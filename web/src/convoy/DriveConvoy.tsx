import { useEffect, useRef } from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTick } from '../drive/hooks.js';
import ConvoyChat, { ConvoyAudio } from './ConvoyChat.js';
import { ConvoyConnection } from './ConvoySession.js';
import { useDriveMap } from '../drive/context.js';
import { attachConvoyLayer, type ConvoyLayer } from './layer.js';
import { useConvoy } from './useConvoy.js';

/**
 * The convoy you are in, on the Drive screen: everyone else's pin, and the
 * shared destination as a one-tap choice when you have not picked your own.
 * Your own car is Drive's arrow, so your pin is left off.
 */
export default function DriveConvoy() {
  const { map, goTo, goRoute } = useDriveMap();
  const convoy = useConvoy();
  const layer = useRef<ConvoyLayer | null>(null);
  const view = convoy.view;
  const [expanded, setExpanded] = useState(false);
  const now = useTick(5000);

  useEffect(() => {
    if (!map) return;
    layer.current = attachConvoyLayer(map);
    return () => { layer.current?.remove(); layer.current = null; };
  }, [map]);

  useEffect(() => {
    if (!view) { layer.current?.update([]); return; }
    layer.current?.update(view.members.filter((m) => m.id !== view.me), { me: view.me, leader: view.leader, destination: view.destination });
  }, [view, map, now]);

  if (!view) return null;
  const dest = view.destination;
  const leader = view.leader === convoy.me;
  return (
    <div className={`driveconvoy${expanded ? ' is-expanded' : ''}`} onKeyDown={(event) => { if (event.key === 'Escape') setExpanded(false); }}>
      <button className="driveconvoy__name" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <span className="driveconvoy__title">{convoy.room?.name ?? 'Convoy'}</span>
        <span className="driveconvoy__count">{view.members.filter((m) => m.online).length} on</span>
        {!!convoy.unread[convoy.room!.code] && <b className="convoy-unread">{convoy.unread[convoy.room!.code]} new</b>}
        <span aria-hidden="true">{expanded ? '▴' : '▾'}</span>
      </button>
      {expanded && <div className="driveconvoy__panel" role="region" aria-label="Convoy controls">
        <ConvoyConnection />
      {leader && <button type="button" className="secondary" onClick={() => convoy.setCruising(!view.cruising)}>
        {view.cruising ? 'Resume guided convoy' : 'Just cruise'}
      </button>}
      {view.cruising && <p className="hint">Just cruising — no shared destination or route.</p>}
      {dest && (
        <button type="button" className="primary" onClick={() => goTo(dest.lat, dest.lng, dest.label || 'Convoy destination')}>
          {convoy.room?.resting ? 'Preview rest stop' : 'Drive to'} {dest.label || 'the convoy’s destination'}
        </button>
      )}
      {view.route && (
        <button type="button" className="primary" onClick={() => goRoute(view.route!.stops, view.route!.name)}>
          Drive convoy route
        </button>
      )}
        <ConvoyChat key={convoy.room!.code} compact />
        <details><summary>Riding &amp; audio</summary><ConvoyAudio /></details>
        <Link to="/convoy">Manage convoy</Link>
      </div>}
    </div>
  );
}
