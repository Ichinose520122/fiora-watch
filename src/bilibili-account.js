import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { requestPublic } from './network.js';

const GENERATE = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate';
const POLL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll';
const NAV = 'https://api.bilibili.com/x/web-interface/nav';
const COOKIE_NAMES = Object.freeze(['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5']);
const HEADERS = Object.freeze({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
});
const TTL = 180000;
const POLL_INTERVAL = 3000;
const MAX_AGE = 180 * 86400000;
const AAD = Buffer.from('FioraWatch/bilibili-account/v1');
const cookieValue = value => typeof value === 'string' && /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]{1,4096}$/.test(value);

function ownerId(owner) {
  if (typeof owner !== 'string' || owner.length < 16 || owner.length > 256 || !/^[A-Za-z0-9_-]+$/.test(owner)) throw new Error('扫码会话无效，请重新登录影院');
}

function qrUrl(value, key) {
  let url;
  try { url = new URL(value); } catch { throw new Error('B站未返回有效的官方二维码'); }
  const officialPath = (url.hostname === 'account.bilibili.com' && url.pathname === '/h5/account-h5/auth/scan-web') ||
    (url.hostname === 'passport.bilibili.com' && url.pathname === '/h5-app/passport/login/scan');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !officialPath || url.href.length > 2048) throw new Error('B站未返回有效的官方二维码');
  const allowed = new Set(['qrcode_key', 'navhide', 'callback', 'from']);
  for (const parameter of url.searchParams.keys()) {
    if (!allowed.has(parameter) || url.searchParams.getAll(parameter).length !== 1) throw new Error('B站二维码参数无效');
  }
  if (url.searchParams.get('qrcode_key') !== key ||
      (url.searchParams.has('navhide') && url.searchParams.get('navhide') !== '1') ||
      (url.searchParams.has('callback') && url.searchParams.get('callback') !== 'close') ||
      (url.searchParams.has('from') && !['', 'main_web'].includes(url.searchParams.get('from')))) throw new Error('B站二维码参数无效');
  return url.href;
}

function cookiesFrom(headers, now) {
  const values = Object.create(null);
  let expiresAt = now + MAX_AGE;
  const lines = headers['set-cookie'] || [];
  if (!Array.isArray(lines) || lines.length > 32) throw new Error('B站登录凭据格式无效，请重新扫码');
  for (const line of lines) {
    if (typeof line !== 'string' || line.length > 8192) throw new Error('B站登录凭据格式无效，请重新扫码');
    const [pair, ...attributes] = line.split(';');
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator).trim();
    if (separator < 1 || !COOKIE_NAMES.includes(name)) continue;
    const value = pair.slice(separator + 1);
    if (!cookieValue(value)) throw new Error('B站登录凭据格式无效，请重新扫码');
    let maxAge;
    let expiry;
    for (const attribute of attributes) {
      const index = attribute.indexOf('=');
      const key = (index < 0 ? attribute : attribute.slice(0, index)).trim().toLowerCase();
      const content = index < 0 ? '' : attribute.slice(index + 1).trim();
      if (key === 'domain' && !/^\.?bilibili\.com$/i.test(content)) throw new Error('B站登录凭据来源无效');
      if (key === 'max-age') {
        if (!/^-?\d{1,12}$/.test(content)) throw new Error('B站登录凭据期限无效');
        maxAge = Number(content);
      }
      if (key === 'expires') {
        expiry = Date.parse(content);
        if (!Number.isFinite(expiry)) throw new Error('B站登录凭据期限无效');
      }
    }
    if (maxAge !== undefined) expiry = now + maxAge * 1000;
    if (expiry !== undefined) expiresAt = Math.min(expiresAt, expiry);
    values[name] = value;
  }
  if (!values.SESSDATA || !/^[1-9]\d{0,19}$/.test(values.DedeUserID || '') || expiresAt <= now) throw new Error('B站没有返回完整且有效的登录凭据，请重新扫码');
  return { values, expiresAt };
}

function headerFrom(values) {
  return COOKIE_NAMES.filter(name => values[name]).map(name => `${name}=${values[name]}`).join('; ');
}

function privateError(error) {
  if (/HTTP\s*412\b/.test(String(error?.message || ''))) return new Error('B站限制了影院服务器访问（HTTP 412），账号验证未完成，请稍后重试');
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return new Error('B站账号请求已取消或超时，请稍后重试');
  return new Error('B站账号接口暂不可用，请稍后重试');
}

export class BilibiliAccount {
  #request; #now; #file; #key;
  #cookies = null; #account = null; #loadError = false;
  #epoch = 0; #pending = null; #statusRequest = null;

  constructor(config, { request = requestPublic, now = Date.now } = {}) {
    if (typeof config?.secret !== 'string' || config.secret.length < 32 || typeof config.dataDir !== 'string') throw new Error('B站账号存储配置无效');
    this.#request = request; this.#now = now;
    this.#file = path.join(path.resolve(config.dataDir), 'bilibili-account.json');
    this.#key = Buffer.from(hkdfSync('sha256', Buffer.from(config.secret), Buffer.from('FioraWatch'), Buffer.from('bilibili-account:v1'), 32));
    this.#load();
  }

