import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerInteractionHandler } from '../dist/interactions.js';

const enabled = process.env.RUN_POSTGRES_INTEGRATION === '1';

function createRegisteredHandler() {
  let listener;
  registerInteractionHandler({ on(_event, callback) { listener = callback; } });
  assert.equal(typeof listener, 'function');
  return listener;
}

function createWarnInteraction({ id, guildId, reason }) {
  let deferred = false;
  const replies = [];
  return {
    id,
    guildId,
    guild: {},
    commandName: 'warn',
    user: { id: '123456789012345671' },
    memberPermissions: { has: () => true },
    options: {
      getUser: () => ({ id: '123456789012345672' }),
      getString: () => reason,
    },
    isChatInputCommand: () => true,
    get deferred() { return deferred; },
    get replied() { return false; },
    async deferReply() { deferred = true; },
    async reply(payload) { replies.push(payload); },
    async editReply(payload) { replies.push(payload); },
    async followUp(payload) { replies.push(payload); },
    replies,
  };
}

test('same /warn interaction replay creates one dossier even when handlers race', { skip: !enabled, timeout: 20_000 }, async () => {
  const { prisma } = await import('@veyrobot/db');
  const guildId = `9${crypto.randomUUID().replace(/\D/g, '').padEnd(17, '0').slice(0, 17)}`;
  const interactionId = '143000000000000001';
  try {
    await prisma.guildConfig.create({ data: { guildId, updatedBy: '123456789012345671', warningsEnabled: true, language: 'en', timeZone: 'UTC', embedColor: '#7775F5' } });
    const handle = createRegisteredHandler();
    const firstDelivery = createWarnInteraction({ id: interactionId, guildId, reason: 'same interaction replay' });
    const replay = createWarnInteraction({ id: interactionId, guildId, reason: 'same interaction replay' });

    await Promise.all([handle(firstDelivery), handle(replay)]);
    const laterReplay = createWarnInteraction({ id: interactionId, guildId, reason: 'same interaction replay' });
    await handle(laterReplay);

    const dossiers = await prisma.moderationCase.findMany({ where: { guildId, action: 'WARN' } });
    assert.equal(dossiers.length, 1, 'reprocessing one Discord interaction must not create a second dossier');
    assert.equal(dossiers[0]?.operationId, interactionId, 'the stable interaction ID is retained as the replay key');
    assert.equal(firstDelivery.replies.length, 1);
    assert.equal(replay.replies.length, 1);
    assert.equal(laterReplay.replies.length, 1);
    assert.match(firstDelivery.replies[0]?.embeds?.[0]?.data?.description ?? '', new RegExp(dossiers[0].id));
    assert.match(replay.replies[0]?.embeds?.[0]?.data?.description ?? '', new RegExp(dossiers[0].id));
    assert.match(laterReplay.replies[0]?.embeds?.[0]?.data?.description ?? '', new RegExp(dossiers[0].id));
  } finally {
    await prisma.moderationCase.deleteMany({ where: { guildId } });
    await prisma.guildConfig.deleteMany({ where: { guildId } });
  }
});

test('two intentional /warn interactions create two distinct dossiers', { skip: !enabled, timeout: 20_000 }, async () => {
  const { prisma } = await import('@veyrobot/db');
  const guildId = `9${crypto.randomUUID().replace(/\D/g, '').padEnd(17, '0').slice(0, 17)}`;
  try {
    await prisma.guildConfig.create({ data: { guildId, updatedBy: '123456789012345671', warningsEnabled: true, language: 'en', timeZone: 'UTC', embedColor: '#7775F5' } });
    const handle = createRegisteredHandler();
    const first = createWarnInteraction({ id: '143000000000000011', guildId, reason: 'intentional command one' });
    const second = createWarnInteraction({ id: '143000000000000012', guildId, reason: 'intentional command two' });

    await Promise.all([handle(first), handle(second)]);

    const dossiers = await prisma.moderationCase.findMany({ where: { guildId, action: 'WARN' }, orderBy: { operationId: 'asc' } });
    assert.deepEqual(dossiers.map(row => row.operationId), [first.id, second.id]);
    assert.equal(dossiers.length, 2, 'new Discord interaction IDs represent intentionally separate commands');
  } finally {
    await prisma.moderationCase.deleteMany({ where: { guildId } });
    await prisma.guildConfig.deleteMany({ where: { guildId } });
  }
});
