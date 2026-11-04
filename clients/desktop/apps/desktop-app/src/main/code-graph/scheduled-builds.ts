import type {
  InitiatedWorkEngine,
  InitiatedWorkGateCheck,
  InitiatedWorkRunControl,
  LiveInitiatedWorkRun,
} from '@canopy/core-runtime/node/initiated-work';
import { codeGraphBuildRefusalOf } from '@canopy/core-runtime/node/code-graph';
import {
  INITIATED_WORK_CODE_GRAPH_SCHEDULER_SOURCE,
  WORKER_CODE_GRAPH_GRANTS,
  type CanopyCallerDescriptor,
  type InitiatedWorkCodeGraphBuildOriginContext,
  type InitiatedWorkRunResult,
  type WorkerCodeGraphBackgroundBuild,
} from '@canopy/protocol/canopy-core';
import {
  getActiveDesktopRuntimeIfAccepting,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';

/*
 * The code-graph scheduler's automatic builds as core initiated work
 * (CAN-5617). Once the scheduler has decided a worktree needs a build (its
 * fingerprint changed, or it has no completed graph), the build is one
 * `core.initiatedWork.run` with a `system` origin, and the run dispatches
 * `worker.codeGraph.build` as a background request carrying the scheduler's
 * trigger and observed fingerprint. The worker queues it in the background
 * class it always had, so queue policy is unchanged. Debounce, coalescing and
 * the fingerprint check stay with the scheduler: an unchanged fingerprint
 * starts no build and records no run.
 */

const SCHEDULED_BUILDS_CALLER: CanopyCallerDescriptor = {
  principalId: 'desktop-code-graph-scheduler',
  clientInstanceId: 'desktop-main',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: [WORKER_CODE_GRAPH_GRANTS.write],
};

export type ScheduledCodeGraphBuildRuntime = Pick<
  DesktopCanopyDispatcher,
  'instruction' | 'initiatedWork'
>;

let runtimeForTests: ScheduledCodeGraphBuildRuntime | null = null;

/** Test seam: run scheduled builds over a runtime built from real parts. */
export function setScheduledCodeGraphBuildRuntimeForTests(
  runtime: ScheduledCodeGraphBuildRuntime | null,
): void {
  runtimeForTests = runtime;
}

function activeRuntime(): ScheduledCodeGraphBuildRuntime | null {
  return runtimeForTests ?? getActiveDesktopRuntimeIfAccepting();
}

export interface ScheduledCodeGraphBuild {
  projectId: string;
  worktreeId: string;
  trigger: WorkerCodeGraphBackgroundBuild['trigger'];
  /** The bounded signal that asked for the build, for its origin. */
  refreshSource: string;
  observedFingerprint: string;
  observedFingerprintMs: number;
  /** The code graph is still on for the project. */
  available(): boolean;
  /** Cleanup canceled the worktree's builds after the fingerprint was read. */
  canceled(): boolean;
  /** Called once the run passed its gates and is recorded. */
  onStarted?(): void;
}

/**
 * How a scheduled build ended. `not-started`: no runtime accepts work (the
 * app is starting or quitting), so nothing was recorded.
 */
export type ScheduledCodeGraphBuildOutcome =
  | InitiatedWorkRunResult['status']
  | 'skipped'
  | 'cancelled'
  | 'refused'
  | 'not-started';

function targetKey(projectId: string, worktreeId: string): string {
  return `code-graph\0${projectId}\0${worktreeId}`;
}

function isScheduledBuildRun(run: LiveInitiatedWorkRun, key: string): boolean {
  return (
    run.targetKey === key &&
    run.origin.kind === 'system' &&
    run.origin.sourceId === INITIATED_WORK_CODE_GRAPH_SCHEDULER_SOURCE
  );
}

function gates(build: ScheduledCodeGraphBuild): InitiatedWorkGateCheck[] {
  return [
    {
      gate: 'pause',
      check: () =>
        build.available()
          ? { decision: 'passed' }
          : {
              decision: 'skipped',
              message: 'Code graph generation is off for this project.',
            },
    },
    {
      gate: 'deletionFence',
      check: () =>
        build.canceled()
          ? {
              decision: 'skipped',
              message: "This worktree's graph builds were canceled.",
            }
          : { decision: 'passed' },
    },
  ];
}

async function execute(
  runtime: ScheduledCodeGraphBuildRuntime,
  build: ScheduledCodeGraphBuild,
  control: InitiatedWorkRunControl,
): Promise<InitiatedWorkRunResult['status']> {
  // A run cancelled before it dispatched never starts its build. Once it
  // has, the build belongs to the worker's queue, which may share it with
  // other callers for the worktree: the run waits for it and ends cancelled,
  // and worker.codeGraph.build.cancel stops the build itself.
  if (control.signal.aborted) throw new Error('The run was cancelled.');
  try {
    await runtime.instruction(
      'worker.codeGraph.build',
      {
        graphScope: {
          kind: 'worktree',
          workspaceId: build.projectId,
          worktreeId: build.worktreeId,
          mode: 'incremental',
          background: {
            trigger: build.trigger,
            observedFingerprint: {
              value: build.observedFingerprint,
              observedMs: Math.max(0, Math.round(build.observedFingerprintMs)),
            },
          },
        },
      },
      {
        caller: SCHEDULED_BUILDS_CALLER,
        // One build per run: a retry of the run's dispatch joins it.
        metadata: { idempotencyKey: control.operationId },
      },
    );
    return 'succeeded';
  } catch (error) {
    // A cancelled run reports its cancellation, not the build's refusal.
    if (control.signal.aborted) throw error;
    const refusal = codeGraphBuildRefusalOf(error);
    if (refusal?.code === 'worker.codeGraph.buildTimedOut') return 'timedOut';
    // Turned off or stopped by someone else while it ran.
    if (
      refusal?.code === 'worker.codeGraph.unavailable' ||
      refusal?.code === 'worker.codeGraph.buildCanceled'
    )
      return 'stopped';
    return 'failed';
  }
}

/**
 * Runs one scheduled build as initiated work and resolves once it ends.
 * Never rejects: the scheduler's builds are fire-and-forget.
 */
export async function startScheduledCodeGraphBuild(
  build: ScheduledCodeGraphBuild,
): Promise<ScheduledCodeGraphBuildOutcome> {
  const runtime = activeRuntime();
  if (runtime === null) return 'not-started';
  const engine: InitiatedWorkEngine = runtime.initiatedWork;
  const context: InitiatedWorkCodeGraphBuildOriginContext = {
    trigger: build.trigger,
    refreshSource: build.refreshSource,
  };
  try {
    const submission = await engine.submit({
      origin: {
        kind: 'system',
        sourceId: INITIATED_WORK_CODE_GRAPH_SCHEDULER_SOURCE,
        context,
      },
      // Local graph maintenance: the desktop authority is accountable.
      owner: { kind: 'system', id: LOCAL_DESKTOP_AUTHORITY_ID },
      scope: { workspaceId: build.projectId, worktreeId: build.worktreeId },
      targetKey: targetKey(build.projectId, build.worktreeId),
      gates: gates(build),
      onQueued: () => {
        build.onStarted?.();
      },
      execute: async (control) => {
        const startedAt = Date.now();
        const status = await execute(runtime, build, control);
        return {
          value: status,
          result: {
            status,
            exitCode: null,
            durationMs: Math.max(0, Date.now() - startedAt),
          },
        };
      },
    });
    switch (submission.disposition) {
      case 'ran':
        return submission.cancelled ? 'cancelled' : submission.value;
      case 'skipped':
      case 'refused':
      case 'cancelled':
        return submission.disposition;
      case 'duplicate':
      case 'held':
        return 'not-started';
    }
  } catch {
    // The run could not be recorded, or its executor failed after cancel;
    // the engine recorded what it could.
    return 'failed';
  }
}

/**
 * Cancels the worktree's live scheduled-build runs, recording why on each.
 * Their worker builds are stopped by the scheduler's own cancel.
 */
export function cancelScheduledCodeGraphBuilds(
  projectId: string,
  worktreeId: string,
  reason: string,
): void {
  const runtime = activeRuntime();
  if (runtime === null) return;
  const key = targetKey(projectId, worktreeId);
  void runtime.initiatedWork
    .cancelWhere((run) => isScheduledBuildRun(run, key), {
      requestedBy: SCHEDULED_BUILDS_CALLER.principalId,
      reason,
    })
    .catch(() => undefined);
}
