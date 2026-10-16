import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = process.cwd();
const id = createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 12);
const project = `veyrobot-backup-proof-${id}`;
const sourceDb = `veyrobot_backup_source_${id}`;
const targetDb = `veyrobot_backup_restore_${id}`;
const freshDb = `veyrobot_backup_fresh_${id}`;
const concurrentDb = `veyrobot_backup_concurrent_${id}`;
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'veyrobot-backup-restore-'));
const composeFile = path.join(tempRoot, 'compose.test.yaml');
const backupDirectory = path.join(tempRoot, 'backups');
const composePrefix = ['compose', '--project-name', project, '-f', composeFile];
const pgUser = 'backup_test';
const timings = {};
const sourceEpoch = randomBytes(32).toString('hex');
const restoreEpoch = randomBytes(32).toString('hex');

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
    const corepackCli = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node_modules', 'corepack', 'dist', 'corepack.js');
    if (process.execPath && path.isAbsolute(corepackCli)) return run(process.execPath, [corepackCli, 'pnpm', ...args], { env });
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

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

function runRecoveryCli(script, env) {
  return spawnSync(process.execPath, ['--import', 'tsx', script], { cwd: root, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 15_000 });
}

function assertCliFailure(result, message) {
  assert.equal(result.error, undefined, `${message}: CLI process must finish, not fail to spawn or time out`);
  assert.ok(Number.isInteger(result.status) && result.status !== 0, `${message}: expected a nonzero exit; stderr=${result.stderr}`);
}

async function assertApiStarts(databaseUrl, epoch, redisUrl, label) {
  const port = await freePort();
  const apiBase = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: path.join(root, 'apps/api'),
    env: { ...process.env, DATABASE_URL: databaseUrl, REDIS_URL: redisUrl, VEYROBOT_RECOVERY_EPOCH: epoch, NODE_ENV: 'test', API_PORT: String(port), API_PUBLIC_URL: apiBase,
      DASHBOARD_URL: 'http://localhost:3000', DISCORD_CLIENT_ID: 'test-client-id', DISCORD_CLIENT_SECRET: 'fake-only', DISCORD_BOT_TOKEN: 'not-a-real-token',
      SESSION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output = (output + chunk).slice(-20_000); });
  child.stderr.setEncoding('utf8').on('data', chunk => { output = (output + chunk).slice(-20_000); });
  try {
    let health;
    for (let i = 0; i < 100 && child.exitCode === null; i++) {
      try { health = await fetch(`${apiBase}/health`); break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.equal(health?.status, 200, `${label}: API should start only with an authorized recovery gate. Output: ${output}`);
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]); }
  }
}

