import { create } from 'zustand';
import type {
  HookCompleteEvent,
  HookDescriptor,
  HookOutputEvent,
  HookRunResponse,
  HookRunSnapshot,
  HookStartedEvent,
} from '@canopy/desktop-shared/types';
import {
  applyBatchToRunsMap,
  createIdleOutputBuffer,
  type IdleOutputBuffer,
} from './idleOutputBuffer';

const MAX_OUTPUT_LINES = 1000;
const loadedWorktreeKeys = new Set<string>();

interface PendingOutput {
  projectId: string;
  worktreeId: string;
  hookKey: string;
  lines: string[];
  hook: HookDescriptor;
  activeActionIndex?: number;
}

let outputBuffer: IdleOutputBuffer<PendingOutput> | null = null;

export interface HookRunState {
  label: string;
  triggerName: string;
  actions: HookDescriptor['actions'];
  target: HookDescriptor['target'];
  repoId?: string;
  repoName?: string;
  status: 'running' | 'success' | 'failed' | 'stopped';
  outputLines: string[];
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  startedAt: number;
  activeActionIndex?: number;
}

interface HooksState {
  /** Keyed by `${projectId}/${worktreeId}` -> hookKey -> HookRunState */
  runs: Record<string, Record<string, HookRunState>>;
  startRun: (
    projectId: string,
    worktreeId: string,
    hook: HookDescriptor,
  ) => void;
  startRunFromEvent: (event: HookStartedEvent) => void;
  appendOutput: (event: HookOutputEvent) => void;
  completeRun: (
    projectId: string,
    worktreeId: string,
    hookKey: string,
    response: HookRunResponse,
  ) => void;
  completeRunFromEvent: (event: HookCompleteEvent) => void;
  loadWorktreeRuns: (projectId: string, worktreeId: string) => Promise<void>;
  unloadWorktreeRuns: (projectId: string, worktreeId: string) => void;
  cleanupWorktree: (projectId: string, worktreeId: string) => void;
}

function worktreeKey(projectId: string, worktreeId: string): string {
  return `${projectId}/${worktreeId}`;
}

function createRunState(hook: HookDescriptor): HookRunState {
  return {
    label: hook.label,
    triggerName: hook.triggerName,
    actions: hook.actions,
    target: hook.target,
    repoId: hook.repoId,
    repoName: hook.repoName,
    status: 'running',
    outputLines: [],
    exitCode: null,
    timedOut: false,
    durationMs: 0,
    startedAt: Date.now(),
  };
}

function runStateFromSnapshot(snapshot: HookRunSnapshot): HookRunState {
  return {
    ...createRunState(snapshot.hook),
    status:
      snapshot.status === 'running'
        ? 'running'
        : snapshot.status === 'success'
          ? 'success'
          : snapshot.status === 'cancelled'
            ? 'stopped'
            : 'failed',
    outputLines:
      snapshot.outputLines.length > MAX_OUTPUT_LINES
        ? snapshot.outputLines.slice(-MAX_OUTPUT_LINES)
        : snapshot.outputLines,
    exitCode: snapshot.exitCode,
    timedOut: snapshot.timedOut,
    durationMs: snapshot.durationMs,
    startedAt: Date.parse(snapshot.startedAt) || Date.now(),
    activeActionIndex: snapshot.activeActionIndex,
  };
}

function resolveHookRunStatus(
  response: HookRunResponse,
): HookRunState['status'] {
  if (response.stopped) {
    return 'stopped';
  }

  return response.success ? 'success' : 'failed';
}

function isHookRunActive(status: HookRunState['status']): boolean {
  return status === 'running';
}

function retainActiveRunsWithoutOutput(
  worktreeRuns: Record<string, HookRunState>,
): Record<string, HookRunState> | null {
  const retained: Record<string, HookRunState> = {};
  for (const [hookKey, run] of Object.entries(worktreeRuns)) {
    if (isHookRunActive(run.status)) {
      retained[hookKey] = { ...run, outputLines: [] };
    }
  }
  return Object.keys(retained).length > 0 ? retained : null;
}

function applyBatchToRuns(
  runs: Record<string, Record<string, HookRunState>>,
  batch: PendingOutput[],
): Record<string, Record<string, HookRunState>> {
  return applyBatchToRunsMap(runs, batch, {
    getKey: (item) => ({
      worktreeKey: worktreeKey(item.projectId, item.worktreeId),
      runKey: item.hookKey,
      lines: item.lines,
    }),
    createRun: (item, outputLines) => ({
      ...createRunState(item.hook),
      outputLines,
      activeActionIndex: item.activeActionIndex,
    }),
    updateRun: (run, outputLines) => ({
      ...run,
      outputLines,
    }),
    maxOutputLines: MAX_OUTPUT_LINES,
  });
}

