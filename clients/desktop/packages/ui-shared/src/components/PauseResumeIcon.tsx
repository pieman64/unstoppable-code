import type { JSX } from 'react';
import {
  PauseIcon,
  PlayIcon,
  type AppIconProps,
  type IconSize,
} from '../icons/AppIcons';

export interface PauseResumeIconProps extends AppIconProps {
  /** When true renders the play (resume) glyph; otherwise the pause glyph. */
  paused: boolean;
  /** A step of the icon scale. Defaults to `sm`. */
  size?: IconSize;
}

/**
 * Pure pause/resume glyph that picks an app icon based on `paused`.
 * Used by the Hooks section and any future pausable activity card.
 */
export function PauseResumeIcon({
  paused,
  size = 'sm',
  ...rest
}: PauseResumeIconProps): JSX.Element {
  const Icon = paused ? PlayIcon : PauseIcon;
  return <Icon size={size} {...rest} />;
}
