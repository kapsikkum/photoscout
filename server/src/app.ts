import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, photosDir } from './db.js';
import helmet from 'helmet';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import {
  SessionUser, Visibility,
  canEdit, canRead, isStaff, needsAuth, originAllowed, readCookie, requireAdmin, requireUser, secureEqual, HANDLE, OAUTH_COOKIE, SESSION_COOKIE,
} from './auth.js';
import {
  accountIdOf, createSession, deleteSession, deleteUser, findUserById, findUserByUsername, listUsers,
  sessionUser, setProfile, setUserBanned, setUserRole, setUsername, upsertOAuthUser, usernameTaken,
} from './authStore.js';
import {
  bodyProblem, CHAT_MINUTES, MAX_CHAT_BODY, MAX_POST_BODY, parseCheckin, parseCommunityEvent, parseGear, parseMessage, parseProfile, parseReport, parseRide, parseSuggestion,
} from './bodyLimits.js';
import { catalog, searchCatalog } from './gearCatalog.js';
import { authConfigView, configuredProviders, generateCodeVerifier, generateState, provider, publicUrl, updateCredentials } from './oauth.js';
import { corsDecision, readOrigins } from './cors.js';
import { accessConfigView, publicReads, setPublicReads } from './access.js';
import { applySettingsUpdate, getSettings, memberSettings, publicSettings, tfnswKey } from './settings.js';
import { geocode, GeocoderBusyError } from './geocode.js';
import { routing } from './routing.js';
import { bboxFromRadius, haversine, parseBbox, parseLatLng } from './geo.js';
import { parseGoodTimes, GoodTimesError, DEFAULT_GOOD_TIMES } from './goodTimes.js';
import { fetchPlanes, fetchPlaneInfo, isValidHex, isValidCallsign } from './feeds/planes.js';
import { fetchWeather, fetchWindGrid } from './feeds/weather.js';
import { fetchMarine } from './feeds/marine.js';
import { fetchFires } from './feeds/rfs.js';
import { fetchAurora } from './feeds/spaceWeather.js';
import { fetchBuildings } from './sources/osm.js';
import { fetchRoadCell, parseCell } from './sources/roads.js';
import { fetchCameras } from './feeds/cameras.js';
import { fetchRoadworks } from './feeds/roadworks.js';
import {
  buildPointPassesResponse, combinedFeedData, combinedRealtime, emptyFeedData, nextPasses, parsePointPassRequest, predictTrainPositions, tripCount, TRAIN_FEEDS,
} from './feeds/trains.js';
import { nearbyFor } from './feeds/eventScout.js';
import { eventsApi } from './events/index.js';
import { syncEngineAreas } from './events/areas.js';
import { syncCrawler } from './events/sources/crawler.js';
import { eventList, flyerIsShown, forgetEventList, MAX_GROUP_LENGTH, setUserEventState, userEventStates, withState, type EventItem } from './events.js';
import { clearEventRsvp, communityRsvpSummary, eventRsvpSummary, eventRsvpTotals, isRsvpStatus, setEventRsvp, withRsvps } from './eventRsvps.js';
import { addInvite, findInvite, inviteTo, MAX_INVITES_PER_HOUR, MAX_PENDING_PER_PAIR, sentLastHour, setInviteStatus, waitingBetween, waitingInviteCount, waitingInvites, type InviteRow } from './invites.js';
import { flyerRelative, isSafeFlyerPath } from './events/flyers.js';
import { store as flyerStore } from './events/flyerStore.js';
import { buildIcs } from './events/ics.js';
import { calendarTokenInfo, issueCalendarToken, revokeCalendarToken, userForCalendarToken } from './calendarToken.js';
import { addSuggestion, listSuggestions, resolveSuggestion, suggestionJson, suggestionRefusal } from './suggestions.js';
import { getCachedRail, requestTilesForUnsnapped, trackGraphFor } from './sources/rail.js';
import { commonsNearbyCached, lensStats } from './sources/commons.js';
import { coverFields, deleteImages, detectImageType, MAX_PHOTO_BYTES, parseMultipart, photoMeta, saveImage, SPOT_COVER_COLS } from './photos.js';
import { buildGpx } from './gpx.js';
import { buildFeatureCollection, ImportError, importFeatureCollection, ShareBundle, syncRemote } from './share.js';
import { assertPublicUrl, guardedFetch } from './ssrf.js';
import { tasks } from './tasks/tasks.js';
import { versionInfo } from './version.js';
import { isRouteType, parseRouteSnap, parseRouteStaging, parseRouteVertices, serializeRouteWaypoints, routeJson, type RouteRow } from './routes.js';
import { chatFeed } from './realtime.js';
import { cruiseJson, readCruise, resolveCruise } from './cruise.js';
import { mountPlugins } from './plugins/routes.js';
import { pluginRuntime } from './plugins/host.js';
import crypto from 'node:crypto';

declare global {
  namespace Express {
    interface Request {
      user: SessionUser | null;
    }
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');

function trustProxySetting(raw: string | undefined): boolean | number | string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  if (value === 'true' || value === 'false') return value === 'true';
  return value;
}
const trustProxy = trustProxySetting(process.env.TRUST_PROXY);
if (trustProxy !== undefined) app.set('trust proxy', trustProxy);

// --- headers ----------------------------------------------------------------

// The map draws tiles, terrain and radar from a dozen hosts and runs its
// shadow maths in blob workers, so images, fetches and workers are open to
// https; scripts are not, which is the part that matters.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:', 'https:'],
        'connect-src': ["'self'", 'https:'],
        'worker-src': ["'self'", 'blob:'],
        // Radio streams: the Radio Garden plugin's /stations/<id>/listen redirects to radio.garden and on to the station.
        'media-src': ["'self'", 'https:'],
        // The installable app: its manifest and the service worker that lets it open offline.
        'manifest-src': ["'self'"],
        'font-src': ["'self'", 'data:', 'https:'],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
    // Photos and exports are fetched by other PhotoScouts through a share link.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })
);

app.use(express.json({ limit: '2mb' }));

// --- CORS, the session, the origin check, the limits, then the gate ----------

app.use('/api', (req, res, next) => {
  const decision = corsDecision(
    {
      origin: req.headers.origin,
      method: req.method,
      path: req.baseUrl + req.path,
      requestMethod: req.headers['access-control-request-method'] as string | undefined,
    },
    readOrigins(getSettings(db).corsOrigins),
    // The same access mode the sign-in gate below uses, so CORS never offers what that gate refuses.
    publicReads(db)
  );
  if (decision) {
    res.vary(decision.vary);
    res.set(decision.headers);
    if (decision.preflight) return res.sendStatus(204);
  }
  next();
});

app.use('/api', (req, _res, next) => {
  req.user = sessionUser(db, readCookie(req.headers.cookie, SESSION_COOKIE));
  next();
});

app.use('/api', (req, res, next) => {
  if (originAllowed(req.method, req.headers.origin, publicUrl())) return next();
  res.status(403).json({ error: 'Cross-site request refused' });
});

/**
 * Limits by who is asking: the account when there is one, otherwise the
 * address. Counted in memory, which is right for one process and wrong for
 * several.
 * ponytail: per-process counters; move to a shared store if this ever runs as more than one instance.
 */
const limitKey = (req: express.Request): string => (req.user ? `u:${req.user.id}` : ipKeyGenerator(req.ip ?? ''));
const limit = (windowMs: number, max: number, what: string) =>
  rateLimit({
    windowMs,
    limit: max,
    keyGenerator: limitKey,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => process.env.RATE_LIMITS === 'off',
    message: { error: `Too many ${what} — slow down and try again shortly` },
  });

const MINUTE = 60_000;
// Everything, as a ceiling. A map screen makes a burst of requests when it
// opens, so this is generous; the tighter ones below are what bite.
app.use('/api', limit(MINUTE, 600, 'requests'));
// Sign-in round trips, by address: nobody has an account yet at this point.
// Not the status check, which every page load makes.
app.use(/^\/api\/auth\/[^/]+\/(start|callback)$/, limit(10 * MINUTE, 40, 'sign-in attempts'));
// Anything that changes something.
app.use('/api', (req, res, next) =>
  req.method === 'GET' || req.method === 'HEAD' ? next() : writeLimit(req, res, next)
);
const writeLimit = limit(MINUTE, 90, 'changes');
// Routes that make this server ask somebody else's: each request here costs a
// third party one, so they are counted on their own and kept low.
const upstreamLimit = limit(MINUTE, 60, 'lookups');
app.use(
  ['/api/geocode', '/api/route', '/api/planes', '/api/weather', '/api/marine', '/api/buildings', '/api/roads', '/api/cameras', '/api/candidates', '/api/plugins/media.24thframe.radio-garden'],
  upstreamLimit
);
app.use(/^\/api\/(spots|places)\/[^/]+\/(nearby|commons|trains)$/, upstreamLimit);
/** Photo uploads: each is held in memory while it is checked, so few at a time. */
const uploadLimit = limit(10 * MINUTE, 60, 'uploads');
/** The one public chat room: ten lines a minute each. */
const chatLimit = limit(MINUTE, 10, 'messages');

app.use('/api', (req, res, next) => {
  // Private unless an admin (or PUBLIC_READS) allows public reads; then a plugin's own route is open
  // only where that plugin declares it public (plugin.json "public"). Sign-in routes are open either way.
  if (!needsAuth(req.method, req.baseUrl + req.path, (id, method, rest) => pluginRuntime.isPublicRoute(id, method, rest), publicReads(db))) return next();
  if (req.user) return next();
  res.status(401).json({ error: 'Sign in required' });
});

/**
 * Sizes and ranges for what people type into a place, a spot or a route.
 * The handlers below check what each field means; this only refuses the
 * shapes none of them should ever be handed, in one place.
 */
app.use(['/api/places', '/api/spots', '/api/routes'], (req, res, next) => {
  if (req.method !== 'POST' && req.method !== 'PATCH') return next();
  const problem = bodyProblem((req.body ?? {}) as Record<string, unknown>);
  if (problem) return res.status(400).json({ error: problem });
  next();
});

// --- auth -------------------------------------------------------------------

const secureCookie = {
  httpOnly: true,
  get secure() {
    return publicUrl().startsWith('https:');
  },
  sameSite: 'lax' as const,
  path: '/',
};

app.get('/api/auth/status', (req, res) => {
  res.json({
    authed: Boolean(req.user),
    user: req.user ? findUserById(db, req.user.id) : null,
    // What to put in ADMIN_IDS to make this account an admin. Its own, and only to itself.
    account: req.user ? accountIdOf(db, req.user.id) : null,
    providers: configuredProviders(db),
    publicReads: publicReads(db),
  });
});

/** Send the browser to the provider, remembering what was sent so the answer can be checked. */
app.get('/api/auth/:provider/start', (req, res) => {
  const p = provider(db, req.params.provider);
  if (!p) return res.status(404).json({ error: 'That sign-in is not set up' });
  const state = generateState();
  const verifier = generateCodeVerifier();
  res.cookie(OAUTH_COOKIE, `${req.params.provider}.${state}.${verifier}`, { ...secureCookie, maxAge: 10 * MINUTE });
  res.redirect(p.authorizationUrl(state, verifier).toString());
});

/**
 * The provider's answer. The state in the query has to be the one in the
 * cookie this browser was given at the start, which is what stops somebody
 * else's sign-in being finished in this browser.
 */
app.get('/api/auth/:provider/callback', async (req, res) => {
  const fail = (why: string) => res.redirect(`/login?error=${encodeURIComponent(why)}`);
  const [name, state, verifier] = (readCookie(req.headers.cookie, OAUTH_COOKIE) ?? '').split('.');
  res.clearCookie(OAUTH_COOKIE, secureCookie);
  const p = provider(db, req.params.provider);
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const returned = typeof req.query.state === 'string' ? req.query.state : '';
  if (!p || !code || !state || !verifier || name !== req.params.provider || !secureEqual(returned, state)) {
    return fail('Sign-in could not be completed. Please try again.');
  }
  try {
    const profile = await p.profile(code, verifier);
    const user = upsertOAuthUser(db, { provider: req.params.provider, ...profile });
    if (user.banned) return fail('This account has been suspended.');
    const { token, maxAgeMs } = createSession(db, user.id);
    res.cookie(SESSION_COOKIE, token, { ...secureCookie, maxAge: maxAgeMs });
    res.redirect('/');
  } catch (err) {
    console.error(`[auth] ${req.params.provider} sign-in failed:`, (err as Error).message);
    fail('Sign-in could not be completed. Please try again.');
  }
});

app.post('/api/auth/logout', (req, res) => {
  deleteSession(db, readCookie(req.headers.cookie, SESSION_COOKIE));
  res.clearCookie(SESSION_COOKIE, secureCookie);
  res.json({ ok: true });
});

/** Change your own handle, bio and Instagram handle; send any of them. */
app.patch('/api/auth/me', (req, res) => {
  const username = (req.body as { username?: unknown } | undefined)?.username;
  const profile = parseProfile(req.body ?? {});
  if (!profile.ok) return res.status(400).json({ error: profile.error });
  if (username === undefined && profile.value.bio === undefined && profile.value.instagram === undefined) {
    return res.status(400).json({ error: 'Send a handle, a bio or an Instagram handle' });
  }
  if (username !== undefined) {
    if (typeof username !== 'string' || !HANDLE.test(username)) {
      return res.status(400).json({ error: 'A handle is 3 to 24 letters, digits or underscores' });
    }
    const me = findUserById(db, req.user!.id);
    if (me && me.username.toLowerCase() !== username.toLowerCase() && usernameTaken(db, username)) {
      return res.status(409).json({ error: 'That handle is taken' });
    }
    setUsername(db, req.user!.id, username);
  }
  setProfile(db, req.user!.id, profile.value);
  res.json(findUserById(db, req.user!.id));
});

// --- users (admin) -----------------------------------------------------------

app.get('/api/users', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(listUsers(db));
});
app.patch('/api/users/:id', (req, res) => {
  if (!isStaff(req.user)) return res.status(403).json({ error: 'Admins only' });
  const target = findUserById(db, req.params.id);
  if (!target) return res.status(404).json({ error: 'No such user' });
  const { role, banned } = (req.body ?? {}) as { role?: unknown; banned?: unknown };
  // A moderator may suspend or reinstate a contributor and nothing else.
  if (req.user!.role === 'moderator' && (role !== undefined || target.role !== 'contributor')) {
    return res.status(403).json({ error: 'Moderators can only suspend or reinstate contributors' });
  }
  const self = req.params.id === req.user!.id;
  if (role !== undefined) {
    if (role !== 'admin' && role !== 'moderator' && role !== 'contributor') return res.status(400).json({ error: 'role must be admin, moderator or contributor' });
    if (self) return res.status(400).json({ error: 'Cannot change your own role' });
    setUserRole(db, req.params.id, role);
  }
  if (banned !== undefined) {
    if (typeof banned !== 'boolean') return res.status(400).json({ error: 'banned must be true or false' });
    if (self) return res.status(400).json({ error: 'Cannot suspend your own account' });
    setUserBanned(db, req.params.id, banned);
  }
  res.json(findUserById(db, req.params.id));
});
app.delete('/api/users/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (req.params.id === req.user!.id) return res.status(400).json({ error: 'Cannot delete your own account' });
  deleteUser(db, req.params.id);
  res.json({ ok: true });
});

