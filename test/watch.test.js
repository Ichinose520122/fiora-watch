import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { signTicket, verifyTicket } from '../src/auth.js';
import { Store, control, position } from '../src/store.js';
import { publicAddress, allowedUrl, requestPublic } from '../src/network.js';
import { parseMacCMS, parsePlaylist, resolveMedia } from '../src/resolver.js';
import { MediaLibrary, safeFile } from '../src/media.js';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const secret = 'test-secret-only-0123456789abcdef0123456789';
const user = 'a'.repeat(24); const room = 'b'.repeat(24);
const config = { secret, issuer: 'https://chat.example.com', audience: 'http://localhost:9300', hosts: ['cdn.example.com'], cacheBytes: 1024 * 1024, maxDownloadBytes: 1024 * 1024 };
function payload(overrides = {}) { const now = Math.floor(Date.now() / 1000); return { v: 1, iss: config.issuer, aud: config.audience, iat: now, exp: now + 60, jti: randomBytes(16).toString('hex'), sub: user, room, name: '测试用户', avatar: '', canControl: true, admin: true, ...overrides }; }
function temporary(t) { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fiora-watch-test-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory; }

test('ticket rejects forged, expired, future and wrong-audience claims', () => {
  const good = signTicket(payload(), secret);
  assert.equal(verifyTicket(good, config).sub, user);
  assert.throws(() => verifyTicket(`${good.slice(0, -5)}abcde`, config));
  for (const override of [{ aud: 'https://evil.example' }, { iss: 'https://evil.example' }, { exp: 1 }, { iat: Math.floor(Date.now() / 1000) + 30 }, { admin: 'true' }, { room: '__proto__' }]) {
    assert.throws(() => verifyTicket(signTicket(payload(override), secret), config));
  }
});

test('ticket replay protection persists and restart pauses rooms / fails interrupted jobs', t => {
  const dir = temporary(t); const store = new Store(dir); const p = payload();
  store.consumeTicket(p); store.room(room).paused = false; store.data.jobs.push({ status: 'running' }); store.save();
  const restored = new Store(dir);
  assert.throws(() => restored.consumeTicket(p), /已使用/);
  assert.equal(restored.room(room).paused, true); assert.equal(restored.data.jobs[0].status, 'failed');
});

test('room controls use authoritative elapsed time and reject stale writes', () => {
  const state = { media: {}, position: 5, paused: true, updatedAt: 1000, revision: 0 };
  control(state, { action: 'play', revision: 0 }, 1000);
  assert.equal(position(state, 4000), 8);
  assert.throws(() => control(state, { action: 'seek', position: 50, revision: 0 }, 4000), /已更新/);
  control(state, { action: 'pause', revision: 1 }, 4000); assert.equal(state.position, 8);
  control(state, { action: 'seek', revision: 2, position: 100 }, 5000); assert.equal(position(state, 7000), 100);
  assert.throws(() => control(state, { action: 'seek', revision: 3, position: -1 }));
});

test('SSRF guards reject private, mapped, metadata, credential and nonstandard-port addresses', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.1.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fc00::1', '0.0.0.0']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('1.1.1.1'), true);
  for (const url of ['file:///etc/passwd', 'https://user:pass@cdn.example.com/a', 'https://cdn.example.com:8080/a', 'https://cdn.example.com.evil/a']) assert.throws(() => allowedUrl(url, config.hosts));
  await assert.rejects(requestPublic('http://127.0.0.1/test', ['127.0.0.1']), /内网/);
});

test('MacCMS decoding reads JSON without executing scripts', async () => {
  const target = 'https://cdn.example.com/show/playlist.m3u8';
  const html = '<title>Episode 1</title><script>var player_aaaa=' + JSON.stringify({ encrypt: 2, url: Buffer.from(encodeURIComponent(target)).toString('base64') }) + '</script>';
  assert.equal(parseMacCMS(html, 'https://cdn.example.com/play/1'), target);
  const result = await resolveMedia('https://cdn.example.com/play/1', config.hosts, async () => ({ text: html, url: 'https://cdn.example.com/play/1' }));
  assert.equal(result.kind, 'hls'); assert.equal(result.title, 'Episode 1');
  assert.throws(() => parseMacCMS('<script>var player_aaaa=process.exit()</script>', target));
});

