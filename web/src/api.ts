/** Typed client for every server/src/index.ts endpoint. */
import { activityFetch as fetch } from './activity.js';

export type Role = 'admin' | 'moderator' | 'contributor';
export type Visibility = 'private' | 'unlisted' | 'public';

export interface User {
  id: string;
  username: string;
  avatar: string;
  role: Role;
  banned: boolean;
  created_at: string;
  bio: string;
  /** A handle without the @, empty when none. */
  instagram: string;
}

export type Provider = 'google' | 'discord';

/** How sign-in is set up, as an admin sees it. The secrets stay on the server. */
export interface AuthConfig {
  publicUrl: string;
  publicUrlFromEnv: boolean;
  adminIdsSet: boolean;
  providers: { name: Provider; clientId: string; secretSet: boolean; fromEnv: boolean; ready: boolean; redirectUrl: string }[];
}

/**
 * Whether visitors who have not signed in may read the public map (Settings → Instance).
 * `source` says where the answer came from: 'env' means PUBLIC_READS is set on the server, which wins and cannot be changed here.
 */
export interface AccessConfig {
  publicReads: boolean;
  source: 'env' | 'stored' | 'default';
}

export interface AuthStatus {
  authed: boolean;
  user: User | null;
  /** `provider:id` for the signed-in account: what an operator puts in ADMIN_IDS. */
  account: string | null;
  /** The sign-in providers this instance has set up. */
  providers: Provider[];
  /** False when this instance is private (sign-in required to read anything). */
  publicReads: boolean;
}

export type Phase = 'sunrise' | 'golden_am' | 'day' | 'golden_pm' | 'sunset' | 'blue' | 'night' | 'astro';
export type Days = 'any' | 'weekday' | 'weekend';

export interface GoodTimes {
  phases: Phase[];
  months: number[];
  days: Days;
  conditions: string[];
  eventKeywords: string[];
  avoid: string;
  notes: string;
}

export interface Place {
  id: string;
  ownerId: string;
  name: string;
  notes: string;
  access: string;
  lat: number;
  lng: number;
  geom: unknown;
  visibility: Visibility;
  source: string;
  sourceRef: string;
  createdAt: string;
  updatedAt: string;
}

export interface Spot {
  id: string;
  placeId: string | null;
  ownerId: string;
  name: string;
  notes: string;
  lat: number;
  lng: number;
  tags: string[];
  facingDeg: number | null;
  fovDeg: number | null;
  goodTimes: GoodTimes;
  visibility: Visibility;
  source: string;
  sourceRef: string;
  createdAt: string;
  updatedAt: string;
  /** From the server's spot payload: how many photos, and the cover photo's thumbnail (null when none). */
  photoCount?: number;
  coverThumbUrl?: string | null;
}

export interface Photo {
  id: string;
  spotId: string;
  kind: 'of_location' | 'taken_here';
  url: string;
  thumbUrl: string;
  w: number;
  h: number;
  takenAt: string | null;
  caption: string;
  createdAt: string;
  focalLength?: number | null;
  dateTimeOriginal?: string | null;
}

/** A place the app looks around: the map and feeds always; events and busy venues when switched on. */
export interface Area { name: string; lat: number; lng: number; radiusKm: number; events: boolean; busy: boolean; topics?: string[]; hiddenCategories?: string[] }

export interface Settings {
  /** The first area: where the map opens. */
  home: Area;
  areas: Area[];
  allowPrivateRemotes: boolean;
  /** Never the key itself — only whether one is set, and whether the environment pins it. */
  tfnswApiKeySet: boolean;
  tfnswApiKeyFromEnv: boolean;
  /** The events service's token: write-only, like the TfNSW key. */
  corsOrigins: string[];
}

export interface GeocodeResult {
  displayName: string;
  lat: number;
  lng: number;
  kind?: string;
}

export interface VersionInfo {
  version: string;
  commit: string;
  builtAt: string;
  display: string;
}

export interface FireIncident {
  id: string;
  title: string;
  category: string;
  status: string;
  sizeHa?: number;
  updated: string;
  link: string;
  geometry: GeoJSON.Geometry;
}

export interface AuroraData {
  kpNow: number | null;
  kpMaxNext24h: number | null;
}

export interface Remote {
  id: string;
  owner_id: string;
  url: string;
  last_sync: string | null;
  last_error: string | null;
  created_at: string;
}

export type RouteType = 'sprint' | 'circuit';

