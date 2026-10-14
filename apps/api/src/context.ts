import type { FastifyRequest } from 'fastify';
import type { GuildListCache } from './guild-list-cache.js';

export type DiscordUser = { id: string; username: string; avatar: string | null };
export type DiscordGuild = { id: string; name: string; icon: string | null; owner: boolean; permissions: string };
export type Session = { user: DiscordUser; accessToken: string; csrf: string; sessionId: string };
export type ApiFailure = Error & { statusCode?: number; code?: string; retryAfter?: string };
type Db = typeof import('@veyrobot/db');
type Moderation = typeof import('@veyrobot/moderation');

export type ApiContext = {
  env: { API_PUBLIC_URL: string; DASHBOARD_URL: string; DISCORD_CLIENT_ID: string; DISCORD_CLIENT_SECRET: string; DISCORD_BOT_TOKEN: string };
  db: Db;
  moderation: Moderation;
  prisma: Db['prisma'];
  guildListCache: GuildListCache<DiscordGuild[]>;
  sessionHash: (id: string) => string;
  session: (req: FastifyRequest) => Session | null;
  getCachedGuilds: (session: Session) => Promise<DiscordGuild[]>;
  authorizeGuild: (req: FastifyRequest, guildId: string, fresh?: boolean) => Promise<{ session: Session; guild: DiscordGuild }>;
  requireInstalledGuild: (req: FastifyRequest, guildId: string, fresh?: boolean) => Promise<{ session: Session; guild: DiscordGuild }>;
  validMutation: (req: FastifyRequest, session: Session, csrf: string) => boolean;
  isBotOnlineInGuild: (guildId: string) => Promise<boolean>;
};
