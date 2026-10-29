import type {
  CodeReviewArtifact,
  CodeReviewFile,
} from '@canopy/desktop-shared/types';

/** Marks cached artifacts stale when the worktree diff fingerprint advances. */
export function reviewForFingerprint(
  review: CodeReviewFile | null,
  fingerprint: string | undefined,
): CodeReviewFile | null {
  if (!review || !fingerprint) return review;
  const stale = <T>(
    artifact: CodeReviewArtifact<T> | undefined,
  ): CodeReviewArtifact<T> | undefined =>
    artifact &&
    artifact.status !== 'generating' &&
    artifact.derivedFromFingerprint !== fingerprint
      ? { ...artifact, status: 'stale' }
      : artifact;
  return {
    ...review,
    annotations: stale(review.annotations),
    diagrams: {
      logicDiff: stale(review.diagrams.logicDiff),
      dataModelDiff: stale(review.diagrams.dataModelDiff),
    },
  };
}
