import { DiscordAPIError, PermissionFlagsBits, Routes, type Guild, type GuildMember } from 'discord.js';
import type { ModerationCase } from '@veyrobot/db';
import { hasPermissionBits } from '@veyrobot/contracts';
import { ACTIONS, canActOnTarget, ModerationRuleError, type ModerationAction } from './service.js';

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
  return isGuildOwner || hasPermissionBits(permissions, requiredPermission[action]);
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

type ExecutionStore = LockStore & {
  moderationCase: {
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
    findMany?(args: { where: Record<string, unknown>; select: Record<string, boolean> }): Promise<unknown[]>;
  };
  guildTargetDecision?: {
    findUnique(args: { where: { guildId_targetId: { guildId: string; targetId: string } } }): Promise<{ generation: number; appliedGeneration?: number } | null>;
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  };
  $transaction?: (fn: (tx: ExecutionStore) => Promise<void>) => Promise<void>;
};

export async function executeModerationAction(input: {
  operationId: string; guild: Guild; caseRecord: ModerationCase;
  store: ExecutionStore;
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
    mutationMayHaveStarted = true;
  };
  let finalStatus: string | null = null;
  let finalResult = '';
  let finalExpiryData: Record<string, unknown> = {};
  let mutationMayHaveStarted = false;
  try {
    const action = caseRecord.action as ModerationAction;
    if (!ACTIONS.includes(action)) throw new ModerationRuleError('Action enregistrée inconnue.');
    const [actor, bot] = await Promise.all([guild.members.fetch({ user: caseRecord.actorId, force: true, cache: false }), guild.members.fetchMe()]);
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
      try { await guild.bans.fetch({ user: caseRecord.targetId, force: true, cache: false }); } catch (error) {
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
      try { target = await guild.members.fetch({ user: caseRecord.targetId, force: true, cache: false }); } catch (error) {
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
    const certain = error instanceof ModerationRuleError || (error instanceof DiscordAPIError && error.status >= 400 && error.status < 500) || !mutationMayHaveStarted;
    const status = certain ? 'failed' : 'uncertain';
    const message = error instanceof Error ? error.message : 'Résultat Discord indéterminé.';
    finalStatus = status; finalResult = message.slice(0, 500);
    finalExpiryData = caseRecord.action === 'TEMPBAN' ? { expiryStatus: 'failed', expiryResult: 'Le bannissement initial n’a pas été confirmé; aucun débannissement ne sera planifié.' } : {};
  } finally {
    clearInterval(interval);
    await heartbeat;
  }
  if (!finalStatus || leaseLost) return;
  const where = { id: caseRecord.id, status: 'running', claimToken, claimLeaseUntil: { gt: new Date() } };
  const data = { status: finalStatus, completedAt: new Date(), result: finalResult, ...finalExpiryData };
  const banAction = caseRecord.action === 'BAN' || caseRecord.action === 'TEMPBAN' || caseRecord.action === 'UNBAN';
  if (banAction && finalStatus === 'succeeded' && caseRecord.banGeneration != null && store.$transaction && store.guildTargetDecision) {
    await store.$transaction(async tx => {
      const completed = await tx.moderationCase.updateMany({ where, data });
      if (completed.count !== 1) throw new Error('Moderation claim expired before durable completion.');
      const applied = await tx.guildTargetDecision!.updateMany({
        where: { guildId: caseRecord.guildId, targetId: caseRecord.targetId, generation: caseRecord.banGeneration },
        data: { appliedGeneration: caseRecord.banGeneration, appliedOperationId: caseRecord.operationId },
      });
      if (applied.count !== 1) throw new Error('Ban decision generation changed before durable completion.');
    });
  } else await store.moderationCase.updateMany({ where, data });
}

function actionFor(record: ModerationCase): ModerationAction { return record.action as ModerationAction; }

export async function expireTemporaryBan(input: {
  guild: Guild; caseRecord: ModerationCase;
  store: ExecutionStore;
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
    try { ban = await guild.bans.fetch({ user: caseRecord.targetId, force: true, cache: false }); } catch (error) {
      if (error instanceof DiscordAPIError && error.status === 404) {
        throw new ExpiryTerminal('superseded', 'Le ban a déjà été retiré manuellement; aucune requête de débannissement n’a été envoyée.');
      }
      throw error;
    }
    const decision = await store.guildTargetDecision?.findUnique({ where: { guildId_targetId: { guildId: caseRecord.guildId, targetId: caseRecord.targetId } } });
    if (decision && (decision.appliedGeneration ?? decision.generation) > (caseRecord.banGeneration ?? 0)) {
      throw new ExpiryTerminal('superseded', 'Une décision de ban/déban plus récente a été enregistrée dans l’application; cette échéance est annulée.');
    }
    if (decision && decision.generation > (caseRecord.banGeneration ?? 0)) {
      const later = await store.moderationCase.findMany?.({
        where: { guildId: caseRecord.guildId, targetId: caseRecord.targetId, banGeneration: { gt: caseRecord.banGeneration ?? 0 }, action: { in: ['BAN', 'TEMPBAN', 'UNBAN'] } },
        select: { status: true },
      }) as Array<{ status: string }> | undefined;
      if (later?.some(row => row.status === 'uncertain')) throw new ExpiryTerminal('uncertain', 'Une décision plus récente a un résultat incertain; cette échéance requiert une réconciliation humaine.');
      if (later?.some(row => row.status === 'requested' || row.status === 'running')) {
        await store.moderationCase.updateMany({
          where: { id: caseRecord.id, expiryStatus: 'running', expiryClaimToken, expiryLeaseUntil: { gt: new Date() } },
          data: { expiryStatus: 'scheduled', expiryClaimToken: null, expiryLeaseUntil: null, expiryResult: 'Une décision plus récente est en cours; échéance réévaluée après sa conclusion.' },
        });
        return;
      }
    }
    if (!ban.reason?.includes(`[${caseRecord.banMarker}]`)) {
      throw new ExpiryTerminal('uncertain', 'La raison du ban Discord ne correspond plus au marqueur initial. Aucun débannissement automatique n’a été effectué.');
    }
    await renew();
    if (leaseLost) throw new ExpiryTerminal('uncertain', 'Le bail a expiré avant la requête de débannissement; vérifier manuellement.');
    const edge = await store.moderationCase.updateMany({ where: { id: caseRecord.id, expiryStatus: 'running', expiryClaimToken, expiryLeaseUntil: { gt: new Date() } }, data: { expiryResult: 'discord_request_inflight' } });
    if (edge.count !== 1) { leaseLost = true; throw new ExpiryTerminal('uncertain', 'Le bail d’expiration n’appartient plus à cet exécuteur.'); }
    const latestDecision = await store.guildTargetDecision?.findUnique({ where: { guildId_targetId: { guildId: caseRecord.guildId, targetId: caseRecord.targetId } } });
    if (latestDecision && (latestDecision.appliedGeneration ?? latestDecision.generation) > (caseRecord.banGeneration ?? 0)) throw new ExpiryTerminal('superseded', 'Une décision plus récente a été appliquée avant l’appel de débannissement; aucun appel n’a été envoyé.');
    if (latestDecision && latestDecision.generation > (caseRecord.banGeneration ?? 0)) {
      const latest = await store.moderationCase.findMany?.({
        where: { guildId: caseRecord.guildId, targetId: caseRecord.targetId, banGeneration: { gt: caseRecord.banGeneration ?? 0 }, action: { in: ['BAN', 'TEMPBAN', 'UNBAN'] } },
        select: { status: true },
      }) as Array<{ status: string }> | undefined;
      if (latest?.some(row => row.status === 'uncertain')) throw new ExpiryTerminal('uncertain', 'Une nouvelle décision a un résultat incertain pendant la fenêtre de déban; examen humain requis.');
      if (latest?.some(row => row.status === 'requested' || row.status === 'running')) {
        await store.moderationCase.updateMany({
          where: { id: caseRecord.id, expiryStatus: 'running', expiryClaimToken, expiryLeaseUntil: { gt: new Date() } },
          data: { expiryStatus: 'scheduled', expiryClaimToken: null, expiryLeaseUntil: null, expiryResult: 'Une décision plus récente est arrivée avant le déban; échéance réévaluée après sa conclusion.' },
        });
        return;
      }
      if (latest?.some(row => row.status === 'succeeded')) throw new ExpiryTerminal('uncertain', 'Une nouvelle décision réussie ne correspond pas à la génération appliquée; réconciliation humaine requise.');
    }
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
