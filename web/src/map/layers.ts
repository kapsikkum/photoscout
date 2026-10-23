/** MapLibre sources and layers: base extras (imagery, DEM), light (mood, rays, shadows) and our places/spots. */
import { GeoJSONSource, Map as MlMap, type RasterTileSource, type LightSpecification } from 'maplibre-gl';
import type { EventItem, FireIncident, Place, Roadwork, Spot, TrafficCamera } from '../api.js';
import { isOver } from '../events.js';
import { cameraBearing, ICON, thumbIconId } from './spotGlance.js';
import { RAIL_COLOR } from './legend.js';
import { useOvertureBuildings } from './overture.js';
import { destination, wedge } from './geo.js';
import { buildingShadows, MIN_SHADOW_ALT, type Footprint } from './shadows.js';
import type { ShadowJob } from './shadows.worker.js';

const SHADOW_COLOR = '#0a0c1a';
import { altitudeM, flatPlaneRotation, pitchBlend, planeLabel, planeShadowPos, zoomBlend } from './planes3d.js';
import { Planes3dLayer } from './planes3dLayer.js';
import { Trains3dLayer, trainsNo3d, type Train3d } from './trains3dLayer.js';
import { registerTerrainShadowProtocol, setBuildingShadows, setTerrainShadowSun, setTerrainShadowTerrain, SHADOW_RASTER_MAX_Z } from './terrainShadowSource.js';
import { RADAR_MAX_NATIVE_Z } from './weather.js';
import { moodAt, moonPos, sunPos, sunriseSunset } from './sun.js';
import { SELECTED_BEARING_PROJECTION_SOURCE } from './sunAnchor.js';
import { initRouteLayers } from './routeLayer.js';

export const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
export const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
export const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const NIGHT_LIGHTS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png';
const FONT = ['Noto Sans Regular'];

export const CHILD_SPOT_ZOOM = 13;
export const SHADOW_ZOOM = 15;

type FC = GeoJSON.FeatureCollection;
const empty = (): FC => ({ type: 'FeatureCollection', features: [] });
const src = (map: MlMap, id: string) => map.getSource(id) as GeoJSONSource | undefined;
export const setData = (map: MlMap, id: string, data: FC) => src(map, id)?.setData(data);

