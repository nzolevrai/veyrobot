import { Client, EmbedBuilder, Events, PermissionFlagsBits } from 'discord.js';
import { createWarningCase, withModerationAdmission, prisma } from '@veyrobot/db';
import { submitModerationAction, type ModerationAction } from '@veyrobot/moderation';
import { warn, actionCommands } from './commands.js';

export function registerInteractionHandler(client: Client): void {
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
    const item = await withModerationAdmission(prisma, interaction.guildId, interaction.id, tx => submitModerationAction(tx, { guildId: interaction.guildId!, actorId: interaction.user.id, targetId, action, reason, ...(durationMinutes === undefined ? {} : { durationMinutes }), ...(channelAction ? { channelId: targetId } : {}), ...(requestedCount === undefined ? {} : { requestedCount }), ...(rateLimitSeconds === undefined ? {} : { rateLimitSeconds }), ...(filterAuthorId === undefined ? {} : { filterAuthorId }), operationId: interaction.id }));
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(embedColor).setTitle(english ? 'Action requested' : 'Action demandée').setDescription(english ? `Case: ${item.id}\nStatus: ${item.status}. Check the case for the confirmed outcome.` : `Dossier : ${item.id}\nÉtat : ${item.status}. Consultez le dossier pour le résultat confirmé.`)], ephemeral: true });
  } catch (error) {
    console.error('Could not enqueue moderation action', error);
    await interaction.reply({ content: error instanceof Error && error.message.includes('désactivé') && english ? 'This module is disabled on this server.' : error instanceof Error ? error.message : 'Action non exécutée: erreur inconnue.', ephemeral: true });
  }
});
}
