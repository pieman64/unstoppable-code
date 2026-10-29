'use client';

import type { JSX } from 'react';
import { ExternalLink } from '@canopy/ui-shared/icons/AppIcons';
import type { TelemetryExpensiveRun } from '@canopy/protocol/telemetry';
import { StatusBadge } from '@canopy/ui-shared';
import { useSettingsPrivacy } from '../../host';
import {
  formatDurationMs,
  formatRelativeTime,
  formatTokens,
} from '../feed-format';
import { formatUsd } from './format';
import {
  formatEventTypeLabel,
  formatProviderLabel,
  formatTurnStatusLabel,
  turnStatusBadgeVariant,
} from './run-display';

interface MostExpensiveRunsProps {
  runs: readonly TelemetryExpensiveRun[];
}

/** Join class names, dropping empty ones so no stray whitespace remains. */
function cx(...classNames: readonly string[]): string {
  return classNames.filter(Boolean).join(' ');
}

/** Join non-empty parts with the standard middot separator. */
function joinParts(parts: readonly (string | null | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(' · ');
}

/**
 * Top-cost runs panel. Each row foregrounds the highest-value signals — status
 * color and author — alongside the existing cost/PR affordances, then packs the
 * remaining provenance (event type, branch, provider/model, tokens, duration,
 * recency) into two dense muted lines.
 */
export function MostExpensiveRuns({
  runs,
}: MostExpensiveRunsProps): JSX.Element {
  // Run titles and author names are user content: keep them out of replays.
  const { blockClassName } = useSettingsPrivacy();
  if (runs.length === 0) {
    return (
      <p
        className="rounded-lg border border-dashed px-4 py-6 text-center text-s fg-secondary"
        data-testid="expensive-runs-empty"
      >
        No sessions recorded for this range.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2" data-testid="expensive-runs-list">
      {runs.map((run) => {
        const totalTokens = run.inputTokens + run.outputTokens;
        const tokensValue = totalTokens > 0 ? formatTokens(totalTokens) : null;
        const tokensLabel = tokensValue ? `${tokensValue} tokens` : null;
        const durationLabel = formatDurationMs(run.durationMs);
        // The DB column is non-nullable but nothing prevents a blank/whitespace
        // value, so fall back to 'Unknown' when the trimmed name is empty.
        const authorName = run.authorName?.trim();
        const authorLabel = authorName ? authorName : 'Unknown';
        // Only surface the in/out token breakdown tooltip when there are tokens
        // to break down; otherwise a zero-token run shows a "0 in · 0 out" hint.
        const tokenBreakdown =
          totalTokens > 0
            ? `${run.inputTokens.toLocaleString()} in · ${run.outputTokens.toLocaleString()} out`
            : undefined;
        const turnCountLabel = `${run.turnCount} turn${run.turnCount === 1 ? '' : 's'}`;
        const detailLine = joinParts([
          turnCountLabel,
          formatProviderLabel(run.provider),
          run.model,
          tokensLabel,
          durationLabel,
          formatRelativeTime(run.startedAtIso),
        ]);
        const metaLine = joinParts([
          authorLabel,
          formatEventTypeLabel(run.eventType),
          run.branchName,
        ]);
        return (
          <li
            key={run.sessionId}
            className="flex items-start justify-between gap-3 rounded-lg border bg-card px-4 py-3"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <StatusBadge
                  variant={turnStatusBadgeVariant(run.status)}
                  label={formatTurnStatusLabel(run.status)}
                  dataTestId={`expensive-run-status-${run.sessionId}`}
                />
                <p
                  className={cx(
                    'truncate text-s font-medium fg-primary',
                    blockClassName,
                  )}
                >
                  {run.label}
                </p>
              </div>
              <p
                className={cx(
                  'mt-0.5 truncate text-xs fg-secondary',
                  blockClassName,
                )}
              >
                {metaLine}
              </p>
              <p
                className="mt-0.5 truncate text-xs tabular-nums fg-secondary"
                title={tokenBreakdown}
              >
                {detailLine}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className="text-s font-semibold tabular-nums fg-primary">
                {formatUsd(run.totalCostUsd)}
              </span>
              {run.prUrl && (
                <a
                  href={run.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-medium fg-accent hover:underline"
                  data-testid={`expensive-run-pr-${run.sessionId}`}
                >
                  PR
                  <ExternalLink size={12} aria-hidden="true" />
                </a>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