/** Metres per screen pixel at the map's centre and zoom. */
export const metresPerPixel = (map: MlMap) => (156_543.03 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / 2 ** map.getZoom();

function styleLayers(map: MlMap) {
  return map.getStyle().layers ?? [];
}
export function buildingLayerIds(map: MlMap): string[] {
  return styleLayers(map).filter((l) => 'source-layer' in l && l['source-layer'] === 'building').map((l) => l.id);
}

export const DEM_SOURCE = { type: 'raster-dem' as const, tiles: [TERRARIUM], tileSize: 256, maxzoom: 14, encoding: 'terrarium' as const,
  attribution: 'Terrain: <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>' };

export function initLayers(map: MlMap) {
  try { map.setSourceTileLodParams(4.0, 1.8); } catch { /* ignore */ }
  useOvertureBuildings(map);
  const layers = styleLayers(map);
  const firstSymbol = layers.find((l) => l.type === 'symbol')?.id;
  const firstRoad = layers.find((l) => l.type === 'line' && 'source-layer' in l && l['source-layer'] === 'transportation')?.id ?? firstSymbol;
  const firstBuilding = buildingLayerIds(map)[0] ?? firstSymbol;

  map.addSource('imagery', { type: 'raster', tiles: [ESRI], tileSize: 256, maxzoom: 17, attribution: 'Imagery © Esri' });
  map.addLayer({ id: 'imagery', type: 'raster', source: 'imagery', layout: { visibility: 'none' } }, firstRoad);

  map.addSource('night-lights', { type: 'raster', tiles: [NIGHT_LIGHTS], tileSize: 256, maxzoom: 8, attribution: 'Night lights © NASA GIBS' });
  map.addLayer({ id: 'night-lights', type: 'raster', source: 'night-lights', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0 } }, firstRoad);

  map.addSource('dem', DEM_SOURCE);
  map.addSource('terrain', DEM_SOURCE); // a second source for 3D terrain, as MapLibre recommends
  map.addLayer({
    id: 'hillshade', type: 'hillshade', source: 'dem',
    paint: { 'hillshade-illumination-anchor': 'map', 'hillshade-method': 'combined', 'hillshade-exaggeration': 0.5 },
  }, firstRoad);

  map.addSource('shadows', { type: 'geojson', data: empty() });
  // One shadow raster: cast terrain shadows (ray-marched in workers), slopes facing away from the sun, and building
  // shadows rasterised into the same mask, so overlaps never darken twice. Tiles start empty-sun and follow updateShadows.
  // The 'shadows' fill stays (invisible) as the Building shadows legend handle and the polygons' GeoJSON home.
  registerTerrainShadowProtocol(SHADOW_COLOR);
  map.addSource('terrain-shadow', { type: 'raster', tiles: ['terrainshadow://{z}/{x}/{y}?az=180&alt=45'], tileSize: 256,
    minzoom: 9, maxzoom: SHADOW_RASTER_MAX_Z });
  map.addLayer({ id: 'terrain-shadow', type: 'raster', source: 'terrain-shadow', minzoom: 9, layout: { visibility: 'none' },
    paint: { 'raster-opacity': 0.3, 'raster-fade-duration': 0, 'raster-resampling': 'linear' } }, firstBuilding);
  map.addLayer({ id: 'shadows', type: 'fill', source: 'shadows', paint: { 'fill-color': SHADOW_COLOR, 'fill-opacity': 0 } }, firstBuilding);

  map.addSource('mood', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]] } } });
  map.addLayer({ id: 'mood', type: 'fill', source: 'mood', paint: { 'fill-color': '#000', 'fill-opacity': 0, 'fill-antialias': false } }, firstSymbol);

  // Ours, above everything in the base style.
  map.addSource('place-outlines', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'place-fill', type: 'fill', source: 'place-outlines', filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'fill-color': '#f5a623', 'fill-opacity': 0.08 } });
  map.addLayer({ id: 'place-line', type: 'line', source: 'place-outlines',
    paint: { 'line-color': '#f5a623', 'line-width': 2, 'line-opacity': 0.8 } });

  map.addSource('wedges', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'wedges', type: 'fill', source: 'wedges', minzoom: CHILD_SPOT_ZOOM,
    paint: { 'fill-color': ['case', ['get', 'good'], '#f5a623', '#4cc3ff'], 'fill-opacity': ['case', ['get', 'selected'], 0.4, 0.2] } });

  map.addSource('rays', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'rays', type: 'line', source: 'rays', layout: { 'line-cap': 'round' },
    paint: {
      'line-color': ['match', ['get', 'kind'], 'sun', '#ffd23f', 'moon', '#dfe7ff', 'sunrise', '#ff9d4d', '#ff6a3d'],
      'line-width': ['match', ['get', 'kind'], 'sun', 4, 'moon', 3, 2],
      'line-opacity': ['case', ['get', 'up'], 0.95, 0.4],
      'line-dasharray': ['match', ['get', 'kind'], 'sunrise', ['literal', [2, 2]], 'sunset', ['literal', [2, 2]], ['literal', [1, 0]]],
    } });

  map.addSource(SELECTED_BEARING_PROJECTION_SOURCE, { type: 'geojson', data: empty() });
  map.addLayer({ id: SELECTED_BEARING_PROJECTION_SOURCE, type: 'line', source: SELECTED_BEARING_PROJECTION_SOURCE, layout: { 'line-cap': 'round' },
    paint: {
      'line-color': '#ff2bd6',
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2.5, 16, 4.5],
      'line-opacity': 0.95,
    } });

  map.addSource('draft', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'draft-fill', type: 'fill', source: 'draft', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#4ade80', 'fill-opacity': 0.15 } });
  map.addLayer({ id: 'draft-line', type: 'line', source: 'draft', filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': '#4ade80', 'line-width': 2, 'line-dasharray': [2, 1] } });
  map.addLayer({ id: 'draft-pts', type: 'circle', source: 'draft', filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 5, 'circle-color': '#4ade80', 'circle-stroke-color': '#0e1014', 'circle-stroke-width': 2 } });

  // Persisted route overlays live above the base style and below map labels.
  initRouteLayers(map, firstSymbol);

  map.addSource('place-points', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'place-points', type: 'circle', source: 'place-points', maxzoom: CHILD_SPOT_ZOOM,
    paint: { 'circle-radius': 14, 'circle-color': '#171a21', 'circle-stroke-color': '#f5a623', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'place-count', type: 'symbol', source: 'place-points', maxzoom: CHILD_SPOT_ZOOM,
    layout: { 'text-field': ['to-string', ['get', 'count']], 'text-font': FONT, 'text-size': 12, 'text-allow-overlap': true },
    paint: { 'text-color': '#f5a623' } });
  map.addLayer({ id: 'place-label', type: 'symbol', source: 'place-points', maxzoom: CHILD_SPOT_ZOOM, minzoom: 9,
    layout: { 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 12, 'text-offset': [0, 1.7], 'text-anchor': 'top' },
    paint: { 'text-color': '#e9ecf3', 'text-halo-color': '#0e1014', 'text-halo-width': 1.5 } });

  const spotPaint = {
    'circle-radius': ['case', ['get', 'selected'], 9, 7] as any,
    'circle-color': ['case', ['get', 'good'], '#f5a623', '#4cc3ff'] as any,
    'circle-stroke-color': ['case', ['get', 'selected'], '#ffffff', '#0e1014'] as any,
    'circle-stroke-width': 2,
  };
  const spotLabel = {
    layout: { 'text-field': ['get', 'name'] as any, 'text-font': FONT, 'text-size': 12, 'text-offset': [0, 1.1] as [number, number], 'text-anchor': 'top' as const, 'text-optional': true },
    paint: { 'text-color': '#e9ecf3', 'text-halo-color': '#0e1014', 'text-halo-width': 1.5 },
  };

  map.addSource('place-spots', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'place-spots', type: 'circle', source: 'place-spots', minzoom: CHILD_SPOT_ZOOM, paint: spotPaint });
  map.addLayer({ id: 'place-spots-label', type: 'symbol', source: 'place-spots', minzoom: 14, ...spotLabel });

  map.addSource('spots', { type: 'geojson', data: empty(), cluster: true, clusterMaxZoom: 12, clusterRadius: 40 });
  map.addLayer({ id: 'clusters', type: 'circle', source: 'spots', filter: ['has', 'point_count'],
    paint: { 'circle-radius': 15, 'circle-color': '#1d212b', 'circle-stroke-color': '#4cc3ff', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'cluster-count', type: 'symbol', source: 'spots', filter: ['has', 'point_count'],
    layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': FONT, 'text-size': 12, 'text-allow-overlap': true },
    paint: { 'text-color': '#4cc3ff' } });
  map.addLayer({ id: 'spot-points', type: 'circle', source: 'spots', filter: ['!', ['has', 'point_count']], paint: spotPaint });
  map.addLayer({ id: 'spot-label', type: 'symbol', source: 'spots', filter: ['!', ['has', 'point_count']], minzoom: 12, ...spotLabel });

  // Cover-photo thumbnails floating above the dots; images load lazily via styleimagemissing (spotGlance.ts).
  const thumbs = (minzoom: number) => ({
    type: 'symbol' as const, minzoom,
    layout: {
      'icon-image': ['get', 'thumb'] as any, 'icon-anchor': 'bottom' as const, 'icon-offset': [0, -(ICON.lift - ICON.margin)] as [number, number],
      'icon-size': ['case', ['get', 'selected'], 1.15, 1] as any, 'icon-allow-overlap': true, 'icon-ignore-placement': true,
      'symbol-sort-key': ['case', ['get', 'selected'], 1, 0] as any,
    },
    paint: { 'icon-opacity': ['interpolate', ['linear'], ['zoom'], minzoom, 0, minzoom + 0.75, 1] as any },
  });
  map.addLayer({ id: 'place-spot-thumbs', source: 'place-spots', filter: ['!=', ['get', 'thumb'], ''], ...thumbs(CHILD_SPOT_ZOOM) });
  map.addLayer({ id: 'spot-thumbs', source: 'spots', filter: ['all', ['!', ['has', 'point_count']], ['!=', ['get', 'thumb'], '']], ...thumbs(12) });
}

/** Phase 3: planes, rail, trains, candidates. Kept separate from initLayers, called once alongside it. */
export function initFeedLayers(map: MlMap) {
  // Precipitation radar (RainViewer): tiles are swapped per frame by setRadarFrame; sits under our overlays.
  map.addSource('radar', { type: 'raster', tiles: [], tileSize: 256, maxzoom: RADAR_MAX_NATIVE_Z,
    attribution: 'Radar © <a href="https://www.rainviewer.com/">RainViewer</a>' });
  map.addLayer({ id: 'radar', type: 'raster', source: 'radar', layout: { visibility: 'none' },
    paint: { 'raster-opacity': 0.65, 'raster-fade-duration': 0 } }, map.getLayer('place-fill') ? 'place-fill' : undefined);

  // Rail network: lines coloured by usage/service, industrial/mine sites highlighted.
  map.addSource('rail', { type: 'geojson', data: empty() });
  map.addLayer({
    id: 'rail-lines', type: 'line', source: 'rail', filter: ['==', ['geometry-type'], 'LineString'], layout: { visibility: 'none' },
    paint: {
      'line-color': ['match', ['get', 'usage'], 'main', RAIL_COLOR, 'branch', '#7fd8a0', ['match', ['get', 'service'], 'siding', '#c98a3a', 'yard', '#c98a3a', '#8a93a6']],
      'line-width': ['match', ['get', 'usage'], 'main', 2.5, 1.5],
    },
  });
  map.addLayer({
    id: 'rail-industrial', type: 'circle', source: 'rail', filter: ['==', ['geometry-type'], 'Point'], layout: { visibility: 'none' },
    paint: { 'circle-radius': 5, 'circle-color': ['case', ['==', ['get', 'kind'], 'mine'], '#c94c3a', '#c98a3a'], 'circle-stroke-color': '#0e1014', 'circle-stroke-width': 1 },
  });

  // Planes: an emoji symbol rotated to track, a dashed +15min projection, and a ghost at map time.
  map.addSource('planes', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'planes', type: 'symbol', source: 'planes', layout: {
    visibility: 'none', 'text-field': '✈', 'text-size': 18, 'text-rotate': ['get', 'rotation'], 'text-rotation-alignment': 'map', 'text-allow-overlap': true, 'text-ignore-placement': true,
  }, paint: { 'text-halo-color': '#0e1014', 'text-halo-width': 1 } });
  map.addSource('planes-proj', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'planes-proj', type: 'line', source: 'planes-proj', layout: { visibility: 'none' },
    paint: { 'line-color': '#dfe7ff', 'line-width': 1.5, 'line-dasharray': [2, 2], 'line-opacity': 0.7 } });
  map.addSource('planes-ghost', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'planes-ghost', type: 'circle', source: 'planes-ghost', layout: { visibility: 'none' },
    paint: { 'circle-radius': 5, 'circle-color': '#dfe7ff', 'circle-opacity': 0.5, 'circle-stroke-color': '#dfe7ff', 'circle-stroke-width': 1 } });

  // 3D planes (pitched view): ground shadow silhouette and ground label, then the custom WebGL layer on top.
  // They cross-fade with the flat ✈ symbol on pitch (applyPlanePitch).
  map.addSource('planes-shadow', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'planes-shadow', type: 'symbol', source: 'planes-shadow', layout: {
    visibility: 'none', 'text-field': '✈', 'text-size': ['interpolate', ['linear'], ['zoom'], 8, 16, 14, 30],
    'text-rotate': ['get', 'rotation'], 'text-rotation-alignment': 'map', 'text-pitch-alignment': 'map', 'text-allow-overlap': true, 'text-ignore-placement': true,
  }, paint: { 'text-color': SHADOW_COLOR, 'text-opacity': 0 } }, 'planes');
  map.addSource('planes-label', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'planes-label', type: 'symbol', source: 'planes-label', layout: {
    visibility: 'none', 'text-field': ['get', 'label'], 'text-font': FONT, 'text-size': 11, 'text-offset': [0, 1],
    'text-rotation-alignment': 'map', 'text-pitch-alignment': 'map', 'text-allow-overlap': true, 'text-ignore-placement': true,
  }, paint: { 'text-color': '#dfe7ff', 'text-halo-color': '#0e1014', 'text-halo-width': 1.2, 'text-opacity': 0 } }, 'planes');
  planes3d = new Planes3dLayer();
  map.addLayer(planes3d);
  if (map.getLayer('planes-3d')) map.setLayoutProperty('planes-3d', 'visibility', 'none');
  map.on('pitch', () => applyPlanePitch(map));
  applyPlanePitch(map);

  // Trains: live (realtime position) vs scheduled (interpolated).
  map.addSource('trains', { type: 'geojson', data: empty() });
  // Live: solid green with a bright ring. Scheduled (estimate): hollow grey ring, so it reads as a guess.
  map.addLayer({ id: 'trains', type: 'circle', source: 'trains', layout: { visibility: 'none' }, paint: {
    'circle-radius': ['case', ['==', ['get', 'status'], 'live'], 7, 5],
    'circle-color': ['case', ['==', ['get', 'status'], 'live'], '#22c55e', '#8a93a6'],
    'circle-opacity': ['case', ['==', ['get', 'status'], 'live'], 1, 0.25],
    'circle-stroke-color': ['case', ['==', ['get', 'status'], 'live'], '#f0fdf4', '#8a93a6'],
    'circle-stroke-width': ['case', ['==', ['get', 'status'], 'live'], 2, 1.5],
  } });
  // 3D trains (pitched view): box carriages along the track; cross-fade with the flat markers (applyTrainPitch).
  trains3d = new Trains3dLayer();
  map.addLayer(trains3d, 'trains');
  if (map.getLayer('trains-3d')) map.setLayoutProperty('trains-3d', 'visibility', 'none');
  map.on('pitch', () => applyTrainPitch(map));
  map.on('zoom', () => applyTrainPitch(map));
  // Terrain arriving lets trains that were waiting on it go 3D.
  map.on('sourcedata', (e) => { if (!hiddenLayers.has('trains') && e.sourceId === 'terrain' && e.isSourceLoaded) map.triggerRepaint(); });
  applyTrainPitch(map);

  // Nearby list hover: a ring around the hovered plane or train.
  map.addSource('nearby-hl', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'nearby-hl', type: 'circle', source: 'nearby-hl', paint: {
    'circle-radius': 14, 'circle-color': 'rgba(245, 166, 35, 0.2)', 'circle-stroke-color': '#f5a623', 'circle-stroke-width': 2.5,
  } });

  // OSM candidates: muted, distinct from real spots.
  map.addSource('candidates', { type: 'geojson', data: empty() });
  map.addLayer({ id: 'candidates', type: 'circle', source: 'candidates', layout: { visibility: 'none' },
    paint: { 'circle-radius': 6, 'circle-color': '#6b7280', 'circle-opacity': 0.55, 'circle-stroke-color': '#e9ecf3', 'circle-stroke-width': 1, 'circle-stroke-opacity': 0.6 } });

  // OSM road quality: graded by surface/smoothness, under labels; unknown is thin and faint.
  const grade = (good: string | number, fair: string | number, poor: string | number, unknown: string | number) => ['match', ['get', 'grade'], 'good', good, 'fair', fair, 'poor', poor, unknown] as any;
  map.addSource('road-quality', { type: 'geojson', data: empty(), attribution: 'Roads © OpenStreetMap contributors' });
  map.addLayer({ id: 'road-quality', type: 'line', source: 'road-quality', minzoom: ROADS_MIN_ZOOM, layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' }, paint: {
    'line-color': grade('#22c55e', '#f59e0b', '#ef4444', '#9ca3af'),
    // zoom must be the top-level interpolate input; the per-grade factor goes inside each stop.
    'line-width': ['interpolate', ['linear'], ['zoom'], ROADS_MIN_ZOOM, ['*', 3, grade(1, 1, 1, 0.5)], 18, ['*', 7, grade(1, 1, 1, 0.5)]] as any,
    'line-opacity': grade(0.85, 0.85, 0.85, 0.5),
  } }, styleLayers(map).find((l) => l.type === 'symbol')?.id);

  // NSW RFS fire incidents: points coloured by alert level + polygons outlined
  const FIRE_COLOR = ['match', ['get', 'category'], 'Emergency Warning', '#ef4444', 'Emergency', '#ef4444', 'Watch and Act', '#f97316', 'Advice', '#eab308', '#9ca3af'] as any;
  map.addSource('fires', { type: 'geojson', data: empty(), attribution: '© NSW RFS' });
  map.addLayer({
    id: 'fires-polys-fill', type: 'fill', source: 'fires',
    filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'MultiPolygon']],
    layout: { visibility: 'none' },
    paint: { 'fill-color': FIRE_COLOR, 'fill-opacity': 0.15 },
  });
  map.addLayer({
    id: 'fires-polys-line', type: 'line', source: 'fires',
    filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'MultiPolygon']],
    layout: { visibility: 'none' },
    paint: { 'line-color': FIRE_COLOR, 'line-width': 2 },
  });
  map.addLayer({
    id: 'fires-pts', type: 'circle', source: 'fires',
    filter: ['==', ['geometry-type'], 'Point'],
    layout: { visibility: 'none' },
    paint: { 'circle-radius': 6, 'circle-color': FIRE_COLOR, 'circle-stroke-color': '#0e1014', 'circle-stroke-width': 1.5 },
  });

  // Events from Event Scout: purple dots (spots are blue, candidates grey) that cluster when close.
  map.addSource('events', { type: 'geojson', data: empty(), cluster: true, clusterMaxZoom: 13, clusterRadius: 40 });
  map.addLayer({ id: 'event-clusters', type: 'circle', source: 'events', filter: ['has', 'point_count'], layout: { visibility: 'none' },
    paint: { 'circle-radius': 15, 'circle-color': '#1d212b', 'circle-stroke-color': EVENT_COLOR, 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'event-cluster-count', type: 'symbol', source: 'events', filter: ['has', 'point_count'],
    layout: { visibility: 'none', 'text-field': ['get', 'point_count_abbreviated'], 'text-font': FONT, 'text-size': 12, 'text-allow-overlap': true },
    paint: { 'text-color': EVENT_COLOR } });
  map.addLayer({ id: 'event-points', type: 'circle', source: 'events', filter: ['!', ['has', 'point_count']], layout: { visibility: 'none' },
    paint: { 'circle-radius': 7, 'circle-color': EVENT_COLOR, 'circle-stroke-color': '#0e1014', 'circle-stroke-width': 2 } });

  map.addSource('roadworks', { type: 'geojson', data: empty(), attribution: '© Transport for NSW' });
  map.addLayer({ id: 'roadworks-line', type: 'line', source: 'roadworks',
    filter: ['any', ['==', ['geometry-type'], 'LineString'], ['==', ['geometry-type'], 'MultiLineString']],
    layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#f59e0b', 'line-width': 5, 'line-opacity': 0.85, 'line-dasharray': [2, 1] },
  });
  map.addLayer({ id: 'roadworks-points', type: 'circle', source: 'roadworks', filter: ['==', ['geometry-type'], 'Point'],
    layout: { visibility: 'none' },
    paint: { 'circle-radius': 7, 'circle-color': '#f59e0b', 'circle-stroke-color': '#0e1014', 'circle-stroke-width': 2 },
  });

  // NSW Live Traffic cameras: a camera glyph (places are plain dots) with a cone the way it looks.
  // The cone is a screen-sized icon rotated to the bearing, so it stays small at any zoom.
  if (!map.hasImage('camera')) map.addImage('camera', cameraIcon(), { pixelRatio: 2 });
  if (!map.hasImage('camera-cone')) map.addImage('camera-cone', cameraConeIcon(), { pixelRatio: 2 });
  map.addSource('cameras', { type: 'geojson', data: empty(), attribution: '© Transport for NSW' });
  map.addLayer({ id: 'camera-cones', type: 'symbol', source: 'cameras', filter: ['has', 'bearing'],
    layout: { visibility: 'none', 'icon-image': 'camera-cone', 'icon-rotate': ['get', 'bearing'], 'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true, 'icon-ignore-placement': true } });
  map.addLayer({ id: 'cameras', type: 'symbol', source: 'cameras',
    layout: { visibility: 'none', 'icon-image': 'camera', 'icon-allow-overlap': true, 'icon-ignore-placement': true } });
}

/** Layers the user has switched off (legend/chips); code that toggles visibility itself must respect this. */
/** Point the radar layer at a frame's tile URL, or hide it (null). `on` is the legend/chip state. */
export function setRadarFrame(map: MlMap, tileUrl: string | null, on: boolean) {
  const source = map.getSource('radar') as RasterTileSource | undefined;
  if (!source) return;
  if (tileUrl && radarUrl !== tileUrl) { source.setTiles([tileUrl]); radarUrl = tileUrl; }
  setLayerVisible(map, ['radar'], on && !!tileUrl);
}
let radarUrl = '';

export const hiddenLayers = new Set<string>();

export function setLayerVisible(map: MlMap, layerIds: string[], on: boolean) {
  for (const id of layerIds) {
    if (on) hiddenLayers.delete(id); else hiddenLayers.add(id);
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }
  if (layerIds.includes('terrain-shadow') || layerIds.includes('shadows')) syncShadowRaster(map);
}

export function updateRail(map: MlMap, fc: GeoJSON.FeatureCollection) {
  setData(map, 'rail', fc);
}

/** Every layer under the legend's Planes toggle. */
export const PLANE_LAYERS = ['planes', 'planes-proj', 'planes-ghost', 'planes-shadow', 'planes-label', 'planes-3d'];
let planes3d: Planes3dLayer | null = null;

/** Cross-fade flat ✈ (pitch ~0) and the 3D marker, shadow and label (pitched). Opacity only, so legend visibility stands. */
export function applyPlanePitch(map: MlMap) {
  const t = pitchBlend(map.getPitch());
  if (map.getLayer('planes')) map.setPaintProperty('planes', 'text-opacity', 1 - t);
  if (map.getLayer('planes-shadow')) map.setPaintProperty('planes-shadow', 'text-opacity', 0.35 * t);
  if (map.getLayer('planes-label')) map.setPaintProperty('planes-label', 'text-opacity', t);
}

type PlaneIn = { hex: string; flight?: string; lat: number; lon: number; track: number | null; alt_baro?: number | 'ground' | null };

export function updatePlanes(
  map: MlMap,
  planes: PlaneIn[],
  projections: { hex: string; coords: [number, number][] }[],
  ghosts: { hex: string; lat: number; lon: number }[],
  sun?: { azimuth: number; altitude: number },
) {
  setData(map, 'planes-proj', { type: 'FeatureCollection',
    features: projections.map((p) => ({ type: 'Feature', properties: { id: p.hex }, geometry: { type: 'LineString', coordinates: p.coords } })) });
  setData(map, 'planes-ghost', { type: 'FeatureCollection', features: ghosts.map((g) => ({ type: 'Feature', properties: { id: g.hex }, geometry: { type: 'Point', coordinates: [g.lon, g.lat] } })) });
  updatePlanePositions(map, planes, sun);
}

/** The parts of the planes layers that move with each plane: marker, 3D marker, label and shadow (called per animation frame). */
export function updatePlanePositions(map: MlMap, planes: PlaneIn[], sun?: { azimuth: number; altitude: number }) {
  setData(map, 'planes', { type: 'FeatureCollection', features: planes.map((p) => ({
    type: 'Feature', properties: { id: p.hex, rotation: flatPlaneRotation(p.track) }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
  })) });
  // 3D: planes with a known altitude. Shadow from the sun at map time (none at night).
  const withAlt = planes.map((p) => ({ p, alt: altitudeM(p.alt_baro) }));
  planes3d?.setPlanes(withAlt.filter((x) => x.alt != null).map(({ p, alt }) => ({ lng: p.lon, lat: p.lat, altM: alt!, track: p.track ?? 0 })));
  setData(map, 'planes-label', { type: 'FeatureCollection', features: withAlt.map(({ p, alt }) => ({
    type: 'Feature', properties: { id: p.hex, label: planeLabel(p.flight ?? '', p.hex, alt) }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
  })) });
  const shadows: GeoJSON.Feature[] = [];
  if (sun) for (const { p, alt } of withAlt) {
    if (alt == null || alt <= 0) continue;
    const pos = planeShadowPos(p.lon, p.lat, alt, sun);
    if (pos) shadows.push({ type: 'Feature', properties: { id: p.hex, rotation: flatPlaneRotation(p.track) }, geometry: { type: 'Point', coordinates: pos } });
  }
  setData(map, 'planes-shadow', { type: 'FeatureCollection', features: shadows });
}

/** Every layer under the legend's Trains toggle. */
export const TRAIN_LAYERS = ['trains', 'trains-3d'];
let trains3d: Trains3dLayer | null = null;
export function setTrains3d(trains: Train3d[]) { trains3d?.setTrains(trains); }

/** Fade the flat train markers out as the 3D carriages fade in (they stay clickable at opacity 0). */
export function applyTrainPitch(map: MlMap) {
  if (!map.getLayer('trains')) return;
  // Flat markers fade out as the 3D chains fade in; a train still waiting on terrain height stays flat.
  const k = 1 - pitchBlend(map.getPitch()) * zoomBlend(map.getZoom());
  const op = ['case', ['get', 'no3d'], 1, k] as unknown as number;
  map.setPaintProperty('trains', 'circle-opacity', ['case', ['==', ['get', 'status'], 'live'], op, ['*', 0.25, op]]);
  map.setPaintProperty('trains', 'circle-stroke-opacity', op);
}

export function updateTrains(map: MlMap, positions: { tripId: string; route: string; headsign: string; serviceName?: string; status: string; delaySec: number; lat: number; lng: number }[]) {
  setData(map, 'trains', { type: 'FeatureCollection', features: positions.map((p) => ({
    type: 'Feature', properties: { id: p.tripId, route: p.route, headsign: p.headsign, serviceName: p.serviceName ?? '', status: p.status, delaySec: p.delaySec, no3d: trainsNo3d.has(p.tripId) }, geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
  })) });
}

/** Ring the marker hovered in the Nearby list; null clears it. */
export function setNearbyHighlight(map: MlMap, at: [number, number] | null) {
  setData(map, 'nearby-hl', { type: 'FeatureCollection', features: at ? [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: at } }] : [] });
}

export function updateCandidates(map: MlMap, candidates: { id: string; name: string; lat: number; lng: number }[]) {
  setData(map, 'candidates', { type: 'FeatureCollection', features: candidates.map((c) => ({
    type: 'Feature', properties: { id: c.id, name: c.name }, geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
  })) });
}

export const ROADS_MIN_ZOOM = 13;

export function updateRoads(map: MlMap, roads: GeoJSON.FeatureCollection) {
  setData(map, 'road-quality', roads);
}

export const FIRE_LAYERS = ['fires-polys-fill', 'fires-polys-line', 'fires-pts'];

export function extractFireGeometries(geom: GeoJSON.Geometry): { point: GeoJSON.Point | null; polygons: (GeoJSON.Polygon | GeoJSON.MultiPolygon)[] } {
  let point: GeoJSON.Point | null = null;
  const polygons: (GeoJSON.Polygon | GeoJSON.MultiPolygon)[] = [];
  function walk(g: GeoJSON.Geometry) {
    if (g.type === 'Point' && !point) point = g;
    else if (g.type === 'Polygon' || g.type === 'MultiPolygon') polygons.push(g);
    else if (g.type === 'GeometryCollection') g.geometries.forEach(walk);
  }
  walk(geom);
  return { point, polygons };
}

export function firesGeoJSON(incidents: FireIncident[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const inc of incidents) {
    const p = {
      id: inc.id,
      title: inc.title,
      category: inc.category,
      status: inc.status,
      sizeHa: inc.sizeHa,
      updated: inc.updated,
      link: inc.link,
    };
    const { point, polygons } = extractFireGeometries(inc.geometry);
    if (point) {
      features.push({
        type: 'Feature',
        id: `${inc.id}-pt`,
        properties: p,
        geometry: point,
      });
    }
    polygons.forEach((poly, i) => {
      features.push({
        type: 'Feature',
        id: `${inc.id}-poly-${i}`,
        properties: p,
        geometry: poly,
      });
    });
  }
  return { type: 'FeatureCollection', features };
}

export function updateFires(map: MlMap, fires: FireIncident[]) {
  setData(map, 'fires', firesGeoJSON(fires));
}

export const ROADWORK_LAYERS = ['roadworks-line', 'roadworks-points'];
export function roadworksGeoJSON(roadworks: Roadwork[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: roadworks.map((work) => ({
      type: 'Feature',
      id: work.id,
      properties: {
        id: work.id,
        title: work.title,
        headline: work.headline,
        start: work.start ?? '',
        end: work.end ?? '',
        updated: work.updated ?? '',
        expectedDelayMinutes: work.expectedDelayMinutes ?? '',
        advice: work.advice.join(' • '),
      },
      geometry: work.geometry,
    })),
  };
}
export function updateRoadworks(map: MlMap, roadworks: Roadwork[]) {
  setData(map, 'roadworks', roadworksGeoJSON(roadworks));
}

const EVENT_COLOR = '#c084fc';
export const EVENT_LAYERS = ['event-clusters', 'event-cluster-count', 'event-points'];

/** Only events with a position are drawn, and not ones that are over or that this person has hidden. */
export function eventsGeoJSON(events: EventItem[], now = Date.now()): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const ev of events) {
    if (ev.lat == null || ev.lng == null || ev.hidden || isOver(ev, now)) continue;
    features.push({
      type: 'Feature',
      id: ev.group,
      properties: { group: ev.group, title: ev.title, category: ev.category },
      geometry: { type: 'Point', coordinates: [ev.lng, ev.lat] },
    });
  }
  return { type: 'FeatureCollection', features };
}

