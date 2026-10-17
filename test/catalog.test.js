import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { searchCatalog, parseEpisodes, listEpisodes } from '../src/catalog.js';
import { resolveMedia } from '../src/resolver.js';

test('catalog search and episode lists retain covers and subtitle groups without unrelated links', async () => {
  const search = await searchCatalog('番名', 1, ['ani.girigirilove.com'], async url => {
    assert.equal(new URL(url).searchParams.get('wd'), '番名');
    return { text: JSON.stringify({ code: 1, list: [{ id: 12, name: '番名', pic: '/upload/cover.webp' }, { id: 'bad', name: 'invalid' }] }) };
  });
  assert.equal(search.items.length, 1);
  assert.equal(search.items[0].cover, 'https://ani.girigirilove.com/upload/cover.webp');
  const html = `<div class="detail-pic"><img alt="番名" data-src="/upload/cover.webp"></div>
    <div class="anthology-tab"><a class="swiper-slide">繁中<span class="badge">2</span></a><a class="swiper-slide">简中</a></div>
    <ul class="anthology-list-play"><a href="/playGV12-1-1/"><span>01</span></a><a href="/playGV12-2-1/">01</a>
    <a href="https://evil.example/playGV12-1-2/">广告</a><a href="/playGV99-1-1/">推荐</a></ul>`;
  const list = parseEpisodes(html, 'https://ani.girigirilove.com/playGV12-2-1/');
  assert.equal(list.title, '番名'); assert.equal(list.cover, search.items[0].cover);
  assert.deepEqual(list.episodes.map(item => item.group), ['繁中', '简中']);
  assert.equal(list.episodeIndex, 1);
});

test('real detail/play markup returns the complete season and preserves the requested episode', async () => {
  const origin = 'https://ani.girigirilove.com';
  for (const name of ['detail', 'play']) {
    const html = fs.readFileSync(new URL(`fixtures/girigiri-${name}.html`, import.meta.url), 'utf8');
    const result = parseEpisodes(html, `${origin}/${name === 'detail' ? 'GV12' : 'playGV12-1-8'}/`);
    assert.equal(result.episodes.length, 12);
    assert.equal(result.episodes[11].episodeNumber, 12);
    assert.equal(result.episodes[11].group, '简中');
    if (name === 'play') assert.equal(result.episodeIndex, 7);
  }
  const detail = fs.readFileSync(new URL('fixtures/girigiri-detail.html', import.meta.url), 'utf8');
  const list = await listEpisodes(`${origin}/playGV12-1-8`, ['ani.girigirilove.com'], async url => {
    assert.equal(url, `${origin}/GV12/`); return { url, text: detail };
  });
  assert.equal(list.episodes.length, 12); assert.equal(list.episodeIndex, 7);
});

test('canonical detail fills a partial player list across all lines without selecting the wrong episode', async () => {
  const origin = 'https://ani.girigirilove.com';
  const detail = `<div class="detail-pic"><img alt="Series"></div><div class="anthology-tab"><a class="swiper-slide">A</a><a class="swiper-slide">B</a></div><ul class="anthology-list-play"><a href="/playGV12-2-2/">02</a><a href="/playGV12-1-1/">01</a><a href="/playGV12-2-1/">01</a><a href="/playGV12-2-2?ad=1">duplicate</a></ul>`;
  const player = `<ul class="anthology-list-play"><a href="/playGV12-2-2/">02</a></ul><script>var player_aaaa={"url":"https://cdn.example.com/2.mp4"}</script>`;
  const resolved = await resolveMedia(`${origin}/playGV12-2-2/`, ['ani.girigirilove.com', 'cdn.example.com'], async url => ({ url, text: url.includes('/GV12/') ? detail : player }));
  assert.equal(resolved.episodes.length, 3); assert.equal(resolved.episodeIndex, 2);
  assert.equal(resolved.episodeTitle, '02'); assert.equal(resolved.group, 'B'); assert.equal(resolved.episodeNumber, 2);
  assert.equal(resolved.url, 'https://cdn.example.com/2.mp4');
});

test('player metadata can fall back safely when the detail endpoint is unavailable', async () => {
  const url = 'https://ani.girigirilove.com/playGV12-1-1/';
  const list = await listEpisodes(url, ['ani.girigirilove.com'], async input => {
    if (input.includes('/GV12/')) throw new Error('temporary unavailable');
    return { url: input, text: '<ul class="anthology-list-play"><a href="/playGV12-1-1/">01</a></ul>' };
  });
  assert.equal(list.episodes[0].url, url);
});
