import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.dataset = {}; this.value = ''; this.textContent = ''; this.classList = { add() {}, toggle() {} }; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; this.textContent = ''; }
  setAttribute(name, value) { this[name] = value; }
  querySelectorAll(selector) { return this.children.flatMap(node => [...(selector === 'details[open]' && node.tag === 'details' && node.open ? [node] : []), ...node.querySelectorAll(selector)]); }
}
function fixture() {
  const elements = new Map(); const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const context = vm.createContext({ URL, URLSearchParams, Promise, console, location: { pathname: '/test' },
    document: { getElementById: element, createElement: tag => new Element(tag), querySelectorAll: () => [], addEventListener() {} },
    window: { addEventListener() {} }, setInterval() {}, confirm: () => true,
  });
  vm.runInContext(fs.readFileSync(new URL('../public/manage.js', import.meta.url), 'utf8'), context);
  const run = code => vm.runInContext(code, context); return { element, context, run };
}
function flatten(node) { return [node.textContent, ...node.children.map(flatten)].join(' '); }
function find(node, predicate) { return predicate(node) ? node : node.children.map(child => find(child, predicate)).find(Boolean); }

test('download cards expose speed, bytes, progress and credible ETA while retaining expanded details', async () => {
  const { context, run, element } = fixture(); context.response = { jobs: [{ id: 'one', title: '第一集', status: 'running', stage: 'downloading', kind: 'mp4', bytes: 1000, expectedBytes: 2000, speedBytesPerSecond: 100 }], usedBytes: 1000, quota: 5000 };
  run('api = async () => response'); await run('downloads()');
  assert.match(flatten(element('jobs')), /实时速度 100 B\/s/); assert.match(flatten(element('jobs')), /50\.0%/);
  assert.match(flatten(element('jobs')), /预计剩余 10 秒/); assert.match(flatten(element('jobs')), /已下载 \/ 总量/);
  find(element('jobs'), node => node.tag === 'details').open = true;
  context.response.jobs[0].speedBytesPerSecond = 0; await run('downloads()');
  assert.equal(find(element('jobs'), node => node.tag === 'details').open, true);
  assert.match(flatten(element('jobs')), /实时速度 0 B\/s/); assert.doesNotMatch(flatten(element('jobs')), /预计剩余/);
  Object.assign(context.response.jobs[0], { kind: 'hls', expectedBytes: 0, total: 8, completed: 2, speedBytesPerSecond: 100 }); await run('downloads()');
  assert.match(flatten(element('jobs')), /25\.0%/); assert.match(flatten(element('jobs')), /分段 2 \/ 8/); assert.doesNotMatch(flatten(element('jobs')), /预计剩余/);
  Object.assign(context.response.jobs[0], { status: 'failed', error: '来源提前中断' }); await run('downloads()'); assert.match(flatten(element('jobs')), /来源提前中断/);
});

test('library selection works by series and filtered results while excluding protected media', async () => {
  const { run, element, context } = fixture(); context.response = { items: [
    { id: 'download:one', title: '第一集', seriesTitle: '番剧A', removable: true },
    { id: 'download:two', title: '第二集', seriesTitle: '番剧A', removable: true },
    { id: 'download:busy', title: '第三集', seriesTitle: '番剧A', removable: false, removeReason: '房间正在使用' },
    { id: 'local:mounted', title: '挂载视频', readOnly: true, removable: false, removeReason: '挂载媒体只读' },
  ] };
  run('state = { user: {admin:true}, canControl:true }; api = async () => response'); await run('library()');
  const group = find(element('library'), node => node.textContent === '勾选本组'); await group.onclick();
  assert.equal(run('selectedLibrary.size'), 2); assert.equal(element('library-selection-count').textContent, '已选 2 项');
  assert.match(flatten(element('library')), /房间正在使用/); assert.match(flatten(element('library')), /挂载媒体只读/);
  element('library-clear-selection').onclick(); assert.equal(run('selectedLibrary.size'), 0);
  element('library-filter').value = '第二集'; element('library-filter').oninput(); element('library-select-all').onclick();
  assert.equal(run('selectedLibrary.size'), 1); assert.equal(run("selectedLibrary.has('download:two')"), true);
  element('library-filter').value = ''; element('library-filter').oninput(); assert.equal(run('selectedLibrary.size'), 1);
});

test('playback settings saves the global delivery field and accepts a legacy response', async () => {
  const { run, context, element } = fixture(); context.calls = [];
  run("state = {user:{admin:true}}; api = async (url, body) => { calls.push(body); return {bilibiliDelivery:'proxy'}; }");
  element('playback-delivery').value = 'direct'; await run('playbackSettings(true)');
  assert.equal(context.calls[0].delivery, 'direct'); assert.equal(element('playback-delivery').value, 'proxy');
});
