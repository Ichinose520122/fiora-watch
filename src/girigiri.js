import { load } from 'cheerio';
import { allowedUrl, fetchText } from './network.js';

export const GIRIGIRI_ORIGIN = 'https://ani.girigirilove.com';
// The site's own frontend uses this fixed public API. It is not a general proxy:
// media URLs still require the administrator's MEDIA_ALLOWED_HOSTS allowlist.
const API_ORIGIN = 'https://m3u8.girigirilove.com';
const API_HOSTS = Object.freeze(['m3u8.girigirilove.com']);
const MAX_EPISODES = 2000;
const clean = value => load(String(value || '')).text().replace(/\s+/g, ' ').trim().slice(0, 180);

function index(value, fallback = 0) {
  if (value === null) return fallback;
  if (!/^\d{1,4}$/.test(value) || Number(value) >= MAX_EPISODES) throw new Error('Girigiri 线路或集数编号无效');
  return Number(value);
}

export function catalogIdentity(input) {
  let url;
  try { url = new URL(input); } catch { return null; }
  if (url.origin !== GIRIGIRI_ORIGIN || url.username || url.password) return null;
  const modern = /^\/(detail|play)\/([1-9]\d{0,11})\/?$/.exec(url.pathname);
  if (modern) {
    for (const key of ['sourceIndex', 'episodeIndex']) {
      if (url.searchParams.getAll(key).length > 1) throw new Error('Girigiri 线路或集数编号重复');
    }
    return { id: modern[2], modern: true, play: modern[1] === 'play',
      sourceIndex: modern[1] === 'play' ? index(url.searchParams.get('sourceIndex')) : 0,
      episodeIndex: modern[1] === 'play' ? index(url.searchParams.get('episodeIndex')) : 0 };
  }
  const legacy = /^\/(?:GV([1-9]\d{0,11})|playGV([1-9]\d{0,11})-([1-9]\d{0,3})-([1-9]\d{0,3}))\/?$/.exec(url.pathname);
  if (!legacy) return null;
  const sourceIndex = legacy[3] ? Number(legacy[3]) - 1 : 0;
  const episodeIndex = legacy[4] ? Number(legacy[4]) - 1 : 0;
  if (sourceIndex >= MAX_EPISODES || episodeIndex >= MAX_EPISODES) throw new Error('Girigiri 线路或集数编号无效');
  return { id: legacy[1] || legacy[2], modern: false, play: !!legacy[2], sourceIndex, episodeIndex };
}

export function canonicalCatalogUrl(input) {
  const info = catalogIdentity(input);
  if (!info) throw new Error('请使用 Girigirilove 番剧或播放页地址');
  if (!info.modern) return `${GIRIGIRI_ORIGIN}/${info.play ? `playGV${info.id}-${info.sourceIndex + 1}-${info.episodeIndex + 1}` : `GV${info.id}`}/`;
  return info.play ? `${GIRIGIRI_ORIGIN}/play/${info.id}?sourceIndex=${info.sourceIndex}&episodeIndex=${info.episodeIndex}` : `${GIRIGIRI_ORIGIN}/detail/${info.id}`;
}

export function girigiriCover(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value, value.startsWith('upload/') ? 'https://jpg.girigirilove.net/' : GIRIGIRI_ORIGIN);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        ['ani.girigirilove.com', 'jpg.girigirilove.net'].includes(url.hostname) && url.pathname.startsWith('/upload/')) return url.href;
  } catch { /* Covers are optional. */ }
  return '';
}

async function api(method, parameters, hosts, read) {
  allowedUrl(GIRIGIRI_ORIGIN, hosts);
  const url = new URL(`/api.php/Vod/${method}`, API_ORIGIN);
  url.search = new URLSearchParams(parameters);
  const result = await read(url.href, API_HOSTS);
  if (result.url && new URL(result.url).origin !== API_ORIGIN) throw new Error('Girigiri 接口跳转到了非预期来源');
  let data;
  try { data = JSON.parse(result.text); } catch { throw new Error('Girigiri 接口暂不可用，请稍后重试'); }
  if (![1, 200].includes(Number(data?.code)) || !data.info || typeof data.info !== 'object') throw new Error('Girigiri 接口暂不可用或此番不可访问');
  return data.info;
}

