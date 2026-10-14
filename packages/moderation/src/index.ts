import { DiscordAPIError, PermissionFlagsBits, Routes, type Guild, type GuildMember } from 'discord.js';
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
    ...(producer ? { enableOfflineQueue: false, connectTimeout: 3_000, retryStrategy: (attempt: number) => attempt > 2 ? null : attempt * 250 } : {}),
  };
}

const requiredPermission: Record<ModerationAction, bigint> = {
  TIMEOUT: PermissionFlagsBits.ModerateMembers,
  UNTIMEOUT: PermissionFlagsBits.ModerateMembers,
  KICK: PermissionFlagsBits.KickMembers,
  BAN: PermissionFlagsBits.BanMembers,
  UNBAN: PermissionFlagsBits.BanMembers,
  TEMPBAN: PermissionFlagsBits.BanMembers,
  PURGE_MESSAGES: PermissionFlagsBits.ManageMessages,
  SLOWMODE: PermissionFlagsBits.ManageChannels,
  LOCK_CHANNEL: PermissionFlagsBits.ManageRoles,
  UNLOCK_CHANNEL: PermissionFlagsBits.ManageRoles,
};
export function hasModerationPermission(action: ModerationAction, permissions: bigint, isGuildOwner = false): boolean {
  return isGuildOwner || (permissions & requiredPermission[action]) === requiredPermission[action];
}

export function canActOnTarget(input: { actorIsOwner: boolean; actorAboveTarget: boolean; botAboveTarget: boolean; targetIsOwner: boolean }): boolean {
  return !input.targetIsOwner && (input.actorIsOwner || input.actorAboveTarget) && input.botAboveTarget;
}

export class ModerationRuleError extends Error {}

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
  if (store.guildConfig && !moduleEnabled(await store.guildConfig.findUnique({ where: { guildId: input.guildId } }), moduleForAction(input.action))) throw new ModerationRuleError('Ce module est désactivé sur ce serveur.');
  if (!/^[\w-]{16,80}$/.test(input.operationId)) throw new ModerationRuleError('Identifiant d’opération invalide.');
  const prior = await store.moderationCase.findUnique({ where: { operationId: input.operationId } });
  if (prior) {
    if (prior.guildId !== input.guildId || prior.actorId !== input.actorId || prior.targetId !== input.targetId || prior.action !== input.action || prior.reason !== input.reason.trim() || prior.durationMinutes !== (input.durationMinutes ?? null)) throw new ModerationRuleError('Identifiant déjà utilisé pour une autre opération.');
    return prior;
  }
  const channelAction = ['PURGE_MESSAGES', 'SLOWMODE', 'LOCK_CHANNEL', 'UNLOCK_CHANNEL'].includes(input.action);
  const data: Record<string, unknown> = { ...input, ...(channelAction ? { channelId: input.channelId ?? input.targetId, targetId: input.channelId ?? input.targetId } : {}), id: crypto.randomUUID(), operationId: input.operationId, status: 'requested', action: input.action, reason: input.reason.trim(), ...(input.action === 'TEMPBAN' ? { expiryStatus: 'pending', banMarker: `veyro-case-${input.operationId}` } : {}) };
  const isBanDecision = input.action === 'BAN' || input.action === 'TEMPBAN' || input.action === 'UNBAN';
  const record = isBanDecision && store.$transaction ? await store.$transaction(async tx => {
    const where = { guildId_targetId: { guildId: input.guildId, targetId: input.targetId } };
    const decision = await tx.guildTargetDecision.upsert({ where, create: { guildId: input.guildId, targetId: input.targetId, generation: 1, latestOperationId: input.operationId }, update: { generation: { increment: 1 }, latestOperationId: input.operationId } });
    return tx.moderationCase.create({ data: { ...data, banGeneration: decision.generation } });
  }) : await store.moderationCase.create({ data });
  // PostgreSQL is the durable outbox. Only the bot dispatcher publishes jobs,
  // applying per-guild fairness before work reaches BullMQ.
  return record;
}

