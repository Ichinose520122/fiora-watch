import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayer, qualityLabel, sameOriginTrack } from '../public/player.js';

class Element extends EventTarget {
  constructor(id = '') { super(); this.id = id; this.hidden = true; this.children = []; this.attributes = {}; this.textContent = ''; this.track = { mode: 'disabled', kind: 'subtitles' }; const classes = new Set(); this.classList = { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x), toggle: (x, on = !classes.has(x)) => on ? classes.add(x) : classes.delete(x) }; }
  setAttribute(name, value) { this.attributes[name] = value; }
  replaceChildren(...children) { this.children = children; }
  append(child) { this.children.push(child); child.parent = this; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  focus() { this.focused = true; }
  closest() { return null; }
  querySelectorAll() { return this.children; }
  querySelector(selector) { return selector === 'button' ? this.children[0] : null; }
}
function fixture(subtitles = async () => ({ subtitles: [] })) {
  const elements = new Map(); const doc = new EventTarget();
  doc.getElementById = id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); };
  doc.createElement = () => new Element(); doc.body = new Element();
  const video = new Element('video'); video.textTracks = Object.assign([], { addEventListener() {} }); video.paused = true; video.ended = false;
  const notices = []; const controls = createPlayer({ video, document: doc, subtitles, notify: message => notices.push(message) });
  return { controls, video, elements, get: doc.getElementById, notices, doc };
}
function engine(representations) {
  const listeners = new Map(); const settings = []; const selections = [];
  return {
    on(name, callback) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(callback); },
    emit(name) { listeners.get(name)?.forEach(callback => callback()); },
    getRepresentationsByType: () => representations,
    getCurrentRepresentationForType: () => representations[0], getTracksFor: () => [], enableText() {},
    updateSettings: value => settings.push(value), setRepresentationForTypeById: (type, id) => selections.push({ type, id }), settings, selections,
  };
}
const events = { STREAM_INITIALIZED: 'ready', REPRESENTATION_SWITCH: 'switch', QUALITY_CHANGE_RENDERED: 'quality', TEXT_TRACKS_ADDED: 'text' };
const flush = () => new Promise(resolve => setImmediate(resolve));

test('quality labels use actual representation metadata and approved labels', () => {
  assert.equal(qualityLabel({ id: 'video-0', height: 1080, frameRate: 60 }), '1080P 60帧');
  assert.equal(qualityLabel({ id: 'video-0', height: 1080 }, [{ representationId: 'video-0', label: '1080P 高码率' }]), '1080P 高码率');
  assert.equal(qualityLabel({ bandwidth: 2500000 }), '2.5 Mbps');
});

test('subtitles allow only same-origin HTTP media URLs', () => {
  assert.equal(sameOriginTrack('/api/subtitle?id=1', 'https://watch.example'), 'https://watch.example/api/subtitle?id=1');
  for (const value of ['https://external.example/a.vtt', '//external.example/a.vtt', 'javascript:alert(1)', 'data:text/vtt,WEBVTT', 'https://user:secret@watch.example/a.vtt']) assert.equal(sameOriginTrack(value, 'https://watch.example'), null);
});

test('DASH 5 quality selection affects only the local engine and restores automatic mode', () => {
  const f = fixture(); const player = engine([{ id: 'hd', height: 1080 }, { id: 'sd', height: 480 }]);
  f.controls.begin({ url: '/movie.mpd', kind: 'dash' }, 1); f.controls.attachDash(player, events); player.emit('ready');
  const choices = f.get('quality-options').children;
  assert.deepEqual(choices.map(choice => choice.textContent), ['自动 · 随网络调整', '1080P', '480P']);
  choices[2].onclick(); assert.deepEqual(player.selections, [{ type: 'video', id: 'sd' }]);
  assert.equal(player.settings.at(-1).streaming.abr.autoSwitchBitrate.video, false);
  f.get('quality-options').children[0].onclick(); assert.equal(player.settings.at(-1).streaming.abr.autoSwitchBitrate.video, true);
});