/** Sign-in set-up, for Settings → Sign-in. The secrets themselves never leave the server. */
app.get('/api/auth-config', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(authConfigView(db));
});
app.put('/api/auth-config/:provider', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const refused = updateCredentials(db, req.params.provider, (req.body ?? {}) as Record<string, unknown>);
  if (refused) return res.status(400).json({ error: refused });
  res.json(authConfigView(db));
});

/**
 * Whether visitors who have not signed in may read the public map, for
 * Settings → Instance. Private unless this says otherwise. PUBLIC_READS in the
 * environment wins; a save is refused while it is set, rather than stored where it would do nothing.
 */
app.get('/api/settings/access', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(accessConfigView(db));
});
app.put('/api/settings/access', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const value = (req.body as { publicReads?: unknown } | undefined)?.publicReads;
  if (typeof value !== 'boolean') return res.status(400).json({ error: 'publicReads must be true or false' });
  if (accessConfigView(db).source === 'env') return res.status(409).json({ error: 'Set by PUBLIC_READS in the environment — change it there' });
  setPublicReads(db, value);
  res.json(accessConfigView(db));
});

// --- settings -----------------------------------------------------------------

app.get('/api/settings', (req, res) => {
  const settings = getSettings(db);
  res.json(req.user?.role === 'admin' ? publicSettings(settings) : memberSettings(settings));
});
app.put('/api/settings', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { settings, keyChanged, areasChanged } = applySettingsUpdate(db, (req.body ?? {}) as Record<string, unknown>);
  // The engine's areas are written from this list, and the crawler told at once
  // rather than at the next refresh. Not awaited: a crawler that is down must not fail a save.
  if (areasChanged) {
    void syncCrawler(syncEngineAreas(settings));
    forgetEventList();
  }
  // A new key means timetables can now be pulled: start the import in the background.
  if (keyChanged && settings.tfnswApiKey) {
    void (async () => {
      for (const name of ['trains-static-nswtrains', 'trains-static-sydneytrains']) {
        await tasks.run(name, { force: true }).catch(() => {});
      }
    })();
  }
  res.json(publicSettings(settings));
});

// --- geocode / version ----------------------------------------------------------

app.get('/api/geocode', async (req, res, next) => {
  try {
    const q = String(req.query.q ?? '').trim();
    if (!q) return res.json([]);
    res.json(await geocode(db, q));
  } catch (err) {
    if (err instanceof GeocoderBusyError) return res.status(503).json({ error: 'Geocoder busy, try again shortly' });
    next(err);
  }
});

app.get('/api/version', (_req, res) => res.json(versionInfo()));

// --- driving routes (OSRM, behind the sign-in gate and the upstream limit) -----------

app.use(routing);

// --- places / spots: shared visibility helpers ---------------------------------

/** SQL fragment (with its params) restricting rows to what `user` may list. Unlisted rows never appear in a list, and a suspended owner's public rows are out of sight. */
function listVisibilityWhere(user: SessionUser | null | undefined): { sql: string; params: string[] } {
  const publicRow = "(visibility = 'public' AND owner_id NOT IN (SELECT id FROM users WHERE banned = 1))";
  if (user) return { sql: `(${publicRow} OR (visibility = 'private' AND owner_id = ?))`, params: [user.id] };
  return { sql: publicRow, params: [] };
}

/** Who may delete a row: whoever may edit it, and a moderator for anything that is not private, so abuse on the public map can be removed. */
function canRemove(row: { visibility: Visibility; owner_id: string }, user: SessionUser | null | undefined): boolean {
  return canEdit(row.owner_id, user ?? null) || (user?.role === 'moderator' && row.visibility !== 'private');
}

interface PlaceRow {
  id: string; owner_id: string; name: string; notes: string; access: string; lat: number; lng: number;
  geom: string | null; visibility: Visibility; source: string; source_ref: string; created_at: string; updated_at: string;
}
function placeJson(r: PlaceRow) {
  return {
    id: r.id, ownerId: r.owner_id, name: r.name, notes: r.notes, access: r.access, lat: r.lat, lng: r.lng,
    geom: r.geom ? JSON.parse(r.geom) : null, visibility: r.visibility, source: r.source, sourceRef: r.source_ref,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

interface SpotRow {
  id: string; place_id: string | null; owner_id: string; name: string; notes: string; lat: number; lng: number;
  tags: string; facing_deg: number | null; fov_deg: number | null; good_times: string;
  visibility: Visibility; source: string; source_ref: string; created_at: string; updated_at: string;
  photo_count?: number; cover_id?: string | null;
}
function spotJson(r: SpotRow) {
  return {
    id: r.id, placeId: r.place_id, ownerId: r.owner_id, name: r.name, notes: r.notes, lat: r.lat, lng: r.lng,
    tags: JSON.parse(r.tags), facingDeg: r.facing_deg, fovDeg: r.fov_deg, goodTimes: JSON.parse(r.good_times),
    visibility: r.visibility, source: r.source, sourceRef: r.source_ref, createdAt: r.created_at, updatedAt: r.updated_at,
    ...coverFields(r),
  };
}

function isVisibility(v: unknown): v is Visibility {
  return v === 'private' || v === 'unlisted' || v === 'public';
}

// --- places --------------------------------------------------------------------

app.get('/api/places', (req, res) => {
  const { sql, params } = listVisibilityWhere(req.user);
  const rows = db.handle.prepare(`SELECT * FROM places WHERE ${sql} ORDER BY name`).all(...params) as unknown as PlaceRow[];
  res.json(rows.map(placeJson));
});

app.post('/api/places', (req, res) => {
  const b = req.body as Record<string, unknown>;
  if (typeof b.name !== 'string' || !b.name.trim()) return res.status(400).json({ error: 'name is required' });
  if (typeof b.lat !== 'number' || typeof b.lng !== 'number') return res.status(400).json({ error: 'lat and lng must be numbers' });
  const visibility = isVisibility(b.visibility) ? b.visibility : 'private';
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.handle
    .prepare('INSERT INTO places (id, owner_id, name, notes, access, lat, lng, geom, visibility, source, source_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.user!.id, b.name.trim(), String(b.notes ?? ''), String(b.access ?? ''), b.lat, b.lng,
      b.geom ? JSON.stringify(b.geom) : null, visibility, 'manual', '', now, now);
  res.status(201).json(placeJson(db.handle.prepare('SELECT * FROM places WHERE id = ?').get(id) as unknown as PlaceRow));
});

app.get('/api/places/:id', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM places WHERE id = ?').get(req.params.id) as unknown as PlaceRow | undefined;
  if (!row || !canRead(row.visibility, row.owner_id, req.user)) return res.status(404).json({ error: 'Not found' });
  res.json(placeJson(row));
});

app.patch('/api/places/:id', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM places WHERE id = ?').get(req.params.id) as unknown as PlaceRow | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!canEdit(row.owner_id, req.user)) return res.status(403).json({ error: 'Forbidden' });
  const b = req.body as Record<string, unknown>;
  const next = {
    name: typeof b.name === 'string' ? b.name.trim() : row.name,
    notes: typeof b.notes === 'string' ? b.notes : row.notes,
    access: typeof b.access === 'string' ? b.access : row.access,
    lat: typeof b.lat === 'number' ? b.lat : row.lat,
    lng: typeof b.lng === 'number' ? b.lng : row.lng,
    geom: b.geom !== undefined ? (b.geom ? JSON.stringify(b.geom) : null) : row.geom,
    visibility: isVisibility(b.visibility) ? b.visibility : row.visibility,
  };
  db.handle
    .prepare('UPDATE places SET name=?, notes=?, access=?, lat=?, lng=?, geom=?, visibility=?, updated_at=? WHERE id=?')
    .run(next.name, next.notes, next.access, next.lat, next.lng, next.geom, next.visibility, new Date().toISOString(), row.id);
  res.json(placeJson(db.handle.prepare('SELECT * FROM places WHERE id = ?').get(row.id) as unknown as PlaceRow));
});

