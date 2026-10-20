import crypto from 'node:crypto';
import { haversine } from './geo.js';

/**
 * Convoy rooms: who is driving together, where they are and where they are going.
 *
 * Pure bookkeeping, with no sockets in it (see realtime.ts for those), so the
 * rules can be tested with a clock in the test's hand. A position is only ever
 * held here as the member's latest and is dropped when they leave or their
 * last connection does; nothing in this file touches the database or a log.
 *
 * ponytail: in-memory rooms, single process; move to a shared store if this ever runs as more than one instance.
 */

export const MAX_MEMBERS = 30;
export const MAX_ROOMS_PER_USER = 3;
/** A ceiling on the whole process, so rooms made in bulk cannot eat its memory. */
export const MAX_ROOMS = 1000;
/** A room nobody is connected to is gone after this long. */
export const ROOM_IDLE_MS = 30 * 60_000;
/** A member who has dropped off stays on the list (greyed out) this long, then goes. */
export const MEMBER_GRACE_MS = 30 * 60_000;
/** One position a second per member; a little under, so a phone's 1 Hz timer is never caught out by jitter. */
export const POSITION_GAP_MS = 900;
/** How many people a leader can have removed from one room, so the list stays small. */
export const MAX_REMOVED = 100;
export const MAX_NAME = 40;
export const MAX_LABEL = 80;
export const DEFAULT_REGROUP_SEPARATION_M = 5_000;
export const MIN_REGROUP_SEPARATION_M = 1_000;
export const MAX_REGROUP_SEPARATION_M = 20_000;
/** A wide reading must persist this long before GPS lag can trigger a regroup. */
export const AUTO_REGROUP_DELAY_MS = 90_000;
/** Do not decide a group is split from a stale phone location. */
export const AUTO_REGROUP_FRESH_MS = 35_000;

/** No 0/O, 1/I/L: a code is read aloud and typed on a phone. 31^8 is about 8.5e11. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;
export const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

export function newCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

/** What a client may type for a code: case and spaces forgiven. */
export const normalizeCode = (raw: string): string => raw.replace(/[\s-]/g, '').toUpperCase();

export interface Who { id: string; username: string; avatar: string }
export interface Position { lat: number; lng: number; heading: number | null; speed: number | null; ts: number }
export interface Destination { lat: number; lng: number; label: string }
/** A shared driving itinerary. A circuit includes its first stop again at the end. */
export interface ConvoyRoute { name: string; stops: [number, number][] }
export const MAX_CONVOY_ROUTE_STOPS = 25;
export interface AutomaticRegroup { enabled: boolean; separationM: number }
export interface ConvoyMessage { id: string; clientId: string; userId: string; username: string; text: string; ts: number }
export const MAX_CONVOY_MESSAGES = 50;
export const CONVOY_MESSAGE_TTL_MS = 30 * 60_000;
export const MAX_CONVOY_MESSAGE_LENGTH = 500;
export const CONVOY_CHAT_GAP_MS = 2_000;

interface Member extends Who {
  online: boolean;
  /** Last time they were connected or sent a position. */
  lastSeen: number;
  lastPositionAt: number;
  position: Position | null;
  joinedAt: number;
  lastMessageAt?: number;
}

interface Room {
  code: string;
  name: string;
  /** The community event this room is the convoy of, when it is a cruise's. */
  eventId: string | null;
  leader: string;
  destination: Destination | null;
  /** The original destination while the convoy is temporarily paused at a rest stop. */
  resumeDestination: Destination | null;
  resting: boolean;
  /** A leader-controlled no-destination state; route guidance is deliberately cleared. */
  cruising: boolean;
  route: ConvoyRoute | null;
  automaticRegroup: AutomaticRegroup;
  separatedSince: number | null;
  regroupPending: boolean;
  messages: ConvoyMessage[];
  navigationVersion: number;
  lastRestLookupAt?: number;
  members: Map<string, Member>;
  /** People the leader removed: they cannot come back in with the code. */
  removed: Set<string>;
  createdAt: number;
  /** When the last member went offline; null while somebody is connected. */
  emptySince: number | null;
}

/** What goes to a client: ids and public profile only, the same as chat shows. */
export interface RoomView {
  messages: ConvoyMessage[];
  code: string;
  name: string;
  eventId: string | null;
  leader: string;
  destination: Destination | null;
  resting: boolean;
  cruising: boolean;
  route: ConvoyRoute | null;
  automaticRegroup: AutomaticRegroup;
  members: { id: string; username: string; avatar: string; online: boolean; lastSeen: number; position: Position | null }[];
}

