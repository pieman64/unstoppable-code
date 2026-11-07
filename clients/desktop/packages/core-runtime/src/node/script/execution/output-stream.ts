import {
  WORKER_SCRIPT_OUTPUT_ITEM_MAX_LINES,
  WORKER_SCRIPT_OUTPUT_LINE_MAX_LENGTH,
  type WorkerScriptExecutionOutputItem,
  type WorkerScriptExecutionOutputParams,
} from '@canopy/protocol/canopy-core';

import type {
  CanopyHandlerContext,
  CanopyStreamSink,
} from '../../../runtime/types';
import type { ScriptExecutionWorker } from './worker-scripts';

export const WORKER_SCRIPT_OUTPUT_AWAIT_START_MS = 60_000;
/** A subscriber this many items behind has its line items dropped. */
export const WORKER_SCRIPT_OUTPUT_BACKLOG = 64;
/** How often a subscription rechecks a run that is still starting. */
const STARTING_RECHECK_MS = 1_000;

export interface WorkerScriptStreamHandlers {
  'worker.script.execution.output': (
    params: WorkerScriptExecutionOutputParams,
    context: CanopyHandlerContext,
    sink: CanopyStreamSink<WorkerScriptExecutionOutputItem>,
  ) => Promise<() => void>;
}

/**
 * `worker.script.execution.output` over one worker's runs (CAN-5087): the
 * started signal and lines of a run as the worker writes them, never resumed.
 * Not in the worker registry; only hosts that serve remote runs compose it.
 */
export function createWorkerScriptStreamHandlers(
  worker: ScriptExecutionWorker,
  options: { readonly awaitStartMs?: number } = {},
): WorkerScriptStreamHandlers {
  const awaitStartMs =
    options.awaitStartMs ?? WORKER_SCRIPT_OUTPUT_AWAIT_START_MS;
  return {
    'worker.script.execution.output': (params, _context, sink) => {
      try {
        worker.assertServedScope(params.scope);
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      const { executionId, scope } = params;
      let ended = false;
      let started = false;
      let dropped = 0;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let unobserve: (() => void) | null = null;
      const cleanup = (): void => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        unobserve?.();
        unobserve = null;
      };
      const end = (): void => {
        if (ended) return;
        ended = true;
        cleanup();
        sink.end('completed');
      };
      const emit = (item: WorkerScriptExecutionOutputItem): boolean => {
        if (ended) return false;
        if (sink.emit(item) !== null) return true;
        // The consumer closed the subscription.
        ended = true;
        cleanup();
        return false;
      };
      const flushGap = (): boolean => {
        if (dropped === 0) return true;
        const droppedLines = dropped;
        dropped = 0;
        return emit({ kind: 'gap', droppedLines });
      };
      const emitStarted = (): void => {
        if (started) return;
        started = true;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        emit({ kind: 'started' });
      };
      const deliver = (lines: string[]): void => {
        for (
          let index = 0;
          index < lines.length && !ended;
          index += WORKER_SCRIPT_OUTPUT_ITEM_MAX_LINES
        ) {
          const chunk = lines.slice(
            index,
            index + WORKER_SCRIPT_OUTPUT_ITEM_MAX_LINES,
          );
          if ((sink.buffered?.() ?? 0) >= WORKER_SCRIPT_OUTPUT_BACKLOG) {
            dropped += chunk.length;
            continue;
          }
          if (!flushGap()) return;
          let truncated = false;
          const cut = chunk.map((line) => {
            if (line.length <= WORKER_SCRIPT_OUTPUT_LINE_MAX_LENGTH)
              return line;
            truncated = true;
            return line.slice(0, WORKER_SCRIPT_OUTPUT_LINE_MAX_LENGTH);
          });
          emit({ kind: 'lines', lines: cut, truncated });
        }
      };
      // Registered before the state is read, so no transition is missed.
      unobserve = worker.observe(executionId, {
        onProcessStarted: emitStarted,
        onLines: (lines) => {
          if (lines.length > 0) deliver(lines);
        },
        onFinished: () => {
          if (flushGap()) end();
        },
      });
      // A run that fails before its process starts reports nothing, so a
      // waiting subscription ends once no run with this id is executing.
      const recheck = (delayMs: number): void => {
        timer = setTimeout(() => {
          timer = null;
          if (started || ended) return;
          const current = worker.executionState(executionId, scope);
          if (current === 'absent') end();
          else if (current === 'starting')
            recheck(Math.min(awaitStartMs, STARTING_RECHECK_MS));
        }, delayMs);
        timer.unref();
      };
      const state = worker.executionState(executionId, scope);
      if (state === 'running') emitStarted();
      else if (state === 'absent' && params.awaitStart !== true) end();
      else if (state === 'absent') recheck(awaitStartMs);
      else recheck(Math.min(awaitStartMs, STARTING_RECHECK_MS));
      return Promise.resolve(cleanup);
    },
  };
}
