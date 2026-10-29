import type { JSX } from 'react';
import { Tooltip } from './Tooltip';

/** Normalizes a version for display, never inventing one that is absent. */
export function displayVersion(version: string | undefined): string | null {
  const trimmed = version?.trim().replace(/^v/i, '') ?? '';
  return trimmed === '' ? null : `v${trimmed}`;
}

export function updateMarkerLabel(latestVersion?: string): string {
  const latest = displayVersion(latestVersion);
  return latest ? `Update available: ${latest}` : 'Update available';
}

export interface UpdateMarkerProps {
  readonly latestVersion?: string;
  readonly dataTestId?: string;
}

/** The small accent dot beside an installed version when an update exists. */
export function UpdateMarker({
  latestVersion,
  dataTestId,
}: UpdateMarkerProps): JSX.Element {
  const label = updateMarkerLabel(latestVersion);
  return (
    <Tooltip label={label}>
      <span
        role="img"
        aria-label={label}
        data-testid={dataTestId}
        tabIndex={0}
        className="focus-ring inline-flex h-4 w-4 items-center justify-center rounded-full"
      >
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" />
      </span>
    </Tooltip>
  );
}
