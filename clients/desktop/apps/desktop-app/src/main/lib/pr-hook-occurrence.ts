import type { PersistedPrSnapshotFileV1 } from '@canopy/desktop-shared/types/github';

const OCCURRENCE = /^github:(.+)#(\d+):/;

/** One PR state advance is one occurrence of each trigger it fired. */
export function prHookOccurrenceKey(
  snapshot: PersistedPrSnapshotFileV1,
  triggerName: string,
): string {
  return `github:${snapshot.repository.fullName}#${snapshot.pr.number}:${triggerName}:${snapshot.capturedAt}`;
}

/** The pull request an automatic hook occurrence fired for, or null. */
export function prHookOccurrencePullRequest(
  occurrenceKey: string,
): { repository: string; number: number } | null {
  const match = OCCURRENCE.exec(occurrenceKey);
  return match ? { repository: match[1], number: Number(match[2]) } : null;
}