export type Outcome<T = RoomView> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

export class Rooms {
  private rooms = new Map<string, Room>();
  private byEvent = new Map<string, string>();
  private byUser = new Map<string, Set<string>>();

  constructor(private now: () => number = Date.now, private makeCode: () => string = newCode) {}

  get size(): number { return this.rooms.size; }

  private room(code: string): Room | undefined { return this.rooms.get(code); }

  view(code: string): RoomView | undefined {
    const room = this.room(code);
    if (!room) return undefined;
    room.messages = room.messages.filter((m) => this.now() - m.ts < CONVOY_MESSAGE_TTL_MS);
    return {
      messages: room.messages.map((m) => ({ ...m })),
      code: room.code, name: room.name, eventId: room.eventId, leader: room.leader, destination: room.destination, resting: room.resting, cruising: room.cruising,
      route: room.route && { name: room.route.name, stops: room.route.stops.map((p) => [...p] as [number, number]) },
      automaticRegroup: { ...room.automaticRegroup },
      members: [...room.members.values()].sort((a, b) => a.joinedAt - b.joinedAt).map((m) => ({
        id: m.id, username: m.username, avatar: m.avatar, online: m.online, lastSeen: m.lastSeen, position: m.online ? m.position : null,
      })),
    };
  }

  /** The codes of the rooms a user is in. */
  roomsOf(userId: string): string[] { return [...(this.byUser.get(userId) ?? [])]; }

  /** Everyone in a room, for sending to. */
  memberIds(code: string): string[] { return [...(this.room(code)?.members.keys() ?? [])]; }

  forEvent(eventId: string): string | undefined { return this.byEvent.get(eventId); }

  isLeader(code: string, userId: string): boolean { return this.room(code)?.leader === userId; }

  /** Private room chat, bounded in memory; retries with the same client id are idempotent. */
  message(code: string, userId: string, text: string, clientId: string): Outcome<ConvoyMessage> {
    const room = this.room(code);
    const member = room?.members.get(userId);
    if (!room || !member) return fail('You are not in that convoy');
    const now = this.now();
    room.messages = room.messages.filter((m) => now - m.ts < CONVOY_MESSAGE_TTL_MS);
    const duplicate = room.messages.find((m) => m.userId === userId && m.clientId === clientId);
    if (duplicate) return { ok: true, value: { ...duplicate } };
    const clean = text.trim();
    if (!clean || clean.length > MAX_CONVOY_MESSAGE_LENGTH) return fail('Messages need 1 to 500 characters');
    if (member.lastMessageAt !== undefined && now - member.lastMessageAt < CONVOY_CHAT_GAP_MS) return fail('Wait a moment before sending another message');
    const message = { id: crypto.randomUUID(), clientId, userId, username: member.username, text: clean, ts: now };
    member.lastMessageAt = now;
    room.messages = [...room.messages, message].slice(-MAX_CONVOY_MESSAGES);
    return { ok: true, value: { ...message } };
  }

  create(who: Who, opts: { name?: string; eventId?: string | null; destination?: Destination | null; route?: ConvoyRoute | null; automaticRegroup?: AutomaticRegroup } = {}): Outcome {
    if (this.rooms.size >= MAX_ROOMS) return fail('Convoys are very busy right now. Try again shortly.');
    if ((this.byUser.get(who.id)?.size ?? 0) >= MAX_ROOMS_PER_USER) return fail(`You can be in ${MAX_ROOMS_PER_USER} convoys at once: leave one first`);
    if (opts.eventId && this.byEvent.has(opts.eventId)) return fail('That cruise already has a convoy');
    let code = this.makeCode();
    while (this.rooms.has(code)) code = this.makeCode();
    const now = this.now();
    const room: Room = {
      code, name: (opts.name ?? '').trim().slice(0, MAX_NAME) || 'Convoy', eventId: opts.eventId ?? null, leader: who.id,
      destination: opts.destination ?? null,
      resumeDestination: null,
      resting: false,
      cruising: false,
      route: opts.route ? { name: opts.route.name.trim().slice(0, MAX_NAME) || 'Convoy route', stops: opts.route.stops.map((p) => [...p] as [number, number]) } : null,
      automaticRegroup: opts.automaticRegroup ?? { enabled: false, separationM: DEFAULT_REGROUP_SEPARATION_M },
      separatedSince: null,
      regroupPending: false,
      messages: [],
      navigationVersion: 0,
      members: new Map(), removed: new Set(), createdAt: now, emptySince: null,
    };
    this.rooms.set(code, room);
    if (room.eventId) this.byEvent.set(room.eventId, code);
    this.add(room, who);
    return { ok: true, value: this.view(code)! };
  }

