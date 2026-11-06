import type {
  SlowActionEvent,
  SlowActionKind,
  SlowActionRecord,
  SlowActionSnapshot,
} from '@canopy/desktop-shared/types';

const DEFAULT_SLOW_ACTION_THRESHOLD_MS = 15_000;
const MAX_SLOW_ACTION_RECORDS = 256;

export interface TrackSlowActionOptions {
  id?: string;
  kind: SlowActionKind;
  label: string;
  thresholdMs?: number;
  context?: SlowActionRecord['context'];
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
  const pending: PendingSlowAction = {
    record,
    timeout: setTimeout(() => {
      visibleRecords.set(id, record);
      trimVisibleRecords();
      if (visibleRecords.has(id)) {
        emitSlowActionEvent({ type: 'added', record });
      }
    }, thresholdMs),
  };

  pendingActions.set(id, pending);

  try {
    return await promise;
  } finally {
    clearTimeout(pending.timeout);
    pendingActions.delete(id);
    if (visibleRecords.delete(id)) {
      emitSlowActionEvent({ type: 'resolved', id });
    }
  }
}
