import type { JSX } from 'react';
import { ScheduleIcon as AppCatalogScheduleIcon } from '../icons/AppIcons';

interface UsageResetIconProps {
  /** Icon size in pixels for both width and height. Defaults to 14. */
  size?: number;
  className?: string;
}

/**
 * Clock-with-motion-lines "time flies" glyph. Shared between the AI Credits
 * usage-limit banner and the account-snapshot cards' "reset time has passed"
 * overlay so the two surfaces stay visually consistent.
 */
export function UsageResetIcon({
  size = 14,
  className = 'shrink-0',
}: UsageResetIconProps): JSX.Element {
  return (
    <AppCatalogScheduleIcon
      aria-hidden="true"
      width={size}
      height={size}
      className={className}
    />
  );
}
