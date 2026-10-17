import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { PrismaClient } from './generated/prisma/client.js';
import { persistWarningCase, type WarningCaseInput } from './warning-case.js';
import { performance } from 'node:perf_hooks';

export type { WarningCaseInput } from './warning-case.js';
export type { ModerationCase } from './generated/prisma/client.js';
export function casesForGuildQuery(guildId: string, targetId?: string) {
  return { guildId, ...(targetId ? { targetId } : {}) };
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required.');
export const postgresPool = new Pool({ connectionString, max: Number(process.env.DATABASE_POOL_SIZE ?? 10) });
type PoolCallback = (error: Error | undefined, client: PoolClient | undefined, release: ((error?: Error | boolean) => void) | undefined) => void;
const poolAcquireMetrics = { acquisitions: 0, totalWaitMs: 0, maxWaitMs: 0 };
const originalConnect = postgresPool.connect.bind(postgresPool);
const instrumentedConnect = ((callback?: PoolCallback) => {
  const started = performance.now();
  const record = () => {
    const waitMs = performance.now() - started;
    poolAcquireMetrics.acquisitions++;
    poolAcquireMetrics.totalWaitMs += waitMs;
    poolAcquireMetrics.maxWaitMs = Math.max(poolAcquireMetrics.maxWaitMs, waitMs);
  };
  if (callback) return originalConnect((error, client, release) => { record(); callback(error ?? undefined, client, release); });
  return originalConnect().then(client => { record(); return client; }, error => { record(); throw error; });
}) as typeof postgresPool.connect;
(postgresPool as unknown as { connect: typeof instrumentedConnect }).connect = instrumentedConnect;
export function takePoolAcquireMetrics() {
  const snapshot = { ...poolAcquireMetrics };
  poolAcquireMetrics.acquisitions = 0;
  poolAcquireMetrics.totalWaitMs = 0;
  poolAcquireMetrics.maxWaitMs = 0;
  return snapshot;
}
const adapter = new PrismaPg(postgresPool, { disposeExternalPool: true });
export const prisma = new PrismaClient({ adapter, log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'] });
export * from './guild-config.js';
export * from './admission.js';
export * from './restore-quarantine.js';
export * from './recovery-gate.js';

export async function createWarningCase(input: WarningCaseInput) {
  return prisma.$transaction(async tx => {
    const config = await tx.guildConfig.findUnique({ where: { guildId: input.guildId }, select: { warningsEnabled: true } });
    if (!config?.warningsEnabled) throw Object.assign(new Error('Le module Avertissements est désactivé sur ce serveur.'), { statusCode: 400, code: 'MODULE_DISABLED' });
    return persistWarningCase({ create: ({ data }) => tx.moderationCase.create({ data }) }, input);
  }, { isolationLevel: 'Serializable' });
}
