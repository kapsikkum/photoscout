import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoff, CONNECTION_TIMEOUT_MS, HEARTBEAT_MS, LINGER_MS, MAX_WAIT_MS, RealtimeClient, SESSION_ENDED, UNAVAILABLE_AFTER, type Env, type SocketLike } from '../src/convoy/client.js';
import { activeRoom, emptyState, lastSeenText, reduce, speedText, withMine } from '../src/convoy/state.js';
import { pinsFor, STALE_MS } from '../src/convoy/layer.js';
import type { Member, Room } from '../src/convoy/types.js';
import { convoyEvents } from '../src/convoy/events.js';

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  closedWith: number | undefined;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  send(data: string) { this.sent.push(data); }
  close(code?: number) { this.closedWith = code; this.readyState = 3; }
  // What the network does.
  hello() { this.readyState = 1; this.onopen?.({}); this.onmessage?.({ data: JSON.stringify({ t: 'hello', me: 'u1', rooms: [] }) }); }
  drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const env: Env = {
    open: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    url: () => 'wss://x/ws',
    random: () => 1,
    setTimeout: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimeout: (h) => { (h as { live: boolean }).live = false; },
  };
  const client = new RealtimeClient(env);
  const fire = () => { const t = timers.filter((x) => x.live).pop(); assert.ok(t, 'a timer was set'); t.live = false; t.fn(); return t.ms; };
  return { client, sockets, timers, fire };
}

test('the wait doubles from a second, caps at 30, and is jittered between half and all of it', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map((n) => backoff(n, 1)), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(backoff(2, 0), 2000);
  assert.ok(backoff(20, 0.5) <= MAX_WAIT_MS);
});

test('it connects when asked, is open on the hello, and reconnects after a drop with a growing wait', () => {
  const { client, sockets, fire } = harness();
  const statuses: string[] = [];
  client.onStatus((s) => statuses.push(s));
  const release = client.acquire();
  assert.equal(sockets.length, 1);
  sockets[0].hello();
  assert.equal(client.status, 'open');
  assert.equal(client.send({ t: 'chat.sub' }), true);
  assert.deepEqual(sockets[0].sent, ['{"t":"chat.sub"}']);

  sockets[0].drop();
  assert.equal(client.status, 'retrying');
  assert.equal(client.send({ t: 'chat.sub' }), false, 'nothing is queued while it is down');
  assert.equal(fire(), 1000);
  assert.equal(sockets.length, 2);
  sockets[1].drop(); // never opened
  assert.equal(fire(), 1000);
  sockets[2].drop();
  assert.equal(fire(), 2000);
  sockets[3].hello();
  assert.equal(client.status, 'open');
  assert.deepEqual(statuses.slice(0, 4), ['connecting', 'open', 'retrying', 'connecting']);
  release();
});

test('after a few failures in a row the page is told to poll, and it is still trying', () => {
  const { client, sockets, fire } = harness();
  client.acquire();
  for (let i = 0; i < UNAVAILABLE_AFTER; i++) { sockets[i].drop(); if (i < UNAVAILABLE_AFTER - 1) fire(); }
  assert.equal(client.status, 'unavailable');
  fire();
  assert.equal(sockets.length, UNAVAILABLE_AFTER + 1, 'it keeps trying');
  sockets[UNAVAILABLE_AFTER].hello();
  assert.equal(client.status, 'open', 'and recovers');
});

test('a session that has ended is not retried', () => {
  const { client, sockets, timers } = harness();
  client.acquire();
  sockets[0].hello();
  sockets[0].drop(SESSION_ENDED);
  assert.equal(client.status, 'ended');
  assert.equal(timers.filter((t) => t.live).length, 0);
});

test('the socket outlives a page change by a moment and then goes', () => {
  const { client, sockets, timers, fire } = harness();
  const first = client.acquire();
  sockets[0].hello();
  first();
  const second = client.acquire(); // the next page, straight away
  assert.equal(sockets.length, 1, 'no reconnect');
  assert.equal(timers.filter((t) => t.live && t.ms === LINGER_MS).length, 0, 'and the pending close was cancelled');
  second();
  assert.equal(fire(), LINGER_MS);
  assert.equal(sockets[0].closedWith, undefined);
  assert.equal(sockets[0].readyState, 3);
  assert.equal(client.status, 'idle');
});

