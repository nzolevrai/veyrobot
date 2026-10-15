import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createHmac } from 'node:crypto';
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
  const guildCounterFile = join(tmpdir(), `veyrobot-guild-fetch-${process.pid}-${seed}.txt`);
  const installationCounterFile = join(tmpdir(), `veyrobot-installation-check-${process.pid}-${seed}.txt`);
  await writeFile(guildCounterFile, '');
  await writeFile(installationCounterFile, '');
  const proxyIpSecret = 'integration-only-hmac-secret-longer-than-32-bytes';
  const childEnv = { ...process.env, NODE_ENV: 'test', API_PORT: String(port), API_PUBLIC_URL: base, DASHBOARD_URL: 'http://localhost:3000', API_PROXY_BODY_TIMEOUT_MS: '200', API_RATE_LIMIT_MAX: '2', API_PREAUTH_RATE_LIMIT_MAX: '12', API_PROXY_CLIENT_IP_SECRET: proxyIpSecret, DISCORD_CLIENT_ID: '123456789012345678', DISCORD_CLIENT_SECRET: 'fake-only', DISCORD_BOT_TOKEN: 'fake-only', SESSION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', TEST_USER_ID: actorId, TEST_GUILD_A: guildA, TEST_GUILD_B: guildB, TEST_GUILD_C: guildC, MOCK_GUILDS_COUNTER_FILE: guildCounterFile, MOCK_INSTALLATION_COUNTER_FILE: installationCounterFile };
  const apiEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  const mockEntry = new URL('./mock-discord.mjs', import.meta.url).href;
  let child;
  let dashboard;
  let apiLogs = '';
  let caseId;
  let actionCaseId;
  const start = async () => {
    child = spawn(process.execPath, ['--import', mockEntry, apiEntry], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8').on('data', chunk => { apiLogs = (apiLogs + chunk).slice(-1_000_000); });
    child.stderr.setEncoding('utf8').on('data', chunk => { apiLogs = (apiLogs + chunk).slice(-1_000_000); });
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
    const oauthStart = (headers = {}) => fetch(`${base}/oauth/discord/start`, { redirect: 'manual', headers });
    const forgedIp = { 'x-veyrobot-client-ip': '203.0.113.10', 'x-veyrobot-client-ip-signature': 'a'.repeat(64) };
    assert.equal((await oauthStart(forgedIp)).status, 302);
    assert.equal((await oauthStart(forgedIp)).status, 302);
    assert.equal((await oauthStart(forgedIp)).status, 429, 'unsigned client identity cannot escape the socket-IP bucket');
    const signed = ip => ({ 'x-veyrobot-client-ip': ip, 'x-veyrobot-client-ip-signature': createHmac('sha256', proxyIpSecret).update(ip).digest('hex') });
    assert.equal((await oauthStart(signed('203.0.113.10'))).status, 302);
    assert.equal((await oauthStart(signed('203.0.113.10'))).status, 302);
    assert.equal((await oauthStart(signed('203.0.113.10'))).status, 429);
    assert.equal((await oauthStart(signed('203.0.113.11'))).status, 302, 'distinct signed anonymous clients retain separate buckets');
    await stop();
    childEnv.API_RATE_LIMIT_MAX = '90';
    delete childEnv.API_PREAUTH_RATE_LIMIT_MAX;
    await start();
    const oauthStartResponse = await call('/oauth/discord/start', undefined, { redirect: 'manual' });
    const state = new URL(oauthStartResponse.headers.get('location')).searchParams.get('state');
    const stateCookie = oauthStartResponse.headers.get('set-cookie').split(';', 1)[0];
    assert.equal((await call('/me', stateCookie)).status, 401, 'OAuth state cookie must not be treated as an authenticated session');
    const callback = await call(`/oauth/discord/callback?code=fixture&state=${state}`, stateCookie, { redirect: 'manual' });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), 'http://localhost:3000/dashboard/user');
    const secondStart = await call('/oauth/discord/start', undefined, { redirect: 'manual' });
    const secondState = new URL(secondStart.headers.get('location')).searchParams.get('state');
    const secondStateCookie = secondStart.headers.get('set-cookie').split(';', 1)[0];
    const secondCallback = await call(`/oauth/discord/callback?code=fixture&state=${secondState}`, secondStateCookie, { redirect: 'manual' });
    const secondCookie = secondCallback.headers.get('set-cookie').split(';', 1)[0];
    assert.equal(secondCallback.status, 302);
    await stop();
    childEnv.MOCK_OAUTH_TOKEN_DELAY_MS = '9000';
    await start();
    const slowStart = await call('/oauth/discord/start', undefined, { redirect: 'manual' });
    const slowState = new URL(slowStart.headers.get('location')).searchParams.get('state');
    const slowStateCookie = slowStart.headers.get('set-cookie').split(';', 1)[0];
    const slowCallback = await call(`/oauth/discord/callback?code=fixture&state=${slowState}`, slowStateCookie, { redirect: 'manual' });
    assert.equal(slowCallback.status, 502, 'A stalled Discord token exchange must time out with a bounded response');
    delete childEnv.MOCK_OAUTH_TOKEN_DELAY_MS;
    await stop(); await start();
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
      let delayedUpload;
      const slowBody = new ReadableStream({
        start(controller) { controller.enqueue(Buffer.from('{')); delayedUpload = setTimeout(() => { controller.enqueue(Buffer.from('}')); controller.close(); }, 500); },
        cancel() { clearTimeout(delayedUpload); },
      });
      const slowResponse = await fetch(`http://localhost:${dashboardPort}/api/guilds/${guildA}/actions`, { method: 'POST', duplex: 'half', headers: { 'content-type': 'application/json' }, body: slowBody });
      assert.equal(slowResponse.status, 408, 'Next must time out a slow body before contacting the API');
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
    const guildFetchesAfterWarning = (await readFile(guildCounterFile, 'utf8')).trim().split('\n').filter(Boolean).length;
    const casesAfterWarning = await call(`/guilds/${guildA}/cases`, cookie);
    assert.equal(casesAfterWarning.status, 200, 'A successful fresh mutation authorization must warm the cache for its immediate history refresh');
    assert.ok((await casesAfterWarning.json()).items.some(item => item.id === caseId));
    assert.equal((await readFile(guildCounterFile, 'utf8')).trim().split('\n').filter(Boolean).length, guildFetchesAfterWarning, 'The post-write history read must not issue a redundant OAuth guild-list call');
    childEnv.MOCK_GUILDS_STATUS = '429';
    await stop(); await start();
    const limitedReads = await Promise.all(Array.from({ length: 8 }, () => call(`/guilds/${guildA}/cases`, cookie)));
    assert.ok(limitedReads.every(response => response.status === 429), 'A post-write history read may be rate limited without changing the saved warning');
    assert.ok(limitedReads.every(response => response.headers.get('retry-after') === '2'), 'Discord Retry-After must be returned unchanged');
    const guildFetchesAfterLimit = (await readFile(guildCounterFile, 'utf8')).trim().split('\n').filter(Boolean).length;
    assert.equal(guildFetchesAfterLimit - guildFetchesAfterWarning, 1, 'Concurrent reads and immediate retries must share one OAuth guild request during Retry-After');
    assert.equal((await call('/me', cookie)).status, 200, 'A Discord 429 must not destroy the authenticated session');
    assert.equal(await prisma.moderationCase.count({ where: { id: caseId, guildId: guildA, action: 'WARN' } }), 1, 'The successful warning must remain stored exactly once after history refresh fails');
    await stop(); delete childEnv.MOCK_GUILDS_STATUS; await start();
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
    childEnv.MOCK_INSTALLATION_CHECK_STATUS = '200';
    childEnv.API_RATE_LIMIT_MAX = '90';
    await writeFile(installationCounterFile, '');
    await stop(); await start();
    const secondMe = await call('/me', secondCookie);
    assert.equal(secondMe.status, 200);
    const secondCsrf = (await secondMe.json()).csrf;
    const installationPost = (sessionCookie, sessionCsrf, headers = {}) => call(`/guilds/${guildB}/installation-check`, sessionCookie, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', ...headers },
      body: JSON.stringify({ csrf: sessionCsrf }),
    });
    for (let index = 0; index < 5; index++) {
      assert.equal((await installationPost(cookie, csrf, { 'x-forwarded-for': `198.51.100.${index + 1}`, 'x-veyrobot-client-ip': `203.0.113.${index + 1}`, 'x-veyrobot-client-ip-signature': 'f'.repeat(64) })).status, 200);
    }
    const sixthFirstSession = await installationPost(cookie, csrf, { 'x-forwarded-for': '203.0.113.90', 'x-veyrobot-client-ip': '203.0.113.90', 'x-veyrobot-client-ip-signature': '0'.repeat(64) });
    assert.equal(sixthFirstSession.status, 429, 'installation-check enforces five requests for the first valid session despite forged IP headers');
    const secondSessionFirstCall = await installationPost(secondCookie, secondCsrf);
    assert.equal(secondSessionFirstCall.status, 200, 'exhausting one session does not block another session on the same IP');
    for (let index = 1; index < 5; index++) assert.equal((await installationPost(secondCookie, secondCsrf)).status, 200);
    assert.equal((await installationPost(secondCookie, secondCsrf)).status, 429, 'the second valid session has its own five-request installation-check quota');
    assert.equal((await call('/me', cookie)).status, 200, 'exhausting the route-specific quota does not exhaust the general session quota');
    assert.equal((await readFile(installationCounterFile, 'utf8')).trim().split('\n').filter(Boolean).length, 10, 'only the ten allowed installation checks reach the Discord adapter');
    const otherGuildConfig = await (await call(`/guilds/${guildB}/config`, cookie)).json();
    assert.equal(otherGuildConfig.language, 'fr'); assert.equal(otherGuildConfig.embedColor, '#7775F5'); assert.equal(otherGuildConfig.warningsEnabled, false);
    childEnv.MOCK_INSTALLATION_CHECK_STATUS = '429';
    await stop(); await start();
    const discordLimited = await post(`/guilds/${guildB}/installation-check`, {});
    assert.equal(discordLimited.status, 503);
    assert.equal(discordLimited.headers.get('retry-after'), '7', 'The direct bot-token Discord read must preserve Retry-After and avoid an automatic retry');
    delete childEnv.MOCK_INSTALLATION_CHECK_STATUS;
    await stop(); await start();
    const persisted = await (await call(`/guilds/${guildA}/config`, cookie)).json();
    assert.equal(persisted.embedColor, '#ABCDEF'); assert.equal(persisted.timeZone, 'Europe/Paris'); assert.equal(persisted.language, 'en'); assert.equal(persisted.warningsEnabled, false); assert.equal(persisted.memberActionsEnabled, true); assert.equal(persisted.version, disabled.version);
    await stop();
    childEnv.API_RATE_LIMIT_MAX = '2';
    await start();
    assert.equal((await call('/me', cookie, { headers: { 'x-forwarded-for': '198.51.100.1' } })).status, 200);
    assert.equal((await call('/me', cookie, { headers: { 'x-forwarded-for': '203.0.113.99' } })).status, 200);
    assert.equal((await call('/me', cookie, { headers: { 'x-forwarded-for': '192.0.2.42' } })).status, 429, 'Forged forwarding headers must not bypass the session limit');
    assert.equal((await call('/me', secondCookie, { headers: { 'x-forwarded-for': '198.51.100.1' } })).status, 200, 'A second session must have a separate rate limit bucket');
    assert.equal((await call('/me', secondCookie)).status, 200);
    assert.equal((await call('/me', secondCookie)).status, 429, 'The second valid session has its own complete quota');
    await stop(); delete childEnv.API_RATE_LIMIT_MAX; await start();
    const logout = await call('/logout', cookie, { method: 'POST', headers: { origin: 'http://localhost:3000' } });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get('set-cookie') ?? '', /veyrobot_session=;/);
    assert.equal((await call('/me', cookie)).status, 401, 'A copied cookie must be revoked server-side');
    const logoutSecond = await call('/logout', secondCookie, { method: 'POST', headers: { origin: 'http://localhost:3000' } });
    assert.equal(logoutSecond.status, 204);
    await stop(); await start();
    assert.equal((await call('/me', cookie)).status, 401, 'Revocation must survive API restart');

    childEnv.API_RATE_LIMIT_MAX = '2';
    await stop(); await start();
    const revokedResponses = await Promise.all(Array.from({ length: 8 }, (_, index) => call('/me', index % 2 ? secondCookie : cookie)));
    assert.deepEqual(revokedResponses.map(response => response.status).sort((a, b) => a - b), [401, 401, 429, 429, 429, 429, 429, 429], 'revoked sessions share the same anonymous IP quota under concurrent replay');
    const installationCountBeforeRevokedReplay = (await readFile(installationCounterFile, 'utf8')).trim().split('\n').filter(Boolean).length;
    childEnv.API_RATE_LIMIT_MAX = '2';
    await stop(); await start();
    const revokedInstallChecks = await Promise.all(Array.from({ length: 8 }, (_, index) => installationPost(index % 2 ? secondCookie : cookie, csrf)));
    assert.deepEqual(revokedInstallChecks.map(response => response.status).sort((a, b) => a - b), [401, 401, 429, 429, 429, 429, 429, 429], 'revoked cookies share the IP quota and cannot reach the installation adapter');
    assert.equal((await readFile(installationCounterFile, 'utf8')).trim().split('\n').filter(Boolean).length, installationCountBeforeRevokedReplay, 'revoked session requests never call the Discord adapter');

    await stop(); await start();
    const publicOne = await call('/public-config', cookie);
    const publicTwo = await call('/public-config', secondCookie);
    const publicThree = await call('/public-config', cookie);
    assert.deepEqual([publicOne.status, publicTwo.status, publicThree.status], [200, 200, 429], 'public routes use IP quota even when a stale authenticated cookie is present');

    await stop(); await start();
    const incompleteResponses = await Promise.all(Array.from({ length: 8 }, (_, index) => call('/me', index % 2 ? secondStateCookie : stateCookie)));
    assert.deepEqual(incompleteResponses.map(response => response.status).sort((a, b) => a - b), [401, 401, 429, 429, 429, 429, 429, 429], 'OAuth state cookies without a complete session share the anonymous IP quota');

    await stop(); childEnv.API_RATE_LIMIT_MAX = '90'; await start();
    const createSessionCookie = async () => {
      const startResponse = await call('/oauth/discord/start', undefined, { redirect: 'manual' });
      const state = new URL(startResponse.headers.get('location')).searchParams.get('state');
      const stateCookie = startResponse.headers.get('set-cookie').split(';', 1)[0];
      const callbackResponse = await call(`/oauth/discord/callback?code=fixture&state=${state}`, stateCookie, { redirect: 'manual' });
      assert.equal(callbackResponse.status, 302);
      return callbackResponse.headers.get('set-cookie').split(';', 1)[0];
    };
    const grantsBeforeExpiry = new Set((await prisma.sessionGrant.findMany({ select: { idHash: true } })).map(grant => grant.idHash));
    const expiredCookieA = await createSessionCookie();
    const expiredCookieB = await createSessionCookie();
    const newGrantHashes = (await prisma.sessionGrant.findMany({ select: { idHash: true } })).map(grant => grant.idHash).filter(hash => !grantsBeforeExpiry.has(hash));
    assert.equal(newGrantHashes.length, 2);
    await prisma.sessionGrant.updateMany({ where: { idHash: { in: newGrantHashes } }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    childEnv.API_RATE_LIMIT_MAX = '2';
    await stop(); await start();
    const expiredResponses = await Promise.all(Array.from({ length: 8 }, (_, index) => call('/me', index % 2 ? expiredCookieB : expiredCookieA)));
    assert.deepEqual(expiredResponses.map(response => response.status).sort((a, b) => a - b), [401, 401, 429, 429, 429, 429, 429, 429], 'expired sessions share the anonymous IP quota under concurrent replay');

    const savedDatabaseUrl = childEnv.DATABASE_URL;
    childEnv.DATABASE_URL = 'postgresql://unavailable:unavailable@127.0.0.1:1/unavailable?connect_timeout=1';
    childEnv.API_RATE_LIMIT_MAX = '2';
    await stop(); await start();
    const grantFailureResponses = await Promise.all([expiredCookieA, expiredCookieB, expiredCookieA].map(cookie => call('/me', cookie)));
    assert.deepEqual(grantFailureResponses.map(response => response.status).sort((a, b) => a - b), [429, 503, 503], 'a grant store outage never grants a session bucket and is still bounded by the IP quota');
    for (const response of grantFailureResponses.filter(item => item.status === 503)) {
      const body = await response.json();
      assert.equal(body.error, 'Vérification de session indisponible.');
      assert.equal(body.requestId, response.headers.get('x-request-id'));
      assert.doesNotMatch(body.error, /Prisma|postgres|fixture|connect|database|P100/i);
    }
    await delay(50);
    const grantFailureLog = apiLogs.split(/\r?\n/).map(line => { try { return JSON.parse(line); } catch { return null; } })
      .find(entry => entry?.phase === 'session_grant_validation' && entry?.requestId === grantFailureResponses.find(item => item.status === 503)?.headers.get('x-request-id'));
    assert.ok(grantFailureLog, 'grant-validation PostgreSQL failure is logged with the correlated requestId');
    assert.equal(grantFailureLog.code, 'SESSION_CHECK_UNAVAILABLE');
    assert.equal(grantFailureLog.status, 503);
    assert.equal(typeof grantFailureLog.exception.message, 'string');
    assert.doesNotMatch(JSON.stringify(grantFailureLog), /fixture_local_only|fixture:|postgresql:\/\//i);
    childEnv.API_RATE_LIMIT_MAX = '90';
    childEnv.API_PREAUTH_RATE_LIMIT_MAX = '2';
    await stop(); await start();
    const preAuthFailureStatuses = await Promise.all([expiredCookieA, expiredCookieB, expiredCookieA].map(cookie => call('/me', cookie).then(response => response.status)));
    assert.deepEqual(preAuthFailureStatuses.sort((a, b) => a - b), [429, 503, 503], 'the pre-auth IP limit caps database grant lookups even if the database is unavailable');
    childEnv.DATABASE_URL = savedDatabaseUrl;
    await stop();

    childEnv.DATABASE_URL = savedDatabaseUrl;
    childEnv.API_RATE_LIMIT_MAX = '90';
    childEnv.API_PREAUTH_RATE_LIMIT_MAX = '2';
    await start();
    const preAuthStatuses = await Promise.all([call('/public-config'), call('/public-config'), call('/public-config')].map(response => response.then(value => value.status)));
    assert.deepEqual(preAuthStatuses.sort((a, b) => a - b), [200, 200, 429], 'the bounded pre-auth IP quota applies to public routes');
    console.log('API integration passed: OAuth, distinct valid-session quotas including installation-check, revoked/expired/incomplete fallback, forged headers, bounded pre-auth grant checks, outage behavior, adapter call counts, and public-route limits.');
  } finally {
    await stop();
    if (caseId) await prisma.moderationCase.deleteMany({ where: { id: caseId } });
    if (actionCaseId) await prisma.moderationCase.deleteMany({ where: { id: actionCaseId } });
    await prisma.configAudit.deleteMany({ where: { guildId: { in: [guildA, guildB, guildC] } } });
    await prisma.guildConfig.deleteMany({ where: { guildId: { in: [guildA, guildB, guildC] } } });
    await prisma.guildPresence.deleteMany({ where: { guildId: { in: [guildA, guildB, guildC] } } });
    await prisma.shardPresence.deleteMany({ where: { shardId: { in: [onlineShard, offlineShard] } } });
    await import('node:fs/promises').then(({ unlink }) => unlink(guildCounterFile).catch(() => undefined));
    await import('node:fs/promises').then(({ unlink }) => unlink(installationCounterFile).catch(() => undefined));
    await prisma.$disconnect();
  }
}
