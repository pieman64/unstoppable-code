import { Buffer } from 'node:buffer';

import { CanopyTransportError } from './errors';
import { CanopyChannelIdSchema } from './frames';

export { CanopyTransportError };

/**
 * 8 MiB: the catalog's largest bounded payload (a 4 MiB
 * `worker.artifact.download` chunk) base64-encoded plus its envelope.
 */
export const CANOPY_DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * 512 MiB: about V8's longest string, so any JSON message one process can
 * encode at all fits once a peer reassembles message parts.
 */
export const CANOPY_MAX_MESSAGE_BYTES = 512 * 1024 * 1024;

const HEADER_BYTES = 4;
const JSON_OBJECT_TAG = 0x7b; // '{'
const JSON_ARRAY_TAG = 0x5b; // '['
const CHANNEL_DATA_TAG = 0x00;
const MESSAGE_PART_TAG = 0x01;
const MESSAGE_PART_FINAL = 0x01;
/** Tag and flags ahead of a message part's bytes. */
const MESSAGE_PART_OVERHEAD_BYTES = 2;

function frameError(
  kind: 'invalid_argument' | 'resource_exhausted',
  message: string,
): CanopyTransportError {
  return new CanopyTransportError({ kind, message, retry: { kind: 'never' } });
}

export type CanopyDecodedFrame =
  /** A JSON object, or an array the connection rejects as a batch. */
  | {
      readonly type: 'json';
      readonly value: object;
      /** Encoded body size, for byte-based buffering limits. */
      readonly byteLength: number;
    }
  | {
      readonly type: 'channel.data';
      readonly channelId: string;
      readonly bytes: Uint8Array;
    };

function withLengthPrefix(body: Buffer, maxFrameBytes: number): Buffer {
  if (body.length > maxFrameBytes)
    throw frameError(
      'resource_exhausted',
      `Frame of ${body.length} bytes exceeds the ${maxFrameBytes}-byte cap.`,
    );
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * True only for values `JSON.stringify` encodes without loss or throwing.
 * Reads property descriptors, so no getter runs during validation.
 */
function isJsonSafe(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (!isArray && prototype !== Object.prototype && prototype !== null)
    return false;
  // JSON.stringify drops symbol keys, and an array's non-index keys.
  if (Object.getOwnPropertySymbols(value).length) return false;
  const names = Object.getOwnPropertyNames(value);
  // Dense indices plus `length`; JSON.stringify sends a hole as null.
  if (isArray && names.length !== value.length + 1) return false;
  const keys = isArray
    ? Array.from({ length: value.length }, (_, index) => String(index))
    : names;
  ancestors.add(value);
  const safe = keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || descriptor.get || descriptor.set)
      return false;
    // Object properties set to `undefined` are dropped, as the JSON shape intends.
    return (
      (!isArray && descriptor.value === undefined) ||
      isJsonSafe(descriptor.value, ancestors)
    );
  });
  ancestors.delete(value);
  return safe;
}

/** Proxy traps can throw during inspection or serialization. */
function stringifyJsonSafe(value: object): string {
  try {
    if (isJsonSafe(value, new Set())) return JSON.stringify(value);
  } catch {
    // Reported below as not JSON-safe.
  }
  throw frameError('invalid_argument', 'Frame is not JSON-safe.');
}

/** `u32` big-endian body length, then the UTF-8 JSON object. */
export function encodeCanopyJsonFrame(
  value: object,
  maxFrameBytes = CANOPY_DEFAULT_MAX_FRAME_BYTES,
): Buffer {
  if (Array.isArray(value))
    throw frameError('invalid_argument', 'Frames carry one JSON object.');
  return withLengthPrefix(
    Buffer.from(stringifyJsonSafe(value), 'utf8'),
    maxFrameBytes,
  );
}

/**
 * One JSON object as a single frame when it fits, else as consecutive message
 * parts (`u32` length, `0x01`, flags, UTF-8 bytes; the last part's flags are
 * `0x01`) of at most `maxMessageBytes` in all. Returned as one buffer so a
 * single write keeps the parts together.
 */
export function encodeCanopyJsonMessage(
  value: object,
  maxFrameBytes = CANOPY_DEFAULT_MAX_FRAME_BYTES,
  maxMessageBytes = maxFrameBytes,
): Buffer {
  if (Array.isArray(value))
    throw frameError('invalid_argument', 'Frames carry one JSON object.');
  const body = Buffer.from(stringifyJsonSafe(value), 'utf8');
  if (body.length <= maxFrameBytes)
    return withLengthPrefix(body, maxFrameBytes);
  if (body.length > maxMessageBytes)
    throw frameError(
      'resource_exhausted',
      `Message of ${body.length} bytes exceeds the ${Math.max(maxFrameBytes, maxMessageBytes)}-byte cap.`,
    );
  const partBytes = maxFrameBytes - MESSAGE_PART_OVERHEAD_BYTES;
  if (partBytes < 1)
    throw frameError('invalid_argument', 'Frames are too small for parts.');
  const frames: Buffer[] = [];
  for (let offset = 0; offset < body.length; offset += partBytes) {
    const end = Math.min(offset + partBytes, body.length);
    const header = Buffer.allocUnsafe(HEADER_BYTES + 2);
    header.writeUInt32BE(end - offset + MESSAGE_PART_OVERHEAD_BYTES, 0);
    header[HEADER_BYTES] = MESSAGE_PART_TAG;
    header[HEADER_BYTES + 1] = end === body.length ? MESSAGE_PART_FINAL : 0;
    frames.push(header, body.subarray(offset, end));
  }
  return Buffer.concat(frames);
}

