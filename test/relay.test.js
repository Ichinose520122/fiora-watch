import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { MediaRelay, RELAY_LIMITS } from '../src/relay.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { signTicket } from '../src/auth.js';

const roomId = 'b'.repeat(24);
const hosts = ['cdn.example.com', 'keys.example.com'];
const selection = () => ({ id: roomId, mediaVersion: 1, media: { kind: 'hls', url: 'https://cdn.example.com/master.m3u8' } });
const upstream = (body, url, statusCode = 200, headers = {}) => {
  const response = Readable.from([Buffer.from(body)]); response.statusCode = statusCode; response.headers = headers;
  return { response, url };
};

test('HLS relay rewrites variants, audio, iframe, AES keys, fMP4 maps, byte ranges and live tags to opaque authorized paths', () => {
  const relay = new MediaRelay(hosts); const room = selection();
  const input = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/list.m3u8"\n#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="iframe.m3u8"\n#EXT-X-SESSION-KEY:METHOD=AES-128,URI="https://keys.example.com/session.key?secret=private"\n#EXT-X-STREAM-INF:BANDWIDTH=200,AUDIO="a"\nvariant/list\n#EXT-X-KEY:METHOD=AES-128,URI="../key.bin"\n#EXT-X-MAP:URI="init.mp4",BYTERANGE="128@0"\n#EXT-X-BYTERANGE:100@128\nsegment.mp4\n#EXT-X-PART:DURATION=0.2,URI="part.m4s"\n#EXT-X-PRELOAD-HINT:TYPE=PART,URI="next.m4s"\n#EXT-X-RENDITION-REPORT:URI="other.m3u8",LAST-MSN=3\n#EXT-X-SESSION-DATA:DATA-ID="x",URI="metadata.json"\n';
  const output = relay.rewrite(room, input, 'https://cdn.example.com/show/master.m3u8');
  assert.doesNotMatch(output, /https?:|secret=|\.m3u8|\.mp4|\.m4s|\.key|\.bin|\.json/);
  assert.match(output, /BYTERANGE="128@0"/); assert.match(output, /#EXT-X-BYTERANGE:100@128/);
  const paths = [...output.matchAll(/\/api\/media\/relay\?room=[a-f0-9]+&version=1&resource=r[A-Za-z0-9_-]+/g)].map(match => match[0]);
  assert.equal(paths.length, 11);
  const entries = paths.map(value => relay.resource(room, new URL(value, 'http://local').searchParams.get('resource')));
  assert.equal(entries[0].url, 'https://cdn.example.com/show/audio/list.m3u8'); assert.equal(entries[0].manifest, true);
  assert.equal(entries[3].url, 'https://cdn.example.com/show/variant/list'); assert.equal(entries[3].manifest, true);
  assert.equal(entries[4].url, 'https://cdn.example.com/key.bin'); assert.equal(entries[4].manifest, false);
  assert.equal(relay.rewrite(room, input, 'https://cdn.example.com/show/master.m3u8'), output);
  const named = relay.rewrite(room, '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,NAME="English, URI=caption",URI="audio/list.m3u8"', 'https://cdn.example.com/show/master.m3u8');
  assert.match(named, /NAME="English, URI=caption"/); assert.doesNotMatch(named, /URI="audio/);
  room.mediaVersion++; assert.equal(relay.resource(room, new URL(paths[0], 'http://local').searchParams.get('resource')), null);
});

test('HLS relay fails closed for disallowed hosts, credentials, variable/steering extensions, malformed and unknown URI attributes', () => {
  for (const line of ['https://evil.example/s.ts', 'http://127.0.0.1/a.ts', 'https://a:b@cdn.example.com/a.ts', 'https://cdn.example.com:8443/a.ts', 'data:text/plain,a', '#EXT-X-KEY:METHOD=AES-128,URI="https://evil.example/k"', '#EXT-X-KEY:METHOD=AES-128,URI=key.bin', '#EXT-X-KEY:URI="key",URI=bad', '#EXT-X-KEY:uri="key"', '#EXT-X-UNKNOWN:URI="key"', '#EXT-X-CONTENT-STEERING:SERVER-URI="https://cdn.example.com/a"', '#EXT-X-DEFINE:NAME="x",VALUE="a"', '{$name}.ts']) {
    assert.throws(() => new MediaRelay(hosts).rewrite(selection(), `#EXTM3U\n${line}`, 'https://cdn.example.com/a.m3u8'), line);
  }
  assert.throws(() => new MediaRelay(hosts).rewrite(selection(), 'not hls', 'https://cdn.example.com/a'));
});

test('relay bounds resources per manifest and decoded manifest size without accumulating live windows', async () => {
  const relay = new MediaRelay(hosts, undefined, { ...RELAY_LIMITS, manifestResources: 2, manifestBytes: 40 }); const first = selection();
  const original = relay.rewrite(first, '#EXTM3U\na.ts\nb.ts', first.media.url);
  assert.throws(() => relay.rewrite(first, '#EXTM3U\na.ts\nb.ts\nc.ts', first.media.url), /数量/);
  for (let window = 0; window < 100; window++) relay.rewrite(first, `#EXTM3U\n${window}.ts\n${window + 1}.ts`, first.media.url);
  assert.equal(relay.rewrite(first, '#EXTM3U\na.ts\nb.ts', first.media.url), original);
  const compressed = upstream(gzipSync('#EXTM3U\n' + '#comment'.repeat(50)), first.media.url, 200, { 'content-encoding': 'gzip' });
  await assert.rejects(relay.manifest(first, compressed), /过大/); assert.equal(compressed.response.destroyed, true);
});

test('opaque stateless tokens survive other rooms and long live playback, bind room/version/type and reject tampering or process restart', () => {
  const relay = new MediaRelay(hosts); const first = selection();
  const firstPath = relay.register(first, 'first.ts?secret=hidden', first.media.url, false);
  const token = new URL(firstPath, 'http://local').searchParams.get('resource');
  assert.doesNotMatch(token, /secret|cdn|first/);
  assert.equal(relay.validToken(token), true);
  assert.equal(relay.resource(first, token).url, 'https://cdn.example.com/first.ts?secret=hidden');
  for (let index = 0; index < 20000; index++) {
    const other = { ...selection(), id: index.toString(16).padStart(24, '0') };
    relay.register(other, `${index}.ts`, first.media.url, false);
  }
  assert.equal(relay.resource(first, token).url, 'https://cdn.example.com/first.ts?secret=hidden');
  assert.equal(relay.register(first, 'first.ts?secret=hidden', first.media.url, false), firstPath);
  assert.notEqual(relay.register(first, 'first.ts?secret=hidden', first.media.url, true), firstPath);
  assert.equal(relay.resource({ ...first, id: 'd'.repeat(24) }, token), null);
  assert.equal(relay.resource({ ...first, mediaVersion: 2 }, token), null);
  const bytes = Buffer.from(token.slice(1), 'base64url');
  for (const offset of [0, 12, 28, bytes.length - 1]) {
    const changed = Buffer.from(bytes); changed[offset] ^= 1;
    assert.equal(relay.resource(first, 'r' + changed.toString('base64url')), null);
  }
  assert.equal(new MediaRelay(hosts).resource(first, token), null);
  const restricted = new MediaRelay(['keys.example.com']); restricted.key = relay.key; restricted.nonceKey = relay.nonceKey;
  assert.equal(restricted.resource(first, token), null);
  assert.equal(relay.resource(first, 'r' + 'a'.repeat(6000)), null);
  const properties = Object.values(relay); assert.equal(properties.some(value => value instanceof Map), false);
});

test('long VOD accepts 16384 URIs and rejects an oversized manifest without poisoning subsequent playback', () => {
  const relay = new MediaRelay(hosts); const room = selection();
  const text = '#EXTM3U\n' + Array.from({ length: 16384 }, (_value, index) => `${index}.ts`).join('\n');
  const rewritten = relay.rewrite(room, text, room.media.url);
  assert.equal(rewritten.split('\n').length, 16385);
  assert.throws(() => relay.rewrite(room, text + '\none-more.ts', room.media.url), /数量/);
  const retried = relay.rewrite(room, '#EXTM3U\n0.ts', room.media.url);
  assert.equal(rewritten.split('\n')[1], retried.split('\n')[1]);
});

test('legacy persisted playback preference migrates to the general delivery setting', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-legacy-setting-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({ rooms: {}, jobs: [], usedTickets: {}, settings: { bilibiliDelivery: 'proxy' } }));
  const store = new Store(directory); assert.deepEqual(store.data.settings, { delivery: 'proxy', bilibiliDelivery: 'proxy' });
});

