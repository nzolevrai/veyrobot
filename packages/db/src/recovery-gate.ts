import { createHash, timingSafeEqual } from 'node:crypto';
import type { Prisma, PrismaClient } from './generated/prisma/client.js';

const RECOVERY_GATE_ID = 'singleton';

export function recoveryEpochHash(epoch: string): string {
  if (typeof epoch !== 'string' || epoch.length < 32 || epoch.length > 256) {
    throw new Error('Recovery epoch is missing or outside the allowed length.');
  }
  return createHash('sha256').update(epoch, 'utf8').digest('hex');
}

/** Fail closed unless this deployment's external epoch is recorded in PostgreSQL. */
export async function assertRecoveryAuthorized(client: PrismaClient, epoch: string): Promise<void> {
  const expected = Buffer.from(recoveryEpochHash(epoch), 'hex');
  const gate = await client.recoveryGate.findUnique({ where: { id: RECOVERY_GATE_ID }, select: { epochHash: true } });
  if (!gate) throw new Error('Recovery authorization is not initialized.');
  const stored = Buffer.from(gate.epochHash, 'hex');
  if (stored.length !== expected.length || !timingSafeEqual(stored, expected)) {
    throw new Error('Recovery authorization does not match deployment state.');
  }
}

/** First-install bootstrap only. Rejects any database carrying application state. */
export async function initializeRecoveryAuthorization(client: PrismaClient, epoch: string): Promise<void> {
  const epochHash = recoveryEpochHash(epoch);
  await client.$transaction(async tx => {
    // SHARE table locks prevent concurrent inserts/updates/deletes while the
    // emptiness check and gate creation are performed. Lock in a fixed order;
    // the separate EXCLUSIVE lock serializes concurrent initializers.
    await lockFirstInstallTables(tx);
    const gateCount = await tx.recoveryGate.count();
    if (gateCount > 0) throw new Error('Recovery authorization already exists; initialization cannot replace it.');

    const rows = await tx.$queryRaw<Array<{ hasApplicationData: boolean }>>`
      SELECT (
        EXISTS (SELECT 1 FROM "ModerationCase") OR
        EXISTS (SELECT 1 FROM "GuildTargetDecision") OR
        EXISTS (SELECT 1 FROM "ChannelLockState") OR
        EXISTS (SELECT 1 FROM "GuildConfig") OR
        EXISTS (SELECT 1 FROM "ConfigAudit") OR
        EXISTS (SELECT 1 FROM "GuildPresence") OR
        EXISTS (SELECT 1 FROM "ShardPresence") OR
        EXISTS (SELECT 1 FROM "SessionGrant")
      ) AS "hasApplicationData"
    `;
    if (rows[0]?.hasApplicationData !== false) {
      throw new Error('Database contains application data; use recovery:quarantine instead of first-install initialization.');
    }

    await tx.recoveryGate.create({ data: { id: RECOVERY_GATE_ID, epochHash } });
  }, { isolationLevel: 'ReadCommitted', maxWait: 5_000, timeout: 10_000 });
}

async function lockFirstInstallTables(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`LOCK TABLE "ModerationCase", "GuildTargetDecision", "ChannelLockState", "GuildConfig", "ConfigAudit", "GuildPresence", "ShardPresence", "SessionGrant" IN SHARE MODE`;
  await tx.$executeRaw`LOCK TABLE "RecoveryGate" IN EXCLUSIVE MODE`;
}