/** `u32` length, `0x00`, `u8` channel-id length, ASCII channel id, raw bytes. */
export function encodeCanopyChannelDataFrame(
  channelId: string,
  bytes: Uint8Array,
  maxFrameBytes = CANOPY_DEFAULT_MAX_FRAME_BYTES,
): Buffer {
  if (!CanopyChannelIdSchema.safeParse(channelId).success)
    throw frameError('invalid_argument', 'Invalid channel id.');
  const id = Buffer.from(channelId, 'ascii');
  return withLengthPrefix(
    Buffer.concat([Buffer.from([CHANNEL_DATA_TAG, id.length]), id, bytes]),
    maxFrameBytes,
  );
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function decodeJson(body: Buffer): CanopyDecodedFrame {
  if (body[0] !== JSON_OBJECT_TAG && body[0] !== JSON_ARRAY_TAG)
    throw frameError('invalid_argument', 'Unknown frame type.');
  let value: unknown;
  try {
    value = JSON.parse(utf8.decode(body));
  } catch {
    throw frameError('invalid_argument', 'Frame is not valid UTF-8 JSON.');
  }
  if (typeof value !== 'object' || value === null)
    throw frameError('invalid_argument', 'Frames carry one JSON object.');
  return { type: 'json', value, byteLength: body.length };
}

function decodeBody(body: Buffer): CanopyDecodedFrame {
  if (body[0] === CHANNEL_DATA_TAG) {
    const idEnd = 2 + (body[1] ?? 0);
    if (body.length < 2 || body[1] === 0 || body.length < idEnd)
      throw frameError('invalid_argument', 'Malformed channel data frame.');
    const channelId = body.toString('latin1', 2, idEnd);
    if (!CanopyChannelIdSchema.safeParse(channelId).success)
      throw frameError('invalid_argument', 'Malformed channel id.');
    return {
      type: 'channel.data',
      channelId,
      bytes: new Uint8Array(body.subarray(idEnd)),
    };
  }
  return decodeJson(body);
}

/**
 * Reassembles frames across arbitrary chunk boundaries, and a message's parts
 * into its one JSON frame. Any error is fatal to the connection: the stream
 * position can no longer be trusted.
 */
export class CanopyFrameDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private bodyLength: number | null = null;
  private parts: Buffer[] = [];
  private partBytes = 0;

  constructor(
    private readonly maxFrameBytes = CANOPY_DEFAULT_MAX_FRAME_BYTES,
    /** Parts of one message may total this much; one frame unless raised. */
    private maxMessageBytes = maxFrameBytes,
  ) {}

  /** Raises or lowers the message cap for parts not yet joined. */
  setMaxMessageBytes(bytes: number): void {
    this.maxMessageBytes = bytes;
  }

  /** Appends and decodes every complete frame. */
  push(chunk: Uint8Array): CanopyDecodedFrame[] {
    this.append(chunk);
    const frames: CanopyDecodedFrame[] = [];
    for (let frame = this.nextFrame(); frame; frame = this.nextFrame())
      frames.push(frame);
    return frames;
  }

  /** Buffers bytes without decoding, so a paused reader holds raw bytes only. */
  append(chunk: Uint8Array): void {
    this.chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length));
    this.buffered += chunk.length;
  }

  /** Decodes the next complete frame, or returns null until more bytes arrive. */
  nextFrame(): CanopyDecodedFrame | null {
    for (let body = this.nextBody(); body; body = this.nextBody()) {
      if (body[0] !== MESSAGE_PART_TAG) {
        if (this.parts.length)
          throw frameError('invalid_argument', 'Message parts interleaved.');
        return decodeBody(body);
      }
      if (body.length <= MESSAGE_PART_OVERHEAD_BYTES)
        throw frameError('invalid_argument', 'Empty message part.');
      this.partBytes += body.length - MESSAGE_PART_OVERHEAD_BYTES;
      if (this.partBytes > this.maxMessageBytes)
        throw frameError(
          'resource_exhausted',
          `Message exceeds the ${this.maxMessageBytes}-byte cap.`,
        );
      this.parts.push(Buffer.from(body.subarray(MESSAGE_PART_OVERHEAD_BYTES)));
      if (body[1] === MESSAGE_PART_FINAL) {
        const message = Buffer.concat(this.parts, this.partBytes);
        this.parts = [];
        this.partBytes = 0;
        return decodeJson(message);
      }
    }
    return null;
  }

  private nextBody(): Buffer | null {
    if (this.bodyLength === null) {
      if (this.buffered < HEADER_BYTES) return null;
      const length = this.flatten().readUInt32BE(0);
      // Checked before buffering the body so an oversized peer cannot force
      // the allocation.
      if (length > this.maxFrameBytes)
        throw frameError(
          'resource_exhausted',
          `Frame of ${length} bytes exceeds the ${this.maxFrameBytes}-byte cap.`,
        );
      if (length === 0) throw frameError('invalid_argument', 'Empty frame.');
      this.bodyLength = length;
    }
    const frameEnd = HEADER_BYTES + this.bodyLength;
    if (this.buffered < frameEnd) return null;
    const all = this.flatten();
    const rest = all.subarray(frameEnd);
    this.chunks = rest.length ? [rest] : [];
    this.buffered = rest.length;
    this.bodyLength = null;
    return all.subarray(HEADER_BYTES, frameEnd);
  }

  private flatten(): Buffer {
    if (this.chunks.length !== 1)
      this.chunks = [Buffer.concat(this.chunks, this.buffered)];
    return this.chunks[0];
  }
}
