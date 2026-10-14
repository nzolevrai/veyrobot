export type View = 'overview' | 'warnings' | 'actions' | 'cases' | 'settings';

export type Guild = {
  id: string;
  name: string;
  icon: string | null;
  botPresent: boolean;
  botInstalled: boolean;
  botOnline: boolean;
  owner?: boolean;
  permissions?: string;
};
export type GuildConfig = { guildId: string; version: number; warningsEnabled: boolean; memberActionsEnabled: boolean; channelActionsEnabled: boolean; language: 'fr' | 'en'; timeZone: string; embedColor: string };

export type DiscordUser = { id: string; username: string; avatar: string | null };

export type ModerationCase = {
  id: string;
  guildId: string;
  targetId: string;
  channelId?: string | null;
  deletedCount?: number | null;
  actorId: string;
  action: string;
  reason: string;
  status: string;
  result: string | null;
  createdAt: string;
  expiresAt?: string | null;
  expiryStatus?: string | null;
  expiryResult?: string | null;
};
