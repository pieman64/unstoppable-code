import {
  COMPRESSION_THRESHOLD_BYTES,
  MAX_FRAGMENT_BYTES,
  MAX_MESSAGE_BYTES,
} from '@canopy/protocol/remote-control';
import { concatBytes, copyBytes, type Bytes } from './bytes';
import {
  deserializeV8,
  serializeV8,
  V8SerializationError,
} from './v8-serializer';

/**
 * Encodes session messages for the encrypted channel, wire-identical to the
 * desktop's `message-codec.ts`: V8 serialization, raw deflate for messages of
 * at least 8 KiB when it is smaller, and fragments of at most 65,470 bytes
 * that, sealed and framed, fill one relay frame.
 *
 * Fragment: `[flags u8][bytes]`. Bit 0 marks the final fragment; bit 1 marks
 * a deflated message (set on every fragment of that message). Every fragment
 * but the last is full. Compression uses `CompressionStream('deflate-raw')`,
 * so compressed bytes differ from Node's level-1 output but inflate alike.
 */
export const FRAGMENT_FLAG_FINAL = 0x01;
export const FRAGMENT_FLAG_COMPRESSED = 0x02;
const KNOWN_FLAGS = FRAGMENT_FLAG_FINAL | FRAGMENT_FLAG_COMPRESSED;

export type MessageCodecErrorCode =
  | 'too_large'
  | 'unsupported_value'
  | 'malformed_fragment'
  | 'malformed_message'
  | 'decompression_failed';

export class MessageCodecError extends Error {
  constructor(
    readonly code: MessageCodecErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MessageCodecError';
  }
}

export interface MessageCodecOptions {
  /** Largest serialized (uncompressed) message; both sides check the same. */
  maxMessageBytes?: number;
}

/**
 * Serializes synchronously, so the value is captured when the caller sends
 * it; compression and fragmentation happen later in `fragmentMessage`.
 */
export function serializeMessage(
  value: unknown,
  options: MessageCodecOptions = {},
): Bytes {
  try {
    return serializeV8(value, {
      maxBytes: options.maxMessageBytes ?? MAX_MESSAGE_BYTES,
    });
  } catch (error) {
    if (error instanceof V8SerializationError && error.code === 'too_large') {
      throw new MessageCodecError('too_large', 'Message is too large to send.');
    }
    throw new MessageCodecError(
      'unsupported_value',
      error instanceof Error
        ? error.message
        : 'Message could not be serialized.',
    );
  }
}

async function readAll(
  readable: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Bytes | null> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return concatBytes(chunks);
}

/** Raw deflate, or null when it would not be smaller than the input. */
async function deflateRaw(input: Bytes): Promise<Bytes | null> {
  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const writing = writer
    .write(input)
    .then(() => writer.close())
    .catch(() => undefined);
  const output = await readAll(stream.readable, input.byteLength - 1);
  await writing;
  return output;
}

/**
 * Inflates raw deflate, stopping as soon as the output passes `limit`, so a
 * compression bomb never allocates more than the limit.
 */
export async function inflateRawBounded(
  input: Bytes,
  limit: number,
): Promise<Bytes> {
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const writing = writer
    .write(input)
    .then(() => writer.close())
    .catch(() => undefined);
  let output: Bytes | null;
  try {
    output = await readAll(stream.readable, limit);
  } catch {
    await writing;
    throw new MessageCodecError(
      'decompression_failed',
      'Incoming message could not be decoded.',
    );
  }
  await writing;
  if (output === null) {
    throw new MessageCodecError('too_large', 'Incoming message is too large.');
  }
  return output;
}

/** Compresses (when worthwhile) and splits one serialized message. */
export async function fragmentMessage(serialized: Bytes): Promise<Bytes[]> {
  let payload = serialized;
  let compressed = false;
  if (serialized.byteLength >= COMPRESSION_THRESHOLD_BYTES) {
    const deflated = await deflateRaw(serialized);
    if (deflated !== null && deflated.byteLength < serialized.byteLength) {
      payload = deflated;
      compressed = true;
    }
  }
  const fragments: Bytes[] = [];
  let offset = 0;
  do {
    const end = Math.min(offset + MAX_FRAGMENT_BYTES, payload.byteLength);
    const flags =
      (end === payload.byteLength ? FRAGMENT_FLAG_FINAL : 0) |
      (compressed ? FRAGMENT_FLAG_COMPRESSED : 0);
    fragments.push(
      concatBytes([Uint8Array.of(flags), payload.subarray(offset, end)]),
    );
    offset = end;
  } while (offset < payload.byteLength);
  return fragments;
}

/** `serializeMessage` then `fragmentMessage`. */
export async function encodeMessage(
  value: unknown,
  options: MessageCodecOptions = {},
): Promise<Bytes[]> {
  return fragmentMessage(serializeMessage(value, options));
}

/**
 * Reassembles fragments from one ordered session into whole messages. Calls
 * must not overlap (a session feeds it from one serialized chain). Size is
 * enforced as fragments accumulate and again while inflating.
 */
export class MessageAssembler {
  private parts: Uint8Array[] = [];
  private size = 0;
  private compressed: boolean | null = null;
  private busy = false;
  private readonly maxMessageBytes: number;

  constructor(options: MessageCodecOptions = {}) {
    this.maxMessageBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
  }

  /** Returns the decoded message once its final fragment arrives. */
  async push(
    fragment: Uint8Array,
  ): Promise<{ complete: true; value: unknown } | null> {
    if (this.busy) {
      throw new MessageCodecError(
        'malformed_fragment',
        'Message fragments must be pushed in order.',
      );
    }
    if (fragment.byteLength < 1) {
      throw new MessageCodecError(
        'malformed_fragment',
        'Empty message fragment.',
      );
    }
    const flags = fragment[0] ?? 0;
    if ((flags & ~KNOWN_FLAGS) !== 0) {
      throw new MessageCodecError(
        'malformed_fragment',
        'Unknown fragment flags.',
      );
    }
    const compressed = (flags & FRAGMENT_FLAG_COMPRESSED) !== 0;
    if (this.compressed !== null && this.compressed !== compressed) {
      throw new MessageCodecError(
        'malformed_fragment',
        'Message fragments disagree on compression.',
      );
    }
    const body = fragment.subarray(1);
    const final = (flags & FRAGMENT_FLAG_FINAL) !== 0;
    // Senders split only at full fragments, so every fragment but the last
    // is full: this bounds how many one message can arrive in.
    if (!final && body.byteLength !== MAX_FRAGMENT_BYTES) {
      throw new MessageCodecError(
        'malformed_fragment',
        'Message fragment is not full.',
      );
    }
    if (body.byteLength > MAX_FRAGMENT_BYTES) {
      throw new MessageCodecError(
        'malformed_fragment',
        'Message fragment is too large.',
      );
    }
    this.size += body.byteLength;
    if (this.size > this.maxMessageBytes) {
      throw new MessageCodecError(
        'too_large',
        'Incoming message is too large.',
      );
    }
    this.parts.push(copyBytes(body));
    this.compressed = compressed;
    if (!final) return null;
    const joined = concatBytes(this.parts);
    this.parts = [];
    this.size = 0;
    this.compressed = null;
    this.busy = true;
    try {
      const serialized = compressed
        ? await inflateRawBounded(joined, this.maxMessageBytes)
        : joined;
      let value: unknown;
      try {
        value = deserializeV8(serialized);
      } catch {
        throw new MessageCodecError(
          'malformed_message',
          'Incoming message could not be decoded.',
        );
      }
      return { complete: true, value };
    } finally {
      this.busy = false;
    }
  }
}
