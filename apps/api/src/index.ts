import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import secureSession from '@fastify/secure-session';
import rateLimit from '@fastify/rate-limit';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canManageGuild } from '@veyrobot/contracts';
import type { ApiContext, DiscordGuild as DGuild, Session } from './context.js';
import { oauthRoutes } from './oauth-routes.js';
import { guildRoutes } from './guild-routes.js';
import { moderationRoutes } from './moderation-routes.js';
import { GuildListCache } from './guild-list-cache.js';

const envSchema = z.object({
  API_PORT: z.coerce.number().default(4000),
  API_PUBLIC_URL: z.string().url(),
  DASHBOARD_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_CLIENT_SECRET: z.string().min(1),
  DISCORD_BOT_TOKEN: z.string().min(1),
  SESSION_KEY: z.string().regex(/^[a-f\d]{64}$/i),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});
const envResult = envSchema.safeParse(process.env);
if (!envResult.success) {
  const fields = [...new Set(envResult.error.issues.map(issue => issue.path.join('.')))];
  console.error(`Configuration API invalide. Variables manquantes ou invalides : ${fields.join(', ')}`);
  process.exit(1);
}
const env = envResult.data;
const [db, moderation] = await Promise.all([import('@veyrobot/db'), import('@veyrobot/moderation')]);
const { prisma } = db;

