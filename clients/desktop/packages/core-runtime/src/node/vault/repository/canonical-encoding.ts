/*
 * Injective field encoding for authenticated data, receipts and key
 * derivation. A fixed field order per domain label, length-prefixed strings
 * and a presence byte for nullable fields keep distinct inputs distinct.
 */

const UINT32_MAX = 0xffff_ffff;

const encoder = new TextEncoder();
// `ignoreBOM`: by default a leading U+FEFF is dropped, so decoding would not
// invert encoding.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// TextEncoder maps every lone surrogate to U+FFFD, so two different strings
// would share bytes; refuse them instead.
function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit < 0xd800 || unit > 0xdfff) continue;
    const next = value.charCodeAt(i + 1);
    if (unit > 0xdbff || !(next >= 0xdc00 && next <= 0xdfff)) return true;
    i += 1;
  }
  return false;
}

export function isWellFormedText(value: unknown): value is string {
  return typeof value === 'string' && !hasLoneSurrogate(value);
}

/**
 * `length` is the prefix for bytes the caller feeds straight to a digest
 * after the encoding, so a secret is never copied into it.
 */
export type CanonicalField =
  | readonly ['text', string]
  | readonly ['nullableText', string | null]
  | readonly ['uint', number]
  | readonly ['nullableUint', number | null]
  | readonly ['length', number];

function uint32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX)
    throw new TypeError('Canonical length out of range.');
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function textChunks(value: string): Uint8Array[] {
  if (!isWellFormedText(value))
    throw new TypeError('Canonical text must be well-formed.');
  const bytes = encoder.encode(value);
  return [uint32(bytes.byteLength), bytes];
}

function uint64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError('Canonical integers must be non-negative and safe.');
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
}

function presence(value: unknown): Uint8Array {
  return Uint8Array.of(value === null ? 0 : 1);
}

function fieldChunks(field: CanonicalField): Uint8Array[] {
  switch (field[0]) {
    case 'text':
      return textChunks(field[1]);
    case 'nullableText':
      return field[1] === null
        ? [presence(null)]
        : [presence(field[1]), ...textChunks(field[1])];
    case 'uint':
      return [uint64(field[1])];
    case 'nullableUint':
      return field[1] === null
        ? [presence(null)]
        : [presence(field[1]), uint64(field[1])];
    case 'length':
      return [uint32(field[1])];
    default: {
      const unreachable: never = field;
      throw new TypeError(`Unknown canonical field ${String(unreachable)}.`);
    }
  }
}

/** The domain label first, then each field in order. Invalid values are a TypeError. */
export function encodeCanonical(
  domain: string,
  fields: readonly CanonicalField[],
): Uint8Array {
  const chunks = [...textChunks(domain), ...fields.flatMap(fieldChunks)];
  const out = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Every read returns null on malformed input; `end` checks nothing is left over. */
export class CanonicalReader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  text(): string | null {
    if (this.offset + 4 > this.bytes.byteLength) return null;
    const length = this.view.getUint32(this.offset);
    const start = this.offset + 4;
    if (start + length > this.bytes.byteLength) return null;
    this.offset = start + length;
    try {
      return decoder.decode(this.bytes.subarray(start, start + length));
    } catch {
      return null;
    }
  }

  nullableText(): string | null | undefined {
    const present = this.presence();
    if (present === null) return undefined;
    if (!present) return null;
    return this.text() ?? undefined;
  }

  uint(): number | null {
    if (this.offset + 8 > this.bytes.byteLength) return null;
    const value = this.view.getBigUint64(this.offset);
    this.offset += 8;
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  }

  end(): boolean {
    return this.offset === this.bytes.byteLength;
  }

  private presence(): boolean | null {
    if (this.offset >= this.bytes.byteLength) return null;
    const flag = this.bytes[this.offset];
    this.offset += 1;
    if (flag === 0) return false;
    return flag === 1 ? true : null;
  }
}
