import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GuildListCache } from '../dist/guild-list-cache.js';

test('fifty concurrent misses in one session issue one request', async () => {
  const cache = new GuildListCache();
  let calls = 0;
  const results = await Promise.all(Array.from({ length: 50 }, () => cache.get('session-a', async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return ['guild-a'];
  })));
  assert.equal(calls, 1);
  assert.ok(results.every(item => item === results[0]));
});

test('sessions stay isolated; failure is retried and expiry reloads', async () => {
  let now = 0;
  const cache = new GuildListCache(10, 2, () => now);
  let calls = 0;
  await assert.rejects(cache.get('a', async () => { calls++; throw new Error('Discord unavailable'); }));
  assert.deepEqual(await cache.get('a', async () => { calls++; return ['a']; }), ['a']);
  assert.deepEqual(await cache.get('b', async () => { calls++; return ['b']; }), ['b']);
  assert.equal(calls, 3);
  now = 11;
  assert.deepEqual(await cache.get('a', async () => { calls++; return ['new-a']; }), ['new-a']);
  assert.equal(calls, 4);
});

test('concurrent distinct sessions cannot exceed the loading cap', async () => {
  const cache = new GuildListCache(10_000, 1);
  let finish;
  const pending = cache.get('first', () => new Promise(resolve => { finish = resolve; }));
  let secondCalled = false;
  await assert.rejects(cache.get('second', async () => { secondCalled = true; return []; }), { code: 'OAUTH_CACHE_CAPACITY', statusCode: 503 });
  assert.equal(secondCalled, false);
  finish([]);
  await pending;
});

test('a forced authorization refresh warms the same cache used by subsequent reads', async () => {
  const cache = new GuildListCache(10_000);
  let calls = 0;
  const load = async () => { calls++; return ['fresh-permissions']; };
  assert.deepEqual(await cache.refresh('session-a', load), ['fresh-permissions']);
  assert.deepEqual(await cache.get('session-a', load), ['fresh-permissions']);
  assert.equal(calls, 1, 'read-only dossier refresh should reuse the permission snapshot fetched for the preceding mutation');
});

test('Discord Retry-After is honored for cache misses and forced refreshes', async () => {
  let now = 0;
  const cache = new GuildListCache(10, 2, () => now);
  let calls = 0;
  const limited = async () => {
    calls++;
    throw Object.assign(new Error('rate limited'), { statusCode: 429, code: 'DISCORD_RATE_LIMIT', retryAfter: '5' });
  };
  await assert.rejects(cache.get('session-a', limited), { statusCode: 429, code: 'DISCORD_RATE_LIMIT', retryAfter: '5' });
  const burst = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => index % 2 ? cache.get('session-a', limited) : cache.refresh('session-a', limited)));
  assert.ok(burst.every(result => result.status === 'rejected'));
  assert.ok(burst.every(result => result.status === 'rejected' && result.reason.retryAfter === '5'));
  assert.equal(calls, 1, 'known cooldown must prevent repeated upstream OAuth reads');
  now = 5_000;
  assert.deepEqual(await cache.get('session-a', async () => { calls++; return ['recovered']; }), ['recovered']);
  assert.equal(calls, 2, 'one retry is allowed after Retry-After expires');
});
