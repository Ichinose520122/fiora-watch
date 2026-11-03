import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { RelayCache, RELAY_CACHE_MAX_ENTRY_BYTES } from '../src/relay-cache.js';

async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'watch-relay-cache-'));
  const settings = { bilibili: { enabled: true, maxBytes: 32, ttlMs: 1000 }, girigiri: { enabled: true, maxBytes: 32, ttlMs: 1000 } };
  let now = 100;
  const cache = new RelayCache({ directory, settings: () => settings, now: () => now, ...overrides });
  await cache.ready;
  t.after(async () => { await cache.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { cache, settings, directory, advance: value => { now += value; } };
}
function upstream(body = 'hello', headers = {}, statusCode = 200) {
  const response = Readable.from([Buffer.from(body)]);
  response.headers = { 'content-length': String(Buffer.byteLength(body)), 'content-type': 'video/mp4', ...headers };
  response.statusCode = statusCode;
  return { response, url: 'https://cdn.example/video' };
}
async function body(result) {
  const chunks = [];
  for await (const chunk of result.response) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}
const miss = () => { throw new Error('Expected a disk cache hit'); };

test('streams a cold response into disk and serves hits with exact range and media headers', async t => {
  const { cache, directory } = await fixture(t);
  const headers = { 'content-range': 'bytes 5-9/100', 'accept-ranges': 'bytes', etag: 'v1' };
  assert.equal(await body(await cache.open('bilibili', 'url:bytes=5-9', () => upstream('hello', headers, 206))), 'hello');
  assert.equal(cache.stats().bilibili.bytes, 5);
  const hit = await cache.open('bilibili', 'url:bytes=5-9', miss);
  assert.equal(hit.cached, true); assert.equal(hit.response.statusCode, 206);
  assert.equal(hit.response.headers['content-range'], headers['content-range']);
  assert.equal(hit.response.headers['content-type'], 'video/mp4');
  assert.equal(await body(hit), 'hello');
  assert.equal((await fs.readdir(directory)).filter(name => name.endsWith('.cache')).length, 1);
  assert.equal(await body(await cache.open('bilibili', 'url:bytes=0-4', () => upstream('other'))), 'other');
});

test('applies independent provider quotas, LRU eviction, expiry and live settings', async t => {
  const { cache, settings, advance } = await fixture(t);
  settings.bilibili.maxBytes = 10;
  const put = async (provider, key, data) => body(await cache.open(provider, key, () => upstream(data)));
  await put('bilibili', 'a', 'aaaaa'); advance(1);
  await put('bilibili', 'b', 'bbbbb'); advance(1);
  await body(await cache.open('bilibili', 'a', miss)); advance(1);
  await put('bilibili', 'c', 'ccccc');
  assert.equal(cache.stats().bilibili.bytes, 10);
  assert.equal(cache.entries.has(JSON.stringify(['bilibili', 'b'])), false);
  await put('girigiri', 'a', 'different');
  assert.equal(await body(await cache.open('bilibili', 'a', miss)), 'aaaaa');
  assert.equal(await body(await cache.open('girigiri', 'a', miss)), 'different');
  settings.bilibili.enabled = false; await cache.prune();
  assert.equal(cache.stats().bilibili.entries, 0); assert.equal(cache.stats().girigiri.entries, 1);
  advance(1001); await cache.prune(); assert.equal(cache.stats().girigiri.bytes, 0);
});

test('concurrent reservations count against capacity and duplicate misses have a single writer', async t => {
  const { cache, settings } = await fixture(t); settings.bilibili.maxBytes = 8;
  const source = new PassThrough(); source.headers = { 'content-length': '5' }; source.statusCode = 200;
  const first = await cache.open('bilibili', 'a', () => ({ response: source }));
  assert.equal(cache.stats().bilibili.reservedBytes, 5);
  assert.equal(await body(await cache.open('bilibili', 'a', () => upstream('other'))), 'other');
  assert.equal(await body(await cache.open('bilibili', 'b', () => upstream('bbbbb'))), 'bbbbb');
  assert.equal(cache.stats().bilibili.reservedBytes, 5); assert.equal(cache.stats().bilibili.entries, 0);
  const consuming = body(first); source.end('hello'); assert.equal(await consuming, 'hello');
  assert.equal(cache.stats().bilibili.bytes, 5); assert.equal(cache.stats().bilibili.reservedBytes, 0);
});

test('forwards the first chunk before the upstream finishes and removes aborted partial writes', async t => {
  const { cache, directory } = await fixture(t);
  const source = new PassThrough(); source.headers = { 'content-length': '10' }; source.statusCode = 200;
  const controller = new AbortController();
  const opened = await cache.open('girigiri', 'stream', () => ({ response: source }), { signal: controller.signal });
  const iterator = opened.response[Symbol.asyncIterator](); const first = iterator.next(); source.write('first');
  assert.equal((await first).value.toString(), 'first');
  const next = iterator.next(); controller.abort(new Error('viewer left'));
  await assert.rejects(next, /viewer left/);
  assert.equal(source.destroyed, true); assert.equal(cache.stats().girigiri.reservedBytes, 0);
  assert.equal((await fs.readdir(directory)).length, 0);
});

test('does not cache invalid length, partial body, rejected content, error status or oversized objects', async t => {
  const { cache, settings } = await fixture(t);
  settings.bilibili.maxBytes = RELAY_CACHE_MAX_ENTRY_BYTES * 2;
  const cases = [
    [() => upstream('body', { 'content-length': undefined }), {}],
    [() => upstream('body', { 'content-length': '3' }), {}],
    [() => upstream('body', { 'content-length': '9' }), {}],
    [() => upstream('body', { 'content-length': String(RELAY_CACHE_MAX_ENTRY_BYTES + 1) }), {}],
    [() => upstream('body', {}, 416), {}],
    [() => upstream('body', {}, 206), {}],
    [() => upstream('body', { 'content-range': 'bytes 0-4/10' }, 206), {}],
    [() => upstream('body', { 'content-range': 'bytes 0-3/3' }, 206), {}],
    [() => upstream('body'), { cacheable: () => false }],
  ];
  for (let index = 0; index < cases.length; index++) {
    assert.equal(await body(await cache.open('bilibili', index, cases[index][0], cases[index][1])), 'body');
    assert.equal(cache.stats().bilibili.entries, 0); assert.equal(cache.stats().bilibili.reservedBytes, 0);
  }
});

test('active disk readers stay accounted for and prevent eviction until their stream closes', async t => {
  const { cache, settings } = await fixture(t); settings.bilibili.maxBytes = 5;
  await body(await cache.open('bilibili', 'a', () => upstream('hello')));
  const hit = await cache.open('bilibili', 'a', miss);
  assert.equal(await body(await cache.open('bilibili', 'b', () => upstream('other'))), 'other');
  assert.equal(cache.stats().bilibili.bytes, 5); assert.equal(cache.entries.has(JSON.stringify(['bilibili', 'b'])), false);
  assert.equal(await body(hit), 'hello');
  await body(await cache.open('bilibili', 'b', () => upstream('other')));
  assert.equal(cache.entries.has(JSON.stringify(['bilibili', 'a'])), false);
  assert.equal(await body(await cache.open('bilibili', 'b', miss)), 'other');
});

test('upstream failures and viewer cancellation discard temporary files', async t => {
  const { cache, directory } = await fixture(t);
  const source = new PassThrough(); source.headers = { 'content-length': '10' }; source.statusCode = 200;
  const opened = await cache.open('bilibili', 'failed', () => ({ response: source }));
  const consuming = body(opened); source.write('part'); source.destroy(new Error('upstream failed'));
  await assert.rejects(consuming, /upstream failed/);
  assert.equal(cache.stats().bilibili.reservedBytes, 0); assert.deepEqual(await fs.readdir(directory), []);
  const next = new PassThrough(); next.headers = { 'content-length': '10' }; next.statusCode = 200;
  const abandoned = await cache.open('bilibili', 'abandoned', () => ({ response: next }));
  const closed = new Promise(resolve => abandoned.response.once('close', resolve));
  abandoned.response.destroy(); await closed;
  assert.equal(next.destroyed, true); assert.deepEqual(await fs.readdir(directory), []);
});

test('disk creation and disk write errors bypass the cache without breaking playback', async t => {
  const { cache, directory } = await fixture(t);
  await fs.rmdir(directory); await fs.writeFile(directory, 'not a directory');
  assert.equal(await body(await cache.open('bilibili', 'no-disk', () => upstream())), 'hello');
  await fs.unlink(directory); await fs.mkdir(directory);
  const source = new PassThrough(); source.headers = { 'content-length': '5' }; source.statusCode = 200;
  const opened = await cache.open('bilibili', 'disk-write', () => ({ response: source }));
  const reservation = [...cache.reservations.values()][0];
  reservation.handle.write = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  const consuming = body(opened); source.end('hello'); assert.equal(await consuming, 'hello');
  assert.equal(cache.stats().bilibili.entries, 0); assert.equal(cache.stats().bilibili.reservedBytes, 0);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('pruning disabled caches and closing cancels writers while allowing playback to finish', async t => {
  const { cache, settings, directory } = await fixture(t);
  for (const close of [false, true]) {
    settings.girigiri.enabled = true;
    const source = new PassThrough(); source.headers = { 'content-length': '5' }; source.statusCode = 200;
    const opened = await cache.open('girigiri', String(close), () => ({ response: source }));
    if (close) await cache.close(); else { settings.girigiri.enabled = false; await cache.prune(); }
    const consuming = body(opened); source.end('hello'); assert.equal(await consuming, 'hello');
    assert.equal(cache.stats().girigiri.reservedBytes, 0); assert.deepEqual(await fs.readdir(directory), []);
  }
});

test('initialization discards only owned files and safely bypasses unavailable cache storage', async t => {
  const { cache, directory } = await fixture(t); await cache.close();
  await fs.writeFile(path.join(directory, 'relay-12345678-1234-1234-1234-123456789abc.cache'), 'old');
  await fs.writeFile(path.join(directory, 'keep.txt'), 'keep');
  const restarted = new RelayCache({ directory, settings: () => ({}) });
  await restarted.ready; await restarted.close(); assert.deepEqual(await fs.readdir(directory), ['keep.txt']);
  const unavailable = new RelayCache({ directory: path.join(directory, 'keep.txt', 'child'), settings: () => ({ bilibili: { enabled: true, maxBytes: 32, ttlMs: 1000 } }) });
  assert.equal(await body(await unavailable.open('bilibili', 'a', () => upstream())), 'hello');
  await unavailable.close();
});
