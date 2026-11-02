import { hkdfSync, randomFillSync } from 'node:crypto';

import { isAesKey, openBox, sealBox } from './aes-gcm';
import { encodeCanonical } from './canonical-encoding';
import {
  vaultIntegrityFailure,
  type VaultIntegrityFailure,
} from './integrity-failure';
import {
  VAULT_ID_PATTERN,
  VAULT_RECORD_FORMAT,
  type VaultSealedBox,
} from './record-format';
import { zeroBytes } from './zero-bytes';

/*
 * The key slot holds a random 32-byte key-encryption key (KEK); the vault
 * header holds the data key wrapped under it. Seal and receipt subkeys come
 * from the data key by HKDF-SHA256, bound to the vault ID.
 */

const { keyBytes, kdfHash, version, domains } = VAULT_RECORD_FORMAT;

export type VaultSubkeyPurpose = 'seal' | 'receipt';

/** Opaque handle: it carries, logs and serializes no key byte. */
export interface VaultSubkeys {
  readonly vaultId: string;
}

export type VaultDataKeyUnwrap =
  /** A fresh key the caller owns and zeroes after deriving its subkeys. */
  | { readonly kind: 'unwrapped'; readonly dataKey: Uint8Array }
  | VaultIntegrityFailure;

const heldSubkeys = new WeakMap<
  VaultSubkeys,
  Record<VaultSubkeyPurpose, Uint8Array>
>();

export function isVaultId(value: unknown): value is string {
  return typeof value === 'string' && VAULT_ID_PATTERN.test(value);
}

function checkVaultId(vaultId: string): void {
  if (!isVaultId(vaultId)) throw new TypeError('Invalid vault ID.');
}

function wrapAad(vaultId: string): Uint8Array {
  return encodeCanonical(domains.dataKeyWrap, [
    ['uint', version],
    ['text', vaultId],
  ]);
}

/** A random 32-byte key: a slot KEK or a data key. */
export function generateVaultKey(): Uint8Array {
  return randomFillSync(new Uint8Array(keyBytes));
}

export function wrapDataKey(
  kek: Uint8Array,
  dataKey: Uint8Array,
  vaultId: string,
): VaultSealedBox {
  if (!isAesKey(kek) || !isAesKey(dataKey))
    throw new TypeError(`Vault keys must be ${keyBytes} bytes.`);
  checkVaultId(vaultId);
  return sealBox(kek, dataKey, wrapAad(vaultId));
}

/**
 * Slot material and header are untrusted: any failure is a
 * `VaultIntegrityFailure`, which the slot mapper reports as `key_missing`.
 */
export function unwrapDataKey(
  kek: Uint8Array,
  wrapped: VaultSealedBox,
  vaultId: string,
): VaultDataKeyUnwrap {
  if (!isVaultId(vaultId)) return vaultIntegrityFailure('vault_id');
  const opened = openBox(kek, wrapped, wrapAad(vaultId));
  if (opened.kind !== 'opened') return opened;
  if (opened.plaintext.byteLength !== keyBytes) {
    zeroBytes(opened.plaintext);
    return vaultIntegrityFailure('length');
  }
  return { kind: 'unwrapped', dataKey: opened.plaintext };
}

function deriveSubkey(
  dataKey: Uint8Array,
  vaultId: string,
  domain: string,
): Uint8Array {
  const info = encodeCanonical(domain, [
    ['uint', version],
    ['text', vaultId],
  ]);
  // A uniformly random data key needs no salt (RFC 5869 §3.1).
  return new Uint8Array(
    hkdfSync(kdfHash, dataKey, new Uint8Array(0), info, keyBytes),
  );
}

/** Does not retain `dataKey`; the caller still zeroes it. */
export function deriveVaultSubkeys(
  dataKey: Uint8Array,
  vaultId: string,
): VaultSubkeys {
  if (!isAesKey(dataKey))
    throw new TypeError(`Vault keys must be ${keyBytes} bytes.`);
  checkVaultId(vaultId);
  const handle: VaultSubkeys = Object.freeze({ vaultId });
  heldSubkeys.set(handle, {
    seal: deriveSubkey(dataKey, vaultId, domains.sealSubkey),
    receipt: deriveSubkey(dataKey, vaultId, domains.receiptSubkey),
  });
  return handle;
}

/** Lends a subkey for one synchronous use. Throws once the keys are disposed. */
export function withVaultSubkey<T>(
  keys: VaultSubkeys,
  purpose: VaultSubkeyPurpose,
  use: (key: Uint8Array) => T,
): T {
  const held = heldSubkeys.get(keys);
  if (!held) throw disposedError();
  return use(held[purpose]);
}

export function isVaultSubkeysHeld(keys: VaultSubkeys): boolean {
  return heldSubkeys.has(keys);
}

// Disposed keys throw rather than report `corrupt`: losing the key is a
// protection state (a lock drops it), never evidence against the record.
function disposedError(): Error {
  return new Error('Vault keys are disposed or unknown.');
}

/** For callers that validate input only after confirming the keys are held. */
export function assertVaultSubkeysHeld(keys: VaultSubkeys): void {
  if (!heldSubkeys.has(keys)) throw disposedError();
}

/** Zeroes both subkeys; every later use throws. Idempotent. */
export function disposeVaultSubkeys(keys: VaultSubkeys): void {
  const held = heldSubkeys.get(keys);
  if (!held) return;
  heldSubkeys.delete(keys);
  zeroBytes(held.seal, held.receipt);
}
