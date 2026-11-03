import { create } from 'zustand';
import type { WorkspaceReadinessIssue } from '@canopy/desktop-shared/types';
import {
  WORKSPACE_READINESS_LAUNCHES_STORAGE_KEY,
  isSameLaunchedReadinessFix,
  launchedReadinessFixKey,
  launchedReadinessFixesForTarget,
  parseLaunchedReadinessFixes,
  resolvedLaunchedReadinessFixes,
  serializeLaunchedReadinessFixes,
  workspaceReadinessLaunchKey,
  type LaunchedReadinessFix,
  type LaunchedReadinessFixes,
} from '@/lib/workspaceReadinessLaunches';

function readLaunches(
  fallback: LaunchedReadinessFixes = {},
): LaunchedReadinessFixes {
  try {
    return parseLaunchedReadinessFixes(
      window.localStorage.getItem(WORKSPACE_READINESS_LAUNCHES_STORAGE_KEY),
    );
  } catch {
    return fallback;
  }
}

function writeLaunches(records: LaunchedReadinessFixes): void {
  try {
    window.localStorage.setItem(
      WORKSPACE_READINESS_LAUNCHES_STORAGE_KEY,
      serializeLaunchedReadinessFixes(records),
    );
  } catch {
    // Storage full or unavailable: the link still holds for this session, but
    // cannot survive a restart.
  }
}

type KeySet = Readonly<Record<string, true>>;

function withoutKeys(source: KeySet, keys: readonly string[]): KeySet {
  if (!keys.some((key) => source[key])) return source;
  const next: Record<string, true> = { ...source };
  for (const key of keys) delete next[key];
  return next;
}

function withKey(source: KeySet, key: string, present: boolean): KeySet {
  if (Boolean(source[key]) === present) return source;
  return present ? { ...source, [key]: true } : withoutKeys(source, [key]);
}

interface WorkspaceReadinessLaunchState {
  /**
   * Launched readiness fixes by scoped launch key, persisted in
   * `localStorage` so Home, the Overview and workspace settings keep linking
   * to the launched chat across remounts, reloads and restarts.
   */
  readonly records: LaunchedReadinessFixes;
  /** Launches whose first send has not settled; this session only. */
  readonly pendingSendKeys: KeySet;
  /** Launches whose first send failed; this session only. */
  readonly failedSendKeys: KeySet;
  readonly recordLaunch: (record: LaunchedReadinessFix) => void;
  /**
   * Removes each given record only while the stored record is still that
   * same launch, so stale evidence cannot delete a newer launch. Idempotent.
   */
  readonly removeLaunches: (records: readonly LaunchedReadinessFix[]) => void;
  readonly setSendPending: (key: string, pending: boolean) => void;
  readonly setSendFailed: (key: string, failed: boolean) => void;
  /** Re-reads persisted records, replacing the in-memory set. */
  readonly hydrate: () => void;
}

export const useWorkspaceReadinessLaunchStore =
  create<WorkspaceReadinessLaunchState>((set) => ({
    records: readLaunches(),
    pendingSendKeys: {},
    failedSendKeys: {},
    recordLaunch: (record): void =>
      set((state) => {
        const key = launchedReadinessFixKey(record);
        const records = { ...state.records, [key]: record };
        writeLaunches(records);
        return {
          records,
          failedSendKeys: withoutKeys(state.failedSendKeys, [key]),
        };
      }),
    removeLaunches: (targets): void =>
      set((state) => {
        const removed: string[] = [];
        for (const target of targets) {
          const key = launchedReadinessFixKey(target);
          const current = state.records[key];
          if (current && isSameLaunchedReadinessFix(current, target)) {
            removed.push(key);
          }
        }
        if (removed.length === 0) return state;
        const records: Record<string, LaunchedReadinessFix> = {
          ...state.records,
        };
        for (const key of removed) delete records[key];
        writeLaunches(records);
        return {
          records,
          pendingSendKeys: withoutKeys(state.pendingSendKeys, removed),
          failedSendKeys: withoutKeys(state.failedSendKeys, removed),
        };
      }),
    setSendPending: (key, pending): void =>
      set((state) => {
        const pendingSendKeys = withKey(state.pendingSendKeys, key, pending);
        return pendingSendKeys === state.pendingSendKeys
          ? state
          : { pendingSendKeys };
      }),
    setSendFailed: (key, failed): void =>
      set((state) => {
        const failedSendKeys = withKey(state.failedSendKeys, key, failed);
        return failedSendKeys === state.failedSendKeys
          ? state
          : { failedSendKeys };
      }),
    hydrate: (): void =>
      set((state) => ({ records: readLaunches(state.records) })),
  }));

/**
 * Call when an audit of one target begins; pass the result to
 * {@link pruneResolvedWorkspaceReadinessLaunches} when it succeeds.
 */
export function snapshotWorkspaceReadinessLaunches(
  workspaceId: string,
  baseWorktreeId: string | undefined,
): LaunchedReadinessFix[] {
  return launchedReadinessFixesForTarget(
    useWorkspaceReadinessLaunchStore.getState().records,
    workspaceId,
    baseWorktreeId,
  );
}

/**
 * Clears snapshot records whose issue a successful, complete audit of the
 * same target no longer reports. Callers must already have rejected stale
 * or superseded audit responses.
 */
export function pruneResolvedWorkspaceReadinessLaunches(
  snapshot: readonly LaunchedReadinessFix[],
  reportedIssues: readonly WorkspaceReadinessIssue[],
  complete: boolean | undefined,
): void {
  if (complete !== true) return;
  const resolved = resolvedLaunchedReadinessFixes(snapshot, reportedIssues);
  if (resolved.length > 0) {
    useWorkspaceReadinessLaunchStore.getState().removeLaunches(resolved);
  }
}

/** The retained launch for one issue on one audit target, if any. */
export function selectWorkspaceReadinessLaunch(
  state: Pick<WorkspaceReadinessLaunchState, 'records'>,
  workspaceId: string,
  baseWorktreeId: string | undefined,
  issueKey: string,
): LaunchedReadinessFix | undefined {
  return state.records[
    workspaceReadinessLaunchKey(workspaceId, baseWorktreeId, issueKey)
  ];
}
