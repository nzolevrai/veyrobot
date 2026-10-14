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
