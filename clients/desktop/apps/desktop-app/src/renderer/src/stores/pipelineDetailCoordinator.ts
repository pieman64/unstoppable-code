import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ExecutionState } from '@canopy/desktop-shared/types/pipeline';
import {
  acquirePipelineDetailLease,
  acquirePipelineSummaryInterest,
  pipelineDetailOwnerKey,
  releasePipelineDetailLease,
  type PipelineDetailOwner,
} from '../lib/pipelineDetailLeases';
import type { StepLogIdentity } from '../lib/pipelineRunOutput';
import { usePipelineRunsStore } from './pipelineRunsStore';
import {
  acquireStepLogInterest,
  getStepLogView,
  stepLogInterestKey,
  subscribeStepLog,
  type StepLogInterest,
  type StepLogView,
} from './pipelineStepLogStore';

/**
 * Pipeline detail coordinator: the one demand owner for visible pipeline
 * detail consumers (the execution detail modal and its inline children today,
 * the pipeline execution panel in phase 03).
 *
 * - `acquirePipelineExecutionDetail` / `usePipelineExecutionDetailLease`:
 *   ref-counted detail leases keyed by owner plus execution. Interest is
 *   registered before the first snapshot read; the read is single-flight and
 *   stale-guarded in `pipelineRunsStore.loadExecutionDetails`. Releasing the
 *   last lease evicts the heavy snapshot unless the list or a summary
 *   interest still retains it.
 * - `usePipelineExecutionSummaryInterest`: lightweight live status for chat
 *   run cards. Never reads detail or logs by itself.
 * - `useStepLogInterest`: one physical step log's output, read and joined by
 *   `pipelineStepLogStore`.
 *
 * `enabled` is the visibility gate: phase 03 drives it from panel visibility,
 * so a hidden consumer holds no lease, no log interest, and no buffer.
 */

export type { PipelineDetailOwner } from '../lib/pipelineDetailLeases';

function hasCompleteDetail(state: ExecutionState | undefined): boolean {
  return Boolean(state?.job_definitions && state.job_groups);
}

/**
 * Loads a snapshot for a leased execution unless the cache already holds a
 * complete one (which execution events keep current while it is leased).
 */
export function ensurePipelineExecutionDetail(
  executionId: string,
): Promise<ExecutionState | null> {
  const store = usePipelineRunsStore.getState();
  const cached = store.statesById[executionId];
  if (cached && hasCompleteDetail(cached)) {
    return Promise.resolve(cached);
  }
  return store.loadExecutionDetails(executionId);
}

/**
 * Imperative lease for non-React callers. The returned release is
 * idempotent; the last release evicts the execution's unretained detail.
 */
export function acquirePipelineExecutionDetail(
  owner: PipelineDetailOwner | null | undefined,
  executionId: string,
): () => void {
  // Register interest first so events observed during the read are applied
  // to this execution and supersede a late snapshot.
  const lease = acquirePipelineDetailLease(owner, executionId);
  void ensurePipelineExecutionDetail(executionId);
  return (): void => {
    if (releasePipelineDetailLease(lease)) {
      usePipelineRunsStore.getState().releaseExecutionDetail(executionId);
    }
  };
}

export interface PipelineExecutionDetailLeaseResult {
  /** The snapshot read failed and no state is cached. */
  loadFailed: boolean;
}

function parseOwnerKey(ownerKey: string): PipelineDetailOwner | null {
  const separator = ownerKey.indexOf('/');
  if (separator <= 0) return null;
  return {
    projectId: ownerKey.slice(0, separator),
    worktreeId: ownerKey.slice(separator + 1),
  };
}

/**
 * Holds a detail lease for `executionId` while `enabled`, loading its
 * snapshot, and reloading it if the cached state disappears while leased.
 * Consumers select the state itself from `pipelineRunsStore.statesById`.
 */
