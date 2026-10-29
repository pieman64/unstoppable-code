import type { JSX, ReactNode } from 'react';
import type {
  PortalProviderUsageAccount,
  PortalProviderUsageWindow,
} from '@canopy/protocol/portal';
import { LimitSubCardView, type UsageLimitCard } from './LimitSubCardView';
import { ProviderUsageAccountRow } from './ProviderUsageAccountRow';
import type { UsageIndicatorAccountSummaryProps } from './UsageIndicator';
import { ChevronRightMediumIcon } from '../icons/AppIcons';

const PASSIVE_SOURCE_LABEL = 'Reported by the account proxy';

/** A time of day for today, otherwise with its date. */
function when(at: string | number, nowMs: number): string | null {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toDateString() === new Date(nowMs).toDateString()
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
}

function fullTime(at: string): string | undefined {
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : undefined;
}

function windowCard(window: PortalProviderUsageWindow): UsageLimitCard {
  return {
    key: window.id,
    title: window.label,
    unlimited: window.unlimited,
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt,
    windowDurationMs: window.windowDurationMs,
    creditsAreCount: window.credits?.unit === 'credits',
    credits: window.credits
      ? {
          usedUsd: window.credits.spent,
          remainingUsd: window.credits.remaining,
          totalUsd: window.credits.total,
        }
      : undefined,
  };
}

/** How fresh an account's limits are, or undefined when nothing was read. */
function freshnessText(
  account: PortalProviderUsageAccount,
  nowMs: number,
): string | undefined {
  if (account.usageSource === 'passive') return PASSIVE_SOURCE_LABEL;
  if (account.usageSource === 'live' && account.lastUpdatedAt) {
    const time = when(account.lastUpdatedAt, nowMs);
    return time ? `Updated ${time}` : undefined;
  }
  return undefined;
}

/**
 * The failed read, whether older limits stay shown, and when asking again
 * is allowed. Nothing retries on its own, so the copy does not promise it.
 */
function errorText(
  account: PortalProviderUsageAccount,
  nowMs: number,
): string | undefined {
  if (!account.error) return undefined;
  let text = account.error.message;
  if (account.windows.length > 0) text += ' Showing last known usage.';
  if (account.retryAt) {
    const retryMs = new Date(account.retryAt).getTime();
    const time = when(account.retryAt, nowMs);
    if (Number.isFinite(retryMs) && retryMs > nowMs && time) {
      text += ` Try again after ${time}.`;
    }
  }
  return text;
}

/**
 * One line about an account's usage for compact surfaces: the failed read
 * first, otherwise how fresh the limits are.
 */
export function providerAccountUsageStatusText(
  account: PortalProviderUsageAccount,
  nowMs: number,
): string | undefined {
  return errorText(account, nowMs) ?? freshnessText(account, nowMs);
}

const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The window a folded account shows: its first 7-day window, which leads the
 * provider's scoped 7-day windows (`7-day Opus`), or its first window.
 */
export function providerAccountUsageLeadWindowId(
  account: PortalProviderUsageAccount,
): string | undefined {
  return (
    account.windows.find((window) => window.windowDurationMs === SEVEN_DAY_MS)
      ?.id ?? account.windows[0]?.id
  );
}

/** An account's windows as the composer popover's limit rows. */
export function providerAccountUsageSummaryLimits(
  account: PortalProviderUsageAccount,
): UsageIndicatorAccountSummaryProps['limits'] {
  return account.windows.map((window) => {
    const credits = window.credits;
    return {
      id: window.id,
      label: window.label,
      ...(window.unlimited ? { unlimited: true } : {}),
      ...(window.usedPercent === undefined
        ? {}
        : { usedPercent: window.usedPercent }),
      ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
      ...(credits?.unit === 'credits'
        ? credits.remaining === undefined
          ? {}
          : { remainingCredits: credits.remaining }
        : credits
          ? {
              ...(credits.spent === undefined
                ? {}
                : { usedUsd: credits.spent }),
              ...(credits.remaining === undefined
                ? {}
                : { remainingUsd: credits.remaining }),
              ...(credits.total === undefined
                ? {}
                : { totalUsd: credits.total }),
            }
          : {}),
    };
  });
}

/**
 * An account's limit windows, how fresh they are, and the last failed read.
 * Cached windows stay beside the error; no windows reads as unavailable,
 * never as 0%.
 */
export function ProviderAccountUsageDetails({
  account,
  nowMs,
  frameless = false,
  collapsible = false,
}: {
  account: PortalProviderUsageAccount;
  nowMs: number;
  frameless?: boolean;
  /** Settings keeps quota details behind a closed disclosure. */
  collapsible?: boolean;
}): JSX.Element {
  const error = errorText(account, nowMs);
  const freshness = freshnessText(account, nowMs);
  const freshnessTitle =
    account.usageSource === 'live' && account.lastUpdatedAt
      ? fullTime(account.lastUpdatedAt)
      : undefined;
  const windows = account.windows.map((window) => (
    <LimitSubCardView
      key={window.id}
      card={windowCard(window)}
      nowMs={nowMs}
      frameless={frameless}
    />
  ));
  const usage = (
    <>
      {windows}
      {account.windows.length === 0 && !error && (
        <p className="text-xs fg-secondary">Usage unavailable</p>
      )}
    </>
  );
  const freshnessLabel = freshness ? (
    <p className="text-xs fg-tertiary" title={freshnessTitle}>
      {freshness}
    </p>
  ) : null;
  return (
    <div className={`space-y-2 ${frameless ? 'mt-2' : 'mt-3'}`}>
      {collapsible ? (
        <details className="group/account-usage">
          <summary className="focus-ring flex w-fit cursor-pointer list-none items-center gap-1 rounded-md text-xs font-medium fg-secondary hover:fg-primary [&::-webkit-details-marker]:hidden">
            <ChevronRightMediumIcon
              size={14}
              aria-hidden="true"
              className="shrink-0 group-open/account-usage:rotate-90"
            />
            Usage
          </summary>
          <div className="mt-2 space-y-2">
            {usage}
            {freshnessLabel}
          </div>
        </details>
      ) : (
        usage
      )}
      {error && (
        <p role="status" className="text-xs fg-secondary">
          {error}
        </p>
      )}
      {!collapsible && freshnessLabel}
    </div>
  );
}

/**
 * One multi-account proxy account with its usage: the account (blocked from
 * session replay), a host-supplied state or action beside it, then its
 * limits. Shared by every host's usage surface.
 */
export function ProviderAccountUsage({
  account,
  providerLabel,
  nowMs,
  frameless = false,
  children,
}: {
  account: PortalProviderUsageAccount;
  providerLabel: string;
  nowMs: number;
  frameless?: boolean;
  children?: ReactNode;
}): JSX.Element {
  return (
    <section data-testid="provider-account-usage">
      <ProviderUsageAccountRow
        accountLabel={account.label ?? null}
        statusLabel={`${providerLabel} account`}
        frameless={frameless}
      >
        {children ?? null}
      </ProviderUsageAccountRow>
      <ProviderAccountUsageDetails
        account={account}
        nowMs={nowMs}
        frameless={frameless}
      />
    </section>
  );
}
