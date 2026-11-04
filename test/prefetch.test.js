import test from 'node:test';
import assert from 'node:assert/strict';
import { hlsSegments, dashSegments, mp4Ahead, RelayPrefetch } from '../src/prefetch.js';

test('VOD plans use explicit and implicit HLS byte offsets, ignore keys and reject live or invalid ranges', () => {
  const url = 'https://media.example/item.mp4';
  const list = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="secret"\n#EXTINF:8,\n#EXT-X-BYTERANGE:10@7\nitem.mp4\n#EXTINF:4,\n#EXT-X-BYTERANGE:16\nitem.mp4\n#EXT-X-ENDLIST';
  assert.deepEqual(hlsSegments(list, url), [{ url, time: 0, range: 'bytes=7-16' }, { url, time: 8, range: 'bytes=17-32' }]);
  assert.deepEqual(hlsSegments(list.replace('#EXT-X-ENDLIST', ''), url), []);
  assert.deepEqual(hlsSegments(list.replace('10@7', '10'), url), []);
  assert.deepEqual(hlsSegments(list.replace(/item.mp4\n#EXT-X-ENDLIST/, 'different.mp4\n#EXT-X-ENDLIST'), url), []);
});

test('64-bit SIDX includes the box location and first offset and rejects indirect indexes', () => {
  const data = Buffer.alloc(60);
  data.writeUInt32BE(8); data.write('free', 4);
  data.writeUInt32BE(52, 8); data.write('sidx', 12); data[16] = 1; data.writeUInt32BE(5, 24);
  data.writeBigUInt64BE(15n, 28); data.writeBigUInt64BE(27n, 36); data.writeUInt16BE(1, 46);
  data.writeUInt32BE(7, 48); data.writeUInt32BE(30, 52);
  assert.deepEqual(dashSegments(data, 100, 'track'), [{ time: 3, url: 'track', range: 'bytes=187-193' }]);
  data.writeUInt32BE(0x80000007, 48); assert.deepEqual(dashSegments(data, 100, 'track'), []);
  assert.deepEqual(dashSegments(data.subarray(0, 44), 100, 'track'), []);
});

test('progressive MP4 predicts bounded ranges, truncates the last block and skips open-ended requests', () => {
  const tasks = mp4Ahead('movie', 'bytes=0-32767', 'bytes 0-32767/100000');
  assert.deepEqual(tasks.map(t => t.range), ['bytes=32768-65535', 'bytes=65536-98303', 'bytes=98304-99999']);
  assert.equal(mp4Ahead('movie', 'bytes=0-32767', 'bytes 0-32767/10000000').length, 4);
  assert.deepEqual(mp4Ahead('movie', 'bytes=0-', 'bytes 0-99999/100000'), []);
});

test('new demand preempts an active speculative fetch and seek drops the old queue', async () => {
  let busy = false;
  const queue = new RelayPrefetch(() => busy);
  const room = { id: 'room' };
  let count = 0, signal;
  const start = Promise.withResolvers();
  try {
    queue.queue(room, 'video', [1, 2], () => true, async (_, abort) => {
      count++; signal = abort; start.resolve();
      await new Promise(resolve => abort.addEventListener('abort', resolve, { once: true }));
      return false;
    });
    await Promise.race([start.promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('did not start')), 2000); start.promise.then(() => clearTimeout(timer)); })]);
    busy = true; queue.interrupt(); assert.equal(signal.aborted, true);
    queue.cancel(room); busy = false; queue.wake();
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(count, 1);
  } finally { queue.close(); }
});
