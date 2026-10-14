import { z } from 'zod';

export const moduleIds = ['warnings', 'member-actions', 'channel-actions'] as const;
export type ModuleId = typeof moduleIds[number];
export const guildSettingsSchema = z.object({
  language: z.enum(['fr', 'en']),
  timeZone: z.string().min(1).max(80).refine(value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return value === 'UTC' || value.includes('/'); } catch { return false; }
  }, 'Fuseau horaire IANA invalide.'),
  embedColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Couleur hexadécimale invalide.'),
});
export const defaultGuildConfig = {
  version: 0, warningsEnabled: false, memberActionsEnabled: false,
  channelActionsEnabled: false, language: 'fr', timeZone: 'UTC', embedColor: '#7775F5',
} as const;
export function moduleEnabled(config: { warningsEnabled: boolean; memberActionsEnabled: boolean; channelActionsEnabled: boolean } | null, id: ModuleId): boolean {
  if (!config) return false;
  return id === 'warnings' ? config.warningsEnabled : id === 'member-actions' ? config.memberActionsEnabled : config.channelActionsEnabled;
}
export function moduleForAction(action: string): ModuleId {
  return ['PURGE_MESSAGES', 'SLOWMODE', 'LOCK_CHANNEL', 'UNLOCK_CHANNEL'].includes(action) ? 'channel-actions' : 'member-actions';
}
export function rejectPendingAfterDisable(config: ({ warningsEnabled: boolean; memberActionsEnabled: boolean; channelActionsEnabled: boolean; updatedAt: Date } | null), action: string, requestedAt: Date): boolean {
  return Boolean(config && !moduleEnabled(config, moduleForAction(action)) && config.updatedAt <= requestedAt);
}
