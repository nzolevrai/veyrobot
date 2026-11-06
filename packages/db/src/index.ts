import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { PrismaClient } from './generated/prisma/client.js';
import type { Prisma } from './generated/prisma/client.js';
import { isReplayConflict, isSameWarningReplay, persistWarningCase, type WarningCaseInput } from './warning-case.js';
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

async function assertWarningsEnabled(tx: Prisma.TransactionClient, guildId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ warningsEnabled: boolean }>>`
    SELECT "warningsEnabled" FROM "GuildConfig" WHERE "guildId" = ${guildId} FOR SHARE
  `;
  if (!rows[0]?.warningsEnabled) throw Object.assign(new Error('Le module Avertissements est désactivé sur ce serveur.'), { statusCode: 400, code: 'MODULE_DISABLED' });
}

export async function createWarningCase(input: WarningCaseInput) {
  if (!input.operationId) {
    return prisma.$transaction(async tx => {
      await assertWarningsEnabled(tx, input.guildId);
      return persistWarningCase({ create: ({ data }) => tx.moderationCase.create({ data }) }, input);
    }, { isolationLevel: 'Serializable' });
  }
  const replayInput: WarningCaseInput & { operationId: string } = { ...input, operationId: input.operationId };
  const existing = await prisma.moderationCase.findUnique({ where: { operationId: replayInput.operationId } });
  if (existing) {
    if (isSameWarningReplay(existing, replayInput)) return existing;
    throw Object.assign(new Error('Identifiant d’interaction déjà associé à un dossier différent.'), { code: 'INTERACTION_REPLAY_CONFLICT' });
  }

  try {
    return await prisma.$transaction(async tx => {
      await assertWarningsEnabled(tx, input.guildId);
      await tx.moderationCase.createMany({
        data: [{ ...replayInput, action: 'WARN', status: 'completed' }],
        skipDuplicates: true,
      });
      const record = await tx.moderationCase.findUnique({ where: { operationId: replayInput.operationId } });
      if (!record) throw new Error('Le dossier avertissement n’a pas pu être relu après son écriture.');
      if (!isSameWarningReplay(record, replayInput)) {
        throw Object.assign(new Error('Identifiant d’interaction déjà associé à un dossier différent.'), { code: 'INTERACTION_REPLAY_CONFLICT' });
      }
      return record;
    });
  } catch (error) {
    // Concurrent deliveries can both pass the first lookup. The unique database
    // constraint selects one winner; the loser returns it only if its payload
    // matches the same Discord interaction exactly.
    if (!isReplayConflict(error)) throw error;
    const replay = await prisma.moderationCase.findUnique({ where: { operationId: replayInput.operationId } });
    if (replay && isSameWarningReplay(replay, replayInput)) return replay;
    throw error;
  }
}