test('messages go to listeners, and garbage is ignored', () => {
  const { client, sockets } = harness();
  const got: string[] = [];
  client.onMessage((m) => got.push(m.t));
  client.acquire();
  sockets[0].hello();
  sockets[0].onmessage?.({ data: 'nonsense' });
  sockets[0].onmessage?.({ data: JSON.stringify({ t: 'chat.gone', id: 'x' }) });
  assert.deepEqual(got, ['hello', 'chat.gone']);
});

const member = (id: string, patch: Partial<Member> = {}): Member => ({ id, username: id.toUpperCase(), avatar: '', online: true, lastSeen: 1000, position: null, ...patch });
const room = (code: string, members: Member[], patch: Partial<Room> = {}): Room => ({ messages: [], code, name: code, eventId: null, leader: 'a', destination: null, resting: false, cruising: false, route: null, automaticRegroup: { enabled: false, separationM: 5_000 }, members, ...patch });

test('stalled handshakes and half-open connections time out and reconnect', () => {
  const { client, sockets, fire } = harness();
  client.acquire();
  assert.equal(fire(), CONNECTION_TIMEOUT_MS);
  assert.equal(client.status, 'retrying');
  assert.equal(sockets[0].readyState, 3);
  fire();
  sockets[1].hello();
  assert.equal(fire(), HEARTBEAT_MS);
  assert.deepEqual(JSON.parse(sockets[1].sent[0]), { t: 'ping' });
  assert.equal(fire(), CONNECTION_TIMEOUT_MS);
  assert.equal(client.status, 'retrying');
  fire();
  sockets[2].hello();
  client.reconnect();
  assert.equal(sockets[2].readyState, 3);
  assert.equal(sockets.length, 4);
  sockets[2].onmessage?.({ data: JSON.stringify({ t: 'hello', me: 'stale', rooms: [] }) });
  assert.equal(client.status, 'connecting', 'old socket cannot overwrite the new connection');
});

test('a heartbeat reply keeps the connection alive without leaking timers', () => {
  const { client, sockets, timers, fire } = harness();
  const release = client.acquire();
  sockets[0].hello();
  fire();
  sockets[0].onmessage?.({ data: '{"t":"pong"}' });
  assert.equal(timers.filter((t) => t.live).length, 1);
  assert.equal(timers.find((t) => t.live)!.ms, HEARTBEAT_MS);
  release();
  fire();
  assert.equal(timers.filter((t) => t.live).length, 0);
});

test('chat delivery deduplicates messages, bounds history and notifies only new incoming messages', () => {
  const r = room('R', [member('a'), member('b')]);
  let state = reduce(emptyState, { t: 'hello', me: 'a', rooms: [r] });
  const message = { id: '1', clientId: 'c1', userId: 'b', username: 'B', text: 'Wait for me', ts: 1000 };
  const packet = { t: 'convoy.message' as const, room: 'R', message };
  assert.equal(convoyEvents(state, packet).length, 1);
  state = reduce(state, packet);
  assert.equal(convoyEvents(state, packet).length, 0);
  state = reduce(state, packet);
  assert.equal(state.rooms[0].messages.length, 1);
  assert.equal(convoyEvents(state, { ...packet, message: { ...message, id: 'own', userId: 'a' } }).length, 0);
  for (let i = 2; i < 65; i++) state = reduce(state, { ...packet, message: { ...message, id: `${i}` } });
  assert.equal(state.rooms[0].messages.length, 50);
  const missing = { ...message, id: 'missed' };
  const hello = { t: 'hello' as const, me: 'a', rooms: [{ ...state.rooms[0], messages: [...state.rooms[0].messages, missing] }] };
  assert.equal(convoyEvents(emptyState, hello).length, 0, 'initial history is silent');
  assert.equal(convoyEvents(state, hello).length, 1, 'reconnect catches up an unseen incoming message once');
  assert.equal(convoyEvents(reduce(state, hello), hello).length, 0);
});

