import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchCatalog, parseEpisodes } from '../src/catalog.js';

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
