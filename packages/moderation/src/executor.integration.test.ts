import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PermissionFlagsBits, type Guild } from 'discord.js';
import { prisma } from '@veyrobot/db';
import { executeModerationAction, expireTemporaryBan, markInterruptedOperationsUncertain } from './index.js';

const integration = process.env.RUN_POSTGRES_INTEGRATION === '1';
const guildId = '987654321012345678';
const actorId = '887654321012345678';
const targetId = '787654321012345678';

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function controlledGuild(options: { kick?: () => Promise<void>; beforeTarget?: () => Promise<void>; unban?: () => Promise<void> } = {}) {
  let kicks = 0;
  let unbans = 0;
  const actor = { id: actorId, permissions: { bitfield: PermissionFlagsBits.KickMembers }, roles: { highest: { comparePositionTo: () => 1 } } };
  const bot = { id: '687654321012345678', permissions: { bitfield: PermissionFlagsBits.KickMembers | PermissionFlagsBits.BanMembers, has: () => true }, roles: { highest: { comparePositionTo: () => 1 } } };
  const target = { id: targetId, roles: { highest: {} }, kick: async () => { kicks++; await options.kick?.(); } };
  const guild = {
    ownerId: actorId,
    members: {
      fetch: async ({ user }: { user: string }) => { if (user === targetId) { await options.beforeTarget?.(); return target; } return actor; },
      fetchMe: async () => bot,
      unban: async () => { unbans++; await options.unban?.(); },
    },
    bans: { fetch: async () => ({ reason: 'test [veyro-case-test]' }) },
  } as unknown as Guild;
  return { guild, get kicks() { return kicks; }, get unbans() { return unbans; } };
}

async function seed(action = 'KICK') {
  return prisma.moderationCase.create({ data: {
    guildId, actorId, targetId, action, reason: 'isolated executor test',
    operationId: `test-${randomUUID()}`, status: 'requested',
  } });
}

async function expireLease(id: string, expiry = false) {
  await prisma.moderationCase.update({ where: { id }, data: expiry ? { expiryLeaseUntil: new Date(0) } : { claimLeaseUntil: new Date(0) } });
  await markInterruptedOperationsUncertain(prisma);
}

test('production executor: interruption before Discord send prevents mutation and stale write', { skip: !integration }, async () => {
  const row = await seed();
  const gate = deferred();
  const discord = controlledGuild({ beforeTarget: () => gate.promise });
  try {
    const running = executeModerationAction({ operationId: row.operationId!, guild: discord.guild, caseRecord: row, store: prisma });
    for (let i = 0; i < 100; i++) { if ((await prisma.moderationCase.findUniqueOrThrow({ where: { id: row.id } })).status === 'running') break; await new Promise(resolve => setTimeout(resolve, 5)); }
    await expireLease(row.id);
    gate.release(); await running;
    assert.equal(discord.kicks, 0);
    assert.equal((await prisma.moderationCase.findUniqueOrThrow({ where: { id: row.id } })).status, 'failed');
  } finally { gate.release(); await prisma.moderationCase.delete({ where: { id: row.id } }); }
});

test('production executor: lost response remains uncertain and duplicate delivery does not retry', { skip: !integration }, async () => {
  const row = await seed();
  const discord = controlledGuild({ kick: async () => { throw new Error('response lost after send'); } });
  try {
    await executeModerationAction({ operationId: row.operationId!, guild: discord.guild, caseRecord: row, store: prisma });
    await executeModerationAction({ operationId: row.operationId!, guild: discord.guild, caseRecord: row, store: prisma });
    assert.equal(discord.kicks, 1);
    assert.equal((await prisma.moderationCase.findUniqueOrThrow({ where: { id: row.id } })).status, 'uncertain');
  } finally { await prisma.moderationCase.delete({ where: { id: row.id } }); }
});