export function updateEvents(map: MlMap, events: EventItem[]) {
  setData(map, 'events', eventsGeoJSON(events));
}

export function camerasGeoJSON(cameras: TrafficCamera[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: cameras.map((c) => ({
      type: 'Feature',
      id: c.id,
      properties: {
        id: c.id,
        title: c.title,
        view: c.view,
        direction: c.direction,
        ...(bearingOf(c) != null ? { bearing: bearingOf(c) } : {}),
        region: c.region,
        imageUrl: c.imageUrl,
      },
      geometry: {
        type: 'Point',
        coordinates: c.point,
      },
    })),
  };
}

const bearingOf = (c: TrafficCamera) => cameraBearing(c.direction ?? '', c.view ?? '');

export function updateCameras(map: MlMap, cameras: TrafficCamera[]) {
  setData(map, 'cameras', camerasGeoJSON(cameras));
}

/** A 60° wedge pointing up from the image centre (the camera), fading out over 32 px; drawn at 2x. */
function cameraConeIcon(): ImageData {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const fade = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  fade.addColorStop(0, 'rgba(56,189,248,0.55)');
  fade.addColorStop(1, 'rgba(56,189,248,0)');
  g.fillStyle = fade;
  g.beginPath(); g.moveTo(64, 64); g.arc(64, 64, 64, -Math.PI / 2 - Math.PI / 6, -Math.PI / 2 + Math.PI / 6); g.closePath(); g.fill();
  return g.getImageData(0, 0, 128, 128);
}

