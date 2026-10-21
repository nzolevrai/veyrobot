import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import type { PrismaClient } from './generated/prisma/client.js';
import { assertRecoveryAuthorized, recoveryEpochHash } from './recovery-gate.js';

function clientReturning(gate: { epochHash: string } | null): PrismaClient {
  return { recoveryGate: { findUnique: async () => gate } } as unknown as PrismaClient;
}

test('recovery startup authorization requires a matching externally supplied epoch', async () => {
  const epoch = randomBytes(32).toString('hex');
  assert.equal(recoveryEpochHash(epoch).length, 64);
  await assertRecoveryAuthorized(clientReturning({ epochHash: recoveryEpochHash(epoch) }), epoch);
  await assert.rejects(assertRecoveryAuthorized(clientReturning({ epochHash: recoveryEpochHash(epoch) }), randomBytes(32).toString('hex')));
  await assert.rejects(assertRecoveryAuthorized(clientReturning(null), epoch), /not initialized/);
  await assert.rejects(assertRecoveryAuthorized(clientReturning({ epochHash: 'bad' }), epoch));
  await assert.rejects(assertRecoveryAuthorized(clientReturning(null), 'short'));
});

test('recovery authorization fails closed when the database read fails', async () => {
  const epoch = randomBytes(32).toString('hex');
  const failedClient = { recoveryGate: { findUnique: async () => { throw new Error('database unavailable'); } } } as unknown as PrismaClient;
  await assert.rejects(assertRecoveryAuthorized(failedClient, epoch), /database unavailable/);
});
