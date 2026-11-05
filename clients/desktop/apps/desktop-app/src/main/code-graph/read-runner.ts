import { totalmem } from 'node:os';
import {
  flushCodeGraphQueryTelemetry,
  flushCodeGraphReadDiagnostics,
} from '../lib/code-graph-telemetry';
import { codeGraphReadRecorders } from './read-recorders';
import { getExecutionHostPort } from '../execution-host/utility-process-host';
import { codeGraphHostBudget } from '@canopy/code-graph/host/budgets';
import {
  createCodeGraphReadScheduler,
  type CodeGraphWorkerReadInput,
} from '@canopy/code-graph/host/read-scheduler';
import type { CodeGraphWorkerReadResponse } from '@canopy/code-graph/host/read-protocol';

// The read host protocol lives with the host in `@canopy/code-graph/host`,
// and the read scheduler beside it. This module composes the scheduler for
// Electron main: utility-process read hosts and the desktop telemetry.

export type {
  CodeGraphReadCall,
  CodeGraphWorkerReadTask,
  CodeGraphWorkerReadRequest,
  CodeGraphWorkerReadResult,
  CodeGraphBaseIdentityReadResult,
  CodeGraphWorkerReadResponse,
} from '@canopy/code-graph/host/read-protocol';
export {
  CODE_GRAPH_READ_WORKER_IDLE_TIMEOUT_MS,
  CodeGraphReadFailureError,
  CodeGraphWorkerReadError,
  codeGraphReadFailure,
} from '@canopy/code-graph/host/read-scheduler';
export type {
  CodeGraphWorkerReadErrorReason,
  CodeGraphWorkerReadInput,
} from '@canopy/code-graph/host/read-scheduler';

const WORKER_ENTRY_FILENAME = 'code-graph-read-worker.js';
const WORKER_SERVICE_NAME = 'code-graph-read';

const scheduler = createCodeGraphReadScheduler({
  launchReadHost: () =>
    getExecutionHostPort().launch({
      entry: WORKER_ENTRY_FILENAME,
      serviceName: WORKER_SERVICE_NAME,
      budget: codeGraphHostBudget('read', {
        totalMemoryBytes: totalmem(),
      }),
    }),
  ...codeGraphReadRecorders,
  flushTelemetry: () => {
    flushCodeGraphQueryTelemetry();
    flushCodeGraphReadDiagnostics();
  },
});

export function runCodeGraphWorkerRead(
  input: CodeGraphWorkerReadInput,
): Promise<CodeGraphWorkerReadResponse> {
  return scheduler.run(input);
}

/**
 * Refuses new reads for `key` until the returned release runs, so nothing can
 * start a reader for a worktree while its data is being removed. Fences nest;
 * each release is idempotent.
 */
export function fenceCodeGraphReads(key: string): () => void {
  return scheduler.fence(key);
}

/**
 * Refuses new reads for every key of a project (`${workspaceId}/…`: its
 * worktrees and base variants) until the returned release runs. Project
 * deletion holds it while it removes the project's directory.
 */
export function fenceCodeGraphReadsForWorkspace(
  workspaceId: string,
): () => void {
  return scheduler.fenceWorkspace(workspaceId);
}

/**
 * Cancels every queued and running read for `key` and kills every worker
 * serving it, then waits until each of those processes has exited. Worktree
 * cleanup relies on this before it closes and removes graph data.
 */
export function cancelCodeGraphReads(key: string): Promise<void> {
  return scheduler.cancel(key);
}

/**
 * `cancelCodeGraphReads` for every key of a project (its worktrees and base
 * variants). Project deletion awaits it before removing the project directory,
 * which holds every worktree's graph.
 */
export function cancelCodeGraphReadsForWorkspace(
  workspaceId: string,
): Promise<void> {
  return scheduler.cancelWorkspace(workspaceId);
}

export function shutdownCodeGraphReadWorkers(): Promise<void> {
  return scheduler.shutdown();
}

export function resetCodeGraphReadRunnerForTests(): void {
  scheduler.resetForTests();
}