async function fixture(t, requestMedia) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-relay-api-'));
  const config = { secret: 'test-only-secret-012345678901234567890', audience: 'http://localhost:9300', issuer: 'https://chat.example.com', dataDir, libraryDir: path.join(dataDir, 'library'), hosts, cacheBytes: 10000, maxDownloadBytes: 10000 };
  const instance = createApp(config, { chat: async () => ({}), requestMedia });
  fs.writeFileSync(path.join(config.libraryDir, 'local.mp4'), '0123456789');
  const server = instance.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { instance.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (url, cookie = '', body, headers = {}, options = {}) => fetch(base + url, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: config.audience, 'X-Watch-Request': '1', 'X-Watch-Room': roomId, 'Content-Type': 'application/json', Cookie: cookie, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...options });
  const login = async (admin = true) => {
    const now = Math.floor(Date.now() / 1000);
    const response = await call('/api/session', '', { ticket: signTicket({ v: 1, iss: config.issuer, aud: config.audience, iat: now, exp: now + 60, jti: randomUUID().replaceAll('-', ''), sub: (admin ? 'a' : 'c').repeat(24), room: roomId, name: 'test', admin, canControl: admin }, config.secret) });
    return response.headers.get('set-cookie').split(';')[0];
  };
  return { instance, call, login };
}

