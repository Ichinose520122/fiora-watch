import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { createApp } from '../src/server.js';
import { signTicket } from '../src/auth.js';
import { socialSource } from '../src/social.js';

const room = 'b'.repeat(24);

test('HLS warms later segments for active viewers, serves them from disk and stops at five minutes', async t => {
  const selected = { source: 'https://cdn.example.com/example', kind: 'hls', title: 'Example', url: 'https://cdn.example.com/movie.m3u8' };
  const reads = new Map();
  const { call, login } = await fixture(t, {
    resolve: async () => selected,
    requestMedia: async url => {
      reads.set(url, (reads.get(url) || 0) + 1);
      const manifest = url.endsWith('.m3u8');
      const data = manifest ? '#EXTM3U\n' + Array.from({ length: 8 }, (_, i) => '#EXTINF:61,\n' + i + '.ts\n').join('') + '#EXT-X-ENDLIST' : 'segment';
      const response = Readable.from([Buffer.from(data)]);
      response.statusCode = 200;
      response.headers = { 'content-length': String(Buffer.byteLength(data)), 'content-type': manifest ? 'application/vnd.apple.mpegurl' : 'video/mp2t' };
      return { url, response };
    },
  });
  const admin = await login(true);
  await call('/api/settings/playback', admin, { delivery: 'proxy' });
  await call('/api/media', admin, { mode: 'online', url: selected.source, revision: 0 });
  const events = await call('/api/events', admin);
  try {
    const state = await (await call('/api/state', admin)).json();
    const manifest = await (await call(state.media.url, admin)).text();
    const paths = manifest.split('\n').filter(line => line.startsWith('/api/'));
    assert.equal(await (await call(paths[0], admin)).text(), 'segment');
    await waitForCached(call, admin, 'online', 5);
    for (let n = 0; n < 5; n++) assert.equal(reads.get('https://cdn.example.com/' + n + '.ts'), 1);
    assert.equal(reads.has('https://cdn.example.com/5.ts'), false);
    assert.equal(await (await call(paths[3], admin)).text(), 'segment');
    assert.equal(reads.get('https://cdn.example.com/3.ts'), 1);
    await call('/api/settings/playback', admin, { prefetch: false });
    await call('/api/control', admin, { action: 'seek', position: 305, revision: 1 });
    await (await call(paths[5], admin)).arrayBuffer();
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(reads.has('https://cdn.example.com/6.ts'), false);
  } finally { await events.body.cancel(); }
});

test('MP4 preserves open-ended responses and warms subsequent finite ranges', async t => {
  const url = 'https://cdn.example.com/movie.mp4';
  const file = Buffer.alloc(131072, 42);
  const reads = [];
  const { call, login } = await fixture(t, {
    resolve: async () => ({ source: url, url, kind: 'mp4', title: 'Movie' }),
    requestMedia: async (_url, _hosts, _signal, options) => {
      const range = options.headers.Range;
      reads.push(range);
      const [, first, last] = /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = Number(first), end = last ? Number(last) : file.length - 1;
      const response = Readable.from([file.subarray(start, end + 1)]);
      response.statusCode = 206;
      response.headers = { 'content-length': String(end - start + 1), 'content-type': 'video/mp4', 'content-range': 'bytes ' + start + '-' + end + '/' + file.length };
      return { url, response };
    },
  });
  const admin = await login(true);
  await call('/api/settings/playback', admin, { delivery: 'proxy' });
  await call('/api/media', admin, { mode: 'online', url, revision: 0 });
  const events = await call('/api/events', admin);
  try {
    const { media } = await (await call('/api/state', admin)).json();
    const read = range => call(media.url, admin, undefined, { Range: range });
    const open = await read('bytes=65536-');
    assert.equal(open.status, 206);
    assert.equal(open.headers.get('content-range'), 'bytes 65536-131071/131072');
    assert.deepEqual(Buffer.from(await open.arrayBuffer()), file.subarray(65536));
    assert.deepEqual(reads, ['bytes=65536-']);
    await (await read('bytes=0-32767')).arrayBuffer();
    await waitForCached(call, admin, 'online', 5);
    assert.deepEqual(reads.slice(1), ['bytes=0-32767', 'bytes=32768-65535', 'bytes=65536-98303', 'bytes=98304-131071']);
    assert.deepEqual(Buffer.from(await (await read('bytes=32768-65535')).arrayBuffer()), file.subarray(32768, 65536));
    assert.equal(reads.length, 5);
  } finally { await events.body.cancel(); }
});

