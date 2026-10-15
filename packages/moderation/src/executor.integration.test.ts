import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DiscordAPIError, PermissionFlagsBits, type Guild } from 'discord.js';
import { prisma } from '@veyrobot/db';
import { executeModerationAction, expireTemporaryBan, markInterruptedOperationsUncertain } from './index.js';
import { submitModerationAction } from './service.js';

const integration = process.env.RUN_POSTGRES_INTEGRATION === '1';
const guildId = '987654321012345678';
const actorId = '887654321012345678';
const targetId = '787654321012345678';

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

const F7_BARRIER_TIMEOUT_MS = 2_000;
async function waitForBarrier(promise: Promise<void>, name: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for F7 barrier: ${name}`)), F7_BARRIER_TIMEOUT_MS); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })])
    .finally(() => { if (timer) clearTimeout(timer); });
}

function controlledGuild(options: { kick?: () => Promise<void>; beforeTarget?: () => Promise<void>; unban?: () => Promise<void>; ban?: () => Promise<void>; banReason?: string } = {}) {
  let kicks = 0;
  let unbans = 0;
  const actor = { id: actorId, permissions: { bitfield: PermissionFlagsBits.KickMembers }, roles: { highest: { comparePositionTo: () => 1 } } };
  const bot = { id: '687654321012345678', permissions: { bitfield: PermissionFlagsBits.KickMembers | PermissionFlagsBits.BanMembers, has: () => true }, roles: { highest: { comparePositionTo: () => 1 } } };
  const target = { id: targetId, roles: { highest: {} }, kick: async () => { kicks++; await options.kick?.(); }, ban: async () => { await options.ban?.(); } };
  const guild = {
    ownerId: actorId,
    members: {
      fetch: async ({ user }: { user: string }) => { if (user === targetId) { await options.beforeTarget?.(); return target; } return actor; },
      fetchMe: async () => bot,
      unban: async () => { unbans++; await options.unban?.(); },
    },
    bans: { fetch: async () => ({ reason: options.banReason ?? 'test [veyro-case-test]' }) },
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

function f7Pair() {
  const digits = randomUUID().replaceAll(/\D/g, '').slice(0, 17).padEnd(17, '1');
  return { guildId: `9${digits}`, actorId: `8${digits}`, targetId: `7${digits}` };
}

function f7Discord(pair: ReturnType<typeof f7Pair>, options: { beforeBan?: (reason: string) => Promise<void>; onBan?: (reason: string) => Promise<void>; onUnban?: () => Promise<void> } = {}) {
  let banReason: string | null = null;
  let memberPresent = true;
  let actorCanBan = true;
  const calls: string[] = [];
  const notFound = (path: string, code: number) => new DiscordAPIError({ message: 'not found' }, code, 404, 'GET', path, { body: null, files: null });
  const actor = { id: pair.actorId, permissions: { get bitfield() { return actorCanBan ? PermissionFlagsBits.BanMembers : 0n; } }, roles: { highest: { comparePositionTo: () => 1 } } };
  const bot = { id: '687654321012345678', permissions: { bitfield: PermissionFlagsBits.BanMembers, has: (flag: bigint) => (PermissionFlagsBits.BanMembers & flag) === flag }, roles: { highest: { comparePositionTo: () => 1 } } };
  const target = { id: pair.targetId, roles: { highest: {} }, ban: async ({ reason }: { reason: string }) => {
    calls.push(`BAN:${reason}`);
    await options.beforeBan?.(reason);
    banReason = reason; // Model Discord applying the mutation before the response is observed.
    memberPresent = false;
    await options.onBan?.(reason);
  } };
  const guild = {
    id: pair.guildId,
    ownerId: '687654321012345679',
    members: {
      fetch: async ({ user }: { user: string }) => {
        if (user === pair.actorId) return actor;
        if (banReason || !memberPresent) throw notFound(`/guilds/${pair.guildId}/members/${pair.targetId}`, 10007);
        return target;
      },
      fetchMe: async () => bot,
      unban: async () => { calls.push('UNBAN'); await options.onUnban?.(); banReason = null; memberPresent = false; },
    },
    bans: { fetch: async ({ user }: { user: string }) => {
      if (user !== pair.targetId || !banReason) throw notFound(`/guilds/${pair.guildId}/bans/${pair.targetId}`, 10026);
      return { reason: banReason };
    }, create: async (user: string, { reason }: { reason: string }) => {
      calls.push(`BAN:${reason}`);
      banReason = reason;
      memberPresent = false;
      await options.onBan?.(reason);
    } },
  } as unknown as Guild;
  return {
    guild, calls,
    setActorCanBan(value: boolean) { actorCanBan = value; },
    setMemberPresent(value: boolean) { memberPresent = value; },
    get banReason() { return banReason; },
    clearBanExternally() { banReason = null; memberPresent = false; },
  };
}

async function f7Request(pair: ReturnType<typeof f7Pair>, action: 'BAN' | 'TEMPBAN' | 'UNBAN', operationId = `f7-${randomUUID()}`) {
  await prisma.guildConfig.upsert({ where: { guildId: pair.guildId }, create: { guildId: pair.guildId, updatedBy: pair.actorId, memberActionsEnabled: true }, update: { memberActionsEnabled: true } });
  return submitModerationAction(prisma, {
    guildId: pair.guildId, actorId: pair.actorId, targetId: pair.targetId, action,
    reason: `F7 integration ${action}`, ...(action === 'TEMPBAN' ? { durationMinutes: 10 } : {}), operationId,
  });
}

async function f7Due(id: string) {
  await prisma.moderationCase.update({ where: { id }, data: { expiresAt: new Date(0) } });
  return prisma.moderationCase.findUniqueOrThrow({ where: { id } });
}

async function f7Cleanup(...pairs: Array<ReturnType<typeof f7Pair>>) {
  for (const pair of pairs) {
    await prisma.moderationCase.deleteMany({ where: { guildId: pair.guildId, targetId: pair.targetId } });
    await prisma.guildTargetDecision.deleteMany({ where: { guildId: pair.guildId, targetId: pair.targetId } });
    await prisma.guildConfig.deleteMany({ where: { guildId: pair.guildId } });
  }
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

test('production executor: expired lease during slow Discord call fences old writer', { skip: !integration, timeout: 30_000 }, async () => {
  const row = await seed();
  const gate = deferred();
  const entered = deferred();
  const discord = controlledGuild({ kick: async () => { entered.release(); await gate.promise; } });
  try {
    const running = executeModerationAction({ operationId: row.operationId!, guild: discord.guild, caseRecord: row, store: prisma });
    await waitForBarrier(entered.promise, 'slow Discord call entered');
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

test('production executor: process killed after Discord send leaves an uncertain operation without automatic replay', { skip: !integration, timeout: 30_000 }, async () => {
  const row = await seed();
  const child = fork(fileURLToPath(new URL('./executor-child.mjs', import.meta.url)), [], {
    env: { ...process.env, EXECUTOR_TEST_CASE_ID: row.id }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  try {
    await waitWithTimeout(new Promise<void>((resolve, reject) => {
      child.on('message', message => { if ((message as { stage?: string }).stage === 'discord-request-entered') resolve(); });
      child.once('exit', code => reject(new Error(`Executor exited before Discord send (${code})`)));
    }), 15_000, 'Executor did not reach Discord send within 15 seconds');
    child.kill('SIGKILL');
    await waitWithTimeout(new Promise<void>(resolve => child.once('exit', () => resolve())), 2_000, 'Executor child did not stop after SIGKILL');
    const inflight = await prisma.moderationCase.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(inflight.executionPhase, 'discord_request_inflight');
    await expireLease(row.id);
    assert.equal((await prisma.moderationCase.findUniqueOrThrow({ where: { id: row.id } })).status, 'uncertain');
    const retry = controlledGuild();
    await executeModerationAction({ operationId: row.operationId!, guild: retry.guild, caseRecord: row, store: prisma });
    assert.equal(retry.kicks, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (child.exitCode === null && child.signalCode === null) await waitWithTimeout(new Promise<void>(resolve => child.once('exit', () => resolve())), 2_000, 'Executor child cleanup timed out').catch(() => undefined);
    await prisma.moderationCase.delete({ where: { id: row.id } });
  }
});

test('production expiry: interrupted unban is uncertain and never automatically repeated', { skip: !integration, timeout: 30_000 }, async () => {
  const row = await prisma.moderationCase.create({ data: {
    guildId, actorId, targetId, action: 'TEMPBAN', reason: 'isolated expiry test', status: 'succeeded',
    operationId: `test-${randomUUID()}`, banMarker: 'veyro-case-test', expiresAt: new Date(0), expiryStatus: 'scheduled',
  } });
  const gate = deferred();
  const entered = deferred();
  const discord = controlledGuild({ unban: async () => { entered.release(); await gate.promise; } });
  try {
    const running = expireTemporaryBan({ guild: discord.guild, caseRecord: row, store: prisma });
    await waitForBarrier(entered.promise, 'expiry unban entered');
    await expireLease(row.id, true);
    gate.release(); await running;
    assert.equal((await prisma.moderationCase.findUniqueOrThrow({ where: { id: row.id } })).expiryStatus, 'uncertain');
    await expireTemporaryBan({ guild: discord.guild, caseRecord: row, store: prisma });
    assert.equal(discord.unbans, 1);
  } finally { gate.release(); await prisma.moderationCase.delete({ where: { id: row.id } }); }
});

test('production expiry keeps the original tempban scheduled when a newer BAN request failed', { skip: !integration }, async () => {
  const operationId = `test-${randomUUID()}`;
  const failedOperationId = `test-${randomUUID()}`;
  const row = await prisma.moderationCase.create({ data: {
    guildId, actorId, targetId, action: 'TEMPBAN', reason: 'prior temporary ban', status: 'succeeded', operationId,
    banMarker: 'veyro-case-prior', banGeneration: 1, expiresAt: new Date(0), expiryStatus: 'scheduled',
  } });
  await prisma.guildTargetDecision.create({ data: { guildId, targetId, generation: 2, latestOperationId: failedOperationId, appliedGeneration: 1, appliedOperationId: operationId } });
  await prisma.moderationCase.create({ data: { guildId, actorId, targetId, action: 'BAN', reason: 'failed newer request', status: 'failed', operationId: failedOperationId, banGeneration: 2 } });
  const discord = controlledGuild({ banReason: '[veyro-case-prior]' });
  try {
    await expireTemporaryBan({ guild: discord.guild, caseRecord: row, store: prisma });
    const expiry = await prisma.moderationCase.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(discord.unbans, 1);
    assert.equal(expiry.expiryStatus, 'succeeded');
    const decision = await prisma.guildTargetDecision.findUniqueOrThrow({ where: { guildId_targetId: { guildId, targetId } } });
    assert.equal(decision.generation, 2);
    assert.equal(decision.appliedGeneration, 1);
  } finally {
    await prisma.moderationCase.deleteMany({ where: { operationId: { in: [operationId, failedOperationId] } } });
    await prisma.guildTargetDecision.deleteMany({ where: { guildId, targetId } });
  }
});

test('production BAN success advances applied generation atomically with the dossier', { skip: !integration }, async () => {
  const operationId = `test-${randomUUID()}`;
  const row = await prisma.moderationCase.create({ data: {
    guildId, actorId, targetId, action: 'BAN', reason: 'applied generation integration', status: 'requested', operationId, banGeneration: 1,
  } });
  await prisma.guildTargetDecision.create({ data: { guildId, targetId, generation: 1, latestOperationId: operationId, appliedGeneration: 0 } });
  let bans = 0;
  const discord = controlledGuild({ ban: async () => { bans++; } });
  try {
    await executeModerationAction({ operationId, guild: discord.guild, caseRecord: row, store: prisma });
    const [finalCase, decision] = await Promise.all([
      prisma.moderationCase.findUniqueOrThrow({ where: { id: row.id } }),
      prisma.guildTargetDecision.findUniqueOrThrow({ where: { guildId_targetId: { guildId, targetId } } }),
    ]);
    assert.equal(bans, 1);
    assert.equal(finalCase.status, 'succeeded');
    assert.equal(decision.appliedGeneration, 1);
    assert.equal(decision.appliedOperationId, operationId);
  } finally {
    await prisma.moderationCase.delete({ where: { id: row.id } });
    await prisma.guildTargetDecision.deleteMany({ where: { guildId, targetId } });
  }
});

test('F7 PostgreSQL: explicit failure preserves the old expiry; later decisions advance generations without stale unban', { skip: !integration }, async () => {
  const pair = f7Pair();
  const discord = f7Discord(pair);
  try {
    const first = await f7Request(pair, 'TEMPBAN');
    await executeModerationAction({ operationId: first.operationId!, guild: discord.guild, caseRecord: first, store: prisma });
    const dueFirst = await f7Due(first.id);
    discord.setActorCanBan(false);
    const failed = await f7Request(pair, 'BAN');
    await executeModerationAction({ operationId: failed.operationId!, guild: discord.guild, caseRecord: failed, store: prisma });
    discord.setActorCanBan(true);
    await expireTemporaryBan({ guild: discord.guild, caseRecord: dueFirst, store: prisma });
    const afterFirstExpiry = await prisma.moderationCase.findUniqueOrThrow({ where: { id: first.id } });
    const decisionAfterFailure = await prisma.guildTargetDecision.findUniqueOrThrow({ where: { guildId_targetId: { guildId: pair.guildId, targetId: pair.targetId } } });
    assert.equal((await prisma.moderationCase.findUniqueOrThrow({ where: { id: failed.id } })).status, 'failed');
    assert.equal(failed.banGeneration, 2);
    assert.equal(first.banGeneration, 1);
    assert.equal(afterFirstExpiry.expiryStatus, 'succeeded');
    assert.equal(decisionAfterFailure.generation, 2);
    assert.equal(decisionAfterFailure.appliedGeneration, 1);
    assert.deepEqual(discord.calls.map(call => call.split(':')[0]), ['BAN', 'UNBAN']);
    assert.ok(discord.calls[0]!.includes(first.banMarker!));
    await expireTemporaryBan({ guild: discord.guild, caseRecord: dueFirst, store: prisma });
    assert.equal(discord.calls.filter(call => call === 'UNBAN').length, 1, 'redelivery after a completed expiry is fenced by PostgreSQL');

    const second = await f7Request(pair, 'TEMPBAN');
    discord.setMemberPresent(true); // The simulated user rejoins after the confirmed expiry.
    await executeModerationAction({ operationId: second.operationId!, guild: discord.guild, caseRecord: second, store: prisma });
    const dueSecond = await f7Due(second.id);
    const permanent = await f7Request(pair, 'BAN');
    await executeModerationAction({ operationId: permanent.operationId!, guild: discord.guild, caseRecord: permanent, store: prisma });
    await expireTemporaryBan({ guild: discord.guild, caseRecord: dueSecond, store: prisma });
    const [secondExpiry, decisionAfterPermanent] = await Promise.all([
      prisma.moderationCase.findUniqueOrThrow({ where: { id: second.id } }),
      prisma.guildTargetDecision.findUniqueOrThrow({ where: { guildId_targetId: { guildId: pair.guildId, targetId: pair.targetId } } }),
    ]);
    assert.equal(secondExpiry.expiryStatus, 'superseded');
    assert.equal(decisionAfterPermanent.generation, 4);
    assert.equal(decisionAfterPermanent.appliedGeneration, 4);
    assert.deepEqual(discord.calls.map(call => call.split(':')[0]), ['BAN', 'UNBAN', 'BAN']);
    assert.ok(discord.calls[2]!.includes(second.banMarker!));
    assert.equal((await prisma.moderationCase.findUniqueOrThrow({ where: { id: permanent.id } })).status, 'succeeded');
  } finally { await f7Cleanup(pair); }
});

test('F7 PostgreSQL: expiry defers across an in-flight newer decision using synchronization barriers', { skip: !integration, timeout: 30_000 }, async () => {
  const pair = f7Pair();
  const entered = deferred();
  const release = deferred();
  const discord = f7Discord(pair, { onUnban: async () => { entered.release(); await release.promise; } });
  let running: Promise<void> | undefined;
  try {
    const first = await f7Request(pair, 'TEMPBAN');
    await executeModerationAction({ operationId: first.operationId!, guild: discord.guild, caseRecord: first, store: prisma });
    const due = await f7Due(first.id);
    const newer = await f7Request(pair, 'UNBAN');
    running = executeModerationAction({ operationId: newer.operationId!, guild: discord.guild, caseRecord: newer, store: prisma });
    void running.catch(() => undefined);
    await waitForBarrier(entered.promise, 'newer decision unban entered');
    await expireTemporaryBan({ guild: discord.guild, caseRecord: due, store: prisma });
    assert.equal((await prisma.moderationCase.findUniqueOrThrow({ where: { id: first.id } })).expiryStatus, 'scheduled');
    assert.equal((await prisma.moderationCase.findUniqueOrThrow({ where: { id: newer.id } })).status, 'running');
    assert.equal(discord.calls.filter(call => call === 'UNBAN').length, 1, 'only the newer UNBAN call is in flight; expiry has not issued another');
    release.release();
    await running;
    const decision = await prisma.guildTargetDecision.findUniqueOrThrow({ where: { guildId_targetId: { guildId: pair.guildId, targetId: pair.targetId } } });
    assert.equal(decision.generation, 2);
    assert.equal(decision.appliedGeneration, 2);
    assert.equal(newer.banGeneration, 2);
    await expireTemporaryBan({ guild: discord.guild, caseRecord: await f7Due(first.id), store: prisma });
    assert.equal((await prisma.moderationCase.findUniqueOrThrow({ where: { id: first.id } })).expiryStatus, 'superseded');
    assert.deepEqual(discord.calls.map(call => call.split(':')[0]), ['BAN', 'UNBAN']);
  } finally { release.release(); await running?.catch(() => undefined); await f7Cleanup(pair); }
});

test('F7 PostgreSQL: an uncertain newer decision quarantines expiry even while Discord retains the original marker', { skip: !integration, timeout: 30_000 }, async () => {
  const pair = f7Pair();
  let loseNewUnbanBeforeApply = false;
  const discord = f7Discord(pair, { onUnban: async () => { if (loseNewUnbanBeforeApply) throw new Error('simulated response loss before Discord applies the new UNBAN'); } });
  try {
    const first = await f7Request(pair, 'TEMPBAN');
    await executeModerationAction({ operationId: first.operationId!, guild: discord.guild, caseRecord: first, store: prisma });
    const due = await f7Due(first.id);
    const originalMarker = discord.banReason;
    assert.ok(originalMarker?.includes(`[${first.banMarker}]`));

    const later = await f7Request(pair, 'UNBAN');
    loseNewUnbanBeforeApply = true;
    await executeModerationAction({ operationId: later.operationId!, guild: discord.guild, caseRecord: later, store: prisma });
    assert.equal((await prisma.moderationCase.findUniqueOrThrow({ where: { id: later.id } })).status, 'uncertain');
    assert.equal(discord.banReason, originalMarker, 'uncertain simulated request leaves Discord on the initial marker');

    await expireTemporaryBan({ guild: discord.guild, caseRecord: due, store: prisma });
    assert.equal((await prisma.moderationCase.findUniqueOrThrow({ where: { id: first.id } })).expiryStatus, 'uncertain');
    assert.equal(discord.calls.filter(call => call === 'UNBAN').length, 1, 'expiry must not send an additional unban even though the old marker matches');
    assert.deepEqual(discord.calls.map(call => call.split(':')[0]), ['BAN', 'UNBAN']);
    assert.equal(discord.banReason, originalMarker);
  } finally { await f7Cleanup(pair); }
});

test('F7 PostgreSQL: last expiry decision check sees a request admitted after the initial check', { skip: !integration, timeout: 30_000 }, async () => {
  const pair = f7Pair();
  const discord = f7Discord(pair);
  let reads = 0;
  let later: Awaited<ReturnType<typeof f7Request>> | undefined;
  const store = {
    moderationCase: prisma.moderationCase,
    guildTargetDecision: {
      findUnique: async (args: Parameters<typeof prisma.guildTargetDecision.findUnique>[0]) => {
        const observed = await prisma.guildTargetDecision.findUnique(args);
        reads++;
        if (reads === 1) later = await f7Request(pair, 'BAN');
        return observed;
      },
      updateMany: prisma.guildTargetDecision.updateMany,
    },
  };
  try {
    const first = await f7Request(pair, 'TEMPBAN');
    await executeModerationAction({ operationId: first.operationId!, guild: discord.guild, caseRecord: first, store: prisma });
    const due = await f7Due(first.id);

    await expireTemporaryBan({ guild: discord.guild, caseRecord: due, store: store as never });
    assert.ok(later, 'the barrier admitted a newer decision after the initial decision read');
    assert.equal(reads, 2, 'expiry performed both the initial and final decision reads');
    assert.equal((await prisma.moderationCase.findUniqueOrThrow({ where: { id: later!.id } })).status, 'requested');
    assert.equal((await prisma.moderationCase.findUniqueOrThrow({ where: { id: first.id } })).expiryStatus, 'scheduled');
    assert.equal(discord.calls.filter(call => call === 'UNBAN').length, 0, 'final check must prevent the risky mutation');
  } finally { await f7Cleanup(pair); }
});

test('F7 PostgreSQL: BAN acknowledged before a newer admission is finalized without overwriting a newer applied generation', { skip: !integration, timeout: 30_000 }, async () => {
  const pair = f7Pair();
  const entered = deferred();
  const release = deferred();
  const discord = f7Discord(pair);
  let blocked = false;
  let first: Awaited<ReturnType<typeof f7Request>> | undefined;
  const store = {
    moderationCase: prisma.moderationCase,
    guildTargetDecision: prisma.guildTargetDecision,
    $transaction: (callback: (tx: unknown) => Promise<void>) => prisma.$transaction(async tx => callback({
      moderationCase: tx.moderationCase,
      guildTargetDecision: {
        findUnique: tx.guildTargetDecision.findUnique.bind(tx.guildTargetDecision),
        updateMany: async (args: Parameters<typeof tx.guildTargetDecision.updateMany>[0]) => {
          const generationFilter = args.where.generation as { gte?: number } | undefined;
          if (!blocked && first && generationFilter?.gte === first.banGeneration) {
            blocked = true;
            entered.release();
            await release.promise;
          }
          return tx.guildTargetDecision.updateMany(args);
        },
      },
    }) as never),
  };
  let running: Promise<void> | undefined;
  try {
    first = await f7Request(pair, 'BAN');
    running = executeModerationAction({ operationId: first.operationId!, guild: discord.guild, caseRecord: first, store: store as never });
    void running.catch(() => undefined);
    await waitForBarrier(entered.promise, 'first BAN final transaction reached decision write');
    assert.ok(discord.calls.some(call => call.startsWith('BAN:')), 'Discord acknowledged the first BAN before finalization');

    const newer = await f7Request(pair, 'BAN');
    await executeModerationAction({ operationId: newer.operationId!, guild: discord.guild, caseRecord: newer, store: prisma });
    const afterNewer = await prisma.guildTargetDecision.findUniqueOrThrow({ where: { guildId_targetId: { guildId: pair.guildId, targetId: pair.targetId } } });
    assert.deepEqual([afterNewer.generation, afterNewer.appliedGeneration, afterNewer.appliedOperationId], [2, 2, newer.operationId]);

    release.release();
    await waitForBarrier(running, 'first BAN final transaction completed');
    const [firstFinal, decision] = await Promise.all([
      prisma.moderationCase.findUniqueOrThrow({ where: { id: first.id } }),
      prisma.guildTargetDecision.findUniqueOrThrow({ where: { guildId_targetId: { guildId: pair.guildId, targetId: pair.targetId } } }),
    ]);
    assert.equal(firstFinal.status, 'succeeded', 'confirmed first mutation is durably recorded');
    assert.deepEqual([decision.generation, decision.appliedGeneration, decision.appliedOperationId], [2, 2, newer.operationId], 'older completion cannot overwrite the newer applied decision');
    assert.equal(discord.calls.filter(call => call.startsWith('BAN:')).length, 1, 'the second BAN observes the existing ban and does not mutate again');
  } finally { release.release(); await running?.catch(() => undefined); await f7Cleanup(pair); }
});

test('F7 PostgreSQL: uncertain newer decision quarantines only its guild expiry and redelivery does not mutate again', { skip: !integration }, async () => {
  const pairA = f7Pair();
  const pairB = { ...f7Pair(), targetId: pairA.targetId };
  let loseNewBanResponse = false;
  const discordA = f7Discord(pairA, { onBan: async () => { if (loseNewBanResponse) throw new Error('simulated response lost after Discord applied BAN'); } });
  const discordB = f7Discord(pairB);
  try {
    const oldA = await f7Request(pairA, 'TEMPBAN');
    const oldB = await f7Request(pairB, 'TEMPBAN');
    await executeModerationAction({ operationId: oldA.operationId!, guild: discordA.guild, caseRecord: oldA, store: prisma });
    await executeModerationAction({ operationId: oldB.operationId!, guild: discordB.guild, caseRecord: oldB, store: prisma });
    const dueA = await f7Due(oldA.id);
    const dueB = await f7Due(oldB.id);
    // Simulate an external unban and a user who has left, so the subsequent BAN exercises bans.create.
    discordA.clearBanExternally();
    const uncertain = await f7Request(pairA, 'BAN');
    loseNewBanResponse = true;
    await executeModerationAction({ operationId: uncertain.operationId!, guild: discordA.guild, caseRecord: uncertain, store: prisma });
    await executeModerationAction({ operationId: uncertain.operationId!, guild: discordA.guild, caseRecord: uncertain, store: prisma });
    assert.equal((await prisma.moderationCase.findUniqueOrThrow({ where: { id: uncertain.id } })).status, 'uncertain');
    await expireTemporaryBan({ guild: discordA.guild, caseRecord: dueA, store: prisma });
    await expireTemporaryBan({ guild: discordB.guild, caseRecord: dueB, store: prisma });
    assert.equal((await prisma.moderationCase.findUniqueOrThrow({ where: { id: oldA.id } })).expiryStatus, 'uncertain');
    assert.equal((await prisma.moderationCase.findUniqueOrThrow({ where: { id: oldB.id } })).expiryStatus, 'succeeded');
    assert.deepEqual(discordA.calls.map(call => call.split(':')[0]), ['BAN', 'BAN']);
    assert.deepEqual(discordB.calls.map(call => call.split(':')[0]), ['BAN', 'UNBAN']);
    assert.ok(discordA.calls[0]!.includes(oldA.banMarker!));
    assert.ok(!discordA.calls[1]!.includes(oldA.banMarker!));
    assert.notEqual(pairA.guildId, pairB.guildId);
    const decisionA = await prisma.guildTargetDecision.findUniqueOrThrow({ where: { guildId_targetId: { guildId: pairA.guildId, targetId: pairA.targetId } } });
    const decisionB = await prisma.guildTargetDecision.findUniqueOrThrow({ where: { guildId_targetId: { guildId: pairB.guildId, targetId: pairB.targetId } } });
    assert.deepEqual([decisionA.generation, decisionA.appliedGeneration], [2, 1]);
    assert.deepEqual([decisionB.generation, decisionB.appliedGeneration], [1, 1]);
  } finally { await f7Cleanup(pairA, pairB); }
});

test('F7 PostgreSQL: Discord BAN success followed by failed final transaction reconciles uncertain without replay', { skip: !integration }, async () => {
  const pair = f7Pair();
  const discord = f7Discord(pair);
  try {
    const old = await f7Request(pair, 'TEMPBAN');
    await executeModerationAction({ operationId: old.operationId!, guild: discord.guild, caseRecord: old, store: prisma });
    const due = await f7Due(old.id);
    // Simulate the ban being removed externally before a new BAN of a non-member.
    discord.clearBanExternally();
    const newer = await f7Request(pair, 'BAN');
    const store = {
      moderationCase: prisma.moderationCase,
      guildTargetDecision: prisma.guildTargetDecision,
      $transaction: (callback: (tx: unknown) => Promise<void>) => prisma.$transaction(async tx => callback({
        moderationCase: { updateMany: async (args: Parameters<typeof prisma.moderationCase.updateMany>[0]) => {
          if (args.where.id === newer.id && args.data.status === 'succeeded') throw new Error('simulated PostgreSQL failure after Discord success');
          return tx.moderationCase.updateMany(args);
        } },
        guildTargetDecision: tx.guildTargetDecision,
      }) as never),
    };
    await assert.rejects(executeModerationAction({ operationId: newer.operationId!, guild: discord.guild, caseRecord: newer, store: store as never }), /simulated PostgreSQL failure/);
    assert.equal(discord.calls.filter(call => call.startsWith('BAN:')).length, 2, 'one TEMPBAN plus exactly one newer BAN request');
    const inflight = await prisma.moderationCase.findUniqueOrThrow({ where: { id: newer.id } });
    assert.equal(inflight.status, 'running');
    assert.equal(inflight.executionPhase, 'discord_request_inflight');
    const beforeRecovery = await prisma.guildTargetDecision.findUniqueOrThrow({ where: { guildId_targetId: { guildId: pair.guildId, targetId: pair.targetId } } });
    assert.deepEqual([beforeRecovery.generation, beforeRecovery.appliedGeneration], [2, 1]);
    assert.ok(discord.calls[0]!.includes(old.banMarker!));
    assert.ok(!discord.calls[1]!.includes(old.banMarker!));
    await expireLease(newer.id);
    assert.equal((await prisma.moderationCase.findUniqueOrThrow({ where: { id: newer.id } })).status, 'uncertain');
    const afterRecovery = await prisma.guildTargetDecision.findUniqueOrThrow({ where: { guildId_targetId: { guildId: pair.guildId, targetId: pair.targetId } } });
    assert.deepEqual([afterRecovery.generation, afterRecovery.appliedGeneration], [2, 1]);
    await executeModerationAction({ operationId: newer.operationId!, guild: discord.guild, caseRecord: newer, store: prisma });
    await expireTemporaryBan({ guild: discord.guild, caseRecord: due, store: prisma });
    assert.equal((await prisma.moderationCase.findUniqueOrThrow({ where: { id: old.id } })).expiryStatus, 'uncertain');
    assert.equal((await prisma.moderationCase.findUniqueOrThrow({ where: { id: newer.id } })).status, 'uncertain');
    assert.equal(discord.calls.filter(call => call.startsWith('BAN:')).length, 2, 'restart reconciliation and redelivery must not repeat the ambiguous mutation');
    assert.equal(discord.calls.filter(call => call === 'UNBAN').length, 0);
  } finally { await f7Cleanup(pair); }
});
