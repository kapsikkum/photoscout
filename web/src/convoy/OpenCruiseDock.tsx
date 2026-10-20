import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useConvoy } from './useConvoy.js';
import { haversineKm } from '../map/geo.js';
import type { OpenConvoySummary } from './types.js';

export interface OpenCruiseDockProps {
  open: boolean;
  onClose: () => void;
  onSelectConvoy?: (convoy: OpenConvoySummary) => void;
  isLoggedIn?: boolean;
}

/**
 * Small cruise UI for the map (same visual style as the convoy overlay/dock).
 * Features an Open Cruise toggle directly from the map, live nearby drivers count,
 * 500m proximity matching and convoy creation, and active Open Convoys list.
 */
export function OpenCruiseDock({
  open,
  onClose,
  onSelectConvoy,
  isLoggedIn = true,
}: OpenCruiseDockProps) {
  const convoy = useConvoy();
  const [expanded, setExpanded] = useState(true);

  if (!open && !convoy.openCruise) return null;

  // Nearby users within 500m
  const nearbyUsers: { id: string; username: string; distM: number }[] = [];
  if (convoy.openCruise && convoy.position) {
    for (const u of convoy.openCruiseUsers) {
      if (!u.position) continue;
      if (convoy.room && convoy.room.members.some((m) => m.id === u.id)) continue;
      const distM = haversineKm(convoy.position.lat, convoy.position.lng, u.position.lat, u.position.lng) * 1000;
      if (distM <= 500) {
        nearbyUsers.push({ id: u.id, username: u.username, distM });
      }
    }
  }
  nearbyUsers.sort((a, b) => a.distM - b.distM);

  const hasActiveConvoy = Boolean(convoy.room);
  const statusLabel = convoy.openCruise
    ? (nearbyUsers.length > 0 ? `${nearbyUsers.length} nearby` : 'Active')
    : 'Off';

  return (
    <aside
      className={`convoy-dock convoy-dock--map open-cruise-dock${hasActiveConvoy ? ' open-cruise-dock--stacked' : ''}${expanded ? ' is-expanded' : ''}`}
      aria-label="Open Cruise overlay"
    >
      <button
        type="button"
        className="convoy-dock__toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="open-cruise-dock__toggle-title">
          <span className={`open-cruise-dot${convoy.openCruise ? ' is-active' : ''}`} />
          <span>Open Cruise · <strong>{statusLabel}</strong></span>
        </span>
        <span className="open-cruise-dock__toggle-controls">
          <span className="convoy-dock__chevron" aria-hidden>{expanded ? '▴' : '▾'}</span>
          <button
            type="button"
            className="open-cruise-dock__close-btn"
            title="Close Open Cruise UI"
            aria-label="Close Open Cruise UI"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
          >
            ✕
          </button>
        </span>
      </button>

      {convoy.openCruise && isLoggedIn && (
        <span className="convoy-connection">
          <span className="convoy-nav-dot is-on" /> Live · {convoy.openCruiseUsers.length} driver{convoy.openCruiseUsers.length === 1 ? '' : 's'} on map
        </span>
      )}

      {expanded && (
        <div className="convoy-dock__body open-cruise-dock__body">
          {/* Main Toggle from the map */}
          <div className="open-cruise-dock__toggle-row">
            <div>
              <div className="open-cruise-dock__toggle-label">Open Cruise Mode</div>
              <div className="open-cruise-dock__toggle-hint">Share location with nearby drivers</div>
            </div>
            <button
              type="button"
              className={`button ${convoy.openCruise ? 'primary' : 'secondary'} open-cruise-dock__switch`}
              onClick={() => convoy.setOpenCruise(!convoy.openCruise)}
            >
              {convoy.openCruise ? 'On' : 'Off'}
            </button>
          </div>

          {!isLoggedIn ? (
            <div className="open-cruise-dock__off-state">
              <p className="hint">
                Sign in to share your location and match with open convoys on the map.
              </p>
              <Link className="button primary full-width" to="/login">
                Sign in
              </Link>
            </div>
          ) : convoy.openCruise ? (
            <>
              <p className="open-cruise-dock__desc">
                Your location is visible to everyone with Open Cruise enabled. When two or more drivers are within 500m, you can form an Open Convoy.
              </p>

              {/* 500m Nearby Match Section */}
              {nearbyUsers.length > 0 && (
                <div className="open-cruise-dock__match-box">
                  <div className="open-cruise-dock__match-head">
                    <span className="open-convoy-badge open-convoy-badge--live">⚡ 500m Match</span>
                    <span className="open-cruise-dock__match-dist">{Math.round(nearbyUsers[0].distM)}m away</span>
                  </div>
                  <p className="open-cruise-dock__match-user">
                    <strong>{nearbyUsers[0].username}</strong> is in range!
                  </p>
                  <button
                    type="button"
                    className="button primary small-btn full-width"
                    onClick={() => convoy.sendOpenConvoyInvite(nearbyUsers[0].id)}
                  >
                    Create Open Convoy
                  </button>
                </div>
              )}

              {/* Active Open Convoys on Map */}
              {convoy.openConvoys.length > 0 && (
                <div className="open-cruise-dock__convoys-section">
                  <div className="open-cruise-dock__section-title">
                    Open Convoys ({convoy.openConvoys.length})
                  </div>
                  <ul className="open-cruise-dock__convoys-list">
                    {convoy.openConvoys.map((c) => (
                      <li key={c.code} className="open-cruise-dock__convoy-item">
                        <div className="open-cruise-dock__convoy-meta">
                          <strong>{c.name}</strong>
                          <span className="open-cruise-dock__convoy-sub">
                            Leader: {c.leader} · {c.members.length} member{c.members.length === 1 ? '' : 's'}
                          </span>
                        </div>
                        {onSelectConvoy && (
                          <button
                            type="button"
                            className="button secondary small-btn"
                            onClick={() => onSelectConvoy(c)}
                          >
                            View
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Quick Navigation Links */}
              <div className="eventcard__actions open-cruise-dock__actions">
                <Link className="button" to="/convoy">Convoy Hub</Link>
                <Link className="button primary" to="/drive">Start Drive</Link>
              </div>
            </>
          ) : (
            <div className="open-cruise-dock__off-state">
              <p className="hint">
                Turn on Open Cruise to see other cruising drivers and open convoys live on the map.
              </p>
              <button
                type="button"
                className="button primary full-width"
                onClick={() => convoy.setOpenCruise(true)}
              >
                Turn On Open Cruise
              </button>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
