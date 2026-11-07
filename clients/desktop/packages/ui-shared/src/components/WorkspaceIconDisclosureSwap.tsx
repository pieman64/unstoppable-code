import type { JSX, ReactNode } from 'react';
import { ChevronDownMediumIcon } from '../icons/AppIcons';

export interface WorkspaceIconDisclosureSwapProps {
  /** True when the owning workspace section is collapsed. */
  collapsed: boolean;
  /** Resting workspace icon that the disclosure chevron replaces on hover. */
  children: ReactNode;
  /** Appended to the fixed test ids; see `WorkspaceSectionHeader.testIdSuffix`. */
  testIdSuffix?: string;
}

/**
 * Shared disclosure affordance for workspace and cowork sidebar rows: the
 * workspace icon renders at rest — no chevron in the default state, even while
 * the section is collapsed — and hovering or keyboard-focusing anywhere in the
 * row (`group/sidebar-item`) fades the icon out and the disclosure chevron in,
 * in the same slot, so the swap never reflows the row. The chevron pre-rotates
 * while collapsed so the revealed state reads as "expandable". It is
 * `pointer-events-none`: hosts keep the underlying icon button interactive
 * (drag handle and/or collapse toggle) beneath the swap.
 */
export function WorkspaceIconDisclosureSwap({
  collapsed,
  children,
  testIdSuffix = '',
}: WorkspaceIconDisclosureSwapProps): JSX.Element {
  return (
    <span
      data-testid={`workspace-icon-disclosure-swap${testIdSuffix}`}
      className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center"
    >
      <span
        aria-hidden="true"
        className="inline-flex items-center justify-center transition-opacity group-hover/sidebar-item:opacity-0 group-focus-within/sidebar-item:opacity-0"
      >
        {children}
      </span>
      {/* data-workspace-disclosure-chevron is the styling hook the desktop
          sidebar uses to exempt the rotation from its instant-interaction
          rule (which zeroes every descendant transition-duration), so the
          chevron turns smoothly when the section toggles while hovered. */}
      <ChevronDownMediumIcon
        size="sm"
        data-testid={`workspace-section-collapse-chevron${testIdSuffix}`}
        data-workspace-disclosure-chevron="true"
        className={`pointer-events-none absolute fg-secondary opacity-0 transition-[opacity,rotate] group-hover/sidebar-item:opacity-100 group-focus-within/sidebar-item:opacity-100 ${
          collapsed ? '-rotate-90' : 'rotate-0'
        }`}
      />
    </span>
  );
}
