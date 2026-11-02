/*
 * Every stored key, header or revision that fails to check out produces this
 * one value. Callers handle every step the same way: an entry is `corrupt`,
 * a key slot is `key_missing`. `step` is internal context for diagnostics,
 * never a reason to behave differently or something to show users.
 */

export type VaultIntegrityStep =
  /** The platform reported the key slot itself as corrupt. */
  | 'slot'
  /** The slot material is not a 32-byte key. */
  | 'key'
  /** The vault ID is invalid or names another vault. */
  | 'vault_id'
  /** Stored fields are outside their wire bounds. */
  | 'fields'
  /** The stored box is malformed. */
  | 'box'
  /** The sealed or opened bytes have the wrong length. */
  | 'length'
  /** The authentication tag does not verify. */
  | 'tag';

export interface VaultIntegrityFailure {
  readonly kind: 'corrupt';
  readonly step: VaultIntegrityStep;
}

export function vaultIntegrityFailure(
  step: VaultIntegrityStep,
): VaultIntegrityFailure {
  return Object.freeze({ kind: 'corrupt', step });
}
