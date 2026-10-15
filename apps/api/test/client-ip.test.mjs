import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLIENT_IP_HEADER, CLIENT_IP_SIGNATURE_HEADER, signedClientIp, verifiedClientIp } from '../dist/client-ip.js';

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
});
