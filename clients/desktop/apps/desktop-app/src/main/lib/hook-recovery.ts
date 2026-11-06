import {
  hookTargetKey,
  recordedHookPause,
  type InitiatedWorkResumer,
  type InitiatedWorkResumption,
} from '@canopy/core-runtime/node/initiated-work';
import type { OperationRecovery } from '@canopy/core-runtime/node/operations';
import type {
  HookRunRequest,
  HookRunResponse,
  HookDescriptor,
} from '@canopy/desktop-shared/types';
import type { HookAction } from '@canopy/desktop-shared/hooks';
import {
  InitiatedWorkHookOriginContextSchema,
  type InitiatedWorkHookOriginContext,
  type InitiatedWorkRunRecord,
  type OperationRecord,
} from '@canopy/protocol/canopy-core';
import type { BrowserWindow } from 'electron';
import { resolveHookForRun } from '../services/hooks-service';
import {
  PR_ADVANCE_SOURCE,
  readCurrentPrTrackingSnapshot,
  settlePrTrackingState,
} from './github-pr-hook-state';
import {
  getHookFiring,
  getHookFiringIfAvailable,
  getHookInitiatedWork,
  getHookQueue,
} from './hook-initiated-work';
import { findHookRunForOperation } from './hook-log-store';
import { hookClientPresence } from './hook-client-presence';
import { resumedHookRunBody, type RunHookOptions } from './hook-runner';
import { logMainProcessWarn } from './main-process-logging';
import { readPreferencesFile } from './preferences-store';
import { prHookOccurrencePullRequest } from './pr-hook-occurrence';
import { readWorkspaceWorktreesDetailed } from './workspace-persistence';

/*
 * Restart recovery for hook runs (CAN-4145, ADR 14). A hook run the ledger
 * accepted but that never started is revalidated against today's worktree,
 * hook configuration, pull request snapshot, pause and owner, then run under
 * its recorded operation in its accepted order. A run that may have started
 * is reconciled with the run log it wrote under that operation and is never
 * started again.
 */

interface HookRunLocation {
  workspaceId: string;
  worktreeId: string;
  context: InitiatedWorkHookOriginContext;
}

function locate(operation: OperationRecord): HookRunLocation {
  const context = InitiatedWorkHookOriginContextSchema.parse(
    operation.origin.context,
  );
  const { workspaceId, worktreeId } = operation.scope;
  if (workspaceId === undefined || worktreeId === undefined)
    throw new Error('A hook run names no worktree.');
  return { workspaceId, worktreeId, context };
}

function runRequest(location: HookRunLocation): HookRunRequest {
  const { workspaceId, worktreeId, context } = location;
  if (context.target === 'project')
    return {
      target: 'project',
      projectId: workspaceId,
      worktreeId,
      triggerName: context.triggerName,
    };
  if (context.target === 'workspace-root')
    return {
      target: 'workspace-root',
      workspaceId,
      worktreeId,
      triggerName: context.triggerName,
    };
  return {
    target: 'workspace-repo',
    workspaceId,
    worktreeId,
    repoId: context.repoId ?? '',
    triggerName: context.triggerName,
  };
}

const invalidated = (message: string): InitiatedWorkResumption<never> => ({
  status: 'invalidated',
  message,
});

/** The renderer events a recovered run reports, as automatic runs do. */
export type HookRunEvents = (
  projectId: string,
  worktreeId: string,
) => Pick<RunHookOptions, 'onStarted' | 'onOutput' | 'onComplete'>;

const WORKTREE_READ_RETRY_INITIAL_MS = 1_000;
const WORKTREE_READ_RETRY_MAX_MS = 60_000;

/**
 * The project's worktree list from a read that can be trusted to show a
 * worktree is gone. A failed or partial read is retried with backoff while
 * the run keeps its place on its target; a cancellation stops the wait.
 */
export async function readWorktreesAuthoritatively(
  workspaceId: string,
  signal: AbortSignal,
): Promise<readonly { id: string }[]> {
  for (let delay = WORKTREE_READ_RETRY_INITIAL_MS; ; ) {
    const read = await readWorkspaceWorktreesDetailed(workspaceId).catch(
      () => null,
    );
    if (read && (read.authority === 'ok' || read.authority === 'absent'))
      return read.worktrees;
    signal.throwIfAborted();
    const wait = AbortSignal.any([signal, AbortSignal.timeout(delay)]);
    if (!wait.aborted)
      await new Promise<void>((resolve) => {
        wait.addEventListener('abort', () => resolve(), { once: true });
      });
    signal.throwIfAborted();
    delay = Math.min(delay * 2, WORKTREE_READ_RETRY_MAX_MS);
  }
}