export interface Route {
  id: string;
  ownerId: string;
  name: string;
  notes: string;
  access: string;
  type: RouteType;
  /** Ordered [lng, lat] coordinate pairs. */
  vertices: [number, number][];
  /** Original click locations used to reconstruct a snapped route. */
  waypoints?: [number, number][];
  /** Whether to follow roads between saved waypoints. */
  snap?: boolean;
  /** Optional off-route staging location; used as planning anchor if present. */
  staging: { lat: number; lng: number } | null;
  visibility: Visibility;
  createdAt: string;
  updatedAt: string;
}

// --- phase 3: feeds ---

export interface Plane { hex: string; flight: string; lat: number; lon: number; track: number | null; gs: number | null; alt_baro: number | null; t: string; seen: number }
export interface PlaneInfo {
  type: string | null;
  manufacturer: string | null;
  registration: string | null;
  owner: string | null;
  airline: string | null;
  origin: string | null;
  destination: string | null;
}

export interface MarineHour {
  time: string;
  seaLevelHeightMsl: number | null;
  waveHeight: number | null;
  waveDirection: number | null;
  wavePeriod: number | null;
  swellWaveHeight: number | null;
  swellWaveDirection: number | null;
}

export interface TideExtreme {
  type: 'high' | 'low';
  time: string;
  height: number;
}

export interface MarineData {
  coastal: boolean;
  hourly?: MarineHour[];
  tides?: TideExtreme[];
}

export interface RailFeature extends GeoJSON.Feature { properties: { id: string; kind: 'rail' | 'industrial' | 'mine' | 'works'; usage?: string; service?: string; name?: string } }

export interface TrainPosition {
  tripId: string; routeId: string; route: string; headsign: string; lat: number; lng: number; status: 'live' | 'scheduled'; delaySec: number;
  serviceName?: string;
  bearing?: number | null; speedMps?: number | null; carriages?: number | null; network?: 'sydneytrains' | 'nswtrains' | null;
  path?: [number, number][]; pathAtKm?: number;
  /** Server snapped it onto OSM track; when false/absent the client snaps to the basemap's rail lines instead. */
  snapped?: boolean;
}
export interface TrainPass { tripId: string; routeId: string; route: string; headsign: string; at: string }
export interface TrainsStatus { configured: boolean; lastImport: string | null; tripCount: number }

export interface TrafficCamera {
  id: string;
  title: string;
  view: string;
  direction: string;
  region: string;
  imageUrl: string;
  point: [number, number];
}
export interface CamerasResponse {
  configured: boolean;
  cameras: TrafficCamera[];
}

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
  geometry: GeoJSON.Point | GeoJSON.LineString | GeoJSON.MultiLineString;
}
export interface RoadworksResponse {
  lastPublished: string | null;
  roadworks: Roadwork[];
}

export interface ScoutEvent {
  group: string; title: string; description: string; startTime: string; endTime: string; venueName: string;
  address: string; locality: string; lat: number; lng: number; imageUrl: string | null; category: string; goodDuring: boolean;
}
export interface NearbyResult {
  events: ScoutEvent[];
  crowd: { venue: string; live: number | null; typical: number | null; score: number | null; bestWindow: string | null } | null;
  status: 'ok';
}

/** An event from event-scout as this server passes it on (server/src/events.ts); starred and hidden are the caller's own. */
export interface EventItem {
  group: string;
  title: string;
  description: string;
  startTime: string;
  endTime: string | null;
  venueName: string;
  address: string;
  locality: string;
  lat: number | null;
  lng: number | null;
  imageUrl: string;
  category: string;
  priceText: string;
  isOnline: boolean;
  dateOnly: boolean;
  photoScore: number;
  /** Shared by every date of a repeating event. */
  series: string;
  /** One link to a listing, '' when there is none. */
  url: string;
  /** Where it was found, by source name, each once. */
  sources: string[];
  /** When it first showed in the list, or null. */
  foundAt: string | null;
  starred: boolean;
  hidden: boolean;
  /** Set only on an event somebody here made (see CommunityEvent); a scraped one leaves all of these out. */
  community?: boolean;
  communityId?: string;
  ownerId?: string;
  organiser?: string;
  /** How many say they are going. On a community event this is the whole count; a scraped one has it from the RSVP routes. */
  going?: number;
  /** Scraped events only: how many are interested. A community event has no "interested". */
  interested?: number;
  /** The caller's own RSVP, null for none or for a visitor. */
  myRsvp?: RsvpStatus | null;
  /** Kept for a community event that says only whether you are going. */
  isGoing?: boolean;
  /** The cruise of a community event, without its line (see Cruise). */
  cruise?: Cruise | null;
}

