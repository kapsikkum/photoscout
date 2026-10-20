import { useEffect, useState } from 'react';
import type { OpenConvoySummary, OpenCruiseUser } from './types.js';
import { useConvoy } from './useConvoy.js';
import { haversineKm } from '../map/geo.js';

export function OpenCruiseOverlays({
  selectedConvoy,
  onCloseSelectedConvoy,
}: {
  selectedConvoy?: OpenConvoySummary | null;
  onCloseSelectedConvoy?: () => void;
}) {
  const convoy = useConvoy();
  const [invitedUserId, setInvitedUserId] = useState<string | null>(null);

  // Auto-clear invite-pending feedback after 30 seconds
  useEffect(() => {
    if (!invitedUserId) return;
    const t = setTimeout(() => setInvitedUserId(null), 30_000);
    return () => clearTimeout(t);
  }, [invitedUserId]);

  // Find nearby users within 500m
  const nearbyUsers: { user: OpenCruiseUser; distM: number }[] = [];
  if (convoy.openCruise && convoy.position) {
    for (const u of convoy.openCruiseUsers) {
      if (!u.position) continue;
      // Exclude if already in the same room
      if (convoy.room && convoy.room.members.some((m) => m.id === u.id)) continue;
      const distM = haversineKm(convoy.position.lat, convoy.position.lng, u.position.lat, u.position.lng) * 1000;
      if (distM <= 500) {
        nearbyUsers.push({ user: u, distM });
      }
    }
  }

  // Sort nearest first
  nearbyUsers.sort((a, b) => a.distM - b.distM);

  const handleSendInvite = (targetUserId: string) => {
    convoy.sendOpenConvoyInvite(targetUserId);
    setInvitedUserId(targetUserId);
  };

  return (
    <>
      {/* 1. Incoming Invite Banner */}
      {convoy.incomingInvite && (
        <div className="open-convoy-banner open-convoy-banner--invite" role="alert">
          <div className="open-convoy-banner__info">
            <span className="open-convoy-badge">Open Convoy</span>
            <p className="open-convoy-banner__text">
              <strong>{convoy.incomingInvite.from.username}</strong> wants to create an Open convoy
            </p>
          </div>
          <div className="open-convoy-banner__actions">
            <button
              type="button"
              className="primary"
              onClick={() => convoy.acceptOpenConvoyInvite(convoy.incomingInvite!.from.id)}
            >
              Join
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => convoy.declineOpenConvoyInvite(convoy.incomingInvite!.from.id)}
            >
              Decline
            </button>
          </div>
        </div>
      )}

      {/* 2. Invitation Declined Notice */}
      {convoy.declinedNotice && (
        <div className="open-convoy-banner open-convoy-banner--declined" role="status">
          <p className="open-convoy-banner__text">
            <strong>{convoy.declinedNotice.from.username}</strong> declined the convoy invitation.
          </p>
          <button type="button" className="ghost" onClick={() => convoy.dismissDeclinedNotice()}>
            Dismiss
          </button>
        </div>
      )}

      {/* 3. Proximity Matching Banner (within 500m) */}
      {!convoy.incomingInvite && nearbyUsers.length > 0 && (
        <div className="open-convoy-banner open-convoy-banner--proximity" role="region" aria-label="Nearby Open Cruise drivers">
          <div className="open-convoy-banner__info">
            <span className="open-convoy-badge open-convoy-badge--live">⚡ 500m Match</span>
            <p className="open-convoy-banner__text">
              <strong>{nearbyUsers[0].user.username}</strong> is nearby ({Math.round(nearbyUsers[0].distM)}m away)
            </p>
          </div>
          <div className="open-convoy-banner__actions">
            {invitedUserId === nearbyUsers[0].user.id ? (
              <span className="open-convoy-banner__pending">Request sent…</span>
            ) : (
              <button
                type="button"
                className="primary"
                onClick={() => handleSendInvite(nearbyUsers[0].user.id)}
              >
                Create Open Convoy
              </button>
            )}
          </div>
        </div>
      )}

      {/* 4. Selected Open Convoy Inspection Modal */}
      {selectedConvoy && (
        <div className="open-convoy-modal-backdrop" onClick={onCloseSelectedConvoy}>
          <div className="open-convoy-modal" role="dialog" aria-labelledby="open-convoy-title" onClick={(e) => e.stopPropagation()}>
            <div className="open-convoy-modal__head">
              <div>
                <span className="open-convoy-badge">Open Convoy</span>
                <h2 id="open-convoy-title">{selectedConvoy.name}</h2>
              </div>
              <button type="button" className="ghost close-btn" onClick={onCloseSelectedConvoy} aria-label="Close">
                ✕
              </button>
            </div>

            <div className="open-convoy-modal__status">
              {selectedConvoy.cruising && (
                <p className="open-convoy-mode">
                  <span className="mode-icon">🧭</span> <strong>Just cruise mode</strong> (no set destination)
                </p>
              )}
              {selectedConvoy.destination && (
                <p className="open-convoy-dest">
                  <span className="dest-icon">⚑</span> Heading to: <strong>{selectedConvoy.destination.label}</strong>
                </p>
              )}
              {selectedConvoy.resting && (
                <p className="open-convoy-resting">
                  <span className="rest-icon">☕</span> Paused at rest stop
                </p>
              )}
            </div>

            <div className="open-convoy-modal__members">
              <h3>Current Members ({selectedConvoy.members.length})</h3>
              <ul className="member-list">
                {selectedConvoy.members.map((m) => (
                  <li key={m.id} className="member-item">
                    <span className="member-avatar">{m.avatar ? <img src={m.avatar} alt="" /> : '👤'}</span>
                    <span className="member-name">{m.username}</span>
                    {m.id === selectedConvoy.leader && <span className="leader-pill">Leader</span>}
                    {m.newMember && <span className="catching-up-pill">Catching up</span>}
                  </li>
                ))}
              </ul>
            </div>

            <div className="open-convoy-modal__footer">
              {convoy.rooms.some((r) => r.code === selectedConvoy.code) ? (
                <p className="hint">You are in this convoy</p>
              ) : (
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    convoy.joinOpenConvoy(selectedConvoy.code);
                    onCloseSelectedConvoy?.();
                  }}
                >
                  Join Open Convoy
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
