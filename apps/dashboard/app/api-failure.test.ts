import assert from 'node:assert/strict';
import test from 'node:test';
import { failureMessage, readApiFailure } from './api-failure';

test('limitation API et Discord ne sont pas prises pour une session expirée', async () => {
  for (const code of ['API_RATE_LIMIT', 'DISCORD_RATE_LIMIT']) {
    const failure = await readApiFailure(Response.json({ code, requestId: 'req-test' }, { status: 429 }));
    assert.equal(failure.status, 429);
    assert.equal(failure.requestId, 'req-test');
    assert.doesNotMatch(failureMessage(failure), /Reconnectez/);
  }
});
test('erreur API et session absente sont distinguées', () => {
  assert.match(failureMessage({ status: 503, code: 'API_UNREACHABLE' }), /conservée/);
  assert.match(failureMessage({ status: 401, code: 'SESSION_ABSENT' }), /Reconnectez/);
});
