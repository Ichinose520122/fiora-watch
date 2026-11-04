import test from 'node:test';
import assert from 'node:assert/strict';
import { socialSource, resolveSocial } from '../src/social.js';

test('canonicalize YouTube shares and X posts without carrying tracking or playlist parameters', () => {
  const source = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
  for (const url of [source + '&list=PL1', 'https://youtu.be/jNQXAC9IVRw?t=9', 'https://m.youtube.com/shorts/jNQXAC9IVRw']) {
    assert.deepEqual(socialSource(url), { provider: 'youtube', source });
  }
  assert.equal(socialSource('https://twitter.com/user/status/123/video/2?s=20').source, 'https://x.com/i/status/123/video/2');
  assert.equal(socialSource('https://x.com.example.org/user/status/123'), null);
  for (const url of ['https://x.com/explore', 'https://youtube.com/playlist?list=abcd', 'https://user@x.com/i/status/123']) {
    assert.throws(() => socialSource(url));
  }
});

test('accept platform CDN streams and reject live streams, unrelated URLs and extractor failures', async () => {
  const selection = socialSource('https://youtu.be/jNQXAC9IVRw');
  const extract = data => resolveSocial(selection, async (_file, args) => {
    assert.equal(args.at(-1), selection.source);
    return { stdout: JSON.stringify(data) };
  });
  const data = { title: '公开样例', url: 'https://r1.googlevideo.com/playback', protocol: 'https' };
  assert.deepEqual(await extract(data), { ...selection, url: data.url, title: data.title, kind: 'mp4' });
  assert.equal((await extract({ ...data, protocol: 'm3u8_native' })).kind, 'hls');
  for (const fields of [{ url: 'http://127.0.0.1/' }, { url: 'https://video.twimg.com/track' }, { live_status: 'is_live' }]) {
    await assert.rejects(extract({ ...data, ...fields }), /未能解析/);
  }
  await assert.rejects(resolveSocial(selection, async () => { throw new Error('private upstream details'); }), /未能解析/);
});
