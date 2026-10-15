import { allowedUrl, fetchText } from './network.js';

export function parseMacCMS(html, pageUrl) {
  // Only JSON data is read. Never evaluate the source site's JavaScript.
  const match = /\bvar\s+player_[\w]+\s*=\s*(\{[^\n]*?\})\s*(?:;|<\/script>)/i.exec(html);
  if (!match) throw new Error('此页面暂不支持解析，请输入 m3u8 / mp4 直链');
  const data = JSON.parse(match[1]);
  if (typeof data.url !== 'string' || data.url.length > 8192) throw new Error('页面没有有效视频地址');
  let url = data.url;
  if (Number(data.encrypt) === 2) url = decodeURIComponent(Buffer.from(url, 'base64').toString());
  else if (Number(data.encrypt) === 1) url = decodeURIComponent(url);
  return new URL(url, pageUrl).href;
}

export async function resolveMedia(input, hosts, read = fetchText) {
  if (typeof input !== 'string' || input.length > 4096) throw new Error('视频地址格式错误');
  const source = allowedUrl(input.trim(), hosts).href;
  let url = source;
  let title = new URL(source).pathname.split('/').filter(Boolean).pop() || '在线视频';
  if (!/\.(m3u8|mp4)(?:\?|$)/i.test(url)) {
    const page = await read(url, hosts);
    url = parseMacCMS(page.text, page.url);
    const name = /<title[^>]*>([^<]+)<\/title>/i.exec(page.text)?.[1];
    if (name) title = name.trim().slice(0, 160);
  }
  allowedUrl(url, hosts);
  if (!/\.(m3u8|mp4)(?:\?|$)/i.test(url)) throw new Error('解析结果不是支持的 HLS / MP4 视频');
  return { kind: /\.m3u8(?:\?|$)/i.test(url) ? 'hls' : 'mp4', url, source, title };
}

export function parsePlaylist(text, base, hosts) {
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(line => line.trim());
  if (lines[0] !== '#EXTM3U') throw new Error('无效的 HLS 清单');
  // First version downloads finite, unencrypted MPEG-TS VOD only.
  if (/#EXT-X-(KEY|SESSION-KEY|MAP|BYTERANGE|MEDIA:|PART:|PRELOAD-HINT)/.test(text)) throw new Error('下载暂不支持加密、分离音轨、fMP4 或字节范围 HLS，请使用在线模式');
  const urls = lines.filter(line => line && !line.startsWith('#')).map(line => allowedUrl(new URL(line, base).href, hosts).href);
  if (!urls.length || urls.length > 4000) throw new Error('HLS 分段数量无效');
  if (text.includes('#EXT-X-STREAM-INF:')) return { variant: urls[0] };
  if (!text.includes('#EXT-X-ENDLIST')) throw new Error('下载只支持已完结的点播清单');
  // Reconstruct a local playlist from a small safe tag subset, no upstream URI attributes.
  const permitted = /^#(?:EXTM3U$|EXTINF:|EXT-X-(?:VERSION:|TARGETDURATION:|MEDIA-SEQUENCE:|DISCONTINUITY$|ENDLIST$|PLAYLIST-TYPE:))/;
  let index = 0;
  const local = lines.filter(line => line && (!line.startsWith('#') || permitted.test(line)))
    .map(line => line.startsWith('#') ? line : `${index++}.ts`).join('\n');
  return { urls, local };
}
