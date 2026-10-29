import type { HTMLAttributes, JSX, ReactNode } from 'react';

/**
 * Space kept below the content. `default` (32px) ends a scrolling page body;
 * `tight` (16px) and `compact` (24px) close a fixed header block (heading,
 * tabs, filters) that a scrolling body follows; `spacious` (64px) ends a long
 * catalog so its last card clears the bottom edge.
 */
export type PageContentBottomInset =
  | 'tight'
  | 'compact'
  | 'default'
  | 'spacious';

const BOTTOM_INSET_CLASS_NAMES: Record<PageContentBottomInset, string> = {
  tight: 'pb-4',
  compact: 'pb-6',
  default: 'pb-8',
  spacious: 'pb-16',
};

export interface PageContentProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  bottomInset?: PageContentBottomInset;
  /** Stack children as page sections, 24px apart. */
  stack?: boolean;
}

/** Shared centered maximum width and gutter for top-level pages. */
export function PageContent({
  children,
  className,
  bottomInset = 'default',
  stack = false,
  ...props
}: PageContentProps): JSX.Element {
  return (
    <div
      {...props}
      className={`mx-auto w-full max-w-6xl px-8 ${BOTTOM_INSET_CLASS_NAMES[bottomInset]}${stack ? ' space-y-6' : ''} ${className ?? ''}`}
    >
      {children}
    </div>
  );
}
