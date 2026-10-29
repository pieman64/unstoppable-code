import { useEffect } from 'react';
import type {
  ExecutionEvent,
  PipelineAdvisorEvent,
  PipelineQueueEvent,
  StepOutputEvent,
} from '@canopy/desktop-shared/types/pipeline';
import type { WorktreeSelection } from '@canopy/desktop-shared/types';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore } from '@/stores/chatStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import {
  hasStepLogInterestForExecution,
  routeStepOutputEvents,
} from '@/stores/pipelineStepLogStore';

/**
 * The renderer's single pipeline IPC bridge.
 *
 * One instance per renderer JS context owns the execution, step-output,
 * queue, and advisor listeners, and drives the selected worktree's (or Cowork
 * Work Entry's) run list. Auxiliary panel windows are `window.open` children
 * that share the main renderer's context, so they share this bridge; the
 * separate App Advisor window renderer installs its own.
 *
 * Consumers (Activity sections, detail modals, chat cards, panels) only read
 * the stores and register interest; none of them listens to pipeline IPC.
 *
 * Ordering: buffered step output is flushed before each execution event is
 * applied, so a terminal state never renders ahead of its final output.
 */

export interface PipelineRunsBridgeOptions {
  /**
   * Project events into the global worktree status maps (sidebar, overview,
   * busy reporter, seen/unseen bookkeeping). Only the main window owns that
   * state and its side effects.
   */
  trackGlobalStatus: boolean;
}

interface InstalledBridge {
  refs: number;
  dispose: () => void;
}

let installedBridge: InstalledBridge | null = null;

/** Late fallback when a hidden window throttles animation frames. */
const STEP_OUTPUT_FLUSH_FALLBACK_MS = 250;

function shouldRefreshTrackedPlans(event: ExecutionEvent): boolean {
  const isTerminalEvent =
    event.type === 'execution.completed' ||
    event.type === 'execution.failed' ||
    event.type === 'execution.cancelled';
  if (!isTerminalEvent) {
    return false;
  }

  return (
    event.state.planId !== undefined ||
    event.state.plan_hash_after !== undefined
  );
}

function selectionKey(selection: WorktreeSelection | null): string | null {
  return selection ? `${selection.projectId}/${selection.worktreeId}` : null;
}

function createBridge(options: PipelineRunsBridgeOptions): () => void {
  let disposed = false;
  let pendingStepOutput: StepOutputEvent[] = [];
  let stepOutputFrame: number | null = null;
  let stepOutputTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelScheduledFlush = (): void => {
    if (stepOutputFrame !== null) {
      window.cancelAnimationFrame(stepOutputFrame);
      stepOutputFrame = null;
    }
    if (stepOutputTimer !== null) {
      clearTimeout(stepOutputTimer);
      stepOutputTimer = null;
    }
  };

  const flushStepOutput = (): void => {
    cancelScheduledFlush();
    if (pendingStepOutput.length === 0) return;
    const events = pendingStepOutput;
    pendingStepOutput = [];
    routeStepOutputEvents(events);
  };

  const queueStepOutput = (event: StepOutputEvent): void => {
    // Output nobody registered interest in is never buffered. An interest
    // registered later recovers it from its snapshot read.
    if (!hasStepLogInterestForExecution(event.executionId)) return;
    pendingStepOutput.push(event);
    if (stepOutputFrame === null) {
      stepOutputFrame = window.requestAnimationFrame(flushStepOutput);
    }
    if (stepOutputTimer === null) {
      stepOutputTimer = setTimeout(
        flushStepOutput,
        STEP_OUTPUT_FLUSH_FALLBACK_MS,
      );
    }
  };

  // ---- Selected-scope list loading (Code worktree or Cowork Work Entry) ----
  let loadedSelectionKey: string | null | undefined;
  let selectionGeneration = 0;
  const syncSelection = (selection: WorktreeSelection | null): void => {
    const key = selectionKey(selection);
    if (key === loadedSelectionKey) return;
    loadedSelectionKey = key;
    selectionGeneration += 1;
    const generation = selectionGeneration;
    if (!selection) {
      usePipelineRunsStore.getState().clear();
      return;
    }
    const { projectId, worktreeId } = selection;
    void (async (): Promise<void> => {
      try {
        const cwd = await window.api.getWorktreePath({
          projectId,
          worktreeId,
        });
        if (disposed || generation !== selectionGeneration) return;
        await usePipelineRunsStore
          .getState()
          .loadExecutions({ cwd, projectId, worktreeId });
      } catch {
        // The list stays as it was; the next selection change retries.
      }
    })();
  };
  syncSelection(useChatStore.getState().selectedWorktree);
  const unsubscribeSelection = useChatStore.subscribe((state, previous) => {
    if (state.selectedWorktree !== previous.selectedWorktree) {
      syncSelection(state.selectedWorktree);
    }
  });

  const unsubscribeExecution = window.pipelines.onExecutionEvent(
    (event: ExecutionEvent) => {
      // Preserve the observable output-before-state ordering when a terminal
      // event arrives before the next paint flushes the queued output.
      flushStepOutput();
      const store = usePipelineRunsStore.getState();
      if (options.trackGlobalStatus) {
        store.trackGlobalExecutionEvent(event);
      } else {
        store.handleExecutionEvent(event);
      }
      const selection = useChatStore.getState().selectedWorktree;
      if (
        selection &&
        shouldRefreshTrackedPlans(event) &&
        event.state.project_id === selection.projectId &&
        event.state.worktree_id === selection.worktreeId
      ) {
        void useActivityStore
          .getState()
          .loadTrackedPlans(selection.projectId, selection.worktreeId);
      }
    },
  );
  const unsubscribeStepOutput = window.pipelines.onStepOutput(
    (event: StepOutputEvent) => {
      queueStepOutput(event);
    },
  );
  const unsubscribeQueueEvent = window.pipelines.onQueueEvent(
    (event: PipelineQueueEvent) => {
      usePipelineRunsStore.getState().handleQueueEvent(event);
    },
  );
  const unsubscribeAdvisorEvent =
    typeof window.pipelines.onAdvisorEvent === 'function'
      ? window.pipelines.onAdvisorEvent((event: PipelineAdvisorEvent) => {
          usePipelineRunsStore.getState().handleAdvisorEvent(event);
        })
      : (): void => {};

  return (): void => {
    flushStepOutput();
    disposed = true;
    unsubscribeSelection();
    unsubscribeExecution();
    unsubscribeStepOutput();
    unsubscribeQueueEvent();
    unsubscribeAdvisorEvent();
  };
}

/**
 * Installs the renderer's pipeline bridge, or joins the installed one.
 * Returns an idempotent release; the last release uninstalls it.
 */
export function installPipelineRunsBridge(
  options: PipelineRunsBridgeOptions,
): () => void {
  if (!installedBridge) {
    installedBridge = { refs: 0, dispose: createBridge(options) };
  }
  const bridge = installedBridge;
  bridge.refs += 1;
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    bridge.refs -= 1;
    if (bridge.refs === 0 && installedBridge === bridge) {
      installedBridge = null;
      bridge.dispose();
    }
  };
}

/** Mount once per renderer, outside the panel grid. */
export function usePipelineRunsBridge(
  options: PipelineRunsBridgeOptions,
): void {
  const { trackGlobalStatus } = options;
  useEffect(
    () => installPipelineRunsBridge({ trackGlobalStatus }),
    [trackGlobalStatus],
  );
}
