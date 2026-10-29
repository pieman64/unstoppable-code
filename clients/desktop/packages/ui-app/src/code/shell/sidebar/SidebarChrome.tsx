import type { HTMLAttributes, JSX, ReactNode } from 'react';

export type SidebarChromeVariant = 'rail' | 'drawer';
export type SidebarChromeWidth = 'compact' | 'default' | 'wide' | 'full';
export type SidebarDensity = 'compact' | 'default' | 'touch';
export type SidebarChromeScroll = 'frame' | 'host' | 'none';

export interface SidebarChromeProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'children'
> {
  readonly children: ReactNode;
  readonly variant?: SidebarChromeVariant;
  readonly width?: SidebarChromeWidth;
  readonly density?: SidebarDensity;
  /**
   * Whether this frame scrolls itself (`'frame'`), an inner host owns
   * scrolling (`'host'`), or the frame is nested inside an OUTER scroller that
   * owns it (`'none'`).
   *
   * `'none'` must not clip: `overflow: hidden` makes this element the nearest
   * scrollport for everything inside it, so sticky descendants would be
   * measured against a box that never scrolls and would simply flow away with
   * the content.
   */
  readonly scroll?: SidebarChromeScroll;
  /** Emit `h-full`; disable when the frame is `split` or the host sizes it. */
  readonly fullHeight?: boolean;
  /**
   * `sidebar` paints the frame on the sidebar material (`bg-sidebar`), the
   * desktop rail's surface.
   */
  readonly surface?: 'transparent' | 'sidebar';
  /**
   * The web portal's responsive split: below the `lg` breakpoint the rail is
   * a 42vh pane (at least 300px) stacked above the content under a bottom
   * hairline; from `lg` it is a full-height rail with a trailing hairline.
   * Pair it with `fullHeight={false}`.
   */
  readonly split?: boolean;
}

const WIDTH_CLASSES: Readonly<Record<SidebarChromeWidth, string>> = {
  compact: 'w-56',
  default: 'w-64',
  wide: 'w-72',
  full: 'w-full',
};

// `border-<color>` is left off: the unlayered base border rule paints the
// same `--line-base` on every edge (CAN-2734).
const SPLIT_CLASS_NAME =
  'h-[42vh] min-h-75 shrink-0 border-b lg:h-full lg:border-b-0 lg:border-r';

/** Data-agnostic outer sidebar frame. Responsive placement remains host-owned. */
export function SidebarChrome({
  children,
  variant = 'rail',
  width = variant === 'drawer' ? 'full' : 'default',
  density = 'default',
  scroll = 'frame',
  fullHeight = true,
  surface = 'transparent',
  split = false,
  className,
  ...attributes
}: SidebarChromeProps): JSX.Element {
  const densityClass = density === 'compact' ? 'text-xs' : '';
  const heightClass = fullHeight ? 'h-full ' : '';
  const overflowClass =
    scroll === 'frame'
      ? 'overflow-auto '
      : scroll === 'none'
        ? ''
        : 'overflow-hidden ';

  return (
    <div
      {...attributes}
      className={`flex ${heightClass}min-h-0 flex-col ${overflowClass}${WIDTH_CLASSES[width]} ${densityClass}${split ? ` ${SPLIT_CLASS_NAME}` : ''}${surface === 'sidebar' ? ' bg-sidebar' : ''}${className ? ` ${className}` : ''}`}
      data-sidebar-density={density}
      data-sidebar-variant={variant}
    >
      {children}
    </div>
  );
}
