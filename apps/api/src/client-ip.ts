import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalizeClientIp, clientIpSigningPayload } from '@veyrobot/contracts/client-ip';

export const CLIENT_IP_HEADER = 'x-veyrobot-client-ip';
export const CLIENT_IP_SIGNATURE_HEADER = 'x-veyrobot-client-ip-signature';

export function signedClientIp(ip: string, secret: string): string {
  const canonicalIp = canonicalizeClientIp(ip);
  if (!canonicalIp) throw new TypeError('Client address must be a supported IP literal');
  return createHmac('sha256', secret).update(clientIpSigningPayload(canonicalIp)).digest('hex');
}

export function verifiedClientIp(headers: Record<string, unknown>, secret: string): string | null {
  const ip = headers[CLIENT_IP_HEADER] as string | undefined;
  const signature = headers[CLIENT_IP_SIGNATURE_HEADER] as string | undefined;
  const canonicalIp = canonicalizeClientIp(ip);
  if (!canonicalIp || typeof signature !== 'string' || !/^[a-f\d]{64}$/i.test(signature)) return null;
  const expected = Buffer.from(signedClientIp(canonicalIp, secret), 'hex');
  const actual = Buffer.from(signature, 'hex');
  return actual.length === expected.length && timingSafeEqual(expected, actual) ? canonicalIp : null;
}