export function usePipelineExecutionDetailLease(
  owner: PipelineDetailOwner | null | undefined,
  executionId: string | null,
  enabled: boolean,
): PipelineExecutionDetailLeaseResult {
  const ownerKey = pipelineDetailOwnerKey(owner);
  const active = enabled && executionId !== null;
  const hasState = usePipelineRunsStore((state) =>
    executionId !== null ? state.statesById[executionId] !== undefined : false,
  );
  const [failedExecutionId, setFailedExecutionId] = useState<string | null>(
    null,
  );

  // The lease effect is declared before the load effect, so demand is
  // registered before the first read in the same commit.
  useEffect(() => {
    if (!active || executionId === null) return undefined;
    const lease = acquirePipelineDetailLease(
      parseOwnerKey(ownerKey),
      executionId,
    );
    return (): void => {
      if (releasePipelineDetailLease(lease)) {
        usePipelineRunsStore.getState().releaseExecutionDetail(executionId);
      }
    };
  }, [active, executionId, ownerKey]);

  useEffect(() => {
    if (!active || executionId === null || hasState) return undefined;
    let cancelled = false;
    setFailedExecutionId((current) =>
      current === executionId ? null : current,
    );
    void ensurePipelineExecutionDetail(executionId).then((result) => {
      if (!cancelled && result === null) {
        setFailedExecutionId(executionId);
      }
    });
    return (): void => {
      cancelled = true;
    };
  }, [active, executionId, hasState]);

  return {
    loadFailed:
      active &&
      executionId !== null &&
      !hasState &&
      failedExecutionId === executionId,
  };
}

/**
 * Keeps the listed executions' cached state across list scope changes and
 * live under execution events, without detail or log demand. Releasing it
 * does not evict: the entry falls back to ordinary unretained cache.
 */
export function usePipelineExecutionSummaryInterest(
  executionIds: readonly string[],
): void {
  const idsKey = executionIds.join('\0');
  useEffect(() => {
    if (idsKey.length === 0) return undefined;
    const releases = idsKey.split('\0').map(acquirePipelineSummaryInterest);
    return (): void => {
      for (const release of releases) {
        release();
      }
    };
  }, [idsKey]);
}

export interface UseStepLogInterestOptions {
  identity: StepLogIdentity;
  logFilePath?: string;
  /** Whether the step has settled; a change triggers one re-read. */
  terminal: boolean;
  enabled: boolean;
  acceptsLiveOutput?: boolean;
}

const IDLE_STEP_LOG_VIEW: StepLogView = Object.freeze({
  status: 'ready',
  lines: [],
});

function noopUnsubscribe(): void {}

/**
 * Registers interest in one step log while mounted and `enabled`, and
 * subscribes to that log only.
 */
export function useStepLogInterest({
  identity,
  logFilePath,
  terminal,
  enabled,
  acceptsLiveOutput = true,
}: UseStepLogInterestOptions): StepLogView {
  const request = {
    identity,
    logFilePath,
    terminal,
    acceptsLiveOutput,
  };
  const key = enabled ? stepLogInterestKey(request) : null;
  const requestRef = useRef(request);
  requestRef.current = request;
  const interestRef = useRef<StepLogInterest | null>(null);

  // A layout effect, so buffering starts within the commit that mounts the
  // log. Output arrives over IPC, which can run between a commit and its
  // passive effects; the bridge drops output nothing has registered for,
  // and a snapshot read issued afterwards may predate that chunk's append.
  useLayoutEffect(() => {
    if (key === null) return undefined;
    const interest = acquireStepLogInterest(requestRef.current);
    interestRef.current = interest;
    return (): void => {
      interest.release();
      if (interestRef.current === interest) {
        interestRef.current = null;
      }
    };
  }, [key]);

  useEffect(() => {
    interestRef.current?.setTerminal(terminal);
  }, [key, terminal]);

  const subscribe = useCallback(
    (listener: () => void): (() => void) =>
      key === null ? noopUnsubscribe : subscribeStepLog(key, listener),
    [key],
  );
  const getSnapshot = useCallback(
    (): StepLogView =>
      key === null ? IDLE_STEP_LOG_VIEW : getStepLogView(key),
    [key],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
