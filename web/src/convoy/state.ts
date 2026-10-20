import type { Destination, Member, OpenConvoySummary, OpenCruiseUser, Position, Room, ServerMessage } from './types.js';

/**
 * What the page knows about its convoys, and the one function that folds the
 * server's messages into it. No browser in here, so it can be tested.
 */

export interface ConvoyState {
  /** Your own id, once the server has said hello. */
  me: string | null;
  rooms: Room[];
  /** Which room the page is showing (you can be in a few). */
  active: string | null;
  /** The last thing the server refused, for the page to show. */
  error: string;
  openCruise: boolean;
  openCruiseUsers: OpenCruiseUser[];
  openConvoys: OpenConvoySummary[];
  incomingInvite: { from: { id: string; username: string; avatar: string }; ts: number } | null;
  declinedNotice: { from: { id: string; username: string }; ts: number } | null;
}

export const emptyState: ConvoyState = {
  me: null,
  rooms: [],
  active: null,
  error: '',
  openCruise: false,
  openCruiseUsers: [],
  openConvoys: [],
  incomingInvite: null,
  declinedNotice: null,
};

const pick = (rooms: Room[], wanted: string | null): string | null =>
  rooms.some((r) => r.code === wanted) ? wanted : rooms[0]?.code ?? null;

export function reduce(state: ConvoyState, m: ServerMessage): ConvoyState {
  switch (m.t) {
    case 'convoy.message':
      return { ...state, rooms: state.rooms.map((r) => r.code !== m.room || r.messages.some((x) => x.id === m.message.id)
        ? r : { ...r, messages: [...r.messages, m.message].slice(-50) }) };
    case 'hello':
      return { ...state, me: m.me, rooms: m.rooms, active: pick(m.rooms, state.active), error: '' };
    case 'room': {
      const known = state.rooms.some((r) => r.code === m.room.code);
      const rooms = known ? state.rooms.map((r) => (r.code === m.room.code ? m.room : r)) : [...state.rooms, m.room];
      // A room you did not have is one you just made or joined: show it.
      return { ...state, rooms, active: known ? pick(rooms, state.active) : m.room.code, error: '' };
    }
    case 'left': {
      const rooms = state.rooms.filter((r) => r.code !== m.room);
      return { ...state, rooms, active: pick(rooms, state.active), error: m.removed ? 'The leader removed you from that convoy.' : state.error };
    }
    case 'pos':
      return {
        ...state,
        rooms: state.rooms.map((r) => r.code !== m.room ? r : {
          ...r,
          members: r.members.map((x) => x.id === m.id ? { ...x, online: true, lastSeen: m.ts, position: { lat: m.lat, lng: m.lng, heading: m.heading, speed: m.speed, ts: m.ts } } : x),
        }),
      };
    case 'open_cruise.state':
      return { ...state, openCruise: m.enabled, openCruiseUsers: m.users ?? [], openConvoys: m.convoys ?? [] };
    case 'open_cruise.pos': {
      const idx = state.openCruiseUsers.findIndex((u) => u.id === m.user.id);
      const openCruiseUsers = idx >= 0
        ? state.openCruiseUsers.map((u, i) => i === idx ? m.user : u)
        : [...state.openCruiseUsers, m.user];
      return { ...state, openCruiseUsers };
    }
    case 'open_cruise.pos_stop':
      return {
        ...state,
        openCruiseUsers: state.openCruiseUsers.map((u) => u.id === m.id ? { ...u, position: null } : u),
      };
    case 'open_cruise.user_joined': {
      const idx = state.openCruiseUsers.findIndex((u) => u.id === m.user.id);
      const openCruiseUsers = idx >= 0
        ? state.openCruiseUsers.map((u, i) => i === idx ? m.user : u)
        : [...state.openCruiseUsers, m.user];
      return { ...state, openCruiseUsers };
    }
    case 'open_cruise.user_left':
      return {
        ...state,
        openCruiseUsers: state.openCruiseUsers.filter((u) => u.id !== m.id),
      };
    case 'open_cruise.convoys':
      return { ...state, openConvoys: m.convoys };
    case 'open_convoy.invited':
      return { ...state, incomingInvite: { from: m.from, ts: Date.now() } };
    case 'open_convoy.declined':
      return { ...state, declinedNotice: { from: m.from, ts: Date.now() } };
    case 'error':
      // Chat has nothing to do with this; the convoy page only shows what it asked for.
      return m.in === undefined || m.in.startsWith('convoy.') || m.in.startsWith('open_') || m.in === 'pos' ? { ...state, error: m.error } : state;
    default:
      return state;
  }
}

export const activeRoom = (s: ConvoyState): Room | null => s.rooms.find((r) => r.code === s.active) ?? null;

/** The room's members with your own position swapped for the one your phone just gave, which the server never sends back. */
export function withMine(room: Room, me: string | null, mine: Position | null): Member[] {
  if (!mine || !me) return room.members;
  return room.members.map((m) => (m.id === me ? { ...m, online: true, position: mine } : m));
}

/** The pieces of a room the map draws, in the one shape any map can be handed. */
export interface ConvoyView { members: Member[]; leader: string; me: string | null; destination: Destination | null; cruising: boolean; route: import('./types.js').ConvoyRoute | null }

export const viewOf = (room: Room, me: string | null, mine: Position | null): ConvoyView =>
  ({ members: withMine(room, me, mine), leader: room.leader, me, destination: room.destination, cruising: room.cruising, route: room.route });

/** "just now", "3 min ago", "2 h ago" for a last-seen time given in ms. */
export function lastSeenText(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 20) return 'just now';
  if (s < 90) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

/** Metres per second as km/h, rounded; '' when unknown. */
export function speedText(mps: number | null): string {
  return mps === null ? '' : `${Math.round(mps * 3.6)} km/h`;
}
