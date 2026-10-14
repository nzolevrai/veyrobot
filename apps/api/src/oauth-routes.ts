import type { FastifyPluginAsync } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ApiContext, Session } from './context.js';

export function oauthRoutes(ctx: ApiContext): FastifyPluginAsync {
  const { env, prisma, session, sessionHash, guildListCache } = ctx;
  const api = 'https://discord.com/api/v10';
  return async app => {
app.get('/oauth/discord/start', async (_req, reply) => {
  const state = crypto.randomUUID();
  const s = { csrf: state };
  (_req.session as { set(key: string, value: unknown): void }).set('auth', s);
  const params = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, response_type: 'code', redirect_uri: `${env.API_PUBLIC_URL}/oauth/discord/callback`, scope: 'identify guilds', state });
  return reply.redirect(`https://discord.com/oauth2/authorize?${params}`);
});
app.get('/oauth/discord/callback', async (req, reply) => {
  const query = z.object({ code: z.string().min(1), state: z.string().min(1) }).safeParse(req.query);
  const initial = (req.session as { get(key: string): unknown }).get('auth') as { csrf?: string } | null;
  if (!query.success || !initial?.csrf || query.data.state !== initial.csrf) return reply.code(400).send({ error: 'État OAuth invalide ou expiré.' });
  let tokenResponse: Response;
  try { tokenResponse = await fetch(`${api}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code: query.data.code, redirect_uri: `${env.API_PUBLIC_URL}/oauth/discord/callback` }), signal: AbortSignal.timeout(8_000) }); }
  catch { return reply.code(502).send({ error: 'Discord est temporairement indisponible pendant la connexion.' }); }
  if (!tokenResponse.ok) return reply.code(401).send({ error: 'La connexion Discord a échoué.' });
  const token = z.object({ access_token: z.string(), token_type: z.string(), expires_in: z.number() }).parse(await tokenResponse.json());
  let userResponse: Response;
  try { userResponse = await fetch(`${api}/users/@me`, { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(8_000) }); }
  catch { return reply.code(502).send({ error: 'Discord est temporairement indisponible pendant la connexion.' }); }
  if (!userResponse.ok) return reply.code(401).send({ error: 'Impossible de lire le profil Discord.' });
  const user = z.object({ id: z.string(), username: z.string(), avatar: z.string().nullable() }).parse(await userResponse.json());
  const sessionId = crypto.randomUUID();
  await prisma.sessionGrant.create({ data: { idHash: sessionHash(sessionId), expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1_000) } });
  (req.session as { set(key: string, value: unknown): void }).set('auth', { user, accessToken: token.access_token, csrf: crypto.randomUUID(), sessionId } satisfies Session);
  return reply.redirect(new URL('/dashboard/user', env.DASHBOARD_URL).toString());
});
app.get('/me', async (req, reply) => { const s = session(req); if (!s?.user) return reply.code(401).send({ code: 'SESSION_ABSENT', error: 'Non connecté.', requestId: req.id }); return { user: s.user, csrf: s.csrf }; });
app.post('/logout', async (req, reply) => {
  if (req.headers.origin !== new URL(env.DASHBOARD_URL).origin) return reply.code(403).send({ error: 'Vérification CSRF refusée.' });
  const s = session(req);
  if (s?.sessionId) {
    try { await prisma.sessionGrant.updateMany({ where: { idHash: sessionHash(s.sessionId), revokedAt: null }, data: { revokedAt: new Date() } }); }
    catch { return reply.code(503).send({ code: 'SESSION_REVOKE_UNAVAILABLE', error: 'Déconnexion temporairement indisponible.', requestId: req.id }); }
    guildListCache.delete(createHash('sha256').update(`${s.user.id}:${s.accessToken}`).digest('hex'));
  }
  req.session.delete();
  if (s?.accessToken) {
    try {
      const revoked = await fetch(`${api}/oauth2/token/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${env.DISCORD_CLIENT_ID}:${env.DISCORD_CLIENT_SECRET}`).toString('base64')}` },
        body: new URLSearchParams({ token: s.accessToken, token_type_hint: 'access_token' }),
        signal: AbortSignal.timeout(3_000),
      });
      if (!revoked.ok) app.log.warn({ statusCode: revoked.status }, 'Discord OAuth token revocation failed');
    } catch { app.log.warn('Discord OAuth token revocation request failed'); }
  }
  return reply.code(204).send();
});
  };
}
