import { allowedUrl, fetchText, requestPublic } from './network.js';

// These domains belong to the supported provider, independent of custom source settings.
const SITE_HOSTS = Object.freeze(['www.bilibili.com', 'bilibili.com', 'm.bilibili.com', 'b23.tv']);
const API_HOSTS = Object.freeze(['api.bilibili.com']);
// Exact overseas hostname observed in the official anonymous playurl response.
// Do not allow other Akamai customer domains or a wildcard for akamaized.net.
const CDN_HOSTS = Object.freeze(['*.bilivideo.com', 'upos-hz-mirrorakam.akamaized.net']);
const COVER_HOSTS = Object.freeze(['i0.hdslb.com', 'i1.hdslb.com', 'i2.hdslb.com']);
const HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
});
const BV = /^BV[1-9A-HJ-NP-Za-km-z]{10}$/;
const AV = /^av([1-9]\d{0,15})$/i;
const UNSUPPORTED = 'B站此视频需要登录、付费、地区授权或使用不支持的播放形式，请使用官方播放器';
const ACCESS_RESTRICTED = 'B站暂时限制了影院服务器的访问（HTTP 412），请稍后重试或使用官方播放器';
const restricted = error => /HTTP\s*412\b/.test(String(error?.message || ''));

// Only the official API and video page receive credentials, never short links or CDNs.
export function authenticatedBilibiliReader(account, read = fetchText) {
  return (value, hosts, signal, options = {}) => {
    const url = new URL(value);
    const cookie = url.protocol === 'https:' && ['api.bilibili.com', 'www.bilibili.com'].includes(url.hostname) && !url.port ? account.cookieHeader() : '';
    return read(value, hosts, signal, { ...options, headers: { ...options.headers, ...(cookie ? { Cookie: cookie } : {}) } });
  };
}

function inputUrl(input) {
  if (typeof input !== 'string' || input.length > 4096) throw new Error('B站视频地址格式错误');
  const value = input.trim();
  const source = BV.test(value) || AV.test(value) ? `https://www.bilibili.com/video/${value}` : value;
  const url = allowedUrl(source, SITE_HOSTS);
  if (url.protocol !== 'https:') throw new Error('B站视频地址需要使用 HTTPS');
  return url;
}

export function isBilibiliUrl(input) {
  if (typeof input !== 'string') return false;
  if (BV.test(input.trim()) || AV.test(input.trim())) return true;
  try { return SITE_HOSTS.includes(new URL(input.trim()).hostname); } catch { return false; }
}

async function readProvider(url, hosts, read = fetchText) {
  return read(url, hosts, AbortSignal.timeout(30000), { headers: HEADERS });
}

async function identity(input, read) {
  let url = inputUrl(input);
  if (url.hostname === 'b23.tv') {
    if (!/^\/[a-zA-Z0-9]+\/?$/.test(url.pathname)) throw new Error('B站短链接格式错误');
    if (read === fetchText) {
      // Only need the final validated URL; do not download a whole video page.
      const result = await requestPublic(url.href, SITE_HOSTS, AbortSignal.timeout(30000), { headers: HEADERS });
      result.response.destroy(); url = inputUrl(result.url);
    } else url = inputUrl((await readProvider(url.href, SITE_HOSTS, read)).url);
  }
  const id = /^\/video\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  if (!id || (!BV.test(id) && !AV.test(id))) throw new Error('仅支持B站 BV / av 普通公开视频及其分P，暂不支持番剧、直播或课程');
  const page = url.searchParams.get('p') || '1';
  if (!/^[1-9]\d{0,4}$/.test(page)) throw new Error('B站分P编号无效');
  return { id, page: Number(page) };
}

async function api(path, parameters, read) {
  const url = new URL(`https://api.bilibili.com${path}`);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
  let result;
  try { result = await readProvider(url.href, API_HOSTS, read); }
  catch (error) {
    if (restricted(error)) throw new Error(ACCESS_RESTRICTED, { cause: error });
    throw error;
  }
  let body;
  try { body = JSON.parse(result.text); } catch { throw new Error('B站接口未返回有效数据，可能触发访问限制，请稍后重试'); }
  if (body.code !== 0 || !body.data) {
    if (body.code === -412) throw new Error(ACCESS_RESTRICTED);
    if ([-403, -404, -10403, 62002, 62004].includes(body.code)) throw new Error(UNSUPPORTED);
    throw new Error(`B站接口暂不可用（${Number.isInteger(body.code) ? body.code : '未知'}），请稍后重试`);
  }
  return body.data;
}

function canonical(bvid, page) { return `https://www.bilibili.com/video/${bvid}/?p=${page}`; }

function initialState(text) {
  // Read only the balanced JSON object assigned by the public video page. Never eval scripts.
  const marker = /(?:^|[\s;>])window\.__INITIAL_STATE__\s*=\s*/.exec(text);
  if (!marker) throw new Error('B站公开页面没有可用的视频资料，请稍后重试或使用官方播放器');
  const start = marker.index + marker[0].length;
  if (text[start] !== '{') throw new Error('B站公开页面视频资料不是有效 JSON');
  let depth = 0; let quoted = false; let escaped = false;
  for (let offset = start; offset < text.length; offset += 1) {
    const character = text[offset];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(start, offset + 1)); }
      catch { throw new Error('B站公开页面视频资料不是有效 JSON'); }
    }
  }
  throw new Error('B站公开页面视频资料不完整');
}

