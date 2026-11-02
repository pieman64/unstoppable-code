import { openBox, readSealedBox, sealBox } from './aes-gcm';
import {
  encodeVaultAuthenticatedData,
  readVaultSealedFields,
  type VaultSealedFields,
} from './authenticated-data';
import {
  vaultIntegrityFailure,
  type VaultIntegrityFailure,
} from './integrity-failure';
import { VAULT_SECRET_MAX_BYTES, type VaultSealedBox } from './record-format';
import {
  assertVaultSubkeysHeld,
  withVaultSubkey,
  type VaultSubkeys,
} from './vault-keys';
import { zeroBytes } from './zero-bytes';

export type VaultOpenResult =
  /** A fresh copy the caller owns and zeroes after use. */
  | { readonly kind: 'opened'; readonly material: Uint8Array }
  /** Never `absent`: a stored revision that fails its tag is `corrupt`. */
  | VaultIntegrityFailure;

export type VaultVerifyResult =
  | { readonly kind: 'verified' }
  | VaultIntegrityFailure;

function isSecretLength(byteLength: number): boolean {
  return byteLength >= 1 && byteLength <= VAULT_SECRET_MAX_BYTES;
}

/** Seals one revision under a fresh nonce. Invalid input is a TypeError. */
export function sealVaultSecret(
  keys: VaultSubkeys,
  fields: VaultSealedFields,
  material: Uint8Array,
): VaultSealedBox {
  assertVaultSubkeysHeld(keys);
  const snapshot = readVaultSealedFields(fields);
  if (snapshot === null) throw new TypeError('Invalid sealed vault fields.');
  if (snapshot.vaultId !== keys.vaultId)
    throw new TypeError('Sealed fields belong to another vault.');
  if (!(material instanceof Uint8Array) || !isSecretLength(material.byteLength))
    throw new TypeError(
      `Vault secrets must be 1-${VAULT_SECRET_MAX_BYTES} bytes.`,
    );
  const aad = encodeVaultAuthenticatedData(snapshot);
  return withVaultSubkey(keys, 'seal', (key) => sealBox(key, material, aad));
}

/** Stored fields and box are untrusted: anything that does not verify is `corrupt`. */
export function openVaultSecret(
  keys: VaultSubkeys,
  fields: VaultSealedFields,
  sealed: VaultSealedBox,
): VaultOpenResult {
  assertVaultSubkeysHeld(keys);
  const snapshot = readVaultSealedFields(fields);
  if (snapshot === null) return vaultIntegrityFailure('fields');
  if (snapshot.vaultId !== keys.vaultId)
    return vaultIntegrityFailure('vault_id');
  const box = readSealedBox(sealed);
  if (box === null) return vaultIntegrityFailure('box');
  if (!isSecretLength(box.ciphertext.byteLength))
    return vaultIntegrityFailure('length');
  const aad = encodeVaultAuthenticatedData(snapshot);
  const opened = withVaultSubkey(keys, 'seal', (key) => openBox(key, box, aad));
  return opened.kind === 'opened'
    ? { kind: 'opened', material: opened.plaintext }
    : opened;
}

/** Checks the tag without returning the secret, for the verify-once cache. */
export function verifyVaultSecret(
  keys: VaultSubkeys,
  fields: VaultSealedFields,
  sealed: VaultSealedBox,
): VaultVerifyResult {
  const result = openVaultSecret(keys, fields, sealed);
  if (result.kind !== 'opened') return result;
  zeroBytes(result.material);
  return { kind: 'verified' };
}
