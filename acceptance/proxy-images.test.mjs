// Images in proxy requests: extraction, data: URLs, SSRF guard, limits, unsupported-agent warning (fake adapters, no real CLI).
import test, { before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, getEventListeners } from 'node:events';
import { Readable } from 'node:stream';
import { startProxy } from '../dist/server/index.js';
import { isPrivateIp, findImages, resolveImages, pickAddress } from '../dist/server/images.js';
import { ev } from '../dist/core/events.js';

const PX = 'iVBORw0KGgo='; // not a real PNG; only the type and size are checked
const seen = [];
const mk = (images) => ({ name: 'fake', images, async *run(o) { seen.push(o); yield ev.text('ok'); return { text: 'ok', usage: { input: 1, output: 1 } }; } });
let proxy;
before(async () => { proxy = await startProxy({ port: 0, adapters: { withimg: mk(true), noimg: mk(false) } }); });
after(() => proxy?.close());

const chat = (model, content) => fetch(proxy.url + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content }] }) });
const dataImg = { type: 'image_url', image_url: { url: `data:image/png;base64,${PX}` } };
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

async function abortDuringPinnedImageRequest(endpoint, headers, body) {
  const started = deferred();
  const disconnected = deferred();
  const release = deferred();
  let requestDestroyed = false;
  const originalEmit = http.ServerResponse.prototype.emit;
  const closeMock = mock.method(http.ServerResponse.prototype, 'emit', function (event, ...args) {
    if (event === 'close') disconnected.resolve();
    return originalEmit.call(this, event, ...args);
  });
  const requestMock = mock.method(http, 'request', (_options, onResponse) => {
    const req = new EventEmitter();
    req.end = () => release.promise.then(() => onResponse(Object.assign(Readable.from([Buffer.from('png')]), {
      statusCode: 200,
      headers: { 'content-type': 'image/png' },
    })));
    req.destroy = () => { requestDestroyed = true; };
    started.resolve();
    return req;
  });
  const controller = new AbortController();
  try {
    const request = fetch(proxy.url + endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    await started.promise;
    controller.abort();
    await assert.rejects(request, (e) => e.name === 'AbortError');
    await disconnected.promise;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(requestDestroyed, true, 'client disconnect should destroy the pending image request');
    release.resolve(); // unblock local fixture after the request connection has closed
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    release.resolve();
    requestMock.mock.restore();
    closeMock.mock.restore();
  }
}

test('pre-aborted image resolution does not start a pinned request', async () => {
  const requestMock = mock.method(http, 'request', () => { throw new Error('request must not start'); });
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      resolveImages({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://8.8.8.8/a.png' } }] }] }, { signal: controller.signal }),
      (e) => e?.name === 'AbortError'
    );
    assert.equal(requestMock.mock.callCount(), 0);
  } finally {
    requestMock.mock.restore();
  }
});

test('successful pinned image resolution removes its abort hook', async () => {
  let destroyCalls = 0;
  const requestMock = mock.method(http, 'request', (_options, onResponse) => {
    const req = new EventEmitter();
    req.end = () => onResponse(Object.assign(Readable.from([Buffer.from('png')]), {
      statusCode: 200,
      headers: { 'content-type': 'image/png' },
      destroy(...args) { destroyCalls++; return Readable.prototype.destroy.apply(this, args); },
    }));
    req.destroy = () => { destroyCalls++; };
    return req;
  });
  const controller = new AbortController();
  try {
    const images = await resolveImages({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://8.8.8.8/a.png' } }] }] }, { signal: controller.signal });
    assert.equal(images.length, 1);
    const completedDestroyCalls = destroyCalls;
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    controller.abort();
    assert.equal(destroyCalls, completedDestroyCalls, 'abort after completion should not destroy the finished request/body again');
  } finally {
    requestMock.mock.restore();
  }
});

test('abort during pinned image body destroys response and request', async () => {
  const startedBody = deferred();
  let requestDestroyed = false;
  let responseDestroyed = false;
  const requestMock = mock.method(http, 'request', (_options, onResponse) => {
    const req = new EventEmitter();
    req.end = () => {
      const response = new Readable({
        read() { startedBody.resolve(); },
        destroy(error, callback) { responseDestroyed = true; return Readable.prototype.destroy.call(this, error, callback); },
      });
      response.statusCode = 200;
      response.headers = { 'content-type': 'image/png' };
      onResponse(response);
    };
    req.destroy = () => { requestDestroyed = true; };
    return req;
  });
  const controller = new AbortController();
  try {
    const resolving = resolveImages({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://8.8.8.8/pending-body' } }] }] }, { signal: controller.signal });
    await startedBody.promise;
    controller.abort();
    await assert.rejects(resolving, /image URL could not be fetched/);
    assert.equal(requestDestroyed, true);
    assert.equal(responseDestroyed, true);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally {
    requestMock.mock.restore();
  }
});

test('pinned request errors before headers release abort hook and timeout', async () => {
  const controller = new AbortController();
  const requestMock = mock.method(http, 'request', () => {
    const req = new EventEmitter();
    req.end = () => process.nextTick(() => req.emit('error', new Error('fixture connection error')));
    req.destroy = () => {};
    return req;
  });
  try {
    await assert.rejects(
      resolveImages({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://8.8.8.8/error' } }] }] }, { signal: controller.signal }),
      /image URL could not be fetched/
    );
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally {
    requestMock.mock.restore();
  }
});

test('injected image fetch receives caller abort and cancels a rejected body', async () => {
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1])); },
    cancel() { bodyCancelled = true; },
  });
  let bodyCancelled = false;
  await assert.rejects(
    resolveImages(
      { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://8.8.8.8/no-image' } }] }] },
      { fetchImpl: async () => ({ status: 200, ok: true, headers: new Headers({ 'content-type': 'text/plain' }), body }), signal: new AbortController().signal }
    ),
    /not a supported image/
  );
  assert.equal(bodyCancelled, true, 'rejected response bodies should be canceled');

  const controller = new AbortController();
  let fetchSignal;
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const resolving = resolveImages(
    { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://8.8.8.8/pending' } }] }] },
    {
      signal: controller.signal,
      fetchImpl: async (_url, init) => {
        fetchSignal = init.signal;
        readyResolve();
        return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
      },
    }
  );
  await ready;
  controller.abort();
  await assert.rejects(resolving, /image URL could not be fetched/);
  assert.equal(fetchSignal.aborted, true, 'caller abort should reach the injected fetch signal');
});

test('isPrivateIp', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.16.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
});

test('findImages: openai, responses and anthropic shapes', () => {
  assert.equal(findImages({ messages: [{ role: 'user', content: [dataImg, { type: 'text', text: 'x' }] }] }).length, 1);
  assert.equal(findImages({ input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://e.com/a.png' }] }] })[0].url, 'https://e.com/a.png');
  const a = findImages({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PX } }] }] });
  assert.equal(a[0].mediaType, 'image/png');
});

test('pickAddress: the pinning decision returns a validated public address and refuses private ones', () => {
  // production connects to exactly this address, so this pins the fix for TOCTOU DNS rebinding
  assert.equal(pickAddress([{ address: '8.8.8.8' }, { address: '93.184.216.34' }]), '8.8.8.8');
  assert.equal(pickAddress([{ address: '2606:4700::1111' }]), '2606:4700::1111');
  for (const set of [[], [{ address: '127.0.0.1' }], [{ address: '8.8.8.8' }, { address: '10.0.0.5' }], [{ address: '169.254.169.254' }], [{ address: 'fd00::1' }], [{ address: 'not-an-ip' }]]) {
    assert.throws(() => pickAddress(set), (e) => e.status === 400 && /private or local/.test(e.message), JSON.stringify(set));
  }
});

test('the agent receives the decoded image, the prompt has a neutral placeholder', async () => {
  seen.length = 0;
  const r = await chat('withimg/m1', [{ type: 'text', text: 'what is this?' }, dataImg]);
  assert.equal(r.status, 200); assert.equal(r.headers.get('x-agentbridge-warning'), null);
  assert.deepEqual(seen[0].images, [{ mediaType: 'image/png', data: PX }]);
  assert.match(seen[0].prompt, /\[image\]/); assert.doesNotMatch(seen[0].prompt, /omitted/);
});

test('disconnect during OpenAI chat image resolution never starts the agent', async () => {
  seen.length = 0;
  await abortDuringPinnedImageRequest('/v1/chat/completions', {}, {
    model: 'withimg/m1',
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://8.8.8.8/image.png' } }] }],
  });
  assert.equal(seen.length, 0);
});

test('disconnect during Anthropic image resolution never starts the agent', async () => {
  seen.length = 0;
  await abortDuringPinnedImageRequest('/v1/messages', { 'anthropic-version': '2023-06-01', 'x-api-key': 'test' }, {
    model: 'withimg/m1',
    max_tokens: 32,
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'http://8.8.8.8/image.png' } }] }],
  });
  assert.equal(seen.length, 0);
});

