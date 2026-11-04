import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { allowedUrl } from './network.js';

const run = promisify(execFile);
export const socialHosts = {
  youtube: ['*.googlevideo.com'],
  x: ['video.twimg.com'],
};
let active = 0;

const youtubeMuxed = "b[ext=mp4][protocol~='^(https|m3u8(_native)?)$']";
const youtubeSplit = 'bv[vcodec^=avc1][protocol=https][container=mp4_dash][height>360]+ba[acodec^=mp4a][protocol=https][container=m4a_dash][audio_channels<=?2]';

export function youtubeTrackUrl(value) {
  const url = allowedUrl(value, socialHosts.youtube);
  if (url.protocol !== 'https:') throw new Error('YouTube 轨道地址无效');
  return url.href;
}

function youtubeTracks(formats) {
  if (!Array.isArray(formats) || formats.length !== 2) throw new Error('缺少 YouTube 音视频轨道');
  return formats.map((format, index) => {
    const video = index === 0;
    const codecs = video ? format.vcodec : format.acodec;
    if (!(video ? /^avc1\.[a-f\d]{6}$/i : /^mp4a\.40\.\d+$/).test(codecs) ||
        (video && (![format.width, format.height].every(n => Number.isSafeInteger(n) && n > 0)))) throw new Error('YouTube 轨道格式无效');
    const bandwidth = Math.round(format.tbr * 1000);
    return { id: video ? 'video' : 'audio', type: video ? 'video' : 'audio', url: youtubeTrackUrl(format.url),
      codecs, bandwidth: bandwidth > 0 && Number.isSafeInteger(bandwidth) ? bandwidth : (video ? 3000000 : 128000),
      ...(video ? { width: format.width, height: format.height } : {}) };
  });
}

export function socialSource(input) {
  let url;
  try { url = new URL(input); } catch { return null; }
  const host = url.hostname.replace(/^(?:www\.|m\.|mobile\.)/, '');
  if (!['youtube.com', 'youtu.be', 'x.com', 'twitter.com'].includes(host)) return null;
  if (!['https:', 'http:'].includes(url.protocol) || url.port || url.username || url.password) throw new Error('视频链接格式错误');
  if (host === 'youtube.com' || host === 'youtu.be') {
    const id = host === 'youtu.be' ? /^\/([^/]+)\/?$/.exec(url.pathname)?.[1]
      : url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:shorts|embed|live)\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    if (!/^[\w-]{11}$/.test(id || '')) throw new Error('请输入 YouTube 单个视频的链接');
    return { provider: 'youtube', source: 'https://www.youtube.com/watch?v=' + id };
  }
  const match = /^\/(?:[a-zA-Z0-9_]+|i\/web)\/status\/(\d{1,20})(\/video\/[1-4])?\/?$/.exec(url.pathname);
  if (!match) throw new Error('请输入含视频的 X 帖子链接');
  return { provider: 'x', source: 'https://x.com/i/status/' + match[1] + (match[2] || '') };
}

export async function resolveSocial(selection, execute = run, youtubeAccount) {
  if (active >= 3) throw new Error('视频解析繁忙，请稍后再试');
  active++;
  try {
    const youtube = selection.provider === 'youtube';
    const extract = cookieArgs => execute('yt-dlp', [
      ...cookieArgs,
      '--ignore-config', '--no-cache-dir', '--no-playlist', '--playlist-items', '1', '--js-runtimes', 'node',
      '--use-extractors', selection.provider === 'youtube' ? 'youtube' : 'twitter',
      '--socket-timeout', '12', '--retries', '0', '--extractor-retries', '0',
      '-f', youtube ? youtubeSplit + '/' + youtubeMuxed : 'b[ext=mp4][protocol=https]/b[ext=mp4][protocol^=m3u8]',
      '--print', '%(.{url,title,protocol,live_status,duration})j',
      ...(youtube ? ['--print', '%(requested_formats.:.{url,vcodec,acodec,tbr,width,height})j'] : []), '--', selection.source,
    ], { timeout: 45000, maxBuffer: 128 * 1024, windowsHide: true });
    const { stdout } = youtube && youtubeAccount ? await youtubeAccount.withCookies(extract) : await extract([]);
    const [metadata, tracks] = stdout.trim().split(/\r?\n/);
    const data = JSON.parse(metadata);
    if (['is_live', 'is_upcoming', 'post_live'].includes(data.live_status)) throw new Error();
    if (youtube && data.protocol === 'https+https') {
      if (!Number.isFinite(data.duration) || data.duration <= 0 || data.duration > 7 * 86400) throw new Error();
      return { ...selection, kind: 'dash', title: String(data.title || 'YouTube').slice(0, 160),
        youtubeDash: { duration: data.duration, tracks: youtubeTracks(JSON.parse(tracks)) } };
    }
    const url = allowedUrl(data.url, socialHosts[selection.provider]);
    if (url.protocol !== 'https:') throw new Error();
    return { ...selection, url: url.href, title: String(data.title || '在线视频').slice(0, 160),
      kind: data.protocol.startsWith('m3u8') ? 'hls' : 'mp4' };
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('影院未安装 yt-dlp 视频解析器');
    if (selection.provider === 'youtube') throw new Error('未能解析 YouTube 视频，请检查影院网络、视频权限或在播放设置中重新绑定账号');
    throw new Error('未能解析公开视频，请确认帖子内含视频、无需登录且影院服务器可访问该平台');
  } finally { active--; }
}
