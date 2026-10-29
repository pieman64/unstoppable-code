import type { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { dirname } from 'node:path';
import { runWithGitRequestContext } from '@canopy/desktop-shared/node/git-request-context';
import {
  IPC_CHANNELS,
  WORKSPACE_ROOT_REPO_ID,
  type SidebarItem,
  type WorktreeBranchChangedEvent,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import { getCurrentBranchDisplayName, getGitHeadWatchState } from './git';
import {
  logMainProcessDebug,
  logMainProcessInfo,
  logMainProcessWarn,
} from './main-process-logging';
import { getWorkspaceWorktreeDir } from './paths';
import { invalidateWorktreeStats } from './worktree-service';
import { observeWorktreeGit } from './worktree-git-observations';
import { WorktreeRecordRefusedError } from './worktree-repair';
import { listWorkspaceWorktreeRepoEntries } from './worktree-repo-entries';
import { sendToWindow } from './window-send';
import { detachedWorkCallback } from '@canopy/desktop-shared/node/lib/detached-work';

interface WatchedRepoRef {
  projectId: string;
  worktreeId: string;
  repoPath: string;
  repoId?: string;
  /**
   * The sidebar branch main last recorded for this checkout. Child repos of a
   * multi-repo worktree have no persisted branch of their own, so it is null.
   */
  persistedBranchName: string | null;
}

interface BranchWatcherEntry extends WatchedRepoRef {
  watcher: FSWatcher;
  branchName: string | null;
  refreshTimer: ReturnType<typeof setTimeout> | null;
}

/** The worktree a git-ready event names; see `ensureWorktreeBranchWatchers`. */
export interface WorktreeBranchWatchTarget {
  projectId: string;
  worktreeId: string;
  workspaceKind: 'single-repo' | 'multi-repo';
  branchName: string;
}

type BranchRecordOutcome =
  | 'recorded'
  | 'unchanged'
  | 'not-found'
  | 'refused'
  | 'failed';

const branchWatchers = new Map<string, BranchWatcherEntry>();
const retiredBranchWatchers = new Set<FSWatcher>();
const pendingStarts = new Map<string, Promise<boolean>>();
let syncGeneration = 0;
let stopEpoch = 0;

function runBranchWatcherGit<T>(callback: () => Promise<T>): Promise<T> {
  return runWithGitRequestContext(
    { source: 'branch-watcher', requestId: randomUUID() },
    callback,
  );
}

function getWatcherKey(
  ref: Pick<WatchedRepoRef, 'projectId' | 'worktreeId' | 'repoId'>,
): string {
  return `${ref.projectId}/${ref.worktreeId}/${ref.repoId ?? 'root'}`;
}

function getWorktreeKey(projectId: string, worktreeId: string): string {
  return `${projectId}/${worktreeId}`;
}

function closeWatcher(entry: BranchWatcherEntry): void {
  if (entry.refreshTimer) {
    clearTimeout(entry.refreshTimer);
    entry.refreshTimer = null;
  }
  entry.watcher.close();
}

function retireWatcher(entry: BranchWatcherEntry): void {
  if (entry.refreshTimer) {
    clearTimeout(entry.refreshTimer);
    entry.refreshTimer = null;
  }
  retiredBranchWatchers.add(entry.watcher);
}

/** Git reports a detached HEAD as the literal `HEAD`, which names no branch. */
function isBranchName(branchName: string | null): branchName is string {
  return branchName !== null && branchName !== '' && branchName !== 'HEAD';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function collectWorktreeRepoRefs(
  projectId: string,
  workspaceKind: 'single-repo' | 'multi-repo',
  worktree: Pick<WorktreeData, 'id' | 'branchName'>,
): Promise<WatchedRepoRef[]> {
  const worktreePath = getWorkspaceWorktreeDir(projectId, worktree.id);
  if (workspaceKind === 'single-repo') {
    return [
      {
        projectId,
        worktreeId: worktree.id,
        repoPath: worktreePath,
        persistedBranchName: worktree.branchName,
      },
    ];
  }

  const repoEntries = await listWorkspaceWorktreeRepoEntries(
    projectId,
    worktreePath,
  ).catch((error: unknown) => {
    logMainProcessWarn('Worktree branch watcher repos unavailable', {
      key: getWorktreeKey(projectId, worktree.id),
      error: describeError(error),
    });
    return [];
  });
  return repoEntries.map((repo) => ({
    projectId,
    worktreeId: worktree.id,
    repoId: repo.repoId,
    repoPath: repo.repoPath,
    persistedBranchName:
      repo.repoId === WORKSPACE_ROOT_REPO_ID ? worktree.branchName : null,
  }));
}

interface CollectedWatchedRepos {
  refs: WatchedRepoRef[];
  /** Worktrees whose checkout is still being created; see the sync. */
  pendingWorktreeKeys: Set<string>;
}

async function collectWatchedRepos(
  items: SidebarItem[],
): Promise<CollectedWatchedRepos> {
  const refs: WatchedRepoRef[] = [];
  const pendingWorktreeKeys = new Set<string>();

  for (const item of items) {
    if (item.type === 'cowork') {
      continue;
    }

    for (const worktree of item.worktrees) {
      // A checkout still being created has no HEAD to watch yet. Its git-ready
      // hook starts the watcher (`ensureWorktreeBranchWatchers`).
      if (worktree.setupPhase === 'git-pending') {
        pendingWorktreeKeys.add(getWorktreeKey(item.id, worktree.id));
        continue;
      }
      refs.push(
        ...(await collectWorktreeRepoRefs(item.id, item.type, worktree)),
      );
    }
  }

  return { refs, pendingWorktreeKeys };
}

/**
 * Records the branch through `internal.worktree.git.observe`. The renderer is
 * told about the branch either way, so a failed or refused write is dropped
 * here, as before.
 */
async function persistBranchChange(
  event: WorktreeBranchChangedEvent,
): Promise<BranchRecordOutcome> {
  return observeWorktreeGit({
    kind: 'branch',
    workspaceId: event.projectId,
    worktreeId: event.worktreeId,
    branchName: event.branchName,
    ...(event.repoId ? { repoId: event.repoId } : {}),
  }).then(
    (outcome) => outcome.status,
    (error: unknown) =>
      error instanceof WorktreeRecordRefusedError ? 'refused' : 'failed',
  );
}

/**
 * Records a checkout's branch and tells the renderer. The HEAD watcher calls
 * it on a branch change, and the branch namer calls it after its own rename so
 * the sidebar does not depend on a watcher being attached. Both fire within
 * moments of the rename, so recording the same branch twice keeps the name. A
 * live watcher entry already holds it, so its next HEAD event is a no-op. Like
 * any branch observation, the second write still clears a recorded PR status.
 */
export async function recordWorktreeBranchChange(
  event: WorktreeBranchChangedEvent,
  getWindow: () => BrowserWindow | null,
): Promise<void> {
  const key = getWatcherKey(event);
  const entry = branchWatchers.get(key);
  if (entry) {
    entry.branchName = event.branchName;
  }
  invalidateWorktreeStats(event.projectId, event.worktreeId);
  const outcome = await persistBranchChange(event);
  // A dropped write leaves the sidebar on the old name until the next start.
  const log =
    outcome === 'failed' || outcome === 'refused'
      ? logMainProcessWarn
      : logMainProcessDebug;
  log('Worktree branch recorded', { key, outcome });

  const window = getWindow();
  if (!window) {
    return;
  }
  sendToWindow(window, IPC_CHANNELS.worktreeBranchChanged, event);
}

function scheduleBranchRefresh(
  entry: BranchWatcherEntry,
  getWindow: () => BrowserWindow | null,
): void {
  if (entry.refreshTimer) {
    clearTimeout(entry.refreshTimer);
  }

  entry.refreshTimer = setTimeout(
    detachedWorkCallback(() => {
      entry.refreshTimer = null;
      return refreshBranch(entry, getWindow);
    }),
    100,
  );
}

async function refreshBranch(
  entry: BranchWatcherEntry,
  getWindow: () => BrowserWindow | null,
): Promise<void> {
  const branchName = await runBranchWatcherGit(() =>
    getCurrentBranchDisplayName(entry.repoPath),
  ).catch(() => null);
  if (!isBranchName(branchName) || branchName === entry.branchName) {
    logMainProcessDebug('Worktree branch unchanged', {
      key: getWatcherKey(entry),
    });
    return;
  }

  entry.branchName = branchName;
  await recordWorktreeBranchChange(
    {
      projectId: entry.projectId,
      worktreeId: entry.worktreeId,
      branchName,
      ...(entry.repoId ? { repoId: entry.repoId } : {}),
    },
    getWindow,
  );
}

/**
 * Starts one watcher and catches up on a branch change it missed: a rename
 * made while nothing watched this checkout is recorded now. Returns whether a
 * watcher was installed.
 */
async function startWatcher(
  ref: WatchedRepoRef,
  getWindow: () => BrowserWindow | null,
  isStale: () => boolean,
): Promise<boolean> {
  const key = getWatcherKey(ref);
  const { headPath, branchName } = await runBranchWatcherGit(() =>
    getGitHeadWatchState(ref.repoPath),
  );
  if (isStale() || branchWatchers.has(key)) {
    return false;
  }
  const watcher = watch(
    dirname(headPath),
    { persistent: false },
    (_event, filename) => {
      if (filename && filename.toString() !== 'HEAD') {
        return;
      }
      logMainProcessDebug('Worktree branch watcher HEAD event', {
        key,
        filename: filename?.toString() ?? null,
      });
      const entry = branchWatchers.get(key);
      if (entry?.watcher === watcher) {
        scheduleBranchRefresh(entry, getWindow);
      }
    },
  );

  watcher.on('error', (error: unknown) => {
    logMainProcessWarn('Worktree branch watcher stopped', {
      key,
      error: describeError(error),
    });
    const entry = branchWatchers.get(key);
    if (entry?.watcher === watcher) {
      if (entry.refreshTimer) clearTimeout(entry.refreshTimer);
      // The next sync or git-ready start re-creates it and catches up.
      branchWatchers.delete(key);
    } else {
      retiredBranchWatchers.delete(watcher);
    }
  });

  // Seed with the recorded branch so a checkout that moved while unwatched is
  // compared with what the sidebar shows, not with what HEAD holds now. Git
  // reports a detached HEAD as `HEAD`; it and a failed read have no branch to
  // catch up on, so they seed from live HEAD as before.
  const onBranch = isBranchName(branchName);
  const entry: BranchWatcherEntry = {
    ...ref,
    watcher,
    branchName: onBranch ? (ref.persistedBranchName ?? branchName) : branchName,
    refreshTimer: null,
  };
  branchWatchers.set(key, entry);

  // The watcher is registered first, so a HEAD change during this write still
  // schedules its own refresh. A failed catch-up leaves the watcher running.
  if (entry.branchName !== branchName) {
    await refreshBranch(entry, getWindow).catch((error: unknown) => {
      logMainProcessWarn('Worktree branch catch-up failed', {
        key,
        error: describeError(error),
      });
    });
  }
  return true;
}

type StartResult = 'started' | 'present' | 'stale';

/** One start per key: a caller that finds a start in flight waits for it. */
async function startWatcherOnce(
  ref: WatchedRepoRef,
  getWindow: () => BrowserWindow | null,
  isStale: () => boolean,
): Promise<StartResult> {
  const key = getWatcherKey(ref);
  for (;;) {
    if (branchWatchers.has(key)) {
      return 'present';
    }
    const pending = pendingStarts.get(key);
    if (!pending) {
      break;
    }
    // A start from a superseded sync may install nothing, so check again.
    await pending.catch(() => false);
  }
  if (isStale()) {
    return 'stale';
  }

  const start = startWatcher(ref, getWindow, isStale);
  pendingStarts.set(key, start);
  try {
    return (await start) ? 'started' : 'stale';
  } finally {
    if (pendingStarts.get(key) === start) {
      pendingStarts.delete(key);
    }
  }
}

export async function syncWorktreeBranchWatchers(
  items: SidebarItem[],
  getWindow: () => BrowserWindow | null,
  preserveWorkspaceIds: ReadonlySet<string> = new Set(),
): Promise<void> {
  const generation = ++syncGeneration;
  const isStale = (): boolean => generation !== syncGeneration;
  const { refs, pendingWorktreeKeys } = await collectWatchedRepos(items);
  const summary = {
    refs: refs.length,
    started: 0,
    retired: 0,
    present: 0,
    failed: 0,
    superseded: false,
  };
  if (isStale()) {
    summary.superseded = true;
    logMainProcessInfo('Worktree branch watchers synced', summary);
    return;
  }

  const nextKeys = new Set(refs.map(getWatcherKey));
  for (const [key, entry] of Array.from(branchWatchers.entries())) {
    if (
      !nextKeys.has(key) &&
      !preserveWorkspaceIds.has(entry.projectId) &&
      // A snapshot taken before git-ready keeps the watcher that the
      // git-ready hook already started.
      !pendingWorktreeKeys.has(
        getWorktreeKey(entry.projectId, entry.worktreeId),
      )
    ) {
      retireWatcher(entry);
      branchWatchers.delete(key);
      summary.retired += 1;
    }
  }

  for (const ref of refs) {
    if (isStale()) {
      summary.superseded = true;
      break;
    }
    try {
      const result = await startWatcherOnce(ref, getWindow, isStale);
      if (result === 'started') summary.started += 1;
      if (result === 'present') summary.present += 1;
    } catch (error) {
      summary.failed += 1;
      logMainProcessInfo('Worktree branch watcher failed to start', {
        key: getWatcherKey(ref),
        error: describeError(error),
      });
    }
  }
  logMainProcessInfo('Worktree branch watchers synced', summary);
}

/**
 * Starts the watchers of one worktree whose checkout just became ready. Unlike
 * a sync, it neither supersedes a sync in flight nor retires other watchers.
 * The start catches up, so a rename made before git-ready is recorded too.
 */
export async function ensureWorktreeBranchWatchers(
  target: WorktreeBranchWatchTarget,
  getWindow: () => BrowserWindow | null,
): Promise<void> {
  const epoch = stopEpoch;
  const isStale = (): boolean => epoch !== stopEpoch;
  const refs = await collectWorktreeRepoRefs(
    target.projectId,
    target.workspaceKind,
    { id: target.worktreeId, branchName: target.branchName },
  );
  for (const ref of refs) {
    if (isStale()) {
      return;
    }
    await startWatcherOnce(ref, getWindow, isStale).catch((error: unknown) => {
      logMainProcessInfo('Worktree branch watcher failed to start', {
        key: getWatcherKey(ref),
        error: describeError(error),
      });
    });
  }
}

export function stopWorktreeBranchWatchers(): void {
  syncGeneration += 1;
  stopEpoch += 1;
  for (const entry of Array.from(branchWatchers.values())) {
    closeWatcher(entry);
  }
  branchWatchers.clear();
  for (const watcher of Array.from(retiredBranchWatchers)) {
    try {
      watcher.close();
    } catch {
      // The runtime may already have stopped a watcher after its path moved.
    }
  }
  retiredBranchWatchers.clear();
}
