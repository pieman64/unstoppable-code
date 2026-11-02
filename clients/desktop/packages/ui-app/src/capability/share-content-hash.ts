const SHA256_HEX = /^[0-9a-f]{64}$/i;

/**
 * A shared skill's SKILL.md hash in comparable form: lowercase SHA-256 hex.
 * The hash is of the raw source, so case is not significant. Missing, empty
 * or malformed hashes are no evidence and come back undefined, so two of
 * them never compare equal.
 */
export function normalizeShareContentHash(
  hash: string | undefined,
): string | undefined {
  return hash && SHA256_HEX.test(hash) ? hash.toLowerCase() : undefined;
}
