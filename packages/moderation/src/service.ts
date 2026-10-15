import type { ModerationCase } from '@veyrobot/db';
import { moduleEnabled, moduleForAction } from '@veyrobot/db';
import type { ConnectionOptions } from 'bullmq';

export const ACTIONS = ['TIMEOUT', 'UNTIMEOUT', 'KICK', 'BAN', 'UNBAN', 'TEMPBAN', 'PURGE_MESSAGES', 'SLOWMODE', 'LOCK_CHANNEL', 'UNLOCK_CHANNEL'] as const;
export type ModerationAction = typeof ACTIONS[number];
export type ModerationInput = {
  guildId: string; actorId: string; targetId: string; action: ModerationAction;
  reason: string; durationMinutes?: number; channelId?: string; filterAuthorId?: string; requestedCount?: number; rateLimitSeconds?: number;
};
export function redisConnection(urlString: string, producer = false): ConnectionOptions {
  const url = new URL(urlString);
  if (!['redis:', 'rediss:'].includes(url.protocol)) throw new Error('REDIS_URL must use redis:// or rediss://.');
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.pathname.length > 1 ? { db: Number(url.pathname.slice(1)) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: producer ? 1 : null,
    ...(producer ? { enableOfflineQueue: false, connectTimeout: 3_000, retryStrategy: (attempt: number) => Math.min(1_000 * 2 ** Math.min(attempt - 1, 4), 20_000) } : {}),
  };
}

export function canActOnTarget(input: { actorIsOwner: boolean; actorAboveTarget: boolean; botAboveTarget: boolean; targetIsOwner: boolean }): boolean {
  return !input.targetIsOwner && (input.actorIsOwner || input.actorAboveTarget) && input.botAboveTarget;
}

export class ModerationRuleError extends Error {
  constructor(message: string) { super(message); this.name = 'ModerationRuleError'; }
}

export function validateModerationInput(input: ModerationInput): void {
  if (!/^\d{17,20}$/.test(input.guildId) || !/^\d{17,20}$/.test(input.actorId) || !/^\d{17,20}$/.test(input.targetId)) throw new ModerationRuleError('Identifiant Discord invalide.');
  if (!ACTIONS.includes(input.action)) throw new ModerationRuleError('Action inconnue.');
  if (!input.reason.trim() || input.reason.trim().length > 500) throw new ModerationRuleError('Une raison de 1 à 500 caractères est requise.');
  if ((input.action === 'TIMEOUT' || input.action === 'TEMPBAN') && (!Number.isInteger(input.durationMinutes) || input.durationMinutes! < 1 || input.durationMinutes! > (input.action === 'TIMEOUT' ? 40_320 : 525_600))) throw new ModerationRuleError(input.action === 'TIMEOUT' ? 'La durée du timeout doit être comprise entre 1 minute et 28 jours.' : 'La durée du ban temporaire doit être comprise entre 1 minute et 365 jours.');
  if (['PURGE_MESSAGES', 'SLOWMODE', 'LOCK_CHANNEL', 'UNLOCK_CHANNEL'].includes(input.action) && !/^\d{17,20}$/.test(input.channelId ?? input.targetId)) throw new ModerationRuleError('Identifiant de salon Discord invalide.');
  if (input.action === 'PURGE_MESSAGES' && (!Number.isInteger(input.requestedCount) || input.requestedCount! < 1 || input.requestedCount! > 100)) throw new ModerationRuleError('Le nombre de messages doit être compris entre 1 et 100.');
  if (input.filterAuthorId && !/^\d{17,20}$/.test(input.filterAuthorId)) throw new ModerationRuleError('Identifiant d’auteur Discord invalide.');
  if (input.action === 'SLOWMODE' && (!Number.isInteger(input.rateLimitSeconds) || input.rateLimitSeconds! < 0 || input.rateLimitSeconds! > 21_600)) throw new ModerationRuleError('Le slowmode doit être compris entre 0 et 21600 secondes.');
}

