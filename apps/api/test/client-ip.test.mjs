import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import { CLIENT_IP_HEADER, CLIENT_IP_SIGNATURE_HEADER, signedClientIp, verifiedClientIp } from '../dist/client-ip.js';
import { canonicalizeClientIp, clientIpSigningPayload } from '@veyrobot/contracts/client-ip';

test('only a valid server signature can give an anonymous request a client-specific rate-limit key', () => {
  const secret = 'test-only-signing-secret';
  const headers = { [CLIENT_IP_HEADER]: '203.0.113.7', [CLIENT_IP_SIGNATURE_HEADER]: signedClientIp('203.0.113.7', secret) };
  assert.equal(verifiedClientIp(headers, secret), '203.0.113.7');
  assert.equal(verifiedClientIp({ ...headers, [CLIENT_IP_HEADER]: '203.0.113.8' }, secret), null);
  assert.equal(verifiedClientIp({ ...headers, [CLIENT_IP_SIGNATURE_HEADER]: signedClientIp('203.0.113.7', 'wrong') }, secret), null);
  assert.equal(verifiedClientIp({ [CLIENT_IP_HEADER]: '203.0.113.8' }, secret), null);
  assert.equal(verifiedClientIp({ ...headers, [CLIENT_IP_HEADER]: 'not-an-ip' }, secret), null);
  assert.equal(verifiedClientIp({ ...headers, [CLIENT_IP_HEADER]: ['203.0.113.7', '203.0.113.8'] }, secret), null);
  assert.equal(verifiedClientIp({ ...headers, [CLIENT_IP_SIGNATURE_HEADER]: ['00'.repeat(32)] }, secret), null);
  assert.equal(verifiedClientIp({ ...headers, [CLIENT_IP_HEADER]: '203.0.113.7, 198.51.100.1' }, secret), null);
  assert.equal(verifiedClientIp({ ...headers, [CLIENT_IP_SIGNATURE_HEADER]: `${headers[CLIENT_IP_SIGNATURE_HEADER]},${headers[CLIENT_IP_SIGNATURE_HEADER]}` }, secret), null);
});

test('accepts a valid signature only for the canonical address and returns its quota key', () => {
  const secret = 'test-only-signing-secret-longer-than-32-bytes';
  const canonical = '2001:db8::1';
  const signature = createHmac('sha256', secret).update(clientIpSigningPayload(canonical)).digest('hex');
  assert.equal(verifiedClientIp({ [CLIENT_IP_HEADER]: '2001:0DB8:0:0:0:0:0:1', [CLIENT_IP_SIGNATURE_HEADER]: signature }, secret), canonical);
  assert.equal(canonicalizeClientIp('::ffff:c000:201'), '192.0.2.1');
  assert.equal(signedClientIp('::ffff:192.0.2.1', secret), signedClientIp('192.0.2.1', secret));
});

test('invalid identity or mismatched secrets can only fall back to socket identity', () => {
  const ip = '198.51.100.4';
  const signature = signedClientIp(ip, 'source-secret-at-least-32-bytes-long');
  assert.equal(verifiedClientIp({ [CLIENT_IP_HEADER]: ip, [CLIENT_IP_SIGNATURE_HEADER]: signature }, 'different-secret-at-least-32-bytes'), null);
  assert.equal(verifiedClientIp({ [CLIENT_IP_HEADER]: '[198.51.100.4]', [CLIENT_IP_SIGNATURE_HEADER]: signature }, 'source-secret-at-least-32-bytes-long'), null);
  assert.throws(() => signedClientIp('198.51.100.4:443', 'source-secret-at-least-32-bytes-long'), TypeError);
});
