import { randomBytes, createCipheriv, createDecipheriv, createHmac } from 'node:crypto';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { allowedUrl, requestPublic } from './network.js';

const MANIFEST_TYPES = /^(?:application\/(?:vnd\.apple\.mpegurl|x-mpegurl)|audio\/(?:mpegurl|x-mpegurl))(?:;|$)/i;
const MANIFEST_TAGS = new Set(['EXT-X-MEDIA', 'EXT-X-I-FRAME-STREAM-INF', 'EXT-X-RENDITION-REPORT']);
const URI_TAGS = new Set([...MANIFEST_TAGS, 'EXT-X-KEY', 'EXT-X-SESSION-KEY', 'EXT-X-MAP', 'EXT-X-PART', 'EXT-X-PRELOAD-HINT', 'EXT-X-SESSION-DATA']);
export const RELAY_LIMITS = Object.freeze({ manifestResources: 16384, manifestBytes: 2 * 1024 * 1024, urlLength: 4096, tokenLength: 5600 });

function attributes(line) {
  const start = line.indexOf(':');
  if (start < 0) return [];
  const parts = []; let quoted = false; let since = start + 1;
  for (let index = since; index <= line.length; index++) {
    if (line[index] === '"') quoted = !quoted;
    if (index === line.length || (line[index] === ',' && !quoted)) {
      const value = line.slice(since, index); parts.push({ value, match: /^\s*([A-Za-z0-9-]+)\s*=\s*(.*)$/.exec(value) }); since = index + 1;
    }
  }
  return parts;
}

// Resource URLs are opaque to browsers. Authenticated encryption binds each
// resource to its room/version without retaining a growing server URL map.
export class MediaRelay {
  constructor(hosts, request = requestPublic, limits = RELAY_LIMITS) {
    this.hosts = [...hosts]; this.request = request; this.limits = limits;
    this.key = randomBytes(32); this.nonceKey = randomBytes(32);
  }
  path(room, id = 'root') { return `/api/media/relay?room=${room.id}&version=${room.mediaVersion}&resource=${id}`; }
  associatedData(room) { return Buffer.from(`${room.id}:${room.mediaVersion}`); }
  validToken(id) { return typeof id === 'string' && id.length <= this.limits.tokenLength && /^r[A-Za-z0-9_-]{40,}$/.test(id); }
  resource(room, id) {
    if (id === 'root') return { url: allowedUrl(room.media.url, this.hosts).href, manifest: room.media.kind === 'hls' };
    if (!this.validToken(id)) return null;
    try {
      const token = Buffer.from(id.slice(1), 'base64url');
      const cipher = createDecipheriv('aes-256-gcm', this.key, token.subarray(0, 12));
      cipher.setAAD(this.associatedData(room)); cipher.setAuthTag(token.subarray(12, 28));
      const value = Buffer.concat([cipher.update(token.subarray(28)), cipher.final()]);
      if (![0, 1].includes(value[0]) || value.length > this.limits.urlLength + 1) return null;
      return { url: allowedUrl(value.subarray(1).toString('utf8'), this.hosts).href, manifest: value[0] === 1 };
    } catch { return null; }
  }
  register(room, value, base, manifest) {
    if (!value.trim() || value.length > this.limits.urlLength) throw new Error('HLS 资源地址格式无效');
    if (value.includes('{$')) throw new Error('服务器中继暂不支持 HLS 变量');
    const url = allowedUrl(new URL(value, base).href, this.hosts).href;
    if (url.length > this.limits.urlLength) throw new Error('HLS 资源地址过长');
    const aad = this.associatedData(room);
    const plaintext = Buffer.concat([Buffer.from([manifest ? 1 : 0]), Buffer.from(url)]);
    // Independent HMAC key derives a nonce from the complete authenticated
    // message. Identical requests have stable URLs; distinct messages do not
    // reuse a nonce except with the negligible 96-bit collision probability.
    const nonce = createHmac('sha256', this.nonceKey).update(aad).update(Buffer.from([0])).update(plaintext).digest().subarray(0, 12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce); cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return this.path(room, 'r' + Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url'));
  }
  rewrite(room, text, base) {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    if (lines[0].trim() !== '#EXTM3U') throw new Error('无效的 HLS 清单');
    let nextManifest = false; let resources = 0;
    const addressPath = (value, manifest) => {
      if (++resources > this.limits.manifestResources) throw new Error('播放清单资源数量超过中继限制');
      return this.register(room, value, base, manifest);
    };
    return lines.map(raw => {
      const line = raw.trim();
      if (!line) return '';
      if (!line.startsWith('#')) {
        const result = addressPath(line, nextManifest || /\.m3u8(?:[?#]|$)/i.test(line));
        nextManifest = false; return result;
      }
      const tag = /^#([A-Z0-9-]+)/.exec(line)?.[1];
      if (['EXT-X-DEFINE', 'EXT-X-CONTENT-STEERING'].includes(tag)) throw new Error('服务器中继暂不支持此 HLS 清单扩展');
      if (tag === 'EXT-X-STREAM-INF') nextManifest = true;
      // Reject unknown URI-bearing extensions instead of letting a browser make
      // an unmediated request. All standard media/key/map/variant URIs are mapped.
      const parts = attributes(line);
      const addresses = parts.filter(part => part.match && /URI$/i.test(part.match[1]));
      if (!addresses.length) return line;
      if (!URI_TAGS.has(tag) || addresses.some(part => part.match[1] !== 'URI')) throw new Error('服务器中继暂不支持此 HLS 地址扩展');
      if (addresses.length !== 1 || !/^"[^"\r\n]*"$/.test(addresses[0].match[2])) throw new Error('HLS 地址属性格式无效');
      const address = addresses[0];
      address.value = `URI="${addressPath(address.match[2].slice(1, -1), MANIFEST_TAGS.has(tag))}"`;
      return `${line.slice(0, line.indexOf(':') + 1)}${parts.map(part => part.value).join(',')}`;
    }).join('\n');
  }
  async open(resource, range, signal) {
    if (range !== undefined && (typeof range !== 'string' || !/^bytes=\d*-\d*$/.test(range) || range.length > 100)) throw new Error('视频字节范围无效');
    return this.request(resource.url, this.hosts, signal, {
      acceptedStatus: [200, 206, 416], headers: !resource.manifest && range ? { Range: range } : {},
    });
  }
  isManifest(resource, upstream) {
    return resource.manifest || MANIFEST_TYPES.test(String(upstream.response.headers['content-type'] || '')) || /\.m3u8(?:[?#]|$)/i.test(upstream.url || resource.url);
  }
  async manifest(room, upstream, signal) {
    const response = upstream.response;
    const encoding = response.headers['content-encoding'];
    const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
    if (encoding && encoding !== 'identity' && !decoder) { response.destroy(); throw new Error('HLS 清单压缩格式不支持'); }
    const stream = decoder ? response.pipe(decoder) : response;
    if (decoder) response.on('error', error => decoder.destroy(error));
    const abort = () => { response.destroy(); decoder?.destroy(signal.reason || new Error('请求已取消')); };
    signal?.addEventListener('abort', abort, { once: true });
    const chunks = []; let size = 0;
    try {
      signal?.throwIfAborted();
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > this.limits.manifestBytes) throw new Error('HLS 播放清单过大');
        chunks.push(chunk);
      }
      signal?.throwIfAborted();
      return this.rewrite(room, Buffer.concat(chunks).toString('utf8'), upstream.url);
    } finally { signal?.removeEventListener('abort', abort); response.destroy(); decoder?.destroy(); }
  }
}
