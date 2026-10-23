/** Legend categories: groups base-style and overlay layers by id / source-layer / filter, with swatches. */

/** Minimal layer shape (a MapLibre LayerSpecification fits). */
export interface LegendLayer {
  id: string;
  type: string;
  source?: unknown;
  'source-layer'?: string;
  filter?: unknown;
  paint?: Record<string, unknown>;
}

export type SwatchKind = 'line' | 'dashed' | 'fill' | 'dot' | 'text' | 'ring' | 'glyph' | 'camera';
export interface Category {
  key: string;
  label: string;
  group: 'Base map' | 'Overlays';
  swatch: SwatchKind;
  /** The character a 'glyph' swatch draws (the same one the map draws). */
  glyph?: string;
  /** Fallback colour when the style paint isn't a plain colour. */
  color: string;
  /** Paint property to read the colour from (on the first matching layer that has a literal). */
  paintProp?: string;
  defaultOn: boolean;
  match: (l: LegendLayer) => boolean;
}

/** Rail's colour wherever it's drawn: the highlighted base-map railways, the rail overlay's main lines, the legend. */
export const RAIL_COLOR = '#f5a623';

const sl = (l: LegendLayer) => l['source-layer'];
const f = (l: LegendLayer) => JSON.stringify(l.filter ?? null);
const isRail = (l: LegendLayer) => /\brail\b|"transit"|_rail/.test(`${l.id} ${f(l)}`);
const ids = (...list: string[]) => (l: LegendLayer) => list.includes(l.id);

// One row per thing that looks different on the map; things drawn together (e.g. the single shadow raster) share a row.
export const CATEGORIES: Category[] = [
  { key: 'roads', label: 'Roads & tracks', group: 'Base map', swatch: 'line', color: '#fc8', paintProp: 'line-color', defaultOn: true,
    match: (l) => (sl(l) === 'transportation' && !isRail(l)) || sl(l) === 'aeroway' },
  { key: 'rail-base', label: 'Railways', group: 'Base map', swatch: 'dashed', color: '#bbb', paintProp: 'line-color', defaultOn: true,
    match: (l) => sl(l) === 'transportation' && isRail(l) },
  { key: 'water', label: 'Water, parks & land use', group: 'Base map', swatch: 'fill', color: '#9ec7e8', paintProp: 'fill-color', defaultOn: true,
    match: (l) => ((sl(l) === 'water' || sl(l) === 'waterway') && l.type !== 'symbol') || ['park', 'landuse', 'landcover'].includes(sl(l) ?? '') },
  { key: 'buildings', label: 'Buildings', group: 'Base map', swatch: 'fill', color: '#d9d0c9', paintProp: 'fill-color', defaultOn: true,
    match: (l) => sl(l) === 'building' },
  { key: 'boundaries', label: 'Boundaries', group: 'Base map', swatch: 'dashed', color: '#a37da1', paintProp: 'line-color', defaultOn: true,
    match: (l) => sl(l) === 'boundary' },
  { key: 'labels', label: 'Labels & points of interest', group: 'Base map', swatch: 'text', color: '#333', paintProp: 'text-color', defaultOn: true,
    match: (l) => sl(l) === 'poi' || (l.type === 'symbol' && ['place', 'transportation_name', 'water_name', 'waterway', 'aerodrome_label', 'transportation'].includes(sl(l) ?? '')) },

  { key: 'spots', label: 'Spots & places', group: 'Overlays', swatch: 'dot', color: '#4cc3ff', defaultOn: true,
    match: ids('spot-points', 'spot-label', 'spot-thumbs', 'place-spots', 'place-spots-label', 'place-spot-thumbs', 'clusters', 'cluster-count', 'place-fill', 'place-line') },
  { key: 'routes', label: 'Routes', group: 'Overlays', swatch: 'line', color: '#f97316', paintProp: 'line-color', defaultOn: true,
    match: ids('route-glow', 'route-casing', 'route-lines', 'route-arrows', 'route-staging-halo', 'route-staging') },
  { key: 'sun', label: 'Sun/moon rays & light wedges', group: 'Overlays', swatch: 'line', color: '#ffd23f', defaultOn: true, match: ids('rays', 'wedges') },
  { key: 'terrain', label: 'Relief & shadows', group: 'Overlays', swatch: 'fill', color: '#5a5f6e', defaultOn: true, match: ids('hillshade', 'terrain-shadow', 'shadows') },
  { key: 'imagery', label: 'Satellite', group: 'Overlays', swatch: 'fill', color: '#3b5a3a', defaultOn: false, match: ids('imagery') },
  { key: 'night-lights', label: 'Night lights', group: 'Overlays', swatch: 'fill', color: '#ffd23f', defaultOn: false, match: ids('night-lights') },
  { key: 'weather', label: 'Weather', group: 'Overlays', swatch: 'fill', color: '#3aa0ff', defaultOn: false, match: ids('radar') },
  { key: 'rail', label: 'Rail', group: 'Overlays', swatch: 'line', color: RAIL_COLOR, defaultOn: false, match: ids('rail-lines', 'rail-industrial') },
  { key: 'trains', label: 'Trains', group: 'Overlays', swatch: 'ring', color: '#22c55e', defaultOn: false, match: ids('trains') },
  { key: 'planes', label: 'Planes', group: 'Overlays', swatch: 'glyph', glyph: '✈', color: '#dfe7ff', defaultOn: false, match: ids('planes', 'planes-proj', 'planes-ghost', 'planes-shadow', 'planes-label', 'planes-3d') },
  { key: 'cameras', label: 'Cameras', group: 'Overlays', swatch: 'camera', color: '#38bdf8', defaultOn: false, match: ids('camera-cones', 'cameras') },
  { key: 'roadworks', label: 'NSW roadworks', group: 'Overlays', swatch: 'line', color: '#f59e0b', defaultOn: false, match: ids('roadworks-line', 'roadworks-points') },
  { key: 'fires', label: 'Fires', group: 'Overlays', swatch: 'dot', color: 'conic-gradient(#ef4444 0 33%, #f97316 0 66%, #eab308 0)', defaultOn: false, match: ids('fires-pts', 'fires-polys-line', 'fires-polys-fill') },
  { key: 'events', label: 'Events', group: 'Overlays', swatch: 'dot', color: '#c084fc', defaultOn: false, match: ids('event-clusters', 'event-cluster-count', 'event-points') },
  { key: 'road-quality', label: 'Road quality', group: 'Overlays', swatch: 'dot', color: 'conic-gradient(#22c55e 0 33%, #f59e0b 0 66%, #ef4444 0)', defaultOn: false, match: ids('road-quality') },
  { key: 'candidates', label: 'Candidates', group: 'Overlays', swatch: 'dot', color: '#6b7280', defaultOn: false, match: ids('candidates') },
];

