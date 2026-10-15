import assert from 'node:assert/strict';
import test from 'node:test';
import { createWarningThenRefresh } from './warning-submission';

test('un échec 429 du rafraîchissement ne transforme pas la création enregistrée en échec et ne la répète pas', async () => {
  let writes = 0;
  let reads = 0;
  const result = await createWarningThenRefresh(async () => {
    writes++;
    return { id: 'case-saved' };
  }, async () => {
    reads++;
    throw Object.assign(new Error('429'), { status: 429 });
  });
  assert.deepEqual(result, { created: { id: 'case-saved' }, refreshed: false });
  assert.equal(writes, 1);
  assert.equal(reads, 1);
});
