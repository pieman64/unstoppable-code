import { isDeviceId } from '@canopy/protocol/device-relay';
import {
  copyBytes,
  decodeBase64Url,
  encodeBase64Url,
  type Bytes,
} from './bytes';
import { randomBytes, sha256, subtleCrypto } from './web-crypto';

/**
 * A device's long-term identity: an Ed25519 key pair. The device ID is the
 * base64url of the first 16 bytes of SHA-256 over the raw public key, so a
 * pinned pairing record is self-certifying (same rule as the desktop).
 *
 * Private keys are non-extractable unless a host explicitly asks otherwise,
 * so a browser can persist the `CryptoKey` in IndexedDB without ever exposing
 * its bytes.
 */
export interface DeviceIdentity {
  readonly deviceId: string;
  /** Raw 32-byte public key, base64url without padding. */
  readonly publicKey: string;
  readonly privateKey: CryptoKey;
}

export interface IdentityKeyOptions {
  /**
   * Whether the private key may be exported later (hosted services seal it
   * server-side). Defaults to false.
   */
  extractable?: boolean;
}

const ED25519 = { name: 'Ed25519' } as const;
const RAW_ED25519_PUBLIC_KEY_BYTES = 32;

export class DeviceIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceIdentityError';
  }
}

function rawPublicKeyBytes(publicKey: string): Bytes {
  let raw: Bytes;
  try {
    raw = decodeBase64Url(publicKey);
  } catch {
    throw new DeviceIdentityError('Device public key is not base64url.');
  }
  if (raw.byteLength !== RAW_ED25519_PUBLIC_KEY_BYTES) {
    throw new DeviceIdentityError(
      'Device public key must be a raw 32-byte Ed25519 key.',
    );
  }
  return raw;
}

export async function deriveDeviceId(publicKey: string): Promise<string> {
  const digest = await sha256([rawPublicKeyBytes(publicKey)]);
  return encodeBase64Url(digest.subarray(0, 16));
}

/** Whether a peer's advertised public key matches its device ID. */
export async function publicKeyMatchesDeviceId(
  publicKey: string,
  deviceId: string,
): Promise<boolean> {
  if (!isDeviceId(deviceId)) return false;
  try {
    return (await deriveDeviceId(publicKey)) === deviceId;
  } catch {
    return false;
  }
}

async function identityFromParts(
  privateKey: CryptoKey,
  publicKey: string,
): Promise<DeviceIdentity> {
  return {
    deviceId: await deriveDeviceId(publicKey),
    publicKey,
    privateKey,
  };
}

export async function generateDeviceIdentity(
  options: IdentityKeyOptions = {},
): Promise<DeviceIdentity> {
  const subtle = subtleCrypto();
  const pair = await subtle.generateKey(ED25519, options.extractable ?? false, [
    'sign',
    'verify',
  ]);
  if (!('privateKey' in pair)) {
    throw new DeviceIdentityError('Ed25519 key generation failed.');
  }
  const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  return identityFromParts(pair.privateKey, encodeBase64Url(raw));
}

function jwkString(jwk: JsonWebKey, field: 'x' | 'd'): string {
  const value = jwk[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new DeviceIdentityError(`Ed25519 JWK is missing "${field}".`);
  }
  return value;
}

/**
 * Imports an Ed25519 private key JWK (`kty: OKP`, `crv: Ed25519`, `x`, `d`).
 */
export async function importDeviceIdentityJwk(
  jwk: JsonWebKey,
  options: IdentityKeyOptions = {},
): Promise<DeviceIdentity> {
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') {
    throw new DeviceIdentityError('Device key must be an Ed25519 JWK.');
  }
  const x = jwkString(jwk, 'x');
  const d = jwkString(jwk, 'd');
  rawPublicKeyBytes(x);
  let privateKey: CryptoKey;
  try {
    privateKey = await subtleCrypto().importKey(
      'jwk',
      { kty: 'OKP', crv: 'Ed25519', x, d },
      ED25519,
      options.extractable ?? false,
      ['sign'],
    );
  } catch {
    // Some runtimes check `x` against `d` here; others only at the probe below.
    throw new DeviceIdentityError(
      'Device private key does not match its public key.',
    );
  }
  const identity = await identityFromParts(privateKey, x);
  await assertKeyPairMatches(identity);
  return identity;
}

/**
 * Imports a PKCS#8 Ed25519 private key, the format the desktop exports.
 * WebCrypto cannot derive a public key from a non-extractable private key, so
 * the key is imported extractable once to read its public half and then
 * re-imported with the requested extractability; the transient key is
 * dropped.
 */
export async function importDeviceIdentityPkcs8(
  pkcs8: Uint8Array,
  options: IdentityKeyOptions = {},
): Promise<DeviceIdentity> {
  const subtle = subtleCrypto();
  let transient: CryptoKey;
  try {
    transient = await subtle.importKey(
      'pkcs8',
      copyBytes(pkcs8),
      ED25519,
      true,
      ['sign'],
    );
  } catch {
    throw new DeviceIdentityError('Device key must be an Ed25519 private key.');
  }
  const jwk = await subtle.exportKey('jwk', transient);
  return importDeviceIdentityJwk(jwk, options);
}

/**
 * Rebuilds an identity from a stored private `CryptoKey` and its public key
 * (for example after reading both back from IndexedDB). Proves the pair
 * matches before returning.
 */
export async function restoreDeviceIdentity(
  privateKey: CryptoKey,
  publicKey: string,
): Promise<DeviceIdentity> {
  if (
    privateKey.type !== 'private' ||
    privateKey.algorithm.name !== 'Ed25519'
  ) {
    throw new DeviceIdentityError('Device key must be an Ed25519 private key.');
  }
  const identity = await identityFromParts(privateKey, publicKey);
  await assertKeyPairMatches(identity);
  return identity;
}

/** PKCS#8 bytes of an extractable identity, readable by the desktop import. */
export async function exportDeviceIdentityPkcs8(
  identity: DeviceIdentity,
): Promise<Bytes> {
  if (!identity.privateKey.extractable) {
    throw new DeviceIdentityError('This device key cannot be exported.');
  }
  return new Uint8Array(
    await subtleCrypto().exportKey('pkcs8', identity.privateKey),
  );
}

export async function signWithIdentity(
  identity: DeviceIdentity,
  message: Uint8Array,
): Promise<Bytes> {
  return new Uint8Array(
    await subtleCrypto().sign(ED25519, identity.privateKey, copyBytes(message)),
  );
}

/** Pure Ed25519 verification over a raw base64url public key. */
export async function verifyEd25519(
  publicKey: string,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const subtle = subtleCrypto();
  const key = await subtle.importKey(
    'raw',
    rawPublicKeyBytes(publicKey),
    ED25519,
    true,
    ['verify'],
  );
  try {
    return await subtle.verify(
      ED25519,
      key,
      copyBytes(signature),
      copyBytes(message),
    );
  } catch {
    return false;
  }
}

async function assertKeyPairMatches(identity: DeviceIdentity): Promise<void> {
  const challenge = randomBytes(32);
  const signature = await signWithIdentity(identity, challenge);
  if (!(await verifyEd25519(identity.publicKey, challenge, signature))) {
    throw new DeviceIdentityError(
      'Device private key does not match its public key.',
    );
  }
}
