import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prisma, withModerationAdmission } from './index.js';

test('PostgreSQL admission bounds concurrent pending work and allows an exact replay', { skip: process.env.RUN_POSTGRES_INTEGRATION !== '1' }, async () => {
  const prefix = `9${crypto.randomUUID().replace(/\D/g, '').padEnd(16, '0').slice(0, 16)}`;
  const guildA = `${prefix}1`;
  const guildB = `${prefix}2`;
  const guildC = `${prefix}3`;
  const oldGlobal = process.env.MAX_PENDING_GLOBAL;
  const oldGuild = process.env.MAX_PENDING_PER_GUILD;
  const existing = await prisma.moderationCase.count({ where: { status: { in: ['requested', 'running'] } } });
  process.env.MAX_PENDING_GLOBAL = String(existing + 2);
  process.env.MAX_PENDING_PER_GUILD = '1';
  const create = (guildId: string, operationId: string) => withModerationAdmission(prisma, guildId, operationId, async tx => {
    const prior = await tx.moderationCase.findUnique({ where: { operationId } });
    return prior ?? tx.moderationCase.create({ data: { guildId, operationId, actorId: '123456789012345679', targetId: '123456789012345680', action: 'KICK', reason: 'admission integration', status: 'requested' } });
  });
  try {
    const competing = await Promise.allSettled([create(guildA, `test-${crypto.randomUUID()}`), create(guildA, `test-${crypto.randomUUID()}`)]);
    assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(competing.filter(result => result.status === 'rejected').length, 1);
    const accepted = competing.find(result => result.status === 'fulfilled')!;
    assert.equal((await create(guildA, accepted.value.operationId!)).id, accepted.value.id);
    await create(guildB, `test-${crypto.randomUUID()}`);
    await assert.rejects(create(guildC, `test-${crypto.randomUUID()}`), /File de modération pleine/);
    await prisma.moderationCase.update({ where: { id: accepted.value.id }, data: { status: 'succeeded' } });
    await create(guildC, `test-${crypto.randomUUID()}`);
  } finally {
    await prisma.moderationCase.deleteMany({ where: { guildId: { in: [guildA, guildB, guildC] } } });
    if (oldGlobal === undefined) delete process.env.MAX_PENDING_GLOBAL; else process.env.MAX_PENDING_GLOBAL = oldGlobal;
    if (oldGuild === undefined) delete process.env.MAX_PENDING_PER_GUILD; else process.env.MAX_PENDING_PER_GUILD = oldGuild;
    await prisma.$disconnect();
  }
});
