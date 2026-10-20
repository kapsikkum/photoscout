import crypto from 'node:crypto';

/**
 * Who may do what, kept pure so it can be tested without a database.
 *
 * There are no passwords here. An account is whoever a sign-in provider says
 * it is (see oauth.ts), and a session is a random value in a cookie whose
 * hash is a row in the database (see authStore.ts).
 */

/**
 * `__Host-` makes the browser refuse the cookie unless it is Secure, has no
 * Domain and has Path=/ — so a sibling subdomain cannot set or shadow it.
 */
export const SESSION_COOKIE = '__Host-ps_session';
/** State and PKCE verifier for a sign-in that is under way. Ten minutes. */
export const OAUTH_COOKIE = '__Host-ps_oauth';

export type Role = 'admin' | 'moderator' | 'contributor';
export type Visibility = 'private' | 'unlisted' | 'public';

export interface SessionUser {
  id: string;
  role: Role;
}

/**
 * Open in every mode, private or public. Signing in and out cannot themselves
 * require a session, and a share or calendar token is its own credential.
 */
const OPEN_ROUTES = [
  /^\/api\/auth\/status$/,
  /^\/api\/auth\/logout$/,
  /^\/api\/auth\/[a-z]+\/(start|callback)$/,
  /^\/api\/version$/,
  // A share token is itself the credential; `/api/shares` (plural, managing
  // your own links) is a different, protected route.
  /^\/api\/share\//,
  // A calendar link is secret like a share token: whoever holds the token is the subscriber.
  /^\/api\/calendar\/[^/]+$/,
];

/**
 * What a visitor who has not signed in may read when the instance allows
 * public reads (see access.ts; off by default, so a private instance ignores
 * this list): the public map and nothing that costs anything. Each of these
 * filters its rows through `canRead`, so an anonymous request sees public rows
 * only. Everything that proxies a third-party service is left off on purpose —
 * an open proxy is an invitation.
 */
const ANONYMOUS_READS = [
  /^\/api\/(places|spots|routes)(\/[^/]+)?$/,
  /^\/api\/spots\/[^/]+\/photos$/,
  /^\/api\/routes\/[^/]+\/photos$/,
  /^\/api\/photos\/[^/]+\/(file|thumb)$/,
  /^\/api\/route-photos\/[^/]+\/(file|thumb)$/,
  // Where the map opens. A visitor gets the same cut-down answer a member does.
  /^\/api\/settings$/,
  // Map layers with no parameters, answered from this server's own cache:
  // a visitor asking costs nobody upstream anything.
  /^\/api\/(rail|fires|aurora)$/,
  // Events, from a list this server keeps for a minute (see events.ts), so
  // asking costs event-scout nothing more however many visitors there are.
  /^\/api\/events(\/[^/]+)?$/,
  // Who is going to an event: the counts are public, as the list is.
  /^\/api\/events\/[^/]+\/rsvp$/,
  /^\/api\/community-events\/[^/]+\/rsvp$/,
  // A stored flyer; the route checks that its event is still on show.
  /^\/api\/flyer\/[^/]+\/[^/]+$/,
  // A profile by handle, the public community events, and the pictures of a
  // ride. The profile search (`/api/profiles` with no handle) is not here.
  /^\/api\/profiles\/[^/]+$/,
  /^\/api\/community-events(\/[^/]+)?$/,
  /^\/api\/kit\/photos\/[^/]+\/(file|thumb)$/,
  // The feed (scope=following is refused to a visitor by the handler: the query is not seen here) and a post's comments.
  /^\/api\/feed$/,
  /^\/api\/posts\/[^/]+\/comments$/,
  // The web bundles of the active plugins: the map loads them before anyone signs in.
  /^\/api\/plugins-web$/,
];

/**
 * A plugin's own route, /api/plugins/<id>/<rest>. Whether a visitor may read it
 * is for the plugin to declare (`public` in its plugin.json), not for this list.
 */
const PLUGIN_ROUTE = /^\/api\/plugins\/([^/]+)(\/.*)?$/;