function assertRoleAbove(actor: GuildMember, bot: GuildMember, target: GuildMember, guild: Guild): void {
  const actorIsOwner = actor.id === guild.ownerId;
  const actorAboveTarget = actor.roles.highest.comparePositionTo(target.roles.highest) > 0;
  const botAboveTarget = bot.roles.highest.comparePositionTo(target.roles.highest) > 0;
  const allowed = canActOnTarget({ actorIsOwner, actorAboveTarget, botAboveTarget, targetIsOwner: target.id === guild.ownerId });
  if (!allowed) throw new ModerationRuleError(target.id === guild.ownerId ? 'Le propriétaire du serveur ne peut pas être ciblé.' : !actorIsOwner && !actorAboveTarget ? 'Votre rôle doit être supérieur à celui de la cible.' : 'Le rôle du bot doit être supérieur à celui de la cible.');
}

const isChannelAction = (action: ModerationAction) => action === 'PURGE_MESSAGES' || action === 'SLOWMODE' || action === 'LOCK_CHANNEL' || action === 'UNLOCK_CHANNEL';
const channelPermissions: Partial<Record<ModerationAction, bigint>> = {
  PURGE_MESSAGES: PermissionFlagsBits.ManageMessages | PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory,
  SLOWMODE: PermissionFlagsBits.ManageChannels,
  LOCK_CHANNEL: PermissionFlagsBits.ManageRoles,
  UNLOCK_CHANNEL: PermissionFlagsBits.ManageRoles,
};
type LockStore = { channelLockState?: {
  findUnique(args: { where: { guildId_channelId: { guildId: string; channelId: string } } }): Promise<{ active: boolean; originalSendMessages: string } | null>;
  upsert(args: { where: { guildId_channelId: { guildId: string; channelId: string } }; create: { guildId: string; channelId: string; originalSendMessages: string; active: boolean; lockOperationId: string }; update: { originalSendMessages: string; active: boolean; lockOperationId: string; lockedAt: Date; unlockedAt: null } }): Promise<unknown>;
  update(args: { where: { guildId_channelId: { guildId: string; channelId: string } }; data: { active: boolean; unlockedAt: Date } }): Promise<unknown>;
} };

