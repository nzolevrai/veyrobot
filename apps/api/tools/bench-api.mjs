import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

if (!process.env.DATABASE_URL?.includes('veyrobot_foundation_bench')) throw new Error('Use isolated veyrobot_foundation_bench database.');
const rps = Number(process.env.BENCH_OFFERED_RPS ?? 10);
const seconds = Number(process.env.BENCH_SECONDS ?? 5);
if (!Number.isInteger(rps) || rps < 1 || rps > 100 || !Number.isInteger(seconds) || seconds < 1 || seconds > 30) throw new Error('Invalid benchmark rate/duration.');
const port = await new Promise(resolve => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const address = probe.address(); probe.close(() => resolve(address.port)); }); });
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['--import', new URL('../test/mock-discord.mjs', import.meta.url).href, fileURLToPath(new URL('../dist/index.js', import.meta.url))], {
  env: { ...process.env, NODE_ENV: 'test', API_PORT: String(port), API_PUBLIC_URL: base, DASHBOARD_URL: 'http://localhost:3000', DISCORD_CLIENT_ID: '123456789012345678', DISCORD_CLIENT_SECRET: 'fixture', DISCORD_BOT_TOKEN: 'fixture', SESSION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', TEST_USER_ID: '123456789012345679', TEST_GUILD_A: '123456789012345680', TEST_GUILD_B: '123456789012345681', TEST_GUILD_C: '123456789012345682' }, stdio: 'ignore',
});
const p = (values, q) => { const a = [...values].sort((x, y) => x - y); return +(a[Math.floor((a.length - 1) * q)] ?? 0).toFixed(2); };
try {
  let ready = false;
  for (let i = 0; i < 150; i++) { try { ready = (await fetch(`${base}/ready`)).ok; if (ready) break; } catch { /* boot */ } await delay(100); }
  if (!ready) throw new Error('API did not start.');
  const start = await fetch(`${base}/oauth/discord/start`, { redirect: 'manual' });
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const stateCookie = start.headers.get('set-cookie').split(';', 1)[0];
  const callback = await fetch(`${base}/oauth/discord/callback?code=fixture&state=${state}`, { headers: { cookie: stateCookie }, redirect: 'manual' });
  if (callback.status !== 302) throw new Error(`OAuth fixture failed: ${callback.status}`);
  const cookie = callback.headers.get('set-cookie').split(';', 1)[0];
  const latencies = [];
  const pending = [];
  let offered = 0, accepted = 0, rejected429 = 0, errors = 0;
  const began = performance.now();
  for (let i = 0; i < rps * seconds; i++) {
    const due = began + i * 1000 / rps;
    setTimeout(() => {
      offered++;
      const tick = performance.now();
      pending.push(fetch(`${base}/guilds`, { headers: { cookie } }).then(response => { if (response.ok) accepted++; else if (response.status === 429) rejected429++; else errors++; latencies.push(performance.now() - tick); }).catch(() => { errors++; }));
    }, Math.max(0, due - performance.now()));
  }
  await delay(seconds * 1000 + 100);
  await Promise.all(pending);
  console.info(JSON.stringify({ scope: 'Fastify /guilds with signed session, isolated PostgreSQL and mocked Discord OAuth/REST', rps, seconds, offered, accepted, rejected429, errors, latencyMs: { p50: p(latencies, .5), p95: p(latencies, .95), p99: p(latencies, .99) }, elapsedMs: +(performance.now() - began).toFixed(2) }));
  if (errors || accepted + rejected429 !== rps * seconds) process.exitCode = 1;
} finally { child.kill('SIGTERM'); await delay(200); }
