import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Route } from '../src/api.js';
import {
  ROUTE_LAYERS,
  routeFeatureCollections,
  routePulseGradient,
} from '../src/map/routeLayer.js';
import { categoryOf } from '../src/map/legend.js';

const route = (patch: Partial<Route>): Route => ({
  id: 'r1',
  ownerId: 'u1',
  name: 'Ridge run',
  notes: '',
  access: '',
  type: 'sprint',
  vertices: [[151.1, -33.1], [151.2, -33.2], [151.3, -33.3]],
  staging: null,
  visibility: 'private',
  createdAt: '',
  updatedAt: '',
  ...patch,
});

test('routeFeatureCollections emits one selectable directed LineString per route', () => {
  const { segments } = routeFeatureCollections([route({ type: 'circuit' })], 'r1');

  assert.equal(segments.features.length, 1);
  assert.deepEqual(segments.features[0].properties, {
    id: 'r1',
    routeId: 'r1',
    type: 'circuit',
    selected: true,
  });
  assert.deepEqual(segments.features[0].geometry, {
    type: 'LineString',
    coordinates: [[151.1, -33.1], [151.2, -33.2], [151.3, -33.3], [151.1, -33.1]],
  });
});

test('routeFeatureCollections emits staging points only when a route has staging coordinates', () => {
  const { staging } = routeFeatureCollections([
    route({ id: 'with-stage', staging: { lat: -33.4, lng: 151.4 } }),
    route({ id: 'without-stage', staging: null }),
  ], 'with-stage');

  assert.equal(staging.features.length, 1);
  assert.deepEqual(staging.features[0].properties, { id: 'with-stage', routeId: 'with-stage', selected: true });
  assert.deepEqual(staging.features[0].geometry, { type: 'Point', coordinates: [151.4, -33.4] });
});

test('routeFeatureCollections keeps a long route as one LineString instead of one feature per leg', () => {
  const vertices = Array.from({ length: 1_001 }, (_, i) => [151 + i / 10_000, -33 - i / 10_000] as [number, number]);
  const { segments } = routeFeatureCollections([route({ vertices })], null);

  assert.equal(segments.features.length, 1);
  assert.deepEqual(segments.features[0].geometry, { type: 'LineString', coordinates: vertices });
});

test('every layer in ROUTE_LAYERS matches legend category routes', () => {
  for (const id of ROUTE_LAYERS) {
    assert.equal(categoryOf({ id, type: 'line' }), 'routes', 'Layer ' + id + ' must match legend category routes');
  }
});

test('ROUTE_LAYERS includes every rendered route overlay layer', () => {
  assert.deepEqual([...ROUTE_LAYERS], [
    'route-glow',
    'route-casing',
    'route-lines',
    'route-pulse',
    'route-arrows',
    'route-staging-halo',
    'route-staging',
  ]);
});

test('routePulseGradient keeps stops ascending inside [0, 1] for every phase', () => {
  for (let phase = 0; phase <= 1; phase += 0.01) {
    const xs = (routePulseGradient(phase) as unknown[]).slice(3).filter((_, i) => i % 2 === 0) as number[];
    assert.equal(xs[0], 0);
    assert.equal(xs.at(-1), 1);
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i] > xs[i - 1], `phase ${phase}: ${xs}`);
  }
});
