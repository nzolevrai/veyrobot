import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { proxyRequest } from './api/proxy.js';

function streamedRequest(chunks: Uint8Array[], headers: Record<string, string> = {}, signal?: AbortSignal): Request {
  return new Request('http://localhost/api/test', {
    method: 'POST', headers, signal, duplex: 'half',
    body: new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }),
  } as RequestInit);
}

test('rejects declared and streamed oversized bodies before contacting the API', async () => {
  let sent = 0;
  const upstream: typeof fetch = async () => { sent++; return new Response('sent'); };
  const declared = await proxyRequest(streamedRequest([new Uint8Array(1)], { 'content-length': '1048577' }), ['test'], '', upstream);
  assert.equal(declared.status, 413);
  const streamed = await proxyRequest(streamedRequest([new Uint8Array(700_000), new Uint8Array(348_577)]), ['test'], '', upstream);
  assert.equal(streamed.status, 413);
  assert.equal(sent, 0);
});

test('forwards a bounded body without Content-Length and filters hop headers in both directions', async () => {
  const upstream: typeof fetch = async (_url, init) => {
    assert.equal(init?.headers instanceof Headers && init.headers.get('x-drop'), null);
    assert.equal(init?.headers instanceof Headers && init.headers.get('connection'), null);
    assert.equal(Buffer.from(init?.body as Uint8Array).toString(), 'payload');
    const headers = new Headers({ connection: 'x-response-drop', 'x-response-drop': 'internal', location: '/next' });
    headers.append('set-cookie', 'first=1; HttpOnly');
    headers.append('set-cookie', 'second=2; HttpOnly');
    return new Response(null, { status: 302, headers });
  };
  const response = await proxyRequest(streamedRequest([Buffer.from('pay'), Buffer.from('load')], { connection: 'x-drop', 'x-drop': 'internal' }), ['test'], '', upstream);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/next');
  assert.equal(response.headers.get('x-response-drop'), null);
  assert.equal(response.headers.getSetCookie().length, 2);
});

test('distinguishes body read errors, client cancellation, upstream outage and timeout', async () => {
  let sent = 0;
  const upstream: typeof fetch = async () => { sent++; throw new Error('network unavailable'); };
  const bad = new Request('http://localhost/api/test', { method: 'POST', duplex: 'half', body: new ReadableStream({ pull(controller) { controller.error(new Error('broken input')); } }) } as RequestInit);
  assert.equal((await proxyRequest(bad, ['test'], '', upstream)).status, 400);
  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal((await proxyRequest(new Request('http://localhost/api/test', { signal: cancelled.signal }), ['test'], '', upstream)).status, 499);
  assert.equal(sent, 0);
  assert.equal((await proxyRequest(new Request('http://localhost/api/test'), ['test'], '', upstream)).status, 502);
  const old = process.env.API_PROXY_TIMEOUT_MS;
  process.env.API_PROXY_TIMEOUT_MS = '100';
  try {
    const hanging: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
    assert.equal((await proxyRequest(new Request('http://localhost/api/test'), ['test'], '', hanging)).status, 504);
  } finally {
    if (old === undefined) delete process.env.API_PROXY_TIMEOUT_MS;
    else process.env.API_PROXY_TIMEOUT_MS = old;
  }
});

test('client abort stops an already pending upstream request', async () => {
  const controller = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let aborted = false;
  const upstream: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    entered();
    init?.signal?.addEventListener('abort', () => { aborted = true; reject(init.signal?.reason); }, { once: true });
  });
  const pending = proxyRequest(new Request('http://localhost/api/test', { signal: controller.signal }), ['test'], '', upstream);
  await started;
  controller.abort();
  assert.equal((await pending).status, 499);
  assert.equal(aborted, true);
});

test('a local HTTP upstream that never answers is aborted at the configured deadline', async () => {
  const server = createServer(() => undefined);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const oldBase = process.env.API_INTERNAL_URL;
  const oldTimeout = process.env.API_PROXY_TIMEOUT_MS;
  process.env.API_INTERNAL_URL = `http://127.0.0.1:${address.port}`;
  process.env.API_PROXY_TIMEOUT_MS = '100';
  try {
    assert.equal((await proxyRequest(new Request('http://localhost/api/test'), ['test'])).status, 504);
  } finally {
    if (oldBase === undefined) delete process.env.API_INTERNAL_URL;
    else process.env.API_INTERNAL_URL = oldBase;
    if (oldTimeout === undefined) delete process.env.API_PROXY_TIMEOUT_MS;
    else process.env.API_PROXY_TIMEOUT_MS = oldTimeout;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
