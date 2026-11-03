import type { WorkerScriptDescriptor } from '@canopy/protocol/canopy-core';

import type { ScriptRunInvocation, ScriptRunLogRef } from './script-run-log';

/** How a script process ended. `exitCode` is null for a stop or abort. */
export interface ScriptProcessResult {
  success: boolean;
  exitCode: number | null;
  /** Combined stdout and stderr, at most 256 KiB, then the failure text. */
  output: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ScriptRunTracking {
  projectId: string;
  worktreeId: string;
  scriptKey: string;
  runId?: string;
  /** Registry namespace. Omitted entries are ordinary scripts. */
  kind?: 'script' | 'hook';
  script?: WorkerScriptDescriptor;
  invocation?: ScriptRunInvocation;
  logRef?: ScriptRunLogRef;
}

/** A running script process, or a host-run one (an interactive PTY). */
export interface ActiveScriptRun {
  stop: () => void;
  /** End the whole process group, then settle. */
  drain: () => Promise<void>;
  waitForExit: Promise<ScriptProcessResult>;
  tracking?: ScriptRunTracking;
}

export interface StoppedScriptRun {
  response: ScriptProcessResult;
  tracking?: ScriptRunTracking;
}

function isTrackedScriptMatch(
  tracking: ScriptRunTracking | undefined,
  target: ScriptRunTracking,
): boolean {
  if (!tracking) return false;
  return (
    tracking.projectId === target.projectId &&
    tracking.worktreeId === target.worktreeId &&
    tracking.scriptKey === target.scriptKey &&
    (tracking.kind ?? 'script') === (target.kind ?? 'script')
  );
}

/**
 * The worker's running script processes (CAN-4143). Hooks register under the
 * `hook` kind and are hidden from the script views; every run of a worktree,
 * hooks included, is drained when the worktree is removed.
 */
export class ScriptRunRegistry {
  private readonly runs = new Set<ActiveScriptRun>();
  private readonly listeners = new Set<() => void>();

  add(run: ActiveScriptRun): void {
    this.runs.add(run);
    this.notify();
  }

  delete(run: ActiveScriptRun): void {
    if (this.runs.delete(run)) this.notify();
  }

  has(run: ActiveScriptRun): boolean {
    return this.runs.has(run);
  }

  private notify(): void {
    this.listeners.forEach((listener): void => {
      // A throwing subscriber must not disturb script execution or other
      // listeners; this registry is observational only.
      try {
        listener();
      } catch {
        // Ignore listener failures.
      }
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  /** Every running script's tracking, hooks excluded. */
  list(): ScriptRunTracking[] {
    return Array.from(this.runs)
      .map((run) => run.tracking)
      .filter(
        (tracking): tracking is ScriptRunTracking =>
          tracking !== undefined && tracking.kind !== 'hook',
      );
  }

  /**
   * The tracking of each running script key in a worktree, hooks excluded;
   * a key with several runs is listed once.
   */
  listForWorktree(target: {
    projectId: string;
    worktreeId: string;
  }): ScriptRunTracking[] {
    const seen = new Set<string>();
    const result: ScriptRunTracking[] = [];
    for (const run of Array.from(this.runs)) {
      const tracking = run.tracking;
      if (
        !tracking ||
        tracking.kind === 'hook' ||
        tracking.projectId !== target.projectId ||
        tracking.worktreeId !== target.worktreeId
      ) {
        continue;
      }
      if (seen.has(tracking.scriptKey)) {
        continue;
      }
      seen.add(tracking.scriptKey);
      result.push(tracking);
    }
    return result;
  }

  isRunning(target: ScriptRunTracking): boolean {
    return Array.from(this.runs).some((run) =>
      isTrackedScriptMatch(run.tracking, target),
    );
  }

  stopAll(): void {
    this.runs.forEach((run) => {
      run.stop();
    });
  }

  /** Stop every run of a script key; resolves with the first to settle. */
  async stop(target: ScriptRunTracking): Promise<StoppedScriptRun | null> {
    const stopped = await this.stopEach(target);
    return stopped[0] ?? null;
  }

  /** Stop every run of a script key and wait for each to settle. */
  async stopEach(target: ScriptRunTracking): Promise<StoppedScriptRun[]> {
    const active = Array.from(this.runs).filter((run) =>
      isTrackedScriptMatch(run.tracking, target),
    );
    active.forEach((run) => {
      run.stop();
    });
    const results = await Promise.allSettled(
      active.map(async (run) => ({
        response: await run.waitForExit,
        tracking: run.tracking,
      })),
    );
    return results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
  }

  /** Stop one concrete run without affecting other runs of its script. */
  async stopRun(
    target: ScriptRunTracking & { runId: string },
  ): Promise<StoppedScriptRun | null> {
    const run = Array.from(this.runs).find(
      (candidate): boolean =>
        isTrackedScriptMatch(candidate.tracking, target) &&
        (candidate.tracking?.logRef?.runId ?? candidate.tracking?.runId) ===
          target.runId,
    );
    if (run === undefined) return null;
    run.stop();
    try {
      return { response: await run.waitForExit, tracking: run.tracking };
    } catch {
      return null;
    }
  }

  /**
   * Drain the worktree's runs that match, each judged as its own concrete
   * run: a run is not hidden behind another with the same script key, as it
   * is in listForWorktree. Draining rather than stopping ends the whole
   * process group: a shell that exits on the stop signal would drop its
   * tracking while a child that ignores the signal kept running, out of
   * reach of drainWorktree.
   */
  async drainMatching(
    target: { projectId: string; worktreeId: string },
    shouldDrain: (tracking: ScriptRunTracking) => boolean,
  ): Promise<StoppedScriptRun[]> {
    const runs = Array.from(this.runs).filter(
      ({ tracking }) =>
        tracking !== undefined &&
        tracking.kind !== 'hook' &&
        tracking.projectId === target.projectId &&
        tracking.worktreeId === target.worktreeId &&
        shouldDrain(tracking),
    );
    const results = await Promise.allSettled(
      runs.map(async (run) => {
        await run.drain();
        return { response: await run.waitForExit, tracking: run.tracking };
      }),
    );
    return results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
  }

  /** Includes hooks, automatic setup, and duplicate keys absent from views. */
  async drainWorktree(projectId: string, worktreeId: string): Promise<void> {
    const runs = Array.from(this.runs).filter(
      ({ tracking }) =>
        tracking?.projectId === projectId && tracking.worktreeId === worktreeId,
    );
    const results = await Promise.allSettled(runs.map((run) => run.drain()));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
}
