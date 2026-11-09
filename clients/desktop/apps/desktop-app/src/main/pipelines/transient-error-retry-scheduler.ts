import type { BrowserWindow } from 'electron';
import {
  PIPELINE_TRANSIENT_RETRY_DELAYS_MS,
  PIPELINE_TRANSIENT_RETRY_MAX_ATTEMPTS,
} from '@canopy/execution-engine/agent-failures';
import type {
  ExecutionEvent,
  ExecutionState,
  PipelineTransientRetryState,
} from '@canopy/execution-engine/types/pipeline';
import type {
  ResumePipelineExecutionFromMainRequest,
  ResumePipelineExecutionFromMainResult,
} from './pipeline-resume-service';

interface PipelineRetryPreferences {
  autoRetryTransientErrorsPipelines: boolean;
}

interface PipelineRetryEntry {
  lastEvent: ExecutionEvent;
  display?: PipelineTransientRetryState;
  attempts: Map<string, number>;
  timer: ReturnType<typeof setTimeout> | null;
  scheduledReasonIds: string[];
  scheduledSignatures: string[];
  token: number;
}

export interface TransientErrorRetrySchedulerDependencies {
  emitEvent?: (event: ExecutionEvent) => void;
  resume: (
    request: ResumePipelineExecutionFromMainRequest,
  ) => Promise<ResumePipelineExecutionFromMainResult>;
  readPreferences: () => Promise<PipelineRetryPreferences>;
}

const retryEntries = new Map<string, PipelineRetryEntry>();
let initializedDependencies: TransientErrorRetrySchedulerDependencies | null =
  null;
let tokenCounter = 0;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function nextToken(): number {
  tokenCounter += 1;
  return tokenCounter;
}

function clearTimer(entry: PipelineRetryEntry): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
}

export function withPipelineTransientRetryState(
  state: ExecutionState,
): ExecutionState {
  const display = retryEntries.get(state.id)?.display;
  return state.transient_retry === display
    ? state
    : { ...state, transient_retry: display };
}

function emitRetryState(entry: PipelineRetryEntry): void {
  initializedDependencies?.emitEvent?.({
    ...entry.lastEvent,
    type: 'execution.updated',
    state: withPipelineTransientRetryState(entry.lastEvent.state),
    timestamp: new Date().toISOString(),
  });
}

function deleteEntry(executionId: string): void {
  const entry = retryEntries.get(executionId);
  if (entry) clearTimer(entry);
  retryEntries.delete(executionId);
  if (entry) emitRetryState(entry);
}

function isTerminalEvent(event: ExecutionEvent): boolean {
  return (
    event.type === 'execution.completed' ||
    event.type === 'execution.failed' ||
    event.type === 'execution.cancelled' ||
    event.state.status === 'success' ||
    event.state.status === 'failure' ||
    event.state.status === 'cancelled'
  );
}

function transientStepSignature(
  reasons: readonly ExecutionEvent['state']['status_reasons'][number][],
): string[] {
  return Array.from(
    new Set(
      reasons.map(
        (reason) => `${reason.source.job_id}\0${reason.source.step_id}`,
      ),
    ),
  ).sort();
}

function transientReasonSignature(
  reason: ExecutionEvent['state']['status_reasons'][number],
): string {
  return `${reason.source.job_id}\0${reason.source.step_id}`;
}

function isTerminalStatus(status: string | undefined): boolean {
  return (
    status === 'success' ||
    status === 'failure' ||
    status === 'cancelled' ||
    status === 'skipped'
  );
}

function pruneTerminalAttemptHistory(
  entry: PipelineRetryEntry,
  state: ExecutionEvent['state'],
): void {
  for (const signature of Array.from(entry.attempts.keys())) {
    const [jobId] = signature.split('\0');
    const job = jobId ? state.jobs[jobId] : undefined;
    const terminal = isTerminalStatus(job?.status);
    if (terminal) {
      entry.attempts.delete(signature);
    }
  }
}

function clearScheduledBatch(entry: PipelineRetryEntry): void {
  clearTimer(entry);
  entry.scheduledReasonIds = [];
  entry.scheduledSignatures = [];
  entry.display = undefined;
  entry.token = nextToken();
  emitRetryState(entry);
}

