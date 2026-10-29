import type {
  ChatTabsFile,
  PortalEntityEnvelope,
  PortalTarget,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  listDelegationActivity,
  parseDelegationSessionKey,
  subscribeDelegationActivity,
} from '../agents/delegation/activity';
import {
  getAllActiveSessionInfos,
  subscribeChatSessionActivity,
} from '../agents/session-manager';
import {
  listActiveHookRunTargets,
  subscribeActiveHookRunsChanged,
} from '../lib/hook-runner';
import {
  listTrackedShellScripts,
  subscribeTrackedScriptsChanged,
} from '../lib/script-runner';
import { deriveWorktreeChatBadgesSummary } from '../lib/chat-badge-sync';
import {
  createPortalEvent,
  enqueuePortalEvent,
  isCanopyPortalActive,
} from '../portal/portal-event-bus';
import {
  getActivePipelineExecutionHandles,
  subscribeToActiveCountChange,
} from '../pipelines/pipeline-execution-registry';
import { ptyManager } from '../terminal/pty-manager';
import { subscribePipelineRunUpdates } from './pipelines-service';
import { scheduleDesktopSessionSnapshotInvalidation } from './desktop-session-snapshot-invalidation';

const SESSION_REFRESH_DELAY_MS = 35;

export interface WorktreeRuntimeStatus {
  isStreaming?: boolean;
  hasUnread?: boolean;
  awaitingApproval?: boolean;
  lastActivityAt?: string;
  pipelineStatus?: 'running' | 'paused';
  terminalStatus?: 'running';
  scriptStatus?: 'running';
  hookStatus?: 'running';
  isRunningRun?: boolean;
}

interface WorktreeRuntimeStatusInput {
  workspaceId: string;
  worktree: WorktreeData;
}

interface SessionStatus {
  isStreaming: boolean;
  lastActivityAt?: number;
}

interface PersistedStatus {
  hasUnread?: boolean;
  awaitingApproval?: boolean;
  lastActivityAt?: number;
}

interface MirroredBadges {
  hasUnread: boolean;
  awaitingApproval: boolean;
}

let started = false;
let generation = 0;
let unsubscribeSessionActivity: (() => void) | null = null;
let unsubscribeDelegationActivity: (() => void) | null = null;
let unsubscribePipelineCount: (() => void) | null = null;
let unsubscribePipelineUpdates: (() => void) | null = null;
let unsubscribeTerminalActivity: (() => void) | null = null;
let unsubscribeScriptActivity: (() => void) | null = null;
let unsubscribeHookActivity: (() => void) | null = null;
let sessionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let sessionStatuses = new Map<string, SessionStatus>();
let executionStatuses = new Map<string, WorktreeRuntimeStatus>();
// These maps hold one entry per worktree observed this process session.
// They are bounded by the user's worktree set (not by activity volume); stale
// entries for deleted worktrees are inert. Persisted statuses follow every
// chat write, so they outlive portal sessions; the rest clear on stop.
const persistedStatuses = new Map<string, PersistedStatus>();
// The worktrees.json badge mirror as of the latest snapshot, for deltas.
const mirroredBadges = new Map<string, MirroredBadges>();
const fingerprints = new Map<string, string>();
const emissionVersions = new Map<string, number>();

function statusKey(workspaceId: string, worktreeId: string): string {
  return `${workspaceId}\0${worktreeId}`;
}

function splitStatusKey(key: string): {
  workspaceId: string;
  worktreeId: string;
} {
  const separator = key.indexOf('\0');
  return {
    workspaceId: key.slice(0, separator),
    worktreeId: key.slice(separator + 1),
  };
}

function bucketActivityAt(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return new Date(Math.floor(value / 1000) * 1000).toISOString();
}

