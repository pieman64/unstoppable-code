import {
  APP_ADVISOR_PROJECT_ID,
  type ChatActiveSessionInfo,
  type LocalMemoryScopeRequest,
} from '@canopy/desktop-shared/types';
import {
  getAllActiveSessionInfos,
  subscribeChatSessionActivity,
} from '../../agents/session-manager';
import { isE2eBuild } from '../../lib/e2e-gate';
import {
  BACKGROUND_HELPER_PRIORITIES,
  enqueueBackgroundHelperTask,
} from '../../lib/background-helper-queue';
import { readPreferencesFile } from '../../lib/preferences-store';
import { isConsolidationInputClean } from '@canopy/memory-consolidation/input';
import { broadcastLocalMemoryChanged } from './change-events';
import { localMemoryScopeDir } from './scope-resolver';
import {
  beginLocalMemoryConsolidationRun,
  endLocalMemoryConsolidationRun,
} from './consolidation-run-tracker';
import {
  consolidationRunOutcome,
  readConsolidationState,
  recordConsolidationRun,
} from './consolidation-state';
import type { RunConsolidationResult } from './consolidation-task';
import { resolveLocalMemoryRunModel } from './helper-model';
import { resolveMemoryWorkspaceId } from './workspace-scope';

export const LOCAL_MEMORY_CONSOLIDATION_DEBOUNCE_MS = 5 * 60_000;
export const LOCAL_MEMORY_CONSOLIDATION_HOURLY_CAP_MS = 60 * 60_000;

interface ConsolidationScope {
  scopeDir: string;
  workspaceId?: string;
}

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const cancellationEpochs = new Map<string, number>();
const inFlight = new Set<string>();
const pendingAfterFlight = new Map<string, ConsolidationScope>();
const lastRunAt = new Map<string, number>();
let previousSessions = new Map<string, ChatActiveSessionInfo>();
let unsubscribeSessionActivity: (() => void) | null = null;
let started = false;
let sessionActivityChain: Promise<void> = Promise.resolve();

function sessionKey(session: ChatActiveSessionInfo): string {
  return `${session.projectId}/${session.worktreeId}/${session.chatId}`;
}

function isRelevantSession(session: ChatActiveSessionInfo): boolean {
  return session.projectId !== APP_ADVISOR_PROJECT_ID;
}

function isSessionBusy(session: ChatActiveSessionInfo): boolean {
  return session.turnActive || session.pendingMessageCount > 0;
}

function currentRelevantSessions(): ChatActiveSessionInfo[] {
  return getAllActiveSessionInfos().filter(isRelevantSession);
}

function userScope(): ConsolidationScope {
  return { scopeDir: localMemoryScopeDir({ scope: 'user' }) };
}

function scopeRequest(scope: ConsolidationScope): LocalMemoryScopeRequest {
  return scope.workspaceId === undefined
    ? { scope: 'user' }
    : { scope: 'workspace', workspaceId: scope.workspaceId };
}

function workspaceScope(workspaceId: string): ConsolidationScope {
  return {
    scopeDir: localMemoryScopeDir({ scope: 'workspace', workspaceId }),
    workspaceId,
  };
}

/**
 * Resolve the REAL memory workspace a session writes to. Sentinel sessions
 * (plan-explore / code-review / legacy cowork) carry a sentinel project id
 * with the real target behind a registry lookup; comparing or keying scopes
 * by the raw `projectId` would schedule consolidation for never-written
 * sentinel directories and miss the resolved store. Null means the session
 * has no workspace memory scope at all.
 */
async function resolveSessionWorkspaceId(
  session: ChatActiveSessionInfo,
): Promise<string | null> {
  return resolveMemoryWorkspaceId({
    projectId: session.projectId,
    worktreeId: session.worktreeId,
  });
}

async function isScopeIdle(scope: ConsolidationScope): Promise<boolean> {
  const busySessions = currentRelevantSessions().filter(isSessionBusy);
  if (scope.workspaceId === undefined) {
    // User-scope memory can be written from any session.
    return busySessions.length === 0;
  }
  for (const session of busySessions) {
    if ((await resolveSessionWorkspaceId(session)) === scope.workspaceId) {
      return false;
    }
  }
  return true;
}

function cancelScope(scope: ConsolidationScope): void {
  const timer = debounceTimers.get(scope.scopeDir);
  if (timer) {
    clearTimeout(timer);
    debounceTimers.delete(scope.scopeDir);
  }
  cancellationEpochs.set(
    scope.scopeDir,
    (cancellationEpochs.get(scope.scopeDir) ?? 0) + 1,
  );
}

