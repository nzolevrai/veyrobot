import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { prisma } from '@veyrobot/db';

const sourceUrl = process.env.DATABASE_URL ?? '';
if (!sourceUrl.includes('veyrobot_arch_bench')) throw new Error('Use the isolated veyrobot_arch_bench source database.');
const id = randomUUID().replaceAll('-', '').slice(0, 12);
const targetDb = `veyrobot_restore_quarantine_${id}`;
const archiveDir = await mkdtemp(path.join(os.tmpdir(), 'veyrobot-restore-proof-'));
const archivePath = path.join(archiveDir, 'restore.dump');
const guildId = '777777777777777777';
const actorId = '123456789012345678';
const requestedId = `restore_${id}_requested`;
const runningId = `restore_${id}_running`;
const expiryId = `restore_${id}_expiry`;
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
  const existing = await prisma.moderationCase.count({ where: { operationId: { in: [requestedId, runningId, expiryId] } } });
  if (existing) throw new Error('Generated operation IDs already exist.');
  await prisma.moderationCase.createMany({ data: [
    { guildId, actorId, targetId: '888888888888888881', action: 'KICK', reason: 'restore proof requested', status: 'requested', operationId: requestedId },
    { guildId, actorId, targetId: '888888888888888882', action: 'BAN', reason: 'restore proof running', status: 'running', operationId: runningId, startedAt: new Date(), claimToken: randomUUID(), claimLeaseUntil: new Date(Date.now() + 120_000), executionPhase: 'discord_request_inflight' },
    { guildId, actorId, targetId: '888888888888888883', action: 'TEMPBAN', reason: 'restore proof expiry', status: 'succeeded', operationId: expiryId, banMarker: `veyro-case-${expiryId}`, banGeneration: 1, expiryStatus: 'scheduled', expiresAt: new Date(Date.now() - 60_000) },
  ] });
  // Back up while one operation is requested, one in-flight, and an expiry due.
  const dump = spawnSync('docker', ['compose', 'exec', '-T', 'postgres', 'pg_dump', '-U', 'sentinelle', '-Fc', '-d', 'veyrobot_arch_bench'], { cwd: process.cwd(), encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  if (dump.status !== 0) throw new Error(`pg_dump failed (${dump.status}): ${dump.stderr.toString('utf8').slice(0, 500)}`);
  await writeFile(archivePath, dump.stdout);
  // Simulate successful Discord work after the dump. No Discord client is started.
  await prisma.moderationCase.updateMany({ where: { operationId: requestedId }, data: { status: 'succeeded', completedAt: new Date(), result: 'simulated external action after backup' } });
  await prisma.moderationCase.updateMany({ where: { operationId: runningId }, data: { status: 'succeeded', completedAt: new Date(), result: 'simulated external action after backup' } });
  await prisma.moderationCase.updateMany({ where: { operationId: expiryId }, data: { expiryStatus: 'succeeded', unbannedAt: new Date(), expiryResult: 'simulated external expiry after backup' } });
  docker(['exec', '-T', 'postgres', 'createdb', '-U', 'sentinelle', targetDb]);
  const restore = spawnSync('docker', ['compose', 'exec', '-T', 'postgres', 'pg_restore', '-U', 'sentinelle', '-d', targetDb, '--no-owner'], { cwd: process.cwd(), input: await readFile(archivePath), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (restore.status !== 0) throw new Error(`pg_restore failed (${restore.status}): ${restore.stderr.slice(0, 500)}`);
  const quarantineOutput = runNode(['--import', 'tsx', 'packages/db/src/restore-quarantine-cli.ts'], { DATABASE_URL: targetUrl.toString(), RESTORE_QUARANTINE_CONFIRM: '1' });
  pool = new Pool({ connectionString: targetUrl.toString(), max: 2 });
  const rows = await pool.query('SELECT "operationId", status, "expiryStatus" FROM "ModerationCase" WHERE "operationId" = ANY($1::text[]) ORDER BY "operationId"', [[requestedId, runningId, expiryId]]);
  const states = Object.fromEntries(rows.rows.map(row => [row.operationId, { status: row.status, expiryStatus: row.expiryStatus }]));
  if (states[requestedId]?.status !== 'uncertain' || states[runningId]?.status !== 'uncertain' || states[expiryId]?.expiryStatus !== 'uncertain') throw new Error(`Restored operations not fully quarantined: ${JSON.stringify(states)}`);
  const checkCode = `import { prisma } from '@veyrobot/db'; import { createDispatcher } from './dist/dispatcher.js'; const adds=[]; const q={getBackend:()=>({client:Promise.resolve({status:'ready'})}), add:async(...x)=>adds.push(x)}; const dispatch=createDispatcher(prisma,q,()=>true,()=>{}); await new Promise(r=>setTimeout(r,0)); await dispatch(); await prisma.$disconnect(); if(adds.length) process.exitCode=3; console.log(JSON.stringify({publishedAfterQuarantine:adds.length}));`;
  const dispatcherCheck = runNode(['--input-type=module', '-e', checkCode], { DATABASE_URL: targetUrl.toString() }, path.join(process.cwd(), 'apps', 'bot'));
  console.log(JSON.stringify({ runId: id, scope: 'pg_dump/pg_restore isolated scenario; simulated Discord state changes only; no bot or Discord client', backupState: { requested: true, running: true, dueExpiry: true }, simulatedAfterBackup: true, restoredStates: states, quarantineOutput: quarantineOutput.trim(), dispatcherCheck: dispatcherCheck.trim(), targetDatabase: targetDb }));
} finally {
  await pool?.end();
  await prisma.moderationCase.deleteMany({ where: { operationId: { in: [requestedId, runningId, expiryId] } } }).catch(() => undefined);
  await prisma.$disconnect();
  docker(['exec', '-T', 'postgres', 'dropdb', '-U', 'sentinelle', '--if-exists', targetDb]);
  await rm(archiveDir, { recursive: true, force: true });
}
