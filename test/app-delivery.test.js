import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(kind) {
  const elements = new Map(); const beginnings = []; const failures = []; const engines = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', value: '', hidden: false, classList: { toggle() {} },
      setAttribute() {}, removeAttribute(name) { delete this[name]; }, addEventListener() {}, replaceChildren() {}, append() {} });
    return elements.get(id);
  };
  const video = element('video'); Object.assign(video, { paused: true, readyState: 0, currentTime: 0, duration: NaN,
    pause() { this.paused = true; }, load() {}, play: async () => {} });
  class Hls {
    static Events = { ERROR: 'error' };
    static isSupported() { return true; }
    constructor() { this.listeners = new Map(); engines.push(this); }
    loadSource(source) { this.source = source; }
    attachMedia() {}
    on(event, callback) { this.listeners.set(event, callback); }
    destroy() { this.destroyed = true; }
    fail() { this.listeners.get('error')?.('error', { fatal: true }); }
  }
  const context = vm.createContext({ URL, URLSearchParams, Promise, Hls,
    location: { pathname: '/test', hash: '', origin: 'https://watch.example' }, performance: { now: () => 0 },
    document: { getElementById: element, createElement: () => element('created') },
    setInterval() {}, setTimeout() {}, clearTimeout() {},
    mountAtomPlayer: () => ({ video, active: true, atom: {}, setFullscreen() {}, reset() {}, update() {} }),
    createDanmaku: () => ({ clear() {}, ingest() {} }), loadMediaEngine: async () => {},
    createPlayer: () => ({ toggleFullscreen() {}, begin: (media, version, options) => beginnings.push({ media, version, ...options }), attachHls() {}, fail: text => failures.push(text) }),
  });
  // Stub imported adapters, then execute the complete application including its
  // real receive -> loadMedia -> engine error path. No playback logic is copied.
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
  vm.runInContext(source, context);
  const select = (overrides = {}, version = 1) => {
    context.next = { revision: version, mediaVersion: version, position: 42, paused: true, serverTime: 0, updatedAt: 0,
      user: { name: 'viewer' }, canControl: true, media: { kind, provider: 'girigiri', title: `Episode ${version}`, playbackMode: 'direct', url: `https://cdn.example/episode-${version}.${kind}`, fallbackUrl: `/api/relay?version=${version}`, ...overrides } };
    vm.runInContext('receive(next)', context);
  };
  const sourceUrl = () => kind === 'hls' ? engines.at(-1).source : video.src;
  const errorCallback = () => {
    if (kind === 'hls') { const engine = engines.at(-1); return () => engine.fail(); }
    const callback = video.onerror; return () => { video.error = { code: 4 }; callback(); };
  };
  return { element, beginnings, failures, engines, select, sourceUrl, errorCallback };
}

for (const kind of ['hls', 'mp4']) {
  test(`${kind}: direct failure falls back once to the same-origin relay and preserves player choices`, async () => {
    const f = fixture(kind); await flush(); f.select(); await flush();
    assert.equal(f.element('delivery-status').textContent, '直连'); assert.equal(f.beginnings.length, 1);
    const staleError = f.errorCallback(); staleError(); await flush();
    assert.equal(f.sourceUrl(), '/api/relay?version=1'); assert.equal(f.element('delivery-status').textContent, '服务器中继');
    assert.match(f.element('playback-status').textContent, /服务器中继/);
    assert.equal(f.beginnings.length, 2); assert.equal(f.beginnings[0].preserve, false); assert.equal(f.beginnings[1].preserve, true);
    assert.equal(f.beginnings[1].version, f.beginnings[0].version);
    staleError(); assert.equal(f.beginnings.length, 2); assert.equal(f.failures.length, 0);
    f.errorCallback()(); await flush();
    assert.equal(f.beginnings.length, 2); assert.equal(f.failures.length, 1); assert.equal(f.sourceUrl(), '/api/relay?version=1');
  });

  test(`${kind}: explicit proxy failure never switches to a direct source`, async () => {
    const f = fixture(kind); await flush(); f.select({ playbackMode: 'proxy', url: '/api/relay?version=1', fallbackUrl: 'https://cdn.example/direct' }); await flush();
    f.errorCallback()(); await flush();
    assert.equal(f.sourceUrl(), '/api/relay?version=1'); assert.equal(f.beginnings.length, 1); assert.equal(f.failures.length, 1);
    assert.equal(f.element('delivery-status').textContent, '服务器中继');
  });

  test(`${kind}: errors from a replaced source cannot fail or reroute the new episode`, async () => {
    const f = fixture(kind); await flush(); f.select(); await flush(); const staleError = f.errorCallback();
    f.select({}, 2); await flush(); const source = f.sourceUrl(); staleError(); await flush();
    assert.equal(f.sourceUrl(), source); assert.equal(f.sourceUrl(), `https://cdn.example/episode-2.${kind}`);
    assert.equal(f.beginnings.length, 2); assert.equal(f.beginnings[1].preserve, false); assert.equal(f.failures.length, 0);
    assert.equal(f.element('delivery-status').textContent, '直连'); assert.equal(f.element('notice').textContent, '');
  });

  test(`${kind}: direct failure refuses a fallback on another origin`, async () => {
    const f = fixture(kind); await flush(); f.select({ fallbackUrl: 'https://outside.example/relay' }); await flush();
    const source = f.sourceUrl(); f.errorCallback()(); await flush();
    assert.equal(f.sourceUrl(), source); assert.equal(f.beginnings.length, 1); assert.equal(f.failures.length, 1);
    assert.equal(f.element('delivery-status').textContent, '直连');
  });
}