  #load() {
    try {
      const stat = fs.lstatSync(this.#file);
      if (!stat.isFile() || stat.size > 65536) throw new Error('Invalid credential file');
      const envelope = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
      if (envelope.v !== 1 || !['iv', 'tag', 'ciphertext'].every(key => typeof envelope[key] === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(envelope[key]))) throw new Error('Invalid envelope');
      const iv = Buffer.from(envelope.iv, 'base64'); const tag = Buffer.from(envelope.tag, 'base64');
      if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid envelope');
      const decipher = createDecipheriv('aes-256-gcm', this.#key, iv);
      decipher.setAAD(AAD); decipher.setAuthTag(tag);
      const stored = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
      const values = stored.cookies;
      const account = stored.account;
      if (!values || Object.keys(values).some(name => !COOKIE_NAMES.includes(name) || !cookieValue(values[name])) || !values.SESSDATA ||
          !/^[1-9]\d{0,19}$/.test(values.DedeUserID || '') || !account || account.uid !== values.DedeUserID ||
          typeof account.username !== 'string' || account.username.length > 100 || typeof account.vip !== 'boolean' ||
          !Number.isFinite(account.checkedAt) || !Number.isFinite(account.expiresAt)) throw new Error('Invalid stored account');
      fs.chmodSync(this.#file, 0o600);
      this.#cookies = values;
      this.#account = { username: account.username, uid: account.uid, vip: account.vip, vipType: account.vipType === 1 || account.vipType === 2 ? account.vipType : 0, checkedAt: account.checkedAt, expiresAt: account.expiresAt };
    } catch (error) {
      if (error.code !== 'ENOENT') this.#loadError = true;
    }
  }

  #save(values, account) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ cookies: values, account }), 'utf8'), cipher.final()]);
    const envelope = { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    let descriptor;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.fchmodSync(descriptor, 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(envelope));
      fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
      fs.renameSync(temporary, this.#file);
      this.#loadError = false;
    } catch { throw new Error('B站账号无法安全保存，请检查影院数据目录权限'); }
    finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') { /* No credentials are logged. */ } }
    }
  }

  #clearCredentials() {
    this.#cookies = null; this.#account = null; this.#loadError = false;
    try { fs.unlinkSync(this.#file); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('账号已停止使用，但本地凭据移除失败，请检查影院数据目录权限'); }
  }

  #invalidate() {
    this.#epoch += 1;
    this.#pending?.controller.abort();
    this.#pending = null;
  }

  #snapshot() {
    const expired = Boolean(this.#account && this.#account.expiresAt <= this.#now());
    if (!this.#cookies || !this.#account || expired) return {
      connected: false, username: '', uid: '', vip: false, checkedAt: this.#account?.checkedAt || 0,
      ...(expired ? { expired: true } : {}), ...(this.#loadError ? { error: '保存的B站账号无法解密，请重新绑定' } : {}),
    };
    return { connected: true, ...this.#account };
  }

  cookieHeader() {
    if (!this.#cookies || !this.#account || this.#account.expiresAt <= this.#now()) return '';
    return headerFrom(this.#cookies);
  }

  async #json(value, { cookie, signal } = {}) {
    const url = new URL(value);
    const allowed = (url.origin === 'https://passport.bilibili.com' && ['/x/passport-login/web/qrcode/generate', '/x/passport-login/web/qrcode/poll'].includes(url.pathname)) ||
      (url.origin === 'https://api.bilibili.com' && url.pathname === '/x/web-interface/nav');
    if (!allowed || url.username || url.password || url.hash || (cookie && value !== NAV)) throw new Error('B站账号接口地址无效');
    let response;
    let decoder;
    try {
      const timeout = AbortSignal.timeout(20000);
      const result = await this.#request(url.href, [url.hostname], signal ? AbortSignal.any([timeout, signal]) : timeout, {
        headers: { ...HEADERS, ...(cookie ? { Cookie: cookie } : {}) },
        acceptedStatus: [200],
      }, 4); // Exhaust the existing redirect budget: credentials never follow a redirect.
      response = result.response;
      if (response.statusCode !== 200 || (result.url && result.url !== url.href)) throw new Error(`HTTP ${response.statusCode}`);
      const encoding = response.headers['content-encoding'];
      decoder = encoding === 'gzip' ? createGunzip() : encoding === 'br' ? createBrotliDecompress() : encoding === 'deflate' ? createInflate() : null;
      const stream = decoder ? response.pipe(decoder) : response;
      if (decoder) response.on('error', error => decoder.destroy(error));
      let bytes = 0; const chunks = [];
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) throw new Error('Response too large');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.code === -412) throw new Error('HTTP 412');
      return { body, headers: response.headers };
    } catch (error) { throw privateError(error); }
    finally { response?.destroy(); decoder?.destroy(); }
  }