async function waitForCached(call, admin, provider, count) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const settings = await (await call('/api/settings/playback', admin)).json();
    if (settings.cacheUsage[provider].entries >= count) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail('Speculative data did not reach the disk cache');
}

for (const provider of ['youtube', 'bilibili']) {
  test(provider + ' DASH warms the exact upcoming ranges of both selected tracks', async t => {
    const index = Buffer.alloc(68);
    index.writeUInt32BE(index.length); index.write('sidx', 4); index.writeUInt32BE(1, 16); index.writeUInt16BE(3, 30);
    for (let i = 32; i < index.length; i += 12) { index.writeUInt32BE(16, i); index.writeUInt32BE(120, i + 4); }
    const reads = [];
    const get = (url, range) => {
      reads.push([url, range]);
      const data = range === 'bytes=0-67' ? index : Buffer.alloc(16, 42);
      const response = Readable.from([data]); response.statusCode = 206;
      response.headers = { 'content-range': range.replace('=', ' ') + '/116', 'content-length': String(data.length), 'content-type': 'video/mp4' };
      return { response, url };
    };
    const tracks = media.bilibili.tracks.map(track => ({ ...track, url: 'https://r.googlevideo.com/' + track.type }));
    const { call, login } = await fixture(t, { resolve: async () => provider === 'youtube'
      ? { title: 'test', provider, kind: 'dash', youtubeDash: { duration: 360, tracks } } : structuredClone(media),
      requestTrack: async (track, range) => get(track.url, range),
      requestMedia: async (url, _hosts, _signal, options) => get(url, options.headers.Range) });
    const admin = await login(true);
    await call('/api/settings/playback', admin, { delivery: 'proxy' });
    await call('/api/media', admin, { mode: 'online', revision: 0, url: 'fixture' });
    const events = await call('/api/events', admin);
    try {
      const state = await (await call('/api/state', admin)).json();
      const manifest = await (await call(state.media.url, admin)).text();
      const paths = [...manifest.matchAll(/<BaseURL>(.*?)<\/BaseURL>/g)].map(m => m[1].replaceAll('&amp;', '&'));
      assert.equal(paths.length, 2);
      for (const url of paths) for (const range of ['bytes=0-67', 'bytes=68-83']) {
        assert.equal((await (await call(url, admin, undefined, { Range: range })).arrayBuffer()).byteLength, range === 'bytes=0-67' ? 68 : 16);
      }
      await waitForCached(call, admin, provider === 'youtube' ? 'online' : provider, 8);
      assert.equal(reads.length, 8);
      for (const url of paths) await (await call(url, admin, undefined, { Range: 'bytes=84-99' })).arrayBuffer();
      assert.equal(reads.length, 8);
    } finally { await events.body.cancel(); }
  });
}

test('a room remembers YouTube delivery per video across selections and alternate links', async t => {
  const { call, login } = await fixture(t, { resolve: async url => ({
    ...socialSource(url), kind: 'mp4', url: 'https://r.googlevideo.com/movie.mp4', title: 'Test',
  }) });
  const owner = await login(true), viewer = await login(false);
  let revision = 0;
  async function choose(url, youtubeDelivery) {
    const response = await call('/api/media', owner, { mode: 'online', url, youtubeDelivery, revision });
    assert.equal(response.status, 200);
    const state = await (await call('/api/state', viewer)).json();
    revision = state.revision;
    return state.media;
  }
  const a = 'https://youtu.be/jNQXAC9IVRw', b = 'https://youtu.be/aqz-KE-bKQ0';
  assert.match((await choose(a, 'proxy')).url, /^\/api\/media\/relay/);
  assert.equal((await choose(b, 'direct')).playbackMode, 'direct');
  await call('/api/settings/playback', owner, { delivery: 'proxy' });
  assert.equal((await choose(b)).playbackMode, 'direct');
  await call('/api/settings/playback', owner, { delivery: 'direct' });
  assert.equal((await choose('https://www.youtube.com/watch?v=jNQXAC9IVRw')).playbackMode, 'proxy');
  assert.equal((await choose(a, 'default')).playbackMode, 'direct');
});

