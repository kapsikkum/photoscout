import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  clearRoadworksCache,
  fetchRoadworks,
  parseRoadworks,
  setRoadworksCacheForTest,
} from '../src/feeds/roadworks.js';

test('parseRoadworks normalizes valid point and line features and drops malformed geometry', () => {
  const parsed = parseRoadworks({
    lastPublished: 1_792_732_830_000,
    features: [
      {
        type: 'Feature',
        id: 'works-1',
        geometry: { type: 'Point', coordinates: [151.2093, -33.8688] },
        properties: {
          displayName: 'SCHEDULED ROADWORK Harbour Bridge',
          headline: 'Lane closure',
          start: 1_792_700_000_000,
          end: 1_792_800_000_000,
          lastUpdated: 1_792_720_000_000,
          expectedDelay: 15,
          adviceA: 'Allow extra travel time',
          adviceB: 'Reduced speed limit',
          adviceC: ' ',
          periods: [{ closureType: 'LANE_CLOSURE', direction: 'Northbound' }],
        },
      },
      {
        type: 'Feature',
        id: 'works-2',
        geometry: { type: 'LineString', coordinates: [[150.9, -33.7], [151, -33.8]] },
        properties: { displayName: 'SCHEDULED ROADWORK Pacific Highway' },
      },
      {
        type: 'Feature',
        id: 'bad',
        geometry: { type: 'Point', coordinates: [999, 999] },
        properties: { displayName: 'Invalid' },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [151.2, -33.8] },
        properties: { displayName: 'SCHEDULED ROADWORK Stable fallback', start: 1_792_700_000_000 },
      },
    ],
  });

  assert.equal(parsed.lastPublished, '2026-10-23T05:20:30.000Z');
  assert.equal(parsed.roadworks.length, 3);
  assert.deepEqual(parsed.roadworks[0], {
    id: 'works-1',
    title: 'SCHEDULED ROADWORK Harbour Bridge',
    headline: 'Lane closure',
    start: '2026-10-22T20:13:20.000Z',
    end: '2026-10-24T00:00:00.000Z',
    updated: '2026-10-23T01:46:40.000Z',
    expectedDelayMinutes: 15,
    advice: ['Allow extra travel time', 'Reduced speed limit'],
    periods: [{ closureType: 'LANE_CLOSURE', direction: 'Northbound' }],
    geometry: { type: 'Point', coordinates: [151.2093, -33.8688] },
  });
  assert.deepEqual(parsed.roadworks[1].geometry, { type: 'LineString', coordinates: [[150.9, -33.7], [151, -33.8]] });
  assert.equal(parsed.roadworks[2].id, 'roadwork:SCHEDULED ROADWORK Stable fallback:151.2,-33.8:2026-10-22T20:13:20.000Z');
});

test('fetchRoadworks caches for five minutes and serves stale data when the source fails', async () => {
  clearRoadworksCache();
  let requests = 0;
  let status = 200;
  const fixture = {
    lastPublished: 1_792_732_830_000,
    features: [{ type: 'Feature', id: 'works-1', geometry: { type: 'Point', coordinates: [151.2, -33.8] }, properties: { displayName: 'SCHEDULED ROADWORK Test' } }],
  };
  const server = http.createServer((_req, res) => {
    requests++;
    if (status !== 200) { res.writeHead(status); res.end('upstream down'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(fixture));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}/roadworks.json`;

  try {
    const fresh = await fetchRoadworks(url);
    assert.equal(fresh.roadworks.length, 1);
    assert.equal(requests, 1);
    assert.deepEqual(await fetchRoadworks(url), fresh);
    assert.equal(requests, 1);

    status = 500;
    setRoadworksCacheForTest(fresh, Date.now() - 6 * 60_000, url);
    assert.deepEqual(await fetchRoadworks(url), fresh);
    assert.equal(requests, 2);

    clearRoadworksCache();
    await assert.rejects(() => fetchRoadworks(url), /NSW roadworks returned 500/);
  } finally {
    server.close();
    clearRoadworksCache();
  }
});
