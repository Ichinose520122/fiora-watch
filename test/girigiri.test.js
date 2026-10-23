import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogIdentity, canonicalCatalogUrl, parseGirigiriDetail, girigiriCover } from '../src/girigiri.js';
import { listEpisodes, searchCatalog, isCatalogUrl } from '../src/catalog.js';
import { resolveMedia } from '../src/resolver.js';

const origin = 'https://ani.girigirilove.com';
const api = 'https://m3u8.girigirilove.com/api.php/Vod/';
const hosts = ['ani.girigirilove.com', 'akua.girigirilove.com'];
// Minimal fields from the public /detail/27217 response observed on 2026-10-23.
const sample = {
  vod_id: 27217, vod_name: '装备我最强', vod_pic: 'upload/vod/20261001-1/4c740af563a08752dfab66716dbc758f.webp',
  vod_play_from: 'chs',
  vod_play_url: [1, 2, 3].map(n => `${String(n).padStart(2, '0')}$https://akua.girigirilove.com/zijian/oldanime/2026/10/TempalItemnoChikara/0${n}/playlist.m3u8`).join('#'),
};
const response = data => ({ code: 1, info: data });
function reader(data = sample, calls = []) {
  return async (url, allowedHosts) => {
    calls.push(url);
    assert.equal(new URL(url).origin, 'https://m3u8.girigirilove.com');
    assert.deepEqual(allowedHosts, ['m3u8.girigirilove.com']);
    return { url, text: JSON.stringify(response(data)) };
  };
}

test('new detail/play routes have canonical identities and reject invalid selections', () => {
  assert.equal(isCatalogUrl(`${origin}/detail/27217`), true);
  assert.equal(canonicalCatalogUrl(`${origin}/play/27217/?episodeIndex=02&x=1&sourceIndex=0#junk`), `${origin}/play/27217?sourceIndex=0&episodeIndex=2`);
  assert.equal(canonicalCatalogUrl(`${origin}/play/27217`), `${origin}/play/27217?sourceIndex=0&episodeIndex=0`);
  assert.equal(catalogIdentity(`${origin}/playGV27217-2-3/`).episodeIndex, 2);
  for (const url of ['https://evil.example/detail/27217', 'https://user:password@ani.girigirilove.com/detail/27217', `${origin}/detail/0`, `${origin}/detail/27217/extra`]) assert.equal(isCatalogUrl(url), false);
  for (const query of ['episodeIndex=-1', 'sourceIndex=1.2', 'episodeIndex=2000', 'episodeIndex=abc', 'sourceIndex=', 'sourceIndex=0&sourceIndex=1']) {
    assert.throws(() => catalogIdentity(`${origin}/play/27217?${query}`), /编号/);
  }
});

test('modern detail uses the fixed API and returns all episodes without leaking raw media URLs', async () => {
  const calls = [];
  const result = await listEpisodes(`${origin}/detail/27217`, hosts, reader(sample, calls));
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0]).pathname, '/api.php/Vod/get_detail');
  assert.equal(new URL(calls[0]).searchParams.get('vod_id'), '27217');
  assert.equal(result.title, '装备我最强');
  assert.equal(result.episodes.length, 3);
  assert.equal(result.episodes[2].group, '简中');
  assert.equal(result.episodes[2].episodeNumber, 3);
  assert.equal(result.cover, `https://jpg.girigirilove.net/${sample.vod_pic}`);
  assert.equal(result.source, `${origin}/detail/27217`);
  assert.ok(!JSON.stringify(result).includes('akua.girigirilove.com'));
});

test('new playback selects the requested episode and line, with one fresh API request', async () => {
  const data = { ...sample, vod_play_from: 'chs$$$cht', vod_play_url: `${sample.vod_play_url}$$$繁中01$https://akua.girigirilove.com/cht01.mp4#繁中02$https://akua.girigirilove.com/cht02.mp4?sign=a$b` };
  const calls = [];
  const result = await resolveMedia(`${origin}/play/27217?sourceIndex=1&episodeIndex=1`, hosts, reader(data, calls));
  assert.equal(calls.length, 1);
  assert.equal(result.url, 'https://akua.girigirilove.com/cht02.mp4?sign=a$b');
  assert.equal(result.kind, 'mp4');
  assert.equal(result.group, '繁中');
  assert.equal(result.episodeIndex, 4);
  assert.equal(result.episodeNumber, 2);
  assert.equal(result.episodes.length, 5);
  const first = await resolveMedia(`${origin}/detail/27217`, hosts, reader());
  assert.equal(first.kind, 'hls');
  assert.ok(first.url.endsWith('/01/playlist.m3u8'));
});