test('HLS download resolves relative segments and rejects unsafe or unsupported playlists', () => {
  const base = 'https://cdn.example.com/show/index.m3u8';
  const text = '#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:4,\n0.ts\n#EXT-X-ENDLIST';
  assert.deepEqual(parsePlaylist(text, base, config.hosts).urls, ['https://cdn.example.com/show/0.ts']);
  assert.match(parsePlaylist(text, base, config.hosts).local, /0.ts/);
  for (const invalid of [text.replace('0.ts', 'http://127.0.0.1/a'), text.replace('#EXT-X-ENDLIST', ''), text + '\n#EXT-X-KEY:METHOD=AES-128,URI="key"']) assert.throws(() => parsePlaylist(invalid, base, config.hosts));
  assert.equal(parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow.m3u8', base, config.hosts).variant, 'https://cdn.example.com/show/low.m3u8');
});

test('download queue writes complete HLS locally and enforces byte budget with partial cleanup', async t => {
  const dataDir = temporary(t); const cfg = { ...config, dataDir, libraryDir: path.join(dataDir, 'library') };
  const store = new Store(dataDir);
  const library = new MediaLibrary(cfg, store, undefined, {
    resolve: async () => ({ kind: 'hls', title: 'Episode', url: 'https://cdn.example.com/index.m3u8' }),
    read: async url => ({ url, text: '#EXTM3U\n#EXTINF:1,\n0.ts\n#EXTINF:1,\n1.ts\n#EXT-X-ENDLIST' }),
    request: async () => ({ response: Readable.from([Buffer.alloc(188, 0x47)]) }),
  });
  const job = library.enqueue('https://cdn.example.com/index.m3u8', user);
  while (library.running) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(job.status, 'done'); assert.equal(job.bytes, 376); assert.equal(library.list().length, 1);
  assert.match(fs.readFileSync(path.join(library.root, job.id, 'index.m3u8'), 'utf8'), /1.ts/);
  library.config.maxDownloadBytes = 100;
  const failed = library.enqueue('https://cdn.example.com/index.m3u8', user);
  while (library.running) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(failed.status, 'failed'); assert.equal(fs.existsSync(path.join(library.tmp, failed.id)), false);
  library.cancel(job.id); assert.equal(library.list().length, 0);
});

test('media path rejects traversal and local library never follows symlinks', t => {
  const root = temporary(t); const media = path.join(root, 'media'); fs.mkdirSync(media);
  fs.writeFileSync(path.join(root, 'secret.mp4'), 'secret'); fs.writeFileSync(path.join(media, 'good.mp4'), 'video');
  assert.throws(() => safeFile(media, '../secret.mp4')); assert.equal(safeFile(media, 'good.mp4'), path.join(media, 'good.mp4'));
});

test('configuration requires dedicated strong secret and HTTPS outside localhost', () => {
  assert.throws(() => loadConfig({ WATCH_SHARED_SECRET: 'short' }));
  assert.throws(() => loadConfig({ WATCH_SHARED_SECRET: secret, WATCH_PUBLIC_URL: 'http://watch.example.com' }));
  assert.equal(loadConfig({ WATCH_SHARED_SECRET: secret }).audience, 'http://localhost:9300');
});

test('HTTP integration: single-use login, room isolation, two viewers, CSRF, roles and ranged local media', async t => {
  const dataDir = temporary(t); const libraryDir = path.join(dataDir, 'library');
  const instance = createApp({ ...config, dataDir, libraryDir }, { resolve: async url => ({ url, title: 'Test', kind: 'mp4' }) });
  fs.writeFileSync(path.join(libraryDir, 'movie.mp4'), '0123456789');
  const server = instance.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { instance.close(); await new Promise(resolve => server.close(resolve)); });
  const headers = { Origin: config.audience, 'Content-Type': 'application/json', 'X-Watch-Request': '1', 'X-Watch-Room': room };
  const request = (url, cookie = '', body, extra = {}) => fetch(base + url, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, Cookie: cookie, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const ticket = signTicket(payload(), secret);
  const login = await request('/api/session', '', { ticket }); assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await request('/api/session', '', { ticket })).status, 400);
  assert.equal((await request('/api/state')).status, 401);
  assert.equal((await request('/api/state', cookie, undefined, { 'X-Watch-Room': 'c'.repeat(24) })).status, 403);
  assert.equal((await request('/api/media', cookie, { mode: 'online', url: 'https://cdn.example.com/a.mp4', revision: 0 }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('/api/media', cookie, { mode: 'local', id: 'local:movie.mp4', revision: 0 })).status, 200);
  const login2 = await request('/api/session', '', { ticket: signTicket(payload({ sub: 'c'.repeat(24), admin: false, canControl: false }), secret) });
  const cookie2 = login2.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/control', cookie2, { action: 'play', revision: 1 })).status, 403);
  assert.equal((await request('/api/downloads', cookie2, { url: 'https://cdn.example.com/a.mp4' })).status, 403);
  assert.equal((await request('/api/control', cookie, { action: 'play', revision: 1 })).status, 200);
  const second = await (await request('/api/state', cookie2)).json(); assert.equal(second.paused, false); assert.equal(second.revision, 2);
  assert.equal((await request('/api/control', cookie, { action: 'pause', revision: 1 })).status, 400);
  const partial = await request('/media/local/movie.mp4', cookie2, undefined, { Range: 'bytes=2-5' }); assert.equal(partial.status, 206); assert.equal(await partial.text(), '2345');
  assert.equal((await request('/media/local/movie.mp4')).status, 401);
  assert.equal((await request('/media/local/movie.mp4', cookie, undefined, { Range: 'bytes=99-100' })).status, 416);
  await request('/api/logout', cookie, {}); assert.equal((await request('/api/state', cookie)).status, 401);
});
