import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { MediaLibrary } from '../src/media.js';
import { Store } from '../src/store.js';

function setup(t, dependencies = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-download-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = { dataDir, libraryDir: path.join(dataDir, 'library'), hosts: ['cdn.example.com', 'ani.girigirilove.com'], maxDownloadBytes: 1024, cacheBytes: 10000 };
  const store = new Store(dataDir);
  return new MediaLibrary(config, store, undefined, {
    resolve: async source => ({ kind: 'mp4', title: 'Episode', url: source }),
    request: async () => ({ response: Readable.from([Buffer.alloc(100)]) }), ...dependencies,
  });
}
async function until(predicate) {
  for (let tries = 0; tries < 200; tries++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Download did not reach expected state');
}

test('batch validates all URLs atomically, normalizes duplicates and reuses queued/completed jobs', async t => {
  const library = setup(t); library.running = true;
  assert.throws(() => library.enqueueBatch(['https://cdn.example.com/one.mp4', 'http://127.0.0.1/internal'], 'admin'));
  assert.throws(() => library.enqueueBatch(['https://cdn.example.com/one.mp4', 'https://www.bilibili.com/video/BV123'], 'admin'), /在线模式/);
  assert.equal(library.store.data.jobs.length, 0);
  const result = library.enqueueBatch(['https://ani.girigirilove.com/playGV12-1-1', 'https://ani.girigirilove.com/playGV12-1-1/?x=1', 'https://cdn.example.com/two.mp4'], 'admin');
  assert.equal(result.added, 2); assert.equal(result.skipped, 1); assert.equal(result.jobs[0].episodeNumber, 1);
  assert.equal(library.enqueueBatch(['https://cdn.example.com/two.mp4'], 'admin').added, 0);
  library.running = false; await library.run();
  assert.equal(result.jobs[0].status, 'done');
  const repeat = library.enqueueBatch(['https://cdn.example.com/two.mp4'], 'admin');
  assert.equal(repeat.added, 0); assert.equal(repeat.jobs[0].id, result.jobs[1].id);
});

test('batch limits preserve every preexisting history record and reject entire overfull additions', t => {
  const library = setup(t); library.running = true;
  assert.throws(() => library.enqueueBatch(Array(101).fill('https://cdn.example.com/one.mp4'), 'admin'), /100/);
  library.store.data.jobs.push(...Array.from({ length: 199 }, (_, i) => ({ id: String(i), source: `https://cdn.example.com/${i}.mp4`, status: 'queued' })));
  assert.throws(() => library.enqueueBatch(['https://cdn.example.com/new1.mp4', 'https://cdn.example.com/new2.mp4'], 'admin'), /200/);
  assert.equal(library.store.data.jobs.length, 199);
  const [job] = library.enqueueBatch(['https://cdn.example.com/new1.mp4'], 'admin').jobs;
  library.cancel(job.id); assert.equal(job.status, 'cancelled'); assert.equal(job.stage, 'cancelled');
  assert.equal(library.store.data.jobs.length, 200); assert.ok(job.finishedAt);
});

test('modern Girigiri downloads retain both indexes while normalizing unrelated query and fragments', t => {
  const library = setup(t); library.running = true;
  const result = library.enqueueBatch([
    'https://ani.girigirilove.com/play/27217?sourceIndex=0&episodeIndex=2',
    'https://ani.girigirilove.com/play/27217/?tracking=one&episodeIndex=2&sourceIndex=0#player',
    'https://ani.girigirilove.com/play/27217?sourceIndex=0&episodeIndex=3',
    'https://ani.girigirilove.com/play/27217?sourceIndex=1&episodeIndex=2',
  ], 'admin');
  assert.equal(result.added, 3); assert.equal(result.skipped, 1);
  assert.equal(new Set(result.jobs.map(job => job.id)).size, 3);
  const episode = result.jobs[0];
  assert.equal(episode.source, 'https://ani.girigirilove.com/play/27217?sourceIndex=0&episodeIndex=2');
  assert.equal(episode.episodeNumber, 3); assert.equal(episode.group, '线路 1');
  assert.equal(episode.title, '第 3 集 · 线路 1 · 等待解析');
  assert.equal(result.jobs[1].episodeNumber, 4);
  assert.equal(result.jobs[2].group, '线路 2');
  assert.equal(library.enqueueBatch(['https://ani.girigirilove.com/play/27217?episodeIndex=2&sourceIndex=0&x=2'], 'admin').added, 0);
});

test('modern Girigiri missing indexes default to zero and maximum indexes remain distinct', t => {
  const library = setup(t); library.running = true;
  const result = library.enqueueBatch([
    'https://ani.girigirilove.com/play/27217',
    'https://ani.girigirilove.com/play/27217?sourceIndex=0&episodeIndex=0',
    'https://ani.girigirilove.com/play/27217?episodeIndex=1999',
    'https://ani.girigirilove.com/play/27217?sourceIndex=1999',
  ], 'admin');
  assert.equal(result.added, 3); assert.equal(result.skipped, 1);
  assert.equal(result.jobs[0].source, 'https://ani.girigirilove.com/play/27217?sourceIndex=0&episodeIndex=0');
  assert.equal(result.jobs[0].episodeNumber, 1); assert.equal(result.jobs[0].group, '线路 1');
  assert.equal(result.jobs[1].episodeNumber, 2000); assert.equal(result.jobs[2].group, '线路 2000');
});

test('modern Girigiri invalid indexes reject the entire batch before saving or running downloads', t => {
  const library = setup(t); let saves = 0; let runs = 0;
  library.store.save = () => { saves++; }; library.run = () => { runs++; };
  for (const key of ['sourceIndex', 'episodeIndex']) {
    for (const value of ['-1', '0.5', '2000', '999999999999999999999', 'NaN', 'Infinity']) {
      assert.throws(() => library.enqueueBatch([
        'https://cdn.example.com/valid.mp4',
        `https://ani.girigirilove.com/play/27217?${key}=${value}`,
      ], 'admin'), undefined, `${key}=${value}`);
      assert.equal(library.store.data.jobs.length, 0);
    }
  }
  assert.equal(saves, 0); assert.equal(runs, 0);
});

test('modern Girigiri downloads continue to enforce configured hosts and credential restrictions', t => {
  const library = setup(t); library.running = true;
  for (const source of [
    'https://ani.girigirilove.com.attacker.example/play/27217?episodeIndex=2',
    'https://user:password@ani.girigirilove.com/play/27217?episodeIndex=2',
    'https://ani.girigirilove.com:8443/play/27217?episodeIndex=2',
  ]) assert.throws(() => library.enqueue(source, 'admin'), /域名未允许/);
  library.config.hosts = ['cdn.example.com'];
  assert.throws(() => library.enqueue('https://ani.girigirilove.com/play/27217?episodeIndex=2', 'admin'), /域名未允许/);
  assert.equal(library.store.data.jobs.length, 0);
});

test('MP4 progress includes expected bytes and transfer speed during a single long response', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const library = setup(t, { request: async () => {
    const response = Readable.from((async function* () { yield Buffer.alloc(100); await gate; yield Buffer.alloc(100); })());
    response.headers = { 'content-length': '200' }; return { response };
  } });
  const job = library.enqueue('https://cdn.example.com/one.mp4', 'admin');
  await until(() => job.bytes === 100);
  assert.equal(job.stage, 'downloading'); assert.equal(job.expectedBytes, 200); assert.equal(job.progress, 0.5); assert.ok(job.speedBytesPerSecond > 0);
  release(); await until(() => !library.running);
  assert.equal(job.status, 'done'); assert.equal(job.progress, 1); assert.equal(job.bytes, 200); assert.equal(job.speedBytesPerSecond, 0);
  assert.ok(job.startedAt <= job.finishedAt); assert.equal(library.list().length, 1);
});

test('truncated responses fail with a retained error and remove partial files', async t => {
  const library = setup(t, { request: async () => {
    const response = Readable.from([Buffer.alloc(100)]); response.headers = { 'content-length': '200' }; return { response };
  } });
  const job = library.enqueue('https://cdn.example.com/truncated.mp4', 'admin'); await until(() => !library.running);
  assert.equal(job.status, 'failed'); assert.equal(job.stage, 'failed'); assert.match(job.error, /字节数/);
  assert.equal(fs.existsSync(path.join(library.tmp, job.id)), false); assert.equal(library.store.data.jobs[0], job);
});

test('cancelling during resolution retains history and prevents transfer from starting', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let requests = 0;
  const library = setup(t, { resolve: async () => { await gate; return { kind: 'mp4', title: 'Episode', url: 'https://cdn.example.com/one.mp4' }; }, request: async () => { requests++; throw new Error('must not transfer'); } });
  const job = library.enqueue('https://cdn.example.com/one.mp4', 'admin');
  library.cancel(job.id); release(); await until(() => !library.running);
  assert.equal(job.status, 'cancelled'); assert.equal(requests, 0); assert.match(job.error, /取消/);
  assert.equal(library.store.data.jobs.length, 1);
});
