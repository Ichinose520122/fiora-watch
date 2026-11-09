import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { control } from '../src/store.js';

const flush = () => new Promise(resolve => setImmediate(resolve));

test('room ending records the exact endpoint and play atomically restarts the shared clock', () => {
  const room = { media: {}, mediaVersion: 1, revision: 1, paused: false, position: 57, updatedAt: 0 };
  control(room, { action: 'ended', position: 60, revision: 1, mediaVersion: 1 }, 5000);
  assert.equal(room.position, 60); assert.equal(room.paused, true); assert.equal(room.ended, true);
  control(room, { action: 'play', revision: 2, mediaVersion: 1 }, 6000);
  assert.equal(room.position, 0); assert.equal(room.paused, false); assert.equal(room.ended, false);
  assert.equal(room.revision, 3); assert.equal(room.updatedAt, 6000);
  const snapshot = structuredClone(room);
  assert.throws(() => control(room, { action: 'ended', position: 60, revision: 2, mediaVersion: 1 }), /已更新/);
  assert.throws(() => control(room, { action: 'play', restart: true, revision: 3, mediaVersion: 0 }), /影片已更新/);
  assert.deepEqual(room, snapshot);
});

test('explicit replay covers an unreported ending; ordinary pause/seek keeps normal resume behavior', () => {
  const room = { media: {}, mediaVersion: 1, revision: 1, paused: true, position: 59, updatedAt: 1000 };
  control(room, { action: 'play', restart: true, revision: 1 }, 1000);
  assert.equal(room.position, 0); assert.equal(room.paused, false);
  control(room, { action: 'pause', revision: 2 }, 4000);
  control(room, { action: 'play', revision: 3 }, 5000);
  assert.equal(room.position, 3);
  control(room, { action: 'ended', position: 60, revision: 4 }, 6000);
  control(room, { action: 'seek', position: 20, revision: 5 }, 7000);
  control(room, { action: 'play', revision: 6 }, 8000);
  assert.equal(room.position, 20); assert.equal(room.ended, false);
  const snapshot = structuredClone(room);
  for (const input of [{ action: 'ended', position: NaN }, { action: 'ended', position: -1 }, { action: 'ended', position: Infinity }, { action: 'play', restart: 'yes' }, { action: 'seek', position: 0, restart: true }]) {
    assert.throws(() => control(room, { ...input, revision: room.revision }));
    assert.deepEqual(room, snapshot);
  }
});

function fixture({ canControl = true, duration = 60 } = {}) {
  const elements = new Map(); const events = new Map(); const requests = []; let serverState;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', value: '', hidden: false, classList: { toggle() {} },
      setAttribute() {}, removeAttribute() {}, addEventListener() {}, replaceChildren() {}, append() {} });
    return elements.get(id);
  };
  const video = Object.assign(element('video'), { paused: true, ended: false, readyState: 1, currentTime: 0, duration,
    pause() { this.paused = true; }, load() {}, async play() { this.paused = false; if (this.currentTime < duration) this.ended = false; },
    addEventListener(name, callback) { if (!events.has(name)) events.set(name, []); events.get(name).push(callback); } });
  let currentTime = 0;
  Object.defineProperty(video, 'currentTime', { get: () => currentTime, set(value) { currentTime = value; if (value < duration) video.ended = false; } });
  const context = vm.createContext({ URL, URLSearchParams, AbortSignal, Promise,
    location: { pathname: '/test', hash: '', origin: 'https://watch.example' }, performance: { now: () => 0 },
    document: { getElementById: element, createElement: () => element('created') },
    setInterval() {}, setTimeout() {}, clearTimeout() {},
    fetch: async (url, options) => {
      if (url === '/api/state') return { ok: true, json: async () => serverState };
      assert.equal(url, '/api/control');
      await new Promise(resolve => requests.push({ body: JSON.parse(options.body), resolve }));
      return { ok: true, json: async () => ({}) };
    },
    mountAtomPlayer: () => ({ video, active: true, atom: {}, setFullscreen() {}, reset() {}, update() {} }),
    createDanmaku: () => ({ clear() {}, ingest() {} }), loadMediaEngine: async () => {},
    createDiscovery: () => ({ refresh() {} }),
    createPlayer: () => ({ toggleFullscreen() {}, begin() {}, fail() {} }),
  });
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
  vm.runInContext(source, context);
  const state = (overrides = {}) => ({ revision: 1, mediaVersion: 1, position: 0, paused: false, ended: false,
    serverTime: 0, updatedAt: 0, user: { name: 'owner' }, canControl,
    media: { url: '/movie.mp4', kind: 'mp4', title: 'Movie' }, ...overrides });
  const receive = next => { context.next = next; vm.runInContext('receive(next)', context); };
  const command = name => { context.command = name; vm.runInContext('requestPlayerControl(command)', context); };
  receive(state());
  return { video, requests, state, receive, command,
    ended() { video.currentTime = duration; video.ended = true; video.paused = true; events.get('ended')?.forEach(callback => callback()); },
    async confirm(index, next) { serverState = next; requests[index].resolve(); await flush(); },
  };
}

