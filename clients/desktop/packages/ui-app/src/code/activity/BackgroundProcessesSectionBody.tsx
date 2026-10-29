'use client';

import { useState, type JSX, type KeyboardEvent } from 'react';
import type {
  BackgroundTask,
  BackgroundTaskStatus,
} from '@canopy/protocol/background-tasks';
import { AnsiOutput } from '@canopy/ui-shared/components';
import {
  getBackgroundProcessStatusClassName as getStatusClassName,
  isTerminalBackgroundProcessStatus as isTerminalStatus,
} from '@canopy/ui-shared/lib';
import { ChevronIcon, WorkflowIcon } from '@canopy/ui-shared/icons';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

export interface BackgroundProcessesSectionBodyProps {
  readonly tasks: readonly BackgroundTask[];
  readonly stoppingTaskId: string | null;
  readonly onStop?: (task: BackgroundTask) => void;
  readonly onOpenDetail: (task: BackgroundTask) => void;
}

function getMutedStatusClassName(status: BackgroundTaskStatus): string {
  switch (status) {
    case 'completed':
      return 'bg-success-subtle fg-success-strong/70';
    case 'failed':
      return 'bg-destructive-subtle fg-destructive-strong';
    case 'stopped':
      return 'bg-warning-subtle fg-warning/70';
    default:
      return 'bg-fg-primary/[0.05] fg-secondary/60';
  }
}

export function BackgroundProcessesSectionBody({
  tasks,
  stoppingTaskId,
  onStop,
  onOpenDetail,
}: BackgroundProcessesSectionBodyProps): JSX.Element | null {
  const [stoppedExpanded, setStoppedExpanded] = useState(false);
  const sortedProcesses = [...tasks].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
  const activeProcesses = sortedProcesses.filter(
    (process) => !isTerminalStatus(process.status),
  );
  const stoppedProcesses = sortedProcesses.filter((process) =>
    isTerminalStatus(process.status),
  );
  const totalCount = activeProcesses.length + stoppedProcesses.length;

  if (totalCount === 0) {
    return null;
  }

  const handleKeyDown = (
    event: KeyboardEvent<HTMLDivElement>,
    process: BackgroundTask,
  ): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpenDetail(process);
    }
  };

  return (
    <div className="space-y-2" data-testid="activity-bg-body">
      {/* Active processes */}
      {activeProcesses.map((process) => (
        <div
          key={process.id}
          role="button"
          tabIndex={0}
          className="cursor-pointer space-y-3 rounded-lg border bg-fg-primary/[0.03] px-3 py-3 transition hover:bg-fg-primary/[0.05]"
          onClick={(): void => onOpenDetail(process)}
          onKeyDown={(event): void => handleKeyDown(event, process)}
          data-testid="activity-bg-item"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                {process.kind === 'workflow' && (
                  <span className="flex-shrink-0 fg-special">
                    <WorkflowIcon />
                  </span>
                )}
                <span className="text-xs font-medium fg-secondary">
                  {process.kind}
                </span>
                <span
                  className={`rounded-full px-2 py-1 text-3xs font-medium ${getStatusClassName(process.status)}`}
                >
                  {process.status}
                </span>
              </div>
              {/* Descriptions fall back to the command or prompt, and
                  summaries quote agent output, so replay blocks them. */}
              <div
                className={`${REPLAY_BLOCK_CLASS} mt-1 truncate text-xs font-medium fg-primary/80`}
              >
                {process.title}
              </div>
              {process.lastDescription &&
                process.lastDescription !== process.title && (
                  <div
                    className={`${REPLAY_BLOCK_CLASS} mt-1 truncate text-xs fg-secondary`}
                  >
                    {process.lastDescription}
                  </div>
                )}
              {process.summary && (
                <div
                  className={`${REPLAY_BLOCK_CLASS} mt-1 truncate text-xs fg-secondary`}
                >
                  {process.summary}
                </div>
              )}
            </div>

            {onStop && process.canStop && (
              <button
                type="button"
                onClick={(event): void => {
                  event.stopPropagation();
                  onStop(process);
                }}
                disabled={stoppingTaskId === process.id}
                className="focus-ring shrink-0 rounded-md border border-line-destructive px-2.5 py-1.5 text-2xs font-medium fg-destructive transition hover:bg-destructive-subtle disabled:cursor-wait disabled:opacity-60"
                data-testid="activity-bg-stop"
              >
                {stoppingTaskId === process.id ? 'Stopping…' : 'Stop'}
              </button>
            )}
          </div>

          {process.kind !== 'workflow' && (
            <AnsiOutput lines={process.outputLines} className="max-h-44" />
          )}
        </div>
      ))}

      {/* Stopped processes (collapsible) */}
      {stoppedProcesses.length > 0 && (
        <div className="pt-1">
          <button
            type="button"
            aria-expanded={stoppedExpanded}
            onClick={(): void => setStoppedExpanded((previous) => !previous)}
            className="focus-ring flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-xs font-medium fg-secondary/60 transition hover:fg-secondary"
            data-testid="activity-bg-stopped-toggle"
          >
            <ChevronIcon open={stoppedExpanded} />
            Stopped ({stoppedProcesses.length})
          </button>

          {stoppedExpanded && (
            <div className="mt-2 space-y-1.5">
              {stoppedProcesses.map((process) => (
                <div
                  key={process.id}
                  role="button"
                  tabIndex={0}
                  className="cursor-pointer overflow-hidden rounded-lg border bg-fg-primary/[0.015] px-3 py-2.5 transition hover:bg-fg-primary/[0.03]"
                  onClick={(): void => onOpenDetail(process)}
                  onKeyDown={(event): void => handleKeyDown(event, process)}
                  data-testid="activity-bg-item"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium fg-secondary/60">
                      {process.kind}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-3xs font-medium ${getMutedStatusClassName(process.status)}`}
                    >
                      {process.status}
                    </span>
                  </div>
                  <div className="mt-1 truncate text-xs fg-secondary">
                    {process.title}
                  </div>
                  {process.summary && (
                    <div className="mt-0.5 truncate text-xs fg-secondary/60">
                      {process.summary}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