async function scheduleScope(
  scope: ConsolidationScope,
  delayMs = LOCAL_MEMORY_CONSOLIDATION_DEBOUNCE_MS,
): Promise<void> {
  if (!started || !(await isScopeIdle(scope))) {
    return;
  }
  // `started` may have flipped during the async idleness check; a timer set
  // now would survive stopLocalMemoryConsolidationScheduler's sweep.
  if (!started) {
    return;
  }
  const existingTimer = debounceTimers.get(scope.scopeDir);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  const timer = setTimeout(() => {
    debounceTimers.delete(scope.scopeDir);
    void attemptScopeConsolidation(scope);
  }, delayMs);
  timer.unref?.();
  debounceTimers.set(scope.scopeDir, timer);
}

export async function requestLocalMemoryConsolidation(options: {
  workspaceId?: string;
}): Promise<void> {
  if (!started) {
    return;
  }
  await scheduleScope(
    options.workspaceId === undefined
      ? userScope()
      : workspaceScope(options.workspaceId),
  );
}

function isWithinHourlyCap(lastConsolidatedAt: string | undefined): boolean {
  if (lastConsolidatedAt === undefined) {
    return false;
  }
  const timestamp = Date.parse(lastConsolidatedAt);
  return (
    Number.isFinite(timestamp) &&
    Date.now() - timestamp < LOCAL_MEMORY_CONSOLIDATION_HOURLY_CAP_MS
  );
}

function scopeEpochIsCurrent(
  scope: ConsolidationScope,
  epoch: number,
): boolean {
  return started && (cancellationEpochs.get(scope.scopeDir) ?? 0) === epoch;
}

async function schedulerMayWrite(
  scope: ConsolidationScope,
  epoch: number,
): Promise<boolean> {
  // Every await below yields to cancellations (stop, new turn activity), so
  // the started-state + epoch must be rechecked after EACH await, and
  // idleness re-confirmed immediately before the write is granted.
  if (!scopeEpochIsCurrent(scope, epoch)) {
    return false;
  }
  if (!(await isScopeIdle(scope))) {
    return false;
  }
  if (!scopeEpochIsCurrent(scope, epoch)) {
    return false;
  }
  const preferences = await readPreferencesFile().catch(() => null);
  if (preferences?.localMemoryEnabled !== true) {
    return false;
  }
  if (!scopeEpochIsCurrent(scope, epoch)) {
    return false;
  }
  if (!(await isScopeIdle(scope))) {
    return false;
  }
  return scopeEpochIsCurrent(scope, epoch);
}

