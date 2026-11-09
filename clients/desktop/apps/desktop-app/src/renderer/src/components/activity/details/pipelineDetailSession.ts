/**
 * Retained view state for a pipeline execution detail that outlives its
 * React subtree.
 *
 * A pipeline panel's content unmounts on a worktree switch and its data is
 * dropped while it is hidden, but the user's place in the run should survive
 * both: which steps they opened, raw versus rich output, which child runs
 * they expanded, where they had scrolled, and pause answers they had not sent
 * yet. A panel host provides a {@link PipelineDetailSession} backed by its
 * per-panel session store; detail components start from the retained value
 * and write every user change back. Without a session (the compatibility
 * modal, archived views) the same components keep ordinary local state.
 *
 * Only small view values belong here. Execution snapshots, logs, reports,
 * and parsed transcripts never do.
 */
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from 'react';
import type {
  PipelinePauseCheckpoint,
  PipelineScalar,
} from '@canopy/execution-engine/types/pipeline';
import type { PipelineLogViewMode } from '@/lib/pipelineExecutionDetail';

/** Unsent answers per pause checkpoint id, then per field key. */
export type PipelinePauseDraftSet = Readonly<
  Record<string, Readonly<Record<string, PipelineScalar>>>
>;

export interface PipelineDetailSessionState {
  /** A step row's expanded state, only once the user toggled it. */
  readonly stepExpanded: Readonly<Record<string, boolean>>;
  /** A step's raw or rich output choice, only once the user chose. */
  readonly stepLogViewMode: Readonly<Record<string, PipelineLogViewMode>>;
  /** Step instance keys whose inline child run is expanded. */
  readonly expandedChildSteps: readonly string[];
  /** Unsent pause answers per execution id. */
  readonly pauseDrafts: Readonly<Record<string, PipelinePauseDraftSet>>;
  /** Last scroll offset of the detail body (best effort). */
  readonly scrollTop?: number;
}

export const EMPTY_PIPELINE_DETAIL_SESSION_STATE: PipelineDetailSessionState =
  Object.freeze({
    stepExpanded: Object.freeze({}),
    stepLogViewMode: Object.freeze({}),
    expandedChildSteps: Object.freeze([]),
    pauseDrafts: Object.freeze({}),
  });

export type PipelineDetailSessionUpdater = (
  previous: PipelineDetailSessionState,
) => PipelineDetailSessionState;

/** A host's retained session for one detail instance. */
export interface PipelineDetailSession {
  /** The retained values. Reading never subscribes to changes. */
  read(): PipelineDetailSessionState;
  update(updater: PipelineDetailSessionUpdater): void;
}

export const PipelineDetailSessionContext =
  createContext<PipelineDetailSession | null>(null);

export function usePipelineDetailSession(): PipelineDetailSession | null {
  return useContext(PipelineDetailSessionContext);
}

/**
 * The value retained for this component when it mounted, or `undefined`
 * without a session or a retained value. Read once: later session writes are
 * this component's own and already in its local state.
 */
export function useRetainedSessionValue<T>(
  select: (state: PipelineDetailSessionState) => T | undefined,
): T | undefined {
  const session = usePipelineDetailSession();
  const [retained] = useState<T | undefined>(() =>
    session === null ? undefined : select(session.read()),
  );
  return retained;
}

/**
 * A stable writer into the current session. A no-op without one, so callers
 * need not branch.
 */
export function useSessionWriter(): (
  updater: PipelineDetailSessionUpdater,
) => void {
  const session = usePipelineDetailSession();
  const sessionRef = useRef(session);
  sessionRef.current = session;
  return useCallback((updater: PipelineDetailSessionUpdater): void => {
    sessionRef.current?.update(updater);
  }, []);
}

/** One step instance's session key: run, job, step, and attempt identity. */
export function stepSessionKey(identity: {
  executionId: string;
  jobId: string;
  stepId: string;
  source: string;
  attempt: number;
  iteration: number;
}): string {
  return [
    identity.executionId,
    identity.jobId,
    identity.stepId,
    identity.source,
    String(identity.attempt),
    String(identity.iteration),
  ].join('\u0000');
}

/** Answers keyed by field for one checkpoint's request, defaults filled in. */
export type PauseAnswers = Record<string, PipelineScalar>;

/**
 * Keeps only retained drafts that still apply: checkpoints that are pending
 * now, and answers for fields their current request still asks for. Anything
 * else (a resumed or superseded checkpoint, a changed form) is dropped rather
 * than carried into a new request.
 */
export function revalidatePauseDrafts(
  drafts: PipelinePauseDraftSet | undefined,
  checkpoints: readonly PipelinePauseCheckpoint[],
): Record<string, PauseAnswers> {
  const result: Record<string, PauseAnswers> = {};
  if (drafts === undefined) return result;
  for (const checkpoint of checkpoints) {
    const draft = drafts[checkpoint.id];
    if (draft === undefined) continue;
    const fieldKeys = new Set(
      (checkpoint.request?.fields ?? []).map((field) => field.key),
    );
    const answers: PauseAnswers = {};
    for (const [key, value] of Object.entries(draft)) {
      if (fieldKeys.has(key)) answers[key] = value;
    }
    result[checkpoint.id] = answers;
  }
  return result;
}
