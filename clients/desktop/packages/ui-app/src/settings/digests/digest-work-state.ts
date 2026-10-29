import type { DigestListItem } from './digest-list';

/**
 * Whether any row is still queued or generating, which is when the archive
 * keeps refreshing itself.
 */
export function isDigestWorkInFlight(
  digests: readonly Pick<DigestListItem, 'status'>[],
): boolean {
  return digests.some(
    (digest) => digest.status === 'PENDING' || digest.status === 'GENERATING',
  );
}
