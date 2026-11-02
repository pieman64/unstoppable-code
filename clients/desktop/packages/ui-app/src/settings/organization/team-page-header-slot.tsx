'use client';

import { createContext, useContext, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * The organization page header's actions cell, for a section whose page
 * actions read its own state (the Timeline's Live toggle, the Projects
 * Refresh from GitHub). `null` until the header has mounted; `undefined`
 * outside the organization page, where a section draws its actions itself.
 */
export const TeamPageHeaderSlotContext = createContext<
  HTMLElement | null | undefined
>(undefined);

/**
 * Renders a section's page actions in the page header's actions, before the
 * page's own. Nothing renders until the header's slot exists; outside the
 * organization page the actions render in place.
 */
export function TeamPageHeaderActions({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element | null {
  const slot = useContext(TeamPageHeaderSlotContext);
  if (slot === undefined) {
    return (
      <div className="flex items-center justify-end gap-2">{children}</div>
    );
  }
  return slot === null ? null : createPortal(children, slot);
}
