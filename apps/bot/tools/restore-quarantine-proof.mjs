import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { prisma } from '@veyrobot/db';

const sourceUrl = process.env.DATABASE_URL ?? '';
const sourceDatabase = decodeURIComponent(new URL(sourceUrl).pathname.slice(1));
if (!sourceDatabase.startsWith('veyrobot_arch_bench_')) throw new Error('Use a dedicated isolated database named veyrobot_arch_bench_<run-id>.');
const id = randomUUID().replaceAll('-', '').slice(0, 12);
const recoveryEpoch = randomBytes(32).toString('hex');
const targetDb = `veyrobot_restore_quarantine_${id}`;
const archiveDir = await mkdtemp(path.join(os.tmpdir(), 'veyrobot-restore-proof-'));
const archivePath = path.join(archiveDir, 'restore.dump');
const guildId = '777777777777777777';
const actorId = '123456789012345678';
const requestedId = `restore_${id}_requested`;
const runningId = `restore_${id}_running`;
const expiryId = `restore_${id}_expiry`;
const futureExpiryId = `restore_${id}_future`;
const runningExpiryId = `restore_${id}_running_expiry`;
const replacementId = `restore_${id}_replacement`;
const sessionGrantIdHash = createHash('sha256').update(randomUUID()).digest('hex');
const replacedTargetId = '888888888888888884';
const targetUrl = new URL(sourceUrl);
targetUrl.pathname = `/${targetDb}`;
targetUrl.searchParams.delete('schema');
function docker(args, input) {
  const result = spawnSync('docker', ['compose', ...args], { cwd: process.cwd(), input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`docker compose ${args.join(' ')} failed (${result.status}): ${result.stderr.slice(0, 500)}`);
  return result.stdout;
}
function runNode(args, env, cwd = process.cwd()) {
  const result = spawnSync(process.execPath, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`node ${args.join(' ')} failed (${result.status}): ${result.stderr.slice(0, 500)}`);
  return result.stdout;
}

let pool;
try {
  const existing = await prisma.moderationCase.count({ where: { operationId: { in: [requestedId, runningId, expiryId, futureExpiryId, runningExpiryId, replacementId] } } });
  if (existing) throw new Error('Generated operation IDs already exist.');
  await prisma.moderationCase.createMany({ data: [
    { guildId, actorId, targetId: '888888888888888881', action: 'KICK', reason: 'restore proof requested', status: 'requested', operationId: requestedId },
    { guildId, actorId, targetId: '888888888888888882', action: 'BAN', reason: 'restore proof running', status: 'running', operationId: runningId, startedAt: new Date(), claimToken: randomUUID(), claimLeaseUntil: new Date(Date.now() + 120_000), executionPhase: 'discord_request_inflight' },
    { guildId, actorId, targetId: '888888888888888883', action: 'TEMPBAN', reason: 'restore proof expiry', status: 'succeeded', operationId: expiryId, banMarker: `veyro-case-${expiryId}`, banGeneration: 1, expiryStatus: 'scheduled', expiresAt: new Date(Date.now() - 60_000) },
    { guildId, actorId, targetId: replacedTargetId, action: 'TEMPBAN', reason: 'restore proof future expiry', status: 'succeeded', operationId: futureExpiryId, banMarker: `veyro-case-${futureExpiryId}`, banGeneration: 1, expiryStatus: 'scheduled', expiresAt: new Date(Date.now() + 60 * 60_000) },
    { guildId, actorId, targetId: '888888888888888885', action: 'TEMPBAN', reason: 'restore proof running expiry', status: 'succeeded', operationId: runningExpiryId, banMarker: `veyro-case-${runningExpiryId}`, banGeneration: 1, expiryStatus: 'running', expiryClaimToken: randomUUID(), expiryLeaseUntil: new Date(Date.now() + 120_000), expiryResult: 'discord_request_inflight', expiresAt: new Date(Date.now() - 30_000) },
  ] });
  await prisma.guildTargetDecision.upsert({ where: { guildId_targetId: { guildId, targetId: replacedTargetId } }, create: { guildId, targetId: replacedTargetId, generation: 1, latestOperationId: futureExpiryId, appliedGeneration: 1, appliedOperationId: futureExpiryId }, update: { generation: 1, latestOperationId: futureExpiryId, appliedGeneration: 1, appliedOperationId: futureExpiryId } });
  await prisma.sessionGrant.create({ data: { idHash: sessionGrantIdHash, expiresAt: new Date(Date.now() + 60 * 60_000) } });
  // Back up while one operation is requested, one in-flight, and an expiry due.
  const dump = spawnSync('docker', ['compose', 'exec', '-T', 'postgres', 'pg_dump', '-U', 'sentinelle', '-Fc', '-d', sourceDatabase], { cwd: process.cwd(), encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  if (dump.status !== 0) throw new Error(`pg_dump failed (${dump.status}): ${dump.stderr.toString('utf8').slice(0, 500)}`);
  await writeFile(archivePath, dump.stdout);
  // Simulate successful Discord work after the dump. No Discord client is started.
  await prisma.moderationCase.updateMany({ where: { operationId: requestedId }, data: { status: 'succeeded', completedAt: new Date(), result: 'simulated external action after backup' } });
  await prisma.moderationCase.updateMany({ where: { operationId: runningId }, data: { status: 'succeeded', completedAt: new Date(), result: 'simulated external action after backup' } });
  await prisma.moderationCase.updateMany({ where: { operationId: expiryId }, data: { expiryStatus: 'succeeded', unbannedAt: new Date(), expiryResult: 'simulated external expiry after backup' } });
  await prisma.moderationCase.updateMany({ where: { operationId: runningExpiryId }, data: { expiryStatus: 'succeeded', unbannedAt: new Date(), expiryResult: 'simulated external expiry after backup' } });
  await prisma.moderationCase.create({ data: { guildId, actorId, targetId: replacedTargetId, action: 'BAN', reason: 'restore proof permanent replacement', status: 'succeeded', operationId: replacementId, banGeneration: 2, completedAt: new Date(), result: 'simulated permanent ban after backup' } });
  await prisma.guildTargetDecision.update({ where: { guildId_targetId: { guildId, targetId: replacedTargetId } }, data: { generation: 2, latestOperationId: replacementId, appliedGeneration: 2, appliedOperationId: replacementId } });
  docker(['exec', '-T', 'postgres', 'createdb', '-U', 'sentinelle', targetDb]);
  const restore = spawnSync('docker', ['compose', 'exec', '-T', 'postgres', 'pg_restore', '-U', 'sentinelle', '-d', targetDb, '--no-owner'], { cwd: process.cwd(), input: await readFile(archivePath), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (restore.status !== 0) throw new Error(`pg_restore failed (${restore.status}): ${restore.stderr.slice(0, 500)}`);
  const quarantineOutput = runNode(['--import', 'tsx', 'packages/db/src/restore-quarantine-cli.ts'], { DATABASE_URL: targetUrl.toString(), RESTORE_QUARANTINE_CONFIRM: '1', VEYROBOT_RECOVERY_EPOCH: recoveryEpoch });
  pool = new Pool({ connectionString: targetUrl.toString(), max: 2 });
  const restoredGrant = await pool.query('SELECT "revokedAt" FROM "SessionGrant" WHERE "idHash" = $1', [sessionGrantIdHash]);
  if (restoredGrant.rows.length !== 1 || restoredGrant.rows[0].revokedAt === null) throw new Error('Restored active session grant was not revoked before application startup.');
  const rows = await pool.query('SELECT "operationId", status, "expiryStatus" FROM "ModerationCase" WHERE "operationId" = ANY($1::text[]) ORDER BY "operationId"', [[requestedId, runningId, expiryId, futureExpiryId, runningExpiryId]]);
  const states = Object.fromEntries(rows.rows.map(row => [row.operationId, { status: row.status, expiryStatus: row.expiryStatus }]));
  if (states[requestedId]?.status !== 'uncertain' || states[runningId]?.status !== 'uncertain' || states[expiryId]?.expiryStatus !== 'uncertain' || states[futureExpiryId]?.expiryStatus !== 'uncertain' || states[runningExpiryId]?.expiryStatus !== 'uncertain') throw new Error(`Restored operations not fully quarantined: ${JSON.stringify(states)}`);
  const checkCode = `import { prisma } from '@veyrobot/db'; import { createDispatcher } from './dist/dispatcher.js'; const adds=[]; const q={getBackend:()=>({client:Promise.resolve({status:'ready'})}), add:async(...x)=>adds.push(x)}; const dispatch=createDispatcher(prisma,q,()=>true,()=>{}); await new Promise(r=>setTimeout(r,0)); await dispatch(); await prisma.$disconnect(); if(adds.length) process.exitCode=3; console.log(JSON.stringify({publishedAfterQuarantine:adds.length}));`;
  const dispatcherCheck = runNode(['--input-type=module', '-e', checkCode], { DATABASE_URL: targetUrl.toString() }, path.join(process.cwd(), 'apps', 'bot'));
  console.log(JSON.stringify({ runId: id, scope: 'pg_dump/pg_restore isolated scenario; simulated Discord state changes only; no bot or Discord client', backupState: { requested: true, running: true, dueExpiry: true, futureExpiryBeforePermanentBan: true, runningExpiry: true, activeSessionGrant: true }, simulatedAfterBackup: { operationExecution: true, permanentBanReplacedTemporaryBan: true, runningExpiryExecuted: true }, restoredStates: states, restoredActiveSessionGrantRevoked: true, quarantineOutput: quarantineOutput.trim(), dispatcherCheck: dispatcherCheck.trim(), targetDatabase: targetDb }));
} finally {
  await pool?.end();
  await prisma.moderationCase.deleteMany({ where: { operationId: { in: [requestedId, runningId, expiryId, futureExpiryId, runningExpiryId, replacementId] } } }).catch(() => undefined);
  await prisma.guildTargetDecision.deleteMany({ where: { guildId, targetId: replacedTargetId } }).catch(() => undefined);
  await prisma.sessionGrant.deleteMany({ where: { idHash: sessionGrantIdHash } }).catch(() => undefined);
  await prisma.$disconnect();
  docker(['exec', '-T', 'postgres', 'dropdb', '-U', 'sentinelle', '--if-exists', targetDb]);
  await rm(archiveDir, { recursive: true, force: true });
}
