import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';

// Only public JS/CSS enters this cache. API responses, HTML, subtitles and video
// retain their existing authentication and no-store behavior.
export function publicAssets(root) {
  const files = new Map();
  function collect(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const relative = `${prefix}/${entry.name}`; const file = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(file, relative);
      else if (entry.isFile() && /\.(js|css)$/.test(entry.name)) files.set(relative, file);
    }
  }
  collect(path.join(root, 'public'));
  files.set('/vendor/hls.min.js', path.join(root, 'node_modules/hls.js/dist/hls.min.js'));
  files.set('/vendor/dash.all.min.js', path.join(root, 'node_modules/dashjs/dist/modern/umd/dash.all.min.js'));
  const cache = new Map();
  return (req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) || !files.has(req.path)) return next();
    const file = files.get(req.path); const stat = fs.statSync(file);
    let asset = cache.get(file);
    if (!asset || asset.mtime !== stat.mtimeMs || asset.size !== stat.size) {
      const identity = fs.readFileSync(file);
      const buffers = { identity, gzip: gzipSync(identity), br: brotliCompressSync(identity, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }) };
      asset = { mtime: stat.mtimeMs, size: stat.size, versions: Object.fromEntries(Object.entries(buffers).map(([name, body]) => [name, {
        body, etag: `"${createHash('sha256').update(body).digest('hex')}"`,
      }])) }; cache.set(file, asset);
    }
    res.vary('Accept-Encoding');
    const encoding = req.acceptsEncodings('br', 'gzip', 'identity');
    if (!encoding) return res.sendStatus(406);
    const selected = asset.versions[encoding];
    res.type(path.extname(file));
    res.set({ 'Cache-Control': 'public, max-age=0, must-revalidate', ETag: selected.etag });
    if (encoding !== 'identity') res.set('Content-Encoding', encoding);
    return res.send(selected.body);
  };
}
