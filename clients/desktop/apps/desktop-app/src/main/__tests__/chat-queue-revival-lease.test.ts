import type {
  ChatQueueTarget,
  ChatSendMessageRequest,
  ChatQueueUpdatedEvent,
} from '@canopy/desktop-shared/types';
import {
  ChatQueueService,
  type ChatQueueRevivalLease,
  type ChatQueueServiceDependencies,
} from '../services/chat-queue-service';

interface TestHarness {
  readonly service: ChatQueueService;
  readonly dispatched: string[];
  readonly dispatchStarted: Promise<void>;
  readonly drainStarted: Promise<void>;
  setActiveProviderTurn(active: boolean): void;
  setDispatchImpl(impl: ((rootId: string) => Promise<void>) | undefined): void;
  setDrainEventsImpl(impl: (() => Promise<void>) | undefined): void;
  markPreparationCancelled(): void;
}

const target = (): ChatQueueTarget => ({
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
});

function request(userMessageId: string): ChatSendMessageRequest {
  return {
    ...target(),
    userMessageId,
    text: `Message ${userMessageId}`,
  };
}

let serviceUnderTest: ChatQueueService | undefined;

function createHarness(): TestHarness {
  let activeProviderTurn = false;
  let dispatchImpl: ((rootId: string) => Promise<void>) | undefined;
  let drainEventsImpl: (() => Promise<void>) | undefined;
  let preparationCancelled = false;
  let nextId = 0;
  let resolveDispatchStarted: (() => void) | undefined;
  let resolveDrainStarted: (() => void) | undefined;
  const dispatchStarted = new Promise<void>((resolve) => {
    resolveDispatchStarted = resolve;
  });
  const drainStarted = new Promise<void>((resolve) => {
    resolveDrainStarted = resolve;
  });
  const dispatched: string[] = [];
  const broadcasts: ChatQueueUpdatedEvent[] = [];
  const dependencies: ChatQueueServiceDependencies = {
    dispatch: async (sendRequest): Promise<void> => {
      dispatched.push(sendRequest.userMessageId);
      activeProviderTurn = true;
      resolveDispatchStarted?.();
      await dispatchImpl?.(sendRequest.userMessageId);
    },
    beginTurnPreparation: () => ({
      get cancelled(): boolean {
        return preparationCancelled;
      },
      finish: (): void => undefined,
    }),
    cancel: (): Promise<void> => {
      activeProviderTurn = false;
      return Promise.resolve();
    },
    settleCancelledTurn: (): void => undefined,
    hasActiveProviderTurn: (): boolean => activeProviderTurn,
    hasPendingProviderContinuation: (): boolean => false,
    drainProviderEvents: async (): Promise<void> => {
      resolveDrainStarted?.();
      await drainEventsImpl?.();
    },
    persistRuntime: (): void => undefined,
    broadcast: (event): void => {
      broadcasts.push(event);
    },
    createId: (): string => `queue-${++nextId}`,
    now: Date.now,
    schedule: (callback, delayMs): ReturnType<typeof setTimeout> =>
      setTimeout(callback, delayMs),
  };
  const service = new ChatQueueService(dependencies);
  serviceUnderTest = service;
  return {
    service,
    dispatched,
    dispatchStarted,
    drainStarted,
    setActiveProviderTurn: (active): void => {
      activeProviderTurn = active;
    },
    setDispatchImpl: (impl): void => {
      dispatchImpl = impl;
    },
    setDrainEventsImpl: (impl): void => {
      drainEventsImpl = impl;
    },
    markPreparationCancelled: (): void => {
      preparationCancelled = true;
    },
  };
}

