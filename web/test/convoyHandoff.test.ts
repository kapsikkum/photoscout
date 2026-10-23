import test from 'node:test';
import assert from 'node:assert/strict';
import type { Route } from '../src/api.js';
import { routeConvoyHandoff } from '../src/convoy/handoff.js';

const route = (patch: Partial<Route> = {}): Route => ({
  id: 'route-1', ownerId: 'u1', name: 'Mountain loop', notes: '', access: '', type: 'circuit',
  vertices: [[149.5, -33.4], [149.6, -33.5]], staging: null, visibility: 'private',
  createdAt: '', updatedAt: '', ...patch,
});

test('a convoy route handoff shares the route and uses its staging location as the destination', () => {
  const handoff = routeConvoyHandoff(route({ staging: { lat: -33.41, lng: 149.51 } }));
  assert.deepEqual(handoff, {
    route: { name: 'Mountain loop', stops: [[149.5, -33.4], [149.6, -33.5], [149.5, -33.4]] },
    destination: { lat: -33.41, lng: 149.51, label: 'Mountain loop staging' },
  });
});

test('a route without staging uses its first stop as the convoy destination', () => {
  const handoff = routeConvoyHandoff(route());
  assert.deepEqual(handoff?.destination, { lat: -33.4, lng: 149.5, label: 'Mountain loop start' });
});
