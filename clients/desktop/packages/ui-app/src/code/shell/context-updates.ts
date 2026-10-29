import type {
  ForeignActivityProjection,
  ForeignActivityWorkspace,
} from '@canopy/protocol/foreign-activity';
import {
  isSameWorkspaceContext,
  serializeWorkspaceContext,
  type WorkspaceContext,
} from '@canopy/protocol/workspace-context';
import type { SidebarSurfaceSnapshot } from './SidebarSurface';
import type { SnapshotWorkspace } from './worktree-status';

/**
 * Other-context updates (CAN-2959, CAN-3522): the blue dot the shared
 * `SidebarContextRow` paints on the switcher and on a context's menu row.
 *
 * Two pieces live here so desktop and the web portal cannot drift:
 *
 * - {@link contextKeysWithUpdates} is THE definition of an update. Both hosts
 *   feed it a `ForeignActivityProjection`-shaped list of groups: a context
 *   has updates when any of its workspaces has carried work running, a new
 *   unread result, or work interrupted while running.
 * - The carryover reducer ({@link startContextCarryover} and friends) is the
 *   portal's source of that projection. The desktop main process owns the
 *   authoritative `ForeignActivityLedger` over its own chat, pipeline and
 *   script operations; the portal only sees the paired desktop's and the
 *   cloud's snapshot rows, so it applies the same ledger rules to them:
 *   each switch starts a new epoch and discards previous carryover, work
 *   already running in another context is registered, unread badges that
 *   predate the epoch are never imported, a carried run that finishes with
 *   unread attention stays until it is read, one that finishes quietly
 *   lingers 30 seconds without a dot, and one that disappears while running
 *   lingers as interrupted. The selected context is never tracked.
 */

/** Key a context the way the switcher's test ids and dots do. */
export function contextUpdateKey(context: WorkspaceContext): string {
  return context.kind === 'personal' ? 'personal' : context.organizationId;
}

/** Whether a carried workspace row is an update: running, unread, or interrupted. */
export function isForeignActivityUpdate(
  workspace: Pick<
    ForeignActivityWorkspace,
    'running' | 'unread' | 'interrupted'
  >,
): boolean {
  return workspace.running > 0 || workspace.unread > 0 || workspace.interrupted;
}

/** The contexts, keyed `'personal'` or by organization id, that have updates. */
export function contextKeysWithUpdates(
  projection: Pick<ForeignActivityProjection, 'groups'>,
): ReadonlySet<string> {
  return new Set(
    projection.groups
      .filter((group) => group.workspaces.some(isForeignActivityUpdate))
      .map((group) => contextUpdateKey(group.context)),
  );
}

/** How long a quiet or interrupted completion stays carried. */
export const CONTEXT_CARRYOVER_LINGER_MS = 30_000;
/** Completed entries kept per epoch, matching the desktop ledger bound. */
const CONTEXT_CARRYOVER_COMPLETED_LIMIT = 200;

/** One observable unit of work: a worktree row or a Work Entry chat. */
export interface ContextActivityItem {
  readonly key: string;
  readonly context: WorkspaceContext;
  readonly workspaceId: string;
  readonly name: string;
  readonly active: boolean;
  readonly unread: boolean;
  /**
   * The leg that produced the row (`'cloud'` or `'remote-control'` on the
   * portal). A snapshot is authoritative only for the legs it was built from,
   * so an absent leg's carryover is left alone instead of looking vanished.
   */
  readonly source?: string;
}

type CarryoverEntryState = 'active' | 'completed-unread' | 'completed-linger';

interface CarryoverEntry {
  readonly item: ContextActivityItem;
  readonly state: CarryoverEntryState;
  readonly changedAt: number;
  readonly interrupted: boolean;
}

export interface ContextCarryoverState {
  /** The selected context this epoch started in; never tracked. */
  readonly context: WorkspaceContext;
  readonly entries: ReadonlyMap<string, CarryoverEntry>;
  /**
   * Last unread flag seen for each untracked foreign item, so only a new
   * unread result registers and a pre-existing badge never does.
   */
  readonly unreadSeen: ReadonlyMap<string, boolean>;
}

function isForeign(
  item: ContextActivityItem,
  context: WorkspaceContext,
): boolean {
  return !isSameWorkspaceContext(item.context, context);
}

function withoutExpired(
  entries: Map<string, CarryoverEntry>,
  now: number,
): void {
  for (const [key, entry] of Array.from(entries)) {
    if (isExpired(entry, now)) entries.delete(key);
  }
}

function isExpired(entry: CarryoverEntry, now: number): boolean {
  return (
    entry.state === 'completed-linger' &&
    now - entry.changedAt >= CONTEXT_CARRYOVER_LINGER_MS
  );
}

