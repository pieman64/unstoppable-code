import type { ComponentProps, HTMLAttributes, JSX, ReactNode } from 'react';
import { ComposerTraySlot } from './ComposerTray';

/**
 * Which composer edge a drawer hangs from. `top` tucks 16px under the
 * composer (Home's pickers, the chat tip and background work); `bottom` sits
 * under it (MCP sign-in).
 */
export type ComposerDrawerEdge = 'top' | 'bottom';

const EDGE_CLASS_NAMES: Record<ComposerDrawerEdge, string> = {
  // `-mb-4` + `pb-5` tuck the drawer under the elevated composer while
  // keeping a 4px visible inset (`p-1`) on every side of its content.
  top: '-mb-4 rounded-t-drawer pb-5',
  bottom: 'rounded-b-2xl',
};

export interface ComposerDrawerProps extends Omit<
  HTMLAttributes<HTMLElement>,
  'children'
> {
  readonly edge: ComposerDrawerEdge;
  /** `section` when the drawer is a labelled region (`aria-labelledby`). */
  readonly as?: 'div' | 'section';
  readonly children: ReactNode;
}

/**
 * The one composer-edge surface: a depth strip inset 16px from the
 * composer's sides, past its corner radius, rounded on its outer edge. It
 * holds `ComposerDrawerSection`s, and draws nothing while none renders
 * (`display: contents`, so a mounted slot's markers keep their boxes).
 *
 * A top drawer also offers the composer tray (the compact queue) a slot
 * just above itself, so the tray tucks under the drawer rather than the
 * drawer tucking over the tray; with the drawer empty, the tray reaches the
 * box below it.
 */
export function ComposerDrawer({
  edge,
  as: Element = 'div',
  className = '',
  children,
  ...props
}: ComposerDrawerProps): JSX.Element {
  return (
    <>
      {edge === 'top' ? <ComposerTraySlot /> : null}
      <Element
        {...props}
        data-composer-drawer={edge}
        className={`relative mx-4 bg-depth p-1 shadow-2xs [&:not(:has([data-composer-drawer-section]))]:contents ${EDGE_CLASS_NAMES[edge]} ${className}`}
      >
        {children}
      </Element>
    </>
  );
}

/**
 * One block of a `ComposerDrawer`: pickers, a tip, background work. Every
 * section after the first draws the menu divider's hairline above it. The
 * divider lives here, not on the drawer, because an elevated surface never
 * carries a border of its own.
 */
export function ComposerDrawerSection({
  className = '',
  children,
  ...props
}: ComponentProps<'div'>): JSX.Element {
  return (
    <div
      {...props}
      data-composer-drawer-section=""
      className={`[[data-composer-drawer-section]~&]:mt-1 [[data-composer-drawer-section]~&]:border-t [[data-composer-drawer-section]~&]:pt-1 ${className}`}
    >
      {children}
    </div>
  );
}