async function waitWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(new Error(`Operation did not finish within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

afterEach((): void => {
  serviceUnderTest?.resetForTests();
  serviceUnderTest = undefined;
});

describe('ChatQueueService revival leases', () => {
  it('accepts only a free, idless, or same-root gate and supersedes an older same-id lease', async () => {
    const harness = createHarness();
    await harness.service.submit(request('root'), 'desktop');
    const service = harness.service;

    const first = service.acceptTurnRevival(target(), 'root');
    expect(first.accepted).toBe(true);
    if (first.accepted) {
      const firstLease: ChatQueueRevivalLease = first.lease;
      expect(firstLease.rootId).toBe('root');
    }
    expect(service.acceptTurnRevival(target(), 'other-root')).toEqual({
      accepted: false,
    });

    const second = service.acceptTurnRevival(target(), 'root');
    expect(second.accepted).toBe(true);
    if (first.accepted) {
      expect(service.confirmTurnRevival(target(), first.lease)).toBe(false);
    }
    if (!first.accepted || !second.accepted) return;
    expect(second.lease.epoch).toBeGreaterThan(first.lease.epoch);
    expect(service.rollbackTurnRevival(target(), first.lease)).toBe(false);
    expect(harness.service.isTurnActive(target())).toBe(true);
  });

  it('adopts an active provider gate that has no known root', async () => {
    const harness = createHarness();
    harness.setActiveProviderTurn(true);
    await harness.service.submit(request('queued'), 'desktop');

    const service = harness.service;
    const accepted = service.acceptTurnRevival(target(), 'adopted-root');

    expect(accepted.accepted).toBe(true);
    expect(harness.service.isTurnActive(target())).toBe(true);
    if (!accepted.accepted) return;
    expect(service.confirmTurnRevival(target(), accepted.lease)).toBe(true);
  });

  it('rearms an accepted lease after its own root terminal before canonical confirmation', async () => {
    const harness = createHarness();
    await harness.service.submit(request('root'), 'desktop');
    const service = harness.service;
    const accepted = service.acceptTurnRevival(target(), 'root');
    expect(accepted.accepted).toBe(true);
    if (!accepted.accepted) return;

    harness.setActiveProviderTurn(false);
    harness.service.onTurnTerminal(target(), 'complete', 'root');
    expect(harness.service.isTurnActive(target())).toBe(false);
    expect(service.rollbackTurnRevival(target(), accepted.lease)).toBe(false);
    expect(harness.service.isTurnActive(target())).toBe(false);
    expect(service.confirmTurnRevival(target(), accepted.lease)).toBe(true);
    expect(harness.service.isTurnActive(target())).toBe(true);
  });

  it('rejects a distinct late terminal as a release owner, and rejects an untagged Stop release', async () => {
    const harness = createHarness();
    await harness.service.submit(request('root'), 'desktop');
    const service = harness.service;
    const accepted = service.acceptTurnRevival(target(), 'root');
    expect(accepted.accepted).toBe(true);
    if (!accepted.accepted) return;

    harness.setActiveProviderTurn(false);
    harness.service.onTurnTerminal(target(), 'complete', 'other-root');
    expect(harness.service.isTurnActive(target())).toBe(true);
    expect(service.confirmTurnRevival(target(), accepted.lease)).toBe(true);

    harness.service.onTurnTerminal(target(), 'cancelled');
    expect(service.confirmTurnRevival(target(), accepted.lease)).toBe(false);
    expect(service.rollbackTurnRevival(target(), accepted.lease)).toBe(false);
  });

  it('invalidates confirmation and rollback after pending input operations are invalidated', async () => {
    const harness = createHarness();
    await harness.service.submit(request('root'), 'desktop');
    const service = harness.service;
    const accepted = service.acceptTurnRevival(target(), 'root');
    expect(accepted.accepted).toBe(true);
    if (!accepted.accepted) return;

    harness.service.invalidatePendingInputOperations(target());

    expect(service.confirmTurnRevival(target(), accepted.lease)).toBe(false);
    expect(service.rollbackTurnRevival(target(), accepted.lease)).toBe(false);
    expect(harness.service.isTurnActive(target())).toBe(true);
  });

  it('does not roll back while dispatch is in flight even after its reservation was released', async () => {
    const harness = createHarness();
    let releaseDispatch: (() => void) | undefined;
    harness.setDispatchImpl(
      () =>
        new Promise<void>((resolve) => {
          releaseDispatch = resolve;
        }),
    );
    const submitting = harness.service.submit(request('root'), 'desktop');
    await harness.dispatchStarted;
    const service = harness.service;

    try {
      harness.service.onTurnTerminal(target(), 'complete', 'root');
      const accepted = service.acceptTurnRevival(target(), 'root');
      expect(accepted.accepted).toBe(true);
      if (!accepted.accepted) return;
      expect(service.rollbackTurnRevival(target(), accepted.lease)).toBe(false);
    } finally {
      releaseDispatch?.();
      await submitting;
    }
  });

  it('does not roll back while a Stop reservation owns the gate', async () => {
    const harness = createHarness();
    let releaseBarrier: (() => void) | undefined;
    harness.setDrainEventsImpl(
      () =>
        new Promise<void>((resolve) => {
          releaseBarrier = resolve;
        }),
    );
    const submitting = harness.service.submit(request('root'), 'desktop');
    await harness.drainStarted;

    try {
      harness.markPreparationCancelled();
      releaseBarrier?.();
      await submitting;
      const service = harness.service;
      const accepted = service.acceptTurnRevival(target(), 'root');
      expect(accepted.accepted).toBe(true);
      if (!accepted.accepted) return;
      expect(service.rollbackTurnRevival(target(), accepted.lease)).toBe(false);
    } finally {
      releaseBarrier?.();
      await submitting;
    }
  });

  it('releases an owned lease and drains the existing queue within two seconds', async () => {
    const harness = createHarness();
    await harness.service.submit(request('root'), 'desktop');
    let queuedDispatch: (() => void) | undefined;
    const queuedWasDispatched = new Promise<void>((resolve) => {
      queuedDispatch = resolve;
    });
    harness.setDispatchImpl((rootId) => {
      if (rootId === 'queued') queuedDispatch?.();
      return Promise.resolve();
    });
    await harness.service.submit(request('queued'), 'portal');
    const service = harness.service;
    const accepted = service.acceptTurnRevival(target(), 'root');
    expect(accepted.accepted).toBe(true);
    if (!accepted.accepted) return;

    harness.setActiveProviderTurn(false);
    expect(service.rollbackTurnRevival(target(), accepted.lease)).toBe(true);
    await waitWithin(queuedWasDispatched, 2_000);

    expect(harness.dispatched).toEqual(['root', 'queued']);
  });

  it('returns an inert no-entry lease without allocating an entry and confirms true while absent', () => {
    const harness = createHarness();
    const service = harness.service;
    const accepted = service.acceptTurnRevival(target(), 'root');

    expect(accepted.accepted).toBe(true);
    if (!accepted.accepted) return;
    expect(accepted.lease).toEqual({ rootId: 'root', epoch: -1 });
    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1'),
    ).toEqual([]);
    expect(service.confirmTurnRevival(target(), accepted.lease)).toBe(true);
    expect(service.rollbackTurnRevival(target(), accepted.lease)).toBe(false);
    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1'),
    ).toEqual([]);
  });

  it('supersedes an earlier inert lease when a newer revival is accepted while absent', () => {
    const harness = createHarness();
    const service = harness.service;
    const earlier = service.acceptTurnRevival(target(), 'root');
    const newer = service.acceptTurnRevival(target(), 'root');

    expect(earlier.accepted).toBe(true);
    expect(newer.accepted).toBe(true);
    if (!earlier.accepted || !newer.accepted) return;
    expect(service.confirmTurnRevival(target(), earlier.lease)).toBe(false);
    expect(service.confirmTurnRevival(target(), newer.lease)).toBe(true);
    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1'),
    ).toEqual([]);
  });

  it('confirms an inert lease against a later idless active gate and adopts it for its root', async () => {
    // A send during the autonomous turn adopts the provider's activity without
    // a root; that is this turn, not a newer owner, as acceptance treats it.
    const harness = createHarness();
    const service = harness.service;
    const accepted = service.acceptTurnRevival(target(), 'root');
    expect(accepted.accepted).toBe(true);
    if (!accepted.accepted) return;

    harness.setActiveProviderTurn(true);
    await harness.service.submit(request('queued'), 'desktop');

    expect(service.confirmTurnRevival(target(), accepted.lease)).toBe(true);
    // With the provider idle, only the gate (now owned by `root`) keeps the turn.
    harness.setActiveProviderTurn(false);
    expect(harness.service.isTurnActive(target())).toBe(true);
    service.onTurnTerminal(target(), 'complete', 'other-root');
    expect(harness.service.isTurnActive(target())).toBe(true);
    service.onTurnTerminal(target(), 'complete', 'root');
    expect(harness.service.isTurnActive(target())).toBe(false);
  });

  it('does not let an inert lease cross entry deletion and same-root recreation', async () => {
    const harness = createHarness();
    const service = harness.service;
    const accepted = service.acceptTurnRevival(target(), 'root');
    expect(accepted.accepted).toBe(true);
    if (!accepted.accepted) return;

    await harness.service.submit(request('root'), 'desktop');
    expect(service.confirmTurnRevival(target(), accepted.lease)).toBe(true);
    harness.service.beginWorktreeDeletion('project-1', 'worktree-1').commit();
    await harness.service.submit(request('root'), 'desktop');

    expect(service.confirmTurnRevival(target(), accepted.lease)).toBe(false);
    expect(harness.service.isTurnActive(target())).toBe(true);
  });

  it('does not let a normal lease cross entry deletion and same-root recreation', async () => {
    const harness = createHarness();
    await harness.service.submit(request('root'), 'desktop');
    const service = harness.service;
    const accepted = service.acceptTurnRevival(target(), 'root');
    expect(accepted.accepted).toBe(true);
    if (!accepted.accepted) return;

    harness.service.beginWorktreeDeletion('project-1', 'worktree-1').commit();
    await harness.service.submit(request('root'), 'desktop');

    expect(service.confirmTurnRevival(target(), accepted.lease)).toBe(false);
    expect(service.rollbackTurnRevival(target(), accepted.lease)).toBe(false);
    expect(harness.service.isTurnActive(target())).toBe(true);
  });

  it('confirms an inert lease against a later free entry without changing its epoch', async () => {
    const harness = createHarness();
    const service = harness.service;
    const accepted = service.acceptTurnRevival(target(), 'root');
    expect(accepted.accepted).toBe(true);
    if (!accepted.accepted) return;

    await harness.service.pauseForAuthentication(target(), 'auth-attempt');

    expect(service.confirmTurnRevival(target(), accepted.lease)).toBe(true);
    expect(harness.service.isTurnActive(target())).toBe(true);
    expect(service.rollbackTurnRevival(target(), accepted.lease)).toBe(false);
  });

  it('confirms an inert lease when the later entry is already owned by its root', async () => {
    const harness = createHarness();
    const service = harness.service;
    const accepted = service.acceptTurnRevival(target(), 'root');
    expect(accepted.accepted).toBe(true);
    if (!accepted.accepted) return;

    await harness.service.submit(request('root'), 'desktop');

    expect(service.confirmTurnRevival(target(), accepted.lease)).toBe(true);
    expect(harness.service.isTurnActive(target())).toBe(true);
  });

  it('refuses an inert lease when a different root owns the later entry', async () => {
    const harness = createHarness();
    const service = harness.service;
    const accepted = service.acceptTurnRevival(target(), 'root');
    expect(accepted.accepted).toBe(true);
    if (!accepted.accepted) return;

    await harness.service.submit(request('other-root'), 'desktop');

    expect(service.confirmTurnRevival(target(), accepted.lease)).toBe(false);
    expect(harness.service.isTurnActive(target())).toBe(true);
  });

  it('refuses an inert lease after a newer input operation or revival', async () => {
    const harness = createHarness();
    const service = harness.service;
    const accepted = service.acceptTurnRevival(target(), 'root');
    expect(accepted.accepted).toBe(true);
    if (!accepted.accepted) return;

    await harness.service.pauseForAuthentication(target(), 'auth-attempt');
    harness.service.invalidatePendingInputOperations(target());
    expect(service.confirmTurnRevival(target(), accepted.lease)).toBe(false);

    const later = service.acceptTurnRevival(target(), 'root');
    expect(later.accepted).toBe(true);
    expect(service.confirmTurnRevival(target(), accepted.lease)).toBe(false);
  });
});
