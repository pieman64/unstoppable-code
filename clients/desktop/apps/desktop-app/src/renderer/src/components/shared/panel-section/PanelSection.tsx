import {
  isValidElement,
  useContext,
  type ButtonHTMLAttributes,
  type JSX,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ActivityActionCardButton,
  type CollapsedIconColor as SharedCollapsedIconColor,
  Divider,
  HeaderActionButton,
  type HeaderActionButtonTone,
  PanelSection as SharedPanelSection,
  PanelSectionHeaderActionSlotContext,
  type PanelSectionHeaderProps,
  type SpaceRole,
} from '@canopy/ui-shared/components';
import { useSortableDragHandle } from './sortable-section-context';
import { useActivitySectionChrome } from './section-chrome-context';

export type CollapsedIconColor = SharedCollapsedIconColor;

interface PanelSectionProps {
  icon: JSX.Element;
  title: string;
  subtitle?: ReactNode;
  subtitleGap?: SpaceRole;
  children?: ReactNode;
  headerAction?: ReactNode;
  collapsedIconColor?: CollapsedIconColor;
  defaultCollapsed?: boolean;
  /** Whether the body contains meaningful content beneath the header. */
  hasExpandableContent?: boolean;
  /** Visible secondary-button label used for an action-only body-only card. */
  actionOnlyLabel?: string;
  /** Render an empty body-only section as one full-card action button. */
  actionOnlyCard?: boolean;
  /** Keep secondary content, such as hidden history, beneath an action card. */
  showBodyWithActionCard?: boolean;
  /** Extra DOM handlers for the full-card action (for example file drops). */
  actionOnlyCardProps?: ButtonHTMLAttributes<HTMLButtonElement>;
  /**
   * Body layout when rendered frameless (standalone `activity-card` panel).
   * - `'scroll'` (default): one `flex-1` scrolling body — unbounded sections
   *   fill and scroll under the pinned header with no section-level change.
   * - `'flex'`: a `flex-1` flex-column body with no overflow — the section
   *   manages its own internal scroll regions (hybrid multi-scroll sections).
   * Ignored in card mode.
   */
  framelessBody?: 'scroll' | 'flex';
}

interface BodyOnlyHeaderActionProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly iconOnly?: boolean;
  readonly size?: string;
  readonly tone?: HeaderActionButtonTone;
  readonly tooltipLabel?: ReactNode;
  readonly variant?: string;
}

interface ForwardedBodyOnlyHeaderActionProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly tone?: HeaderActionButtonTone;
  readonly tooltipLabel?: ReactNode;
}

function getBodyOnlyActionButtonProps(
  headerAction: ReactNode,
): ForwardedBodyOnlyHeaderActionProps | null {
  if (!isValidElement<BodyOnlyHeaderActionProps>(headerAction)) return null;

  const {
    children: _children,
    className: _className,
    iconOnly: _iconOnly,
    size: _size,
    variant: _variant,
    ...buttonProps
  } = headerAction.props;
  void _children;
  void _className;
  void _iconOnly;
  void _size;
  void _variant;
  return buttonProps;
}

/**
 * Desktop wrapper around the shared `PanelSection`. Reads the
 * dnd-kit-driven drag-handle context so the section header can act as
 * the sortable handle when wrapped in a `SortablePanelSection`.
 *
 * Also reads {@link useActivitySectionChrome}: under a `'frameless'`
 * provider (the standalone `activity-card` panel), the card chrome and the
 * expand/collapse UX are dropped. The icon and title are surfaced by the
 * panel's own tab (see `renderPanelTabIcon`/`renderPanelTabLabel`), so the
 * frameless header row omits them and carries only the subtitle and any
 * header actions in a single compact row — rendered directly above the
 * always-expanded content with no border, background, or rounded box, and it
 * is not a collapse target or a sortable drag handle. When a section has
 * neither a subtitle nor an action, the header row is dropped entirely and
 * the body owns the top padding.
 */
