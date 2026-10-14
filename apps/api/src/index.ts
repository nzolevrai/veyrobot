import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import secureSession from '@fastify/secure-session';
import rateLimit from '@fastify/rate-limit';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canManageGuild, canModerateMembers } from '@veyrobot/contracts';
import type { ModerationAction } from '@veyrobot/moderation';

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
const [{ casesForGuildQuery, createWarningCase, prisma, defaultGuildConfig, guildSettingsSchema, moduleIds }, moderation] = await Promise.all([import('@veyrobot/db'), import('@veyrobot/moderation')]);
const { submitModerationAction } = moderation;

const app = Fastify({ logger: { serializers: { req: (req) => ({ method: req.method, path: req.url?.split('?')[0] }) } }, trustProxy: env.NODE_ENV === 'production', bodyLimit: 16_384 });
app.addHook('onRequest', async (req, reply) => { reply.header('x-request-id', req.id); });
await app.register(rateLimit, { max: 90, timeWindow: '1 minute', errorResponseBuilder: (req) => ({ statusCode: 429, code: 'API_RATE_LIMIT', error: 'Trop de requêtes. Réessayez après le délai indiqué.', requestId: req.id }) });
await app.register(secureSession, { key: Buffer.from(env.SESSION_KEY, 'hex'), cookieName: 'veyrobot_session', cookie: { path: '/', httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production', maxAge: 60 * 60 * 8 } });

const api = 'https://discord.com/api/v10';
type DUser = { id: string; username: string; avatar: string | null };
type DGuild = { id: string; name: string; icon: string | null; owner: boolean; permissions: string };
type Session = { user: DUser; accessToken: string; csrf: string };
type ApiFailure = Error & { statusCode?: number; code?: string; retryAfter?: string };
const session = (req: import('fastify').FastifyRequest): Session | null => (req.session as { get(key: string): unknown }).get('auth') as Session | null ?? null;
async function getGuilds(s: Session): Promise<DGuild[]> {
  let response: Response;
  try { response = await fetch(`${api}/users/@me/guilds?limit=200`, { headers: { Authorization: `Bearer ${s.accessToken}` }, signal: AbortSignal.timeout(8_000) }); }
  catch { throw Object.assign(new Error('Discord est temporairement indisponible.'), { statusCode: 502, code: 'DISCORD_UNAVAILABLE' }); }
  if (response.status === 401 || response.status === 403) throw Object.assign(new Error('Reconnectez votre compte Discord.'), { statusCode: 401, code: 'OAUTH_RECONNECT_REQUIRED' });
  if (response.status === 429) throw Object.assign(new Error('Discord limite temporairement la lecture des serveurs.'), { statusCode: 429, code: 'DISCORD_RATE_LIMIT', retryAfter: response.headers.get('retry-after') ?? undefined });
  if (!response.ok) throw Object.assign(new Error('Discord est temporairement indisponible.'), { statusCode: 502, code: 'DISCORD_UNAVAILABLE' });
  return z.array(z.object({ id: z.string(), name: z.string(), icon: z.string().nullable(), owner: z.boolean(), permissions: z.string() })).parse(await response.json());
}
const guildListCache = new Map<string, { expiresAt: number; guilds: DGuild[] }>();
async function getCachedGuilds(s: Session): Promise<DGuild[]> {
  const key = createHash('sha256').update(`${s.user.id}:${s.accessToken}`).digest('hex');
  const cached = guildListCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.guilds;
  const guilds = await getGuilds(s);
  const now = Date.now();
  for (const [cacheKey, value] of guildListCache) if (value.expiresAt <= now) guildListCache.delete(cacheKey);
  if (guildListCache.size >= 1_000) guildListCache.delete(guildListCache.keys().next().value!);
  guildListCache.set(key, { guilds, expiresAt: now + 10_000 });
  return guilds;
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
app.get('/public-config', async () => ({ discordClientId: env.DISCORD_CLIENT_ID }));
app.get('/oauth/discord/start', async (_req, reply) => {
  const state = crypto.randomUUID();
  const s = { csrf: state } as Session;
  (_req.session as { set(key: string, value: unknown): void }).set('auth', s);
  const params = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, response_type: 'code', redirect_uri: `${env.API_PUBLIC_URL}/oauth/discord/callback`, scope: 'identify guilds', state });
  return reply.redirect(`https://discord.com/oauth2/authorize?${params}`);
});
app.get('/oauth/discord/callback', async (req, reply) => {
  const query = z.object({ code: z.string().min(1), state: z.string().min(1) }).safeParse(req.query);
  const initial = session(req);
  if (!query.success || !initial?.csrf || query.data.state !== initial.csrf) return reply.code(400).send({ error: 'État OAuth invalide ou expiré.' });
  const tokenResponse = await fetch(`${api}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code: query.data.code, redirect_uri: `${env.API_PUBLIC_URL}/oauth/discord/callback` }) });
  if (!tokenResponse.ok) return reply.code(401).send({ error: 'La connexion Discord a échoué.' });
  const token = z.object({ access_token: z.string(), token_type: z.string(), expires_in: z.number() }).parse(await tokenResponse.json());
  const userResponse = await fetch(`${api}/users/@me`, { headers: { Authorization: `Bearer ${token.access_token}` } });
  if (!userResponse.ok) return reply.code(401).send({ error: 'Impossible de lire le profil Discord.' });
  const user = z.object({ id: z.string(), username: z.string(), avatar: z.string().nullable() }).parse(await userResponse.json());
  (req.session as { set(key: string, value: unknown): void }).set('auth', { user, accessToken: token.access_token, csrf: crypto.randomUUID() } satisfies Session);
  return reply.redirect(new URL('/dashboard/user', env.DASHBOARD_URL).toString());
});
app.get('/me', async (req, reply) => { const s = session(req); if (!s?.user) return reply.code(401).send({ code: 'SESSION_ABSENT', error: 'Non connecté.', requestId: req.id }); return { user: s.user, csrf: s.csrf }; });
app.post('/logout', async (req, reply) => {
  if (req.headers.origin !== new URL(env.DASHBOARD_URL).origin) return reply.code(403).send({ error: 'Vérification CSRF refusée.' });
  const s = session(req);
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
app.get('/guilds', async (req, reply) => {
  const s = session(req); if (!s?.user) return reply.code(401).send({ code: 'SESSION_ABSENT', error: 'Connexion requise.', requestId: req.id });
  try {
    const guilds = (await getCachedGuilds(s)).filter(g => canManageGuild(g.owner, g.permissions));
    const memberships = await prisma.guildPresence.findMany({ where: { guildId: { in: guilds.map(g => g.id) } }, select: { guildId: true, shardId: true } });
    const shardIds = [...new Set(memberships.map(row => row.shardId))];
    const onlineShards = new Set((await prisma.shardPresence.findMany({ where: { shardId: { in: shardIds }, lastSeenAt: { gt: new Date(Date.now() - 90_000) } }, select: { shardId: true } })).map(row => row.shardId));
    const installedGuildIds = new Set(memberships.map(row => row.guildId));
    const onlineGuildIds = new Set(memberships.filter(row => onlineShards.has(row.shardId)).map(row => row.guildId));
    return guilds.map(g => ({ id: g.id, name: g.name, icon: g.icon, owner: g.owner, canManage: true, permissions: g.permissions, botInstalled: installedGuildIds.has(g.id), botOnline: onlineGuildIds.has(g.id), botPresent: installedGuildIds.has(g.id) }));
  } catch (cause) {
    const failure = cause as ApiFailure;
    const status = failure.statusCode ?? 503;
    if (failure.retryAfter) reply.header('retry-after', failure.retryAfter);
    app.log.warn({ requestId: req.id, endpoint: '/guilds', status, code: failure.code ?? 'INTERNAL_ERROR' }, 'guild list failed');
    return reply.code(status).send({ code: failure.code ?? 'INTERNAL_ERROR', error: failure.statusCode ? failure.message : 'Impossible de lire les serveurs actuellement.', requestId: req.id });
  }
});
app.post<{ Params: { guildId: string }; Body: unknown }>('/guilds/:guildId/installation-check', async (req, reply) => {
  try {
    const { session: s } = await authorizeGuild(req, req.params.guildId, true);
    const input = z.object({ csrf: z.string() }).parse(req.body);
    if (!validMutation(req, s, input.csrf)) return reply.code(403).send({ error: 'Vérification CSRF refusée.' });
    const response = await fetch(`${api}/guilds/${req.params.guildId}`, { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` }, signal: AbortSignal.timeout(5_000) });
    if (response.status === 403 || response.status === 404) {
      await prisma.guildPresence.deleteMany({ where: { guildId: req.params.guildId } });
      return { botInstalled: false, botOnline: false };
    }
    if (!response.ok) return reply.code(503).send({ error: 'La vérification Discord est temporairement indisponible. Réessayez plus tard.' });
    await prisma.guildPresence.upsert({ where: { guildId: req.params.guildId }, create: { guildId: req.params.guildId, shardId: -1 }, update: {} });
    return { botInstalled: true, botOnline: await isBotOnlineInGuild(req.params.guildId) };
  } catch (e) { return reply.code((e as { statusCode?: number }).statusCode ?? 503).send({ error: e instanceof Error ? e.message : 'Vérification indisponible.' }); }
});
app.get<{ Params: { guildId: string } }>('/guilds/:guildId/config', async (req, reply) => {
  try {
    await requireInstalledGuild(req, req.params.guildId);
    return await prisma.guildConfig.findUnique({ where: { guildId: req.params.guildId } }) ?? { guildId: req.params.guildId, ...defaultGuildConfig };
  } catch (cause) {
    const failure = cause as ApiFailure;
    const status = failure.statusCode ?? 503;
    if (failure.retryAfter) reply.header('retry-after', failure.retryAfter);
    app.log.warn({ requestId: req.id, endpoint: '/guilds/:guildId/config', status, code: failure.code ?? 'INTERNAL_ERROR' }, 'guild config failed');
    return reply.code(status).send({ code: failure.code ?? (status === 403 ? 'ACCESS_DENIED' : 'INTERNAL_ERROR'), error: failure.statusCode ? failure.message : 'Configuration temporairement indisponible.', requestId: req.id });
  }
});
const configMutation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('module'), moduleId: z.enum(moduleIds), enabled: z.boolean(), version: z.number().int().nonnegative(), csrf: z.string() }),
  z.object({ kind: z.literal('settings'), settings: guildSettingsSchema, version: z.number().int().nonnegative(), csrf: z.string() }),
  z.object({ kind: z.literal('patch'), changes: guildSettingsSchema.partial().extend({ warningsEnabled: z.boolean().optional(), memberActionsEnabled: z.boolean().optional(), channelActionsEnabled: z.boolean().optional() }).refine(value => Object.keys(value).length > 0, 'Aucune modification.'), version: z.number().int().nonnegative(), csrf: z.string() }),
]);
app.put<{ Params: { guildId: string }; Body: unknown }>('/guilds/:guildId/config', async (req, reply) => {
  try {
    const { session: s } = await requireInstalledGuild(req, req.params.guildId, true);
    const input = configMutation.parse(req.body);
    if (!validMutation(req, s, input.csrf)) return reply.code(403).send({ error: 'Vérification CSRF refusée.' });
    const raw = input.kind === 'module' ? { [input.moduleId === 'warnings' ? 'warningsEnabled' : input.moduleId === 'member-actions' ? 'memberActionsEnabled' : 'channelActionsEnabled']: input.enabled } : input.kind === 'settings' ? input.settings : input.changes;
    const data = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined)) as Record<string, string | boolean>;
    const updated = await prisma.$transaction(async tx => {
      const current = await tx.guildConfig.findUnique({ where: { guildId: req.params.guildId } });
      if ((current?.version ?? 0) !== input.version) return null;
      if (!current) {
        const created = await tx.guildConfig.create({ data: { guildId: req.params.guildId, updatedBy: s.user.id, ...data } });
        await tx.configAudit.create({ data: { guildId: req.params.guildId, actorId: s.user.id, version: created.version, changes: data } });
        return created;
      }
      const claim = await tx.guildConfig.updateMany({ where: { guildId: req.params.guildId, version: input.version }, data: { ...data, version: { increment: 1 }, updatedBy: s.user.id } });
      if (!claim.count) return null;
      const saved = await tx.guildConfig.findUniqueOrThrow({ where: { guildId: req.params.guildId } });
      await tx.configAudit.create({ data: { guildId: req.params.guildId, actorId: s.user.id, version: saved.version, changes: data } });
      return saved;
    });
    if (!updated) return reply.code(409).send({ error: 'Ce serveur a été modifié par une autre personne. Actualisez les réglages.' });
    return updated;
  } catch (e) {
    if (['P2002', 'P2034'].includes((e as { code?: string }).code ?? '')) return reply.code(409).send({ error: 'La configuration a changé pendant l’enregistrement. Actualisez les réglages.' });
    if (e instanceof z.ZodError) return reply.code(400).send({ error: e.issues[0]?.message ?? 'Réglages invalides.' });
    const status = (e as { statusCode?: number }).statusCode;
    if (status) return reply.code(status).send({ error: e instanceof Error ? e.message : 'Accès refusé.' });
    app.log.error({ err: e }, 'guild config update failed');
    return reply.code(500).send({ error: 'La configuration n’a pas pu être enregistrée.' });
  }
});
app.get<{ Params: { guildId: string }; Querystring: unknown }>('/guilds/:guildId/cases', async (req, reply) => {
  try {
    await requireInstalledGuild(req, req.params.guildId);
    const q = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(50).default(25), targetId: z.string().regex(/^\d{17,20}$/).optional() }).parse(req.query);
    const rows = await prisma.moderationCase.findMany({ where: casesForGuildQuery(req.params.guildId, q.targetId), orderBy: { createdAt: 'desc' }, take: q.limit, ...(q.cursor ? { skip: 1, cursor: { id: q.cursor } } : {}) });
    return { items: rows, nextCursor: rows.length === q.limit ? rows.at(-1)?.id : null };
  } catch (e) { return reply.code((e as { statusCode?: number }).statusCode ?? 400).send({ error: e instanceof Error ? e.message : 'Erreur de requête.' }); }
});
const actionInput = z.object({ action: z.enum(['TIMEOUT', 'UNTIMEOUT', 'KICK', 'BAN', 'UNBAN', 'TEMPBAN', 'PURGE_MESSAGES', 'SLOWMODE', 'LOCK_CHANNEL', 'UNLOCK_CHANNEL']), targetId: z.string().regex(/^\d{17,20}$/), channelId: z.string().regex(/^\d{17,20}$/).optional(), filterAuthorId: z.string().regex(/^\d{17,20}$/).optional(), requestedCount: z.coerce.number().int().min(1).max(100).optional(), rateLimitSeconds: z.coerce.number().int().min(0).max(21_600).optional(), reason: z.string().trim().min(1).max(500), durationMinutes: z.coerce.number().int().min(1).max(525_600).optional(), csrf: z.string().min(1), operationId: z.string().regex(/^[\w-]{16,80}$/) });
const userPermissionBits: Record<ModerationAction, bigint> = { TIMEOUT: 1n << 40n, UNTIMEOUT: 1n << 40n, KICK: 1n << 1n, BAN: 1n << 2n, UNBAN: 1n << 2n, TEMPBAN: 1n << 2n, PURGE_MESSAGES: 1n << 13n, SLOWMODE: 1n << 4n, LOCK_CHANNEL: 1n << 28n, UNLOCK_CHANNEL: 1n << 28n };
app.post<{ Params: { guildId: string }; Body: unknown }>('/guilds/:guildId/actions', async (req, reply) => {
  try {
    const { session: s, guild } = await requireInstalledGuild(req, req.params.guildId, true);
    const input = actionInput.parse(req.body);
    if (input.csrf !== s.csrf || req.headers.origin !== new URL(env.DASHBOARD_URL).origin) return reply.code(403).send({ error: 'Vérification CSRF refusée.' });
    const channelAction = ['PURGE_MESSAGES', 'SLOWMODE', 'LOCK_CHANNEL', 'UNLOCK_CHANNEL'].includes(input.action);
    if (!channelAction && !guild.owner && (BigInt(guild.permissions) & userPermissionBits[input.action]) === 0n) return reply.code(403).send({ error: 'La permission Discord requise pour cette action est absente.' });
    if ((input.action === 'TIMEOUT' || input.action === 'TEMPBAN') && input.durationMinutes === undefined) return reply.code(400).send({ error: 'La durée est obligatoire pour cette action.' });
    if (input.action !== 'TIMEOUT' && input.action !== 'TEMPBAN' && input.durationMinutes !== undefined) return reply.code(400).send({ error: 'La durée ne s’applique qu’au timeout ou au ban temporaire.' });
    if (input.action === 'TIMEOUT' && (input.durationMinutes! > 40_320)) return reply.code(400).send({ error: 'Le timeout est limité à 28 jours.' });
    if (input.action === 'PURGE_MESSAGES' && input.requestedCount === undefined) return reply.code(400).send({ error: 'Le nombre de messages à examiner est obligatoire.' });
    if (input.action === 'SLOWMODE' && input.rateLimitSeconds === undefined) return reply.code(400).send({ error: 'La valeur du slowmode est obligatoire (0 pour le désactiver).'});
    if (!await isBotOnlineInGuild(req.params.guildId)) return reply.code(503).send({ error: 'Le bot est installé mais temporairement hors ligne. Réessayez après son retour.' });
    const item = await submitModerationAction(prisma, { guildId: req.params.guildId, actorId: s.user.id, targetId: input.targetId, action: input.action, reason: input.reason, ...(input.durationMinutes === undefined ? {} : { durationMinutes: input.durationMinutes }), ...(input.channelId === undefined ? {} : { channelId: input.channelId }), ...(input.filterAuthorId === undefined ? {} : { filterAuthorId: input.filterAuthorId }), ...(input.requestedCount === undefined ? {} : { requestedCount: input.requestedCount }), ...(input.rateLimitSeconds === undefined ? {} : { rateLimitSeconds: input.rateLimitSeconds }), operationId: input.operationId });
    return reply.code(202).send(item);
  } catch (e) { return reply.code((e as { statusCode?: number }).statusCode ?? 400).send({ error: e instanceof Error ? e.message : 'Erreur de requête.' }); }
});
const warningInput = z.object({ targetId: z.string().regex(/^\d{17,20}$/), reason: z.string().trim().min(1).max(500), csrf: z.string().min(1) });
app.post<{ Params: { guildId: string }; Body: unknown }>('/guilds/:guildId/warnings', async (req, reply) => {
  try {
    const { session: s, guild: memberPermission } = await requireInstalledGuild(req, req.params.guildId, true);
    const input = warningInput.parse(req.body);
    if (input.csrf !== s.csrf || req.headers.origin !== new URL(env.DASHBOARD_URL).origin) return reply.code(403).send({ error: 'Vérification CSRF refusée.' });
    if (!memberPermission || !canModerateMembers(memberPermission.owner, memberPermission.permissions)) return reply.code(403).send({ error: 'La permission Discord Modérer les membres est requise.' });
    if (!await isBotOnlineInGuild(req.params.guildId)) return reply.code(503).send({ error: 'Le bot est installé mais temporairement hors ligne. Réessayez après son retour.' });
    const record = await createWarningCase({ guildId: req.params.guildId, actorId: s.user.id, targetId: input.targetId, reason: input.reason });
    return reply.code(201).send(record);
  } catch (e) { return reply.code((e as { statusCode?: number }).statusCode ?? 400).send({ error: e instanceof Error ? e.message : 'Erreur de requête.' }); }
});

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