async function attemptScopeConsolidation(
  scope: ConsolidationScope,
): Promise<void> {
  if (!started) {
    return;
  }
  if (inFlight.has(scope.scopeDir)) {
    pendingAfterFlight.set(scope.scopeDir, scope);
    return;
  }

  // Capture the cancellation epoch and reserve the in-flight slot BEFORE the
  // first await: a cancellation that lands during any preflight await bumps
  // the epoch past this snapshot, and concurrent attempts queue behind this
  // one instead of interleaving preflight reads.
  const epoch = cancellationEpochs.get(scope.scopeDir) ?? 0;
  inFlight.add(scope.scopeDir);
  try {
    if (!(await isScopeIdle(scope))) {
      return;
    }
    // Only the enabled flag is used here: the queued task reads preferences
    // again before resolving its model, since the user can change the memory
    // model while the task waits.
    const enabled =
      (await readPreferencesFile().catch(() => null))?.localMemoryEnabled ===
      true;
    if (!enabled) {
      cancelScope(scope);
      return;
    }

    const inMemoryLastRunAt = lastRunAt.get(scope.scopeDir) ?? 0;
    if (
      Number.isFinite(inMemoryLastRunAt) &&
      Date.now() - inMemoryLastRunAt < LOCAL_MEMORY_CONSOLIDATION_HOURLY_CAP_MS
    ) {
      await scheduleScope(
        scope,
        LOCAL_MEMORY_CONSOLIDATION_HOURLY_CAP_MS -
          (Date.now() - inMemoryLastRunAt),
      );
      return;
    }
    const state = await readConsolidationState(scope.scopeDir);
    const mostRecentRun = Math.max(
      inMemoryLastRunAt,
      state?.lastConsolidatedAt === undefined
        ? 0
        : Date.parse(state.lastConsolidatedAt),
    );
    if (
      Number.isFinite(mostRecentRun) &&
      Date.now() - mostRecentRun < LOCAL_MEMORY_CONSOLIDATION_HOURLY_CAP_MS
    ) {
      await scheduleScope(
        scope,
        LOCAL_MEMORY_CONSOLIDATION_HOURLY_CAP_MS - (Date.now() - mostRecentRun),
      );
      return;
    }

    // Keep the structured-helper/provider stack off Electron's startup import
    // path. This local module is only needed after a dirty scope survives the
    // five-minute debounce; local dynamic imports are safe in packaged main.
    const { collectConsolidationInput, runLocalMemoryConsolidation } =
      await import('./consolidation-task');
    const preflight = await collectConsolidationInput(scope.scopeDir);
    if (isConsolidationInputClean(preflight)) {
      return;
    }
    if (state?.lastInputHash === preflight.inputHash) {
      return;
    }

    // Preflight awaited preferences/state/import/fs work; revalidate the
    // epoch and idleness before enqueueing so a cancellation during preflight
    // stops this stale attempt.
    if (!(await schedulerMayWrite(scope, epoch))) {
      return;
    }

    await enqueueBackgroundHelperTask({
      priority: BACKGROUND_HELPER_PRIORITIES.memoryConsolidation,
      task: async (): Promise<void> => {
        // Revalidate once more when the queued slot actually runs; the queue
        // may have delayed this task past another cancellation.
        if (!(await schedulerMayWrite(scope, epoch))) {
          return;
        }
        const latestState = await readConsolidationState(scope.scopeDir);
        const queuedInput = await collectConsolidationInput(scope.scopeDir);
        if (isConsolidationInputClean(queuedInput)) {
          return;
        }
        if (latestState && isWithinHourlyCap(latestState.lastConsolidatedAt)) {
          await scheduleScope(
            scope,
            LOCAL_MEMORY_CONSOLIDATION_HOURLY_CAP_MS -
              (Date.now() - Date.parse(latestState.lastConsolidatedAt ?? '')),
          );
          return;
        }
        if (latestState?.lastInputHash === queuedInput.inputHash) return;
        // The queue may have held this task while the user chose another
        // memory model or turned memory off: resolve from what is saved now.
        const currentPreferences = await readPreferencesFile().catch(
          () => null,
        );
        if (
          currentPreferences?.localMemoryEnabled !== true ||
          !scopeEpochIsCurrent(scope, epoch)
        ) {
          return;
        }
        // A manual run, rebuild or restore already executing for this scope
        // owns the write and its status; the scheduler re-arms through the
        // next idle transition. The scope is held before the model is
        // resolved, so a refusal below never overwrites that run's status.
        // The hourly stamp is only written once a run actually starts, so a
        // skipped attempt never throttles the next one.
        if (!beginLocalMemoryConsolidationRun(scope.scopeDir)) {
          return;
        }
        let run: Awaited<ReturnType<typeof resolveLocalMemoryRunModel>>;
        try {
          run = await resolveLocalMemoryRunModel(
            currentPreferences,
            scope.workspaceId,
          );
        } catch (error) {
          endLocalMemoryConsolidationRun(scope.scopeDir);
          throw error;
        }
        if ('refusal' in run) {
          try {
            // A resolution error is a scheduler failure, handled and
            // recorded below like every other one.
            if (run.refusal.result === 'failed') {
              throw new Error(run.refusal.reason);
            }
            // Fail closed: the chosen memory model cannot run right now, or
            // the organization blocks it, and memory is never sent to
            // another model in its place. The status line says why; the next
            // idle transition tries again.
            await recordConsolidationRun(scope.scopeDir, run.refusal);
          } finally {
            endLocalMemoryConsolidationRun(scope.scopeDir);
          }
          broadcastLocalMemoryChanged(scopeRequest(scope));
          return;
        }
        const { helperModel } = run;
        lastRunAt.set(scope.scopeDir, Date.now());
        broadcastLocalMemoryChanged(scopeRequest(scope));
        let result: RunConsolidationResult;
        try {
          result = await runLocalMemoryConsolidation({
            scopeDir: scope.scopeDir,
            ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
            ...helperModel,
            shouldContinue: () => schedulerMayWrite(scope, epoch),
          });
          await recordConsolidationRun(
            scope.scopeDir,
            consolidationRunOutcome(result),
          );
        } finally {
          endLocalMemoryConsolidationRun(scope.scopeDir);
          broadcastLocalMemoryChanged(scopeRequest(scope));
        }
        if (result.status === 'partial') {
          await scheduleScope(scope, LOCAL_MEMORY_CONSOLIDATION_HOURLY_CAP_MS);
          return;
        }
        if (result.status !== 'success' || !result.inputHash) {
          return;
        }
        if ((queuedInput.omittedImportFiles?.fileCount ?? 0) > 0) {
          await scheduleScope(scope, LOCAL_MEMORY_CONSOLIDATION_HOURLY_CAP_MS);
        }
      },
    });
  } catch (error) {
    lastRunAt.set(scope.scopeDir, Date.now());
    const reason = error instanceof Error ? error.message : String(error);
    process.emitWarning(reason, {
      code: 'LOCAL_MEMORY_CONSOLIDATION_SCHEDULER_FAILED',
    });
    await recordConsolidationRun(scope.scopeDir, {
      result: 'failed',
      reason,
    }).catch(() => undefined);
    broadcastLocalMemoryChanged(scopeRequest(scope));
  } finally {
    inFlight.delete(scope.scopeDir);
    const pending = pendingAfterFlight.get(scope.scopeDir);
    pendingAfterFlight.delete(scope.scopeDir);
    if (pending && started && (await isScopeIdle(pending))) {
      void attemptScopeConsolidation(pending);
    }
  }
}