async function executeChannelAction(input: { action: ModerationAction; guild: Guild; actor: GuildMember; bot: GuildMember; caseRecord: ModerationCase; store: LockStore; beforeDiscordMutation: () => Promise<void> }): Promise<string> {
  const { action, guild, actor, bot, caseRecord, store, beforeDiscordMutation } = input;
  const channelId = caseRecord.channelId ?? caseRecord.targetId;
  const channel = await guild.channels.fetch(channelId, { force: true });
  if (!channel || !channel.isTextBased() || !('messages' in channel)) throw new ModerationRuleError('Le salon est absent ou ne prend pas en charge les messages.');
  const required = channelPermissions[action]!;
  if (!channel.permissionsFor(actor)?.has(required)) throw new ModerationRuleError('Vos permissions dans ce salon ne permettent pas cette action.');
  if (!channel.permissionsFor(bot)?.has(required)) throw new ModerationRuleError('Le bot ne possède pas les permissions nécessaires dans ce salon.');
  const reason = `${caseRecord.reason.slice(0, 450)} [acteur ${caseRecord.actorId}; dossier ${caseRecord.id}]`;
  if (action === 'PURGE_MESSAGES') {
    const messages = await channel.messages.fetch({ limit: caseRecord.requestedCount ?? 1, cache: false });
    const candidates = [...messages.values()].filter(message => !caseRecord.filterAuthorId || message.author.id === caseRecord.filterAuthorId);
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1_000;
    const eligible = candidates.filter(message => message.createdTimestamp > cutoff);
    const tooOld = candidates.length - eligible.length;
    let accepted = 0;
    if (eligible.length === 1) { await beforeDiscordMutation(); await guild.client.rest.delete(Routes.channelMessage(channelId, eligible[0]!.id), { reason }); accepted = 1; }
    else if (eligible.length > 1) { await beforeDiscordMutation(); await guild.client.rest.post(Routes.channelBulkDelete(channelId), { body: { messages: eligible.map(message => message.id) }, reason }); accepted = eligible.length; }
    return `Discord a confirmé la requête de suppression pour ${accepted} identifiant(s) sur ${candidates.length} correspondant(s); ${tooOld} ancien(s) ignoré(s). Discord ne renvoie pas de compte individuel pour chaque identifiant supprimé.`;
  }
  if (action === 'SLOWMODE') {
    if (!('setRateLimitPerUser' in channel) || typeof channel.setRateLimitPerUser !== 'function') throw new ModerationRuleError('Le type de salon ne prend pas en charge le slowmode.');
    await beforeDiscordMutation();
    await channel.setRateLimitPerUser(caseRecord.rateLimitSeconds ?? 0, reason);
    return `Slowmode appliqué: ${caseRecord.rateLimitSeconds ?? 0} seconde(s) par message.`;
  }
  if (!('permissionOverwrites' in channel)) throw new ModerationRuleError('Les permissions de ce type de salon ne peuvent pas être verrouillées par le bot.');
  if (!store.channelLockState) throw new Error('Le stockage de l’état du verrouillage n’est pas disponible.');
  const key = { guildId_channelId: { guildId: caseRecord.guildId, channelId } };
  const prior = await store.channelLockState.findUnique({ where: key });
  const overwrite = channel.permissionOverwrites.cache.get(guild.roles.everyone.id);
  const current = overwrite?.allow.has(PermissionFlagsBits.SendMessages) ? 'allow' : overwrite?.deny.has(PermissionFlagsBits.SendMessages) ? 'deny' : 'inherit';
  if (action === 'LOCK_CHANNEL') {
    if (!prior?.active) await store.channelLockState.upsert({ where: key, create: { guildId: caseRecord.guildId, channelId, originalSendMessages: current, active: true, lockOperationId: caseRecord.id }, update: { originalSendMessages: current, active: true, lockOperationId: caseRecord.id, lockedAt: new Date(), unlockedAt: null } });
    await beforeDiscordMutation();
    await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }, { reason });
    return 'Salon verrouillé. L’état antérieur de @everyone est conservé pour une restauration contrôlée.';
  }
  if (!prior?.active) throw new ModerationRuleError('Aucun verrouillage géré par le bot n’est enregistré pour ce salon.');
  if (current !== 'deny') {
    await store.channelLockState.update({ where: key, data: { active: false, unlockedAt: new Date() } });
    return 'Une modification externe a changé la permission SendMessages; aucune restauration n’a été appliquée.';
  }
  const restore = prior.originalSendMessages === 'allow' ? true : prior.originalSendMessages === 'deny' ? false : null;
  await beforeDiscordMutation();
  await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: restore }, { reason });
  await store.channelLockState.update({ where: key, data: { active: false, unlockedAt: new Date() } });
  return 'Permission SendMessages restaurée à sa valeur antérieure; les autres permissions du salon n’ont pas été touchées.';
}

