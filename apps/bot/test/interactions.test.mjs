import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acknowledgeInteraction, respondSafely, runInteractionSafely } from '../dist/interactions.js';

test('interaction acknowledgement and replies use the valid Discord response state', async () => {
  const calls = [];
  assert.equal(await acknowledgeInteraction({ deferReply: async options => calls.push(['defer', options.ephemeral]) }), true);
  await respondSafely({ deferred: true, replied: false, reply: async () => calls.push(['reply']), editReply: async () => calls.push(['edit']), followUp: async () => calls.push(['followUp']) }, { content: 'done' });
  await respondSafely({ deferred: false, replied: true, reply: async () => calls.push(['reply']), editReply: async () => calls.push(['edit']), followUp: async () => calls.push(['followUp']) }, { content: 'again' });
  assert.deepEqual(calls.map(call => call[0]), ['defer', 'edit', 'followUp']);
});

test('defer, reply, edit and follow-up errors are contained and do not reject the event callback', async () => {
  assert.equal(await acknowledgeInteraction({ deferReply: async () => { throw new Error('expired'); } }), false);
  for (const state of [{ deferred: false, replied: false, method: 'reply' }, { deferred: true, replied: false, method: 'editReply' }, { deferred: false, replied: true, method: 'followUp' }]) {
    let called = false;
    await respondSafely({ deferred: state.deferred, replied: state.replied, reply: async () => { if (state.method === 'reply') { called = true; throw new Error('expired'); } }, editReply: async () => { if (state.method === 'editReply') { called = true; throw new Error('expired'); } }, followUp: async () => { if (state.method === 'followUp') { called = true; throw new Error('expired'); } } }, { content: 'safe' });
    assert.equal(called, true);
  }
  let acknowledgedError;
  const result = await runInteractionSafely(async () => { throw new Error('database unavailable'); }, async error => { acknowledgedError = error; });
  assert.equal(result, undefined);
  assert.match(acknowledgedError.message, /database unavailable/);
  assert.equal(await runInteractionSafely(async () => 'other interaction still runs', async () => { throw new Error('not expected'); }), 'other interaction still runs');
});