export async function searchGirigiri(query, page, hosts, read = fetchText) {
  const limit = 24;
  const data = await api('get_list', { vod_name: query.trim(), offset: String((page - 1) * limit), limit: String(limit) }, hosts, read);
  if (!Array.isArray(data.rows)) throw new Error('Girigiri 搜索结果格式无效');
  const seen = new Set();
  const items = data.rows.slice(0, limit).filter(item => item && /^[1-9]\d{0,11}$/.test(String(item.vod_id)) && !seen.has(String(item.vod_id)) && seen.add(String(item.vod_id)))
    .map(item => ({ title: clean(item.vod_name), url: `${GIRIGIRI_ORIGIN}/detail/${item.vod_id}`, cover: girigiriCover(item.vod_pic), description: clean(item.vod_remarks || item.vod_blurb) }));
  return { items, page, hasMore: data.rows.length > 0 && Number(data.total) > page * limit };
}

export function parseGirigiriDetail(data, input) {
  const info = catalogIdentity(input);
  if (!info || String(data?.vod_id) !== info.id) throw new Error('Girigiri 返回了其他番剧的数据，请重试');
  if (typeof data.vod_play_from !== 'string' || typeof data.vod_play_url !== 'string') throw new Error('此番暂无可用分集');
  const names = data.vod_play_from.split('$$$');
  const lists = data.vod_play_url.split('$$$');
  const episodes = []; const playbackUrls = [];
  let sourceIndex = 0;
  // Match the new site's source/episode indexing, including its empty-entry filtering.
  for (let rawIndex = 0; rawIndex < names.length; rawIndex++) {
    const name = names[rawIndex].trim();
    if (!name || !lists[rawIndex]) continue;
    const entries = lists[rawIndex].split('#').map(value => {
      const separator = value.indexOf('$');
      const title = (separator < 0 ? value : value.slice(0, separator)).trim();
      const url = (separator < 0 ? value : value.slice(separator + 1)).trim();
      return title && url ? { title, url } : null;
    }).filter(Boolean);
    if (!entries.length) continue;
    if (episodes.length + entries.length > MAX_EPISODES) throw new Error('Girigiri 分集数量超过限制');
    const group = ({ chs: '简中', cht: '繁中' })[name] || clean(name) || `线路 ${sourceIndex + 1}`;
    entries.forEach((entry, episodeIndex) => {
      episodes.push({ title: clean(entry.title) || `第 ${episodeIndex + 1} 集`,
        url: `${GIRIGIRI_ORIGIN}/play/${info.id}?sourceIndex=${sourceIndex}&episodeIndex=${episodeIndex}`,
        group, groupId: sourceIndex + 1, episodeNumber: episodeIndex + 1 });
      playbackUrls.push(entry.url);
    });
    sourceIndex++;
  }
  if (!episodes.length) throw new Error('此番暂无可用分集');
  const episodeIndex = info.play ? episodes.findIndex(item => item.groupId === info.sourceIndex + 1 && item.episodeNumber === info.episodeIndex + 1) : 0;
  if (episodeIndex < 0) throw new Error('指定的 Girigiri 线路或集数不存在');
  return { catalog: { title: clean(data.vod_name), cover: girigiriCover(data.vod_pic), description: clean(data.vod_blurb || data.vod_content),
    source: `${GIRIGIRI_ORIGIN}/detail/${info.id}`, episodes, episodeIndex }, playbackUrls };
}

export async function loadGirigiri(input, hosts, read = fetchText) {
  const info = catalogIdentity(input);
  if (!info) throw new Error('请使用 Girigirilove 番剧或播放页地址');
  allowedUrl(input, hosts);
  const data = await api('get_detail', { vod_id: info.id, user_id: '' }, hosts, read);
  return parseGirigiriDetail(data, input);
}

export async function resolveGirigiri(input, hosts, read = fetchText) {
  const { catalog, playbackUrls } = await loadGirigiri(input, hosts, read);
  const episode = catalog.episodes[catalog.episodeIndex];
  const url = allowedUrl(playbackUrls[catalog.episodeIndex], hosts).href;
  if (!/\.(m3u8|mp4)$/i.test(new URL(url).pathname)) throw new Error('此 Girigiri 线路不是支持的 HLS / MP4 视频，请选择其他线路');
  return { kind: /\.m3u8$/i.test(new URL(url).pathname) ? 'hls' : 'mp4', url,
    source: episode.url, title: `${catalog.title} · ${episode.title}`, episodes: catalog.episodes, episodeIndex: catalog.episodeIndex,
    seriesTitle: catalog.title, cover: catalog.cover, episodeTitle: episode.title, group: episode.group, episodeNumber: episode.episodeNumber };
}