export async function executeModerationAction(input: {
  operationId: string; guild: Guild; caseRecord: ModerationCase;
  store: { moderationCase: { updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }> }; guildTargetDecision?: { findUnique(args: { where: { guildId_targetId: { guildId: string; targetId: string } } }): Promise<{ generation: number } | null> } } & LockStore;
}): Promise<void> {
  const { caseRecord, guild, store } = input;
  const claimToken = crypto.randomUUID();
  const leaseUntil = () => new Date(Date.now() + 120_000);
  const claimed = await store.moderationCase.updateMany({ where: { id: caseRecord.id, status: 'requested' }, data: { status: 'running', startedAt: new Date(), claimToken, claimLeaseUntil: leaseUntil(), executionPhase: 'preparing' } });
  if (claimed.count !== 1) return;
  let leaseLost = false;
  let heartbeat: Promise<void> | undefined;
  const renew = async () => {
    const result = await store.moderationCase.updateMany({ where: { id: caseRecord.id, status: 'running', claimToken, claimLeaseUntil: { gt: new Date() } }, data: { claimLeaseUntil: leaseUntil() } });
    if (result.count !== 1) leaseLost = true;
  };
  const interval = setInterval(() => {
    if (!heartbeat && !leaseLost) heartbeat = renew().catch(() => { leaseLost = true; }).finally(() => { heartbeat = undefined; });
  }, 20_000);
  const beforeDiscordMutation = async () => {
    await renew();
    if (leaseLost) throw new ModerationRuleError('Le bail d’exécution a été perdu avant l’appel Discord.');
    const edge = await store.moderationCase.updateMany({ where: { id: caseRecord.id, status: 'running', claimToken, claimLeaseUntil: { gt: new Date() } }, data: { executionPhase: 'discord_request_inflight' } });
    if (edge.count !== 1) { leaseLost = true; throw new ModerationRuleError('Le bail d’exécution n’appartient plus à ce worker.'); }
  };
  let finalStatus: string | null = null;
  let finalResult = '';
  let finalExpiryData: Record<string, unknown> = {};
  try {
    const action = caseRecord.action as ModerationAction;
    if (!ACTIONS.includes(action)) throw new ModerationRuleError('Action enregistrée inconnue.');
    const [actor, bot] = await Promise.all([guild.members.fetch({ user: caseRecord.actorId, force: true }), guild.members.fetchMe()]);
    if (!isChannelAction(action) && !hasModerationPermission(action, actor.permissions.bitfield, actor.id === guild.ownerId)) throw new ModerationRuleError('Votre permission Discord a été retirée ou ne permet pas cette action.');
    if (!isChannelAction(action) && !hasModerationPermission(action, bot.permissions.bitfield)) throw new ModerationRuleError('Le bot ne possède pas la permission Discord requise.');
    const assertCurrentDecision = async () => {
      if (isChannelAction(action) || (action !== 'BAN' && action !== 'TEMPBAN' && action !== 'UNBAN')) return;
      const decision = await store.guildTargetDecision?.findUnique({ where: { guildId_targetId: { guildId: caseRecord.guildId, targetId: caseRecord.targetId } } });
      if (decision && caseRecord.banGeneration !== decision.generation) throw new ModerationRuleError('Cette décision a été remplacée par une décision de ban/déban plus récente.');
    };
    await assertCurrentDecision();
    const auditSuffix = actionFor(caseRecord) === 'TEMPBAN' ? ` [${caseRecord.banMarker}]` : ` [acteur ${caseRecord.actorId}; dossier ${caseRecord.id}]`;
    const reason = `${caseRecord.reason.slice(0, 512 - auditSuffix.length)}${auditSuffix}`;
    if (leaseLost) throw new ModerationRuleError('Le bail d’exécution a été perdu avant l’appel Discord.');
    if (isChannelAction(action)) {
      finalResult = await executeChannelAction({ action, guild, actor, bot, caseRecord, store, beforeDiscordMutation });
    } else if (action === 'UNBAN') {
      try { await guild.bans.fetch(caseRecord.targetId); } catch (error) {
        if (error instanceof DiscordAPIError && error.status === 404) finalResult = 'Aucun ban n’existe dans Discord; l’état demandé est déjà atteint.';
        else throw error;
      }
      if (!finalResult) {
        await assertCurrentDecision();
        await beforeDiscordMutation();
        await guild.members.unban(caseRecord.targetId, reason);
      }
    } else {
      let target: GuildMember | null = null;
      try { target = await guild.members.fetch({ user: caseRecord.targetId, force: true }); } catch (error) {
        if (action !== 'BAN' || !(error instanceof DiscordAPIError) || error.status !== 404) throw error;
        try { await guild.bans.fetch({ user: caseRecord.targetId, force: true, cache: false }); }
        catch (banError) {
          if (!(banError instanceof DiscordAPIError) || banError.status !== 404) throw banError;
          await assertCurrentDecision();
          await beforeDiscordMutation();
          await guild.bans.create(caseRecord.targetId, { reason, deleteMessageSeconds: 0 });
          finalResult = 'Ban permanent confirmé pour un utilisateur qui n’est plus membre du serveur.';
        }
        if (!finalResult) finalResult = 'Ban déjà présent dans Discord; la nouvelle décision permanente remplace l’échéance antérieure.';
      }
      if (target) {
        if (target.id === actor.id) throw new ModerationRuleError('Vous ne pouvez pas vous cibler vous-même.');
        assertRoleAbove(actor, bot, target, guild);
        await assertCurrentDecision();
        await beforeDiscordMutation();
        if (action === 'TIMEOUT') await target.timeout(caseRecord.durationMinutes! * 60_000, reason);
        else if (action === 'UNTIMEOUT') await target.timeout(null, reason);
        else if (action === 'KICK') await target.kick(reason);
        else await target.ban({ reason, deleteMessageSeconds: 0 });
      }
    }
    const completedAt = new Date();
    finalStatus = 'succeeded'; finalResult ||= 'Action confirmée par Discord.';
    finalExpiryData = action === 'TEMPBAN' ? { expiresAt: new Date(completedAt.getTime() + caseRecord.durationMinutes! * 60_000), expiryStatus: 'scheduled' } : {};
  } catch (error) {
    const certain = error instanceof ModerationRuleError || (error instanceof DiscordAPIError && error.status >= 400 && error.status < 500);
    const status = certain ? 'failed' : 'uncertain';
    const message = error instanceof Error ? error.message : 'Résultat Discord indéterminé.';
    finalStatus = status; finalResult = message.slice(0, 500);
    finalExpiryData = caseRecord.action === 'TEMPBAN' ? { expiryStatus: 'failed', expiryResult: 'Le bannissement initial n’a pas été confirmé; aucun débannissement ne sera planifié.' } : {};
  } finally {
    clearInterval(interval);
    await heartbeat;
  }
  if (!finalStatus || leaseLost) return;
  await store.moderationCase.updateMany({ where: { id: caseRecord.id, status: 'running', claimToken, claimLeaseUntil: { gt: new Date() } }, data: { status: finalStatus, completedAt: new Date(), result: finalResult, ...finalExpiryData } });
}

