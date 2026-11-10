import type { JSX } from 'react';
import type { ThinkingLevel } from '@canopy/protocol/thinking';
import { ThinkingIcon } from './AppIcons';

interface ThinkingLevelIconProps {
  value: ThinkingLevel | undefined;
}

/**
 * The effort glyph per level, in an escalating ramp of ink: green (`medium`)
 * -> blue (`high`) -> amber (`xhigh`) -> red (`max`) -> purple (`ultra`).
 * `ApprovalModePicker` reuses the first three stops so the two composer
 * controls read as one system. Whole elements rather than class names, so
 * each class string stays static for the design lint.
 */
const THINKING_LEVEL_ICONS: Readonly<Record<ThinkingLevel, JSX.Element>> = {
  off: <ThinkingIcon size="sm" className="shrink-0 fg-secondary" />,
  low: <ThinkingIcon size="sm" className="shrink-0 fg-secondary" active />,
  medium: <ThinkingIcon size="sm" className="shrink-0 fg-success" active />,
  high: <ThinkingIcon size="sm" className="shrink-0 fg-blue" active />,
  xhigh: <ThinkingIcon size="sm" className="shrink-0 fg-warning" active />,
  max: <ThinkingIcon size="sm" className="shrink-0 fg-destructive" active />,
  ultra: <ThinkingIcon size="sm" className="shrink-0 fg-purple" active />,
};

/** The model or provider default, with no level chosen. */
const DEFAULT_THINKING_ICON = (
  <ThinkingIcon size="sm" className="shrink-0 fg-secondary" />
);

/** The shared effort glyph in its current level's ink. */
export function ThinkingLevelIcon({
  value,
}: ThinkingLevelIconProps): JSX.Element {
  return value === undefined
    ? DEFAULT_THINKING_ICON
    : THINKING_LEVEL_ICONS[value];
}
