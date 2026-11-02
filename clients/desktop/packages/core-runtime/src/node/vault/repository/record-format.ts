/*
 * Sealed vault record format, version 1 (CAN-4500 plan r4, Q5 option O2′),
 * accepted at the 2026-10-29 security checkpoint. The algorithms, the
 * authenticated field set and these domain labels fix the on-disk format.
 * Changing any of them needs a new `version`; keep every such choice here.
 * Accepted residual risks: deleting a record, or rolling one back to an older
 * revision whole, still verifies; on Windows and Linux, same-user processes
 * can read the key slot.
 */
export const VAULT_RECORD_FORMAT = Object.freeze({
  version: 1,
  cipher: 'aes-256-gcm',
  keyBytes: 32,
  nonceBytes: 12,
  tagBytes: 16,
  kdfHash: 'sha256',
  macHash: 'sha256',
  deleteReceiptHash: 'sha256',
  /** Domain separation: each label prefixes exactly one encoding or derivation. */
  domains: Object.freeze({
    dataKeyWrap: 'canopy.vault.data-key-wrap',
    sealSubkey: 'canopy.vault.subkey.seal',
    receiptSubkey: 'canopy.vault.subkey.receipt',
    sealedSecret: 'canopy.vault.sealed-secret',
    putReceipt: 'canopy.vault.put-receipt',
    deleteReceipt: 'canopy.vault.delete-receipt',
  }),
} as const);

/**
 * Vault IDs are minted short and lowercase so `vault-<vaultId>` fits the key
 * slot name pattern `^[a-z0-9][a-z0-9-]{0,63}$` (plan Q4c item 7). This also
 * keeps HKDF info under Node's 1024-byte limit.
 */
export const VAULT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,57}$/;
export const VAULT_KEY_SLOT_PREFIX = 'vault-';

/** Matches `VaultPutMaterial.material` in `src/vault/contracts.ts`. */
export const VAULT_SECRET_MAX_BYTES = 1_000_000;

/** One AES-256-GCM box: the data key in the header, or one sealed revision. */
export interface VaultSealedBox {
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly tag: Uint8Array;
}