function actionFor(record: ModerationCase): ModerationAction { return record.action as ModerationAction; }

export async function expireTemporaryBan(input: {
  guild: Guild; caseRecord: ModerationCase;
  store: { moderationCase: { updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }> }; guildTargetDecision?: { findUnique(args: { where: { guildId_targetId: { guildId: string; targetId: string } } }): Promise<{ generation: number } | null> } };
}): Promise<void> {
  const { guild, caseRecord, store } = input;
  if (caseRecord.action !== 'TEMPBAN' || !caseRecord.expiresAt || caseRecord.expiresAt > new Date() || !caseRecord.banMarker) return;
  const expiryClaimToken = crypto.randomUUID();
  const leaseUntil = () => new Date(Date.now() + 120_000);
  const claim = await store.moderationCase.updateMany({ where: { id: caseRecord.id, status: 'succeeded', expiryStatus: 'scheduled', expiresAt: { lte: new Date() } }, data: { expiryStatus: 'running', expiryStartedAt: new Date(), expiryClaimToken, expiryLeaseUntil: leaseUntil() } });
  if (claim.count !== 1) return;
  let leaseLost = false;
  let heartbeat: Promise<void> | undefined;
  const renew = async () => {
    const result = await store.moderationCase.updateMany({ where: { id: caseRecord.id, expiryStatus: 'running', expiryClaimToken, expiryLeaseUntil: { gt: new Date() } }, data: { expiryLeaseUntil: leaseUntil() } });
    if (result.count !== 1) leaseLost = true;
  };
  const interval = setInterval(() => {
    if (!heartbeat && !leaseLost) heartbeat = renew().catch(() => { leaseLost = true; }).finally(() => { heartbeat = undefined; });
  }, 20_000);
  let finalExpiryStatus: string | null = null;
  let finalExpiryResult = '';
  let unbannedAt: Date | undefined;
  class ExpiryTerminal extends Error { constructor(readonly status: string, message: string) { super(message); } }
  try {
    const me = await guild.members.fetchMe();
    if (!me.permissions.has(PermissionFlagsBits.BanMembers)) throw new ModerationRuleError('Le bot ne possède plus la permission Bannir des membres.');
    let ban;
    try { ban = await guild.bans.fetch(caseRecord.targetId); } catch (error) {
      if (error instanceof DiscordAPIError && error.status === 404) {
        throw new ExpiryTerminal('superseded', 'Le ban a déjà été retiré manuellement; aucune requête de débannissement n’a été envoyée.');
      }
      throw error;
    }
    const decision = await store.guildTargetDecision?.findUnique({ where: { guildId_targetId: { guildId: caseRecord.guildId, targetId: caseRecord.targetId } } });
    if (decision && caseRecord.banGeneration !== decision.generation) {
      throw new ExpiryTerminal('superseded', 'Une décision de ban/déban plus récente a été enregistrée dans l’application; cette échéance est annulée.');
    }
    if (!ban.reason?.includes(`[${caseRecord.banMarker}]`)) {
      throw new ExpiryTerminal('uncertain', 'La raison du ban Discord ne correspond plus au marqueur initial. Aucun débannissement automatique n’a été effectué.');
    }
    await renew();
    if (leaseLost) throw new ExpiryTerminal('uncertain', 'Le bail a expiré avant la requête de débannissement; vérifier manuellement.');
    const edge = await store.moderationCase.updateMany({ where: { id: caseRecord.id, expiryStatus: 'running', expiryClaimToken, expiryLeaseUntil: { gt: new Date() } }, data: { expiryResult: 'discord_request_inflight' } });
    if (edge.count !== 1) { leaseLost = true; throw new ExpiryTerminal('uncertain', 'Le bail d’expiration n’appartient plus à cet exécuteur.'); }
    const latestDecision = await store.guildTargetDecision?.findUnique({ where: { guildId_targetId: { guildId: caseRecord.guildId, targetId: caseRecord.targetId } } });
    if (latestDecision && caseRecord.banGeneration !== latestDecision.generation) throw new ExpiryTerminal('superseded', 'Une décision plus récente a été enregistrée avant l’appel de débannissement; aucun appel n’a été envoyé.');
    // Discord ne fournit pas de comparaison-et-suppression conditionnelle du motif du ban.
    await guild.members.unban(caseRecord.targetId, `Expiration automatique du dossier ${caseRecord.id}`);
    finalExpiryStatus = 'succeeded'; unbannedAt = new Date(); finalExpiryResult = 'Débannissement confirmé par Discord.';
  } catch (error) {
    if (error instanceof ExpiryTerminal) { finalExpiryStatus = error.status; finalExpiryResult = error.message; }
    else {
    const certain = error instanceof ModerationRuleError || (error instanceof DiscordAPIError && error.status >= 400 && error.status < 500);
    finalExpiryStatus = certain ? 'failed' : 'uncertain'; finalExpiryResult = (error instanceof Error ? error.message : 'Résultat Discord indéterminé.').slice(0, 500);
    }
  } finally {
    clearInterval(interval);
    await heartbeat;
  }
  if (finalExpiryStatus && !leaseLost) await store.moderationCase.updateMany({ where: { id: caseRecord.id, expiryStatus: 'running', expiryClaimToken, expiryLeaseUntil: { gt: new Date() } }, data: { expiryStatus: finalExpiryStatus, ...(unbannedAt ? { unbannedAt } : {}), expiryResult: finalExpiryResult } });
}