async function pageMetadata(selected, read) {
  const result = await readProvider(canonical(selected.id, selected.page), SITE_HOSTS, read);
  const data = initialState(result.text)?.videoData;
  const sameVideo = BV.test(selected.id) ? data?.bvid === selected.id : String(data?.aid) === AV.exec(selected.id)[1];
  if (!sameVideo) throw new Error('B站公开页面未提供所选视频资料，请使用官方播放器');
  return data;
}

function safeCover(value) {
  if (typeof value !== 'string' || value.length > 4096) return '';
  try {
    const url = allowedUrl(value, COVER_HOSTS);
    url.protocol = 'https:';
    if (url.port) return '';
    return url.href;
  } catch { return ''; }
}

async function metadata(input, read) {
  const selected = await identity(input, read);
  let data;
  try { data = await api('/x/web-interface/view', BV.test(selected.id) ? { bvid: selected.id } : { aid: AV.exec(selected.id)[1] }, read); }
  catch (error) {
    if (!restricted(error)) throw error;
    // Some server IPs can read normal public pages and playurl but cannot call view.
    // This is the same anonymous metadata embedded in that public page, with all checks below retained.
    try { data = await pageMetadata(selected, read); }
    catch (pageError) {
      if (restricted(pageError)) throw new Error(ACCESS_RESTRICTED, { cause: pageError });
      throw pageError;
    }
  }
  if (!BV.test(data.bvid) || !Array.isArray(data.pages) || !data.pages.length || data.pages.length > 2000) throw new Error('B站没有有效的分P列表');
  if (data.rights?.pay || data.rights?.ugc_pay || data.rights?.arc_pay || data.rights?.is_stein_gate ||
      data.is_upower_exclusive || data.is_upower_preview || data.is_chargeable_season) throw new Error(UNSUPPORTED);
  const title = String(data.title || 'B站视频').slice(0, 160);
  const pages = data.pages;
  if (pages.some(page => !Number.isSafeInteger(page.cid) || page.cid <= 0 || !Number.isSafeInteger(page.page) || page.page <= 0)) throw new Error('B站分P列表无效');
  const episodeIndex = pages.findIndex(page => page.page === selected.page);
  if (episodeIndex < 0) throw new Error('所选B站分P不存在');
  const episodes = pages.map(page => ({ title: `P${page.page} ${String(page.part || title).slice(0, 160)}`, url: canonical(data.bvid, page.page), group: title }));
  return { data, selected: pages[episodeIndex], title, seriesTitle: title, cover: safeCover(data.pic), source: canonical(data.bvid, selected.page), episodes, episodeIndex };
}

export async function listBilibiliEpisodes(input, _hosts, read = fetchText) {
  const { title, seriesTitle, cover, source, episodes, episodeIndex } = await metadata(input, read);
  return { title, seriesTitle, cover, source, episodes, episodeIndex };
}

function mediaUrl(value) {
  const url = allowedUrl(value, CDN_HOSTS);
  if (url.protocol !== 'https:' || !/\.(?:m4s|mp4)$/i.test(url.pathname)) throw new Error('B站返回了不支持的媒体地址');
  return url.href;
}

function segmentRange(value) {
  if (typeof value !== 'string' || !/^\d+-\d+$/.test(value)) throw new Error('B站 DASH 字节索引无效');
  const [start, end] = value.split('-').map(Number);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end) throw new Error('B站 DASH 字节索引无效');
  return `${start}-${end}`;
}

function trackFrom(item, type, index) {
  if (item.drm || item.is_drm || item.drm_type) throw new Error(UNSUPPORTED);
  const segment = item.SegmentBase || item.segment_base;
  const mimeType = item.mimeType || item.mime_type;
  const codecs = item.codecs;
  if (mimeType !== `${type}/mp4` || typeof codecs !== 'string' || !/^[\w.,-]{1,100}$/.test(codecs) || !Number.isSafeInteger(item.bandwidth) || item.bandwidth < 1) throw new Error('B站 DASH 轨道信息无效');
  const track = {
    id: `${type}-${index}`, type, url: mediaUrl(item.baseUrl || item.base_url), mimeType, codecs,
    bandwidth: item.bandwidth, indexRange: segmentRange(segment?.indexRange || segment?.index_range),
    initialization: segmentRange(segment?.Initialization || segment?.initialization),
  };
  const [initStart, initEnd] = track.initialization.split('-').map(Number);
  const [indexStart] = track.indexRange.split('-').map(Number);
  if (initStart !== 0 || initEnd >= indexStart) throw new Error('B站 DASH 初始化与索引范围重叠');
  if (type === 'video') {
    if (![item.width, item.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 16384)) throw new Error('B站视频尺寸无效');
    track.width = item.width; track.height = item.height;
    const rate = String(item.frameRate || item.frame_rate || '');
    if (/^\d+(?:\.\d+|\/\d+)?$/.test(rate) && rate.length < 24) track.frameRate = rate;
  }
  return track;
}

