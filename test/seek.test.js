import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture() {
  const elements = new Map(); const timers = new Map(); const requests = []; let timerId = 0;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', hidden: false, classList: { toggle() {} },
      setAttribute() {}, removeAttribute() {}, addEventListener() {}, replaceChildren() {}, append() {} });
    return elements.get(id);
  };
  const video = Object.assign(element('video'), { paused: true, readyState: 1, currentTime: 0, duration: 600,
    pause() { this.paused = true; }, load() {}, play: async () => {} });
  let serverState;
  const context = vm.createContext({ URL, URLSearchParams, AbortSignal, Promise,
    location: { pathname: '/test', hash: '', origin: 'https://watch.example' }, performance: { now: () => 0 },
    document: { getElementById: element, createElement: () => element('created') },
    setInterval() {}, setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => {
      if (url === '/api/state') return { ok: true, json: async () => serverState };
      assert.equal(url, '/api/control');
      const done = deferred(); const body = JSON.parse(options.body); requests.push({ body, done });
      await done.promise; return { ok: true, json: async () => ({}) };
    },
    mountAtomPlayer: () => ({ video, active: true, atom: {}, setFullscreen() {}, reset() {}, update() {} }),
    createDanmaku: () => ({ clear() {}, ingest() {} }), loadMediaEngine: async () => {},
    createPlayer: () => ({ toggleFullscreen() {}, begin() {}, fail() {} }),
  });
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
  vm.runInContext(source, context);
  const state = (position = 10, revision = 1, version = 1) => ({ revision, mediaVersion: version, position, paused: true,
    serverTime: 0, updatedAt: 0, user: { name: 'owner' }, canControl: true,
    media: { url: `/movie-${version}.mp4`, kind: 'mp4', title: 'Movie' } });
  const receive = next => { context.next = next; vm.runInContext('receive(next)', context); };
  const command = (name, position) => { context.command = name; context.position = position; vm.runInContext('requestPlayerControl(command, position)', context); };
  receive(state());
  return { video, requests, state, receive, command, element,
    seeking: () => vm.runInContext('locallySeeking', context),
    async timers() { const batch = [...timers.values()]; timers.clear(); batch.forEach(callback => callback()); await flush(); },
    async confirm(index, next) { serverState = next; requests[index].done.resolve(); await flush(); },
  };
}

test('dragging holds the local timeline through SSE; release seeks immediately until room confirmation', async () => {
  const f = fixture(); await flush(); assert.equal(f.video.currentTime, 10);
  f.command('seek-start'); f.receive(f.state(15, 2));
  assert.equal(f.video.currentTime, 10); assert.equal(f.seeking(), true);
  f.command('seek', 120); assert.equal(f.video.currentTime, 120);
  f.receive(f.state(15, 2)); assert.equal(f.video.currentTime, 120);
  await f.timers(); assert.equal(f.requests.length, 1); assert.equal(f.requests[0].body.position, 120);
  await f.confirm(0, f.state(120, 3));
  assert.equal(f.seeking(), false); assert.equal(f.video.currentTime, 120); assert.equal(f.video.paused, true);
});

test('an older seek response cannot unlock or roll back a newer seek', async () => {
  const f = fixture(); await flush(); f.command('seek', 100); await f.timers();
  f.command('seek-start'); f.command('seek', 250); await f.timers();
  assert.equal(f.requests.length, 1); assert.equal(f.video.currentTime, 250);
  await f.confirm(0, f.state(100, 2));
  assert.equal(f.seeking(), true); assert.equal(f.video.currentTime, 250);
  f.receive(f.state(100, 2)); assert.equal(f.video.currentTime, 250);
  await f.timers(); assert.equal(f.requests.length, 2); assert.equal(f.requests[1].body.position, 250);
  await f.confirm(1, f.state(250, 3)); assert.equal(f.seeking(), false); assert.equal(f.video.currentTime, 250);
});

test('cancelled drag restores room time and superseded queued positions are never sent', async () => {
  const f = fixture(); await flush(); f.command('seek', 100); f.command('seek-start');
  f.receive(f.state(25, 2)); f.command('seek-cancel');
  assert.equal(f.seeking(), false); assert.equal(f.video.currentTime, 25);
  await f.timers(); assert.equal(f.requests.length, 0);
});