const app = Fastify({ logger: { serializers: { req: (req) => ({ method: req.method, path: req.url?.split('?')[0] }) } }, trustProxy: env.NODE_ENV === 'production', bodyLimit: 16_384 });
app.addHook('onRequest', async (req, reply) => { reply.header('x-request-id', req.id); });
await app.register(rateLimit, { max: 90, timeWindow: '1 minute', errorResponseBuilder: (req) => ({ statusCode: 429, code: 'API_RATE_LIMIT', error: 'Trop de requêtes. Réessayez après le délai indiqué.', requestId: req.id }) });
await app.register(secureSession, { key: Buffer.from(env.SESSION_KEY, 'hex'), cookieName: 'veyrobot_session', cookie: { path: '/', httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production', maxAge: 60 * 60 * 8 } });

const api = 'https://discord.com/api/v10';
const session = (req: import('fastify').FastifyRequest): Session | null => (req.session as { get(key: string): unknown }).get('auth') as Session | null ?? null;
const sessionHash = (id: string) => createHash('sha256').update(id).digest('hex');
app.addHook('preHandler', async (req, reply) => {
  const path = req.url.split('?')[0];
  if (path === '/health' || path === '/ready' || path === '/public-config' || path === '/oauth/discord/start' || path === '/oauth/discord/callback') return;
  const current = session(req);
  if (!current?.user) return;
  if (!current.sessionId) { req.session.delete(); return reply.code(401).send({ code: 'SESSION_ABSENT', error: 'Reconnectez votre compte.', requestId: req.id }); }
  try {
    const grant = await prisma.sessionGrant.findUnique({ where: { idHash: sessionHash(current.sessionId) }, select: { expiresAt: true, revokedAt: true } });
    if (!grant || grant.revokedAt || grant.expiresAt <= new Date()) {
      req.session.delete();
      return reply.code(401).send({ code: 'SESSION_ABSENT', error: 'Session expirée ou révoquée.', requestId: req.id });
    }
  } catch {
    return reply.code(503).send({ code: 'SESSION_CHECK_UNAVAILABLE', error: 'Vérification de session indisponible.', requestId: req.id });
  }
});
async function getGuilds(s: Session): Promise<DGuild[]> {
  let response: Response;
  try { response = await fetch(`${api}/users/@me/guilds?limit=200`, { headers: { Authorization: `Bearer ${s.accessToken}` }, signal: AbortSignal.timeout(8_000) }); }
  catch { throw Object.assign(new Error('Discord est temporairement indisponible.'), { statusCode: 502, code: 'DISCORD_UNAVAILABLE' }); }
  if (response.status === 401 || response.status === 403) throw Object.assign(new Error('Reconnectez votre compte Discord.'), { statusCode: 401, code: 'OAUTH_RECONNECT_REQUIRED' });
  if (response.status === 429) throw Object.assign(new Error('Discord limite temporairement la lecture des serveurs.'), { statusCode: 429, code: 'DISCORD_RATE_LIMIT', retryAfter: response.headers.get('retry-after') ?? undefined });
  if (!response.ok) throw Object.assign(new Error('Discord est temporairement indisponible.'), { statusCode: 502, code: 'DISCORD_UNAVAILABLE' });
  return z.array(z.object({ id: z.string(), name: z.string(), icon: z.string().nullable(), owner: z.boolean(), permissions: z.string() })).parse(await response.json());
}
const guildListCache = new GuildListCache<DGuild[]>();
async function getCachedGuilds(s: Session): Promise<DGuild[]> {
  const key = createHash('sha256').update(`${s.user.id}:${s.accessToken}`).digest('hex');
  return guildListCache.get(key, () => getGuilds(s));
}
async function authorizeGuild(req: FastifyRequest, guildId: string, fresh = false): Promise<{ session: Session; guild: DGuild }> {
  const s = session(req);
  if (!s) throw Object.assign(new Error('Connexion Discord requise.'), { statusCode: 401, code: 'SESSION_ABSENT' });
  if (!/^\d{17,20}$/.test(guildId)) throw Object.assign(new Error('Identifiant de serveur invalide.'), { statusCode: 400, code: 'INVALID_GUILD_ID' });
  const guild = (await (fresh ? getGuilds(s) : getCachedGuilds(s))).find(g => g.id === guildId);
  if (!guild || !canManageGuild(guild.owner, guild.permissions)) throw Object.assign(new Error('Vous devez être propriétaire du serveur ou disposer de Gérer le serveur.'), { statusCode: 403, code: 'ACCESS_DENIED' });
  return { session: s, guild };
}
async function requireInstalledGuild(req: FastifyRequest, guildId: string, fresh = false) {
  const authorized = await authorizeGuild(req, guildId, fresh);
  const membership = await prisma.guildPresence.findUnique({ where: { guildId }, select: { guildId: true } });
  if (!membership) throw Object.assign(new Error('Veyro n’est pas installé sur ce serveur.'), { statusCode: 403, code: 'ACCESS_DENIED' });
  return authorized;
}
function validMutation(req: FastifyRequest, s: Session, csrf: string): boolean {
  return csrf === s.csrf && req.headers.origin === new URL(env.DASHBOARD_URL).origin;
}
async function isBotOnlineInGuild(guildId: string): Promise<boolean> {
  const membership = await prisma.guildPresence.findUnique({ where: { guildId }, select: { shardId: true } });
  if (!membership) return false;
  const shard = await prisma.shardPresence.findUnique({ where: { shardId: membership.shardId }, select: { lastSeenAt: true } });
  return Boolean(shard && shard.lastSeenAt > new Date(Date.now() - 90_000));
}

app.get('/health', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));
app.get('/ready', { config: { rateLimit: false } }, async (_req, reply) => {
  try { await prisma.$queryRaw`SELECT 1`; return { status: 'ready' }; }
  catch { return reply.code(503).send({ status: 'degraded', dependency: 'postgresql' }); }
});
app.get('/public-config', async () => ({ discordClientId: env.DISCORD_CLIENT_ID }));
const context: ApiContext = { env, db, moderation, prisma, guildListCache, sessionHash, session, getCachedGuilds, authorizeGuild, requireInstalledGuild, validMutation, isBotOnlineInGuild };
await app.register(oauthRoutes(context));
await app.register(guildRoutes(context));
await app.register(moderationRoutes(context));

app.addHook('onClose', async () => { await prisma.$disconnect(); });
await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().catch(error => {
      app.log.error({ err: error }, 'API shutdown failed');
      process.exitCode = 1;
    });
  });
}