export async function resolveBilibili(input, _hosts, read = fetchText) {
  const info = await metadata(input, read);
  const data = await api('/x/player/playurl', { bvid: info.data.bvid, cid: info.selected.cid, fnval: 144, qn: 127, fourk: 1 }, read);
  if (data.is_preview || data.drm_tech_type || data.drm_type || data.need_login || data.need_vip) throw new Error(UNSUPPORTED);
  const common = { source: info.source, title: info.episodes.length > 1 ? `${info.title} · ${info.episodes[info.episodeIndex].title}` : info.title, seriesTitle: info.title, cover: info.cover, episodes: info.episodes, episodeIndex: info.episodeIndex };
  if (data.dash) {
    const duration = Number(data.dash.duration);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 7 * 86400) throw new Error('B站视频时长无效');
    // Prefer widely supported AVC / AAC among qualities authorized by the provider.
    const videos = (data.dash.video || []).filter(item => /^avc1\./.test(item.codecs || '')).slice(0, 8);
    const audio = (data.dash.audio || []).filter(item => /^mp4a\./.test(item.codecs || '')).sort((a, b) => b.bandwidth - a.bandwidth)[0];
    if (!videos.length || !audio) throw new Error('B站没有可播放的 H.264 / AAC 音视频轨道，请使用官方播放器');
    const tracks = videos.map((item, index) => trackFrom(item, 'video', index));
    tracks.push(trackFrom(audio, 'audio', 0));
    return { ...common, kind: 'dash', bilibili: { duration, tracks } };
  }
  // Older public videos may expose a single progressive MP4, never concatenate FLV parts.
  if (data.format?.startsWith('mp4') && data.durl?.length === 1 && !data.durl[0].ahead && !data.durl[0].vhead) {
    const duration = Number(data.timelength) / 1000;
    const url = mediaUrl(data.durl[0].url);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('B站视频时长无效');
    return { ...common, kind: 'mp4', bilibili: { duration, tracks: [{ id: 'muxed-0', type: 'muxed', url, mimeType: 'video/mp4' }] } };
  }
  throw new Error(UNSUPPORTED);
}

const xml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);

export function buildBilibiliManifest(media, trackUrl) {
  if (media.kind !== 'dash' || !media.bilibili?.tracks?.length) throw new Error('没有有效的B站 DASH 清单');
  const adaptations = ['video', 'audio'].map(type => {
    const representations = media.bilibili.tracks.map((track, index) => {
      if (track.type !== type) return '';
      const local = trackUrl(track, index);
      if (typeof local !== 'string' || !local.startsWith('/') || local.startsWith('//') || /[\\\r\n]/.test(local) || new URL(local, 'https://watch.invalid').origin !== 'https://watch.invalid') throw new Error('B站媒体代理必须使用同源路径');
      const dimensions = type === 'video' ? ` width="${track.width}" height="${track.height}"${track.frameRate ? ` frameRate="${xml(track.frameRate)}"` : ''}` : '';
      return `<Representation id="${xml(track.id)}" bandwidth="${track.bandwidth}" codecs="${xml(track.codecs)}"${dimensions}><BaseURL>${xml(local)}</BaseURL><SegmentBase indexRange="${segmentRange(track.indexRange)}" indexRangeExact="true"><Initialization range="${segmentRange(track.initialization)}"/></SegmentBase></Representation>`;
    }).join('');
    if (!representations) throw new Error('B站 DASH 缺少音视频轨道');
    return `<AdaptationSet contentType="${type}" mimeType="${type}/mp4" segmentAlignment="true" startWithSAP="1">${representations}</AdaptationSet>`;
  }).join('');
  const duration = Number(media.bilibili.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 7 * 86400) throw new Error('B站视频时长无效');
  return `<?xml version="1.0" encoding="UTF-8"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" minBufferTime="PT1.5S" mediaPresentationDuration="PT${duration}S"><Period start="PT0S">${adaptations}</Period></MPD>`;
}

export function validateByteRange(range) {
  if (range === undefined || range === null || range === '') return undefined;
  if (typeof range !== 'string' || range.length > 80 || !/^bytes=(\d*)-(\d*)$/.test(range)) throw new Error('仅支持单个有效的字节范围');
  const [start, end] = range.slice(6).split('-');
  if ((!start && !end) || [start, end].some(value => value && !Number.isSafeInteger(Number(value))) ||
      (start && end && Number(start) > Number(end)) || (!start && Number(end) === 0)) throw new Error('字节范围无效');
  return range;
}

// Call only with a server-held resolved track. Client input selects an opaque token + index.
export async function requestBilibiliTrack(track, range, signal = AbortSignal.timeout(120000)) {
  const url = mediaUrl(track?.url);
  const validatedRange = validateByteRange(range);
  return requestPublic(url, CDN_HOSTS, signal, {
    headers: { ...HEADERS, ...(validatedRange ? { Range: validatedRange } : {}) },
    acceptedStatus: [200, 206, 416],
  });
}
