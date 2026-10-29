import { type JSX, type ReactNode, useEffect } from 'react';
import { useSidebarStore } from '@/stores/sidebarStore';
import { CollapsedTitlebarToggle } from '../sidebar/CollapsedTitlebarToggle';

/**
 * Row height. `bar` is the shared 40px top strip every page keeps, content or
 * not, so the collapsed-sidebar toggle always has a row to sit in.
 * `breadcrumb` is the 46px bar that seats a breadcrumb trail on the sidebar
 * controls' line: the trail keeps the sidebar's 9px top inset and gets the
 * same 9px below it. `content` sizes to the page's own header row.
 */
export type PageTitlebarHeight = 'bar' | 'breadcrumb' | 'content';

const HEIGHT_CLASS_NAMES: Record<PageTitlebarHeight, string> = {
  bar: 'h-10',
  breadcrumb: 'h-11.5',
  content: '',
};

/**
 * A pinned bar's chrome: the opaque fill that keeps cards from showing
 * through the drag region, and the worktree header's bottom hairline (one
 * physical pixel, `--border-hairline` in `--line-base`) drawn by a
 * pseudo-element rather than a border so it never changes the content box.
 * Its opacity carries the fade.
 */
const PINNED_CLASS_NAME =
  "sticky top-0 bg-base after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-[var(--border-hairline)] after:bg-[var(--line-base)] after:transition-opacity after:duration-150 after:content-['']";

export interface PageTitlebarProps {
  /** The page's own top-bar content, placed to the right of the toggle. */
  children?: ReactNode;
  /** Placement classes for the outer row: `z-*`, flex participation. */
  className?: string;
  /** Test id for the outer row, for specs that assert on its position. */
  testId?: string;
  height?: PageTitlebarHeight;
  /**
   * The bar is the window's drag region on the desktop (default). The
   * controls inside it opt out with `electron-no-drag`, as every shared
   * control already does.
   */
  dragRegion?: boolean;
  /** Draw the hairline border below a header row. */
  divider?: boolean;
  /**
   * The bar stays put over a scrolling page: painted opaque so content does
   * not show through the drag region, and carrying a bottom hairline that
   * fades in only while `scrolled`. At rest there is nothing under the bar to
   * divide.
   */
  pinned?: boolean;
  scrolled?: boolean;
}

/**
 * Layout helper every page uses to render its top bar in the window's top
 * area. When the sidebar is hidden it places the self-contained
 * {@link CollapsedTitlebarToggle} at the left and aligns the page's top bar
 * flush against it (same row — the toggle takes real space, so nothing is
 * pushed down and the page's top bar stays inline at the top of the window).
 * When the sidebar is shown the toggle lives in the sidebar instead and this
 * renders the page's top bar full width, unchanged.
 */
export function PageTitlebar({
  children,
  className,
  testId,
  height = 'bar',
  dragRegion = true,
  divider = false,
  pinned = false,
  scrolled = false,
}: PageTitlebarProps): JSX.Element {
  const registerTitlebarHost = useSidebarStore((s) => s.registerTitlebarHost);
  const unregisterTitlebarHost = useSidebarStore(
    (s) => s.unregisterTitlebarHost,
  );

  // Register while mounted so App.tsx knows the active page hosts the toggle
  // inline and can suppress its fallback collapsed toggle bar.
  useEffect(() => {
    registerTitlebarHost();
    return unregisterTitlebarHost;
  }, [registerTitlebarHost, unregisterTitlebarHost]);

  const classes = [
    'flex shrink-0 items-stretch',
    dragRegion ? 'electron-drag' : '',
    HEIGHT_CLASS_NAMES[height],
    divider ? 'border-b' : '',
    pinned
      ? `${PINNED_CLASS_NAME} ${scrolled ? 'after:opacity-100' : 'after:opacity-0'}`
      : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} data-testid={testId}>
      <CollapsedTitlebarToggle />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