/** Sky-blue camera on a dark disc, drawn at 2x. */
function cameraIcon(): ImageData {
  const c = document.createElement('canvas');
  c.width = c.height = 44;
  const g = c.getContext('2d')!;
  const disc = (r: number, y = 22) => { g.beginPath(); g.arc(22, y, r, 0, Math.PI * 2); g.fill(); };
  g.fillStyle = '#0e1014'; disc(21);
  g.fillStyle = '#38bdf8'; g.beginPath(); g.roundRect(9, 15, 26, 17, 3); g.fill(); g.fillRect(16, 11, 10, 5);
  g.fillStyle = '#0e1014'; disc(5.5, 23.5);
  g.fillStyle = '#38bdf8'; disc(3, 23.5);
  return g.getImageData(0, 0, 44, 44);
}

export const CLICKABLE = ['spot-thumbs', 'place-spot-thumbs', 'spot-points', 'place-spots', 'clusters', 'place-points', 'place-fill', 'place-line', 'candidates', 'fires-pts', 'fires-polys-fill', 'fires-polys-line', 'roadworks-line', 'roadworks-points', 'cameras', 'event-points', 'event-clusters', 'road-quality', 'route-lines', 'route-staging'];

export function setImagery(map: MlMap, on: boolean) {
  map.setLayoutProperty('imagery', 'visibility', on ? 'visible' : 'none');
}

