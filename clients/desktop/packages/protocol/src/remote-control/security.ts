import { z } from 'zod';

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Decode only canonical, unpadded base64url; unused trailing bits must be zero. */
export function decodeCanonicalBase64url(
  value: string,
  byteLength: number,
): Uint8Array<ArrayBuffer> | null {
  if (
    value.length !== Math.ceil((byteLength * 8) / 6) ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    return null;
  const bytes = new Uint8Array(byteLength);
  let accumulator = 0;
  let bits = 0;
  let offset = 0;
  for (const character of value) {
    accumulator = (accumulator << 6) | ALPHABET.indexOf(character);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset++] = (accumulator >>> bits) & 255;
    }
  }
  return offset === byteLength && (accumulator & ((1 << bits) - 1)) === 0
    ? bytes
    : null;
}

export function canonicalBase64urlSchema(bytes: number): z.ZodString {
  return z
    .string()
    .refine(
      (value) => decodeCanonicalBase64url(value, bytes) !== null,
      'Invalid canonical base64url value.',
    );
}

export const CanonicalMacSchema = canonicalBase64urlSchema(32);
export const PAIR_PROOF_LABEL = 'canopy-pair-proof-v1';
export const HOSTED_DELEGATION_LABEL = 'canopy-hosted-delegation-v1';
export const HOSTED_DELEGATION_MAX_MS = 10 * 60_000;
export const HostedDelegationSchema = z.object({
  rootPublicKey: canonicalBase64urlSchema(32),
  sessionPublicKey: canonicalBase64urlSchema(32),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  signature: canonicalBase64urlSchema(64),
});
export type HostedDelegation = z.infer<typeof HostedDelegationSchema>;

/** UTF-8 label || u32be key length || decoded key || u64be expiry. */
export function hostedDelegationSigningBytes(
  sessionPublicKey: string,
  expiresAt: number,
): Uint8Array<ArrayBuffer> {
  const key = decodeCanonicalBase64url(sessionPublicKey, 32);
  if (!key || !Number.isSafeInteger(expiresAt) || expiresAt <= 0)
    throw new Error('Invalid hosted delegation.');
  const label = new TextEncoder().encode(HOSTED_DELEGATION_LABEL);
  const bytes = new Uint8Array(label.length + 4 + key.length + 8);
  bytes.set(label);
  const view = new DataView(bytes.buffer);
  view.setUint32(label.length, key.length, false);
  bytes.set(key, label.length + 4);
  view.setBigUint64(bytes.length - 8, BigInt(expiresAt), false);
  return bytes;
}
