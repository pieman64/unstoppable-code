import { z } from 'zod';
import { CanopyErrorPayloadSchema } from '@canopy/protocol/canopy-core';

// Binding-level frames (ADR 2 channels, D3 nonce handshake). They share the
// framed stream with JSON-RPC envelopes and are told apart by `type` instead
// of `jsonrpc`; they are binding concerns, never catalog operations.

const IdentifierSchema = z.string().min(1).max(512);
const Base64UrlSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(1_024);

/** SHA-256 hex of the data-root identity; the raw path never crosses the wire. */
export const CanopyDataRootHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** Channel ids ride in the binary data-frame header, so they stay short ASCII. */
export const CanopyChannelIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const CanopyAuthChallengeFrameSchema = z.strictObject({
  type: z.literal('auth.challenge'),
  nonce: Base64UrlSchema,
  dataRootHash: CanopyDataRootHashSchema,
});

/** `proof` is base64url HMAC-SHA256 of the nonce keyed by the token-file secret. */
export const CanopyAuthResponseFrameSchema = z.strictObject({
  type: z.literal('auth.response'),
  proof: Base64UrlSchema,
  dataRootHash: CanopyDataRootHashSchema,
});

export const CanopyAuthOkFrameSchema = z.strictObject({
  type: z.literal('auth.ok'),
  connectionId: IdentifierSchema,
});

export const CanopyAuthFailedFrameSchema = z.strictObject({
  type: z.literal('auth.failed'),
  error: CanopyErrorPayloadSchema,
});

export const CanopyChannelCapsSchema = z.strictObject({
  maxChunkBytes: z.number().int().min(1).max(16_777_216),
  maxBufferedChunks: z.number().int().min(1).max(65_536),
});
export type CanopyChannelCaps = z.output<typeof CanopyChannelCapsSchema>;

export const CanopyChannelOpenFrameSchema = z.strictObject({
  type: z.literal('channel.open'),
  channelId: CanopyChannelIdSchema,
  kind: z.string().regex(/^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*$/),
  leaseId: IdentifierSchema,
  caps: CanopyChannelCapsSchema,
});

/** The accepter may only lower the requested caps. */
export const CanopyChannelOpenedFrameSchema = z.strictObject({
  type: z.literal('channel.opened'),
  channelId: CanopyChannelIdSchema,
  caps: CanopyChannelCapsSchema,
});

/** Ends a channel in both directions; a rejected `channel.open` carries an error. */
export const CanopyChannelCloseFrameSchema = z.strictObject({
  type: z.literal('channel.close'),
  channelId: CanopyChannelIdSchema,
  error: CanopyErrorPayloadSchema.nullable(),
});

/** Returns `chunks` of send credit as the receiver's reader consumes them. */
export const CanopyChannelCreditFrameSchema = z.strictObject({
  type: z.literal('channel.credit'),
  channelId: CanopyChannelIdSchema,
  chunks: z.number().int().min(1).max(65_536),
});

/** Best-effort last frame telling the peer why the connection is closing. */
export const CanopyConnectionCloseFrameSchema = z.strictObject({
  type: z.literal('connection.close'),
  error: CanopyErrorPayloadSchema.nullable(),
});

export const CanopyBindingFrameSchema = z.discriminatedUnion('type', [
  CanopyAuthChallengeFrameSchema,
  CanopyAuthResponseFrameSchema,
  CanopyAuthOkFrameSchema,
  CanopyAuthFailedFrameSchema,
  CanopyChannelOpenFrameSchema,
  CanopyChannelOpenedFrameSchema,
  CanopyChannelCloseFrameSchema,
  CanopyChannelCreditFrameSchema,
  CanopyConnectionCloseFrameSchema,
]);
export type CanopyBindingFrame = z.output<typeof CanopyBindingFrameSchema>;
