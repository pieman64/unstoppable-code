import type {
  LedgerActorLabel,
  LedgerActorRef,
  LedgerEntrySearchItem,
  LedgerRollupItem,
  LedgerRootChatFilter,
  LedgerStatus,
} from '@canopy/protocol/canopy-core';
import { isLedgerTerminalStatus } from '@canopy/protocol/canopy-core';
import type {
  LedgerFeedRow,
  LedgerFeedWorkRow,
  LedgerViewActorHost,
  LedgerViewScope,
} from '@canopy/protocol/ledger-view';
import {
  LEDGER_AGENT_WAIT_KINDS,
  type LedgerAgentWaitKind,
  type LedgerLiveSnapshot,
  type LedgerLiveWait,
} from '@canopy/app-core';
import { ledgerAgentIsWorking } from './ledger-feed-live';

/** The Feed table's status precedence (L10). */
export const LEDGER_WORK_STATUSES = [
  'needs_you',
  'working',
  'blocked',
  'failed',
  'stopped',
  'todo',
  'completed',
] as const;

export type LedgerWorkStatus = (typeof LEDGER_WORK_STATUSES)[number];

/** Inputs shared by the status and Doing now derivations. */
export interface LedgerWorkContext {
  readonly snapshot: LedgerLiveSnapshot | null;
  /** An actor's wait belongs to only this open operation/task row. */
  readonly currentOperations: ReadonlyMap<string, string>;
  readonly actors: Readonly<Record<string, LedgerActorLabel>>;
}

export type LedgerDoingNow =
  | {
      readonly kind: 'wait';
      readonly waitKind: LedgerAgentWaitKind;
      readonly text: string;
    }
  | { readonly kind: 'review'; readonly task: string }
  | { readonly kind: 'catching_up' }
  | {
      readonly kind: 'working';
      readonly task: string;
      readonly agentName: string;
    }
  | { readonly kind: 'blocked'; readonly task: string }
  | { readonly kind: 'failed'; readonly task: string }
  | { readonly kind: 'next'; readonly task: string };

export interface LedgerWorkRowView {
  readonly key: string;
  readonly row: LedgerFeedWorkRow;
  readonly status: LedgerWorkStatus;
  readonly doingNow: LedgerDoingNow | null;
  readonly group: 'operation' | 'no_operation';
  readonly lastActivityAt: string;
}

export type LedgerWorkStatusCounts = Record<LedgerWorkStatus, number>;

export type LedgerWorkSortColumn =
  | 'status'
  | 'operation'
  | 'progress'
  | 'lastActivity';

export interface LedgerWorkSort {
  readonly column: LedgerWorkSortColumn;
  readonly direction: 'asc' | 'desc';
}

export const DEFAULT_LEDGER_WORK_SORT: LedgerWorkSort = {
  column: 'lastActivity',
  direction: 'desc',
};

export const LEDGER_WORK_STATUS_SORT: LedgerWorkSort = {
  column: 'status',
  direction: 'asc',
};

/** An item's progress over its direct child tasks, not every leaf. */
export interface LedgerProgressInfo {
  readonly show: boolean;
  readonly statuses: LedgerRollupItem['childStatuses'];
  readonly counts: LedgerRollupItem['childCounts'];
  readonly done: number;
  readonly total: number;
}

export type LedgerNeedsYouKind = LedgerAgentWaitKind | 'review';

export interface LedgerNeedsYouItem {
  readonly key: string;
  readonly kind: LedgerNeedsYouKind;
  readonly title: string;
  readonly scope: LedgerViewScope;
  readonly time: string | null;
  readonly wait?: LedgerLiveWait;
  readonly review?: LedgerFeedRow;
}

export interface LedgerWorkTreeRow {
  readonly entry: LedgerEntrySearchItem;
  readonly depth: number;
  readonly showOwner: boolean;
  readonly ownerStateVisible: boolean;
  /** Its own child tasks' statuses in tree order; empty for a leaf. */
  readonly childStatuses: readonly LedgerStatus[];
}

const OPEN_LEAF_STATUSES: readonly LedgerStatus[] = [
  'TODO',
  'IN_PROGRESS',
  'BLOCKED',
  'NEEDS_REVIEW',
];

const ALL_LEAF_STATUSES: readonly LedgerStatus[] = [
  'TODO',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
  'BLOCKED',
  'NEEDS_REVIEW',
  'INFO',
];

function leafCount(item: LedgerRollupItem, status: LedgerStatus): number {
  return item.leafCounts[status] ?? 0;
}