test('convoy notices describe destination, membership and leadership changes, not positions', () => {
  const r = room('R', [member('a'), member('b')]);
  const state = reduce(emptyState, { t: 'hello', me: 'a', rooms: [r] });
  assert.equal(convoyEvents(state, { t: 'pos', room: 'R', id: 'b', lat: 1, lng: 2, heading: null, speed: null, ts: 2000 }).length, 0);
  const changed = { ...r, leader: 'b', resting: true, destination: { lat: 1, lng: 2, label: 'Rest area' }, members: [...r.members, member('c')] };
  const notices = convoyEvents(state, { t: 'room', room: changed });
  assert.ok(notices.some((n) => n.text.includes('C joined')));
  assert.ok(notices.some((n) => n.text.includes('B is now leading')));
  assert.ok(notices.some((n) => n.text.includes('Rest stop: Rest area')));
});

test('the reducer follows hello, room, pos and left, and shows a room you have just joined', () => {
  let s = reduce(emptyState, { t: 'hello', me: 'a', rooms: [] });
  assert.equal(s.me, 'a');
  assert.equal(activeRoom(s), null);
  s = reduce(s, { t: 'room', room: room('R1', [member('a')]) });
  assert.equal(s.active, 'R1');
  s = reduce(s, { t: 'room', room: room('R2', [member('a')]) });
  assert.equal(s.active, 'R2', 'a new room is shown');
  s = reduce(s, { t: 'room', room: room('R1', [member('a'), member('b')]) });
  assert.equal(s.active, 'R2', 'an update to another room is not');
  s = reduce(s, { t: 'pos', room: 'R1', id: 'b', lat: 1, lng: 2, heading: 90, speed: 5, ts: 5000 });
  assert.deepEqual(s.rooms[0].members[1].position, { lat: 1, lng: 2, heading: 90, speed: 5, ts: 5000 });
  assert.equal(s.rooms[0].members[1].lastSeen, 5000);
  s = reduce(s, { t: 'left', room: 'R2' });
  assert.equal(s.active, 'R1');
  s = reduce(s, { t: 'left', room: 'R1' });
  assert.equal(s.active, null);
  assert.match(reduce(s, { t: 'left', room: 'R1', removed: true }).error, /removed you/);
  assert.equal(reduce(s, { t: 'chat.gone', id: 'x' }), s, 'chat is not its business');
  assert.equal(reduce(s, { t: 'error', error: 'No convoy has that code', in: 'convoy.join' }).error, 'No convoy has that code');
  assert.equal(reduce(s, { t: 'error', error: 'chat thing', in: 'chat.sub' }).error, '');
});

test('your own position comes from your phone, not the server', () => {
  const r = room('R', [member('a'), member('b')]);
  const mine = { lat: 3, lng: 4, heading: null, speed: null, ts: 9000 };
  assert.deepEqual(withMine(r, 'a', mine)[0].position, mine);
  assert.equal(withMine(r, 'a', null), r.members);
});

test('pins are for members who are online and sharing, and a quiet one fades', () => {
  const pos = (ts: number) => ({ lat: 1, lng: 2, heading: 10, speed: 1, ts });
  const now = 100_000;
  const pins = pinsFor(
    [member('a', { position: pos(now) }), member('b', { position: pos(now - STALE_MS - 1) }), member('c', { online: false, position: pos(now) }), member('d')],
    { me: 'a', leader: 'b' }, now,
  );
  assert.deepEqual(pins.map((p) => [p.id, p.me, p.leader, p.stale]), [['a', true, false, false], ['b', false, true, true]]);
});

test('last seen and speed read as people say them', () => {
  assert.equal(lastSeenText(1000, 5000), 'just now');
  assert.equal(lastSeenText(0, 60_000), '60 s ago');
  assert.equal(lastSeenText(0, 5 * 60_000), '5 min ago');
  assert.equal(lastSeenText(0, 3 * 3600_000), '3 h ago');
  assert.equal(speedText(25), '90 km/h');
  assert.equal(speedText(null), '');
});
