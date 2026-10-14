import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { canManageGuild } from '@veyrobot/contracts';
import type { ApiContext, ApiFailure } from './context.js';

export function guildRoutes(ctx: ApiContext): FastifyPluginAsync {
  const { env, prisma, session, getCachedGuilds, authorizeGuild, requireInstalledGuild, validMutation, isBotOnlineInGuild } = ctx;
  const { defaultGuildConfig, guildSettingsSchema, moduleIds } = ctx.db;
  const api = 'https://discord.com/api/v10';
  return async app => {
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
  };
}