  /** Joining a room you are already in is a no-op that returns it, so a reconnecting client can just say so again. */
  join(code: string, who: Who): Outcome {
    const room = this.room(code);
    if (!room) return fail('No convoy has that code');
    if (room.removed.has(who.id)) return fail('The leader removed you from this convoy');
    const have = room.members.get(who.id);
    if (have) {
      Object.assign(have, { username: who.username, avatar: who.avatar });
      return { ok: true, value: this.view(code)! };
    }
    if (room.members.size >= MAX_MEMBERS) return fail(`That convoy is full (${MAX_MEMBERS} members)`);
    if ((this.byUser.get(who.id)?.size ?? 0) >= MAX_ROOMS_PER_USER) return fail(`You can be in ${MAX_ROOMS_PER_USER} convoys at once: leave one first`);
    this.add(room, who);
    return { ok: true, value: this.view(code)! };
  }

  private add(room: Room, who: Who): void {
    const now = this.now();
    room.members.set(who.id, { ...who, online: true, lastSeen: now, lastPositionAt: 0, position: null, joinedAt: now });
    room.emptySince = null;
    let mine = this.byUser.get(who.id);
    if (!mine) this.byUser.set(who.id, (mine = new Set()));
    mine.add(room.code);
  }

  /** Out of a room. Returns what is left of it, or undefined when it is gone (or you were not in it). */
  leave(code: string, userId: string): RoomView | undefined {
    const room = this.room(code);
    if (!room || !room.members.delete(userId)) return undefined;
    const mine = this.byUser.get(userId);
    mine?.delete(code);
    if (mine?.size === 0) this.byUser.delete(userId);
    if (room.members.size === 0) { this.drop(room); return undefined; }
    if (room.leader === userId) { room.leader = this.successor(room); room.navigationVersion++; room.regroupPending = false; }
    this.settle(room);
    return this.view(code);
  }

