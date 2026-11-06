import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';

if (process.env.RUN_BOT_LIFECYCLE_INTEGRATION !== '1' || process.env.VEYROBOT_ISOLATED_INTEGRATION !== '1') {
  throw new Error('Set RUN_BOT_LIFECYCLE_INTEGRATION=1 and VEYROBOT_ISOLATED_INTEGRATION=1 for this isolated lifecycle test.');
}
const root = process.cwd();
const suffix = randomUUID().replaceAll('-', '').slice(0, 18);
const databaseName = `vbot_lifecycle_${suffix}`;
const epoch = randomBytes(32).toString('hex');
const localRequire = createRequire(new URL('../apps/bot/package.json', import.meta.url));
const discordRequire = createRequire(localRequire.resolve('discord.js'));
const { WebSocketServer, WebSocket } = discordRequire('ws');
const { Client: PgClient } = localRequire('pg');
const dockerName = `vbot-lifecycle-redis-${suffix}`;
const postgresContainerName = `vbot-lifecycle-pg-${suffix}`;
let sourceUrl;
let dbUrl;
let phase = 'initialization';
let lastPostgresDiagnostic;
const inheritedRuntimeKeys = ['PATH', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'COREPACK_HOME', 'PNPM_HOME'];
const testEnv = Object.fromEntries(inheritedRuntimeKeys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
testEnv.VEYROBOT_RECOVERY_EPOCH = epoch;
let isolatedDbCreated = false;
let redisContainerId;
let postgresContainerId;
let restServer;
let wsServer;
let bot;
let stderr = '';
let stdout = '';
const sockets = new Set();
const gatewayActivity = [];
const lifecycleEvents = [];
const lifecycleDiagnostics = [];
let destroyCompleted;
let failureSnapshot;
let postReleaseSnapshot;
let destroyCompletedResolve;
const destroyGate = new Promise(resolve => { destroyCompletedResolve = resolve; });
let gatewayConnectionsCreated = 0;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 120_000, ...options });
  if (result.error || result.status !== 0) throw new Error(sanitizeDiagnosticText(`${command} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr?.slice(-2000) ?? result.status}`));
  return result.stdout.trim();
}
function manager(args, options = {}) {
  if (process.platform === 'win32') return run(process.execPath, [path.join(path.dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'corepack.js'), 'pnpm', ...args], options);
  return run('corepack', ['pnpm', ...args], options);
}
function docker(args, allowFailure = false) {
  const result = spawnSync('docker', args, { cwd: root, encoding: 'utf8', timeout: 30_000 });
  if (!allowFailure && (result.error || result.status !== 0)) throw new Error(sanitizeDiagnosticText(`docker ${args.join(' ')} failed: ${result.error?.message ?? result.stderr?.slice(-1000)}`));
  return result.stdout.trim();
}
function sanitizeDiagnosticText(value, maxLength = 5_000) {
  let text = String(value);
  for (const secret of [epoch, 'lifecycle-test-only', 'lifecycle-test-token', sourceUrl?.toString(), dbUrl?.toString()].filter(Boolean)) {
    text = text.replaceAll(secret, '[REDACTED]');
  }
  return text
    .replace(/postgres(?:ql)?:\/\/[^\s/@]+(?::[^\s/@]*)?@/gi, 'postgresql://[REDACTED]@')
    .replace(/\b(password|client_secret|session_key)=([^\s&]+)/gi, '$1=[REDACTED]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(-maxLength);
}
function sanitizePostgresDiagnostic(error) {
  const message = sanitizeDiagnosticText(error instanceof Error ? error.message : String(error), 240);
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : undefined;
  return { name: error instanceof Error && error.name === 'Error' ? 'Error' : 'PostgresError', ...(code ? { code } : {}), message };
}
function containerFailureDiagnostics(containerId) {
  if (!containerId) return 'not created';
  const state = sanitizeDiagnosticText(docker(['inspect', '--format', '{{json .State}}', containerId], true), 1200);
  const logs = sanitizeDiagnosticText(docker(['logs', '--tail', '80', containerId], true));
  return JSON.stringify({ state, logs });
}
async function within(label, promise, timeoutMs = 15_000) {
  let timeout;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label} after ${timeoutMs} ms.`)), timeoutMs); })]);
  } finally { clearTimeout(timeout); }
}
async function until(label, predicate, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await within(label, Promise.resolve().then(predicate), Math.max(1, end - Date.now()));
    if (value) return value;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs} ms.`);
}
function requestChild(message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for bot snapshot (${message.type}).`)); }, 5_000);
    const onMessage = payload => {
      if (!payload?.lifecycleSnapshot) return;
      cleanup(); resolve(payload.lifecycleSnapshot);
    };
    const cleanup = () => { clearTimeout(timer); bot.off('message', onMessage); };
    bot.on('message', onMessage);
    bot.send(message);
  });
}
async function canAcquireLease() {
  const client = new PgClient({ connectionString: dbUrl.toString(), connectionTimeoutMillis: 3_000 });
  await client.connect();
  try { return (await client.query('SELECT pg_try_advisory_lock($1, $2) AS acquired', [86291, 1])).rows[0].acquired; }
  finally { await client.end(); }
}
function eventPromise(kind, count, timeoutMs = 20_000) {
  return within(`${kind} event ${count}`, new Promise(resolve => {
    const listener = message => {
      if (message?.lifecycleEvent === kind && message.count >= count) { bot.off('message', listener); resolve(message); }
    };
    bot.on('message', listener);
  }), timeoutMs);
}
function listenGateway() {
  return new Promise((resolve, reject) => {
    restServer = http.createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/api/v10/gateway/bot') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ url: `ws://127.0.0.1:${restServer.address().port}`, shards: 1, session_start_limit: { total: 1000, remaining: 1000, reset_after: 60_000, max_concurrency: 1 } }));
      } else {
        response.writeHead(404, { 'content-type': 'application/json' }); response.end('{"message":"not found","code":0}');
      }
    });
    restServer.once('error', reject);
    restServer.listen(0, '127.0.0.1', () => {
      wsServer = new WebSocketServer({ server: restServer });
      wsServer.on('connection', socket => {
        gatewayConnectionsCreated++;
        const connectionId = gatewayConnectionsCreated;
        gatewayActivity.push({ event: 'connected', connectionId });
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
        socket.on('message', bytes => {
          const payload = JSON.parse(bytes.toString());
          if (payload.op !== 1) gatewayActivity.push({ event: 'gateway_payload', connectionId, op: payload.op });
          if (payload.op === 1) socket.send(JSON.stringify({ op: 11, d: null }));
          if (payload.op === 2) socket.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: {
            v: 10,
            user: { id: '100000000000000001', username: 'LifecycleBot', discriminator: '0000', avatar: null, bot: true, global_name: null },
            guilds: [],
            session_id: `lifecycle-${sockets.size}`,
            resume_gateway_url: `ws://127.0.0.1:${restServer.address().port}`,
            application: { id: '100000000000000002', flags: 0 },
          } }));
          if (payload.op === 6) socket.send(JSON.stringify({ op: 0, t: 'RESUMED', s: 2, d: {} }));
        });
        socket.on('close', code => {
          gatewayActivity.push({ event: 'closed', connectionId, code });
          if (code === 4000) socket.__controlledReconnect = true;
        });
      });
      resolve();
    });
  });
}
async function closeGateway() {
  if (wsServer) await new Promise(resolve => wsServer.close(resolve));
  if (restServer?.listening) await new Promise(resolve => restServer.close(resolve));
}
function snapshotSignature(s) {
  return JSON.stringify({ intervals: s.intervals, clientEvents: s.clientEvents, shardListeners: s.shardListeners, shardCount: s.shardCount, cacheCounts: s.cacheCounts, postgresPool: { total: s.postgresPool.total, waiting: s.postgresPool.waiting }, redisConnectedClients: s.redisConnectedClients });
}
function redisClientCount() {
  const info = docker(['exec', redisContainerId, 'redis-cli', 'INFO', 'clients']);
  return Number(info.match(/connected_clients:(\d+)/)?.[1] ?? 0);
}

