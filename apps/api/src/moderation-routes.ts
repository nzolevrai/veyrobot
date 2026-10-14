import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { canModerateMembers } from '@veyrobot/contracts';
import type { ModerationAction } from '@veyrobot/moderation/service';
import type { ApiContext } from './context.js';

export const admissionTotals = { accepted: 0, refused: 0 };

export function moderationRoutes(ctx: ApiContext): FastifyPluginAsync {
  const { env, prisma, requireInstalledGuild, isBotOnlineInGuild } = ctx;
  const { casesForGuildQuery, createWarningCase, withModerationAdmission } = ctx.db;
  const { submitModerationAction } = ctx.moderation;
  return async app => {
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
    const item = await withModerationAdmission(prisma, req.params.guildId, input.operationId, tx => submitModerationAction(tx, { guildId: req.params.guildId, actorId: s.user.id, targetId: input.targetId, action: input.action, reason: input.reason, ...(input.durationMinutes === undefined ? {} : { durationMinutes: input.durationMinutes }), ...(input.channelId === undefined ? {} : { channelId: input.channelId }), ...(input.filterAuthorId === undefined ? {} : { filterAuthorId: input.filterAuthorId }), ...(input.requestedCount === undefined ? {} : { requestedCount: input.requestedCount }), ...(input.rateLimitSeconds === undefined ? {} : { rateLimitSeconds: input.rateLimitSeconds }), operationId: input.operationId }));
    admissionTotals.accepted++;
    return reply.code(202).send(item);
  } catch (e) { if ((e as { code?: string }).code === 'MODERATION_BACKLOG_LIMIT') admissionTotals.refused++; return reply.code((e as { statusCode?: number }).statusCode ?? 400).send({ error: e instanceof Error ? e.message : 'Erreur de requête.' }); }
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

  };
}
