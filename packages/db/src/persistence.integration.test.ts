import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createWarningCase, prisma } from './index.js';

const enabled = process.env.RUN_POSTGRES_INTEGRATION === '1';
const testGuildId = `9${crypto.randomUUID().replace(/\D/g, '').padEnd(17, '0').slice(0, 17)}`;
let createdId: string | undefined;
let temporaryBanId: string | undefined;
after(async () => { if (createdId) await prisma.moderationCase.deleteMany({ where: { id: createdId } }); if (temporaryBanId) await prisma.moderationCase.deleteMany({ where: { id: temporaryBanId } }); if (enabled) await prisma.guildConfig.deleteMany({ where: { guildId: testGuildId } }); await prisma.$disconnect(); });

test('PostgreSQL persists and reloads a warning dossier', { skip: !enabled }, async () => {
  const targetId = '123456789012345678';
  await assert.rejects(createWarningCase({ guildId: testGuildId, actorId: '123456789012345680', targetId, reason: 'Must be disabled' }), /désactivé/);
  await prisma.guildConfig.create({ data: { guildId: testGuildId, updatedBy: '123456789012345680', warningsEnabled: true, language: 'en', timeZone: 'Europe/Paris', embedColor: '#123ABC' } });
  const record = await createWarningCase({ guildId: testGuildId, actorId: '123456789012345680', targetId, reason: 'Integration persistence check' });
  createdId = record.id;
  const loaded = await prisma.moderationCase.findFirst({ where: { id: record.id, guildId: record.guildId, targetId } });
  assert.ok(loaded);
  assert.equal(loaded?.action, 'WARN');
  assert.equal(loaded?.reason, 'Integration persistence check');
  await prisma.$disconnect();
  const settings = await prisma.guildConfig.findUnique({ where: { guildId: testGuildId } });
  assert.equal(settings?.warningsEnabled, true);
  assert.equal(settings?.memberActionsEnabled, false);
  assert.equal(settings?.language, 'en');
  assert.equal(settings?.timeZone, 'Europe/Paris');
  assert.equal(settings?.embedColor, '#123ABC');
  assert.equal(await prisma.moderationCase.count({ where: { id: record.id, guildId: '123456789012345679' } }), 0);
});

test('PostgreSQL preserves a confirmed temporary ban expiry and its marker', { skip: !enabled }, async () => {
  const now = new Date();
  const operationId = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + 60_000);
  const record = await prisma.moderationCase.create({ data: {
    id: crypto.randomUUID(), operationId, guildId: testGuildId, actorId: '123456789012345680', targetId: '123456789012345681',
    action: 'TEMPBAN', reason: 'Integration scheduler persistence check', status: 'succeeded', durationMinutes: 1,
    createdAt: now, startedAt: now, completedAt: now, expiresAt, banMarker: `veyro-case-${operationId}`, expiryStatus: 'scheduled',
  } });
  temporaryBanId = record.id;
  const loaded = await prisma.moderationCase.findUnique({ where: { operationId } });
  assert.equal(loaded?.expiresAt?.getTime(), expiresAt.getTime());
  assert.equal(loaded?.banMarker, `veyro-case-${operationId}`);
  assert.equal(loaded?.expiryStatus, 'scheduled');
});
