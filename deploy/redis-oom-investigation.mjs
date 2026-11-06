import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { openSync, readSync, closeSync, readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

if (process.platform !== 'linux') throw new Error('This diagnostic requires a Linux runner.');

const image = process.env.REDIS_DIAGNOSTIC_IMAGE || 'redis:7.4.12-alpine';
const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
const outDir = process.env.REDIS_OOM_DIAGNOSTIC_DIR || join(tmpdir(), `veyrobot-redis-oom-${suffix}`);
mkdirSync(outDir, { recursive: true, mode: 0o700 });
const outputPath = join(outDir, 'redis-oom-investigation.json');
const eventPath = join(outDir, 'docker-events.jsonl');
const output = { startedAt: new Date().toISOString(), runner: {}, image, scenarios: [], limitations: [] };
const containerNames = new Set();
const volumeNames = new Set();
let eventProcess;
let eventBuffer = '';
let eventErrors = [];
const maxEventRows = 500;
const dockerEvents = [];

function command(commandName, args, timeout = 10_000) {
  const result = spawnSync(commandName, args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error ? { name: result.error.name, code: result.error.code } : undefined,
    stdout: (result.stdout ?? '').trim().slice(-12_000),
    stderr: (result.stderr ?? '').trim().slice(-4_000),
  };
}
function checkedDocker(args, timeout) {
  const result = command('docker', args, timeout);
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed (${result.status ?? result.error?.code ?? result.signal ?? 'unknown'}): ${result.stderr || result.stdout}`);
  return result.stdout;
}
function kernelOomEvidence() {
  const result = command('dmesg', ['--ctime'], 2_000);
  if (result.status !== 0) return { available: false, status: result.status, error: result.error?.code, reason: 'dmesg unavailable or permission denied' };
  return { available: true, lines: result.stdout.split(/\r?\n/).filter(line => /out of memory|oom-kill|oom_reaper|killed process|memory cgroup out of memory/i.test(line)).slice(-30) };
}
function writeArtifact() {
  output.updatedAt = new Date().toISOString();
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
}
function startEventCapture() {
  eventProcess = spawn('docker', ['events', '--filter', 'type=container', '--format', '{{json .}}'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  eventProcess.stdout.setEncoding('utf8');
  eventProcess.stderr.setEncoding('utf8');
  eventProcess.stdout.on('data', chunk => {
    eventBuffer += chunk;
    const lines = eventBuffer.split(/\r?\n/);
    eventBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        const name = row.Actor?.Attributes?.name ?? '';
        if (!name.startsWith(`veyro-oom-diag-${suffix}-`)) continue;
        const record = {
          time: row.timeNano ? new Date(Number(row.timeNano) / 1e6).toISOString() : undefined,
          action: row.Action,
          name,
          exitCode: row.Actor?.Attributes?.exitCode,
          signal: row.Actor?.Attributes?.signal,
          execCommand: row.Actor?.Attributes?.execID ? '[exec id omitted]' : undefined,
        };
        dockerEvents.push(record);
        if (dockerEvents.length > maxEventRows) dockerEvents.shift();
        appendFileSync(eventPath, `${JSON.stringify(record)}\n`);
      } catch {
        eventErrors.push('Could not parse a Docker event line.');
        if (eventErrors.length > 20) eventErrors.shift();
      }
    }
  });
  eventProcess.stderr.on('data', chunk => {
    eventErrors.push(chunk.toString('utf8').slice(0, 500));
    if (eventErrors.length > 20) eventErrors.shift();
  });
  eventProcess.on('error', error => eventErrors.push(`docker events ${error.code ?? error.name}`));
}
function hostCgroupPath(pid) {
  if (!pid) return null;
  try {
    const line = readFileSync(`/proc/${pid}/cgroup`, 'utf8').split(/\r?\n/).find(value => value.startsWith('0::'));
    if (!line) return null;
    return `/sys/fs/cgroup/${line.slice(3).replace(/^\/+/, '')}`;
  } catch { return null; }
}
function openCgroupReader(pid) {
  const base = hostCgroupPath(pid);
  const files = ['memory.current', 'memory.peak', 'memory.max', 'memory.swap.current', 'memory.swap.max', 'memory.events', 'memory.events.local', 'memory.oom.group', 'cgroup.procs'];
  const handles = {};
  if (base) for (const name of files) {
    try { handles[name] = openSync(join(base, name), 'r'); } catch {}
  }
  return { base: base ? '[cgroup path recorded locally only]' : null, handles };
}
function readHeld(fd) {
  try {
    const buffer = Buffer.alloc(8192);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, length).toString('utf8').trim();
  } catch (error) { return `[read failed: ${error.code ?? error.name}]`; }
}
function processDetails(pidsText) {
  return (pidsText ?? '').split(/\s+/).filter(value => /^\d+$/.test(value)).slice(0, 32).map(value => {
    const pid = Number(value);
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const select = key => status.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1]?.slice(0, 120);
      return {
        pid,
        name: readFileSync(`/proc/${pid}/comm`, 'utf8').trim().slice(0, 120),
        state: select('State'),
        ppid: select('PPid'),
        vmRss: select('VmRSS'),
        oomScore: readFileSync(`/proc/${pid}/oom_score`, 'utf8').trim(),
        oomScoreAdj: readFileSync(`/proc/${pid}/oom_score_adj`, 'utf8').trim(),
      };
    } catch (error) { return { pid, unavailable: error.code ?? error.name }; }
  });
}
function snapshotCgroup(reader) {
  const data = Object.fromEntries(Object.entries(reader.handles).map(([name, fd]) => [name, readHeld(fd)]));
  return { readableFiles: Object.keys(reader.handles), data, processes: processDetails(data['cgroup.procs']) };
}
function closeCgroupReader(reader) {
  for (const fd of Object.values(reader.handles)) { try { closeSync(fd); } catch {} }
}
function stateOf(name) {
  const result = command('docker', ['inspect', name, '--format', '{{json .State}}|||{{json .HostConfig}}'], 5_000);
  const [stateText, hostConfigText] = result.stdout.split('|||');
  let state; let hostConfig;
  try { state = JSON.parse(stateText); } catch {}
  try { hostConfig = JSON.parse(hostConfigText); } catch {}
  return { status: result.status, error: result.error, state: state && { running: state.Running, oomKilled: state.OOMKilled, exitCode: state.ExitCode, error: state.Error }, limits: hostConfig && { memory: hostConfig.Memory, memorySwap: hostConfig.MemorySwap } };
}
function captureContainer(name) {
  const inspect = stateOf(name);
  const logs = command('docker', ['logs', '--tail', '80', name], 5_000);
  const top = command('docker', ['top', name, '-eo', 'pid,ppid,stat,rss,comm'], 5_000);
  const stats = command('docker', ['stats', '--no-stream', '--format', '{{json .}}', name], 5_000);
  return { inspect, logs: { status: logs.status, stdout: logs.stdout.slice(-8_000), stderr: logs.stderr.slice(-2_000) }, top: { status: top.status, stdout: top.stdout.slice(0, 4_000), stderr: top.stderr.slice(0, 1_000) }, stats: { status: stats.status, stdout: stats.stdout.slice(0, 2_000), stderr: stats.stderr.slice(0, 1_000) } };
}
function redisFrame(index, bytes) {
  const key = Buffer.from(`oom:${index}`);
  const value = Buffer.alloc(bytes, 0x7a);
  return Buffer.concat([Buffer.from(`*3\r\n$3\r\nSET\r\n$${key.length}\r\n`), key, Buffer.from(`\r\n$${value.length}\r\n`), value, Buffer.from('\r\n')]);
}
async function waitFor(label, predicate, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (predicate()) return true; await sleep(100); }
  return false;
}
async function runFiller(target, mode, fillerName) {
  const args = mode === 'docker-exec'
    ? ['exec', '-i', target, 'redis-cli', '--pipe']
    : ['run', '--name', fillerName, '--network', `container:${target}`, '--memory=128m', '--memory-swap=128m', '-i', image, 'redis-cli', '-h', '127.0.0.1', '--pipe'];
  if (mode === 'external-container') containerNames.add(fillerName);
  const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const captures = { stdout: '', stderr: '', writeError: null, spawnError: null, stdinError: null, timedOut: false, commandsSent: 0, bytesSent: 0, pid: child.pid };
  const endCapture = (current, chunk) => (current + chunk.toString('utf8')).slice(-8_000);
  child.stdout.on('data', chunk => { captures.stdout = endCapture(captures.stdout, chunk); });
  child.stderr.on('data', chunk => { captures.stderr = endCapture(captures.stderr, chunk); });
  child.on('error', error => { captures.spawnError = { name: error.name, code: error.code }; });
  child.stdin.on('error', error => { captures.stdinError = { name: error.name, code: error.code }; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const started = Date.now();
  const timer = setTimeout(() => { captures.timedOut = true; child.kill('SIGTERM'); }, 30_000);
  const cgroupSamples = [];
  const processSampler = setInterval(() => {
    const sample = snapshotCgroup(activeReader);
    cgroupSamples.push({ atMs: Date.now() - started, ...sample });
    if (cgroupSamples.length > 40) cgroupSamples.shift();
  }, 100);
  const progress = [];
  let writeError = null;
  try {
    for (let index = 0; index < 96; index++) {
      if (child.stdin.destroyed || child.exitCode !== null) break;
      const frame = redisFrame(index, 1024 * 1024);
      try {
        await new Promise((resolve, reject) => child.stdin.write(frame, error => error ? reject(error) : resolve()));
      } catch (error) {
        writeError = { name: error.name, code: error.code, message: error.message.slice(0, 160) };
        captures.commandsSent = index;
        break;
      }
      captures.commandsSent = index + 1;
      captures.bytesSent += frame.length;
      if (captures.commandsSent % 4 === 0) {
        const sample = snapshotCgroup(activeReader);
        progress.push({ commandsSent: captures.commandsSent, atMs: Date.now() - started, cgroup: sample, events: dockerEvents.slice(-8) });
        if (progress.length > 24) progress.shift();
        if (dockerEvents.some(event => event.name === target && ['oom', 'die'].includes(event.action))) break;
      }
    }
    if (!child.stdin.destroyed) child.stdin.end();
  } finally {
    clearInterval(processSampler);
    clearTimeout(timer);
  }
  const completed = await Promise.race([closed, sleep(5_000).then(() => null)]);
  if (!completed && child.exitCode === null && !captures.timedOut) {
    captures.closeWaitExpired = true;
    // Bound client cleanup only after recording that the observation window expired.
    captures.liveClientCleanupSignal = 'SIGTERM after bounded observation';
    child.kill('SIGTERM');
  }
  const finalClose = completed ?? await Promise.race([closed, sleep(1_000).then(() => null)]);
  return {
    ...captures,
    status: finalClose?.code ?? child.exitCode,
    signal: finalClose?.signal ?? child.signalCode,
    writeError,
    elapsedMs: Date.now() - started,
    pipelineSummary: `${captures.stdout}\n${captures.stderr}`.slice(-4_000),
    progress,
    cgroupSamples,
    clientContainer: mode === 'external-container' ? captureContainer(fillerName) : undefined,
  };
}

let activeReader;
async function scenario(mode) {
  const target = `veyro-oom-diag-${suffix}-${mode}`;
  const volume = `veyro-oom-diag-data-${suffix}-${mode}`;
  const filler = `veyro-oom-diag-client-${suffix}-${mode}`;
  containerNames.add(target);
  const result = { mode, target, image, startedAt: new Date().toISOString() };
  output.scenarios.push(result);
  writeArtifact();
  checkedDocker(['volume', 'create', volume]);
  checkedDocker(['run', '-d', '--name', target, '--memory=48m', '--memory-swap=48m', '-v', `${volume}:/data`, image, 'redis-server', '--appendonly', 'yes', '--appendfsync', 'everysec', '--save', '', '--dir', '/data']);
  volumeNames.add(volume);
  const ready = await waitFor('Redis readiness', () => command('docker', ['exec', target, 'redis-cli', 'PING']).stdout === 'PONG');
  if (!ready) throw new Error(`Redis readiness timed out for ${mode}.`);
  result.redisVersion = checkedDocker(['exec', target, 'redis-cli', 'INFO', 'server']).match(/redis_version:([^\r\n]+)/)?.[1] ?? null;
  checkedDocker(['exec', target, 'redis-cli', 'CONFIG', 'SET', 'appendfsync', 'always']);
  checkedDocker(['exec', target, 'redis-cli', 'SET', 'durable:probe', 'before-oom']);
  const persistence = checkedDocker(['exec', target, 'redis-cli', 'INFO', 'persistence']);
  result.witnessBeforeFill = { aofWriteOk: /aof_last_write_status:ok/.test(persistence), fsyncPendingZero: /aof_pending_bio_fsync:0/.test(persistence) };
  assert.equal(result.witnessBeforeFill.aofWriteOk, true, 'the diagnostic witness write completed through AOF');
  assert.equal(result.witnessBeforeFill.fsyncPendingZero, true, 'the diagnostic witness was fsynced before filling');
  checkedDocker(['exec', target, 'redis-cli', 'CONFIG', 'SET', 'appendonly', 'no']);
  result.aofDisabledBeforeFill = await waitFor('AOF disabled', () => command('docker', ['exec', target, 'redis-cli', 'INFO', 'persistence']).stdout.includes('aof_enabled:0'));
  assert.equal(result.aofDisabledBeforeFill, true, 'AOF is disabled before synthetic memory writes');
  const state = JSON.parse(checkedDocker(['inspect', target, '--format', '{{json .State}}']));
  result.containerPid = state.Pid;
  activeReader = openCgroupReader(state.Pid);
  result.cgroupBeforeFill = snapshotCgroup(activeReader);
  result.stateBeforeFill = stateOf(target);
  writeArtifact();

  const fill = await runFiller(target, mode, filler);
  result.fill = fill;
  // Give Docker's event stream a short, bounded opportunity to deliver die/oom events.
  await sleep(500);
  result.cgroupAfterFillBeforeRestart = snapshotCgroup(activeReader);
  result.targetBeforeRestart = captureContainer(target);
  result.kernelOomEvidenceBeforeRestart = kernelOomEvidence();
  result.eventsBeforeRestart = dockerEvents.filter(event => event.name === target || event.name === filler);
  result.eventCaptureErrors = eventErrors.slice(-10);
  writeArtifact();

  if (result.targetBeforeRestart.inspect.state?.running === false) {
    const start = command('docker', ['start', target], 10_000);
    result.restart = { status: start.status, stdout: start.stdout, stderr: start.stderr };
    const recovered = await waitFor('Redis recovery after observed exit', () => command('docker', ['exec', target, 'redis-cli', 'PING']).stdout === 'PONG', 15_000);
    result.restart.ready = recovered;
    if (recovered) result.restart.witness = command('docker', ['exec', target, 'redis-cli', 'GET', 'durable:probe']).stdout;
    result.targetAfterRestart = captureContainer(target);
  } else {
    result.restart = { attempted: false, reason: 'target was still running; no stop was issued to manufacture an OOM outcome' };
  }
  result.finishedAt = new Date().toISOString();
  closeCgroupReader(activeReader);
  activeReader = undefined;
  writeArtifact();
  console.info(JSON.stringify({ event: 'redis_oom_diagnostic_scenario_complete', mode, image, redisVersion: result.redisVersion, fill: { status: fill.status, signal: fill.signal, timedOut: fill.timedOut, commandsSent: fill.commandsSent, writeError: fill.writeError, stdinError: fill.stdinError }, targetState: result.targetBeforeRestart.inspect.state, cgroupFilesHeld: Object.keys(result.cgroupBeforeFill.data ?? {}) }));
}

try {
  output.runner = {
    recordedAt: new Date().toISOString(),
    kernel: command('uname', ['-a']).stdout,
    kernelRelease: command('uname', ['-r']).stdout,
    osRelease: command('sh', ['-c', 'cat /etc/os-release | sed -n "1,8p"']).stdout,
    dockerVersion: command('docker', ['version', '--format', 'client={{.Client.Version}} server={{.Server.Version}} serverGit={{.Server.GitCommit}} api={{.Server.APIVersion}}']).stdout,
    dockerInfo: command('docker', ['info', '--format', 'kernel={{.KernelVersion}} cgroup={{.CgroupVersion}} os={{.OperatingSystem}} driver={{.Driver}} memoryBytes={{.MemTotal}}']).stdout,
    node: process.version,
  };
  checkedDocker(['pull', image], 120_000);
  output.imageDigest = command('docker', ['image', 'inspect', image, '--format', '{{index .RepoDigests 0}}']).stdout;
  startEventCapture();
  await sleep(300);
  await scenario('docker-exec');
  await scenario('external-container');
  output.dockerEvents = dockerEvents;
  output.eventCaptureErrors = eventErrors.slice(-10);
  output.finishedAt = new Date().toISOString();
  writeArtifact();
  console.info(JSON.stringify({ event: 'redis_oom_investigation_complete', outputPath, scenarios: output.scenarios.map(row => ({ mode: row.mode, redisVersion: row.redisVersion, oomKilled: row.targetBeforeRestart.inspect.state?.oomKilled, exitCode: row.targetBeforeRestart.inspect.state?.exitCode, dockerOomEvents: row.eventsBeforeRestart.filter(event => event.name === row.target && event.action === 'oom').length })) }));
} catch (error) {
  output.error = { name: error.name, message: String(error.message).slice(0, 2_000) };
  output.dockerEvents = dockerEvents;
  output.eventCaptureErrors = eventErrors.slice(-10);
  writeArtifact();
  console.error(JSON.stringify({ event: 'redis_oom_investigation_failed', outputPath, error: output.error }));
  process.exitCode = 1;
} finally {
  if (eventProcess && eventProcess.exitCode === null) eventProcess.kill('SIGTERM');
  // All state/log/cgroup evidence is written before removing only resources named by this run.
  const containerCleanup = [...containerNames].reverse().map(name => ({ name, ...command('docker', ['rm', '-f', name], 15_000) }));
  const volumeCleanup = [...volumeNames].reverse().map(name => ({ name, ...command('docker', ['volume', 'rm', '-f', name], 15_000) }));
  output.cleanedAt = new Date().toISOString();
  output.cleanup = {
    policy: 'Only uniquely named diagnostic containers and volumes created by this run are removed after snapshots are written.',
    containers: containerCleanup,
    volumes: volumeCleanup,
  };
  writeArtifact();
}