export type RsvpStatus = 'going' | 'interested';
export interface RsvpAttendee { id: string; username: string; avatar: string }
/** Who is coming to one event: the counts, the caller's own answer and the people behind "going". */
export interface RsvpSummary { going: number; interested: number; mine: RsvpStatus | null; attendees: RsvpAttendee[] }
export interface UserHit { id: string; username: string; avatar: string }
export type InviteKind = 'event' | 'community';
export interface Invite {
  id: string; kind: InviteKind; ref: string; from: UserHit; createdAt: string;
  /** The event as it was when the invite was read, null once it has gone. */
  event: { title: string; startsAt: string; venue: string; imageUrl: string } | null;
}
export interface InviteInbox { invites: Invite[]; pendingCount: number }
export interface KitPhoto { id: string; url: string; thumbUrl: string; w: number; h: number }
export interface RideInput { kind: 'car' | 'motorbike'; make: string; model: string; year: number | null; nickname: string; notes: string }
export interface Ride extends RideInput { id: string; ownerId: string; photos: KitPhoto[]; createdAt: string; updatedAt: string }
export interface GearInput { kind: 'camera' | 'lens' | 'other'; brand: string; name: string; notes: string }
export interface Gear extends GearInput { id: string; ownerId: string; createdAt: string; updatedAt: string }
export interface CatalogItem { brand: string; name: string; kind: 'camera' | 'lens' }
export interface ProfileHit { username: string; avatar: string }
export interface Profile extends ProfileHit {
  id: string; bio: string; instagram: string; createdAt: string;
  followers: number; following: number; isFollowing: boolean; rides: Ride[]; gear: Gear[];
}

/** An event somebody here made (server/src/app.ts), kept apart from the scraped feed above. */
export interface FeedItem {
  id: string; kind: 'checkin' | 'ride' | 'gear' | 'rsvp' | 'event'; created_at: string; author: ProfileHit;
  body: string; place_name: string; lat: number | null; lng: number | null;
  /** A route inside this app. */
  link: string; votes: number; comments: number; voted: boolean;
}
export interface FeedComment { id: string; body: string; created_at: string; author: ProfileHit }
export type CheckinInput = { body?: string } & ({ spotId: string } | { eventId: string } | { lat: number; lng: number; placeName: string });
export interface ChatMessage { id: string; body: string; created_at: string; author: ProfileHit }
export type ReportKind = 'post' | 'comment' | 'chat' | 'community_event' | 'profile' | 'ride' | 'spot';
export interface Report {
  id: string; target_kind: ReportKind; target_id: string; reason: string; created_at: string; resolved_at: string | null;
  reporter: string | null; snapshot: string | null; author: { id: string; username: string; role: Role; banned: boolean } | null;
}

/** A cruise: the route to drive, where to meet and when the cars move off. The line is a copy, so anyone who can see the event sees it. */
export interface Cruise {
  /** `vertices` is left out of a list of events; the single event has it. */
  route: { name: string; type: RouteType; vertices?: [number, number][] };
  meet: { lat: number; lng: number; note: string };
  rollOut: string;
}
/** What to send to attach one: a saved route of yours (`routeId`) or a line drawn for it (`vertices`). Leave both out to keep the current line. */
export interface CruiseInput {
  routeId?: string; vertices?: [number, number][]; name?: string; type?: RouteType;
  meet?: { lat: number; lng: number; note: string }; rollOut?: string;
}

export interface CommunityEventInput {
  title: string; description: string; startTime: string; endTime: string | null; venueName: string; address: string;
  lat: number; lng: number; priceText: string; visibility: 'public' | 'unlisted';
  /** An object attaches or changes a cruise, null takes it off, and leaving it out keeps it. */
  cruise?: CruiseInput | null;
}
export interface CommunityEvent extends Omit<CommunityEventInput, 'cruise'> {
  id: string; ownerId: string; owner: ProfileHit; going: number; isGoing: boolean; createdAt: string; updatedAt: string;
  cruise: Cruise | null;
}
export interface SpotSuggestionInput { name: string; notes: string; lat: number; lng: number }
export interface SpotSuggestion extends SpotSuggestionInput {
  id: string; createdAt: string; suggestedBy: string | null; resolvedAt: string | null; outcome: 'approved' | 'rejected' | null; spotId: string | null;
}
export interface EventState { starred: boolean; hidden: boolean }

