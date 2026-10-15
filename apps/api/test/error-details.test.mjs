import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { Writable } from 'node:stream';
import { apiExceptionLogRecord, classifyApiError, sanitizedErrorDetails } from '../dist/error-details.js';

test('emitted API exception log redacts every canary while retaining bounded diagnostics', async () => {
  const canaries = [
    'CS_CANARY_9f3a', 'SK_CANARY_7d2b', 'BEARER_CANARY_6a1c', 'COOKIE_CANARY_4e8d',
    'PGUSER_CANARY_3b7f', 'PGPASS_CANARY_2c5a', 'NESTED_CANARY_8d1e', 'NEWLINE_CANARY_5a4c',
    'LONG_CANARY_0f9b', 'CODE_CANARY_1e6d', 'REQUEST_CANARY_2a7c',
  ];
  const leaf = Object.assign(new Error(`query failed client_secret=${canaries[0]} SESSION_KEY=${canaries[1]} Authorization: Bearer ${canaries[2]} Cookie: sid=${canaries[3]} PostgreSQL URL postgresql://${canaries[4]}:${canaries[5]}@db.invalid/app\nclient_secret=${canaries[7]}${'x'.repeat(6000)}${canaries[8]}`), {
    name: `client_secret=${canaries[0]}`,
    code: `SESSION_KEY=${canaries[9]}`,
    cause: Object.assign(new Error(`upstream failed refresh_token=${canaries[6]}`), { name: `SESSION_KEY=${canaries[1]}`, cause: new TypeError('socket reset', { cause: new Error('beyond depth') }) }),
  });
  const failure = Object.assign(new Error('database unavailable'), { name: `SESSION_KEY=${canaries[1]}`, cause: leaf, code: 'P1001' });
  const record = apiExceptionLogRecord(`req-${canaries[10]}=secret`, 503, 'SESSION_CHECK_UNAVAILABLE', failure, `session_grant_validation\nSESSION_KEY=${canaries[1]}`);

  let output = '';
  const stream = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
  const app = Fastify({ logger: { level: 'error', stream } });
  try {
    app.log.error(record, 'Session grant validation failed');
    await app.close();
  } finally { await app.close().catch(() => undefined); }

  const emitted = JSON.parse(output.trim());
  for (const canary of canaries) assert.equal(output.includes(canary), false, `emitted logger output leaked ${canary}`);
  assert.equal(emitted.requestId, 'unknown');
  assert.equal(emitted.status, 503);
  assert.equal(emitted.code, 'SESSION_CHECK_UNAVAILABLE');
  assert.match(emitted.phase, /session_grant_validation/);
  assert.equal(emitted.exception.name, 'Error');
  assert.equal(emitted.exception.code, 'P1001');
  assert.equal(emitted.exception.message, 'Exception text omitted.');
  assert.equal(emitted.exception.cause.name, 'Error');
  assert.equal(emitted.exception.cause.message, 'Exception text omitted.');
  assert.equal(emitted.exception.cause.cause.name, 'Error');
  assert.equal(emitted.exception.cause.cause.cause.message, 'Exception text omitted.');
  assert.equal(emitted.exception.cause.cause.cause.name, 'TypeError');
  assert.equal(emitted.exception.cause.cause.cause.cause.message, '[cause depth limit]');
  assert.equal(emitted.exception.cause.code, undefined);
  assert.ok(output.length < 5000, 'output remains bounded despite an oversized exception');
});

test('emitted API logs omit unsafe exception text in common secret formats and beyond the input budget', async () => {
  const canaries = ['CANARY_JSON', 'CANARY valeur avec espaces', 'CANARY_URL_PASSWORD', 'CANARY_JWT_PAYLOAD'];
  const jwt = `eyJ${'a'.repeat(28)}.${'b'.repeat(28)}.${'c'.repeat(28)}`;
  const longCredentialUrl = `database failed postgresql://user:${canaries[2]}${'x'.repeat(5000)}@db.invalid/app`;
  const error = new Error([
    `{"client_secret":"${canaries[0]}"}`,
    `SESSION_KEY="${canaries[1]}"`,
    longCredentialUrl,
    jwt,
  ].join('\n'));
  const stream = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
  let output = '';
  const app = Fastify({ logger: { level: 'error', stream } });
  try {
    app.log.error(apiExceptionLogRecord('req-safe-1', 500, 'INTERNAL_ERROR', error), 'API request failed');
    await app.close();
  } finally { await app.close().catch(() => undefined); }

  for (const canary of canaries) assert.equal(output.includes(canary), false, `API emitted ${canary}`);
  assert.equal(output.includes(jwt), false, 'API emitted a raw JWT');
  const record = JSON.parse(output.trim());
  assert.equal(record.requestId, 'req-safe-1');
  assert.equal(record.exception.message, 'Exception text omitted.');
  assert.equal(record.exception.code, undefined);
});

test('API classification keeps client responses generic and exposes no internal codes', () => {
  const error = Object.assign(new Error('postgresql://user:password@db.invalid/x SESSION_KEY=classified-canary'), {
    name: 'client_secret=classified-canary', code: 'SESSION_KEY=classified-canary', statusCode: 503,
  });
  const classified = classifyApiError(error);
  const clientBody = { code: classified.code, error: classified.message, requestId: 'req-123' };
  assert.equal(classified.status, 503);
  assert.equal(classified.code, 'INTERNAL_ERROR');
  assert.equal(classified.message, 'Service temporairement indisponible.');
  assert.equal(JSON.stringify(clientBody).includes('classified-canary'), false);
  assert.equal(JSON.stringify(clientBody).includes('postgresql'), false);
});

test('sanitizer handles circular causes, throwing getters and atypical thrown values without throwing', () => {
  const circular = new Error('outer');
  circular.cause = circular;
  assert.equal(sanitizedErrorDetails(circular).cause?.message, '[circular cause]');
  let deepCause = new Error('deepest');
  for (let depth = 0; depth < 6; depth++) deepCause = new Error(`layer ${depth}`, { cause: deepCause });
  const bounded = sanitizedErrorDetails(deepCause);
  assert.equal(bounded.cause?.cause?.cause?.cause?.message, '[cause depth limit]');
  const hostile = new Proxy({}, { get(_target, property) { if (property === 'name' || property === 'message' || property === 'code' || property === 'cause') throw new Error('getter failed'); return undefined; }, getPrototypeOf() { throw new Error('prototype trap'); } });
  assert.doesNotThrow(() => sanitizedErrorDetails(hostile));
  assert.doesNotThrow(() => classifyApiError(hostile));
  assert.equal(sanitizedErrorDetails('thrown string').message, 'Non-Error thrown.');
});

test('safe diagnostic text preserves short benign context and fails closed for oversized input', async () => {
  const { safeDiagnosticText } = await import('../dist/error-details.js');
  assert.equal(safeDiagnosticText('database pool exhausted during session_grant_validation'), 'database pool exhausted during session_grant_validation');
  assert.equal(safeDiagnosticText('x'.repeat(5000)), '[diagnostic text omitted: input limit exceeded]');
  assert.equal(safeDiagnosticText('SESSION_KEY="CANARY valeur avec espaces"'), 'SESSION_KEY=[redacted]');
  assert.equal(safeDiagnosticText('{"CLIENT_SECRET":"CANARY_JSON"}'), '{"CLIENT_SECRET":[redacted]}');
  assert.equal(safeDiagnosticText('eyJ' + 'a'.repeat(28) + '.' + 'b'.repeat(28) + '.' + 'c'.repeat(28)), '[redacted-token]');
});
