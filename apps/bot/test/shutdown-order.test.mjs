import test from 'node:test';
import assert from 'node:assert/strict';
import { destroyClientBeforeReleasingLease } from '../dist/shutdown-order.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('holds the single-instance lease until Gateway destruction completes', async () => {
  const destroyGate = deferred();
  const events = [];
  let destroyStarted;
  const started = new Promise(resolve => { destroyStarted = resolve; });

  const shutdown = destroyClientBeforeReleasingLease({
    destroy() {
      events.push('gateway-close-started');
      destroyStarted();
      return destroyGate.promise.then(() => { events.push('gateway-closed'); });
    },
  }, async () => { events.push('lease-released'); });

  await started;
  assert.deepEqual(events, ['gateway-close-started']);
  destroyGate.resolve();
  await shutdown;
  assert.deepEqual(events, ['gateway-close-started', 'gateway-closed', 'lease-released']);
});
