import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_REGROUP_DELAY_MS, CODE_LENGTH, CODE_PATTERN, MAX_MEMBERS, MAX_ROOMS_PER_USER, MEMBER_GRACE_MS, MissLimiter, newCode, normalizeCode, POSITION_GAP_MS, ROOM_IDLE_MS, Rooms,
} from '../src/convoy.js';
import { parseClientMessage } from '../src/wsMessages.js';

const who = (n: number) => ({ id: `u${n}`, username: `user${n}`, avatar: '' });
const clock = () => { const c = { t: 1_000_000, now: () => c.t }; return c; };

test('codes are 8 characters with no lookalikes, and do not repeat', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const code = newCode();
    assert.equal(code.length, CODE_LENGTH);
    assert.match(code, CODE_PATTERN);
    assert.doesNotMatch(code, /[01OIL]/);
    seen.add(code);
  }
  assert.equal(seen.size, 2000);
  assert.equal(normalizeCode(' abcd-efgh '), 'ABCDEFGH');
});

test('the creator leads; joining twice is harmless; a stranger cannot set the destination', () => {
  const rooms = new Rooms();
  const made = rooms.create(who(1), { name: '  Sunday run  ' });
  assert.ok(made.ok);
  const room = made.value;
  assert.equal(room.name, 'Sunday run');
  assert.equal(room.leader, 'u1');
  assert.ok(rooms.join(room.code, who(2)).ok);
  assert.ok(rooms.join(room.code, who(2)).ok);
  assert.equal(rooms.view(room.code)!.members.length, 2);
  assert.equal(rooms.setDestination(room.code, 'u2', { lat: 1, lng: 2, label: 'x' }).ok, false);
  const set = rooms.setDestination(room.code, 'u1', { lat: 1, lng: 2, label: ' Lookout ' });
  assert.ok(set.ok);
  assert.equal(set.value.destination?.label, 'Lookout');
  assert.equal(rooms.handOver(room.code, 'u2', 'u1').ok, false, 'only the leader hands over');
  assert.equal(rooms.handOver(room.code, 'u1', 'nobody').ok, false);
  assert.equal(rooms.handOver(room.code, 'u1', 'u2').ok && rooms.view(room.code)!.leader, 'u2');
});

test('the leader can share a route, including a circuit closing stop', () => {
  const rooms = new Rooms();
  const made = rooms.create(who(1));
  assert.ok(made.ok);
  const route = { name: 'Mountain loop', stops: [[149.57, -33.42], [149.58, -33.43], [149.57, -33.42]] as [number, number][] };
  const setRoute = (rooms as unknown as { setRoute: (code: string, userId: string, route: { name: string; stops: [number, number][] } | null) => { ok: boolean } }).setRoute;

  assert.equal(setRoute.call(rooms, made.value.code, 'u2', route).ok, false);
  assert.equal(setRoute.call(rooms, made.value.code, 'u1', route).ok, true);
  assert.deepEqual(rooms.view(made.value.code)!.route, route);
});

test('any convoy member can pause at a rest stop, while the leader resumes the saved destination', () => {
  const rooms = new Rooms();
  const made = rooms.create(who(1), { destination: { lat: -33.4, lng: 149.5, label: 'Final lookout' } });
  assert.ok(made.ok);
  assert.ok(rooms.join(made.value.code, who(2)).ok);
  const rest = { lat: -33.3, lng: 149.4, label: 'Macca\'s — restrooms tagged' };
  const api = rooms as unknown as {
    setRestStop: (code: string, userId: string, destination: { lat: number; lng: number; label: string }) => { ok: boolean };
    continueDestination: (code: string, userId: string) => { ok: boolean };
  };

  assert.equal(api.setRestStop(made.value.code, 'u2', rest).ok, true);
  assert.deepEqual(rooms.view(made.value.code)!.destination, rest);
  assert.equal((rooms.view(made.value.code)! as { resting?: boolean }).resting, true);
  assert.equal(api.continueDestination(made.value.code, 'u2').ok, false);
  assert.equal(api.continueDestination(made.value.code, 'u1').ok, true);
  assert.deepEqual(rooms.view(made.value.code)!.destination, { lat: -33.4, lng: 149.5, label: 'Final lookout' });
  assert.equal((rooms.view(made.value.code)! as { resting?: boolean }).resting, false);
});

