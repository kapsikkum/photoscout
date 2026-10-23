import type { Route } from '../api.js';
import { routeStops, routingWaypoints } from '../map/routeGeometry.js';
import type { ConvoyRoute, Destination } from './types.js';

/** The bounded shared-route payload and meetup point for a saved route. */
export function routeConvoyHandoff(route: Route): { route: ConvoyRoute; destination: Destination } | null {
  const stops = routingWaypoints(routeStops(route), route.type);
  if (stops.length < 2 || !stops.every(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat))) return null;
  const [startLng, startLat] = stops[0];
  const anchor = route.staging ?? { lat: startLat, lng: startLng };
  return {
    route: { name: route.name.slice(0, 40), stops },
    destination: {
      lat: anchor.lat,
      lng: anchor.lng,
      label: `${route.name} ${route.staging ? 'staging' : 'start'}`.slice(0, 80),
    },
  };
}
