import type { Prisma, PrismaClient } from './generated/prisma/client.js';
import { performance } from 'node:perf_hooks';

function limit(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100_000) throw new Error(`${name} must be an integer between 1 and 100000.`);
  return value;
}

export class AdmissionLimitError extends Error {
  readonly statusCode = 429;
  readonly code = 'MODERATION_BACKLOG_LIMIT';
}

type AdmissionMetrics = { decisions: number; lockWaitTotalMs: number; lockWaitMaxMs: number; countTotalMs: number; countMaxMs: number; lockHeldTotalMs: number; lockHeldMaxMs: number };
let admissionMetrics: AdmissionMetrics = { decisions: 0, lockWaitTotalMs: 0, lockWaitMaxMs: 0, countTotalMs: 0, countMaxMs: 0, lockHeldTotalMs: 0, lockHeldMaxMs: 0 };

export function takeAdmissionMetrics(): AdmissionMetrics {
  const snapshot = admissionMetrics;
  admissionMetrics = { decisions: 0, lockWaitTotalMs: 0, lockWaitMaxMs: 0, countTotalMs: 0, countMaxMs: 0, lockHeldTotalMs: 0, lockHeldMaxMs: 0 };
  return snapshot;
}

/** Serializes only admission decisions, so the queued count cannot race past its caps. */
export async function withModerationAdmission<T>(client: PrismaClient, guildId: string, operationId: string, create: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const globalLimit = limit('MAX_PENDING_GLOBAL', 5_000);
  const guildLimit = limit('MAX_PENDING_PER_GUILD', 100);
  return client.$transaction(async tx => {
    const heldAt = performance.now();
    const lockStarted = performance.now();
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(86291, 2)::text AS locked`;
    const lockWaitMs = performance.now() - lockStarted;
    let countMs = 0;
    const measureCompletion = () => {
      const lockHeldMs = performance.now() - heldAt - lockWaitMs;
      admissionMetrics.decisions++;
      admissionMetrics.lockWaitTotalMs += lockWaitMs;
      admissionMetrics.lockWaitMaxMs = Math.max(admissionMetrics.lockWaitMaxMs, lockWaitMs);
      admissionMetrics.countTotalMs += countMs;
      admissionMetrics.countMaxMs = Math.max(admissionMetrics.countMaxMs, countMs);
      admissionMetrics.lockHeldTotalMs += lockHeldMs;
      admissionMetrics.lockHeldMaxMs = Math.max(admissionMetrics.lockHeldMaxMs, lockHeldMs);
    };
    try {
    const prior = await tx.moderationCase.findUnique({ where: { operationId }, select: { id: true } });
    if (!prior) {
      const countStarted = performance.now();
      const [globalCount, guildCount] = await Promise.all([
        tx.moderationCase.count({ where: { status: { in: ['requested', 'running'] } } }),
        tx.moderationCase.count({ where: { guildId, status: { in: ['requested', 'running'] } } }),
      ]);
      countMs = performance.now() - countStarted;
      if (guildCount >= guildLimit) throw new AdmissionLimitError(`File du serveur pleine (${guildLimit} demandes actives maximum). Réessayez plus tard.`);
      if (globalCount >= globalLimit) throw new AdmissionLimitError(`File de modération pleine (${globalLimit} demandes actives maximum). Réessayez plus tard.`);
    }
    return await create(tx);
    } finally { measureCompletion(); }
  }, { maxWait: 3_000, timeout: 5_000 });
}