test('fallback range blur does not unlock its unconfirmed seek', async () => {
  const f = fixture(); await flush();
  f.element('seek').oninput(); f.element('seek').onchange({ target: { value: '180' } }); f.element('seek').onblur();
  f.receive(f.state(20, 2)); assert.equal(f.seeking(), true); assert.equal(f.video.currentTime, 180);
  await f.timers(); await f.confirm(0, f.state(180, 3)); assert.equal(f.seeking(), false);
});

test('switching media clears queued seeks and stale requests cannot re-lock the new movie', async () => {
  const f = fixture(); await flush(); f.command('seek', 100); await f.timers();
  f.command('seek', 250); f.receive(f.state(5, 3, 2));
  assert.equal(f.seeking(), false); assert.equal(f.video.currentTime, 5);
  await f.confirm(0, f.state(100, 2)); await f.timers();
  assert.equal(f.requests.length, 1); assert.equal(f.seeking(), false); assert.equal(f.video.currentTime, 5);
});

test('Atom captures desktop drags, ignores unrelated releases, and cancels lost pointers', () => {
  const source = fs.readFileSync(new URL('../public/vendor/atom/APlayer.watch.js', import.meta.url), 'utf8');
  const start = source.indexOf('let $=!1;const watchCancel=');
  const end = source.indexOf('e.proxy(t,"pointermove"', start);
  assert.ok(start > 0 && end > start);
  const handlers = new Map(); const commands = []; let capture; let seek;
  const element = { setPointerCapture: id => { capture = id; }, hasPointerCapture: id => capture === id, releasePointerCapture: () => { capture = undefined; } };
  const atom = { option: { watchControl: (...args) => commands.push(args) }, emit() {},
    proxy(_target, names, callback) { for (const name of Array.isArray(names) ? names : [names]) handlers.set(name, callback); },
    hover(_target, _enter, leave) { handlers.set('leave', leave); }, set seek(value) { seek = value; } };
  const player = {};
  vm.runInNewContext(source.slice(start, end).replace(/,$/, ';'), { e: atom, t: element, o: player, g: {}, y: (_video, _target, event) => ({ second: event.position }), Date });
  handlers.get('pointerup')({ position: 90 }); assert.equal(seek, undefined);
  handlers.get('pointerdown')({ pointerId: 1, button: 0 }); assert.equal(capture, 1); assert.equal(player.drog, true);
  handlers.get('leave')(); handlers.get('pointerup')({ pointerId: 1, position: 90 });
  assert.equal(seek, 90); assert.equal(capture, undefined); assert.equal(player.drog, false);
  handlers.get('pointerdown')({ pointerId: 2, button: 0 }); handlers.get('lostpointercapture')();
  assert.equal(player.drog, false); assert.deepEqual(commands, [['seek-start'], ['seek-start'], ['seek-cancel']]);
});

test('Atom ignores native timeline updates during desktop and mobile drag previews', () => {
  const source = fs.readFileSync(new URL('../public/vendor/atom/APlayer.watch.js', import.meta.url), 'utf8');
  const start = source.indexOf('e.on("timeUpdate",(t=>{if($||o.drog)return;');
  const end = source.indexOf('let $=!1;', start);
  assert.ok(start > 0 && end > start);
  let update; const styles = []; const player = { current: 120, duration: 600, drog: false };
  const context = vm.createContext({ e: { on(_name, callback) { update = callback; } }, o: player,
    s: { chapter: [{}], $chapter: [{ played: {}, loaded: {} }] }, k: {}, g: {}, D: [], f: () => 50,
    p: (...args) => styles.push(args) });
  vm.runInContext(`${source.slice(start, end)}let $=!0;`, context);
  update(10); assert.equal(styles.length, 0);
  vm.runInContext('$=!1;', context); player.drog = true; update(10); assert.equal(styles.length, 0);
  player.drog = false; update(120); assert.equal(styles.length, 3);
  assert.equal(styles[0][2], 'scaleX(0.2)'); assert.equal(styles[2][2], 'translateX(20%)');
});