try {
  phase = 'start_isolated_postgres_container';
  postgresContainerId = docker(['run', '-d', '--rm', '--name', postgresContainerName, '--memory=768m', '-e', 'POSTGRES_USER=veyrobot_test', '-e', 'POSTGRES_PASSWORD=lifecycle-test-only', '-e', 'POSTGRES_DB=veyrobot', '-p', '127.0.0.1::5432', 'postgres:17-alpine']);
  phase = 'start_isolated_redis_container';
  redisContainerId = docker(['run', '-d', '--rm', '--name', dockerName, '--memory=256m', '-p', '127.0.0.1::6379', 'redis:7-alpine']);
  phase = 'resolve_published_container_ports';
  const pgPortText = docker(['port', postgresContainerId, '5432/tcp']);
  const pgPort = Number(pgPortText.slice(pgPortText.lastIndexOf(':') + 1));
  const redisPortText = docker(['port', redisContainerId, '6379/tcp']);
  const redisPort = Number(redisPortText.slice(redisPortText.lastIndexOf(':') + 1));
  assert.ok(Number.isInteger(pgPort) && pgPort > 0, 'isolated PostgreSQL 17 container exposes a loopback port');
  assert.ok(Number.isInteger(redisPort) && redisPort > 0, 'isolated Redis 7 container exposes a loopback port');
  sourceUrl = new URL(`postgresql://veyrobot_test:lifecycle-test-only@127.0.0.1:${pgPort}/veyrobot?schema=public`);
  dbUrl = new URL(sourceUrl);
  dbUrl.pathname = `/${databaseName}`;
  testEnv.DATABASE_URL = dbUrl.toString();
  testEnv.REDIS_URL = `redis://127.0.0.1:${redisPort}`;
  phase = 'postgres_tcp_readiness_select_1';
  const postgresReadyDeadline = Date.now() + 30_000;
  while (Date.now() < postgresReadyDeadline) {
    const probe = new PgClient({ connectionString: sourceUrl.toString(), connectionTimeoutMillis: 1_500, query_timeout: 2_000 });
    let connected = false;
    try {
      await probe.connect();
      connected = true;
      const result = await probe.query('SELECT 1 AS ready');
      if (result.rows[0]?.ready === 1) { lastPostgresDiagnostic = undefined; break; }
      lastPostgresDiagnostic = { name: 'PostgresReadinessError', message: 'SELECT 1 returned an unexpected result.' };
    } catch (error) {
      lastPostgresDiagnostic = sanitizePostgresDiagnostic(error);
    } finally {
      if (connected) await probe.end().catch(error => { lastPostgresDiagnostic = sanitizePostgresDiagnostic(error); });
      else await probe.end().catch(() => undefined);
    }
    if (Date.now() >= postgresReadyDeadline) {
      throw new Error(`PostgreSQL TCP readiness failed at phase ${phase}; last error: ${JSON.stringify(lastPostgresDiagnostic ?? { message: 'no successful SELECT 1 observed' })}`);
    }
    await delay(250);
  }
  if (lastPostgresDiagnostic) throw new Error(`PostgreSQL TCP readiness did not complete at phase ${phase}; last error: ${JSON.stringify(lastPostgresDiagnostic)}`);
  phase = 'redis_readiness';
  await until('isolated Redis 7 readiness', async () => docker(['exec', redisContainerId, 'redis-cli', 'PING'], true) === 'PONG', 20_000);
  phase = 'postgres_admin_connection';
  const sourceClient = new PgClient({ connectionString: sourceUrl.toString() });
  try {
    await sourceClient.connect();
    const probe = await sourceClient.query('SELECT 1 AS ready');
    assert.equal(probe.rows[0]?.ready, 1, 'administrative connection uses the published TCP endpoint');
    phase = 'create_isolated_database';
    await sourceClient.query(`CREATE DATABASE "${databaseName}"`);
    isolatedDbCreated = true;
  } finally {
    await sourceClient.end().catch(() => undefined);
  }
  phase = 'migrations';
  manager(['db:migrate'], { env: testEnv });
  process.env.DATABASE_URL = dbUrl.toString();
  phase = 'recovery_gate_initialization';
  const { prisma, initializeRecoveryAuthorization } = await import('../apps/bot/node_modules/@veyrobot/db/dist/index.js');
  await initializeRecoveryAuthorization(prisma, epoch);
  await prisma.$disconnect();

  phase = 'gateway_fixture_start';
  await listenGateway();

  phase = 'launch_bot';
  const preload = new URL('../apps/bot/test/lifecycle-observer-preload.mjs', import.meta.url).pathname;
  bot = spawn(process.execPath, ['--import', preload, 'dist/index.js'], {
    cwd: `${root}/apps/bot`,
    env: { ...testEnv, BOT_LIFECYCLE_REST_URL: `http://127.0.0.1:${restServer.address().port}`, DISCORD_BOT_TOKEN: 'lifecycle-test-token', DISCORD_CLIENT_ID: '100000000000000002', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  bot.stdout.setEncoding('utf8'); bot.stderr.setEncoding('utf8');
  bot.stdout.on('data', chunk => { stdout += chunk; });
  bot.stderr.on('data', chunk => { stderr += chunk; });
  bot.on('message', message => { if (message?.lifecycleEvent) lifecycleEvents.push(message.lifecycleEvent); if (message?.lifecycleDiagnostic) lifecycleDiagnostics.push(message.lifecycleDiagnostic); if (message?.gatewayDestroyCompleted) { destroyCompleted = true; destroyCompletedResolve(); } });
  const exited = new Promise((resolve, reject) => {
    bot.once('error', reject);
    bot.once('exit', (code, signal) => resolve({ code, signal }));
  });
  await eventPromise('ready', 1, 30_000);
  await until('bot recovery lease acquired', async () => !(await canAcquireLease()), 10_000);
  await delay(2_000);
  const baseline = await requestChild({ type: 'bot-lifecycle-snapshot' });
  baseline.redisConnectedClients = redisClientCount();
  assert.equal(baseline.readyEvents, 1);
  assert.equal(baseline.shardCount, 1);
  assert.equal(baseline.cacheCounts.guilds, 0, 'Gateway fixture contains no guilds and performs no moderation work');
  assert.equal(baseline.postgresPool.waiting, 0);

  const snapshots = [baseline];
  const gatewayConnectionsBefore = gatewayConnectionsCreated;
  for (let cycle = 1; cycle <= 3; cycle++) {
    const reconnect = eventPromise('reconnecting', cycle, 20_000);
    const resumed = eventPromise('resumed', cycle, 20_000);
    const openSockets = [...sockets].filter(socket => socket.readyState === WebSocket.OPEN);
    assert.equal(openSockets.length, 1, `exactly one open Gateway socket exists before reconnect ${cycle}`);
    const current = openSockets[0];
    assert.ok(current && current.readyState === WebSocket.OPEN, `Gateway connection is open before reconnect ${cycle}`);
    gatewayActivity.push({ event: 'server_reconnect_request', connectionId: gatewayConnectionsCreated, op: 7 });
    current.send(JSON.stringify({ op: 7, d: null }));
    await reconnect;
    await resumed;
    await until(`Gateway resumes after cycle ${cycle}`, () => [...sockets].some(socket => socket.readyState === WebSocket.OPEN), 20_000);
    await delay(1_000);
    assert.equal(sockets.size, 1, `only one Gateway socket remains after reconnect ${cycle}`);
    const sample = await requestChild({ type: 'bot-lifecycle-snapshot' });
    sample.redisConnectedClients = redisClientCount();
    assert.equal(sample.readyEvents, 1, 'startup Ready setup remains one-shot across Gateway reconnects');
    assert.equal(sample.reconnectEvents, cycle);
    assert.equal(sample.shardCount, 1);
    assert.equal(sample.postgresPool.total, baseline.postgresPool.total, 'pool connection count remains stable');
    assert.equal(sample.postgresPool.waiting, 0, 'pool has no queued connection waiters');
    assert.equal(snapshotSignature(sample), snapshotSignature(baseline), `timers, listeners, pools, caches and shard count stay constant after reconnect ${cycle}`);
    snapshots.push(sample);
  }
  assert.equal(sockets.size, 1, 'exactly one Gateway socket remains after the final reconnect');
  assert.equal(gatewayConnectionsCreated, gatewayConnectionsBefore + 3, 'exactly one Gateway connection is created for each controlled reconnect');
  const maxRss = Math.max(...snapshots.map(sample => sample.rssBytes));
  const maxHeap = Math.max(...snapshots.map(sample => sample.heapUsedBytes));
  assert.ok(maxRss <= baseline.rssBytes + 32 * 1024 * 1024, 'reconnect sequence does not retain more than 32 MiB RSS above the stabilized baseline');
  assert.ok(maxHeap <= baseline.heapUsedBytes + 32 * 1024 * 1024, 'reconnect sequence does not retain more than 32 MiB heap above the stabilized baseline');

  const pgBefore = new PgClient({ connectionString: dbUrl.toString() });
  await pgBefore.connect();
  const pgRows = await pgBefore.query(`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1 AND application_name='veyrobot-bot-lease'`, [databaseName]);
  assert.equal(pgRows.rows[0].count, 1, 'exactly one dedicated advisory-lock session remains before shutdown');
  await pgBefore.end();

  const destroyHoldReady = eventPromise('destroy-hold-ready', 1, 5_000);
  bot.send({ type: 'hold-client-destroy-completion' });
  await destroyHoldReady;
  bot.send({ type: 'request-graceful-shutdown' });
  await within('real Client.destroy completion barrier', destroyGate, 20_000);
  assert.equal(destroyCompleted, true, 'production Client.destroy completed its local Gateway close');
  assert.equal(sockets.size, 0, 'simulated Gateway reports a closed client socket before the lease release');
  const closedSnapshot = await requestChild({ type: 'bot-lifecycle-snapshot' });
  assert.equal(closedSnapshot.clientReady, false, 'discord.js Client is no longer ready after destroy');
  assert.equal(closedSnapshot.intervals, 0, 'all tracked periodic intervals are cleared before lease release');
  assert.equal(closedSnapshot.postgresPool.total, 0, 'Prisma/PostgreSQL pool is closed before lease release');
  assert.equal(await canAcquireLease(), false, 'single-instance advisory lock remains held until Client.destroy returns');
  bot.send({ type: 'release-client-destroy-completion' });
  await eventPromise('destroy-release-ack', 1, 5_000);
  assert.equal(await until('lease release after Gateway close', canAcquireLease, 10_000), true);
  if (bot.connected && bot.exitCode === null) {
    postReleaseSnapshot = await requestChild({ type: 'bot-lifecycle-snapshot' }).catch(() => undefined);
  }
  // The test-only IPC channel is unref'd by the preload after the release ack;
  // production handles, not the test channel, now determine process exit.
  const exit = await within('bot process graceful exit', exited, 15_000);
  assert.deepEqual(exit, { code: 0, signal: null });
  const gatewayClosed = await until('all simulated Gateway sockets closed', () => sockets.size === 0, 5_000).catch(() => false);
  assert.equal(gatewayClosed, true);
  assert.equal(await canAcquireLease(), true, 'lease can be acquired after graceful bot exit');

  const finalStats = await docker(['exec', redisContainerId, 'redis-cli', 'INFO', 'clients']);
  const redisClients = Number(finalStats.match(/connected_clients:(\d+)/)?.[1] ?? 0);
  assert.ok(redisClients <= 1, 'all production BullMQ Redis clients closed; only the probe remains');
  assert.match(stdout, /Connecté comme LifecycleBot/);
  assert.doesNotMatch(`${stdout}\n${stderr}`, /uncaughtException|unhandledRejection|Fatal bot error/);
  console.info(JSON.stringify({
    event: 'bot_lifecycle_integration_passed',
    node: process.version,
    reconnectCycles: 3,
    snapshots: snapshots.map(({ intervals, activeResources, cacheCounts, postgresPool, redisConnectedClients, rssBytes, heapUsedBytes, externalBytes, arrayBuffersBytes, clientEvents, shardListeners }) => ({ intervals, activeResources, cacheCounts, postgresPool, redisConnectedClients, rssBytes, heapUsedBytes, externalBytes, arrayBuffersBytes, clientEvents, shardListeners })),
    lifecycleEvents,
    lifecycleDiagnostics,
    postReleaseSnapshot: postReleaseSnapshot ? { activeResources: postReleaseSnapshot.activeResources, intervals: postReleaseSnapshot.intervals, postgresPool: postReleaseSnapshot.postgresPool, clientReady: postReleaseSnapshot.clientReady } : 'process exited before another snapshot',
    closedSnapshot: { intervals: closedSnapshot.intervals, postgresPool: closedSnapshot.postgresPool, clientReady: closedSnapshot.clientReady },
    redisConnectedClientsAfterExit: redisClients,
    gatewayConnectionsCreated,
    memoryInterpretation: 'Short controlled reconnect sequence; no forced GC. Memory ranges are observations, not a long-duration leak or capacity proof.',
  }));
} catch (error) {
  if (bot?.connected && bot.exitCode === null) {
    failureSnapshot = await requestChild({ type: 'bot-lifecycle-snapshot' }).catch(() => undefined);
  }
  bot?.kill('SIGKILL');
  const postgresFailureDiagnostics = containerFailureDiagnostics(postgresContainerId);
  const redisFailureDiagnostics = containerFailureDiagnostics(redisContainerId);
  throw new Error(`phase=${phase}\n${sanitizeDiagnosticText(error instanceof Error ? error.stack : String(error), 4_000)}\n--- postgres container before cleanup ---\n${postgresFailureDiagnostics}\n--- redis container before cleanup ---\n${redisFailureDiagnostics}\n--- last sanitized postgres diagnostic ---\n${JSON.stringify(lastPostgresDiagnostic)}\n--- gateway activity ---\n${JSON.stringify(gatewayActivity)}\n--- bot snapshot ---\n${JSON.stringify(failureSnapshot)}\n--- lifecycle diagnostics ---\n${JSON.stringify(lifecycleDiagnostics)}\n--- bot stdout ---\n${sanitizeDiagnosticText(stdout, 4_000)}\n--- bot stderr ---\n${sanitizeDiagnosticText(stderr, 4_000)}`);
} finally {
  if (bot && bot.exitCode === null) { bot.kill('SIGKILL'); await new Promise(resolve => bot.once('exit', resolve)); }
  await closeGateway().catch(() => undefined);
  docker(['rm', '-f', dockerName], true);
  if (isolatedDbCreated) {
    const admin = new PgClient({ connectionString: sourceUrl.toString() });
    let connected = false;
    try {
      await admin.connect(); connected = true;
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    } catch { /* A failed test still cleans the isolated container below. */ }
    finally { if (connected) await admin.end().catch(() => undefined); }
  }
  docker(['rm', '-f', postgresContainerName], true);
}