export interface Candidate { id: string; source: string; ref: string; name: string; lat: number; lng: number; tags: Record<string, string>; fetchedAt: string }
export interface CommonsImage {
  title: string;
  pageUrl: string;
  thumbUrl: string | null;
  lat: number;
  lng: number;
  focal35?: number | null;
  focalRaw?: number | null;
  takenAt?: string | null;
  model?: string | null;
}

export interface LensBucket {
  key: string;
  label: string;
  count: number;
  pct: number;
}

export interface LensStats {
  total: number;
  buckets: LensBucket[];
  hours: number[];
  peakWindow: string | null;
  summary: string;
}

export interface CommonsResponse {
  images: CommonsImage[];
  stats: LensStats | null;
  lenses?: LensStats | null;
}

export interface TaskStatus {
  name: string; label: string; description: string; enabled: boolean; canDisable: boolean; manualOnly: boolean;
  running: boolean; blockedBy: string | null; schedule: string | null; intervalMinutes: number | null;
  lastRun: string | null; lastResult: string | null; lastOk: boolean | null; nextDue: string | null; log: string[];
}

export interface Share {
  token: string;
  owner_id: string;
  filter: string;
  created_at: string;
  revoked_at: string | null;
}

/** A refusal that carries the HTTP status, so a caller can treat 429 (too many) differently from the rest. */
export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'HttpError';
  }
}

export class Unauthorized extends Error {
  constructor(message = 'Sign in required') {
    super(message);
    this.name = 'Unauthorized';
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = (body as { error?: string }).error ?? `HTTP ${res.status}`;
    if (res.status === 401) throw new Unauthorized(message);
    throw new HttpError(message, res.status);
  }
  return res.json() as Promise<T>;
}

const jsonHeaders = { 'Content-Type': 'application/json' };

export interface WeatherHour {
  time: string; // ISO (UTC)
  tempC: number | null;
  cloudPct: number | null;
  cloudLowPct: number | null;
  cloudMidPct: number | null;
  cloudHighPct: number | null;
  precipMm: number | null;
  precipProbPct: number | null;
  windKmh: number | null;
  windDeg: number | null;
  gustKmh: number | null;
  visibilityM: number | null;
  weatherCode: number | null;
  fogLikely: boolean;
  aod: number | null;
}
export interface WeatherForecast { lat: number; lng: number; fetchedAt: string; hourly: WeatherHour[] }

export interface WindGridPoint { lat: number; lng: number; windKmh: number; windDeg: number }
export interface WindGridResponse {
  bounds: { south: number; west: number; north: number; east: number };
  cols: number;
  rows: number;
  time: string;
  grid: WindGridPoint[];
}

