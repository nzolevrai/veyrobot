import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

if (process.env.RUN_HTTP_PERFORMANCE_INTEGRATION !== '1') throw new Error('Set RUN_HTTP_PERFORMANCE_INTEGRATION=1 to run the isolated HTTP performance scenario.');
if (process.env.CI !== 'true' && process.env.ALLOW_LOCAL_HTTP_PERFORMANCE !== '1') throw new Error('Local execution requires ALLOW_LOCAL_HTTP_PERFORMANCE=1.');
if (!process.env.DATABASE_URL || !process.env.REDIS_URL) throw new Error('DATABASE_URL and REDIS_URL are required for the disposable integration.');
const root = path.resolve(import.meta.dirname, '..');
const runId = randomUUID().replaceAll('-', '').slice(0, 10);
const dbName = `veyrobot_http_perf_${runId}`;
const operationPrefix = `httpperf_${runId}_`;
const queueName = `httpperf-${runId}`;
const actorId = '123456789012345679';
const guildIds = Array.from({ length: 4 }, (_, index) => String(250_000_000_000_000_000n + BigInt(parseInt(runId, 16) * 10 + index)));
const apiEntry = path.join(root, 'apps', 'api', 'dist', 'index.js');
const mockEntry = path.join(root, 'apps', 'api', 'test', 'mock-discord.mjs');
const apiSecret = randomUUID().replaceAll('-', '').padEnd(64, 'a');
const recoveryEpoch = randomUUID().replaceAll('-', '').padEnd(64, 'b');
const sessionKey = randomUUID().replaceAll('-', '').padEnd(64, 'c');
const sourceDatabaseUrl = new URL(process.env.DATABASE_URL);
const redisUrl = new URL(process.env.REDIS_URL);
const redisDbOverride = process.env.HTTP_PERFORMANCE_REDIS_DB === undefined ? null : Number(process.env.HTTP_PERFORMANCE_REDIS_DB);
if (redisDbOverride !== null && (!Number.isInteger(redisDbOverride) || redisDbOverride < 1 || redisDbOverride > 15)) throw new Error('HTTP_PERFORMANCE_REDIS_DB must be an isolated logical database number from 1 through 15.');
const redisDb = redisDbOverride ?? (1 + (Number.parseInt(runId.slice(-4), 16) % 15));
redisUrl.pathname = `/${redisDb}`;
const isolatedDatabaseUrl = new URL(sourceDatabaseUrl);
isolatedDatabaseUrl.pathname = `/${dbName}`;
isolatedDatabaseUrl.searchParams.set('schema', 'public');
const adminUrl = new URL(sourceDatabaseUrl);
adminUrl.pathname = '/postgres';
const require = createRequire(import.meta.url);
const { Pool } = require(path.join(root, 'packages', 'db', 'node_modules', 'pg'));
const allowedHost = new Set(['localhost', '127.0.0.1', '::1', 'postgres']);
if (!allowedHost.has(sourceDatabaseUrl.hostname)) throw new Error('Refusing benchmark database creation on a non-local PostgreSQL host.');
if (!['localhost', '127.0.0.1', '::1', 'redis'].includes(redisUrl.hostname)) throw new Error('Refusing benchmark Redis use on a non-local host.');
if (sourceDatabaseUrl.protocol !== 'postgresql:' || redisUrl.protocol !== 'redis:') throw new Error('Only local PostgreSQL and Redis URLs are supported by this benchmark.');

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});
function runMigration(env) {
  const result = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'corepack pnpm --filter @veyrobot/db db:migrate'], { cwd: root, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
    : spawnSync('corepack', ['pnpm', '--filter', '@veyrobot/db', 'db:migrate'], { cwd: root, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Disposable database migration failed (exit ${result.status ?? 'unknown'}).`);
}
function quantile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return +(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0).toFixed(2);
}
function distribution(values) { return { count: values.length, p50Ms: quantile(values, .5), p95Ms: quantile(values, .95), p99Ms: quantile(values, .99), maxMs: +(Math.max(0, ...values)).toFixed(2) }; }
async function until(label, predicate, timeoutMs = 15_000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await sleep(intervalMs); }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}.`);
}
function cookieValue(setCookie) { return String(setCookie).split(';', 1)[0]; }
const samples = [];
let adminPool;
let prisma;
let queue;
let worker;
let dispatcherTimer;
let apiProcess;
let apiLogs = '';
let apiInspectorPort;
let redisClient;
let droppedDatabase = false;
let dispatch;
let botLogEvents = [];
let botObservedExecutionLogs = 0;
let originalConsoleInfo;
let originalConsoleError;
let workerStart = new Map();
let workerFinish = new Map();
let enqueueStart = new Map();
let publishedAt = new Map();
let lifecycle = [];
let acceptedHttpByOperation = new Map();
let actionCounter = 0;
let requestCounts = { offered: 0, acceptedHttp: 0, refusedAdmission429: 0, otherErrors: 0, duplicateRequests: 0 };
let uniqueOperations = new Map();
let simulated = { timeout: 0, ban: 0, unban: 0, callsByGuild: new Map() };
let activeGate;
let sampleBusy = false;
let sampleTimer;
const loop = monitorEventLoopDelay({ resolution: 20 });
let cpuStart;
const runStarted = performance.now();

function operationId(label) { return `${operationPrefix}${label}_${String(actionCounter++).padStart(6, '0')}`; }
function targetId() { return String(600_000_000_000_000_000n + BigInt(actionCounter + 1)); }
function recordMutation(guildId, kind) {
  simulated[kind]++;
  simulated.callsByGuild.set(guildId, (simulated.callsByGuild.get(guildId) ?? 0) + 1);
}
function controlledGuild(guildId) {
  const role = { comparePositionTo: other => other === lowRole ? 1 : 0 };
  const lowRole = { comparePositionTo: other => other === role ? -1 : 0 };
  const permissions = { bitfield: (1n << 1n) | (1n << 2n) | (1n << 40n), has: () => true };
  const banReasons = new Map();
  const mutate = async kind => {
    if (kind === 'timeout' && activeGate?.guildId === guildId && !activeGate.entered) {
      activeGate.entered = true; activeGate.enter();
      await activeGate.releasePromise;
    }
    recordMutation(guildId, kind);
    await sleep(35);
  };
  return {
    id: guildId, ownerId: '999999999999999997',
    members: {
      fetch: async ({ user }) => user === actorId
        ? { id: actorId, permissions, roles: { highest: role } }
        : { id: user, permissions, roles: { highest: lowRole }, timeout: async () => mutate('timeout'), ban: async ({ reason }) => { await mutate('ban'); banReasons.set(user, reason); } },
      fetchMe: async () => ({ id: '999999999999999998', permissions, roles: { highest: role } }),
      unban: async user => { recordMutation(guildId, 'unban'); banReasons.delete(user); await sleep(35); },
    },
    bans: { fetch: async input => {
      const user = typeof input === 'string' ? input : input.user;
      const reason = banReasons.get(user);
      if (!reason) { const error = new Error('Unknown ban (controlled adapter).'); error.status = 404; error.code = 10026; throw error; }
      return { reason };
    } },
  };
}

async function sampleInspectorHeap(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_000) });
  const [target] = await response.json();
  if (!target?.webSocketDebuggerUrl) return null;
  const url = new URL(target.webSocketDebuggerUrl); url.hostname = '127.0.0.1'; url.port = String(port);
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('Inspector heap request timed out.')); }, 1_500);
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.getHeapUsage' }));
    socket.onerror = () => { clearTimeout(timer); reject(new Error('Inspector heap request failed.')); };
    socket.onmessage = event => { const message = JSON.parse(String(event.data)); if (message.id === 1) { clearTimeout(timer); socket.close(); resolve(message.result ?? null); } };
  });
}
function osProcessSample(pid) {
  if (process.platform === 'win32') {
    const command = `$p=Get-Process -Id ${Number(pid)} -ErrorAction Stop; [Console]::WriteLine(\"$($p.WorkingSet64)|$($p.CPU)\")`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 3_000, maxBuffer: 2_000 });
    if (result.status !== 0) return null;
    const [rss, cpu] = result.stdout.trim().split('|').map(Number);
    return Number.isFinite(rss) ? { rssBytes: rss, cpuSeconds: Number.isFinite(cpu) ? cpu : null } : null;
  }
  const result = spawnSync('ps', ['-o', 'rss=,time=', '-p', String(Number(pid))], { encoding: 'utf8', timeout: 3_000, maxBuffer: 2_000 });
  const [rssKb, time] = result.stdout.trim().split(/\s+/);
  if (!rssKb || !time) return null;
  const parts = time.split(':').map(Number);
  const cpuSeconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts.at(-1);
  return { rssBytes: Number(rssKb) * 1024, cpuSeconds: Number.isFinite(cpuSeconds) ? cpuSeconds : null };
}
async function collectResources() {
  if (sampleBusy || !apiProcess || apiProcess.exitCode !== null) return;
  sampleBusy = true;
  try {
    const memory = process.memoryUsage();
    const [heap, pg, redisInfo, counts] = await Promise.all([
      sampleInspectorHeap(apiInspectorPort).catch(() => null),
      prisma.$queryRaw`SELECT count(*)::int AS connections, pg_database_size(current_database())::bigint AS database_bytes FROM pg_stat_activity WHERE datname = current_database()`,
      redisClient.info('memory'), queue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
    ]);
    const redisFields = Object.fromEntries(['used_memory', 'used_memory_rss', 'maxmemory', 'connected_clients'].map(key => [key, Number(redisInfo.split(/\r?\n/).find(line => line.startsWith(`${key}:`))?.slice(key.length + 1).split(',')[0] ?? 0)]));
    samples.push({ atSeconds: +((performance.now() - runStarted) / 1000).toFixed(2), api: { ...osProcessSample(apiProcess.pid), heapUsedBytes: heap?.usedSize ?? null, heapTotalBytes: heap?.totalSize ?? null }, workerHarness: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, externalBytes: memory.external, arrayBuffersBytes: memory.arrayBuffers }, postgres: pg[0], redis: redisFields, queue: counts, host: { totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem() }, eventLoopP95Ms: +(loop.percentile(95) / 1e6).toFixed(2) });
    loop.reset();
  } finally { sampleBusy = false; }
}

