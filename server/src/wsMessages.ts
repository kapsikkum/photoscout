import { CODE_PATTERN, DEFAULT_REGROUP_SEPARATION_M, MAX_CONVOY_MESSAGE_LENGTH, MAX_CONVOY_ROUTE_STOPS, MAX_LABEL, MAX_NAME, MAX_REGROUP_SEPARATION_M, MIN_REGROUP_SEPARATION_M, normalizeCode } from './convoy.js';

/**
 * What a client may say on the socket, checked field by field before anything
 * acts on it. Every message is one JSON object with a `t` that names it; a
 * field that is not listed is dropped, a listed one that is the wrong shape
 * refuses the whole message.
 */

/** Metres per second: about 430 km/h, above which a "speed" is a bad sensor or somebody's idea of a joke. */
const MAX_SPEED = 120;

export type ClientMessage =
  | { t: 'ping' }
  | { t: 'convoy.message'; room: string; text: string; clientId: string }
  | { t: 'chat.sub' }
  | { t: 'chat.unsub' }
  | { t: 'convoy.create'; name: string; automaticRegroup: { enabled: boolean; separationM: number } }
  | { t: 'convoy.join'; code: string }
  | { t: 'convoy.cruise'; eventId: string }
  | { t: 'convoy.leave'; room: string }
  | { t: 'convoy.dest'; room: string; destination: { lat: number; lng: number; label: string } | null }
  | { t: 'convoy.mode'; room: string; cruising: boolean }
  | { t: 'convoy.rest'; room: string; action: 'find' | 'continue' }
  | { t: 'convoy.route'; room: string; route: { name: string; stops: [number, number][] } | null }
  | { t: 'convoy.lead'; room: string; to: string }
  | { t: 'convoy.remove'; room: string; id: string }
  | { t: 'pos.stop' }
  | { t: 'pos'; lat: number; lng: number; heading: number | null; speed: number | null };

export type ParsedMessage = { ok: true; message: ClientMessage } | { ok: false; error: string };

class Bad extends Error {}
const bad = (message: string): never => { throw new Bad(message); };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function num(o: Record<string, unknown>, field: string, min: number, max: number): number {
  const v = o[field];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return bad(`${field} must be a number from ${min} to ${max}`);
  return v;
}

/** A number, or null for "the device does not know". */
function maybeNum(o: Record<string, unknown>, field: string, min: number, max: number): number | null {
  return o[field] === undefined || o[field] === null ? null : num(o, field, min, max);
}

function str(o: Record<string, unknown>, field: string, max: number, required = false): string {
  const v = o[field] ?? '';
  if (typeof v !== 'string') return bad(`${field} must be text`);
  const t = v.trim();
  if (required && !t) return bad(`${field} is required`);
  if (t.length > max) return bad(`${field} is too long`);
  return t;
}

const id = (o: Record<string, unknown>, field: string): string => str(o, field, 64, true);

function convoyRoute(raw: unknown): { name: string; stops: [number, number][] } | null {
  if (raw === null || raw === undefined) return null;
  if (!isObject(raw)) return bad('route must be an object or null');
  if (!Array.isArray(raw.stops) || raw.stops.length < 2 || raw.stops.length > MAX_CONVOY_ROUTE_STOPS) return bad(`route needs 2 to ${MAX_CONVOY_ROUTE_STOPS} stops`);
  const stops = raw.stops.map((point) => {
    if (!Array.isArray(point) || point.length !== 2 || !point.every((n) => typeof n === 'number' && Number.isFinite(n))) return bad('each route stop must be [lng, lat]');
    const [lng, lat] = point as number[];
    if (Math.abs(lng) > 180 || Math.abs(lat) > 90) return bad('route stop is outside valid lng/lat bounds');
    return [lng, lat] as [number, number];
  });
  return { name: str(raw, 'name', MAX_NAME), stops };
}

function automaticRegroup(raw: unknown): { enabled: boolean; separationM: number } {
  if (raw === undefined) return { enabled: false, separationM: DEFAULT_REGROUP_SEPARATION_M };
  if (!isObject(raw) || typeof raw.enabled !== 'boolean') return bad('automatic regroup must include enabled');
  const separationM = num(raw, 'separationM', MIN_REGROUP_SEPARATION_M, MAX_REGROUP_SEPARATION_M);
  return { enabled: raw.enabled, separationM };
}

export function parseClientMessage(raw: string): ParsedMessage {
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return { ok: false, error: 'Messages are JSON' }; }
  if (!isObject(o) || typeof o.t !== 'string') return { ok: false, error: 'Expected an object with a t' };
  try {
    switch (o.t) {
      case 'ping':
        return { ok: true, message: { t: 'ping' } };
      case 'convoy.message':
        return { ok: true, message: { t: o.t, room: id(o, 'room'), text: str(o, 'text', MAX_CONVOY_MESSAGE_LENGTH, true), clientId: id(o, 'clientId') } };
      case 'chat.sub':
      case 'chat.unsub':
      case 'pos.stop':
        return { ok: true, message: { t: o.t } };
      case 'convoy.create':
        return { ok: true, message: { t: o.t, name: str(o, 'name', MAX_NAME), automaticRegroup: automaticRegroup(o.automaticRegroup) } };
      case 'convoy.join': {
        const code = normalizeCode(str(o, 'code', 32, true));
        if (!CODE_PATTERN.test(code)) return bad('That is not a convoy code');
        return { ok: true, message: { t: o.t, code } };
      }
      case 'convoy.cruise':
        return { ok: true, message: { t: o.t, eventId: id(o, 'eventId') } };
      case 'convoy.leave':
        return { ok: true, message: { t: o.t, room: id(o, 'room') } };
      case 'convoy.dest': {
        let destination: { lat: number; lng: number; label: string } | null = null;
        if (o.destination !== null && o.destination !== undefined) {
          if (!isObject(o.destination)) return bad('destination must be an object or null');
          destination = { lat: num(o.destination, 'lat', -90, 90), lng: num(o.destination, 'lng', -180, 180), label: str(o.destination, 'label', MAX_LABEL) };
        }
        return { ok: true, message: { t: o.t, room: id(o, 'room'), destination } };
      }
      case 'convoy.mode': {
        if (typeof o.cruising !== 'boolean') return bad('cruising must be true or false');
        return { ok: true, message: { t: o.t, room: id(o, 'room'), cruising: o.cruising } };
      }
      case 'convoy.rest': {
        const action = o.action;
        if (action !== 'find' && action !== 'continue') return bad('rest action must be find or continue');
        return { ok: true, message: { t: o.t, room: id(o, 'room'), action } };
      }
      case 'convoy.route':
        return { ok: true, message: { t: o.t, room: id(o, 'room'), route: convoyRoute(o.route) } };
      case 'convoy.remove':
        return { ok: true, message: { t: o.t, room: id(o, 'room'), id: id(o, 'id') } };
      case 'convoy.lead':
        return { ok: true, message: { t: o.t, room: id(o, 'room'), to: id(o, 'to') } };
      case 'pos':
        return { ok: true, message: { t: o.t, lat: num(o, 'lat', -90, 90), lng: num(o, 'lng', -180, 180), heading: maybeNum(o, 'heading', 0, 360), speed: maybeNum(o, 'speed', 0, MAX_SPEED) } };
      default:
        return { ok: false, error: 'Unknown message' };
    }
  } catch (err) {
    if (err instanceof Bad) return { ok: false, error: err.message };
    throw err;
  }
}
