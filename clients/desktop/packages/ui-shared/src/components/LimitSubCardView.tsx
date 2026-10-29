import type { JSX } from 'react';
import {
  USAGE_ALERT_CRITICAL_THRESHOLD,
  USAGE_ALERT_WARNING_THRESHOLD,
} from '@canopy/protocol/provider-usage';
import { formatCreditCount } from './UsageIndicator';
import { LinearProgress } from './LinearProgress';
import { UsageResetIcon } from './UsageResetIcon';

export interface UsageLimitCard {
  key: string;
  title: string;
  unlimited?: boolean;
  usedPercent?: number;
  resetsAt?: string | number;
  windowDurationMs?: number;
  credits?: { usedUsd?: number; remainingUsd?: number; totalUsd?: number };
  creditsAreCount?: boolean;
}

function usagePercentColorClass(percent: number): string {
  if (percent >= USAGE_ALERT_CRITICAL_THRESHOLD) return 'fg-destructive';
  if (percent >= USAGE_ALERT_WARNING_THRESHOLD) return 'fg-warning';
  return 'fg-secondary';
}

function formatResetAt(resetAt?: string | number): string | null {
  if (!resetAt) {
    return null;
  }

  const parsed = new Date(resetAt);
  const timestamp = parsed.getTime();
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return parsed.toLocaleString();
}

function isResetPassed(
  resetsAt: string | number | undefined,
  nowMs: number,
): boolean {
  if (!resetsAt) {
    return false;
  }
  const resetMs = new Date(resetsAt).getTime();
  return Number.isFinite(resetMs) && resetMs <= nowMs;
}

function computeTimeProgressPercent(
  resetsAt: string | number | undefined,
  windowDurationMs: number | undefined,
  nowMs: number,
): number | undefined {
  if (!resetsAt || !windowDurationMs) {
    return undefined;
  }
  const resetMs = new Date(resetsAt).getTime();
  if (!Number.isFinite(resetMs)) {
    return undefined;
  }
  const startMs = resetMs - windowDurationMs;
  const elapsedMs = nowMs - startMs;
  const pct = (elapsedMs / windowDurationMs) * 100;
  if (!Number.isFinite(pct)) {
    return undefined;
  }
  return Math.max(0, Math.min(100, pct));
}

function usagePercentBarClass(percent: number): string {
  if (percent >= USAGE_ALERT_CRITICAL_THRESHOLD) return 'bg-destructive';
  if (percent >= USAGE_ALERT_WARNING_THRESHOLD) return 'bg-warning';
  return 'bg-accent';
}

interface UsageMeterProps {
  usedPercent: number;
  timePercent?: number;
}

function UsageMeter({
  usedPercent,
  timePercent,
}: UsageMeterProps): JSX.Element {
  return (
    <div className="mt-2">
      <LinearProgress
        percentage={usedPercent}
        barColor={usagePercentBarClass(usedPercent)}
        height="h-1.5"
      />
      <div className="relative mt-0.5 h-1.5 w-full">
        {timePercent !== undefined && (
          <div
            className="absolute top-0 -translate-x-1/2"
            style={{ left: `${timePercent}%` }}
          >
            <svg
              width="8"
              height="5"
              viewBox="0 0 8 5"
              className="fill-fg-primary/70"
              role="img"
              aria-label={`Window elapsed: ${timePercent.toFixed(0)}%`}
            >
              <path d="M4 0 L8 5 L0 5 Z" />
            </svg>
          </div>
        )}
      </div>
    </div>
  );
}

interface LimitSubCardViewProps {
  card: UsageLimitCard;
  nowMs: number;
  /**
   * Panel (frameless) view: fill the card with the same subtle background as
   * the activity panel section cards (`bg-fg-primary/[0.03]`). The standalone
   * page keeps the plain bordered box.
   */
  frameless?: boolean;
}

export function LimitSubCardView({
  card,
  nowMs,
  frameless = false,
}: LimitSubCardViewProps): JSX.Element {
  const resetLabel = formatResetAt(card.resetsAt);
  const timePercent = computeTimeProgressPercent(
    card.resetsAt,
    card.windowDurationMs,
    nowMs,
  );
  const resetPassed = !card.unlimited && isResetPassed(card.resetsAt, nowMs);
  const usedPercent = card.unlimited ? undefined : card.usedPercent;
  const hasCreditDetails =
    card.credits?.usedUsd !== undefined ||
    card.credits?.remainingUsd !== undefined;

  return (
    <div
      className={`relative rounded-xl border px-3 py-3 text-s ${
        frameless ? 'bg-fg-primary/[0.03]' : ''
      }`}
    >
      <div className="font-medium fg-primary">{card.title}</div>
      {usedPercent !== undefined && (
        <UsageMeter usedPercent={usedPercent} timePercent={timePercent} />
      )}
      <div className="mt-2 space-y-1 text-xs fg-secondary">
        {card.unlimited ? (
          <div>Unlimited</div>
        ) : usedPercent === undefined && !hasCreditDetails ? (
          <div>Usage unavailable</div>
        ) : null}
        {usedPercent !== undefined && (
          <div>
            Usage:{' '}
            <span className={usagePercentColorClass(usedPercent)}>
              {usedPercent.toFixed(1)}%
            </span>
          </div>
        )}
        {resetLabel && <div>Resets: {resetLabel}</div>}
        {card.credits?.usedUsd !== undefined && (
          <div>Spent: ${card.credits.usedUsd.toFixed(2)}</div>
        )}
        {card.credits?.remainingUsd !== undefined &&
          (card.creditsAreCount ? (
            <div>
              Remaining credits: {formatCreditCount(card.credits.remainingUsd)}
            </div>
          ) : (
            <div>
              Remaining credits: ${card.credits.remainingUsd.toFixed(2)}
            </div>
          ))}
      </div>
      {resetPassed && (
        <div className="absolute inset-0 flex items-center justify-center gap-1.5 rounded-xl bg-card/70 fg-secondary">
          <UsageResetIcon />
          <span className="text-xs font-medium">Reset time has passed</span>
        </div>
      )}
    </div>
  );
}
