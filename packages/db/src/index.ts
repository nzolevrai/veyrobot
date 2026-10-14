import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
import { persistWarningCase, type WarningCaseInput } from './warning-case.js';

export type { WarningCaseInput } from './warning-case.js';
export type { ModerationCase } from './generated/prisma/client.js';
export function casesForGuildQuery(guildId: string, targetId?: string) {
  return { guildId, ...(targetId ? { targetId } : {}) };
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required.');
const adapter = new PrismaPg({ connectionString, max: Number(process.env.DATABASE_POOL_SIZE ?? 10) });
export const prisma = new PrismaClient({ adapter, log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'] });
export * from './guild-config.js';
export * from './admission.js';

export async function createWarningCase(input: WarningCaseInput) {
  return prisma.$transaction(async tx => {
    const config = await tx.guildConfig.findUnique({ where: { guildId: input.guildId }, select: { warningsEnabled: true } });
    if (!config?.warningsEnabled) throw new Error('Le module Avertissements est désactivé sur ce serveur.');
    return persistWarningCase({ create: ({ data }) => tx.moderationCase.create({ data }) }, input);
  }, { isolationLevel: 'Serializable' });
}
