'use client';

import { memo, useMemo, type JSX, type ReactNode } from 'react';
import type { LedgerEntrySearchItem } from '@canopy/protocol/canopy-core';
import type { LedgerThread } from '../../lib/ledger-threads';
import {
  ledgerActivityItems,
  ledgerOpenEntryActors,
  LedgerActivityLine,
  LedgerHistoryMore,
  type LedgerActivityItem,
} from './LedgerEntryDetails';
import {
  LedgerEntryPost,
  LedgerEntryReply,
  type LedgerEntryPostContext,
} from './LedgerEntryPost';
import type { LedgerEntryRowDetails } from './ledger-entry-attribution';
import type { LedgerEntrySlots, LedgerOpenEntry } from './ledger-entry-slots';

/** Inputs for one entry thread in a Ledger list. */
export interface LedgerEntryThreadProps {
  readonly thread: LedgerThread<LedgerEntrySearchItem>;
  readonly context: LedgerEntryPostContext;
  readonly rowDetails?: (entry: LedgerEntrySearchItem) => LedgerEntryRowDetails;
  readonly entrySlots?: (
    entry: LedgerEntrySearchItem,
  ) => LedgerEntrySlots | undefined;
  readonly openEntry: LedgerOpenEntry | null;
  /** The correction box under this thread's replies, when correcting it. */
  readonly correctionBox?: ReactNode;
  /** Marks a pinned entry shown above the ordinary thread list. */
  readonly pinned?: boolean;
}

type ThreadLine =
  | {
      readonly kind: 'activity';
      readonly key: string;
      readonly occurredAt: string;
      readonly item: LedgerActivityItem;
      readonly order: number;
    }
  | {
      readonly kind: 'correction';
      readonly key: string;
      readonly occurredAt: string;
      readonly entry: LedgerEntrySearchItem;
      readonly order: number;
    };

function orderedThreadLines(
  activities: readonly LedgerActivityItem[],
  corrections: readonly LedgerEntrySearchItem[],
): ThreadLine[] {
  const lines: ThreadLine[] = [
    ...activities.map(
      (item, order): ThreadLine => ({
        kind: 'activity',
        key: `activity:${item.key}`,
        occurredAt: item.occurredAt,
        item,
        order,
      }),
    ),
    ...corrections.map(
      (entry, index): ThreadLine => ({
        kind: 'correction',
        key: `correction:${entry.entryId}`,
        occurredAt: entry.createdAt,
        entry,
        order: activities.length + index,
      }),
    ),
  ];
  return lines.sort((left, right) => {
    const leftTime = Date.parse(left.occurredAt);
    const rightTime = Date.parse(right.occurredAt);
    if (
      Number.isFinite(leftTime) &&
      Number.isFinite(rightTime) &&
      leftTime !== rightTime
    ) {
      return leftTime - rightTime;
    }
    return left.order - right.order;
  });
}

/** Shows a root entry, its corrections, changes and correction box. */
export const LedgerEntryThread = memo(function LedgerEntryThread({
  thread,
  context,
  rowDetails,
  entrySlots,
  openEntry,
  correctionBox,
  pinned,
}: LedgerEntryThreadProps): JSX.Element {
  const root = thread.root;
  const rootDetails = rowDetails?.(root);
  const rootSlots = entrySlots?.(root);
  const newestCorrection = thread.corrections[thread.corrections.length - 1];
  const openRoot = openEntry?.entryId === root.entryId ? openEntry : null;
  const activities = useMemo(() => {
    if (openRoot === null) return [];
    const actors = ledgerOpenEntryActors(context.actors, openRoot.view);
    return ledgerActivityItems(openRoot.view, actors, rootDetails?.attribution);
  }, [context.actors, openRoot, rootDetails?.attribution]);
  const lines = useMemo(
    () => orderedThreadLines(activities, thread.corrections),
    [activities, thread.corrections],
  );
  const history = openRoot?.view?.entry.history;
  const hasMoreHistory =
    history !== undefined && history !== null && history.nextCursor !== null;
  const showHistoryMore =
    hasMoreHistory && openRoot?.onLoadMoreHistory !== undefined;
  const hasCorrectionBox =
    correctionBox !== null &&
    correctionBox !== undefined &&
    correctionBox !== false;
  const hasThreadContent =
    lines.length > 0 || showHistoryMore || hasCorrectionBox;

  return (
    <div
      data-testid="ledger-entry-thread"
      data-root-entry-id={root.entryId}
      data-pinned={pinned === true ? 'true' : undefined}
    >
      <LedgerEntryPost
        entry={root}
        context={context}
        details={rootDetails}
        slots={rootSlots}
        open={openRoot}
        correctsLoadedEntry={!thread.orphan}
        canAddCorrection={thread.corrections.length === 0}
      >
        {hasThreadContent && (
          <div className="border-l border-line-base pl-3">
            <div className="flex flex-col gap-3">
              {lines.length > 0 && (
                <ul className="flex flex-col gap-2.5">
                  {lines.map((line) =>
                    line.kind === 'activity' ? (
                      <LedgerActivityLine
                        key={line.key}
                        item={line.item}
                        now={context.now}
                        localUser={
                          rootDetails?.attribution?.kind !== 'teammate'
                        }
                      />
                    ) : (
                      <LedgerEntryReply
                        key={line.key}
                        entry={line.entry}
                        context={context}
                        details={rowDetails?.(line.entry)}
                        slots={entrySlots?.(line.entry)}
                        open={
                          openEntry?.entryId === line.entry.entryId
                            ? openEntry
                            : null
                        }
                        rootEntryId={root.entryId}
                        canAddCorrection={
                          line.entry.entryId === newestCorrection?.entryId
                        }
                      />
                    ),
                  )}
                </ul>
              )}
              {showHistoryMore && openRoot?.onLoadMoreHistory !== undefined && (
                <LedgerHistoryMore
                  onLoadMore={openRoot.onLoadMoreHistory}
                  loading={openRoot.loadingMoreHistory ?? false}
                />
              )}
              {hasCorrectionBox && <div>{correctionBox}</div>}
            </div>
          </div>
        )}
      </LedgerEntryPost>
    </div>
  );
});
