import {
  useCallback,
  useEffect,
  useId,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { getWindow } from '../panels/window-registry';
import {
  formatCost,
  formatDuration,
  formatTokenCount,
} from '../lib/format-usage';
import {
  UsageActionRow,
  UsageDisclosureChevron,
  USAGE_DISCLOSURE_ROW_CLASS,
  USAGE_DISCLOSURE_INK_CLASS,
} from './UsageIndicatorActions';
import { CONTEXT_SERIES_COLORS } from '../lib/usage-series-colors';
import { DropdownMenuSurface } from './DropdownMenu';
import { SegmentedControl } from './SegmentedControl';
import { COMPOSER_ROW_MENU_GAP } from './FloatingMenu';
import { UsageMeter, formatUsagePercent } from './usage-indicator-meter';
import type {
  UsageIndicatorUsage,
  UsageIndicatorResponse,
  UsageIndicatorContextBreakdown,
} from './UsageIndicator';

/**
 * Popover contents before the first reply when the chat has no context window
 * to draw an empty bar against. Points forward at what fills the meter rather
 * than at the absence.
 */
const EMPTY_USAGE_HINT = 'Usage appears after the first reply.';

function isEmptyUsage(usage: UsageIndicatorUsage): boolean {
  return (
    usage.numTurns === 0 &&
    usage.contextTokens === 0 &&
    usage.inputTokens === 0 &&
    usage.outputTokens === 0
  );
}

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: string;
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <dt className="fg-secondary">{label}</dt>
      <dd className="min-w-0 truncate tabular-nums fg-primary">{value}</dd>
    </div>
  );
}

function PopoverDivider(): JSX.Element {
  // `border-*` color utilities are inert (CAN-2734); paint the hairline: one
  // device pixel in the quietest line role, with 16px of room either side
  // (the section gap plus this margin). The bottom margin takes a second
  // hairline so the divider's box is whole CSS pixels: a half-pixel box
  // shifts everything under it, and the footer band's own hairline then
  // falls between device pixels and disappears.
  return (
    <div
      aria-hidden="true"
      className="mb-[calc(0.25rem+var(--border-hairline))] mt-1 h-[var(--border-hairline)] shrink-0 bg-line-quaternary"
    />
  );
}

/** A category's colour: a chart series for content, neutrals for the rest. */
function contextCategoryColor(
  kind: UsageIndicatorContextBreakdown['categories'][number]['kind'],
  usedIndex: number,
): string {
  if (kind === 'used') {
    return (
      CONTEXT_SERIES_COLORS[usedIndex % CONTEXT_SERIES_COLORS.length] ??
      'var(--fg-secondary)'
    );
  }
  if (kind === 'buffer') return 'var(--fg-tertiary)';
  return 'var(--bg-muted)';
}

function formatContextShare(tokens: number, maxTokens: number): string {
  const share = maxTokens > 0 ? (tokens / maxTokens) * 100 : 0;
  if (share > 0 && share < 0.1) return '<0.1%';
  return `${share.toFixed(1)}%`;
}

/**
 * The context meter split into its categories: each part of the window in
 * use takes its own series colour, the compaction reserve a neutral, and the
 * free space stays the empty track.
 */
function ContextBreakdownMeter({
  breakdown,
}: {
  breakdown: UsageIndicatorContextBreakdown;
}): JSX.Element {
  let usedIndex = -1;
  return (
    <div
      role="img"
      aria-label="Context window by category"
      className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-fg-primary/[0.08]"
    >
      {breakdown.categories.map((category) => {
        if (category.kind === 'used') usedIndex += 1;
        if (
          category.tokens <= 0 ||
          category.kind === 'free' ||
          category.kind === 'deferred'
        ) {
          return null;
        }
        const width = (category.tokens / breakdown.maxTokens) * 100;
        return (
          <span
            key={category.name}
            className="h-full shrink-0"
            style={{
              width: `${Math.min(width, 100)}%`,
              backgroundColor: contextCategoryColor(category.kind, usedIndex),
            }}
          />
        );
      })}
    </div>
  );
}

