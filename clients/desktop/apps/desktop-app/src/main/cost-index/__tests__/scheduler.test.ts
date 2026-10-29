import { costScopeKey, type CostScopeRef } from '@canopy/protocol/cost-view';
import type { AuditEntryEnqueuedEvent } from '../../observability/audit-stream-hooks';
import {
  createCostIndexScheduler,
  type CostSchedulerDependencies,
} from '../scheduler';
import type { CostInternalTrigger } from '../types';

const scope: CostScopeRef = {
  kind: 'entry',
  projectId: 'project-1',
  worktreeId: 'entry-1',
};

function event(
  overrides: Partial<AuditEntryEnqueuedEvent> = {},
): AuditEntryEnqueuedEvent {
  return {
    eventType: 'worktree_chat',
    status: 'success',
    projectId: scope.projectId,
    worktreeId: 'entry-1',
    chatId: 'chat-1',
    ...overrides,
  };
}

function fixture(watchedScopes = new Set<string>()): {
  readonly dependencies: CostSchedulerDependencies;
  readonly dispatch: (value: AuditEntryEnqueuedEvent) => void;
  readonly watchedScopes: Set<string>;
  readonly staleScopes: CostScopeRef[];
} {
  const staleScopes: CostScopeRef[] = [];
  let listener: ((value: AuditEntryEnqueuedEvent) => void) | null = null;
  const dependencies: CostSchedulerDependencies = {
    refreshInternal: jest.fn<
      Promise<{ ran: boolean; updatedAt: string | null; revision: number }>,
      [CostInternalTrigger, CostScopeRef?]
    >(() => Promise.resolve({ ran: false, updatedAt: null, revision: 0 })),
    hasAuditGrowth: jest.fn<Promise<boolean>, []>(() => Promise.resolve(false)),
    onAuditEntryEnqueued: (next) => {
      listener = next;
      return (): void => {
        listener = null;
      };
    },
    isCostScopeWatched: (candidate) =>
      watchedScopes.has(costScopeKey(candidate)),
    markScopeStale: (candidate) => {
      staleScopes.push(candidate);
    },
  };
  const dispatch = (value: AuditEntryEnqueuedEvent): void => {
    if (listener === null) throw new Error('Scheduler is not subscribed');
    listener(value);
  };
  return { dependencies, dispatch, watchedScopes, staleScopes };
}

