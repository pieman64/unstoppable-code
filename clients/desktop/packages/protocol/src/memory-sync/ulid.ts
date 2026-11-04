const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_BYTES = 10;

export const MEMORY_ULID_MAX_TIME_MS = 281_474_976_710_655;

export const MEMORY_ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function isMemoryUlid(value: unknown): value is string {
  return typeof value === 'string' && MEMORY_ULID_PATTERN.test(value);
}

function encodeTime(timeMs: number): string {
  if (
    !Number.isInteger(timeMs) ||
    timeMs < 0 ||
    timeMs > MEMORY_ULID_MAX_TIME_MS
  ) {
    throw new RangeError(`ULID time out of range: ${timeMs}`);
  }
  let remaining = timeMs;
  let encoded = '';
  for (let index = 0; index < TIME_CHARS; index += 1) {
    encoded = CROCKFORD_ALPHABET.charAt(remaining % 32) + encoded;
    remaining = Math.floor(remaining / 32);
  }
  return encoded;
}

function encodeRandom(bytes: Uint8Array): string {
  if (bytes.length !== RANDOM_BYTES) {
    throw new RangeError(`ULID randomness must be ${RANDOM_BYTES} bytes`);
  }
  let encoded = '';
  let buffer = 0;
  let bits = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    buffer = (buffer << 8) | (bytes[index] ?? 0);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += CROCKFORD_ALPHABET.charAt((buffer >> bits) & 31);
    }
    buffer &= (1 << bits) - 1;
  }
  return encoded;
}

export function encodeMemoryUlid(
  timeMs: number,
  randomness: Uint8Array,
): string {
  return encodeTime(timeMs) + encodeRandom(randomness);
}

export function memoryUlidTime(value: string): number | null {
  if (!isMemoryUlid(value)) return null;
  let timeMs = 0;
  for (const char of value.slice(0, TIME_CHARS)) {
    timeMs = timeMs * 32 + CROCKFORD_ALPHABET.indexOf(char);
  }
  return timeMs;
}

function incrementRandomness(bytes: Uint8Array): boolean {
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    const current = bytes[index] ?? 0;
    if (current < 255) {
      bytes[index] = current + 1;
      return true;
    }
    bytes[index] = 0;
  }
  return false;
}

function webCryptoRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export interface MemoryUlidFactoryOptions {
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
}

/**
 * Within one millisecond, and when the clock steps back, the factory keeps the
 * last timestamp and increments the random part, so each ID sorts after the
 * previous one even when the wall clock does not move forward.
 */
export function createMemoryUlidFactory(
  options: MemoryUlidFactoryOptions = {},
): () => string {
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? webCryptoRandomBytes;
  let lastTime = -1;
  let lastRandom = new Uint8Array(RANDOM_BYTES);
  return (): string => {
    const time = now();
    if (time > lastTime) {
      lastTime = time;
      lastRandom = Uint8Array.from(randomBytes(RANDOM_BYTES));
    } else if (!incrementRandomness(lastRandom)) {
      throw new RangeError('ULID randomness overflowed within one millisecond');
    }
    return encodeMemoryUlid(lastTime, lastRandom);
  };
}
