import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import secureSession from '@fastify/secure-session';
import rateLimit from '@fastify/rate-limit';
import { createHash } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { z } from 'zod';
import { canManageGuild } from '@veyrobot/contracts';
import type { ApiContext, DiscordGuild as DGuild, Session } from './context.js';
import { oauthRoutes } from './oauth-routes.js';
import { guildRoutes } from './guild-routes.js';
import { moderationRoutes, admissionTotals } from './moderation-routes.js';
import { GuildListCache } from './guild-list-cache.js';
import { verifiedClientIp } from './client-ip.js';
import { sanitizedErrorDetails } from './error-details.js';

const envSchema = z.object({
  API_PORT: z.coerce.number().default(4000),
  API_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10_000).default(90),
  API_PREAUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10_000).default(180),
  API_PUBLIC_URL: z.string().url(),
  DASHBOARD_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_CLIENT_SECRET: z.string().min(1),
  DISCORD_BOT_TOKEN: z.string().min(1),
  SESSION_KEY: z.string().regex(/^[a-f\d]{64}$/i),
  API_TRUSTED_PROXIES: z.string().default(''),
  API_PROXY_CLIENT_IP_SECRET: z.string().refine(secret => secret === '' || Buffer.byteLength(secret) >= 32, 'Must be empty or at least 32 bytes').default(''),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});
const envResult = envSchema.safeParse(process.env);
if (!envResult.success) {
  const fields = [...new Set(envResult.error.issues.map(issue => issue.path.join('.')))];
  console.error(`Configuration API invalide. Variables manquantes ou invalides : ${fields.join(', ')}`);
  process.exit(1);
}
const env = envResult.data;
const [db, moderation] = await Promise.all([import('@veyrobot/db'), import('@veyrobot/moderation/service')]);
const { prisma } = db;

