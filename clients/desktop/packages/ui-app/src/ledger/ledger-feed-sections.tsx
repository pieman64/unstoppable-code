import type { JSX, ReactNode } from 'react';
import type { LedgerWorkStatus } from '@canopy/app-state/ledger-feed';
import { Heading, StatusGlyph } from '@canopy/ui-shared/components';
import type { StatusGlyphState } from '@canopy/ui-shared/lib';

export interface FeedSectionHeadingProps {
  readonly title: string;
  readonly count?: number;
  readonly actions?: ReactNode;
  readonly testId: string;
}

export function FeedSectionHeading({
  title,
  count,
  actions,
  testId,
}: FeedSectionHeadingProps): JSX.Element {
  return (
    <div
      data-testid={testId}
      data-feed-section-heading
      className="flex min-h-8 items-center justify-between gap-3"
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <Heading level={2} variant="section" truncate>
          {title}
        </Heading>
        {count === undefined ? null : (
          <span className="shrink-0 text-xs tabular-nums fg-tertiary">
            {count}
          </span>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </div>
  );
}

export const LEDGER_WORK_STATUS_LABELS: Readonly<
  Record<LedgerWorkStatus | 'all', string>
> = {
  all: 'All',
  needs_you: 'Needs you',
  working: 'Working',
  blocked: 'Blocked',
  failed: 'Failed',
  stopped: 'Stopped',
  todo: 'To do',
  completed: 'Completed',
};

export const LEDGER_WORK_STATUS_GLYPHS: Readonly<
  Record<LedgerWorkStatus, StatusGlyphState>
> = {
  needs_you: 'needs-you',
  working: 'running',
  blocked: 'paused',
  failed: 'failed',
  stopped: 'cancelled',
  todo: 'queued',
  completed: 'done',
};

export interface WorkStatusLabelProps {
  readonly status: LedgerWorkStatus;
}

export function WorkStatusLabel({ status }: WorkStatusLabelProps): JSX.Element {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs fg-secondary">
      <StatusGlyph state={LEDGER_WORK_STATUS_GLYPHS[status]} size={14} />
      <span>{LEDGER_WORK_STATUS_LABELS[status]}</span>
    </span>
  );
}
