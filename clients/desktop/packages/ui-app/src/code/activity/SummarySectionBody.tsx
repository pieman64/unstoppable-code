'use client';

import { useState, type JSX } from 'react';
import { WORKTREE_UNIT_LABEL } from '@canopy/protocol';
import {
  Stack,
  Button,
  DialogModal,
  RefreshSpinner,
  Heading,
} from '@canopy/ui-shared/components';
import { formatRelativeTime } from '@canopy/ui-shared/lib';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { Surface } from '@canopy/ui-shared/components';

export interface SummarySectionBodyRepo {
  readonly name: string;
  readonly description: string;
}

export interface SummarySectionBodySummary {
  readonly title: string;
  readonly description: string;
  readonly highlights?: readonly string[];
  readonly repos?: readonly SummarySectionBodyRepo[];
  readonly generatedAt?: string;
  readonly lastFullRefreshAt?: string;
}

export interface SummarySectionBodyProps {
  readonly summary?: SummarySectionBodySummary;
  readonly generating: boolean;
  readonly refreshEnabled: boolean;
  readonly onRefresh?: () => void;
}

export function SummarySectionBody({
  summary,
  generating,
  refreshEnabled,
  onRefresh,
}: SummarySectionBodyProps): JSX.Element {
  const [detailOpen, setDetailOpen] = useState(false);

  if (!summary) {
    return <></>;
  }

  return (
    <>
      <button
        type="button"
        onClick={(): void => setDetailOpen(true)}
        className="focus-ring w-full cursor-pointer text-left"
      >
        <div className="text-s font-semibold fg-primary">{summary.title}</div>
        <p
          className={`${REPLAY_BLOCK_CLASS} mt-1 line-clamp-6 text-xs leading-5 fg-primary/70`}
        >
          {summary.description}
        </p>
        <span
          className="mt-2 inline-block text-xs fg-accent transition-colors hover:fg-accent/80"
          data-testid="summary-details-link"
        >
          View more details
        </span>
      </button>

      {detailOpen ? (
        <DialogModal
          onClose={(): void => setDetailOpen(false)}
          title={`${WORKTREE_UNIT_LABEL} Summary`}
          maxWidth="lg"
        >
          <div
            className="grid grid-cols-1 content-start overflow-y-auto gap-5"
            data-testid="summary-detail-modal"
          >
            <div className="flex items-start justify-between gap-4">
              <Stack gap="tight">
                <Heading level={3} variant="section">
                  {summary.title}
                </Heading>
                <p className="text-s fg-secondary">
                  Last updated {formatRelativeTime(summary.generatedAt)}
                  {summary.lastFullRefreshAt !== undefined
                    ? ` · Full refresh ${formatRelativeTime(summary.lastFullRefreshAt)}`
                    : null}
                </p>
              </Stack>
              {refreshEnabled && onRefresh ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="compact"
                  onClick={onRefresh}
                  disabled={generating}
                >
                  <RefreshSpinner spinning={generating} tone="accent" />
                  {generating ? 'Refreshing…' : 'Refresh'}
                </Button>
              ) : null}
            </div>

            <p
              className={`${REPLAY_BLOCK_CLASS} text-s leading-6 fg-primary/90`}
            >
              {summary.description}
            </p>

            {summary.highlights !== undefined ? (
              <Stack gap="item">
                <Heading level={4} variant="label">
                  Highlights
                </Heading>
                <div className={`${REPLAY_BLOCK_CLASS} flex flex-col gap-2`}>
                  {summary.highlights.map((highlight, index) => (
                    <Surface
                      variant="group"
                      padding="compact"
                      key={`highlight-${index}`}
                    >
                      <div className="flex items-start gap-3">
                        <span
                          className="mt-1 h-2 w-2 rounded-full bg-accent"
                          data-testid="summary-highlight-dot"
                        />
                        <p className="text-s leading-6 fg-primary/90">
                          {highlight}
                        </p>
                      </div>
                    </Surface>
                  ))}
                </div>
              </Stack>
            ) : null}

            {summary.repos && summary.repos.length > 0 ? (
              <Stack gap="item">
                <Heading level={4} variant="label">
                  Repository summaries
                </Heading>
                <Stack gap="inline">
                  {summary.repos.map((repo) => (
                    <Surface key={repo.name} variant="group" padding="compact">
                      <Heading level={5} variant="title">
                        {repo.name}
                      </Heading>
                      <p
                        className={`${REPLAY_BLOCK_CLASS} mt-1 text-s leading-6 fg-primary/80`}
                      >
                        {repo.description}
                      </p>
                    </Surface>
                  ))}
                </Stack>
              </Stack>
            ) : null}
          </div>
        </DialogModal>
      ) : null}
    </>
  );
}
