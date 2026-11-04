/**
 * A secret the desktop backend holds. Replies carry this in place of the
 * value, so the renderer and a remote-control window learn only that the
 * secret is set. `ref` is opaque, durable and derived from the slot that
 * holds the value, never from the value itself.
 *
 * Design: docs/planning/2026-11-02-can-4411-secret-replies/README.md
 */
export interface StoredSecretValue {
  kind: 'stored-secret';
  ref: string;
}

/**
 * A secret field in a save request: new plaintext (empty clears it), or the
 * stored-secret value a reply carried, meaning "keep the value it names".
 */
export type SecretValueInput = string | StoredSecretValue;

export const STORED_SECRET_ERROR_CODES = [
  'stored_secret_unknown',
  'stored_secret_reveal',
  'stored_secret_destination_changed',
] as const;
export type StoredSecretErrorCode = (typeof STORED_SECRET_ERROR_CODES)[number];

export function isStoredSecretValue(
  value: unknown,
): value is StoredSecretValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'stored-secret' &&
    'ref' in value &&
    typeof value.ref === 'string'
  );
}

export function isStoredSecretErrorCode(
  value: unknown,
): value is StoredSecretErrorCode {
  return STORED_SECRET_ERROR_CODES.some((code) => code === value);
}