test('an agent without image support still answers, with a warning header', async () => {
  seen.length = 0;
  const r = await chat('noimg/m1', [{ type: 'text', text: 'hi' }, dataImg]);
  assert.equal(r.status, 200); assert.match(r.headers.get('x-agentbridge-warning'), /images_not_supported/);
  assert.equal(seen[0].images, undefined);
});

test('SSRF: private and local URLs are refused before any fetch', async () => {
  for (const url of ['http://127.0.0.1:1/a.png', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/a.png', 'http://10.0.0.5/a.png', 'ftp://example.com/a.png', 'file:///etc/passwd']) {
    const r = await chat('withimg/m1', [{ type: 'image_url', image_url: { url } }]);
    assert.equal(r.status, 400, url);
    assert.match((await r.json()).error.code, /image_url_blocked|invalid_image/);
  }
});

test('a public URL that redirects to a private address is refused', async () => {
  const fetchImpl = async (u) => (String(u).includes('start') ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret.png' } }) : new Response('x'));
  await assert.rejects(resolveImages({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://8.8.8.8/start' } }] }] }, { fetchImpl }), /private or local/);
});

test('production transport: a hostname that resolves to loopback is refused through the real DNS path', async () => {
  // exercises the prod chain (dns.lookup -> pickAddress, no injected fetchImpl); an unpinned
  // connection would actually reach the server below
  const srv = http.createServer(() => { throw new Error('must never be reached'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await chat('withimg/m1', [{ type: 'image_url', image_url: { url: `http://localhost:${srv.address().port}/a.png` } }]);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error.code, 'image_url_blocked');
  } finally {
    srv.close();
  }
});

test('a redirect whose Location cannot be parsed is a 400, not a 502', async () => {
  const fetchImpl = async () => new Response(null, { status: 302, headers: { location: 'http://[1:2:3:4:5:6:7:8:9]/x.png' } });
  await assert.rejects(
    resolveImages({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://8.8.8.8/start' } }] }] }, { fetchImpl }),
    (e) => e.status === 400 && /malformed redirect location/.test(e.message)
  );
});

test('a public URL is fetched (type and size checked)', async () => {
  const ok = async () => new Response(Buffer.from('abc'), { status: 200, headers: { 'content-type': 'image/png' } });
  const out = await resolveImages({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://8.8.8.8/a.png' } }] }] }, { fetchImpl: ok });
  assert.deepEqual(out, [{ mediaType: 'image/png', data: Buffer.from('abc').toString('base64') }]);
  const html = async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } });
  await assert.rejects(resolveImages({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://8.8.8.8/a' } }] }] }, { fetchImpl: html }), /not a supported image/);
});

test('limits: too many images, unsupported type', async () => {
  let r = await chat('withimg/m1', Array.from({ length: 9 }, () => dataImg));
  assert.equal(r.status, 400); assert.equal((await r.json()).error.code, 'too_many_images');
  r = await chat('withimg/m1', [{ type: 'image_url', image_url: { url: 'data:image/svg+xml;base64,PHN2Zz4=' } }]);
  assert.equal(r.status, 400);
});

test('a malformed percent-encoded data: URL is a 400, not a 502', async () => {
  for (const url of ['data:image/png,%E0%A4%A', 'data:image/png,%zz']) {
    const r = await chat('withimg/m1', [{ type: 'image_url', image_url: { url } }]);
    assert.equal(r.status, 400, url);
    const j = await r.json();
    assert.equal(j.error.type, 'invalid_request_error');
    assert.match(j.error.message, /malformed data: URL/);
  }
});
