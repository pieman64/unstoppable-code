import { BlockList, isIP } from 'node:net';

const NON_PUBLIC_NETWORKS = new BlockList();
NON_PUBLIC_NETWORKS.addSubnet('0.0.0.0', 8, 'ipv4');
NON_PUBLIC_NETWORKS.addSubnet('10.0.0.0', 8, 'ipv4');
NON_PUBLIC_NETWORKS.addSubnet('100.64.0.0', 10, 'ipv4');
NON_PUBLIC_NETWORKS.addSubnet('127.0.0.0', 8, 'ipv4');
NON_PUBLIC_NETWORKS.addSubnet('169.254.0.0', 16, 'ipv4');
NON_PUBLIC_NETWORKS.addSubnet('172.16.0.0', 12, 'ipv4');
NON_PUBLIC_NETWORKS.addSubnet('192.0.0.0', 24, 'ipv4');
NON_PUBLIC_NETWORKS.addSubnet('192.0.2.0', 24, 'ipv4');
NON_PUBLIC_NETWORKS.addSubnet('192.88.99.0', 24, 'ipv4');
NON_PUBLIC_NETWORKS.addSubnet('192.168.0.0', 16, 'ipv4');
NON_PUBLIC_NETWORKS.addSubnet('198.18.0.0', 15, 'ipv4');
NON_PUBLIC_NETWORKS.addSubnet('198.51.100.0', 24, 'ipv4');
NON_PUBLIC_NETWORKS.addSubnet('203.0.113.0', 24, 'ipv4');
NON_PUBLIC_NETWORKS.addSubnet('224.0.0.0', 4, 'ipv4');
NON_PUBLIC_NETWORKS.addSubnet('240.0.0.0', 4, 'ipv4');
NON_PUBLIC_NETWORKS.addAddress('::', 'ipv6');
NON_PUBLIC_NETWORKS.addAddress('::1', 'ipv6');
NON_PUBLIC_NETWORKS.addSubnet('64:ff9b:1::', 48, 'ipv6');
NON_PUBLIC_NETWORKS.addSubnet('100::', 64, 'ipv6');
NON_PUBLIC_NETWORKS.addSubnet('2001::', 23, 'ipv6');
NON_PUBLIC_NETWORKS.addSubnet('fc00::', 7, 'ipv6');
NON_PUBLIC_NETWORKS.addSubnet('fe80::', 10, 'ipv6');
NON_PUBLIC_NETWORKS.addSubnet('ff00::', 8, 'ipv6');

function mappedIpv4Address(address: string): string | null {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  const mappedPrefix = /^(?:::ffff:|0:0:0:0:0:ffff:)/;
  if (!mappedPrefix.test(normalized)) {
    return null;
  }

  const suffix = normalized.replace(mappedPrefix, '');
  if (isIP(suffix) === 4) {
    return suffix;
  }

  const hexMatch = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(suffix);
  if (!hexMatch) {
    return null;
  }
  const high = Number.parseInt(hexMatch[1], 16);
  const low = Number.parseInt(hexMatch[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

export function isNonPublicIpAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  const mappedIpv4 = mappedIpv4Address(normalized);
  if (mappedIpv4) {
    return NON_PUBLIC_NETWORKS.check(mappedIpv4, 'ipv4');
  }

  const family = isIP(normalized);
  return (
    (family === 4 && NON_PUBLIC_NETWORKS.check(normalized, 'ipv4')) ||
    (family === 6 && NON_PUBLIC_NETWORKS.check(normalized, 'ipv6'))
  );
}
