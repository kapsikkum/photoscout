import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { realtime, type Status } from './client.js';
import { activeRoom, emptyState, reduce, viewOf, type ConvoyState, type ConvoyView } from './state.js';
import type { AutomaticRegroup, ConvoyRoute, Destination, Position, Room } from './types.js';
import { convoyEvents, type ConvoyNotice } from './events.js';

/**
 * The convoy for any page: connect, reconnect, say where you are while you are
 * in a room, hear where the others are. Several components can call
 * `useConvoy()` at once (the Convoy page, a Drive page with a convoy on its
 * map) and share one connection, one room list and one location watch.
 *
 * Your position goes out at most once a second, only while you are in a room
 * and have sharing on, and stops the moment you leave or the socket drops.
 */

const SEND_GAP_MS = 1000;

interface Snapshot {
  notices: ConvoyNotice[];
  unread: Record<string, number>;
  readMessages: boolean;
  announceEvents: boolean;
  desktopAlerts: boolean;
  keepAwake: boolean;
  status: Status;
  state: ConvoyState;
  sharing: boolean;
  mine: Position | null;
  geoError: string;
}

const SHARING_KEY = 'photoscout.convoy.sharing';
function readSharing(): boolean {
  try { return localStorage.getItem(SHARING_KEY) !== 'off'; } catch { return true; }
}

function preference(key: string): boolean { try { return localStorage.getItem(`photoscout.convoy.${key}`) === 'on'; } catch { return false; } }
let snap: Snapshot = { notices: [], unread: {}, readMessages: preference('readMessages'), announceEvents: preference('announceEvents'), desktopAlerts: preference('desktopAlerts'), keepAwake: preference('keepAwake'), status: realtime.status, state: emptyState, sharing: readSharing(), mine: null, geoError: '' };
const listeners = new Set<() => void>();
let users = 0;
let release: (() => void) | null = null;
let unhook: (() => void)[] = [];
let watchId: number | null = null;
let lastSent = 0;
let errorTimer: ReturnType<typeof setTimeout> | null = null;

function set(patch: Partial<Snapshot>): void {
  snap = { ...snap, ...patch };
  syncWatch();
  for (const fn of [...listeners]) fn();
}

/** Watch the phone's location exactly while it is wanted: in a room, sharing on, socket open. */
function syncWatch(): void {
  const want = users > 0 && snap.sharing && snap.status === 'open' && snap.state.rooms.length > 0 && typeof navigator !== 'undefined' && 'geolocation' in navigator;
  if (want && watchId === null) {
    watchId = navigator.geolocation.watchPosition(onFix, onFixError, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20_000 });
    window.PhotoScoutNative?.startBackgroundLocation?.();
  } else if (!want && watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
    window.PhotoScoutNative?.stopBackgroundLocation?.();
    realtime.send({ t: 'pos.stop' }); // so the others are not left looking at where you last were
    if (snap.mine) snap = { ...snap, mine: null }; // not shared any more, so not drawn as shared
  }
}

function onFix(p: GeolocationPosition): void {
  const c = p.coords;
  const now = Date.now();
  if (now - p.timestamp > 5000) { set({ geoError: 'Waiting for a fresh GPS position…' }); return; }
  const heading = c.heading !== null && Number.isFinite(c.heading) ? c.heading : null;
  const speed = c.speed !== null && Number.isFinite(c.speed) ? Math.max(0, c.speed) : null;
  const mine: Position = { lat: c.latitude, lng: c.longitude, heading, speed, ts: now };
  if (now - lastSent >= SEND_GAP_MS && realtime.send({ t: 'pos', lat: mine.lat, lng: mine.lng, heading, speed })) lastSent = now;
  set({ mine, geoError: '' });
}

function onFixError(err: GeolocationPositionError): void {
  set({ geoError: err.code === err.PERMISSION_DENIED ? 'Location is blocked, so the others cannot see you. Allow it in the browser to share.' : 'Could not get your location yet.' });
}

function start(): void {
  unhook = [
    realtime.onStatus((status) => {
      if (status === 'ended') { set({ status, state: emptyState, notices: [], unread: {}, mine: null }); return; }
      set({ status });
    }),
    realtime.onMessage((m) => {
      const events = convoyEvents(snap.state, m);
      const state = reduce(snap.state, m);
      if (state === snap.state) return;
      const notices = events.map((event) => ({ ...event, id: crypto.randomUUID(), ts: Date.now() }));
      const unread = { ...snap.unread };
      for (const event of events) if (event.kind === 'message') unread[event.room] = (unread[event.room] ?? 0) + 1;
      if (m.t === 'hello' || m.t === 'left') for (const code of Object.keys(unread)) if (!state.rooms.some((r) => r.code === code)) delete unread[code];
      set({ state, unread, notices: [...snap.notices, ...notices].slice(-5) });
      if (state.error) {
        if (errorTimer) clearTimeout(errorTimer);
        errorTimer = setTimeout(() => set({ state: { ...snap.state, error: '' } }), 8000);
      }
    }),
  ];
  release = realtime.acquire();
  snap = { ...snap, status: realtime.status };
}