function boundCompleted(entries: Map<string, CarryoverEntry>): void {
  const completed = Array.from(entries)
    .filter(([, entry]) => entry.state !== 'active')
    .sort(([, left], [, right]) => right.changedAt - left.changedAt);
  for (const [key] of completed.slice(CONTEXT_CARRYOVER_COMPLETED_LIMIT))
    entries.delete(key);
}

/**
 * Start a new epoch for a deliberate switch (or the first read): previous
 * carryover is discarded, foreign work already running is registered, and the
 * current unread flags become the baseline.
 */
export function startContextCarryover(
  context: WorkspaceContext,
  items: readonly ContextActivityItem[],
  now: number,
): ContextCarryoverState {
  const entries = new Map<string, CarryoverEntry>();
  const unreadSeen = new Map<string, boolean>();
  for (const item of items) {
    if (!isForeign(item, context)) continue;
    if (item.active) {
      entries.set(item.key, {
        item,
        state: 'active',
        changedAt: now,
        interrupted: false,
      });
    } else {
      unreadSeen.set(item.key, item.unread);
    }
  }
  return { context, entries, unreadSeen };
}

/**
 * Apply a newer snapshot within the current epoch. `authoritativeSources`
 * names the legs the snapshot fully represents; carryover from any other leg
 * is kept as it is until its own leg reports again. Omitted means every leg.
 */
export function observeContextCarryover(
  state: ContextCarryoverState,
  items: readonly ContextActivityItem[],
  now: number,
  authoritativeSources?: ReadonlySet<string>,
): ContextCarryoverState {
  const authoritative = (item: ContextActivityItem): boolean =>
    authoritativeSources === undefined ||
    (item.source !== undefined && authoritativeSources.has(item.source));
  const entries = new Map(state.entries);
  const unreadSeen = new Map(state.unreadSeen);
  withoutExpired(entries, now);
  const present = new Map<string, ContextActivityItem>();
  for (const item of items) {
    if (isForeign(item, state.context)) present.set(item.key, item);
  }
  for (const [key, entry] of Array.from(entries)) {
    const item = present.get(key);
    if (item === undefined) {
      // Only the leg that produced the row can say it is gone.
      if (!authoritative(entry.item)) continue;
      // Work that vanished while running is interrupted. A finished unread
      // result whose row is gone can never be read, so its dot goes too;
      // a quiet completion keeps lingering until it expires.
      if (entry.state === 'active')
        entries.set(key, {
          ...entry,
          state: 'completed-linger',
          changedAt: now,
          interrupted: true,
        });
      else if (entry.state === 'completed-unread') entries.delete(key);
      continue;
    }
    if (item.active) {
      entries.set(key, {
        item,
        state: 'active',
        changedAt: entry.changedAt,
        interrupted: false,
      });
      continue;
    }
    if (entry.state === 'completed-unread' && !item.unread) {
      // Read elsewhere: the dot goes, and the badge is now the baseline.
      entries.delete(key);
      unreadSeen.set(key, false);
      continue;
    }
    entries.set(key, {
      item,
      state: item.unread ? 'completed-unread' : 'completed-linger',
      changedAt: entry.state === 'active' ? now : entry.changedAt,
      interrupted: false,
    });
    // A quiet completion is read, so a later unread flag is a new result
    // even after its linger has expired.
    if (!item.unread) unreadSeen.set(key, false);
  }
  for (const [key, item] of present) {
    if (entries.has(key)) continue;
    if (item.active) {
      entries.set(key, {
        item,
        state: 'active',
        changedAt: now,
        interrupted: false,
      });
      unreadSeen.delete(key);
      continue;
    }
    // A snapshot can miss a short run entirely; a fresh unread flag after the
    // epoch is that run's result. First sight only records the baseline.
    if (item.unread && unreadSeen.get(key) === false) {
      entries.set(key, {
        item,
        state: 'completed-unread',
        changedAt: now,
        interrupted: false,
      });
      unreadSeen.delete(key);
      continue;
    }
    unreadSeen.set(key, item.unread);
  }
  boundCompleted(entries);
  return { context: state.context, entries, unreadSeen };
}