test('a leader can switch a convoy to just-cruise mode, while rest stops still resume to no destination', () => {
  const rooms = new Rooms();
  const route = { name: 'Mountain loop', stops: [[149.5, -33.4], [149.6, -33.5]] as [number, number][] };
  const made = rooms.create(who(1), { route, destination: { lat: -33.5, lng: 149.6, label: 'Lookout' } });
  assert.ok(made.ok);
  if (!made.ok) return;
  assert.ok(rooms.join(made.value.code, who(2)).ok);
  assert.equal(rooms.setCruising(made.value.code, 'u2', true).ok, false);
  const cruising = rooms.setCruising(made.value.code, 'u1', true);
  assert.ok(cruising.ok);
  if (!cruising.ok) return;
  assert.equal(cruising.value.cruising, true);
  assert.equal(cruising.value.destination, null);
  assert.equal(cruising.value.route, null);
  assert.ok(rooms.setRestStop(made.value.code, 'u2', { lat: -33.42, lng: 149.52, label: 'Nearby servo' }).ok);
  const resumed = rooms.continueDestination(made.value.code, 'u1');
  assert.ok(resumed.ok);
  if (resumed.ok) {
    assert.equal(resumed.value.cruising, true);
    assert.equal(resumed.value.destination, null);
  }
});

test('automatic regroup waits for sustained fresh GPS separation, and is off by default', () => {
  const c = clock();
  const rooms = new Rooms(c.now);
  const route = { name: 'Mountain loop', stops: [[149.5, -33.4], [149.6, -33.5]] as [number, number][] };
  const made = rooms.create(who(1), { route, automaticRegroup: { enabled: true, separationM: 5_000 } });
  assert.ok(made.ok);
  if (!made.ok) return;
  const code = made.value.code;
  assert.deepEqual(made.value.automaticRegroup, { enabled: true, separationM: 5_000 });
  assert.ok(rooms.join(code, who(2)).ok);
  const send = (id: string, lat: number, lng: number) => rooms.position(id, { lat, lng, heading: null, speed: null })!;

  assert.deepEqual(send('u1', -33.4, 149.5).automaticRegroupCodes, []);
  c.t += POSITION_GAP_MS;
  assert.deepEqual(send('u2', -33.3, 149.5).automaticRegroupCodes, [], 'the first wide reading only starts the delay');
  for (let elapsed = 0; elapsed < AUTO_REGROUP_DELAY_MS; elapsed += 31_000) {
    c.t += 30_000;
    const first = send('u1', -33.4, 149.5);
    c.t += POSITION_GAP_MS;
    const out = send('u2', -33.3, 149.5);
    if (elapsed + 31_000 < AUTO_REGROUP_DELAY_MS) {
      assert.deepEqual(first.automaticRegroupCodes, []);
      assert.deepEqual(out.automaticRegroupCodes, []);
    } else {
      assert.deepEqual([...first.automaticRegroupCodes, ...out.automaticRegroupCodes], [code]);
    }
  }
  const regrouped = rooms.completeAutomaticRegroup(code, { lat: -33.35, lng: 149.52, label: 'Regroup stop' });
  assert.ok(regrouped.ok);
  if (regrouped.ok) {
    assert.equal(regrouped.value.resting, true);
    assert.equal(regrouped.value.destination?.label, 'Regroup stop');
  }
  c.t += POSITION_GAP_MS;
  assert.deepEqual(send('u1', -33.4, 149.5).automaticRegroupCodes, [], 'a resting convoy does not queue another regroup');

  const plain = rooms.create(who(3), { route });
  assert.ok(plain.ok);
  assert.deepEqual(plain.value.automaticRegroup, { enabled: false, separationM: 5_000 });
});

test('a convoy holds 30, and a user is in 3', () => {
  const rooms = new Rooms();
  const code = (rooms.create(who(0)) as { ok: true; value: { code: string } }).value.code;
  for (let i = 1; i < MAX_MEMBERS; i++) assert.ok(rooms.join(code, who(i)).ok, `member ${i + 1}`);
  const over = rooms.join(code, who(99));
  assert.equal(over.ok, false);
  assert.match((over as { error: string }).error, /full/);

  const mine = new Rooms();
  for (let i = 0; i < MAX_ROOMS_PER_USER; i++) assert.ok(mine.create(who(1)).ok);
  assert.equal(mine.create(who(1)).ok, false);
  const other = (mine.create(who(2)) as { ok: true; value: { code: string } }).value.code;
  assert.equal(mine.join(other, who(1)).ok, false, 'joining counts too');
});

