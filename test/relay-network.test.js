import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { MediaRelay } from '../src/relay.js';

test('relay network pins validated DNS, validates redirect hosts and IPs, and sends no browser credentials', async t => {
  const originalLookup = dns.lookup; const originalGet = http.get; const requests = [];
  t.after(() => { dns.lookup = originalLookup; http.get = originalGet; });
  dns.lookup = async hostname => [{ address: hostname.startsWith('private') ? '127.0.0.1' : hostname.startsWith('metadata') ? '169.254.169.254' : '8.8.8.8', family: 4 }];
  http.get = (url, options, callback) => {
    requests.push({ url, options });
    options.lookup(url.hostname, {}, (_error, address, family) => { assert.equal(address, '8.8.8.8'); assert.equal(family, 4); });
    const response = Readable.from(['data']); response.headers = {}; response.statusCode = 200;
    if (url.pathname === '/redirect-private') { response.statusCode = 302; response.headers.location = 'http://private.relay-test.example/track'; }
    if (url.pathname === '/redirect-denied') { response.statusCode = 302; response.headers.location = 'http://denied.relay-test.example/track'; }
    if (url.pathname === '/redirect-allowed') { response.statusCode = 302; response.headers.location = 'http://other.relay-test.example/track'; }
    const request = new EventEmitter(); request.setTimeout = () => request;
    queueMicrotask(() => callback(response)); return request;
  };
  const relay = new MediaRelay(['public.relay-test.example', 'private.relay-test.example', 'metadata.relay-test.example', 'other.relay-test.example']);
  const signal = new AbortController().signal;
  const result = await relay.open({ url: 'http://public.relay-test.example/redirect-allowed', manifest: false }, 'bytes=2-5', signal);
  result.response.destroy(); assert.equal(requests.length, 2);
  for (const { options } of requests) {
    assert.equal(options.headers.Range, 'bytes=2-5');
    assert.deepEqual(Object.keys(options.headers).sort(), ['Accept-Encoding', 'Range', 'User-Agent']);
    assert.equal(options.signal, signal);
  }
  assert.equal(result.url, 'http://other.relay-test.example/track');
  const initial = requests.length;
  await assert.rejects(relay.open({ url: 'http://private.relay-test.example/track' }, undefined, signal), /内网或保留/);
  await assert.rejects(relay.open({ url: 'http://metadata.relay-test.example/track' }, undefined, signal), /内网或保留/);
  assert.equal(requests.length, initial);
  await assert.rejects(relay.open({ url: 'http://public.relay-test.example/redirect-private' }, undefined, signal), /内网或保留/);
  assert.equal(requests.length, initial + 1);
  await assert.rejects(relay.open({ url: 'http://public.relay-test.example/redirect-denied' }, undefined, signal), /域名未允许/);
  assert.equal(requests.length, initial + 2);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(relay.open({ url: 'http://public.relay-test.example/track' }, undefined, aborted.signal), { name: 'AbortError' });
});
