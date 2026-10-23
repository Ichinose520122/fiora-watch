import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('download form reads complete Girigiri catalogs for modern and legacy detail/play pages', async () => {
  const elements = new Map(); const calls = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, {});
    return elements.get(id);
  };
  const context = vm.createContext({
    URL, URLSearchParams, Promise,
    location: { pathname: '/test' },
    document: { getElementById: element, querySelectorAll: () => [], querySelector: () => ({ click: () => calls.push(['tab']) }), addEventListener() {} },
    window: { addEventListener() {} }, setInterval() {},
    record: (...args) => calls.push(args),
  });
  vm.runInContext(fs.readFileSync(new URL('../public/manage.js', import.meta.url), 'utf8'), context);
  vm.runInContext("attempt = task => task(); inspect = async url => record('inspect', url); download = async url => record('download', url); notice = text => record('notice', text);", context);
  for (const pathname of ['/detail/27217', '/detail/27217/', '/play/27217?sourceIndex=0&episodeIndex=2', '/GV12/', '/playGV12-1-2/']) {
    calls.length = 0; const source = `https://ani.girigirilove.com${pathname}`;
    element('download-source').value = source;
    element('download-form').onsubmit({ preventDefault() {} });
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(calls.slice(0, 2), [['tab'], ['inspect', source]]);
    assert.equal(calls.some(([type]) => type === 'download'), false);
  }
  for (const source of ['https://cdn.example.com/video.mp4', 'https://ani.girigirilove.com.attacker.example/play/27217', 'https://ani.girigirilove.com/unrelated/27217']) {
    calls.length = 0; element('download-source').value = source;
    element('download-form').onsubmit({ preventDefault() {} });
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(calls, [['download', source]]);
  }
});