test('positions are throttled to about one a second, and only the latest is kept', () => {
  const c = clock();
  const rooms = new Rooms(c.now);
  const code = (rooms.create(who(1)) as { ok: true; value: { code: string } }).value.code;
  rooms.join(code, who(2));
  const p = { lat: -33, lng: 151, heading: 90, speed: 12 };
  assert.ok(rooms.position('u1', p));
  c.t += 100;
  assert.equal(rooms.position('u1', { ...p, lat: -34 }), null, 'too soon');
  c.t += POSITION_GAP_MS;
  assert.ok(rooms.position('u1', { ...p, lat: -35 }));
  assert.equal(rooms.view(code)!.members.find((m) => m.id === 'u1')!.position?.lat, -35);
  assert.equal(rooms.position('stranger', p), null, 'not in a room');
});

test('going offline clears the position and keeps the member; leaving removes them and passes the lead on', () => {
  const c = clock();
  const rooms = new Rooms(c.now);
  const code = (rooms.create(who(1)) as { ok: true; value: { code: string } }).value.code;
  rooms.join(code, who(2));
  rooms.join(code, who(3));
  rooms.position('u2', { lat: 1, lng: 1, heading: null, speed: null });
  assert.deepEqual(rooms.setOnline('u2', false), [code]);
  const away = rooms.view(code)!.members.find((m) => m.id === 'u2')!;
  assert.equal(away.online, false);
  assert.equal(away.position, null);
  assert.equal(away.lastSeen, c.t);

  rooms.setOnline('u1', false);
  rooms.leave(code, 'u1');
  assert.equal(rooms.view(code)!.leader, 'u3', 'the lead goes to the longest-standing member who is connected');
  assert.equal(rooms.roomsOf('u1').length, 0);
  assert.equal(rooms.leave(code, 'u1'), undefined, 'leaving twice is nothing');
});

test('a room nobody is connected to expires, and a member who stays away too long goes', () => {
  const c = clock();
  const rooms = new Rooms(c.now);
  const a = (rooms.create(who(1)) as { ok: true; value: { code: string } }).value.code;
  const b = (rooms.create(who(2), { eventId: 'ev1' }) as { ok: true; value: { code: string } }).value.code;
  rooms.join(b, who(3));
  assert.equal(rooms.forEvent('ev1'), b);

  rooms.setOnline('u1', false);
  rooms.setOnline('u2', false);
  c.t += ROOM_IDLE_MS - 1000;
  assert.deepEqual(rooms.sweep(), { changed: [], gone: [] });
  c.t += 2000;
  const swept = rooms.sweep();
  assert.deepEqual(swept.gone, [a]);
  assert.deepEqual(swept.changed, [b]);
  assert.equal(rooms.view(a), undefined, 'idle room is gone');
  // The other room still had u3 connected, so only u2 (away for the grace period) was let go.
  assert.ok(rooms.view(b));
  assert.deepEqual(rooms.view(b)!.members.map((m) => m.id), ['u3']);
  assert.equal(rooms.view(b)!.leader, 'u3');
  assert.ok(MEMBER_GRACE_MS <= ROOM_IDLE_MS);

  rooms.setOnline('u3', false);
  c.t += ROOM_IDLE_MS + 1;
  assert.ok(rooms.sweep().gone.includes(b));
  assert.equal(rooms.forEvent('ev1'), undefined, 'the cruise can have a new convoy');
});

test('a cruise has one convoy', () => {
  const rooms = new Rooms();
  assert.ok(rooms.create(who(1), { eventId: 'ev1' }).ok);
  assert.equal(rooms.create(who(2), { eventId: 'ev1' }).ok, false);
});

test('the leader can put someone out, and the code does not bring them back', () => {
  const rooms = new Rooms();
  const code = (rooms.create(who(1)) as { ok: true; value: { code: string } }).value.code;
  rooms.join(code, who(2));
  rooms.join(code, who(3));
  assert.equal(rooms.remove(code, 'u2', 'u3').ok, false, 'not the leader');
  assert.equal(rooms.remove(code, 'u1', 'u1').ok, false, 'not yourself');
  assert.equal(rooms.remove(code, 'u1', 'nobody').ok, false);
  const out = rooms.remove(code, 'u1', 'u2');
  assert.ok(out.ok);
  assert.deepEqual(rooms.view(code)!.members.map((m) => m.id), ['u1', 'u3']);
  const back = rooms.join(code, who(2));
  assert.equal(back.ok, false);
  assert.match((back as { error: string }).error, /removed you/);
  assert.equal(rooms.roomsOf('u2').length, 0);
});

