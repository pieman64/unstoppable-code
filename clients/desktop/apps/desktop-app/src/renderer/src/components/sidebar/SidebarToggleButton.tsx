import type { JSX } from 'react';
import { TitlebarIconButton } from '@canopy/ui-shared';
import { SidebarHiddenLeftWideIcon } from '@canopy/ui-shared/icons/AppIcons';

export interface SidebarToggleButtonProps {
  /** Whether the unified sidebar is currently hidden. */
  hidden: boolean;
  onToggle: () => void;
}

/**
 * Expand/collapse control for the unified sidebar. Lives in the window
 * titlebar layer so it stays visible even when the sidebar itself is
 * hidden. Placement (macOS traffic-light offset vs. Windows far-left) is
 * the caller's concern.
 *
 * Deliberately has NO visual tooltip: hovering this control reveals the
 * sidebar itself (CAN-2415), which both answers the question a tooltip would
 * and leaves a portalled label floating over the panel it just opened. The
 * `aria-label` still carries the state for assistive technology.
 */
export function SidebarToggleButton({
  hidden,
  onToggle,
}: SidebarToggleButtonProps): JSX.Element {
  const label = hidden ? 'Show sidebar' : 'Hide sidebar';

  return (
    <TitlebarIconButton
      onClick={onToggle}
      icon={SidebarHiddenLeftWideIcon}
      foreground="titlebar"
      aria-label={label}
      // Empty string is the documented opt-out on TitlebarIconButton.
      tooltipLabel=""
      data-testid="sidebar-toggle"
    />
  );
}