test('API sources follow the website empty-line and empty-entry indexing', () => {
  const data = { ...sample, vod_name: 'A &amp; B', vod_blurb: '<p>Description</p>', vod_play_from: 'empty$$$chs$$$cht',
    vod_play_url: '$$$#bad$#$missing#01$https://akua.girigirilove.com/1.mp4$$$02$https://akua.girigirilove.com/2.mp4' };
  const { catalog } = parseGirigiriDetail(data, `${origin}/play/27217?sourceIndex=1&episodeIndex=0`);
  assert.equal(catalog.title, 'A & B');
  assert.equal(catalog.description, 'Description');
  assert.equal(catalog.episodes.length, 2);
  assert.equal(catalog.episodeIndex, 1);
  assert.equal(catalog.episodes[1].group, '繁中');
});

test('old saved URLs recover through the API after MacCMS HTML disappears', async () => {
  const calls = [];
  const read = async (url, allowedHosts) => {
    if (url.startsWith(origin)) return { url, text: '<html><div id="app"></div></html>' };
    return reader(sample, calls)(url, allowedHosts);
  };
  const result = await resolveMedia(`${origin}/playGV27217-1-3/`, hosts, read);
  assert.equal(result.episodeIndex, 2);
  assert.equal(result.episodeNumber, 3);
  assert.ok(result.url.endsWith('/03/playlist.m3u8'));
  const list = await listEpisodes(`${origin}/GV27217/`, hosts, read);
  assert.equal(list.episodes.length, 3);
  const unavailable = await resolveMedia(`${origin}/playGV27217-1-2/`, hosts, async (url, allowedHosts) => {
    if (url.startsWith(origin)) throw new Error('来源返回 HTTP 404');
    return reader()(url, allowedHosts);
  });
  assert.equal(unavailable.episodeNumber, 2);
});

test('search uses new API pagination, covers and detail links', async () => {
  const result = await searchCatalog('装备', 2, hosts, async (url, allowedHosts) => {
    assert.equal(new URL(url).pathname, '/api.php/Vod/get_list');
    assert.equal(new URL(url).searchParams.get('offset'), '24');
    assert.equal(new URL(url).searchParams.get('limit'), '24');
    assert.equal(new URL(url).searchParams.get('vod_name'), '装备');
    assert.deepEqual(allowedHosts, ['m3u8.girigirilove.com']);
    return { url, text: JSON.stringify(response({ total: 60, rows: [sample, sample, { vod_id: 'bad' }, null] })) };
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].url, `${origin}/detail/27217`);
  assert.equal(result.hasMore, true);
  assert.equal(result.page, 2);
  assert.equal(girigiriCover('https://evil.example/upload/x.png'), '');
  assert.equal(girigiriCover('https://name:pass@jpg.girigirilove.net/upload/x.png'), '');
  for (const page of [0, 21, 1.5]) await assert.rejects(searchCatalog('a', page, hosts, reader()), /页码/);
});

test('mismatched shows, missing episodes, unsupported sources and off-list media fail closed', async () => {
  const source = `${origin}/play/27217?sourceIndex=0&episodeIndex=0`;
  await assert.rejects(resolveMedia(source, hosts, reader({ ...sample, vod_id: 99 })), /其他番剧/);
  await assert.rejects(resolveMedia(`${origin}/play/27217?episodeIndex=9`, hosts, reader()), /不存在/);
  await assert.rejects(resolveMedia(`${origin}/play/27217?sourceIndex=2`, hosts, reader()), /不存在/);
  await assert.rejects(resolveMedia(source, ['akua.girigirilove.com'], reader()), /域名未允许/);
  for (const url of ['https://evil.example/test.m3u8', 'http://127.0.0.1/private.mp4', 'https://user:pass@akua.girigirilove.com/test.mp4', 'javascript:alert(1)']) {
    await assert.rejects(resolveMedia(source, hosts, reader({ ...sample, vod_play_url: `01$${url}` })));
  }
  await assert.rejects(resolveMedia(source, hosts, reader({ ...sample, vod_play_url: '01$https://akua.girigirilove.com/embed/1' })), /HLS \/ MP4/);
  assert.throws(() => parseGirigiriDetail({ ...sample, vod_play_url: Array(2001).fill('01$https://akua.girigirilove.com/1.mp4').join('#') }, source), /超过限制/);
  for (const text of ['<html>Unavailable</html>', 'null', '{"code":403}', '{"code":1,"info":{}}']) {
    await assert.rejects(listEpisodes(source, hosts, async url => ({ url, text })));
  }
  await assert.rejects(listEpisodes(source, hosts, async () => ({ url: 'https://evil.example/', text: JSON.stringify(response(sample)) })), /非预期来源/);
});
