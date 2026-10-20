import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Where everything this app keeps on disk lives: database, photos, both. */
export const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(__dirname, '../../data');
fs.mkdirSync(dataDir, { recursive: true });
export const photosDir = path.join(dataDir, 'photos');
fs.mkdirSync(photosDir, { recursive: true });

const SCHEMA = `
-- No passwords: an account is whoever a sign-in provider says it is.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'contributor',
  banned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (provider, provider_id)
);

-- Kept here rather than signed into the cookie, so signing out, a ban or a
-- change of role takes effect on the next request. The id is the SHA-256 of
-- the cookie's value: a copy of this table signs nobody in.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- What one person has starred or hidden among the events event-scout lists,
-- by the group key it gives them. No foreign key to the events: they live in
-- another service, and a key that has gone from its list is harmless here.
CREATE TABLE IF NOT EXISTS user_event_state (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_group TEXT NOT NULL,
  starred INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, event_group)
);

-- The Kit: what a person drives and what they shoot with. Each row is its
-- owner's; deleting the account takes them all (authStore.deleteUser also
-- removes the photo files, which a foreign key cannot).
CREATE TABLE IF NOT EXISTS rides (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  year INTEGER,
  nickname TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rides_owner ON rides(owner_id);

CREATE TABLE IF NOT EXISTS ride_photos (
  id TEXT PRIMARY KEY,
  ride_id TEXT NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  file TEXT NOT NULL,
  thumb TEXT NOT NULL,
  w INTEGER NOT NULL DEFAULT 0,
  h INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ride_photos_ride ON ride_photos(ride_id);
CREATE INDEX IF NOT EXISTS idx_ride_photos_owner ON ride_photos(owner_id, created_at);

CREATE TABLE IF NOT EXISTS gear (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  brand TEXT NOT NULL,
  name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gear_owner ON gear(owner_id);

CREATE TABLE IF NOT EXISTS follows (
  follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);

-- Events people make themselves, kept apart from the scraped feed that
-- events.ts serves: different owner, different rules, never mixed in storage.
CREATE TABLE IF NOT EXISTS community_events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  start_time TEXT NOT NULL,
  end_time TEXT,
  venue_name TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  price_text TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'public',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_community_events_owner ON community_events(owner_id);
CREATE INDEX IF NOT EXISTS idx_community_events_start ON community_events(start_time);

CREATE TABLE IF NOT EXISTS community_rsvps (
  event_id TEXT NOT NULL REFERENCES community_events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_community_rsvps_user ON community_rsvps(user_id);

-- Going or interested in a crawled event, by the group key user_event_state
-- uses. No foreign key to the event: it lives in another service.
CREATE TABLE IF NOT EXISTS event_rsvps (
  event_group TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('going','interested')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_group, user_id)
);
CREATE INDEX IF NOT EXISTS idx_event_rsvps_user ON event_rsvps(user_id);

-- One person asking another to an event, crawled or community. The event is
-- named by kind and key, with no foreign key, so an invite can outlive it.
CREATE TABLE IF NOT EXISTS event_invites (
  id TEXT PRIMARY KEY,
  event_kind TEXT NOT NULL CHECK(event_kind IN ('event','community')),
  event_ref TEXT NOT NULL,
  from_user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','dismissed')),
  UNIQUE(event_kind, event_ref, from_user, to_user)
);
CREATE INDEX IF NOT EXISTS idx_event_invites_to ON event_invites(to_user, status);
CREATE INDEX IF NOT EXISTS idx_event_invites_from ON event_invites(from_user, created_at);

-- The feed, chat and reports. No foreign keys: authStore.deleteUser and the
-- routes that delete a ride, gear or event clear their rows by hand, so a
-- post can outlive nothing it should not.
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL, -- checkin | ride | gear | rsvp | event
  ref_id TEXT NOT NULL DEFAULT '',
  lat REAL,
  lng REAL,
  place_name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
CREATE INDEX IF NOT EXISTS idx_posts_owner ON posts(owner_id, created_at);
CREATE INDEX IF NOT EXISTS idx_posts_ref ON posts(kind, ref_id);

CREATE TABLE IF NOT EXISTS post_votes (
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS post_comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  body TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_post_comments_post ON post_comments(post_id, created_at);
CREATE INDEX IF NOT EXISTS idx_post_comments_owner ON post_comments(owner_id, created_at);

-- One public room whose messages live thirty minutes (see the housekeeping task).
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_created ON chat_messages(created_at);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_open ON reports(resolved_at, created_at);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_kind, target_id);

-- A spot somebody suggested for the public map. Nothing here is on the map
-- until a moderator approves it, which makes a public spot of it.
CREATE TABLE IF NOT EXISTS spot_suggestions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  outcome TEXT,
  spot_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_suggestions_open ON spot_suggestions(resolved_at, created_at);
CREATE INDEX IF NOT EXISTS idx_suggestions_user ON spot_suggestions(user_id, created_at);

-- The secret in a calendar subscription link. Only its SHA-256 is kept, so a
-- copy of this table subscribes nobody; one row per person, replaced when
-- they make a new link.
CREATE TABLE IF NOT EXISTS calendar_tokens (
  user_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS places (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  access TEXT NOT NULL DEFAULT '',
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  geom TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_places_owner ON places(owner_id);
CREATE INDEX IF NOT EXISTS idx_places_source ON places(source, source_ref);

CREATE TABLE IF NOT EXISTS spots (
  id TEXT PRIMARY KEY,
  place_id TEXT,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  facing_deg REAL,
  fov_deg REAL,
  good_times TEXT NOT NULL DEFAULT '{}',
  visibility TEXT NOT NULL DEFAULT 'private',
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spots_owner ON spots(owner_id);
CREATE INDEX IF NOT EXISTS idx_spots_place ON spots(place_id);
CREATE INDEX IF NOT EXISTS idx_spots_latlng ON spots(lat, lng);
CREATE INDEX IF NOT EXISTS idx_spots_source ON spots(source, source_ref);

CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  spot_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'taken_here',
  file TEXT NOT NULL,
  thumb TEXT NOT NULL,
  w INTEGER NOT NULL DEFAULT 0,
  h INTEGER NOT NULL DEFAULT 0,
  taken_at TEXT,
  caption TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  focal_length REAL,
  date_time_original TEXT
);
CREATE INDEX IF NOT EXISTS idx_photos_spot ON photos(spot_id);

CREATE TABLE IF NOT EXISTS route_photos (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  file TEXT NOT NULL,
  thumb TEXT NOT NULL,
  w INTEGER NOT NULL DEFAULT 0,
  h INTEGER NOT NULL DEFAULT 0,
  taken_at TEXT,
  caption TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_route_photos_route ON route_photos(route_id);

CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  ref TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  tags TEXT NOT NULL DEFAULT '{}',
  fetched_at TEXT NOT NULL,
  UNIQUE(source, ref)
);

CREATE TABLE IF NOT EXISTS shares (
  token TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  filter TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS remotes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  url TEXT NOT NULL,
  last_sync TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sightings (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT '',
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  line_ref TEXT NOT NULL DEFAULT '',
  seen_at TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'private',
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sightings_source ON sightings(source, source_ref);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS routes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  access TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'sprint',
  vertices TEXT NOT NULL DEFAULT '[]',
  waypoints TEXT,
  snap INTEGER NOT NULL DEFAULT 0,
  staging TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_routes_owner ON routes(owner_id);

-- GTFS static data for trains, filtered at import time to trips touching a
-- configured area. One feed's rows share the 'feed' column ('nswtrains' | 'sydneytrains').
CREATE TABLE IF NOT EXISTS gtfs_routes (
  feed TEXT NOT NULL,
  route_id TEXT NOT NULL,
  short_name TEXT NOT NULL DEFAULT '',
  long_name TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (feed, route_id)
);
CREATE TABLE IF NOT EXISTS gtfs_trips (
  feed TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  shape_id TEXT NOT NULL DEFAULT '',
  headsign TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (feed, trip_id)
);
CREATE TABLE IF NOT EXISTS gtfs_stops (
  feed TEXT NOT NULL,
  stop_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  PRIMARY KEY (feed, stop_id)
);
CREATE TABLE IF NOT EXISTS gtfs_stop_times (
  feed TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  stop_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  arrival_sec INTEGER NOT NULL,
  departure_sec INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gtfs_stop_times_trip ON gtfs_stop_times(feed, trip_id, seq);
CREATE TABLE IF NOT EXISTS gtfs_shapes (
  feed TEXT NOT NULL,
  shape_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gtfs_shapes ON gtfs_shapes(feed, shape_id, seq);
CREATE TABLE IF NOT EXISTS gtfs_calendar (
  feed TEXT NOT NULL,
  service_id TEXT NOT NULL,
  days TEXT NOT NULL, -- 7 chars '0'/'1', Monday first, as GTFS calendar.txt orders them
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  PRIMARY KEY (feed, service_id)
);
`;

