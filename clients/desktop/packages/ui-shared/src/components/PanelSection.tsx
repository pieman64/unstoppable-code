import {
  createContext,
  useState,
  type ButtonHTMLAttributes,
  type JSX,
  type ReactNode,
  type Ref,
} from 'react';
import { ChevronRightMediumIcon } from '../icons/AppIcons';
import { Heading } from './Heading';

export type CollapsedIconColor = 'amber' | 'blue' | 'muted';

/**
 * The header's trailing controls cell, exposed to body content. Hosts whose
 * action handlers live in the body (e.g. the desktop body-only chrome, where
 * a section owns its own modal/import state) `createPortal` their button into
 * this element so it lands in the same title-row-centered grid cell a
 * `headerAction` prop would, instead of overlaying the card. `null` until the
 * header has mounted, or when no `PanelSection` is above the reader.
 */
export const PanelSectionHeaderActionSlotContext =
  createContext<HTMLElement | null>(null);

/**
 * Opaque attribute bag passed to the section header. Used to wire up a
 * sortable pointer-drag adapter (e.g., the pointer listener from
 * `@dnd-kit/sortable`'s `useSortable()` hook). The shared component
 * deliberately does not import dnd-kit; instead, the host spreads its
 * attribute/listener bags into this object before passing it.
 */
export type PanelSectionHeaderProps = Record<string, unknown>;

export interface PanelSectionProps {
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  subtitleInline?: boolean;
  children?: ReactNode;
  headerAction?: ReactNode;
  collapsedIconColor?: CollapsedIconColor;
  defaultCollapsed?: boolean;
  /** Whether the section has body content that can be expanded or collapsed. */
  collapsible?: boolean;
  /**
   * Preserve the body subtree while collapsed. Use this when a header action
   * delegates to state or controls owned by the body.
   */
  keepBodyMountedWhenCollapsed?: boolean;
  /**
   * Host reveal request. Each new value expands a collapsed section once;
   * later collapse and expand clicks stay with the user. The value present
   * at mount is not a request.
   */
  expandRequest?: number;
  /**
   * Optional opaque header props. When provided the header row receives
   * a grab cursor and all entries in this bag are spread onto the
   * header element.
   */
  headerProps?: PanelSectionHeaderProps;
  /** Optional separate keyboard-only sortable handle supplied by the host. */
  keyboardDragHandleProps?: ButtonHTMLAttributes<HTMLButtonElement>;
  keyboardDragHandleRef?: Ref<HTMLButtonElement>;
}

function SectionChevronIcon({ expanded }: { expanded: boolean }): JSX.Element {
  return (
    <ChevronRightMediumIcon
      size={16}
      className={`transition-transform duration-150 ease-out motion-reduce:transition-none ${
        expanded ? 'rotate-90' : ''
      }`}
    />
  );
}

function getCollapsedIconColorClass(color: CollapsedIconColor): string {
  return color === 'amber' ? 'fg-warning' : 'fg-secondary';
}

/**
 * Pure display collapsible card. Matches the styling and behavior of
 * canopy's desktop `PanelSection`. To compose this inside a sortable
 * context (e.g., dnd-kit), pass `headerProps` with the supplied pointer
 * listener.
 */