function hasOpenLeaves(item: LedgerRollupItem): boolean {
  return OPEN_LEAF_STATUSES.some((status) => leafCount(item, status) > 0);
}

function isOpenRow(item: LedgerRollupItem): boolean {
  return !isLedgerTerminalStatus(item.status) || hasOpenLeaves(item);
}

function compareLastActivityDesc(
  left: LedgerFeedWorkRow,
  right: LedgerFeedWorkRow,
): number {
  return (
    Date.parse(right.item.lastActivityAt) -
      Date.parse(left.item.lastActivityAt) ||
    right.item.lastActivityAt.localeCompare(left.item.lastActivityAt) ||
    left.item.entryId.localeCompare(right.item.entryId)
  );
}

/** The open operation/task row an actor currently owns or is working on. */
export function currentOperation(
  actorId: string,
  rows: readonly LedgerFeedWorkRow[],
): string | null {
  const openRows = rows.filter((row) => isOpenRow(row.item));
  const active = openRows
    .filter((row) =>
      row.item.inProgressLeaves.some((leaf) => leaf.owner.actorId === actorId),
    )
    .sort(compareLastActivityDesc)[0];
  if (active !== undefined) return active.item.entryId;

  const owned = openRows
    .filter(
      (row) =>
        row.item.owner.actorId === actorId ||
        row.item.openLeafOwners.some(
          (candidate) => candidate.owner.actorId === actorId,
        ),
    )
    .sort(compareLastActivityDesc)[0];
  return owned?.item.entryId ?? null;
}

function attributedWait(
  row: LedgerFeedWorkRow,
  context: LedgerWorkContext,
): LedgerLiveWait | undefined {
  return context.snapshot?.waits.find(
    (wait) =>
      wait.actorId !== null &&
      context.currentOperations.get(wait.actorId) === row.item.entryId,
  );
}

/** Derives the one status shown in the Operations table (L10). */
export function workStatus(
  row: LedgerFeedWorkRow,
  context: LedgerWorkContext,
): LedgerWorkStatus {
  const { item } = row;
  if (item.openNeedsReviewOwnedByCaller > 0 || attributedWait(row, context)) {
    return 'needs_you';
  }

  // A review or wait outranks work; live work (including background work)
  // outranks blocked and failed leaves.
  // Truncated started work is TODO, not Stopped, absent live/unknown in-progress evidence.
  if (
    item.openLeafOwners.some((candidate) => {
      const agent = context.snapshot?.agents[candidate.owner.actorId];
      return agent !== undefined && ledgerAgentIsWorking(agent);
    }) ||
    item.inProgressLeaves.some((leaf) => {
      const agent = context.snapshot?.agents[leaf.owner.actorId];
      return agent !== undefined && ledgerAgentIsWorking(agent);
    }) ||
    (item.openLeafOwnerCount > item.openLeafOwners.length &&
      item.inProgressLeaves.some(
        (leaf) => context.snapshot?.agents[leaf.owner.actorId] === undefined,
      ))
  ) {
    return 'working';
  }

  if (leafCount(item, 'BLOCKED') > 0 || item.status === 'BLOCKED') {
    return 'blocked';
  }

  if (
    item.status === 'FAILED' ||
    (leafCount(item, 'FAILED') > 0 &&
      (hasOpenLeaves(item) || !isLedgerTerminalStatus(item.status)))
  ) {
    return 'failed';
  }

  const openLeaves = hasOpenLeaves(item);
  const startedLeafCount = ALL_LEAF_STATUSES.filter(
    (status) => status !== 'TODO',
  ).reduce((total, status) => total + leafCount(item, status), 0);
  const completedLeaves = leafCount(item, 'COMPLETED');

  if (
    (openLeaves && startedLeafCount > 0) ||
    (!openLeaves &&
      !isLedgerTerminalStatus(item.status) &&
      (item.status === 'IN_PROGRESS' || completedLeaves > 0))
  ) {
    if (item.openLeafOwnerCount > item.openLeafOwners.length) return 'todo';
    return 'stopped';
  }

  if (
    (openLeaves && startedLeafCount === 0) ||
    (!openLeaves &&
      !isLedgerTerminalStatus(item.status) &&
      ALL_LEAF_STATUSES.every((status) => leafCount(item, status) === 0))
  ) {
    return 'todo';
  }

  // Terminal rows with no open leaves are complete; the rollup invariants
  // make other no-open-leaf states unreachable after the cases above.
  return 'completed';
}

