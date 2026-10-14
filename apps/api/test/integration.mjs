import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

if (process.env.RUN_POSTGRES_INTEGRATION !== '1') {
  console.log('API PostgreSQL integration skipped (RUN_POSTGRES_INTEGRATION != 1).');
} else {
  const freePort = () => new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(address.port));
    });
  });
  const { prisma } = await import('@veyrobot/db');
  const seed = randomUUID().replace(/\D/g, '').padEnd(16, '0').slice(0, 16);
  const guildA = `9${seed}1`; const guildB = `9${seed}2`; const guildC = `9${seed}3`;
  const actorId = `8${seed}1`; const targetId = `8${seed}2`;
  const onlineShard = 10000 + Math.floor(Math.random() * 1000);
  const offlineShard = onlineShard + 1;
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const childEnv = { ...process.env, NODE_ENV: 'test', API_PORT: String(port), API_PUBLIC_URL: base, DASHBOARD_URL: 'http://localhost:3000', DISCORD_CLIENT_ID: '123456789012345678', DISCORD_CLIENT_SECRET: 'fake-only', DISCORD_BOT_TOKEN: 'fake-only', SESSION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', TEST_USER_ID: actorId, TEST_GUILD_A: guildA, TEST_GUILD_B: guildB, TEST_GUILD_C: guildC };
  const apiEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  const mockEntry = new URL('./mock-discord.mjs', import.meta.url).href;
  let child;
  let dashboard;
  let caseId;
  let actionCaseId;
  const start = async () => {
    child = spawn(process.execPath, ['--import', mockEntry, apiEntry], { env: childEnv, stdio: 'ignore' });
    for (let i = 0; i < 150; i++) { try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* wait for listen */ } await delay(100); }
    throw new Error('API test process did not start');
  };
  const stop = async () => { if (dashboard && dashboard.exitCode === null) { dashboard.kill('SIGTERM'); await delay(200); } if (child && child.exitCode === null) { child.kill('SIGTERM'); await delay(200); } };
  const call = (path, cookie, options = {}) => fetch(`${base}${path}`, { ...options, headers: { ...(cookie ? { cookie } : {}), ...(options.headers ?? {}) } });
  try {
    await prisma.guildPresence.createMany({ data: [{ guildId: guildA, shardId: onlineShard }, { guildId: guildC, shardId: offlineShard }] });
    await prisma.shardPresence.createMany({ data: [{ shardId: onlineShard, lastSeenAt: new Date() }, { shardId: offlineShard, lastSeenAt: new Date(0) }] });
    await start();
    assert.equal((await call('/ready')).status, 200);
    const oauthStart = await call('/oauth/discord/start', undefined, { redirect: 'manual' });
    const state = new URL(oauthStart.headers.get('location')).searchParams.get('state');
    const stateCookie = oauthStart.headers.get('set-cookie').split(';', 1)[0];
    const callback = await call(`/oauth/discord/callback?code=fixture&state=${state}`, stateCookie, { redirect: 'manual' });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), 'http://localhost:3000/dashboard/user');
    let cookie = callback.headers.get('set-cookie').split(';', 1)[0];
    assert.equal(cookie.split('=', 1)[0], 'veyrobot_session', 'Unexpected OAuth session cookie name');
    if (process.env.RUN_DASHBOARD_ROUTE_INTEGRATION === '1') {
      const dashboardPort = await freePort();
      const dashboardEntry = fileURLToPath(new URL('../../dashboard/node_modules/next/dist/bin/next', import.meta.url));
      dashboard = spawn(process.execPath, [dashboardEntry, 'start', '-p', String(dashboardPort)], { env: { ...childEnv, API_INTERNAL_URL: base }, cwd: fileURLToPath(new URL('../../dashboard/', import.meta.url)), stdio: 'ignore' });
      const direct = `http://localhost:${dashboardPort}/dashboard/${guildA}/overview`;
      let available = false;
      for (let i = 0; i < 150; i++) { try { if ((await fetch(`http://localhost:${dashboardPort}/`)).ok) { available = true; break; } } catch { /* wait for Next */ } await delay(100); }
      assert.equal(available, true, 'Dashboard test process did not start');
      const proxiedBody = async size => fetch(`http://localhost:${dashboardPort}/api/guilds/${guildA}/actions`, {
        method: 'POST', duplex: 'half', headers: { 'content-type': 'application/json' },
        body: new ReadableStream({ start(controller) { controller.enqueue(size === 2 ? Buffer.from('{}') : new Uint8Array(size)); controller.close(); } }),
      });
      assert.equal((await proxiedBody(1_048_577)).status, 413, 'Next must reject a chunked oversized body before the API');
      assert.equal((await proxiedBody(2)).status, 401, 'Next must forward a bounded chunked body to the API');
      const noSession = await fetch(direct, { redirect: 'manual' });
      assert.equal(noSession.status, 307);
      const userRoute = `http://localhost:${dashboardPort}/dashboard/user`;
      assert.equal((await fetch(userRoute, { redirect: 'manual' })).status, 307);
      const profileRoute = `${userRoute}/profil`;
      assert.equal((await fetch(profileRoute, { redirect: 'manual' })).status, 307);
      for (const flag of ['fr', 'gb']) {
        const asset = await fetch(`http://localhost:${dashboardPort}/flags/${flag}.svg`);
        assert.equal(asset.status, 200, `Local ${flag} flag must be served`);
        assert.match(await asset.text(), /^<svg\b/);
      }
      const apiWithSession = await call(`/guilds/${guildA}/config`, cookie);
      assert.equal(apiWithSession.status, 200, 'API must accept the OAuth cookie directly');
      const separator = cookie.indexOf('=');
      const rawValue = cookie.slice(separator + 1);
      const decodedValue = decodeURIComponent(rawValue);
      const decodedCookie = `${cookie.slice(0, separator + 1)}${decodedValue}`;
      const decodedResult = await call(`/guilds/${guildA}/config`, decodedCookie);
      assert.notEqual(rawValue, decodedValue, 'OAuth cookie fixture must expose encoding regression');
      assert.equal(decodedResult.status, 401, 'Decoded cookie must not authenticate at the API');
      const authorized = await fetch(direct, { headers: { cookie }, redirect: 'manual' });
      assert.equal(authorized.status, 200, `Next server must relay the OAuth cookie to the API (redirect reason: ${new URL(authorized.headers.get('location') ?? '/', direct).searchParams.get('session') ?? 'none'})`);
      const reload = await fetch(direct, { headers: { cookie }, redirect: 'manual' });
      assert.equal(reload.status, 200);
      if (process.env.BENCH_DASHBOARD === '1') {
        const latency = [];
        for (let index = 0; index < 20; index++) {
          const began = performance.now();
          const page = await fetch(`http://localhost:${dashboardPort}/dashboard/user/profil`, { headers: { cookie }, redirect: 'manual' });
          assert.equal(page.status, 200);
          await page.arrayBuffer();
          latency.push(performance.now() - began);
        }
        const sorted = latency.sort((a, b) => a - b);
        console.info(JSON.stringify({ scope: 'Next server response /dashboard/user/profil with fake OAuth API; not browser render', requests: sorted.length, p50Ms: +sorted[9].toFixed(2), p95Ms: +sorted[18].toFixed(2), p99Ms: +sorted[19].toFixed(2) }));
      }
      for (const route of [userRoute, profileRoute, `${userRoute}/security`, `${userRoute}/premium`]) {
        const page = await fetch(route, { headers: { cookie }, redirect: 'manual' });
        assert.equal(page.status, 200, `User route should open directly: ${new URL(route).pathname}`);
        if (route === userRoute) {
          const html = await page.text();
          assert.match(html, /Bienvenue sur le panel VeyroBot !/);
          assert.match(html, />VeyroBot</);
          assert.doesNotMatch(html, />Veyro\s+Bot</);
          assert.match(html, /href="\/dashboard\/user\/profil"/);
        }
        if (route === profileRoute) {
          const html = await page.text();
          assert.match(html, /Compte Discord/);
          assert.match(html, /href="\/dashboard\/user\/profil"[^>]*aria-current="page"/);
        }
      }
      assert.equal((await fetch(profileRoute, { headers: { cookie }, redirect: 'manual' })).status, 200, 'Profile route must survive refresh');
      for (const oldRoute of [`http://localhost:${dashboardPort}/profil`, `${userRoute}/profile`]) {
        const oldProfile = await fetch(oldRoute, { headers: { cookie }, redirect: 'manual' });
        assert.equal(oldProfile.status, 307);
        assert.equal(new URL(oldProfile.headers.get('location'), userRoute).pathname, '/dashboard/user/profil');
      }
      child.kill('SIGTERM'); await delay(350);
      const unavailable = await fetch(direct, { headers: { cookie }, redirect: 'manual' });
      assert.equal(unavailable.status, 200, 'API outage must render a stable retry page');
      assert.match(await unavailable.text(), /Réessayer/);
      childEnv.MOCK_GUILDS_STATUS = '429';
      await start();
      const discordLimited = await call('/guilds', cookie);
      assert.equal(discordLimited.status, 429);
      assert.equal((await discordLimited.json()).code, 'DISCORD_RATE_LIMIT');
      assert.ok(discordLimited.headers.get('x-request-id'));
      const limitedRoute = await fetch(direct, { headers: { cookie }, redirect: 'manual' });
      assert.equal(limitedRoute.status, 200, 'Discord 429 must not be treated as expired session');
      child.kill('SIGTERM'); await delay(350);
      delete childEnv.MOCK_GUILDS_STATUS;
      await start();
      const proxiedLogout = await fetch(`http://localhost:${dashboardPort}/api/logout`, { method: 'POST', headers: { cookie, origin: 'http://localhost:3000' } });
      assert.equal(proxiedLogout.status, 204, 'Dashboard rewrite must forward logout');
      assert.match(proxiedLogout.headers.get('set-cookie') ?? '', /veyrobot_session=;/);
      assert.equal((await call('/me', cookie)).status, 401, 'A saved cookie must not survive logout');
      assert.equal((await fetch(`http://localhost:${dashboardPort}/api/me`)).status, 401);
      const nextStart = await call('/oauth/discord/start', undefined, { redirect: 'manual' });
      const nextState = new URL(nextStart.headers.get('location')).searchParams.get('state');
      const nextStateCookie = nextStart.headers.get('set-cookie').split(';', 1)[0];
      const nextCallback = await call(`/oauth/discord/callback?code=fixture&state=${nextState}`, nextStateCookie, { redirect: 'manual' });
      assert.equal(nextCallback.status, 302);
      cookie = nextCallback.headers.get('set-cookie').split(';', 1)[0];
    }
    const me = await call('/me', cookie); const { csrf } = await me.json();
    await prisma.shardPresence.update({ where: { shardId: onlineShard }, data: { lastSeenAt: new Date() } });
    const guilds = await (await call('/guilds', cookie)).json();
    assert.deepEqual(guilds.map(item => [item.botInstalled, item.botOnline]), [[true, true], [false, false], [true, false]]);
    assert.equal((await call(`/guilds/${guildB}/cases`, cookie)).status, 403);
    assert.equal((await call(`/guilds/${guildB}/config`, cookie)).status, 403);
    const post = (path, body) => call(path, cookie, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' }, body: JSON.stringify({ ...body, csrf }) });
    const put = (path, body) => call(path, cookie, { method: 'PUT', headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' }, body: JSON.stringify({ ...body, csrf }) });
    const absent = await (await post(`/guilds/${guildB}/installation-check`, {})).json();
    assert.equal(absent.botInstalled, false);
    assert.equal((await post(`/guilds/${guildC}/warnings`, { targetId, reason: 'offline' })).status, 503);
    assert.equal((await post(`/guilds/${guildA}/warnings`, { targetId, reason: 'disabled' })).status, 400);
    assert.equal((await post(`/guilds/${guildA}/actions`, { targetId, action: 'BAN', reason: 'disabled', operationId: randomUUID() })).status, 400);
    assert.equal((await post(`/guilds/${guildA}/actions`, { targetId, channelId: targetId, action: 'PURGE_MESSAGES', requestedCount: 5, reason: 'disabled', operationId: randomUUID() })).status, 400);
    const before = await (await call(`/guilds/${guildA}/config`, cookie)).json();
    assert.equal(before.version, 0); assert.equal(before.warningsEnabled, false);
    const enabled = await (await put(`/guilds/${guildA}/config`, { kind: 'module', moduleId: 'warnings', enabled: true, version: 0 })).json();
    assert.equal(enabled.warningsEnabled, true);
    assert.equal((await put(`/guilds/${guildA}/config`, { kind: 'module', moduleId: 'warnings', enabled: false, version: 0 })).status, 409);
    const warning = await post(`/guilds/${guildA}/warnings`, { targetId, reason: 'API integration warning' });
    assert.equal(warning.status, 201); caseId = (await warning.json()).id;
    assert.ok((await (await call(`/guilds/${guildA}/cases`, cookie)).json()).items.some(item => item.id === caseId));
    assert.ok(!(await (await call(`/guilds/${guildC}/cases`, cookie)).json()).items.some(item => item.id === caseId));
    const saved = await put(`/guilds/${guildA}/config`, { kind: 'settings', version: enabled.version, settings: { language: 'en', timeZone: 'Europe/Paris', embedColor: '#123ABC' } });
    assert.equal(saved.status, 200);
    const settings = await saved.json();
    const patchResponse = await put(`/guilds/${guildA}/config`, { kind: 'patch', version: settings.version, changes: { memberActionsEnabled: true, embedColor: '#ABCDEF' } });
    assert.equal(patchResponse.status, 200);
    const patch = await patchResponse.json();
    assert.equal(patch.memberActionsEnabled, true); assert.equal(patch.embedColor, '#ABCDEF'); assert.equal(patch.language, 'en');
    const operationId = randomUUID();
    const actionInput = { targetId, action: 'TIMEOUT', durationMinutes: 1, reason: 'integration request only', operationId };
    const actionResponse = await post(`/guilds/${guildA}/actions`, actionInput);
    assert.equal(actionResponse.status, 202);
    actionCaseId = (await actionResponse.json()).id;
    assert.equal((await (await post(`/guilds/${guildA}/actions`, actionInput)).json()).id, actionCaseId);
    assert.equal((await post(`/guilds/${guildA}/actions`, { ...actionInput, reason: 'changed payload' })).status, 400);
    assert.equal((await put(`/guilds/${guildA}/config`, { kind: 'patch', version: settings.version, changes: { warningsEnabled: false } })).status, 409);
    assert.equal((await put(`/guilds/${guildA}/config`, { kind: 'patch', version: patch.version, changes: { timeZone: 'Mars/Base' } })).status, 400);
    const disabled = await (await put(`/guilds/${guildA}/config`, { kind: 'module', moduleId: 'warnings', enabled: false, version: patch.version })).json();
    assert.equal(disabled.warningsEnabled, false);
    assert.equal((await post(`/guilds/${guildA}/warnings`, { targetId, reason: 'after disable' })).status, 400);
    assert.ok((await (await call(`/guilds/${guildA}/cases`, cookie)).json()).items.some(item => item.id === caseId));
    const installed = await (await post(`/guilds/${guildB}/installation-check`, {})).json();
    assert.equal(installed.botInstalled, true); assert.equal(installed.botOnline, false);
    const otherGuildConfig = await (await call(`/guilds/${guildB}/config`, cookie)).json();
    assert.equal(otherGuildConfig.language, 'fr'); assert.equal(otherGuildConfig.embedColor, '#7775F5'); assert.equal(otherGuildConfig.warningsEnabled, false);
    await stop(); await start();
    const persisted = await (await call(`/guilds/${guildA}/config`, cookie)).json();
    assert.equal(persisted.embedColor, '#ABCDEF'); assert.equal(persisted.timeZone, 'Europe/Paris'); assert.equal(persisted.language, 'en'); assert.equal(persisted.warningsEnabled, false); assert.equal(persisted.memberActionsEnabled, true); assert.equal(persisted.version, disabled.version);
    const logout = await call('/logout', cookie, { method: 'POST', headers: { origin: 'http://localhost:3000' } });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get('set-cookie') ?? '', /veyrobot_session=;/);
    assert.equal((await call('/me', cookie)).status, 401, 'A copied cookie must be revoked server-side');
    await stop(); await start();
    assert.equal((await call('/me', cookie)).status, 401, 'Revocation must survive API restart');
    console.log('API integration passed: OAuth to user route, direct user and guild routes, proxied logout, outage and rate limit, guild isolation, restart persistence.');
  } finally {
    await stop();
    if (caseId) await prisma.moderationCase.deleteMany({ where: { id: caseId } });
    if (actionCaseId) await prisma.moderationCase.deleteMany({ where: { id: actionCaseId } });
    await prisma.configAudit.deleteMany({ where: { guildId: { in: [guildA, guildB, guildC] } } });
    await prisma.guildConfig.deleteMany({ where: { guildId: { in: [guildA, guildB, guildC] } } });
    await prisma.guildPresence.deleteMany({ where: { guildId: { in: [guildA, guildB, guildC] } } });
    await prisma.shardPresence.deleteMany({ where: { shardId: { in: [onlineShard, offlineShard] } } });
    await prisma.$disconnect();
  }
}
