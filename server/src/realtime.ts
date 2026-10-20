import type http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { db } from './db.js';
import { originAllowed, readCookie, SESSION_COOKIE } from './auth.js';
import { findUserById, hashOf, onSessionsRevoked, sessionUser } from './authStore.js';
import { publicUrl } from './oauth.js';
import { MAX_LABEL, MissLimiter, Rooms, type Who } from './convoy.js';
import { findRestStop, restStopLabel } from './sources/restStops.js';
import { cruiseAccess } from './cruise.js';
import { parseClientMessage, type ClientMessage } from './wsMessages.js';

/**
 * The one WebSocket endpoint, `/ws`: convoy rooms and the chat room's live
 * delivery. Everything the REST routes decide about who someone is still
 * holds here, because the socket is opened with the same session cookie and
 * checked again on a timer, and ended the moment a session is.
 *
 * Positions are relayed from memory to memory. They are not stored, and not
 * logged: nothing in this file writes one anywhere but another socket.
 */

export const WS_PATH = '/ws';
/** A few KB: the biggest honest message is a 80-character label. */
export const MAX_MESSAGE_BYTES = 4096;
const MAX_SOCKETS_PER_USER = 5;
const MAX_SOCKETS = 2000;
/** Ten messages at once, then five a second. */
const BUCKET = 10;
const REFILL_PER_SECOND = 5;
/** More messages than this refused inside ten seconds and the socket is closed on the sender. */
const FLOOD_DROPS = 50;

/** Close codes in the private range, so a client can tell why it was dropped and not retry in vain. */
export const CLOSE_SESSION_ENDED = 4401;
export const CLOSE_FLOODING = 1008;

interface Conn {
  ws: WebSocket;
  userId: string;
  token: string;
  tokenHash: string;
  alive: boolean;
  tokens: number;
  refilledAt: number;
  drops: number;
  dropsSince: number;
  chat: boolean;
}

export interface RealtimeOptions {
  heartbeatMs?: number;
  sweepMs?: number;
  rooms?: Rooms;
}

const conns = new Set<Conn>();
const byUser = new Map<string, Set<Conn>>();
let rooms = new Rooms();
const misses = new MissLimiter();

const send = (conn: Conn, message: unknown): void => {
  // A stalled phone must not accumulate an unbounded queue of positions or chat.
  if (conn.ws.bufferedAmount > 256 * 1024) { conn.ws.terminate(); return; }
  if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(message));
};
const sendUser = (userId: string, message: unknown): void => {
  for (const conn of byUser.get(userId) ?? []) send(conn, message);
};

function broadcastOpenCruise(message: unknown, excludeUserId?: string): void {
  for (const u of rooms.getOpenCruiseUsers()) {
    if (excludeUserId && u.id === excludeUserId) continue;
    sendUser(u.id, message);
  }
}

/** The room as every member should now see it. */
function announce(code: string): void {
  const view = rooms.view(code);
  if (!view) return;
  for (const id of rooms.memberIds(code)) sendUser(id, { t: 'room', room: view });
  if (view.open) {
    broadcastOpenCruise({ t: 'open_cruise.convoys', convoys: rooms.openConvoys() });
  }
}

/** A sustained split queued by Rooms: look up one advisory stop and apply it only if it is still pending. */
function automaticRegroup(code: string): void {
  const room = rooms.view(code);
  if (!room?.route || room.resting) return;
  const reserved = rooms.reserveRestLookup(code, room.leader);
  if (!reserved.ok) { rooms.completeAutomaticRegroup(code, null); return; }
  const leader = room.members.find((member) => member.id === room.leader)?.position;
  const from: [number, number] = leader ? [leader.lng, leader.lat] : room.route.stops[0];
  void findRestStop(room.route.stops, from).then((stop) => {
    if (rooms.navigationVersion(code) !== reserved.value) return;
    const done = rooms.completeAutomaticRegroup(code, stop ? { lat: stop.lat, lng: stop.lng, label: `Regroup: ${restStopLabel(stop)}` } : null);
    if (done.ok && stop) announce(code);
  }).catch(() => { rooms.completeAutomaticRegroup(code, null); });
}

