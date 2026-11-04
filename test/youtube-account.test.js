import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { YoutubeAccount } from '../src/youtube-account.js';
import { resolveSocial, socialSource } from '../src/social.js';

const exported = '# Netscape HTTP Cookie File\n#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tfake-test-value\n.example.com\tTRUE\t/\tTRUE\t0\tSID\tunrelated\n';
test('verify before replacing a binding, encrypt at rest and isolate each yt-dlp invocation', async t => {
  const config = { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'watch-account-test-')), secret: 'test-only-secret-012345678901234567890' };
  t.after(() => fs.rmSync(config.dataDir, { recursive: true, force: true }));
  const account = new YoutubeAccount(config);
  const verified = async (url, hosts, signal, options) => {
    assert.equal(url, 'https://www.youtube.com/account');
    assert.deepEqual(hosts, ['www.youtube.com']);
    assert.equal(options.headers.Cookie, 'SID=fake-test-value');
    return { text: '{"LOGGED_IN":true}' };
  };
  assert.deepEqual(await account.bind(exported, verified), { saved: true });
  const saved = fs.readFileSync(path.join(config.dataDir, 'youtube-account.enc'));
  assert.equal(saved.includes('fake-test-value'), false);
  await assert.rejects(account.bind(exported, async () => ({ text: '{"LOGGED_IN":false}' })));
  assert.deepEqual(fs.readFileSync(path.join(config.dataDir, 'youtube-account.enc')), saved);
  const restored = new YoutubeAccount(config);
  let file;
  await resolveSocial(socialSource('https://youtu.be/jNQXAC9IVRw'), async (_, args) => {
    file = args[args.indexOf('--cookies') + 1];
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /SID\tfake-test-value/);
    assert.doesNotMatch(text, /unrelated/);
    return { stdout: JSON.stringify({ url: 'https://v.googlevideo.com/play', title: 'sample', protocol: 'https' }) };
  }, restored);
  assert.equal(fs.existsSync(file), false);
  await resolveSocial(socialSource('https://x.com/i/status/123'), async (_, args) => {
    assert.ok(!args.includes('--cookies'));
    return { stdout: JSON.stringify({ url: 'https://video.twimg.com/video.mp4', title: 'sample', protocol: 'https' }) };
  }, restored);
  await assert.rejects(restored.withCookies(args => { file = args[1]; throw new Error('extractor failed'); }));
  assert.equal(fs.existsSync(file), false);
  let finish;
  const pending = restored.bind(exported, () => new Promise(resolve => { finish = resolve; }));
  restored.remove();
  finish({ text: '{"LOGGED_IN":true}' });
  await assert.rejects(pending);
  assert.deepEqual(restored.status(), { saved: false });
  assert.deepEqual(await restored.withCookies(args => args), []);
});
