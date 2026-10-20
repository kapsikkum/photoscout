import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { Map as MlMap } from 'maplibre-gl';
import { useTick, useWakeLock } from '../drive/hooks.js';
import { readConvoy, stopConvoyAudio } from '../drive/audio.js';
import { realtime } from './client.js';
import { attachConvoyLayer } from './layer.js';
import { attachOpenCruiseLayer } from './openCruiseLayer.js';
import ConvoyChat, { ConvoyAudio } from './ConvoyChat.js';
import { useConvoy } from './useConvoy.js';
import { showConvoyNotification } from './notifications.js';
import { OpenCruiseOverlays } from './OpenCruiseOverlays.js';
import type { OpenConvoySummary } from './types.js';

export function ConvoyNav() {
  const convoy = useConvoy();
  const { pathname } = useLocation();
  const unread = Object.values(convoy.unread).reduce((sum, n) => sum + n, 0);
  return <Link to="/convoy" className={pathname === '/convoy' ? 'active' : ''}>
    Convoy {convoy.room && <span className={`convoy-nav-dot${convoy.status === 'open' ? ' is-on' : ''}`} aria-label={convoy.status === 'open' ? 'Connected' : 'Reconnecting'} />}
    {unread > 0 && <span className="convoy-unread" aria-label={`${unread} unread convoy messages`}>{unread > 99 ? '99+' : unread}</span>}
  </Link>;
}

export function ConvoyConnection() {
  const convoy = useConvoy();
  if (convoy.status === 'open') return <span className="convoy-connection"><span className="convoy-nav-dot is-on" /> Live · {convoy.room?.members.filter((m) => m.online).length ?? 0} connected</span>;
  return <span className="convoy-connection" role="status">{convoy.status === 'ended'
    ? <Link to="/login">Session ended. Sign in again</Link>
    : <>Reconnecting… <button className="linkbtn" onClick={() => realtime.reconnect()}>Retry now</button></>}</span>;
}

/** App-level owner: route changes never release the connection or its GPS watch. */
export default function ConvoySession() {
  const convoy = useConvoy();
  const { pathname } = useLocation();
  const [expanded, setExpanded] = useState(false);
  const seen = useRef(new Set<string>());
  const now = useTick(1000);
  const wake = useWakeLock(!!convoy.room && convoy.keepAwake && pathname !== '/drive');
  useEffect(() => {
    let lastWake = 0;
    const wake = () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastWake < 500) return;
      lastWake = Date.now();
      realtime.reconnect();
    };
    const restored = (event: PageTransitionEvent) => { if (event.persisted) wake(); };
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', restored);
    document.addEventListener('visibilitychange', wake);
    return () => { window.removeEventListener('online', wake); window.removeEventListener('pageshow', restored); document.removeEventListener('visibilitychange', wake); stopConvoyAudio(); };
  }, []);
  useEffect(() => {
    for (const notice of convoy.notices) {
      if (seen.current.has(notice.id)) continue;
      seen.current.add(notice.id);
      if (now - notice.ts < 10_000 && (notice.kind === 'message' ? convoy.readMessages : convoy.announceEvents)) readConvoy(notice.text);
      if (now - notice.ts < 10_000 && convoy.desktopAlerts && document.visibilityState === 'hidden' && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        void showConvoyNotification(notice);
      }
    }
    const kept = new Set(convoy.notices.map((n) => n.id));
    for (const id of seen.current) if (!kept.has(id)) seen.current.delete(id);
  }, [convoy.notices, convoy.readMessages, convoy.announceEvents, convoy.desktopAlerts, now]);
  useEffect(() => { if (!convoy.room || convoy.status === 'ended') stopConvoyAudio(); }, [convoy.room?.code, convoy.status]);
  const recent = convoy.notices.filter((n) => now - n.ts < 8_000);
  const unread = convoy.room ? convoy.unread[convoy.room.code] ?? 0 : 0;
  return <>
    <div className="convoy-notices" role="status" aria-live="polite" aria-atomic="false">
      {recent.slice(-2).map((notice) => <div className="convoy-notice" key={notice.id}>
        <Link to="/convoy" onClick={() => convoy.setActive(notice.room)}>{notice.text}</Link>
        <button aria-label="Dismiss convoy notification" onClick={() => convoy.dismissNotice(notice.id)}>×</button>
      </div>)}
    </div>
    {/* Global Open Cruise Banners (matching, invites, decline notices) */}
    {pathname !== '/drive' && pathname !== '/' && <OpenCruiseOverlays />}
    {convoy.status === 'ended' && <div className="convoy-session-error" role="alert">Convoy disconnected: your session ended. <a href="/login">Sign in again</a></div>}
    {convoy.room && !['/convoy', '/drive'].includes(pathname) && <aside className={`convoy-dock${pathname === '/' ? ' convoy-dock--map' : ''}${expanded ? ' is-expanded' : ''}`} aria-label="Active convoy">
      <button className="convoy-dock__toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <span>
          Convoy · <strong>{convoy.room.name}</strong>
          {convoy.room.open && <span className="open-convoy-badge" style={{ marginLeft: 6 }}>Open</span>}
        </span>
        <span>{unread > 0 && <b className="convoy-unread">{unread}</b>} {expanded ? '▴' : '▾'}</span>
      </button>
      <ConvoyConnection />
      {expanded && <div className="convoy-dock__body">
        {convoy.rooms.length > 1 && <label>Active convoy <select value={convoy.room.code} onChange={(e) => convoy.setActive(e.target.value)}>{convoy.rooms.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}</select></label>}
        {convoy.room.destination && <p>{convoy.room.resting ? 'Rest stop' : 'Destination'}: {convoy.room.destination.label || 'Map destination'}</p>}
        <div className="eventcard__actions">
          <Link className="button" to="/convoy">Manage convoy</Link>
          <Link className="button primary" to="/drive">Open navigation</Link>
          {convoy.room.leader === convoy.me && (
            <button
              type="button"
              className="button"
              onClick={() => convoy.setOpen(!convoy.room!.open)}
            >
              {convoy.room.open ? 'Make Private' : 'Make Open'}
            </button>
          )}
        </div>
        <ConvoyChat key={convoy.room.code} compact />
        <details><summary>Riding &amp; audio</summary><ConvoyAudio /></details>
        {convoy.geoError && convoy.sharing && <p className="error" role="status">{convoy.geoError}</p>}
        {convoy.keepAwake && wake !== 'on' && <p className="hint">Screen wake lock {wake === 'unsupported' ? 'is unsupported' : 'is unavailable'}. Check your device’s auto-lock setting.</p>}
      </div>}
    </aside>}
  </>;
}