/**
 * The meter's legend: one row per category in the window with its tokens and
 * share. Tool definitions that load only when needed take no room in the
 * window, so they are left out.
 */
function ContextBreakdownList({
  breakdown,
}: {
  breakdown: UsageIndicatorContextBreakdown;
}): JSX.Element {
  let usedIndex = -1;
  return (
    <dl
      data-testid="usage-indicator-context-breakdown"
      className="flex flex-col gap-1"
    >
      {breakdown.categories.map((category) => {
        if (category.kind === 'used') usedIndex += 1;
        if (category.tokens <= 0 || category.kind === 'deferred') return null;
        return (
          <div key={category.name} className="flex items-center gap-2 text-xs">
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-xs"
              style={{
                backgroundColor: contextCategoryColor(category.kind, usedIndex),
              }}
            />
            <dt className="min-w-0 flex-1 truncate fg-primary">
              {category.name}
            </dt>
            <dd className="tabular-nums fg-secondary">
              {formatTokenCount(category.tokens)}
            </dd>
            <dd className="w-12 text-right tabular-nums fg-primary">
              {formatContextShare(category.tokens, breakdown.maxTokens)}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

type UsageDetailsView = 'context' | 'session';

const USAGE_DETAILS_VIEWS: readonly {
  readonly id: UsageDetailsView;
  readonly label: string;
}[] = [
  { id: 'context', label: 'Context' },
  { id: 'session', label: 'Session' },
];

function usageDetailsTabId(idPrefix: string, view: UsageDetailsView): string {
  return `${idPrefix}-tab-${view}`;
}

function usageDetailsPanelId(idPrefix: string, view: UsageDetailsView): string {
  return `${idPrefix}-panel-${view}`;
}

/**
 * Which list the expanded popover shows, one at a time: what fills the
 * context window, or the session's cost, turns, model and tokens. The shared
 * segmented picker, as tabs across the popover's width.
 */
function UsageDetailsTabs({
  value,
  onChange,
  idPrefix,
}: {
  value: UsageDetailsView;
  onChange: (next: UsageDetailsView) => void;
  idPrefix: string;
}): JSX.Element {
  return (
    <SegmentedControl
      value={value}
      options={USAGE_DETAILS_VIEWS.map((view) => ({
        value: view.id,
        label: view.label,
        dataTestId: `usage-indicator-details-${view.id}`,
        id: usageDetailsTabId(idPrefix, view.id),
        controls: usageDetailsPanelId(idPrefix, view.id),
      }))}
      onChange={onChange}
      label="Usage details"
      semantics="tabs"
      width="fill"
      dataTestId="usage-indicator-details-switch"
    />
  );
}

// ---------------------------------------------------------------------------
// UsagePopover — detail panel
// ---------------------------------------------------------------------------

/**
 * Placed above the meter, the popover is pinned by its BOTTOM edge, so
 * content that grows (the context breakdown opening) extends upward in the
 * same frame instead of spilling down over the composer until the next
 * measurement moves it. Below the meter it is pinned by its top edge.
 */
interface PopoverPosition {
  side: 'above' | 'below';
  /** `bottom` offset when above, `top` offset when below. */
  edge: number;
  left: number;
  maxHeight: number;
}

const POPOVER_WIDTH = 292; // w-73
const POPOVER_GAP = 8;
const VIEWPORT_PADDING = 8;

function computePopoverPosition(
  anchorEl: HTMLElement,
  popoverEl: HTMLElement | null,
  alignEl: HTMLElement | null,
): PopoverPosition {
  const rect = anchorEl.getBoundingClientRect();
  const popoverHeight = popoverEl ? popoverEl.offsetHeight : 0;
  // Aligned to the composer box, the popover joins the settings row's menus
  // at their 4px gap.
  const gap = alignEl ? COMPOSER_ROW_MENU_GAP : POPOVER_GAP;

  // Prefer placing above the anchor; flip below if not enough space
  const spaceAbove = rect.top - gap;
  const spaceBelow = getWindow(anchorEl).innerHeight - rect.bottom - gap;
  const above = spaceAbove >= popoverHeight || spaceAbove >= spaceBelow;
  const maxHeight = Math.max(
    0,
    (above ? spaceAbove : spaceBelow) - VIEWPORT_PADDING,
  );
  const edge = above
    ? getWindow(anchorEl).innerHeight - (rect.top - gap)
    : rect.bottom + gap;

  // Right-aligned to the meter, which sits at the trailing end of the
  // composer's status row, so the popover grows back over the composer. A
  // host's align element (the composer box) sets the right edge instead,
  // so the popover lines up with the box like the row's other menus.
  const width = popoverEl?.offsetWidth || POPOVER_WIDTH;
  const right = alignEl?.getBoundingClientRect().right ?? rect.right;
  const left = Math.min(
    Math.max(VIEWPORT_PADDING, right - width),
    getWindow(anchorEl).innerWidth - width - VIEWPORT_PADDING,
  );

  return { side: above ? 'above' : 'below', edge, left, maxHeight };
}

export default function UsagePopover({
  usage,
  modelLabel,
  percentage,
  isCodex,
  showContextWindow,
  responseUsage,
  accountUsage,
  onSeeDetails,
  contextBreakdown,
  costPreview,
  hideCost = false,
  anchorRef,
  alignRef,
  popoverRef,
}: {
  usage: UsageIndicatorUsage;
  modelLabel: string;
  percentage: number;
  isCodex: boolean;
  showContextWindow: boolean;
  responseUsage?: UsageIndicatorResponse;
  accountUsage?: ReactNode;
  onSeeDetails?: () => void;
  contextBreakdown?: UsageIndicatorContextBreakdown;
  costPreview?: ReactNode;
  hideCost?: boolean;
  anchorRef: React.RefObject<HTMLDivElement | null>;
  alignRef?: React.RefObject<HTMLElement | null>;
  popoverRef: React.RefObject<HTMLDivElement | null>;
}): JSX.Element {
  const [position, setPosition] = useState<PopoverPosition | null>(null);

  const updatePosition = useCallback((): void => {
    const anchorEl = anchorRef.current;
    if (!anchorEl) return;

    const next = computePopoverPosition(
      anchorEl,
      popoverRef.current,
      alignRef?.current ?? null,
    );
    setPosition((prev) => {
      if (
        prev &&
        prev.side === next.side &&
        prev.edge === next.edge &&
        prev.left === next.left &&
        prev.maxHeight === next.maxHeight
      )
        return prev;
      return next;
    });
  }, [alignRef, anchorRef, popoverRef]);

  useEffect(() => {
    updatePosition();
    // Track scroll/resize on the window the anchor lives in so the popover
    // stays put when the composer has been popped out to an aux window.
    const view = getWindow(anchorRef.current);
    const observer =
      typeof view.ResizeObserver === 'function'
        ? new view.ResizeObserver(updatePosition)
        : null;
    if (popoverRef.current) observer?.observe(popoverRef.current);
    view.addEventListener('resize', updatePosition);
    view.addEventListener('scroll', updatePosition, true);
    return (): void => {
      observer?.disconnect();
      view.removeEventListener('resize', updatePosition);
      view.removeEventListener('scroll', updatePosition, true);
    };
  }, [updatePosition, anchorRef, popoverRef]);

  const style: React.CSSProperties = {
    position: 'fixed',
    zIndex: 'var(--z-index-dropdown)',
    ...(position
      ? {
          ...(position.side === 'above'
            ? { bottom: position.edge }
            : { top: position.edge }),
          left: position.left,
          maxHeight: position.maxHeight,
          // Grows from the corner nearest the meter, like the row's menus.
          transformOrigin:
            position.side === 'above' ? 'bottom right' : 'top right',
        }
      : // Unplaced for its first measurement, so it never flashes at the
        // wrong spot before the entry motion starts.
        { visibility: 'hidden', pointerEvents: 'none' }),
  };

  // Codex app-server usage carries no cost of its own, so a Codex chat hides
  // the row unless the host priced the turn itself: cloud Core bills every
  // turn through the gateway and reports the figure regardless of harness.
  const showCost =
    !hideCost &&
    !responseUsage &&
    usage.totalCostUsd !== undefined &&
    (!isCodex || usage.totalCostUsd > 0);
  const showDuration =
    !responseUsage && !isCodex && usage.durationMs !== undefined;
  const showCacheWrite =
    !isCodex && usage.cacheCreationInputTokens !== undefined;

  // The session's figures fold under the Context row; without a
  // context meter there is nothing to fold them under, so they show inline.
  // Before the first reply every figure is 0, so none show at all.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsView, setDetailsView] = useState<UsageDetailsView>('context');
  const detailsId = useId();
  const hasFigures = !responseUsage && !isEmptyUsage(usage);
  const showFigures = hasFigures && (!showContextWindow || detailsOpen);
  const showSplit = detailsOpen && contextBreakdown !== undefined;
  // Before the first reply the Context row stands at zero over an empty bar,
  // so the popover keeps its shape. Without a window there is no bar to
  // draw, and a hint says what will fill it.
  const beforeFirstReply =
    !responseUsage && isEmptyUsage(usage) && !showContextWindow;
  const showEmptyContext = beforeFirstReply && usage.contextWindow > 0;
  const showEmptyHint = beforeFirstReply && usage.contextWindow <= 0;

  // The chat's cost, previewed under Context; the host supplies the row.
  const hasCostPreview =
    !hideCost &&
    costPreview !== undefined &&
    costPreview !== null &&
    !responseUsage;
  const costRow = hasCostPreview ? costPreview : null;

  const sessionFigures = (
    <dl data-testid="usage-indicator-details" className="flex flex-col gap-1">
      {showCost && !hasCostPreview ? (
        <DetailRow label="Cost" value={formatCost(usage.totalCostUsd ?? 0)} />
      ) : null}
      {showDuration && (
        <DetailRow
          label="Duration"
          value={formatDuration(usage.durationMs ?? 0)}
        />
      )}
      <DetailRow label="Turns" value={String(usage.numTurns)} />
      {modelLabel && <DetailRow label="Model" value={modelLabel} />}
      <DetailRow label="Input" value={formatTokenCount(usage.inputTokens)} />
      <DetailRow label="Output" value={formatTokenCount(usage.outputTokens)} />
      <DetailRow
        label="Cache read"
        value={formatTokenCount(usage.cacheReadInputTokens)}
      />
      {showCacheWrite && (
        <DetailRow
          label="Cache write"
          value={formatTokenCount(usage.cacheCreationInputTokens ?? 0)}
        />
      )}
    </dl>
  );

  return (
    <DropdownMenuSurface
      ref={popoverRef}
      role="dialog"
      aria-label="Usage"
      padding="readout"
      data-canopy-browser-native-overlay="true"
      data-testid="usage-indicator-popover"
      // The shared floating-surface entry motion (scale and fade), which
      // starts once the popover is placed, as the settings row's menus do.
      data-positioned={position ? 'true' : 'false'}
      // A readout, not text to copy: no selection, as in the effort panel.
      // 292px: the widest row (a weekly limit's name, its reset time and the
      // percent) fits without truncating.
      className="canopy-floating-menu w-73 select-none overflow-y-auto"
      style={style}
    >
      <div className="flex flex-col gap-3">
        {responseUsage && (
          <>
            <div className="flex flex-col gap-1">
              <span className="text-xs fg-primary">
                {responseUsage.title ?? 'Response tokens'}
              </span>
              <p
                className="text-xs fg-secondary"
                data-testid="usage-indicator-response-hint"
              >
                {responseUsage.message}
              </p>
            </div>
            {(modelLabel || responseUsage.usage) && (
              <dl className="flex flex-col gap-1">
                {modelLabel && <DetailRow label="Model" value={modelLabel} />}
                {responseUsage.usage && (
                  <>
                    <DetailRow
                      label="Input"
                      value={formatTokenCount(responseUsage.usage.inputTokens)}
                    />
                    <DetailRow
                      label="Output"
                      value={formatTokenCount(responseUsage.usage.outputTokens)}
                    />
                    {responseUsage.usage.reasoningTokens !== undefined && (
                      <DetailRow
                        label="Reasoning"
                        value={formatTokenCount(
                          responseUsage.usage.reasoningTokens,
                        )}
                      />
                    )}
                    {!hideCost &&
                      responseUsage.usage.estimatedCostUsd !== undefined && (
                        <DetailRow
                          label="Estimated cost"
                          value={formatCost(
                            responseUsage.usage.estimatedCostUsd,
                          )}
                        />
                      )}
                    {responseUsage.usage.cacheReadTokens !== undefined && (
                      <DetailRow
                        label="Cache read"
                        value={formatTokenCount(
                          responseUsage.usage.cacheReadTokens,
                        )}
                      />
                    )}
                    {responseUsage.usage.cacheWriteTokens !== undefined && (
                      <DetailRow
                        label="Cache write"
                        value={formatTokenCount(
                          responseUsage.usage.cacheWriteTokens,
                        )}
                      />
                    )}
                  </>
                )}
              </dl>
            )}
            {responseUsage.context && (
              <div className="flex flex-col gap-1.5">
                <dl>
                  <DetailRow
                    label="Reported context"
                    value={`${formatTokenCount(responseUsage.context.usedTokens)} / ${formatTokenCount(responseUsage.context.maxTokens)}`}
                  />
                </dl>
                <UsageMeter
                  percentage={Math.min(
                    100,
                    (responseUsage.context.usedTokens /
                      responseUsage.context.maxTokens) *
                      100,
                  )}
                  label="Reported context used"
                />
              </div>
            )}
            <p className="text-xs fg-secondary">{responseUsage.note}</p>
          </>
        )}
        {showEmptyHint && (
          <p
            className="text-xs fg-secondary"
            data-testid="usage-indicator-empty-hint"
          >
            {EMPTY_USAGE_HINT}
          </p>
        )}
        {showEmptyContext && (
          // The Context row at zero. It names no window or share: a seeded
          // window is the model's configuration, not what the runtime
          // reported. There is nothing to expand yet, so no chevron.
          <div
            data-testid="usage-indicator-context-empty"
            className="flex flex-col gap-1.5"
          >
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="whitespace-nowrap fg-primary">Context</span>
              <span className="whitespace-nowrap tabular-nums fg-secondary">
                {formatTokenCount(usage.contextTokens)}
              </span>
            </div>
            <UsageMeter percentage={0} label="Context window used" />
          </div>
        )}
        {showContextWindow && (
          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              onClick={(): void => setDetailsOpen((value) => !value)}
              aria-expanded={detailsOpen}
              aria-controls={detailsId}
              data-testid="usage-indicator-context"
              // No hover surface: the row's text brightens instead, and the
              // pickers' own chevron turns over as the details open.
              className={`${USAGE_DISCLOSURE_ROW_CLASS} items-center justify-between gap-3`}
            >
              {/* "Context", not "Context window": at 292px the longest
                  numbers ("999.9k / 999.9k (100%)") and the chevron still
                  fit on one line beside it. */}
              <span className="whitespace-nowrap fg-primary">Context</span>
              <span
                className={`flex items-center gap-1 whitespace-nowrap tabular-nums ${USAGE_DISCLOSURE_INK_CLASS}`}
              >
                {formatTokenCount(usage.contextTokens)} /{' '}
                {formatTokenCount(usage.contextWindow)} (
                {formatUsagePercent(percentage)})
                <UsageDisclosureChevron open={detailsOpen} />
              </span>
            </button>
            {contextBreakdown ? (
              <ContextBreakdownMeter breakdown={contextBreakdown} />
            ) : (
              <UsageMeter percentage={percentage} label="Context window used" />
            )}
          </div>
        )}
        {!showContextWindow && costRow}
        {(showSplit || showFigures) && (
          // What the Context row expands: with a category split, tabs
          // between it and the session's figures; else the figures.
          <div
            id={detailsId}
            data-testid="usage-indicator-expanded"
            className="flex flex-col gap-3"
          >
            {showSplit && showFigures && contextBreakdown ? (
              <>
                <UsageDetailsTabs
                  value={detailsView}
                  onChange={setDetailsView}
                  idPrefix={detailsId}
                />
                {/* Both lists share one cell, so the popover keeps its
                    height as the tabs flip between them. They cross-fade
                    with a 4px slide toward the side picked: the one leaving
                    fades out in half the time the new one takes to settle,
                    and stays visible until its fade ends. */}
                <div className="grid">
                  <div
                    role="tabpanel"
                    id={usageDetailsPanelId(detailsId, 'context')}
                    aria-labelledby={usageDetailsTabId(detailsId, 'context')}
                    data-usage-view="context"
                    aria-hidden={detailsView !== 'context'}
                    className={`col-start-1 row-start-1 transition-[opacity,translate,visibility] ease-out motion-reduce:transition-none ${
                      detailsView === 'context'
                        ? 'translate-x-0 opacity-100 duration-200'
                        : 'invisible -translate-x-1 opacity-0 duration-100'
                    }`}
                  >
                    <ContextBreakdownList breakdown={contextBreakdown} />
                  </div>
                  <div
                    role="tabpanel"
                    id={usageDetailsPanelId(detailsId, 'session')}
                    aria-labelledby={usageDetailsTabId(detailsId, 'session')}
                    data-usage-view="session"
                    aria-hidden={detailsView !== 'session'}
                    className={`col-start-1 row-start-1 transition-[opacity,translate,visibility] ease-out motion-reduce:transition-none ${
                      detailsView === 'session'
                        ? 'translate-x-0 opacity-100 duration-200'
                        : 'invisible translate-x-1 opacity-0 duration-100'
                    }`}
                  >
                    {sessionFigures}
                  </div>
                </div>
              </>
            ) : showSplit && contextBreakdown ? (
              <ContextBreakdownList breakdown={contextBreakdown} />
            ) : (
              showFigures && sessionFigures
            )}
          </div>
        )}
        {/* Cost follows Context and whatever Context expands, so each
            row's details stay attached to it. */}
        {showContextWindow && costRow}
        {accountUsage && (
          <>
            <PopoverDivider />
            {accountUsage}
          </>
        )}
        {onSeeDetails && (
          // A footer band under the popover's usual inset divider; the band
          // takes the quaternary surface, bleeding past the popover's 12px inset. It
          // stops one hairline short of the edge so the surface's inset rim
          // (part of its shadow, painted under content) still shows, and its
          // corners follow the surface's radius less that hairline.
          <div className="mx-[calc(var(--border-hairline)-0.75rem)] mb-[calc(var(--border-hairline)-0.75rem)] mt-1 flex flex-col overflow-hidden rounded-b-[calc(var(--radius-lg)-var(--border-hairline))]">
            <div
              aria-hidden="true"
              // Inset like the popover's other dividers: back to the 12px
              // content edge from the band's near-full bleed.
              className="mx-[calc(0.75rem-var(--border-hairline))] h-[var(--border-hairline)] shrink-0 bg-line-quaternary"
            />
            {/* The whole band is the link: hovering anywhere on it lights the
                label and its chevron. The band's clipped corners would cut a
                focus ring, so keyboard focus tints the band instead. */}
            <UsageActionRow
              label="See detailed breakdown"
              onClick={onSeeDetails}
              testId="usage-indicator-see-details"
              band
            />
          </div>
        )}
      </div>
    </DropdownMenuSurface>
  );
}