test('production executor: expired lease during slow Discord call fences old writer', { skip: !integration }, async () => {
  const row = await seed();
  const gate = deferred();
  const entered = deferred();
  const discord = controlledGuild({ kick: async () => { entered.release(); await gate.promise; } });
  try {
    const running = executeModerationAction({ operationId: row.operationId!, guild: discord.guild, caseRecord: row, store: prisma });
    await entered.promise;
    await expireLease(row.id);
    gate.release(); await running;
    assert.equal(discord.kicks, 1);
    const final = await prisma.moderationCase.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(final.status, 'uncertain');
    await executeModerationAction({ operationId: row.operationId!, guild: discord.guild, caseRecord: row, store: prisma });
    assert.equal(discord.kicks, 1);
  } finally { gate.release(); await prisma.moderationCase.delete({ where: { id: row.id } }); }
});

test('production executor: lost PostgreSQL result write after Discord success reconciles as uncertain', { skip: !integration }, async () => {
  const row = await seed();
  const discord = controlledGuild();
  let dropped = false;
  const store = {
    moderationCase: { updateMany: async (args: Parameters<typeof prisma.moderationCase.updateMany>[0]) => {
      if (!dropped && args.data.status === 'succeeded') { dropped = true; throw new Error('simulated PostgreSQL disconnection after Discord response'); }
      return prisma.moderationCase.updateMany(args);
    } },
    guildTargetDecision: prisma.guildTargetDecision,
  };
  try {
    await assert.rejects(executeModerationAction({ operationId: row.operationId!, guild: discord.guild, caseRecord: row, store }), /disconnection/);
    assert.equal(discord.kicks, 1);
    const inflight = await prisma.moderationCase.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(inflight.executionPhase, 'discord_request_inflight');
    await expireLease(row.id);
    assert.equal((await prisma.moderationCase.findUniqueOrThrow({ where: { id: row.id } })).status, 'uncertain');
    await executeModerationAction({ operationId: row.operationId!, guild: discord.guild, caseRecord: row, store: prisma });
    assert.equal(discord.kicks, 1);
  } finally { await prisma.moderationCase.delete({ where: { id: row.id } }); }
});

test('production executor: process killed after Discord send leaves an uncertain operation without automatic replay', { skip: !integration }, async () => {
  const row = await seed();
  const child = fork(fileURLToPath(new URL('./executor-child.mjs', import.meta.url)), [], {
    env: { ...process.env, EXECUTOR_TEST_CASE_ID: row.id }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        child.on('message', message => { if ((message as { stage?: string }).stage === 'discord-request-entered') resolve(); });
        child.once('exit', code => reject(new Error(`Executor exited before Discord send (${code})`)));
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Executor did not reach Discord send')), 5_000)),
    ]);
    child.kill('SIGKILL');
    await new Promise<void>(resolve => child.once('exit', () => resolve()));
    const inflight = await prisma.moderationCase.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(inflight.executionPhase, 'discord_request_inflight');
    await expireLease(row.id);
    assert.equal((await prisma.moderationCase.findUniqueOrThrow({ where: { id: row.id } })).status, 'uncertain');
    const retry = controlledGuild();
    await executeModerationAction({ operationId: row.operationId!, guild: retry.guild, caseRecord: row, store: prisma });
    assert.equal(retry.kicks, 0);
  } finally {
    if (!child.killed) child.kill('SIGKILL');
    await prisma.moderationCase.delete({ where: { id: row.id } });
  }
});

test('production expiry: interrupted unban is uncertain and never automatically repeated', { skip: !integration }, async () => {
  const row = await prisma.moderationCase.create({ data: {
    guildId, actorId, targetId, action: 'TEMPBAN', reason: 'isolated expiry test', status: 'succeeded',
    operationId: `test-${randomUUID()}`, banMarker: 'veyro-case-test', expiresAt: new Date(0), expiryStatus: 'scheduled',
  } });
  const gate = deferred();
  const entered = deferred();
  const discord = controlledGuild({ unban: async () => { entered.release(); await gate.promise; } });
  try {
    const running = expireTemporaryBan({ guild: discord.guild, caseRecord: row, store: prisma });
    await entered.promise;
    await expireLease(row.id, true);
    gate.release(); await running;
    assert.equal((await prisma.moderationCase.findUniqueOrThrow({ where: { id: row.id } })).expiryStatus, 'uncertain');
    await expireTemporaryBan({ guild: discord.guild, caseRecord: row, store: prisma });
    assert.equal(discord.unbans, 1);
  } finally { gate.release(); await prisma.moderationCase.delete({ where: { id: row.id } }); }
});
