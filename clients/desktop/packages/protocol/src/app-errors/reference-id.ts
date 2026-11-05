const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export type ErrorRandomBytes = (length: number) => Uint8Array;

function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

function createReferenceId(
  prefix: 'ERR' | 'REP',
  random: ErrorRandomBytes,
): string {
  const bytes = random(8);
  if (!(bytes instanceof Uint8Array) || bytes.length !== 8) {
    throw new TypeError('Reference IDs require eight random bytes');
  }
  // 256 is divisible by 32, so masking introduces no alphabet bias.
  return `${prefix}-${Array.from(bytes, (byte) => ALPHABET.charAt(byte & 31)).join('')}`;
}

/** Requires Web Crypto unless cryptographic random bytes are injected. */
export function createErrorReferenceId(
  random: ErrorRandomBytes = randomBytes,
): string {
  return createReferenceId('ERR', random);
}

export function createReportReferenceId(
  random: ErrorRandomBytes = randomBytes,
): string {
  return createReferenceId('REP', random);
}

export function isReferenceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === 12 &&
    /^(ERR|REP)-[0-9A-HJKMNP-TV-Z]{8}$/.test(value)
  );
}
