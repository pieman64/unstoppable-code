'use client';

import { createContext, useContext, type JSX, type ReactNode } from 'react';

/**
 * The one column every settings page and every loading, error and
 * placeholder frame sits in, on every host. Sharing it keeps a page's header
 * at the same left edge and width whichever page, organization tab or host
 * state is showing, so nothing moves while content loads or when the viewer
 * clicks between sibling pages.
 *
 * `min-h-full` stretches the column under a scroller with a definite height
 * (the web `portal-app-content`, which hosts the page root directly);
 * `flex-1` stretches it inside a flex column whose height is only a minimum
 * (the desktop hosted-settings wrappers inside the settings scroller). Either
 * way a placeholder body can fill the space under the header.
 *
 * Pages that hold reading text (account forms, digests, invoices) keep their
 * own narrower measure inside the column, left-aligned under the header.
 */
export const TEAM_PAGE_COLUMN_CLASS =
  'mx-auto flex w-full max-w-5xl min-h-full flex-1 flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8';

/** A column inside a column adds no second width, inset or test id. */
const NESTED_COLUMN_CLASS = 'flex min-w-0 flex-col gap-6';

const SettingsPageColumnContext = createContext(false);

export interface SettingsPageColumnProps {
  /** `main` for a page's own landmark; `div` (the default) otherwise. */
  readonly as?: 'main' | 'div';
  /** Placement only, for example `relative`. Width and insets stay fixed. */
  readonly className?: string;
  readonly children: ReactNode;
}

/**
 * Renders the shared settings column. A frame nested in another column (a
 * host state inside the account frame, a notice inside a page) renders only
 * its flex body, so the column is never inset twice.
 */
export function SettingsPageColumn({
  as: Tag = 'div',
  className,
  children,
}: SettingsPageColumnProps): JSX.Element {
  const nested = useContext(SettingsPageColumnContext);
  const base = nested ? NESTED_COLUMN_CLASS : TEAM_PAGE_COLUMN_CLASS;
  return (
    <Tag
      className={className ? `${base} ${className}` : base}
      data-testid={nested ? undefined : 'settings-page-column'}
    >
      <SettingsPageColumnContext.Provider value>
        {children}
      </SettingsPageColumnContext.Provider>
    </Tag>
  );
}
