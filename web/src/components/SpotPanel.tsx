import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { FireIncident, Place, Spot } from '../api.js';
import { haversineKm } from '../map/geo.js';
import { alignments, Alignment, goodNow } from '../map/sun.js';
import { hhmm } from '../time.js';
import DayStrip from './DayStrip.js';
import { GoodTimesChips } from './GoodTimesEditor.js';
import Photos from './Photos.js';
import Nearby from './Nearby.js';
import { useConvoyHandoff } from '../convoy/useConvoyHandoff.js';

export function formatAlignment(a: Alignment) {
  const day = a.start.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  return `${a.body === 'sun' ? '☀ Sun' : '☾ Moon'} ${day} ${hhmm(a.start)}–${hhmm(a.end)} · ${Math.round(a.azimuth)}°`;
}

function fireIncidentPoint(geom: GeoJSON.Geometry): [number, number] | null {
  if (geom.type === 'Point') return geom.coordinates as [number, number];
  if (geom.type === 'GeometryCollection') {
    for (const g of geom.geometries) {
      const pt = fireIncidentPoint(g);
      if (pt) return pt;
    }
  }
  return null;
}

const ADVICE_OR_ABOVE = new Set(['Advice', 'Watch and Act', 'Emergency Warning', 'Emergency']);

export default function SpotPanel({ spot, place, time, fires = [], canEdit, onEdit, onDelete, onMove, onCreateSpotAt, canUseConvoy }: {
  spot: Spot;
  place: Place | undefined;
  time: Date;
  fires?: FireIncident[];
  canEdit: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onMove: (lat: number, lng: number) => void;
  onCreateSpotAt: (lat: number, lng: number) => Promise<Spot>;
  canUseConvoy: boolean;
}) {
  const convoy = useConvoyHandoff(canUseConvoy);
  const next = useMemo(() => alignments(spot, time, 365, 3), [spot, time]); // cached per day, so cheap to redo
  const good = goodNow(spot, time);

  const nearbyFire = useMemo(() => {
    let best: { incident: FireIncident; km: number } | null = null;
    for (const f of fires) {
      if (!ADVICE_OR_ABOVE.has(f.category)) continue;
      const pt = fireIncidentPoint(f.geometry);
      if (!pt) continue;
      const km = haversineKm(spot.lat, spot.lng, pt[1], pt[0]);
      if (km <= 20 && (!best || km < best.km)) {
        best = { incident: f, km };
      }
    }
    return best;
  }, [fires, spot.lat, spot.lng]);

  return (
    <>
      <h2>{spot.name} {good && <span className="badge-good">Good now</span>}</h2>
      {nearbyFire && (
        <p className="status-line error" role="alert">
          ⚠️ RFS {nearbyFire.incident.category}: {nearbyFire.incident.title} ({nearbyFire.km.toFixed(1)} km away)
        </p>
      )}
      <p className="hint">
        {place && <><Link to={`/places/${place.id}`}>{place.name}</Link> · </>}
        {spot.facingDeg != null ? `Facing ${Math.round(spot.facingDeg)}° (${spot.fovDeg ?? 60}° FOV)` : 'No facing set'} · {spot.visibility}
      </p>
      {spot.notes && <p className="panel__notes">{spot.notes}</p>}
      <p className="hint">{convoy.active
        ? <button className="linkbtn" disabled={!convoy.canSet} title={convoy.disabledReason} onClick={() => convoy.setPoint(spot.lat, spot.lng, spot.name)}>Convoy there</button>
        : <Link to={`/drive?to=${spot.lat},${spot.lng}`}>Drive there</Link>}</p>
      {spot.tags.length > 0 && <div className="chiprow">{spot.tags.map((t) => <span key={t} className="chip">#{t}</span>)}</div>}

      <h4>Photos</h4>
      <Photos spot={spot} canEdit={canEdit} onMoveSpot={onMove} onCreateSpotAt={onCreateSpotAt} />

      <h4>Good times</h4>
      <GoodTimesChips value={spot.goodTimes} />

      <h4>{time.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</h4>
      <DayStrip lat={spot.lat} lng={spot.lng} time={time} />

      <h4>Next alignments</h4>
      {spot.facingDeg == null ? <p className="hint">Set a facing to find sun and moon alignments.</p>
        : next.length === 0 ? <p className="hint">No sun or moon on this bearing within a year.</p>
        : <ul className="plainlist">{next.map((a) => <li key={a.start.getTime() + a.body}>{formatAlignment(a)}</li>)}</ul>}

      <h4>Nearby</h4>
      <Nearby spot={spot} />

      {canEdit && (
        <div className="panel__actions">
          <button className="primary" onClick={onEdit}>Edit</button>
          <button className="danger" onClick={onDelete}>Delete</button>
        </div>
      )}
    </>
  );
}
