import type { DigestListItem } from './digest-list';

/**
 * The newer and older rows around one digest in an archive ordered newest
 * first. Pure, so server loaders can derive neighbor ids without importing
 * any rendering code.
 */
export function digestNeighbors<T extends Pick<DigestListItem, 'externalId'>>(
  digests: readonly T[],
  externalId: string,
): { newer: T | null; older: T | null } {
  const index = digests.findIndex((digest) => digest.externalId === externalId);
  if (index === -1) return { newer: null, older: null };
  return {
    newer: index > 0 ? (digests[index - 1] ?? null) : null,
    older: digests[index + 1] ?? null,
  };
}
