'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  PrBadgeTooltipContent,
  RichHoverTooltip,
  Tooltip,
} from '@canopy/ui-shared/components';
import {
  GitDraftIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { OPERATIONAL_STATUS_COLORS } from '@canopy/ui-shared/lib';
import type {
  PullRequestSectionCheckDetail,
  PullRequestSectionCheckStatus,
  PullRequestSectionPrState,
} from '../activity/PullRequestSectionBody';
import { CheckDetailsList } from './CheckDetailsList';
import { getCheckStatusLabel } from './pull-request-actions-copy';
import type {
  PullRequestActionsPr,
  PullRequestActionsRepo,
} from './pull-request-actions-plan';

/**
 * Header PR + CI badges (REG-3025, moved from the desktop `PrStatusBar`).
 *
 * Both read as one line of status: STATE lives in the colour of a small
 * leading glyph, and the text stays `fg-primary` so it is legible rather than
 * tinted. The PR badge dropped its pill and the redundant "PR" word — the
 * icon already says what it is — leaving just `#1234`.
 */

interface PrStateBadgeProps {
  readonly state: PullRequestSectionPrState;
  readonly prNumber: number;
  readonly prUrl?: string | null;
}

/** Per-state glyph + tint. The glyph carries the state, not the label. */
const PR_STATE_ICON: Record<
  PullRequestSectionPrState,
  { Icon: typeof GitPullRequestIcon; className: string; label: string }
> = {
  open: {
    Icon: GitPullRequestIcon,
    className: OPERATIONAL_STATUS_COLORS.success.foreground,
    label: 'open',
  },
  merged: {
    Icon: GitMergeIcon,
    className: OPERATIONAL_STATUS_COLORS.merged.foreground,
    label: 'merged',
  },
  closed: {
    Icon: GitPullRequestClosedIcon,
    className: OPERATIONAL_STATUS_COLORS.failed.foreground,
    label: 'closed',
  },
  draft: { Icon: GitDraftIcon, className: 'fg-secondary', label: 'draft' },
};

export function PrStateBadge({
  state,
  prNumber,
  prUrl,
}: PrStateBadgeProps): JSX.Element {
  const { Icon, className: iconClassName, label } = PR_STATE_ICON[state];
  const className =
    'electron-no-drag inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-normal fg-primary transition-colors';
  const content = (
    <>
      <Icon size={16} className={`shrink-0 ${iconClassName}`} />#{prNumber}
    </>
  );

  if (prUrl) {
    return (
      <a
        href={prUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Pull request #${prNumber} (${label})`}
        className={`${className} hover:bg-subtle`}
      >
        {content}
      </a>
    );
  }

  return (
    <span
      aria-label={`Pull request #${prNumber} (${label})`}
      className={className}
    >
      {content}
    </span>
  );
}

interface CiStatusBadgeProps {
  readonly status: PullRequestSectionCheckStatus;
}

/**
 * CI state as a filled dot, the same vocabulary — and the same 6px size — the
 * app's other indicator dots use (the filter-active dots on the Projects
 * header menu / `FileLabelFilterDropdown`), with the label left
 * plain (`CI`, no colon) in `fg-primary`.
 */
const CI_STATUS_DOT: Record<PullRequestSectionCheckStatus, { dot: string }> = {
  passing: { dot: OPERATIONAL_STATUS_COLORS.success.background },
  failing: { dot: OPERATIONAL_STATUS_COLORS.failed.background },
  // Grey, but pulsing: colour is reserved for OUTCOMES (green/red), so a
  // check still running says so through motion instead — the same
  // `animate-pulse` dots the sidebar uses for in-flight work.
  pending: { dot: 'bg-fg-quaternary animate-pulse' },
  neutral: { dot: 'bg-fg-quaternary' },
  none: { dot: 'bg-fg-quaternary' },
};

export function CiStatusBadge({ status }: CiStatusBadgeProps): JSX.Element {
  const { dot } = CI_STATUS_DOT[status];

  return (
    <span
      // The dot carries the state and the visible text is just `CI`, so the
      // badge is announced as one labelled image rather than a bare "CI".
      role="img"
      aria-label={getCheckStatusLabel(status)}
      // Same hover affordance as the PR badge beside it: both open something
      // on hover, so both have to look reachable.
      // Same `px-2.5` shell as the PR badge and every header action button:
      // one padding value across the whole row beats per-control optical
      // nudges (an earlier `pr-1.5` here balanced this badge's own ink but
      // made it the odd one out in the container).
      className="electron-no-drag inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-xs font-normal fg-primary transition-colors hover:bg-subtle"
    >
      <span
        aria-hidden="true"
        className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dot}`}
      />
      CI
    </span>
  );
}

// ---------------------------------------------------------------------------
// Popovers – the per-check CI list and the multi-repo PR list. Each keeps a
// short close delay plus trigger/popover hover refs so the cursor can travel
// into the popover (and scroll long lists) without it dismissing.
// ---------------------------------------------------------------------------

const POPOVER_BRIDGE_PX = 6;

function usePopoverLayout(
  anchorRect: DOMRect,
  contentKey: unknown,
): {
  cardRef: RefObject<HTMLDivElement | null>;
  layout: { top: number; left: number; placeAbove: boolean };
} {
  const cardRef = useRef<HTMLDivElement>(null);
  // `placeAbove` flips the bridge to the bottom of the card when the popover
  // would otherwise overflow the viewport vertically and gets placed above the
  // anchor. The wrapper top is set to anchorRect.bottom (or anchorRect.top)
  // with no gap so the cursor never lands in dead space.
  const [layout, setLayout] = useState<{
    top: number;
    left: number;
    placeAbove: boolean;
  }>({
    top: anchorRect.bottom,
    left: anchorRect.left,
    placeAbove: false,
  });

  useLayoutEffect((): void => {
    const card = cardRef.current;
    if (!card) return;
    const cardRect = card.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const totalHeight = cardRect.height + POPOVER_BRIDGE_PX;
    let left = anchorRect.left;
    if (left + cardRect.width > vw) left = vw - cardRect.width - 8;
    if (left < 8) left = 8;
    const wouldOverflowBelow = anchorRect.bottom + totalHeight > vh;
    const fitsAbove = anchorRect.top - totalHeight >= 0;
    const placeAbove = wouldOverflowBelow && fitsAbove;
    const top = placeAbove ? anchorRect.top - totalHeight : anchorRect.bottom;
    setLayout({ top, left, placeAbove });
  }, [anchorRect, contentKey]);

  return { cardRef, layout };
}

interface CheckDetailsPopoverProps {
  readonly anchorRect: DOMRect;
  readonly checkDetails: readonly PullRequestSectionCheckDetail[];
  readonly onMouseEnter: () => void;
  readonly onMouseLeave: () => void;
  readonly dataTestId?: string;
}

function CheckDetailsPopover({
  anchorRect,
  checkDetails,
  onMouseEnter,
  onMouseLeave,
  dataTestId = 'pr-status-bar-ci-popover',
}: CheckDetailsPopoverProps): JSX.Element {
  const { cardRef, layout } = usePopoverLayout(anchorRect, checkDetails);

  return createPortal(
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="fixed z-dropdown"
      style={{ top: layout.top, left: layout.left }}
      data-testid={dataTestId}
    >
      {!layout.placeAbove && <div style={{ height: POPOVER_BRIDGE_PX }} />}
      <div
        ref={cardRef}
        className="min-w-65 max-w-105 rounded-lg bg-popover px-3 py-2 shadow-lg"
      >
        <CheckDetailsList checkDetails={checkDetails} scrollable />
      </div>
      {layout.placeAbove && <div style={{ height: POPOVER_BRIDGE_PX }} />}
    </div>,
    document.body,
  );
}

/**
 * Hover state for a trigger and the popover it opens, plus any nested
 * popovers inside it: hides only after a grace period with none hovered.
 * Survives re-renders (status polls arrive often) and brief traversals.
 */
function useHoverPopover(enabled: boolean): {
  rect: DOMRect | null;
  onTriggerEnter: (element: HTMLElement) => void;
  onTriggerLeave: () => void;
  onPopoverEnter: () => void;
  onPopoverLeave: () => void;
  onNestedEnter: () => void;
  onNestedLeave: () => void;
} {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const triggerRef = useRef(false);
  const popoverRef = useRef(false);
  const nestedRef = useRef(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHideTimer = useCallback((): void => {
    if (hideTimerRef.current !== null) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);
  const evaluate = useCallback((): void => {
    clearHideTimer();
    if (triggerRef.current || popoverRef.current || nestedRef.current) return;
    hideTimerRef.current = setTimeout((): void => {
      hideTimerRef.current = null;
      // Re-check at fire time in case the user re-entered during the delay.
      if (triggerRef.current || popoverRef.current || nestedRef.current) {
        return;
      }
      setRect(null);
    }, 250);
  }, [clearHideTimer]);

  useEffect((): void => {
    if (enabled) return;
    clearHideTimer();
    triggerRef.current = false;
    popoverRef.current = false;
    nestedRef.current = false;
    setRect(null);
  }, [enabled, clearHideTimer]);
  useEffect((): (() => void) => clearHideTimer, [clearHideTimer]);

  return {
    rect,
    onTriggerEnter: useCallback(
      (element: HTMLElement): void => {
        triggerRef.current = true;
        if (enabled) setRect(element.getBoundingClientRect());
        evaluate();
      },
      [enabled, evaluate],
    ),
    onTriggerLeave: useCallback((): void => {
      triggerRef.current = false;
      evaluate();
    }, [evaluate]),
    onPopoverEnter: useCallback((): void => {
      popoverRef.current = true;
      evaluate();
    }, [evaluate]),
    onPopoverLeave: useCallback((): void => {
      popoverRef.current = false;
      evaluate();
    }, [evaluate]),
    onNestedEnter: useCallback((): void => {
      nestedRef.current = true;
      evaluate();
    }, [evaluate]),
    onNestedLeave: useCallback((): void => {
      nestedRef.current = false;
      evaluate();
    }, [evaluate]),
  };
}

interface CiStatusBadgeWithPopoverProps {
  readonly status: PullRequestSectionCheckStatus;
  readonly checkDetails: readonly PullRequestSectionCheckDetail[];
  readonly badgeTestId?: string;
  readonly popoverTestId?: string;
  readonly onPopoverMouseEnter?: () => void;
  readonly onPopoverMouseLeave?: () => void;
}

export function CiStatusBadgeWithPopover({
  status,
  checkDetails,
  badgeTestId = 'pr-status-bar-ci-badge',
  popoverTestId = 'pr-status-bar-ci-popover',
  onPopoverMouseEnter,
  onPopoverMouseLeave,
}: CiStatusBadgeWithPopoverProps): JSX.Element {
  const hover = useHoverPopover(checkDetails.length > 0);
  const { onPopoverEnter, onPopoverLeave } = hover;
  const handlePopoverEnter = useCallback((): void => {
    onPopoverMouseEnter?.();
    onPopoverEnter();
  }, [onPopoverEnter, onPopoverMouseEnter]);
  const handlePopoverLeave = useCallback((): void => {
    onPopoverMouseLeave?.();
    onPopoverLeave();
  }, [onPopoverLeave, onPopoverMouseLeave]);

  return (
    <>
      {/* The rich check list is the real preview, but it only exists when the
          provider actually returned per-check details. Without this fallback
          the badge is silent on hover in exactly the states where the dot
          alone is least self-explanatory (neutral, not run, a status with no
          detail payload). Suppressed once the popover can take over. */}
      <Tooltip
        label={getCheckStatusLabel(status)}
        suppressed={checkDetails.length > 0}
      >
        <span
          className="electron-no-drag inline-flex"
          onMouseEnter={(event): void =>
            hover.onTriggerEnter(event.currentTarget)
          }
          onMouseLeave={hover.onTriggerLeave}
          data-testid={badgeTestId}
        >
          <CiStatusBadge status={status} />
        </span>
      </Tooltip>
      {hover.rect && checkDetails.length > 0 && (
        <CheckDetailsPopover
          anchorRect={hover.rect}
          checkDetails={checkDetails}
          onMouseEnter={handlePopoverEnter}
          onMouseLeave={handlePopoverLeave}
          dataTestId={popoverTestId}
        />
      )}
    </>
  );
}

/** The single repository's PR badge, with its rich hover card. */
export function PullRequestStateBadgeWithTooltip({
  pr,
  dataTestId = 'pr-status-bar-pr-tooltip',
}: {
  readonly pr: PullRequestActionsPr;
  readonly dataTestId?: string;
}): JSX.Element {
  return (
    <RichHoverTooltip
      dataTestId={dataTestId}
      surfaceClassName="min-w-65 max-w-85"
      surfacePadding="card"
      disabled={!pr.tooltip}
      content={pr.tooltip ? <PrBadgeTooltipContent pr={pr.tooltip} /> : null}
    >
      <PrStateBadge state={pr.state} prNumber={pr.number} prUrl={pr.url} />
    </RichHoverTooltip>
  );
}

function RepoPrStatusRow({
  repo,
  pr,
  onNestedPopoverMouseEnter,
  onNestedPopoverMouseLeave,
}: {
  readonly repo: PullRequestActionsRepo;
  readonly pr: PullRequestActionsPr;
  readonly onNestedPopoverMouseEnter: () => void;
  readonly onNestedPopoverMouseLeave: () => void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="min-w-0 flex-1 truncate fg-primary">
        {repo.repoName}
      </span>
      <PullRequestStateBadgeWithTooltip
        pr={pr}
        dataTestId={`pr-status-bar-repo-pr-tooltip-${repo.repoId}`}
      />
      <CiStatusBadgeWithPopover
        status={pr.checkStatus}
        checkDetails={pr.checkDetails}
        badgeTestId={`pr-status-bar-repo-ci-badge-${repo.repoId}`}
        popoverTestId={`pr-status-bar-repo-ci-popover-${repo.repoId}`}
        onPopoverMouseEnter={onNestedPopoverMouseEnter}
        onPopoverMouseLeave={onNestedPopoverMouseLeave}
      />
    </div>
  );
}

function RepoPrStatusPopover({
  anchorRect,
  repos,
  onMouseEnter,
  onMouseLeave,
  onNestedPopoverMouseEnter,
  onNestedPopoverMouseLeave,
}: {
  readonly anchorRect: DOMRect;
  readonly repos: readonly PullRequestActionsRepo[];
  readonly onMouseEnter: () => void;
  readonly onMouseLeave: () => void;
  readonly onNestedPopoverMouseEnter: () => void;
  readonly onNestedPopoverMouseLeave: () => void;
}): JSX.Element {
  const { cardRef, layout } = usePopoverLayout(anchorRect, repos);

  // React treats portaled descendants as part of the same event tree, so
  // returning from a nested portaled tooltip may not synthesize a fresh
  // mouseenter for this DOM parent. Pointer movement in the parent is the
  // authoritative handoff and cancels any pending close timer.
  return createPortal(
    <div
      onMouseEnter={onMouseEnter}
      onMouseMove={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="fixed z-dropdown"
      style={{ top: layout.top, left: layout.left }}
      data-testid="pr-status-bar-repo-popover"
    >
      {!layout.placeAbove && <div style={{ height: POPOVER_BRIDGE_PX }} />}
      <div
        ref={cardRef}
        className="min-w-70 max-w-120 rounded-lg bg-popover px-3 py-2 shadow-lg"
      >
        <div className="mb-1.5 text-3xs font-semibold fg-secondary">
          Pull requests
        </div>
        <div className="space-y-1.5">
          {repos.map((repo) =>
            repo.pr === null ? null : (
              <RepoPrStatusRow
                key={repo.repoId}
                repo={repo}
                pr={repo.pr}
                onNestedPopoverMouseEnter={onNestedPopoverMouseEnter}
                onNestedPopoverMouseLeave={onNestedPopoverMouseLeave}
              />
            ),
          )}
        </div>
      </div>
      {layout.placeAbove && <div style={{ height: POPOVER_BRIDGE_PX }} />}
    </div>,
    document.body,
  );
}

/**
 * The multi-repo `N PRs` badge: hovering lists each repository's PR and CI;
 * clicking opens the host's PR details.
 */
export function MultiRepoPrBadge({
  openRepos,
  onOpen,
}: {
  readonly openRepos: readonly PullRequestActionsRepo[];
  readonly onOpen: () => void;
}): JSX.Element {
  const hover = useHoverPopover(openRepos.length > 0);
  return (
    <>
      <button
        type="button"
        onClick={onOpen}
        onMouseEnter={(e): void => hover.onTriggerEnter(e.currentTarget)}
        onMouseLeave={hover.onTriggerLeave}
        className={`electron-no-drag inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors hover:opacity-90 ${
          openRepos.every((r) => r.pr?.state === 'merged')
            ? 'border-fg-special-strong/30 bg-special-subtle fg-special-strong'
            : 'border-fg-success-strong/30 bg-success-subtle fg-success-strong'
        }`}
      >
        {openRepos.length} {openRepos.length === 1 ? 'PR' : 'PRs'}
      </button>
      {hover.rect && openRepos.length > 0 && (
        <RepoPrStatusPopover
          anchorRect={hover.rect}
          repos={openRepos}
          onMouseEnter={hover.onPopoverEnter}
          onMouseLeave={hover.onPopoverLeave}
          onNestedPopoverMouseEnter={hover.onNestedEnter}
          onNestedPopoverMouseLeave={hover.onNestedLeave}
        />
      )}
    </>
  );
}
