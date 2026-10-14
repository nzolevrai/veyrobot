import { ChannelType, Client, DiscordAPIError, EmbedBuilder, Events, GatewayIntentBits, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { Queue, Worker } from 'bullmq';
import type { ModerationAction } from '@veyrobot/moderation';
import { z } from 'zod';

const lastErrorLogAt = new Map<string, number>();
function logThrottled(key: string, message: string, error: unknown): void {
  const now = Date.now();
  if (now - (lastErrorLogAt.get(key) ?? 0) < 60_000) return;
  lastErrorLogAt.set(key, now);
  if (lastErrorLogAt.size > 32) lastErrorLogAt.delete(lastErrorLogAt.keys().next().value!);
  console.error(message, error instanceof Error ? error.name : 'unknown error');
}

const envSchema = z.object({ DISCORD_BOT_TOKEN: z.string().min(1), DISCORD_CLIENT_ID: z.string().min(1), DATABASE_URL: z.string().min(1), REDIS_URL: z.string().url().default('redis://localhost:6379') });
const envResult = envSchema.safeParse(process.env);
if (!envResult.success) {
  const fields = [...new Set(envResult.error.issues.map(issue => issue.path.join('.')))];
  console.error(`Configuration bot invalide. Variables manquantes ou invalides : ${fields.join(', ')}`);
  process.exit(1);
}
const env = envResult.data;
const [{ createWarningCase, rejectPendingAfterDisable, prisma }, moderation] = await Promise.all([import('@veyrobot/db'), import('@veyrobot/moderation')]);
const { executeModerationAction, expireTemporaryBan, markInterruptedOperationsUncertain, redisConnection, submitModerationAction } = moderation;
// Uncertain network/5xx responses must reach our durable state machine; avoid
// the REST layer automatically repeating non-idempotent moderation requests.
const client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { retries: 0, timeout: 15_000 } });
const connection = redisConnection(env.REDIS_URL);
const queue = new Queue('veyrobot-moderation', { connection });
const activeGuilds = new Set<string>();
let wakeRequestDispatcher: (() => Promise<void>) | undefined;
const worker = new Worker('veyrobot-moderation', async job => {
  if (!client.isReady()) return; // PostgreSQL keeps the request pending for the next Ready/reconciliation.
  const guildId = String((job.data as { guildId: string }).guildId);
  // A busy guild cannot occupy every worker slot. Skipped jobs remain requested
  // in PostgreSQL and are republished by the reconciler after this guild drains.
  if (activeGuilds.has(guildId)) return;
  activeGuilds.add(guildId);
  try {
  if (job.name === 'temporary-ban-expiry') {
    const { caseId, guildId } = job.data as { caseId: string; guildId: string };
    const row = await prisma.moderationCase.findUnique({ where: { id: caseId } });
    if (!row || row.guildId !== guildId) return;
    let guild = client.guilds.cache.get(guildId);
    if (!guild) {
      try { guild = await client.guilds.fetch(guildId); } catch (error) {
        if (!(error instanceof DiscordAPIError) || (error.status !== 403 && error.status !== 404)) throw error;
        await prisma.moderationCase.updateMany({ where: { id: row.id, expiryStatus: 'scheduled' }, data: { expiryStatus: 'failed', expiryResult: 'Le bot ne peut pas accéder à ce serveur. Rétablissez son accès avant de créer une nouvelle demande.' } });
        return;
      }
    }
    if (!guild) {
      await prisma.moderationCase.update({ where: { id: row.id }, data: { expiryStatus: 'failed', expiryResult: 'Le bot ne peut plus accéder à ce serveur. Réactivez la planification après avoir restauré son accès.' } });
      return;
    }
    await expireTemporaryBan({ guild, caseRecord: row, store: prisma });
    return;
  }
  const { operationId } = job.data as { operationId: string; guildId: string };
  const row = await prisma.moderationCase.findUnique({ where: { operationId } });
  if (!row || row.guildId !== guildId || row.status !== 'requested') return;
  // A request accepted before a switch was disabled remains committed. A request
  // created after disable (for example from an old API process) is rejected here.
  const moduleConfig = await prisma.guildConfig.findUnique({ where: { guildId } });
  if (rejectPendingAfterDisable(moduleConfig, row.action, row.createdAt)) {
    await prisma.moderationCase.updateMany({ where: { id: row.id, status: 'requested' }, data: { status: 'failed', completedAt: new Date(), result: 'Module désactivé avant la demande : aucune action Discord envoyée.' } });
    return;
  }
  let guild = client.guilds.cache.get(guildId);
  if (!guild) {
    try { guild = await client.guilds.fetch(guildId); } catch (error) {
      if (!(error instanceof DiscordAPIError) || (error.status !== 403 && error.status !== 404)) throw error;
      await prisma.moderationCase.updateMany({ where: { id: row.id, status: 'requested' }, data: { status: 'failed', completedAt: new Date(), result: 'Le bot ne peut pas accéder au serveur; aucune action Discord n’a été envoyée.' } });
      return;
    }
  }
  if (!guild) {
    await prisma.moderationCase.update({ where: { id: row.id }, data: { status: 'failed', completedAt: new Date(), result: 'Le bot ne peut pas accéder au serveur; aucune action Discord n’a été envoyée.' } });
    return;
  }
  await executeModerationAction({ operationId, guild, caseRecord: row, store: prisma });
  } finally {
    activeGuilds.delete(guildId);
    if (wakeRequestDispatcher) setTimeout(() => void wakeRequestDispatcher?.(), 0);
  }
}, { connection, concurrency: 4, autorun: true });

