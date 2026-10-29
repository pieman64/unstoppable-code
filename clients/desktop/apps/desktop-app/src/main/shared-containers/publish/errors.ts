import type { SharedContainerPublicationErrorReason } from '@canopy/desktop-shared/types';

export class SharedContainerPublishRefusalError extends Error {
  constructor(
    public readonly reason: SharedContainerPublicationErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'SharedContainerPublishRefusalError';
  }
}

export class SharedContainerArtifactBudgetError extends SharedContainerPublishRefusalError {
  constructor(
    public readonly used: number,
    public readonly limit: number,
  ) {
    super(
      'artifact-budget',
      `This worktree needs ${used} shared artifacts, above the ${limit}-artifact limit. Commit or narrow the approved file scope and try again.`,
    );
    this.name = 'SharedContainerArtifactBudgetError';
  }
}

export function getSharedContainerPublishErrorReason(
  error: unknown,
): SharedContainerPublicationErrorReason | undefined {
  return error instanceof SharedContainerPublishRefusalError
    ? error.reason
    : undefined;
}
