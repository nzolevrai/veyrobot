import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

if (process.env.RUN_REDIS_MEMORY_INTEGRATION !== '1') throw new Error('Set RUN_REDIS_MEMORY_INTEGRATION=1 to run disposable Redis memory tests.');

const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const names = [`veyrobot-aof-${suffix}`, `veyrobot-oom-${suffix}`];
let oomObserver;
function docker(args, { allowFailure = false, timeoutMs = 120_000 } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  if (!allowFailure && result.status !== 0) throw new Error(`docker ${args[0]} failed with ${result.status}: ${result.stderr?.slice(0, 1000)}`);
  return { status: result.status, signal: result.signal, error: result.error ? { name: result.error.name, code: result.error.code, message: result.error.message } : undefined, timedOut: result.error?.code === 'ETIMEDOUT', stdout: result.stdout?.trim() ?? '', stderr: result.stderr?.trim() ?? '' };
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
function dockerMemoryBytes(value) {
  const match = /^([\d.]+)(B|KiB|MiB|GiB)$/.exec(value?.trim() ?? '');
  return match ? Math.round(Number(match[1]) * ({ B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 })[match[2]]) : null;
}
function externalStatsSummary(rows) {
  const samples = rows.map(sample => ({ ...sample, workingBytes: dockerMemoryBytes(sample.memory?.split('/')[0]) }));
  const peak = samples.reduce((best, sample) => sample.workingBytes !== null && (!best || sample.workingBytes > best.workingBytes) ? sample : best, null);
  return { sampleCount: samples.length, first: samples[0] ?? null, last: samples.at(-1) ?? null, sampledPeak: peak };
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
function hostCgroupSnapshot(pid) {
  if (process.platform !== 'linux' || !pid) return { available: false, reason: 'host cgroup files are not visible from this runner' };
  try {
    const entry = readFileSync(`/proc/${pid}/cgroup`, 'utf8').split(/\r?\n/).find(line => line.startsWith('0::'));
    if (!entry) return { available: false, reason: 'unified cgroup path unavailable' };
    const relative = entry.slice(3).replace(/^\/+/, '');
    const base = `/sys/fs/cgroup/${relative}`;
    const read = file => readFileSync(`${base}/${file}`, 'utf8').trim();
    return { available: true, current: read('memory.current'), peak: read('memory.peak'), max: read('memory.max'), swapCurrent: read('memory.swap.current'), swapMax: read('memory.swap.max'), events: read('memory.events') };
  } catch (error) {
    return { available: false, reason: `${error.code ?? error.name}: host cgroup read unavailable` };
  }
}
function hostPressureSnapshot() {
  if (process.platform !== 'linux') return { available: false, reason: 'host /proc is not visible from this runner' };
  try {
    const psi = readFileSync('/proc/pressure/memory', 'utf8').trim().slice(0, 1000);
    const meminfo = readFileSync('/proc/meminfo', 'utf8').split(/\r?\n/).filter(line => /^(MemTotal|MemAvailable|SwapTotal|SwapFree):/.test(line)).join('\n');
    return { available: true, psi, meminfo };
  } catch (error) {
    return { available: false, reason: `${error.code ?? error.name}: host memory pressure unavailable` };
  }
}
function kernelOomEvidence() {
  if (process.platform !== 'linux') return { available: false, reason: 'kernel log is not visible from this runner' };
  const result = spawnSync('dmesg', ['--ctime'], { encoding: 'utf8', timeout: 2_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  if (result.status !== 0) return { available: false, status: result.status, error: result.error?.code, reason: 'dmesg unavailable or permission denied' };
  const lines = (result.stdout ?? '').split(/\r?\n/).filter(line => /out of memory|oom-kill|oom_reaper|killed process|memory cgroup out of memory/i.test(line));
  return { available: true, matchingLines: lines.slice(-20) };
}
function startDockerObserver(name) {
  const events = spawn('docker', ['events', '--filter', 'type=container', '--filter', `container=${name}`, '--format', '{{json .}}'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const state = { events: [], stats: [], errors: [], statsReady: false };
  const pushLine = (target, line, limit = 80) => { if (!line.trim()) return; target.push(line.slice(0, 2_000)); if (target.length > limit) target.shift(); };
  let buffer = '';
  events.stdout.setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? '';
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        state.events.push({ type: event.Type, action: event.Action, timeNano: event.timeNano, name: event.Actor?.Attributes?.name, exitCode: event.Actor?.Attributes?.exitCode, signal: event.Actor?.Attributes?.signal });
        if (state.events.length > 80) state.events.shift();
      } catch { pushLine(state.errors, 'unparseable docker event'); }
    }
  });
  events.stderr.setEncoding('utf8').on('data', chunk => pushLine(state.errors, chunk));
  events.on('error', error => pushLine(state.errors, `docker events ${error.code ?? error.name}`));
  const startStats = () => {
    const stats = spawn('docker', ['stats', '--format', '{{json .}}', name], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let statsBuffer = '';
    stats.stdout.setEncoding('utf8').on('data', chunk => {
      statsBuffer += chunk.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
      const lines = statsBuffer.split(/\r?\n/); statsBuffer = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const row = JSON.parse(line);
          state.stats.push({ memory: row.MemUsage, memoryPercent: row.MemPerc, processes: row.PIDs, at: new Date().toISOString() });
          if (state.stats.length > 40) state.stats.shift();
          state.statsReady = true;
        } catch { if (line.trim()) pushLine(state.errors, 'unparseable docker stats row'); }
      }
    });
    stats.stderr.setEncoding('utf8').on('data', chunk => pushLine(state.errors, `docker stats: ${chunk}`));
    stats.on('error', error => pushLine(state.errors, `docker stats ${error.code ?? error.name}`));
    state.statsProcess = stats;
  };
  const hasEvent = action => state.events.some(event => event.action === action);
  return {
    state,
    startStats,
    async waitForEvent(action, timeoutMs = 10_000) {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        if (hasEvent(action)) return;
        if (events.exitCode !== null) throw new Error(`docker events exited before ${action}: ${state.errors.join('\n')}`);
        await sleep(25);
      }
      throw new Error(`Timed out waiting for Docker ${action} event; events=${JSON.stringify(state.events)}; errors=${JSON.stringify(state.errors)}`);
    },
    async waitForStats(timeoutMs = 10_000) {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) { if (state.statsReady) return; await sleep(25); }
      throw new Error(`Timed out waiting for external docker stats; errors=${JSON.stringify(state.errors)}`);
    },
    async stop() {
      for (const child of [state.statsProcess, events]) {
        if (!child) continue;
        if (child.exitCode === null) child.kill('SIGTERM');
        if (child.exitCode === null) await Promise.race([new Promise(resolve => child.once('close', resolve)), sleep(1_000)]);
      }
    },
  };
}
function oomSnapshot(name, observer, pid) {
  const inspectResult = docker(['inspect', name, '--format', '{{json .State}}|||{{json .HostConfig}}'], { allowFailure: true, timeoutMs: 3_000 });
  let state;
  let hostConfig;
  const [stateJson, hostConfigJson] = inspectResult.stdout.split('|||');
  try { state = JSON.parse(stateJson); } catch {}
  try { hostConfig = JSON.parse(hostConfigJson); } catch {}
  return {
    state: state ? { running: state.Running, oomKilled: state.OOMKilled, exitCode: state.ExitCode, error: state.Error } : { inspectStatus: inspectResult.status, error: inspectResult.error, stderr: inspectResult.stderr.slice(0, 500) },
    limits: hostConfig ? { memoryBytes: hostConfig.Memory, memorySwapBytes: hostConfig.MemorySwap } : { inspectStatus: inspectResult.status, error: inspectResult.error },
    externalDockerStats: observer.state.stats.slice(-8),
    dockerEvents: observer.state.events.slice(-15),
    hostCgroup: hostCgroupSnapshot(pid),
    hostPressure: hostPressureSnapshot(),
    kernelOomEvidence: kernelOomEvidence(),
  };
}
function oomFailureDiagnostics(name, fillResult, observer, pid, before) {
  const snapshot = oomSnapshot(name, observer, pid);
  const logs = docker(['logs', '--tail', '60', name], { allowFailure: true, timeoutMs: 5_000 });
  return JSON.stringify({ before, fill: fillResult, snapshot, recentDockerEvents: observer.state.events.slice(-15), observerErrors: observer.state.errors.slice(-10), containerLogs: { status: logs.status, signal: logs.signal, error: logs.error, stdout: logs.stdout.slice(-3000), stderr: logs.stderr.slice(-1000) } });
}
async function runOomFill(name, observer, pid, { maxCommands = 96, valueBytes = 1024 * 1024, timeoutMs = 30_000 } = {}) {
  const client = spawn('docker', ['exec', '-i', name, 'redis-cli', '--pipe'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  let spawnError;
  let timedOut = false;
  let clientTerminatedAfterOom = false;
  let oomObservedDuringFill = false;
  let commandsSent = 0;
  let bytesSent = 0;
  let lastProgress;
  const progressSamples = [];
  const hostSamples = [];
  let stdinError;
  const startedAt = Date.now();
  const sampler = setInterval(() => {
    hostSamples.push({ atMs: Date.now() - startedAt, cgroup: hostCgroupSnapshot(pid), pressure: hostPressureSnapshot() });
    if (hostSamples.length > 100) hostSamples.shift();
  }, 100);
  const appendBounded = (current, chunk) => (current + chunk.toString('utf8')).slice(-6_000);
  client.stdout.on('data', chunk => { stdout = appendBounded(stdout, chunk); });
  client.stderr.on('data', chunk => { stderr = appendBounded(stderr, chunk); });
  client.on('error', error => { spawnError = { name: error.name, code: error.code, message: error.message.slice(0, 500) }; });
  client.stdin.on('error', error => { stdinError = { name: error.name, code: error.code, message: error.message.slice(0, 500) }; });
  const closed = new Promise(resolve => client.once('close', (status, signal) => resolve({ status, signal })));
  const timeout = setTimeout(() => { timedOut = true; client.kill('SIGTERM'); }, timeoutMs);
  const frame = (key, value) => {
    const keyBuffer = Buffer.from(key);
    return Buffer.concat([
      Buffer.from(`*3\r\n$3\r\nSET\r\n$${keyBuffer.length}\r\n`), keyBuffer, Buffer.from(`\r\n$${value.length}\r\n`), value, Buffer.from('\r\n'),
    ]);
  };
  const writeFrame = buffer => new Promise((resolve, reject) => {
    if (client.stdin.destroyed || client.exitCode !== null) { reject(new Error('redis-cli pipe closed before the next bounded write')); return; }
    client.stdin.write(buffer, error => error ? reject(error) : resolve());
  });
  let closeResult;
  let writeError;
  const value = Buffer.alloc(valueBytes, 0x7a);
  try {
    for (let index = 0; index < maxCommands && !timedOut; index++) {
      const command = frame(`oom:${index}`, value);
      try { await writeFrame(command); }
      catch (error) {
        writeError = { name: error.name, code: error.code, message: error.message.slice(0, 500) };
        lastProgress = { externalDockerStats: observer.state.stats.at(-1), hostCgroup: hostCgroupSnapshot(pid), hostPressure: hostPressureSnapshot() };
        progressSamples.push({ commandsSent, bytesSent, externalMemory: lastProgress.externalDockerStats?.memory, hostCgroup: lastProgress.hostCgroup });
        oomObservedDuringFill = observer.state.events.some(event => event.action === 'oom');
        break;
      }
      commandsSent++;
      bytesSent += command.length;
      if (commandsSent % 4 === 0) {
        lastProgress = { externalDockerStats: observer.state.stats.at(-1), hostCgroup: hostCgroupSnapshot(pid), hostPressure: hostPressureSnapshot() };
        progressSamples.push({ commandsSent, bytesSent, externalMemory: lastProgress.externalDockerStats?.memory, hostCgroup: lastProgress.hostCgroup });
        if (progressSamples.length > 5) progressSamples.shift();
        oomObservedDuringFill = observer.state.events.some(event => event.action === 'oom');
        console.info(JSON.stringify({ event: 'redis_cgroup_oom_fill_progress', commandsSent, bytesSent, elapsedMs: Date.now() - startedAt, externalDockerStats: lastProgress.externalDockerStats, hostCgroup: lastProgress.hostCgroup, hostPressure: lastProgress.hostPressure, recentDockerActions: observer.state.events.slice(-3).map(event => ({ action: event.action, exitCode: event.exitCode, signal: event.signal })) }));
        if (oomObservedDuringFill || observer.state.events.some(event => event.action === 'die')) break;
        if (Date.now() - startedAt >= timeoutMs) { timedOut = true; client.kill('SIGTERM'); break; }
      }
    }
  } finally {
    clearTimeout(timeout);
    clearInterval(sampler);
    if (!client.stdin.destroyed) client.stdin.end();
    const closeWaitMs = oomObservedDuringFill ? 3_000 : Math.max(1, timeoutMs - (Date.now() - startedAt));
    closeResult = await Promise.race([closed, sleep(closeWaitMs).then(() => undefined)]);
    if (!closeResult && client.exitCode === null) {
      if (!oomObservedDuringFill) timedOut = true;
      client.kill('SIGTERM');
      clientTerminatedAfterOom = oomObservedDuringFill;
      closeResult = await Promise.race([closed, sleep(1_000).then(() => undefined)]);
    }
  }
  const summary = `${stdout}\n${stderr}`;
  const parsedErrors = summary.match(/errors:\s*(\d+)/i);
  const parsedReplies = summary.match(/replies:\s*(\d+)/i);
  const result = {
    status: closeResult?.status ?? client.exitCode,
    signal: closeResult?.signal ?? client.signalCode,
    spawnError,
    writeError,
    stdinError,
    timedOut,
    clientTerminatedAfterOom,
    oomObservedDuringFill,
    commandsSent,
    bytesSent,
    maxCommands,
    valueBytes,
    elapsedMs: Date.now() - startedAt,
    stdout: stdout.slice(-6_000),
    stderr: stderr.slice(-6_000),
    pipelineErrors: parsedErrors ? Number(parsedErrors[1]) : undefined,
    pipelineReplies: parsedReplies ? Number(parsedReplies[1]) : undefined,
    lastProgress,
    progressSamples,
    hostSampling: {
      sampleCount: hostSamples.length,
      cgroupReadableSamples: hostSamples.filter(sample => sample.cgroup.available).length,
      firstCgroup: hostSamples.find(sample => sample.cgroup.available)?.cgroup,
      lastCgroup: hostSamples.findLast(sample => sample.cgroup.available)?.cgroup,
      firstHostPressure: hostSamples.find(sample => sample.pressure.available)?.pressure,
      lastHostPressure: hostSamples.findLast(sample => sample.pressure.available)?.pressure,
    },
  };
  return result;
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
  // Subscribe before container creation so start/oom/die events cannot be missed.
  oomObserver = startDockerObserver(oom);
  docker(['run', '-d', '--name', oom, '--memory=48m', '--memory-swap=48m', '-v', `${oomVolume}:/data`, 'redis:7-alpine', 'redis-server', '--appendonly', 'yes', '--appendfsync', 'everysec', '--save', '', '--dir', '/data']);
  cleanups.push(() => docker(['rm', '-f', oom], { allowFailure: true }));
  await oomObserver.waitForEvent('start');
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
  const oomPid = JSON.parse(docker(['inspect', oom, '--format', '{{json .State}}']).stdout).Pid;
  const preFillEvidence = { at: new Date().toISOString(), cgroup: hostCgroupSnapshot(oomPid), hostPressure: hostPressureSnapshot(), kernelOomEvidence: kernelOomEvidence(), events: oomObserver.state.events.slice(-10) };
  oomObserver.startStats();
  await oomObserver.waitForStats();
  const oomFill = await runOomFill(oom, oomObserver, oomPid, { maxCommands: 96, valueBytes: 1024 * 1024, timeoutMs: 30_000 });
  let observedOom = false;
  try {
    await waitFor('Redis container OOM kill', () => {
      const result = docker(['inspect', oom, '--format', '{{json .State}}'], { allowFailure: true, timeoutMs: 5_000 });
      try { observedOom = JSON.parse(result.stdout).OOMKilled === true; } catch {}
      return observedOom;
    }, 5_000);
    await oomObserver.waitForEvent('oom', 5_000);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- OOM diagnostics before cleanup ---\n${oomFailureDiagnostics(oom, oomFill, oomObserver, oomPid, preFillEvidence)}`);
  }
  const oomState = JSON.parse(docker(['inspect', oom, '--format', '{{json .State}}']).stdout);
  const preRestartDiagnostics = oomFailureDiagnostics(oom, oomFill, oomObserver, oomPid, preFillEvidence);
  assert.equal(oomState.OOMKilled, true, `this is a container OOM kill, not a maxmemory rejection; fill=${JSON.stringify(oomFill)}; diagnostics=${preRestartDiagnostics}`);
  assert.ok(oomObserver.state.events.some(event => event.action === 'oom'), `Docker daemon emitted an oom event; diagnostics=${preRestartDiagnostics}`);
  assert.ok(oomFill.commandsSent > 0, 'the controlled pipeline sent at least one bounded SET before the cgroup OOM');
  assert.equal(oomFill.timedOut, false, `the Redis pipe must not hit its 30 second test bound; fill=${JSON.stringify(oomFill)}; diagnostics=${preRestartDiagnostics}`);
  assert.ok(oomFill.status !== 0 || oomFill.signal || oomFill.spawnError || oomFill.writeError || oomFill.stdinError || (oomFill.pipelineErrors ?? 0) > 0, `the pipeline must expose the interruption that accompanies the OOM; fill=${JSON.stringify(oomFill)}; diagnostics=${preRestartDiagnostics}`);
  docker(['start', oom]);
  await waitFor('Redis AOF recovery after OOM', () => docker(['exec', oom, 'redis-cli', 'PING'], { allowFailure: true }).stdout === 'PONG', 30_000);
  const recovered = docker(['exec', oom, 'redis-cli', 'GET', 'durable:probe']).stdout;
  assert.equal(recovered, 'before-oom', 'the probe was fsynced before the OOM filler and recovered from AOF');
  console.info(JSON.stringify({
    event: 'redis_memory_integration_passed',
    redisVersion,
    aofRewrite: { cgroupLimitBytes: hostConfig.Memory, redisMaxmemoryBytes: 256 * 1024 ** 2, configuredHeadroomBytes: hostConfig.Memory - 256 * 1024 ** 2, peakCgroupBytes: aofPeakCgroupBytes, peakDockerStatsWorkingSetBytes: aofPeakRssBytes, redisMaxima: redisMetricsMax, dataKeysAfterRewrite: dbsize, concurrentWriteBatchSize: concurrentWrites, completion: 'aof_last_bgrewrite_status=ok' },
    oom: {
      cgroupLimitBytes: 48 * 1024 ** 2,
      oomKilled: oomState.OOMKilled,
      dockerOomEvents: oomObserver.state.events.filter(event => event.action === 'oom').length,
      exitCode: oomState.ExitCode,
      filler: { status: oomFill.status, signal: oomFill.signal, spawnError: oomFill.spawnError, writeError: oomFill.writeError, stdinError: oomFill.stdinError, timedOut: oomFill.timedOut, commandsSent: oomFill.commandsSent, bytesSent: oomFill.bytesSent, elapsedMs: oomFill.elapsedMs, hostSampling: oomFill.hostSampling },
      externalDockerStats: externalStatsSummary(oomObserver.state.stats),
      hostCgroupBeforeFill: preFillEvidence.cgroup,
      hostPressureBeforeFill: preFillEvidence.hostPressure,
      kernelOomEvidenceBeforeFill: preFillEvidence.kernelOomEvidence,
      recoveredAofProbe: 'before-oom (fsync confirmed before incident)',
      restarted: true,
    },
    limitation: 'Standalone Redis process evidence only; PostgreSQL durable operation and production worker recovery during cgroup OOM are covered only by separate maxmemory-saturation integration, not by this OOM scenario.',
  }));
} finally {
  await oomObserver?.stop();
  for (const cleanup of cleanups.reverse()) { try { cleanup(); } catch {} }
}