/** The same members and destination on the main map, including stale-location repainting and Open Cruise layer. */
export function MapConvoy({
  map,
  selectedOpenConvoy,
  onCloseSelectedOpenConvoy,
}: {
  map: MlMap | null;
  selectedOpenConvoy?: OpenConvoySummary | null;
  onCloseSelectedOpenConvoy?: () => void;
}) {
  const convoy = useConvoy();
  const view = convoy.view;
  const now = useTick(5000);
  const [internalSelectedConvoy, setInternalSelectedConvoy] = useState<OpenConvoySummary | null>(null);

  const activeSelectedConvoy = selectedOpenConvoy !== undefined ? selectedOpenConvoy : internalSelectedConvoy;

  // A single layer per map, with an independent update lifecycle.
  const layer = useRef<ReturnType<typeof attachConvoyLayer> | null>(null);
  const openLayer = useRef<ReturnType<typeof attachOpenCruiseLayer> | null>(null);

  useEffect(() => {
    if (!map) return;
    layer.current = attachConvoyLayer(map);
    openLayer.current = attachOpenCruiseLayer(map, [], [], {
      myId: convoy.me,
      myPosition: convoy.position,
      onSelectConvoy: (c) => setInternalSelectedConvoy(c),
    });
    return () => {
      layer.current?.remove();
      layer.current = null;
      openLayer.current?.remove();
      openLayer.current = null;
    };
  }, [map]);

  useEffect(() => {
    layer.current?.update(view?.members ?? [], view ? { me: view.me, leader: view.leader, destination: view.destination } : { destination: null });
  }, [map, view, now]);

  useEffect(() => {
    if (!convoy.openCruise) {
      openLayer.current?.update([], []);
      return;
    }
    openLayer.current?.update(convoy.openCruiseUsers, convoy.openConvoys, {
      myId: convoy.me,
      myPosition: convoy.position,
      onSelectConvoy: (c) => setInternalSelectedConvoy(c),
    });
  }, [map, convoy.openCruise, convoy.openCruiseUsers, convoy.openConvoys, convoy.position, convoy.me, now]);

  const handleClose = () => {
    setInternalSelectedConvoy(null);
    onCloseSelectedOpenConvoy?.();
  };

  return (
    <>
      <OpenCruiseOverlays
        selectedConvoy={activeSelectedConvoy}
        onCloseSelectedConvoy={handleClose}
      />
    </>
  );
}