app.delete('/api/places/:id', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM places WHERE id = ?').get(req.params.id) as unknown as PlaceRow | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!canRemove(row, req.user)) return res.status(403).json({ error: 'Forbidden' });
  // Spots outlive their place: detached, not deleted.
  db.handle.prepare('UPDATE spots SET place_id = NULL WHERE place_id = ?').run(row.id);
  db.handle.prepare('DELETE FROM places WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// --- spots ----------------------------------------------------------------------

app.get('/api/spots', (req, res) => {
  try {
    const { sql, params } = listVisibilityWhere(req.user);
    const clauses = [sql];
    const args: any[] = [...params]; // mixed string/number bind params for the prepared statement below

    if (typeof req.query.placeId === 'string') {
      clauses.push('place_id = ?');
      args.push(req.query.placeId);
    }

    let bbox = null as ReturnType<typeof parseBbox> | null;
    if (typeof req.query.bbox === 'string') bbox = parseBbox(req.query.bbox);
    else if (typeof req.query.near === 'string') {
      const { lat, lng } = parseLatLng(req.query.near);
      const radiusKm = Number(req.query.radiusKm ?? 10);
      bbox = bboxFromRadius(lat, lng, radiusKm);
    }
    if (bbox) {
      clauses.push('lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?');
      args.push(bbox.south, bbox.north, bbox.west, bbox.east);
    }

    let rows = db.handle.prepare(`SELECT spots.*, ${SPOT_COVER_COLS} FROM spots WHERE ${clauses.join(' AND ')} ORDER BY name`).all(...args) as unknown as SpotRow[];

    // near= is a circle; the bbox above is only its bounding box.
    if (typeof req.query.near === 'string') {
      const { lat, lng } = parseLatLng(req.query.near);
      const radiusM = Number(req.query.radiusKm ?? 10) * 1000;
      rows = rows.filter((r) => haversine(lat, lng, r.lat, r.lng) <= radiusM);
    }

    res.json(rows.map(spotJson));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/api/spots', (req, res) => {
  const b = req.body as Record<string, unknown>;
  if (typeof b.name !== 'string' || !b.name.trim()) return res.status(400).json({ error: 'name is required' });
  if (typeof b.lat !== 'number' || typeof b.lng !== 'number') return res.status(400).json({ error: 'lat and lng must be numbers' });
  let goodTimes;
  try {
    goodTimes = parseGoodTimes(b.goodTimes);
  } catch (err) {
    if (err instanceof GoodTimesError) return res.status(400).json({ error: err.message });
    throw err;
  }
  const visibility = isVisibility(b.visibility) ? b.visibility : 'private';
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.handle
    .prepare(
      `INSERT INTO spots (id, place_id, owner_id, name, notes, lat, lng, tags, facing_deg, fov_deg, good_times, visibility, source, source_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', '', ?, ?)`
    )
    .run(id, b.placeId ? String(b.placeId) : null, req.user!.id, b.name.trim(), String(b.notes ?? ''), b.lat, b.lng,
      JSON.stringify(Array.isArray(b.tags) ? b.tags : []), typeof b.facingDeg === 'number' ? b.facingDeg : null,
      typeof b.fovDeg === 'number' ? b.fovDeg : null, JSON.stringify(goodTimes), visibility, now, now);
  res.status(201).json(spotJson(db.handle.prepare(`SELECT spots.*, ${SPOT_COVER_COLS} FROM spots WHERE id = ?`).get(id) as unknown as SpotRow));
});

app.get('/api/spots/:id', (req, res) => {
  const row = db.handle.prepare(`SELECT spots.*, ${SPOT_COVER_COLS} FROM spots WHERE id = ?`).get(req.params.id) as unknown as SpotRow | undefined;
  if (!row || !canRead(row.visibility, row.owner_id, req.user)) return res.status(404).json({ error: 'Not found' });
  res.json(spotJson(row));
});

app.patch('/api/spots/:id', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM spots WHERE id = ?').get(req.params.id) as unknown as SpotRow | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!canEdit(row.owner_id, req.user)) return res.status(403).json({ error: 'Forbidden' });
  const b = req.body as Record<string, unknown>;
  let goodTimes = JSON.parse(row.good_times);
  if (b.goodTimes !== undefined) {
    try {
      goodTimes = parseGoodTimes(b.goodTimes);
    } catch (err) {
      if (err instanceof GoodTimesError) return res.status(400).json({ error: err.message });
      throw err;
    }
  }
  const next = {
    place_id: b.placeId !== undefined ? (b.placeId ? String(b.placeId) : null) : row.place_id,
    name: typeof b.name === 'string' ? b.name.trim() : row.name,
    notes: typeof b.notes === 'string' ? b.notes : row.notes,
    lat: typeof b.lat === 'number' ? b.lat : row.lat,
    lng: typeof b.lng === 'number' ? b.lng : row.lng,
    tags: b.tags !== undefined ? JSON.stringify(Array.isArray(b.tags) ? b.tags : []) : row.tags,
    facing_deg: b.facingDeg !== undefined ? (typeof b.facingDeg === 'number' ? b.facingDeg : null) : row.facing_deg,
    fov_deg: b.fovDeg !== undefined ? (typeof b.fovDeg === 'number' ? b.fovDeg : null) : row.fov_deg,
    visibility: isVisibility(b.visibility) ? b.visibility : row.visibility,
  };
  db.handle
    .prepare('UPDATE spots SET place_id=?, name=?, notes=?, lat=?, lng=?, tags=?, facing_deg=?, fov_deg=?, good_times=?, visibility=?, updated_at=? WHERE id=?')
    .run(next.place_id, next.name, next.notes, next.lat, next.lng, next.tags, next.facing_deg, next.fov_deg,
      JSON.stringify(goodTimes), next.visibility, new Date().toISOString(), row.id);
  res.json(spotJson(db.handle.prepare(`SELECT spots.*, ${SPOT_COVER_COLS} FROM spots WHERE id = ?`).get(row.id) as unknown as SpotRow));
});

app.delete('/api/spots/:id', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM spots WHERE id = ?').get(req.params.id) as unknown as SpotRow | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!canRemove(row, req.user)) return res.status(403).json({ error: 'Forbidden' });
  const photos = db.handle.prepare('SELECT file, thumb FROM photos WHERE spot_id = ?').all(row.id) as { file: string; thumb: string }[];
  deleteImages(photos.flatMap((p) => [p.file, p.thumb]));
  db.handle.prepare('DELETE FROM photos WHERE spot_id = ?').run(row.id);
  db.handle.prepare('DELETE FROM spots WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// --- photos -----------------------------------------------------------------

interface PhotoRow {
  id: string; spot_id: string; owner_id: string; kind: string; file: string; thumb: string;
  w: number; h: number; taken_at: string | null; caption: string; created_at: string;
  focal_length?: number | null; date_time_original?: string | null;
}
function photoJson(r: PhotoRow) {
  return {
    id: r.id, spotId: r.spot_id, kind: r.kind, url: `/api/photos/${r.id}/file`, thumbUrl: `/api/photos/${r.id}/thumb`,
    w: r.w, h: r.h, takenAt: r.taken_at, caption: r.caption, createdAt: r.created_at,
    focalLength: r.focal_length ?? null,
    dateTimeOriginal: r.date_time_original ?? r.taken_at ?? null,
  };
}

/** Photos one account may add in a day. Disk is the thing a public upload form runs out of. */
const MAX_PHOTOS_PER_DAY = 200;

/** Spot photos and ride photos both count: the cap is on the disk, not on where a picture goes. */
function photosToday(userId: string): number {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const r = db.handle.prepare(
    'SELECT (SELECT COUNT(*) FROM photos WHERE owner_id = ? AND created_at > ?) + (SELECT COUNT(*) FROM ride_photos WHERE owner_id = ? AND created_at > ?) AS n'
  ).get(userId, since, userId, since) as { n: number };
  return r.n;
}

app.post('/api/spots/:id/photos', uploadLimit, async (req, res, next) => {
  try {
    const spot = db.handle.prepare('SELECT * FROM spots WHERE id = ?').get(req.params.id) as unknown as SpotRow | undefined;
    if (!spot) return res.status(404).json({ error: 'Not found' });
    if (!canEdit(spot.owner_id, req.user)) return res.status(403).json({ error: 'Forbidden' });
    if (photosToday(req.user!.id) >= MAX_PHOTOS_PER_DAY) return res.status(429).json({ error: 'Daily photo limit reached. Try again tomorrow.' });

    const { fields, files } = await parseMultipart(req, MAX_PHOTO_BYTES * 2 + 4096);
    if (!files.photo || !detectImageType(files.photo)) return res.status(400).json({ error: 'photo must be a JPEG, PNG or WebP file' });
    const thumbBuf = files.thumb && detectImageType(files.thumb) ? files.thumb : files.photo;

    const parsedFocal = fields.focalLength ? Number(fields.focalLength) : null;
    const focalLength = parsedFocal !== null && Number.isFinite(parsedFocal) && parsedFocal > 0 ? parsedFocal : null;
    const { w, h, takenAt } = photoMeta(fields);
    const dateTimeOriginal = takenAt;

    const file = saveImage(files.photo);
    const thumb = saveImage(thumbBuf);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const kind = fields.kind === 'of_location' ? 'of_location' : 'taken_here';
    db.handle
      .prepare('INSERT INTO photos (id, spot_id, owner_id, kind, file, thumb, w, h, taken_at, caption, created_at, focal_length, date_time_original) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, spot.id, req.user!.id, kind, file, thumb, w, h,
        takenAt, String(fields.caption ?? '').slice(0, 2000), now, focalLength, dateTimeOriginal);
    res.status(201).json(photoJson(db.handle.prepare('SELECT * FROM photos WHERE id = ?').get(id) as unknown as PhotoRow));
  } catch (err) { next(err); }
});

function servePhoto(variant: 'file' | 'thumb') {
  return (req: express.Request, res: express.Response) => {
    const row = db.handle.prepare('SELECT p.*, s.visibility as spot_visibility, s.owner_id as spot_owner_id FROM photos p JOIN spots s ON s.id = p.spot_id WHERE p.id = ?')
      .get(req.params.id) as (PhotoRow & { spot_visibility: Visibility; spot_owner_id: string }) | undefined;
    if (!row || !canRead(row.spot_visibility, row.spot_owner_id, req.user)) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(photosDir, variant === 'file' ? row.file : row.thumb));
  };
}
app.get('/api/photos/:id/file', servePhoto('file'));
app.get('/api/photos/:id/thumb', servePhoto('thumb'));

app.get('/api/spots/:id/photos', (req, res) => {
  const spot = db.handle.prepare('SELECT * FROM spots WHERE id = ?').get(req.params.id) as unknown as SpotRow | undefined;
  if (!spot || !canRead(spot.visibility, spot.owner_id, req.user)) return res.status(404).json({ error: 'Not found' });
  const rows = db.handle.prepare('SELECT * FROM photos WHERE spot_id = ? ORDER BY created_at').all(spot.id) as unknown as PhotoRow[];
  res.json(rows.map(photoJson));
});

app.patch('/api/photos/:id', (req, res) => {
  const row = db.handle.prepare('SELECT p.*, s.owner_id as spot_owner_id FROM photos p JOIN spots s ON s.id = p.spot_id WHERE p.id = ?')
    .get(req.params.id) as (PhotoRow & { spot_owner_id: string }) | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!canEdit(row.spot_owner_id, req.user)) return res.status(403).json({ error: 'Forbidden' });
  const b = req.body as Record<string, unknown>;
  const caption = typeof b.caption === 'string' ? b.caption.slice(0, 500) : row.caption;
  const kind = b.kind === 'of_location' || b.kind === 'taken_here' ? b.kind : row.kind;
  db.handle.prepare('UPDATE photos SET caption = ?, kind = ? WHERE id = ?').run(caption, kind, row.id);
  res.json(photoJson(db.handle.prepare('SELECT * FROM photos WHERE id = ?').get(row.id) as unknown as PhotoRow));
});

app.delete('/api/photos/:id', (req, res) => {
  const row = db.handle.prepare('SELECT p.*, s.owner_id as spot_owner_id FROM photos p JOIN spots s ON s.id = p.spot_id WHERE p.id = ?')
    .get(req.params.id) as (PhotoRow & { spot_owner_id: string }) | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!canEdit(row.spot_owner_id, req.user)) return res.status(403).json({ error: 'Forbidden' });
  deleteImages([row.file, row.thumb]);
  db.handle.prepare('DELETE FROM photos WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// --- import / export ----------------------------------------------------------

app.post('/api/import', (req, res) => {
  const bundle = req.body as ShareBundle;
  if (!bundle || bundle.type !== 'FeatureCollection' || !Array.isArray(bundle.features)) {
    return res.status(400).json({ error: 'A GeoJSON FeatureCollection is required' });
  }
  try {
    res.json(importFeatureCollection(db, bundle, req.user!.id));
  } catch (err) {
    if (err instanceof ImportError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

app.get('/api/export.geojson', (req, res) => {
  const bundle = buildFeatureCollection(db, req.user!.id, (id, variant) => `/api/photos/${id}/${variant}`);
  res.json(bundle);
});

app.get('/api/export.gpx', (req, res) => {
  const rows = db.handle.prepare('SELECT name, notes, lat, lng FROM spots WHERE owner_id = ?').all(req.user!.id) as
    { name: string; notes: string; lat: number; lng: number }[];
  res.type('application/gpx+xml').send(buildGpx(rows.map((r) => ({ lat: r.lat, lng: r.lng, name: r.name, desc: r.notes }))));
});

// --- shares -------------------------------------------------------------------

interface ShareRow { token: string; owner_id: string; filter: string; created_at: string; revoked_at: string | null }

app.get('/api/shares', (req, res) => {
  const rows = req.user!.role === 'admin'
    ? db.handle.prepare('SELECT * FROM shares').all()
    : db.handle.prepare('SELECT * FROM shares WHERE owner_id = ?').all(req.user!.id);
  res.json(rows);
});

/** Live share links one account may hold. A link hands over everything its owner has, private rows included. */
const MAX_SHARES = 20;

app.post('/api/shares', (req, res) => {
  const live = db.handle.prepare('SELECT COUNT(*) AS n FROM shares WHERE owner_id = ? AND revoked_at IS NULL').get(req.user!.id) as { n: number };
  if (live.n >= MAX_SHARES) return res.status(400).json({ error: `You can have ${MAX_SHARES} share links at once: revoke one first` });
  const token = crypto.randomBytes(18).toString('base64url');
  db.handle
    .prepare('INSERT INTO shares (token, owner_id, filter, created_at) VALUES (?, ?, ?, ?)')
    .run(token, req.user!.id, '{}', new Date().toISOString());
  res.status(201).json({ token });
});

app.delete('/api/shares/:token', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM shares WHERE token = ?').get(req.params.token) as unknown as ShareRow | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.owner_id !== req.user!.id && req.user!.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  db.handle.prepare('UPDATE shares SET revoked_at = ? WHERE token = ?').run(new Date().toISOString(), req.params.token);
  res.json({ ok: true });
});

function activeShare(token: string): ShareRow | null {
  const row = db.handle.prepare('SELECT * FROM shares WHERE token = ?').get(token) as unknown as ShareRow | undefined;
  return row && !row.revoked_at ? row : null;
}

/** The bundle a share token grants — no session needed, the token is the credential. */
app.get('/api/share/:token', (req, res) => {
  const share = activeShare(req.params.token);
  if (!share) return res.status(404).json({ error: 'Unknown or revoked share' });
  res.json(buildFeatureCollection(db, share.owner_id, (id, variant) => `/api/share/${req.params.token}/photos/${id}/${variant}`));
});

app.get('/api/share/:token/photos/:id/:variant', (req, res) => {
  const share = activeShare(req.params.token);
  if (!share) return res.status(404).json({ error: 'Unknown or revoked share' });
  const variant = req.params.variant === 'thumb' ? 'thumb' : 'file';
  const row = db.handle.prepare('SELECT p.* FROM photos p JOIN spots s ON s.id = p.spot_id WHERE p.id = ? AND s.owner_id = ?')
    .get(req.params.id, share.owner_id) as unknown as PhotoRow | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(photosDir, variant === 'file' ? row.file : row.thumb));
});

// --- remotes --------------------------------------------------------------------

interface RemoteRow { id: string; owner_id: string; url: string; last_sync: string | null; last_error: string | null; created_at: string }

// Admins only, all of it: a remote is a URL this server goes and fetches on a
// timer, and on a public instance that is not something to hand every account.
app.use('/api/remotes', (req, res, next) => { if (requireAdmin(req, res)) next(); });

app.get('/api/remotes', (_req, res) => {
  res.json(db.handle.prepare('SELECT * FROM remotes').all());
});

app.post('/api/remotes', async (req, res) => {
  const { url } = (req.body ?? {}) as { url?: unknown };
  if (typeof url !== 'string' || !url || url.length > 2000) return res.status(400).json({ error: 'url is required' });
  try {
    await assertPublicUrl(url, getSettings(db).allowPrivateRemotes);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
  const id = crypto.randomUUID();
  db.handle.prepare('INSERT INTO remotes (id, owner_id, url, created_at) VALUES (?, ?, ?, ?)').run(id, req.user!.id, url, new Date().toISOString());
  res.status(201).json(db.handle.prepare('SELECT * FROM remotes WHERE id = ?').get(id));
});

app.delete('/api/remotes/:id', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM remotes WHERE id = ?').get(req.params.id) as unknown as RemoteRow | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.owner_id !== req.user!.id && req.user!.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  db.handle.prepare('DELETE FROM remotes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/remotes/:id/sync', async (req, res, next) => {
  try {
    const row = db.handle.prepare('SELECT * FROM remotes WHERE id = ?').get(req.params.id) as unknown as RemoteRow | undefined;
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.owner_id !== req.user!.id && req.user!.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const result = await syncRemote(db, row, getSettings(db).allowPrivateRemotes);
    db.handle.prepare('UPDATE remotes SET last_sync = ?, last_error = NULL WHERE id = ?').run(new Date().toISOString(), row.id);
    res.json(result);
  } catch (err) {
    db.handle.prepare('UPDATE remotes SET last_error = ? WHERE id = ?').run((err as Error).message, req.params.id);
    next(err);
  }
});

// --- tasks (read-only status; the scheduler drives the actual runs) -------------

app.get('/api/tasks', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const since = Number(req.query.since ?? 0);
  res.json({ tasks: tasks.statuses(), ...tasks.since(since) });
});
app.post('/api/tasks/:name/run', (req, res, next) => {
  if (!requireAdmin(req, res)) return;
  tasks.run(req.params.name, { force: true }).then((result) => res.json(result)).catch(next);
});

// --- planes -------------------------------------------------------------------

app.get('/api/planes', async (req, res, next) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const nm = Number(req.query.nm ?? 40);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'lat and lng are required' });
    const baseUrl = process.env.ADSB_URL ?? 'https://api.adsb.lol';
    res.json(await fetchPlanes(baseUrl, lat, lng, nm));
  } catch (err) { next(err); }
});

app.get('/api/planes/:hex/info', async (req, res, next) => {
  try {
    const { hex } = req.params;
    if (!isValidHex(hex)) return res.status(400).json({ error: 'Invalid hex: must be 6 hex characters' });
    let callsign: string | undefined = undefined;
    if (req.query.callsign !== undefined && req.query.callsign !== '') {
      const cs = String(req.query.callsign).trim();
      if (!isValidCallsign(cs)) return res.status(400).json({ error: 'Invalid callsign: must be alphanumeric and up to 8 characters' });
      callsign = cs;
    }
    res.json(await fetchPlaneInfo(hex, callsign));
  } catch (err) { next(err); }
});

// --- weather ------------------------------------------------------------------

app.get('/api/weather', async (req, res, next) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const days = Number(req.query.days ?? 7);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.status(400).json({ error: 'lat and lng are required' });
    const baseUrl = process.env.OPEN_METEO_URL ?? 'https://api.open-meteo.com';
    res.json(await fetchWeather(baseUrl, lat, lng, Number.isFinite(days) ? days : 7));
  } catch (err) { next(err); }
});

app.get('/api/weather/wind-grid', async (req, res, next) => {
  try {
    const south = Number(req.query.south);
    const west = Number(req.query.west);
    const north = Number(req.query.north);
    const east = Number(req.query.east);
    const cols = Number(req.query.cols ?? 4);
    const rows = Number(req.query.rows ?? 4);
    const time = req.query.time == null ? undefined : Date.parse(String(req.query.time));
    if (!Number.isFinite(south) || !Number.isFinite(west) || !Number.isFinite(north) || !Number.isFinite(east)
      || south < -90 || north > 90 || west < -180 || east > 180 || south >= north || west >= east
      || (time != null && !Number.isFinite(time))) {
      return res.status(400).json({ error: 'valid south, west, north, east bounds and optional time are required' });
    }
    const baseUrl = process.env.OPEN_METEO_URL ?? 'https://api.open-meteo.com';
    res.json(await fetchWindGrid(baseUrl, { south, west, north, east }, cols, rows, time));
  } catch (err) { next(err); }
});

