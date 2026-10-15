import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const CLIENT_IP_HEADER = 'x-veyrobot-client-ip';
export const CLIENT_IP_SIGNATURE_HEADER = 'x-veyrobot-client-ip-signature';

export function signedClientIp(ip: string, secret: string): string {
  return createHmac('sha256', secret).update(ip).digest('hex');
}

export function verifiedClientIp(headers: Record<string, unknown>, secret: string): string | null {
  const ip = headers[CLIENT_IP_HEADER] as string | undefined;
  const signature = headers[CLIENT_IP_SIGNATURE_HEADER] as string | undefined;
  if (typeof ip !== 'string' || isIP(ip) === 0 || typeof signature !== 'string' || !/^[a-f\d]{64}$/i.test(signature)) return null;
  const expected = Buffer.from(signedClientIp(ip, secret), 'hex');
  const actual = Buffer.from(signature, 'hex');
  return actual.length === expected.length && timingSafeEqual(expected, actual) ? ip : null;
}
