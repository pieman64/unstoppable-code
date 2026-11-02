import type { ScriptRunResponse } from '@canopy/desktop-shared/types';
import { logMainProcessWarn } from './main-process-logging';
import type { ScriptRunLogRef } from './script-log-store';

/**
 * Structured outcomes of a worktree's post-create setup lifecycle.
 *
 * The project and workspace setup runners return these so callers that must
 * wait for setup (pipeline host steps, Split PR) can read each script's real
 * identity, exit code and canonical log reference. Fire-and-forget callers
 * keep using the `start*PostCreateSetup` wrappers and ignore them.
 */
export type WorktreeSetupLifecycle = 'before-setup' | 'setup' | 'after-setup';

export interface WorktreeSetupScriptRef {
  scriptKey: string;
  /** Run ID of the canonical script log, or a generated ID when the log could not start. */
  runId: string;
  target: 'project' | 'workspace-root' | 'workspace-repo';
  lifecycle: WorktreeSetupLifecycle;
  repoId?: string;
  /** Canonical log reference; `null` when the run log could not be started. */
  logRef: ScriptRunLogRef | null;
}

export interface WorktreeSetupScriptResult extends WorktreeSetupScriptRef {
  status: 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
  /** Real process exit code; `null` when the process was killed or never reported one. */
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Optional progress callbacks for a setup run. Callbacks are invoked through
 * `notifyWorktreeSetupObserver`: a callback that throws or rejects is logged
 * and ignored, and an asynchronous callback is never awaited, so an observer
 * can neither fail nor delay setup.
 *
 * - `onResolved` fires at most once, as soon as the runner knows whether any
 *   setup script will run. It does not fire when script resolution itself
 *   fails before that is known; the runner's promise still settles.
 * - `onScriptStarted` fires after the canonical run log starts and before the
 *   process launches.
 * - `onScriptCompleted` fires after the canonical run log is completed, so a
 *   snapshot taken from it sees the final log and metadata.
 */
export interface WorktreeSetupObserver {
  onResolved?(configured: boolean): void;
  onScriptStarted?(script: WorktreeSetupScriptRef): void | Promise<void>;
  onScriptCompleted?(script: WorktreeSetupScriptResult): void | Promise<void>;
}

export interface WorktreeSetupRunResult {
  /** `skipped` with no scripts, `failed` when any script did not succeed, otherwise `completed`. */
  status: 'completed' | 'failed' | 'skipped';
  /** Started scripts in lifecycle order: before-setup, repositories in configured order, after-setup. */
  scripts: WorktreeSetupScriptResult[];
  detail?: string;
}

export type WorktreeSetupObserverEvent =
  | 'resolved'
  | 'script-started'
  | 'script-completed';

/**
 * Invoke one observer callback without letting it affect setup. Synchronous
 * throws and asynchronous rejections are logged (event name and error type
 * only, never user text) and swallowed; a returned promise is not awaited.
 */
export function notifyWorktreeSetupObserver(
  event: WorktreeSetupObserverEvent,
  invoke: () => void | Promise<void>,
): void {
  const logFailure = (error: unknown): void => {
    logMainProcessWarn('[worktree-setup] Setup observer callback failed', {
      event,
      errorType: error instanceof Error ? error.name : typeof error,
    });
  };
  try {
    const pending = invoke();
    if (pending instanceof Promise) {
      pending.catch(logFailure);
    }
  } catch (error) {
    logFailure(error);
  }
}

/** Classify a script response the same way the canonical run log does. */
export function getWorktreeSetupScriptStatus(
  response: Pick<ScriptRunResponse, 'success' | 'exitCode' | 'timedOut'>,
): WorktreeSetupScriptResult['status'] {
  if (response.success) {
    return 'succeeded';
  }
  if (response.timedOut) {
    return 'timed_out';
  }
  return response.exitCode === null ? 'cancelled' : 'failed';
}

export function buildWorktreeSetupScriptResult(
  ref: WorktreeSetupScriptRef,
  response: Pick<ScriptRunResponse, 'success' | 'exitCode' | 'timedOut'>,
): WorktreeSetupScriptResult {
  return {
    ...ref,
    status: getWorktreeSetupScriptStatus(response),
    exitCode: response.exitCode,
    timedOut: response.timedOut,
  };
}

export function getWorktreeSetupRunStatus(
  scripts: readonly WorktreeSetupScriptResult[],
): WorktreeSetupRunResult['status'] {
  if (scripts.length === 0) {
    return 'skipped';
  }
  return scripts.every((script) => script.status === 'succeeded')
    ? 'completed'
    : 'failed';
}
