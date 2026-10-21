import { Client, EmbedBuilder, Events, PermissionFlagsBits, type ChatInputCommandInteraction, type InteractionEditReplyOptions, type InteractionReplyOptions } from 'discord.js';
import { createWarningCase, withModerationAdmission, prisma } from '@veyrobot/db';
import { submitModerationAction, type ModerationAction } from '@veyrobot/moderation';
import { warn, actionCommands } from './commands.js';
import { logBotError } from './error-log.js';

function logInteractionFailure(error: unknown): void {
  logBotError('interaction_handler_failed', 'interaction', 'Interaction handling failed', error);
}

export async function respondSafely(interaction: Pick<ChatInputCommandInteraction, 'deferred' | 'replied' | 'reply' | 'editReply' | 'followUp'>, payload: InteractionReplyOptions): Promise<void> {
  try {
    if (interaction.deferred) await interaction.editReply(payload as unknown as InteractionEditReplyOptions);
    else if (interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch (error) { logInteractionFailure(error); }
}

export async function acknowledgeInteraction(interaction: Pick<ChatInputCommandInteraction, 'deferReply'>): Promise<boolean> {
  try { await interaction.deferReply({ ephemeral: true }); return true; }
  catch (error) { logInteractionFailure(error); return false; }
}

export async function runInteractionSafely<T>(run: () => Promise<T>, onError: (error: unknown) => Promise<void>): Promise<T | undefined> {
  try { return await run(); }
  catch (error) { logInteractionFailure(error); await onError(error); return undefined; }
}

async function handleInteraction(interaction: ChatInputCommandInteraction, onActionAccepted?: () => void): Promise<void> {
  if (!interaction.guildId || !interaction.guild) return;
  if (interaction.commandName !== warn.name && !actionCommands.some(command => command.name === interaction.commandName)) return;

  // Acknowledge before database admission, Discord fetches, or other variable-latency work.
  if (!await acknowledgeInteraction(interaction)) return;
  let guildSettings;
  try { guildSettings = await prisma.guildConfig.findUnique({ where: { guildId: interaction.guildId } }); }
  catch {
    await respondSafely(interaction, { content: 'Configuration du serveur indisponible. Aucune action enregistrée.' });
    return;
  }
  const english = guildSettings?.language === 'en';
  const embedColor = parseInt((guildSettings?.embedColor ?? '#7775F5').slice(1), 16);
  if (interaction.commandName === warn.name) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
      await respondSafely(interaction, { content: english ? 'Moderate Members permission is required.' : 'La permission Modérer les membres est requise.' });
      return;
    }
    const target = interaction.options.getUser('membre', true);
    const reason = interaction.options.getString('raison', true).trim();
    try {
      const item = await createWarningCase({ guildId: interaction.guildId, actorId: interaction.user.id, targetId: target.id, reason });
      await respondSafely(interaction, { embeds: [new EmbedBuilder().setColor(embedColor).setTitle(english ? 'Warning saved' : 'Avertissement enregistré').setDescription(english ? `User: ${target.id}\nCase: ${item.id}` : `Utilisateur : ${target.id}\nDossier : ${item.id}`)] });
    } catch (error) {
      logInteractionFailure(error);
      const disabled = error instanceof Error && error.message.includes('désactivé');
      await respondSafely(interaction, { content: disabled ? english ? 'Warnings are disabled on this server.' : 'Le module Avertissements est désactivé sur ce serveur.' : english ? 'The warning could not be saved. No Discord action was performed.' : 'Le dossier ne peut pas être enregistré pour le moment. Aucune action Discord n’a été exécutée.' });
    }
    return;
  }

  const actionByCommand: Record<string, ModerationAction> = { timeout: 'TIMEOUT', untimeout: 'UNTIMEOUT', kick: 'KICK', ban: 'BAN', unban: 'UNBAN', tempban: 'TEMPBAN', purge: 'PURGE_MESSAGES', slowmode: 'SLOWMODE', lock: 'LOCK_CHANNEL', unlock: 'UNLOCK_CHANNEL' };
  const action = actionByCommand[interaction.commandName];
  if (!action) return;
  const permission = action === 'TIMEOUT' || action === 'UNTIMEOUT' ? PermissionFlagsBits.ModerateMembers : action === 'KICK' ? PermissionFlagsBits.KickMembers : action === 'BAN' || action === 'UNBAN' || action === 'TEMPBAN' ? PermissionFlagsBits.BanMembers : action === 'PURGE_MESSAGES' ? PermissionFlagsBits.ManageMessages : action === 'SLOWMODE' ? PermissionFlagsBits.ManageChannels : PermissionFlagsBits.ManageRoles;
  const channelAction = ['PURGE_MESSAGES', 'SLOWMODE', 'LOCK_CHANNEL', 'UNLOCK_CHANNEL'].includes(action);
  if (!channelAction && !interaction.memberPermissions?.has(permission)) {
    await respondSafely(interaction, { content: 'La permission Discord requise est absente.' });
    return;
  }
  const targetId = action === 'UNBAN' ? interaction.options.getString('utilisateur', true) : channelAction ? interaction.options.getChannel('salon', true).id : interaction.options.getUser('membre', true).id;
  const reason = interaction.options.getString('raison', true).trim();
  const durationMinutes = action === 'TIMEOUT' || action === 'TEMPBAN' ? interaction.options.getInteger('minutes', true) : undefined;
  try {
    const requestedCount = action === 'PURGE_MESSAGES' ? interaction.options.getInteger('nombre', true) : undefined;
    const rateLimitSeconds = action === 'SLOWMODE' ? interaction.options.getInteger('secondes', true) : undefined;
    const filterAuthorId = action === 'PURGE_MESSAGES' ? interaction.options.getUser('auteur')?.id : undefined;
    const item = await withModerationAdmission(prisma, interaction.guildId, interaction.id, tx => submitModerationAction(tx, { guildId: interaction.guildId!, actorId: interaction.user.id, targetId, action, reason, ...(durationMinutes === undefined ? {} : { durationMinutes }), ...(channelAction ? { channelId: targetId } : {}), ...(requestedCount === undefined ? {} : { requestedCount }), ...(rateLimitSeconds === undefined ? {} : { rateLimitSeconds }), ...(filterAuthorId === undefined ? {} : { filterAuthorId }), operationId: interaction.id }));
    onActionAccepted?.();
    await respondSafely(interaction, { embeds: [new EmbedBuilder().setColor(embedColor).setTitle(english ? 'Action requested' : 'Action demandée').setDescription(english ? `Case: ${item.id}\nStatus: ${item.status}. Check the case for the confirmed outcome.` : `Dossier : ${item.id}\nÉtat : ${item.status}. Consultez le dossier pour le résultat confirmé.`)] });
  } catch (error) {
    logInteractionFailure(error);
    const disabled = error instanceof Error && error.message.includes('désactivé');
    await respondSafely(interaction, { content: disabled && english ? 'This module is disabled on this server.' : error instanceof Error && disabled ? 'Ce module est désactivé sur ce serveur.' : 'La demande n’a pas pu être enregistrée. Aucune action Discord n’a été confirmée.' });
  }
}

export function registerInteractionHandler(client: Client, onActionAccepted?: () => void): void {
  client.on(Events.InteractionCreate, interaction => {
    if (!interaction.isChatInputCommand()) return;
    void runInteractionSafely(() => handleInteraction(interaction, onActionAccepted), async error => {
      await respondSafely(interaction, { content: 'Le traitement a échoué. Consultez le dossier avant de réessayer.' });
      if (error instanceof Error) logInteractionFailure(error);
    });
  });
}