export type QueuedHookRevalidation =
  | { status: 'valid'; hook: HookDescriptor; action: HookAction; cwd: string }
  | { status: 'invalidated'; message: string };

export async function revalidateQueuedHookWork(
  operation: OperationRecord,
  actionIndex: number,
  actionType: 'chat' | 'pipeline',
  signal: AbortSignal,
): Promise<QueuedHookRevalidation> {
  const location = locate(operation);
  const { workspaceId, worktreeId, context } = location;
  const worktrees = await readWorktreesAuthoritatively(workspaceId, signal);
  if (!worktrees.some((worktree) => worktree.id === worktreeId))
    return {
      status: 'invalidated',
      message: 'This worktree no longer exists.',
    };
  let resolved: Awaited<ReturnType<typeof resolveHookForRun>>;
  try {
    resolved = await resolveHookForRun(runRequest(location));
  } catch {
    return {
      status: 'invalidated',
      message: "This hook's repository is no longer in the project.",
    };
  }
  const { hook } = resolved;
  if (!hook || hook.hookKey !== operation.origin.sourceId)
    return {
      status: 'invalidated',
      message: 'This hook is no longer configured.',
    };
  const action = hook.actions[actionIndex];
  if (!action || action.type !== actionType)
    return {
      status: 'invalidated',
      message: "This hook's action changed, so the queued work was not run.",
    };
  if (context.pullRequest) {
    const trackedRepo = {
      projectId: workspaceId,
      worktreeId,
      repoStorageKey: resolved.repoStorageKey,
    };
    await settlePrTrackingState(trackedRepo, (subject) =>
      getHookInitiatedWork().sourceHead(PR_ADVANCE_SOURCE, subject),
    );
    const snapshotRef = await readCurrentPrTrackingSnapshot(trackedRepo);
    if (!snapshotRef.snapshot)
      return {
        status: 'invalidated',
        message: 'This pull request is no longer tracked.',
      };
    if (
      context.pullRequest.number !== snapshotRef.snapshot.pr.number ||
      context.pullRequest.repository.toLowerCase() !==
        snapshotRef.snapshot.repository.fullName.toLowerCase()
    )
      return {
        status: 'invalidated',
        message:
          'This worktree now tracks another pull request than the one this hook fired for.',
      };
  }
  for (const gate of await getHookFiring().recoveredGates(
    operation,
    hook.actions,
  )) {
    const verdict = gate.check();
    if (verdict.decision === 'skipped')
      return { status: 'invalidated', message: verdict.message };
    if (verdict.decision === 'refused')
      return { status: 'invalidated', message: verdict.failure.message };
  }
  return { status: 'valid', hook, action, cwd: resolved.cwd };
}

async function resume(
  operation: OperationRecord,
  getWindow: () => BrowserWindow | null,
  events: HookRunEvents,
  signal: AbortSignal,
): Promise<InitiatedWorkResumption<HookRunResponse>> {
  const location = locate(operation);
  const { workspaceId, worktreeId, context } = location;
  // Other triggers carry their payload in the run's environment only, such
  // as a pre-commit failure's error, which no restart keeps.
  if (!context.triggerName.startsWith('pr:'))
    return invalidated(
      "This hook's trigger details were not kept across the restart, so it was not run again.",
    );
  const worktrees = await readWorktreesAuthoritatively(workspaceId, signal);
  if (!worktrees.some((worktree) => worktree.id === worktreeId))
    return invalidated('This worktree no longer exists.');
  let resolved: Awaited<ReturnType<typeof resolveHookForRun>>;
  try {
    resolved = await resolveHookForRun(runRequest(location));
  } catch {
    return invalidated("This hook's repository is no longer in the project.");
  }
  const { hook } = resolved;
  if (!hook || hook.hookKey !== operation.origin.sourceId)
    return invalidated('This hook is no longer configured.');
  const engine = getHookInitiatedWork();
  const trackedRepo = {
    projectId: workspaceId,
    worktreeId,
    repoStorageKey: resolved.repoStorageKey,
  };
  await settlePrTrackingState(trackedRepo, (subject) =>
    engine.sourceHead(PR_ADVANCE_SOURCE, subject),
  );
  const snapshotRef = await readCurrentPrTrackingSnapshot(trackedRepo);
  if (!snapshotRef.snapshot)
    return invalidated('This pull request is no longer tracked.');
  const firedFor =
    context.pullRequest ??
    (operation.origin.occurrenceKey !== undefined
      ? prHookOccurrencePullRequest(operation.origin.occurrenceKey)
      : null);
  if (!firedFor)
    return invalidated(
      'The pull request this hook was run for is not known, so it was not run again.',
    );
  if (
    firedFor.number !== snapshotRef.snapshot.pr.number ||
    firedFor.repository.toLowerCase() !==
      snapshotRef.snapshot.repository.fullName.toLowerCase()
  )
    return invalidated(
      'This worktree now tracks another pull request than the one this hook fired for.',
    );

  // Pause (under the policy it was fired with), split lock, deletion fence
  // and owner, decided again by the core hook source.
  const gates = await getHookFiring().recoveredGates(operation, hook.actions);
  const prefs = await readPreferencesFile();
  const body = resumedHookRunBody({
    projectId: workspaceId,
    worktreeId,
    hook,
    cwd: resolved.cwd,
    invocation: context.invocation,
    pause: recordedHookPause(context),
    ...(operation.origin.occurrenceKey !== undefined
      ? { occurrenceKey: operation.origin.occurrenceKey }
      : {}),
    timeoutSeconds: prefs.scriptTimeoutMinutes * 60,
    currentSnapshot: snapshotRef.snapshot,
    currentSnapshotPath: snapshotRef.currentSnapshotPath,
    previousSnapshotPath: snapshotRef.previousSnapshotPath,
    getWindow,
    clientPresence: hookClientPresence(getWindow),
    ...events(workspaceId, worktreeId),
  });
  return {
    status: 'resume',
    request: { ...body, gates },
  };
}

