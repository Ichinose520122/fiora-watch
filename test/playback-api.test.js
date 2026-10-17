import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { createApp } from '../src/server.js';
import { signTicket } from '../src/auth.js';

const room = 'b'.repeat(24);
const media = { source: 'https://www.bilibili.com/video/BV1v2Ht6cERH/', kind: 'dash', title: 'Video', bilibili: { bvid: 'BV1v2Ht6cERH', cid: 42493413237, duration: 87, tracks: ['video', 'audio'].map(type => ({ id: `${type}-0`, type, quality: 80, url: `https://example.bilivideo.com/${type}.m4s?secret=private`, mimeType: `${type}/mp4`, codecs: type === 'video' ? 'avc1.64001E' : 'mp4a.40.2', bandwidth: 100000, width: 1080, height: 1920, initialization: '0-99', indexRange: '100-199' })) } };
async function fixture(t, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-playback-'));
  const config = { secret: 'test-only-secret-012345678901234567890', audience: 'http://localhost:9300', issuer: 'https://chat.example.com', dataDir, libraryDir: path.join(dataDir, 'library'), hosts: ['cdn.example.com'], cacheBytes: 10000, maxDownloadBytes: 10000 };
  let listCalls = 0; let fileCalls = 0;
  const instance = createApp(config, {
    resolve: async () => structuredClone(media), chat: async () => ({}),
    listSubtitles: async () => { listCalls++; return { status: 'available', subtitles: [{ id: 'subtitle-1', label: '中文（AI）', language: 'zh-CN', url: 'https://aisubtitle.hdslb.com/bfs/ai_subtitle/private.json?token=hidden' }] }; },
    fetchSubtitle: async track => { fileCalls++; assert.equal(track.id, 'subtitle-1'); return 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n字幕\n'; },
    requestTrack: async () => { const response = Readable.from(['video']); response.statusCode = 206; response.headers = { 'content-length': '5' }; return { response }; },
    ...overrides,
  });
  const server = instance.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { instance.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (url, cookie, body, headers = {}) => fetch(base + url, { redirect: 'manual', method: body === undefined ? 'GET' : 'POST', headers: { Origin: config.audience, 'X-Watch-Request': '1', 'X-Watch-Room': room, 'Content-Type': 'application/json', Cookie: cookie || '', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const login = async admin => {
    const now = Math.floor(Date.now() / 1000);
    const response = await call('/api/session', '', { ticket: signTicket({ v: 1, iss: config.issuer, aud: config.audience, iat: now, exp: now + 60, jti: randomUUID().replaceAll('-', ''), sub: (admin ? 'a' : 'c').repeat(24), room, name: 'test', admin, canControl: admin }, config.secret) });
    return response.headers.get('set-cookie').split(';')[0];
  };
  return { instance, call, config, login, counts: () => ({ listCalls, fileCalls }) };
}

test('delivery setting requires admin/CSRF, persists and applies only to the next media selection', async t => {
  const { instance, call, config, login } = await fixture(t); const admin = await login(true); const viewer = await login(false);
  assert.equal((await call('/api/settings/playback', viewer)).status, 403);
  assert.equal((await call('/api/settings/playback', viewer, { bilibiliDelivery: 'direct' })).status, 403);
  assert.equal((await call('/api/settings/playback', admin, { bilibiliDelivery: 'direct' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('/api/settings/playback', admin, { bilibiliDelivery: 'evil' })).status, 400);
  await call('/api/media', admin, { mode: 'online', url: media.source, revision: 0 });
  let state = await (await call('/api/state', viewer)).json();
  assert.equal(state.media.playbackMode, 'proxy'); assert.equal(state.position, 0); assert.equal(state.paused, true);
  await call('/api/settings/playback', admin, { bilibiliDelivery: 'direct' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(config.dataDir, 'state.json'))).settings.bilibiliDelivery, 'direct');
  assert.equal((await (await call('/api/state', viewer)).json()).media.playbackMode, 'proxy');
  await call('/api/control', admin, { action: 'seek', position: 70, revision: 1 });
  await call('/api/media', admin, { mode: 'online', url: media.source + '?t=70', revision: 2 });
  state = await (await call('/api/state', viewer)).json();
  assert.equal(state.media.playbackMode, 'direct'); assert.equal(state.position, 0);
  assert.equal(state.paused, true); assert.equal(state.media.qualities[0].label, '1080P');
  assert.doesNotMatch(JSON.stringify(state), /secret=private|bilibili":|login_mid/);
  const manifest = await (await call(state.media.url, viewer)).text(); assert.match(manifest, /delivery=direct/);
  const directPath = `/api/bilibili/track?room=${room}&version=3&track=0&delivery=direct`;
  const direct = await call(directPath, viewer); assert.equal(direct.status, 302); assert.equal(direct.headers.get('location'), media.bilibili.tracks[0].url);
  assert.equal((await call(directPath, '')).status, 401);
  assert.equal((await call(directPath.replace(room, 'd'.repeat(24)), viewer, undefined, { 'X-Watch-Room': 'd'.repeat(24) })).status, 403);
  assert.equal((await call(directPath.replace('version=3', 'version=1'), viewer)).status, 404);
  const fallback = await (await call(state.media.fallbackUrl, viewer)).text(); assert.doesNotMatch(fallback, /delivery=direct/);
  assert.equal((await call(directPath.replace('direct', 'proxy'), viewer)).status, 206);
  assert.equal(instance.store.room(room).position, 0);
});

test('subtitle routes hide upstream URLs, share bounded cache, enforce room/version/track and preserve playback', async t => {
  const { instance, call, login, counts } = await fixture(t); const cookie = await login(true);
  await call('/api/media', cookie, { mode: 'online', url: media.source, revision: 0 });
  const listUrl = `/api/bilibili/subtitles?room=${room}&version=1`;
  const [one, two] = await Promise.all([call(listUrl, cookie), call(listUrl, cookie)]);
  const result = await one.json(); await two.json();
  assert.equal(result.status, 'available'); assert.equal(result.subtitles.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /aisubtitle|token=hidden/);
  const fileUrl = result.subtitles[0].url;
  const response = await call(fileUrl, cookie); assert.match(response.headers.get('content-type'), /text\/vtt/); assert.match(await response.text(), /WEBVTT/);
  await call(fileUrl, cookie); assert.deepEqual(counts(), { listCalls: 1, fileCalls: 1 });
  assert.equal((await call(fileUrl.replace('id=subtitle-1', 'id=wrong'), cookie)).status, 404);
  assert.equal((await call(fileUrl.replace('id=subtitle-1', 'id=../../private'), cookie)).status, 404);
  assert.equal((await call(listUrl, cookie, undefined, { 'X-Watch-Room': 'd'.repeat(24) })).status, 403);
  assert.equal(instance.store.room(room).position, 0); assert.equal(instance.store.room(room).revision, 1);
  await call('/api/media', cookie, { mode: 'clear', revision: 1 });
  assert.equal((await call(fileUrl, cookie)).status, 404);
});

test('slow subtitle responses cannot escape after a media switch', async t => {
  let release; let started;
  const ready = new Promise(resolve => { started = resolve; });
  const { call, login } = await fixture(t, { listSubtitles: () => { started(); return new Promise(resolve => { release = resolve; }); } });
  const cookie = await login(true); await call('/api/media', cookie, { mode: 'online', url: media.source, revision: 0 });
  const pending = call(`/api/bilibili/subtitles?room=${room}&version=1`, cookie); await ready;
  await call('/api/media', cookie, { mode: 'clear', revision: 1 });
  release({ status: 'none', subtitles: [] }); assert.equal((await pending).status, 409);
});
