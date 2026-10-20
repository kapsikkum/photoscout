import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTick } from '../drive/hooks.js';
import ConvoyChat, { ConvoyAudio } from './ConvoyChat.js';
import { ConvoyConnection } from './ConvoySession.js';
import { useDriveMap } from '../drive/context.js';
import { attachConvoyLayer, type ConvoyLayer } from './layer.js';
import { attachOpenCruiseLayer, type OpenCruiseLayer } from './openCruiseLayer.js';
import { OpenCruiseOverlays } from './OpenCruiseOverlays.js';
import { useConvoy } from './useConvoy.js';
import type { OpenConvoySummary } from './types.js';

/**
 * The convoy you are in, and Open Cruise mode on the Drive screen:
 * - everyone else's pin and shared destination
 * - other Open Cruise drivers and open convoys
 * - 500m proximity matching and invitations
 */
export default function DriveConvoy() {
  const { map, goTo, goRoute } = useDriveMap();
  const convoy = useConvoy();
  const layer = useRef<ConvoyLayer | null>(null);
  const openLayer = useRef<OpenCruiseLayer | null>(null);
  const view = convoy.view;
  const [expanded, setExpanded] = useState(false);
  const [selectedConvoy, setSelectedConvoy] = useState<OpenConvoySummary | null>(null);
  const now = useTick(5000);

  useEffect(() => {
    if (!map) return;
    layer.current = attachConvoyLayer(map);
    openLayer.current = attachOpenCruiseLayer(map, [], [], {
      myId: convoy.me,
      myPosition: convoy.position,
      onSelectConvoy: (c) => setSelectedConvoy(c),
    });
    return () => {
      layer.current?.remove();
      layer.current = null;
      openLayer.current?.remove();
      openLayer.current = null;
    };
  }, [map]);

  useEffect(() => {
    if (!view) { layer.current?.update([]); return; }
    layer.current?.update(view.members.filter((m) => m.id !== view.me), { me: view.me, leader: view.leader, destination: view.destination });
  }, [view, map, now]);

  useEffect(() => {
    if (!map) return;
    if (!convoy.openCruise) {
      openLayer.current?.update([], []);
      return;
    }
    openLayer.current?.update(convoy.openCruiseUsers, convoy.openConvoys, {
      myId: convoy.me,
      myPosition: convoy.position,
      onSelectConvoy: (c) => setSelectedConvoy(c),
    });
  }, [map, convoy.openCruise, convoy.openCruiseUsers, convoy.openConvoys, convoy.position, convoy.me, now]);

  const dest = view?.destination;
  const leader = view?.leader === convoy.me;

  return (
    <>
      <OpenCruiseOverlays
        selectedConvoy={selectedConvoy}
        onCloseSelectedConvoy={() => setSelectedConvoy(null)}
      />

      {view ? (
        <div className={`driveconvoy${expanded ? ' is-expanded' : ''}`} onKeyDown={(event) => { if (event.key === 'Escape') setExpanded(false); }}>
          <button className="driveconvoy__name" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            <span className="driveconvoy__title">{convoy.room?.name ?? 'Convoy'}</span>
            <span className="driveconvoy__count">{view.members.filter((m) => m.online).length} on</span>
            {!!convoy.unread[convoy.room!.code] && <b className="convoy-unread">{convoy.unread[convoy.room!.code]} new</b>}
            <span aria-hidden="true">{expanded ? '▴' : '▾'}</span>
          </button>
          {expanded && (
            <div className="driveconvoy__panel" role="region" aria-label="Convoy controls">
              <ConvoyConnection />
              <button
                type="button"
                className={`secondary open-cruise-toggle-btn ${convoy.openCruise ? 'is-active' : ''}`}
                onClick={() => convoy.setOpenCruise(!convoy.openCruise)}
              >
                {convoy.openCruise ? 'Open Cruise: ON' : 'Open Cruise: OFF'}
              </button>
              {leader && (
                <button type="button" className="secondary" onClick={() => convoy.setCruising(!view.cruising)}>
                  {view.cruising ? 'Resume guided convoy' : 'Just cruise'}
                </button>
              )}
              {leader && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => convoy.setOpen(!convoy.room!.open)}
                >
                  {convoy.room?.open ? 'Make Private' : 'Make Open'}
                </button>
              )}
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
            </div>
          )}
        </div>
      ) : convoy.openCruise ? (
        <div className={`driveconvoy${expanded ? ' is-expanded' : ''}`} onKeyDown={(event) => { if (event.key === 'Escape') setExpanded(false); }}>
          <button className="driveconvoy__name is-open-cruise" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            <span className="open-cruise-dot" />
            <span className="driveconvoy__title">Open Cruise Active</span>
            <span className="driveconvoy__count">{convoy.openCruiseUsers.length} on map</span>
            <span aria-hidden="true">{expanded ? '▴' : '▾'}</span>
          </button>
          {expanded && (
            <div className="driveconvoy__panel" role="region" aria-label="Open Cruise controls">
              <p className="hint">Your location is visible to other Open Cruise drivers. Matches occur within 500m.</p>
              <button type="button" className="secondary" onClick={() => convoy.setOpenCruise(false)}>
                Turn off Open Cruise
              </button>
              <Link to="/convoy">Convoy settings</Link>
            </div>
          )}
        </div>
      ) : (
        <div className="driveconvoy driveconvoy--dormant">
          <button
            type="button"
            className="driveconvoy__name driveconvoy__name--toggle"
            onClick={() => convoy.setOpenCruise(true)}
            title="Enable Open Cruise to see and be seen by other drivers"
          >
            <span>🚗 Open Cruise</span>
          </button>
        </div>
      )}
    </>
  );
}
