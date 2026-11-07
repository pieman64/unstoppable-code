import type {
  CanopyHostExecution,
  WorkerScriptExecuteParams,
  WorkerScriptExecuteResult,
  WorkerScriptExecution,
  WorkerScriptExecutionCancelParams,
  WorkerScriptExecutionCancelResult,
  WorkerScriptExecutionOutputItem,
  WorkerScriptExecutionOutputParams,
  WorkerScriptScope,
} from '@canopy/protocol/canopy-core';

import { CanopyOperationError } from '../../../runtime/errors';
import { MAX_SCRIPT_OUTPUT_BYTES } from './process-runner';

export interface RemoteScriptTransport {
  /** Opens `worker.script.execution.output`; rejects when it cannot be opened. */
  openOutput(
    params: WorkerScriptExecutionOutputParams,
    onFrame: (frame: RemoteScriptOutputFrame) => void,
  ): Promise<{ close(): void }>;
  execute(
    params: WorkerScriptExecuteParams,
    options: {
      readonly idempotencyKey: string;
      readonly execution: CanopyHostExecution;
    },
  ): Promise<WorkerScriptExecuteResult>;
  cancel(
    params: WorkerScriptExecutionCancelParams,
    options: { readonly idempotencyKey: string },
  ): Promise<WorkerScriptExecutionCancelResult>;
  /** The script key's latest run in the worktree's run log, read on the caller's side. */
  readRun(
    scope: WorkerScriptScope,
    scriptKey: string,
  ): Promise<WorkerScriptExecution | null>;
  /** The call never reached a live daemon, or its connection dropped. */
  isUnreachable(error: unknown): boolean;
}

export type RemoteScriptOutputFrame =
  | { readonly kind: 'item'; readonly item: WorkerScriptExecutionOutputItem }
  | {
      readonly kind: 'end';
      /** The stream ended `completed` because the run finished; otherwise its connection dropped. */
      readonly completed?: boolean;
    };

export interface RemoteScriptRelay {
  started(): void;
  lines(lines: string[]): void;
}

export interface RemoteScriptRunRequest {
  /** Recorded, with a workspace and worktree, and without `secrets`. */
  readonly params: WorkerScriptExecuteParams;
  readonly execution: CanopyHostExecution;
  readonly signal: AbortSignal;
  readonly relay: RemoteScriptRelay;
  readonly createIdempotencyKey: () => string;
  /** Default 1000. */
  readonly pollIntervalMs?: number;
  /** How long the run may be missing from the run log, before or after it appears. Default 30000. */
  readonly appearanceTimeoutMs?: number;
  /** How long a settled run waits for its output stream to end. Default 2000. */
  readonly drainTimeoutMs?: number;
}

/** `not-started`: nothing that can start a process was sent; the caller may run it elsewhere. */
export type RemoteScriptRunOutcome =
  | { readonly kind: 'not-started'; readonly reason: 'unreachable' | 'refused' }
  | {
      readonly kind: 'finished';
      readonly result: WorkerScriptExecuteResult;
      readonly output: string;
    };

/** `failed_precondition`, `worker.script.placementUnreachable`, never retried, no details. */
export function scriptPlacementUnreachableError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    code: 'worker.script.placementUnreachable',
    message:
      "The background service stopped answering before this script's outcome was known. It may still be running there; check its output.",
    retry: { kind: 'never' },
  });
}

function settledStatus(
  status: WorkerScriptExecution['status'],
): WorkerScriptExecuteResult['status'] {
  if (status === 'success') return 'success';
  if (status === 'cancelled') return 'cancelled';
  return 'failed';
}

/**
 * Drive one script run on a remote worker (CAN-5087): open its output
 * stream, send it once, and cancel it on abort. After a dropped connection
 * the run is never sent again; the run log, which both hosts write, settles
 * it.
 */