  /** Whoever has been there longest and is connected, otherwise longest of all. */
  private successor(room: Room): string {
    const members = [...room.members.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    return (members.find((m) => m.online) ?? members[0]).id;
  }

  private drop(room: Room): void {
    this.rooms.delete(room.code);
    if (room.eventId) this.byEvent.delete(room.eventId);
  }

  setDestination(code: string, userId: string, destination: Destination | null): Outcome {
    const room = this.room(code);
    if (!room?.members.has(userId)) return fail('You are not in that convoy');
    if (room.leader !== userId) return fail('Only the leader can set the destination');
    room.navigationVersion++;
    room.destination = destination && { ...destination, label: destination.label.trim().slice(0, MAX_LABEL) };
    room.resumeDestination = null;
    room.resting = false;
    room.cruising = false;
    room.separatedSince = null;
    room.regroupPending = false;
    return { ok: true, value: this.view(code)! };
  }

  /** Leader-only free cruising: keep the convoy together without a destination or shared route. */
  setCruising(code: string, userId: string, cruising: boolean): Outcome {
    const room = this.room(code);
    if (!room?.members.has(userId)) return fail('You are not in that convoy');
    if (room.leader !== userId) return fail('Only the leader can change convoy mode');
    room.navigationVersion++;
    room.cruising = cruising;
    if (cruising) {
      room.destination = null;
      room.resumeDestination = null;
      room.resting = false;
      room.route = null;
    }
    room.separatedSince = null;
    room.regroupPending = false;
    return { ok: true, value: this.view(code)! };
  }

  /** Temporarily replace the destination with a rest stop, remembering where the convoy was headed. */
  setRestStop(code: string, userId: string, destination: Destination): Outcome {
    const room = this.room(code);
    if (!room?.members.has(userId)) return fail('You are not in that convoy');
    if (room.resting) return fail('The convoy is already in rest mode');
    room.navigationVersion++;
    room.resumeDestination = room.destination && { ...room.destination };
    room.destination = { ...destination, label: destination.label.trim().slice(0, MAX_LABEL) };
    room.resting = true;
    room.separatedSince = null;
    room.regroupPending = false;
    return { ok: true, value: this.view(code)! };
  }

  /** Leave rest mode and restore the destination that was active before the stop. */
  continueDestination(code: string, userId: string): Outcome {
    const room = this.room(code);
    if (!room?.members.has(userId)) return fail('You are not in that convoy');
    if (room.leader !== userId) return fail('Only the leader can set the destination');
    if (!room.resting) return fail('The convoy is not in rest mode');
    room.navigationVersion++;
    room.destination = room.resumeDestination;
    room.resumeDestination = null;
    room.resting = false;
    room.separatedSince = null;
    room.regroupPending = false;
    return { ok: true, value: this.view(code)! };
  }

  /** The leader shares a route as ordered driving stops, including a circuit's closing stop when applicable. */
  setRoute(code: string, userId: string, route: ConvoyRoute | null): Outcome {
    const room = this.room(code);
    if (!room?.members.has(userId)) return fail('You are not in that convoy');
    if (room.leader !== userId) return fail('Only the leader can set the route');
    room.navigationVersion++;
    room.route = route && { name: route.name.trim().slice(0, MAX_NAME) || 'Convoy route', stops: route.stops.map((p) => [...p] as [number, number]) };
    room.separatedSince = null;
    room.regroupPending = false;
    return { ok: true, value: this.view(code)! };
  }

  /** Shared cooldown covers every member and socket, including automatic regroup. */
  reserveRestLookup(code: string, userId: string): Outcome<number> {
    const room = this.room(code);
    if (!room?.members.has(userId)) return fail('You are not in that convoy');
    if (!room.route || room.resting) return fail('A shared route outside rest mode is required');
    if (room.lastRestLookupAt !== undefined && this.now() - room.lastRestLookupAt < 30_000) return fail('A rest-stop search was just requested. Try again in a moment.');
    room.lastRestLookupAt = this.now();
    return { ok: true, value: room.navigationVersion };
  }

  navigationVersion(code: string): number | undefined { return this.room(code)?.navigationVersion; }

  /** Complete an automatic rest-stop lookup atomically, so repeated position updates cannot queue duplicates. */
  completeAutomaticRegroup(code: string, destination: Destination | null): Outcome {
    const room = this.room(code);
    if (!room?.regroupPending) return fail('That automatic regroup is no longer pending');
    room.regroupPending = false;
    if (!destination) return { ok: true, value: this.view(code)! };
    if (!room.automaticRegroup.enabled || !room.route || room.resting) return fail('That automatic regroup is no longer available');
    room.navigationVersion++;
    room.resumeDestination = room.destination && { ...room.destination };
    room.destination = { ...destination, label: destination.label.trim().slice(0, MAX_LABEL) };
    room.resting = true;
    return { ok: true, value: this.view(code)! };
  }

  handOver(code: string, userId: string, to: string): Outcome {
    const room = this.room(code);
    if (!room?.members.has(userId)) return fail('You are not in that convoy');
    if (room.leader !== userId) return fail('Only the leader can hand over');
    if (!room.members.has(to)) return fail('They are not in this convoy');
    room.leader = to;
    room.navigationVersion++;
    room.regroupPending = false;
    return { ok: true, value: this.view(code)! };
  }

  /** The leader puts someone out, and they cannot rejoin with the code. Returns what is left of the room. */
  remove(code: string, userId: string, target: string): Outcome {
    const room = this.room(code);
    if (!room?.members.has(userId)) return fail('You are not in that convoy');
    if (room.leader !== userId) return fail('Only the leader can remove someone');
    if (target === userId) return fail('Leave instead');
    if (!room.members.has(target)) return fail('They are not in this convoy');
    if (room.removed.size >= MAX_REMOVED) return fail('This convoy has removed too many people. Start a new one.');
    room.removed.add(target);
    this.leave(code, target);
    return { ok: true, value: this.view(code)! };
  }

  /**
   * A position from a member: kept as their latest and returned with the rooms
   * it goes to, or null when it came too soon after the last (throttled).
   */
  position(userId: string, p: Omit<Position, 'ts'>): { position: Position; codes: string[]; automaticRegroupCodes: string[] } | null {
    const codes = this.roomsOf(userId);
    if (codes.length === 0) return null;
    const now = this.now();
    const first = this.room(codes[0])!.members.get(userId)!;
    if (now - first.lastPositionAt < POSITION_GAP_MS) return null;
    const position: Position = { ...p, ts: now };
    for (const code of codes) {
      const m = this.room(code)!.members.get(userId)!;
      m.position = position;
      m.lastPositionAt = now;
      m.lastSeen = now;
    }
    return { position, codes, automaticRegroupCodes: codes.filter((code) => this.automaticRegroupDue(this.room(code)!, now)) };
  }

  private automaticRegroupDue(room: Room, now: number): boolean {
    if (!room.automaticRegroup.enabled || !room.route || room.resting || room.regroupPending) {
      room.separatedSince = null;
      return false;
    }
    const positions = [...room.members.values()].filter((m) => m.online && m.position && now - m.position.ts <= AUTO_REGROUP_FRESH_MS).map((m) => m.position!);
    if (positions.length < 2) { room.separatedSince = null; return false; }
    let widest = 0;
    for (let i = 0; i < positions.length; i++) for (let j = i + 1; j < positions.length; j++) widest = Math.max(widest, haversine(positions[i].lat, positions[i].lng, positions[j].lat, positions[j].lng));
    if (widest < room.automaticRegroup.separationM) { room.separatedSince = null; return false; }
    if (room.separatedSince === null) { room.separatedSince = now; return false; }
    if (now - room.separatedSince < AUTO_REGROUP_DELAY_MS) return false;
    room.separatedSince = null;
    room.regroupPending = true;
    return true;
  }

  /** They stopped sharing but are still in the room: their dot goes. Returns the rooms that changed. */
  clearPosition(userId: string): string[] {
    const changed: string[] = [];
    for (const code of this.roomsOf(userId)) {
      const m = this.room(code)!.members.get(userId)!;
      if (m.position) { m.position = null; changed.push(code); }
    }
    return changed;
  }

  /** The first connection of a user opens, or their last one closes. Returns the rooms whose list changed. */
  setOnline(userId: string, online: boolean): string[] {
    const now = this.now();
    const changed: string[] = [];
    for (const code of this.roomsOf(userId)) {
      const room = this.room(code)!;
      const m = room.members.get(userId)!;
      if (m.online === online) continue;
      m.online = online;
      m.lastSeen = now;
      if (!online) m.position = null;
      this.settle(room);
      changed.push(code);
    }
    return changed;
  }

  /** Out of every room, as for a suspended or deleted account. Returns the rooms that changed. */
  removeUser(userId: string): string[] {
    const changed: string[] = [];
    for (const code of this.roomsOf(userId)) if (this.leave(code, userId)) changed.push(code);
    return changed;
  }

  /** Whether the room has anybody connected, tracked so an empty one can time out. */
  private settle(room: Room): void {
    const anyone = [...room.members.values()].some((m) => m.online);
    if (anyone) room.emptySince = null;
    else room.emptySince ??= this.now();
  }

  /** Retire members who have been gone too long and rooms nobody has been in. Returns the rooms that changed and the codes that went. */
  sweep(): { changed: string[]; gone: string[] } {
    const now = this.now();
    const changed: string[] = [];
    const gone: string[] = [];
    for (const room of [...this.rooms.values()]) {
      room.messages = room.messages.filter((m) => now - m.ts < CONVOY_MESSAGE_TTL_MS);
      for (const m of [...room.members.values()]) {
        if (!m.online && now - m.lastSeen >= MEMBER_GRACE_MS && this.leave(room.code, m.id) && !changed.includes(room.code)) changed.push(room.code);
      }
      if (!this.rooms.has(room.code)) { gone.push(room.code); continue; }
      if (room.emptySince !== null && now - room.emptySince >= ROOM_IDLE_MS) { this.drop(room); gone.push(room.code); }
    }
    return { changed: changed.filter((c) => !gone.includes(c)), gone };
  }
}

/**
 * Wrong guesses at a code, counted per account so the invite code cannot be
 * walked through: ten misses in ten minutes and the next try waits.
 */
export class MissLimiter {
  private misses = new Map<string, number[]>();
  constructor(private now: () => number = Date.now, private max = 10, private windowMs = 10 * 60_000) {}

  blocked(key: string): boolean {
    const recent = (this.misses.get(key) ?? []).filter((t) => this.now() - t < this.windowMs);
    if (recent.length === 0) this.misses.delete(key); else this.misses.set(key, recent);
    return recent.length >= this.max;
  }

  miss(key: string): void {
    this.misses.set(key, [...(this.misses.get(key) ?? []), this.now()].slice(-this.max));
  }

  sweep(): void { for (const key of [...this.misses.keys()]) this.blocked(key); }
}