// --- marine (tides & swell) ---------------------------------------------------

app.get('/api/marine', async (req, res, next) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return res.status(400).json({ error: 'lat and lng are required' });
    }
    const baseUrl = process.env.OPEN_METEO_MARINE_URL ?? 'https://marine-api.open-meteo.com';
    res.json(await fetchMarine(baseUrl, lat, lng));
  } catch (err) { next(err); }
});

// --- fires (NSW RFS) ----------------------------------------------------

app.get('/api/fires', async (_req, res, next) => {
  try {
    res.json(await fetchFires());
  } catch (err) { next(err); }
});

// --- events (from event-scout) --------------------------------------------

/** The shared list, with the caller's own star and hide laid over it when signed in, and the going and interested counts on every event. */
async function eventsFor(req: express.Request) {
  const events = eventList();
  const marked = withState(events, req.user ? userEventStates(db, req.user.id) : null);
  return withRsvps(marked, eventRsvpTotals(db, req.user?.id ?? null));
}

app.get('/api/events', async (req, res, next) => {
  try {
    res.json(await eventsFor(req));
  } catch (err) { next(err); }
});

app.get('/api/events/:group', async (req, res, next) => {
  try {
    const event = (await eventsFor(req)).find((ev) => ev.group === req.params.group);
    if (!event) return res.status(404).json({ error: 'No such event' });
    res.json(event);
  } catch (err) { next(err); }
});

/** Star or hide an event for yourself. Event-scout's own flags are not touched. */
app.put('/api/events/:group/state', async (req, res, next) => {
  try {
    const group = req.params.group;
    const { starred, hidden } = (req.body ?? {}) as { starred?: unknown; hidden?: unknown };
    if (group.length > MAX_GROUP_LENGTH) return res.status(400).json({ error: 'Not an event' });
    if (starred === undefined && hidden === undefined) return res.status(400).json({ error: 'Send starred or hidden' });
    if ((starred !== undefined && typeof starred !== 'boolean') || (hidden !== undefined && typeof hidden !== 'boolean')) {
      return res.status(400).json({ error: 'starred and hidden must be true or false' });
    }
    // Only for an event on the list, so this table cannot be filled with made-up keys.
    if (!(eventList()).some((ev) => ev.group === group)) {
      return res.status(404).json({ error: 'No such event' });
    }
    res.json({ group, ...setUserEventState(db, req.user!.id, group, { starred, hidden }) });
  } catch (err) { next(err); }
});

/** Going or interested, for an event on the list. Clearing is allowed for one that has since left it, so a stale answer can still go. */
app.get('/api/events/:group/rsvp', async (req, res, next) => {
  try {
    const group = req.params.group;
    if (!eventList().some((ev) => ev.group === group)) return res.status(404).json({ error: 'No such event' });
    res.json({ rsvp: eventRsvpSummary(db, group, req.user?.id ?? null) });
  } catch (err) { next(err); }
});

app.put('/api/events/:group/rsvp', async (req, res, next) => {
  try {
    if (!requireUser(req, res)) return;
    const status = ((req.body ?? {}) as { status?: unknown }).status;
    if (!isRsvpStatus(status)) return res.status(400).json({ error: 'status must be going or interested' });
    const group = req.params.group;
    if (!eventList().some((ev) => ev.group === group)) return res.status(404).json({ error: 'No such event' });
    setEventRsvp(db, req.user!.id, group, status);
    res.json({ rsvp: eventRsvpSummary(db, group, req.user!.id) });
  } catch (err) { next(err); }
});

app.delete('/api/events/:group/rsvp', (req, res) => {
  if (!requireUser(req, res)) return;
  clearEventRsvp(db, req.user!.id, req.params.group);
  res.json({ rsvp: eventRsvpSummary(db, req.params.group, req.user!.id) });
});

/** What a browser is told about a stored flyer: the type from our own list, never sniffed, and nothing it could run. */
const FLYER_TYPES: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif' };

/**
 * A flyer this server keeps, for anyone, so long as its event is on show.
 * Both halves of the path are checked against the shapes the store writes before
 * the disk is touched, so nothing can climb out of the folder.
 */
app.get('/api/flyer/:day/:name', (req, res) => {
  const { day, name } = req.params;
  const type = FLYER_TYPES[name.split('.').pop() ?? ''];
  if (!isSafeFlyerPath(day, name) || !type || !flyerIsShown(day, name)) return res.status(404).json({ error: 'No such flyer' });
  const relative = flyerRelative(day, name);
  if (!flyerStore.has(relative)) return res.status(404).json({ error: 'No such flyer' });
  // Named by a hash of the address it came from, so it never changes once written.
  res.set({
    'Content-Type': type,
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  res.sendFile(flyerStore.absolute(relative), { dotfiles: 'deny' });
});

// --- aurora (NOAA space weather) ----------------------------------------

app.get('/api/aurora', async (_req, res, next) => {
  try {
    res.json(await fetchAurora());
  } catch (err) { next(err); }
});

// Building footprints around a point, for Plan shoot's building shadows (the page has no map to read vector tiles from).
app.get('/api/buildings', async (req, res, next) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const r = Number(req.query.r ?? 250);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'lat and lng are required' });
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.status(400).json({ error: 'lat and lng are out of range' });
    // Fifty-metre steps between 50 and 500: every distinct radius is its own
    // cache row and its own Overpass query.
    const radius = Math.min(500, Math.max(50, Math.round((Number.isFinite(r) ? r : 250) / 50) * 50));
    // Footprints barely change: cache per ~10 m cell for a week so Overpass outages don't blank building shade.
    const key = `buildings:${lat.toFixed(4)},${lng.toFixed(4)}:${Math.round(radius)}`;
    const cached = db.getKv(key);
    if (cached) return res.type('application/json').send(cached);
    try {
      const fc = await fetchBuildings(lat, lng, radius);
      db.setKv(key, JSON.stringify(fc), new Date(Date.now() + 7 * 86_400_000).toISOString());
      res.json(fc);
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  } catch (err) { next(err); }
});

// --- rail network --------------------------------------------

app.get('/api/rail', (_req, res) => res.json(getCachedRail(db)));

// --- trains -----------------------------------------------------------------

app.get('/api/trains/status', (_req, res) => {
  const configured = Boolean(tfnswKey(db));
  const lastImport = TRAIN_FEEDS.map((f) => db.getKv(`trains:lastImport:${f}`)).filter((v): v is string => Boolean(v)).sort().at(-1) ?? null;
  res.json({ configured, lastImport, tripCount: tripCount(db) });
});

app.get('/api/trains', async (req, res, next) => {
  try {
    const key = tfnswKey(db);
    if (!key) return res.json({ configured: false, positions: [] });
    const at = req.query.at ? new Date(String(req.query.at)) : new Date();
    // Realtime describes *now*; only mix it in when asked about (roughly) now.
    const nearNow = Math.abs(at.getTime() - Date.now()) < 5 * 60_000;
    const [feed, realtime] = [combinedFeedData(db), nearNow ? await combinedRealtime(key) : []];
    const unsnapped = predictTrainPositions(feed, at, realtime);
    const track = trackGraphFor(db, unsnapped);
    const positions = predictTrainPositions(feed, at, realtime, track);
    requestTilesForUnsnapped(db, positions);
    res.json({ configured: true, positions });
  } catch (err) { next(err); }
});

app.get('/api/trains/passes', (req, res) => {
  const parsed = parsePointPassRequest(req.query);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const key = tfnswKey(db);
  res.json(buildPointPassesResponse(Boolean(key), key ? combinedFeedData(db) : emptyFeedData(), parsed.point, parsed.hours, new Date()));
});

app.get('/api/spots/:id/trains', (req, res) => {
  const spot = db.handle.prepare('SELECT * FROM spots WHERE id = ?').get(req.params.id) as unknown as SpotRow | undefined;
  if (!spot || !canRead(spot.visibility, spot.owner_id, req.user)) return res.status(404).json({ error: 'Not found' });
  if (!tfnswKey(db)) return res.json({ configured: false, passes: [] });
  const hours = Number(req.query.hours ?? 6);
  const passes = nextPasses(combinedFeedData(db), spot, hours, new Date());
  res.json({ configured: true, passes });
});

// --- NSW roadworks (TfNSW Live Traffic, public cached feed) -------------------

app.get('/api/roadworks', async (_req, res, next) => {
  try {
    res.json(await fetchRoadworks());
  } catch (err) { next(err); }
});

// --- traffic cameras (TfNSW) --------------------------------------------------

app.get('/api/cameras', async (_req, res, next) => {
  try {
    const key = tfnswKey(db);
    if (!key) return res.json({ configured: false, cameras: [] });
    const cameras = await fetchCameras(key);
    res.json({ configured: true, cameras });
  } catch (err) {
    const status = (err as any).status ?? 502;
    res.status(status).json({ error: (err as Error).message });
  }
});

