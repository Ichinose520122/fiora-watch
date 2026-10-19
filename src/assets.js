import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';

// The immutable namespace is derived from all public asset contents. Relative
// module imports stay in the same release, including lazy-loaded media engines.
export function publicAssets(root) {
  const files = new Map();
  function collect(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const relative = `${prefix}/${entry.name}`; const file = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(file, relative);
      else if (entry.isFile() && /\.(m?js|css|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf)$/i.test(entry.name)) files.set(relative, file);
    }
  }
  collect(path.join(root, 'public'));
  files.set('/vendor/hls.min.js', path.join(root, 'node_modules/hls.js/dist/hls.min.js'));
  files.set('/vendor/dash.all.min.js', path.join(root, 'node_modules/dashjs/dist/modern/umd/dash.all.min.js'));
  const assets = new Map(); const release = createHash('sha256');
  for (const [url, file] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const body = fs.readFileSync(file);
    const digest = createHash('sha256').update(body).digest('hex');
    release.update(url).update('\0').update(digest).update('\0');
    assets.set(url, { file, versions: { identity: { body, etag: `"${digest}"` } } });
  }
  const prefix = `/assets/${release.digest('hex').slice(0, 24)}`;
  const middleware = (req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method)) return next();
    const versioned = req.path.startsWith('/assets/');
    if (versioned && !req.path.startsWith(`${prefix}/`)) return res.sendStatus(404);
    const url = versioned ? req.path.slice(prefix.length) : req.path;
    const asset = assets.get(url);
    if (!asset) return versioned ? res.sendStatus(404) : next();
    const compressible = /\.(m?js|css|svg)$/i.test(asset.file);
    if (compressible && !asset.versions.gzip) {
      for (const [name, body] of Object.entries({
        gzip: gzipSync(asset.versions.identity.body),
        br: brotliCompressSync(asset.versions.identity.body, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }),
      })) asset.versions[name] = { body, etag: `"${createHash('sha256').update(body).digest('hex')}"` };
    }
    res.vary('Accept-Encoding');
    const encoding = req.acceptsEncodings(...(compressible ? ['br', 'gzip', 'identity'] : ['identity']));
    if (!encoding) return res.sendStatus(406);
    const selected = asset.versions[encoding];
    res.type(path.extname(asset.file));
    res.set({ 'Cache-Control': versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate', ETag: selected.etag });
    if (encoding !== 'identity') res.set('Content-Encoding', encoding);
    return res.send(selected.body);
  };
  middleware.html = name => fs.readFileSync(path.join(root, 'public', name), 'utf8')
    .replace(/\b(src|href)="(\/[^"?#]+)"/g, (original, attr, url) => assets.has(url) ? `${attr}="${prefix}${url}"` : original);
  return middleware;
}