export async function runScriptRemotely(
  transport: RemoteScriptTransport,
  request: RemoteScriptRunRequest,
): Promise<RemoteScriptRunOutcome> {
  const { params, execution, signal, relay, createIdempotencyKey } = request;
  const pollIntervalMs = request.pollIntervalMs ?? 1_000;
  const appearanceTimeoutMs = request.appearanceTimeoutMs ?? 30_000;
  const drainTimeoutMs = request.drainTimeoutMs ?? 2_000;
  const { record, executionId } = params;
  const { workspaceId, worktreeId, authorityId, targetId } = params.scope;
  if (
    record === undefined ||
    workspaceId === undefined ||
    worktreeId === undefined ||
    params.secrets !== undefined
  )
    throw new Error(
      'A remote script run needs a recorded, scoped run without secret bindings.',
    );
  const scope: WorkerScriptScope = {
    workspaceId,
    worktreeId,
    ...(authorityId !== undefined ? { authorityId } : {}),
    ...(targetId !== undefined ? { targetId } : {}),
  };
  const scriptKey = record.script.scriptKey;
  // A passed deadline leaves a call's outcome unknown, as a dropped
  // connection does.
  const outcomeUnknown = (error: unknown): boolean =>
    transport.isUnreachable(error) ||
    (error instanceof CanopyOperationError &&
      error.payload.kind === 'deadline_exceeded');

  let output = '';
  let outputBytes = 0;
  let outputFull = false;
  // A line the stream cut or lines it dropped leave the collected output incomplete.
  let outputIncomplete = false;
  let anyLine = false;
  let started = false;
  let seen = false;
  let detached = false;
  let onDetached: (() => void) | null = null;
  const collect = (lines: string[]): void => {
    for (const line of lines) {
      if (outputFull) return;
      const piece = anyLine ? `\n${line}` : line;
      const bytes = Buffer.byteLength(piece, 'utf8');
      if (outputBytes + bytes > MAX_SCRIPT_OUTPUT_BYTES) {
        outputFull = true;
        return;
      }
      output += piece;
      outputBytes += bytes;
      anyLine = true;
    }
  };
  const onFrame = (frame: RemoteScriptOutputFrame): void => {
    if (frame.kind === 'end') {
      detached = true;
      // Output the run wrote after a dropped stream never reaches it.
      if (frame.completed !== true) outputIncomplete = true;
      onDetached?.();
      return;
    }
    const { item } = frame;
    if (item.kind === 'started') {
      seen = true;
      if (started) return;
      started = true;
      relay.started();
    } else if (item.kind === 'lines') {
      if (item.truncated) outputIncomplete = true;
      collect(item.lines);
      relay.lines(item.lines);
    } else {
      // A gap counts lines the stream dropped; the run log keeps them.
      outputIncomplete = true;
    }
  };

  let stream: { close(): void };
  try {
    stream = await transport.openOutput(
      { scope, executionId, awaitStart: true },
      onFrame,
    );
  } catch (error) {
    return {
      kind: 'not-started',
      reason: transport.isUnreachable(error) ? 'unreachable' : 'refused',
    };
  }

  const timers = new Set<ReturnType<typeof setTimeout>>();
  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, ms);
      timers.add(timer);
    });
  // Frames queued behind the run's outcome arrive after it: wait for the
  // stream's end before returning, or count its last lines as lost.
  const drain = async (): Promise<void> => {
    if (detached) return;
    await new Promise<void>((resolve) => {
      onDetached = resolve;
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, drainTimeoutMs);
      timers.add(timer);
    });
    onDetached = null;
    if (!detached) outputIncomplete = true;
  };

  if (signal.aborted) {
    stream.close();
    return {
      kind: 'finished',
      result: {
        executionId,
        status: 'cancelled',
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        outputBytes: 0,
        outputTruncated: false,
        recorded: false,
      },
      output: '',
    };
  }

  // A cancel that never reached the daemon stays pending, so the log-following
  // loop below sends it again until the daemon takes it or the run settles.
  let cancelKey: string | null = null;
  let cancelDone = false;
  let cancelling: Promise<void> | null = null;
  const sendCancel = (): Promise<void> => {
    if (cancelDone) return Promise.resolve();
    cancelKey ??= createIdempotencyKey();
    const idempotencyKey = cancelKey;
    cancelling ??= transport
      .cancel({ scope, scriptKey, executionId }, { idempotencyKey })
      .then(
        ({ stopped }): void => {
          // Nothing stopped: the daemon may not have admitted the run yet.
          // Its answer is kept under this key, so the next cancel needs a
          // new one.
          if (stopped.length > 0) cancelDone = true;
          else cancelKey = null;
        },
        (error: unknown): void => {
          if (!outcomeUnknown(error)) cancelDone = true;
        },
      )
      .finally(() => {
        cancelling = null;
      });
    return cancelling;
  };
  let settled = false;
  const onAbort = (): void => {
    void (async (): Promise<void> => {
      await sendCancel();
      while (!cancelDone && !settled) {
        await wait(pollIntervalMs);
        if (!settled) await sendCancel();
      }
    })();
  };
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    try {
      const result = await transport.execute(params, {
        idempotencyKey: createIdempotencyKey(),
        execution,
      });
      await drain();
      return {
        kind: 'finished',
        result: {
          ...result,
          // Lines the stream cut or dropped leave the relayed output incomplete.
          outputTruncated:
            result.outputTruncated || outputFull || outputIncomplete,
        },
        output,
      };
    } catch (error) {
      // Any other rejection is the reached daemon's answer.
      if (!outcomeUnknown(error)) throw error;
    }

    // The run may be running there: follow its log, never send it again.
    // Time since the run was last in the log, or since it was sent.
    let missingMs = 0;
    for (;;) {
      await wait(pollIntervalMs);
      missingMs += pollIntervalMs;
      if (signal.aborted) await sendCancel();
      const run = await transport
        .readRun(scope, scriptKey)
        .catch((): null => null);
      if (run?.executionId === executionId) {
        missingMs = 0;
        seen = true;
        if (run.status !== 'running') {
          await drain();
          return {
            kind: 'finished',
            result: {
              executionId,
              status: settledStatus(run.status),
              exitCode: run.exitCode,
              timedOut: run.timedOut,
              durationMs: run.durationMs,
              outputBytes: Buffer.byteLength(output, 'utf8'),
              outputTruncated: outputFull || outputIncomplete,
              recorded: true,
            },
            output,
          };
        }
        if (detached) {
          // The stream never resumes: lines written since it ended are lost.
          outputIncomplete = true;
          // An end the new stream sends while it opens must stand.
          detached = false;
          const reopened = await transport
            .openOutput({ scope, executionId, awaitStart: false }, onFrame)
            .catch((): null => null);
          if (reopened === null) {
            detached = true;
          } else {
            stream.close();
            stream = reopened;
          }
        }
        continue;
      }
      // A later run replaced it, or it never appeared or left the log.
      if (run !== null && seen) throw scriptPlacementUnreachableError();
      if (missingMs >= appearanceTimeoutMs)
        throw scriptPlacementUnreachableError();
    }
  } finally {
    settled = true;
    signal.removeEventListener('abort', onAbort);
    timers.forEach((timer) => clearTimeout(timer));
    stream.close();
  }
}