export function setTerrain3d(map: MlMap, on: boolean) {
  map.setTerrain(on ? { source: 'terrain', exaggeration: 1.4 } : null);
  map.easeTo({ pitch: on ? 60 : 0, duration: 600 });
  if (on) {
    try {
      // Cheaper terrain mesh/textures; pokes MapLibre internals, so a version bump must not throw.
      const t = (map as any).terrain;
      if (t) {
        t.meshSize = 64;
        t.qualityFactor = 1;
        const p = (map as any).painter;
        if (p?.renderToTexture) {
          p.renderToTexture.rttSize = t.tileManager.tileSize * t.qualityFactor;
        }
      }
    } catch {
      // internals changed; keep MapLibre defaults
    }
  }
  try {
    if (on) {
      map.setSourceTileLodParams(4.0, 1.8);
    } else {
      map.setSourceTileLodParams(9.314, 3.0);
    }
  } catch {
    // Style tile managers might still be initializing
  }
}

/** Hillshade light from the sun, and a tint that follows its altitude. */
/** setPaintProperty only when the value changed: each call re-evaluates the layer and forces a repaint. */
function paint(map: MlMap, layer: string, prop: Parameters<MlMap["setPaintProperty"]>[1], value: string | number) {
  if (!map.getLayer(layer)) return map.setPaintProperty(layer, prop, value); // keep the original error path
  if (JSON.stringify(map.getPaintProperty(layer, prop)) === JSON.stringify(value)) return;
  map.setPaintProperty(layer, prop, value);
}