test('every online MP4/HLS obeys the selected delivery; local files bypass relay; opaque routes enforce session, room and version', async t => {
  const calls = [];
  const { instance, call, login } = await fixture(t, async (url, allowedHosts, signal, options) => {
    calls.push({ url, allowedHosts, options }); assert.equal(signal.aborted, false);
    if (url.endsWith('master.m3u8')) return upstream('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchild/list.m3u8', url, 200, { 'content-type': 'application/vnd.apple.mpegurl' });
    if (url.endsWith('list.m3u8')) return upstream('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/key.bin"\n#EXTINF:1,\n../a.ts\n#EXT-X-ENDLIST', url, 200, { 'content-type': 'application/vnd.apple.mpegurl' });
    return upstream('2345', url, 206, { 'content-type': url.endsWith('.ts') ? 'video/mp2t' : 'video/mp4', 'content-range': 'bytes 2-5/10', 'accept-ranges': 'bytes', 'content-length': '4' });
  });
  const admin = await login(); const viewer = await login(false);
  assert.equal((await call('/api/settings/playback', viewer, { delivery: 'proxy' })).status, 403);
  await call('/api/settings/playback', admin, { delivery: 'proxy' });
  assert.deepEqual(await (await call('/api/settings/playback', admin)).json(), { delivery: 'proxy', bilibiliDelivery: 'proxy' });
  await call('/api/media', admin, { mode: 'online', url: 'https://cdn.example.com/movie.mp4?secret=hidden', revision: 0 });
  let state = await (await call('/api/state', viewer)).json(); const old = state.media.url;
  assert.equal(state.media.playbackMode, 'proxy'); assert.match(old, /^\/api\/media\/relay/); assert.doesNotMatch(JSON.stringify(state), /secret=hidden/);
  assert.equal((await call(old)).status, 401);
  assert.equal((await call(old, viewer, undefined, { 'X-Watch-Room': 'e'.repeat(24) })).status, 403);
  assert.equal((await call(old.replace('resource=root', 'resource=' + 'a'.repeat(32)), viewer)).status, 404);
  assert.equal((await call(old.replace('resource=root', 'resource=https://evil.example'), viewer)).status, 404);
  const partial = await call(old + '&url=https://evil.example', viewer, undefined, { Range: 'bytes=2-5', Authorization: 'Bearer browser-private' });
  assert.equal(partial.status, 206); assert.equal(await partial.text(), '2345'); assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10'); assert.equal(partial.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(calls.at(-1).options.headers, { Range: 'bytes=2-5' }); assert.deepEqual(calls.at(-1).allowedHosts, hosts); assert.match(calls.at(-1).url, /cdn\.example/);
  assert.equal((await call(old, viewer, undefined, { Range: 'bytes=1-2,3-4' })).status, 400);
  await call('/api/media', admin, { mode: 'online', url: 'https://cdn.example.com/master.m3u8', revision: 1 });
  assert.equal((await call(old, viewer)).status, 404);
  state = await (await call('/api/state', viewer)).json();
  const master = await (await call(state.media.url, viewer)).text(); assert.doesNotMatch(master, /https?:/);
  const childPath = master.split('\n').at(-1); const child = await (await call(childPath, viewer)).text();
  assert.doesNotMatch(child, /https?:/); const segmentPath = child.split('\n').find(line => line.startsWith('/api/'));
  const segment = await call(segmentPath, viewer, undefined, { Range: 'bytes=2-5' }); assert.equal(segment.status, 206); assert.equal(segment.headers.get('content-type'), 'video/mp2t'); await segment.text();
  const keyPath = /URI="([^"]+)"/.exec(child)[1]; await (await call(keyPath, viewer)).text(); assert.equal(calls.at(-1).url, 'https://keys.example.com/key.bin');
  await call('/api/settings/playback', admin, { delivery: 'direct' });
  assert.equal((await (await call('/api/state', viewer)).json()).media.playbackMode, 'proxy');
  await call('/api/media', admin, { mode: 'online', url: 'https://cdn.example.com/movie.mp4', revision: 2 });
  state = await (await call('/api/state', viewer)).json(); assert.equal(state.media.url, 'https://cdn.example.com/movie.mp4'); assert.equal(state.media.playbackMode, 'direct');
  assert.equal((await call(state.media.fallbackUrl, viewer)).status, 206);
  await call('/api/media', admin, { mode: 'local', id: 'local:local.mp4', revision: 3 });
  state = await (await call('/api/state', viewer)).json(); assert.equal(state.media.url, '/media/local/local.mp4'); assert.equal(state.media.playbackMode, undefined); assert.equal(state.media.fallbackUrl, undefined);
  assert.equal((await call(childPath, viewer)).status, 404); assert.equal(instance.store.room(roomId).revision, 4);
});

