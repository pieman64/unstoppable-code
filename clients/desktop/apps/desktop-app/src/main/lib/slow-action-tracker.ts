import type {
  SlowActionEvent,
  SlowActionKind,
  SlowActionRecord,
  SlowActionSnapshot,
} from '@canopy/desktop-shared/types';
import {
  createDesktopInstrumentationOperationKey,
  type DesktopInstrumentationContext,
  type DesktopOperationName,
} from '@canopy/desktop-instrumentation';
import {
  failDesktopOperation,
  startDesktopOperation,
  succeedDesktopOperation,
} from '@canopy/desktop-instrumentation/electron/main';

const DEFAULT_SLOW_ACTION_THRESHOLD_MS = 15_000;
const MAX_SLOW_ACTION_RECORDS = 256;
const SLOW_ACTION_OPERATION_NAME = 'canopy.slow_action';

export interface TrackSlowActionOptions {
  id?: string;
  kind: SlowActionKind;
  label: string;
  thresholdMs?: number;
  context?: SlowActionRecord['context'];
  telemetryOperationName: DesktopOperationName;
}

type SlowActionListener = (event: SlowActionEvent) => void;

interface PendingSlowAction {
  record: SlowActionRecord;
  timeout: NodeJS.Timeout;
}

const pendingActions = new Map<string, PendingSlowAction>();
const visibleRecords = new Map<string, SlowActionRecord>();
const listeners = new Set<SlowActionListener>();

function makeSlowActionId(kind: SlowActionKind): string {
  return `slow-${kind}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function emitSlowActionEvent(event: SlowActionEvent): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener(event);
    } catch (error) {
      // Diagnostics should never break the work they are observing.
      // eslint-disable-next-line no-console
      console.error('[slow-action-tracker] listener failed:', error);
    }
  }
}

function buildTelemetryContext(
  record: SlowActionRecord,
  status: 'started' | 'threshold_exceeded' | 'success' | 'failure',
  durationMs?: number,
): DesktopInstrumentationContext {
  return {
    kind: record.kind,
    channel: record.context?.channel,
    has_project_context: Boolean(
      record.context?.projectId || record.context?.worktreeId,
    ),
    has_chat_context: Boolean(record.context?.chatId),
    has_pipeline_execution: Boolean(record.context?.pipelineExecutionId),
    has_terminal: Boolean(record.context?.terminalId),
    threshold_ms: record.thresholdMs,
    duration_ms: durationMs,
    exceeded_slow_threshold:
      status === 'threshold_exceeded'
        ? true
        : durationMs !== undefined
          ? durationMs >= record.thresholdMs
          : undefined,
    status,
  };
}

function safelyEmitTelemetry(callback: () => void): void {
  try {
    callback();
  } catch {
    // Telemetry must never affect the work it observes.
  }
}

function emitSlowThresholdTelemetry(record: SlowActionRecord): void {
  safelyEmitTelemetry(() => {
    const durationMs = Math.max(0, Date.now() - record.startedAtMs);
    const operationKey = createDesktopInstrumentationOperationKey(
      `slow-action-threshold:${record.id}:${record.startedAtMs}`,
    );
    const context = buildTelemetryContext(
      record,
      'threshold_exceeded',
      durationMs,
    );
    startDesktopOperation(SLOW_ACTION_OPERATION_NAME, {
      operationKey,
      context,
    });
    succeedDesktopOperation(SLOW_ACTION_OPERATION_NAME, {
      operationKey,
      context,
    });
  });
}

function trimVisibleRecords(): void {
  while (visibleRecords.size > MAX_SLOW_ACTION_RECORDS) {
    let oldestId: string | null = null;
    let oldestStartedAtMs = Number.POSITIVE_INFINITY;
    visibleRecords.forEach((record) => {
      if (record.startedAtMs < oldestStartedAtMs) {
        oldestId = record.id;
        oldestStartedAtMs = record.startedAtMs;
      }
    });
    if (!oldestId) {
      return;
    }
    visibleRecords.delete(oldestId);
    emitSlowActionEvent({ type: 'evicted', id: oldestId });
  }
}

export function getSlowActionSnapshot(): SlowActionSnapshot {
  return {
    records: Array.from(visibleRecords.values()).sort(
      (left, right) => right.startedAtMs - left.startedAtMs,
    ),
  };
}

export function subscribeSlowActions(listener: SlowActionListener): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

export function clearSlowActions(): void {
  visibleRecords.clear();
  emitSlowActionEvent({ type: 'cleared' });
}

export function resetSlowActionTrackerForTests(): void {
  for (const pending of Array.from(pendingActions.values())) {
    clearTimeout(pending.timeout);
  }
  pendingActions.clear();
  visibleRecords.clear();
  listeners.clear();
}

export async function trackSlowAction<T>(
  promise: Promise<T>,
  options: TrackSlowActionOptions,
): Promise<T> {
  const id = options.id ?? makeSlowActionId(options.kind);
  const startedAtMs = Date.now();
  const thresholdMs = options.thresholdMs ?? DEFAULT_SLOW_ACTION_THRESHOLD_MS;
  const record: SlowActionRecord = {
    id,
    kind: options.kind,
    label: options.label,
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    thresholdMs,
    ...(options.context ? { context: options.context } : {}),
  };
  const telemetryOperationKey = createDesktopInstrumentationOperationKey(
    `tracked-action:${record.kind}:${record.id}`,
  );

  const pending: PendingSlowAction = {
    record,
    timeout: setTimeout(() => {
      visibleRecords.set(id, record);
      emitSlowThresholdTelemetry(record);
      trimVisibleRecords();
      if (visibleRecords.has(id)) {
        emitSlowActionEvent({ type: 'added', record });
      }
    }, thresholdMs),
  };

  pendingActions.set(id, pending);
  safelyEmitTelemetry(() => {
    startDesktopOperation(options.telemetryOperationName, {
      operationKey: telemetryOperationKey,
      context: buildTelemetryContext(record, 'started'),
    });
  });

  try {
    const result = await promise;
    const durationMs = Math.max(0, Date.now() - startedAtMs);
    safelyEmitTelemetry(() => {
      succeedDesktopOperation(options.telemetryOperationName, {
        operationKey: telemetryOperationKey,
        context: buildTelemetryContext(record, 'success', durationMs),
      });
    });
    return result;
  } catch (error) {
    const durationMs = Math.max(0, Date.now() - startedAtMs);
    safelyEmitTelemetry(() => {
      failDesktopOperation(options.telemetryOperationName, 'error', {
        operationKey: telemetryOperationKey,
        context: buildTelemetryContext(record, 'failure', durationMs),
      });
    });
    throw error;
  } finally {
    clearTimeout(pending.timeout);
    pendingActions.delete(id);
    if (visibleRecords.delete(id)) {
      emitSlowActionEvent({ type: 'resolved', id });
    }
  }
}
