/** NSW Live Traffic roadworks feed. Public GeoJSON, cached for 5 min and stale-on-error. */

export type Position = [number, number];
export type RoadworkGeometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'LineString'; coordinates: Position[] }
  | { type: 'MultiLineString'; coordinates: Position[][] };

export interface Roadwork {
  id: string;
  title: string;
  headline: string;
  start: string | null;
  end: string | null;
  updated: string | null;
  expectedDelayMinutes: number | null;
  advice: string[];
  periods: Record<string, unknown>[];
  geometry: RoadworkGeometry;
}

export interface RoadworksData {
  lastPublished: string | null;
  roadworks: Roadwork[];
}

const iso = (value: unknown): string | null => {
  const ms = Number(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const validPosition = (value: unknown): value is [number, number] =>
  Array.isArray(value) && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))
  && Math.abs(Number(value[0])) <= 180 && Math.abs(Number(value[1])) <= 90;

function geometryOf(value: unknown): RoadworkGeometry | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { type?: unknown; coordinates?: unknown };
  if (raw.type === 'Point' && validPosition(raw.coordinates)) {
    return { type: 'Point', coordinates: [Number(raw.coordinates[0]), Number(raw.coordinates[1])] };
  }
  if (raw.type === 'LineString' && Array.isArray(raw.coordinates) && raw.coordinates.length >= 2 && raw.coordinates.every(validPosition)) {
    const coordinates = raw.coordinates as Position[];
    return { type: 'LineString', coordinates: coordinates.map(([lng, lat]) => [Number(lng), Number(lat)]) };
  }
  if (raw.type === 'MultiLineString' && Array.isArray(raw.coordinates)
    && raw.coordinates.every((line) => Array.isArray(line) && line.length >= 2 && line.every(validPosition))) {
    const coordinates = raw.coordinates as Position[][];
    return { type: 'MultiLineString', coordinates: coordinates.map((line) => line.map(([lng, lat]) => [Number(lng), Number(lat)])) };
  }
  return null;
}

/** Pure defensive parser for the public TfNSW roadwork FeatureCollection. */
export function parseRoadworks(raw: unknown): RoadworksData {
  if (!raw || typeof raw !== 'object') return { lastPublished: null, roadworks: [] };
  const source = raw as { lastPublished?: unknown; features?: unknown };
  const features = Array.isArray(source.features) ? source.features : [];
  const roadworks: Roadwork[] = [];
  for (const feature of features) {
    if (!feature || typeof feature !== 'object') continue;
    const f = feature as { id?: unknown; geometry?: unknown; properties?: unknown };
    const geometry = geometryOf(f.geometry);
    if (!geometry) continue;
    const props = f.properties && typeof f.properties === 'object' ? f.properties as Record<string, unknown> : {};
    const title = text(props.displayName) || text(props.name) || 'Scheduled roadwork';
    const start = iso(props.start);
    const geometryKey = geometry.type === 'Point' ? geometry.coordinates.join(',') : JSON.stringify(geometry.coordinates);
    const id = text(f.id) || text(props.id) || `roadwork:${title}:${geometryKey}:${start ?? ''}`;
    const advice = [props.adviceA, props.adviceB, props.adviceC].map(text).filter((v, i, all) => Boolean(v) && all.indexOf(v) === i);
    const periods = Array.isArray(props.periods) ? props.periods.filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === 'object' && !Array.isArray(p)) : [];
    const expectedDelay = Number(props.expectedDelay);
    roadworks.push({
      id,
      title,
      headline: text(props.headline),
      start,
      end: iso(props.end),
      updated: iso(props.lastUpdated),
      expectedDelayMinutes: Number.isFinite(expectedDelay) && expectedDelay >= 0 ? expectedDelay : null,
      advice,
      periods,
      geometry,
    });
  }
  return { lastPublished: iso(source.lastPublished), roadworks };
}

export const ROADWORKS_FEED_URL = 'https://data.livetraffic.com/traffic/hazards/roadwork-open.json';
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5 * 60_000;
let cache: { at: number; url: string; data: RoadworksData } | null = null;
let inflight: Promise<RoadworksData> | null = null;

export function clearRoadworksCache(): void {
  cache = null;
  inflight = null;
}

export function setRoadworksCacheForTest(data: RoadworksData, at: number, url = ROADWORKS_FEED_URL): void {
  cache = { at, url, data };
}

export async function fetchRoadworks(url = ROADWORKS_FEED_URL): Promise<RoadworksData> {
  if (cache && cache.url === url && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  if (inflight) return inflight;
  inflight = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'photoscout/0.1' }, signal: controller.signal });
      if (!res.ok) throw new Error(`NSW roadworks returned ${res.status}`);
      const data = parseRoadworks(await res.json());
      cache = { at: Date.now(), url, data };
      return data;
    } catch (err) {
      if (cache && cache.url === url) return cache.data;
      throw err;
    } finally {
      clearTimeout(timer);
      inflight = null;
    }
  })();
  return inflight;
}
