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
  members: Member[];
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
  | { t: 'chat.refresh' };

export type ClientMessage =
  | { t: 'ping' }
  | { t: 'convoy.message'; room: string; text: string; clientId: string }
  | { t: 'chat.sub' }
  | { t: 'chat.unsub' }
  | { t: 'convoy.create'; name: string; automaticRegroup: AutomaticRegroup }
  | { t: 'convoy.join'; code: string }
  | { t: 'convoy.cruise'; eventId: string }
  | { t: 'convoy.leave'; room: string }
  | { t: 'convoy.dest'; room: string; destination: Destination | null }
  | { t: 'convoy.mode'; room: string; cruising: boolean }
  | { t: 'convoy.rest'; room: string; action: 'find' | 'continue' }
  | { t: 'convoy.route'; room: string; route: ConvoyRoute | null }
  | { t: 'convoy.lead'; room: string; to: string }
  | { t: 'convoy.remove'; room: string; id: string }
  | { t: 'pos.stop' }
  | { t: 'pos'; lat: number; lng: number; heading: number | null; speed: number | null };
