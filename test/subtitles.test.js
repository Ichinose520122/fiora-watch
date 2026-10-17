import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authenticatedBilibiliReader } from '../src/bilibili.js';
import { bilibiliSubtitleToVtt, fetchBilibiliSubtitle, listBilibiliSubtitles, signBilibiliWbi } from '../src/bilibili-subtitles.js';

const media = { bvid: 'BV1v2Ht6cERH', cid: 42493413237 };
const track = { lan: 'ai-zh', lan_doc: '中文', ai_status: 2, subtitle_url: '//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/example?auth_key=temporary' };
const response = (data, code = 0) => JSON.stringify({ code, data });
const reader = data => async url => ({ url, text: response({ ...media, need_login_subtitle: false, subtitle: { subtitles: data } }) });

test('Bilibili subtitle discovery uses selected part and official API authentication only', async () => {
  const calls = [];
  const read = authenticatedBilibiliReader({ cookieHeader: () => 'SESSDATA=private' }, async (url, hosts, _signal, options) => {
    calls.push({ url: new URL(url), hosts, options });
    if (new URL(url).hostname === 'aisubtitle.hdslb.com') return { url, text: '{"body":[]}' };
    return reader([track])(url);
  });
  const result = await listBilibiliSubtitles(media, read);
  assert.equal(result.status, 'available');
  assert.match(result.subtitles[0].id, /^[a-f0-9]{24}$/);
  assert.deepEqual(result.subtitles, [{ id: result.subtitles[0].id, label: '中文（AI）', language: 'ai-zh', url: 'https:' + track.subtitle_url }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, '/x/player/v2');
  assert.equal(calls[0].url.searchParams.get('bvid'), media.bvid);
  assert.equal(calls[0].url.searchParams.get('cid'), String(media.cid));
  assert.deepEqual(calls[0].hosts, ['api.bilibili.com']);
  assert.equal(calls[0].options.headers.Cookie, 'SESSDATA=private');
  const vtt = await fetchBilibiliSubtitle(result.subtitles[0], read);
  // Auth reader must omit credentials on the exact subtitle CDN too.
  assert.equal(calls.at(-1).options.headers.Cookie, undefined);
  assert.equal(typeof vtt, 'string');
});

test('subtitle identity survives provider reordering and signed URL refresh', async () => {
  const english = { ...track, lan: 'en', lan_doc: 'English', id_str: '22' };
  const first = await listBilibiliSubtitles(media, reader([track, english]));
  const second = await listBilibiliSubtitles(media, reader([english, { ...track, subtitle_url: track.subtitle_url.replace('temporary', 'renewed') }]));
  assert.equal(first.subtitles[0].id, second.subtitles[1].id);
  assert.equal(first.subtitles[1].id, second.subtitles[0].id);
  assert.notEqual(first.subtitles[0].id, first.subtitles[1].id);
});

test('subtitle login, no subtitles and rate limiting are distinct non-fatal results', async () => {
  assert.equal((await listBilibiliSubtitles(media, reader([]))).status, 'none');
  const login = await listBilibiliSubtitles(media, async url => ({ url, text: response({ ...media, need_login_subtitle: true, subtitle: { subtitles: [] } }) }));
  assert.equal(login.status, 'login_required'); assert.deepEqual(login.subtitles, []);
  for (const code of [-101, -111, -352, -403, -412, -509]) {
    let calls = 0;
    const result = await listBilibiliSubtitles(media, async url => { calls++; return { url, text: response(null, code) }; });
    assert.equal(result.status, [-101, -111].includes(code) ? 'login_required' : 'rate_limited');
    assert.equal(calls, 1);
  }
  for (const status of [403, 412, 429]) {
    assert.equal((await listBilibiliSubtitles(media, async () => { throw new Error(`来源返回 HTTP ${status}`); })).status, 'rate_limited');
  }
  assert.equal((await listBilibiliSubtitles({ bvid: media.bvid, cid: -1 }, reader([]))).status, 'unavailable');
  assert.equal((await listBilibiliSubtitles(media, reader(Array(51).fill(track)))).status, 'unavailable');
});

test('old rooms discover metadata lazily for the exact canonical source part', async () => {
  const calls = [];
  const result = await listBilibiliSubtitles({ source: `https://www.bilibili.com/video/${media.bvid}/?p=2` }, async url => {
    calls.push(new URL(url));
    if (new URL(url).pathname === '/x/web-interface/view') return { url, text: response({ bvid: media.bvid, pages: [{ page: 1, cid: 10 }, { page: 2, cid: media.cid }] }) };
    return reader([track])(url);
  });
  assert.equal(result.status, 'available'); assert.equal(calls.length, 2);
  assert.equal(calls[1].searchParams.get('cid'), String(media.cid));
  let requests = 0;
  const invalid = await listBilibiliSubtitles({ source: 'https://127.0.0.1/video/' + media.bvid }, async () => { requests++; });
  assert.equal(invalid.status, 'unavailable'); assert.match(invalid.message, /重新选择/); assert.equal(requests, 0);
});

test('signed player fallback validates video identity and public WBI keys', async () => {
  const calls = [];
  const read = async url => {
    const path = new URL(url).pathname; calls.push(new URL(url));
    if (path === '/x/player/v2') return { url, text: response({ ...media, cid: 99, subtitle: { subtitles: [track] } }) };
    if (path === '/x/web-interface/nav') return { url, text: response({ wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } }, -101) };
    return reader([track])(url);
  };
  assert.equal((await listBilibiliSubtitles(media, read)).status, 'available');
  assert.deepEqual(calls.map(url => url.pathname), ['/x/player/v2', '/x/web-interface/nav', '/x/player/wbi/v2']);
  assert.match(calls[2].searchParams.get('w_rid'), /^[0-9a-f]{32}$/);
  assert.equal((await listBilibiliSubtitles(media, async url => ({ url, text: response({ ...media, cid: 1 }) }))).status, 'unavailable');
  const vector = signBilibiliWbi({ foo: '114', bar: '514', zab: '1919810' }, '7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45', 1702204169000);
  assert.equal(vector.wts, 1702204169);
  assert.equal(vector.w_rid, '8f6f2b5b3d485fe1886cec6a0be8c5d4');
  assert.deepEqual(signBilibiliWbi({ foo: "1!'()*2" }, '7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45', 1000).w_rid,
    signBilibiliWbi({ foo: '12' }, '7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45', 1000).w_rid);
});

