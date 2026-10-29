import type {
  CostChatRow,
  CostPipelineRunRow,
  CostScopeView,
  CostTotals,
} from '@canopy/protocol/cost-view';

export type CostScopeRowTarget =
  | { readonly kind: 'chat'; readonly chatId: string }
  | { readonly kind: 'pipeline-run'; readonly executionId: string };

export type CostScopeSort = 'cost' | 'recent';

function descendingNumber(left: number, right: number): number {
  return right - left;
}

function descendingDate(left: string, right: string): number {
  return right.localeCompare(left);
}

export function sortCostChats(
  chats: readonly CostChatRow[],
  sort: CostScopeSort,
  showArchived: boolean,
): CostChatRow[] {
  const shownChats = chats.filter(
    (chat) => showArchived || chat.state !== 'archived',
  );
  return shownChats.sort((left, right) => {
    if (sort === 'cost') {
      const byCost = descendingNumber(left.totals.usd, right.totals.usd);
      if (byCost !== 0) return byCost;
    }
    return descendingDate(left.lastActivityAt, right.lastActivityAt);
  });
}

export function sortCostRuns(
  runs: readonly CostPipelineRunRow[],
  sort: CostScopeSort,
): CostPipelineRunRow[] {
  const sortedRuns = [...runs];
  return sortedRuns.sort((left, right) => {
    if (sort === 'cost') {
      const byCost = descendingNumber(left.totals.usd, right.totals.usd);
      if (byCost !== 0) return byCost;
    }
    return descendingDate(left.startedAt, right.startedAt);
  });
}

/** The maximum observed USD total among the shown rows, never below 0. */
export function costScopeScaleMax(
  chats: readonly CostChatRow[],
  runs: readonly CostPipelineRunRow[],
  unattached?: CostTotals,
): number {
  return Math.max(
    0,
    ...chats.map((chat) => chat.totals.usd),
    ...runs.map((run) => run.totals.usd),
    unattached?.usd ?? 0,
  );
}

export function isSameCostRowTarget(
  a: CostScopeRowTarget | null | undefined,
  b: CostScopeRowTarget,
): boolean {
  if (a === null || a === undefined || a.kind !== b.kind) return false;
  return a.kind === 'chat' && b.kind === 'chat'
    ? a.chatId === b.chatId
    : a.kind === 'pipeline-run' &&
        b.kind === 'pipeline-run' &&
        a.executionId === b.executionId;
}

/** Work tied to the entry but to no chat or run, priced or not. */
export function hasUnattachedCost(
  unattached: CostScopeView['unattached'],
): unattached is NonNullable<CostScopeView['unattached']> {
  return (
    unattached !== undefined &&
    (unattached.usd > 0 || unattached.notPricedCount > 0)
  );
}

/** Whether a scope has any cost row to show, including unpriced work. */
export function costScopeHasContent(view: CostScopeView): boolean {
  return (
    view.totals.usd > 0 ||
    view.chats.length > 0 ||
    view.pipelineRuns.length > 0 ||
    hasUnattachedCost(view.unattached)
  );
}
