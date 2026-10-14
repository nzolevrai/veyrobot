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
  assert.equal(health?.status, 200, `API starts without opening a database connection. Child output: ${childOutput}`);
  assert.deepEqual(await health.json(), { status: 'ok' });
  assert.equal((await fetch(`${apiUrl}/guilds`)).status, 401, 'expired or missing dashboard sessions cannot list guilds');
  assert.equal((await fetch(`${apiUrl}/guilds/123456789012345678/cases`)).status, 401, 'expired or missing sessions cannot read even a known guild dossier');

  const start = await fetch(`${apiUrl}/oauth/discord/start`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const authorization = new URL(start.headers.get('location'));
  assert.equal(authorization.origin, 'https://discord.com');
  assert.equal(authorization.searchParams.get('scope'), 'identify guilds');
  assert.ok(authorization.searchParams.get('state'));
  const cookie = start.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie, 'OAuth state is stored in the encrypted session cookie');

  const callback = await fetch(`${apiUrl}/oauth/discord/callback?code=unused&state=wrong`, { headers: { cookie } });
  assert.equal(callback.status, 400, 'OAuth callback rejects a mismatched state before token exchange');
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
}