describe('cost index scheduler', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('starts the first pass immediately after deferred module loading and disposes its hook', async () => {
    const harness = fixture();
    const dispose = createCostIndexScheduler(harness.dependencies);
    expect(harness.dependencies.refreshInternal).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.refreshInternal).toHaveBeenCalledWith(
      'startup',
      undefined,
    );
    dispose();
    expect(() => harness.dispatch(event())).toThrow(
      'Scheduler is not subscribed',
    );
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(harness.dependencies.hasAuditGrowth).not.toHaveBeenCalled();
  });

  it('refreshes a watched scope at once when a session turn ends', () => {
    const harness = fixture(new Set([costScopeKey(scope)]));
    const dispose = createCostIndexScheduler(harness.dependencies);
    for (const eventType of [
      'worktree_chat',
      'standalone_chat',
      'app_advisor',
    ] as const) {
      harness.dispatch(event({ eventType, status: 'interrupted' }));
    }
    // The startup pass, then one refresh per ended turn, with no wait.
    expect(harness.dependencies.refreshInternal).toHaveBeenCalledTimes(4);
    expect(harness.dependencies.refreshInternal).toHaveBeenLastCalledWith(
      'turn',
      scope,
    );
    dispose();
  });

  it('debounces the end of a delegation or a subagent for a few seconds', async () => {
    const harness = fixture(new Set([costScopeKey(scope)]));
    const dispose = createCostIndexScheduler(harness.dependencies);
    harness.dispatch(event({ eventType: 'managed_delegation' }));
    await jest.advanceTimersByTimeAsync(2_000);
    // A subagent of the still-running turn ends: the wait starts again.
    harness.dispatch(event({ status: 'running', cause: 'subagent_ended' }));
    await jest.advanceTimersByTimeAsync(2_999);
    expect(harness.dependencies.refreshInternal).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(harness.dependencies.refreshInternal).toHaveBeenCalledTimes(2);
    expect(harness.dependencies.refreshInternal).toHaveBeenLastCalledWith(
      'turn',
      scope,
    );
    dispose();
  });

  it('refreshes once when the turn ends while a debounce is pending', async () => {
    const harness = fixture(new Set([costScopeKey(scope)]));
    const dispose = createCostIndexScheduler(harness.dependencies);
    harness.dispatch(event({ eventType: 'managed_delegation' }));
    harness.dispatch(event());
    expect(harness.dependencies.refreshInternal).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(harness.dependencies.refreshInternal).toHaveBeenCalledTimes(2);
    dispose();
  });

  it('never postpones a pending refresh for slower background work', async () => {
    const harness = fixture(new Set([costScopeKey(scope)]));
    const dispose = createCostIndexScheduler(harness.dependencies);
    harness.dispatch(event({ eventType: 'managed_delegation' }));
    harness.dispatch(event({ eventType: 'worktree_summary' }));
    await jest.advanceTimersByTimeAsync(3_000);
    expect(harness.dependencies.refreshInternal).toHaveBeenCalledTimes(2);
    dispose();
  });

  it('marks an unwatched scope stale instead of refreshing it', async () => {
    const harness = fixture();
    const dispose = createCostIndexScheduler(harness.dependencies);
    harness.dispatch(event());
    harness.dispatch(event({ eventType: 'managed_delegation' }));
    harness.dispatch(event({ status: 'running' }));
    await jest.advanceTimersByTimeAsync(30_000);
    expect(harness.dependencies.refreshInternal).toHaveBeenCalledTimes(1);
    expect(harness.staleScopes).toEqual([scope, scope]);
    dispose();
  });

  it('debounces other finished work per watched scope for 30 seconds and ignores unwatched scopes', async () => {
    const harness = fixture(new Set([costScopeKey(scope)]));
    const dispose = createCostIndexScheduler(harness.dependencies);
    harness.dispatch(event({ eventType: 'worktree_summary' }));
    await jest.advanceTimersByTimeAsync(20_000);
    harness.dispatch(event({ eventType: 'pipeline_agent_turn' }));
    await jest.advanceTimersByTimeAsync(9_999);
    expect(harness.dependencies.refreshInternal).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(harness.dependencies.refreshInternal).toHaveBeenLastCalledWith(
      'turn',
      scope,
    );

    harness.dispatch(
      event({ eventType: 'worktree_summary', worktreeId: 'unwatched-entry' }),
    );
    await jest.advanceTimersByTimeAsync(30_000);
    expect(harness.dependencies.refreshInternal).toHaveBeenCalledTimes(2);
    dispose();
  });

  it('does not refresh a watched scope for unfinished audit updates', async () => {
    const harness = fixture(new Set([costScopeKey(scope)]));
    const dispose = createCostIndexScheduler(harness.dependencies);
    harness.dispatch(event({ status: 'running' }));
    await jest.advanceTimersByTimeAsync(30_000);
    expect(harness.dependencies.refreshInternal).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('rechecks watches when a debounce fires and cancels pending work on disposal', async () => {
    const harness = fixture(new Set([costScopeKey(scope)]));
    const dispose = createCostIndexScheduler(harness.dependencies);
    harness.dispatch(event({ eventType: 'managed_delegation' }));
    harness.watchedScopes.clear();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(harness.dependencies.refreshInternal).toHaveBeenCalledTimes(1);

    harness.watchedScopes.add(costScopeKey(scope));
    harness.dispatch(event({ eventType: 'managed_delegation' }));
    dispose();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(harness.dependencies.refreshInternal).toHaveBeenCalledTimes(1);
  });

  it('checks only for audit stat growth every ten minutes before running idle refresh', async () => {
    const harness = fixture();
    const growth = harness.dependencies.hasAuditGrowth as jest.Mock<
      Promise<boolean>
    >;
    growth.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const dispose = createCostIndexScheduler(harness.dependencies);

    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(harness.dependencies.hasAuditGrowth).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.refreshInternal).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(harness.dependencies.hasAuditGrowth).toHaveBeenCalledTimes(2);
    expect(harness.dependencies.refreshInternal).toHaveBeenLastCalledWith(
      'idle',
      undefined,
    );
    dispose();
  });
});