export function PanelSection({
  icon,
  title,
  subtitle,
  subtitleInline = false,
  children,
  headerAction,
  collapsedIconColor = 'muted',
  defaultCollapsed = false,
  collapsible = true,
  keepBodyMountedWhenCollapsed = false,
  expandRequest,
  headerProps,
  keyboardDragHandleProps,
  keyboardDragHandleRef,
}: PanelSectionProps): JSX.Element {
  // Collapsed section icons stay neutral unless the host explicitly marks
  // the section with the warning/amber channel.
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  // Adjusted while rendering rather than in an effect, so a revealed section
  // paints expanded in the same commit that delivers the request.
  const [seenExpandRequest, setSeenExpandRequest] = useState(expandRequest);
  if (expandRequest !== seenExpandRequest) {
    setSeenExpandRequest(expandRequest);
    if (expandRequest !== undefined) setCollapsed(false);
  }
  // Callback-ref state (not a ref object) so body readers re-render once the
  // controls cell exists and can portal into it.
  const [headerActionSlot, setHeaderActionSlot] =
    useState<HTMLDivElement | null>(null);

  const iconColorClass =
    collapsible && collapsed
      ? getCollapsedIconColorClass(collapsedIconColor)
      : 'fg-secondary';

  const hasDraggable = headerProps !== undefined;
  const headerSpread: Record<string, unknown> = headerProps ?? {};
  const titleRowClassName = 'flex min-w-0 items-center gap-3 text-left';
  const titleIcon = (
    <span
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center"
      data-panel-section-icon
    >
      <span
        className={`inline-flex h-4 w-4 shrink-0 items-center justify-center [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0 ${iconColorClass}${
          collapsible ? ' group-hover/section-header:hidden' : ''
        }`}
        data-panel-section-leading-icon
      >
        {icon}
      </span>
      {collapsible && (
        <span
          className="hidden h-4 w-4 shrink-0 items-center justify-center fg-accent group-hover/section-header:inline-flex [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0"
          data-panel-section-hover-chevron
          aria-hidden="true"
        >
          <SectionChevronIcon expanded={!collapsed} />
        </span>
      )}
    </span>
  );

  return (
    <section
      className={`rounded-lg bg-tertiary p-3 shadow-sm${collapsible && !collapsed ? ' space-y-3' : ''}`}
      data-collapsible={collapsible ? 'true' : 'false'}
    >
      <div
        className={`group/section-header relative grid select-none grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1${
          collapsible ? ' cursor-pointer' : ''
        }${hasDraggable ? ' active:cursor-grabbing' : ''}`}
        {...headerSpread}
        data-panel-section-header
        onClick={(): void => {
          if (collapsible) setCollapsed((previous) => !previous);
        }}
      >
        {keyboardDragHandleProps != null && (
          <button
            ref={keyboardDragHandleRef}
            type="button"
            className="sr-only focus:not-sr-only focus:absolute focus:left-0 focus:top-0 focus:z-20 focus:rounded-sm focus:bg-quaternary focus:px-2 focus:py-1 focus:text-2xs focus:font-normal focus:fg-primary focus:shadow-sm"
            {...keyboardDragHandleProps}
          />
        )}
        {collapsible ? (
          <Heading
            level={3}
            variant="title"
            truncate
            className="col-start-1 row-start-1 min-w-0"
          >
            <button
              type="button"
              className={`${titleRowClassName} focus-ring w-full rounded-sm`}
              data-panel-section-title-row
              aria-expanded={!collapsed}
              onClick={(event): void => {
                event.stopPropagation();
                setCollapsed((previous) => !previous);
              }}
            >
              {titleIcon}
              <span
                className="min-w-0 flex-1 truncate"
                data-panel-section-title
              >
                {title}
              </span>
            </button>
          </Heading>
        ) : (
          <div
            className={`col-start-1 row-start-1 ${titleRowClassName}`}
            data-panel-section-title-row
          >
            {titleIcon}
            <Heading
              level={3}
              variant="title"
              truncate
              className="min-w-0 flex-1"
              data-panel-section-title
            >
              {title}
            </Heading>
          </div>
        )}
        <div
          ref={setHeaderActionSlot}
          className="col-start-2 row-start-1 -mr-1 flex h-0 shrink-0 self-center items-center gap-1"
          data-panel-section-controls
        >
          {subtitleInline && subtitle != null && (
            <span
              className="mr-2 whitespace-nowrap text-2xs font-normal fg-secondary"
              data-panel-section-subtitle
            >
              {subtitle}
            </span>
          )}
          {headerAction != null && (
            <div
              className="flex items-center"
              onClick={(e): void => e.stopPropagation()}
              onKeyDown={(e): void => e.stopPropagation()}
              onPointerDown={(e): void => e.stopPropagation()}
              role="presentation"
            >
              {headerAction}
            </div>
          )}
        </div>
        {!subtitleInline && subtitle != null && (
          <div
            className="col-span-2 row-start-2 min-w-0 pl-7 text-2xs font-normal fg-secondary"
            data-panel-section-subtitle
          >
            {subtitle}
          </div>
        )}
        {collapsible && children != null && (
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute -left-3 -right-3 top-full h-[var(--default-border-width)] translate-y-3 bg-line-tertiary transition-opacity duration-200 ease-out motion-reduce:transition-none ${
              collapsed ? 'opacity-0' : 'opacity-100'
            }`}
            data-panel-section-divider
          />
        )}
      </div>
      {(!collapsible || !collapsed || keepBodyMountedWhenCollapsed) &&
        children != null && (
          <div
            hidden={collapsible && collapsed}
            className={`space-y-3${collapsible ? ' pt-3.25' : ' pt-3 empty:hidden'}`}
            data-panel-section-body
          >
            <PanelSectionHeaderActionSlotContext.Provider
              value={headerActionSlot}
            >
              {children}
            </PanelSectionHeaderActionSlotContext.Provider>
          </div>
        )}
    </section>
  );
}
