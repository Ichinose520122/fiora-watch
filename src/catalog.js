import { load } from 'cheerio';
import { allowedUrl, fetchText } from './network.js';

const origin = 'https://ani.girigirilove.com';
const clean = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 180);
export function isCatalogUrl(value) {
  try { const url = new URL(value); return url.origin === origin && /^\/(?:GV\d+|playGV\d+-\d+-\d+)\/?$/.test(url.pathname); }
  catch { return false; }
}

export async function searchCatalog(query, page = 1, hosts, read = fetchText) {
  if (typeof query !== 'string' || !query.trim() || query.length > 80) throw new Error('请输入 1–80 字的番名');
  page = Number(page);
  if (!Number.isInteger(page) || page < 1 || page > 20) throw new Error('搜索页码无效');
  const url = new URL('/index.php/ajax/suggest', origin);
  url.search = new URLSearchParams({ mid: '1', wd: query.trim(), limit: '30', page: String(page) });
  const result = await read(url.href, hosts);
  let data;
  try { data = JSON.parse(result.text); } catch { throw new Error('搜索来源暂时不可用，请稍后重试或粘贴播放页地址'); }
  if (Number(data.code) !== 1 || !Array.isArray(data.list)) throw new Error('搜索来源暂时不可用，请稍后重试');
  const seen = new Set();
  const items = data.list.slice(0, 60).filter(item => /^\d{1,12}$/.test(String(item.id)) && !seen.has(String(item.id)) && seen.add(String(item.id))).map(item => {
    let cover = '';
    try { const image = new URL(item.pic, origin); if (image.origin === origin && image.pathname.startsWith('/upload/')) cover = image.href; } catch { /* A poster is optional. */ }
    return { title: clean(item.name), url: `${origin}/GV${item.id}/`, cover, description: clean(item.remarks || '') };
  });
  const actualPage = Number(data.page) || page;
  return { items, page: actualPage, hasMore: actualPage === page && Number(data.pagecount) > page };
}

export function parseEpisodes(html, pageUrl) {
  if (!isCatalogUrl(pageUrl)) throw new Error('暂不支持此地址的分集列表');
  const $ = load(html);
  const current = new URL(pageUrl);
  const showId = /(?:play)?GV(\d+)/.exec(current.pathname)[1];
  const groups = $('.anthology-tab .swiper-slide').map((_i, element) => {
    const copy = $(element).clone(); copy.find('i,.badge').remove(); return clean(copy.text());
  }).get();
  const episodes = []; const seen = new Set();
  // Only this show's episode links are accepted; ads and recommendation cards are ignored.
  $('.anthology-list-play a[href]').each((_i, element) => {
    let url;
    try { url = new URL($(element).attr('href'), current); } catch { return; }
    const match = /^\/playGV(\d+)-(\d+)-(\d+)\/?$/.exec(url.pathname);
    if (url.origin !== origin || !match || match[1] !== showId || seen.has(url.pathname) || episodes.length >= 2000) return;
    seen.add(url.pathname);
    episodes.push({ title: clean($(element).find('span').first().text() || $(element).text()) || `第 ${match[3]} 集`, url: url.href,
      group: groups[Number(match[2]) - 1] || `线路 ${match[2]}` });
  });
  if (!episodes.length) throw new Error('此番暂无可用分集，或来源页面暂不可用');
  const title = clean($('.player-title-link').first().text() || $('.detail-pic img').attr('alt') || $('h1').first().text() || $('title').text().split(' - ')[0]);
  let cover = '';
  const poster = $(`a[href="/GV${showId}/"] img`).first();
  const picture = poster.attr('data-src') || poster.attr('src') || $('meta[property="og:image"]').attr('content') || $('.detail-pic img').attr('data-src');
  try { const image = new URL(picture, origin); if (image.origin === origin && image.pathname.startsWith('/upload/')) cover = image.href; } catch { /* Optional cover. */ }
  return { title, cover, source: `${origin}/GV${showId}/`, episodes,
    episodeIndex: Math.max(0, episodes.findIndex(item => new URL(item.url).pathname === current.pathname)) };
}

export async function listEpisodes(input, hosts, read = fetchText) {
  if (typeof input !== 'string' || input.length > 4096 || !isCatalogUrl(input)) throw new Error('请使用 Girigirilove 番剧或播放页地址');
  const result = await read(allowedUrl(input, hosts).href, hosts);
  return parseEpisodes(result.text, result.url);
}

// Cache public metadata briefly; playback URLs are always resolved when selecting an episode.
export function createCatalog(hosts, read = fetchText) {
  const cache = new Map();
  async function cached(key, task) {
    const existing = cache.get(key);
    if (existing && existing.expires > Date.now()) return existing.value;
    const value = await task();
    if (cache.size >= 100) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expires: Date.now() + 60000 });
    return value;
  }
  return {
    search: (q, page) => cached(`search:${q}:${page}`, () => searchCatalog(q, page, hosts, read)),
    episodes: url => cached(`episodes:${url}`, () => listEpisodes(url, hosts, read)),
  };
}