/** The category drawn by a map chip, so the chip shows the same swatch and label as its legend row. */
export const category = (key: string): Category => CATEGORIES.find((c) => c.key === key)!;

export function categoryOf(layer: LegendLayer): string | null {
  return CATEGORIES.find((c) => c.match(layer))?.key ?? null;
}

/** Layer ids per category key, in style order. */
export function groupLayers(layers: LegendLayer[]): Record<string, string[]> {
  const out: Record<string, string[]> = Object.fromEntries(CATEGORIES.map((c) => [c.key, [] as string[]]));
  for (const l of layers) {
    const k = categoryOf(l);
    if (k) out[k].push(l.id);
  }
  return out;
}

/** Swatch colour: the first plain-string paint value among the category's layers, else the fallback. */
export function swatchColor(cat: Category, layers: LegendLayer[]): string {
  if (cat.paintProp) {
    for (const l of layers) {
      if (!cat.match(l)) continue;
      const v = l.paint?.[cat.paintProp];
      if (typeof v === 'string') return v;
    }
  }
  return cat.color;
}

export type Visibility = Record<string, boolean>;
const KEY = 'ls.legend';
export function defaultVisibility(): Visibility {
  return Object.fromEntries(CATEGORIES.map((c) => [c.key, c.defaultOn]));
}
export function loadVisibility(): Visibility {
  const v = defaultVisibility();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    for (const k of Object.keys(v)) if (typeof saved[k] === 'boolean') v[k] = saved[k];
  } catch { /* no storage */ }
  return v;
}
export function saveVisibility(v: Visibility) {
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* no storage */ }
}