export function PanelSection({
  icon,
  title,
  subtitle,
  subtitleGap,
  children,
  headerAction,
  collapsedIconColor = 'muted',
  defaultCollapsed = false,
  hasExpandableContent = true,
  actionOnlyLabel,
  actionOnlyCard = false,
  showBodyWithActionCard = false,
  actionOnlyCardProps,
  framelessBody = 'scroll',
}: PanelSectionProps): JSX.Element {
  const chrome = useActivitySectionChrome();
  const dragHandle = useSortableDragHandle();
  const headerActionSlot = useContext(PanelSectionHeaderActionSlotContext);

  if (chrome === 'body-only') {
    const actionOnly = !hasExpandableContent;
    const forwardedActionProps = getBodyOnlyActionButtonProps(headerAction);
    if (
      actionOnly &&
      actionOnlyCard &&
      actionOnlyLabel !== undefined &&
      forwardedActionProps !== null
    ) {
      const {
        tone: _tone,
        tooltipLabel: _tooltipLabel,
        ...actionButtonProps
      } = forwardedActionProps;
      void _tone;
      void _tooltipLabel;
      return (
        <div
          className={
            showBodyWithActionCard
              ? 'overflow-hidden rounded-lg bg-tertiary shadow-sm'
              : undefined
          }
          data-testid="action-card-container"
        >
          <div className="w-full" data-testid="body-only-section-action-card">
            <ActivityActionCardButton
              {...actionButtonProps}
              {...actionOnlyCardProps}
              icon={icon}
              label={actionOnlyLabel}
              attached={showBodyWithActionCard}
            />
          </div>
          {showBodyWithActionCard && (
            <Divider aria-hidden data-testid="action-card-divider" />
          )}
          <div
            data-testid="action-card-body"
            className={showBodyWithActionCard ? 'p-3' : 'hidden'}
          >
            {children}
          </div>
        </div>
      );
    }
    let resolvedHeaderAction = headerAction;
    if (
      actionOnly &&
      actionOnlyLabel !== undefined &&
      forwardedActionProps !== null
    ) {
      resolvedHeaderAction = (
        <HeaderActionButton {...forwardedActionProps}>
          {actionOnlyLabel}
        </HeaderActionButton>
      );
    }
    // The section's action handlers (create modal, file picker, import
    // modal) live in this body, so the button is lifted into the shared
    // header's controls cell through a portal. That cell is a zero-height,
    // self-centered row-1 grid item, so the button centers on the title row
    // exactly like a `headerAction` prop (the Changed Files card) rather than
    // on the two-line title+subtitle block. The stopPropagation wrappers mirror
    // the shared component's own headerAction wrapper. Without a shared header
    // above (no slot), fall back to an in-card overlay aligned to the title
    // row: the card inset is `p-3` and a 28px control centered on the 20px
    // title row lands 8px from the top.
    const stopPropagation = (event: { stopPropagation: () => void }): void => {
      event.stopPropagation();
    };
    let liftedHeaderAction: ReactNode = null;
    if (resolvedHeaderAction != null && headerActionSlot !== null) {
      liftedHeaderAction = createPortal(
        <div
          data-testid="body-only-section-header-action"
          className="flex items-center"
          onClick={stopPropagation}
          onKeyDown={stopPropagation}
          onPointerDown={stopPropagation}
          role="presentation"
        >
          {resolvedHeaderAction}
        </div>,
        headerActionSlot,
      );
    } else if (resolvedHeaderAction != null) {
      liftedHeaderAction = (
        <div
          data-testid="body-only-section-header-action"
          className="absolute right-3 top-2 z-10 flex items-center"
        >
          {resolvedHeaderAction}
        </div>
      );
    }
    return (
      <>
        {liftedHeaderAction}
        {!actionOnly && children}
      </>
    );
  }

  if (chrome === 'frameless') {
    // The icon + title now live on the panel tab, so the frameless header is a
    // single compact row of just the subtitle and any header action. With
    // neither, the row is dropped and the body carries the top padding instead.
    const showHeader = subtitle != null || headerAction != null;
    const bodyBase =
      framelessBody === 'flex'
        ? 'flex min-h-0 flex-1 flex-col px-3 pb-3'
        : 'min-h-0 flex-1 overflow-y-auto px-3 pb-3';
    return (
      <section
        data-activity-chrome="frameless"
        className="flex h-full min-h-0 flex-col"
      >
        {showHeader && (
          <div
            data-testid="frameless-section-header"
            className="flex shrink-0 items-center justify-between gap-2 px-3 pb-2 pt-3"
          >
            <div className="min-w-0 flex-1 text-2xs fg-secondary">
              {subtitle}
            </div>
            {headerAction != null && (
              <div className="shrink-0">{headerAction}</div>
            )}
          </div>
        )}
        <div
          data-testid="frameless-section-body"
          className={showHeader ? bodyBase : `${bodyBase} pt-3`}
        >
          {children}
        </div>
      </section>
    );
  }
  const headerProps: PanelSectionHeaderProps | undefined = dragHandle
    ? { ...dragHandle.attributes, ...dragHandle.listeners }
    : undefined;
  return (
    <SharedPanelSection
      icon={icon}
      title={title}
      subtitle={subtitle}
      subtitleGap={subtitleGap}
      headerAction={headerAction}
      collapsedIconColor={collapsedIconColor}
      defaultCollapsed={defaultCollapsed}
      headerProps={headerProps}
    >
      {children}
    </SharedPanelSection>
  );
}
