// URL normalizes IPv4 spellings and IPv6 compression before this pure policy
// runs. Mirrors desktop/network-address without importing Node's BlockList.
export function isIpLiteral(host: string): boolean {
  return host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host);
}
function nonPublicV4(parts: number[]): boolean {
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 &&
      ((b === 0 && (c === 0 || c === 2)) ||
        (b === 88 && c === 99) ||
        b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}
export function isNonPublicIpAddress(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(normalized))
    return nonPublicV4(normalized.split('.').map(Number));
  if (!normalized.includes(':')) return false;
  const embedded =
    /^(?:::ffff:|(?:0:){5}ffff:|::|(?:0:){6})(\d+\.\d+\.\d+\.\d+|[\da-f]{1,4}:[\da-f]{1,4})$/i.exec(
      normalized,
    )?.[1];
  if (embedded) {
    if (embedded.includes('.'))
      return nonPublicV4(embedded.split('.').map(Number));
    const [high, low] = embedded
      .split(':')
      .map((word) => Number.parseInt(word, 16));
    return nonPublicV4([high >> 8, high & 255, low >> 8, low & 255]);
  }
  const halves = normalized.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const words = [
    ...left,
    ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'),
    ...right,
  ].map((word) => Number.parseInt(word, 16));
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff)
    return nonPublicV4([
      words[6] >> 8,
      words[6] & 255,
      words[7] >> 8,
      words[7] & 255,
    ]);
  return (
    words.every((word) => word === 0) ||
    (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) ||
    (words[0] === 0x64 && words[1] === 0xff9b && words[2] === 1) ||
    (words[0] === 0x100 && words.slice(1, 4).every((word) => word === 0)) ||
    (words[0] === 0x2001 && words[1] < 0x200) ||
    (words[0] & 0xfe00) === 0xfc00 ||
    (words[0] & 0xffc0) === 0xfe80 ||
    (words[0] & 0xff00) === 0xff00
  );
}