test('destroyed engine events cannot replace the current media menu', () => {
  const f = fixture(); const old = engine([{ id: 'old', height: 2160 }]); const next = engine([{ id: 'new', height: 720 }]);
  f.controls.begin({ url: '/old.mpd' }, 1); f.controls.attachDash(old, events); old.emit('ready');
  f.controls.begin({ url: '/new.mpd' }, 2); f.controls.attachDash(next, events); next.emit('ready'); old.emit('ready');
  assert.deepEqual(f.get('quality-options').children.map(choice => choice.textContent), ['自动 · 随网络调整', '720P']);
});

test('local quality survives a transport fallback but resets for a new episode', () => {
  const f = fixture(); const old = engine([{ id: 'hd', height: 1080 }, { id: 'sd', height: 480 }]);
  f.controls.begin({ url: '/direct.mpd' }, 1); f.controls.attachDash(old, events); old.emit('ready'); f.get('quality-options').children[2].onclick();
  const proxy = engine([{ id: 'hd', height: 1080 }, { id: 'sd', height: 480 }]);
  f.controls.begin({ url: '/proxy.mpd' }, 1, { preserve: true }); f.controls.attachDash(proxy, events); proxy.emit('ready');
  assert.deepEqual(proxy.selections, [{ type: 'video', id: 'sd' }]);
  f.controls.begin({ url: '/next.mpd' }, 2); assert.equal(f.get('quality-button').textContent, '清晰度');
});

test('late subtitle response is ignored after an episode switch and requests are aborted', async () => {
  const priorLocation = globalThis.location; globalThis.location = { origin: 'https://watch.example' };
  try {
    const requests = []; const f = fixture((version, signal) => new Promise(resolve => requests.push({ version, signal, resolve })));
    f.controls.begin({ provider: 'bilibili', url: '/first' }, 1); f.controls.begin({ provider: 'bilibili', url: '/second' }, 2);
    assert.equal(requests[0].signal.aborted, true);
    requests[1].resolve({ subtitles: [{ id: 'new', label: '简体中文', url: '/new.vtt' }, { id: 'unsafe', label: '外部', url: 'https://external.example/sub.vtt' }] }); await flush();
    requests[0].resolve({ subtitles: [{ id: 'old', label: '旧字幕', url: '/old.vtt' }] }); await flush();
    assert.deepEqual(f.get('subtitle-options').children.map(button => button.textContent), ['关闭字幕', '简体中文']);
    f.get('subtitle-options').children[1].onclick(); assert.equal(f.video.children[0].src, 'https://watch.example/new.vtt');
    const track = f.video.children[0]; f.controls.begin({ url: '/third' }, 3); track.onerror();
    assert.equal(f.get('subtitle-button').textContent, '字幕'); assert.equal(f.get('subtitle-message').textContent, '正在读取字幕…');
  } finally { globalThis.location = priorLocation; }
});

test('subtitle failure does not stop loading the video and fallback fullscreen retains controls', async () => {
  const f = fixture(async () => { throw new Error('unavailable'); });
  f.controls.begin({ provider: 'bilibili', url: '/video' }, 1); await flush();
  assert.equal(f.get('subtitle-message').textContent, '字幕暂时不可用，视频可继续播放');
  assert.equal(f.get('player-loading').hidden, false);
  f.video.dispatchEvent(new Event('canplay')); assert.equal(f.get('player-loading').hidden, true);
  await f.get('theater').onclick(); assert.equal(f.get('player-shell').classList.contains('web-fullscreen'), true);
  assert.equal(f.get('theater').attributes['aria-label'], '退出影院模式');
  await f.get('theater').onclick(); assert.equal(f.get('player-shell').classList.contains('web-fullscreen'), false);
  await f.get('fullscreen').onclick(); assert.equal(f.get('player-shell').classList.contains('web-fullscreen'), true);
  assert.equal(f.get('fullscreen').attributes['aria-label'], '退出全屏');
  await f.get('fullscreen').onclick(); assert.equal(f.get('player-shell').classList.contains('web-fullscreen'), false);
});
