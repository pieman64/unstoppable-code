import { type JSX } from 'react';
import type { PortalProviderUsageAuthState as ProviderAuthState } from '@canopy/protocol/portal';
import { StatusBadge } from './StatusBadge';
import { RefreshSpinner } from './RefreshSpinner';
import { Tooltip } from './Tooltip';

export interface UsageCardHeaderProps {
  /** Leading logo/icon rendered inline with the title. */
  icon: JSX.Element;
  /** Card title — provider name or brand app name. */
  title: string;
  /**
   * Overrides the heading's accessible name when the visible title alone does
   * not identify the card. The AI Credits card sets this because its visible
   * title is just the brand app name and its icon is `aria-hidden`, so heading
   * navigation would otherwise lose the "AI Credits" landmark.
   */
  accessibleTitle?: string;
  /** Plain-text auth word (e.g. `authenticated`, `guest`). Stays outside the
   * pill so automation can poll the page for the literal word. */
  authState: ProviderAuthState | 'guest';
  /** Replaces the auth word when another source's state applies. */
  authLabel?: string;
  /** Plan name rendered as a pill after the auth word. Omitted → no pill. */
  planLabel?: string;
  /**
   * Whether the plan named in {@link planLabel} is currently in effect — the
   * single meaning of the pill color across all three cards. Green (`success`)
   * when true, neutral grey (`muted`) otherwise.
   *
   * The provider cards derive it from auth state (an unauthenticated provider
   * has no plan in effect); the AI Credits card derives it from the resolved
   * subscription kind. Both answer the same question.
   */
  planActive: boolean;
  /**
   * Last successful refresh, in either shape the two callers already hold:
   * an ISO string (`ProviderUsageSummary.lastUpdatedAt`) or epoch
   * milliseconds (`useAiCreditsUsage().lastUpdatedAt`, which is `number | null`).
   * Anything falsy renders the `No update` placeholder.
   */
  lastUpdatedAt?: string | number | null;
  refreshing: boolean;
  /** A host that cannot refresh leaves the last snapshot readable. */
  refreshDisabled?: boolean;
  onRefresh: () => void;
  /** Accessible label/tooltip for the refresh button. */
  refreshLabel: string;
  planChipTestId?: string;
  /** Panel density: trims the title size. */
  compact?: boolean;
  /** Frameless (panel) density: trims the subtitle size. */
  frameless?: boolean;
}

/**
 * Shared header for every Usage card (Claude, Codex, AI Credits), so all three
 * read identically:
 *
 * ```
 * <logo>  <Name>
 * authenticated · (Plan name)
 * ```
 *
 * Written once here rather than inline per card — the markup had already
 * drifted between {@link ProviderUsageCards} and {@link AiCreditsUsageCard}.
 * The plan pill reuses `StatusBadge` from `@canopy/ui-shared` rather than
 * rebuilding pill chrome.
 */
export function UsageCardHeader({
  icon,
  title,
  accessibleTitle,
  authState,
  authLabel,
  planLabel,
  planActive,
  lastUpdatedAt,
  refreshing,
  refreshDisabled = false,
  onRefresh,
  refreshLabel,
  planChipTestId,
  compact = false,
  frameless = false,
}: UsageCardHeaderProps): JSX.Element {
  return (
    // items-start pulls the refresh time + button up level with the title's
    // top row (both the page and the panel).
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2
          aria-label={accessibleTitle}
          className={`flex items-center gap-2 font-semibold fg-primary ${
            compact ? 'text-m' : 'text-lg'
          }`}
        >
          {icon}
          {title}
        </h2>
        {/* overflow-hidden keeps a long plan label from escaping the left
            column toward the timestamp pill / refresh button: StatusBadge is
            `shrink-0`, so without it the badge would overflow the card instead
            of being clipped inside it.
            The auth word is `shrink-0` on purpose: it is a short fixed
            vocabulary and the more important token to keep legible, so overflow
            pressure lands on the plan badge, which clips at the column edge
            instead. (Automation is unaffected either way — `textContent` reads
            CSS-clipped text fine.) Known limitation: the badge clips rather
            than ellipsizing, because StatusBadge is `inline-flex shrink-0` and
            its `className` prop replaces the chrome rather than extending it,
            so a truncating override would drop the color palette. */}
        <p
          className={`flex min-w-0 items-center gap-1.5 overflow-hidden fg-secondary ${
            frameless ? 'text-xs' : 'text-s'
          }`}
        >
          <span className="shrink-0">{authLabel ?? authState}</span>
          {planLabel && (
            <>
              <span aria-hidden="true">·</span>
              <StatusBadge
                variant={planActive ? 'success' : 'muted'}
                label={planLabel}
                dataTestId={planChipTestId}
              />
            </>
          )}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-secondary px-2 py-1 text-xs fg-secondary">
          {lastUpdatedAt
            ? new Date(lastUpdatedAt).toLocaleTimeString()
            : 'No update'}
        </span>
        <Tooltip label={refreshLabel}>
          <button
            type="button"
            className="rounded-full p-1.5 fg-secondary transition-colors hover:bg-secondary hover:fg-primary disabled:opacity-50"
            aria-label={refreshLabel}
            disabled={refreshing || refreshDisabled}
            onClick={onRefresh}
          >
            <RefreshSpinner spinning={refreshing} size={14} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
