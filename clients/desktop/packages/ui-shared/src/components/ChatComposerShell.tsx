'use client';

import type { HTMLAttributes, JSX } from 'react';

/**
 * The composer box: the raised tertiary surface, 16px radius, and soft shadow
 * the desktop composer has always drawn. Web used to draw its own bordered
 * 12px box with a focus ring; both hosts now wrap their composer in this one
 * shell so the box reads identically (desktop is the visual source of truth).
 *
 * A surface that already sits on tertiary (the floating App Advisor window)
 * raises it further through `--bg-composer`.
 */
export const CHAT_COMPOSER_SHELL_CLASS =
  'relative rounded-2xl bg-[var(--bg-composer,var(--bg-tertiary))] shadow-lg transition';

/**
 * The same box while a file drag hovers it: an accent wash plus a ring, on
 * the same radius, so the drop target reads as the composer itself.
 */
export const CHAT_COMPOSER_SHELL_DRAG_CLASS =
  'relative rounded-2xl bg-accent-subtle shadow-lg ring-2 ring-line-accent transition';

export interface ChatComposerShellProps extends HTMLAttributes<HTMLDivElement> {
  /** A file drag is hovering the composer; swaps the surface for the drop wash. */
  readonly dragActive?: boolean;
  /** Test hook for the outer box (the one element that spans the composer). */
  readonly dataTestId?: string;
}

export function ChatComposerShell({
  dragActive = false,
  dataTestId,
  className,
  children,
  ...rest
}: ChatComposerShellProps): JSX.Element {
  const shell = dragActive
    ? CHAT_COMPOSER_SHELL_DRAG_CLASS
    : CHAT_COMPOSER_SHELL_CLASS;
  return (
    <div
      data-testid={dataTestId}
      className={className ? `${shell} ${className}` : shell}
      {...rest}
    >
      {children}
    </div>
  );
}
