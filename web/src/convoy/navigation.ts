import type { LngLat } from '../drive/geometry.js';
import { distanceM } from '../drive/geometry.js';
import type { Destination, Position } from './types.js';

/** A routable request from the member's shared GPS fix to the active convoy destination. */
export function convoyNavigationRequest(position: Position | null, destination: Destination | null): [LngLat, LngLat] | null {
  if (!position || !destination || !valid(position.lat, position.lng) || !valid(destination.lat, destination.lng)) return null;
  return [[position.lng, position.lat], [destination.lng, destination.lat]];
}

/** Avoid asking OSRM again for ordinary GPS drift; destination changes always reroute. */
export function shouldRefreshConvoyNavigation(previous: [LngLat, LngLat] | null, next: [LngLat, LngLat], movementM = 40): boolean {
  if (!previous) return true;
  const [from, to] = previous;
  const [nextFrom, nextTo] = next;
  return to[0] !== nextTo[0] || to[1] !== nextTo[1] || distanceM(from, nextFrom) >= movementM;
}

function valid(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}
