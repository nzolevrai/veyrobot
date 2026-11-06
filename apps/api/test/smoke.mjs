import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const port = 4317;
const apiUrl = `http://127.0.0.1:${port}`;
let childOutput = '';
const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/index.js', import.meta.url))], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    NODE_ENV: 'test',
    API_PORT: String(port),
    API_PUBLIC_URL: apiUrl,
    DASHBOARD_URL: 'http://localhost:3000',
    DISCORD_CLIENT_ID: '123456789012345678',
    DISCORD_CLIENT_SECRET: 'local-smoke-test-only',
    DISCORD_BOT_TOKEN: 'local-smoke-test-only',
    SESSION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    DATABASE_URL: 'postgresql://nobody:nobody@127.0.0.1:1/smoke',
    VEYROBOT_RECOVERY_EPOCH: 'a'.repeat(64),
  },
});
child.stdout.setEncoding('utf8').on('data', chunk => { childOutput += chunk; });
child.stderr.setEncoding('utf8').on('data', chunk => { childOutput += chunk; });
child.on('error', error => { childOutput += String(error); });

try {
  let health;
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null) break;
    try { health = await fetch(`${apiUrl}/health`); break; }
    catch { await delay(100); }
  }
  assert.equal(health, undefined, `API must fail closed when recovery authorization cannot be read. Child output: ${childOutput}`);
  assert.equal(child.exitCode, 1, `API must exit before opening a listener. Child output: ${childOutput}`);
  assert.match(childOutput, /recovery authorization is missing, stale, or unavailable/i);
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
}