test('maximum-length encrypted resource fits an ordinary authenticated HTTP request and rejects a changed token before upstream access', async t => {
  const prefix = 'https://cdn.example.com/'; const longestUrl = prefix + 'a'.repeat(RELAY_LIMITS.urlLength - prefix.length);
  const requests = [];
  const { call, login } = await fixture(t, async url => {
    requests.push(url);
    return url.endsWith('master.m3u8')
      ? upstream(`#EXTM3U\n#EXTINF:1,\n${longestUrl}\n#EXT-X-ENDLIST`, url, 200, { 'content-type': 'application/vnd.apple.mpegurl' })
      : upstream('video', url, 200, { 'content-type': 'video/mp2t', 'content-length': '5' });
  });
  const cookie = await login(); await call('/api/settings/playback', cookie, { delivery: 'proxy' });
  await call('/api/media', cookie, { mode: 'online', url: 'https://cdn.example.com/master.m3u8', revision: 0 });
  const state = await (await call('/api/state', cookie)).json();
  const playlist = await (await call(state.media.url, cookie)).text(); const segmentPath = playlist.split('\n')[2];
  assert.ok(segmentPath.length < 6000);
  const media = await call(segmentPath, cookie); assert.equal(media.status, 200); assert.equal(await media.text(), 'video'); assert.equal(requests.at(-1).length, 4096);
  const token = new URL(segmentPath, 'http://local').searchParams.get('resource'); const bytes = Buffer.from(token.slice(1), 'base64url'); bytes[30] ^= 1;
  const before = requests.length; assert.equal((await call(segmentPath.replace(token, 'r' + bytes.toString('base64url')), cookie)).status, 404); assert.equal(requests.length, before);
  assert.equal((await call(segmentPath.replace('version=1', 'version=0'), cookie)).status, 404); assert.equal(requests.length, before);
  assert.throws(() => new MediaRelay(hosts).register(selection(), longestUrl + 'b', longestUrl, false), /地址/);
});

test('relay preserves 416/HEAD range headers and cancels upstream on media switch and client disconnect', async t => {
  let nextResponse = 'range'; let started; let released; let lastSignal;
  const { call, login } = await fixture(t, async (url, _hosts, signal) => {
    lastSignal = signal;
    if (nextResponse === 'range') return upstream('', url, 416, { 'content-range': 'bytes */10' });
    if (nextResponse === 'head') return upstream('2345', url, 206, { 'content-range': 'bytes 2-5/10', 'content-length': '4', 'content-type': 'video/mp4' });
    started(); await new Promise(resolve => { released = resolve; signal.addEventListener('abort', resolve, { once: true }); });
    return upstream('old video', url);
  });
  const cookie = await login(); await call('/api/settings/playback', cookie, { delivery: 'proxy' });
  await call('/api/media', cookie, { mode: 'online', url: 'https://cdn.example.com/movie.mp4', revision: 0 });
  const state = await (await call('/api/state', cookie)).json();
  const invalid = await call(state.media.url, cookie, undefined, { Range: 'bytes=99-100' }); assert.equal(invalid.status, 416); assert.equal(invalid.headers.get('content-range'), 'bytes */10'); assert.equal(await invalid.text(), '');
  nextResponse = 'head'; const head = await call(state.media.url, cookie, undefined, { Range: 'bytes=2-5' }, { method: 'HEAD' }); assert.equal(head.status, 206); assert.equal(head.headers.get('content-length'), '4'); assert.equal(await head.text(), '');
  nextResponse = 'slow'; let ready = new Promise(resolve => { started = resolve; }); const pending = call(state.media.url, cookie); await ready;
  await call('/api/media', cookie, { mode: 'clear', revision: 1 }); assert.equal(lastSignal.aborted, true); assert.equal((await pending).status, 409); released();
  await call('/api/media', cookie, { mode: 'online', url: 'https://cdn.example.com/movie.mp4', revision: 2 }); const next = await (await call('/api/state', cookie)).json();
  const controller = new AbortController(); ready = new Promise(resolve => { started = resolve; });
  const cancelled = call(next.media.url, cookie, undefined, {}, { signal: controller.signal }); await ready; controller.abort(); await assert.rejects(cancelled);
  for (let tries = 0; tries < 20 && !lastSignal.aborted; tries++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(lastSignal.aborted, true); released();
});
