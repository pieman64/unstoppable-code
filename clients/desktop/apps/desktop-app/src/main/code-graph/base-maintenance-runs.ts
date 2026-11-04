import type {
  InitiatedWorkEngine,
  InitiatedWorkGateCheck,
  InitiatedWorkRunControl,
  LiveInitiatedWorkRun,
} from '@canopy/core-runtime/node/initiated-work';
import { codeGraphBuildRefusalOf } from '@canopy/core-runtime/node/code-graph';
import {
  INITIATED_WORK_CODE_GRAPH_BASE_MAINTENANCE_SOURCE,
  WORKER_CODE_GRAPH_GRANTS,
  type CanopyCallerDescriptor,
  type InitiatedWorkCodeGraphBaseMaintenanceOriginContext,
  type InitiatedWorkRunResult,
  type WorkerCodeGraphBuildResult,
} from '@canopy/protocol/canopy-core';
import {
  getActiveDesktopRuntimeIfAccepting,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';

/*
 * The code-graph base manager's maintenance as core initiated work
 * (CAN-5619). Each maintenance cycle maintains one workspace at a time: the
 * workspace's maintenance is one `core.initiatedWork.run` with a `system`
 * origin, and the run dispatches `worker.codeGraph.build` for the
 * workspace's bases in maintenance mode. The worker rebuilds a base only when
 * its shadow moved, one repository at a time, in the `maintenance` class, so
 * queue policy is unchanged. The cycle's cadence stays with the base manager.
 */

const BASE_MAINTENANCE_CALLER: CanopyCallerDescriptor = {
  principalId: 'desktop-code-graph-base-maintenance',
  clientInstanceId: 'desktop-main',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: [WORKER_CODE_GRAPH_GRANTS.write],
};

export type BaseMaintenanceRuntime = Pick<
  DesktopCanopyDispatcher,
  'instruction' | 'initiatedWork'
>;

let runtimeForTests: BaseMaintenanceRuntime | null = null;

/** Test seam: run base maintenance over a runtime built from real parts. */
export function setBaseMaintenanceRuntimeForTests(
  runtime: BaseMaintenanceRuntime | null,
): void {
  runtimeForTests = runtime;
}

function activeRuntime(): BaseMaintenanceRuntime | null {
  return runtimeForTests ?? getActiveDesktopRuntimeIfAccepting();
}

export interface BaseMaintenanceRun {
  workspaceId: string;
  repositoryCount: number;
  /** The code graph is still on for the workspace. */
  available(): boolean;
  /** The base manager is shutting down. */
  stopped(): boolean;
}

/**
 * How a workspace's maintenance ended. `not-started`: no runtime accepts
 * work (the app is quitting), so nothing was recorded.
 */
export type BaseMaintenanceOutcome =
  | InitiatedWorkRunResult['status']
  | 'skipped'
  | 'cancelled'
  | 'refused'
  | 'not-started';

function targetKey(workspaceId: string): string {
  return `code-graph-base\0${workspaceId}`;
}

function isBaseMaintenanceRun(run: LiveInitiatedWorkRun): boolean {
  return (
    run.origin.kind === 'system' &&
    run.origin.sourceId === INITIATED_WORK_CODE_GRAPH_BASE_MAINTENANCE_SOURCE
  );
}

function gates(run: BaseMaintenanceRun): InitiatedWorkGateCheck[] {
  return [
    {
      gate: 'pause',
      check: () =>
        run.available()
          ? { decision: 'passed' }
          : {
              decision: 'skipped',
              message: 'Code graph generation is off for this project.',
            },
    },
    {
      gate: 'deletionFence',
      check: () =>
        run.stopped()
          ? {
              decision: 'skipped',
              message: 'Code graph base maintenance is shutting down.',
            }
          : { decision: 'passed' },
    },
  ];
}

/**
 * The run's status from the workspace's base outcomes: succeeded when every
 * base is current, timed out or stopped when that is what kept a base from
 * being current, failed otherwise.
 */
function statusOf(
  result: WorkerCodeGraphBuildResult,
): InitiatedWorkRunResult['status'] {
  if (result.kind !== 'workspace_base') return 'failed';
  const outcomes = result.repositories.map(({ outcome }) => outcome);
  if (outcomes.every((outcome) => outcome === 'built')) return 'succeeded';
  if (outcomes.includes('failed')) return 'failed';
  if (outcomes.includes('timed_out')) return 'timedOut';
  return 'stopped';
}

async function execute(
  runtime: BaseMaintenanceRuntime,
  run: BaseMaintenanceRun,
  control: InitiatedWorkRunControl,
): Promise<InitiatedWorkRunResult['status']> {
  if (control.signal.aborted) throw new Error('The run was cancelled.');
  try {
    const result = await runtime.instruction(
      'worker.codeGraph.build',
      {
        graphScope: {
          kind: 'workspace_base',
          workspaceId: run.workspaceId,
          background: { trigger: 'maintenance' },
        },
      },
      {
        caller: BASE_MAINTENANCE_CALLER,
        // One maintenance per run: a retry of the run's dispatch joins it.
        metadata: { idempotencyKey: control.operationId },
      },
    );
    return statusOf(result);
  } catch (error) {
    if (control.signal.aborted) throw error;
    const refusal = codeGraphBuildRefusalOf(error);
    if (refusal?.code === 'worker.codeGraph.buildTimedOut') return 'timedOut';
    if (
      refusal?.code === 'worker.codeGraph.unavailable' ||
      refusal?.code === 'worker.codeGraph.buildCanceled'
    )
      return 'stopped';
    return 'failed';
  }
}

/**
 * Maintains one workspace's bases as initiated work and resolves once the
 * run ends. Never rejects: a failed maintenance waits for the next cycle.
 */
export async function runCodeGraphBaseMaintenance(
  run: BaseMaintenanceRun,
): Promise<BaseMaintenanceOutcome> {
  const runtime = activeRuntime();
  if (runtime === null) return 'not-started';
  const engine: InitiatedWorkEngine = runtime.initiatedWork;
  const context: InitiatedWorkCodeGraphBaseMaintenanceOriginContext = {
    trigger: 'maintenance',
    repositoryCount: run.repositoryCount,
  };
  try {
    const submission = await engine.submit({
      origin: {
        kind: 'system',
        sourceId: INITIATED_WORK_CODE_GRAPH_BASE_MAINTENANCE_SOURCE,
        context,
      },
      // Local graph maintenance: the desktop authority is accountable.
      owner: { kind: 'system', id: LOCAL_DESKTOP_AUTHORITY_ID },
      scope: { workspaceId: run.workspaceId },
      targetKey: targetKey(run.workspaceId),
      gates: gates(run),
      execute: async (control) => {
        const startedAt = Date.now();
        const status = await execute(runtime, run, control);
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
    return 'failed';
  }
}

/** Cancels every live base-maintenance run, recording why on each. */
export function cancelCodeGraphBaseMaintenance(reason: string): void {
  const runtime = activeRuntime();
  if (runtime === null) return;
  void runtime.initiatedWork
    .cancelWhere(isBaseMaintenanceRun, {
      requestedBy: BASE_MAINTENANCE_CALLER.principalId,
      reason,
    })
    .catch(() => undefined);
}
