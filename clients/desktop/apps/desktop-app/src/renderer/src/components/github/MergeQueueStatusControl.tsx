import { memo, useEffect, useMemo, useState, type JSX } from 'react';
import { MergeQueueStatus } from '@canopy/ui-shared/components';
import {
  estimateMinutes,
  mergeQueueLabel,
  mergeQueueStep,
} from '@canopy/ui-shared/lib';
import type { AppAdvisorJson } from '@canopy/desktop-shared/types';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  labelCountsDown,
  mergeQueueLabelInputs,
  mergeQueuePopoverSections,
  mergeQueueTarget,
  newestListRead,
  type MergeQueueListState,
  type MergeQueueTarget,
  type QueuedPullRequest,
} from './mergeQueueStatusModel';

/** Re-read the open popover's queues this often; matches the poller's spacing. */
const OPEN_REFRESH_MS = 30_000;
/** "Updated 12s ago" and the estimate count down while the popover is open. */
const OPEN_TICK_MS = 5_000;
/** The closed label shows whole minutes. */
const CLOSED_TICK_MS = 15_000;

/**
 * Moves `now` to the clock every `intervalMs`; null holds it. The interval
 * is chosen from what `now` renders, so the effect keys on it alone and a
 * tick that keeps the same interval never restarts it.
 */
function useTicker(
  intervalMs: number | null,
  setNow: (now: number) => void,
): void {
  useEffect((): (() => void) | void => {
    if (intervalMs === null) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return (): void => window.clearInterval(id);
  }, [intervalMs, setNow]);
}

/**
 * Reads each target's queue while `active`, then again every
 * {@link OPEN_REFRESH_MS} and whenever the PR status changes. Results stay
 * after closing so a reopen paints the last read at once while the next one
 * runs.
 */
function useMergeQueueLists(
  targets: readonly MergeQueueTarget[],
  active: boolean,
): Record<string, MergeQueueListState> {
  const [lists, setLists] = useState<Record<string, MergeQueueListState>>({});
  useEffect((): (() => void) | void => {
    if (!active || targets.length === 0) return;
    let cancelled = false;
    const load = (): void => {
      for (const target of targets) {
        setLists((previous) =>
          previous[target.key]
            ? previous
            : { ...previous, [target.key]: { status: 'loading' } },
        );
        window.api.github
          .getMergeQueue({
            repository: target.repository,
            baseBranch: target.baseBranch,
          })
          .then(
            (response) => {
              if (cancelled) return;
              setLists((previous) => ({
                ...previous,
                [target.key]: { status: 'ready', view: response.queue },
              }));
            },
            () => {
              if (cancelled) return;
              setLists((previous) => {
                const last = previous[target.key];
                return {
                  ...previous,
                  [target.key]: {
                    status: 'error',
                    view: last && last.status !== 'loading' ? last.view : null,
                  },
                };
              });
            },
          );
      }
    };
    load();
    const id = window.setInterval(load, OPEN_REFRESH_MS);
    return (): void => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active, targets]);
  return lists;
}

interface MergeQueueStatusControlProps {
  /** Open pull requests in their base branch's merge queue; never empty. */
  readonly pullRequests: readonly QueuedPullRequest[];
}

/**
 * Desktop wiring for the shared merge queue label and popover in the PR bar.
 * The queue list is read only while the popover is open.
 */
export const MergeQueueStatusControl = memo(function MergeQueueStatusControl({
  pullRequests,
}: MergeQueueStatusControlProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const targets = useMemo(
    () =>
      pullRequests
        .map(mergeQueueTarget)
        .filter((target): target is MergeQueueTarget => target !== null),
    [pullRequests],
  );
  const lists = useMergeQueueLists(targets, open);
  const labelInputs = mergeQueueLabelInputs(pullRequests, lists, now);
  // The closed label ticks while it shows an estimate, which may come from a
  // kept list read rather than the poll.
  const countsDown = labelCountsDown(labelInputs);
  useTicker(open ? OPEN_TICK_MS : countsDown ? CLOSED_TICK_MS : null, setNow);
  const label = mergeQueueLabel(labelInputs);
  const sections = useMemo(
    () => mergeQueuePopoverSections(pullRequests, lists, now),
    [pullRequests, lists, now],
  );
  const updatedAt = newestListRead(
    lists,
    targets.map((target) => target.key),
  );

  const [first] = sections;
  const uiState = useMemo((): AppAdvisorJson | null => {
    if (!open || !first) return null;
    const state: Record<string, AppAdvisorJson> = {
      open: true,
      repoCount: sections.length,
    };
    if (sections.length === 1) {
      state.phase =
        first.phase === 'unmergeable' ? 'blocked' : mergeQueueStep(first.phase);
      if (first.position !== null) state.position = first.position;
      if (first.remainingSeconds !== null) {
        state.etaMinutes = estimateMinutes(first.remainingSeconds);
      }
      if (first.list.status === 'ready') {
        state.queueLength = first.list.totalCount;
      }
    }
    return state;
  }, [open, first, sections.length]);
  useCurrentUiStateReporter('github.mergeQueuePopover', uiState);

  if (!label) return null;
  return (
    <MergeQueueStatus
      label={label}
      sections={sections}
      open={open}
      onOpenChange={setOpen}
      now={now}
      updatedAt={updatedAt}
      // The `· #N` goes at the tier where the header drops the PR and CI
      // badges (`HEADER_PRIORITY.badges` in PrStatusBar); the estimate stays.
      positionClassName="hidden @[420px]/topbar:inline-flex"
      data-testid="pr-status-bar-merge-queue"
    />
  );
});
