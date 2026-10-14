import type { Prisma, PrismaClient } from './generated/prisma/client.js';

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

/** Serializes only admission decisions, so the queued count cannot race past its caps. */
export async function withModerationAdmission<T>(client: PrismaClient, guildId: string, operationId: string, create: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const globalLimit = limit('MAX_PENDING_GLOBAL', 5_000);
  const guildLimit = limit('MAX_PENDING_PER_GUILD', 100);
  return client.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(86291, 2)::text AS locked`;
    const prior = await tx.moderationCase.findUnique({ where: { operationId }, select: { id: true } });
    if (!prior) {
      const [globalCount, guildCount] = await Promise.all([
        tx.moderationCase.count({ where: { status: { in: ['requested', 'running'] } } }),
        tx.moderationCase.count({ where: { guildId, status: { in: ['requested', 'running'] } } }),
      ]);
      if (guildCount >= guildLimit) throw new AdmissionLimitError(`File du serveur pleine (${guildLimit} demandes actives maximum). Réessayez plus tard.`);
      if (globalCount >= globalLimit) throw new AdmissionLimitError(`File de modération pleine (${globalLimit} demandes actives maximum). Réessayez plus tard.`);
    }
    return create(tx);
  }, { maxWait: 3_000, timeout: 5_000 });
}
