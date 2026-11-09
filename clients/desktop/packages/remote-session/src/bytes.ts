/**
 * Byte helpers that run unchanged in browsers, workers and Node. Every byte
 * array handed to WebCrypto is a `Uint8Array<ArrayBuffer>`, never a view over
 * a SharedArrayBuffer.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const DECODE_TABLE: ReadonlyArray<number> = (() => {
  const table = new Array<number>(128).fill(-1);
  for (let index = 0; index < ALPHABET.length; index += 1) {
    table[ALPHABET.charCodeAt(index)] = index;
  }
  return table;
})();

/** Unpadded base64url, as Node's `Buffer#toString('base64url')` writes it. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let output = '';
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const value =
      ((bytes[index] ?? 0) << 16) |
      ((bytes[index + 1] ?? 0) << 8) |
      (bytes[index + 2] ?? 0);
    output +=
      ALPHABET.charAt((value >>> 18) & 63) +
      ALPHABET.charAt((value >>> 12) & 63) +
      ALPHABET.charAt((value >>> 6) & 63) +
      ALPHABET.charAt(value & 63);
  }
  const remaining = bytes.length - index;
  if (remaining === 1) {
    const value = (bytes[index] ?? 0) << 16;
    output +=
      ALPHABET.charAt((value >>> 18) & 63) +
      ALPHABET.charAt((value >>> 12) & 63);
  } else if (remaining === 2) {
    const value = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8);
    output +=
      ALPHABET.charAt((value >>> 18) & 63) +
      ALPHABET.charAt((value >>> 12) & 63) +
      ALPHABET.charAt((value >>> 6) & 63);
  }
  return output;
}

export class Base64UrlError extends Error {
  constructor() {
    super('Value is not base64url.');
    this.name = 'Base64UrlError';
  }
}

/**
 * Decodes unpadded base64url the way Node's `Buffer.from(value, 'base64url')`
 * does for alphabet-only input: whole bytes only, leftover bits ignored, so
 * transcript bytes match the desktop exactly. Any other character throws.
 */
export function decodeBase64Url(value: string): Bytes {
  const output = new Uint8Array(Math.floor((value.length * 6) / 8));
  let accumulator = 0;
  let bits = 0;
  let offset = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const digit = code < 128 ? (DECODE_TABLE[code] ?? -1) : -1;
    if (digit < 0) throw new Base64UrlError();
    accumulator = ((accumulator << 6) | digit) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[offset] = (accumulator >>> bits) & 0xff;
      offset += 1;
    }
  }
  return output;
}

export function concatBytes(parts: ReadonlyArray<Uint8Array>): Bytes {
  let length = 0;
  for (const part of parts) length += part.byteLength;
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

/** A copy whose buffer is a plain ArrayBuffer of exactly its length. */
export function copyBytes(bytes: Uint8Array): Bytes {
  const output = new Uint8Array(bytes.byteLength);
  output.set(bytes);
  return output;
}

export function utf8(value: string): Bytes {
  return copyBytes(new TextEncoder().encode(value));
}

/** Constant-time comparison for equal-length secrets; length is not secret. */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export function uint32BE(value: number): Bytes {
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value, false);
  return output;
}

export function readUint32BE(bytes: Uint8Array, offset: number): number {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset, false);
}

export function uint64BE(value: bigint): Bytes {
  const output = new Uint8Array(8);
  new DataView(output.buffer).setBigUint64(0, value, false);
  return output;
}

export function readUint64BE(bytes: Uint8Array, offset: number): bigint {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getBigUint64(offset, false);
}

export function hexOf(bytes: Uint8Array): string {
  let output = '';
  for (const byte of bytes) output += byte.toString(16).padStart(2, '0');
  return output;
}
