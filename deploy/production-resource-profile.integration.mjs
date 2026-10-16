import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

if (process.env.RUN_PRODUCTION_RESOURCE_PROFILE !== '1') throw new Error('Set RUN_PRODUCTION_RESOURCE_PROFILE=1 to run this disposable Docker Compose profile.');
if (process.env.CI !== 'true' && process.env.ALLOW_LOCAL_RESOURCE_PROFILE !== '1') throw new Error('This test only runs in CI or with explicit local opt-in.');

const root = path.resolve(import.meta.dirname, '..');
const composeFile = path.join(root, 'deploy', 'compose.production.yaml');
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const project = `veyrobot-resource-${suffix}`;
const temp = await mkdtemp(path.join(os.tmpdir(), `${project}-`));
const envFile = path.join(temp, 'compose.env');
const overrideFile = path.join(temp, 'compose.override.yaml');
const postgresPassword = `pg-${randomUUID()}`;
const redisPassword = `redis-${randomUUID()}`;
const epoch = randomUUID().replaceAll('-', '').padEnd(64, 'a');
const apiProxySecret = randomUUID() + randomUUID();
const sessionKey = randomUUID().replaceAll('-', '').padEnd(64, 'b');
const apiInspectorPort = 9231;
const dashboardInspectorPort = 9232;
const botInspectorPort = 9233;
const expectedMemory = { postgres: 1024 ** 3, redis: 384 * 1024 ** 2, migrate: 512 * 1024 ** 2, api: 512 * 1024 ** 2, bot: 768 * 1024 ** 2, dashboard: 512 * 1024 ** 2 };
const operationPrefix = `resource_${suffix}_`;
const actorId = '123456789012345679';
const guildIds = Array.from({ length: 24 }, (_, i) => String(800_000_000_000_000_000n + BigInt(parseInt(suffix.slice(0, 6), 16) * 100 + i)));
let prisma;
let redisQueue;
let redisConnection;
let composeDown = false;
let inspectorPorts = {};

