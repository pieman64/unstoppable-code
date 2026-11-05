import { type JSX, type ReactNode } from 'react';
import {
  Button,
  RichHoverTooltip,
  Tooltip,
} from '@canopy/ui-shared/components';
import {
  SIDEBAR_STATUS_HOVER_WASH_CLASSNAME,
  SIDEBAR_STATUS_SURFACE_CLASSNAME,
} from '@canopy/ui-shared/lib';
import { useLabsExperimentEnabled } from '@/stores/labsExperimentsStore';

interface SidebarFooterBannerAction {
  ariaLabel: string;
  icon: ReactNode;
  onClick: () => void;
  testId: string;
  title?: string;
}

interface SidebarFooterBannerProps {
  ariaLabel?: string;
  children: ReactNode;
  /**
   * Placement and any host surface. Omit it with `surface="status"`, which
   * owns the raised card and its hover.
   */
  className?: string;
  /**
   * `status` is the raised card every interactive prompt shares (update,
   * sign-in repair, resume queue, clone progress): the card stays under the
   * pointer and a `bg-subtle` wash darkens it, rather than each prompt
   * choosing whether hover replaces the card.
   */
  surface?: 'status';
  onClick?: () => void;
  testId: string;
  /** Hover content; only a string also becomes a static banner's native title. */
  title?: ReactNode;
  /**
   * Optional secondary icon button rendered at the trailing edge. Only valid
   * together with `onClick`; the banner then renders as a row of two sibling
   * buttons so the markup stays valid (no nested buttons).
   */
  trailingAction?: SidebarFooterBannerAction;
}

// Height comes first so early access can swap it: there banners take the
// sidebar rows' 32px (`h-8`), so every item shares one height and corner.
const BASE_CLASSNAME =
  'flex w-full items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-row py-0 pl-1 pr-2 text-xs font-normal';
// Split rows (primary + trailing action) drop `overflow-hidden`: the buttons'
// focus-visible outlines draw outside their boxes (2px outline at 2px offset)
// and would be clipped by the container. Label truncation still works because
// the primary button carries its own overflow-hidden.
// The raised card shared by every status prompt. Hover washes the card with
// `bg-subtle` instead of replacing it, so the banner keeps its surface.
const STATUS_SURFACE_CLASSNAME = SIDEBAR_STATUS_SURFACE_CLASSNAME;
const STATUS_HOVER_WASH_CLASSNAME = SIDEBAR_STATUS_HOVER_WASH_CLASSNAME;
// Split rows wash on the primary action only, so hovering the trailing icon
// button highlights just itself.
const STATUS_SPLIT_HOVER_WASH_CLASSNAME =
  'has-[[data-banner-primary]:hover]:[background-image:linear-gradient(var(--bg-subtle),var(--bg-subtle))] has-[[data-banner-primary]:focus-visible]:[background-image:linear-gradient(var(--bg-subtle),var(--bg-subtle))]';
const SPLIT_BASE_CLASSNAME =
  'flex w-full items-center gap-1.5 whitespace-nowrap rounded-row py-0 pl-1 pr-2 text-xs font-normal';

/**
 * Shared compact surface for status banners anchored immediately above the
 * sidebar account divider. Static development context and interactive prompts
 * use the same geometry while supplying their own semantic colors/elevation.
 */
export function SidebarFooterBanner({
  ariaLabel,
  children,
  className = '',
  surface,
  onClick,
  testId,
  title,
  trailingAction,
}: SidebarFooterBannerProps): JSX.Element {
  const heightClassName = useLabsExperimentEnabled('sidebar') ? 'h-8' : 'h-7';
  const surfaceClassName =
    surface === 'status'
      ? onClick
        ? trailingAction
          ? `${STATUS_SURFACE_CLASSNAME} ${STATUS_SPLIT_HOVER_WASH_CLASSNAME}`
          : `${STATUS_SURFACE_CLASSNAME} ${STATUS_HOVER_WASH_CLASSNAME}`
        : STATUS_SURFACE_CLASSNAME
      : '';
  const classes = `${heightClassName} ${BASE_CLASSNAME} ${
    onClick ? 'focus-ring text-left' : ''
  } ${surfaceClassName} ${className}`;

  if (onClick && trailingAction) {
    return (
      <div
        className={`${heightClassName} ${SPLIT_BASE_CLASSNAME} ${surfaceClassName} ${className}`}
        data-testid={`${testId}-row`}
      >
        {/* `data-banner-primary` lets the consumer scope row-level hover
            treatments to the primary action via `has-[...]` so hovering the
            trailing icon button highlights only itself. */}
        {/* RichHoverTooltip (not Tooltip): its wrapper carries no `shrink-0`,
            so it can take over the primary button's `min-w-0 flex-1` slot and
            the label keeps truncating. */}
        <RichHoverTooltip
          disabled={title === undefined}
          triggerWrapperClassName="h-full min-w-0 flex-1"
          surfaceClassName="w-max max-w-72"
          surfacePadding="compact"
          content={<span className="text-xs fg-primary">{title}</span>}
        >
          <button
            type="button"
            onClick={onClick}
            aria-label={ariaLabel}
            className="focus-ring flex h-full w-full min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-row text-left"
            data-testid={testId}
            data-banner-primary
          >
            {children}
          </button>
        </RichHoverTooltip>
        {/* The shared 28px quiet icon button sits 2px from the banner's
            trailing edge (-mr-1.5 against the banner's pr-2), which puts the
            glyph center 16px from the content edge — the same center line
            as the account row's 32px RailIconButton glyphs. */}
        <Tooltip
          label={trailingAction.title ?? trailingAction.ariaLabel}
          className="-mr-1.5"
        >
          <Button
            variant="ghost-quiet"
            size="sm"
            iconOnly
            onClick={trailingAction.onClick}
            aria-label={trailingAction.ariaLabel}
            data-testid={trailingAction.testId}
          >
            {trailingAction.icon}
          </Button>
        </Tooltip>
      </div>
    );
  }

  if (onClick) {
    return (
      <Tooltip
        label={title}
        suppressed={title === undefined}
        className="w-full"
      >
        <button
          type="button"
          onClick={onClick}
          aria-label={ariaLabel}
          className={classes}
          data-testid={testId}
        >
          {children}
        </button>
      </Tooltip>
    );
  }

  return (
    <div
      className={classes}
      title={typeof title === 'string' ? title : undefined}
      data-testid={testId}
      // Non-interactive banners with an accessible label are live statuses
      // (e.g. update download progress); unlabeled ones are decorative.
      role={ariaLabel ? 'status' : undefined}
      aria-label={ariaLabel}
    >
      {children}
    </div>
  );
}

export type SidebarFooterBannerIconTone =
  | 'secondary'
  | 'accent'
  | 'warning'
  | 'destructive';

/**
 * The banner's 20px leading slot, 6px from the card edge, so every banner's
 * label starts on the same line. The glyph's ink carries the state; the label
 * stays `fg-primary`.
 */
export function SidebarFooterBannerIcon({
  tone = 'secondary',
  children,
}: {
  tone?: SidebarFooterBannerIconTone;
  children: ReactNode;
}): JSX.Element {
  const toneClassName =
    tone === 'accent'
      ? 'fg-accent'
      : tone === 'warning'
        ? 'fg-warning'
        : tone === 'destructive'
          ? 'fg-destructive'
          : 'fg-secondary';
  return (
    <span
      data-testid="sidebar-footer-banner-icon"
      className={`ml-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center ${toneClassName}`}
    >
      {children}
    </span>
  );
}
