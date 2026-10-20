import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type User } from '../api.js';
import { routeStops, routingWaypoints } from '../map/routeGeometry.js';
import ConvoyMap from '../convoy/ConvoyMap.js';
import { lastSeenText, speedText } from '../convoy/state.js';
import { useConvoy, type Convoy as ConvoyApi } from '../convoy/useConvoy.js';
import type { Member } from '../convoy/types.js';
import ConvoyChat, { ConvoyAudio } from '../convoy/ConvoyChat.js';
import { ConvoyConnection } from '../convoy/ConvoySession.js';

const STATUS_TEXT: Record<string, string> = {
  connecting: 'Connecting…',
  retrying: 'Connection lost. Trying again…',
  unavailable: 'Cannot reach the live connection. Still trying…',
  ended: 'You have been signed out. Sign in again to use a convoy.',
};

/** A code as people say it: in two halves. */
const spaced = (code: string) => `${code.slice(0, 4)} ${code.slice(4)}`;

/**
 * Drive together. Make a convoy or join one by its code (or from a cruise), and everyone in it sees
 * everyone else on a map while they are sharing. The leader picks where the group is going.
 * Positions pass through the server's memory only; nothing is saved.
 */
export default function Convoy({ user }: { user: User | null }) {
  if (!user) return <div className="page"><p className="hint"><Link to="/login">Sign in</Link> to drive in a convoy.</p></div>;
  return <ConvoyPage />;
}

function ConvoyPage() {
  const convoy = useConvoy();
  const [params, setParams] = useSearchParams();
  const [code, setCode] = useState(() => params.get('code') ?? '');
  const cruise = params.get('cruise');
  const routeId = params.get('route');
  const to = params.get('to');
  const label = params.get('label') ?? '';
  const requestedRoom = params.get('room');
  const asked = useRef(false);
  const applied = useRef<string | null>(null);
  const [selectionError, setSelectionError] = useState('');
  useEffect(() => {
    if (requestedRoom && convoy.status === 'open' && convoy.rooms.some((r) => r.code === requestedRoom)) {
      convoy.setActive(requestedRoom);
      setParams({}, { replace: true });
    }
  }, [requestedRoom, convoy.status, convoy.rooms]);

  // From a cruise's "Start convoy": go straight in once the connection is up.
  useEffect(() => {
    if (!cruise || asked.current || convoy.status !== 'open') return;
    asked.current = true;
    convoy.joinCruise(cruise);
  }, [cruise, convoy.status]);
  // Once you are in (or the server has said no), the link has done its job.
  useEffect(() => {
    if (cruise && asked.current && (convoy.rooms.length > 0 || convoy.error)) setParams({}, { replace: true });
  }, [cruise, convoy.rooms.length, convoy.error]);

  // Links from a place/spot or a saved route wait until the leader has a room, then apply once.
  useEffect(() => {
    if ((!routeId && !to) || !convoy.room || convoy.status !== 'open') return;
    if (convoy.room.leader !== convoy.me) { setSelectionError('Only the convoy leader can apply a shared place or route.'); return; }
    const key = `${convoy.room.code}|${routeId ?? ''}|${to ?? ''}|${label}`;
    if (applied.current === key) return;
    applied.current = key;
    setSelectionError('');
    let cancelled = false;
    void (async () => {
      try {
        if (routeId) {
          const route = await api.route(routeId);
          if (cancelled) return;
          convoy.setRoute({ name: route.name, stops: routingWaypoints(routeStops(route), route.type) });
          if (route.staging) convoy.setDestination({ lat: route.staging.lat, lng: route.staging.lng, label: `${route.name} staging`.slice(0, 80) });
        } else if (to) {
          const [lat, lng] = to.split(',').map(Number);
          if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error('That place has invalid coordinates.');
          convoy.setDestination({ lat, lng, label: (label || 'Convoy destination').slice(0, 80) });
        }
        setParams({}, { replace: true });
      } catch (err) {
        if (cancelled) return;
        applied.current = null;
        setSelectionError((err as Error).message || 'Could not apply the shared convoy selection.');
      }
    })();
    return () => { cancelled = true; if (applied.current === key) applied.current = null; };
  }, [convoy.room?.code, convoy.room?.leader, convoy.status, convoy.me, routeId, to, label]);

  const waiting = STATUS_TEXT[convoy.status];
  return (
    <div className="page convoy">
      <h1>Convoy</h1>
      {convoy.room && <ConvoyConnection />}
      {waiting && <p className={`status-line ${convoy.status === 'ended' ? 'error' : 'disabled'}`}>{waiting}</p>}
      {convoy.error && <p className="status-line error">{convoy.error}</p>}
      {selectionError && <p className="status-line error">{selectionError}</p>}
      {convoy.room ? <InRoom key={convoy.room.code} convoy={convoy} /> : (
        <p className="hint">Start a convoy and send the code to the people you are driving with, or enter the code you were sent. While you are in one, your position is shared with the others in it, and only with them.</p>
      )}
      {convoy.rooms.length < 3 && (
        convoy.room
          ? <details className="convoy__more"><summary>Start or join another convoy</summary><Entry convoy={convoy} code={code} setCode={setCode} /></details>
          : <Entry convoy={convoy} code={code} setCode={setCode} />
      )}
    </div>
  );
}

