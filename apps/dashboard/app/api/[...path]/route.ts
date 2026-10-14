import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const hopHeaders = ['host', 'connection', 'content-length', 'transfer-encoding', 'content-encoding'];

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await context.params;
  const base = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
  const target = new URL(`/${path.map(segment => encodeURIComponent(segment)).join('/')}${request.nextUrl.search}`, base);
  const headers = new Headers(request.headers);
  for (const name of hopHeaders) headers.delete(name);
  try {
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
    if (body && body.byteLength > 1_048_576) return Response.json({ error: 'Requête trop volumineuse.' }, { status: 413 });
    const upstream = await fetch(target, { method: request.method, headers, ...(body ? { body } : {}), redirect: 'manual', cache: 'no-store', signal: request.signal });
    const responseHeaders = new Headers(upstream.headers);
    for (const name of hopHeaders) responseHeaders.delete(name);
    responseHeaders.set('Cache-Control', 'no-store');
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return Response.json({ error: 'API VeyroBot indisponible.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
