import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';

const root = resolve(process.env.VEYROBOT_BUNDLE_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
const verifySplit = process.env.VERIFY_ROUTE_SPLIT !== '0';
const require = createRequire(join(root, 'apps/dashboard/package.json'));
const { chromium, firefox } = require('playwright');
const guildId = '123456789012345678';
const config = { guildId, version: 1, warningsEnabled: true, memberActionsEnabled: true, channelActionsEnabled: true, language: 'fr', timeZone: 'UTC', embedColor: '#7775f5' };
const guild = { id: guildId, name: 'Serveur de mesure', icon: null, botPresent: true, botInstalled: true, botOnline: true, owner: true, permissions: '8' };
const headings = { settings: 'Paramètres', records: 'Dossiers et historique', warnings: 'Avertissements', 'member-actions': 'Actions sur membres' };

async function listen(server) {
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  return server.address().port;
}
async function freePort() {
  const server = createServer(); const port = await listen(server);
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}
function stats(entries) {
  const unique = [...new Map(entries.filter(entry => entry.name.includes('/_next/static/chunks/') && entry.name.endsWith('.js')).map(entry => [entry.name, entry])).values()];
  return { urls: unique.map(entry => new URL(entry.name).pathname), decodedBytes: unique.reduce((sum, entry) => sum + entry.decodedBodySize, 0), encodedBodyBytes: unique.reduce((sum, entry) => sum + entry.encodedBodySize, 0), transferredBytes: unique.reduce((sum, entry) => sum + entry.transferSize, 0) };
}
async function compressedFileSizes(urls) {
  const buffers = await Promise.all(urls.map(url => readFile(join(root, 'apps/dashboard/.next', url.slice('/_next/'.length)))));
  return { gzipBytes: buffers.reduce((sum, data) => sum + gzipSync(data).byteLength, 0), brotliBytes: buffers.reduce((sum, data) => sum + brotliCompressSync(data).byteLength, 0) };
}
async function waitForNext(baseUrl, child, getLogs) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Next exited before readiness: ${getLogs()}`);
    try { const response = await fetch(baseUrl); if (response.status) return; } catch { /* bounded readiness poll */ }
    await delay(100);
  }
  throw new Error(`Timed out waiting for built Next.js: ${getLogs()}`);
}

const api = createServer((request, response) => {
  response.setHeader('content-type', 'application/json'); response.setHeader('cache-control', 'no-store');
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  if (path === '/me') return response.end(JSON.stringify({ user: { id: '223456789012345678', username: 'Mesure locale', avatar: null }, csrf: 'fixture-csrf' }));
  if (path === '/guilds') return response.end(JSON.stringify([guild]));
  if (path === '/public-config') return response.end(JSON.stringify({ discordClientId: 'fixture-client' }));
  if (path === `/guilds/${guildId}/config`) return response.end(JSON.stringify(config));
  if (path.includes('/cases')) return response.end(JSON.stringify({ items: [], nextCursor: null }));
  if (path.endsWith('/warnings')) return response.end(JSON.stringify({ items: [] }));
  response.end(JSON.stringify({ ok: true }));
});
const apiPort = await listen(api);
const nextPort = await freePort();
const baseUrl = `http://127.0.0.1:${nextPort}`;
const nextCli = join(root, 'apps/dashboard/node_modules/next/dist/bin/next');
const next = spawn(process.execPath, [nextCli, 'start', '-p', String(nextPort)], { cwd: join(root, 'apps/dashboard'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production', API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`, API_PROXY_TIMEOUT_MS: '1500' } });
let nextLogs = '';
next.stdout.on('data', chunk => { nextLogs = (nextLogs + chunk.toString()).slice(-4000); });
next.stderr.on('data', chunk => { nextLogs = (nextLogs + chunk.toString()).slice(-4000); });
const result = {};

try {
  await waitForNext(baseUrl, next, () => nextLogs);
  for (const [engineName, engine] of [['chromium', chromium], ['firefox', firefox]]) {
    const browser = await engine.launch({ headless: true, timeout: 15_000 });
    const direct = {};
    for (const route of Object.keys(headings)) {
      const context = await browser.newContext();
      await context.addCookies([{ name: 'veyrobot_session', value: 'fixture-session', url: baseUrl, httpOnly: true, sameSite: 'Lax' }]);
      const page = await context.newPage();
      await page.goto(`${baseUrl}/dashboard/${guildId}/${route}`);
      await page.getByRole('heading', { name: headings[route], exact: true }).waitFor();
      await page.waitForFunction(() => document.readyState === 'complete');
      const initial = stats(await page.evaluate(() => performance.getEntriesByType('resource').map(entry => ({ name: entry.name, decodedBodySize: entry.decodedBodySize, encodedBodySize: entry.encodedBodySize, transferSize: entry.transferSize }))));
      direct[route] = { ...initial, ...await compressedFileSizes(initial.urls) };
      await page.reload();
      await page.getByRole('heading', { name: headings[route], exact: true }).waitFor();
      direct[route].reloadSucceeded = true;
      await context.close();
    }
    for (const route of Object.keys(headings)) {
      const uniqueToRoute = direct[route].urls.filter(url => Object.keys(headings).every(other => other === route || !direct[other].urls.includes(url)));
      if (verifySplit) assert.ok(uniqueToRoute.length > 0, `${engineName} ${route} must load a route-specific chunk`);
    }

    const context = await browser.newContext();
    await context.addCookies([{ name: 'veyrobot_session', value: 'fixture-session', url: baseUrl, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage(); const requested = [];
    page.on('request', request => { if (request.url().includes('/_next/static/chunks/') && request.url().endsWith('.js')) requested.push(new URL(request.url()).pathname); });
    const navigation = {}; let loaded = new Set();
    for (const [index, route] of ['warnings', 'settings', 'member-actions', 'records'].entries()) {
      if (index === 0) await page.goto(`${baseUrl}/dashboard/${guildId}/${route}`);
      else {
        const link = page.locator(`a[href="/dashboard/${guildId}/${route}"]`).first();
        if (!(await link.isVisible().catch(() => false))) {
          await page.locator('button.category-trigger').filter({ hasText: route === 'records' ? 'Suivi' : 'Modération des membres' }).click();
        }
        await link.click();
      }
      await page.getByRole('heading', { name: headings[route], exact: true }).waitFor();
      const nextLoaded = new Set(requested); const added = [...nextLoaded].filter(url => !loaded.has(url));
      if (verifySplit && index > 0) assert.ok(added.some(url => direct[route].urls.includes(url)), `${engineName} navigation to ${route} should load its deferred feature chunk`);
      navigation[route] = { newJavaScriptChunks: added.length, addedChunks: added, addedCompressed: await compressedFileSizes(added) };
      loaded = nextLoaded;
    }
    await context.close(); await browser.close();
    result[engineName] = { direct, navigation };
  }
  console.log(JSON.stringify({ protocol: 'built Next + loopback API fixture + Playwright; static session cookie; no Discord calls', routeSplitAssertions: verifySplit, result }, null, 2));
} finally {
  next.kill(); api.close();
  if (next.exitCode === null) await new Promise(resolveClose => next.once('close', resolveClose));
}
