import type { HTMLAttributes, JSX, ReactNode } from 'react';

export interface NoticeListProps extends Omit<
  HTMLAttributes<HTMLElement>,
  'className' | 'children'
> {
  children: ReactNode;
}

export interface NoticeListItemProps extends Omit<
  HTMLAttributes<HTMLElement>,
  'className' | 'children'
> {
  children: ReactNode;
}

/**
 * A bulleted list inside a `Notice` message. The message slot is an inline
 * span, so the list is built from spans carrying list roles rather than a
 * `<ul>`, which the HTML content model would not allow there.
 */
export function NoticeList({
  children,
  ...rest
}: NoticeListProps): JSX.Element {
  return (
    <span role="list" className="mt-2 block space-y-0.5" {...rest}>
      {children}
    </span>
  );
}

/**
 * One item: a bullet, then text that hangs past it (`pl-4 -indent-4`) when it
 * wraps. The bullet is typography, not an icon, and is hidden from assistive
 * technology because the list roles already convey the structure.
 */
export function NoticeListItem({
  children,
  ...rest
}: NoticeListItemProps): JSX.Element {
  return (
    <span role="listitem" className="block pl-4 -indent-4" {...rest}>
      <span aria-hidden="true" className="mr-1.5">
        •
      </span>
      {children}
    </span>
  );
}
