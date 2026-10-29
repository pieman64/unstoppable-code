import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import { isDeviceId } from '@canopy/protocol/device-relay';

/**
 * A device's long-term identity: an Ed25519 key pair. The device ID is
 * derived from the public key, so a pinned pairing record is self-certifying.
 */
export interface DeviceKeyPair {
  deviceId: string;
  /** Raw 32-byte public key, base64url without padding. */
  publicKey: string;
  privateKey: KeyObject;
}

const RAW_ED25519_PUBLIC_KEY_BYTES = 32;

export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

export function deriveDeviceId(publicKey: string): string {
  const raw = decodeBase64Url(publicKey);
  if (raw.byteLength !== RAW_ED25519_PUBLIC_KEY_BYTES) {
    throw new Error('Device public key must be a raw 32-byte Ed25519 key.');
  }
  const digest = createHash('sha256').update(raw).digest();
  return encodeBase64Url(digest.subarray(0, 16));
}

function rawPublicKey(key: KeyObject): string {
  const jwk = key.export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') {
    throw new Error('Ed25519 key is missing its public component.');
  }
  return jwk.x;
}

function keyPairFromPrivateKey(privateKey: KeyObject): DeviceKeyPair {
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Device key must be an Ed25519 private key.');
  }
  const publicKey = rawPublicKey(createPublicKey(privateKey));
  return { deviceId: deriveDeviceId(publicKey), publicKey, privateKey };
}

export function generateDeviceKeyPair(): DeviceKeyPair {
  const { privateKey } = generateKeyPairSync('ed25519');
  return keyPairFromPrivateKey(privateKey);
}

export function exportDeviceKeyPair(keyPair: DeviceKeyPair): Buffer {
  return keyPair.privateKey.export({ format: 'der', type: 'pkcs8' });
}

export function importDeviceKeyPair(pkcs8: Buffer): DeviceKeyPair {
  return keyPairFromPrivateKey(
    createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }),
  );
}

export function importEd25519PublicKey(publicKey: string): KeyObject {
  if (decodeBase64Url(publicKey).byteLength !== RAW_ED25519_PUBLIC_KEY_BYTES) {
    throw new Error('Peer public key must be a raw 32-byte Ed25519 key.');
  }
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: publicKey },
    format: 'jwk',
  });
}

/** Whether a peer's advertised public key matches its device ID. */
export function publicKeyMatchesDeviceId(
  publicKey: string,
  deviceId: string,
): boolean {
  if (!isDeviceId(deviceId)) return false;
  try {
    return deriveDeviceId(publicKey) === deviceId;
  } catch {
    return false;
  }
}