/** Names only the current wait or the work represented by the row. */
export function doingNow(
  row: LedgerFeedWorkRow,
  status: LedgerWorkStatus,
  context: LedgerWorkContext,
): LedgerDoingNow | null {
  const { item } = row;
  switch (status) {
    case 'needs_you': {
      const wait = attributedWait(row, context);
      if (wait !== undefined) {
        return { kind: 'wait', waitKind: wait.kind, text: wait.title };
      }
      return item.firstReviewLeaf === undefined
        ? null
        : { kind: 'review', task: item.firstReviewLeaf.title };
    }
    case 'working': {
      const catchingUp = item.openLeafOwners.some((candidate) => {
        const agent = context.snapshot?.agents[candidate.owner.actorId];
        const actor = context.actors[candidate.owner.actorId];
        return (
          actor?.kind === 'chat' &&
          agent?.phase === 'working' &&
          agent.catchingUp
        );
      });
      if (catchingUp) return { kind: 'catching_up' };

      const activeLeaves = item.inProgressLeaves
        .map((leaf) => ({
          leaf,
          live: context.snapshot?.agents[leaf.owner.actorId],
          actor: context.actors[leaf.owner.actorId],
        }))
        .filter(
          (candidate) =>
            candidate.live !== undefined &&
            ledgerAgentIsWorking(candidate.live),
        );
      const active = activeLeaves.find(
        (candidate) => candidate.actor !== undefined,
      );
      if (active !== undefined && active.actor !== undefined) {
        return {
          kind: 'working',
          task: active.leaf.title,
          agentName: active.actor.displayName,
        };
      }
      return item.nextOpenLeaf === undefined
        ? null
        : { kind: 'next', task: item.nextOpenLeaf.title };
    }
    case 'blocked':
      return {
        kind: 'blocked',
        task: item.firstBlockedLeaf?.title ?? item.title,
      };
    case 'failed':
      return {
        kind: 'failed',
        task: item.firstFailedLeaf?.title ?? item.title,
      };
    case 'stopped':
    case 'todo':
      return item.nextOpenLeaf === undefined
        ? null
        : { kind: 'next', task: item.nextOpenLeaf.title };
    case 'completed':
      return null;
  }
}

/** The README's one-line copy for the Operations table's Doing now column. */
export function ledgerDoingNowText(
  value: LedgerDoingNow | null,
): string | null {
  if (value === null) return null;
  switch (value.kind) {
    case 'wait':
      return value.text;
    case 'review':
      return `To review: ${value.task}`;
    case 'catching_up':
      return 'Catching up';
    case 'working':
      return `${value.task} · ${value.agentName}`;
    case 'blocked':
      return `Blocked: ${value.task}`;
    case 'failed':
      return `Failed: ${value.task}`;
    case 'next':
      return `Next: ${value.task}`;
  }
}

/** Derives all visible table fields from the Feed page and live projection. */
export function deriveWorkRowViews(
  rows: readonly LedgerFeedWorkRow[],
  actors: Readonly<Record<string, LedgerActorLabel>>,
  snapshot: LedgerLiveSnapshot | null,
  now?: Date,
): LedgerWorkRowView[] {
  // `now` is accepted so a caller can share one clock with nearby Feed views;
  // the host already applied the completed-row window before returning rows.
  void now;
  const currentOperations = new Map<string, string>();
  for (const wait of snapshot?.waits ?? []) {
    if (wait.actorId !== null && !currentOperations.has(wait.actorId)) {
      const operationId = currentOperation(wait.actorId, rows);
      if (operationId !== null)
        currentOperations.set(wait.actorId, operationId);
    }
  }
  const context: LedgerWorkContext = { snapshot, currentOperations, actors };
  return rows.map((row) => {
    const status = workStatus(row, context);
    return {
      key: row.item.entryId,
      row,
      status,
      doingNow: doingNow(row, status, context),
      group: row.item.type === 'OPERATION' ? 'operation' : 'no_operation',
      lastActivityAt: row.item.lastActivityAt,
    };
  });
}

/** Counts only these rows, and always returns every Feed status. */
export function ledgerWorkStatusCounts(
  views: readonly LedgerWorkRowView[],
): LedgerWorkStatusCounts {
  const counts: LedgerWorkStatusCounts = {
    needs_you: 0,
    working: 0,
    blocked: 0,
    failed: 0,
    stopped: 0,
    todo: 0,
    completed: 0,
  };
  for (const view of views) counts[view.status] += 1;
  return counts;
}