test('removeUser takes someone out of every convoy', () => {
  const rooms = new Rooms();
  const a = (rooms.create(who(1)) as { ok: true; value: { code: string } }).value.code;
  const b = (rooms.create(who(2)) as { ok: true; value: { code: string } }).value.code;
  rooms.join(a, who(3));
  rooms.join(b, who(3));
  assert.deepEqual(rooms.removeUser('u3').sort(), [a, b].sort());
  assert.equal(rooms.roomsOf('u3').length, 0);
});

test('wrong codes are counted per account and blocked after ten', () => {
  const c = clock();
  const limiter = new MissLimiter(c.now);
  for (let i = 0; i < 10; i++) { assert.equal(limiter.blocked('u1'), false); limiter.miss('u1'); }
  assert.equal(limiter.blocked('u1'), true);
  assert.equal(limiter.blocked('u2'), false);
  c.t += 10 * 60_000 + 1;
  assert.equal(limiter.blocked('u1'), false);
});

test('every client message is checked, and unlisted fields are dropped', () => {
  const ok = (m: unknown) => parseClientMessage(JSON.stringify(m));
  assert.deepEqual(ok({ t: 'pos', lat: 1, lng: 2, speed: 3, extra: 'x' }), { ok: true, message: { t: 'pos', lat: 1, lng: 2, heading: null, speed: 3 } });
  assert.deepEqual(ok({ t: 'convoy.join', code: 'abcd efgh' }), { ok: true, message: { t: 'convoy.join', code: 'ABCDEFGH' } });
  assert.deepEqual(ok({ t: 'convoy.dest', room: 'R', destination: null }), { ok: true, message: { t: 'convoy.dest', room: 'R', destination: null } });
  assert.deepEqual(ok({ t: 'convoy.rest', room: 'R', action: 'find' }), { ok: true, message: { t: 'convoy.rest', room: 'R', action: 'find' } });
  assert.deepEqual(ok({ t: 'convoy.mode', room: 'R', cruising: true }), { ok: true, message: { t: 'convoy.mode', room: 'R', cruising: true } });
  assert.deepEqual(ok({ t: 'convoy.create', name: 'Run', automaticRegroup: { enabled: true, separationM: 7_000 } }), { ok: true, message: { t: 'convoy.create', name: 'Run', automaticRegroup: { enabled: true, separationM: 7_000 } } });
  for (const bad of [
    'not json', '[]', '7', '{}', { t: 7 }, { t: 'nope' },
    { t: 'pos', lat: 91, lng: 0 }, { t: 'pos', lat: 0, lng: 181 }, { t: 'pos', lat: '1', lng: 0 }, { t: 'pos', lat: null, lng: 0 },
    { t: 'pos', lat: 0, lng: 0, speed: -1 }, { t: 'pos', lat: 0, lng: 0, speed: 1e6 }, { t: 'pos', lat: 0, lng: 0, heading: 361 },
    { t: 'pos', lat: Number.NaN, lng: 0 },
    { t: 'convoy.join', code: 'short' }, { t: 'convoy.join', code: 'ABCDEFG0' }, { t: 'convoy.join' },
    { t: 'convoy.create', name: 'x'.repeat(41) }, { t: 'convoy.create', name: 5 },
    { t: 'convoy.create', name: 'Run', automaticRegroup: { enabled: true, separationM: 999 } }, { t: 'convoy.create', name: 'Run', automaticRegroup: { enabled: 'yes', separationM: 5_000 } },
    { t: 'convoy.mode', room: 'R', cruising: 'yes' },
    { t: 'convoy.dest', room: 'R', destination: { lat: 0, lng: 0, label: 'x'.repeat(81) } }, { t: 'convoy.dest', room: 'R', destination: 'home' },
    { t: 'convoy.lead', room: 'R' }, { t: 'convoy.cruise', eventId: '' },
  ]) {
    assert.equal(ok(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(parseClientMessage('{"t":"pos","lat":NaN}').ok, false);
});