const trustedProxies = env.API_TRUSTED_PROXIES.split(',').map(value => value.trim()).filter(Boolean);
const app = Fastify({ logger: { serializers: { req: (req) => ({ method: req.method, path: req.url?.split('?')[0] }) } }, trustProxy: trustedProxies.length ? trustedProxies : false, bodyLimit: 16_384 });
app.addHook('onRequest', async (req, reply) => { reply.header('x-request-id', req.id); });
await app.register(secureSession, { key: Buffer.from(env.SESSION_KEY, 'hex'), cookieName: 'veyrobot_session', cookie: { path: '/', httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production', maxAge: 60 * 60 * 8 } });

const validatedSessionIds = new WeakMap<FastifyRequest, string>();
const sessionValidationFailures = new WeakMap<FastifyRequest, { status: 401 | 503; code: string; message: string }>();
const clientIpKey = (req: FastifyRequest) => {
  const signedIp = env.API_PROXY_CLIENT_IP_SECRET ? verifiedClientIp(req.headers, env.API_PROXY_CLIENT_IP_SECRET) : null;
  return `ip:${signedIp ?? req.ip}`;
};
const requestRateLimitKey = (req: FastifyRequest) => {
  const sessionId = validatedSessionIds.get(req);
  return sessionId ? `session:${sessionId}` : clientIpKey(req);
};
await app.register(rateLimit, { global: false, max: env.API_RATE_LIMIT_MAX, timeWindow: '1 minute', keyGenerator: requestRateLimitKey,
  errorResponseBuilder: (req) => ({ statusCode: 429, code: 'API_RATE_LIMIT', error: 'Trop de requêtes. Réessayez après le délai indiqué.', requestId: req.id }) });
const checkPreAuthRateLimit = app.createRateLimit({ max: env.API_PREAUTH_RATE_LIMIT_MAX, timeWindow: '1 minute', keyGenerator: clientIpKey });
const checkApiRateLimit = app.createRateLimit({ max: env.API_RATE_LIMIT_MAX, timeWindow: '1 minute', keyGenerator: requestRateLimitKey });
function rejectRateLimited(req: FastifyRequest, reply: import('fastify').FastifyReply, limit: Awaited<ReturnType<typeof checkApiRateLimit>>) {
  if (limit.isAllowed || !limit.isExceeded) return null;
  reply.header('retry-after', String(limit.ttlInSeconds));
  reply.header('x-ratelimit-limit', String(limit.max));
  reply.header('x-ratelimit-remaining', '0');
  reply.header('x-ratelimit-reset', String(limit.ttlInSeconds));
  return reply.code(429).send({ statusCode: 429, code: 'API_RATE_LIMIT', error: 'Trop de requêtes. Réessayez après le délai indiqué.', requestId: req.id });
}
app.addHook('onRequest', async (req, reply) => {
  const path = req.url.split('?')[0];
  if (path === '/health' || path === '/ready') return;
  const denied = rejectRateLimited(req, reply, await checkPreAuthRateLimit(req));
  if (denied) return denied;
});

const api = 'https://discord.com/api/v10';
const session = (req: import('fastify').FastifyRequest): Session | null => {
  const auth = (req.session as { get(key: string): unknown }).get('auth') as Partial<Session> | null;
  if (!auth || !auth.user || typeof auth.user.id !== 'string' || typeof auth.user.username !== 'string' || typeof auth.accessToken !== 'string' || typeof auth.csrf !== 'string' || typeof auth.sessionId !== 'string') return null;
  return auth as Session;
};
const sessionHash = (id: string) => createHash('sha256').update(id).digest('hex');
const sendError: ApiContext['sendError'] = (request, reply, error) => {
  const candidate = error as { statusCode?: number; code?: string; retryAfter?: string };
  const dependencyUnavailable = ['P1000', 'P1001', 'P1002', 'P1017', 'P2024'].includes(candidate.code ?? '') || (error instanceof Error && error.name === 'PrismaClientInitializationError');
  const status = error instanceof z.ZodError || (error instanceof Error && error.name === 'ModerationRuleError') ? 400 : candidate.statusCode ?? (candidate.code === 'P2002' || candidate.code === 'P2034' ? 409 : candidate.code === 'MODERATION_BACKLOG_LIMIT' ? 429 : dependencyUnavailable ? 503 : 500);
  const code = error instanceof z.ZodError ? 'VALIDATION_ERROR' : candidate.code ?? (status === 401 ? 'SESSION_ABSENT' : status === 403 ? 'ACCESS_DENIED' : status === 429 ? 'RATE_LIMITED' : status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED');
  if (candidate.retryAfter) reply.header('retry-after', candidate.retryAfter);
  app.log.error({ requestId: request.id, status, code, ...(candidate.retryAfter ? { retryAfter: candidate.retryAfter } : {}), exception: sanitizedErrorDetails(error) }, 'API request failed');
  const message = status === 400 ? 'Requête invalide.' : status === 401 ? 'Reconnectez votre compte.' : status === 403 ? 'Accès refusé.' : status === 409 ? 'Conflit avec une opération existante.' : status === 429 ? 'Trop de requêtes ou capacité atteinte.' : status === 503 || status === 502 ? 'Service temporairement indisponible.' : 'Erreur interne.';
  return reply.code(status).send({ code, error: message, requestId: request.id });
};
app.setErrorHandler((error, request, reply) => sendError(request, reply, error));
app.addHook('preValidation', async (req) => {
  const path = req.url.split('?')[0];
  if (path === '/health' || path === '/ready' || path === '/public-config' || path === '/oauth/discord/start' || path === '/oauth/discord/callback') return;
  const current = session(req);
  if (!current?.user) return;
  if (!current.sessionId) { req.session.delete(); sessionValidationFailures.set(req, { status: 401, code: 'SESSION_ABSENT', message: 'Reconnectez votre compte.' }); return; }
  try {
    const grant = await prisma.sessionGrant.findUnique({ where: { idHash: sessionHash(current.sessionId) }, select: { expiresAt: true, revokedAt: true } });
    if (!grant || grant.revokedAt || grant.expiresAt <= new Date()) {
      req.session.delete();
      sessionValidationFailures.set(req, { status: 401, code: 'SESSION_ABSENT', message: 'Session expirée ou révoquée.' });
      return;
    }
    validatedSessionIds.set(req, current.sessionId);
  } catch {
    sessionValidationFailures.set(req, { status: 503, code: 'SESSION_CHECK_UNAVAILABLE', message: 'Vérification de session indisponible.' });
  }
});
app.addHook('preHandler', async (req, reply) => {
  const path = req.url.split('?')[0];
  if (path === '/health' || path === '/ready') return;
  const denied = rejectRateLimited(req, reply, await checkApiRateLimit(req));
  if (denied) return denied;
  const failure = sessionValidationFailures.get(req);
  if (failure) return reply.code(failure.status).send({ code: failure.code, error: failure.message, requestId: req.id });
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
  return guildListCache.get(guildListCacheKey(s), () => getGuilds(s));
}
async function getFreshGuilds(s: Session): Promise<DGuild[]> {
  return guildListCache.refresh(guildListCacheKey(s), () => getGuilds(s));
}
function guildListCacheKey(s: Session): string { return createHash('sha256').update(`${s.user.id}:${s.accessToken}`).digest('hex'); }
async function authorizeGuild(req: FastifyRequest, guildId: string, fresh = false): Promise<{ session: Session; guild: DGuild }> {
  const s = session(req);
  if (!s) throw Object.assign(new Error('Connexion Discord requise.'), { statusCode: 401, code: 'SESSION_ABSENT' });
  if (!/^\d{17,20}$/.test(guildId)) throw Object.assign(new Error('Identifiant de serveur invalide.'), { statusCode: 400, code: 'INVALID_GUILD_ID' });
  const guild = (await (fresh ? getFreshGuilds(s) : getCachedGuilds(s))).find(g => g.id === guildId);
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
const context: ApiContext = { env, db, moderation, prisma, guildListCache, sessionHash, sendError, session, getCachedGuilds, authorizeGuild, requireInstalledGuild, validMutation, isBotOnlineInGuild };
await app.register(oauthRoutes(context));
await app.register(guildRoutes(context));
await app.register(moderationRoutes(context));

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
let previousElu = performance.eventLoopUtilization();
const resourceTimer = setInterval(() => {
  const memory = process.memoryUsage();
  const elu = performance.eventLoopUtilization(previousElu);
  previousElu = performance.eventLoopUtilization();
  app.log.info({ metric: 'api_resources', acceptedResponses: admissionTotals.accepted, backlogRefusals: admissionTotals.refused,
    moderationAdmission: db.takeAdmissionMetrics(),
    poolAcquisition: db.takePoolAcquireMetrics(),
    rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, externalBytes: memory.external,
    pool: { total: db.postgresPool.totalCount, idle: db.postgresPool.idleCount, waiting: db.postgresPool.waitingCount },
    eventLoopUtilization: elu.utilization, eventLoopDelayP95Ms: loopDelay.percentile(95) / 1e6 }, 'api operational snapshot');
  loopDelay.reset();
}, 60_000);
resourceTimer.unref();
app.addHook('onClose', async () => { clearInterval(resourceTimer); loopDelay.disable(); await prisma.$disconnect(); });
await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().catch(error => {
      app.log.error({ err: error }, 'API shutdown failed');
      process.exitCode = 1;
    });
  });
}
