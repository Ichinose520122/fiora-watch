import { createHash } from 'node:crypto';
import { allowedUrl, fetchText } from './network.js';

const API_HOSTS = Object.freeze(['api.bilibili.com']);
// Explicit provider subtitle hosts; do not reuse the video/custom-source allowlist.
const SUBTITLE_HOSTS = Object.freeze(['aisubtitle.hdslb.com']);
const HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
});
const BV = /^BV[1-9A-HJ-NP-Za-km-z]{10}$/;
const MIXIN_ORDER = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TIME = 7 * 86400;

export class BilibiliSubtitleError extends Error {
  constructor(code, message, cause) { super(message, cause ? { cause } : undefined); this.code = code; }
}

function failure(error) {
  if (error instanceof BilibiliSubtitleError) return error;
  if (/HTTP\s*(?:412|429|403)\b/.test(error?.message || '')) return new BilibiliSubtitleError('rate_limited', 'B站暂时限制字幕访问，请稍后重试', error);
  return new BilibiliSubtitleError('unavailable', 'B站字幕暂时不可用，视频仍可正常播放', error);
}

async function api(path, parameters, read, allowAnonymousNav = false) {
  const url = new URL(path, 'https://api.bilibili.com');
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
  const result = await read(url.href, API_HOSTS, AbortSignal.timeout(15000), { headers: HEADERS });
  if (typeof result?.text !== 'string' || Buffer.byteLength(result.text) > MAX_BYTES) throw new BilibiliSubtitleError('unavailable', 'B站字幕接口数据无效');
  let body;
  try { body = JSON.parse(result.text); } catch { throw new BilibiliSubtitleError('unavailable', 'B站字幕接口未返回有效数据'); }
  if (body.code === -101 && allowAnonymousNav && body.data?.wbi_img) return body.data;
  if ([-101, -111].includes(body.code)) throw new BilibiliSubtitleError('login_required', '此视频字幕需要登录B站账号');
  if ([-352, -403, -412, -509].includes(body.code)) throw new BilibiliSubtitleError('rate_limited', 'B站暂时限制字幕访问，请稍后重试');
  if (body.code !== 0 || !body.data) throw new BilibiliSubtitleError('unavailable', 'B站字幕接口暂不可用');
  return body.data;
}

// Exported for deterministic protocol tests. Keys are public assets, never account secrets.
export function signBilibiliWbi(parameters, imageKey, subKey, now = Date.now()) {
  if (![imageKey, subKey].every(key => typeof key === 'string' && /^[a-f0-9]{32}$/i.test(key))) throw new Error('B站 WBI 公共签名参数无效');
  const raw = imageKey + subKey;
  const mixin = MIXIN_ORDER.map(index => raw[index]).join('').slice(0, 32);
  const values = { ...parameters, wts: Math.floor(now / 1000) };
  delete values.w_rid;
  const query = Object.keys(values).sort().map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(values[key]).replace(/[!'()*]/g, ''))}`).join('&');
  return { ...values, w_rid: createHash('md5').update(query + mixin).digest('hex') };
}

function subtitleUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\\\s\u0000-\u001f]/.test(value)) throw new BilibiliSubtitleError('unavailable', 'B站字幕地址无效');
  let url;
  try { url = allowedUrl(value.startsWith('//') ? `https:${value}` : value, SUBTITLE_HOSTS); } catch { throw new BilibiliSubtitleError('unavailable', 'B站字幕来源未允许'); }
  if (url.protocol !== 'https:' || url.port || url.hash || !/^\/bfs\/(?:subtitle|ai_subtitle)\//.test(url.pathname)) throw new BilibiliSubtitleError('unavailable', 'B站字幕地址无效');
  return url.href;
}

async function metadata(value, read) {
  const info = value?.bilibili || value;
  if (BV.test(info?.bvid) && Number.isSafeInteger(info.cid) && info.cid > 0) return { bvid: info.bvid, cid: info.cid };
  // Upgrade pre-subtitle room state lazily, selecting the exact canonical source part.
  let source;
  try { source = allowedUrl(value?.source || info?.source, ['www.bilibili.com']); } catch { throw new BilibiliSubtitleError('unavailable', '当前房间缺少字幕资料，请重新选择B站视频'); }
  const bvid = /^\/video\/(BV[1-9A-HJ-NP-Za-km-z]{10})\/?$/.exec(source.pathname)?.[1];
  const page = source.searchParams.get('p') || '1';
  if (!bvid || source.protocol !== 'https:' || !/^[1-9]\d{0,4}$/.test(page)) throw new BilibiliSubtitleError('unavailable', '当前房间缺少字幕资料，请重新选择B站视频');
  const data = await api('/x/web-interface/view', { bvid }, read);
  const selected = Array.isArray(data.pages) && data.pages.length <= 2000 ? data.pages.find(item => item?.page === Number(page)) : undefined;
  if (data.bvid !== bvid || !Number.isSafeInteger(selected?.cid) || selected.cid <= 0) throw new BilibiliSubtitleError('unavailable', '当前房间字幕分P资料无效，请重新选择B站视频');
  return { bvid, cid: selected.cid };
}