function buildSessionStatuses(): Map<string, SessionStatus> {
  const statuses = new Map<string, SessionStatus>();
  for (const session of getAllActiveSessionInfos()) {
    const key = statusKey(session.projectId, session.worktreeId);
    const current = statuses.get(key);
    statuses.set(key, {
      isStreaming: current?.isStreaming === true || session.turnActive,
      lastActivityAt: Math.max(
        current?.lastActivityAt ?? 0,
        session.lastActivityAt,
      ),
    });
  }
  // Queued, starting or running delegates keep their root chat's worktree or
  // Work Entry working, even when no root session is attached.
  for (const entry of listDelegationActivity()) {
    const chat = parseDelegationSessionKey(entry.sessionKey);
    if (!chat) continue;
    const key = statusKey(chat.projectId, chat.worktreeId);
    statuses.set(key, { ...statuses.get(key), isStreaming: true });
  }
  return statuses;
}

function buildExecutionStatuses(): Map<string, WorktreeRuntimeStatus> {
  const statuses = new Map<string, WorktreeRuntimeStatus>();
  for (const handle of getActivePipelineExecutionHandles()) {
    const state = handle.getState();
    if (!state.project_id || !state.worktree_id) continue;
    const key = statusKey(state.project_id, state.worktree_id);
    const current = statuses.get(key);
    if (state.status === 'running') {
      statuses.set(key, {
        ...current,
        pipelineStatus: 'running',
        isRunningRun: true,
      });
    } else if (
      state.status === 'paused' &&
      current?.pipelineStatus !== 'running'
    ) {
      statuses.set(key, { ...current, pipelineStatus: 'paused' });
    }
  }
  for (const target of ptyManager.getRunningWorktreeTargets()) {
    const key = statusKey(target.projectId, target.worktreeId);
    statuses.set(key, { ...statuses.get(key), terminalStatus: 'running' });
  }
  for (const tracking of listTrackedShellScripts()) {
    const key = statusKey(tracking.projectId, tracking.worktreeId);
    statuses.set(key, { ...statuses.get(key), scriptStatus: 'running' });
  }
  for (const target of listActiveHookRunTargets()) {
    const key = statusKey(target.projectId, target.worktreeId);
    statuses.set(key, { ...statuses.get(key), hookStatus: 'running' });
  }
  return statuses;
}

function combineStatus(key: string): WorktreeRuntimeStatus {
  const session = sessionStatuses.get(key);
  const persisted = persistedStatuses.get(key);
  const execution = executionStatuses.get(key);
  const badges = mirroredBadges.get(key);
  const liveLastActivityAt = session?.lastActivityAt;
  const persistedLastActivityAt = persisted?.lastActivityAt;
  const lastActivityAt =
    liveLastActivityAt === undefined && persistedLastActivityAt === undefined
      ? undefined
      : Math.max(liveLastActivityAt ?? 0, persistedLastActivityAt ?? 0);
  const bucketedActivityAt = bucketActivityAt(lastActivityAt);

  return {
    ...(session?.isStreaming === true ? { isStreaming: true } : {}),
    // Live chat writes are always at least as fresh as the asynchronously
    // flushed mirror, so they win over it.
    ...(persisted?.hasUnread === true ||
    (persisted?.hasUnread === undefined && badges?.hasUnread === true)
      ? { hasUnread: true }
      : {}),
    ...(persisted?.awaitingApproval === true ||
    (persisted?.awaitingApproval === undefined &&
      badges?.awaitingApproval === true)
      ? { awaitingApproval: true }
      : {}),
    ...(bucketedActivityAt ? { lastActivityAt: bucketedActivityAt } : {}),
    ...execution,
  };
}

function fingerprint(status: WorktreeRuntimeStatus): string {
  return JSON.stringify([
    status.isStreaming ?? false,
    status.hasUnread ?? false,
    status.awaitingApproval ?? false,
    status.lastActivityAt ?? null,
    status.pipelineStatus ?? null,
    status.terminalStatus ?? null,
    status.scriptStatus ?? null,
    status.hookStatus ?? null,
    status.isRunningRun ?? false,
  ]);
}