function run(command, args, { allowFailure = false, timeout = 600_000 } = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  if (!allowFailure && result.status !== 0) throw new Error(`Disposable resource profile command failed (${path.basename(command)} ${args[0] ?? ''}, exit ${result.status ?? 'unknown'}).`);
  return { stdout: result.stdout?.trim() ?? '', stderr: result.stderr?.trim() ?? '', status: result.status };
}
function runAsync(command, args, { allowFailure = false, timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', status => {
      clearTimeout(timer);
      if (!allowFailure && status !== 0) reject(new Error(`Disposable resource sampler failed (${path.basename(command)} ${args[0] ?? ''}, exit ${status ?? 'unknown'}): ${stderr.trim().slice(0, 500)}`));
      else resolve({ stdout: stdout.trim(), stderr: stderr.trim(), status });
    });
  });
}
const docker = args => run('docker', args);
const composeArgs = ['compose', '--project-name', project, '--env-file', envFile, '--file', composeFile, '--file', overrideFile];
const compose = args => docker([...composeArgs, ...args]);
function yamlString(value) { return JSON.stringify(value.replaceAll('\\', '/')); }
function mappedPort(service, port) {
  const output = compose(['port', service, String(port)]).stdout;
  const match = output.match(/:(\d+)\s*$/);
  if (!match) throw new Error(`No host port was published for disposable service ${service}.`);
  return Number(match[1]);
}
function containerId(service) {
  const id = compose(['ps', '-a', '-q', service]).stdout.split(/\r?\n/).filter(Boolean)[0];
  if (!id) throw new Error(`Compose did not create the disposable ${service} container.`);
  return id;
}
function inspect(id, format) { return docker(['inspect', id, '--format', format]).stdout; }
function parseSize(value) {
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)(B|KiB|MiB|GiB|kB|MB|GB)$/i);
  if (!match) return null;
  const units = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3 };
  return Math.round(Number(match[1]) * units[match[2].toLowerCase()]);
}
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return +(sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0).toFixed(2);
}
async function until(label, predicate, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
async function inspectorHeap(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) });
  const [target] = await response.json();
  if (!target?.webSocketDebuggerUrl) return null;
  const wsUrl = new URL(target.webSocketDebuggerUrl);
  wsUrl.hostname = '127.0.0.1';
  wsUrl.port = String(port);
  const ws = new WebSocket(wsUrl);
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.close(); reject(new Error('Node inspector heap sample timed out.')); }, 2_000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.getHeapUsage' }));
    ws.onerror = () => { clearTimeout(timeout); reject(new Error('Node inspector heap sample failed.')); };
    ws.onmessage = event => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      clearTimeout(timeout);
      ws.close();
      resolve(message.result ? { usedBytes: message.result.usedSize, totalBytes: message.result.totalSize } : null);
    };
  });
}
async function sampleService(service, id) {
  const statLine = (await runAsync('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}|{{.CPUPerc}}', id])).stdout;
  const [usageText, cpuText] = statLine.split('|');
  const [working, limit] = (usageText ?? '').split('/').map(value => value.trim());
  const [currentText, peakText, stateText, restartText, processRssText] = await Promise.all([
    runAsync('docker', ['exec', id, 'cat', '/sys/fs/cgroup/memory.current']),
    runAsync('docker', ['exec', id, 'cat', '/sys/fs/cgroup/memory.peak']),
    runAsync('docker', ['inspect', id, '--format', '{{json .State}}']),
    runAsync('docker', ['inspect', id, '--format', '{{.RestartCount}}']),
    runAsync('docker', ['top', id, '-eo', 'pid,rss,comm']),
  ]);
  const currentCgroup = Number(currentText.stdout);
  const peakCgroup = Number(peakText.stdout);
  const state = JSON.parse(stateText.stdout);
  const result = {
    service, dockerStatsWorkingSetBytes: parseSize(working), dockerStatsLimitBytes: parseSize(limit),
    cgroupCurrentBytes: Number.isFinite(currentCgroup) ? currentCgroup : null,
    cgroupPeakBytes: Number.isFinite(peakCgroup) ? peakCgroup : null,
    summedProcessRssBytes: processRssText.stdout.split(/\r?\n/).slice(1).reduce((sum, line) => sum + Number(line.trim().match(/^\d+\s+(\d+)/)?.[1] ?? 0) * 1024, 0) || null,
    cpuPercent: Number.parseFloat(cpuText) || 0, oomKilled: state.OOMKilled, restartCount: Number(restartText.stdout),
  };
  const inspector = inspectorPorts[service];
  if (inspector) result.nodeHeap = await inspectorHeap(inspector);
  return result;
}