export const useHooksStore = create<HooksState>((set) => {
  const buffer = createIdleOutputBuffer<PendingOutput>({
    getWorktreeKey: (item) => worktreeKey(item.projectId, item.worktreeId),
    flushBatch: (batch) => {
      set((state) => ({ runs: applyBatchToRuns(state.runs, batch) }));
    },
  });
  outputBuffer = buffer;

  return {
    runs: {},

    startRun: (
      projectId: string,
      worktreeId: string,
      hook: HookDescriptor,
    ): void => {
      const wk = worktreeKey(projectId, worktreeId);
      loadedWorktreeKeys.add(wk);
      set((state) => ({
        runs: {
          ...state.runs,
          [wk]: {
            ...state.runs[wk],
            [hook.hookKey]: createRunState(hook),
          },
        },
      }));
    },

    startRunFromEvent: (event: HookStartedEvent): void => {
      if (
        !loadedWorktreeKeys.has(worktreeKey(event.projectId, event.worktreeId))
      ) {
        return;
      }
      useHooksStore
        .getState()
        .startRun(event.projectId, event.worktreeId, event.hook);
    },

    appendOutput: (event: HookOutputEvent): void => {
      const wk = worktreeKey(event.projectId, event.worktreeId);
      if (!loadedWorktreeKeys.has(wk)) {
        return;
      }
      set((state) => {
        const worktreeRuns = state.runs[wk];
        const existing = worktreeRuns?.[event.hook.hookKey];
        if (
          existing === undefined ||
          existing.activeActionIndex === event.activeActionIndex
        ) {
          return state;
        }
        return {
          runs: {
            ...state.runs,
            [wk]: {
              ...worktreeRuns,
              [event.hook.hookKey]: {
                ...existing,
                activeActionIndex: event.activeActionIndex,
              },
            },
          },
        };
      });
      buffer.push({
        projectId: event.projectId,
        worktreeId: event.worktreeId,
        hookKey: event.hook.hookKey,
        lines: event.lines,
        hook: event.hook,
        activeActionIndex: event.activeActionIndex,
      });
    },

    completeRun: (
      projectId: string,
      worktreeId: string,
      hookKey: string,
      response: HookRunResponse,
    ): void => {
      const wk = worktreeKey(projectId, worktreeId);
      set((state) => {
        const worktreeRuns = state.runs[wk];
        if (!worktreeRuns) return state;
        const existing = worktreeRuns[hookKey];
        if (!existing) return state;

        return {
          runs: {
            ...state.runs,
            [wk]: {
              ...worktreeRuns,
              [hookKey]: {
                ...existing,
                status: resolveHookRunStatus(response),
                exitCode: response.exitCode,
                timedOut: response.timedOut,
                durationMs: response.durationMs,
              },
            },
          },
        };
      });
    },

    completeRunFromEvent: (event: HookCompleteEvent): void => {
      const wk = worktreeKey(event.projectId, event.worktreeId);
      set((state) => {
        const worktreeRuns = state.runs[wk] ?? {};
        if (!loadedWorktreeKeys.has(wk) && state.runs[wk] === undefined) {
          return state;
        }
        const existing =
          worktreeRuns[event.hook.hookKey] ?? createRunState(event.hook);

        return {
          runs: {
            ...state.runs,
            [wk]: {
              ...worktreeRuns,
              [event.hook.hookKey]: {
                ...existing,
                status: resolveHookRunStatus(event.result),
                exitCode: event.result.exitCode,
                timedOut: event.result.timedOut,
                durationMs: event.result.durationMs,
              },
            },
          },
        };
      });
    },

    loadWorktreeRuns: async (
      projectId: string,
      worktreeId: string,
    ): Promise<void> => {
      const wk = worktreeKey(projectId, worktreeId);
      loadedWorktreeKeys.add(wk);
      if (typeof window.api.loadWorktreeHookRuns !== 'function') {
        return;
      }
      const snapshots = await window.api.loadWorktreeHookRuns({
        projectId,
        worktreeId,
        maxLines: MAX_OUTPUT_LINES,
      });
      set((state) => {
        if (!loadedWorktreeKeys.has(wk)) {
          return state;
        }
        const loadedRuns: Record<string, HookRunState> = {};
        for (const snapshot of snapshots) {
          loadedRuns[snapshot.hook.hookKey] = runStateFromSnapshot(snapshot);
        }
        const existing = state.runs[wk] ?? {};
        return {
          runs: {
            ...state.runs,
            [wk]: {
              ...loadedRuns,
              ...existing,
            },
          },
        };
      });
    },

    unloadWorktreeRuns: (projectId: string, worktreeId: string): void => {
      const wk = worktreeKey(projectId, worktreeId);
      loadedWorktreeKeys.delete(wk);
      buffer.removeWorktree(wk);
      set((state) => {
        const worktreeRuns = state.runs[wk];
        if (!worktreeRuns) return state;
        const retainedRuns = retainActiveRunsWithoutOutput(worktreeRuns);
        if (retainedRuns) {
          return {
            runs: {
              ...state.runs,
              [wk]: retainedRuns,
            },
          };
        }
        const next = { ...state.runs };
        delete next[wk];
        return { runs: next };
      });
    },

    cleanupWorktree: (projectId: string, worktreeId: string): void => {
      const wk = worktreeKey(projectId, worktreeId);
      loadedWorktreeKeys.delete(wk);
      buffer.removeWorktree(wk);
      set((state) => {
        if (!state.runs[wk]) return state;
        const next = { ...state.runs };
        delete next[wk];
        return { runs: next };
      });
    },
  };
});

/**
 * Immediately flush any buffered `appendOutput` events into the store.
 * Exposed for testing.
 */
export function flushPendingHookOutputs(): void {
  outputBuffer?.flush();
}