export function filterWorkRowViews(
  views: readonly LedgerWorkRowView[],
  statusFilter: LedgerWorkStatus | null,
): readonly LedgerWorkRowView[] {
  return statusFilter === null
    ? views
    : views.filter((view) => view.status === statusFilter);
}

function progressFraction(view: LedgerWorkRowView): number {
  const info = ledgerProgressInfo(view.row.item);
  return !info.show || info.total === 0 ? 0 : info.done / info.total;
}

function primarySortValue(
  left: LedgerWorkRowView,
  right: LedgerWorkRowView,
  column: LedgerWorkSortColumn,
): number {
  switch (column) {
    case 'status':
      return (
        LEDGER_WORK_STATUSES.indexOf(left.status) -
        LEDGER_WORK_STATUSES.indexOf(right.status)
      );
    case 'operation':
      return left.row.item.title.localeCompare(
        right.row.item.title,
        undefined,
        {
          sensitivity: 'base',
        },
      );
    case 'progress':
      return progressFraction(left) - progressFraction(right);
    case 'lastActivity':
      return (
        Date.parse(left.lastActivityAt) - Date.parse(right.lastActivityAt) ||
        left.lastActivityAt.localeCompare(right.lastActivityAt)
      );
  }
}

/** Sorts each group independently, keeping operations above No operation. */
export function sortWorkRowViews(
  views: readonly LedgerWorkRowView[],
  sort: LedgerWorkSort | 'status',
): LedgerWorkRowView[] {
  const selectedSort = sort === 'status' ? LEDGER_WORK_STATUS_SORT : sort;
  const direction = selectedSort.direction === 'asc' ? 1 : -1;
  return [...views].sort((left, right) => {
    const groupOrder =
      (left.group === 'operation' ? 0 : 1) -
      (right.group === 'operation' ? 0 : 1);
    if (groupOrder !== 0) return groupOrder;
    const primary =
      primarySortValue(left, right, selectedSort.column) * direction;
    if (primary !== 0) return primary;
    const byActivity = right.lastActivityAt.localeCompare(left.lastActivityAt);
    return (
      byActivity || left.row.item.entryId.localeCompare(right.row.item.entryId)
    );
  });
}

export function nextLedgerWorkSort(
  current: LedgerWorkSort,
  column: LedgerWorkSortColumn,
): LedgerWorkSort {
  if (current.column === column) {
    return {
      column,
      direction: current.direction === 'asc' ? 'desc' : 'asc',
    };
  }
  return {
    column,
    direction: column === 'operation' || column === 'status' ? 'asc' : 'desc',
  };
}

/**
 * An operation's dots are its top-level tasks, and a task's its subtasks:
 * deeper tasks show only when their parent is opened.
 */
export function ledgerProgressInfo(item: LedgerRollupItem): LedgerProgressInfo {
  const counts = item.childCounts;
  return {
    show: item.hasChildTasks,
    statuses: item.childStatuses,
    counts,
    done: counts.COMPLETED ?? 0,
    total: ALL_LEAF_STATUSES.reduce(
      (total, status) => total + (counts[status] ?? 0),
      0,
    ),
  };
}

/** Orders waits by the locked L06 kind order, then reviews oldest first. */
export function deriveNeedsYou(
  snapshot: LedgerLiveSnapshot | null,
  reviews: readonly LedgerFeedRow[],
): LedgerNeedsYouItem[] {
  const waits = (snapshot?.waits ?? []).flatMap((wait) =>
    LEDGER_AGENT_WAIT_KINDS.includes(wait.kind)
      ? [
          {
            key: `${wait.kind}:${wait.id}`,
            kind: wait.kind,
            title: wait.title,
            scope: {
              projectId: wait.projectId,
              worktreeId: wait.worktreeId,
            },
            time: wait.since,
            wait,
          },
        ]
      : [],
  );
  const orderedWaits = LEDGER_AGENT_WAIT_KINDS.flatMap((kind) =>
    waits.filter((wait) => wait.kind === kind),
  );
  const orderedReviews = reviews
    .filter((row) => row.origin.kind === 'this_device')
    .slice()
    .sort((left, right) =>
      left.entry.updatedAt.localeCompare(right.entry.updatedAt),
    )
    .flatMap((row): LedgerNeedsYouItem[] =>
      row.origin.kind === 'this_device'
        ? [
            {
              key: `review:${row.entry.entryId}`,
              kind: 'review',
              title: row.entry.title,
              scope: row.origin.scope,
              time: row.entry.updatedAt,
              review: row,
            },
          ]
        : [],
    );
  return [...orderedWaits, ...orderedReviews];
}

