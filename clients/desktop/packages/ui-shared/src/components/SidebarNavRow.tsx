'use client';

import {
  forwardRef,
  type ButtonHTMLAttributes,
  type JSX,
  type ReactNode,
} from 'react';
import { OPERATIONAL_STATUS_COLORS } from '../lib/operational-status-colors';
import {
  SIDEBAR_ITEM_IDLE_CLASSNAME,
  SIDEBAR_ITEM_SELECTED_CLASSNAME,
  SIDEBAR_LIST_ICON_CLASSNAME,
  SIDEBAR_NAV_ITEM_CLASSNAME,
} from './sidebar-item-classes';

/** A run state the row reports on its leading glyph. */
export type SidebarNavRowStatus = 'active' | 'unread' | 'success' | 'failed';

export interface SidebarNavRowProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children'
> {
  readonly icon: ReactNode;
  readonly children: ReactNode;
  readonly selected?: boolean;
  /** Back and other quiet navigation controls use secondary ink. */
  readonly tone?: 'default' | 'secondary';
  /**
   * Inks the leading glyph with the status color instead of `fg-secondary`.
   * The row background is reserved for selection.
   */
  readonly status?: SidebarNavRowStatus;
  readonly iconClassName?: string;
  /** Raise labeled rows to 44px for touch layouts. */
  readonly touchTarget?: 'coarse' | 'always' | 'none';
}

/** Canonical navigation row shared by the main and settings sidebars. */
export const SidebarNavRow = forwardRef<HTMLButtonElement, SidebarNavRowProps>(
  function SidebarNavRow(
    {
      icon,
      children,
      selected = false,
      tone = 'default',
      status,
      iconClassName = '',
      touchTarget = 'coarse',
      className = '',
      type = 'button',
      ...buttonProps
    },
    ref,
  ): JSX.Element {
    const stateClassName =
      tone === 'secondary'
        ? 'fg-secondary hover:bg-subtle'
        : selected
          ? SIDEBAR_ITEM_SELECTED_CLASSNAME
          : SIDEBAR_ITEM_IDLE_CLASSNAME;
    const iconInkClassName =
      status === undefined
        ? 'fg-secondary'
        : OPERATIONAL_STATUS_COLORS[status].foreground;

    const touchClassName =
      touchTarget === 'always'
        ? 'min-h-11'
        : touchTarget === 'coarse'
          ? 'pointer-coarse:min-h-11'
          : '';
    return (
      <button
        {...buttonProps}
        ref={ref}
        type={type}
        data-sidebar-nav-row=""
        className={`${SIDEBAR_NAV_ITEM_CLASSNAME} ${touchClassName} ${stateClassName}${className ? ` ${className}` : ''}`}
      >
        <span
          className={`${SIDEBAR_LIST_ICON_CLASSNAME} ${iconInkClassName}${iconClassName ? ` ${iconClassName}` : ''}`}
        >
          {icon}
        </span>
        {children}
      </button>
    );
  },
);

SidebarNavRow.displayName = 'SidebarNavRow';
