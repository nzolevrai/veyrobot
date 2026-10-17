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

  let address = value;
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    const ipv4Tail = lastColon < 0 ? value : value.slice(lastColon + 1);
    if (!validStrictIpv4(ipv4Tail)) return null;
    // ipaddr.js can classify IPv6 addresses with a dotted tail as IPv4-mapped
    // even when the IPv6 prefix is not the mapped prefix (for example ::1.2.3.4).
    // Convert only the already-validated decimal tail before asking it to parse.
    if (lastColon >= 0) {
      const octets = ipv4Tail.split('.').map(Number);
      const high = ((octets[0]! << 8) | octets[1]!).toString(16);
      const low = ((octets[2]! << 8) | octets[3]!).toString(16);
      address = `${value.slice(0, lastColon + 1)}${high}:${low}`;
    }
  }

  if (address.includes(':')) {
    if (!IPV6_TEXT.test(address) || !ipaddr.IPv6.isValid(address)) return null;
    try {
      const parsed = ipaddr.IPv6.parse(address);
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