async function emitChangedWorktree(key: string): Promise<void> {
  // Building the entity does real IO; skip entirely while no portal session
  // is connected — the enqueue would be a no-op anyway.
  if (!started || !isCanopyPortalActive()) return;
  const status = combineStatus(key);
  const nextFingerprint = fingerprint(status);
  if (fingerprints.get(key) === nextFingerprint) return;

  const emissionVersion = (emissionVersions.get(key) ?? 0) + 1;
  emissionVersions.set(key, emissionVersion);
  const currentGeneration = generation;
  const { workspaceId, worktreeId } = splitStatusKey(key);
  let entity: PortalEntityEnvelope | null = null;
  try {
    // Dynamic import intentionally breaks the module cycle with
    // workspace-portal-service (it imports getWorktreeRuntimeStatuses from
    // this file for snapshot builds, while live deltas need its canonical
    // entity builder). A static import would resolve to undefined at runtime.
    const { getWorkspacePortalWorktreeEntity } =
      await import('./workspace-portal-service');
    entity = await getWorkspacePortalWorktreeEntity(
      workspaceId,
      worktreeId,
      status,
    );
  } catch {
    // Callers void this promise; a deleted workspace, a target without a
    // worktrees.json, or transient IO must not surface as an unhandled
    // rejection. Skip the delta — the next snapshot re-baselines.
    return;
  }
  if (
    !started ||
    generation !== currentGeneration ||
    emissionVersions.get(key) !== emissionVersion ||
    entity === null
  ) {
    return;
  }

  const currentStatus = combineStatus(key);
  const currentFingerprint = fingerprint(currentStatus);
  if (currentFingerprint !== nextFingerprint) {
    void emitChangedWorktree(key);
    return;
  }
  fingerprints.set(key, nextFingerprint);
  enqueuePortalEvent(
    createPortalEvent('portal.state.delta', {
      scope: 'worktree',
      target: {
        workspaceLocalId: workspaceId,
        worktreeLocalId: worktreeId,
      },
      entities: [entity],
      generatedAt: new Date().toISOString(),
    }),
  );
}

function refreshSessionsAndEmit(): void {
  sessionRefreshTimer = null;
  if (!started) return;
  const previous = sessionStatuses;
  sessionStatuses = buildSessionStatuses();
  const previousExecutions = executionStatuses;
  executionStatuses = buildExecutionStatuses();
  const keys = new Set<string>();
  previous.forEach((_status, key): void => {
    keys.add(key);
  });
  sessionStatuses.forEach((_status, key): void => {
    keys.add(key);
  });
  previousExecutions.forEach((_status, key): void => {
    keys.add(key);
  });
  executionStatuses.forEach((_status, key): void => {
    keys.add(key);
  });
  keys.forEach((key): void => {
    const before = previous.get(key);
    const after = sessionStatuses.get(key);
    if (
      before?.isStreaming !== after?.isStreaming ||
      before?.lastActivityAt !== after?.lastActivityAt ||
      fingerprint(previousExecutions.get(key) ?? {}) !==
        fingerprint(executionStatuses.get(key) ?? {})
    ) {
      void emitChangedWorktree(key);
    }
  });
}

function scheduleSessionRefresh(): void {
  if (!started || sessionRefreshTimer !== null) return;
  scheduleDesktopSessionSnapshotInvalidation();
  sessionRefreshTimer = setTimeout(
    refreshSessionsAndEmit,
    SESSION_REFRESH_DELAY_MS,
  );
}

