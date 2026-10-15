import path from 'node:path';

export function loadConfig(env = process.env) {
  const publicUrl = new URL(env.WATCH_PUBLIC_URL || 'http://localhost:9300');
  const issuer = new URL(env.FIORA_ORIGIN || 'http://localhost:9200');
  for (const url of [publicUrl, issuer]) {
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password ||
        !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('服务地址必须是 HTTPS 根域名（本地开发允许 HTTP）');
  }
  if (!env.WATCH_SHARED_SECRET || env.WATCH_SHARED_SECRET.length < 32) throw new Error('WATCH_SHARED_SECRET 必须至少 32 字符，且与 Fiora 的 WatchSharedSecret 一致');
  const positive = (value, fallback) => { const number = Number(value || fallback); if (!Number.isFinite(number) || number <= 0) throw new Error('容量或端口配置无效'); return number; };
  return {
    port: positive(env.PORT, 9300), host: env.HOST || '0.0.0.0',
    audience: publicUrl.origin, issuer: issuer.origin, secret: env.WATCH_SHARED_SECRET,
    dataDir: path.resolve(env.DATA_DIR || 'data'), libraryDir: path.resolve(env.LIBRARY_DIR || 'library'),
    hosts: (env.MEDIA_ALLOWED_HOSTS || 'ani.girigirilove.com,akua.girigirilove.com').split(',').map(value => value.trim().toLowerCase()).filter(Boolean),
    cacheBytes: positive(env.CACHE_GB, 20) * 1024 ** 3,
    maxDownloadBytes: positive(env.MAX_DOWNLOAD_GB, 4) * 1024 ** 3,
  };
}
