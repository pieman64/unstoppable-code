import type { JSX } from 'react';
import { updateMenuLabel } from '../lib/customize-row-copy';
import { updateMarkerLabel } from '../lib/display-version';
import { Tooltip } from './Tooltip';

export { displayVersion, updateMarkerLabel } from '../lib/display-version';

/** The shared update action, retaining the optional-version API. */
export function updateActionLabel(latestVersion?: string): string {
  return updateMenuLabel(latestVersion);
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
