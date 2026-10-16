import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const composeFile = path.join(root, 'deploy', 'compose.production.yaml');
const envFile = path.join(root, 'deploy', 'production.env.example');
const project = `veyrobot-budget-probe-${randomUUID().slice(0, 8)}`;
const temp = await mkdtemp(path.join(os.tmpdir(), 'veyrobot-compose-budget-'));
const probeFile = path.join(temp, 'compose.yaml');

function run(args, options = {}) {
  const result = spawnSync('docker', args, { cwd: root, encoding: 'utf8', timeout: 120_000, ...options });
  if (result.status !== 0) throw new Error(`docker ${args.join(' ')} failed (${result.status}): ${result.stderr.slice(-2000)}`);
  return result.stdout.trim();
}
function parseByteSize(value) {
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)(b|kb|mb|gb)?$/i);
  if (!match) throw new Error(`Unsupported byte-size syntax in resolved configuration: ${String(value).slice(0, 32)}`);
  const multiplier = ({ b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 })[match[2]?.toLowerCase() ?? 'b'];
  return Math.floor(Number(match[1]) * multiplier);
}

try {
  const configText = run(['compose', '--env-file', envFile, '-f', composeFile, 'config', '--format', 'json'], {
    env: { ...process.env, VEYROBOT_RECOVERY_EPOCH: '0'.repeat(32) },
  });
  const config = JSON.parse(configText);
  const expected = {
    postgres: 1024 ** 3, migrate: 512 * 1024 ** 2, api: 512 * 1024 ** 2,
    bot: 768 * 1024 ** 2, dashboard: 512 * 1024 ** 2, redis: 512 * 1024 ** 2,
  };
  for (const [service, limit] of Object.entries(expected)) {
    assert.equal(Number(config.services[service]?.deploy?.resources?.limits?.memory), limit, `${service} rendered memory cap`);
  }
  const redisCommand = config.services.redis.command.join(' ');
  assert.deepEqual(config.services.redis.entrypoint, ['/bin/sh', '-ec']);
  assert.match(redisCommand, /cp \/run\/secrets\/redis\.conf \/tmp\/redis\.conf.*chown redis:redis.*chmod 0400.*setpriv --reuid redis --regid redis --clear-groups redis-server \/tmp\/redis\.conf/);
  assert.equal(config.services.redis.secrets[0]?.target, 'redis.conf', 'Redis config secret is mounted at the path used by redis-server and its healthcheck');
  const redisMaxMemory = parseByteSize(redisCommand.match(/--maxmemory\s+(\S+)/)?.[1]);
  const redisContainerLimit = config.services.redis.deploy.resources.limits.memory;
  assert.ok(redisContainerLimit - redisMaxMemory >= 256 * 1024 ** 2, 'Redis leaves a 256 MiB cgroup budget above maxmemory for AOF file cache, COW, clients and native allocations');
  for (const service of ['api', 'bot', 'dashboard', 'migrate']) {
    const heap = Number(config.services[service].environment.NODE_OPTIONS.match(/max-old-space-size=(\d+)/)?.[1]);
    assert.ok(heap > 0 && heap * 1024 ** 2 <= config.services[service].deploy.resources.limits.memory * 0.75, `${service} heap leaves native/buffer/cgroup headroom`);
  }
  const redisTemplate = await readFile(path.join(root, 'deploy', 'redis.conf.example'), 'utf8');
  assert.match(redisTemplate, /^appendonly yes$/m);
  assert.match(redisTemplate, /^appendfsync everysec$/m);
  assert.match(redisTemplate, /^save ""$/m);
  assert.match(redisTemplate, /^maxmemory-policy noeviction$/m);

  await writeFile(probeFile, `services:\n  probe:\n    image: alpine:3.22\n    command: ["sh", "-c", "sleep 90"]\n    deploy:\n      resources:\n        limits:\n          memory: 64M\n`);
  run(['compose', '-p', project, '-f', probeFile, 'up', '-d']);
  const id = run(['compose', '-p', project, '-f', probeFile, 'ps', '-q', 'probe']);
  assert.ok(id, 'probe container started');
  const memoryBytes = Number(run(['inspect', id, '--format', '{{.HostConfig.Memory}}']));
  assert.equal(memoryBytes, 64 * 1024 * 1024, 'Compose applies deploy.resources.limits.memory to the created container');
  console.info(JSON.stringify({ event: 'compose_memory_budget_verified', productionServices: expected, dockerHostMemoryBytes: memoryBytes }));
} finally {
  spawnSync('docker', ['compose', '-p', project, '-f', probeFile, 'down', '--volumes', '--remove-orphans'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  await rm(temp, { recursive: true, force: true });
}
