import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp, type Client } from './httpHarness.js';

const app = await startApp();
after(() => app.close());

const alice = app.client();
const bob = app.client();
const anon = app.client();
await app.signIn(alice, 'google', { id: '111', name: 'Alice' });
await app.signIn(bob, 'google', { id: '222', name: 'Bob' });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const routeInput = (visibility: 'private' | 'public') => ({
  name: `${visibility} photo route`,
  vertices: [[151.2, -33.8], [151.3, -33.7]],
  visibility,
});

async function upload(as: Client | null, routeId: string): Promise<Response> {
  const form = new FormData();
  form.append('photo', new Blob([new Uint8Array(PNG)]), 'route.png');
  form.append('thumb', new Blob([new Uint8Array(PNG)]), 'route-thumb.png');
  form.append('caption', 'First corner');
  const cookie = as?.jar.get('__Host-ps_session');
  return fetch(`${app.base}/api/routes/${routeId}/photos`, {
    method: 'POST',
    headers: cookie ? { Cookie: `__Host-ps_session=${cookie}` } : {},
    body: form,
  });
}

test('route photos follow route visibility and only owners may change them', async () => {
  const publicRoute = (await alice('POST', '/api/routes', routeInput('public'))).json;
  const privateRoute = (await alice('POST', '/api/routes', routeInput('private'))).json;

  const added = await upload(alice, publicRoute.id);
  assert.equal(added.status, 201);
  const photo = await added.json() as { id: string; routeId: string; caption: string; url: string; thumbUrl: string };
  assert.equal(photo.routeId, publicRoute.id);
  assert.equal(photo.caption, 'First corner');

  const listed = await anon('GET', `/api/routes/${publicRoute.id}/photos`);
  assert.equal(listed.status, 200);
  assert.equal(listed.json.length, 1);
  assert.equal((await anon('GET', photo.url)).status, 200);
  assert.equal((await anon('GET', photo.thumbUrl)).status, 200);

  assert.equal((await upload(bob, publicRoute.id)).status, 403);
  assert.equal((await upload(null, publicRoute.id)).status, 401);
  assert.equal((await anon('GET', `/api/routes/${privateRoute.id}/photos`)).status, 404);

  const privatePhoto = await upload(alice, privateRoute.id);
  assert.equal(privatePhoto.status, 201);
  const privatePayload = await privatePhoto.json() as { url: string };
  assert.equal((await anon('GET', privatePayload.url)).status, 404);

  assert.equal((await bob('DELETE', `/api/route-photos/${photo.id}`)).status, 403);
  assert.equal((await alice('DELETE', `/api/route-photos/${photo.id}`)).status, 200);
});

test('deleting a route deletes its route photos from disk', async () => {
  const route = (await alice('POST', '/api/routes', routeInput('private'))).json;
  const added = await upload(alice, route.id);
  assert.equal(added.status, 201);
  await added.json();

  const before = fs.readdirSync(path.join(app.dataDir, 'photos'));
  assert.ok(before.length >= 2);
  assert.equal((await alice('DELETE', `/api/routes/${route.id}`)).status, 200);
  const after = fs.readdirSync(path.join(app.dataDir, 'photos'));
  assert.equal(after.length, before.length - 2);
});
