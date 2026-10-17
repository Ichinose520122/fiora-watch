import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createApp } from '../src/server.js';
import { signTicket } from '../src/auth.js';

test('Bilibili binding is admin-only, same-origin and exposes a local QR image instead of credentials', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-account-api-'));
  const config = { secret: 'test-secret-01234567890123456789012345', audience: 'http://localhost:9300', issuer: 'https://chat.example.com', dataDir: root, libraryDir: path.join(root, 'library'), hosts: [] };
  let owner; let cancelled; let removed = false;
  const instance = createApp(config, { account: {
    cookieHeader: () => 'SESSDATA=hidden', publicStatus: async () => ({ connected: false }),
    start: async id => { owner = id; return { id: 'flow', qrUrl: 'https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=secret', expiresAt: Date.now() + 180000 }; },
    poll: async (id, flow) => { assert.equal(id, owner); assert.equal(flow, 'flow'); return { status: 'waiting' }; },
    remove: async () => { removed = true; }, cancel: id => { cancelled = id; },
  } });
  const server = instance.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { instance.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`; let cookie = '';
  const call = (url, body, origin = config.audience) => fetch(base + url, { method: body ? 'POST' : 'GET', headers: { Origin: origin, Cookie: cookie, 'X-Watch-Request': '1', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await call('/api/bilibili/account')).status, 401);
  for (const admin of [false, true]) {
    const now = Math.floor(Date.now() / 1000);
    const response = await call('/api/session', { ticket: signTicket({ v: 1, iss: config.issuer, aud: config.audience, iat: now, exp: now + 60, jti: (admin ? '2' : '1').repeat(32), sub: 'a'.repeat(24), room: 'b'.repeat(24), name: 'test', canControl: true, admin }, config.secret) });
    cookie = response.headers.get('set-cookie').split(';')[0];
    assert.equal((await call('/api/bilibili/account')).status, admin ? 200 : 403);
    if (!admin) for (const route of ['login', 'poll', 'logout', 'refresh']) assert.equal((await call(`/api/bilibili/account/${route}`, {})).status, 403);
  }
  assert.equal((await call('/api/bilibili/account/login', {}, 'https://evil.example')).status, 403);
  const login = await (await call('/api/bilibili/account/login', {})).json();
  assert.match(login.qrImage, /^data:image\/png;base64,/); assert.equal(login.qrUrl, undefined);
  assert.equal(JSON.stringify(login).includes('SESSDATA'), false);
  assert.equal((await (await call('/api/bilibili/account/poll', { id: login.id })).json()).status, 'waiting');
  assert.equal((await call('/api/bilibili/account/logout', {})).status, 200); assert.equal(removed, true);
  await call('/api/logout', {}); assert.equal(cancelled, owner);
});

test('Bilibili proxy scopes tracks to the room/version and never exposes upstream URLs', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-proxy-'));
  const room = 'b'.repeat(24); const secret = 'test-only-secret-01234567890123456789';
  const config = { secret, audience: 'http://localhost:9300', issuer: 'https://chat.example.com', dataDir: root, libraryDir: path.join(root, 'library'), hosts: [] };
  const updates = [];
  const media = { kind: 'dash', title: '番名 · P2', seriesTitle: '番名', cover: 'https://i0.hdslb.com/cover.jpg', source: 'https://www.bilibili.com/video/BV1xx411c7mD/?p=2', bilibili: {
    duration: 10, tracks: ['video', 'audio'].map(type => ({ id: type, type, url: 'https://example.bilivideo.com/private.m4s?secret=hidden', mimeType: `${type}/mp4`, codecs: type === 'video' ? 'avc1.64001E' : 'mp4a.40.2', bandwidth: 100, width: 640, height: 360, indexRange: '10-19', initialization: '0-9' })),
  } };
  const instance = createApp(config, { resolve: async () => structuredClone(media), chat: async (_grant, update) => { updates.push(update); return { updated: true }; }, requestTrack: async (_track, range) => {
    assert.equal(range, 'bytes=2-5');
    const response = Readable.from(['2345']); response.statusCode = 206; response.headers = { 'content-range': 'bytes 2-5/10', 'content-length': '4' }; return { response };
  } });
  const server = instance.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { instance.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`; let cookie = '';
  const call = (url, body, headers = {}) => fetch(base + url, { method: body ? 'POST' : 'GET', headers: { Origin: config.audience, Cookie: cookie, 'X-Watch-Request': '1', 'Content-Type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const now = Math.floor(Date.now() / 1000);
  const login = await call('/api/session', { ticket: signTicket({ v: 1, iss: config.issuer, aud: config.audience, iat: now, exp: now + 60, jti: '1'.repeat(32), sub: 'a'.repeat(24), room, name: 'demo', canControl: true, admin: true }, secret) });
  cookie = login.headers.get('set-cookie').split(';')[0];
  await call('/api/settings/playback', { bilibiliDelivery: 'proxy' });
  assert.equal((await call('/api/media?room=' + room, { mode: 'online', url: media.source, revision: 0 })).status, 200);
  assert.equal(updates[0].action, 'media'); assert.equal(updates[0].title, '番名');
  const state = await (await call('/api/state?room=' + room)).json();
  assert.equal(JSON.stringify(state).includes('hidden'), false); assert.equal(state.media.bilibili, undefined);
  assert.match(await (await call(state.media.url)).text(), /indexRange="10-19"/);
  const track = `/api/bilibili/track?room=${room}&version=1&track=0`;
  const partial = await call(track, undefined, { Range: 'bytes=2-5' });
  assert.equal(partial.status, 206); assert.equal(await partial.text(), '2345');
  assert.equal((await call(track.replace('version=1', 'version=0'))).status, 404);
  assert.equal((await call(track.replace(room, 'c'.repeat(24)))).status, 403);
});
