/**
 * Left-nav entry point for an overview page: a workspace's "Archived and
 * deleted" overview, and the recipient's "Past shares". Pure and
 * callback-driven so code, cowork, and App Advisor surfaces share one visual
 * implementation.
 */
import type { JSX } from 'react';
import { ArrowUpRight } from '../icons/AppIcons';
import {
  SIDEBAR_ROW_GRID_CLASSNAME,
  SIDEBAR_ROW_LEADING_SLOT_CLASSNAME,
  SIDEBAR_ROW_TRAILING_CELL_CLASSNAME,
} from './sidebar-item-classes';

export interface SidebarOverviewNavLinkProps {
  /** The page the link opens, as it reads in the sidebar. */
  label: string;
  /** Items on the page; the link is absent at zero. */
  count: number;
  /** Highlight while this workspace's overview or a viewer on it is open. */
  selected: boolean;
  onOpen: () => void;
  testId: string;
  /**
   * `compact` (default) is the 28px link. `row` takes the sidebar rows' 32px
   * height and `rounded-row` corner, so it lines up with every other item in
   * the desktop sidebar under early access.
   */
  size?: 'compact' | 'row';
}

/**
 * Sits between the label and the count. A flex container renders no box for
 * whitespace between its items, so this changes nothing on screen; it keeps
 * the link's text and accessible name reading "Archived and deleted 3" rather
 * than "Archived and deleted3".
 */
const LABEL_COUNT_SEPARATOR = ' ';

export function SidebarOverviewNavLink({
  label,
  count,
  selected,
  onOpen,
  testId,
  size = 'compact',
}: SidebarOverviewNavLinkProps): JSX.Element | null {
  if (count <= 0) {
    return null;
  }
  return (
    // `row` keeps the rows' own 1px rhythm above it; the compact link keeps
    // its 4px.
    <div
      className={size === 'row' ? 'mt-px' : 'mt-1'}
      data-testid={`${testId}-section`}
    >
      <button
        type="button"
        data-testid={testId}
        data-selected={selected ? 'true' : 'false'}
        aria-current={selected ? 'page' : undefined}
        onClick={onOpen}
        // The task rows' grid: the same left inset, leading icon column, and
        // gap as the rows above, so the glyph sits under their icons and the
        // label under their titles. Both sizes take the rows' right inset, so
        // the count sits under their ages and the count beside the project
        // name.
        className={`focus-ring flex pr-1.5 ${size === 'row' ? 'h-8 rounded-row' : 'h-7 rounded-md'} w-full items-center ${SIDEBAR_ROW_GRID_CLASSNAME} text-left text-xs transition-colors ${
          selected
            ? 'bg-fg-primary/[0.08] fg-primary'
            : 'fg-secondary hover:bg-fg-primary/[0.04] hover:fg-primary'
        }`}
      >
        <span className={SIDEBAR_ROW_LEADING_SLOT_CLASSNAME} aria-hidden="true">
          <ArrowUpRight size={12} />
        </span>
        <span className="min-w-0 truncate" data-testid={`${testId}-label`}>
          {label}
        </span>
        {LABEL_COUNT_SEPARATOR}
        {/* The rows' age cell, so the count shares one right edge, ink and
            type with the ages above it. */}
        <span
          className={SIDEBAR_ROW_TRAILING_CELL_CLASSNAME}
          data-testid={`${testId}-count`}
        >
          {count}
        </span>
      </button>
    </div>
  );
}

export interface ArchivedContainersNavLinkProps extends Omit<
  SidebarOverviewNavLinkProps,
  'label' | 'count'
> {
  /** Retained items (containers plus legacy archived chats) in the workspace. */
  count: number;
}

export function ArchivedContainersNavLink(
  props: ArchivedContainersNavLinkProps,
): JSX.Element | null {
  return <SidebarOverviewNavLink label="Archived and deleted" {...props} />;
}