function Entry({ convoy, code, setCode }: { convoy: ConvoyApi; code: string; setCode: (c: string) => void }) {
  const [name, setName] = useState('');
  const [automaticRegroup, setAutomaticRegroup] = useState(false);
  const [separationKm, setSeparationKm] = useState(5);
  const ready = convoy.status === 'open';
  const create = (e: FormEvent) => {
    e.preventDefault();
    convoy.create(name, { enabled: automaticRegroup, separationM: separationKm * 1_000 });
    setName('');
  };
  const join = (e: FormEvent) => { e.preventDefault(); convoy.join(code); setCode(''); };
  return (
    <div className="convoy__entry">
      <form className="convoy__card" onSubmit={create}>
        <h2>Start a convoy</h2>
        <input value={name} maxLength={40} placeholder="Name (optional)" onChange={(e) => setName(e.target.value)} />
        <label className="toggle">
          <input type="checkbox" checked={automaticRegroup} onChange={(e) => setAutomaticRegroup(e.target.checked)} />
          Automatic regroup when the group spreads out
        </label>
        {automaticRegroup && <label>
          Regroup distance: <strong>{separationKm} km</strong>
          <input type="range" min="1" max="20" step="1" value={separationKm} onChange={(e) => setSeparationKm(Number(e.target.value))} />
          <span className="hint">Creates a rest-stop suggestion only after positions stay this far apart for 90 seconds. A shared route is required.</span>
        </label>}
        <button className="primary" disabled={!ready}>Start</button>
      </form>
      <form className="convoy__card" onSubmit={join}>
        <h2>Join with a code</h2>
        <input className="convoy__code" value={code} maxLength={12} placeholder="ABCD EFGH" autoCapitalize="characters" autoComplete="off" spellCheck={false}
          onChange={(e) => setCode(e.target.value.toUpperCase())} />
        <button className="primary" disabled={!ready || code.replace(/\s/g, '').length < 8}>Join</button>
      </form>
    </div>
  );
}

