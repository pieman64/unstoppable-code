'use client';

import type { JSX } from 'react';
import type { PortalPrStatus } from '@canopy/protocol/portal';
import { PullRequestSectionBody } from '../PullRequestSectionBody';
import { portalPrStatusToSectionModel } from '../portal-pr-section-mapper';

/**
 * Portal Pull Requests card: renders the extracted desktop presentational
 * core ({@link PullRequestSectionBody}, CAN-1528) fed from the neutral
 * {@link PortalPrStatus} snapshot via the pure section mapper. The desktop
 * rail overrides this section with its own store-backed wrapper, so this
 * component is the portal-only mount point.
 */
export interface PullRequestSectionProps {
  readonly prStatus: PortalPrStatus | undefined;
}

export function PullRequestSection({
  prStatus,
}: PullRequestSectionProps): JSX.Element {
  const model = portalPrStatusToSectionModel(prStatus);
  const hasPr = model.repos?.some((repo) => repo.status !== null) ?? false;
  // The latest refresh failed: say so, never "No pull request".
  const refreshError = prStatus?.refreshError;

  if (!hasPr && !model.isCreating && model.creationProgress === undefined) {
    return refreshError === undefined ? (
      <p className="text-xs fg-secondary" data-testid="activity-pr-empty">
        No pull request.
      </p>
    ) : (
      <p className="text-xs fg-warning" data-testid="activity-pr-error">
        {refreshError}
      </p>
    );
  }

  return (
    <div data-testid="activity-pr">
      {/* The error concerns the whole card (every row is from the last
          read), so it stands above them rather than replacing one chip:
          a recorded DESIGN.md deviation (REG-3025 design notes). */}
      {refreshError !== undefined && (
        <p className="mb-2 text-xs fg-warning" data-testid="activity-pr-error">
          {refreshError} Showing the last status read.
        </p>
      )}
      <PullRequestSectionBody
        repos={model.repos}
        isCreating={model.isCreating}
        creationProgress={model.creationProgress}
      />
    </div>
  );
}