function compareTreeEntry(
  left: LedgerEntrySearchItem,
  right: LedgerEntrySearchItem,
): number {
  // Rollup leaf order is parent entry ID, then entry ID, not insertion order.
  return left.entryId.localeCompare(right.entryId);
}

/**
 * Whether an Operations row is on a root chat filter's line, by the rule the
 * Activity search applies (`core.ledger.entries.search` `rootChat`): with
 * `rootOnly`, a root chat itself added it; otherwise the chat or a delegate
 * under it added it, or one of them owns it.
 */
export function ledgerWorkRowMatchesRootChat(
  row: LedgerFeedWorkRow,
  filter: LedgerRootChatFilter,
  actorHosts: Readonly<Record<string, LedgerViewActorHost>>,
): boolean {
  const origin = row.item.originChat;
  if (filter.rootOnly) {
    return (
      origin !== undefined &&
      !origin.viaDelegate &&
      (filter.chatId === undefined || origin.chatId === filter.chatId)
    );
  }
  if (origin?.chatId === filter.chatId) return true;
  const owner = actorHosts[row.item.owner.actorId];
  return (
    (owner?.kind === 'chat' && owner.chatId === filter.chatId) ||
    (owner?.kind === 'delegation' && owner.rootChatId === filter.chatId)
  );
}

/** A tree row on screen, and whether it opens to tasks under it. */
export interface LedgerVisibleWorkTreeRow {
  readonly row: LedgerWorkTreeRow;
  readonly hasChildren: boolean;
}

/**
 * The tree rows to show when only the rows in `openIds` are open: a row shows
 * while every row above it is open, so the tree starts at its top level.
 * `rows` is in `ledgerWorkTreeRows` order (depth first).
 */
export function ledgerVisibleWorkTreeRows(
  rows: readonly LedgerWorkTreeRow[],
  openIds: ReadonlySet<string>,
): LedgerVisibleWorkTreeRow[] {
  const visible: LedgerVisibleWorkTreeRow[] = [];
  // Rows deeper than this sit under a closed row.
  let closedDepth: number | null = null;
  rows.forEach((row, index) => {
    if (closedDepth !== null) {
      if (row.depth > closedDepth) return;
      closedDepth = null;
    }
    const next = rows[index + 1];
    visible.push({
      row,
      hasChildren: next !== undefined && next.depth > row.depth,
    });
    if (!openIds.has(row.entry.entryId)) closedDepth = row.depth;
  });
  return visible;
}

/** Flattens a parent-linked search result in deterministic depth-first order. */
export function ledgerWorkTreeRows(
  nodes: readonly LedgerEntrySearchItem[],
  rootOwner?: LedgerActorRef,
): LedgerWorkTreeRow[] {
  const byId = new Map(nodes.map((entry) => [entry.entryId, entry]));
  const children = new Map<string, LedgerEntrySearchItem[]>();
  const roots: LedgerEntrySearchItem[] = [];
  for (const entry of nodes) {
    const parentId = entry.parentEntryId;
    if (parentId === undefined || !byId.has(parentId)) {
      roots.push(entry);
      continue;
    }
    const siblingEntries = children.get(parentId) ?? [];
    siblingEntries.push(entry);
    children.set(parentId, siblingEntries);
  }
  roots.sort(compareTreeEntry);
  for (const siblingEntries of Array.from(children.values())) {
    siblingEntries.sort(compareTreeEntry);
  }

  const result: LedgerWorkTreeRow[] = [];
  const visited = new Set<string>();
  const visit = (
    entry: LedgerEntrySearchItem,
    depth: number,
    parentOwnerId?: string,
  ): void => {
    if (visited.has(entry.entryId)) return;
    visited.add(entry.entryId);
    result.push({
      entry,
      depth,
      showOwner:
        parentOwnerId === undefined || entry.owner.actorId !== parentOwnerId,
      ownerStateVisible: entry.status === 'IN_PROGRESS',
      childStatuses: (children.get(entry.entryId) ?? [])
        .filter((child) => child.type === 'TASK')
        .map((child) => child.status),
    });
    for (const child of children.get(entry.entryId) ?? []) {
      visit(child, depth + 1, entry.owner.actorId);
    }
  };
  for (const root of roots) {
    visit(root, 0, rootOwner?.actorId);
  }
  // Preserve entries even if a malformed result contains a parent cycle.
  for (const entry of [...nodes].sort(compareTreeEntry)) {
    if (!visited.has(entry.entryId)) visit(entry, 0, rootOwner?.actorId);
  }
  return result;
}
