import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { allowedUrl } from './network.js';

const run = promisify(execFile);
export const socialHosts = {
  youtube: ['*.googlevideo.com'],
  x: ['video.twimg.com'],
};
let active = 0;

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

export async function resolveSocial(selection, execute = run) {
  if (active >= 3) throw new Error('视频解析繁忙，请稍后再试');
  active++;
  try {
    const { stdout } = await execute('yt-dlp', [
      '--ignore-config', '--no-cache-dir', '--no-playlist', '--playlist-items', '1', '--js-runtimes', 'node',
      '--use-extractors', selection.provider === 'youtube' ? 'youtube' : 'twitter',
      '--socket-timeout', '12', '--retries', '0', '--extractor-retries', '0',
      '-f', 'b[ext=mp4][protocol=https]/b[ext=mp4][protocol^=m3u8]',
      '--print', '%(.{url,title,protocol,live_status})j', '--', selection.source,
    ], { timeout: 45000, maxBuffer: 128 * 1024, windowsHide: true });
    const data = JSON.parse(stdout);
    if (['is_live', 'is_upcoming', 'post_live'].includes(data.live_status)) throw new Error();
    const url = allowedUrl(data.url, socialHosts[selection.provider]);
    if (url.protocol !== 'https:') throw new Error();
    return { ...selection, url: url.href, title: String(data.title || '在线视频').slice(0, 160),
      kind: data.protocol.startsWith('m3u8') ? 'hls' : 'mp4' };
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('影院未安装 yt-dlp 视频解析器');
    throw new Error('未能解析公开视频，请确认帖子内含视频、无需登录且影院服务器可访问该平台');
  } finally { active--; }
}