function stop(): void {
  unhook.forEach((fn) => fn());
  unhook = [];
  release?.();
  release = null;
  if (errorTimer) clearTimeout(errorTimer);
  snap = { ...snap, state: emptyState, notices: [], unread: {}, mine: null, geoError: '' };
  syncWatch();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export interface Convoy {
  notices: ConvoyNotice[];
  unread: Record<string, number>;
  readMessages: boolean;
  announceEvents: boolean;
  desktopAlerts: boolean;
  keepAwake: boolean;
  setPreference(key: 'readMessages' | 'announceEvents' | 'desktopAlerts' | 'keepAwake', on: boolean): void;
  dismissNotice(id: string): void;
  markRead(code: string): void;
  sendMessage(text: string, clientId: string): boolean;
  status: Status;
  me: string | null;
  rooms: Room[];
  room: Room | null;
  /** The active room as a map wants it: members with your own position filled in, who leads, where it is going. */
  view: ConvoyView | null;
  error: string;
  sharing: boolean;
  geoError: string;
  setSharing(on: boolean): void;
  setActive(code: string): void;
  create(name: string, automaticRegroup: AutomaticRegroup): void;
  join(code: string): void;
  joinCruise(eventId: string): void;
  leave(code?: string): void;
  setDestination(destination: Destination | null): void;
  setCruising(cruising: boolean): void;
  rest(action: 'find' | 'continue'): void;
  setRoute(route: ConvoyRoute | null): void;
  handOver(to: string): void;
  remove(id: string): void;
}

export function useConvoy(): Convoy {
  useEffect(() => {
    if (users++ === 0) start();
    syncWatch();
    return () => { if (--users === 0) stop(); };
  }, []);
  const s = useSyncExternalStore(subscribe, () => snap);
  const room = activeRoom(s.state);

  const send = useCallback((m: Parameters<typeof realtime.send>[0]) => {
    if (!realtime.send(m)) set({ state: { ...snap.state, error: 'Not connected yet. Try again in a moment.' } });
  }, []);

  return {
    notices: s.notices,
    unread: s.unread,
    readMessages: s.readMessages,
    announceEvents: s.announceEvents,
    desktopAlerts: s.desktopAlerts,
    keepAwake: s.keepAwake,
    setPreference: (key, on) => {
      try { localStorage.setItem(`photoscout.convoy.${key}`, on ? 'on' : 'off'); } catch { /* private mode */ }
      set({ [key]: on });
    },
    dismissNotice: (id) => set({ notices: snap.notices.filter((n) => n.id !== id) }),
    markRead: (code) => { if (snap.unread[code]) set({ unread: { ...snap.unread, [code]: 0 } }); },
    sendMessage: (text, clientId) => {
      if (!room || !realtime.send({ t: 'convoy.message', room: room.code, text, clientId })) {
        set({ state: { ...snap.state, error: 'Message not sent. Reconnect, then try again.' } });
        return false;
      }
      return true;
    },
    status: s.status,
    me: s.state.me,
    rooms: s.state.rooms,
    room,
    view: room && viewOf(room, s.state.me, s.sharing ? s.mine : null),
    error: s.state.error,
    sharing: s.sharing,
    geoError: s.geoError,
    setSharing: (on) => {
      try { localStorage.setItem(SHARING_KEY, on ? 'on' : 'off'); } catch { /* private mode: it just will not be remembered */ }
      set({ sharing: on });
    },
    setActive: (code) => set({ state: { ...snap.state, active: code } }),
    create: (name, automaticRegroup) => send({ t: 'convoy.create', name, automaticRegroup }),
    join: (code) => send({ t: 'convoy.join', code }),
    joinCruise: (eventId) => send({ t: 'convoy.cruise', eventId }),
    leave: (code) => { const c = code ?? room?.code; if (c) send({ t: 'convoy.leave', room: c }); },
    setDestination: (destination) => { if (room) send({ t: 'convoy.dest', room: room.code, destination }); },
    setCruising: (cruising) => { if (room) send({ t: 'convoy.mode', room: room.code, cruising }); },
    rest: (action) => { if (room) send({ t: 'convoy.rest', room: room.code, action }); },
    setRoute: (route) => { if (room) send({ t: 'convoy.route', room: room.code, route: route && { ...route, name: route.name.slice(0, 40) } }); },
    handOver: (to) => { if (room) send({ t: 'convoy.lead', room: room.code, to }); },
    remove: (id) => { if (room) send({ t: 'convoy.remove', room: room.code, id }); },
  };
}