function verifyPlayer(data, selected) {
  // Bind the response to the selected part even when upstream JSON is otherwise valid.
  if (data.bvid !== selected.bvid || data.cid !== selected.cid) throw new BilibiliSubtitleError('unavailable', 'B站返回的字幕与当前视频不匹配');
  if (!Array.isArray(data.subtitle?.subtitles)) throw new BilibiliSubtitleError('unavailable', 'B站字幕列表无效');
  return data;
}

async function player(selected, read) {
  try { return verifyPlayer(await api('/x/player/v2', selected, read), selected); }
  catch (error) {
    // Do not amplify a clear login/rate-limit response with additional requests.
    if (failure(error).code !== 'unavailable') throw error;
    const nav = await api('/x/web-interface/nav', {}, read, true);
    const keys = ['img_url', 'sub_url'].map(name => {
      const value = nav.wbi_img?.[name];
      return typeof value === 'string' ? /\/([a-f0-9]{32})\.[a-z]+(?:\?|$)/i.exec(value)?.[1] : undefined;
    });
    return verifyPlayer(await api('/x/player/wbi/v2', signBilibiliWbi(selected, ...keys), read), selected);
  }
}

/** Non-fatal discovery. Input is server-held media.bilibili or resolved media.
 * Returned CDN URLs stay on the server; expose only opaque indices to clients.
 * read may be authenticatedBilibiliReader: only official API receives cookies.
 */
export async function listBilibiliSubtitles(media, read = fetchText) {
  try {
    const selected = await metadata(media, read);
    const data = await player(selected, read);
    if (data.need_login_subtitle) return { status: 'login_required', message: '此视频字幕需要登录B站账号', subtitles: [] };
    const tracks = data.subtitle?.subtitles;
    if (!Array.isArray(tracks) || tracks.length > 50) throw new BilibiliSubtitleError('unavailable', 'B站字幕列表无效');
    const subtitles = [];
    for (const track of tracks) {
      if (!track || typeof track.lan !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(track.lan) || !track.subtitle_url) continue;
      try {
        const url = subtitleUrl(track.subtitle_url);
        const label = String(track.lan_doc || track.lan).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80) + (track.lan.startsWith('ai-') ? '（AI）' : '');
        // Keep menu identity across list reordering and expiring CDN signatures.
        const identity = String(track.id_str || track.id || new URL(url).pathname);
        const id = createHash('sha256').update(`${track.lan}:${identity}`).digest('hex').slice(0, 24);
        if (!subtitles.some(item => item.id === id)) subtitles.push({ id, label, language: track.lan, url });
      } catch { /* Skip an unsafe track without discarding other valid provider tracks. */ }
    }
    if (tracks.length && !subtitles.length) throw new BilibiliSubtitleError('unavailable', 'B站未提供可用的安全字幕地址');
    return { status: subtitles.length ? 'available' : 'none', message: subtitles.length ? '' : '当前视频没有可用字幕', subtitles };
  } catch (error) {
    const result = failure(error);
    return { status: result.code, message: result.message, subtitles: [] };
  }
}

function timestamp(seconds) {
  const milliseconds = Math.round(seconds * 1000);
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor(milliseconds / 60000) % 60;
  const secs = Math.floor(milliseconds / 1000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
}

export function bilibiliSubtitleToVtt(input) {
  let data = input;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input) > MAX_BYTES) throw new BilibiliSubtitleError('unavailable', 'B站字幕文件过大');
    try { data = JSON.parse(input); } catch { throw new BilibiliSubtitleError('unavailable', 'B站字幕文件不是有效 JSON'); }
  }
  if (!Array.isArray(data?.body) || data.body.length > 30000) throw new BilibiliSubtitleError('unavailable', 'B站字幕内容无效');
  let bytes = 0;
  const cues = data.body.map(cue => {
    if (!cue || typeof cue.from !== 'number' || typeof cue.to !== 'number' || !Number.isFinite(cue.from) || !Number.isFinite(cue.to) || cue.from < 0 || cue.to <= cue.from || cue.to > MAX_TIME || Math.round(cue.to * 1000) <= Math.round(cue.from * 1000) || typeof cue.content !== 'string' || cue.content.length > 10000) throw new BilibiliSubtitleError('unavailable', 'B站字幕时间或文本无效');
    bytes += Buffer.byteLength(cue.content);
    if (bytes > MAX_BYTES) throw new BilibiliSubtitleError('unavailable', 'B站字幕文件过大');
    // Plain text only: escape VTT markup and neutralize blank-line cue injection.
    const content = cue.content.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').split('\n').map(line => line.trim()).filter(Boolean).join('\n');
    return content ? { from: cue.from, to: cue.to, content } : null;
  }).filter(Boolean).sort((a, b) => a.from - b.from);
  return `WEBVTT\n\n${cues.map((cue, index) => `${index + 1}\n${timestamp(cue.from)} --> ${timestamp(cue.to)}\n${cue.content}\n\n`).join('')}`;
}

/** Fetch only a server-held discovered track, using a credential-free CDN reader. */
export async function fetchBilibiliSubtitle(track, read = fetchText) {
  const url = subtitleUrl(track?.url);
  try {
    const result = await read(url, SUBTITLE_HOSTS, AbortSignal.timeout(30000), { headers: HEADERS });
    // Enforce the destination on injected readers too. fetchText validates every redirect.
    subtitleUrl(result?.url || url);
    return bilibiliSubtitleToVtt(result?.text);
  } catch (error) { throw failure(error); }
}