export const api = {
  // --- auth ---
  authStatus: () => fetch('/api/auth/status').then((r) => json<AuthStatus>(r)),
  logout: () => fetch('/api/auth/logout', { method: 'POST' }).then((r) => json<{ ok: boolean }>(r)),
  saveProfile: (patch: { username?: string; bio?: string; instagram?: string }) =>
    fetch('/api/auth/me', { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(patch) }).then((r) => json<User>(r)),
  setHandle: (username: string) =>
    fetch('/api/auth/me', { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ username }) }).then((r) => json<User>(r)),

  // --- users (admin) ---
  users: () => fetch('/api/users').then((r) => json<User[]>(r)),
  updateUser: (id: string, patch: { role?: Role; banned?: boolean }) =>
    fetch(`/api/users/${id}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(patch) }).then((r) => json<User>(r)),
  deleteUser: (id: string) => fetch(`/api/users/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),

  // --- sign-in set-up (admins) ---
  authConfig: () => fetch('/api/auth-config').then((r) => json<AuthConfig>(r)),
  saveAuthProvider: (name: Provider, body: { clientId?: string; clientSecret?: string; clear?: boolean }) =>
    fetch(`/api/auth-config/${name}`, { method: 'PUT', headers: jsonHeaders, body: JSON.stringify(body) }).then((r) => json<AuthConfig>(r)),

  // --- instance access: private (sign-in only) or public reads (admins) ---
  getAccess: () => fetch('/api/settings/access').then((r) => json<AccessConfig>(r)),
  setAccess: (publicReads: boolean) =>
    fetch('/api/settings/access', { method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ publicReads }) }).then((r) => json<AccessConfig>(r)),

  // --- settings ---
  settings: () => fetch('/api/settings').then((r) => json<Settings>(r)),
  saveSettings: (s: Partial<Settings> & { tfnswApiKey?: string; clearTfnswApiKey?: boolean }) =>
    fetch('/api/settings', { method: 'PUT', headers: jsonHeaders, body: JSON.stringify(s) }).then((r) => json<Settings>(r)),

  // --- geocode / version ---
  geocode: (q: string) => fetch(`/api/geocode?q=${encodeURIComponent(q)}`).then((r) => json<GeocodeResult[]>(r)),
  version: () => fetch('/api/version').then((r) => json<VersionInfo>(r)),

  // --- places ---
  places: () => fetch('/api/places').then((r) => json<Place[]>(r)),
  place: (id: string) => fetch(`/api/places/${id}`).then((r) => json<Place>(r)),
  createPlace: (p: Partial<Place>) =>
    fetch('/api/places', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(p) }).then((r) => json<Place>(r)),
  updatePlace: (id: string, p: Partial<Place>) =>
    fetch(`/api/places/${id}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(p) }).then((r) => json<Place>(r)),
  deletePlace: (id: string) => fetch(`/api/places/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),

  // --- spots ---
  spots: (query: { bbox?: string; near?: string; radiusKm?: number; placeId?: string } = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
    const qs = params.toString();
    return fetch(`/api/spots${qs ? `?${qs}` : ''}`).then((r) => json<Spot[]>(r));
  },
  spot: (id: string) => fetch(`/api/spots/${id}`).then((r) => json<Spot>(r)),
  createSpot: (s: Partial<Spot>) =>
    fetch('/api/spots', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(s) }).then((r) => json<Spot>(r)),
  updateSpot: (id: string, s: Partial<Spot>) =>
    fetch(`/api/spots/${id}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(s) }).then((r) => json<Spot>(r)),
  deleteSpot: (id: string) => fetch(`/api/spots/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),

  // --- photos ---
  spotPhotos: (spotId: string) => fetch(`/api/spots/${spotId}/photos`).then((r) => json<Photo[]>(r)),
  updatePhoto: (id: string, patch: { caption?: string; kind?: Photo['kind'] }) =>
    fetch(`/api/photos/${id}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(patch) }).then((r) => json<Photo>(r)),
  uploadPhoto: (spotId: string, photo: Blob, thumb: Blob, meta: { kind?: string; caption?: string; takenAt?: string; focalLength?: number | null; w?: number; h?: number } = {}) => {
    const form = new FormData();
    form.append('photo', photo);
    form.append('thumb', thumb);
    for (const [k, v] of Object.entries(meta)) if (v !== undefined && v !== null) form.append(k, String(v));
    return fetch(`/api/spots/${spotId}/photos`, { method: 'POST', body: form }).then((r) => json<Photo>(r));
  },
  deletePhoto: (id: string) => fetch(`/api/photos/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),

  // --- import / export ---
  importGeoJson: (featureCollection: unknown) =>
    fetch('/api/import', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(featureCollection) })
      .then((r) => json<{ places: number; spots: number }>(r)),
  exportGeoJsonUrl: () => '/api/export.geojson',
  exportGpxUrl: () => '/api/export.gpx',

  // --- shares ---
  shares: () => fetch('/api/shares').then((r) => json<Share[]>(r)),
  createShare: (filter: unknown = {}) =>
    fetch('/api/shares', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(filter) }).then((r) => json<{ token: string }>(r)),
  revokeShare: (token: string) => fetch(`/api/shares/${token}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),

  // --- remotes ---
  remotes: () => fetch('/api/remotes').then((r) => json<Remote[]>(r)),
  addRemote: (url: string) =>
    fetch('/api/remotes', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ url }) }).then((r) => json<Remote>(r)),
  deleteRemote: (id: string) => fetch(`/api/remotes/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),
  syncRemote: (id: string) => fetch(`/api/remotes/${id}/sync`, { method: 'POST' }).then((r) => json<{ places: number; spots: number }>(r)),

  // --- weather (Open-Meteo, hourly, UTC) ---
  weather: (lat: number, lng: number, days = 7) => fetch(`/api/weather?lat=${lat}&lng=${lng}&days=${days}`).then((r) => json<WeatherForecast>(r)),
  windGrid: (bounds: { south: number; west: number; north: number; east: number }, time?: string) =>
    fetch(`/api/weather/wind-grid?south=${bounds.south}&west=${bounds.west}&north=${bounds.north}&east=${bounds.east}${time ? `&time=${encodeURIComponent(time)}` : ''}`).then((r) => json<WindGridResponse>(r)),
  // --- marine (Open-Meteo, tides & swell) ---
  marine: (lat: number, lng: number) => fetch(`/api/marine?lat=${lat}&lng=${lng}`).then((r) => json<MarineData>(r)),
  // --- fires (NSW RFS) ---
  fires: () => fetch('/api/fires').then((r) => json<FireIncident[]>(r)),
  // --- aurora (NOAA space weather) ---
  aurora: () => fetch('/api/aurora').then((r) => json<AuroraData>(r)),
  // --- planes ---
  planes: (lat: number, lng: number, nm = 40) => fetch(`/api/planes?lat=${lat}&lng=${lng}&nm=${nm}`).then((r) => json<Plane[]>(r)),
  planeInfo: (hex: string, callsign?: string) => {
    const qs = callsign ? `?callsign=${encodeURIComponent(callsign)}` : '';
    return fetch(`/api/planes/${encodeURIComponent(hex)}/info${qs}`).then((r) => json<PlaneInfo>(r));
  },
  buildings: (lat: number, lng: number, r = 250) => fetch(`/api/buildings?lat=${lat}&lng=${lng}&r=${r}`).then((r) => json<GeoJSON.FeatureCollection>(r)),

  // --- rail ---
  rail: () => fetch('/api/rail').then((r) => json<GeoJSON.FeatureCollection>(r)),

  // --- trains ---
  trainsStatus: () => fetch('/api/trains/status').then((r) => json<TrainsStatus>(r)),
  trains: (at?: Date) => fetch(`/api/trains${at ? `?at=${at.toISOString()}` : ''}`).then((r) => json<{ configured: boolean; positions: TrainPosition[] }>(r)),
  trainPassesAt: (lat: number, lng: number, hours = 6) =>
    fetch(`/api/trains/passes?lat=${lat}&lng=${lng}&hours=${hours}`).then((r) => json<{ configured: boolean; passes: TrainPass[] }>(r)),
  spotTrains: (spotId: string, hours = 6) => fetch(`/api/spots/${spotId}/trains?hours=${hours}`).then((r) => json<{ configured: boolean; passes: TrainPass[] }>(r)),
  // --- NSW roadworks (TfNSW Live Traffic) ---
  roadworks: () => fetch('/api/roadworks').then((r) => json<RoadworksResponse>(r)),
  // --- traffic cameras (TfNSW) ---
  cameras: () => fetch('/api/cameras').then((r) => json<CamerasResponse>(r)),
  // --- Event Scout ---
  spotNearby: (spotId: string) => fetch(`/api/spots/${spotId}/nearby`).then((r) => json<NearbyResult>(r)),
  placeNearby: (placeId: string) => fetch(`/api/places/${placeId}/nearby`).then((r) => json<NearbyResult>(r)),

  // --- profiles, follows, the Kit ---
  profile: (username: string) => fetch(`/api/profiles/${encodeURIComponent(username)}`).then((r) => json<Profile>(r)),
  searchProfiles: (q: string) => fetch(`/api/profiles?q=${encodeURIComponent(q)}`).then((r) => json<ProfileHit[]>(r)),
  follows: () => fetch('/api/follows').then((r) => json<ProfileHit[]>(r)),
  follow: (username: string) => fetch(`/api/follows/${encodeURIComponent(username)}`, { method: 'PUT' }).then((r) => json<{ following: boolean }>(r)),
  unfollow: (username: string) => fetch(`/api/follows/${encodeURIComponent(username)}`, { method: 'DELETE' }).then((r) => json<{ following: boolean }>(r)),
  createRide: (ride: RideInput) =>
    fetch('/api/kit/rides', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(ride) }).then((r) => json<Ride>(r)),
  updateRide: (id: string, ride: Partial<RideInput>) =>
    fetch(`/api/kit/rides/${id}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(ride) }).then((r) => json<Ride>(r)),
  deleteRide: (id: string) => fetch(`/api/kit/rides/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),
  uploadRidePhoto: (rideId: string, photo: Blob, thumb: Blob, size: { w: number; h: number }) => {
    const form = new FormData();
    form.append('photo', photo);
    form.append('thumb', thumb);
    form.append('w', String(size.w));
    form.append('h', String(size.h));
    return fetch(`/api/kit/rides/${rideId}/photos`, { method: 'POST', body: form }).then((r) => json<Ride>(r));
  },
  deleteRidePhoto: (id: string) => fetch(`/api/kit/photos/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),
  createGear: (gear: GearInput) =>
    fetch('/api/kit/gear', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(gear) }).then((r) => json<Gear>(r)),
  updateGear: (id: string, gear: Partial<GearInput>) =>
    fetch(`/api/kit/gear/${id}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(gear) }).then((r) => json<Gear>(r)),
  deleteGear: (id: string) => fetch(`/api/kit/gear/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),
  gearCatalog: (q: string) => fetch(`/api/gear/catalog?q=${encodeURIComponent(q)}`).then((r) => json<CatalogItem[]>(r)),

  // --- community events (readable by visitors; making one and saying you are going need a session) ---
  communityEvents: () => fetch('/api/community-events').then((r) => json<CommunityEvent[]>(r)),
  communityEvent: (id: string) => fetch(`/api/community-events/${id}`).then((r) => json<CommunityEvent>(r)),
  createCommunityEvent: (ev: CommunityEventInput) =>
    fetch('/api/community-events', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(ev) }).then((r) => json<CommunityEvent>(r)),
  updateCommunityEvent: (id: string, ev: Partial<CommunityEventInput>) =>
    fetch(`/api/community-events/${id}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(ev) }).then((r) => json<CommunityEvent>(r)),
  deleteCommunityEvent: (id: string) => fetch(`/api/community-events/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),
  communityRsvp: (id: string) => fetch(`/api/community-events/${encodeURIComponent(id)}/rsvp`).then((r) => json<{ rsvp: RsvpSummary }>(r)),
  setCommunityRsvp: (id: string) =>
    fetch(`/api/community-events/${encodeURIComponent(id)}/rsvp`, { method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ status: 'going' }) }).then((r) => json<{ rsvp: RsvpSummary }>(r)),
  clearCommunityRsvp: (id: string) =>
    fetch(`/api/community-events/${encodeURIComponent(id)}/rsvp`, { method: 'DELETE' }).then((r) => json<{ rsvp: RsvpSummary }>(r)),

  // --- feed, chat and reports (the feed and a post's comments are open to visitors) ---
  feed: (scope: 'all' | 'following', before?: string) =>
    fetch(`/api/feed?scope=${scope}${before ? `&before=${encodeURIComponent(before)}` : ''}`).then((r) => json<FeedItem[]>(r)),
  checkin: (c: CheckinInput) =>
    fetch('/api/checkins', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(c) }).then((r) => json<FeedItem>(r)),
  deletePost: (id: string) => fetch(`/api/posts/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),
  votePost: (id: string, on: boolean) =>
    fetch(`/api/posts/${id}/vote`, { method: on ? 'PUT' : 'DELETE' }).then((r) => json<{ votes: number; voted: boolean }>(r)),
  comments: (postId: string) => fetch(`/api/posts/${postId}/comments`).then((r) => json<FeedComment[]>(r)),
  addComment: (postId: string, body: string) =>
    fetch(`/api/posts/${postId}/comments`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ body }) }).then((r) => json<FeedComment>(r)),
  deleteComment: (id: string) => fetch(`/api/comments/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),
  chat: (after?: string) => fetch(`/api/chat${after ? `?after=${encodeURIComponent(after)}` : ''}`).then((r) => json<ChatMessage[]>(r)),
  sendChat: (body: string) =>
    fetch('/api/chat', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ body }) }).then((r) => json<ChatMessage>(r)),
  deleteChat: (id: string) => fetch(`/api/chat/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),
  report: (targetKind: ReportKind, targetId: string, reason: string) =>
    fetch('/api/reports', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ targetKind, targetId, reason }) }).then((r) => json<{ ok: boolean }>(r)),
  reports: () => fetch('/api/reports').then((r) => json<Report[]>(r)),
  resolveReport: (id: string, action: 'dismiss' | 'hide') =>
    fetch(`/api/reports/${id}/resolve`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ action }) }).then((r) => json<{ ok: boolean }>(r)),

  // --- suggested spots (anyone signed in sends one; staff settle them) and the calendar link ---
  suggestSpot: (input: SpotSuggestionInput) =>
    fetch('/api/suggestions', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(input) }).then((r) => json<SpotSuggestion>(r)),
  suggestions: () => fetch('/api/suggestions').then((r) => json<SpotSuggestion[]>(r)),
  resolveSuggestion: (id: string, action: 'approve' | 'reject') =>
    fetch(`/api/suggestions/${id}/resolve`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ action }) }).then((r) => json<{ ok: boolean; spotId: string | null }>(r)),
  calendarLink: () => fetch('/api/calendar-link').then((r) => json<{ exists: boolean; createdAt: string | null }>(r)),
  makeCalendarLink: () => fetch('/api/calendar-link', { method: 'POST' }).then((r) => json<{ token: string; url: string }>(r)),
  revokeCalendarLink: () => fetch('/api/calendar-link', { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),

  // --- events (open to visitors; starring and hiding need a session and are your own) ---
  events: () => fetch('/api/events').then((r) => json<EventItem[]>(r)),
  event: (group: string) => fetch(`/api/events/${encodeURIComponent(group)}`).then((r) => json<EventItem>(r)),
  eventRsvp: (group: string) => fetch(`/api/events/${encodeURIComponent(group)}/rsvp`).then((r) => json<{ rsvp: RsvpSummary }>(r)),
  setEventRsvp: (group: string, status: RsvpStatus) =>
    fetch(`/api/events/${encodeURIComponent(group)}/rsvp`, { method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ status }) }).then((r) => json<{ rsvp: RsvpSummary }>(r)),
  clearEventRsvp: (group: string) =>
    fetch(`/api/events/${encodeURIComponent(group)}/rsvp`, { method: 'DELETE' }).then((r) => json<{ rsvp: RsvpSummary }>(r)),

  // --- invites (a signed-in user asks another to an event; the other accepts or dismisses) ---
  searchUsers: (q: string) => fetch(`/api/users/search?q=${encodeURIComponent(q)}`).then((r) => json<UserHit[]>(r)),
  sendInvite: (kind: InviteKind, ref: string, username: string) =>
    fetch('/api/invites', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ kind, ref, username }) }).then((r) => json<{ invite: Invite }>(r)),
  invites: () => fetch('/api/invites').then((r) => json<InviteInbox>(r)),
  acceptInvite: (id: string) => fetch(`/api/invites/${encodeURIComponent(id)}/accept`, { method: 'POST' }).then((r) => json<{ ok: boolean }>(r)),
  dismissInvite: (id: string) => fetch(`/api/invites/${encodeURIComponent(id)}/dismiss`, { method: 'POST' }).then((r) => json<{ ok: boolean }>(r)),
  setEventState: (group: string, state: Partial<EventState>) =>
    fetch(`/api/events/${encodeURIComponent(group)}/state`, { method: 'PUT', headers: jsonHeaders, body: JSON.stringify(state) })
      .then((r) => json<EventState & { group: string }>(r)),

  // --- candidates + Commons ---
  candidates: (bbox?: string) => fetch(`/api/candidates${bbox ? `?bbox=${bbox}` : ''}`).then((r) => json<Candidate[]>(r)),
  roads: (cell: string) => fetch(`/api/roads?cell=${cell}`).then((r) => json<GeoJSON.FeatureCollection>(r)),
  promoteCandidate: (id: string) => fetch(`/api/candidates/${id}/promote`, { method: 'POST' }).then((r) => json<Spot>(r)),
  spotCommons: (spotId: string) =>
    fetch(`/api/spots/${spotId}/commons`)
      .then((r) => json<CommonsResponse | CommonsImage[]>(r))
      .then((res) => {
        if (Array.isArray(res)) return { images: res, stats: null, lenses: null };
        return res;
      }),

  // --- background tasks ---
  tasks: () => fetch('/api/tasks').then((r) => json<{ tasks: TaskStatus[] }>(r)),
  runTask: (name: string) => fetch(`/api/tasks/${name}/run`, { method: 'POST' }).then((r) => json<{ ok: boolean; message: string }>(r)),

  // --- Event Scout test (TfNSW status is under "trains" above; never the key itself) ---


  // --- routes ---
  routes: () => fetch('/api/routes').then((r) => json<Route[]>(r)),
  route: (id: string) => fetch(`/api/routes/${id}`).then((r) => json<Route>(r)),
  createRoute: (route: Partial<Route>) =>
    fetch('/api/routes', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(route) }).then((r) => json<Route>(r)),
  updateRoute: (id: string, route: Partial<Route>) =>
    fetch(`/api/routes/${id}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(route) }).then((r) => json<Route>(r)),
  deleteRoute: (id: string) => fetch(`/api/routes/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),
};