export async function submitModerationAction(
  store: { moderationCase: { create(args: { data: Record<string, unknown> }): Promise<ModerationCase>; findUnique(args: { where: { operationId: string } }): Promise<ModerationCase | null>; update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown> }; guildConfig?: { findUnique(args: { where: { guildId: string } }): Promise<{ warningsEnabled: boolean; memberActionsEnabled: boolean; channelActionsEnabled: boolean } | null> }; guildTargetDecision?: { upsert(args: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }): Promise<{ generation: number }> }; $transaction?: (fn: (tx: { moderationCase: { create(args: { data: Record<string, unknown> }): Promise<ModerationCase> }; guildTargetDecision: { upsert(args: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }): Promise<{ generation: number }> } }) => Promise<ModerationCase>) => Promise<ModerationCase> },
  input: ModerationInput & { operationId: string },
): Promise<ModerationCase> {
  validateModerationInput(input);
  if (!/^[\w-]{16,80}$/.test(input.operationId)) throw new ModerationRuleError('Identifiant d’opération invalide.');
  const channelAction = ['PURGE_MESSAGES', 'SLOWMODE', 'LOCK_CHANNEL', 'UNLOCK_CHANNEL'].includes(input.action);
  const original = async () => {
    const prior = await store.moderationCase.findUnique({ where: { operationId: input.operationId } });
    if (!prior) return null;
    if (prior.guildId !== input.guildId || prior.actorId !== input.actorId || prior.targetId !== (channelAction ? input.channelId ?? input.targetId : input.targetId) || prior.action !== input.action || prior.reason !== input.reason.trim() || prior.durationMinutes !== (input.durationMinutes ?? null) || prior.channelId !== (channelAction ? input.channelId ?? input.targetId : null) || prior.filterAuthorId !== (input.filterAuthorId ?? null) || prior.requestedCount !== (input.requestedCount ?? null) || prior.rateLimitSeconds !== (input.rateLimitSeconds ?? null)) throw new ModerationRuleError('Identifiant déjà utilisé pour une autre opération.');
    return prior;
  };
  const prior = await original();
  if (prior) return prior;
  if (store.guildConfig && !moduleEnabled(await store.guildConfig.findUnique({ where: { guildId: input.guildId } }), moduleForAction(input.action))) throw new ModerationRuleError('Ce module est désactivé sur ce serveur.');
  const data: Record<string, unknown> = { ...input, ...(channelAction ? { channelId: input.channelId ?? input.targetId, targetId: input.channelId ?? input.targetId } : {}), id: crypto.randomUUID(), operationId: input.operationId, status: 'requested', action: input.action, reason: input.reason.trim(), ...(input.action === 'TEMPBAN' ? { expiryStatus: 'pending', banMarker: `veyro-case-${input.operationId}` } : {}) };
  const isBanDecision = input.action === 'BAN' || input.action === 'TEMPBAN' || input.action === 'UNBAN';
  const saveBan = async (tx: { moderationCase: { create(args: { data: Record<string, unknown> }): Promise<ModerationCase> }; guildTargetDecision: { upsert(args: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }): Promise<{ generation: number }> } }) => {
    const where = { guildId_targetId: { guildId: input.guildId, targetId: input.targetId } };
    const decision = await tx.guildTargetDecision.upsert({ where, create: { guildId: input.guildId, targetId: input.targetId, generation: 1, latestOperationId: input.operationId }, update: { generation: { increment: 1 }, latestOperationId: input.operationId } });
    return tx.moderationCase.create({ data: { ...data, banGeneration: decision.generation } });
  };
  let record: ModerationCase;
  try { record = isBanDecision && store.$transaction ? await store.$transaction(saveBan) : isBanDecision && store.guildTargetDecision ? await saveBan({ moderationCase: store.moderationCase, guildTargetDecision: store.guildTargetDecision }) : await store.moderationCase.create({ data }); }
  catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      const committed = await original();
      if (committed) return committed;
    }
    throw error;
  }
  // PostgreSQL is the durable outbox. Only the bot dispatcher publishes jobs,
  // applying per-guild fairness before work reaches BullMQ.
  return record;
}
