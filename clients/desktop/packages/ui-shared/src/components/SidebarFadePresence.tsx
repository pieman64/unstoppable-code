'use client';

import { type HTMLAttributes, type JSX, type ReactNode } from 'react';

export interface SidebarFadePresenceProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'children'
> {
  readonly open: boolean;
  readonly children: ReactNode;
}

/** Immediate disclosure boundary for frequently used sidebar navigation. */
export function SidebarFadePresence({
  open,
  children,
  className,
  ...attributes
}: SidebarFadePresenceProps): JSX.Element | null {
  if (!open) return null;

  return (
    <div
      {...attributes}
      className={`sidebar-fade-presence${className ? ` ${className}` : ''}`}
      data-state="open"
    >
      <div className="sidebar-fade-presence-inner">{children}</div>
    </div>
  );
}
