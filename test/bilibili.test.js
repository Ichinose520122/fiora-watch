import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBilibiliManifest, isBilibiliUrl, listBilibiliEpisodes, resolveBilibili, validateByteRange } from '../src/bilibili.js';

const bvid = 'BV1xx411c7mD';
const view = { bvid, title: '测试 & 视频', pic: 'http://i1.hdslb.com/bfs/archive/test.jpg', rights: {}, pages: [{ page: 1, cid: 101, part: '开场' }, { page: 2, cid: 102, part: '第二部分' }] };
const track = (type, overrides = {}) => ({ id: 32, baseUrl: `https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/test.${type}.m4s?token=secret`, codecs: type === 'video' ? 'avc1.64001E' : 'mp4a.40.2', mimeType: `${type}/mp4`, bandwidth: 100000, width: 640, height: 360, frameRate: '30', SegmentBase: { Initialization: '0-999', indexRange: '1000-1999' }, ...overrides });
function reader(play = { dash: { duration: 30, video: [track('video')], audio: [track('audio')] } }, metadata = view) {
  return async url => ({ url, text: JSON.stringify({ code: 0, data: new URL(url).pathname.endsWith('/view') ? metadata : play }) });
}

test('Bilibili accepts BV / av and lists canonical selected parts without media URLs', async () => {
  assert.equal(isBilibiliUrl(bvid), true); assert.equal(isBilibiliUrl('av2'), true);
  assert.equal(isBilibiliUrl('https://www.bilibili.com.evil/video/' + bvid), false);
  const list = await listBilibiliEpisodes(`https://www.bilibili.com/video/${bvid}/?p=2`, [], reader());
  assert.equal(list.episodeIndex, 1); assert.equal(list.episodes.length, 2);
  assert.equal(list.seriesTitle, view.title); assert.equal(list.cover, 'https://i1.hdslb.com/bfs/archive/test.jpg');
  assert.equal((await listBilibiliEpisodes(bvid, [], reader(undefined, { ...view, pic: 'http://i1.hdslb.com.evil/image.jpg' }))).cover, '');
  assert.equal(list.episodes[1].url, `https://www.bilibili.com/video/${bvid}/?p=2`);
  assert.equal(JSON.stringify(list).includes('bilivideo'), false);
  await assert.rejects(listBilibiliEpisodes(`https://www.bilibili.com/video/${bvid}/?p=3`, [], reader()), /不存在/);
  await assert.rejects(listBilibiliEpisodes(`https://user:pass@www.bilibili.com/video/${bvid}/`, [], reader()));
  const shortRead = async url => new URL(url).hostname === 'b23.tv' ? { url: `https://www.bilibili.com/video/${bvid}/?p=2` } : reader()(url);
  assert.equal((await listBilibiliEpisodes('https://b23.tv/Ab123', [], shortRead)).episodeIndex, 1);
  await assert.rejects(listBilibiliEpisodes('https://b23.tv/Ab123', [], async () => ({ url: 'https://127.0.0.1/private' })));
  const pageRead = async url => {
    if (new URL(url).pathname.endsWith('/view')) throw new Error('来源返回 HTTP 412');
    return { url, text: `<script>window.__INITIAL_STATE__=${JSON.stringify({ videoData: { ...view, title: 'JSON 中的 } 和 \\" 引号' } })};(function(){throw new Error('must never run')})();</script>` };
  };
  const fallback = await listBilibiliEpisodes(`https://www.bilibili.com/video/${bvid}/?p=2`, [], pageRead);
  assert.equal(fallback.episodeIndex, 1); assert.equal(fallback.title, 'JSON 中的 } 和 \\" 引号');
  await assert.rejects(listBilibiliEpisodes(bvid, [], async () => { throw new Error('来源返回 HTTP 412'); }), /限制了影院服务器.*HTTP 412/);
  await assert.rejects(listBilibiliEpisodes(bvid, [], async url => new URL(url).pathname.endsWith('/view') ? Promise.reject(new Error('来源返回 HTTP 412')) : { url, text: '<script>window.__INITIAL_STATE__=process.exit()</script>' }), /有效 JSON/);
});

test('DASH manifest preserves SegmentBase and uses only same-origin video/audio proxies', async () => {
  const media = await resolveBilibili(`https://www.bilibili.com/video/${bvid}/?p=2`, [], reader());
  assert.equal(media.kind, 'dash'); assert.equal(media.bilibili.tracks.length, 2);
  assert.equal(media.seriesTitle, view.title); assert.equal(media.cover, 'https://i1.hdslb.com/bfs/archive/test.jpg');
  const manifest = buildBilibiliManifest(media, (_, index) => `/api/bilibili/track?part=2&track=${index}`);
  assert.match(manifest, /contentType="video"/); assert.match(manifest, /contentType="audio"/);
  assert.match(manifest, /indexRange="1000-1999"/); assert.match(manifest, /Initialization range="0-999"/);
  assert.match(manifest, /part=2&amp;track=0/); assert.doesNotMatch(manifest, /bilivideo|token=secret/);
  assert.throws(() => buildBilibiliManifest(media, () => 'https://evil.example/a'));
  assert.throws(() => buildBilibiliManifest(media, () => '/\\evil.example/a'));
});

test('Bilibili rejects paid, DRM, unsafe CDN and invalid byte indexes', async () => {
  await assert.rejects(resolveBilibili(bvid, [], reader(undefined, { ...view, rights: { pay: 1 } })), /登录、付费/);
  for (const item of [track('video', { baseUrl: 'https://127.0.0.1/a.m4s' }), track('video', { SegmentBase: { Initialization: '0-999', indexRange: '900-1100' } }), track('video', { drm: true })]) {
    await assert.rejects(resolveBilibili(bvid, [], reader({ dash: { duration: 30, video: [item], audio: [track('audio')] } })));
  }
  for (const range of ['bytes=0-99', 'bytes=100-', 'bytes=-500']) assert.equal(validateByteRange(range), range);
  for (const range of ['bytes=9-2', 'bytes=-0', 'bytes=0-1,2-3', 'bytes=-', 'bytes=9007199254740992-']) assert.throws(() => validateByteRange(range));
});