test('YouTube DASH keeps tracks scoped to the room, media revision and selected delivery', async t => {
  const youtubeDash = { duration: 120, tracks: [
    { id: 'video', type: 'video', width: 1920, height: 1080, codecs: 'avc1.640028', bandwidth: 2000000, url: 'https://r.googlevideo.com/v' },
    { id: 'audio', type: 'audio', codecs: 'mp4a.40.2', bandwidth: 128000, url: 'https://r.googlevideo.com/a' },
  ] };
  const { call, login } = await fixture(t, { resolve: async () => ({ provider: 'youtube', kind: 'dash', title: 'Example', youtubeDash }) });
  const admin = await login(true); const viewer = await login(false);
  await call('/api/media', admin, { mode: 'online', url: 'https://youtu.be/jNQXAC9IVRw', revision: 0 });
  const { media } = await (await call('/api/state', viewer)).json();
  assert.equal(media.youtubeDash, undefined);
  assert.equal((await call(media.url, '')).status, 401);
  const direct = await (await call(media.url, viewer)).text();
  assert.match(direct, /r\.googlevideo\.com\/v/);
  assert.match(direct, /r\.googlevideo\.com\/a/);
  const proxy = await (await call(media.fallbackUrl, viewer)).text();
  assert.doesNotMatch(proxy, /googlevideo/);
  assert.match(proxy, /resource=video/);
  assert.match(proxy, /resource=audio/);
  assert.equal((await call(media.url.replace('version=1', 'version=0'), viewer)).status, 404);
  assert.equal((await call(media.url.replace(room, 'f'.repeat(24)), viewer, undefined, { 'X-Watch-Room': 'f'.repeat(24) })).status, 403);
});

test('only same-origin administrators can bind or remove the YouTube session', async t => {
  const { call, login } = await fixture(t, { youtubeAccount: {
    status: () => ({ saved: false }), bind: () => ({ saved: true }), remove: () => ({ saved: false }),
  } });
  const viewer = await login(false); const admin = await login(true);
  const url = '/api/youtube/account';
  assert.equal((await call(url, '')).status, 401);
  assert.equal((await call(url, viewer)).status, 403);
  assert.equal((await call(url, viewer, {})).status, 403);
  assert.equal((await call(url + '/logout', viewer, {})).status, 403);
  assert.equal((await call(url, admin, {}, { Origin: 'https://other.example' })).status, 403);
  assert.deepEqual(await (await call(url, admin, { cookies: 'fixture' })).json(), { saved: true });
  assert.deepEqual(await (await call(url + '/logout', admin, {})).json(), { saved: false });
});

test('per-provider cache settings validate, persist and require administrator origin checks', async t => {
  const { call, login, config } = await fixture(t);
  const admin = await login(true); const viewer = await login(false);
  const initial = await (await call('/api/settings/playback', admin)).json();
  assert.equal(initial.relayCache.bilibili.maxGiB, 1);
  assert.equal(initial.relayCache.girigiri.maxGiB, 2);
  const update = { relayCache: { bilibili: { enabled: false, maxGiB: 0.5, ttlHours: 2 }, girigiri: { enabled: true, maxGiB: 3, ttlHours: 12 } } };
  assert.equal((await call('/api/settings/playback', viewer, update)).status, 403);
  assert.equal((await call('/api/settings/playback', admin, update, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('/api/settings/playback', admin, update)).status, 200);
  const persisted = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'state.json'))).settings;
  assert.deepEqual(persisted.relayCache, { ...update.relayCache, online: initial.relayCache.online });
  for (const bad of [{ bilibili: { maxGiB: 0 } }, { girigiri: { ttlHours: 169 } }, { bilibili: { enabled: 'yes' } }, { other: {} }]) {
    assert.equal((await call('/api/settings/playback', admin, { relayCache: bad })).status, 400);
  }
  await call('/api/settings/playback', admin, { delivery: 'proxy' });
  const result = await (await call('/api/settings/playback', admin)).json();
  assert.deepEqual(result.relayCache, persisted.relayCache);
  assert.equal(result.delivery, 'proxy');
});

