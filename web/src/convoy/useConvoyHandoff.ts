import type { Route } from '../api.js';
import { useConvoy } from './useConvoy.js';
import { routeConvoyHandoff } from './handoff.js';

/** Active-convoy actions for a map object. The server still enforces leadership. */
export function useConvoyHandoff(enabled = true) {
  const convoy = useConvoy(enabled);
  const active = enabled && convoy.room !== null;
  const leader = active && convoy.room?.leader === convoy.me;
  const connected = convoy.status === 'open';
  const disabledReason = !leader ? 'Only the active convoy leader can set its destination.'
    : !connected ? 'Convoy is reconnecting. Try again once it is live.' : '';

  return {
    active,
    destination: active ? convoy.room?.destination ?? null : null,
    position: active ? convoy.position : null,
    geoError: active ? convoy.geoError : '',
    canSet: leader && connected,
    disabledReason,
    setPoint(lat: number, lng: number, label: string) {
      if (!leader || !connected) return;
      convoy.setDestination({ lat, lng, label: label.slice(0, 80) });
    },
    setRoute(route: Route): boolean {
      if (!leader || !connected) return false;
      const handoff = routeConvoyHandoff(route);
      if (!handoff) return false;
      convoy.setRoute(handoff.route);
      convoy.setDestination(handoff.destination);
      return true;
    },
  };
}