export interface Db {
  handle: DatabaseSync;
  getKv(key: string): string | null;
  setKv(key: string, value: string, expiresAt?: string | null): void;
}

/**
 * Open (and migrate) a database at `filePath`, or the app's own data dir by
 * default. A path param — `:memory:` in particular — is what lets tests run
 * against a throwaway database instead of the real one.
 */
/** For a column added after a table already shipped: `CREATE TABLE IF NOT EXISTS` alone won't add it to an existing db. */
function addColumnIfMissing(handle: DatabaseSync, table: string, column: string, columnDef: string): void {
  const cols = handle.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  try {
    handle.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  } catch (err) {
    // Another process opening the same file (parallel test runs, a second instance) can add it between the check and here.
    if (!/duplicate column name/i.test((err as Error).message)) throw err;
  }
}

export function createDb(filePath: string = path.join(dataDir, 'photoscout.db')): Db {
  const handle = new DatabaseSync(filePath, { timeout: 5000 });
  if (filePath !== ':memory:') handle.exec('PRAGMA journal_mode = WAL');
  handle.exec(SCHEMA);
  addColumnIfMissing(handle, 'users', 'bio', "bio TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(handle, 'users', 'instagram', "instagram TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(handle, 'community_events', 'hidden', 'hidden INTEGER NOT NULL DEFAULT 0');
  // A cruise: the route, meeting point and roll-out time of an event, as one JSON document (see cruise.ts).
  addColumnIfMissing(handle, 'community_events', 'cruise', 'cruise TEXT');
  addColumnIfMissing(handle, 'sightings', 'loaded', 'loaded INTEGER');
  addColumnIfMissing(handle, 'photos', 'focal_length', 'focal_length REAL');
  addColumnIfMissing(handle, 'photos', 'date_time_original', 'date_time_original TEXT');
  addColumnIfMissing(handle, 'routes', 'waypoints', 'waypoints TEXT');
  addColumnIfMissing(handle, 'routes', 'snap', 'snap INTEGER NOT NULL DEFAULT 0');

  function getKv(key: string): string | null {
    const row = handle.prepare('SELECT value, expires_at FROM kv WHERE key = ?').get(key) as
      { value: string; expires_at: string | null } | undefined;
    if (!row) return null;
    if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return null;
    return row.value;
  }

  function setKv(key: string, value: string, expiresAt: string | null = null): void {
    handle
      .prepare('INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at')
      .run(key, value, expiresAt);
  }

  return { handle, getKv, setKv };
}

/** The app's own database. Tests use `createDb(':memory:')` instead. */
export const db = createDb();