function reject(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function close(conn: Conn, code: number, reason: string): void {
  try { conn.ws.close(code, reason); } catch { conn.ws.terminate(); }
}

/** Stop one user's sockets and take them out of every convoy: for a ban or a deleted account. */
function evictUser(userId: string): void {
  for (const code of rooms.removeUser(userId)) announce(code);
  // A convoy they left by being banned: their own client hears it as the end of the session.
  for (const conn of [...(byUser.get(userId) ?? [])]) close(conn, CLOSE_SESSION_ENDED, 'Session ended');
  // Their chat lines are hidden from a read; tell the open chat windows to read again.
  chatFeed.refresh();
}

function whoIs(userId: string): Who | null {
  const u = findUserById(db, userId);
  return u && !u.banned ? { id: u.id, username: u.username, avatar: u.avatar } : null;
}

function handle(conn: Conn, m: ClientMessage): void {
  const reply = (message: unknown) => send(conn, message);
  const error = (text: string) => reply({ t: 'error', error: text, in: m.t });
  switch (m.t) {
    case 'ping':
      return reply({ t: 'pong' });
    case 'convoy.message': {
      const done = rooms.message(m.room, conn.userId, m.text, m.clientId);
      if (!done.ok) return error(done.error);
      for (const id of rooms.memberIds(m.room)) sendUser(id, { t: 'convoy.message', room: m.room, message: done.value });
      return;
    }
    case 'chat.sub':
      conn.chat = true;
      return reply({ t: 'chat.ready' });
    case 'chat.unsub':
      conn.chat = false;
      return;
    case 'open_cruise.toggle': {
      const who = whoIs(conn.userId);
      if (!who) return close(conn, CLOSE_SESSION_ENDED, 'Session ended');
      rooms.setOpenCruise(who, m.enabled);
      if (m.enabled) {
        send(conn, {
          t: 'open_cruise.state',
          enabled: true,
          users: rooms.getOpenCruiseUsers().filter((u) => u.id !== conn.userId),
          convoys: rooms.openConvoys(),
        });
        broadcastOpenCruise({ t: 'open_cruise.user_joined', user: rooms.getOpenCruiseUser(conn.userId)! }, conn.userId);
      } else {
        broadcastOpenCruise({ t: 'open_cruise.user_left', id: conn.userId }, conn.userId);
        send(conn, { t: 'open_cruise.state', enabled: false, users: [], convoys: [] });
      }
      return;
    }
    case 'open_convoy.invite': {
      const who = whoIs(conn.userId);
      if (!who) return close(conn, CLOSE_SESSION_ENDED, 'Session ended');
      const target = whoIs(m.targetUserId);
      if (!target || !rooms.isOpenCruise(target.id)) return error('Driver is not available for Open Convoy');
      const invite = rooms.createOpenConvoyInvite(who, m.targetUserId);
      if (!invite.ok) return error(invite.error);
      sendUser(m.targetUserId, { t: 'open_convoy.invited', from: who });
      return;
    }
    case 'open_convoy.accept': {
      const who = whoIs(conn.userId);
      if (!who) return close(conn, CLOSE_SESSION_ENDED, 'Session ended');
      const done = rooms.acceptOpenConvoyInvite(m.fromUserId, who);
      if (!done.ok) return error(done.error);
      announce(done.value.code);
      broadcastOpenCruise({ t: 'open_cruise.convoys', convoys: rooms.openConvoys() });
      return;
    }
    case 'open_convoy.decline': {
      rooms.declineOpenConvoyInvite(m.fromUserId, conn.userId);
      const who = whoIs(conn.userId);
      if (who) sendUser(m.fromUserId, { t: 'open_convoy.declined', from: who });
      return;
    }
    case 'open_convoy.join': {
      const who = whoIs(conn.userId);
      if (!who) return close(conn, CLOSE_SESSION_ENDED, 'Session ended');
      const done = rooms.joinOpenConvoy(m.code, who);
      if (!done.ok) return error(done.error);
      announce(done.value.code);
      broadcastOpenCruise({ t: 'open_cruise.convoys', convoys: rooms.openConvoys() });
      return;
    }
    case 'pos.stop':
      for (const code of rooms.clearPosition(conn.userId)) announce(code);
      if (rooms.isOpenCruise(conn.userId)) {
        broadcastOpenCruise({ t: 'open_cruise.pos_stop', id: conn.userId }, conn.userId);
      }
      return;
    case 'pos': {
      const out = rooms.position(conn.userId, { lat: m.lat, lng: m.lng, heading: m.heading, speed: m.speed });
      if (!out) return; // not in a room and not open cruise, or throttled
      for (const code of out.codes) {
        const packet = { t: 'pos', room: code, id: conn.userId, ...out.position };
        for (const id of rooms.memberIds(code)) if (id !== conn.userId) sendUser(id, packet);
      }
      if (out.openCruise) {
        const user = rooms.getOpenCruiseUser(conn.userId);
        if (user) {
          broadcastOpenCruise({ t: 'open_cruise.pos', user }, conn.userId);
        }
        if (out.codes.some((code) => rooms.view(code)?.open)) {
          broadcastOpenCruise({ t: 'open_cruise.convoys', convoys: rooms.openConvoys() });
        }
      }
      for (const code of out.memberStatusChangedCodes) announce(code);
      for (const code of out.automaticRegroupCodes) automaticRegroup(code);
      return;
    }
    case 'convoy.leave': {
      if (!rooms.roomsOf(conn.userId).includes(m.room)) return error('You are not in that convoy');
      const wasOpen = rooms.view(m.room)?.open;
      rooms.leave(m.room, conn.userId);
      sendUser(conn.userId, { t: 'left', room: m.room });
      announce(m.room);
      if (wasOpen) {
        broadcastOpenCruise({ t: 'open_cruise.convoys', convoys: rooms.openConvoys() });
      }
      return;
    }
    case 'convoy.remove': {
      const wasOpen = rooms.view(m.room)?.open;
      const done = rooms.remove(m.room, conn.userId, m.id);
      if (!done.ok) return error(done.error);
      sendUser(m.id, { t: 'left', room: m.room, removed: true });
      announce(m.room);
      if (wasOpen) {
        broadcastOpenCruise({ t: 'open_cruise.convoys', convoys: rooms.openConvoys() });
      }
      return;
    }
    case 'convoy.open': {
      const wasOpen = rooms.view(m.room)?.open;
      const done = rooms.setOpen(m.room, conn.userId, m.open);
      if (!done.ok) return error(done.error);
      announce(m.room);
      if (wasOpen || m.open) {
        broadcastOpenCruise({ t: 'open_cruise.convoys', convoys: rooms.openConvoys() });
      }
      return;
    }
    case 'convoy.dest':
    case 'convoy.route':
    case 'convoy.lead':
    case 'convoy.mode': {
      const done = m.t === 'convoy.dest'
        ? rooms.setDestination(m.room, conn.userId, m.destination)
        : m.t === 'convoy.route'
          ? rooms.setRoute(m.room, conn.userId, m.route)
          : m.t === 'convoy.mode'
            ? rooms.setCruising(m.room, conn.userId, m.cruising)
            : rooms.handOver(m.room, conn.userId, m.to);
      return done.ok ? announce(m.room) : error(done.error);
    }
    case 'convoy.rest': {
      const room = rooms.view(m.room);
      if (!room || !room.members.some((member) => member.id === conn.userId)) return error('You are not in that convoy');
      if (m.action === 'continue') {
        if (room.leader !== conn.userId) return error('Only the leader can continue to the destination');
        const done = rooms.continueDestination(m.room, conn.userId);
        return done.ok ? announce(m.room) : error(done.error);
      }
      if (!room.route) return error('Set a convoy route before finding a rest stop');
      const reserved = rooms.reserveRestLookup(m.room, conn.userId);
      if (!reserved.ok) return error(reserved.error);
      const leader = room.members.find((member) => member.id === room.leader)?.position;
      const from: [number, number] = leader ? [leader.lng, leader.lat] : room.route.stops[0];
      void findRestStop(room.route.stops, from).then((stop) => {
        if (!sessionUser(db, conn.token)) return;
        if (rooms.navigationVersion(m.room) !== reserved.value) return error('The convoy route or destination changed. Search again.');
        if (!stop) return error('No suitable rest stop was found close to the remaining route');
        const done = rooms.setRestStop(m.room, conn.userId, { lat: stop.lat, lng: stop.lng, label: restStopLabel(stop) });
        if (done.ok) announce(m.room); else error(done.error);
      }).catch(() => error('Could not look up rest stops right now'));
      return;
    }
    case 'convoy.create':
    case 'convoy.join':
    case 'convoy.cruise': {
      const who = whoIs(conn.userId);
      if (!who) return close(conn, CLOSE_SESSION_ENDED, 'Session ended');
      let done;
      if (m.t === 'convoy.create') {
        done = rooms.create(who, { name: m.name, automaticRegroup: m.automaticRegroup, open: m.open });
      } else if (m.t === 'convoy.join') {
        if (misses.blocked(conn.userId)) return error('Too many wrong codes. Try again in a few minutes.');
        done = rooms.join(m.code, who);
        if (!done.ok && done.error.startsWith('No convoy')) misses.miss(conn.userId);
      } else {
        const access = cruiseAccess(db, m.eventId, conn.userId);
        if (!access.ok) return error(access.error);
        const code = rooms.forEvent(m.eventId);
        if (code) done = rooms.join(code, who);
        else if (!access.isOwner) return error('The organiser has not started this convoy yet');
        else done = rooms.create(who, {
          name: access.title,
          eventId: m.eventId,
          destination: { lat: access.meet.lat, lng: access.meet.lng, label: (access.meet.note || 'Meeting point').slice(0, MAX_LABEL) },
          route: access.route,
        });
      }
      if (!done.ok) return error(done.error);
      announce(done.value.code);
      return;
    }
  }
}

/** A token bucket per socket. Returns whether this message may be acted on. */
function allowed(conn: Conn, now: number): boolean {
  conn.tokens = Math.min(BUCKET, conn.tokens + ((now - conn.refilledAt) / 1000) * REFILL_PER_SECOND);
  conn.refilledAt = now;
  if (conn.tokens >= 1) { conn.tokens -= 1; return true; }
  if (now - conn.dropsSince > 10_000) { conn.dropsSince = now; conn.drops = 0; }
  if (++conn.drops > FLOOD_DROPS) close(conn, CLOSE_FLOODING, 'Slow down');
  return false;
}

/**
 * Attach the WebSocket endpoint to an HTTP server. Returns a function that
 * closes every socket and stops the timers (for tests and a clean shutdown).
 */
export function attachRealtime(server: http.Server, opts: RealtimeOptions = {}): () => void {
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  rooms = opts.rooms ?? new Rooms();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });

  server.on('upgrade', onUpgrade);
  function onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => socket.destroy());
    if (new URL(req.url ?? '/', 'http://x').pathname !== WS_PATH) return void socket.destroy();
    // A browser always says where the page came from. `ws://` is not covered by CORS, so this is the only thing
    // that stops another site's page opening a socket with the visitor's cookie. Same rule as a POST.
    if (!originAllowed('POST', req.headers.origin, publicUrl())) return reject(socket, 403, 'Forbidden');
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    const user = sessionUser(db, token);
    if (!user || !token) return reject(socket, 401, 'Unauthorized');
    if (conns.size >= MAX_SOCKETS || (byUser.get(user.id)?.size ?? 0) >= MAX_SOCKETS_PER_USER) return reject(socket, 429, 'Too Many Requests');
    wss.handleUpgrade(req, socket, head, (ws) => open(ws, user.id, token));
  }

  function open(ws: WebSocket, userId: string, token: string): void {
    const now = Date.now();
    const conn: Conn = { ws, userId, token, tokenHash: hashOf(token), alive: true, tokens: BUCKET, refilledAt: now, drops: 0, dropsSince: now, chat: false };
    conns.add(conn);
    let mine = byUser.get(userId);
    if (!mine) byUser.set(userId, (mine = new Set()));
    mine.add(conn);

    ws.on('pong', () => { conn.alive = true; });
    ws.on('message', (data, isBinary) => {
      if (!sessionUser(db, conn.token)) return close(conn, CLOSE_SESSION_ENDED, 'Session ended');
      conn.alive = true;
      if (isBinary) return close(conn, 1003, 'Text only');
      if (!allowed(conn, Date.now())) return;
      const parsed = parseClientMessage((data as Buffer).toString('utf8'));
      if (!parsed.ok) return send(conn, { t: 'error', error: parsed.error });
      try { handle(conn, parsed.message); } catch (err) { console.error('[ws] handler failed:', (err as Error).message); }
    });
    ws.on('error', () => ws.terminate());
    ws.on('close', () => {
      conns.delete(conn);
      mine!.delete(conn);
      if (mine!.size === 0) {
        byUser.delete(userId);
        for (const code of rooms.setOnline(userId, false)) announce(code);
        if (rooms.isOpenCruise(userId)) {
          rooms.setOpenCruise({ id: userId, username: '', avatar: '' }, false);
          broadcastOpenCruise({ t: 'open_cruise.user_left', id: userId });
        }
      }
    });

    // Tell them who they are and which convoys they are still in, so a reconnect picks up where it left off,
    // and then tell the rest of those convoys they are back.
    const back = rooms.setOnline(userId, true);
    send(conn, { t: 'hello', me: userId, rooms: rooms.roomsOf(userId).map((c) => rooms.view(c)) });
    for (const code of back) announce(code);
  }

  const unhook = onSessionsRevoked((what) => {
    if ('userId' in what) return evictUser(what.userId);
    for (const conn of [...conns]) if (conn.tokenHash === what.session) close(conn, CLOSE_SESSION_ENDED, 'Session ended');
  });

  // Ping everyone; whoever did not answer the last one is gone. The same pass looks again at each session, which
  // is what ends a socket whose session simply ran out.
  const beat = setInterval(() => {
    for (const conn of [...conns]) {
      if (!sessionUser(db, conn.token)) { close(conn, CLOSE_SESSION_ENDED, 'Session ended'); continue; }
      if (!conn.alive) { conn.ws.terminate(); continue; }
      conn.alive = false;
      try { conn.ws.ping(); } catch { conn.ws.terminate(); }
    }
  }, heartbeatMs);
  const sweepTimer = setInterval(() => {
    const { changed } = rooms.sweep();
    for (const code of changed) announce(code);
    misses.sweep();
    broadcastOpenCruise({ t: 'open_cruise.convoys', convoys: rooms.openConvoys() });
  }, opts.sweepMs ?? 30_000);
  beat.unref();
  sweepTimer.unref();

  return () => {
    clearInterval(beat);
    clearInterval(sweepTimer);
    unhook();
    server.off('upgrade', onUpgrade);
    for (const conn of [...conns]) conn.ws.terminate();
    wss.close();
  };
}

/**
 * Live delivery for the chat room. The REST routes in app.ts write the row and
 * then call these; a socket that never subscribed hears nothing, and a client
 * that cannot connect carries on polling.
 */
export const chatFeed = {
  /** A line was posted. `message` is the same JSON the REST list returns. */
  posted(message: unknown): void {
    for (const conn of conns) if (conn.chat) send(conn, { t: 'chat', message });
  },
  /** A line was deleted, by its author or by staff. */
  removed(id: string): void {
    for (const conn of conns) if (conn.chat) send(conn, { t: 'chat.gone', id });
  },
  /** Something changed that a client cannot work out for itself, such as an author being suspended. */
  refresh(): void {
    for (const conn of conns) if (conn.chat) send(conn, { t: 'chat.refresh' });
  },
};