function InRoom({ convoy }: { convoy: ConvoyApi }) {
  const room = convoy.room!;
  const view = convoy.view!;
  const iLead = room.leader === convoy.me;
  const [picking, setPicking] = useState(false);
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 15_000); return () => clearInterval(t); }, []);

  const link = `${location.origin}/convoy?code=${room.code}`;
  async function share() {
    try {
      if (navigator.share) await navigator.share({ title: `Join "${room.name}" on PhotoScout`, text: `Convoy code ${spaced(room.code)}`, url: link });
      else { await navigator.clipboard.writeText(link); setNote('Link copied.'); }
    } catch { /* cancelled, or the clipboard is blocked: the code is on screen anyway */ }
  }
  const members = [...room.members].sort((a, b) => Number(b.online) - Number(a.online));
  const withMine = (m: Member) => view.members.find((x) => x.id === m.id) ?? m;

  return (
    <>
      {convoy.rooms.length > 1 && (
        <div className="chiprow">
          {convoy.rooms.map((r) => <button key={r.code} className={`chip${r.code === room.code ? ' active' : ''}`} onClick={() => convoy.setActive(r.code)}>{r.name}</button>)}
        </div>
      )}
      <div className="convoy__head">
        <div>
          <h2>{room.name}</h2>
          <p className="hint">
            Code <strong className="convoy__codeshown">{spaced(room.code)}</strong>
            {room.eventId && <> · <Link to={`/events?open=${room.eventId}`}>the cruise</Link></>}
          </p>
        </div>
        <div className="eventcard__actions">
          <button onClick={() => void share()}>Share invite</button>
          <button onClick={() => convoy.leave()}>Leave</button>
        </div>
      </div>
      {note && <p className="hint">{note}</p>}

      <label className="toggle">
        <input type="checkbox" checked={convoy.sharing} onChange={(e) => convoy.setSharing(e.target.checked)} />
        Share my position with my joined convoys
      </label>
      {convoy.sharing && <p className="hint">Position sharing stays on across PhotoScout pages until you leave or turn it off. Keep the app visible on your phone for live updates.</p>}
      <ConvoyAudio />
      {convoy.geoError && convoy.sharing && <p className="status-line error">{convoy.geoError}</p>}

      <ConvoyMap view={view} onPick={picking ? (lat, lng) => { convoy.setDestination({ lat, lng, label: label.trim() }); setPicking(false); setLabel(''); } : undefined} />

      <div className="convoy__dest">
        {room.cruising && <p className="hint">Just cruising — the leader has cleared the shared destination and route.</p>}
        {room.destination
          ? <p>⚑ <strong>{room.destination.label || 'Destination'}</strong> <span className="hint">{room.destination.lat.toFixed(4)}, {room.destination.lng.toFixed(4)}</span></p>
          : <p className="hint">No destination yet.{iLead ? ' Choose one on the map.' : ' The leader can set one.'}</p>}
        {room.route && <p>🛣️ <strong>{room.route.name}</strong> <span className="hint">{room.route.stops.length - 1} leg{room.route.stops.length === 2 ? '' : 's'} shared with Drive</span></p>}
        {room.route && !room.resting && !picking && (
          <div className="eventcard__actions">
            <button className="primary" onClick={() => convoy.rest('find')}>Find nearest rest stop</button>
          </div>
        )}
        {iLead && (
          <div className="eventcard__actions">
            <button onClick={() => convoy.setCruising(!room.cruising)}>{room.cruising ? 'Resume guided convoy' : 'Just cruise'}</button>
            {picking
              ? <>
                  <input value={label} maxLength={80} placeholder="Name it (optional), then tap the map" onChange={(e) => setLabel(e.target.value)} />
                  <button onClick={() => setPicking(false)}>Cancel</button>
                </>
              : <button onClick={() => setPicking(true)}>{room.destination ? 'Move destination' : 'Set destination'}</button>}
            {room.destination && !picking && <button onClick={() => convoy.setDestination(null)}>Clear</button>}
            {room.resting && !picking && (
              <button className="primary" onClick={() => convoy.rest('continue')}>Continue to destination</button>
            )}
            {room.route && !picking && <button onClick={() => convoy.setRoute(null)}>Clear route</button>}
          </div>
        )}
      </div>

      <ul className="convoy__members">
        {members.map((m) => {
          const shown = withMine(m);
          return (
            <li key={m.id} className={m.online ? '' : 'is-away'}>
              <span className={`convoy__dot${m.online ? ' is-on' : ''}`} aria-hidden="true" />
              <Link to={`/u/${encodeURIComponent(m.username)}`}>{m.username}</Link>
              {m.id === convoy.me && <span className="eventbadge">You</span>}
              {m.id === room.leader && <span className="eventbadge eventbadge--community">Leader</span>}
              <span className="hint">
                {m.online
                  ? (shown.position ? [speedText(shown.position.speed), `updated ${lastSeenText(shown.position.ts)}`].filter(Boolean).join(' · ') : 'connected, not sharing')
                  : `last seen ${lastSeenText(m.lastSeen)}`}
              </span>
              {iLead && m.id !== convoy.me && m.online && <button className="linkbtn" onClick={() => convoy.handOver(m.id)}>Make leader</button>}
              {iLead && m.id !== convoy.me && <button className="danger" title="They cannot rejoin with the code" onClick={() => convoy.remove(m.id)}>Remove</button>}
            </li>
          );
        })}
      </ul>
      <ConvoyChat key={room.code} />
    </>
  );
}
