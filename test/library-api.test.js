import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server.js';
import { signTicket } from '../src/auth.js';

test('library deletion requires an administrator and same-origin request, validates a whole selection, and preserves mounts', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-library-api-'));
  const config = { secret: 'test-only-secret-012345678901234567890', audience: 'http://localhost:9300', issuer: 'https://chat.example.com', dataDir, libraryDir: path.join(dataDir, 'library'), hosts: ['cdn.example.com'], cacheBytes: 10000, maxDownloadBytes: 10000 };
  const instance = createApp(config, { chat: async () => ({}) });
  const server = instance.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { instance.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`; const room = 'b'.repeat(24);
  const call = (url, cookie = '', body, headers = {}) => fetch(base + url, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: config.audience, 'X-Watch-Request': '1', 'X-Watch-Room': room, Cookie: cookie, 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const login = async admin => {
    const now = Math.floor(Date.now() / 1000);
    const response = await call('/api/session', '', { ticket: signTicket({ v: 1, iss: config.issuer, aud: config.audience, iat: now, exp: now + 60, jti: randomUUID().replaceAll('-', ''), sub: (admin ? 'a' : 'c').repeat(24), room, name: 'test', admin, canControl: admin }, config.secret) });
    assert.equal(response.status, 200); return response.headers.get('set-cookie').split(';')[0];
  };
  const admin = await login(true); const viewer = await login(false); const ids = [randomUUID(), randomUUID()];
  for (const id of ids) {
    instance.store.data.jobs.push({ id, status: 'done', title: '番剧', seriesTitle: '番剧', kind: 'mp4' });
    const directory = path.join(dataDir, 'media', id); fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'video.mp4'), id);
  }
  fs.writeFileSync(path.join(config.libraryDir, 'mounted.mp4'), 'keep'); instance.store.save();
  const selected = { ids: ids.map(id => `download:${id}`) };
  assert.equal((await call('/api/library/remove', '', selected)).status, 401);
  assert.equal((await call('/api/library/remove', viewer, selected)).status, 403);
  assert.equal((await call('/api/library/remove', admin, selected, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('/api/library/remove', admin, selected, { 'X-Watch-Request': '' })).status, 403);
  assert.equal((await call('/api/library/remove', admin, { ids: [selected.ids[0], 'local:mounted.mp4'] })).status, 400);
  instance.store.data.rooms.anotherRoom = { media: { id: selected.ids[1] }, paused: true };
  assert.equal((await call('/api/library/remove', admin, selected)).status, 400);
  assert.equal(instance.store.data.jobs.length, 2);
  for (const id of ids) assert.ok(fs.existsSync(path.join(dataDir, 'media', id, 'video.mp4')));
  const listing = await (await call('/api/library', viewer)).json();
  assert.equal(listing.items.find(item => item.id === selected.ids[1]).removable, false);
  assert.equal(listing.items.find(item => item.id === 'local:mounted.mp4').readOnly, true);
  instance.store.data.rooms.anotherRoom.media = null;
  const response = await call('/api/library/remove', admin, selected); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { removed: 2, ids: selected.ids }); assert.equal(instance.store.data.jobs.length, 0);
  for (const id of ids) assert.equal(fs.existsSync(path.join(dataDir, 'media', id)), false);
  assert.equal(fs.readFileSync(path.join(config.libraryDir, 'mounted.mp4'), 'utf8'), 'keep');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'))).jobs.length, 0);
});