const warn = new SlashCommandBuilder().setName('warn').setDescription('Ajoute un avertissement au dossier de modération.')
  .addUserOption(o => o.setName('membre').setDescription('Membre concerné').setRequired(true))
  .addStringOption(o => o.setName('raison').setDescription('Raison de l’avertissement').setMaxLength(500).setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers);
const actionCommands = [
  new SlashCommandBuilder().setName('timeout').setDescription('Restreint temporairement un membre.').addUserOption(o => o.setName('membre').setDescription('Membre concerné').setRequired(true)).addIntegerOption(o => o.setName('minutes').setDescription('Durée (1 à 40320 minutes)').setMinValue(1).setMaxValue(40320).setRequired(true)).addStringOption(o => o.setName('raison').setDescription('Raison').setMaxLength(500).setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName('untimeout').setDescription('Retire le timeout d’un membre.').addUserOption(o => o.setName('membre').setDescription('Membre concerné').setRequired(true)).addStringOption(o => o.setName('raison').setDescription('Raison').setMaxLength(500).setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName('kick').setDescription('Expulse un membre.').addUserOption(o => o.setName('membre').setDescription('Membre concerné').setRequired(true)).addStringOption(o => o.setName('raison').setDescription('Raison').setMaxLength(500).setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
  new SlashCommandBuilder().setName('ban').setDescription('Bannit un membre.').addUserOption(o => o.setName('membre').setDescription('Membre concerné').setRequired(true)).addStringOption(o => o.setName('raison').setDescription('Raison').setMaxLength(500).setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  new SlashCommandBuilder().setName('unban').setDescription('Débannit un utilisateur par son identifiant Discord.').addStringOption(o => o.setName('utilisateur').setDescription('Identifiant utilisateur (snowflake)').setMinLength(17).setMaxLength(20).setRequired(true)).addStringOption(o => o.setName('raison').setDescription('Raison').setMaxLength(500).setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  new SlashCommandBuilder().setName('tempban').setDescription('Bannit un membre pour une durée limitée (maximum 365 jours).').addUserOption(o => o.setName('membre').setDescription('Membre concerné').setRequired(true)).addIntegerOption(o => o.setName('minutes').setDescription('Durée en minutes (maximum 525600)').setMinValue(1).setMaxValue(525600).setRequired(true)).addStringOption(o => o.setName('raison').setDescription('Raison').setMaxLength(500).setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  new SlashCommandBuilder().setName('purge').setDescription('Supprime jusqu’à 100 messages récents dans un salon.').addChannelOption(o => o.setName('salon').setDescription('Salon à nettoyer').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread).setRequired(true)).addIntegerOption(o => o.setName('nombre').setDescription('Nombre de messages récents à examiner (1–100)').setMinValue(1).setMaxValue(100).setRequired(true)).addStringOption(o => o.setName('raison').setDescription('Raison de modération').setMaxLength(500).setRequired(true)).addUserOption(o => o.setName('auteur').setDescription('Ne supprimer que les messages de cette personne')).setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  new SlashCommandBuilder().setName('slowmode').setDescription('Configure ou désactive le slowmode d’un salon.').addChannelOption(o => o.setName('salon').setDescription('Salon texte').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)).addIntegerOption(o => o.setName('secondes').setDescription('0 désactive; maximum 21600 secondes').setMinValue(0).setMaxValue(21600).setRequired(true)).addStringOption(o => o.setName('raison').setDescription('Raison de modération').setMaxLength(500).setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName('lock').setDescription('Verrouille les messages dans un salon et conserve son état précédent.').addChannelOption(o => o.setName('salon').setDescription('Salon texte').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)).addStringOption(o => o.setName('raison').setDescription('Raison de modération').setMaxLength(500).setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
  new SlashCommandBuilder().setName('unlock').setDescription('Restaure SendMessages si la permission est encore détenue par le verrouillage du bot.').addChannelOption(o => o.setName('salon').setDescription('Salon texte').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)).addStringOption(o => o.setName('raison').setDescription('Raison de modération').setMaxLength(500).setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
];
client.once(Events.ClientReady, async ready => {
  console.info(`Connecté comme ${ready.user.tag}`);
  await markInterruptedOperationsUncertain(prisma).catch(error => console.error('Could not reconcile interrupted moderation actions', error));
  const ownedShardIds = client.shard?.ids ?? [0];
  const publishPresence = async () => {
    if (!client.isReady()) return;
    const lastSeenAt = new Date();
    await Promise.all(ownedShardIds.map(shardId => prisma.shardPresence.upsert({ where: { shardId }, create: { shardId, lastSeenAt }, update: { lastSeenAt } })));
  };
  const membershipByShard = new Map<number, string[]>();
  for (const guild of ready.guilds.cache.values()) membershipByShard.set(guild.shardId, [...(membershipByShard.get(guild.shardId) ?? []), guild.id]);
  let membershipsSynced = false;
  const syncGuildMemberships = async () => {
    if (membershipsSynced) return;
    const syncStartedAt = new Date();
    for (const [shardId, guildIds] of membershipByShard) for (let offset = 0; offset < guildIds.length; offset += 500) {
      const batch = guildIds.slice(offset, offset + 500);
      await prisma.guildPresence.updateMany({ where: { guildId: { in: batch } }, data: { shardId, lastSeenAt: syncStartedAt } });
      await prisma.guildPresence.createMany({ data: batch.map(guildId => ({ guildId, shardId, lastSeenAt: syncStartedAt })), skipDuplicates: true });
    }
    await prisma.guildPresence.deleteMany({ where: { shardId: { in: ownedShardIds }, lastSeenAt: { lt: syncStartedAt } } });
    membershipsSynced = true;
  };
  await syncGuildMemberships().catch(error => logThrottled('guild-membership-sync', 'guild membership sync failed; retry scheduled', error));
  let dispatching = false;
  const dispatchRequested = async () => {
    if (dispatching) return;
    dispatching = true;
    try {
      const pending = await prisma.$queryRaw<Array<{ guildId: string; operationId: string; action: string }>>`
        SELECT c."guildId", c."operationId", c."action"
        FROM "ModerationCase" c
        JOIN (
          SELECT chosen."id", chosen."createdAt"
          FROM (
            SELECT DISTINCT ON (candidate."guildId") candidate."id", candidate."guildId", candidate."createdAt"
            FROM "ModerationCase" candidate
            WHERE candidate."status" = 'requested' AND candidate."operationId" IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM "ModerationCase" active WHERE active."guildId" = candidate."guildId" AND active."status" = 'running')
            ORDER BY candidate."guildId", candidate."createdAt", candidate."id"
          ) chosen
          ORDER BY chosen."createdAt"
          LIMIT 100
        ) ready ON ready."id" = c."id"
        ORDER BY ready."createdAt"
      `;
      for (const item of pending) {
        try { await queue.add('moderation-action', { guildId: item.guildId, operationId: item.operationId }, { jobId: item.operationId, attempts: 1, priority: item.action === 'PURGE_MESSAGES' ? 20 : 1, removeOnComplete: true, removeOnFail: true }); }
        catch (error) { logThrottled('moderation-queue-dispatch', 'moderation queue dispatch failed; PostgreSQL request remains durable', error); break; }
      }
      const expired = await prisma.moderationCase.findMany({ where: { action: 'TEMPBAN', status: 'succeeded', expiryStatus: 'scheduled', expiresAt: { lte: new Date() } }, orderBy: { expiresAt: 'asc' }, take: 100, select: { id: true, guildId: true } });
      for (const item of expired) {
        try { await queue.add('temporary-ban-expiry', { caseId: item.id, guildId: item.guildId }, { jobId: `tempban-${item.id}`, attempts: 3, priority: 10, removeOnComplete: true, removeOnFail: true }); }
        catch (error) { logThrottled('temporary-ban-dispatch', 'temporary ban expiry dispatch failed; PostgreSQL schedule remains durable', error); break; }
      }
    } catch (error) { logThrottled('moderation-request-reconcile', 'moderation request reconciliation failed', error); }
    finally { dispatching = false; }
  };
  wakeRequestDispatcher = dispatchRequested;
  await publishPresence().catch(err => logThrottled('presence-heartbeat', 'initial presence sync failed', err));
  const timer = setInterval(() => void publishPresence().catch(err => logThrottled('presence-heartbeat', 'presence heartbeat failed', err)), 30_000);
  const membershipRetryTimer = setInterval(() => void syncGuildMemberships().catch(error => logThrottled('guild-membership-sync', 'guild membership sync retry failed', error)), 30_000);
  await dispatchRequested();
  const dispatchTimer = setInterval(() => void dispatchRequested(), 5_000);
  const staleOperationTimer = setInterval(() => void markInterruptedOperationsUncertain(prisma).catch(error => console.error('stale moderation operation reconciliation failed', error)), 60_000);
  const shutdown = async () => { clearInterval(timer); clearInterval(membershipRetryTimer); clearInterval(dispatchTimer); clearInterval(staleOperationTimer); await worker.close(); await queue.close(); await prisma.$disconnect(); client.destroy(); process.exit(0); };
  process.once('SIGINT', () => void shutdown()); process.once('SIGTERM', () => void shutdown());
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand() || !interaction.guildId || !interaction.guild) return;
  if (interaction.commandName !== warn.name && !actionCommands.some(command => command.name === interaction.commandName)) return;
  let guildSettings;
  try { guildSettings = await prisma.guildConfig.findUnique({ where: { guildId: interaction.guildId } }); }
  catch { await interaction.reply({ content: 'Configuration du serveur indisponible. Aucune action enregistrée.', ephemeral: true }); return; }
  const english = guildSettings?.language === 'en';
  const embedColor = parseInt((guildSettings?.embedColor ?? '#7775F5').slice(1), 16);
  if (interaction.commandName === warn.name) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) { await interaction.reply({ content: english ? 'Moderate Members permission is required.' : 'La permission Modérer les membres est requise.', ephemeral: true }); return; }
    const target = interaction.options.getUser('membre', true);
    const reason = interaction.options.getString('raison', true).trim();
    try {
      const item = await createWarningCase({ guildId: interaction.guildId, actorId: interaction.user.id, targetId: target.id, reason });
      await interaction.reply({ embeds: [new EmbedBuilder().setColor(embedColor).setTitle(english ? 'Warning saved' : 'Avertissement enregistré').setDescription(english ? `User: ${target.id}\nCase: ${item.id}` : `Utilisateur : ${target.id}\nDossier : ${item.id}`)], ephemeral: true });
    } catch (error) { console.error('warning record failed', error instanceof Error ? error.name : 'unknown'); const disabled = error instanceof Error && error.message.includes('désactivé'); await interaction.reply({ content: disabled ? english ? 'Warnings are disabled on this server.' : 'Le module Avertissements est désactivé sur ce serveur.' : english ? 'The warning could not be saved. No Discord action was performed.' : 'Le dossier ne peut pas être enregistré pour le moment. Aucune action Discord n’a été exécutée.', ephemeral: true }); }
    return;
  }
  const actionByCommand: Record<string, ModerationAction> = { timeout: 'TIMEOUT', untimeout: 'UNTIMEOUT', kick: 'KICK', ban: 'BAN', unban: 'UNBAN', tempban: 'TEMPBAN', purge: 'PURGE_MESSAGES', slowmode: 'SLOWMODE', lock: 'LOCK_CHANNEL', unlock: 'UNLOCK_CHANNEL' };
  const action = actionByCommand[interaction.commandName];
  if (!action) return;
  const permission = action === 'TIMEOUT' || action === 'UNTIMEOUT' ? PermissionFlagsBits.ModerateMembers : action === 'KICK' ? PermissionFlagsBits.KickMembers : action === 'BAN' || action === 'UNBAN' || action === 'TEMPBAN' ? PermissionFlagsBits.BanMembers : action === 'PURGE_MESSAGES' ? PermissionFlagsBits.ManageMessages : action === 'SLOWMODE' ? PermissionFlagsBits.ManageChannels : PermissionFlagsBits.ManageRoles;
  const channelAction = ['PURGE_MESSAGES', 'SLOWMODE', 'LOCK_CHANNEL', 'UNLOCK_CHANNEL'].includes(action);
  if (!channelAction && !interaction.memberPermissions?.has(permission)) { await interaction.reply({ content: 'La permission Discord requise est absente.', ephemeral: true }); return; }
  const targetId = action === 'UNBAN' ? interaction.options.getString('utilisateur', true) : channelAction ? interaction.options.getChannel('salon', true).id : interaction.options.getUser('membre', true).id;
  const reason = interaction.options.getString('raison', true).trim();
  const durationMinutes = action === 'TIMEOUT' || action === 'TEMPBAN' ? interaction.options.getInteger('minutes', true) : undefined;
  try {
    const requestedCount = action === 'PURGE_MESSAGES' ? interaction.options.getInteger('nombre', true) : undefined;
    const rateLimitSeconds = action === 'SLOWMODE' ? interaction.options.getInteger('secondes', true) : undefined;
    const filterAuthorId = action === 'PURGE_MESSAGES' ? interaction.options.getUser('auteur')?.id : undefined;
    const item = await submitModerationAction(prisma, { guildId: interaction.guildId, actorId: interaction.user.id, targetId, action, reason, ...(durationMinutes === undefined ? {} : { durationMinutes }), ...(channelAction ? { channelId: targetId } : {}), ...(requestedCount === undefined ? {} : { requestedCount }), ...(rateLimitSeconds === undefined ? {} : { rateLimitSeconds }), ...(filterAuthorId === undefined ? {} : { filterAuthorId }), operationId: interaction.id });
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(embedColor).setTitle(english ? 'Action requested' : 'Action demandée').setDescription(english ? `Case: ${item.id}\nStatus: ${item.status}. Check the case for the confirmed outcome.` : `Dossier : ${item.id}\nÉtat : ${item.status}. Consultez le dossier pour le résultat confirmé.`)], ephemeral: true });
  } catch (error) {
    console.error('Could not enqueue moderation action', error);
    await interaction.reply({ content: error instanceof Error && error.message.includes('désactivé') && english ? 'This module is disabled on this server.' : error instanceof Error ? error.message : 'Action non exécutée: erreur inconnue.', ephemeral: true });
  }
});
client.on(Events.GuildCreate, guild => void prisma.guildPresence.upsert({ where: { guildId: guild.id }, create: { guildId: guild.id, shardId: guild.shardId }, update: { shardId: guild.shardId, lastSeenAt: new Date() } }).catch(error => logThrottled('guild-membership-event', 'guild join presence update failed', error)));
client.on(Events.GuildDelete, guild => void prisma.guildPresence.deleteMany({ where: { guildId: guild.id } }).catch(error => logThrottled('guild-membership-event', 'guild leave presence update failed', error)));

await client.login(env.DISCORD_BOT_TOKEN);
