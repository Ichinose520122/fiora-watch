import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { BilibiliAccount } from '../src/bilibili-account.js';

const owner = 'session-owner-0123456789';
const other = 'session-other-0123456789';
const key = 'a'.repeat(32);
const privateSession = 'test-secret-session-token';
const cookies = [`SESSDATA=${privateSession}; Domain=.bilibili.com; Path=/; Max-Age=3600; Secure; HttpOnly`, 'bili_jct=test-csrf-token; Domain=.bilibili.com', 'DedeUserID=12345; Domain=.bilibili.com', 'DedeUserID__ckMd5=test-checksum; Domain=.bilibili.com', 'unrelated=must-not-save; Domain=.bilibili.com'];
function temporary(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bilibili-account-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, secret: 'test-encryption-secret-with-more-than-32-characters' };
}
function reply(body, headers = {}) {
  return { response: Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { statusCode: 200, headers }) };
}
const generate = () => reply({ code: 0, data: { qrcode_key: key, url: `https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=${key}&from=` } });
const authorized = () => reply({ code: 0, data: { code: 0, refresh_token: 'must-not-save-refresh-token' } }, { 'set-cookie': cookies });
const nav = () => reply({ code: 0, data: { isLogin: true, mid: 12345, uname: '测试账号', vipStatus: 1, vipType: 2 } });

test('QR binding verifies nav, encrypts credentials atomically and exposes only public account fields', async t => {
  const config = temporary(t); const calls = [];
  const request = async (url, hosts, _signal, options, redirects) => {
    calls.push(new URL(url).pathname);
    assert.deepEqual(hosts, [new URL(url).hostname]); assert.equal(redirects, 4);
    if (url.includes('/generate')) { assert.equal(options.headers.Cookie, undefined); return generate(); }
    if (url.includes('/poll')) { assert.equal(options.headers.Cookie, undefined); return authorized(); }
    assert.equal(new URL(url).pathname, '/x/web-interface/nav');
    assert.match(options.headers.Cookie, /SESSDATA=test-secret-session-token/);
    assert.doesNotMatch(options.headers.Cookie, /unrelated|refresh_token/);
    return nav();
  };
  const account = new BilibiliAccount(config, { request });
  const qr = await account.start(owner);
  assert.equal(new URL(qr.qrUrl).hostname, 'account.bilibili.com');
  const result = await account.poll(owner, qr.id);
  assert.equal(result.status, 'connected'); assert.equal(result.account.username, '测试账号'); assert.equal(result.account.uid, '12345'); assert.equal(result.account.vip, true);
  assert.equal((await account.poll(owner, qr.id)).status, 'connected');
  const publicJson = JSON.stringify({ status: await account.publicStatus(), account });
  assert.doesNotMatch(publicJson, /SESSDATA|bili_jct|qrcode_key|test-secret-session-token|refresh_token/);
  const file = path.join(config.dataDir, 'bilibili-account.json');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /SESSDATA|test-secret-session-token|test-csrf-token|测试账号|must-not-save/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(config.dataDir), ['bilibili-account.json']);
  const restored = new BilibiliAccount(config, { request });
  assert.equal(restored.cookieHeader(), account.cookieHeader()); assert.equal((await restored.publicStatus()).connected, true);
  assert.equal((await new BilibiliAccount({ ...config, secret: 'different-encryption-key-over-32-characters' }).publicStatus()).connected, false);
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8')); envelope.tag = Buffer.alloc(16).toString('base64'); fs.writeFileSync(file, JSON.stringify(envelope));
  assert.equal(new BilibiliAccount(config).cookieHeader(), '');
  assert.deepEqual(calls, ['/x/passport-login/web/qrcode/generate', '/x/passport-login/web/qrcode/poll', '/x/web-interface/nav']);
});

test('QR sessions isolate owners, throttle polling, expire and reject nonofficial QR redirects', async t => {
  let now = Date.now(); let polls = 0;
  const account = new BilibiliAccount(temporary(t), { now: () => now, request: async url => {
    if (url.includes('/generate')) return generate();
    polls += 1; return reply({ code: 0, data: { code: polls === 1 ? 86101 : 86090 } });
  } });
  const qr = await account.start(owner);
  await assert.rejects(account.poll(other, qr.id), /不属于当前会话/);
  assert.equal((await account.poll(owner, qr.id)).status, 'waiting');
  assert.equal((await account.poll(owner, qr.id)).retryAfter, 3); assert.equal(polls, 1);
  now += 3000; assert.equal((await account.poll(owner, qr.id)).status, 'scanned');
  now = qr.expiresAt; assert.equal((await account.poll(owner, qr.id)).status, 'expired'); assert.equal(polls, 2);
  const bad = new BilibiliAccount(temporary(t), { request: async () => reply({ code: 0, data: { qrcode_key: key, url: `https://account.bilibili.com.evil/h5/account-h5/auth/scan-web?qrcode_key=${key}` } }) });
  await assert.rejects(bad.start(owner), /官方二维码/);
});

test('unlink and session cancellation prevent in-flight authorized polls from rebinding an account', async t => {
  const config = temporary(t); let finishNav; let navStarted;
  const started = new Promise(resolve => { navStarted = resolve; });
  const account = new BilibiliAccount(config, { request: async url => {
    if (url.includes('/generate')) return generate();
    if (url.includes('/poll')) return authorized();
    navStarted(); return new Promise(resolve => { finishNav = () => resolve(nav()); });
  } });
  const qr = await account.start(owner); const inFlight = account.poll(owner, qr.id);
  await started; await account.remove(); finishNav();
  assert.equal((await inFlight).status, 'expired'); assert.equal(account.cookieHeader(), '');
  assert.equal(fs.existsSync(path.join(config.dataDir, 'bilibili-account.json')), false);
  const next = await account.start(owner); account.cancel(other);
  // A different owner cannot cancel this session; its first poll still reaches Bilibili.
  const pending = account.poll(owner, next.id);
  await new Promise(resolve => setImmediate(resolve)); account.cancel(owner); finishNav();
  assert.equal((await pending).status, 'expired'); assert.equal((await account.publicStatus()).connected, false);
});

test('nav HTTP412 never stores credentials or exposes upstream cookies in an error', async t => {
  const config = temporary(t);
  const account = new BilibiliAccount(config, { request: async url => {
    if (url.includes('/generate')) return generate();
    if (url.includes('/poll')) return authorized();
    throw new Error(`来源返回 HTTP 412 with sensitive ${privateSession}`);
  } });
  const qr = await account.start(owner);
  await assert.rejects(account.poll(owner, qr.id), error => /HTTP 412/.test(error.message) && !error.message.includes(privateSession));
  assert.equal(account.cookieHeader(), ''); assert.equal((await account.publicStatus()).connected, false);
  assert.equal(fs.existsSync(path.join(config.dataDir, 'bilibili-account.json')), false);
});