/** What became of a run that may have started, from its run log. */
async function reconcile(
  operation: OperationRecord,
): Promise<OperationRecovery> {
  const { workspaceId, worktreeId } = locate(operation);
  const run = await findHookRunForOperation({
    projectId: workspaceId,
    worktreeId,
    operationId: operation.operationId,
  });
  if (!run || run.status === 'running') return { status: 'lost' };
  const runLog = { kind: 'runLog' as const, id: run.runId };
  if (run.status === 'cancelled' && run.stoppedBy === 'commandGate') {
    // Its command gate skipped it on purpose before the restart.
    const skipped: InitiatedWorkRunRecord = {
      disposition: 'skipped',
      gates: [],
      artifacts: [runLog],
      result: {
        status: 'stopped',
        exitCode: run.exitCode,
        durationMs: Math.max(0, Math.round(run.durationMs)),
      },
    };
    return { status: 'completed', outcome: skipped };
  }
  if (run.status === 'cancelled') return { status: 'cancelled' };
  const record: InitiatedWorkRunRecord = {
    disposition: 'ran',
    gates: [],
    artifacts: [runLog],
    result: {
      status: run.timedOut
        ? 'timedOut'
        : run.status === 'success'
          ? 'succeeded'
          : 'failed',
      exitCode: run.exitCode,
      durationMs: Math.max(0, Math.round(run.durationMs)),
    },
  };
  return { status: 'completed', outcome: record };
}

export function createHookResumer(
  getWindow: () => BrowserWindow | null,
  events: HookRunEvents = () => ({}),
): InitiatedWorkResumer<HookRunResponse> {
  return {
    targetKey: (operation) => {
      const { workspaceId, worktreeId, context } = locate(operation);
      return hookTargetKey(workspaceId, worktreeId, {
        target: context.target,
        ...(context.repoId !== undefined ? { repoId: context.repoId } : {}),
      });
    },
    resume: (operation, signal) => resume(operation, getWindow, events, signal),
    reconcile,
  };
}

let started = false;

/**
 * Resume hook runs a restart interrupted. Runs once, when hook firing
 * starts; the ledger opens only when an earlier run created it.
 */
export function startHookRecovery(host: {
  getWindow: () => BrowserWindow | null;
  events: HookRunEvents;
  ledgerExists: () => boolean;
}): void {
  if (started) return;
  const engine = getHookFiringIfAvailable()?.initiatedWork;
  if (!engine) return;
  started = true;
  engine.registerResumer(
    'hook',
    createHookResumer(host.getWindow, host.events),
  );
  void startHookQueueRecovery(host).catch((error: unknown) =>
    logMainProcessWarn('[hooks] could not recover queued hook work', error),
  );
  if (!host.ledgerExists()) return;
  void engine.whenRecovered().catch((error: unknown) => {
    logMainProcessWarn(
      '[hooks] could not recover interrupted hook runs',
      error,
    );
  });
}

async function startHookQueueRecovery(host: {
  getWindow: () => BrowserWindow | null;
  ledgerExists: () => boolean;
}): Promise<void> {
  const { registerHookChatQueueHost } = await import('./hook-chat');
  registerHookChatQueueHost(host.getWindow);
  const { registerHookPipelineQueueHost } = await import('./hook-pipeline');
  registerHookPipelineQueueHost(host.getWindow);
  if (!host.ledgerExists()) return;
  await getHookInitiatedWork().whenRecovered();
  await getHookQueue().sweep();
}