try {
  adminPool = new Pool({ connectionString: adminUrl.toString(), max: 2 });
  await adminPool.query(`CREATE DATABASE "${dbName}"`);
  const testEnv = { ...process.env, DATABASE_URL: isolatedDatabaseUrl.toString(), MAX_PENDING_GLOBAL: '5000', MAX_PENDING_PER_GUILD: '8' };
  runMigration(testEnv);
  process.env.DATABASE_URL = isolatedDatabaseUrl.toString();
  process.env.REDIS_URL = redisUrl.toString();
  process.env.MAX_PENDING_GLOBAL = '5000';
  process.env.MAX_PENDING_PER_GUILD = '8';
  const db = await import('../packages/db/dist/index.js');
  prisma = db.prisma;
  await db.initializeRecoveryAuthorization(prisma, recoveryEpoch);
  const moderation = await import('../packages/moderation/dist/index.js');
  const { Queue } = await import('../apps/bot/node_modules/bullmq/dist/cjs/index.js');
  const { createDispatcher } = await import('../apps/bot/dist/dispatcher.js');
  const { createModerationWorker } = await import('../apps/bot/dist/worker.js');
  const { performance: perf } = await import('node:perf_hooks');
  const targetGuilds = guildIds.map(guildId => controlledGuild(guildId));
  const controlledClient = { isReady: () => true, guilds: { cache: new Map(guildIds.map((guildId, index) => [guildId, targetGuilds[index]])), fetch: async guildId => targetGuilds[guildIds.indexOf(guildId)] ?? null } };
  const port = await freePort(); apiInspectorPort = await freePort();
  const apiBase = `http://127.0.0.1:${port}`;
  const apiEnv = {
    ...testEnv, NODE_ENV: 'test', API_PORT: String(port), API_PUBLIC_URL: apiBase, DASHBOARD_URL: 'http://127.0.0.1:3000',
    API_RATE_LIMIT_MAX: '10000', API_PREAUTH_RATE_LIMIT_MAX: '10000', API_TRUSTED_PROXIES: '',
    VEYROBOT_RECOVERY_EPOCH: recoveryEpoch, DISCORD_CLIENT_ID: '123456789012345678', DISCORD_CLIENT_SECRET: 'http-performance-fixture-only', DISCORD_BOT_TOKEN: 'http-performance-fixture-only',
    SESSION_KEY: sessionKey, TEST_USER_ID: actorId, TEST_GUILD_IDS: guildIds.join(','),
  };
  for (let index = 0; index < guildIds.length; index++) {
    await prisma.guildConfig.create({ data: { guildId: guildIds[index], updatedBy: actorId, memberActionsEnabled: true } });
    await prisma.guildPresence.create({ data: { guildId: guildIds[index], shardId: 92_001 } });
  }
  await prisma.shardPresence.create({ data: { shardId: 92_001, lastSeenAt: new Date() } });

  apiProcess = spawn(process.execPath, [`--inspect=127.0.0.1:${apiInspectorPort}`, '--import', pathToFileURL(mockEntry).href, apiEntry], { cwd: root, env: apiEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  apiProcess.stdout.setEncoding('utf8').on('data', chunk => { apiLogs = (apiLogs + chunk).slice(-4_000_000); });
  apiProcess.stderr.setEncoding('utf8').on('data', chunk => { apiLogs = (apiLogs + chunk).slice(-4_000_000); });
  await until('API health route', async () => {
    if (apiProcess.exitCode !== null) {
      const diagnostics = apiLogs.split(/\r?\n/).map(line => { try { const entry = JSON.parse(line); return { level: entry.level, msg: entry.msg, event: entry.event, phase: entry.phase, errorName: entry.err?.name, errorCode: entry.err?.code }; } catch { return null; } }).filter(Boolean).slice(-8);
      const safeLines = apiLogs.split(/\r?\n/).filter(Boolean).slice(-8).map(line => line
        .replaceAll(apiEnv.SESSION_KEY, '[session-key]')
        .replaceAll(apiEnv.DISCORD_CLIENT_SECRET, '[oauth-secret]')
        .replaceAll(apiEnv.DISCORD_BOT_TOKEN, '[bot-token]')
        .replaceAll(apiEnv.VEYROBOT_RECOVERY_EPOCH, '[recovery-epoch]')
        .replaceAll(apiEnv.DATABASE_URL, '[database-url]')
        .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[database-url]')
        .replace(/(cookie|authorization|token|secret)=?[^\s,;}]*/gi, '$1=[redacted]')
        .slice(0, 500));
      throw new Error(`API child exited with code ${apiProcess.exitCode}; structured fields: ${JSON.stringify(diagnostics)}; redacted lines: ${JSON.stringify(safeLines)}`);
    }
    try { return (await fetch(`${apiBase}/health`)).ok; } catch { return false; }
  }, 20_000);

  const sessions = [];
  for (let index = 0; index < 2; index++) {
    const start = await fetch(`${apiBase}/oauth/discord/start`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const stateCookie = cookieValue(start.headers.get('set-cookie'));
    const callback = await fetch(`${apiBase}/oauth/discord/callback?code=http-performance&state=${state}`, { redirect: 'manual', headers: { cookie: stateCookie } });
    assert.equal(callback.status, 302);
    const sessionCookie = cookieValue(callback.headers.get('set-cookie'));
    const me = await fetch(`${apiBase}/me`, { headers: { cookie: sessionCookie } });
    assert.equal(me.status, 200, 'real API grant validation admits the test OAuth session');
    sessions.push({ cookie: sessionCookie, csrf: (await me.json()).csrf });
  }
  const initialRedis = new Queue(queueName, { connection: moderation.redisConnection(redisUrl.toString(), true) });
  queue = initialRedis;
  await initialRedis.waitUntilReady();
  redisClient = await initialRedis.getBackend().client;
  const initialRedisKeys = await redisClient.keys('*');
  assert.ok(initialRedisKeys.every(key => key.startsWith(`bull:${queueName}:`)), `selected Redis logical database ${redisDb} may contain only BullMQ metadata created for this unique queue`);
  botLogEvents = [];
  originalConsoleInfo = console.info;
  originalConsoleError = console.error;
  console.info = (...values) => {
    try { if (JSON.parse(String(values[0]))?.event === 'moderation_execution') { botObservedExecutionLogs++; return; } } catch { /* keep non-JSON messages suppressed only for this isolated benchmark */ }
    originalConsoleInfo(...values);
  };
  console.error = (..._values) => { botLogEvents.push({ type: 'worker_stderr' }); };
  const workerTelemetry = {
    onAttemptStarted(attempt) {
      workerStart.set(attempt.operationId, { at: perf.now(), epochMs: Date.now(), kind: attempt.kind, guildId: attempt.guildId, scheduledAt: attempt.scheduledAt?.getTime() ?? null });
    },
    onAttemptFinished(_guildId, operationId) { workerFinish.set(operationId, perf.now()); },
  };
  worker = createModerationWorker(controlledClient, moderation.redisConnection(redisUrl.toString()), prisma, moderation, db.rejectPendingAfterDisable, () => { if (dispatch) setImmediate(() => { void dispatch(); }); }, workerTelemetry, queueName);
  worker.on('error', error => botLogEvents.push({ type: 'worker_error', name: error?.name }));
  await Promise.all([queue.waitUntilReady(), worker.waitUntilReady()]);
  dispatch = createDispatcher(prisma, queue, () => true, (key, _message, error) => botLogEvents.push({ type: 'dispatcher_error', key, name: error?.name }), attempt => enqueueStart.set(attempt.operationId, { at: perf.now(), epochMs: attempt.queueAddStartedAt }), event => {
    lifecycle.push({ ...event, at: perf.now() });
    if (event.phase === 'queue_publish' && event.outcome === 'published') publishedAt.set(event.kind === 'expiry' ? `expiry-${event.caseId}` : event.operationId, perf.now());
  });
  dispatcherTimer = setInterval(() => { void dispatch(); }, 1_000);
  loop.enable();
  sampleTimer = setInterval(() => { void collectResources().catch(error => botLogEvents.push({ type: 'sample_error', name: error?.name })); }, 5_000);
  await dispatch();
  cpuStart = process.cpuUsage();

  const offeredProfiles = { normal: [], mixed: [], overload: [] };
  const requestStats = { httpAdmissionMs: { normal: [], mixed: [], overload: [] } };
  async function sendAction(profile, guildId, { id, action = 'TIMEOUT', durationMinutes = 1, target = targetId(), reason = 'isolated HTTP performance integration' } = {}) {
    const operation = id ?? operationId(profile);
    requestCounts.offered++;
    if (!uniqueOperations.has(operation)) uniqueOperations.set(operation, { operationId: operation, profile, guildId, target, action, httpAcceptedAt: null, createdAt: null, caseId: null, admissionMs: null });
    const existing = uniqueOperations.get(operation);
    const session = sessions[requestCounts.offered % sessions.length];
    const began = perf.now();
    const response = await fetch(`${apiBase}/guilds/${guildId}/actions`, { method: 'POST', headers: { cookie: session.cookie, 'content-type': 'application/json', origin: apiEnv.DASHBOARD_URL }, body: JSON.stringify({ action, targetId: target, reason, ...(durationMinutes === undefined ? {} : { durationMinutes }), operationId: operation, csrf: session.csrf }) });
    const admissionMs = perf.now() - began;
    requestStats.httpAdmissionMs[profile].push({ ms: admissionMs, guildId });
    const requestId = response.headers.get('x-request-id');
    if (response.status === 202) {
      requestCounts.acceptedHttp++;
      acceptedHttpByOperation.set(operation, (acceptedHttpByOperation.get(operation) ?? 0) + 1);
      const item = await response.json();
      if (existing.caseId) { requestCounts.duplicateRequests++; assert.equal(item.id, existing.caseId, 'idempotent HTTP replay returns the same durable dossier'); }
      else {
        existing.caseId = item.id; existing.httpAcceptedAt = perf.now(); existing.createdAt = new Date(item.createdAt).getTime(); existing.admissionMs = admissionMs; existing.requestId = requestId;
        offeredProfiles[profile].push(operation);
      }
      return { status: 202, item, operationId: operation, requestId, admissionMs };
    }
    const body = await response.json().catch(() => ({}));
    if (response.status === 429 && body.code === 'MODERATION_BACKLOG_LIMIT') requestCounts.refusedAdmission429++;
    else requestCounts.otherErrors++;
    return { status: response.status, body, operationId: operation, requestId, admissionMs };
  }
  async function openLoop(profile, count, rps, guildFor) {
    const origin = perf.now();
    const pending = [];
    for (let index = 0; index < count; index++) {
      const at = origin + index * 1_000 / rps;
      const waitMs = at - perf.now();
      if (waitMs > 0) await sleep(waitMs);
      pending.push(sendAction(profile, guildFor(index)));
    }
    return Promise.all(pending);
  }
  async function waitForCases(operationIds, statuses, description, timeoutMs = 60_000) {
    return until(description, async () => {
      const rows = await prisma.moderationCase.findMany({ where: { operationId: { in: operationIds } }, select: { operationId: true, status: true, expiryStatus: true } });
      return rows.length === operationIds.length && rows.every(row => statuses.includes(row.status)) ? rows : false;
    }, timeoutMs, 50);
  }
  async function drain(operationIds, description) {
    if (!operationIds.length) return;
    await waitForCases(operationIds, ['succeeded'], `${description} PostgreSQL success`);
    await until(`${description} BullMQ queue drain`, async () => Object.values(await queue.getJobCounts('waiting', 'active', 'delayed', 'failed')).every(value => value === 0), 15_000, 50);
  }
  function checkProfileStatuses(profile, operations) {
    const accepted = operations.filter(result => result.status === 202).length;
    assert.equal(accepted, operations.length, `${profile}: expected ${operations.length} admissions, observed ${accepted}; response sample ${JSON.stringify(operations.slice(0, 5).map(result => ({ status: result.status, code: result.body?.code, error: result.body?.error })))}`);
    assert.equal(operations.filter(result => result.status !== 202).length, 0, `${profile}: no unexpected HTTP refusals/errors`);
  }

  const normal = await openLoop('normal', 40, 2, index => guildIds[index % guildIds.length]);
  checkProfileStatuses('normal', normal);
  const normalOpIds = offeredProfiles.normal;
  await drain(normalOpIds, 'normal profile');
  const normalDuplicate = uniqueOperations.get(normalOpIds[0]);
  const duplicate = await sendAction('normal', normalDuplicate.guildId, { id: normalDuplicate.operationId, target: normalDuplicate.target });
  assert.equal(duplicate.status, 202);
  await drain([normalDuplicate.operationId], 'duplicate replay');

  const mixed = await openLoop('mixed', 80, 4, index => index % 4 === 0 ? guildIds[1 + (Math.floor(index / 4) % 3)] : guildIds[0]);
  checkProfileStatuses('mixed', mixed);
  await drain(offeredProfiles.mixed, 'mixed profile');

  let resolveGateEntered;
  let resolveGateRelease;
  const gateEntered = new Promise(resolve => { resolveGateEntered = resolve; });
  const gateRelease = new Promise(resolve => { resolveGateRelease = resolve; });
  activeGate = { guildId: guildIds[0], entered: false, enter: resolveGateEntered, releasePromise: gateRelease, release: resolveGateRelease };
  const held = await sendAction('overload', guildIds[0], { action: 'TIMEOUT', durationMinutes: 1 });
  assert.equal(held.status, 202, 'the first dominant request is admitted before the overload probe');
  await until('simulated Discord action gate entered', () => activeGate.entered, 15_000);
  await gateEntered;
  const overloadStartIndex = offeredProfiles.overload.length;
  const burstResults = await Promise.all(Array.from({ length: 20 }, () => sendAction('overload', guildIds[0])));
  const burstAccepted = burstResults.filter(result => result.status === 202);
  const burstRefused = burstResults.filter(result => result.status === 429 && result.body.code === 'MODERATION_BACKLOG_LIMIT');
  assert.equal(burstAccepted.length, 7, 'with one running operation and cap 8, exactly seven queued operations are admitted');
  assert.equal(burstRefused.length, 13, 'the active-work limit rejects the remaining overload explicitly');
  assert.equal(burstResults.filter(result => result.status !== 202 && result.status !== 429).length, 0, 'overload produces no unrelated API error');
  const quietWhileHeld = await Promise.all([sendAction('overload', guildIds[1]), sendAction('overload', guildIds[2])]);
  assert.ok(quietWhileHeld.every(result => result.status === 202));
  await waitForCases(quietWhileHeld.map(result => result.operationId), ['succeeded'], 'quiet guild operations complete while dominant adapter remains blocked');
  const quietProgressBeforeBarrierRelease = activeGate.entered && quietWhileHeld.every(result => workerFinish.has(result.operationId));
  assert.ok(quietProgressBeforeBarrierRelease, 'quiet guild completion telemetry arrives before releasing the dominant adapter');
  assert.equal(activeGate.entered, true, 'quiet guilds finish before the dominant Discord adapter barrier is released');
  activeGate.release();
  activeGate = undefined;
  await drain([held.operationId, ...burstAccepted.map(result => result.operationId)], 'overload drainage');
  const overloadOperationIds = offeredProfiles.overload.slice(overloadStartIndex);
  assert.equal(overloadOperationIds.length + 1, 10, 'the overload set has one held running, seven queued and two quiet accepted operations');

  const expiryRequest = await sendAction('mixed', guildIds[3], { action: 'TEMPBAN', durationMinutes: 1 });
  assert.equal(expiryRequest.status, 202);
  await waitForCases([expiryRequest.operationId], ['succeeded'], 'temporary ban admission and execution');
  const tempban = await prisma.moderationCase.findUniqueOrThrow({ where: { operationId: expiryRequest.operationId } });
  assert.equal(tempban.expiryStatus, 'scheduled');
  const dueAt = new Date(Date.now() - 1_000);
  await prisma.moderationCase.update({ where: { id: tempban.id }, data: { expiresAt: dueAt } });
  const expiryKey = `expiry-${tempban.id}`;
  await until('scheduled expiry reaches production worker', async () => {
    const row = await prisma.moderationCase.findUnique({ where: { id: tempban.id }, select: { expiryStatus: true } });
    return row?.expiryStatus === 'succeeded';
  }, 20_000, 50);
  await until('expiry BullMQ cleanup', async () => Object.values(await queue.getJobCounts('waiting', 'active', 'delayed', 'failed')).every(value => value === 0), 15_000, 50);
  const expiryStart = workerStart.get(expiryKey);
  const expiryFinishAt = workerFinish.get(expiryKey);
  assert.ok(expiryStart && expiryFinishAt, 'deadline start and completion telemetry is observed in the production worker');
  const expiryRow = await prisma.moderationCase.findUniqueOrThrow({ where: { id: tempban.id } });
  assert.equal(expiryRow.expiryStatus, 'succeeded');
  assert.ok(expiryRow.unbannedAt);

  await until('all accepted operations are terminal', async () => {
    const rows = await prisma.moderationCase.findMany({ where: { operationId: { startsWith: operationPrefix } }, select: { operationId: true, status: true, expiryStatus: true } });
    const expected = [...uniqueOperations.values()].filter(value => value.caseId).length;
    return rows.length === expected && rows.every(row => row.status === 'succeeded' && (row.expiryStatus === null || row.expiryStatus === 'succeeded'));
  }, 20_000, 50);
  await until('no active operation backlog', async () => {
    const pending = await prisma.moderationCase.count({ where: { operationId: { startsWith: operationPrefix }, status: { in: ['requested', 'running'] } } });
    return pending === 0;
  }, 10_000, 50);
  await collectResources();
  const allCases = await prisma.moderationCase.findMany({ where: { operationId: { startsWith: operationPrefix } }, select: { id: true, operationId: true, guildId: true, status: true, expiryStatus: true } });
  const uniqueAccepted = [...uniqueOperations.values()].filter(value => value.caseId);
  const refusedOperationIds = burstResults.filter(result => result.status === 429).map(result => result.operationId);
  assert.equal(allCases.length, uniqueAccepted.length, 'one durable PostgreSQL row exists per unique accepted operation');
  assert.ok(refusedOperationIds.every(id => !allCases.some(row => row.operationId === id)), 'explicit admission refusals leave no durable action row');
  assert.equal(allCases.filter(row => row.status === 'succeeded').length, uniqueAccepted.length);
  assert.equal(requestCounts.otherErrors, 0);
  assert.equal(botLogEvents.length, 0, 'dispatcher, worker and resource sampler emit no errors');
  assert.equal(botObservedExecutionLogs, uniqueAccepted.length + 1, 'one production execution log is observed per action and per separate deadline job');
  const uniqueMutationsExpected = uniqueAccepted.length + 1;
  assert.equal(simulated.timeout + simulated.ban + simulated.unban, uniqueMutationsExpected, 'one Discord-simulated mutation per unique accepted operation plus its separate expiry unban');
  assert.equal(simulated.ban, 1); assert.equal(simulated.unban, 1);

  const metrics = { httpAdmissionMs: Object.fromEntries(Object.entries(requestStats.httpAdmissionMs).map(([profile, values]) => [profile, distribution(values.map(value => value.ms))])),
    dispatcherWaitMs: {}, bullmqQueueWaitMs: {}, workerExecutionMs: {}, acceptToFinishMs: {}, quietProgressWhileDominantBlocked: quietProgressBeforeBarrierRelease,
    deadline: { dueToWorkerStartMs: +(expiryStart.epochMs - dueAt.getTime()).toFixed(2), executionMs: +(expiryFinishAt - expiryStart.at).toFixed(2), dueToFinishMs: +((expiryStart.epochMs - dueAt.getTime()) + (expiryFinishAt - expiryStart.at)).toFixed(2) } };
  for (const profile of ['normal', 'mixed', 'overload']) {
    const refs = [...uniqueOperations.values()].filter(value => value.profile === profile && value.caseId);
    for (const field of ['dispatcherWaitMs', 'bullmqQueueWaitMs', 'workerExecutionMs', 'acceptToFinishMs']) {
      const vals = refs.map(value => {
        const key = value.operationId; const start = workerStart.get(key); const finish = workerFinish.get(key);
        if (!start || finish === undefined) return null;
        if (field === 'dispatcherWaitMs') return Math.max(0, (enqueueStart.get(key)?.epochMs ?? value.createdAt) - value.createdAt);
        if (field === 'bullmqQueueWaitMs') return Math.max(0, (start.at - (publishedAt.get(key) ?? start.at)));
        if (field === 'workerExecutionMs') return finish - start.at;
        return Math.max(0, (finish - (value.httpAcceptedAt ?? perf.now())));
      }).filter(value => value !== null);
      metrics[field][profile] = distribution(vals);
    }
  }
  const mixedOps = uniqueAccepted.filter(value => value.profile === 'mixed');
  for (const [group, predicate] of [
    ['mixedQuiet', value => guildIds.slice(1).includes(value.guildId)],
    ['mixedDominant', value => value.guildId === guildIds[0]],
  ]) {
    const refs = mixedOps.filter(predicate);
    metrics.httpAdmissionMs[group] = distribution(requestStats.httpAdmissionMs.mixed.filter(value => predicate(value)).map(value => value.ms));
    for (const field of ['dispatcherWaitMs', 'bullmqQueueWaitMs', 'workerExecutionMs', 'acceptToFinishMs']) {
      const values = refs.map(value => {
        const key = value.operationId; const start = workerStart.get(key); const finish = workerFinish.get(key);
        if (!start || finish === undefined) return null;
        if (field === 'dispatcherWaitMs') return Math.max(0, (enqueueStart.get(key)?.epochMs ?? value.createdAt) - value.createdAt);
        if (field === 'bullmqQueueWaitMs') return Math.max(0, start.at - (publishedAt.get(key) ?? start.at));
        if (field === 'workerExecutionMs') return finish - start.at;
        return Math.max(0, finish - (value.httpAcceptedAt ?? perf.now()));
      }).filter(value => value !== null);
      metrics[field][group] = distribution(values);
    }
  }
  const admissionLogs = apiLogs.split(/\r?\n/).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(entry => entry?.event === 'moderation_admitted' && entry.operationId?.startsWith(operationPrefix));
  for (const operation of uniqueAccepted) {
    const entries = admissionLogs.filter(entry => entry.operationId === operation.operationId);
    assert.equal(entries.length, acceptedHttpByOperation.get(operation.operationId), 'API emits one admission log per accepted HTTP attempt, including an idempotent duplicate');
    assert.ok(entries.every(entry => entry.requestId !== operation.operationId), 'HTTP requestId remains distinct from operationId');
  }
  const cpu = process.cpuUsage(cpuStart);
  const apiProcessSample = osProcessSample(apiProcess.pid);
  const statusCounts = values => Object.fromEntries([...new Set(values)].map(status => [status, values.filter(value => value === status).length]));
  const quietMutationCount = guildIds.slice(1).reduce((sum, id) => sum + (simulated.callsByGuild.get(id) ?? 0), 0);
  const mixedQuietFinish = metrics.acceptToFinishMs.mixedQuiet;
  const mixedDominantFinish = metrics.acceptToFinishMs.mixedDominant;
  assert.ok(metrics.httpAdmissionMs.normal.p95Ms < 2_000 && metrics.httpAdmissionMs.mixed.p95Ms < 2_000, 'HTTP admission p95 remains under the predeclared 2 s diagnostic ceiling');
  assert.ok(mixedQuietFinish.p95Ms < 5_000, 'mixed-load quiet-guild accept-to-finish p95 remains below 5 s');
  assert.ok(mixedDominantFinish.p95Ms < 10_000, 'mixed-load dominant-guild accept-to-finish p95 remains below 10 s');
  const quietFinished = uniqueAccepted.filter(value => (value.profile === 'mixed' && guildIds.slice(1).includes(value.guildId)) || (value.profile === 'overload' && guildIds.slice(1).includes(value.guildId)));
  assert.ok(quietFinished.length >= 2, 'calm guild operations progress during mixed load and dominant overload');
  assert.ok(requestCounts.refusedAdmission429 > 0, 'bounded overload is visible as explicit active-work refusals');
  assert.ok(samples.length >= 3, 'resource samples cover the running scenario');
  console.info(JSON.stringify({ event: 'http_full_path_performance_result', runId, runtime: process.version,
    isolation: { postgresDatabase: dbName, redisLogicalDb: redisDb, apiProcess: apiProcess.pid, queueName },
    configuration: { normal: { offered: 40, ratePerSecond: 2, seconds: 20 }, mixed: { offered: 80, ratePerSecond: 4, seconds: 20, dominantShare: 0.75 },
      overload: { burstOffered: 20, perGuildActiveLimit: 8, configuredRateLimitsEnabled: { sessionPerMinute: 10_000, preAuthIpPerMinute: 10_000 } }, simulatorLatencyMs: 35, dispatcherPollMs: 1000, workerConcurrency: 4, maxConcurrentActionsPerGuild: 1 },
    requests: { ...requestCounts, uniqueAccepted: uniqueAccepted.length, totalCases: allCases.length, httpAdmissionOtherErrors: requestCounts.otherErrors, persistedDuplicates: allCases.length - uniqueAccepted.length },
    httpStatuses: { normal: statusCounts(normal.map(item => item.status)), mixed: statusCounts(mixed.map(item => item.status)), overloadBurst: statusCounts(burstResults.map(item => item.status)), quietDuringHold: statusCounts(quietWhileHeld.map(item => item.status)) },
    latencies: metrics, simulatedDiscord: { actions: { timeout: simulated.timeout, ban: simulated.ban, unban: simulated.unban }, byGuildProfile: { dominantGuild: simulated.callsByGuild.get(guildIds[0]) ?? 0, calmGuildsCombined: quietMutationCount } },
    resources: { samples: samples.length, apiPeakRssBytes: Math.max(0, ...samples.map(sample => sample.api?.rssBytes ?? 0), apiProcessSample?.rssBytes ?? 0), apiPeakHeapUsedBytes: Math.max(0, ...samples.map(sample => sample.api?.heapUsedBytes ?? 0)), harnessPeakRssBytes: Math.max(0, ...samples.map(sample => sample.workerHarness.rssBytes)), harnessPeakHeapUsedBytes: Math.max(0, ...samples.map(sample => sample.workerHarness.heapUsedBytes)), postgresPeakConnections: Math.max(0, ...samples.map(sample => Number(sample.postgres.connections))), postgresDatabaseBytes: Number(samples.at(-1)?.postgres.database_bytes ?? 0), redisPeakUsedMemoryBytes: Math.max(0, ...samples.map(sample => sample.redis.used_memory)), maxQueueDepthSampled: Math.max(0, ...samples.map(sample => (sample.queue.waiting ?? 0) + (sample.queue.active ?? 0) + (sample.queue.delayed ?? 0))), eventLoopP95MaxMs: Math.max(0, ...samples.map(sample => sample.eventLoopP95Ms)), hostMemoryBytes: { total: os.totalmem(), freeAtEnd: os.freemem() }, apiCpuSecondsAtEnd: apiProcessSample?.cpuSeconds ?? null, harnessCpuUserSeconds: +(cpu.user / 1e6).toFixed(3), harnessCpuSystemSeconds: +(cpu.system / 1e6).toFixed(3) },
    drain: { terminalCases: allCases.length, unfinished: allCases.filter(row => row.status !== 'succeeded' || (row.expiryStatus && row.expiryStatus !== 'succeeded')).length, queue: await queue.getJobCounts('waiting', 'active', 'delayed', 'failed'), simulatedMutations: simulated.timeout + simulated.ban + simulated.unban },
    scope: 'full API HTTP/OAuth-session validation/authorization/CSRF/quota/PostgreSQL admission plus production dispatcher, BullMQ and production worker/executor with controlled Discord adapter; no real Discord; one local host; not a capacity claim' }));
} finally {
  if (activeGate) { try { activeGate.release(); } catch { /* barrier may already be released */ } }
  if (sampleTimer) clearInterval(sampleTimer);
  if (dispatcherTimer) clearInterval(dispatcherTimer);
  loop.disable();
  if (worker) await worker.close().catch(() => undefined);
  if (queue) { await queue.obliterate({ force: true }).catch(() => undefined); await queue.close().catch(() => undefined); }
  if (apiProcess && apiProcess.exitCode === null) { apiProcess.kill('SIGTERM'); await Promise.race([new Promise(resolve => apiProcess.once('exit', resolve)), sleep(5_000)]); if (apiProcess.exitCode === null) apiProcess.kill('SIGKILL'); }
  if (prisma) await prisma.$disconnect().catch(() => undefined);
  if (originalConsoleInfo) console.info = originalConsoleInfo;
  if (originalConsoleError) console.error = originalConsoleError;
  if (adminPool && !droppedDatabase) {
    try { await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); droppedDatabase = true; } catch { console.error(JSON.stringify({ event: 'http_performance_cleanup_warning', resource: 'disposable_database', database: dbName })); }
    await adminPool.end().catch(() => undefined);
  }
}
