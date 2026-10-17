import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

if (process.env.RUN_REDIS_MEMORY_INTEGRATION !== '1') throw new Error('Set RUN_REDIS_MEMORY_INTEGRATION=1 to run disposable Redis memory tests.');

const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const names = [`veyrobot-aof-${suffix}`, `veyrobot-oom-${suffix}`];
function docker(args, { allowFailure = false } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  if (!allowFailure && result.status !== 0) throw new Error(`docker ${args[0]} failed with ${result.status}: ${result.stderr?.slice(0, 1000)}`);
  return { status: result.status, stdout: result.stdout?.trim() ?? '', stderr: result.stderr?.trim() ?? '' };
}
function stats(name) {
  const [working, limit] = docker(['stats', '--no-stream', '--format', '{{.MemUsage}}', name]).stdout.split('/').map(x => x.trim());
  const bytes = value => {
    const match = value.match(/^([\d.]+)(B|KiB|MiB|GiB)$/);
    return match ? Math.round(Number(match[1]) * ({ B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 })[match[2]]) : null;
  };
  const inspectState = JSON.parse(docker(['inspect', name, '--format', '{{json .State}}']).stdout);
  const cgroupCurrent = Number(docker(['exec', name, 'cat', '/sys/fs/cgroup/memory.current']).stdout);
  const cgroupPeak = Number(docker(['exec', name, 'cat', '/sys/fs/cgroup/memory.peak']).stdout);
  return { workingBytes: bytes(working), limitBytes: bytes(limit), cgroupCurrentBytes: cgroupCurrent || null, cgroupPeakBytes: cgroupPeak || null, oomKilled: inspectState.OOMKilled, running: inspectState.Running, exitCode: inspectState.ExitCode };
}
function pipeRedis(name, count) {
  return new Promise((resolve, reject) => {
    const writer = String.raw`
      const { spawn } = require('node:child_process');
      const { randomBytes } = require('node:crypto');
      const name = process.argv[1];
      const count = Number(process.argv[2]);
      const client = spawn('docker', ['exec', '-i', name, 'redis-cli', '--pipe'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stdout = ''; let stderr = '';
      client.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      client.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      const frame = values => Buffer.concat([Buffer.from('*' + values.length + '\r\n'), ...values.flatMap(value => { const b = Buffer.from(value); return [Buffer.from('$' + b.length + '\r\n'), b, Buffer.from('\r\n')]; })]);
      const done = new Promise((resolve, reject) => { client.on('error', reject); client.on('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error('redis-cli pipe exited ' + code + ': ' + stderr.slice(0, 300)))); });
      client.stdin.write(frame(['BGREWRITEAOF']));
      (async () => {
        for (let i = 0; i < count; i++) {
          const key = 'activity:' + i;
          const value = randomBytes(8192).toString('base64');
          client.stdin.write(frame(['SET', key, value]));
          if (i % 10 === 0) await new Promise(resolve => setTimeout(resolve, 25));
        }
        client.stdin.end();
      })().catch(error => client.stdin.destroy(error));
      done.then(result => process.stdout.write(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
    `;
    const child = spawn(process.execPath, ['-e', writer, name, String(count)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 90_000);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', status => {
      clearTimeout(timer);
      if (timedOut) reject(new Error('Redis pipeline exceeded its 90 second test bound.'));
      else if (status === 0) resolve(JSON.parse(stdout));
      else reject(new Error(`Redis pipeline exited ${status}: ${stderr.slice(0, 1000) || stdout.slice(-1000) || 'no output from redis-cli'}`));
    });
  });
}
async function waitFor(label, predicate, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (predicate()) return; await sleep(250); }
  throw new Error(`Timed out waiting for ${label}`);
}
const cleanups = [];
try {
  const version = docker(['run', '--rm', 'redis:7-alpine', 'redis-server', '--version']).stdout;
  assert.match(version, /v=7\./);
  const volume = `veyrobot-aof-data-${suffix}`;
  docker(['volume', 'create', volume]);
  cleanups.push(() => docker(['volume', 'rm', '-f', volume], { allowFailure: true }));
  const aof = names[0];
  docker(['run', '-d', '--name', aof, '--memory=512m', '--memory-swap=512m', '-v', `${volume}:/data`, 'redis:7-alpine', 'redis-server', '--appendonly', 'yes', '--appendfsync', 'everysec', '--save', '', '--maxmemory', '256mb', '--maxmemory-policy', 'noeviction', '--dir', '/data']);
  cleanups.push(() => docker(['rm', '-f', aof], { allowFailure: true }));
  await sleep(1_000);
  const initialState = JSON.parse(docker(['inspect', aof, '--format', '{{json .State}}']).stdout);
  assert.equal(initialState.Running, true, 'AOF Redis starts under its configured cgroup limit');
  const [hostConfig, redisVersion] = [
    JSON.parse(docker(['inspect', aof, '--format', '{{json .HostConfig}}']).stdout),
    docker(['exec', aof, 'redis-cli', 'INFO', 'server']).stdout.match(/redis_version:([^\r\n]+)/)?.[1],
  ];
  assert.equal(hostConfig.Memory, 512 * 1024 ** 2);
  assert.equal(hostConfig.MemorySwap, 512 * 1024 ** 2, 'Redis rewrite container has no swap allowance beyond its cgroup memory limit');
  assert.equal(docker(['exec', aof, 'redis-cli', 'CONFIG', 'GET', 'maxmemory']).stdout.split(/\r?\n/)[1], '268435456');
  assert.equal(docker(['exec', aof, 'redis-cli', 'CONFIG', 'GET', 'maxmemory-policy']).stdout.split(/\r?\n/)[1], 'noeviction');
  assert.equal(docker(['exec', aof, 'redis-cli', 'CONFIG', 'SET', 'auto-aof-rewrite-percentage', '0']).stdout, 'OK', 'automatic AOF rewrite is disabled so the measured rewrite is the explicit test operation');
  let seedInput = '';
  for (let i = 0; i < 60_000; i++) {
    const key = `seed:${i}`;
    const value = randomBytes(2048).toString('base64');
    seedInput += `*3\r\n$3\r\nSET\r\n$${key.length}\r\n${key}\r\n$${value.length}\r\n${value}\r\n`;
  }
  const seeded = spawnSync('docker', ['exec', '-i', aof, 'redis-cli', '--pipe'], { input: seedInput, encoding: 'utf8', timeout: 120_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(seeded.status, 0, `representative AOF data written (${seeded.stderr?.slice(0, 300) ?? 'no stderr'})`);
  await waitFor('Redis is idle after fixture seeding', () => /aof_rewrite_in_progress:0\r?\n/.test(docker(['exec', aof, 'redis-cli', 'INFO', 'persistence']).stdout));
  const concurrentWrites = 1_000;
  const writer = pipeRedis(aof, concurrentWrites);
  const memorySamples = [];
  let rewriteObservedDuringSampling = false;
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    const [info, persistenceInfo] = [docker(['exec', aof, 'redis-cli', 'INFO', 'memory']).stdout, docker(['exec', aof, 'redis-cli', 'INFO', 'persistence']).stdout];
    rewriteObservedDuringSampling ||= /aof_rewrite_in_progress:1/.test(persistenceInfo);
    const combinedInfo = `${info}\n${persistenceInfo}`;
    const keys = ['used_memory', 'used_memory_rss', 'mem_not_counted_for_evict', 'mem_aof_buffer', 'aof_rewrite_buffer_length', 'current_cow_size', 'current_cow_peak', 'aof_last_cow_size'];
    const metrics = Object.fromEntries(keys.map(key => [key, Number(combinedInfo.match(new RegExp(`^${key}:(\\d+)`, 'm'))?.[1] ?? 0)]));
    memorySamples.push({ at: Date.now(), container: stats(aof), redis: metrics });
    const rewrite = docker(['exec', aof, 'redis-cli', 'INFO', 'persistence']).stdout;
    if (/aof_rewrite_in_progress:0\r?\n/.test(rewrite) && /aof_last_bgrewrite_status:ok/.test(rewrite) && await Promise.race([writer.then(() => true), sleep(0).then(() => false)])) break;
    await sleep(250);
  }
  const writerResult = await writer;
  assert.match(writerResult.stdout, /errors: 0/);
  assert.match(writerResult.stdout, /replies: 1001/);
  assert.equal(rewriteObservedDuringSampling, true, 'sampling overlapped the AOF rewrite');
  const persistence = docker(['exec', aof, 'redis-cli', 'INFO', 'persistence']).stdout;
  assert.match(persistence, /aof_last_bgrewrite_status:ok/);
  const dbsize = Number(docker(['exec', aof, 'redis-cli', 'DBSIZE']).stdout);
  assert.ok(dbsize >= 61_000);
  assert.ok(memorySamples.length > 0);
  const aofPeakCgroupBytes = Math.max(...memorySamples.map(row => row.container.cgroupPeakBytes ?? 0));
  const aofPeakRssBytes = Math.max(...memorySamples.map(row => row.container.workingBytes ?? 0));
  const redisMetricsMax = Object.fromEntries(['used_memory', 'used_memory_rss', 'mem_not_counted_for_evict', 'mem_aof_buffer', 'aof_rewrite_buffer_length', 'current_cow_size', 'current_cow_peak', 'aof_last_cow_size'].map(key => [key, Math.max(...memorySamples.map(row => row.redis[key] ?? 0))]));

  const oom = names[1];
  const oomVolume = `veyrobot-oom-data-${suffix}`;
  docker(['volume', 'create', oomVolume]);
  cleanups.push(() => docker(['volume', 'rm', '-f', oomVolume], { allowFailure: true }));
  docker(['run', '-d', '--name', oom, '--memory=48m', '--memory-swap=48m', '-v', `${oomVolume}:/data`, 'redis:7-alpine', 'redis-server', '--appendonly', 'yes', '--appendfsync', 'everysec', '--save', '', '--dir', '/data']);
  cleanups.push(() => docker(['rm', '-f', oom], { allowFailure: true }));
  await sleep(1_000);
  const oomHostConfig = JSON.parse(docker(['inspect', oom, '--format', '{{json .HostConfig}}']).stdout);
  assert.equal(oomHostConfig.Memory, 48 * 1024 ** 2, 'low cgroup limit for the OOM scenario was applied');
  assert.equal(oomHostConfig.MemorySwap, 48 * 1024 ** 2, 'OOM scenario disables swap so Docker reports a cgroup OOM');
  assert.equal(docker(['exec', oom, 'redis-cli', 'CONFIG', 'GET', 'maxmemory']).stdout.split(/\r?\n/)[1], '0', 'OOM scenario disables Redis maxmemory so it tests cgroup OOM, not maxmemory rejection');
  docker(['exec', oom, 'redis-cli', 'CONFIG', 'SET', 'appendfsync', 'always']);
  docker(['exec', oom, 'redis-cli', 'SET', 'durable:probe', 'before-oom']);
  const preOomPersistence = docker(['exec', oom, 'redis-cli', 'INFO', 'persistence']).stdout;
  assert.match(preOomPersistence, /aof_last_write_status:ok/);
  assert.match(preOomPersistence, /aof_pending_bio_fsync:0/);
  docker(['exec', oom, 'redis-cli', 'CONFIG', 'SET', 'appendonly', 'no']);
  await waitFor('AOF disabled before synthetic OOM writes', () => /aof_enabled:0/.test(docker(['exec', oom, 'redis-cli', 'INFO', 'persistence']).stdout));
  const block = 'z'.repeat(1024 * 1024);
  let oomInput = '';
  for (let i = 0; i < 96; i++) oomInput += `*3\r\n$3\r\nSET\r\n$${String(`oom:${i}`).length}\r\noom:${i}\r\n$${block.length}\r\n${block}\r\n`;
  spawnSync('docker', ['exec', '-i', oom, 'redis-cli', '--pipe'], { input: oomInput, encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  await waitFor('Redis container OOM kill', () => JSON.parse(docker(['inspect', oom, '--format', '{{json .State}}']).stdout).OOMKilled === true, 30_000);
  const oomState = JSON.parse(docker(['inspect', oom, '--format', '{{json .State}}']).stdout);
  assert.equal(oomState.OOMKilled, true, 'this is a container OOM kill, not a maxmemory rejection');
  docker(['start', oom]);
  await waitFor('Redis AOF recovery after OOM', () => docker(['exec', oom, 'redis-cli', 'PING'], { allowFailure: true }).stdout === 'PONG', 30_000);
  const recovered = docker(['exec', oom, 'redis-cli', 'GET', 'durable:probe']).stdout;
  assert.equal(recovered, 'before-oom', 'the probe was fsynced before the OOM filler and recovered from AOF');
  console.info(JSON.stringify({
    event: 'redis_memory_integration_passed',
    redisVersion,
    aofRewrite: { cgroupLimitBytes: hostConfig.Memory, redisMaxmemoryBytes: 256 * 1024 ** 2, configuredHeadroomBytes: hostConfig.Memory - 256 * 1024 ** 2, peakCgroupBytes: aofPeakCgroupBytes, peakDockerStatsWorkingSetBytes: aofPeakRssBytes, redisMaxima: redisMetricsMax, dataKeysAfterRewrite: dbsize, concurrentWriteBatchSize: concurrentWrites, completion: 'aof_last_bgrewrite_status=ok' },
    oom: { cgroupLimitBytes: 48 * 1024 ** 2, oomKilled: oomState.OOMKilled, exitCode: oomState.ExitCode, recoveredAofProbe: 'before-oom (fsync confirmed before incident)', restarted: true },
    limitation: 'Standalone Redis process evidence only; PostgreSQL durable operation and production worker recovery during cgroup OOM are covered only by separate maxmemory-saturation integration, not by this OOM scenario.',
  }));
} finally {
  for (const cleanup of cleanups.reverse()) { try { cleanup(); } catch {} }
}