function handleSessionActivity(): void {
  if (!started) {
    return;
  }
  // Serialize the async activity handling so overlapping activity events
  // cannot interleave their `previousSessions` reads/writes or reorder
  // cancel/schedule pairs around the awaited workspace-id resolutions.
  sessionActivityChain = sessionActivityChain
    .then(() => processSessionActivity())
    .catch(() => undefined);
}

async function processSessionActivity(): Promise<void> {
  if (!started) {
    return;
  }
  const sessions = currentRelevantSessions();
  const current = new Map(
    sessions.map((session) => [sessionKey(session), session]),
  );
  const becameIdleWorkspaceIds = new Set<string>();
  let anySessionBecameIdle = false;

  for (const session of sessions) {
    if (isSessionBusy(session)) {
      const workspaceId = await resolveSessionWorkspaceId(session);
      if (workspaceId !== null) {
        cancelScope(workspaceScope(workspaceId));
      }
      cancelScope(userScope());
      continue;
    }
    const previous = previousSessions.get(sessionKey(session));
    if (previous && isSessionBusy(previous)) {
      anySessionBecameIdle = true;
      const workspaceId = await resolveSessionWorkspaceId(session);
      if (workspaceId !== null) {
        becameIdleWorkspaceIds.add(workspaceId);
      }
    }
  }

  for (const [key, previous] of Array.from(previousSessions.entries())) {
    if (!current.has(key) && isSessionBusy(previous)) {
      anySessionBecameIdle = true;
      const workspaceId = await resolveSessionWorkspaceId(previous);
      if (workspaceId !== null) {
        becameIdleWorkspaceIds.add(workspaceId);
      }
    }
  }

  previousSessions = current;
  for (const workspaceId of Array.from(becameIdleWorkspaceIds)) {
    await scheduleScope(workspaceScope(workspaceId));
  }
  if (anySessionBecameIdle) {
    // User-scope memory can be written by any session — including sentinel
    // sessions with no workspace resolution — so any idle transition re-arms
    // the user scope.
    await scheduleScope(userScope());
  }

  await readPreferencesFile()
    .then((preferences) => {
      if (!preferences.localMemoryEnabled) {
        for (const scopeDir of Array.from(debounceTimers.keys())) {
          cancelScope({ scopeDir });
        }
      }
    })
    .catch(() => undefined);
}

export function startLocalMemoryConsolidationScheduler(): void {
  if (isE2eBuild() || started) {
    return;
  }
  started = true;
  previousSessions = new Map(
    currentRelevantSessions().map((session) => [sessionKey(session), session]),
  );
  unsubscribeSessionActivity = subscribeChatSessionActivity(
    handleSessionActivity,
  );
}

export function stopLocalMemoryConsolidationScheduler(): void {
  if (!started && unsubscribeSessionActivity === null) {
    return;
  }
  started = false;
  unsubscribeSessionActivity?.();
  unsubscribeSessionActivity = null;
  for (const timer of Array.from(debounceTimers.values())) {
    clearTimeout(timer);
  }
  const scopeDirs = new Set([
    ...Array.from(debounceTimers.keys()),
    ...Array.from(inFlight.values()),
  ]);
  for (const scopeDir of Array.from(scopeDirs)) {
    cancellationEpochs.set(
      scopeDir,
      (cancellationEpochs.get(scopeDir) ?? 0) + 1,
    );
  }
  debounceTimers.clear();
  pendingAfterFlight.clear();
  previousSessions.clear();
}

export const localMemoryConsolidationSchedulerTestExports = {
  handleSessionActivity,
  attemptScopeConsolidation,
  reset(): void {
    stopLocalMemoryConsolidationScheduler();
    debounceTimers.clear();
    cancellationEpochs.clear();
    inFlight.clear();
    pendingAfterFlight.clear();
    lastRunAt.clear();
    previousSessions.clear();
    unsubscribeSessionActivity = null;
    sessionActivityChain = Promise.resolve();
    started = false;
  },
};