test('play before ending confirmation queues one replay and ignores the older ending timeline', async () => {
  const f = fixture(); await flush(); f.ended(); await flush();
  assert.equal(f.requests[0].body.action, 'ended'); assert.equal(f.requests[0].body.position, 60);
  f.command('play'); await flush();
  assert.equal(f.video.currentTime, 0); assert.equal(f.requests.length, 1);
  f.receive(f.state({ position: 59, revision: 1 })); assert.equal(f.video.currentTime, 0);
  await f.confirm(0, f.state({ position: 60, paused: true, ended: true, revision: 2 }));
  assert.equal(f.video.currentTime, 0); assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].body.action, 'play'); assert.equal(f.requests[1].body.restart, true);
  assert.equal(f.requests[1].body.revision, 2); assert.equal(f.requests[1].body.mediaVersion, 1);
  await f.confirm(1, f.state({ revision: 3 }));
  assert.equal(f.video.currentTime, 0); assert.equal(f.video.paused, false);
});

test('toggle at an unconfirmed ending replays; stale ending event cannot pause that replay', async () => {
  const f = fixture(); await flush(); f.ended();
  // The ending callback is queued as a microtask, while replay begins immediately.
  f.command('toggle'); await flush();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].body.action, 'play');
  assert.equal(f.requests[0].body.restart, true);
  await f.confirm(0, f.state({ revision: 2 }));
  assert.equal(f.requests.length, 1); assert.equal(f.video.currentTime, 0); assert.equal(f.video.paused, false);
});

test('a room replay resets every viewer even for a video shorter than the drift threshold', async () => {
  const f = fixture({ canControl: false, duration: 1 }); await flush();
  f.receive(f.state({ position: 1, paused: true, ended: true, revision: 2 }));
  f.video.currentTime = 1; f.video.ended = true;
  f.receive(f.state({ revision: 3 })); await flush();
  assert.equal(f.video.currentTime, 0); assert.equal(f.video.paused, false);
  f.ended(); f.command('play'); await flush(); assert.equal(f.requests.length, 0);
});

test('a replay queued for the old movie is discarded when the room selects a new movie', async () => {
  const f = fixture(); await flush(); f.ended(); await flush(); f.command('play');
  const next = f.state({ revision: 3, mediaVersion: 3, position: 10, media: { url: '/next.mp4', kind: 'mp4' } });
  f.receive(next); await f.confirm(0, next);
  assert.equal(f.requests.length, 1); assert.equal(f.video.currentTime, 10);
});

test('repeated room ending snapshots do not publish more ending controls', async () => {
  const f = fixture(); await flush(); f.ended(); await flush();
  const ended = f.state({ position: 60, paused: true, ended: true, revision: 2 });
  await f.confirm(0, ended);
  f.receive(ended); f.receive(ended); f.ended(); await flush();
  assert.equal(f.requests.length, 1);
});
