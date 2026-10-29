import type { JSX, ReactNode } from 'react';

/**
 * The fixed icon slot of a hover card's icon-and-label line: 16px wide (a
 * 16px project glyph fills it, 14px line icons and smaller spinners center)
 * and one 18px text line tall. Pair it with an 8px gap (`gap-2`) to its label.
 * It inks its icon in the quiet tertiary; a colored icon brings its own ink
 * on a wrapping span.
 * Shared by the sidebar worktree preview and the chat tab preview, so their
 * icons sit in the same place.
 */
export function HoverCardIconSlot({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <span
      className="inline-flex h-4.5 w-4 shrink-0 items-center justify-center fg-tertiary"
      aria-hidden="true"
    >
      {children}
    </span>
  );
}