test('subtitle URLs reject SSRF, unrelated hosts, credentials and untrusted paths before requests', async () => {
  const invalid = ['http://aisubtitle.hdslb.com/bfs/subtitle/a.json', 'https://aisubtitle.hdslb.com.evil/bfs/subtitle/a.json', 'https://127.0.0.1/bfs/subtitle/a.json', 'https://user:pass@aisubtitle.hdslb.com/bfs/subtitle/a.json', 'https://aisubtitle.hdslb.com:444/bfs/subtitle/a.json', 'https://i0.hdslb.com/bfs/subtitle/a.json', 'https://aisubtitle.hdslb.com/private', 'https://aisubtitle.hdslb.com/bfs/subtitle/a.json#fragment'];
  for (const url of invalid) {
    assert.equal((await listBilibiliSubtitles(media, reader([{ ...track, subtitle_url: url }]))).status, 'unavailable');
    let calls = 0;
    await assert.rejects(fetchBilibiliSubtitle({ url }, async () => { calls++; }), /字幕/);
    assert.equal(calls, 0);
  }
  const result = await listBilibiliSubtitles(media, reader([{ ...track, subtitle_url: invalid[0] }, track]));
  assert.equal(result.subtitles.length, 1);
  await assert.rejects(fetchBilibiliSubtitle({ url: 'https:' + track.subtitle_url }, async () => ({ url: 'https://127.0.0.1/private', text: '{"body":[]}' })), /字幕/);
});

test('Bilibili JSON becomes plain WebVTT, sorted without blank-line or markup injection', async () => {
  const json = { body: [{ from: 3600.25, to: 3601, content: '下一句' }, { from: 0, to: 1.234, content: '<script>x</script>\r\n\r\n00:10 --> 99:00\n\u0000&' }] };
  const vtt = bilibiliSubtitleToVtt(json);
  assert.equal(vtt, 'WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.234\n&lt;script&gt;x&lt;/script&gt;\n00:10 --&gt; 99:00\n&amp;\n\n2\n01:00:00.250 --> 01:00:01.000\n下一句\n\n');
  assert.equal(await fetchBilibiliSubtitle({ url: 'https:' + track.subtitle_url }, async (url, hosts, _signal, options) => {
    assert.deepEqual(hosts, ['aisubtitle.hdslb.com']);
    assert.equal(options.headers.Cookie, undefined); assert.equal(options.headers.Authorization, undefined);
    return { url, text: JSON.stringify(json) };
  }), vtt);
});

test('invalid, oversized and unbounded subtitle cues are rejected', () => {
  for (const cue of [{ from: -1, to: 1, content: 'a' }, { from: 1, to: 1, content: 'a' }, { from: 0, to: Infinity, content: 'a' }, { from: 0, to: 604801, content: 'a' }, { from: 0, to: 0.00001, content: 'a' }, { from: '0', to: 1, content: 'a' }, { from: 0, to: 1, content: {} }, { from: 0, to: 1, content: 'a'.repeat(10001) }]) {
    assert.throws(() => bilibiliSubtitleToVtt({ body: [cue] }), /字幕/);
  }
  assert.throws(() => bilibiliSubtitleToVtt('x'), /JSON/);
  assert.throws(() => bilibiliSubtitleToVtt({}), /字幕/);
  assert.throws(() => bilibiliSubtitleToVtt({ body: Array(30001).fill({ from: 0, to: 1, content: 'a' }) }), /字幕/);
});
