import ipaddr from 'ipaddr.js';

// Keep this deliberately narrower than the set of formats accepted by general-purpose IP parsers.
// Proxy headers must contain exactly one bare IP literal, not a host/port or list.
const MAX_CLIENT_IP_LENGTH = 45;
const IPV4_DECIMAL = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/;
const IPV6_TEXT = /^[0-9a-f:.]+$/i;

function validStrictIpv4(value: string): boolean {
  if (!IPV4_DECIMAL.test(value)) return false;
  return value.split('.').every(part => Number(part) <= 255);
}

/** Normalize a single bare address. IPv4-mapped IPv6 addresses share the IPv4 bucket. */
export function canonicalizeClientIp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CLIENT_IP_LENGTH) return null;
  if (value !== value.trim() || /[,\s\[\]%/\\]/.test(value)) return null;

  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    const ipv4Tail = lastColon < 0 ? value : value.slice(lastColon + 1);
    if (!validStrictIpv4(ipv4Tail)) return null;
  }

  if (value.includes(':')) {
    if (!IPV6_TEXT.test(value) || !ipaddr.IPv6.isValid(value)) return null;
    try {
      const parsed = ipaddr.IPv6.parse(value);
      if (parsed.zoneId) return null;
      return parsed.isIPv4MappedAddress() ? parsed.toIPv4Address().toString() : parsed.toRFC5952String().toLowerCase();
    } catch {
      return null;
    }
  }

  if (!validStrictIpv4(value)) return null;
  try { return ipaddr.IPv4.parse(value).toString(); } catch { return null; }
}

/** Domain-separated, versioned payload shared by the Next signer and API verifier. */
export function clientIpSigningPayload(canonicalIp: string): string {
  return `veyrobot-client-ip:v1\n${canonicalIp}`;
}
