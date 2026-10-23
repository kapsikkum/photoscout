import test from 'node:test';
import assert from 'node:assert/strict';
import { convoyNavigationRequest, shouldRefreshConvoyNavigation } from '../src/convoy/navigation.js';

test('convoy navigation routes from the member GPS position to the shared destination', () => {
  assert.deepEqual(convoyNavigationRequest(
    { lat: -33.41, lng: 149.51, heading: null, speed: null, ts: 1 },
    { lat: -33.42, lng: 149.62, label: 'Lookout' },
  ), [[149.51, -33.41], [149.62, -33.42]]);
});

test('convoy navigation waits for both a valid position and a destination', () => {
  assert.equal(convoyNavigationRequest(null, { lat: -33.42, lng: 149.62, label: 'Lookout' }), null);
  assert.equal(convoyNavigationRequest({ lat: -33.41, lng: 149.51, heading: null, speed: null, ts: 1 }, null), null);
  assert.equal(convoyNavigationRequest({ lat: 91, lng: 149.51, heading: null, speed: null, ts: 1 }, { lat: -33.42, lng: 149.62, label: 'Lookout' }), null);
});

test('convoy navigation refreshes for a changed destination or meaningful GPS movement', () => {
  const first = [[149.51, -33.41], [149.62, -33.42]] as [[number, number], [number, number]];
  assert.equal(shouldRefreshConvoyNavigation(null, first), true);
  assert.equal(shouldRefreshConvoyNavigation(first, first), false);
  assert.equal(shouldRefreshConvoyNavigation(first, [[149.51005, -33.41], [149.62, -33.42]]), false);
  assert.equal(shouldRefreshConvoyNavigation(first, [[149.52, -33.41], [149.62, -33.42]]), true);
  assert.equal(shouldRefreshConvoyNavigation(first, [[149.51, -33.41], [149.63, -33.42]]), true);
});
