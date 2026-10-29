import { create } from 'zustand';
import type {
  ExecutionEvent,
  ExecutionSummary,
} from '@canopy/desktop-shared/types/pipeline';
import { summaryFromState } from '@/stores/pipelineRunsStore';

/**
 * Every retained pipeline execution, for the Workflows Runs feed and the
 * Library's Last run (CAN-3981). It sits beside the scoped `summaries` in
 * `pipelineRunsStore`, which follows the selected worktree and is left
 * untouched.
 *
 * Executions are keyed by id. An event patches its one entry in place and
 * keeps the list order; only a new execution changes the list's length, and
 * it is put first. Consumers sort their own rows, so nothing here re-sorts.
 */
export interface ExecutionFeedState {
  readonly executions: readonly ExecutionSummary[];
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  load: () => Promise<void>;
  applyEvent: (event: ExecutionEvent) => void;
  /** Reflects a hide or unhide the user just made on one run. */
  setHidden: (executionId: string, hidden: boolean) => void;
}

function sameSummary(a: ExecutionSummary, b: ExecutionSummary): boolean {
  return (
    a.status === b.status &&
    a.completed_at === b.completed_at &&
    a.started_at === b.started_at &&
    a.pipeline_name === b.pipeline_name &&
    a.project_id === b.project_id &&
    a.worktree_id === b.worktree_id &&
    a.event_name === b.event_name &&
    a.trigger_source?.kind === b.trigger_source?.kind &&
    a.hidden === b.hidden &&
    a.has_report === b.has_report &&
    a.has_plan === b.has_plan &&
    JSON.stringify(a.status_reasons) === JSON.stringify(b.status_reasons)
  );
}

/**
 * Patches one execution into the list. Returns the same array when nothing
 * the feed shows changed, so subscribers do not re-render for step output.
 */
export function patchExecution(
  executions: readonly ExecutionSummary[],
  next: ExecutionSummary,
): readonly ExecutionSummary[] {
  const index = executions.findIndex((entry) => entry.id === next.id);
  if (index === -1) return [next, ...executions];
  const current = executions[index];
  if (current !== undefined && sameSummary(current, next)) return executions;
  const patched = executions.slice();
  patched[index] = next;
  return patched;
}

let loadInFlight: Promise<void> | null = null;
// Ids an event patched while a load is in flight; `null` between loads.
let patchedDuringLoad: Set<string> | null = null;

export const useExecutionFeedStore = create<ExecutionFeedState>((set, get) => ({
  executions: [],
  loaded: false,
  loading: false,
  error: null,
  load: (): Promise<void> => {
    if (loadInFlight) return loadInFlight;
    set({ loading: true });
    const patched = new Set<string>();
    patchedDuringLoad = patched;
    const request = (async (): Promise<void> => {
      try {
        const result = await window.pipelines.listExecutions();
        if (!result.success || !result.data) {
          set({
            loaded: true,
            loading: false,
            error: result.error ?? 'Pipeline runs could not be loaded.',
          });
          return;
        }
        const listed = result.data;
        // Events that arrived while the list was loading are newer than it.
        // Anything else still held is from before the load, such as a visit
        // that ended while a run was in progress, and the listing replaces it.
        const live = new Map(
          get()
            .executions.filter((entry) => patched.has(entry.id))
            .map((entry) => [entry.id, entry]),
        );
        const seen = new Set(listed.map((entry) => entry.id));
        set({
          executions: [
            ...Array.from(live.values()).filter((entry) => !seen.has(entry.id)),
            ...listed.map((entry) => live.get(entry.id) ?? entry),
          ],
          loaded: true,
          loading: false,
          error: null,
        });
      } catch (error) {
        set({
          loaded: true,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        loadInFlight = null;
        if (patchedDuringLoad === patched) patchedDuringLoad = null;
      }
    })();
    loadInFlight = request;
    return request;
  },
  applyEvent: (event): void => {
    patchedDuringLoad?.add(event.state.id);
    const executions = patchExecution(
      get().executions,
      summaryFromState(event.state),
    );
    if (executions !== get().executions) set({ executions });
  },
  setHidden: (executionId, hidden): void => {
    set({
      executions: get().executions.map((entry) =>
        entry.id === executionId
          ? { ...entry, hidden: hidden || undefined }
          : entry,
      ),
    });
  },
}));

let retainCount = 0;
let releaseBridge: (() => void) | null = null;

/**
 * Loads the feed and keeps it current while at least one surface holds it.
 * Ref-counted, so the Runs and Library tabs share one subscription.
 */
export function retainExecutionFeed(): () => void {
  retainCount += 1;
  if (retainCount === 1) {
    const unsubscribe = window.pipelines.onExecutionEvent((event) => {
      useExecutionFeedStore.getState().applyEvent(event);
    });
    releaseBridge = unsubscribe;
    void useExecutionFeedStore.getState().load();
  }
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    retainCount -= 1;
    if (retainCount === 0) {
      releaseBridge?.();
      releaseBridge = null;
    }
  };
}
