const MAX_BODY_BYTES = 1_048_576;
const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection'];

function withoutHopHeaders(source: Headers, extra: string[] = []): Headers {
  const result = new Headers(source);
  const nominated = (source.get('connection') ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  for (const header of [...HOP_HEADERS, ...nominated, ...extra]) result.delete(header);
  return result;
}

function failure(status: number, code: string, message: string): Response {
  return Response.json({ error: message, code }, { status, headers: { 'Cache-Control': 'no-store' } });
}

class BodyTooLarge extends Error {}

async function boundedBody(request: Request): Promise<Uint8Array | undefined> {
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel(request.signal.reason).catch(() => undefined); };
  request.signal.addEventListener('abort', cancel, { once: true });
  try {
    if (request.signal.aborted) throw request.signal.reason ?? new Error('Client disconnected');
    while (true) {
      const { done, value } = await reader.read();
      if (request.signal.aborted) throw request.signal.reason ?? new Error('Client disconnected');
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        cancel();
        throw new BodyTooLarge();
      }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return body;
  } finally {
    request.signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

export async function proxyRequest(request: Request, path: string[], search = '', fetchUpstream: typeof fetch = fetch): Promise<Response> {
  const base = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
  const target = new URL(`/${path.map(segment => encodeURIComponent(segment)).join('/')}${search}`, base);
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_BODY_BYTES) return failure(413, 'BODY_TOO_LARGE', 'Requête trop volumineuse.');
  let body: Uint8Array | undefined;
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') body = await boundedBody(request);
  } catch (error) {
    if (error instanceof BodyTooLarge) return failure(413, 'BODY_TOO_LARGE', 'Requête trop volumineuse.');
    if (request.signal.aborted) return failure(499, 'CLIENT_ABORTED', 'Requête annulée.');
    return failure(400, 'BODY_READ_FAILED', 'Lecture de la requête impossible.');
  }
  if (request.signal.aborted) return failure(499, 'CLIENT_ABORTED', 'Requête annulée.');
  const configuredTimeout = Number(process.env.API_PROXY_TIMEOUT_MS ?? 10_000);
  const timeoutMs = Number.isInteger(configuredTimeout) && configuredTimeout >= 100 && configuredTimeout <= 60_000 ? configuredTimeout : 10_000;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error('Upstream timeout')), timeoutMs);
  const signal = AbortSignal.any([request.signal, timeout.signal]);
  const headers = withoutHopHeaders(request.headers, ['host', 'content-length']);
  const requestId = crypto.randomUUID();
  const upstreamStarted = performance.now();
  try {
    const upstream = await fetchUpstream(target, { method: request.method, headers, ...(body ? { body: Buffer.from(body) } : {}), redirect: 'manual', cache: 'no-store', signal });
    const responseHeaders = withoutHopHeaders(upstream.headers, ['content-length', 'content-encoding', 'set-cookie']);
    for (const cookie of upstream.headers.getSetCookie()) responseHeaders.append('set-cookie', cookie);
    responseHeaders.set('Cache-Control', 'no-store');
    if (!upstream.body) { clearTimeout(timer); return new Response(null, { status: upstream.status, headers: responseHeaders }); }
    const reader = upstream.body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) { clearTimeout(timer); controller.close(); }
          else controller.enqueue(value);
        } catch (error) { clearTimeout(timer); controller.error(error); }
      },
      async cancel(reason) { clearTimeout(timer); await reader.cancel(reason); },
    });
    return new Response(stream, { status: upstream.status, headers: responseHeaders });
  } catch {
    clearTimeout(timer);
    if (request.signal.aborted) return failure(499, 'CLIENT_ABORTED', 'Requête annulée.');
    const timedOut = timeout.signal.aborted;
    console.warn(JSON.stringify({ event: 'dashboard_proxy_upstream_error', requestId, code: timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_FAILURE', durationMs: +(performance.now() - upstreamStarted).toFixed(2) }));
    const response = timedOut ? failure(504, 'UPSTREAM_TIMEOUT', 'Délai de l’API dépassé.') : failure(502, 'UPSTREAM_FAILURE', 'API VeyroBot indisponible.');
    response.headers.set('x-request-id', requestId);
    return response;
  }
}