test('Bilibili caches exact ranges behind room authentication and bypasses immediately when disabled', async t => {
  let reads = 0;
  const { call, login } = await fixture(t, { requestTrack: async (_track, range) => {
    reads++; const start = Number(range.slice(6).split('-')[0]);
    const response = Readable.from(['data']); response.statusCode = 206;
    response.headers = { 'content-length': '4', 'content-range': `bytes ${start}-${start + 3}/100`, 'content-type': 'video/mp4' };
    return { response };
  } });
  const admin = await login(true);
  await call('/api/media', admin, { mode: 'online', url: media.source, revision: 0 });
  const url = `/api/bilibili/track?room=${room}&version=1&track=0&delivery=proxy`;
  for (let i = 0; i < 2; i++) {
    const response = await call(url, admin, undefined, { Range: 'bytes=0-3' });
    assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), 'bytes 0-3/100'); assert.equal(await response.text(), 'data');
  }
  assert.equal(reads, 1);
  assert.equal((await call(url, '')).status, 401);
  assert.equal((await call(url.replace('version=1', 'version=0'), admin)).status, 404);
  assert.equal((await call(url, admin, undefined, { Range: 'bytes=3-0' })).status, 400);
  assert.equal(reads, 1);
  await (await call(url, admin, undefined, { Range: 'bytes=4-7' })).text(); assert.equal(reads, 2);
  let settings = await (await call('/api/settings/playback', admin)).json();
  assert.equal(settings.cacheUsage.bilibili.bytes, 8); assert.equal(settings.cacheUsage.girigiri.bytes, 0);
  await call('/api/settings/playback', admin, { relayCache: { bilibili: { enabled: false } } });
  settings = await (await call('/api/settings/playback', admin)).json(); assert.equal(settings.cacheUsage.bilibili.bytes, 0);
  await (await call(url, admin, undefined, { Range: 'bytes=0-3' })).text(); assert.equal(reads, 3);
});

