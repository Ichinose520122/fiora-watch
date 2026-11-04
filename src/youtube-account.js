import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { fetchText } from './network.js';

function parseExport(input) {
  if (typeof input !== 'string' || Buffer.byteLength(input) > 65536) throw new Error('请选择小于 64 KiB 的 cookies.txt');
  const rows = [];
  for (const raw of input.split(/\r?\n/)) {
    const line = raw.replace(/^#HttpOnly_/, '');
    if (!line || line.startsWith('#')) continue;
    const [domain, subdomains, scope, secure, expiry, name, value, ...extra] = line.split('\t');
    if (!['.youtube.com', 'youtube.com', 'www.youtube.com', '.www.youtube.com'].includes(domain)) continue;
    if (scope !== '/' || !/^(TRUE|FALSE)$/.test(subdomains) || !/^(TRUE|FALSE)$/.test(secure) ||
        !/^\d{1,12}$/.test(expiry) || !/^[\w-]+$/.test(name) || !/^[\x21-\x3a\x3c-\x7e]+$/.test(value || '') || extra.length) continue;
    if (Number(expiry) && Number(expiry) <= Date.now() / 1000) continue;
    if (domain === 'youtube.com' && subdomains === 'FALSE') continue;
    rows.push([domain, subdomains, scope, secure, expiry, name, value]);
  }
  if (!rows.some(row => ['SID', 'SAPISID', '__Secure-3PAPISID', '__Secure-1PAPISID'].includes(row[5]))) {
    throw new Error('文件缺少有效的 YouTube 登录 Cookie，请从已登录的 YouTube 页面重新导出');
  }
  return rows;
}

export class YoutubeAccount {
  #key; #file; #version = 0;
  constructor(config) {
    this.#file = path.join(config.dataDir, 'youtube-account.enc');
    this.#key = hkdfSync('sha256', config.secret, 'FioraWatch', 'youtube-account:v1', 32);
  }
  status() { return { saved: fs.existsSync(this.#file) }; }

  async bind(text, read = fetchText) {
    const rows = parseExport(text);
    const version = ++this.#version;
    let page;
    try {
      page = await read('https://www.youtube.com/account', ['www.youtube.com'], AbortSignal.timeout(15000),
        { headers: { Cookie: rows.map(row => row[5] + '=' + row[6]).join('; ') } });
    } catch { throw new Error('无法验证 YouTube 会话，请检查登录状态和影院网络后重试'); }
    if (!/"LOGGED_IN"\s*:\s*true\b/.test(page.text)) throw new Error('YouTube 未确认登录，请重新导出 Cookie');
    if (version !== this.#version) throw new Error('账号设置已更改，请刷新');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const jar = '# Netscape HTTP Cookie File\n' + rows.map(row => row.join('\t')).join('\n') + '\n';
    const ciphertext = Buffer.concat([cipher.update(jar, 'utf8'), cipher.final()]);
    const temp = this.#file + '.' + randomUUID();
    try {
      fs.writeFileSync(temp, Buffer.concat([iv, cipher.getAuthTag(), ciphertext]), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, this.#file);
    } finally { fs.rmSync(temp, { force: true }); }
    return this.status();
  }

  remove() {
    ++this.#version;
    fs.rmSync(this.#file, { force: true });
    return this.status();
  }

  async withCookies(extract) {
    if (!this.status().saved) return extract([]);
    let jar;
    try {
      const data = fs.readFileSync(this.#file);
      const cipher = createDecipheriv('aes-256-gcm', this.#key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      jar = Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]);
    } catch { throw new Error('无法读取已保存的 YouTube 会话，请重新绑定'); }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-youtube-'));
    try {
      const file = path.join(dir, 'cookies.txt');
      fs.writeFileSync(file, jar, { flag: 'wx', mode: 0o600 });
      return await extract(['--cookies', file]);
    } finally { fs.rmSync(dir, { force: true, recursive: true }); }
  }
}
