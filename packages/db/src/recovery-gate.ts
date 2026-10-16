import { createHash, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from './generated/prisma/client.js';

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

/** First-install bootstrap only. Restores must use the transactional quarantine path. */
export async function initializeRecoveryAuthorization(client: PrismaClient, epoch: string): Promise<void> {
  await client.recoveryGate.create({ data: { id: RECOVERY_GATE_ID, epochHash: recoveryEpochHash(epoch) } });
}