app.get('/api/cameras/:id/image', async (req, res, next) => {
  try {
    const key = tfnswKey(db);
    if (!key) return res.status(404).json({ error: 'Not configured' });
    const cameras = await fetchCameras(key);
    const camera = cameras.find((c) => c.id === req.params.id);
    if (!camera || !camera.imageUrl) return res.status(404).json({ error: 'Camera not found' });
    const url = new URL(camera.imageUrl);
    if (url.protocol !== 'https:') return res.status(502).json({ error: 'Camera image is not https' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      // The key only goes to TfNSW's own API host, never to wherever the feed points images.
      const headers: Record<string, string> = { 'User-Agent': 'photoscout/0.1' };
      if (url.hostname === 'api.transport.nsw.gov.au') headers.Authorization = `apikey ${key}`;
      const imgRes = await fetch(url, { headers, signal: controller.signal });
      if (!imgRes.ok) return res.status(502).json({ error: `Image fetch failed (${imgRes.status})` });
      const contentType = imgRes.headers.get('content-type') ?? '';
      if (!contentType.startsWith('image/')) return res.status(502).json({ error: 'Camera image is not an image' });
      res.setHeader('Content-Type', contentType);
      const buf = Buffer.from(await imgRes.arrayBuffer());
      res.send(buf);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) { next(err); }
});

// The Radio Garden layer is the media.24thframe.radio-garden plugin (plugins/radio-garden), served under /api/plugins/.

// --- Event Scout: nearby events and busyness --------------------------------------

function nearbyOriginForSpot(row: SpotRow): { lat: number; lng: number } {
  if (row.place_id) {
    const place = db.handle.prepare('SELECT lat, lng FROM places WHERE id = ?').get(row.place_id) as { lat: number; lng: number } | undefined;
    if (place) return place;
  }
  return { lat: row.lat, lng: row.lng };
}

app.get('/api/spots/:id/nearby', async (req, res, next) => {
  try {
    const spot = db.handle.prepare('SELECT * FROM spots WHERE id = ?').get(req.params.id) as unknown as SpotRow | undefined;
    if (!spot || !canRead(spot.visibility, spot.owner_id, req.user)) return res.status(404).json({ error: 'Not found' });
    const origin = nearbyOriginForSpot(spot);
    const goodTimes = JSON.parse(spot.good_times) as { eventKeywords?: string[] };
    res.json(await nearbyFor(db, origin.lat, origin.lng, goodTimes.eventKeywords ?? []));
  } catch (err) { next(err); }
});

app.get('/api/places/:id/nearby', async (req, res, next) => {
  try {
    const place = db.handle.prepare('SELECT * FROM places WHERE id = ?').get(req.params.id) as unknown as PlaceRow | undefined;
    if (!place || !canRead(place.visibility, place.owner_id, req.user)) return res.status(404).json({ error: 'Not found' });
    res.json(await nearbyFor(db, place.lat, place.lng, []));
  } catch (err) { next(err); }
});

// --- candidates (OSM) + Commons inspiration ---------------------------------------

app.get('/api/candidates', (req, res) => {
  try {
    let rows: any[];
    if (typeof req.query.bbox === 'string') {
      const b = parseBbox(req.query.bbox);
      rows = db.handle.prepare('SELECT * FROM candidates WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?').all(b.south, b.north, b.west, b.east);
    } else {
      rows = db.handle.prepare('SELECT * FROM candidates').all();
    }
    res.json(rows.map((r) => ({ id: r.id, source: r.source, ref: r.ref, name: r.name, lat: r.lat, lng: r.lng, tags: JSON.parse(r.tags), fetchedAt: r.fetched_at })));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Road quality (OSM): one 0.05 degree grid cell per request (?cell=south,west), cached 14 days.
// Concurrent requests for the same cell share one Overpass fetch.
const roadsInflight = new Map<string, Promise<string>>();
app.get('/api/roads', async (req, res) => {
  const c = parseCell(String(req.query.cell ?? ''));
  if (!c) return res.status(400).json({ error: 'cell must be south,west on the 0.05 degree grid' });
  const key = `roads:${c.south},${c.west}`;
  try {
    let json = db.getKv(key);
    if (!json) {
      let p = roadsInflight.get(key);
      if (!p) {
        p = fetchRoadCell(c).then((cell) => {
          const out = JSON.stringify(cell);
          db.setKv(key, out, new Date(Date.now() + 14 * 86_400_000).toISOString());
          return out;
        }).finally(() => roadsInflight.delete(key));
        roadsInflight.set(key, p);
      }
      json = await p;
    }
    res.type('json').send(`{"type":"FeatureCollection","features":${json}}`);
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
});

app.post('/api/candidates/:id/promote', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id) as any;
  if (!row) return res.status(404).json({ error: 'Not found' });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.handle
    .prepare(
      `INSERT INTO spots (id, place_id, owner_id, name, notes, lat, lng, tags, facing_deg, fov_deg, good_times, visibility, source, source_ref, created_at, updated_at)
       VALUES (?, NULL, ?, ?, '', ?, ?, '[]', NULL, NULL, ?, 'private', 'osm', ?, ?, ?)`
    )
    .run(id, req.user!.id, row.name || 'Candidate', row.lat, row.lng, JSON.stringify(DEFAULT_GOOD_TIMES), row.ref, now, now);
  res.status(201).json(spotJson(db.handle.prepare(`SELECT spots.*, ${SPOT_COVER_COLS} FROM spots WHERE id = ?`).get(id) as unknown as SpotRow));
});

/**
 * The events engine's own API (settings, sources, tasks, the crawler, editing
 * and merging events), for admins only. It was a service with its own address;
 * its routes are under /api there, so the path is put back before handing over.
 */
app.use('/api/events-admin', (req, res, next) => {
  if (!requireAdmin(req, res)) return;
  req.url = `/api${req.url}`;
  // An edit, a merge or an archive changes what visitors are shown; do not make them wait out the kept list.
  if (req.method !== 'GET') res.on('finish', forgetEventList);
  eventsApi(req, res, next);
});

app.get('/api/spots/:id/commons', async (req, res, next) => {
  try {
    const spot = db.handle.prepare('SELECT * FROM spots WHERE id = ?').get(req.params.id) as unknown as SpotRow | undefined;
    if (!spot || !canRead(spot.visibility, spot.owner_id, req.user)) return res.status(404).json({ error: 'Not found' });
    const images = await commonsNearbyCached(db, spot.lat, spot.lng);
    const ownRows = db.handle
      .prepare('SELECT focal_length, taken_at, date_time_original FROM photos WHERE spot_id = ?')
      .all(spot.id) as { focal_length: number | null; taken_at: string | null; date_time_original: string | null }[];
    const allPhotos = [
      // Commons clocks are often left on the uploader's home zone, so only own photos inform the time of day.
      ...images.map((c) => ({ focal35: c.focal35, focalRaw: c.focalRaw, takenAt: null })),
      ...ownRows.map((p) => ({
        focal35: null,
        focalRaw: p.focal_length,
        takenAt: p.date_time_original ?? p.taken_at,
      })),
    ];
    const stats = lensStats(allPhotos);
    res.json({ images, stats });
  } catch (err) { next(err); }
});

// --- routes -----------------------------------------------------------------

app.get('/api/routes', (req, res) => {
  const { sql, params } = listVisibilityWhere(req.user);
  const rows = db.handle.prepare(`SELECT * FROM routes WHERE ${sql} ORDER BY name`).all(...params) as unknown as RouteRow[];
  res.json(rows.map(routeJson));
});

app.post('/api/routes', (req, res) => {
  const b = req.body as Record<string, unknown>;
  if (typeof b.name !== 'string' || !b.name.trim()) return res.status(400).json({ error: 'name is required' });
  let vertices;
  let waypoints;
  let snap;
  let staging;
  try {
    vertices = parseRouteVertices(b.vertices);
    waypoints = serializeRouteWaypoints(b.waypoints);
    snap = b.snap === undefined ? false : parseRouteSnap(b.snap);
    staging = parseRouteStaging(b.staging);
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
  const type = isRouteType(b.type) ? b.type : 'sprint';
  const visibility = isVisibility(b.visibility) ? b.visibility : 'private';
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.handle
    .prepare('INSERT INTO routes (id, owner_id, name, notes, access, type, vertices, waypoints, snap, staging, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.user!.id, b.name.trim(), String(b.notes ?? ''), String(b.access ?? ''), type,
      JSON.stringify(vertices), waypoints, snap ? 1 : 0, staging ? JSON.stringify(staging) : null, visibility, now, now);
  res.status(201).json(routeJson(db.handle.prepare('SELECT * FROM routes WHERE id = ?').get(id) as unknown as RouteRow));
});

app.get('/api/routes/:id', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM routes WHERE id = ?').get(req.params.id) as unknown as RouteRow | undefined;
  if (!row || !canRead(row.visibility, row.owner_id, req.user)) return res.status(404).json({ error: 'Not found' });
  res.json(routeJson(row));
});

app.patch('/api/routes/:id', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM routes WHERE id = ?').get(req.params.id) as unknown as RouteRow | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!canEdit(row.owner_id, req.user)) return res.status(403).json({ error: 'Forbidden' });
  const b = req.body as Record<string, unknown>;
  let vertices = row.vertices;
  let waypoints = row.waypoints;
  let snap = !!row.snap;
  let staging = row.staging;
  try {
    if (b.vertices !== undefined) vertices = JSON.stringify(parseRouteVertices(b.vertices));
    if (b.waypoints !== undefined) waypoints = serializeRouteWaypoints(b.waypoints);
    if (b.snap !== undefined) snap = parseRouteSnap(b.snap);
    if (b.staging !== undefined) {
      const parsed = parseRouteStaging(b.staging);
      staging = parsed ? JSON.stringify(parsed) : null;
    }
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
  const next = {
    name: typeof b.name === 'string' ? b.name.trim() : row.name,
    notes: typeof b.notes === 'string' ? b.notes : row.notes,
    access: typeof b.access === 'string' ? b.access : row.access,
    type: isRouteType(b.type) ? b.type : row.type,
    vertices,
    waypoints,
    snap,
    staging,
    visibility: isVisibility(b.visibility) ? b.visibility : row.visibility,
  };
  db.handle
    .prepare('UPDATE routes SET name=?, notes=?, access=?, type=?, vertices=?, waypoints=?, snap=?, staging=?, visibility=?, updated_at=? WHERE id=?')
    .run(next.name, next.notes, next.access, next.type, next.vertices, next.waypoints, next.snap ? 1 : 0, next.staging, next.visibility, new Date().toISOString(), row.id);
  res.json(routeJson(db.handle.prepare('SELECT * FROM routes WHERE id = ?').get(row.id) as unknown as RouteRow));
});

app.delete('/api/routes/:id', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM routes WHERE id = ?').get(req.params.id) as unknown as RouteRow | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!canEdit(row.owner_id, req.user)) return res.status(403).json({ error: 'Forbidden' });
  db.handle.prepare('DELETE FROM routes WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// --- profiles ---------------------------------------------------------------------

/** The account behind a handle in a URL, or undefined; a suspended account is treated as not there. */
function liveUser(username: string) {
  const user = HANDLE.test(username) ? findUserByUsername(db, username) : undefined;
  return user && !user.banned ? user : undefined;
}

/** Search handles by prefix, for finding somebody to follow. */
app.get('/api/profiles', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!/^[A-Za-z0-9_]{1,24}$/.test(q)) return res.json([]);
  // `_` is a wildcard in LIKE and is allowed in a handle, so it is escaped.
  const rows = db.handle
    .prepare("SELECT username, avatar FROM users WHERE banned = 0 AND username LIKE ? ESCAPE '\\' ORDER BY username LIMIT 20")
    .all(`${q.replace(/_/g, '\\_')}%`);
  res.json(rows);
});

app.get('/api/profiles/:username', (req, res) => {
  const user = liveUser(req.params.username);
  if (!user) return res.status(404).json({ error: 'No such profile' });
  const count = (sql: string) => Number((db.handle.prepare(sql).get(user.id) as { n: number | bigint }).n);
  const isFollowing = req.user
    ? Boolean(db.handle.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(req.user.id, user.id))
    : false;
  res.json({
    id: user.id, username: user.username, avatar: user.avatar, bio: user.bio, instagram: user.instagram, createdAt: user.created_at,
    followers: count('SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?'),
    following: count('SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?'),
    isFollowing,
    rides: ridesJson(db.handle.prepare('SELECT * FROM rides WHERE owner_id = ? ORDER BY created_at, id').all(user.id) as unknown as RideRow[]),
    gear: (db.handle.prepare('SELECT * FROM gear WHERE owner_id = ? ORDER BY created_at, id').all(user.id) as unknown as GearRow[]).map(gearJson),
  });
});

// --- follows ----------------------------------------------------------------------

app.get('/api/follows', (req, res) => {
  res.json(db.handle
    .prepare('SELECT u.username, u.avatar FROM follows f JOIN users u ON u.id = f.followee_id WHERE f.follower_id = ? AND u.banned = 0 ORDER BY u.username')
    .all(req.user!.id));
});

app.put('/api/follows/:username', (req, res) => {
  const target = liveUser(req.params.username);
  if (!target) return res.status(404).json({ error: 'No such profile' });
  if (target.id === req.user!.id) return res.status(400).json({ error: 'You cannot follow yourself' });
  db.handle.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)')
    .run(req.user!.id, target.id, new Date().toISOString());
  res.json({ following: true });
});

/** Unfollowing is allowed for a suspended account too: a follow of one should be removable. */
app.delete('/api/follows/:username', (req, res) => {
  const target = HANDLE.test(req.params.username) ? findUserByUsername(db, req.params.username) : undefined;
  if (!target) return res.status(404).json({ error: 'No such profile' });
  db.handle.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(req.user!.id, target.id);
  res.json({ following: false });
});

// --- auto-posts ----------------------------------------------------------------------

/** What happened, put on the feed by the server (never by the client): a ride or gear added, an RSVP, a public event made. */
function autoPost(ownerId: string, kind: 'ride' | 'gear' | 'rsvp' | 'event', refId: string, body: string, where?: { lat: number; lng: number; place: string }) {
  db.handle
    .prepare('INSERT INTO posts (id, owner_id, kind, ref_id, lat, lng, place_name, body, hidden, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)')
    .run(crypto.randomUUID(), ownerId, kind, refId, where?.lat ?? null, where?.lng ?? null, where?.place ?? '', body, new Date().toISOString());
}
/** Deleting the thing deletes its auto-posts. */
const dropPosts = (kinds: string[], refId: string) =>
  db.handle.prepare(`DELETE FROM posts WHERE kind IN (${kinds.map(() => '?').join(',')}) AND ref_id = ?`).run(...kinds, refId);

// --- Kit: rides ---------------------------------------------------------------------

const MAX_RIDES = 30;
const MAX_GEAR = 100;
const MAX_RIDE_PHOTOS = 6;

interface RideRow {
  id: string; owner_id: string; kind: string; make: string; model: string; year: number | null;
  nickname: string; notes: string; created_at: string; updated_at: string;
}
interface RidePhotoRow { id: string; ride_id: string; owner_id: string; file: string; thumb: string; w: number; h: number; created_at: string }

/** Rides with their pictures, fetched together rather than one query per ride. */
function ridesJson(rows: RideRow[]) {
  const photos = rows.length
    ? db.handle.prepare(`SELECT * FROM ride_photos WHERE ride_id IN (${rows.map(() => '?').join(',')}) ORDER BY created_at, id`)
      .all(...rows.map((r) => r.id)) as unknown as RidePhotoRow[]
    : [];
  return rows.map((r) => ({
    id: r.id, ownerId: r.owner_id, kind: r.kind, make: r.make, model: r.model, year: r.year, nickname: r.nickname, notes: r.notes,
    photos: photos.filter((p) => p.ride_id === r.id)
      .map((p) => ({ id: p.id, url: `/api/kit/photos/${p.id}/file`, thumbUrl: `/api/kit/photos/${p.id}/thumb`, w: p.w, h: p.h })),
    createdAt: r.created_at, updatedAt: r.updated_at,
  }));
}

/** The ride in the URL if the caller may change it; otherwise the reply is already sent and this is undefined. */
function ownedRide(req: express.Request, res: express.Response): RideRow | undefined {
  const row = db.handle.prepare('SELECT * FROM rides WHERE id = ?').get(req.params.id) as unknown as RideRow | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return undefined; }
  if (!canEdit(row.owner_id, req.user)) { res.status(403).json({ error: 'Forbidden' }); return undefined; }
  return row;
}

app.post('/api/kit/rides', (req, res) => {
  const input = parseRide(req.body);
  if (!input.ok) return res.status(400).json({ error: input.error });
  const owned = db.handle.prepare('SELECT COUNT(*) AS n FROM rides WHERE owner_id = ?').get(req.user!.id) as { n: number };
  if (owned.n >= MAX_RIDES) return res.status(409).json({ error: `You can keep ${MAX_RIDES} rides` });
  const v = input.value;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.handle.prepare('INSERT INTO rides (id, owner_id, kind, make, model, year, nickname, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.user!.id, v.kind, v.make, v.model, v.year, v.nickname, v.notes, now, now);
  autoPost(req.user!.id, 'ride', id, [v.year, v.make, v.model].filter(Boolean).join(' '));
  res.status(201).json(ridesJson([db.handle.prepare('SELECT * FROM rides WHERE id = ?').get(id) as unknown as RideRow])[0]);
});

app.patch('/api/kit/rides/:id', (req, res) => {
  const row = ownedRide(req, res);
  if (!row) return;
  const input = parseRide(req.body, { kind: row.kind as 'car' | 'motorbike', make: row.make, model: row.model, year: row.year, nickname: row.nickname, notes: row.notes });
  if (!input.ok) return res.status(400).json({ error: input.error });
  const v = input.value;
  db.handle.prepare('UPDATE rides SET kind=?, make=?, model=?, year=?, nickname=?, notes=?, updated_at=? WHERE id=?')
    .run(v.kind, v.make, v.model, v.year, v.nickname, v.notes, new Date().toISOString(), row.id);
  res.json(ridesJson([db.handle.prepare('SELECT * FROM rides WHERE id = ?').get(row.id) as unknown as RideRow])[0]);
});

app.delete('/api/kit/rides/:id', (req, res) => {
  const row = ownedRide(req, res);
  if (!row) return;
  const photos = db.handle.prepare('SELECT file, thumb FROM ride_photos WHERE ride_id = ?').all(row.id) as { file: string; thumb: string }[];
  deleteImages(photos.flatMap((p) => [p.file, p.thumb]));
  db.handle.prepare('DELETE FROM ride_photos WHERE ride_id = ?').run(row.id);
  db.handle.prepare('DELETE FROM rides WHERE id = ?').run(row.id);
  dropPosts(['ride'], row.id);
  res.json({ ok: true });
});

app.post('/api/kit/rides/:id/photos', uploadLimit, async (req, res, next) => {
  try {
    const ride = ownedRide(req, res);
    if (!ride) return;
    // Counted against the ride's owner, so an admin adding a picture does not spend their own allowance.
    const refusal = (): { status: number; error: string } | null => {
      const held = db.handle.prepare('SELECT COUNT(*) AS n FROM ride_photos WHERE ride_id = ?').get(ride.id) as { n: number };
      if (held.n >= MAX_RIDE_PHOTOS) return { status: 409, error: `A ride can have ${MAX_RIDE_PHOTOS} photos` };
      if (photosToday(ride.owner_id) >= MAX_PHOTOS_PER_DAY) return { status: 429, error: 'Daily photo limit reached. Try again tomorrow.' };
      return null;
    };
    let refused = refusal();
    if (refused) return res.status(refused.status).json({ error: refused.error });

    const { fields, files } = await parseMultipart(req, MAX_PHOTO_BYTES * 2 + 4096);
    if (!files.photo || !detectImageType(files.photo)) return res.status(400).json({ error: 'photo must be a JPEG, PNG or WebP file' });
    const thumbBuf = files.thumb && detectImageType(files.thumb) ? files.thumb : files.photo;
    const { w, h } = photoMeta(fields);
    // Asked again: other uploads to this ride may have landed while this one was being read.
    refused = refusal();
    if (refused) return res.status(refused.status).json({ error: refused.error });

    const file = saveImage(files.photo);
    const thumb = saveImage(thumbBuf);
    const id = crypto.randomUUID();
    db.handle.prepare('INSERT INTO ride_photos (id, ride_id, owner_id, file, thumb, w, h, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, ride.id, ride.owner_id, file, thumb, w, h, new Date().toISOString());
    res.status(201).json(ridesJson([ride])[0]);
  } catch (err) { next(err); }
});

/** A ride's picture is as public as the profile it is on, and gone with a suspended account. */
function serveRidePhoto(variant: 'file' | 'thumb') {
  return (req: express.Request, res: express.Response) => {
    const row = db.handle.prepare('SELECT p.file, p.thumb, u.banned FROM ride_photos p JOIN users u ON u.id = p.owner_id WHERE p.id = ?')
      .get(req.params.id) as { file: string; thumb: string; banned: number } | undefined;
    if (!row || row.banned === 1) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(photosDir, variant === 'file' ? row.file : row.thumb));
  };
}
app.get('/api/kit/photos/:id/file', serveRidePhoto('file'));
app.get('/api/kit/photos/:id/thumb', serveRidePhoto('thumb'));

app.delete('/api/kit/photos/:id', (req, res) => {
  const row = db.handle.prepare('SELECT * FROM ride_photos WHERE id = ?').get(req.params.id) as unknown as RidePhotoRow | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!canEdit(row.owner_id, req.user)) return res.status(403).json({ error: 'Forbidden' });
  deleteImages([row.file, row.thumb]);
  db.handle.prepare('DELETE FROM ride_photos WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// --- Kit: gear ----------------------------------------------------------------------

interface GearRow { id: string; owner_id: string; kind: string; brand: string; name: string; notes: string; created_at: string; updated_at: string }
function gearJson(r: GearRow) {
  return { id: r.id, ownerId: r.owner_id, kind: r.kind, brand: r.brand, name: r.name, notes: r.notes, createdAt: r.created_at, updatedAt: r.updated_at };
}

function ownedGear(req: express.Request, res: express.Response): GearRow | undefined {
  const row = db.handle.prepare('SELECT * FROM gear WHERE id = ?').get(req.params.id) as unknown as GearRow | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return undefined; }
  if (!canEdit(row.owner_id, req.user)) { res.status(403).json({ error: 'Forbidden' }); return undefined; }
  return row;
}

/** Suggestions for the gear form (see gearCatalog.ts); the form takes any text. */
app.get('/api/gear/catalog', (req, res) => {
  res.json(searchCatalog(catalog(), typeof req.query.q === 'string' ? req.query.q : ''));
});

app.post('/api/kit/gear', (req, res) => {
  const input = parseGear(req.body);
  if (!input.ok) return res.status(400).json({ error: input.error });
  const owned = db.handle.prepare('SELECT COUNT(*) AS n FROM gear WHERE owner_id = ?').get(req.user!.id) as { n: number };
  if (owned.n >= MAX_GEAR) return res.status(409).json({ error: `You can keep ${MAX_GEAR} pieces of gear` });
  const v = input.value;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.handle.prepare('INSERT INTO gear (id, owner_id, kind, brand, name, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.user!.id, v.kind, v.brand, v.name, v.notes, now, now);
  autoPost(req.user!.id, 'gear', id, `${v.brand} ${v.name}`);
  res.status(201).json(gearJson(db.handle.prepare('SELECT * FROM gear WHERE id = ?').get(id) as unknown as GearRow));
});

app.patch('/api/kit/gear/:id', (req, res) => {
  const row = ownedGear(req, res);
  if (!row) return;
  const input = parseGear(req.body, { kind: row.kind as 'camera' | 'lens' | 'other', brand: row.brand, name: row.name, notes: row.notes });
  if (!input.ok) return res.status(400).json({ error: input.error });
  const v = input.value;
  db.handle.prepare('UPDATE gear SET kind=?, brand=?, name=?, notes=?, updated_at=? WHERE id=?')
    .run(v.kind, v.brand, v.name, v.notes, new Date().toISOString(), row.id);
  res.json(gearJson(db.handle.prepare('SELECT * FROM gear WHERE id = ?').get(row.id) as unknown as GearRow));
});

app.delete('/api/kit/gear/:id', (req, res) => {
  const row = ownedGear(req, res);
  if (!row) return;
  db.handle.prepare('DELETE FROM gear WHERE id = ?').run(row.id);
  dropPosts(['gear'], row.id);
  res.json({ ok: true });
});

// --- community events -----------------------------------------------------------------
// Made by people here, not scraped: they live in their own table and are served
// from here, never through events.ts, so the two can be told apart wherever they meet.

const MAX_UPCOMING_EVENTS = 20;

interface CommunityRow {
  id: string; owner_id: string; title: string; description: string; start_time: string; end_time: string | null;
  venue_name: string; address: string; lat: number; lng: number; price_text: string; visibility: 'public' | 'unlisted';
  created_at: string; updated_at: string;
  cruise?: string | null; hidden?: number; owner_name?: string; owner_avatar?: string; owner_banned?: number; going?: number | bigint; is_going?: number | bigint;
}

/** With no end time an event counts as on for twelve hours after it starts. */
const STILL_ON = "COALESCE(e.end_time, strftime('%Y-%m-%dT%H:%M:%fZ', e.start_time, '+12 hours')) > ?";
const COMMUNITY_SELECT =
  'SELECT e.*, u.username AS owner_name, u.avatar AS owner_avatar, u.banned AS owner_banned, ' +
  '(SELECT COUNT(*) FROM community_rsvps r JOIN users ru ON ru.id = r.user_id WHERE r.event_id = e.id AND ru.banned = 0) AS going, ' +
  'EXISTS (SELECT 1 FROM community_rsvps r WHERE r.event_id = e.id AND r.user_id = ?) AS is_going ' +
  'FROM community_events e JOIN users u ON u.id = e.owner_id';

/** `full` adds the cruise's line; a list leaves it out, since a list of 500 events would carry 500 routes. */
function communityJson(r: CommunityRow, full = false) {
  return {
    id: r.id, ownerId: r.owner_id, owner: { username: r.owner_name ?? '', avatar: r.owner_avatar ?? '' },
    title: r.title, description: r.description, startTime: r.start_time, endTime: r.end_time,
    venueName: r.venue_name, address: r.address, lat: r.lat, lng: r.lng, priceText: r.price_text, visibility: r.visibility,
    going: Number(r.going ?? 0), isGoing: Number(r.is_going ?? 0) === 1,
    cruise: cruiseJson(readCruise(r.cruise), full),
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const communityEvent = (id: string, userId: string | undefined) =>
  db.handle.prepare(`${COMMUNITY_SELECT} WHERE e.id = ?`).get(userId ?? '', id) as unknown as CommunityRow | undefined;

/** Public and unlisted can be read by anyone with the id; a suspended organiser's events are out of sight except to an admin. */
function communityReadable(r: CommunityRow, user: SessionUser | null | undefined): boolean {
  // A hidden event (see the reports queue) is seen by its organiser and by staff only.
  const hiddenOk = r.hidden !== 1 || isStaff(user) || user?.id === r.owner_id;
  return canRead(r.visibility, r.owner_id, user ?? null) && (r.owner_banned !== 1 || user?.role === 'admin') && hiddenOk;
}

const eventIsOver = (r: CommunityRow) =>
  (r.end_time ? Date.parse(r.end_time) : Date.parse(r.start_time) + 12 * 3_600_000) <= Date.now();

/** Going to a community event, once per person. A public one goes on the feed the first time. */
function communityGoing(row: CommunityRow, userId: string): void {
  const added = db.handle.prepare('INSERT OR IGNORE INTO community_rsvps (event_id, user_id, created_at) VALUES (?, ?, ?)')
    .run(row.id, userId, new Date().toISOString());
  if (added.changes > 0 && row.visibility === 'public') autoPost(userId, 'rsvp', row.id, row.title, { lat: row.lat, lng: row.lng, place: row.venue_name });
}

/** What is still on: everyone's public events, and your own unlisted ones. Unlisted events never appear in anyone else's list. */
app.get('/api/community-events', (req, res) => {
  const me = req.user?.id ?? '';
  const rows = db.handle
    .prepare(`${COMMUNITY_SELECT} WHERE u.banned = 0 AND e.hidden = 0 AND ${STILL_ON} AND (e.visibility = 'public' OR e.owner_id = ?) ORDER BY e.start_time, e.id LIMIT 500`)
    .all(me, new Date().toISOString(), me) as unknown as CommunityRow[];
  res.json(rows.map((r) => communityJson(r)));
});

app.post('/api/community-events', (req, res) => {
  const input = parseCommunityEvent(req.body, Date.now());
  if (!input.ok) return res.status(400).json({ error: input.error });
  const upcoming = db.handle.prepare(`SELECT COUNT(*) AS n FROM community_events e WHERE e.owner_id = ? AND ${STILL_ON}`)
    .get(req.user!.id, new Date().toISOString()) as { n: number };
  if (upcoming.n >= MAX_UPCOMING_EVENTS) return res.status(409).json({ error: `You can have ${MAX_UPCOMING_EVENTS} upcoming events` });
  const v = input.value;
  const cruise = req.body?.cruise == null ? null : resolveCruise(db, req.body.cruise, { ownerId: req.user!.id, start: v.startTime, end: v.endTime, current: null });
  if (cruise && !cruise.ok) return res.status(400).json({ error: cruise.error });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.handle
    .prepare('INSERT INTO community_events (id, owner_id, title, description, start_time, end_time, venue_name, address, lat, lng, price_text, visibility, cruise, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, req.user!.id, v.title, v.description, v.startTime, v.endTime, v.venueName, v.address, v.lat, v.lng, v.priceText, v.visibility, cruise?.ok ? JSON.stringify(cruise.value) : null, now, now);
  if (v.visibility === 'public') autoPost(req.user!.id, 'event', id, v.title, { lat: v.lat, lng: v.lng, place: v.venueName });
  res.status(201).json(communityJson(communityEvent(id, req.user!.id)!, true));
});

app.get('/api/community-events/:id', (req, res) => {
  const row = communityEvent(req.params.id, req.user?.id);
  if (!row || !communityReadable(row, req.user)) return res.status(404).json({ error: 'No such event' });
  res.json(communityJson(row, true));
});

app.patch('/api/community-events/:id', (req, res) => {
  const row = communityEvent(req.params.id, req.user!.id);
  if (!row) return res.status(404).json({ error: 'No such event' });
  if (!canEdit(row.owner_id, req.user)) return res.status(403).json({ error: 'Forbidden' });
  const input = parseCommunityEvent(req.body, Date.now(), {
    title: row.title, description: row.description, startTime: row.start_time, endTime: row.end_time, venueName: row.venue_name,
    address: row.address, lat: row.lat, lng: row.lng, priceText: row.price_text, visibility: row.visibility,
  });
  if (!input.ok) return res.status(400).json({ error: input.error });
  const v = input.value;
  // The cruise: left out keeps it (checked again against the new times), null takes it off, an object sets it.
  // Only the organiser can attach a route; staff can still take one off.
  const body = (req.body ?? {}) as { cruise?: unknown };
  let cruise = row.cruise ?? null;
  if (body.cruise === null) cruise = null;
  else if (body.cruise !== undefined && row.owner_id !== req.user!.id) return res.status(403).json({ error: 'Only the organiser can change the cruise' });
  else if (body.cruise !== undefined || (cruise && (v.startTime !== row.start_time || v.endTime !== row.end_time))) {
    const made = resolveCruise(db, body.cruise ?? {}, { ownerId: row.owner_id, start: v.startTime, end: v.endTime, current: readCruise(cruise) });
    if (!made.ok) return res.status(400).json({ error: made.error });
    cruise = JSON.stringify(made.value);
  }
  db.handle
    .prepare('UPDATE community_events SET title=?, description=?, start_time=?, end_time=?, venue_name=?, address=?, lat=?, lng=?, price_text=?, visibility=?, cruise=?, updated_at=? WHERE id=?')
    .run(v.title, v.description, v.startTime, v.endTime, v.venueName, v.address, v.lat, v.lng, v.priceText, v.visibility, cruise, new Date().toISOString(), row.id);
  // Made unlisted, an event leaves the feed; the posts are not remade if it goes public again.
  if (v.visibility === 'unlisted') dropPosts(['event', 'rsvp'], row.id);
  res.json(communityJson(communityEvent(row.id, req.user!.id)!, true));
});

app.delete('/api/community-events/:id', (req, res) => {
  const row = communityEvent(req.params.id, req.user!.id);
  if (!row) return res.status(404).json({ error: 'No such event' });
  if (!canEdit(row.owner_id, req.user)) return res.status(403).json({ error: 'Forbidden' });
  dropPosts(['event', 'rsvp'], row.id);
  db.handle.prepare('DELETE FROM community_rsvps WHERE event_id = ?').run(row.id);
  db.handle.prepare("DELETE FROM event_invites WHERE event_kind = 'community' AND event_ref = ?").run(row.id);
  db.handle.prepare('DELETE FROM community_events WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

app.get('/api/community-events/:id/rsvp', (req, res) => {
  const row = communityEvent(req.params.id, req.user?.id);
  if (!row || !communityReadable(row, req.user)) return res.status(404).json({ error: 'No such event' });
  res.json({ rsvp: communityRsvpSummary(db, row.id, req.user?.id ?? null) });
});

app.put('/api/community-events/:id/rsvp', (req, res) => {
  const row = communityEvent(req.params.id, req.user!.id);
  if (!row || !communityReadable(row, req.user)) return res.status(404).json({ error: 'No such event' });
  if (eventIsOver(row)) return res.status(409).json({ error: 'That event is over' });
  communityGoing(row, req.user!.id);
  res.json({ rsvp: communityRsvpSummary(db, row.id, req.user!.id) });
});

app.delete('/api/community-events/:id/rsvp', (req, res) => {
  const row = communityEvent(req.params.id, req.user!.id);
  if (!row || !communityReadable(row, req.user)) return res.status(404).json({ error: 'No such event' });
  db.handle.prepare('DELETE FROM community_rsvps WHERE event_id = ? AND user_id = ?').run(row.id, req.user!.id);
  db.handle.prepare("DELETE FROM posts WHERE kind = 'rsvp' AND ref_id = ? AND owner_id = ?").run(row.id, req.user!.id);
  res.json({ rsvp: communityRsvpSummary(db, row.id, req.user!.id) });
});

// --- invites ----------------------------------------------------------------------
// One person asks another to an event. Accepting is an RSVP; nobody else sees an invite.

/** Handles that start with what is typed, for choosing who to invite. Not banned people, and not you. */
app.get('/api/users/search', (req, res) => {
  if (!requireUser(req, res)) return;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!/^[A-Za-z0-9_]{2,24}$/.test(q)) return res.json([]);
  // `_` is a wildcard in LIKE and is allowed in a handle, so it is escaped.
  const rows = db.handle
    .prepare("SELECT id, username, avatar FROM users WHERE banned = 0 AND id <> ? AND username LIKE ? ESCAPE '\\' ORDER BY username LIMIT 8")
    .all(req.user!.id, `${q.replace(/_/g, '\\_')}%`);
  res.json(rows);
});

/** A picture of the event an invite is for, or null once it has gone or is out of sight for the person it is shown to. */
function inviteEvent(r: InviteRow, viewer: SessionUser, listed: Map<string, EventItem>) {
  if (r.event_kind === 'event') {
    const ev = listed.get(r.event_ref);
    return ev ? { title: ev.title, startsAt: ev.startTime, venue: ev.venueName, imageUrl: ev.imageUrl } : null;
  }
  const row = communityEvent(r.event_ref, viewer.id);
  return row && communityReadable(row, viewer) ? { title: row.title, startsAt: row.start_time, venue: row.venue_name, imageUrl: '' } : null;
}

app.post('/api/invites', async (req, res, next) => {
  try {
    if (!requireUser(req, res)) return;
    const me = req.user!;
    const { kind, ref, username } = (req.body ?? {}) as { kind?: unknown; ref?: unknown; username?: unknown };
    if (kind !== 'event' && kind !== 'community') return res.status(400).json({ error: 'kind must be event or community' });
    if (typeof ref !== 'string' || ref === '' || ref.length > MAX_GROUP_LENGTH) return res.status(400).json({ error: 'ref must name an event' });
    if (typeof username !== 'string') return res.status(400).json({ error: 'username is required' });
    const target = HANDLE.test(username) ? findUserByUsername(db, username) : undefined;
    if (!target || target.banned) return res.status(404).json({ error: 'No such user' });
    if (target.id === me.id) return res.status(400).json({ error: 'You cannot invite yourself' });
    // The sender must be able to see the event: on the list, or for a community one, readable by them.
    const community = kind === 'community' ? communityEvent(ref, me.id) : undefined;
    const found = kind === 'event' ? eventList().some((ev) => ev.group === ref) : Boolean(community && communityReadable(community, me));
    if (!found) return res.status(404).json({ error: 'No such event' });
    // Asking again about one already sent is answered with that one, and does not count against the hour.
    let invite = findInvite(db, kind, ref, me.id, target.id);
    if (!invite) {
      if (sentLastHour(db, me.id) >= MAX_INVITES_PER_HOUR) return res.status(429).json({ error: `You can send ${MAX_INVITES_PER_HOUR} invites an hour` });
      if (waitingBetween(db, me.id, target.id) >= MAX_PENDING_PER_PAIR) return res.status(429).json({ error: `You already have ${MAX_PENDING_PER_PAIR} invites waiting for this person` });
      invite = addInvite(db, kind, ref, me.id, target.id);
    }
    res.status(201).json({
      invite: {
        id: invite.id, kind: invite.event_kind, ref: invite.event_ref,
        to: { id: target.id, username: target.username, avatar: target.avatar },
        status: invite.status, createdAt: invite.created_at,
      },
    });
  } catch (err) { next(err); }
});

/** Waiting invites from people who are not banned, newest first, with how many there are in all. */
app.get('/api/invites', async (req, res, next) => {
  try {
    if (!requireUser(req, res)) return;
    const me = req.user!;
    const listed = new Map(eventList().map((ev) => [ev.group, ev] as const));
    const invites = waitingInvites(db, me.id).map((r) => ({
      id: r.id, kind: r.event_kind, ref: r.event_ref,
      from: { id: r.from_user, username: r.from_name, avatar: r.from_avatar },
      createdAt: r.created_at,
      event: inviteEvent(r, me, listed),
    }));
    res.json({ invites, pendingCount: waitingInviteCount(db, me.id) });
  } catch (err) { next(err); }
});

/** Accepting is going: the recipient is RSVPed as going, the same way the event's own route would have done it. */
app.post('/api/invites/:id/accept', async (req, res, next) => {
  try {
    if (!requireUser(req, res)) return;
    const me = req.user!;
    const invite = inviteTo(db, req.params.id, me.id);
    if (!invite) return res.status(404).json({ error: 'No such invite' });
    // Only a waiting invite is accepted: a replay must not undo an answer the person has changed since.
    if (invite.status !== 'pending') return res.json({ ok: true });
    if (invite.event_kind === 'event') {
      if (!eventList().some((ev) => ev.group === invite.event_ref)) return res.status(404).json({ error: 'No such event' });
      setEventRsvp(db, me.id, invite.event_ref, 'going');
    } else {
      const row = communityEvent(invite.event_ref, me.id);
      if (!row || !communityReadable(row, me)) return res.status(404).json({ error: 'No such event' });
      if (eventIsOver(row)) return res.status(409).json({ error: 'That event is over' });
      communityGoing(row, me.id);
    }
    setInviteStatus(db, invite.id, 'accepted');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/** Only a waiting invite is dismissed; one already accepted stays accepted. */
app.post('/api/invites/:id/dismiss', (req, res) => {
  if (!requireUser(req, res)) return;
  const invite = inviteTo(db, req.params.id, req.user!.id);
  if (!invite) return res.status(404).json({ error: 'No such invite' });
  if (invite.status === 'pending') setInviteStatus(db, invite.id, 'dismissed');
  res.json({ ok: true });
});

// --- the feed-----------------------------------------------------------------------
// Check-ins by hand, and the auto-posts above. A hidden post, and anything by a suspended
// account, is out of every read. Votes and comments hang off a post by its id.

const FEED_PAGE = 30;
const MAX_CHECKINS_PER_DAY = 30;
const MAX_COMMENTS_PER_DAY = 200;
const MAX_REPORTS_PER_DAY = 20;

/** How many rows one account made in the last day; the SQL takes (user id, since). */
function madeToday(sql: string, userId: string): number {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  return Number((db.handle.prepare(sql).get(userId, since) as { n: number | bigint }).n);
}

interface FeedRow {
  id: string; kind: string; ref_id: string; lat: number | null; lng: number | null; place_name: string; body: string; created_at: string;
  username: string; avatar: string; votes: number | bigint; comments: number | bigint; voted: number | bigint;
}
const FEED_SELECT =
  'SELECT p.id, p.kind, p.ref_id, p.lat, p.lng, p.place_name, p.body, p.created_at, u.username, u.avatar, ' +
  '(SELECT COUNT(*) FROM post_votes v WHERE v.post_id = p.id) AS votes, ' +
  '(SELECT COUNT(*) FROM post_comments c JOIN users cu ON cu.id = c.owner_id WHERE c.post_id = p.id AND c.hidden = 0 AND cu.banned = 0) AS comments, ' +
  'EXISTS (SELECT 1 FROM post_votes v WHERE v.post_id = p.id AND v.user_id = ?) AS voted ' +
  'FROM posts p JOIN users u ON u.id = p.owner_id WHERE p.hidden = 0 AND u.banned = 0';

/** Where a feed card goes when clicked: always a route inside this app, built from ids we made, never from text a user typed. */
function feedLink(r: FeedRow): string {
  if (r.kind === 'ride' || r.kind === 'gear') return `/u/${encodeURIComponent(r.username)}`;
  if (r.kind === 'event' || r.kind === 'rsvp') return `/events?open=${encodeURIComponent(r.ref_id)}`;
  return r.lat !== null && r.lng !== null ? `/?lat=${r.lat}&lng=${r.lng}` : `/u/${encodeURIComponent(r.username)}`;
}

function feedJson(r: FeedRow) {
  return {
    id: r.id, kind: r.kind, created_at: r.created_at, author: { username: r.username, avatar: r.avatar },
    body: r.body, place_name: r.place_name, lat: r.lat, lng: r.lng, link: feedLink(r),
    votes: Number(r.votes), comments: Number(r.comments), voted: Number(r.voted) === 1,
  };
}

/** An ISO-ish instant from the query string, or null when it is not one. */
const instantParam = (v: unknown): number | null => {
  const ms = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

app.get('/api/feed', (req, res) => {
  const scope = req.query.scope ?? 'all';
  if (scope !== 'all' && scope !== 'following') return res.status(400).json({ error: 'scope must be all or following' });
  // The gate sees paths, not queries, so the one scope that needs a session is refused here.
  if (scope === 'following' && !req.user) return res.status(401).json({ error: 'Sign in required' });
  const params: (string | number)[] = [req.user?.id ?? ''];
  let sql = FEED_SELECT;
  if (req.query.before !== undefined) {
    const before = instantParam(req.query.before);
    if (before === null) return res.status(400).json({ error: 'before must be a date and time' });
    sql += ' AND p.created_at < ?';
    params.push(new Date(before).toISOString());
  }
  if (scope === 'following') {
    sql += ' AND p.owner_id IN (SELECT followee_id FROM follows WHERE follower_id = ?)';
    params.push(req.user!.id);
  }
  const rows = db.handle.prepare(`${sql} ORDER BY p.created_at DESC, p.id LIMIT ?`).all(...params, FEED_PAGE) as unknown as FeedRow[];
  res.json(rows.map(feedJson));
});

app.post('/api/checkins', (req, res) => {
  const input = parseCheckin(req.body);
  if (!input.ok) return res.status(400).json({ error: input.error });
  const v = input.value;
  if (madeToday("SELECT COUNT(*) AS n FROM posts WHERE owner_id = ? AND kind = 'checkin' AND created_at > ?", req.user!.id) >= MAX_CHECKINS_PER_DAY) {
    return res.status(429).json({ error: `You can check in ${MAX_CHECKINS_PER_DAY} times a day` });
  }
  let ref = '', lat = v.lat, lng = v.lng, place = v.placeName;
  if (v.spotId) {
    const spot = db.handle.prepare('SELECT id, name, lat, lng, visibility FROM spots WHERE id = ?').get(v.spotId) as
      { id: string; name: string; lat: number; lng: number; visibility: Visibility } | undefined;
    if (!spot || spot.visibility !== 'public') return res.status(404).json({ error: 'No such public spot' });
    ({ lat, lng } = spot);
    ref = `spot:${spot.id}`;
    place = spot.name.slice(0, 120);
  } else if (v.eventId) {
    const ev = communityEvent(v.eventId, req.user!.id);
    if (!ev || ev.visibility !== 'public' || !communityReadable(ev, req.user)) return res.status(404).json({ error: 'No such event' });
    ({ lat, lng } = ev);
    ref = `event:${ev.id}`;
    place = ev.title.slice(0, 120);
  }
  const id = crypto.randomUUID();
  db.handle.prepare("INSERT INTO posts (id, owner_id, kind, ref_id, lat, lng, place_name, body, hidden, created_at) VALUES (?, ?, 'checkin', ?, ?, ?, ?, ?, 0, ?)")
    .run(id, req.user!.id, ref, lat, lng, place, v.body, new Date().toISOString());
  res.status(201).json(feedJson(db.handle.prepare(`${FEED_SELECT} AND p.id = ?`).get(req.user!.id, id) as unknown as FeedRow));
});

/** A post that can be seen, so can be voted on and commented on. */
const visiblePost = (id: string) =>
  Boolean(db.handle.prepare('SELECT 1 FROM posts p JOIN users u ON u.id = p.owner_id WHERE p.id = ? AND p.hidden = 0 AND u.banned = 0').get(id));

app.delete('/api/posts/:id', (req, res) => {
  const row = db.handle.prepare('SELECT owner_id FROM posts WHERE id = ?').get(req.params.id) as { owner_id: string } | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.owner_id !== req.user!.id && !isStaff(req.user)) return res.status(403).json({ error: 'Forbidden' });
  db.handle.prepare('DELETE FROM post_votes WHERE post_id = ?').run(req.params.id);
  db.handle.prepare('DELETE FROM post_comments WHERE post_id = ?').run(req.params.id);
  db.handle.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

function voteReply(postId: string, voted: boolean) {
  const n = db.handle.prepare('SELECT COUNT(*) AS n FROM post_votes WHERE post_id = ?').get(postId) as { n: number | bigint };
  return { votes: Number(n.n), voted };
}
app.put('/api/posts/:id/vote', (req, res) => {
  if (!visiblePost(req.params.id)) return res.status(404).json({ error: 'Not found' });
  db.handle.prepare('INSERT OR IGNORE INTO post_votes (post_id, user_id) VALUES (?, ?)').run(req.params.id, req.user!.id);
  res.json(voteReply(req.params.id, true));
});
app.delete('/api/posts/:id/vote', (req, res) => {
  if (!visiblePost(req.params.id)) return res.status(404).json({ error: 'Not found' });
  db.handle.prepare('DELETE FROM post_votes WHERE post_id = ? AND user_id = ?').run(req.params.id, req.user!.id);
  res.json(voteReply(req.params.id, false));
});

const commentJson = (r: { id: string; body: string; created_at: string; username: string; avatar: string }) =>
  ({ id: r.id, body: r.body, created_at: r.created_at, author: { username: r.username, avatar: r.avatar } });

app.get('/api/posts/:id/comments', (req, res) => {
  if (!visiblePost(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const rows = db.handle
    .prepare('SELECT c.id, c.body, c.created_at, u.username, u.avatar FROM post_comments c JOIN users u ON u.id = c.owner_id WHERE c.post_id = ? AND c.hidden = 0 AND u.banned = 0 ORDER BY c.created_at, c.id LIMIT 200')
    .all(req.params.id) as unknown as Parameters<typeof commentJson>[0][];
  res.json(rows.map(commentJson));
});

app.post('/api/posts/:id/comments', (req, res) => {
  const input = parseMessage(req.body, MAX_POST_BODY);
  if (!input.ok) return res.status(400).json({ error: input.error });
  if (!visiblePost(req.params.id)) return res.status(404).json({ error: 'Not found' });
  if (madeToday('SELECT COUNT(*) AS n FROM post_comments WHERE owner_id = ? AND created_at > ?', req.user!.id) >= MAX_COMMENTS_PER_DAY) {
    return res.status(429).json({ error: `You can comment ${MAX_COMMENTS_PER_DAY} times a day` });
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.handle.prepare('INSERT INTO post_comments (id, post_id, owner_id, body, hidden, created_at) VALUES (?, ?, ?, ?, 0, ?)')
    .run(id, req.params.id, req.user!.id, input.value, now);
  const me = findUserById(db, req.user!.id)!;
  res.status(201).json(commentJson({ id, body: input.value, created_at: now, username: me.username, avatar: me.avatar }));
});

app.delete('/api/comments/:id', (req, res) => {
  const row = db.handle.prepare('SELECT owner_id FROM post_comments WHERE id = ?').get(req.params.id) as { owner_id: string } | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.owner_id !== req.user!.id && !isStaff(req.user)) return res.status(403).json({ error: 'Forbidden' });
  db.handle.prepare('DELETE FROM post_comments WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- chat ---------------------------------------------------------------------------
// One public room. New lines are pushed to open sockets (see realtime.ts); a client that cannot connect polls GET /api/chat instead.

const chatJson = (r: { id: string; body: string; created_at: string; username: string; avatar: string }) =>
  ({ id: r.id, body: r.body, created_at: r.created_at, author: { username: r.username, avatar: r.avatar } });

/** Newest 100 from the last thirty minutes, oldest first; `after` narrows it to what a poller has not seen. Filtered on read so a task that has not run leaks nothing. */
app.get('/api/chat', (req, res) => {
  let since = Date.now() - CHAT_MINUTES * 60_000;
  if (req.query.after !== undefined) {
    const after = instantParam(req.query.after);
    if (after === null) return res.status(400).json({ error: 'after must be a date and time' });
    since = Math.max(since, after);
  }
  const rows = db.handle
    .prepare('SELECT m.id, m.body, m.created_at, u.username, u.avatar FROM chat_messages m JOIN users u ON u.id = m.owner_id WHERE u.banned = 0 AND m.created_at > ? ORDER BY m.created_at DESC, m.id DESC LIMIT 100')
    .all(new Date(since).toISOString()) as unknown as Parameters<typeof chatJson>[0][];
  res.json(rows.reverse().map(chatJson));
});

app.post('/api/chat', chatLimit, (req, res) => {
  const input = parseMessage(req.body, MAX_CHAT_BODY);
  if (!input.ok) return res.status(400).json({ error: input.error });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.handle.prepare('INSERT INTO chat_messages (id, owner_id, body, created_at) VALUES (?, ?, ?, ?)').run(id, req.user!.id, input.value, now);
  const me = findUserById(db, req.user!.id)!;
  const line = chatJson({ id, body: input.value, created_at: now, username: me.username, avatar: me.avatar });
  chatFeed.posted(line);
  res.status(201).json(line);
});

app.delete('/api/chat/:id', (req, res) => {
  const row = db.handle.prepare('SELECT owner_id FROM chat_messages WHERE id = ?').get(req.params.id) as { owner_id: string } | undefined;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.owner_id !== req.user!.id && !isStaff(req.user)) return res.status(403).json({ error: 'Forbidden' });
  db.handle.prepare('DELETE FROM chat_messages WHERE id = ?').run(req.params.id);
  chatFeed.removed(req.params.id);
  res.json({ ok: true });
});

// --- reports and moderation -----------------------------------------------------------

/**
 * What a report is about: a snapshot of its text and who wrote it. With a `viewer` the thing has to be
 * one that viewer can see (so nobody reports, and learns of, what they could not open); without one,
 * as for staff reading the queue, a hidden or suspended author's thing is still found.
 */
function reportTarget(kind: string, id: string, viewer?: SessionUser): { text: string; ownerId: string } | undefined {
  const seen = viewer !== undefined;
  const one = (sql: string) => db.handle.prepare(sql).get(id) as Record<string, any> | undefined;
  switch (kind) {
    case 'post': {
      const r = one(`SELECT p.owner_id, p.body, p.place_name FROM posts p JOIN users u ON u.id = p.owner_id WHERE p.id = ?${seen ? ' AND p.hidden = 0 AND u.banned = 0' : ''}`);
      return r && { text: r.body || r.place_name, ownerId: r.owner_id };
    }
    case 'comment': {
      const r = one(`SELECT c.owner_id, c.body FROM post_comments c JOIN users u ON u.id = c.owner_id WHERE c.id = ?${seen ? ' AND c.hidden = 0 AND u.banned = 0' : ''}`);
      return r && { text: r.body, ownerId: r.owner_id };
    }
    case 'chat': {
      const r = one(`SELECT m.owner_id, m.body FROM chat_messages m JOIN users u ON u.id = m.owner_id WHERE m.id = ?${seen ? ' AND u.banned = 0' : ''}`);
      return r && { text: r.body, ownerId: r.owner_id };
    }
    case 'community_event': {
      const r = communityEvent(id, viewer?.id);
      return r && (!seen || communityReadable(r, viewer)) ? { text: `${r.title}. ${r.description}`, ownerId: r.owner_id } : undefined;
    }
    case 'profile': {
      const r = one(`SELECT id, username, bio FROM users WHERE id = ?${seen ? ' AND banned = 0' : ''}`);
      return r && { text: r.bio || r.username, ownerId: r.id };
    }
    case 'ride': {
      const r = one(`SELECT r.owner_id, r.make, r.model, r.nickname, r.notes FROM rides r JOIN users u ON u.id = r.owner_id WHERE r.id = ?${seen ? ' AND u.banned = 0' : ''}`);
      return r && { text: [r.make, r.model, r.nickname, r.notes].filter(Boolean).join(' '), ownerId: r.owner_id };
    }
    case 'spot': {
      const r = one('SELECT owner_id, name, notes, visibility FROM spots WHERE id = ?');
      return r && (!seen || canRead(r.visibility, r.owner_id, viewer ?? null)) ? { text: [r.name, r.notes].filter(Boolean).join('. '), ownerId: r.owner_id } : undefined;
    }
  }
  return undefined;
}

app.post('/api/reports', (req, res) => {
  const input = parseReport(req.body);
  if (!input.ok) return res.status(400).json({ error: input.error });
  const v = input.value;
  if (!reportTarget(v.targetKind, v.targetId, req.user!)) return res.status(404).json({ error: 'No such thing to report' });
  if (db.handle.prepare('SELECT 1 FROM reports WHERE reporter_id = ? AND target_kind = ? AND target_id = ? AND resolved_at IS NULL').get(req.user!.id, v.targetKind, v.targetId)) {
    return res.status(409).json({ error: 'You have already reported that' });
  }
  if (madeToday('SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ? AND created_at > ?', req.user!.id) >= MAX_REPORTS_PER_DAY) {
    return res.status(429).json({ error: `You can file ${MAX_REPORTS_PER_DAY} reports a day` });
  }
  db.handle.prepare('INSERT INTO reports (id, reporter_id, target_kind, target_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), req.user!.id, v.targetKind, v.targetId, v.reason, new Date().toISOString());
  res.status(201).json({ ok: true });
});

/** The queue: open reports oldest first, then the latest resolved ones. */
app.get('/api/reports', (req, res) => {
  if (!isStaff(req.user)) return res.status(403).json({ error: 'Staff only' });
  const rows = db.handle
    .prepare(
      `SELECT r.id, r.target_kind, r.target_id, r.reason, r.created_at, r.resolved_at, u.username AS reporter
         FROM reports r LEFT JOIN users u ON u.id = r.reporter_id
        ORDER BY r.resolved_at IS NOT NULL, CASE WHEN r.resolved_at IS NULL THEN r.created_at END, r.resolved_at DESC LIMIT 200`
    )
    .all() as unknown as { id: string; target_kind: string; target_id: string; reason: string; created_at: string; resolved_at: string | null; reporter: string | null }[];
  res.json(rows.map((r) => {
    const target = reportTarget(r.target_kind, r.target_id);
    const author = target && findUserById(db, target.ownerId);
    return {
      ...r,
      snapshot: target ? target.text.slice(0, 200) : null,
      author: author ? { id: author.id, username: author.username, role: author.role, banned: author.banned } : null,
    };
  }));
});

app.post('/api/reports/:id/resolve', (req, res) => {
  if (!isStaff(req.user)) return res.status(403).json({ error: 'Staff only' });
  const action = (req.body as { action?: unknown } | undefined)?.action;
  if (action !== 'dismiss' && action !== 'hide') return res.status(400).json({ error: 'action must be dismiss or hide' });
  const r = db.handle.prepare('SELECT id, target_kind, target_id, resolved_at FROM reports WHERE id = ?').get(req.params.id) as
    { id: string; target_kind: string; target_id: string; resolved_at: string | null } | undefined;
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (r.resolved_at) return res.status(409).json({ error: 'Already resolved' });
  const now = new Date().toISOString();
  if (action === 'dismiss') {
    db.handle.prepare('UPDATE reports SET resolved_at = ?, resolved_by = ? WHERE id = ?').run(now, req.user!.id, r.id);
    return res.json({ ok: true });
  }
  // Hiding. A profile, ride or spot is only resolved: staff then suspend the user, or an admin deals with the spot.
  if (r.target_kind === 'post') db.handle.prepare('UPDATE posts SET hidden = 1 WHERE id = ?').run(r.target_id);
  else if (r.target_kind === 'comment') db.handle.prepare('UPDATE post_comments SET hidden = 1 WHERE id = ?').run(r.target_id);
  else if (r.target_kind === 'chat') {
    db.handle.prepare('DELETE FROM chat_messages WHERE id = ?').run(r.target_id);
    chatFeed.removed(r.target_id);
  }
  else if (r.target_kind === 'community_event') {
    db.handle.prepare('UPDATE community_events SET hidden = 1 WHERE id = ?').run(r.target_id);
    db.handle.prepare("UPDATE posts SET hidden = 1 WHERE kind IN ('event', 'rsvp') AND ref_id = ?").run(r.target_id);
  }
  // Everyone's open report on the same thing is settled with it.
  db.handle.prepare('UPDATE reports SET resolved_at = ?, resolved_by = ? WHERE target_kind = ? AND target_id = ? AND resolved_at IS NULL')
    .run(now, req.user!.id, r.target_kind, r.target_id);
  res.json({ ok: true });
});

// --- suggested spots -----------------------------------------------------------------
// Anyone signed in may suggest a place for the public map. It waits in the moderators' queue (the
// Moderation page) and is not a spot until one of them approves it.

app.post('/api/suggestions', (req, res) => {
  const input = parseSuggestion(req.body);
  if (!input.ok) return res.status(400).json({ error: input.error });
  const refusal = suggestionRefusal(db, req.user!.id);
  if (refusal) return res.status(429).json({ error: refusal });
  res.status(201).json(suggestionJson(addSuggestion(db, req.user!.id, input.value)));
});

app.get('/api/suggestions', (req, res) => {
  if (!isStaff(req.user)) return res.status(403).json({ error: 'Staff only' });
  res.json(listSuggestions(db).map(suggestionJson));
});

app.post('/api/suggestions/:id/resolve', (req, res) => {
  if (!isStaff(req.user)) return res.status(403).json({ error: 'Staff only' });
  const action = (req.body as { action?: unknown } | undefined)?.action;
  if (action !== 'approve' && action !== 'reject') return res.status(400).json({ error: 'action must be approve or reject' });
  const done = resolveSuggestion(db, req.params.id, req.user!.id, action);
  if (!done.ok) return res.status(done.status).json({ error: done.error });
  res.json({ ok: true, spotId: done.spotId });
});

// --- calendar subscription ------------------------------------------------------------
// A calendar app cannot sign in, so a person gets a secret link: the public events plus their own
// stars, minus what they have hidden. The link is shown once when made; only its hash is kept.

app.get('/api/calendar-link', (req, res) => {
  const info = calendarTokenInfo(db, req.user!.id);
  res.json({ exists: info !== null, createdAt: info?.createdAt ?? null });
});

/** Makes the link, or a new one that replaces (and so ends) the old. */
app.post('/api/calendar-link', (req, res) => {
  const token = issueCalendarToken(db, req.user!.id);
  res.status(201).json({ token, url: `${publicUrl()}/api/calendar/${token}.ics` });
});

app.delete('/api/calendar-link', (req, res) => {
  revokeCalendarToken(db, req.user!.id);
  res.json({ ok: true });
});

/** The feed itself. A token that is not live is a 404, whatever is wrong with it. */
app.get('/api/calendar/:file', (req, res) => {
  const token = /^([0-9a-f]{64})\.ics$/.exec(req.params.file)?.[1];
  const userId = token ? userForCalendarToken(db, token) : null;
  if (!userId) return res.status(404).json({ error: 'No such calendar' });
  const starredOnly = req.query.starred === '1';
  const states = userEventStates(db, userId);
  const listed = eventList()
    .filter((ev) => !states.get(ev.group)?.hidden && (!starredOnly || states.get(ev.group)?.starred))
    .map((ev) => ({ ...ev, uid: ev.group }));
  const community = starredOnly ? [] : (db.handle
    .prepare(`${COMMUNITY_SELECT} WHERE u.banned = 0 AND e.hidden = 0 AND ${STILL_ON} AND e.visibility = 'public' ORDER BY e.start_time, e.id LIMIT 500`)
    .all('', new Date().toISOString()) as unknown as CommunityRow[])
    .map((r) => ({ uid: `community:${r.id}`, title: r.title, description: r.description, startTime: r.start_time, endTime: r.end_time, venueName: r.venue_name, address: r.address, url: '', lat: r.lat, lng: r.lng }));
  const all = [...listed, ...community];
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Cache-Control', 'private, max-age=300');
  res.send(buildIcs(all, { name: starredOnly ? 'PhotoScout - shortlist' : 'PhotoScout events', description: `${all.length} events from PhotoScout` }));
});

// --- plugins: their routes, the admin API and their static files ------------------

mountPlugins(app, pluginRuntime, { kv: { get: (k) => db.getKv(k), set: (k, v) => db.setKv(k, v) } });

// --- 404 + error handling, then the built frontend -------------------------------

app.use('/api', (req, res) => {
  res.status(404).json({ error: `Unknown endpoint: ${req.method} ${req.baseUrl}${req.path}` });
});

app.use('/api', (err: Error & { status?: number }, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(err);
  const status = err.status ?? 500;
  // The parser's own message quotes the input; say only that it was not JSON.
  if (err instanceof SyntaxError && status === 400) return res.status(400).json({ error: 'Invalid JSON' });
  if (status >= 500) console.error(`[api] ${req.method} ${req.originalUrl}:`, err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message || 'Bad request' });
});

const webDist = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist, {
    // The service worker is re-checked on every launch, so a new build reaches installed copies.
    setHeaders: (res, file) => { if (path.basename(file) === 'sw.js') res.setHeader('Cache-Control', 'no-cache'); },
  }));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}


export { app };