  async #nav(values, expiresAt, signal) {
    const { body } = await this.#json(NAV, { cookie: headerFrom(values), signal });
    if (body.code === -101 || (body.code === 0 && body.data?.isLogin === false)) return null;
    if (body.code !== 0 || body.data?.isLogin !== true) throw new Error('B站未能确认登录状态，请重新扫码');
    const data = body.data;
    const uid = String(data.mid);
    if (!/^[1-9]\d{0,19}$/.test(uid) || uid !== values.DedeUserID || typeof data.uname !== 'string') throw new Error('B站登录身份验证失败，请重新扫码');
    return {
      username: data.uname.replace(/[\x00-\x1F\x7F]/g, '').slice(0, 100), uid,
      vip: data.vipStatus === 1 || data.vip?.status === 1,
      vipType: [1, 2].includes(data.vipType ?? data.vip?.type) ? (data.vipType ?? data.vip?.type) : 0,
      checkedAt: this.#now(), expiresAt,
    };
  }

  async publicStatus({ refresh = false } = {}) {
    if (!refresh || !this.cookieHeader()) return this.#snapshot();
    if (this.#statusRequest) return this.#statusRequest;
    const values = this.#cookies;
    const expiresAt = this.#account.expiresAt;
    this.#statusRequest = (async () => {
      const account = await this.#nav(values, expiresAt);
      if (this.#cookies === values) {
        if (!account) this.#clearCredentials();
        else { this.#save(values, account); this.#account = account; }
      }
      return this.#snapshot();
    })();
    try { return await this.#statusRequest; }
    finally { this.#statusRequest = null; }
  }

  async start(owner) {
    ownerId(owner);
    this.#invalidate();
    const pending = {
      id: randomUUID(), owner, epoch: this.#epoch, controller: new AbortController(),
      expiresAt: this.#now() + TTL, lastPollAt: -Infinity, status: 'waiting', inFlight: false,
    };
    this.#pending = pending;
    try {
      const { body } = await this.#json(GENERATE, { signal: pending.controller.signal });
      if (this.#pending !== pending || pending.epoch !== this.#epoch || this.#now() >= pending.expiresAt) throw new Error('扫码流程已取消，请重新生成二维码');
      if (body.code !== 0 || !/^[a-f0-9]{32}$/i.test(body.data?.qrcode_key || '')) throw new Error('B站暂时无法生成二维码，请稍后重试');
      pending.key = body.data.qrcode_key;
      const url = qrUrl(body.data.url, pending.key);
      return { id: pending.id, qrUrl: url, expiresAt: pending.expiresAt };
    } catch (error) {
      if (this.#pending === pending) this.#invalidate();
      throw error;
    }
  }

  async poll(owner, id) {
    ownerId(owner);
    const pending = this.#pending;
    if (!pending || pending.owner !== owner || pending.id !== id) throw new Error('此扫码流程不属于当前会话，或已被取消');
    if (this.#now() >= pending.expiresAt || pending.status === 'expired') {
      pending.status = 'expired'; pending.controller.abort(); delete pending.key;
      return { status: 'expired' };
    }
    if (pending.status === 'connected') return { status: 'connected', account: this.#snapshot() };
    if (!pending.key) throw new Error('二维码尚未生成，请稍后重试');
    if (pending.inFlight || this.#now() - pending.lastPollAt < POLL_INTERVAL) return { status: pending.status, retryAfter: 3 };
    pending.lastPollAt = this.#now(); pending.inFlight = true;
    const current = () => this.#pending === pending && pending.epoch === this.#epoch && this.#now() < pending.expiresAt && !pending.controller.signal.aborted;
    try {
      const { body, headers } = await this.#json(`${POLL}?qrcode_key=${encodeURIComponent(pending.key)}`, { signal: pending.controller.signal });
      if (!current()) return { status: 'expired' };
      if (body.code !== 0 || !Number.isInteger(body.data?.code)) throw new Error('B站暂时无法查询扫码状态，请稍后重试');
      const code = body.data.code;
      if (code === 86101 || code === 86090) {
        pending.status = code === 86101 ? 'waiting' : 'scanned';
        return { status: pending.status };
      }
      if (code === 86038) {
        pending.status = 'expired'; pending.controller.abort(); delete pending.key;
        return { status: 'expired' };
      }
      if (code !== 0) throw new Error('B站扫码授权未完成，请重新生成二维码');
      const { values, expiresAt } = cookiesFrom(headers, this.#now());
      const account = await this.#nav(values, expiresAt, pending.controller.signal);
      if (!current()) return { status: 'expired' };
      if (!account) throw new Error('B站尚未确认登录成功，请重新扫码');
      // No await between the final generation check, atomic save and memory update.
      // remove/cancel/new start therefore cannot be overtaken by an old poll.
      this.#save(values, account);
      this.#cookies = values; this.#account = account;
      pending.status = 'connected'; delete pending.key;
      return { status: 'connected', account: this.#snapshot() };
    } catch (error) {
      if (!current()) return { status: 'expired' };
      throw error;
    } finally { pending.inFlight = false; }
  }

  cancel(owner) {
    ownerId(owner);
    if (this.#pending?.owner === owner) this.#invalidate();
  }

  async remove() {
    this.#invalidate();
    this.#clearCredentials();
    return this.#snapshot();
  }
}