const lastLight = new WeakMap<MlMap, string>();
const lastBuildingShade = new WeakMap<MlMap, string>();
export function updateMood(map: MlMap, sun: { azimuth: number; altitude: number }) {
  const up = sun.altitude > 0;
  paint(map, 'hillshade', 'hillshade-illumination-direction', sun.azimuth);
  paint(map, 'hillshade', 'hillshade-illumination-altitude', Math.min(90, Math.max(2, sun.altitude)));
  paint(map, 'hillshade', 'hillshade-exaggeration', up ? 0.55 : 0.25);
  paint(map, 'hillshade', 'hillshade-highlight-color', up ? (sun.altitude < 8 ? 'rgba(255,190,120,0.55)' : 'rgba(255,255,255,0.4)') : 'rgba(0,0,0,0)');
  paint(map, 'hillshade', 'hillshade-shadow-color', up ? 'rgba(20,20,40,0.2)' : 'rgba(0,0,10,0.5)');
  const mood = moodAt(sun.altitude);
  paint(map, 'mood', 'fill-color', mood.color);
  paint(map, 'mood', 'fill-opacity', mood.opacity);
  paint(map, 'imagery', 'raster-brightness-max', Math.max(0.35, 1 - mood.opacity * 0.9));
  // Night lights only mean something after dark: none while the sun is up, full from the end of civil twilight (-6°).
  paint(map, 'night-lights', 'raster-opacity', 0.7 * Math.min(1, Math.max(0, -sun.altitude / 6)));
  // 3D buildings: lit from the sun's direction, warm near the horizon, dim and flat at night.
  const light: LightSpecification = {
    anchor: 'map',
    position: [1.5, sun.azimuth, 90 - Math.min(88, Math.max(10, sun.altitude))],
    color: !up ? '#6a7090' : sun.altitude < 8 ? '#ffc58a' : '#ffffff',
    intensity: up ? 0.5 : 0.15,
  };
  const lk = JSON.stringify(light);
  if (lastLight.get(map) !== lk) { lastLight.set(map, lk); map.setLight(light); }
  const shade = up ? (sun.altitude < 8 ? '#cbbfb3' : '#d9d6d0') : '#2a2e3d';
  if (lastBuildingShade.get(map) !== shade) {
    lastBuildingShade.set(map, shade);
    for (const id of buildingLayerIds(map)) {
      if (map.getLayer(id)?.type === 'fill-extrusion') paint(map, id, 'fill-extrusion-color', shade);
    }
  }
}

