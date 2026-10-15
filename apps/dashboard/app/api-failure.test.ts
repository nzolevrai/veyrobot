import assert from 'node:assert/strict';
import test from 'node:test';
import { failureMessage, historyFailureMessage, readApiFailure, retryAfterDelayMs } from './api-failure';

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
test('Retry-After numérique et date sont interprétés sans rendre la session expirée', async () => {
  const numeric = await readApiFailure(new Response('{}', { status: 429, headers: { 'retry-after': '2.5' } }));
  assert.equal(numeric.retryAfter, '2.5');
  assert.equal(retryAfterDelayMs(numeric.retryAfter, 1_000), 2_500);
  assert.equal(retryAfterDelayMs('Thu, 01 Jan 1970 00:00:05 GMT', 1_000), 4_000);
  assert.match(historyFailureMessage(numeric), /Historique temporairement impossible/);
  assert.match(historyFailureMessage(numeric), /dossiers déjà affichés sont conservés/);
});