/** The carryover as `ForeignActivityProjection` groups, for {@link contextKeysWithUpdates}. */
export function contextCarryoverProjection(
  state: ContextCarryoverState,
  now: number,
): ForeignActivityProjection['groups'] {
  const groups = new Map<string, ForeignActivityProjection['groups'][number]>();
  for (const entry of state.entries.values()) {
    if (isExpired(entry, now)) continue;
    const { item } = entry;
    const groupKey = serializeWorkspaceContext(item.context);
    let group = groups.get(groupKey);
    if (group === undefined) {
      group = { context: item.context, workspaces: [] };
      groups.set(groupKey, group);
    }
    let row = group.workspaces.find(
      (workspace) => workspace.workspaceId === item.workspaceId,
    );
    if (row === undefined) {
      const target = {
        source: 'chat' as const,
        operationId: item.key,
        workspaceId: item.workspaceId,
        worktreeId: item.key,
        resultToken: null,
      };
      row = {
        workspaceId: item.workspaceId,
        name: item.name,
        running: 0,
        unread: 0,
        interrupted: false,
        latestTarget: target,
        stopTargets: [],
      };
      group.workspaces.push(row);
    }
    if (entry.state === 'active') row.running += 1;
    if (entry.state === 'completed-unread') row.unread += 1;
    if (entry.interrupted) row.interrupted = true;
  }
  return Array.from(groups.values());
}

/**
 * When the next lingering entry expires, so the host can re-render then.
 * Entries already expired at `now` are skipped: state keeps them until the
 * next snapshot, and they must not hide a later deadline.
 */
export function contextCarryoverDeadline(
  state: ContextCarryoverState,
  now: number,
): number | null {
  let deadline: number | null = null;
  for (const entry of state.entries.values()) {
    if (entry.state !== 'completed-linger' || isExpired(entry, now)) continue;
    const expires = entry.changedAt + CONTEXT_CARRYOVER_LINGER_MS;
    if (deadline === null || expires < deadline) deadline = expires;
  }
  return deadline;
}

export type ContextActivitySnapshot = Pick<
  SidebarSurfaceSnapshot,
  'workspaces' | 'worktrees' | 'standaloneChats'
>;

const PERSONAL: WorkspaceContext = { kind: 'personal' };

/** The leg a portal row came from: the cloud, or the paired desktop. */
export type ContextActivitySource = 'cloud' | 'remote-control';
const REMOTE_CONTROL_SOURCE: ContextActivitySource = 'remote-control';

/**
 * Cloud rows are stamped `backend: 'cloud'`; everything else in a portal
 * snapshot came through the paired desktop (`'remote-control'` or the
 * unstamped `'desktop'`).
 */
export function activitySourceOf(
  backend: SnapshotWorkspace['backend'],
): ContextActivitySource {
  return backend === 'cloud' ? 'cloud' : REMOTE_CONTROL_SOURCE;
}

function workspaceContext(owner: SnapshotWorkspace['owner']): WorkspaceContext {
  return owner === undefined || owner.type === 'personal'
    ? PERSONAL
    : { kind: 'organization', organizationId: owner.organizationId };
}

/**
 * The portal's operations: every worktree row (working when the shared row
 * would show it working) and every Work Entry chat, attributed to the context
 * that owns its workspace. Catalog placeholders are not workspaces.
 */
export function contextActivityItemsFromSnapshot(
  snapshot: ContextActivitySnapshot,
): ContextActivityItem[] {
  const workspaces = new Map<
    string,
    {
      readonly name: string;
      readonly context: WorkspaceContext;
      readonly source: string;
    }
  >();
  for (const workspace of snapshot.workspaces) {
    if (workspace.placeholder !== undefined) continue;
    workspaces.set(workspace.localId, {
      name: workspace.name,
      context: workspaceContext(workspace.owner),
      source: activitySourceOf(workspace.backend),
    });
  }
  const items: ContextActivityItem[] = [];
  for (const worktree of snapshot.worktrees) {
    const workspace = workspaces.get(worktree.workspaceLocalId);
    if (workspace === undefined) continue;
    items.push({
      key: `worktree:${worktree.workspaceLocalId}/${worktree.localId}`,
      context: workspace.context,
      workspaceId: worktree.workspaceLocalId,
      name: workspace.name,
      source: workspace.source,
      active:
        worktree.isStreaming === true ||
        worktree.busy === true ||
        worktree.isRunningRun === true ||
        worktree.pipelineStatus === 'running',
      unread: worktree.hasUnread === true,
    });
  }
  for (const chat of snapshot.standaloneChats) {
    // A chat with no project is Personal, as the sidebar scopes it.
    const projectLocalId = chat.projectLocalId;
    const workspace =
      projectLocalId === undefined
        ? { name: 'Chats', context: PERSONAL, source: REMOTE_CONTROL_SOURCE }
        : workspaces.get(projectLocalId);
    if (workspace === undefined) continue;
    items.push({
      key: `chat:${projectLocalId ?? ''}/${chat.localId}`,
      context: workspace.context,
      workspaceId: projectLocalId ?? '',
      name: workspace.name,
      source: workspace.source,
      active: chat.hasActiveChat === true,
      unread: chat.hasUnread === true,
    });
  }
  return items;
}