export function normalizePath(p: string): string {
  const withoutQuery = p.split('?')[0].toLowerCase();
  const trimmed = withoutQuery.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * Whether a request needs a signed-in session at all.
 *
 * `publicReads` is the instance's access mode (see access.ts). Anything but
 * exactly `true`, which includes leaving it out, makes the instance private:
 * everything but OPEN_ROUTES needs a session, plugin routes and reads included.
 * With `true`, a visitor may also read ANONYMOUS_READS, and the plugin routes a
 * running plugin has declared public. `pluginRoutePublic` says whether it has;
 * without it, every plugin route needs a session.
 */
export function needsAuth(
  method: string,
  path: string,
  pluginRoutePublic: (id: string, method: string, rest: string) => boolean = () => false,
  publicReads = false,
): boolean {
  const normalized = normalizePath(path);
  if (OPEN_ROUTES.some((re) => re.test(normalized))) return false;
  if (publicReads !== true) return true;
  const plugin = PLUGIN_ROUTE.exec(normalized);
  if (plugin) return !pluginRoutePublic(plugin[1], method, plugin[2] ?? '/');
  if (method === 'GET' || method === 'HEAD') return !ANONYMOUS_READS.some((re) => re.test(normalized));
  return true;
}

/**
 * Whether a state-changing request came from this site's own pages.
 *
 * SameSite=Lax on the session cookie already keeps it off cross-site POSTs;
 * this is the second lock. A browser sends Origin on every cross-origin
 * request that can change anything, so one that is present and is not ours is
 * refused. A request with no Origin at all is not a browser's cross-site
 * request and carries no ambient cookie worth protecting.
 */
export function originAllowed(method: string, origin: string | undefined, ownOrigin: string): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  if (!origin) return true;
  return origin === ownOrigin;
}

/**
 * Whether `user` may read a row with this visibility and owner.
 *
 * `unlisted` is deliberately as open as `public` here: an unlisted row is
 * reachable by anyone holding its id, and never appears in a list. Excluding
 * it from lists is a separate filter (see `listWhere` in app.ts) — this
 * function only answers "can this one row be read".
 */
export function canRead(visibility: Visibility, ownerId: string, user: SessionUser | null): boolean {
  if (visibility === 'public' || visibility === 'unlisted') return true;
  if (!user) return false;
  return user.role === 'admin' || user.id === ownerId;
}

/** Contributors edit only their own rows; the admin edits everything. */
export function canEdit(ownerId: string, user: SessionUser | null): boolean {
  if (!user) return false;
  return user.role === 'admin' || user.id === ownerId;
}

/** Admins and moderators: those who may read the reports queue, hide content and suspend contributors. Nothing else is shared. */
export function isStaff(user: { role: Role } | null | undefined): boolean {
  return user?.role === 'admin' || user?.role === 'moderator';
}

/** Compare without leaking how far the comparison got. */
export function secureEqual(a: string, b: string): boolean {
  const ah = crypto.createHash('sha256').update(a, 'utf8').digest();
  const bh = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ah, bh);
}

/** Pull one cookie out of a Cookie header, without a parser dependency. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export const SESSION_DAYS = 30;

/** Three to twenty-four letters, digits or underscores: safe in a URL and in a mention. */
export const HANDLE = /^[A-Za-z0-9_]{3,24}$/;

/**
 * A handle to start a new account with, from whatever the provider calls them.
 * `taken` is asked until a free one turns up; the suffix is random rather than
 * counted so one account's handle says nothing about how many came before.
 */
export function handleFrom(name: string, taken: (handle: string) => boolean, random = () => crypto.randomInt(1000, 10000)): string {
  const base = name.normalize('NFKD').replace(/[^A-Za-z0-9_]/g, '').slice(0, 19);
  const stem = base.length >= 3 ? base : 'driver';
  if (base.length >= 3 && !taken(stem)) return stem;
  for (;;) {
    const candidate = `${stem}_${random()}`;
    if (!taken(candidate)) return candidate;
  }
}

/** The request and reply, as far as the gates below need them. Structural, so this file stays free of express. */
interface GatedRequest {
  user?: SessionUser | null;
}
interface Reply {
  status(code: number): { json(body: unknown): unknown };
}

/** Answer 401 and return false unless a session is signed in. The `/api` gate in app.ts applies the same rule to routes it can see. */
export function requireUser(req: GatedRequest, res: Reply): boolean {
  if (req.user) return true;
  res.status(401).json({ error: 'Sign in required' });
  return false;
}

/** Answer 403 and return false unless the signed-in account is an admin. */
export function requireAdmin(req: GatedRequest, res: Reply): boolean {
  if (req.user?.role === 'admin') return true;
  res.status(403).json({ error: 'Admins only' });
  return false;
}

/** `ADMIN_IDS=google:1234,discord:5678` — the accounts that are admins, by who the provider says they are. */
export function isAdminAccount(provider: string, providerId: string, adminIds: string | undefined): boolean {
  if (!provider || !providerId) return false;
  return (adminIds ?? '').split(',').map((s) => s.trim()).filter(Boolean).includes(`${provider}:${providerId}`);
}
