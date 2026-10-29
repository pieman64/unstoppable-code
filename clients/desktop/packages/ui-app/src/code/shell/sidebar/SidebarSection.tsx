'use client';

import {
  type ButtonHTMLAttributes,
  useId,
  useState,
  type HTMLAttributes,
  type JSX,
  type ReactNode,
} from 'react';
import { SidebarFadePresence } from '@canopy/ui-shared/components';

export interface SidebarSectionProps extends Omit<
  HTMLAttributes<HTMLElement>,
  'children' | 'title'
> {
  readonly children: ReactNode;
  readonly title?: ReactNode;
  readonly icon?: ReactNode;
  readonly count?: ReactNode;
  readonly actions?: ReactNode;
  /** Complete disclosure-label override; title/icon/count are ignored. */
  readonly header?: ReactNode;
  readonly collapsible?: boolean;
  /** Controlled collapse state. */
  readonly collapsed?: boolean;
  /** Initial state for uncontrolled use. */
  readonly defaultCollapsed?: boolean;
  readonly onCollapsedChange?: (collapsed: boolean) => void;
  readonly headerClassName?: string;
  /** Omits the generated header wrapper when a host intentionally has no header. */
  readonly hideHeader?: boolean;
  /**
   * `group` frames the section as one rounded group of rows with 4px of
   * bottom inset, so a `selected` tint sits clear of the last row (the web
   * portal's workspace sections).
   */
  readonly frame?: 'plain' | 'group';
  /** Tint a framed section faintly while it holds the current selection. */
  readonly selected?: boolean;
  /**
   * `inset` sets the header row 4px in from the section edge and keeps 4px
   * under the rows (the desktop's Hidden and Shared with me sections).
   */
  readonly spacing?: 'none' | 'inset';
  /**
   * `sidebar` paints the header on the sidebar material so the rail's pinned
   * copies read against an opaque header (the desktop's workspace headers).
   */
  readonly headerSurface?: 'transparent' | 'sidebar';
  /** Optional host renderer used when a sticky header must escape a masked viewport. */
  readonly renderHeader?: (header: ReactNode) => ReactNode;
  /**
   * Attributes forwarded onto the generated collapse toggle button — the
   * element that carries aria-expanded/focus/keyboard activation. Hosts whose
   * automation ids must live on the actual control (not header content)
   * attach them here.
   */
  readonly headerButtonProps?: ButtonHTMLAttributes<HTMLButtonElement> &
    Record<`data-${string}`, string | undefined>;
  /**
   * Container element. Defaults to `section`. Hosts nesting sections (e.g. a
   * top-level group containing per-workspace sections) pass `as="div"` so
   * `<section>`-anchored automation selectors keep matching exactly one
   * element per logical section.
   */
  readonly as?: 'section' | 'div';
}

/** Collapsible host-content section supporting controlled persistence. */
export function SidebarSection({
  children,
  title,
  icon,
  count,
  actions,
  header,
  headerButtonProps,
  as: Container = 'section',
  collapsible = true,
  collapsed,
  defaultCollapsed = false,
  onCollapsedChange,
  className,
  headerClassName,
  hideHeader = false,
  frame = 'plain',
  selected = false,
  spacing = 'none',
  headerSurface = 'transparent',
  renderHeader,
  ...attributes
}: SidebarSectionProps): JSX.Element {
  const [internalCollapsed, setInternalCollapsed] = useState(defaultCollapsed);
  const isControlled = collapsed !== undefined;
  const isCollapsed = isControlled ? collapsed : internalCollapsed;
  const contentId = useId();
  const containerClassName =
    [
      className,
      // The bottom inset frames the rows; a collapsed group is its header
      // alone, as the desktop project section was.
      frame === 'group' ? (isCollapsed ? 'rounded-lg' : 'rounded-lg pb-1') : '',
      selected ? 'bg-fg-primary/[0.03]' : '',
    ]
      .filter(Boolean)
      .join(' ') || undefined;
  const resolvedContentClassName = spacing === 'inset' ? 'pb-1' : undefined;

  const toggle = (): void => {
    if (!collapsible) return;
    const next = !isCollapsed;
    if (!isControlled) setInternalCollapsed(next);
    onCollapsedChange?.(next);
  };

  const headerContent = header ?? (
    <>
      {icon && <span className="shrink-0">{icon}</span>}
      {title && <span className="min-w-0 truncate">{title}</span>}
      {count !== undefined && (
        <span className="shrink-0 fg-secondary">{count}</span>
      )}
    </>
  );

  const headerNode = (
    <div
      className={`flex min-w-0 items-center gap-1${spacing === 'inset' ? ' px-1' : ''}${headerSurface === 'sidebar' ? ' bg-sidebar' : ''}${headerClassName ? ` ${headerClassName}` : ''}`}
    >
      {collapsible ? (
        <button
          type="button"
          {...headerButtonProps}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={!isCollapsed}
          aria-controls={contentId}
          onClick={toggle}
        >
          {headerContent}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {headerContent}
        </div>
      )}
      {actions && <div className="ml-auto shrink-0">{actions}</div>}
    </div>
  );

  return (
    <Container
      {...attributes}
      className={containerClassName}
      data-collapsed={isCollapsed || undefined}
    >
      {!hideHeader && (renderHeader ? renderHeader(headerNode) : headerNode)}
      {collapsible ? (
        <SidebarFadePresence
          open={!isCollapsed}
          id={contentId}
          className={resolvedContentClassName}
          data-sidebar-section-content=""
        >
          {children}
        </SidebarFadePresence>
      ) : (
        <div
          id={contentId}
          className={resolvedContentClassName}
          data-sidebar-section-content=""
        >
          {children}
        </div>
      )}
    </Container>
  );
}
