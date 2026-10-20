/** What the server's WebSocket says (server/src/realtime.ts), and what a client may say back (server/src/wsMessages.ts). */

export interface Position { lat: number; lng: number; heading: number | null; speed: number | null; /** When the server received it, ms since the epoch. */ ts: number }
export interface Destination { lat: number; lng: number; label: string }
/** Shared Drive stops; a circuit repeats its first stop as the final stop. */
export interface ConvoyRoute { name: string; stops: [number, number][] }
export interface AutomaticRegroup { enabled: boolean; separationM: number }
export interface ConvoyMessage { id: string; clientId: string; userId: string; username: string; text: string; ts: number }

export interface Member {
  id: string;
  username: string;
  avatar: string;
  online: boolean;
  /** ms since the epoch: when they were last connected or heard from. */
  lastSeen: number;
  /** Only while online; a member who drops off has none. */
  position: Position | null;
  /** Joined an open convoy from a distance and has not yet reached the group. */
  newMember?: boolean;
}

export interface Room {
  messages: ConvoyMessage[];
  /** The invite code, which is also the room's id. */
  code: string;
  name: string;
  /** The community event this is the convoy of, or null. */
  eventId: string | null;
  leader: string;
  destination: Destination | null;
  resting: boolean;
  cruising: boolean;
  route: ConvoyRoute | null;
  automaticRegroup: AutomaticRegroup;
  open: boolean;
  members: Member[];
}

export interface OpenConvoySummary {
  code: string;
  name: string;
  leader: string;
  members: { id: string; username: string; avatar: string; newMember?: boolean }[];
  destination: Destination | null;
  cruising: boolean;
  resting: boolean;
  centroid: { lat: number; lng: number } | null;
}

export interface OpenCruiseUser {
  id: string;
  username: string;
  avatar: string;
  position: Position | null;
  lastSeen: number;
}

export type ServerMessage =
  | { t: 'pong' }
  | { t: 'convoy.message'; room: string; message: ConvoyMessage }
  | { t: 'hello'; me: string; rooms: Room[] }
  | { t: 'room'; room: Room }
  | { t: 'left'; room: string; /** The leader put you out. */ removed?: boolean }
  | ({ t: 'pos'; room: string; id: string } & Position)
  | { t: 'error'; error: string; in?: string }
  | { t: 'chat.ready' }
  | { t: 'chat'; message: import('../api.js').ChatMessage }
  | { t: 'chat.gone'; id: string }
  | { t: 'chat.refresh' }
  | { t: 'open_cruise.state'; enabled: boolean; users: OpenCruiseUser[]; convoys: OpenConvoySummary[] }
  | { t: 'open_cruise.pos'; user: OpenCruiseUser }
  | { t: 'open_cruise.pos_stop'; id: string }
  | { t: 'open_cruise.user_joined'; user: OpenCruiseUser }
  | { t: 'open_cruise.user_left'; id: string }
  | { t: 'open_cruise.convoys'; convoys: OpenConvoySummary[] }
  | { t: 'open_convoy.invited'; from: { id: string; username: string; avatar: string } }
  | { t: 'open_convoy.declined'; from: { id: string; username: string } };

export type ClientMessage =
  | { t: 'ping' }
  | { t: 'convoy.message'; room: string; text: string; clientId: string }
  | { t: 'chat.sub' }
  | { t: 'chat.unsub' }
  | { t: 'open_cruise.toggle'; enabled: boolean }
  | { t: 'open_convoy.invite'; targetUserId: string }
  | { t: 'open_convoy.accept'; fromUserId: string }
  | { t: 'open_convoy.decline'; fromUserId: string }
  | { t: 'open_convoy.join'; code: string }
  | { t: 'convoy.create'; name: string; automaticRegroup: AutomaticRegroup; open?: boolean }
  | { t: 'convoy.join'; code: string }
  | { t: 'convoy.cruise'; eventId: string }
  | { t: 'convoy.leave'; room: string }
  | { t: 'convoy.dest'; room: string; destination: Destination | null }
  | { t: 'convoy.mode'; room: string; cruising: boolean }
  | { t: 'convoy.open'; room: string; open: boolean }
  | { t: 'convoy.rest'; room: string; action: 'find' | 'continue' }
  | { t: 'convoy.route'; room: string; route: ConvoyRoute | null }
  | { t: 'convoy.lead'; room: string; to: string }
  | { t: 'convoy.remove'; room: string; id: string }
  | { t: 'pos.stop' }
  | { t: 'pos'; lat: number; lng: number; heading: number | null; speed: number | null };
