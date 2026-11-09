import { concatBytes, copyBytes, type Bytes } from './bytes';

/**
 * Session envelope carried inside a relay data frame:
 * `[type u8][sessionId 16 bytes][body]`, identical to the desktop.
 *
 * Handshake bodies are JSON. Data bodies are secure-channel frames whose
 * associated data is the envelope header, binding each ciphertext to its
 * session.
 */
export const ENVELOPE_TYPES = {
  hello1: 0x10,
  hello2: 0x11,
  hello3: 0x12,
  hello4: 0x13,
  data: 0x20,
  /** Unauthenticated refusal during the handshake; never ends a live session. */
  abort: 0x30,
} as const;

export type EnvelopeType = keyof typeof ENVELOPE_TYPES;

export const SESSION_ID_BYTES = 16;
/** Envelope header: type byte and session ID. */
export const ENVELOPE_HEADER_BYTES = 1 + SESSION_ID_BYTES;

export interface Envelope {
  type: EnvelopeType;
  sessionId: Bytes;
  body: Bytes;
}

const TYPES_BY_BYTE: ReadonlyMap<number, EnvelopeType> = new Map([
  [ENVELOPE_TYPES.hello1, 'hello1'],
  [ENVELOPE_TYPES.hello2, 'hello2'],
  [ENVELOPE_TYPES.hello3, 'hello3'],
  [ENVELOPE_TYPES.hello4, 'hello4'],
  [ENVELOPE_TYPES.data, 'data'],
  [ENVELOPE_TYPES.abort, 'abort'],
]);

export function envelopeHeader(
  type: EnvelopeType,
  sessionId: Uint8Array,
): Bytes {
  if (sessionId.byteLength !== SESSION_ID_BYTES) {
    throw new Error('Session IDs are 16 bytes.');
  }
  return concatBytes([Uint8Array.of(ENVELOPE_TYPES[type]), sessionId]);
}

export function encodeEnvelope(
  type: EnvelopeType,
  sessionId: Uint8Array,
  body: Uint8Array,
): Bytes {
  return concatBytes([envelopeHeader(type, sessionId), body]);
}

export function decodeEnvelope(bytes: Uint8Array): Envelope | null {
  if (bytes.byteLength < ENVELOPE_HEADER_BYTES) return null;
  const type = TYPES_BY_BYTE.get(bytes[0] ?? -1);
  if (type === undefined) return null;
  const copy = copyBytes(bytes);
  return {
    type,
    sessionId: copy.subarray(1, ENVELOPE_HEADER_BYTES),
    body: copy.subarray(ENVELOPE_HEADER_BYTES),
  };
}
