import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import ipaddr from 'ipaddr.js';

export function publicAddress(value) {
  try {
    let address = ipaddr.parse(value);
    if (address.kind() === 'ipv6' && address.isIPv4MappedAddress()) address = address.toIPv4Address();
    return address.range() === 'unicast';
  } catch { return false; }
}

export function allowedUrl(value, hosts) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port)) ||
      !hosts.some(host => url.hostname === host || (host.startsWith('*.') && url.hostname.endsWith(host.slice(1))))) {
    throw new Error('视频来源域名未允许，请在影院 MEDIA_ALLOWED_HOSTS 中配置');
  }
  return url;
}

// Pin the validated DNS answer to the actual connection; validate every redirect.
export async function requestPublic(value, hosts, signal, redirects = 0) {
  const url = allowedUrl(value, hosts);
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('禁止访问内网或保留地址');
  const address = addresses[0];
  const response = await new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      signal,
      headers: { 'User-Agent': 'FioraWatch/0.1', 'Accept-Encoding': 'identity' },
      lookup: (_host, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family),
    }, resolve);
    request.setTimeout(20000, () => request.destroy(new Error('视频来源响应超时')));
    request.on('error', reject);
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.destroy();
    if (redirects >= 4 || !response.headers.location) throw new Error('来源跳转次数过多');
    return requestPublic(new URL(response.headers.location, url).href, hosts, signal, redirects + 1);
  }
  if (response.statusCode !== 200) { response.destroy(); throw new Error(`来源返回 HTTP ${response.statusCode}`); }
  return { response, url: url.href };
}

export async function fetchText(url, hosts, signal = AbortSignal.timeout(30000)) {
  const result = await requestPublic(url, hosts, signal);
  const chunks = []; let size = 0;
  for await (const chunk of result.response) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) { result.response.destroy(); throw new Error('来源页面或清单过大'); }
    chunks.push(chunk);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), url: result.url };
}