try {
  const secretDir = path.join(temp, 'secrets');
  await import('node:fs/promises').then(fs => fs.mkdir(secretDir, { mode: 0o700 }));
  const passwordFile = path.join(secretDir, 'postgres_password');
  const redisConfigFile = path.join(secretDir, 'redis.conf');
  await writeFile(passwordFile, postgresPassword, { mode: 0o600 });
  await writeFile(redisConfigFile, `requirepass ${redisPassword}\nappendonly yes\nappendfsync everysec\nsave ""\nmaxmemory-policy noeviction\n`, { mode: 0o600 });
  await writeFile(envFile, [
    'NODE_ENV=production', `VEYROBOT_IMAGE_TAG=resource-${suffix}`, 'POSTGRES_USER=veyrobot', `POSTGRES_PASSWORD=${postgresPassword}`, 'POSTGRES_DB=veyrobot',
    `DATABASE_URL=postgresql://veyrobot:${encodeURIComponent(postgresPassword)}@postgres:5432/veyrobot?schema=public`, 'DATABASE_POOL_SIZE=10',
    `REDIS_PASSWORD=${redisPassword}`, `REDIS_URL=redis://:${encodeURIComponent(redisPassword)}@redis:6379`, 'REDIS_MEMORY_LIMIT=384M', 'REDIS_MAXMEMORY=256mb',
    `VEYROBOT_RECOVERY_EPOCH=${epoch}`, 'API_PUBLIC_URL=http://127.0.0.1:3000/api', 'DASHBOARD_URL=http://127.0.0.1:3000',
    'API_RATE_LIMIT_MAX=90', 'API_PREAUTH_RATE_LIMIT_MAX=180', 'API_TRUSTED_PROXIES=', `API_PROXY_CLIENT_IP_SECRET=${apiProxySecret}`,
    'DISCORD_CLIENT_ID=123456789012345678', 'DISCORD_CLIENT_SECRET=fake-resource-profile-oauth-secret', 'DISCORD_BOT_TOKEN=fake-resource-profile-token',
    `SESSION_KEY=${sessionKey}`, 'MAX_PENDING_GLOBAL=5000', 'MAX_PENDING_PER_GUILD=100',
  ].join('\n') + '\n', { mode: 0o600 });
  const botHarness = path.join(root, 'deploy', 'production-resource-worker-harness.mjs');
  await writeFile(overrideFile, `services:\n  postgres:\n    ports:\n      - "127.0.0.1::5432"\n  redis:\n    ports:\n      - "127.0.0.1::6379"\n  api:\n    command: ["node", "--inspect=0.0.0.0:${apiInspectorPort}", "apps/api/dist/index.js"]\n    ports:\n      - "127.0.0.1::4000"\n      - "127.0.0.1::${apiInspectorPort}"\n  dashboard:\n    command: ["node", "--inspect=0.0.0.0:${dashboardInspectorPort}", "apps/dashboard/node_modules/next/dist/bin/next", "start", "apps/dashboard", "-p", "3000"]\n    ports: !override\n      - "127.0.0.1::3000"\n      - "127.0.0.1::${dashboardInspectorPort}"\n  bot:\n    command: ["node", "--inspect=0.0.0.0:${botInspectorPort}", "/tmp/production-resource-worker-harness.mjs"]\n    ports:\n      - "127.0.0.1::${botInspectorPort}"\n    volumes:\n      - type: bind\n        source: ${yamlString(botHarness)}\n        target: /tmp/production-resource-worker-harness.mjs\n        read_only: true\nsecrets:\n  postgres_password:\n    file: ${yamlString(passwordFile)}\n  redis_config:\n    file: ${yamlString(redisConfigFile)}\n`, { mode: 0o600 });

  compose(['up', '-d', 'postgres', 'redis']);
  let dependencyHealthPolls = 0;
  await until('PostgreSQL and Redis health', () => {
    const states = Object.fromEntries(['postgres', 'redis'].map(service => {
      const state = JSON.parse(inspect(containerId(service), '{{json .State}}'));
      return [service, { running: state.Running, health: state.Health?.Status ?? 'none', exitCode: state.ExitCode, restarts: Number(inspect(containerId(service), '{{.RestartCount}}')) }];
    }));
    if (++dependencyHealthPolls % 10 === 0) console.info(JSON.stringify({ event: 'resource_profile_dependency_health', states }));
    return Object.values(states).every(state => state.health === 'healthy');
  });
  compose(['up', '--build', 'migrate']);
  const migrationId = containerId('migrate');
  assert.equal(Number(inspect(migrationId, '{{.State.ExitCode}}')), 0, 'production migration image completed successfully');
  compose(['run', '--rm', '--no-deps', '-e', 'RECOVERY_GATE_INITIALIZE=1', '-e', `VEYROBOT_RECOVERY_EPOCH=${epoch}`, 'migrate', 'corepack', 'pnpm', '--filter', '@veyrobot/db', 'recovery-gate:init']);
  compose(['up', '-d', 'api', 'dashboard', 'bot']);
  await until('API and dashboard healthy and controlled worker alive', () => {
    const apiState = JSON.parse(inspect(containerId('api'), '{{json .State}}'));
    const dashboardState = JSON.parse(inspect(containerId('dashboard'), '{{json .State}}'));
    const botState = JSON.parse(inspect(containerId('bot'), '{{json .State}}'));
    return apiState.Health?.Status === 'healthy' && dashboardState.Health?.Status === 'healthy' && botState.Running;
  });
  console.info(JSON.stringify({ event: 'resource_profile_services_healthy' }));

  const containers = Object.fromEntries(['postgres', 'redis', 'migrate', 'api', 'bot', 'dashboard'].map(service => [service, containerId(service)]));
  const appliedLimits = Object.fromEntries(Object.entries(containers).map(([service, id]) => [service, Number(inspect(id, '{{.HostConfig.Memory}}'))]));
  for (const [service, expected] of Object.entries(expectedMemory)) assert.equal(appliedLimits[service], expected, `${service} actual Compose container cgroup limit`);
  console.info(JSON.stringify({ event: 'resource_profile_cgroup_limits_verified', actualContainerLimitsBytes: appliedLimits }));

  const apiPort = mappedPort('api', 4000);
  const dashboardPort = mappedPort('dashboard', 3000);
  const postgresPort = mappedPort('postgres', 5432);
  const redisPort = mappedPort('redis', 6379);
  inspectorPorts = {
    api: mappedPort('api', apiInspectorPort),
    dashboard: mappedPort('dashboard', dashboardInspectorPort),
    bot: mappedPort('bot', botInspectorPort),
  };
  process.env.DATABASE_URL = `postgresql://veyrobot:${encodeURIComponent(postgresPassword)}@127.0.0.1:${postgresPort}/veyrobot?schema=public`;
  process.env.REDIS_URL = `redis://:${encodeURIComponent(redisPassword)}@127.0.0.1:${redisPort}`;
  const db = await import('../apps/bot/node_modules/@veyrobot/db/dist/index.js');
  const moderation = await import('../apps/bot/node_modules/@veyrobot/moderation/dist/index.js');
  const bullmq = await import('../apps/bot/node_modules/bullmq/dist/cjs/index.js');
  prisma = db.prisma;
  redisConnection = moderation.redisConnection(process.env.REDIS_URL, true);
  redisQueue = new bullmq.Queue('veyrobot-moderation', { connection: redisConnection });
  await redisQueue.waitUntilReady();
  const existing = await prisma.guildConfig.count({ where: { guildId: { in: guildIds } } });
  assert.equal(existing, 0, 'synthetic guild IDs are not already present in the disposable database');
  await prisma.guildConfig.createMany({ data: guildIds.map(guildId => ({ guildId, updatedBy: actorId, memberActionsEnabled: true })) });

  const samples = [];
  const sampleErrors = [];
  const generator = { peakRssBytes: process.memoryUsage().rss, startedRssBytes: process.memoryUsage().rss, totalBytes: os.totalmem(), freeBytes: os.freemem() };
  const hostSamples = [];
  const requestResults = { apiOk: 0, apiErrors: 0, dashboardOk: 0, dashboardErrors: 0 };
  const sampleResources = async () => {
    const services = {};
    for (const service of ['postgres', 'redis', 'api', 'bot', 'dashboard']) services[service] = await sampleService(service, containers[service]);
    const redisClient = await redisQueue.getBackend().client;
    const [redisInfo, dbStats] = await Promise.all([
      redisClient.info('memory'),
      prisma.$queryRaw`SELECT (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS connections, pg_database_size(current_database())::bigint AS "databaseBytes"`,
    ]);
    const counts = await redisQueue.getJobCounts('waiting', 'active', 'delayed', 'failed');
    const memory = redisInfo.split(/\r?\n/);
    const redis = Object.fromEntries(['used_memory', 'used_memory_rss', 'mem_not_counted_for_evict', 'mem_aof_buffer', 'maxmemory', 'connected_clients'].map(key => [key, Number(memory.find(line => line.startsWith(`${key}:`))?.split(':')[1]?.split(',')[0] ?? 0)]));
    const [operations, expiring] = await Promise.all([
      prisma.moderationCase.aggregate({ where: { operationId: { startsWith: operationPrefix }, status: { in: ['requested', 'running'] } }, _count: { _all: true }, _min: { createdAt: true } }),
      prisma.moderationCase.aggregate({ where: { operationId: { startsWith: operationPrefix }, action: 'TEMPBAN', expiryStatus: { in: ['scheduled', 'running'] } }, _count: { _all: true } }),
    ]);
    samples.push({ at: Date.now(), services, redis, queue: counts, postgres: dbStats[0], activeOperations: operations._count._all, oldestActiveOperationAgeMs: operations._min.createdAt ? Date.now() - operations._min.createdAt.getTime() : 0, expiriesPending: expiring._count._all });
    const currentMemory = process.memoryUsage();
    generator.peakRssBytes = Math.max(generator.peakRssBytes, currentMemory.rss);
    hostSamples.push({ at: Date.now(), freeBytes: os.freemem(), totalBytes: os.totalmem(), generatorRssBytes: currentMemory.rss });
  };
  let sampleInProgress = false;
  let activeSamplePromise;
  const sampleTimer = setInterval(() => {
    if (sampleInProgress) return;
    sampleInProgress = true;
    activeSamplePromise = sampleResources().catch(error => {
      sampleErrors.push(error instanceof Error ? error.message : 'unknown sampling error');
      console.error(JSON.stringify({ event: 'resource_profile_sampling_error', message: error instanceof Error ? error.message : 'unknown sampling error' }));
    }).finally(() => { sampleInProgress = false; });
  }, 10_000);
  const healthTimer = setInterval(() => {
    void fetch(`http://127.0.0.1:${apiPort}/health`, { signal: AbortSignal.timeout(2_000) }).then(response => { requestResults[response.ok ? 'apiOk' : 'apiErrors']++; }).catch(() => { requestResults.apiErrors++; });
    void fetch(`http://127.0.0.1:${dashboardPort}/`, { signal: AbortSignal.timeout(4_000) }).then(response => { requestResults[response.ok ? 'dashboardOk' : 'dashboardErrors']++; }).catch(() => { requestResults.dashboardErrors++; });
  }, 500);
  const operations = [];
  const acceptedAt = new Map();
  const arrivalSeconds = 30;
const ratePerSecond = 2;
  const startedAt = performance.now();
  try {
    for (let index = 0; index < arrivalSeconds * ratePerSecond; index++) {
      const dueAt = startedAt + index * 1_000 / ratePerSecond;
      const wait = dueAt - performance.now();
      if (wait > 0) await sleep(wait);
      const operationId = `${operationPrefix}${String(index).padStart(4, '0')}`;
      const guildId = guildIds[index % guildIds.length];
      const targetId = String(850_000_000_000_000_000n + BigInt(parseInt(suffix.slice(0, 6), 16) * 200 + index));
      const data = { operationId, guildId, actorId, targetId, action: 'KICK', reason: 'controlled container resource profile' };
      const admittedAt = performance.now();
      await db.withModerationAdmission(prisma, guildId, operationId, tx => moderation.submitModerationAction(tx, data));
      acceptedAt.set(operationId, { acceptedAt: performance.now(), admissionMs: performance.now() - admittedAt });
      operations.push(operationId);
      if (operations.length % 10 === 0) console.info(JSON.stringify({ event: 'resource_profile_load_progress', accepted: operations.length, offered: arrivalSeconds * ratePerSecond }));
    }
    const drainDeadline = Date.now() + 90_000;
    let rows = [];
    while (Date.now() < drainDeadline) {
      rows = await prisma.moderationCase.findMany({ where: { operationId: { in: operations } }, select: { operationId: true, status: true, createdAt: true, startedAt: true, completedAt: true } });
      if (rows.length === operations.length && rows.every(row => row.status === 'succeeded')) break;
      await sleep(250);
    }
    assert.equal(rows.length, operations.length, 'all generated operations are present in PostgreSQL');
    assert.ok(rows.every(row => row.status === 'succeeded'), 'all controlled production worker actions drain without errors');
    console.info(JSON.stringify({ event: 'resource_profile_drained', completed: rows.length }));
    await until('BullMQ queue drained', async () => Object.values(await redisQueue.getJobCounts('waiting', 'active', 'delayed', 'failed')).every(count => count === 0), 30_000);
    const latency = rows.map(row => ({
      admissionMs: acceptedAt.get(row.operationId).admissionMs,
      acceptToStartMs: row.startedAt ? row.startedAt.getTime() - row.createdAt.getTime() : 0,
      acceptToFinishMs: row.completedAt ? row.completedAt.getTime() - row.createdAt.getTime() : 0,
    }));
    await sampleResources();
    const drainedAt = Date.now();
    while (Date.now() - drainedAt < 30_000) { await sleep(5_000); await sampleResources(); }
    console.info(JSON.stringify({ event: 'resource_profile_idle_observation_complete', seconds: 30 }));
    clearInterval(sampleTimer);
    clearInterval(healthTimer);
    if (activeSamplePromise) await activeSamplePromise;
    const finalSamples = await Promise.all(['postgres', 'redis', 'api', 'bot', 'dashboard'].map(service => sampleService(service, containers[service])));
    assert.equal(requestResults.apiErrors, 0, 'API health remained available during the profile');
    assert.equal(requestResults.dashboardErrors, 0, 'dashboard remained available during the profile');
    assert.equal(sampleErrors.length, 0, 'all scheduled cgroup, process RSS, heap and service samples succeeded');
    assert.equal(samples.some(sample => Object.values(sample.services).some(state => state.oomKilled || state.restartCount !== 0)), false, 'no service OOM or restart occurred');
    const output = {
      event: 'production_resource_profile_passed',
      scope: 'real production Compose images and cgroup limits; direct PostgreSQL admission; production dispatcher/worker/executor with controlled Discord adapter; API health and dashboard GET only; no OAuth or real Discord',
      runtime: { node: process.version, docker: docker(['info', '--format', '{{.ServerVersion}}']).stdout, loadGenerator: 'host process, outside service cgroups', totalServicesCapBytes: Object.values(expectedMemory).filter((_, index) => index !== 2).reduce((sum, value) => sum + value, 0) },
      actualContainerLimitsBytes: appliedLimits,
      workload: { seconds: arrivalSeconds, offered: operations.length, accepted: rows.length, terminal: rows.filter(row => row.status === 'succeeded').length, fakeDiscordKickCalls: rows.length, fakeMutationDelayMs: 50, guilds: guildIds.length, admissionPath: 'production DB use case, no HTTP/OAuth' },
      latencyMs: Object.fromEntries(['admissionMs', 'acceptToStartMs', 'acceptToFinishMs'].map(key => [key, { p50: percentile(latency.map(item => item[key]), .5), p95: percentile(latency.map(item => item[key]), .95), p99: percentile(latency.map(item => item[key]), .99) }])),
      serviceMemory: Object.fromEntries(['postgres', 'redis', 'api', 'bot', 'dashboard'].map(service => [service, { limitBytes: expectedMemory[service], peakCgroupBytes: Math.max(...samples.map(sample => sample.services[service].cgroupPeakBytes ?? 0)), peakSummedProcessRssBytes: Math.max(...samples.map(sample => sample.services[service].summedProcessRssBytes ?? 0)), peakDockerWorkingSetBytes: Math.max(...samples.map(sample => sample.services[service].dockerStatsWorkingSetBytes ?? 0)), peakNodeHeapBytes: service in { api: 1, bot: 1, dashboard: 1 } ? Math.max(...samples.map(sample => sample.services[service].nodeHeap?.usedBytes ?? 0)) : null, finalCgroupBytes: finalSamples.find(sample => sample.service === service)?.cgroupCurrentBytes }])),
      redis: { maxUsedBytes: Math.max(...samples.map(sample => sample.redis.used_memory)), maxRssBytes: Math.max(...samples.map(sample => sample.redis.used_memory_rss)), maxNotCountedForEvictionBytes: Math.max(...samples.map(sample => sample.redis.mem_not_counted_for_evict)), maxAofBufferBytes: Math.max(...samples.map(sample => sample.redis.mem_aof_buffer)), maxmemoryBytes: samples.at(-1)?.redis.maxmemory, finalQueue: samples.at(-1)?.queue, maxPendingOperations: Math.max(...samples.map(sample => sample.activeOperations)), maxOldestOperationAgeMs: Math.max(...samples.map(sample => sample.oldestActiveOperationAgeMs)) },
      postgres: { maxConnections: Math.max(...samples.map(sample => Number(sample.postgres.connections))), finalDatabaseBytes: Number(samples.at(-1)?.postgres.databaseBytes) },
      loadGenerator: { startedRssBytes: generator.startedRssBytes, peakRssBytes: generator.peakRssBytes, totalHostMemoryBytes: generator.totalBytes, minHostFreeBytes: Math.min(...hostSamples.map(row => row.freeBytes)), samples: samples.length },
      requests: requestResults,
      samplingErrors: sampleErrors.length,
    };
    console.info(JSON.stringify(output));
  } finally {
    clearInterval(sampleTimer);
    clearInterval(healthTimer);
    if (activeSamplePromise) await activeSamplePromise;
  }
} finally {
  if (prisma) {
    await prisma.moderationCase.deleteMany({ where: { operationId: { startsWith: operationPrefix } } }).catch(() => undefined);
    await prisma.guildConfig.deleteMany({ where: { guildId: { in: guildIds }, updatedBy: actorId } }).catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
  if (redisQueue) await redisQueue.close().catch(() => undefined);
  // redisConnection is a BullMQ connection-options object; Queue.close owns
  // and closes the actual Redis client created from it.
  if (!composeDown) { compose(['down', '--volumes', '--remove-orphans']); composeDown = true; }
  await rm(temp, { recursive: true, force: true });
}