export function startWorktreeRuntimeStatusService(): void {
  if (started) return;
  started = true;
  generation += 1;
  sessionStatuses = buildSessionStatuses();
  executionStatuses = buildExecutionStatuses();
  unsubscribeSessionActivity = subscribeChatSessionActivity(
    scheduleSessionRefresh,
  );
  unsubscribeDelegationActivity = subscribeDelegationActivity(
    scheduleSessionRefresh,
  );
  unsubscribePipelineCount = subscribeToActiveCountChange(
    scheduleSessionRefresh,
  );
  unsubscribePipelineUpdates = subscribePipelineRunUpdates(
    scheduleSessionRefresh,
  );
  // Only the running-detector flip and exit affect getRunningWorktreeTargets;
  // filtering keeps per-chunk terminalOutput events from scheduling refreshes.
  unsubscribeTerminalActivity = ptyManager.addEventListener((channel): void => {
    if (
      channel === IPC_CHANNELS.terminalRunningChanged ||
      channel === IPC_CHANNELS.terminalExit
    ) {
      scheduleSessionRefresh();
    }
  });
  unsubscribeScriptActivity = subscribeTrackedScriptsChanged(
    scheduleSessionRefresh,
  );
  unsubscribeHookActivity = subscribeActiveHookRunsChanged(
    scheduleSessionRefresh,
  );
}

export function stopWorktreeRuntimeStatusService(): void {
  started = false;
  generation += 1;
  unsubscribeSessionActivity?.();
  unsubscribeSessionActivity = null;
  unsubscribeDelegationActivity?.();
  unsubscribeDelegationActivity = null;
  unsubscribePipelineCount?.();
  unsubscribePipelineCount = null;
  unsubscribePipelineUpdates?.();
  unsubscribePipelineUpdates = null;
  unsubscribeTerminalActivity?.();
  unsubscribeTerminalActivity = null;
  unsubscribeScriptActivity?.();
  unsubscribeScriptActivity = null;
  unsubscribeHookActivity?.();
  unsubscribeHookActivity = null;
  if (sessionRefreshTimer !== null) {
    clearTimeout(sessionRefreshTimer);
    sessionRefreshTimer = null;
  }
  sessionStatuses.clear();
  executionStatuses.clear();
  mirroredBadges.clear();
  fingerprints.clear();
  emissionVersions.clear();
}

export function getWorktreeRuntimeStatuses(
  inputs: WorktreeRuntimeStatusInput[],
  target?: PortalTarget,
): Promise<Map<string, WorktreeRuntimeStatus>> {
  sessionStatuses = buildSessionStatuses();
  executionStatuses = buildExecutionStatuses();
  const selected = inputs.filter(
    ({ workspaceId, worktree }) =>
      (!target?.workspaceLocalId || target.workspaceLocalId === workspaceId) &&
      (!target?.worktreeLocalId || target.worktreeLocalId === worktree.id),
  );
  // Never reads chat storage: badges come from live chat writes, else from
  // the worktrees.json mirror every chat write updates; durable activity is
  // the worktree's own lastTouchedAt, which the snapshot projection merges.
  const statuses = new Map<string, WorktreeRuntimeStatus>();
  for (const { workspaceId, worktree } of selected) {
    const key = statusKey(workspaceId, worktree.id);
    mirroredBadges.set(key, {
      hasUnread: (worktree.chatBadges?.unreadChats.length ?? 0) > 0,
      awaitingApproval: (worktree.chatBadges?.approvalChats.length ?? 0) > 0,
    });
    const status = combineStatus(key);
    statuses.set(key, status);
    fingerprints.set(key, fingerprint(status));
  }
  return Promise.resolve(statuses);
}

export function handleChatTabsWritten(
  workspaceId: string,
  worktreeId: string,
  data: ChatTabsFile,
): void {
  const summary = deriveWorktreeChatBadgesSummary(data);
  const key = statusKey(workspaceId, worktreeId);
  persistedStatuses.set(key, {
    hasUnread: summary.unreadChats.length > 0,
    awaitingApproval: summary.approvalChats.length > 0,
    lastActivityAt: Date.now(),
  });
  void emitChangedWorktree(key);
}

export function resetWorktreeRuntimeStatusServiceForTests(): void {
  stopWorktreeRuntimeStatusService();
  persistedStatuses.clear();
}
