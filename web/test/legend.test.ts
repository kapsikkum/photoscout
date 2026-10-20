import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, categoryOf, groupLayers, swatchColor } from '../src/map/legend.js';

const t = 'transportation';
const layers = [
  { id: 'road_motorway', type: 'line', 'source-layer': t, filter: ['==', ['get', 'class'], 'motorway'], paint: { 'line-color': '#e9ac77' } },
  { id: 'road_major_rail', type: 'line', 'source-layer': t, filter: ['==', ['get', 'class'], 'rail'] },
  { id: 'tunnel_transit_rail', type: 'line', 'source-layer': t, filter: ['match', ['get', 'class'], ['transit'], true, false] },
  { id: 'road_path_pedestrian', type: 'line', 'source-layer': t, filter: ['match', ['get', 'class'], ['path', 'pedestrian'], true, false] },
  { id: 'water', type: 'fill', 'source-layer': 'water', paint: { 'fill-color': 'rgb(158,189,255)' } },
  { id: 'waterway_river', type: 'line', 'source-layer': 'waterway' },
  { id: 'waterway_line_label', type: 'symbol', 'source-layer': 'waterway' },
  { id: 'building-3d', type: 'fill-extrusion', 'source-layer': 'building' },
  { id: 'boundary_2', type: 'line', 'source-layer': 'boundary' },
  { id: 'park', type: 'fill', 'source-layer': 'park' },
  { id: 'label_town', type: 'symbol', 'source-layer': 'place' },
  { id: 'poi_r1', type: 'symbol', 'source-layer': 'poi' },
  { id: 'rail-lines', type: 'line', source: 'rail' },
  { id: 'route-lines', type: 'line', source: 'routes', paint: { 'line-color': '#f97316' } },
  { id: 'route-pulse', type: 'line', source: 'routes' },
  { id: 'route-staging', type: 'symbol', source: 'route-staging-pts' },
  { id: 'rays', type: 'line', source: 'rays' },
  { id: 'night-lights', type: 'raster' },
  { id: 'fires-pts', type: 'circle', source: 'fires' },
  { id: 'background', type: 'background' },
];

test('classifies base style and overlay layers', () => {
  const got = Object.fromEntries(layers.map((l) => [l.id, categoryOf(l)]));
  assert.deepEqual(got, {
    road_motorway: 'roads', road_major_rail: 'rail-base', tunnel_transit_rail: 'rail-base', road_path_pedestrian: 'roads',
    water: 'water', waterway_river: 'water', waterway_line_label: 'labels', 'building-3d': 'buildings', boundary_2: 'boundaries',
    park: 'water', label_town: 'labels', poi_r1: 'labels', 'rail-lines': 'rail', rays: 'sun', 'night-lights': 'night-lights', 'fires-pts': 'fires',
    'route-lines': 'routes', 'route-pulse': 'routes', 'route-staging': 'routes', background: null,
  });
  assert.deepEqual(groupLayers(layers).water, ['water', 'waterway_river', 'park']);
  assert.deepEqual(groupLayers(layers).routes, ['route-lines', 'route-pulse', 'route-staging']);
});

test('swatch reads literal paint colours, else falls back', () => {
  const cat = (k: string) => CATEGORIES.find((c) => c.key === k)!;
  assert.equal(swatchColor(cat('water'), layers), 'rgb(158,189,255)');
  assert.equal(swatchColor(cat('roads'), layers), '#e9ac77');
  assert.equal(swatchColor(cat('routes'), layers), '#f97316');
  assert.equal(swatchColor(cat('boundaries'), layers), cat('boundaries').color);
});