test('Girigiri caches video segments, refreshes manifests and keeps its switch independent', async t => {
  const selected = { source: 'https://ani.girigirilove.com/play/12', kind: 'hls', title: 'Episode', url: 'https://cdn.example.com/main.m3u8' };
  let manifests = 0; let segments = 0;
  const { call, login } = await fixture(t, { resolve: async () => structuredClone(selected), requestMedia: async url => {
    const manifest = url.endsWith('.m3u8'); manifest ? manifests++ : segments++;
    const data = manifest ? '#EXTM3U\n#EXTINF:5,\npart.ts\n#EXT-X-ENDLIST\n' : 'segment';
    const response = Readable.from([Buffer.from(data)]); response.statusCode = 200;
    response.headers = { 'content-length': String(Buffer.byteLength(data)), 'content-type': manifest ? 'application/vnd.apple.mpegurl' : 'video/mp2t' };
    return { response, url };
  } });
  const admin = await login(true);
  await call('/api/settings/playback', admin, { delivery: 'proxy', relayCache: { bilibili: { enabled: false } } });
  await call('/api/media', admin, { mode: 'online', url: selected.source, revision: 0 });
  const state = await (await call('/api/state', admin)).json();
  const playlist = await (await call(state.media.url, admin)).text();
  await (await call(state.media.url, admin)).text(); assert.equal(manifests, 2);
  const segment = playlist.split('\n').find(line => line.startsWith('/api/'));
  assert.ok(segment);
  assert.equal(await (await call(segment, admin)).text(), 'segment');
  assert.equal(await (await call(segment, admin)).text(), 'segment'); assert.equal(segments, 1);
  const settings = await (await call('/api/settings/playback', admin)).json();
  assert.equal(settings.cacheUsage.girigiri.bytes, 7); assert.equal(settings.cacheUsage.bilibili.bytes, 0);
  await call('/api/settings/playback', admin, { relayCache: { girigiri: { enabled: false } } });
  await (await call(segment, admin)).text(); assert.equal(segments, 2);
  await call('/api/media', admin, { mode: 'clear', revision: 1 });
  assert.equal((await call(segment, admin)).status, 404);
});
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
  t.after(async () => { await instance.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dataDir, { recursive: true, force: true }); });
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
  assert.equal((await (await call('/api/settings/playback', admin)).json()).bilibiliDelivery, 'direct');
  await call('/api/settings/playback', admin, { bilibiliDelivery: 'proxy' });
  await call('/api/media', admin, { mode: 'online', url: media.source, revision: 0 });
  let state = await (await call('/api/state', viewer)).json();
  assert.equal(state.media.playbackMode, 'proxy'); assert.equal(state.position, 0); assert.equal(state.paused, false);
  await call('/api/settings/playback', admin, { bilibiliDelivery: 'direct' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(config.dataDir, 'state.json'))).settings.bilibiliDelivery, 'direct');
  assert.equal((await (await call('/api/state', viewer)).json()).media.playbackMode, 'proxy');
  await call('/api/control', admin, { action: 'seek', position: 70, revision: 1 });
  await call('/api/media', admin, { mode: 'online', url: media.source + '?t=70', revision: 2 });
  state = await (await call('/api/state', viewer)).json();
  assert.equal(state.media.playbackMode, 'direct'); assert.equal(state.position, 0);
  assert.equal(state.paused, false); assert.equal(state.media.qualities[0].label, '1080P');
  assert.doesNotMatch(JSON.stringify(state), /secret=private|bilibili":|login_mid/);
  const manifest = await (await call(state.media.url, viewer)).text();
  assert.match(manifest, /https:\/\/example\.bilivideo\.com\/video\.m4s/);
  assert.doesNotMatch(manifest, /\/api\/bilibili\/track/);
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

test('ending and replay synchronize room position while retaining controller and version checks', async t => {
  const { call, login } = await fixture(t); const owner = await login(true); const viewer = await login(false);
  await call('/api/media', owner, { mode: 'online', url: media.source, revision: 0 });
  assert.equal((await call('/api/control', viewer, { action: 'ended', position: 87, revision: 1, mediaVersion: 1 })).status, 403);
  assert.equal((await call('/api/control', owner, { action: 'ended', position: 87, revision: 1, mediaVersion: 1 })).status, 200);
  let state = await (await call('/api/state', viewer)).json();
  assert.equal(state.ended, true); assert.equal(state.paused, true); assert.equal(state.position, 87);
  assert.equal((await call('/api/control', viewer, { action: 'play', restart: true, revision: 2, mediaVersion: 1 })).status, 403);
  assert.equal((await call('/api/control', owner, { action: 'play', revision: 2, mediaVersion: 1 })).status, 200);
  state = await (await call('/api/state', viewer)).json();
  assert.equal(state.ended, false); assert.equal(state.paused, false); assert.equal(state.position, 0); assert.equal(state.revision, 3);
  assert.equal((await call('/api/control', owner, { action: 'ended', position: 87, revision: 2, mediaVersion: 1 })).status, 400);
  assert.equal((await call('/api/control', owner, { action: 'play', restart: true, revision: 3, mediaVersion: 0 })).status, 400);
  state = await (await call('/api/state', viewer)).json(); assert.equal(state.revision, 3); assert.equal(state.paused, false);
  await call('/api/control', owner, { action: 'ended', position: 87, revision: 3, mediaVersion: 1 });
  await call('/api/media', owner, { mode: 'online', url: media.source, revision: 4 });
  state = await (await call('/api/state', viewer)).json();
  assert.equal(state.ended, false); assert.equal(state.position, 0); assert.equal(state.mediaVersion, 5);
});
