import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const root = process.cwd();
const id = createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 12);
const project = `veyrobot-backup-proof-${id}`;
const sourceDb = `veyrobot_backup_source_${id}`;
const targetDb = `veyrobot_backup_restore_${id}`;
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'veyrobot-backup-restore-'));
const composeFile = path.join(tempRoot, 'compose.test.yaml');
const backupDirectory = path.join(tempRoot, 'backups');
const composePrefix = ['compose', '--project-name', project, '-f', composeFile];
const pgUser = 'backup_test';
const timings = {};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) {
    const label = path.basename(command);
    const detail = String(result.stderr ?? '').replace(/:\/\/[^/@\s]+@/g, '://[redacted]@').slice(0, 1500);
    throw new Error(`${label} ${args.slice(0, 2).join(' ')} failed with exit ${result.status ?? 'unavailable'}${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

function packageManager(args, env) {
  if (process.platform === 'win32') {
    const command = `corepack pnpm ${args.map(argument => `'${String(argument).replaceAll("'", "''")}'`).join(' ')}`;
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { env });
  }
  return run('corepack', ['pnpm', ...args], { env });
}

function node(args, env, cwd = root) {
  return run(process.execPath, args, { env, cwd });
}

function docker(args) {
  return run('docker', args);
}

let composeStarted = false;
let targetCreated = false;
try {
  await writeFile(composeFile, `services:\n  postgres:\n    image: postgres:17-alpine\n    environment:\n      POSTGRES_USER: ${pgUser}\n      POSTGRES_DB: ${sourceDb}\n      POSTGRES_HOST_AUTH_METHOD: trust\n    ports:\n      - "127.0.0.1::5432"\n`);
  composeStarted = true;
  await docker([...composePrefix, 'up', '-d', 'postgres']);
  const portLine = docker([...composePrefix, 'port', 'postgres', '5432']).trim().split(/\r?\n/).at(-1);
  const port = Number(portLine.slice(portLine.lastIndexOf(':') + 1));
  assert.ok(Number.isInteger(port) && port > 0, 'isolated PostgreSQL port is assigned');
  const databaseUrl = `postgresql://${pgUser}@127.0.0.1:${port}/${sourceDb}?schema=public`;
  const sourceEnv = { ...process.env, DATABASE_URL: databaseUrl };
  packageManager(['db:generate'], sourceEnv);
  packageManager(['db:migrate'], sourceEnv);
  const seed = `import { prisma } from './packages/db/src/index.ts';
const guildId = '777777777777777777';
const actorId = '123456789012345678';
const warningId = 'backup_${id}_warning';
const tempbanId = 'backup_${id}_tempban';
const requestedId = 'backup_${id}_requested';
const runningId = 'backup_${id}_running';
await prisma.guildConfig.create({ data: { guildId, version: 8, updatedBy: actorId, warningsEnabled: true, memberActionsEnabled: true, language: 'fr', timeZone: 'Europe/Paris' } });
await prisma.moderationCase.createMany({ data: [
  { operationId: warningId, guildId, actorId, targetId: '888888888888888881', action: 'WARN', reason: 'backup restore fixture', status: 'succeeded', result: 'warning persisted' },
  { operationId: tempbanId, guildId, actorId, targetId: '888888888888888882', action: 'TEMPBAN', reason: 'temporary ban fixture', status: 'succeeded', banMarker: 'veyro-case-${id}', banGeneration: 1, expiryStatus: 'scheduled', expiresAt: new Date(Date.now() + 3600000), result: 'ban persisted' },
  { operationId: requestedId, guildId, actorId, targetId: '888888888888888883', action: 'BAN', reason: 'pre-snapshot request fixture', status: 'requested', banGeneration: 2 },
  { operationId: runningId, guildId, actorId, targetId: '888888888888888884', action: 'KICK', reason: 'in-flight fixture', status: 'running', startedAt: new Date(), claimToken: 'fixture-claim-${id}', claimLeaseUntil: new Date(Date.now() + 120000), executionPhase: 'discord_request_inflight' }
] });
await prisma.guildTargetDecision.create({ data: { guildId, targetId: '888888888888888882', generation: 1, latestOperationId: tempbanId, appliedGeneration: 1, appliedOperationId: tempbanId } });
await prisma.sessionGrant.create({ data: { idHash: '${createHash('sha256').update(`session-${id}`).digest('hex')}', expiresAt: new Date(Date.now() + 3600000) } });
await prisma.$disconnect();`;
  node(['--import', 'tsx', '--input-type=module', '-e', seed], sourceEnv);

  const backupEnv = { ...process.env, VEYROBOT_BACKUP_DIR: backupDirectory };
  const backupStarted = performance.now();
  const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  const backupOutput = run(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'deploy/backup-postgres.ps1', '-ComposeFile', composeFile, '-ComposeEnvFile', '', '-ComposeProjectName', project], { env: backupEnv });
  timings.backupMs = +(performance.now() - backupStarted).toFixed(1);
  const archiveMatch = backupOutput.match(/Backup complete: (.+\.backup) \(SHA-256 ([a-f0-9]{64}); completion sidecar: (.+\.backup\.sha256)\)/);
  assert.ok(archiveMatch, 'production backup script reports a published archive only after validation');
  const [, archivePath, displayedHash, checksumPath] = archiveMatch;
  assert.equal(path.dirname(archivePath), backupDirectory);
  assert.equal(path.dirname(checksumPath), backupDirectory);
  const archive = await readFile(archivePath);
  const checksum = createHash('sha256').update(archive).digest('hex');
  assert.equal(checksum, displayedHash);
  assert.ok((await readFile(checksumPath, 'utf8')).startsWith(`${checksum} *${path.basename(archivePath)}`));

  const containerId = docker([...composePrefix, 'ps', '-q', 'postgres']).trim();
  assert.ok(containerId, 'test PostgreSQL container remains available for restore');
  const truncatedPath = path.join(tempRoot, 'truncated.backup');
  await writeFile(truncatedPath, archive.subarray(0, Math.max(1, Math.floor(archive.length / 2))));
  const truncatedRemote = `/tmp/veyrobot-truncated-${id}.backup`;
  docker(['cp', truncatedPath, `${containerId}:${truncatedRemote}`]);
  const invalidArchive = spawnSync('docker', [...composePrefix, 'exec', '-T', 'postgres', 'pg_restore', '--list', truncatedRemote], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(invalidArchive.error, undefined, 'pg_restore executable starts for the truncated archive check');
  assert.notEqual(invalidArchive.status, 0, 'real pg_restore rejects a truncated nonempty archive');
  docker([...composePrefix, 'exec', '-T', 'postgres', 'createdb', '-U', pgUser, targetDb]);
  targetCreated = true;
  docker(['cp', archivePath, `${containerId}:/tmp/veyrobot-restore-${id}.backup`]);
  const restoreStarted = performance.now();
  docker([...composePrefix, 'exec', '-T', 'postgres', 'pg_restore', '-U', pgUser, '-d', targetDb, '--no-owner', `/tmp/veyrobot-restore-${id}.backup`]);
  timings.restoreMs = +(performance.now() - restoreStarted).toFixed(1);

  const targetUrl = new URL(databaseUrl);
  targetUrl.pathname = `/${targetDb}`;
  const targetEnv = { ...process.env, DATABASE_URL: targetUrl.toString(), RESTORE_QUARANTINE_CONFIRM: '1' };
  // Only the DB quarantine CLI is run. No API, bot, Gateway or worker is started.
  const quarantineOutput = node(['--import', 'tsx', 'packages/db/src/restore-quarantine-cli.ts'], targetEnv);
  const botBuildEnv = { ...sourceEnv };
  packageManager(['--filter', '@veyrobot/bot', 'build'], botBuildEnv);
  const dispatchCheck = `import { prisma } from '@veyrobot/db'; import { createDispatcher } from './dist/dispatcher.js'; const added=[]; const queue={getBackend:()=>({client:Promise.resolve({status:'ready'})}),add:async(...args)=>added.push(args)}; const dispatch=createDispatcher(prisma,queue,()=>true,()=>{}); await new Promise(resolve=>setTimeout(resolve,0)); await dispatch(); await prisma.$disconnect(); if(added.length!==0) process.exitCode=3; console.log(JSON.stringify({published:added.length}));`;
  const dispatchOutput = node(['--input-type=module', '-e', dispatchCheck], { ...targetEnv, RESTORE_QUARANTINE_CONFIRM: '' }, path.join(root, 'apps/bot'));
  assert.deepEqual(JSON.parse(dispatchOutput.trim()), { published: 0 }, 'production dispatcher does not publish quarantined operations');

  const sessionHash = createHash('sha256').update(`session-${id}`).digest('hex');
  const verify = `import { prisma } from './packages/db/src/index.ts';
const guildId='777777777777777777'; const warningId='backup_${id}_warning'; const tempbanId='backup_${id}_tempban'; const requestedId='backup_${id}_requested'; const runningId='backup_${id}_running';
const config=await prisma.guildConfig.findUnique({where:{guildId}}); const cases=await prisma.moderationCase.findMany({where:{operationId:{in:[warningId,tempbanId,requestedId,runningId]}},select:{operationId:true,action:true,status:true,expiryStatus:true,reason:true}}); const decision=await prisma.guildTargetDecision.findUnique({where:{guildId_targetId:{guildId,targetId:'888888888888888882'}}}); const grant=await prisma.sessionGrant.findUnique({where:{idHash:'${sessionHash}'}}); await prisma.$disconnect();
const byId=Object.fromEntries(cases.map(row=>[row.operationId,row])); console.log(JSON.stringify({config:{version:config?.version,warningsEnabled:config?.warningsEnabled,memberActionsEnabled:config?.memberActionsEnabled},warning:{action:byId[warningId]?.action,status:byId[warningId]?.status,reason:byId[warningId]?.reason},tempban:{status:byId[tempbanId]?.status,expiryStatus:byId[tempbanId]?.expiryStatus},requested:{status:byId[requestedId]?.status},running:{status:byId[runningId]?.status},decision:{generation:decision?.generation,appliedGeneration:decision?.appliedGeneration,appliedOperationId:decision?.appliedOperationId},sessionRevoked:Boolean(grant?.revokedAt)}));`;
  const verification = JSON.parse(node(['--import', 'tsx', '--input-type=module', '-e', verify], { ...targetEnv, RESTORE_QUARANTINE_CONFIRM: '' }).trim());
  assert.deepEqual(verification.config, { version: 8, warningsEnabled: true, memberActionsEnabled: true });
  assert.deepEqual(verification.warning, { action: 'WARN', status: 'succeeded', reason: 'backup restore fixture' });
  assert.deepEqual(verification.tempban, { status: 'succeeded', expiryStatus: 'uncertain' });
  assert.deepEqual(verification.requested, { status: 'uncertain' });
  assert.deepEqual(verification.running, { status: 'uncertain' });
  assert.deepEqual(verification.decision, { generation: 1, appliedGeneration: 1, appliedOperationId: `backup_${id}_tempban` });
  assert.equal(verification.sessionRevoked, true, 'all restored active sessions are revoked before service startup');

  console.log(JSON.stringify({ result: 'passed', postgres: '17-alpine', scope: 'real backup script, pg_restore, DB quarantine and production dispatcher check; no API, bot or Discord client started', quarantine: JSON.parse(quarantineOutput.trim()), checks: verification, durationsMs: timings, archiveBytes: archive.length }));
} finally {
  if (targetCreated) {
    try { docker([...composePrefix, 'exec', '-T', 'postgres', 'dropdb', '-U', pgUser, '--if-exists', targetDb]); } catch { /* container teardown removes this isolated database */ }
  }
  if (composeStarted) {
    try { docker([...composePrefix, 'down', '-v', '--remove-orphans']); } catch { /* isolated test project only */ }
  }
  await rm(tempRoot, { recursive: true, force: true });
}
