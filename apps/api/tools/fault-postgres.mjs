import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const freePort = () => new Promise(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolve(address.port)); }); });
const dbPort = await freePort();
const apiPort = await freePort();
const name = `veyrobot-pg-fault-${randomUUID().slice(0, 12)}`;
const base = `http://127.0.0.1:${apiPort}`;
const startDb = () => execFileSync('docker', ['run', '--rm', '-d', '--name', name, '-e', 'POSTGRES_USER=fixture', '-e', 'POSTGRES_PASSWORD=fixture_local_only', '-e', 'POSTGRES_DB=fixture', '-p', `${dbPort}:5432`, 'postgres:17-alpine'], { stdio: 'ignore' });
const stopDb = () => { try { execFileSync('docker', ['stop', '-t', '0', name], { stdio: 'ignore' }); } catch { /* already stopped */ } };
const status = async path => { try { return (await fetch(`${base}${path}`, { signal: AbortSignal.timeout(2_000) })).status; } catch { return 0; } };
const waitStatus = async (path, expected) => { for (let i = 0; i < 120; i++) { if (await status(path) === expected) return; await delay(100); } throw new Error(`${path} did not reach ${expected}`); };
let api;
try {
  startDb();
  api = spawn(process.execPath, [fileURLToPath(new URL('../dist/index.js', import.meta.url))], {
    env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: `postgresql://fixture:fixture_local_only@127.0.0.1:${dbPort}/fixture?schema=public`, API_PORT: String(apiPort), API_PUBLIC_URL: base, DASHBOARD_URL: 'http://localhost:3000', DISCORD_CLIENT_ID: '123456789012345678', DISCORD_CLIENT_SECRET: 'fixture', DISCORD_BOT_TOKEN: 'fixture', SESSION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }, stdio: 'ignore',
  });
  await waitStatus('/ready', 200);
  stopDb();
  await waitStatus('/ready', 503);
  assert.equal(await status('/health'), 200, 'Liveness should stay separate from PostgreSQL readiness');
  startDb();
  await waitStatus('/ready', 200);
  console.info('PostgreSQL outage/recovery passed: API readiness 200 → 503 → 200, liveness stayed 200.');
} finally {
  if (api && api.exitCode === null) api.kill('SIGTERM');
  stopDb();
}
