import type { JSX, SVGProps } from 'react';
import { PauseIcon, PlayIcon } from '../icons/AppIcons';

export interface PauseResumeIconProps extends SVGProps<SVGSVGElement> {
  /** When true renders the play (resume) glyph; otherwise the pause glyph. */
  paused: boolean;
  /** Icon size in pixels. Defaults to 14. */
  size?: number;
}

/**
 * Pure pause/resume glyph that picks an app icon based on `paused`.
 * Used by the Hooks section and any future pausable activity card.
 */
export function PauseResumeIcon({
  paused,
  size = 16,
  ...rest
}: PauseResumeIconProps): JSX.Element {
  const Icon = paused ? PlayIcon : PauseIcon;
  return <Icon size={size} {...rest} />;
}
