import { costScopeKey, type CostScopeRef } from '@canopy/protocol/cost-view';
import {
  onAuditEntryEnqueued,
  type AuditEntryEnqueuedEvent,
} from '../observability/audit-stream-hooks';
import { isCostScopeWatched } from './events';
import { getDesktopCostIndexStore } from './service';
import type { CostInternalTrigger } from './types';

const IDLE_INTERVAL_MS = 10 * 60 * 1000;
/** Helpers and pipeline steps: at most one refresh per window. */
const BACKGROUND_DELAY_MS = 30 * 1000;
/** A delegation or subagent ended: wait out a burst of them, then refresh. */
const ATTRIBUTED_WORK_DEBOUNCE_MS = 3 * 1000;

/** A session's own turn: a chat in a worktree, a Work Entry or App Advisor. */
const SESSION_TURN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'worktree_chat',
  'standalone_chat',
  'app_advisor',
]);

/** How soon a queued audit entry should reach the cost views. */
type RefreshUrgency = 'now' | 'debounced' | 'background';

function urgencyOf(event: AuditEntryEnqueuedEvent): RefreshUrgency | null {
  if (event.status === 'running') {
    // An unfinished entry changes no cost, except when it was queued because
    // one of its subagents finished.
    return event.cause === 'subagent_ended' ? 'debounced' : null;
  }
  if (SESSION_TURN_EVENT_TYPES.has(event.eventType)) return 'now';
  return event.eventType === 'managed_delegation' ? 'debounced' : 'background';
}

export interface CostSchedulerDependencies {
  readonly refreshInternal: (
    trigger: CostInternalTrigger,
    scope?: CostScopeRef,
  ) => Promise<unknown>;
  readonly hasAuditGrowth: () => Promise<boolean>;
  readonly onAuditEntryEnqueued: (
    listener: (event: AuditEntryEnqueuedEvent) => void,
  ) => () => void;
  readonly isCostScopeWatched: (scope: CostScopeRef) => boolean;
  /** No view shows the scope: its next `open` refresh must not be skipped. */
  readonly markScopeStale: (scope: CostScopeRef) => void;
}

interface PendingScope {
  readonly scope: CostScopeRef;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly dueAt: number;
  /** The latest the refresh may run, however many requests follow. */
  readonly deadline: number;
}

/**
 * Run the first scan when the deferred scheduler is loaded, then only poll
 * audit stats every ten minutes. Finished work refreshes a narrower set, the
 * scopes a view is showing:
 *
 * - a session's turn ends: at once, so its cost is there when the chat goes
 *   idle;
 * - a delegation or a subagent ends: after a short debounce;
 * - a helper or pipeline step ends: within thirty seconds.
 *
 * A scope nobody is showing is marked stale instead, and refreshed when a view
 * opens it.
 */
export function createCostIndexScheduler(
  dependencies: CostSchedulerDependencies,
): () => void {
  let disposed = false;
  let idleRunning = false;
  const pending = new Map<string, PendingScope>();

  const refresh = (
    trigger: CostInternalTrigger,
    scope?: CostScopeRef,
  ): void => {
    if (disposed) return;
    void dependencies.refreshInternal(trigger, scope).catch(() => {
      // Background index maintenance must not destabilize the host process.
    });
  };

  // bootstrap.ts loads this module only after its 60-second startup delay.
  refresh('startup');

  const idleTimer = setInterval((): void => {
    if (disposed || idleRunning) return;
    idleRunning = true;
    void dependencies
      .hasAuditGrowth()
      .then((hasGrowth): void => {
        if (hasGrowth) refresh('idle');
      })
      .catch(() => {
        // A later interval retries; no logging can include audit content.
      })
      .finally((): void => {
        idleRunning = false;
      });
  }, IDLE_INTERVAL_MS);
  idleTimer.unref?.();

  const refreshWatched = (scope: CostScopeRef): void => {
    if (dependencies.isCostScopeWatched(scope)) {
      refresh('turn', scope);
    } else {
      dependencies.markScopeStale(scope);
    }
  };

  const queueRefresh = (scope: CostScopeRef, urgency: RefreshUrgency): void => {
    const key = costScopeKey(scope);
    const previous = pending.get(key);
    if (urgency === 'now') {
      if (previous !== undefined) clearTimeout(previous.timer);
      pending.delete(key);
      refreshWatched(scope);
      return;
    }
    const now = Date.now();
    const deadline = previous?.deadline ?? now + BACKGROUND_DELAY_MS;
    // Background work never postpones a pending refresh. A debounced request
    // starts its wait again, up to the deadline.
    const dueAt =
      urgency === 'background'
        ? (previous?.dueAt ?? deadline)
        : Math.min(now + ATTRIBUTED_WORK_DEBOUNCE_MS, deadline);
    if (previous !== undefined) {
      if (previous.dueAt === dueAt) return;
      clearTimeout(previous.timer);
    }
    const timer = setTimeout(
      (): void => {
        pending.delete(key);
        if (!disposed) refreshWatched(scope);
      },
      Math.max(0, dueAt - now),
    );
    timer.unref?.();
    pending.set(key, { scope, timer, dueAt, deadline });
  };

  const unsubscribe = dependencies.onAuditEntryEnqueued((event): void => {
    if (disposed) return;
    const urgency = urgencyOf(event);
    if (urgency === null) return;
    const scope = scopeForEvent(event);
    if (scope === null) return;
    if (!dependencies.isCostScopeWatched(scope)) {
      dependencies.markScopeStale(scope);
      return;
    }
    queueRefresh(scope, urgency);
  });

  return (): void => {
    if (disposed) return;
    disposed = true;
    clearInterval(idleTimer);
    unsubscribe();
    for (const entry of Array.from(pending.values())) {
      clearTimeout(entry.timer);
    }
    pending.clear();
  };
}

let stopScheduler: (() => void) | null = null;

/** Start once; the returned disposer stops intervals and hook subscriptions. */
export function startCostIndexScheduler(): () => void {
  if (stopScheduler !== null) return stopScheduler;
  const store = getDesktopCostIndexStore();
  const stop = createCostIndexScheduler({
    refreshInternal: (trigger, scope) => store.refreshInternal(trigger, scope),
    hasAuditGrowth: () => store.hasAuditGrowth(),
    onAuditEntryEnqueued,
    isCostScopeWatched,
    markScopeStale: (scope) => store.markScopeStale(scope),
  });
  stopScheduler = (): void => {
    stop();
    stopScheduler = null;
  };
  return stopScheduler;
}

function scopeForEvent(event: AuditEntryEnqueuedEvent): CostScopeRef | null {
  const projectId = event.projectId?.trim();
  const worktreeId = event.worktreeId?.trim();
  if (
    projectId === undefined ||
    projectId.length === 0 ||
    worktreeId === undefined ||
    worktreeId.length === 0
  ) {
    return null;
  }
  return { kind: 'entry', projectId, worktreeId };
}
