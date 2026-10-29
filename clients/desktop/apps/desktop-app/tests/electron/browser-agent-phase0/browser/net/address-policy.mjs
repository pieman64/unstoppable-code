// @ts-check
/**
 * Address and URL policy for the S0.3 per-tab browser enforcement probe.
 *
 * Pure functions, Node built-ins only. No DNS, no network.
 */
import { isIP } from 'node:net';

/**
 * @typedef {'loopback'|'private'|'link-local'|'metadata'|'unique-local'|'cgnat'|'unspecified'|'multicast'|'broadcast'|'reserved'|'synthetic-public'|'public'|'invalid'} AddressClass
 */

/**
 * @typedef {{ allow: boolean, reason: string, host: string|null, hostKind: 'ip'|'name'|'none' }} LeasedUrlDecision
 */

/**
 * Parse a dotted-quad IPv4 string into four octets.
 * @param {string} ip
 * @returns {number[]|null}
 */
function parseIPv4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const out = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/**
 * Parse an IPv6 string (already validated by isIP) into eight 16-bit groups.
 * Supports `::` compression and a trailing embedded IPv4 part.
 * @param {string} ip
 * @returns {number[]|null}
 */
function parseIPv6(ip) {
  let text = ip;
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);

  // Replace an embedded IPv4 tail with two hex groups.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  /** @param {string} s */
  const toGroups = (s) => (s === '' ? [] : s.split(':'));
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  let groups;
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 0) return null;
    groups = [...head, ...new Array(missing).fill('0'), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const out = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

/**
 * @param {number[]} o
 * @returns {AddressClass}
 */
function classifyIPv4Octets(o) {
  const [a, b, c] = o;
  if (a === 169 && b === 254 && c === 169 && o[3] === 254) return 'metadata';
  if (a === 255 && b === 255 && c === 255 && o[3] === 255) return 'broadcast';
  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  if (a === 169 && b === 254) return 'link-local';
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved';
  if (a === 198 && (b === 18 || b === 19)) return 'reserved';
  if (a === 192 && b === 0 && c === 2) return 'synthetic-public';
  if (a === 198 && b === 51 && c === 100) return 'synthetic-public';
  if (a === 203 && b === 0 && c === 113) return 'synthetic-public';
  return 'public';
}

/**
 * Classify an IP address string.
 * @param {string} ip
 * @returns {AddressClass}
 */
export function classifyAddress(ip) {
  if (typeof ip !== 'string') return 'invalid';
  const family = isIP(ip);
  if (family === 4) {
    const o = parseIPv4(ip);
    return o ? classifyIPv4Octets(o) : 'invalid';
  }
  if (family === 6) {
    const g = parseIPv6(ip);
    if (!g) return 'invalid';
    // IPv4-mapped ::ffff:a.b.c.d (any textual form).
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
      return classifyIPv4Octets([
        g[6] >> 8,
        g[6] & 0xff,
        g[7] >> 8,
        g[7] & 0xff,
      ]);
    }
    if (g.every((x) => x === 0)) return 'unspecified';
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'loopback';
    if (
      g[0] === 0xfd00 &&
      g[1] === 0x0ec2 &&
      g.slice(2, 7).every((x) => x === 0) &&
      g[7] === 0x0254
    ) {
      return 'metadata';
    }
    if ((g[0] & 0xffc0) === 0xfe80) return 'link-local';
    if ((g[0] & 0xfe00) === 0xfc00) return 'unique-local';
    if ((g[0] & 0xff00) === 0xff00) return 'multicast';
    if (g[0] === 0x2001 && g[1] === 0x0db8) return 'synthetic-public';
    return 'public';
  }
  return 'invalid';
}

/**
 * Only real public addresses and the synthetic documentation stand-ins pass.
 * @param {string} cls
 * @returns {boolean}
 */
export function isAllowedAddressClass(cls) {
  return cls === 'public' || cls === 'synthetic-public';
}

/**
 * Exact origin string with ws->http and wss->https; null for opaque/invalid.
 * `blob:` URLs yield their inner origin.
 * @param {string} urlOrOrigin
 * @returns {string|null}
 */
export function normalizeOrigin(urlOrOrigin) {
  let u;
  try {
    u = new URL(urlOrOrigin);
  } catch {
    return null;
  }
  if (u.protocol === 'blob:') {
    return u.origin === 'null' ? null : normalizeOrigin(u.origin);
  }
  /** @type {Record<string, string>} */
  const schemeMap = {
    'http:': 'http:',
    'https:': 'https:',
    'ws:': 'http:',
    'wss:': 'https:',
  };
  const scheme = schemeMap[u.protocol];
  if (!scheme || !u.host) return null;
  return `${scheme}//${u.host}`;
}

/**
 * Decide whether a URL may be loaded by a leased tab, at the URL layer only.
 * Hostnames are allowed here with a marker reason; resolved-address enforcement
 * belongs to the gateway.
 * @param {string} url
 * @param {{ exceptionOrigin?: string|null, deniedOrigins?: string[] }} [options]
 * @returns {LeasedUrlDecision}
 */
export function evaluateLeasedUrl(
  url,
  { exceptionOrigin, deniedOrigins = [] } = {},
) {
  /** @type {(allow: boolean, reason: string, host?: string|null, hostKind?: 'ip'|'name'|'none') => LeasedUrlDecision} */
  const result = (allow, reason, host = null, hostKind = 'none') => ({
    allow,
    reason,
    host,
    hostKind,
  });

  let u;
  try {
    u = new URL(url);
  } catch {
    return result(false, 'invalid-url');
  }

  if (u.protocol === 'about:') {
    if (u.href === 'about:blank' || u.href === 'about:srcdoc')
      return result(true, 'about');
    return result(false, 'scheme-denied');
  }
  if (u.protocol === 'data:') return result(true, 'data-no-network');
  if (u.protocol === 'blob:') {
    if (u.origin === 'null') return result(false, 'blob-opaque-origin');
    return evaluateLeasedUrl(u.origin, { exceptionOrigin, deniedOrigins });
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol))
    return result(false, 'scheme-denied');
  if (u.username || u.password) return result(false, 'credentials-in-url');

  const origin = normalizeOrigin(u.href);
  const rawHost = u.hostname;
  const isV6Literal = rawHost.startsWith('[') && rawHost.endsWith(']');
  const host = isV6Literal ? rawHost.slice(1, -1) : rawHost;
  const hostKind = isIP(host) ? 'ip' : 'name';

  const denied = deniedOrigins
    .map((o) => normalizeOrigin(o))
    .filter((o) => o !== null);
  if (origin && denied.includes(origin))
    return result(false, 'denied-origin', host, hostKind);

  const exception = exceptionOrigin ? normalizeOrigin(exceptionOrigin) : null;
  if (origin && exception && origin === exception) {
    return result(true, 'fixture-origin-exception', host, hostKind);
  }

  if (hostKind === 'ip') {
    const cls = classifyAddress(host);
    if (!isAllowedAddressClass(cls))
      return result(false, `address-class:${cls}`, host, 'ip');
    return result(true, `address-class:${cls}`, host, 'ip');
  }

  const bare = host.endsWith('.') ? host.slice(0, -1) : host;
  if (bare === 'localhost' || bare.endsWith('.localhost'))
    return result(false, 'localhost-name', host, 'name');

  return result(true, 'name-needs-resolved-address-check', host, 'name');
}
