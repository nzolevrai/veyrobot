import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prisma } from './index.js';
import { pruneRetainedData } from './retention.js';

test('retention deletes bounded eligible history and preserves active actions', { skip: process.env.RUN_POSTGRES_INTEGRATION !== '1' }, async () => {
  const guildId = `retention-${crypto.randomUUID()}`;
  const old = new Date('2020-01-01T00:00:00Z');
  const now = new Date('2026-10-14T00:00:00Z');
  const oldSession = `retention-${crypto.randomUUID()}`;
  const newSession = `retention-${crypto.randomUUID()}`;
  try {
    await prisma.sessionGrant.createMany({ data: [{ idHash: oldSession, expiresAt: old }, { idHash: newSession, expiresAt: now }] });
    await prisma.configAudit.create({ data: { guildId, actorId: guildId, version: 1, changes: {}, createdAt: old } });
    await prisma.moderationCase.createMany({ data: [
      { guildId, actorId: guildId, targetId: guildId, action: 'WARN', reason: 'old warning', status: 'completed', createdAt: old },
      { guildId, actorId: guildId, targetId: guildId, action: 'WARN', reason: 'recent warning', status: 'completed', createdAt: now },
      { guildId, actorId: guildId, targetId: guildId, action: 'TEMPBAN', reason: 'scheduled', status: 'succeeded', expiryStatus: 'scheduled', expiresAt: now, createdAt: old },
      { guildId, actorId: guildId, targetId: guildId, action: 'KICK', reason: 'pending', status: 'requested', operationId: `retention-${crypto.randomUUID()}`, createdAt: old },
    ] });
    const deleted = await pruneRetainedData(prisma, now, { sessionDays: 30, auditDays: 730, warningDays: 1095, batchSize: 1, maxBatches: 1 });
    assert.deepEqual(deleted, { sessions: 1, configAudits: 1, warnings: 1 });
    assert.equal(await prisma.sessionGrant.count({ where: { idHash: newSession } }), 1);
    assert.deepEqual((await prisma.moderationCase.findMany({ where: { guildId }, select: { reason: true } })).map(row => row.reason).sort(), ['pending', 'recent warning', 'scheduled']);
  } finally {
    await prisma.moderationCase.deleteMany({ where: { guildId } });
    await prisma.configAudit.deleteMany({ where: { guildId } });
    await prisma.sessionGrant.deleteMany({ where: { idHash: { in: [oldSession, newSession] } } });
    await prisma.$disconnect();
  }
});