export async function markInterruptedOperationsUncertain(store: { moderationCase: { updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown> } }, now = new Date()): Promise<void> {
  await store.moderationCase.updateMany({ where: { status: 'running', claimLeaseUntil: { lt: now }, executionPhase: 'preparing' }, data: { status: 'failed', completedAt: now, result: 'Le bail a expiré avant tout appel Discord. Aucune sanction n’a été envoyée; une nouvelle demande explicite est possible.' } });
  await store.moderationCase.updateMany({ where: { status: 'running', claimLeaseUntil: { lt: now }, executionPhase: 'discord_request_inflight' }, data: { status: 'uncertain', completedAt: now, result: 'Le processus s’est arrêté pendant l’appel Discord. Vérifiez l’état Discord; aucune nouvelle tentative automatique ne sera lancée.' } });
  await store.moderationCase.updateMany({ where: { action: 'TEMPBAN', expiryStatus: 'running', expiryLeaseUntil: { lt: now }, expiryResult: 'discord_request_inflight' }, data: { expiryStatus: 'uncertain', expiryResult: 'Le processus s’est arrêté pendant le débannissement. Vérifiez le ban Discord; aucune nouvelle tentative automatique ne sera lancée.' } });
  await store.moderationCase.updateMany({ where: { action: 'TEMPBAN', expiryStatus: 'running', expiryLeaseUntil: { lt: now }, NOT: { expiryResult: 'discord_request_inflight' } }, data: { expiryStatus: 'scheduled', expiryClaimToken: null, expiryLeaseUntil: null, expiryResult: 'Reprise après interruption avant appel Discord.' } });
}
