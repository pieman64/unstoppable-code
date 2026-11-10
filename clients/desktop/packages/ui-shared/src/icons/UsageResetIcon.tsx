import type { JSX } from 'react';
import {
  ScheduleIcon as AppCatalogScheduleIcon,
  type IconSize,
} from './AppIcons';

interface UsageResetIconProps {
  /** A step of the icon scale. Defaults to `sm`. */
  size?: IconSize;
  className?: string;
}

/**
 * Clock-with-motion-lines "time flies" glyph. Shared between the AI Credits
 * usage-limit banner and the account-snapshot cards' "reset time has passed"
 * overlay so the two surfaces stay visually consistent.
 */
export function UsageResetIcon({
  size = 'sm',
  className = 'shrink-0',
}: UsageResetIconProps): JSX.Element {
  return (
    <AppCatalogScheduleIcon
      aria-hidden="true"
      size={size}
      className={className}
    />
  );
}