/** Current sun and moon azimuth rays from `origin`, plus the day's sunrise and sunset azimuths. */
export function updateRays(map: MlMap, origin: { lat: number; lng: number }, time: Date) {
  const km = (metresPerPixel(map) * 240) / 1000;
  const { lat, lng } = origin;
  const ray = (kind: string, az: number, up: boolean, scale = 1): GeoJSON.Feature => ({
    type: 'Feature', properties: { kind, up },
    geometry: { type: 'LineString', coordinates: [[lng, lat], destination(lat, lng, az, km * scale)] },
  });
  const sun = sunPos(time, lat, lng);
  const moon = moonPos(time, lat, lng);
  const rs = sunriseSunset(time, lat, lng);
  const features = [
    ...(rs.sunrise ? [ray('sunrise', rs.sunrise.azimuth, true, 1.15)] : []),
    ...(rs.sunset ? [ray('sunset', rs.sunset.azimuth, true, 1.15)] : []),
    ray('moon', moon.azimuth, moon.altitude > 0, 0.8),
    ray('sun', sun.azimuth, sun.altitude > 0),
  ];
  setData(map, 'rays', { type: 'FeatureCollection', features });
}

/** Building shadows for what's on screen, cleared when zoomed out or the sun is down; terrain shadow follows the sun and fades out at night. */
export function updateShadows(map: MlMap, sun: { azimuth: number; altitude: number }) {
  lastSun.set(map, sun);
  if (sun.altitude > 0) setTerrainShadowSun(map, sun);
  syncShadowRaster(map);
  if (map.getZoom() < SHADOW_ZOOM || sun.altitude <= 0) {
    const st = shadowState.get(map);
    if (st) { st.key = ''; st.id++; st.fc = null; }
    setBuildingShadows(map, null);
    return setData(map, 'shadows', empty());
  }
  const allLayers = buildingLayerIds(map).filter((id) => map.getLayer(id));
  if (!allLayers.length) return;
  // Query flat 2D fill layers when available rather than heavy 3D extruded prism geometries
  const flatLayers = allLayers.filter((id) => map.getLayer(id)?.type === 'fill');
  const layers = flatLayers.length ? flatLayers : allLayers;
  const seen = new Set<string>();
  const features: Footprint[] = [];
  for (const f of map.queryRenderedFeatures({ layers })) {
    const coords = (f.geometry as GeoJSON.Polygon).coordinates?.[0]?.[0];
    const key = `${f.id}:${coords ? `${coords[0]},${coords[1]}` : ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    features.push({ geometry: f.geometry, properties: f.properties });
    if (features.length >= 1000) break;
  }
  // Nothing changed (same buildings, sun within 0.1°): skip the polygon work entirely.
  const key = `${sun.azimuth.toFixed(1)}|${sun.altitude.toFixed(1)}|${[...seen].sort().join(',')}`;
  const st = shadowState.get(map) ?? { key: '', id: 0, fc: null };
  shadowState.set(map, st);
  if (key === st.key) return;
  st.key = key;
  const id = ++st.id;
  const w = shadowWorker();
  const done = (fc: FC) => {
    st.fc = fc;
    setData(map, 'shadows', fc);
    setBuildingShadows(map, hiddenLayers.has('shadows') ? null : fc);
  };
  if (!w) return done(buildingShadows(features, sun.azimuth, sun.altitude));
  w.onmessage = (e: MessageEvent<{ id: number; fc: GeoJSON.FeatureCollection }>) => {
    const cur = shadowState.get(map);
    if (cur && e.data.id === cur.id && map.getSource('shadows')) done(e.data.fc);
  };
  w.postMessage({ id, features, az: sun.azimuth, alt: sun.altitude } satisfies ShadowJob);
}

const shadowState = new WeakMap<MlMap, { key: string; id: number; fc: FC | null }>();
const lastSun = new WeakMap<MlMap, { azimuth: number; altitude: number }>();

/** The shadow raster carries both legend toggles: shown while the sun is up and either part is on. */
function syncShadowRaster(map: MlMap) {
  if (!map.getLayer('terrain-shadow')) return;
  const up = (lastSun.get(map)?.altitude ?? 0) > 0;
  const terrainOn = !hiddenLayers.has('terrain-shadow'), buildingsOn = !hiddenLayers.has('shadows');
  setTerrainShadowTerrain(map, terrainOn);
  setBuildingShadows(map, buildingsOn ? shadowState.get(map)?.fc ?? null : null);
  map.setLayoutProperty('terrain-shadow', 'visibility', up && (terrainOn || buildingsOn) ? 'visible' : 'none');
}
let worker: Worker | null | undefined;
/** One worker for building shadows; the latest request wins (older results are dropped by id). */
function shadowWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try { worker = new Worker(new URL('./shadows.worker.ts', import.meta.url), { type: 'module' }); } catch { worker = null; }
  return worker;
}

/** Places and spots into their sources. `good` marks spots good at map time; `selectedId` highlights one. */
export function updatePlacesAndSpots(map: MlMap, places: Place[], spots: Spot[], good: (s: Spot) => boolean, selectedId: string | null) {
  const point = (s: Spot): GeoJSON.Feature => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
    properties: { id: s.id, name: s.name, good: good(s), selected: s.id === selectedId, thumb: thumbIconId(s.coverThumbUrl) },
  });
  const placeIds = new Set(places.map((p) => p.id));
  const child = spots.filter((s) => s.placeId && placeIds.has(s.placeId));
  const standalone = spots.filter((s) => !s.placeId || !placeIds.has(s.placeId));
  const counts = new Map<string, number>();
  for (const s of child) counts.set(s.placeId!, (counts.get(s.placeId!) ?? 0) + 1);

  setData(map, 'spots', { type: 'FeatureCollection', features: standalone.map(point) });
  setData(map, 'place-spots', { type: 'FeatureCollection', features: child.map(point) });
  setData(map, 'place-points', {
    type: 'FeatureCollection',
    features: places.map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: { id: p.id, name: p.name, count: counts.get(p.id) ?? 0 } })),
  });
  setData(map, 'place-outlines', {
    type: 'FeatureCollection',
    features: places.filter((p) => p.geom).map((p) => ({ type: 'Feature', geometry: p.geom as GeoJSON.Geometry, properties: { id: p.id, name: p.name } })),
  });
  updateWedges(map, spots, good, selectedId);
}

export function updateWedges(map: MlMap, spots: Spot[], good: (s: Spot) => boolean, selectedId: string | null) {
  const km = (metresPerPixel(map) * 55) / 1000;
  setData(map, 'wedges', {
    type: 'FeatureCollection',
    features: spots.filter((s) => s.facingDeg != null).map((s) => ({
      type: 'Feature', properties: { id: s.id, good: good(s), selected: s.id === selectedId },
      geometry: { type: 'Polygon', coordinates: [wedge(s.lat, s.lng, s.facingDeg!, s.fovDeg ?? 60, km)] },
    })),
  });
}

/** The outline being drawn: its vertices, plus the line or polygon through them. */
export function updateDraft(map: MlMap, coords: [number, number][], kind: 'polygon' | 'line') {
  const features: GeoJSON.Feature[] = coords.map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } }));
  if (kind === 'polygon' && coords.length >= 3) {
    features.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...coords, coords[0]]] } });
  } else if (coords.length >= 2) {
    features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
  }
  setData(map, 'draft', { type: 'FeatureCollection', features });
}