async function fireRetryTimer(
  executionId: string,
  token: number,
  getWindow: () => BrowserWindow | null,
): Promise<void> {
  const dependencies = initializedDependencies;
  const entry = retryEntries.get(executionId);
  if (!dependencies || !entry || entry.token !== token) return;
  entry.timer = null;

  try {
    const preferences = await dependencies.readPreferences();
    const liveEntry = retryEntries.get(executionId);
    if (!liveEntry || liveEntry.token !== token) return;
    if (!preferences.autoRetryTransientErrorsPipelines) {
      deleteEntry(executionId);
      return;
    }

    const signatures = [...liveEntry.scheduledSignatures];
    if (signatures.length === 0) return;
    for (const signature of signatures) {
      liveEntry.attempts.set(
        signature,
        (liveEntry.attempts.get(signature) ?? 0) + 1,
      );
    }
    if (liveEntry.display) {
      liveEntry.display = { ...liveEntry.display, nextRetryAt: null };
      emitRetryState(liveEntry);
    }
    const statusReasonIds = [...liveEntry.scheduledReasonIds];
    const result = await dependencies.resume({
      executionId,
      statusReasonIds,
      allowStaleNoop: true,
      initiationSource: 'automation',
      transientRetryOwnToken: token,
      getWindow,
    });
    if (retryEntries.get(executionId)?.token !== token) return;
    if (result.status === 'stale-noop') {
      deleteEntry(executionId);
    }
  } catch {
    if (retryEntries.get(executionId)?.token === token) {
      deleteEntry(executionId);
    }
  }
}

function handlePausedEvent(
  event: ExecutionEvent,
  getWindow: () => BrowserWindow | null,
): void {
  if (event.state.parent_execution_id) return;

  const transientReasons = event.state.status_reasons.filter(
    (reason) =>
      reason.kind === 'provider_temporarily_unavailable' &&
      UUID_PATTERN.test(reason.id),
  );
  const existing = retryEntries.get(event.executionId);
  if (existing) {
    pruneTerminalAttemptHistory(existing, event.state);
  }
  if (transientReasons.length === 0) {
    if (existing) {
      clearScheduledBatch(existing);
    }
    return;
  }
  const entry: PipelineRetryEntry = existing ?? {
    lastEvent: event,
    attempts: new Map(),
    timer: null,
    scheduledReasonIds: [],
    scheduledSignatures: [],
    token: nextToken(),
  };
  if (existing) clearTimer(existing);
  const token = nextToken();
  const scheduledReasons = transientReasons.filter(
    (reason) =>
      (entry.attempts.get(transientReasonSignature(reason)) ?? 0) <
      PIPELINE_TRANSIENT_RETRY_MAX_ATTEMPTS,
  );
  entry.scheduledReasonIds = Array.from(
    new Set(scheduledReasons.map((reason) => reason.id)),
  );
  entry.scheduledSignatures = transientStepSignature(scheduledReasons);
  entry.token = token;
  retryEntries.set(event.executionId, entry);
  if (entry.scheduledSignatures.length === 0) {
    entry.display = {
      attempt: PIPELINE_TRANSIENT_RETRY_MAX_ATTEMPTS,
      maxAttempts: PIPELINE_TRANSIENT_RETRY_MAX_ATTEMPTS,
      nextRetryAt: null,
      exhausted: true,
    };
    emitRetryState(entry);
    return;
  }

  const dependencies = initializedDependencies;
  if (!dependencies) return;
  void (async (): Promise<void> => {
    try {
      const preferences = await dependencies.readPreferences();
      const liveEntry = retryEntries.get(event.executionId);
      if (!liveEntry || liveEntry.token !== token) return;
      if (!preferences.autoRetryTransientErrorsPipelines) {
        deleteEntry(event.executionId);
        return;
      }
      const attempt = Math.min(
        ...liveEntry.scheduledSignatures.map(
          (signature) => liveEntry.attempts.get(signature) ?? 0,
        ),
      );
      const delay = PIPELINE_TRANSIENT_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) return;
      liveEntry.display = {
        attempt: attempt + 1,
        maxAttempts: PIPELINE_TRANSIENT_RETRY_MAX_ATTEMPTS,
        nextRetryAt: Date.now() + delay,
        exhausted: false,
      };
      emitRetryState(liveEntry);
      liveEntry.timer = setTimeout(() => {
        void fireRetryTimer(event.executionId, token, getWindow);
      }, delay);
    } catch {
      if (retryEntries.get(event.executionId)?.token === token) {
        deleteEntry(event.executionId);
      }
    }
  })();
}

export function initTransientErrorRetryScheduler(
  dependencies: TransientErrorRetrySchedulerDependencies,
): void {
  initializedDependencies = dependencies;
}

export function notePipelineExecutionEvent(
  event: ExecutionEvent,
  getWindow: () => BrowserWindow | null,
): void {
  if (!initializedDependencies) return;
  const existing = retryEntries.get(event.executionId);
  if (existing) existing.lastEvent = event;
  if (isTerminalEvent(event)) {
    deleteEntry(event.executionId);
    return;
  }
  if (event.type === 'execution.paused') {
    handlePausedEvent(event, getWindow);
  }
}

export function cancelPendingTransientRetryTimer(
  executionId: string,
  ownToken?: number,
): void {
  const entry = retryEntries.get(executionId);
  if (!entry) return;
  if (ownToken === entry.token) {
    clearTimer(entry);
    return;
  }
  deleteEntry(executionId);
}

export function resetTransientErrorRetrySchedulerForTests(): void {
  for (const entry of Array.from(retryEntries.values())) clearTimer(entry);
  retryEntries.clear();
  initializedDependencies = null;
  tokenCounter = 0;
}