let composeStarted = false;
let targetCreated = false;
let freshCreated = false;
let concurrentCreated = false;
try {
  const nodeVersion = process.versions.node.split('.').map(Number);
  assert.ok(nodeVersion[0] > 24 || (nodeVersion[0] === 24 && nodeVersion[1] >= 17), `Node >=24.17 required; got ${process.versions.node}`);
  await writeFile(composeFile, `services:\n  postgres:\n    image: postgres:17-alpine\n    environment:\n      POSTGRES_USER: ${pgUser}\n      POSTGRES_DB: ${sourceDb}\n      POSTGRES_HOST_AUTH_METHOD: trust\n    ports:\n      - "127.0.0.1::5432"\n  redis:\n    image: redis:7-alpine\n    ports:\n      - "127.0.0.1::6379"\n`);
  composeStarted = true;
  await docker([...composePrefix, 'up', '-d', 'postgres', 'redis']);
  const portLine = docker([...composePrefix, 'port', 'postgres', '5432']).trim().split(/\r?\n/).at(-1);
  const port = Number(portLine.slice(portLine.lastIndexOf(':') + 1));
  assert.ok(Number.isInteger(port) && port > 0, 'isolated PostgreSQL port is assigned');
  const redisPortLine = docker([...composePrefix, 'port', 'redis', '6379']).trim().split(/\r?\n/).at(-1);
  const redisPort = Number(redisPortLine.slice(redisPortLine.lastIndexOf(':') + 1));
  assert.ok(Number.isInteger(redisPort) && redisPort > 0, 'isolated Redis port is assigned');
  const databaseUrl = `postgresql://${pgUser}@127.0.0.1:${port}/${sourceDb}?schema=public`;
  const redisUrl = `redis://127.0.0.1:${redisPort}`;
  const sourceEnv = { ...process.env, DATABASE_URL: databaseUrl };
  packageManager(['db:generate'], sourceEnv);
  packageManager(['db:migrate'], sourceEnv);
  const seed = `import { prisma, initializeRecoveryAuthorization } from './packages/db/src/index.ts';
const guildId = 'restore-test-guild-${id}';
const actorId = 'restore-test-operator';
const warningId = 'backup_${id}_warning';
const tempbanId = 'backup_${id}_tempban';
const requestedId = 'backup_${id}_requested';
const runningId = 'backup_${id}_running';
await initializeRecoveryAuthorization(prisma, '${sourceEpoch}');
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

  node(['--import', 'tsx', '--input-type=module', '-e', `import {prisma} from './packages/db/src/index.ts'; await prisma.moderationCase.update({where:{operationId:'backup_${id}_requested'},data:{status:'succeeded',completedAt:new Date(),result:'simulated source action after snapshot'}}); await prisma.$disconnect();`], sourceEnv);

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
  const targetEnv = { ...process.env, DATABASE_URL: targetUrl.toString(), REDIS_URL: redisUrl, RESTORE_QUARANTINE_CONFIRM: '1', VEYROBOT_RECOVERY_EPOCH: restoreEpoch,
    DISCORD_BOT_TOKEN: 'not-a-real-token', DISCORD_CLIENT_ID: 'test-client-id' };
  const botBuildEnv = { ...sourceEnv };
  packageManager(['--filter', '@veyrobot/bot', 'build'], botBuildEnv);
  packageManager(['--filter', '@veyrobot/api', 'build'], botBuildEnv);
  const botDirectory = path.join(root, 'apps/bot');
  const fakeGatewayPreload = path.join(botDirectory, 'test', 'fake-gateway-login-preload.mjs');
  const startBot = (epoch) => spawnSync(process.execPath, ['--import', fakeGatewayPreload, 'dist/index.js'], {
    cwd: botDirectory, env: { ...targetEnv, VEYROBOT_RECOVERY_EPOCH: epoch }, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 10_000,
  });
  const freshUrl = new URL(databaseUrl);
  freshUrl.pathname = `/${freshDb}`;
  docker([...composePrefix, 'exec', '-T', 'postgres', 'createdb', '-U', pgUser, freshDb]);
  freshCreated = true;
  const freshEnv = { ...sourceEnv, DATABASE_URL: freshUrl.toString() };
  packageManager(['db:migrate'], freshEnv);
  const firstInstallGuard = `import assert from 'node:assert/strict'; import {prisma,initializeRecoveryAuthorization} from './packages/db/src/index.ts';
const epoch='${randomBytes(32).toString('hex')}';
const fixtures=[
 ['moderationCase',{guildId:'guard',actorId:'actor',targetId:'target',action:'WARN',reason:'fixture'}],
 ['guildTargetDecision',{guildId:'guard',targetId:'target'}],
 ['channelLockState',{guildId:'guard',channelId:'channel',originalSendMessages:'allow',lockOperationId:'lock-fixture'}],
 ['guildConfig',{guildId:'guard',updatedBy:'actor'}],
 ['configAudit',{guildId:'guard',actorId:'actor',version:1,changes:{fixture:true}}],
 ['guildPresence',{guildId:'guard',shardId:0}],
 ['shardPresence',{shardId:0}],
 ['sessionGrant',{idHash:'session-fixture',expiresAt:new Date(Date.now()+60000)}]
];
for (const [name,data] of fixtures) {
 await prisma[name].create({data});
 await assert.rejects(initializeRecoveryAuthorization(prisma,epoch),/contains application data/,'each persisted application model must block first-install initialization');
 await prisma[name].deleteMany();
}
await prisma.$disconnect();`;
  node(['--import', 'tsx', '--input-type=module', '-e', firstInstallGuard], freshEnv);
  const freshEpoch = randomBytes(32).toString('hex');
  const freshInitEnv = { ...freshEnv, VEYROBOT_RECOVERY_EPOCH: freshEpoch, RECOVERY_GATE_INITIALIZE: '1' };
  const alternateGateHash = createHash('sha256').update('already-present-gate').digest('hex');
  await node(['--import', 'tsx', '--input-type=module', '-e', `import {prisma} from './packages/db/src/index.ts'; await prisma.recoveryGate.create({data:{id:'unexpected-row',epochHash:'${alternateGateHash}'}}); await prisma.$disconnect();`], freshEnv);
  const alternateGateInit = runRecoveryCli('packages/db/src/recovery-gate-init-cli.ts', freshInitEnv);
  assertCliFailure(alternateGateInit, 'initialization refuses any existing recovery gate row, not only the singleton id');
  const alternateGateRead = await node(['--import', 'tsx', '--input-type=module', '-e', `import {prisma} from './packages/db/src/index.ts'; const rows=await prisma.recoveryGate.findMany({select:{id:true,epochHash:true}}); await prisma.$disconnect(); console.log(JSON.stringify(rows));`], freshEnv);
  assert.deepEqual(JSON.parse(alternateGateRead.trim()), [{ id: 'unexpected-row', epochHash: alternateGateHash }], 'refusing init leaves an unexpected gate row unchanged');
  await node(['--import', 'tsx', '--input-type=module', '-e', `import {prisma} from './packages/db/src/index.ts'; await prisma.recoveryGate.delete({where:{id:'unexpected-row'}}); await prisma.$disconnect();`], freshEnv);
  const freshInit = runRecoveryCli('packages/db/src/recovery-gate-init-cli.ts', freshInitEnv);
  assert.equal(freshInit.status, 0, `first-install initialization on empty migrated DB succeeds: ${freshInit.stderr}`);
  const readGateHash = (env) => node(['--import', 'tsx', '--input-type=module', '-e', `import {prisma} from './packages/db/src/index.ts'; const row=await prisma.recoveryGate.findUniqueOrThrow({where:{id:'singleton'}}); await prisma.$disconnect(); console.log(row.epochHash);`], env);
  const freshGateBefore = await readGateHash(freshEnv);
  const repeatedInit = runRecoveryCli('packages/db/src/recovery-gate-init-cli.ts', freshInitEnv);
  assertCliFailure(repeatedInit, 'initialization refuses an existing gate');
  assert.equal((await readGateHash(freshEnv)).trim(), freshGateBefore.trim(), 'refusing a second initialization does not realign the stored epoch');
  await assertApiStarts(freshUrl.toString(), freshEpoch, redisUrl, 'fresh installation');
  const freshBotStart = spawnSync(process.execPath, ['--import', fakeGatewayPreload, 'dist/index.js'], {
    cwd: botDirectory, env: { ...freshInitEnv, REDIS_URL: redisUrl, DISCORD_BOT_TOKEN: 'not-a-real-token', DISCORD_CLIENT_ID: 'test-client-id' }, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 10_000,
  });
  assert.equal(freshBotStart.status, 42, 'production bot startup is authorized after fresh empty-database initialization');
  assert.ok(`${freshBotStart.stdout}${freshBotStart.stderr}`.includes('FAKE_GATEWAY_LOGIN_REACHED'), 'fresh bot reaches only the fake Gateway adapter');

  docker([...composePrefix, 'exec', '-T', 'postgres', 'createdb', '-U', pgUser, concurrentDb]);
  concurrentCreated = true;
  const concurrentUrl = new URL(databaseUrl);
  concurrentUrl.pathname = `/${concurrentDb}`;
  const concurrentEnv = { ...sourceEnv, DATABASE_URL: concurrentUrl.toString() };
  packageManager(['db:migrate'], concurrentEnv);
  const concurrentEpochs = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')];
  const launchConcurrentInit = (epoch) => new Promise(resolve => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'packages/db/src/recovery-gate-init-cli.ts'], { cwd: root, env: { ...concurrentEnv, VEYROBOT_RECOVERY_EPOCH: epoch, RECOVERY_GATE_INITIALIZE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.once('error', error => { clearTimeout(timeout); resolve({ code: null, output: `${output}${error.message}` }); });
    child.once('close', code => { clearTimeout(timeout); resolve({ code, output }); });
  });
  const concurrentResults = await Promise.all(concurrentEpochs.map(launchConcurrentInit));
  assert.equal(concurrentResults.filter(result => result.code === 0).length, 1, 'exactly one concurrent first-install initializer succeeds');
  assert.equal(concurrentResults.filter(result => result.code !== 0).length, 1, 'the competing initializer fails closed after observing the committed gate');
  const concurrentGateHash = (await readGateHash(concurrentEnv)).trim();
  assert.ok(concurrentEpochs.some(epoch => concurrentGateHash === createHash('sha256').update(epoch).digest('hex')), 'concurrent initialization leaves exactly one submitted epoch recorded');

  const blockedStart = startBot(restoreEpoch);
  assert.equal(blockedStart.status, 1, 'the production bot entrypoint refuses an old restored recovery epoch');
  assert.ok(!`${blockedStart.stdout}${blockedStart.stderr}`.includes('FAKE_GATEWAY_LOGIN_REACHED'), 'no simulated Discord login is attempted before quarantine');
  const existingGateInit = runRecoveryCli('packages/db/src/recovery-gate-init-cli.ts', { ...targetEnv, RECOVERY_GATE_INITIALIZE: '1' });
  assertCliFailure(existingGateInit, 'first-install initialization refuses to replace an existing restored gate');
  const restoredGateHash = await node(['--import', 'tsx', '--input-type=module', '-e', `import {prisma} from './packages/db/src/index.ts'; const row=await prisma.recoveryGate.findUniqueOrThrow({where:{id:'singleton'}}); await prisma.$disconnect(); console.log(row.epochHash);`], targetEnv);
  assert.equal(restoredGateHash.trim(), createHash('sha256').update(sourceEpoch).digest('hex'), 'existing stale gate remains unchanged after init refusal');
  docker([...composePrefix, 'exec', '-T', 'postgres', 'psql', '-U', pgUser, '-d', targetDb, '-v', 'ON_ERROR_STOP=1', '-c', 'DELETE FROM "RecoveryGate"']);
  const legacyInit = runRecoveryCli('packages/db/src/recovery-gate-init-cli.ts', { ...targetEnv, RECOVERY_GATE_INITIALIZE: '1' });
  assertCliFailure(legacyInit, 'a snapshot without a RecoveryGate row but with restored application data cannot use init');
  const absentGate = await node(['--import', 'tsx', '--input-type=module', '-e', `import {prisma} from './packages/db/src/index.ts'; const row=await prisma.recoveryGate.findUnique({where:{id:'singleton'}}); await prisma.$disconnect(); console.log(JSON.stringify(row));`], targetEnv);
  assert.equal(absentGate.trim(), 'null', 'refused init does not create a gate on the restored snapshot');
  const legacyBlockedStart = startBot(restoreEpoch);
  assert.equal(legacyBlockedStart.status, 1, 'bot remains blocked when the restored snapshot has no gate');
  assert.ok(!`${legacyBlockedStart.stdout}${legacyBlockedStart.stderr}`.includes('FAKE_GATEWAY_LOGIN_REACHED'));
  const redisKeysBeforeQuarantine = Number(docker([...composePrefix, 'exec', '-T', 'redis', 'redis-cli', 'dbsize']).trim());
  assert.equal(redisKeysBeforeQuarantine, 0, 'blocked production bot startups have not published any BullMQ job');
  const blockedApiPort = await freePort();
  const blockedApiEnv = { ...targetEnv, NODE_ENV: 'test', API_PORT: String(blockedApiPort), API_PUBLIC_URL: `http://127.0.0.1:${blockedApiPort}`, DASHBOARD_URL: 'http://localhost:3000', DISCORD_CLIENT_SECRET: 'fake-only', SESSION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' };
  const blockedApi = spawnSync(process.execPath, ['dist/index.js'], { cwd: path.join(root, 'apps/api'), env: blockedApiEnv, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 10_000 });
  assert.equal(blockedApi.status, 1, 'the production API entrypoint refuses a snapshot with no gate before listening');
  assert.ok(!`${blockedApi.stdout}${blockedApi.stderr}`.includes('Server listening'), 'API exposes no routes before quarantine');
  const operationBeforeQuarantine = await node(['--import', 'tsx', '--input-type=module', '-e', `import {prisma} from './packages/db/src/index.ts'; const r=await prisma.moderationCase.findUniqueOrThrow({where:{operationId:'backup_${id}_requested'}}); await prisma.$disconnect(); console.log(r.status);`], targetEnv);
  assert.equal(operationBeforeQuarantine.trim(), 'requested', 'restored active work remains unchanged until the transaction commits');

  const triggerSql = `CREATE OR REPLACE FUNCTION fail_recovery_gate_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected gate write failure'; END $$; CREATE TRIGGER fail_recovery_gate_write BEFORE INSERT OR UPDATE ON "RecoveryGate" FOR EACH ROW EXECUTE FUNCTION fail_recovery_gate_write();`;
  docker([...composePrefix, 'exec', '-T', 'postgres', 'psql', '-U', pgUser, '-d', targetDb, '-v', 'ON_ERROR_STOP=1', '-c', triggerSql]);
  const failedQuarantine = spawnSync(process.execPath, ['--import', 'tsx', 'packages/db/src/restore-quarantine-cli.ts'], { cwd: root, env: targetEnv, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.notEqual(failedQuarantine.status, 0, 'injected gate persistence failure aborts quarantine');
  docker([...composePrefix, 'exec', '-T', 'postgres', 'psql', '-U', pgUser, '-d', targetDb, '-v', 'ON_ERROR_STOP=1', '-c', 'DROP TRIGGER fail_recovery_gate_write ON "RecoveryGate"; DROP FUNCTION fail_recovery_gate_write();']);
  const afterFailedQuarantine = await node(['--import', 'tsx', '--input-type=module', '-e', `import {prisma} from './packages/db/src/index.ts'; const [r,e,g]=await Promise.all([prisma.moderationCase.findUniqueOrThrow({where:{operationId:'backup_${id}_requested'}}),prisma.moderationCase.findUniqueOrThrow({where:{operationId:'backup_${id}_tempban'}}),prisma.recoveryGate.findUnique({where:{id:'singleton'}})]); const grant=await prisma.sessionGrant.findFirst(); await prisma.$disconnect(); console.log(JSON.stringify({status:r.status,expiryStatus:e.expiryStatus,gate:Boolean(g),sessionRevoked:Boolean(grant?.revokedAt)}));`], targetEnv);
  assert.deepEqual(JSON.parse(afterFailedQuarantine.trim()), { status: 'requested', expiryStatus: 'scheduled', gate: false, sessionRevoked: false }, 'failed quarantine rolls back operation, expiry, sessions and gate as one transaction');
  const restartDuringQuarantine = startBot(restoreEpoch);
  assert.equal(restartDuringQuarantine.status, 1, 'restart while quarantine is incomplete remains blocked');
  assert.ok(!`${restartDuringQuarantine.stdout}${restartDuringQuarantine.stderr}`.includes('FAKE_GATEWAY_LOGIN_REACHED'));
  assert.equal(Number(docker([...composePrefix, 'exec', '-T', 'redis', 'redis-cli', 'dbsize']).trim()), 0, 'failed quarantine and restart still publish no queue job');

  const quarantineOutput = node(['--import', 'tsx', 'packages/db/src/restore-quarantine-cli.ts'], targetEnv);
  const successfulStart = startBot(restoreEpoch);
  assert.equal(successfulStart.status, 42, 'after atomic quarantine the production entrypoint reaches only the controlled fake Gateway adapter');
  assert.ok(`${successfulStart.stdout}${successfulStart.stderr}`.includes('FAKE_GATEWAY_LOGIN_REACHED'));
  const apiPort = await freePort();
  const apiBase = `http://127.0.0.1:${apiPort}`;
  const resumedApi = spawn(process.execPath, ['dist/index.js'], { cwd: path.join(root, 'apps/api'), env: { ...blockedApiEnv, API_PORT: String(apiPort), API_PUBLIC_URL: apiBase }, stdio: ['ignore', 'pipe', 'pipe'] });
  let apiOutput = '';
  resumedApi.stdout.setEncoding('utf8').on('data', chunk => { apiOutput = (apiOutput + chunk).slice(-20_000); });
  resumedApi.stderr.setEncoding('utf8').on('data', chunk => { apiOutput = (apiOutput + chunk).slice(-20_000); });
  try {
    let health;
    for (let i = 0; i < 100 && resumedApi.exitCode === null; i++) {
      try { health = await fetch(`${apiBase}/health`); break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.equal(health?.status, 200, `API resumes only after the recovery epoch matches. Output: ${apiOutput}`);
  } finally {
    if (resumedApi.exitCode === null) { resumedApi.kill('SIGTERM'); await Promise.race([once(resumedApi, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]); }
  }
  const postRestoreId = `backup_${id}_postrestore`;
  await node(['--import', 'tsx', '--input-type=module', '-e', `import {prisma} from './packages/db/src/index.ts'; await prisma.moderationCase.create({data:{operationId:'${postRestoreId}',guildId:'restore-test-guild-${id}',actorId:'restore-test-operator',targetId:'restore-test-target',action:'BAN',reason:'post-restore controlled fixture',status:'requested'}}); await prisma.$disconnect();`], targetEnv);
  const dispatchCheck = `import { prisma } from '@veyrobot/db'; import { createDispatcher } from './dist/dispatcher.js'; const added=[]; const queue={getBackend:()=>({client:Promise.resolve({status:'ready'})}),add:async(...args)=>added.push(args)}; const dispatch=createDispatcher(prisma,queue,()=>true,()=>{}); await new Promise(resolve=>setTimeout(resolve,0)); await dispatch(); await prisma.$disconnect(); console.log(JSON.stringify({published:added.map(item=>item[1].operationId)}));`;
  const dispatchOutput = node(['--input-type=module', '-e', dispatchCheck], { ...targetEnv, RESTORE_QUARANTINE_CONFIRM: '' }, path.join(root, 'apps/bot'));
  assert.deepEqual(JSON.parse(dispatchOutput.trim()), { published: [postRestoreId] }, 'production dispatcher excludes restored work but resumes new requests after the gate opens');

  const sessionHash = createHash('sha256').update(`session-${id}`).digest('hex');
  const verify = `import { prisma } from './packages/db/src/index.ts';
const guildId='restore-test-guild-${id}'; const warningId='backup_${id}_warning'; const tempbanId='backup_${id}_tempban'; const requestedId='backup_${id}_requested'; const runningId='backup_${id}_running';
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

  console.log(JSON.stringify({ result: 'passed', postgres: '17-alpine', scope: 'real backup/restore; production bot entrypoint blocked before quarantine and allowed only through fake Gateway after; failed transaction and restart tested; no real Discord connection', quarantine: JSON.parse(quarantineOutput.trim()), checks: verification, durationsMs: timings, archiveBytes: archive.length }));
} finally {
  for (const [created, database] of [[targetCreated, targetDb], [freshCreated, freshDb], [concurrentCreated, concurrentDb]]) {
    if (created) {
      try { docker([...composePrefix, 'exec', '-T', 'postgres', 'dropdb', '-U', pgUser, '--if-exists', database]); } catch { /* container teardown removes this isolated database */ }
    }
  }
  if (composeStarted) {
    try { docker([...composePrefix, 'down', '-v', '--remove-orphans']); } catch { /* isolated test project only */ }
  }
  await rm(tempRoot, { recursive: true, force: true });
}
