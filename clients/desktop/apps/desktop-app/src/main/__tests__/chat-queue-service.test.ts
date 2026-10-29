import { WatcherDeliveryHeldError } from '../services/active-chat-input';
import * as senderContext from '../agent-messaging/sender-context';
import type {
  ChatAgentSentInfo,
  ChatQueueOrigin,
  ChatQueueTarget,
  ChatQueueUpdatedEvent,
  ChatSendMessageRequest,
  ChatTabPluginSelections,
  PersistedHostQueuedMessage,
} from '@canopy/desktop-shared/types';
import {
  ChatQueueService,
  type ChatQueuePersistenceMutation,
  type ChatQueueServiceDependencies,
} from '../services/chat-queue-service';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { TurnAuthPreflightBlockedError } from '../lib/auth-preflight-error';
import { AutoModelRoutingApplyError } from '../model-routing/apply-error';
import { AutoModelRoutingInProgressError } from '../model-routing/in-progress-error';
import { getChatStateService } from '../services/chat-state-service';
import {
  isDelegationDeliveryActive,
  retireDelegationDelivery,
} from '../agents/delegation/lifecycle';

jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));
jest.mock('../agents/delegation/lifecycle', () => ({
  retireDelegationDelivery: jest.fn(),
  isDelegationDeliveryActive: jest.fn(),
}));

const mockIsClaudeTuiChatsEnabled = jest.fn(() => false);
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: (): {
    isEnabled: typeof mockIsClaudeTuiChatsEnabled;
  } => ({ isEnabled: mockIsClaudeTuiChatsEnabled }),
}));

const mockReleaseChatDeliveryAuthority = jest.fn(() => Promise.resolve());
jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: (): {
    releaseChatDeliveryAuthority: typeof mockReleaseChatDeliveryAuthority;
  } => ({
    releaseChatDeliveryAuthority: mockReleaseChatDeliveryAuthority,
  }),
}));

const logMainProcessWarnMock = jest.mocked(logMainProcessWarn);
const isDelegationDeliveryActiveMock = jest.mocked(isDelegationDeliveryActive);
const retireDelegationDeliveryMock = jest.mocked(retireDelegationDelivery);

type WatcherSteeringResult =
  | { status: 'fallback' }
  | { status: 'handled'; submitted?: true }
  | { status: 'requeue'; rowId: string; epoch: number };

interface TestHarness {
  ingressIds: Array<string | undefined>;
  steered: ChatSendMessageRequest[];
  setSteerImpl: (
    impl: (() => Promise<WatcherSteeringResult>) | undefined,
  ) => void;
  service: ChatQueueService;
  dispatched: Array<{
    request: ChatSendMessageRequest;
    origin: ChatQueueOrigin;
    fromQueue: boolean;
  }>;
  dispatchedPins: Array<string | undefined>;
  cancelled: ChatQueueTarget[];
  settled: Array<{
    target: ChatQueueTarget;
    turnUserMessageId?: string;
  }>;
  timeline: string[];
  preparations: string[];
  stopPendingPreparations: () => void;
  setWatcherIngressAllowed: (allowed: boolean) => void;
  scheduledDelays: number[];
  broadcasts: ChatQueueUpdatedEvent[];
  setDrainEventsImpl: (impl: (() => Promise<void>) | undefined) => void;
  setDispatchImpl: (impl: (() => Promise<void>) | undefined) => void;
  setCancelImpl: (impl: (() => Promise<void>) | undefined) => void;
  setSettleImpl: (impl: (() => Promise<void>) | undefined) => void;
  setPersistRuntimeImpl: (
    impl: ChatQueueServiceDependencies['persistRuntime'] | undefined,
  ) => void;
  setActiveProviderTurn: (active: boolean) => void;
  setActiveProviderPluginSelections: (
    selections: ChatTabPluginSelections | undefined,
  ) => void;
  setCurrentPluginDefaultsRevision: (revision: number) => void;
  setActiveProviderPluginDefaultsRevision: (
    revision: number | undefined,
  ) => void;
  setPendingProviderContinuation: (pending: boolean) => void;
}

function request(userMessageId: string, text: string): ChatSendMessageRequest {
  return {
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
    userMessageId,
    text,
  };
}

function target(): ChatQueueTarget {
  return {
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
  };
}

describe('queued prompt provenance', () => {
  it.each(['user', 'hook'] as const)(
    'projects %s queue provenance',
    async (initiationSource) => {
      const h = createHarness();
      await h.service.submit(request('root', 'Keep working'), 'desktop');
      h.setActiveProviderTurn(true);
      await h.service.submit(
        { ...request('follow-up', 'Plain text'), initiationSource },
        'desktop',
      );
      expect(
        h.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]?.queue[0],
      ).toMatchObject({
        promptSource: initiationSource === 'hook' ? 'automated' : 'human',
      });
    },
  );
});

function createHarness(): TestHarness {
  const dispatched: TestHarness['dispatched'] = [];
  const dispatchedPins: TestHarness['dispatchedPins'] = [];
  const cancelled: ChatQueueTarget[] = [];
  const settled: TestHarness['settled'] = [];
  const timeline: string[] = [];
  const preparations: string[] = [];
  const livePreparations = new Set<{ cancelled: boolean }>();
  const broadcasts: ChatQueueUpdatedEvent[] = [];
  const scheduledDelays: number[] = [];
  const steered: ChatSendMessageRequest[] = [];
  const ingressIds: Array<string | undefined> = [];
  let steerImpl: (() => Promise<WatcherSteeringResult>) | undefined;
  let id = 0;
  let drainEventsImpl: (() => Promise<void>) | undefined;
  let dispatchImpl: (() => Promise<void>) | undefined;
  let cancelImpl: (() => Promise<void>) | undefined;
  let settleImpl: (() => Promise<void>) | undefined;
  let persistRuntimeImpl:
    | ChatQueueServiceDependencies['persistRuntime']
    | undefined;
  let activeProviderTurn = false;
  let activeProviderPluginSelections: ChatTabPluginSelections | undefined;
  let currentPluginDefaultsRevision = 0;
  let activeProviderPluginDefaultsRevision: number | undefined;
  let pendingProviderContinuation = false;
  let watcherIngressAllowed = true;
  const dependencies: ChatQueueServiceDependencies & {
    drainProviderEvents: (target: ChatQueueTarget) => Promise<void>;
    steerWatcher: (
      request: ChatSendMessageRequest,
      origin: ChatQueueOrigin,
      queuedIds: () => string[],
    ) => Promise<WatcherSteeringResult>;
  } = {
    checkWatcherIngress: (request) => {
      ingressIds.push(request.watcherDeliveryId);
      return Promise.resolve(
        watcherIngressAllowed
          ? { allowed: true }
          : { allowed: false, outcome: 'held', reason: 'owner_boundary' },
      );
    },
    steerWatcher: (request): Promise<WatcherSteeringResult> => {
      steered.push(request);
      return steerImpl?.() ?? Promise.resolve({ status: 'fallback' });
    },
    drainProviderEvents: (): Promise<void> =>
      drainEventsImpl?.() ?? Promise.resolve(),
    dispatch: (queuedRequest, origin, fromQueue, options): Promise<void> => {
      dispatched.push({ request: queuedRequest, origin, fromQueue });
      dispatchedPins.push(options?.requiredAccountProxyConnectionId);
      timeline.push(`dispatch:${queuedRequest.userMessageId}`);
      return dispatchImpl ? dispatchImpl() : Promise.resolve();
    },
    beginTurnPreparation: (): {
      cancelled: boolean;
      finish: () => void;
    } => {
      preparations.push(`begin:${dispatched.length}`);
      const preparation: { cancelled: boolean; finish: () => void } = {
        cancelled: false,
        finish: (): void => {
          livePreparations.delete(preparation);
          preparations.push(`finish:${dispatched.length}`);
        },
      };
      livePreparations.add(preparation);
      return preparation;
    },
    cancel: (queuedTarget): Promise<void> => {
      cancelled.push(queuedTarget);
      timeline.push('cancel');
      return cancelImpl ? cancelImpl() : Promise.resolve();
    },
    settleCancelledTurn: (queuedTarget, turnUserMessageId): Promise<void> => {
      settled.push({
        target: queuedTarget,
        ...(turnUserMessageId ? { turnUserMessageId } : {}),
      });
      timeline.push(`settle:${turnUserMessageId ?? 'untagged'}`);
      return settleImpl ? settleImpl() : Promise.resolve();
    },
    hasActiveProviderTurn: (): boolean => activeProviderTurn,
    getActiveProviderPluginSelections: ():
      | ChatTabPluginSelections
      | undefined => activeProviderPluginSelections,
    getCurrentPluginDefaultsRevision: (): number =>
      currentPluginDefaultsRevision,
    getActiveProviderPluginDefaultsRevision: (): number | undefined =>
      activeProviderPluginDefaultsRevision,
    hasPendingProviderContinuation: (): boolean => pendingProviderContinuation,
    persistRuntime: (...args): void | Promise<void> =>
      persistRuntimeImpl ? persistRuntimeImpl(...args) : undefined,
    broadcast: (event): void => {
      broadcasts.push(event);
    },
    createId: (): string => `queue-${++id}`,
    now: (): number => 1234 + id,
    schedule: (callback, delayMs): ReturnType<typeof setTimeout> => {
      scheduledDelays.push(delayMs);
      return setTimeout(callback, delayMs);
    },
  };
  return {
    service: new ChatQueueService(dependencies),
    setActiveProviderPluginSelections: (selections): void => {
      activeProviderPluginSelections = selections;
    },
    setCurrentPluginDefaultsRevision: (revision): void => {
      currentPluginDefaultsRevision = revision;
    },
    setActiveProviderPluginDefaultsRevision: (revision): void => {
      activeProviderPluginDefaultsRevision = revision;
    },
    steered,
    ingressIds,
    setSteerImpl: (impl): void => {
      steerImpl = impl;
    },
    dispatched,
    dispatchedPins,
    cancelled,
    settled,
    timeline,
    preparations,
    stopPendingPreparations: (): void => {
      livePreparations.forEach((preparation) => {
        preparation.cancelled = true;
      });
    },
    setWatcherIngressAllowed: (allowed): void => {
      watcherIngressAllowed = allowed;
    },
    scheduledDelays,
    broadcasts,
    setDrainEventsImpl: (impl): void => {
      drainEventsImpl = impl;
    },
    setDispatchImpl: (impl): void => {
      dispatchImpl = impl;
    },
    setCancelImpl: (impl): void => {
      cancelImpl = impl;
    },
    setSettleImpl: (impl): void => {
      settleImpl = impl;
    },
    setPersistRuntimeImpl: (impl): void => {
      persistRuntimeImpl = impl;
    },
    setActiveProviderTurn: (active): void => {
      activeProviderTurn = active;
    },
    setPendingProviderContinuation: (pending): void => {
      pendingProviderContinuation = pending;
    },
  };
}

describe('watcher queued delivery ingress', () => {
  beforeEach(() => mockReleaseChatDeliveryAuthority.mockClear());

  it('keeps a refused watcher admission held without releasing its receipt until retry', async () => {
    jest.useFakeTimers();
    const harness = createHarness();
    const persisted: Array<readonly PersistedHostQueuedMessage[]> = [];
    harness.setPersistRuntimeImpl(
      (_target, _ids, _active, _mutation, queue) => {
        persisted.push(queue ?? []);
      },
    );
    harness.setSteerImpl(() => {
      harness.setWatcherIngressAllowed(false);
      return Promise.resolve({ status: 'requeue', rowId: 'watcher', epoch: 0 });
    });
    try {
      await harness.service.submit(
        {
          ...request('watcher', 'Private watcher'),
          watcherFired: { kind: 'Wake' },
          watcherDeliveryId: 'refused-held',
        },
        'desktop',
      );
      expect(harness.dispatched).toEqual([]);
      expect(
        persisted.at(-1)?.map((row) => row.request.watcherDeliveryId),
      ).toEqual(['refused-held']);
      expect(harness.scheduledDelays).toContain(5000);
      expect(mockReleaseChatDeliveryAuthority).not.toHaveBeenCalled();
      harness.setWatcherIngressAllowed(true);
      await jest.advanceTimersByTimeAsync(5001);
      await jest.advanceTimersByTimeAsync(0);
      expect(
        harness.dispatched.map(({ request }) => request.userMessageId),
      ).toEqual(['watcher']);
      expect(mockReleaseChatDeliveryAuthority).toHaveBeenCalledTimes(1);
      expect(mockReleaseChatDeliveryAuthority).toHaveBeenCalledWith(
        'refused-held',
      );
    } finally {
      harness.service.resetForTests();
      jest.useRealTimers();
    }
  });

  it.each(['provider events', 'prior watcher submission'])(
    'holds a watcher revoked while waiting on %s and retries after access returns',
    async (waitOn) => {
      jest.useFakeTimers();
      const harness = createHarness();
      let release: (() => void) | undefined;
      let entered: (() => void) | undefined;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const persisted: Array<readonly PersistedHostQueuedMessage[]> = [];
      harness.setPersistRuntimeImpl(
        (_target, _ids, _active, _mutation, queue) => {
          persisted.push(queue ?? []);
        },
      );
      let prior: Promise<void> | undefined;
      try {
        if (waitOn === 'provider events') {
          harness.setDrainEventsImpl(() => {
            entered?.();
            return blocked;
          });
        } else {
          harness.setSteerImpl(() => {
            entered?.();
            return blocked.then(() => ({ status: 'handled' }));
          });
          prior = harness.service.submit(
            { ...request('prior', 'Prior'), watcherFired: { kind: 'Wake' } },
            'desktop',
          );
        }
        const watcher = {
          ...request('watcher', 'Private watcher'),
          watcherFired: { kind: 'Wake' },
          watcherDeliveryId: 'late-held',
        };
        const submitting = harness.service.submit(watcher, 'desktop');
        await waiting;
        // Let the initial ingress check finish before revoking authority.
        await Promise.resolve();
        harness.setWatcherIngressAllowed(false);
        harness.setSteerImpl(undefined);
        harness.setDrainEventsImpl(undefined);
        release?.();
        await prior;
        await submitting;
        expect(
          harness.steered.filter(
            (row) => row.watcherDeliveryId === 'late-held',
          ),
        ).toEqual([]);
        expect(harness.dispatched).toEqual([]);
        expect(
          harness.service
            .getWorktreeSnapshots('project-1', 'worktree-1')[0]
            ?.queue.map((row) => row.text),
        ).toEqual(['Private watcher']);
        expect(
          persisted.at(-1)?.map((row) => row.request.watcherDeliveryId),
        ).toEqual(['late-held']);
        expect(harness.scheduledDelays).toContain(5000);
        expect(mockReleaseChatDeliveryAuthority).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(0);
        expect(harness.dispatched).toEqual([]);
        harness.setWatcherIngressAllowed(true);
        await jest.advanceTimersByTimeAsync(5001);
        await jest.advanceTimersByTimeAsync(0);
        expect(
          harness.dispatched.map(({ request }) => request.userMessageId),
        ).toEqual(['watcher']);
        expect(mockReleaseChatDeliveryAuthority).toHaveBeenCalledWith(
          'late-held',
        );
      } finally {
        release?.();
        harness.service.resetForTests();
        jest.useRealTimers();
      }
    },
  );

  it.each(['direct', 'queued'])(
    'holds %s watcher dispatch when access changes during persistence',
    async (path) => {
      jest.useFakeTimers();
      const harness = createHarness();
      let entered: (() => void) | undefined;
      let release: (() => void) | undefined;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const watcher = {
        ...request('watcher', 'Private watcher'),
        watcherFired: { kind: 'Wake' },
        watcherDeliveryId: 'persist-held',
      };
      try {
        if (path === 'queued') {
          await harness.service.submit(request('active', 'Run'), 'desktop');
          await harness.service.submit(watcher, 'desktop');
        }
        harness.setPersistRuntimeImpl((_target, ids, active) => {
          if (active && ids.length === 0) {
            entered?.();
            return blocked;
          }
        });
        let dispatching: Promise<void>;
        if (path === 'queued') {
          harness.service.onTurnTerminal(target(), 'complete', 'active');
          dispatching = jest.advanceTimersByTimeAsync(0);
        } else dispatching = harness.service.submit(watcher, 'desktop');
        await waiting;
        harness.setWatcherIngressAllowed(false);
        release?.();
        await dispatching;
        expect(
          harness.dispatched.filter(({ request }) => request.watcherDeliveryId),
        ).toEqual([]);
        expect(
          harness.service
            .getWorktreeSnapshots('project-1', 'worktree-1')[0]
            ?.queue.map((row) => row.text),
        ).toEqual(['Private watcher']);
        expect(harness.scheduledDelays).toContain(5000);
        expect(mockReleaseChatDeliveryAuthority).not.toHaveBeenCalled();
        harness.setWatcherIngressAllowed(true);
        await jest.advanceTimersByTimeAsync(5001);
        await jest.advanceTimersByTimeAsync(0);
        expect(
          harness.dispatched.filter(({ request }) => request.watcherDeliveryId),
        ).toHaveLength(1);
      } finally {
        release?.();
        harness.service.resetForTests();
        jest.useRealTimers();
      }
    },
  );

  it('preserves each delivery identity when cancelling a watcher edit lock', async () => {
    const harness = createHarness();
    try {
      await harness.service.submit(request('active', 'Run'), 'desktop');
      for (const id of ['one', 'two']) {
        await harness.service.submit(
          {
            ...request(id, id),
            watcherFired: { kind: id },
            watcherDeliveryId: id,
            hiddenContext: {
              kind: 'canopy-watcher-event',
              text: `private-${id}`,
            },
          },
          'desktop',
        );
        if (id === 'one')
          await harness.service.setEditLock(target(), 'queue-1', true);
      }
      await harness.service.setEditLock(target(), 'queue-1', false);
      expect(
        harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]
          .queue,
      ).toHaveLength(2);
      harness.ingressIds.length = 0;
      harness.service.onTurnTerminal(target(), 'complete', 'active');
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      harness.service.onTurnTerminal(target(), 'complete', 'one');
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(harness.ingressIds).toEqual(['one', 'one', 'two', 'two']);
      expect(
        harness.dispatched
          .slice(1)
          .map(({ request }) => request.hiddenContext?.text),
      ).toEqual(['private-one', 'private-two']);
      expect(mockReleaseChatDeliveryAuthority.mock.calls).toEqual([
        ['one'],
        ['two'],
      ]);
    } finally {
      harness.service.resetForTests();
    }
  });

  it('automatically retries queue-only held deliveries after access returns', async () => {
    jest.useFakeTimers();
    const harness = createHarness();
    try {
      await harness.service.submit(request('active', 'Run'), 'desktop');
      await harness.service.submit(
        {
          ...request('watcher', 'Watcher'),
          watcherFired: { kind: 'Wake' },
          watcherDeliveryId: 'held-id',
        },
        'desktop',
      );
      harness.setWatcherIngressAllowed(false);
      harness.service.onTurnTerminal(target(), 'complete', 'active');
      await jest.advanceTimersByTimeAsync(0);
      expect(harness.dispatched).toHaveLength(1);
      expect(mockReleaseChatDeliveryAuthority).not.toHaveBeenCalled();
      harness.setWatcherIngressAllowed(true);
      await jest.advanceTimersByTimeAsync(5001);
      await jest.advanceTimersByTimeAsync(0);
      expect(
        harness.dispatched.map(({ request }) => request.userMessageId),
      ).toEqual(['active', 'watcher']);
      expect(mockReleaseChatDeliveryAuthority).toHaveBeenCalledWith('held-id');
    } finally {
      harness.service.resetForTests();
      jest.useRealTimers();
    }
  });

  it('bounds held retries, resets backoff on an access-change wakeup and never blocks user input', async () => {
    jest.useFakeTimers();
    const harness = createHarness();
    try {
      await harness.service.submit(request('active', 'Run'), 'desktop');
      await harness.service.submit(
        {
          ...request('watcher', 'Watcher'),
          watcherFired: { kind: 'Wake' },
          watcherDeliveryId: 'held-id',
        },
        'desktop',
      );
      harness.setWatcherIngressAllowed(false);
      harness.service.onTurnTerminal(target(), 'complete', 'active');
      await jest.advanceTimersByTimeAsync(0);
      for (const delay of [5000, 10000, 20000, 40000, 60000])
        await jest.advanceTimersByTimeAsync(delay + 2);
      expect(harness.scheduledDelays.filter((delay) => delay >= 5000)).toEqual([
        5000, 10000, 20000, 40000, 60000, 60000,
      ]);
      harness.service.retryHeldWatcherDeliveries();
      await jest.advanceTimersByTimeAsync(1);
      expect(
        harness.scheduledDelays.filter((delay) => delay >= 5000).slice(-1),
      ).toEqual([5000]);
      await harness.service.submit(request('user', 'User message'), 'desktop');
      await jest.advanceTimersByTimeAsync(1);
      expect(
        harness.dispatched.map(({ request }) => request.userMessageId),
      ).toEqual(['active', 'user']);
      expect(mockReleaseChatDeliveryAuthority).not.toHaveBeenCalled();
    } finally {
      harness.service.resetForTests();
      jest.useRealTimers();
    }
  });

  it('releases authority only after durable cancellation, deletion or restored-input consumption', async () => {
    const harness = createHarness();
    try {
      await harness.service.submit(request('active', 'Run'), 'desktop');
      const watcher = (id: string): ChatSendMessageRequest => ({
        ...request(id, id),
        watcherFired: { kind: 'Wake' },
        watcherDeliveryId: id,
      });
      await harness.service.submit(watcher('cancelled'), 'desktop');
      harness.setPersistRuntimeImpl(() => Promise.reject(new Error('disk')));
      await expect(harness.service.cancel(target(), 'queue-1')).rejects.toThrow(
        'disk',
      );
      expect(mockReleaseChatDeliveryAuthority).not.toHaveBeenCalled();
      harness.setPersistRuntimeImpl(undefined);
      await harness.service.cancel(target(), 'queue-1');
      await harness.service.restoreWithdrawnInput(
        watcher('restored'),
        'restored-row',
        undefined,
        0,
      );
      await harness.service.consumeRestoredInput(target(), 'restored-row');
      await harness.service.submit(watcher('deleted'), 'desktop');
      harness.service.beginWorktreeDeletion('project-1', 'worktree-1').commit();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(mockReleaseChatDeliveryAuthority.mock.calls).toEqual([
        ['cancelled'],
        ['restored'],
        ['deleted'],
      ]);
    } finally {
      harness.service.resetForTests();
    }
  });

  it('logs authority-release failure without rejecting a consumed row', async () => {
    const harness = createHarness();
    try {
      await harness.service.submit(request('active', 'Run'), 'desktop');
      await harness.service.submit(
        {
          ...request('watcher', 'Watcher'),
          watcherFired: { kind: 'Wake' },
          watcherDeliveryId: 'failed-release',
        },
        'desktop',
      );
      const error = new Error('release failed');
      mockReleaseChatDeliveryAuthority.mockRejectedValueOnce(error);
      await expect(harness.service.cancel(target(), 'queue-1')).resolves.toBe(
        'applied',
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(logMainProcessWarnMock).toHaveBeenCalledWith(
        expect.stringContaining('release watcher delivery authority'),
        error,
      );
    } finally {
      harness.service.resetForTests();
    }
  });

  it('retains the same queued payload when revocation lands during dispatch preparation', async () => {
    const harness = createHarness();
    await harness.service.submit(request('active', 'Run'), 'desktop');
    const watcher = {
      ...request('watcher', 'Watcher fired'),
      watcherFired: { kind: 'Task completed' },
      watcherDeliveryId: 'delivery-1',
    };
    await harness.service.submit(watcher, 'desktop');
    harness.setDispatchImpl(() =>
      Promise.reject(new WatcherDeliveryHeldError('owner_boundary')),
    );
    harness.service.onTurnTerminal(target(), 'complete', 'active');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(
      harness.service
        .getWorktreeSnapshots('project-1', 'worktree-1')[0]
        ?.queue.map((entry) => entry.text),
    ).toContain('Watcher fired');
    harness.service.resetForTests();
  });
  it('skips a held watcher row for user input and retries only on request', async () => {
    const harness = createHarness();
    await harness.service.submit(request('active', 'Run'), 'desktop');
    await harness.service.submit(
      {
        ...request('watcher', 'Watcher fired'),
        watcherFired: { kind: 'Task completed' },
        watcherDeliveryId: 'delivery-1',
      },
      'desktop',
    );
    await harness.service.submit(request('user', 'User message'), 'desktop');
    harness.setWatcherIngressAllowed(false);
    harness.service.onTurnTerminal(target(), 'complete', 'active');
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    try {
      expect(
        harness.dispatched.map((item) => item.request.userMessageId),
      ).toEqual(['active', 'user']);
      expect(
        harness.service
          .getWorktreeSnapshots('project-1', 'worktree-1')[0]
          ?.queue.map((item) => item.text),
      ).toEqual(['Watcher fired']);
      harness.service.onTurnTerminal(target(), 'complete', 'user');
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(harness.dispatched).toHaveLength(2);
      harness.setWatcherIngressAllowed(true);
      harness.service.retryHeldWatcherDeliveries();
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(
        harness.dispatched.map((item) => item.request.userMessageId),
      ).toEqual(['active', 'user', 'watcher']);
    } finally {
      harness.service.resetForTests();
    }
  });
  it('retains accepted watcher input when access is revoked before drain', async () => {
    const harness = createHarness();
    await harness.service.submit(request('active', 'Run'), 'desktop');
    const watcher = {
      ...request('watcher', 'Watcher fired'),
      watcherFired: { kind: 'Task completed' },
      watcherDeliveryId: 'delivery-1',
    };
    await harness.service.submit(watcher, 'desktop');
    harness.setWatcherIngressAllowed(false);
    harness.service.onTurnTerminal(target(), 'complete', 'active');
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(
      harness.dispatched.map((entry) => entry.request.userMessageId),
    ).toEqual(['active']);
    expect(
      harness.service
        .getWorktreeSnapshots('project-1', 'worktree-1')[0]
        ?.queue.map((entry) => entry.text),
    ).toContain('Watcher fired');
    harness.service.resetForTests();
  });
});

describe('ChatQueueService', () => {
  beforeEach((): void => {
    jest.useFakeTimers();
    logMainProcessWarnMock.mockClear();
    retireDelegationDeliveryMock.mockClear();
    isDelegationDeliveryActiveMock.mockReset().mockReturnValue(true);
  });

  afterEach((): void => {
    jest.useRealTimers();
  });

  it('does not steer a billing-pinned continuation into an unrelated live turn', async () => {
    const harness = createHarness();
    await harness.service.submit(request('active', 'first'), 'desktop');
    await harness.service.submit(
      request('continuation', 'Continue'),
      'portal',
      {
        requiredAccountProxyConnectionId: 'proxy-A',
      },
    );
    const queued = harness.service.getWorktreeSnapshots(
      'project-1',
      'worktree-1',
    )[0]?.queue[0];
    expect(queued?.canSteer).not.toBe(true);
    await expect(
      harness.service.steer(target(), 'queue-1', {
        commandId: 'steer-pinned',
        outcome: 'applied',
        entityId: 'chat-1',
      }),
    ).resolves.toBe('busy');
  });

  it('refuses a malformed persisted billing pin instead of dropping its constraint', () => {
    const harness = createHarness();
    expect(() =>
      harness.service.hydratePersistedInput(
        request('continuation', 'Continue'),
        'queue-1',
        'portal',
        1234,
        undefined,
        '',
      ),
    ).toThrow('billing constraint is invalid');
  });

  it('owns Stop for a direct send from acceptance until the provider hand-off returns', async () => {
    const harness = createHarness();
    let releaseDrain: () => void = () => undefined;
    harness.setDrainEventsImpl(
      () =>
        new Promise<void>((resolve) => {
          releaseDrain = resolve;
        }),
    );
    const submission = harness.service.submit(
      request('first', 'first'),
      'desktop',
    );
    await Promise.resolve();
    // A Stop landing while earlier events settle must reach this send.
    expect(harness.preparations).toEqual(['begin:0']);
    releaseDrain();
    await submission;
    expect(harness.preparations).toEqual(['begin:0', 'finish:1']);
  });

  it('releases the turn gate when Stop lands while a direct send settles earlier events', async () => {
    const harness = createHarness();
    let releaseDrain: () => void = () => undefined;
    harness.setDrainEventsImpl(
      () =>
        new Promise<void>((resolve) => {
          releaseDrain = resolve;
        }),
    );
    const submission = harness.service.submit(
      request('stopped', 'stopped before hand-off'),
      'desktop',
    );
    await Promise.resolve();
    // Stop: cancel pending preparations, then release the (still idle) gate.
    harness.stopPendingPreparations();
    harness.service.onTurnTerminal(target(), 'cancelled');
    releaseDrain();
    await submission;
    expect(harness.dispatched).toEqual([]);

    harness.setDrainEventsImpl(undefined);
    await harness.service.submit(request('next', 'next send'), 'desktop');
    expect(
      harness.dispatched.map((item) => item.request.userMessageId),
    ).toEqual(['next']);
  });

  describe('worktree setup hold', () => {
    const ids = (harness: TestHarness): string[] =>
      harness.dispatched.map((item) => item.request.userMessageId);

    it('queues sends while held and drains them in order once released', async () => {
      const harness = createHarness();
      harness.service.holdForWorktreeSetup(target());
      await harness.service.submit(request('first', 'first'), 'desktop');
      await harness.service.submit(request('second', 'second'), 'desktop');
      await jest.advanceTimersByTimeAsync(1000);

      expect(harness.dispatched).toEqual([]);
      expect(harness.service.holdsUserMessage(target(), 'first')).toBe(true);

      harness.service.releaseWorktreeSetupHold(target());
      await jest.advanceTimersByTimeAsync(0);
      expect(ids(harness)).toEqual(['first']);
      harness.service.onTurnTerminal(target(), 'complete', 'first');
      await jest.advanceTimersByTimeAsync(0);
      expect(ids(harness)).toEqual(['first', 'second']);
    });

    it('keeps queued sends held when a Stop releases the turn gate', async () => {
      const harness = createHarness();
      harness.service.holdForWorktreeSetup(target(), 'held');
      await harness.service.submit(request('queued', 'queued'), 'desktop');
      expect(harness.service.holdsUserMessage(target(), 'held')).toBe(true);

      harness.service.onTurnTerminal(target(), 'cancelled');
      await jest.advanceTimersByTimeAsync(1000);
      harness.service.releaseInputOwnership(target());
      await jest.advanceTimersByTimeAsync(1000);

      expect(harness.dispatched).toEqual([]);
      expect(harness.service.holdsUserMessage(target(), 'held')).toBe(false);
      expect(harness.service.holdsUserMessage(target(), 'queued')).toBe(true);

      harness.service.releaseWorktreeSetupHold(target());
      await jest.advanceTimersByTimeAsync(0);
      expect(ids(harness)).toEqual(['queued']);
    });

    it('dispatches the held turn ahead of the sends queued behind it', async () => {
      const harness = createHarness();
      harness.service.holdForWorktreeSetup(target(), 'held');
      await harness.service.submit(request('queued', 'queued'), 'desktop');

      harness.service.releaseWorktreeSetupHold(target(), {
        firstUserMessageId: 'held',
      });
      await jest.advanceTimersByTimeAsync(1000);
      expect(harness.dispatched).toEqual([]);
      await harness.service.submit(request('held', 'held'), 'desktop');
      await jest.advanceTimersByTimeAsync(1000);
      expect(ids(harness)).toEqual(['held']);

      harness.service.onTurnTerminal(target(), 'complete', 'held');
      await jest.advanceTimersByTimeAsync(0);
      expect(ids(harness)).toEqual(['held', 'queued']);
    });

    it('keeps the billing pin of a held turn dispatched ahead of the queue', async () => {
      const harness = createHarness();
      harness.service.holdForWorktreeSetup(target(), 'held');
      await harness.service.submit(request('queued', 'queued'), 'desktop');
      harness.service.releaseWorktreeSetupHold(target(), {
        firstUserMessageId: 'held',
      });

      await harness.service.submit(request('held', 'held'), 'portal', {
        requiredAccountProxyConnectionId: 'proxy-A',
      });
      await jest.advanceTimersByTimeAsync(1000);

      expect(ids(harness)).toEqual(['held']);
      expect(harness.dispatchedPins).toEqual(['proxy-A']);
    });

    it('keeps the billing pin of a held turn queued behind a live turn', async () => {
      const harness = createHarness();
      await harness.service.submit(request('active', 'active'), 'desktop');
      harness.service.holdForWorktreeSetup(target(), 'held');
      harness.service.releaseWorktreeSetupHold(target(), {
        firstUserMessageId: 'held',
      });

      await harness.service.submit(request('held', 'held'), 'portal', {
        requiredAccountProxyConnectionId: 'proxy-A',
      });
      harness.service.onTurnTerminal(target(), 'complete', 'active');
      await jest.advanceTimersByTimeAsync(1000);

      expect(ids(harness)).toEqual(['active', 'held']);
      expect(harness.dispatchedPins).toEqual([undefined, 'proxy-A']);
    });

    it('releases the held turn gate when the held turn never dispatches', async () => {
      const harness = createHarness();
      harness.service.holdForWorktreeSetup(target(), 'held');
      await harness.service.submit(request('queued', 'queued'), 'desktop');
      harness.service.releaseWorktreeSetupHold(target(), {
        firstUserMessageId: 'held',
      });

      harness.service.releaseWorktreeSetupHold(target());
      await jest.advanceTimersByTimeAsync(0);

      expect(ids(harness)).toEqual(['queued']);
    });

    it('takes the queued sends of a setup that did not finish, persisting their ends with their removal', async () => {
      const harness = createHarness();
      const persisted: Parameters<
        ChatQueueServiceDependencies['persistRuntime']
      >[] = [];
      harness.setPersistRuntimeImpl((...args) => {
        persisted.push(args);
        return Promise.resolve();
      });
      harness.service.holdForWorktreeSetup(target());
      await harness.service.submit(request('first', 'first'), 'desktop');
      await harness.service.submit(request('second', 'second'), 'desktop');

      const taken = await harness.service.takeWorktreeSetupHeldSends(
        target(),
        'failed',
      );
      harness.service.releaseWorktreeSetupHold(target());
      await jest.advanceTimersByTimeAsync(1000);

      expect(taken.map((sent) => sent.userMessageId)).toEqual([
        'first',
        'second',
      ]);
      expect(persisted.at(-1)).toEqual([
        target(),
        [],
        false,
        { type: 'end-setup-held', requests: taken, outcome: 'failed' },
        [],
        undefined,
      ]);
      expect(harness.dispatched).toEqual([]);
      expect(harness.service.holdsUserMessage(target(), 'first')).toBe(false);
    });

    it('keeps the queued sends of a setup that did not finish when their ends cannot persist', async () => {
      const harness = createHarness();
      harness.service.holdForWorktreeSetup(target());
      await harness.service.submit(request('first', 'first'), 'desktop');
      await harness.service.submit(request('second', 'second'), 'desktop');
      harness.setPersistRuntimeImpl((_target, _queued, _active, mutation) =>
        mutation?.type === 'end-setup-held'
          ? Promise.reject(new Error('The disk is full.'))
          : Promise.resolve(),
      );

      await expect(
        harness.service.takeWorktreeSetupHeldSends(target(), 'cancelled'),
      ).rejects.toThrow('The disk is full.');

      expect(harness.service.holdsUserMessage(target(), 'first')).toBe(true);
      expect(harness.service.holdsUserMessage(target(), 'second')).toBe(true);
      expect(harness.dispatched).toEqual([]);
    });

    it('keeps a forced send queued while held', async () => {
      const harness = createHarness();
      harness.service.holdForWorktreeSetup(target());
      await harness.service.submit(request('queued', 'queued'), 'desktop');
      const row = harness.broadcasts.at(-1)?.queue[0];
      if (!row) throw new Error('Expected a queued row');

      await harness.service.force(target(), row.id);
      await jest.advanceTimersByTimeAsync(1000);

      expect(harness.dispatched).toEqual([]);
      expect(harness.service.holdsUserMessage(target(), 'queued')).toBe(true);
    });
  });

  it('holds queued sends while a Stop that cancelled a settling send is unwinding', async () => {
    const harness = createHarness();
    let releaseDrain: () => void = () => undefined;
    harness.setDrainEventsImpl(
      () =>
        new Promise<void>((resolve) => {
          releaseDrain = resolve;
        }),
    );
    const stoppedSend = harness.service.submit(
      request('stopped', 'stopped while settling'),
      'desktop',
    );
    await Promise.resolve();
    const followUp = harness.service.submit(
      request('queued', 'queued follow-up'),
      'desktop',
    );
    // Stop cancels the settling send, but session.cancel() is still pending,
    // so its terminal has not released the gate yet.
    harness.stopPendingPreparations();
    releaseDrain();
    harness.setDrainEventsImpl(undefined);
    await stoppedSend;
    await followUp;
    await jest.advanceTimersByTimeAsync(1000);
    expect(harness.dispatched).toEqual([]);

    harness.service.onTurnTerminal(target(), 'cancelled');
    await jest.advanceTimersByTimeAsync(1000);
    expect(
      harness.dispatched.map((item) => item.request.userMessageId),
    ).toEqual(['queued']);
  });

  it('keeps a Stop-claimed turn gated until that Stop settles it', async () => {
    const harness = createHarness();
    let releaseStoppedClaim: () => void = () => undefined;
    let claimDeferred = false;
    harness.setPersistRuntimeImpl(
      (_target, _queued, turnActive, _mutation, _messages, activeTurnId) => {
        if (claimDeferred || !turnActive || activeTurnId !== 'stopped') {
          return undefined;
        }
        // Hold only the stopped send's claim, so Stop lands mid hand-off.
        claimDeferred = true;
        return new Promise<void>((resolve) => {
          releaseStoppedClaim = resolve;
        });
      },
    );
    const stoppedSend = harness.service.submit(
      request('stopped', 'stopped while claiming'),
      'desktop',
    );
    await jest.advanceTimersByTimeAsync(0);
    await harness.service.submit(
      request('queued', 'queued follow-up'),
      'desktop',
    );
    // Stop cancels the claiming send; its own terminal lands afterwards.
    harness.stopPendingPreparations();
    releaseStoppedClaim();
    await stoppedSend;
    await jest.advanceTimersByTimeAsync(1000);
    // The hand-off inherits the cancel downstream; the queue must not start
    // the follow-up before Stop releases the gate it still owns.
    expect(
      harness.dispatched.map((item) => item.request.userMessageId),
    ).toEqual(['stopped']);

    harness.service.onTurnTerminal(target(), 'cancelled');
    await jest.advanceTimersByTimeAsync(1000);
    expect(
      harness.dispatched.map((item) => item.request.userMessageId),
    ).toEqual(['stopped', 'queued']);
  });

  it('owns Stop for a drained queued send until the provider hand-off returns', async () => {
    const harness = createHarness();
    await harness.service.submit(request('active', 'first'), 'desktop');
    await harness.service.submit(request('queued', 'follow-up'), 'desktop');
    harness.service.onTurnTerminal(target(), 'complete');
    await jest.advanceTimersByTimeAsync(1000);
    expect(
      harness.dispatched.map((item) => item.request.userMessageId),
    ).toEqual(['active', 'queued']);
    expect(harness.preparations).toEqual([
      'begin:0',
      'finish:1',
      'begin:1',
      'finish:2',
    ]);
  });

  it('keeps queued follow-ups stopped after a sign-in interruption until explicit resume', async () => {
    const harness = createHarness();
    await harness.service.submit(request('active', 'first'), 'desktop');
    await harness.service.submit(request('queued', 'follow-up'), 'desktop');
    await harness.service.pauseForAuthentication(target(), 'attempt-1');
    harness.service.onTurnTerminal(target(), 'cancelled');
    await jest.advanceTimersByTimeAsync(1000);
    expect(
      harness.dispatched.map((item) => item.request.userMessageId),
    ).toEqual(['active']);
    harness.service.releaseAuthenticationPause(target(), 'unrelated-attempt');
    harness.service.onTurnTerminal(target(), 'complete');
    await jest.advanceTimersByTimeAsync(1000);
    expect(harness.dispatched).toHaveLength(1);
    harness.service.releaseAuthenticationPause(target(), 'attempt-1');
    harness.service.onTurnTerminal(target(), 'complete');
    await jest.advanceTimersByTimeAsync(1000);
    expect(
      harness.dispatched.map((item) => item.request.userMessageId),
    ).toEqual(['active', 'queued']);
  });

  it('rehydrates the authentication pause and does not drain queued work after restart', async () => {
    const first = createHarness();
    await first.service.submit(request('active', 'first'), 'desktop');
    await first.service.submit(request('queued', 'follow-up'), 'desktop');
    let persisted: PersistedHostQueuedMessage | undefined;
    first.setPersistRuntimeImpl(
      (_target, _ids, _turnActive, _mutation, queuedMessages) => {
        persisted = queuedMessages?.[0];
      },
    );
    await first.service.pauseForAuthentication(target(), 'attempt-1');
    expect(persisted?.authenticationAttemptId).toBe('attempt-1');

    const restarted = createHarness();
    if (!persisted) throw new Error('Expected a persisted queued message');
    restarted.service.hydratePersistedInput(
      persisted.request,
      persisted.id,
      persisted.origin,
      persisted.enqueuedAtMs,
      persisted.authenticationAttemptId,
    );
    restarted.service.releaseInputOwnership(target());
    await jest.runOnlyPendingTimersAsync();

    expect(restarted.dispatched).toHaveLength(0);
  });

  it('lets manual Stop release a restart-hydrated authentication pause', async () => {
    const restarted = createHarness();
    restarted.service.hydratePersistedInput(
      request('queued', 'follow-up'),
      'queue-1',
      'desktop',
      1234,
      'attempt-before-restart',
    );
    restarted.service.releaseInputOwnership(target());
    await jest.runOnlyPendingTimersAsync();
    expect(restarted.dispatched).toHaveLength(0);

    expect(restarted.service.releaseAuthenticationPauseForStop(target())).toBe(
      'attempt-before-restart',
    );
    restarted.service.releaseInputOwnership(target());
    await jest.runOnlyPendingTimersAsync();

    expect(
      restarted.dispatched.map((item) => item.request.userMessageId),
    ).toEqual(['queued']);
  });

  it('reschedules queued work after authentication clears a pending drain timer', async () => {
    const harness = createHarness();
    await harness.service.submit(request('active', 'first'), 'desktop');
    await harness.service.submit(request('queued', 'follow-up'), 'desktop');
    harness.service.onTurnTerminal(target(), 'cancelled');
    await harness.service.pauseForAuthentication(target(), 'attempt-1');

    harness.service.releaseAuthenticationPause(target(), 'attempt-1');
    await harness.service.submit(
      {
        ...request('resume', 'Continue'),
        initiationSource: 'automation',
      },
      'desktop',
    );
    await jest.advanceTimersByTimeAsync(1000);

    expect(
      harness.dispatched.map((item) => item.request.userMessageId),
    ).toEqual(['active', 'queued']);
  });

  it('keeps prior-account queued work paused when the user submits a new message', async () => {
    const harness = createHarness();
    await harness.service.submit(request('active', 'first'), 'desktop');
    await harness.service.submit(request('queued', 'prior account'), 'desktop');
    await harness.service.pauseForAuthentication(target(), 'attempt-1');
    harness.service.onTurnTerminal(target(), 'cancelled');

    await harness.service.submit(request('manual', 'new message'), 'desktop');
    await jest.advanceTimersByTimeAsync(1000);

    expect(
      harness.dispatched.map((item) => item.request.userMessageId),
    ).toEqual(['active']);
    expect(
      harness.service
        .getWorktreeSnapshots('project-1', 'worktree-1')[0]
        .queue.map((row) => row.text),
    ).toEqual(['prior account', 'new message']);
  });

  it('durably restores a dequeued message when authentication pauses dispatch', async () => {
    const harness = createHarness();
    await harness.service.submit(request('active', 'first'), 'desktop');
    await harness.service.submit(request('queued', 'follow-up'), 'desktop');
    const persisted: Array<{ ids: string[]; turnActive: boolean }> = [];
    harness.setPersistRuntimeImpl((_target, ids, turnActive) => {
      persisted.push({ ids: [...ids], turnActive });
      if (turnActive && ids.length === 0)
        void harness.service.pauseForAuthentication(target(), 'attempt-1');
    });

    harness.service.onTurnTerminal(target(), 'complete');
    await jest.runOnlyPendingTimersAsync();

    expect(persisted.at(-1)).toEqual({
      ids: ['queue-1'],
      turnActive: false,
    });
    expect(harness.dispatched).toHaveLength(1);
  });

  it('restores a dequeued message only once when auth-pause persistence fails', async () => {
    const harness = createHarness();
    await harness.service.submit(request('active', 'first'), 'desktop');
    await harness.service.submit(request('queued', 'follow-up'), 'desktop');
    harness.setPersistRuntimeImpl((_target, ids, turnActive) => {
      if (turnActive && ids.length === 0) {
        void harness.service.pauseForAuthentication(target(), 'attempt-1');
        return Promise.resolve();
      }
      if (!turnActive && ids.length === 1) {
        return Promise.reject(new Error('journal unavailable during restore'));
      }
      return Promise.resolve();
    });

    harness.service.onTurnTerminal(target(), 'complete');
    await jest.runOnlyPendingTimersAsync();
    await Promise.resolve();

    expect(
      harness.service
        .getWorktreeSnapshots('project-1', 'worktree-1')[0]
        .queue.map((row) => row.text),
    ).toEqual(['follow-up']);
    expect(harness.dispatched).toHaveLength(1);
  });

  it('durably queues a direct submission when authentication pauses dispatch', async () => {
    const harness = createHarness();
    const persisted: Array<{ ids: string[]; turnActive: boolean }> = [];
    harness.setPersistRuntimeImpl((_target, ids, turnActive) => {
      persisted.push({ ids: [...ids], turnActive });
      if (turnActive && ids.length === 0)
        void harness.service.pauseForAuthentication(target(), 'attempt-1');
    });

    await harness.service.submit(request('message-1', 'hello'), 'desktop');

    expect(persisted.at(-1)).toEqual({
      ids: ['queue-1'],
      turnActive: false,
    });
    expect(harness.dispatched).toHaveLength(0);
  });

  it('releases delivery authority once a watcher delivery is steered', async () => {
    const h = createHarness();
    await h.service.submit(request('root', 'Keep working'), 'desktop');
    h.setActiveProviderTurn(true);
    h.setSteerImpl(() => Promise.resolve({ status: 'handled' }));
    await h.service.submit(
      {
        ...request('watcher-steered', 'Build finished'),
        watcherFired: { kind: 'Chat completion' },
        watcherDeliveryId: 'delivery-steered',
      },
      'desktop',
    );
    expect(mockReleaseChatDeliveryAuthority).toHaveBeenCalledWith(
      'delivery-steered',
    );
  });

  it.each(['claude', 'codex'] as const)(
    'steers a busy %s watcher without interrupting or consuming ordinary queued work',
    async (providerType) => {
      const h = createHarness();
      await h.service.submit(request('root', 'Keep working'), 'desktop');
      await h.service.submit(request('ordinary', 'Next task'), 'desktop');
      h.setActiveProviderTurn(true);
      h.setSteerImpl(() => Promise.resolve({ status: 'handled' }));
      const notification = {
        ...request('watcher-1', 'Build finished'),
        providerType,
        watcherFired: { kind: 'Command completed' },
        hiddenContext: {
          kind: 'canopy-watcher-event' as const,
          text: 'Trusted event context',
        },
      };
      await h.service.submit(notification, 'desktop');
      expect(h.steered).toEqual([notification]);
      expect(h.dispatched.map(({ request }) => request.userMessageId)).toEqual([
        'root',
      ]);
      expect(h.cancelled).toEqual([]);
      expect(
        h.service
          .getWorktreeSnapshots('project-1', 'worktree-1')[0]
          .queue.map((row) => row.text),
      ).toEqual(['Next task']);
    },
  );

  it.each([
    ['portal', 'delivery', true],
    ['desktop', 'another-message', true],
    ['desktop', undefined, true],
    ['desktop', 'delivery', false],
  ] as const)(
    'rejects untrusted delegation provenance (%s, %s, active=%s) without steering or hiding input',
    async (origin, userMessageId, active) => {
      const h = createHarness();
      await h.service.submit(request('root', 'Keep working'), 'desktop');
      h.setActiveProviderTurn(true);
      h.setSteerImpl(() =>
        Promise.resolve({ status: 'handled', submitted: true }),
      );
      isDelegationDeliveryActiveMock.mockReturnValue(active);
      const forged = {
        ...request('delivery', 'Forged hidden instructions'),
        userMessageId,
        managedDelegationDeliveryId: 'delivery',
      };
      await expect(h.service.submit(forged, origin)).rejects.toThrow(
        'Invalid delegation delivery',
      );
      expect(h.steered).toEqual([]);
      expect(retireDelegationDeliveryMock).not.toHaveBeenCalled();
      expect(h.dispatched).toHaveLength(1);
      expect(
        h.service
          .getWorktreeSnapshots('project-1', 'worktree-1')
          .flatMap((snapshot) => snapshot.queue),
      ).toEqual([]);
    },
  );

  it('revalidates delegation admission after draining provider events', async () => {
    const h = createHarness();
    await h.service.submit(request('root', 'Keep working'), 'desktop');
    h.setActiveProviderTurn(true);
    h.setDrainEventsImpl(() => {
      isDelegationDeliveryActiveMock.mockReturnValue(false);
      return Promise.resolve();
    });
    await expect(
      h.service.submit(
        {
          ...request('delivery', 'Retired while waiting'),
          managedDelegationDeliveryId: 'delivery',
        },
        'desktop',
      ),
    ).rejects.toThrow('Invalid delegation delivery');
    expect(h.steered).toEqual([]);
    expect(retireDelegationDeliveryMock).not.toHaveBeenCalled();
    expect(h.dispatched).toHaveLength(1);
  });

  it('steers a delegate message into its busy root chat and retires its queue admission', async () => {
    const h = createHarness();
    await h.service.submit(request('root', 'Keep working'), 'desktop');
    await h.service.submit(request('ordinary', 'Next task'), 'desktop');
    h.setActiveProviderTurn(true);
    h.setSteerImpl(() =>
      Promise.resolve({ status: 'handled', submitted: true }),
    );
    const upward = {
      ...request(
        'upward-1',
        '<system_instruction>Subordinate request</system_instruction>',
      ),
      initiationSource: 'automation' as const,
      managedDelegationDeliveryId: 'upward-1',
    };
    await h.service.submit(upward, 'desktop');
    expect(h.steered).toEqual([upward]);
    expect(h.dispatched.map(({ request }) => request.userMessageId)).toEqual([
      'root',
    ]);
    expect(
      h.service
        .getWorktreeSnapshots('project-1', 'worktree-1')[0]
        .queue.map((row) => row.text),
    ).toEqual(['Next task']);
    expect(retireDelegationDeliveryMock).toHaveBeenCalledWith(
      upward,
      'upward-1',
    );
  });

  it.each([
    ['falls back to the queue', { status: 'fallback' }],
    ['was cancelled before the provider took it', { status: 'handled' }],
  ] as const)(
    'keeps the queue admission of a delegate message that %s',
    async (_outcome, steering) => {
      const h = createHarness();
      await h.service.submit(request('root', 'Keep working'), 'desktop');
      h.setActiveProviderTurn(true);
      h.setSteerImpl(() => Promise.resolve(steering));
      const upward = {
        ...request(
          'upward-1',
          '<system_instruction>Subordinate request</system_instruction>',
        ),
        initiationSource: 'automation' as const,
        managedDelegationDeliveryId: 'upward-1',
      };
      await h.service.submit(upward, 'desktop');
      expect(h.steered).toEqual([upward]);
      expect(retireDelegationDeliveryMock).not.toHaveBeenCalled();

      // Only the fallback is still queued, for its own turn after this one.
      h.setActiveProviderTurn(false);
      h.service.onTurnTerminal(target(), 'complete', 'root');
      await jest.runOnlyPendingTimersAsync();
      expect(h.dispatched.map(({ request }) => request.userMessageId)).toEqual(
        steering.status === 'fallback' ? ['root', 'upward-1'] : ['root'],
      );
    },
  );

  it('serializes overlapping watcher handoffs while retaining ordinary queue ingress', async () => {
    const h = createHarness();
    await h.service.submit(request('root', 'Keep working'), 'desktop');
    let release: (() => void) | undefined;
    let began: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      began = resolve;
    });
    h.setSteerImpl(async () => {
      began?.();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { status: 'handled' };
    });
    const first = h.service.submit(
      { ...request('watcher-1', 'First'), watcherFired: { kind: 'Wakeup' } },
      'desktop',
    );
    await ready;
    expect(h.steered).toHaveLength(1);
    const second = h.service.submit(
      { ...request('watcher-2', 'Second'), watcherFired: { kind: 'Wakeup' } },
      'desktop',
    );
    await h.service.submit(request('ordinary', 'Next task'), 'desktop');
    expect(h.steered).toHaveLength(1);
    h.setSteerImpl(() => Promise.resolve({ status: 'handled' }));
    release?.();
    await Promise.all([first, second]);
    expect(h.steered.map((row) => row.userMessageId)).toEqual([
      'watcher-1',
      'watcher-2',
    ]);
    expect(
      h.service
        .getWorktreeSnapshots('project-1', 'worktree-1')[0]
        .queue.map((row) => row.text),
    ).toEqual(['Next task']);
  });

  it('sends a full watcher message when its turn ended during event reconciliation', async () => {
    const h = createHarness();
    await h.service.submit(request('root', 'Keep working'), 'desktop');
    h.setDrainEventsImpl(() => {
      h.service.onTurnTerminal(target(), 'complete', 'root');
      return Promise.resolve();
    });
    const notification = {
      ...request('watcher-1', 'Build finished'),
      watcherFired: { kind: 'Command completed' },
    };
    await h.service.submit(notification, 'desktop');
    expect(h.dispatched.map(({ request }) => request.userMessageId)).toEqual([
      'root',
      'watcher-1',
    ]);
    expect(h.cancelled).toEqual([]);
  });

  it('queues a fallback watcher behind older work after reconciliation ends the turn', async () => {
    const h = createHarness();
    await h.service.submit(request('root', 'Keep working'), 'desktop');
    await h.service.submit(request('ordinary', 'Next task'), 'desktop');
    h.setDrainEventsImpl(() => {
      h.service.onTurnTerminal(target(), 'complete', 'root');
      return Promise.resolve();
    });

    await h.service.submit(
      {
        ...request('watcher', 'Build finished'),
        watcherFired: { kind: 'Command completed' },
      },
      'desktop',
    );

    expect(h.dispatched.map(({ request }) => request.userMessageId)).toEqual([
      'root',
    ]);
    expect(
      h.service
        .getWorktreeSnapshots('project-1', 'worktree-1')[0]
        .queue.map((row) => row.text),
    ).toEqual(['Next task', 'Build finished']);

    await jest.runOnlyPendingTimersAsync();
    expect(h.dispatched.map(({ request }) => request.userMessageId)).toEqual([
      'root',
      'ordinary',
    ]);

    h.service.onTurnTerminal(target(), 'complete', 'ordinary');
    await jest.runOnlyPendingTimersAsync();
    expect(h.dispatched.map(({ request }) => request.userMessageId)).toEqual([
      'root',
      'ordinary',
      'watcher',
    ]);
  });

  it('does not resurrect a watcher fallback after its worktree was deleted during handoff', async () => {
    const h = createHarness();
    await h.service.submit(request('root', 'Keep working'), 'desktop');
    h.setSteerImpl(() => {
      h.service.beginWorktreeDeletion('project-1', 'worktree-1').commit();
      return Promise.resolve({ status: 'fallback' });
    });
    await expect(
      h.service.submit(
        {
          ...request('watcher', 'Build finished'),
          watcherFired: { kind: 'Wakeup' },
        },
        'desktop',
      ),
    ).rejects.toThrow('Chat is closing');
    expect(h.dispatched.map(({ request }) => request.userMessageId)).toEqual([
      'root',
    ]);
    expect(h.service.getWorktreeSnapshots('project-1', 'worktree-1')).toEqual(
      [],
    );
  });

  it('restores a definitively unsent watcher durably before dispatching its full turn', async () => {
    const h = createHarness();
    await h.service.submit(request('root', 'Keep working'), 'desktop');
    const mutations: unknown[] = [];
    h.setPersistRuntimeImpl((_target, _ids, _active, mutation) => {
      mutations.push(mutation);
    });
    h.setSteerImpl(() => {
      h.service.onTurnTerminal(target(), 'complete', 'root');
      return Promise.resolve({ status: 'requeue', rowId: 'watcher', epoch: 0 });
    });
    await h.service.submit(
      {
        ...request('watcher', 'Build finished'),
        watcherFired: { kind: 'Wakeup' },
      },
      'desktop',
    );
    expect(mutations).toContainEqual(
      expect.objectContaining({
        type: 'restore-input',
        rowId: 'watcher',
        epoch: 0,
      }),
    );
    expect(h.dispatched.map(({ request }) => request.userMessageId)).toEqual([
      'root',
      'watcher',
    ]);
    expect(h.cancelled).toEqual([]);
  });

  it('names the running turn, which a message queued behind it does not change', async () => {
    const harness = createHarness();
    expect(harness.service.runningTurnUserMessageId(target())).toBeUndefined();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    expect(harness.service.runningTurnUserMessageId(target())).toBe(
      'message-1',
    );
    await harness.service.submit(request('message-2', 'second'), 'desktop');
    expect(harness.service.runningTurnUserMessageId(target())).toBe(
      'message-1',
    );
  });

  it('enqueues while active and broadcasts the public payload shape', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'portal');

    expect(harness.dispatched).toHaveLength(1);
    expect(harness.broadcasts[harness.broadcasts.length - 1]).toEqual({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      queue: [
        {
          id: 'queue-1',
          text: 'second',
          origin: 'portal',
          enqueuedAtMs: 1235,
          promptSource: 'human',
          supersedesUserMessageId: 'message-2',
          canSteer: true,
        },
      ],
    });
  });

  it('retains internal completion deliveries in the queue journal without exposing them in UI snapshots', async () => {
    const harness = createHarness();
    harness.setActiveProviderTurn(true);
    const persist = jest.fn();
    harness.setPersistRuntimeImpl(persist);
    await harness.service.submit(
      {
        ...request('delivery', 'hidden evidence'),
        managedDelegationDeliveryId: 'delivery',
      },
      'desktop',
    );
    expect(harness.broadcasts[harness.broadcasts.length - 1]?.queue).toEqual(
      [],
    );
    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]?.queue,
    ).toEqual([]);
    expect(persist).toHaveBeenLastCalledWith(
      expect.anything(),
      ['queue-1'],
      true,
      undefined,
      [
        {
          id: 'queue-1',
          request: {
            ...request('delivery', 'hidden evidence'),
            managedDelegationDeliveryId: 'delivery',
          },
          origin: 'desktop',
          enqueuedAtMs: 1235,
        },
      ],
      undefined,
    );
  });

  it('does not acknowledge an enqueued message before canonical persistence', async () => {
    const harness = createHarness();
    harness.setActiveProviderTurn(true);
    let releasePersistence: (() => void) | undefined;
    harness.setPersistRuntimeImpl(
      () =>
        new Promise<void>((resolve) => {
          releasePersistence = resolve;
        }),
    );

    let acknowledged = false;
    const submitted = harness.service
      .submit(request('message-1', 'persist first'), 'desktop')
      .then(() => {
        acknowledged = true;
      });
    await Promise.resolve();

    expect(acknowledged).toBe(false);
    expect(harness.broadcasts).toEqual([]);
    releasePersistence?.();
    await submitted;
    expect(acknowledged).toBe(true);
    expect(harness.broadcasts).toHaveLength(1);
  });

  it('rejects an enqueued message when canonical persistence fails', async () => {
    const harness = createHarness();
    harness.setActiveProviderTurn(true);
    harness.setPersistRuntimeImpl(() =>
      Promise.reject(new Error('journal unavailable')),
    );

    await expect(
      harness.service.submit(
        request('message-1', 'must be durable'),
        'desktop',
      ),
    ).rejects.toThrow('journal unavailable');
    expect(harness.broadcasts).toEqual([]);
    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1'),
    ).toEqual([]);
  });

  it('rolls back an interrupted-Codex recovery enqueue when persistence fails', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    harness.setPersistRuntimeImpl(() =>
      Promise.reject(new Error('journal unavailable')),
    );

    await expect(
      harness.service.submit(
        {
          ...request('message-2', 'must be durable'),
          providerType: 'codex',
          recoverInterruptedCodexTurn: true,
        },
        'desktop',
      ),
    ).rejects.toThrow('journal unavailable');

    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1'),
    ).toEqual([]);
    expect(
      harness.dispatched.map((item) => item.request.userMessageId),
    ).toEqual(['message-1']);
  });

  it('releases the turn gate when initial canonical persistence fails', async () => {
    const harness = createHarness();
    let persistenceAttempts = 0;
    harness.setPersistRuntimeImpl(() => {
      persistenceAttempts += 1;
      return persistenceAttempts === 1
        ? Promise.reject(new Error('journal unavailable'))
        : Promise.resolve();
    });

    await expect(
      harness.service.submit(
        request('message-1', 'failed before dispatch'),
        'desktop',
      ),
    ).rejects.toThrow('journal unavailable');

    expect(harness.service.isTurnActive(target())).toBe(false);
    await harness.service.submit(
      request('message-2', 'dispatch after recovery'),
      'desktop',
    );
    expect(
      harness.dispatched.map(({ request: sent }) => sent.userMessageId),
    ).toEqual(['message-2']);
  });

  it('releases an id-less pending-input gate after confirmed withdrawal', async () => {
    const harness = createHarness();
    harness.setActiveProviderTurn(true);

    await harness.service.submit(
      request('message-1', 'queued behind pending steering'),
      'desktop',
    );
    expect(harness.service.isTurnActive(target())).toBe(true);
    expect(harness.dispatched).toEqual([]);

    harness.setActiveProviderTurn(false);
    harness.service.releaseInputOwnership(target());
    await jest.runOnlyPendingTimersAsync();

    expect(
      harness.dispatched.map(({ request: sent }) => sent.userMessageId),
    ).toEqual(['message-1']);
  });

  it('retries a queued message after transient dequeue persistence failure', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'desktop');
    let persistenceAttempts = 0;
    harness.setPersistRuntimeImpl(() => {
      persistenceAttempts += 1;
      return persistenceAttempts === 2
        ? Promise.reject(new Error('journal temporarily unavailable'))
        : Promise.resolve();
    });

    harness.service.onTurnTerminal(target(), 'complete');
    await jest.runOnlyPendingTimersAsync();
    expect(harness.dispatched).toHaveLength(1);

    await jest.runOnlyPendingTimersAsync();
    expect(
      harness.dispatched.map(({ request: sent }) => sent.userMessageId),
    ).toEqual(['message-1', 'message-2']);
  });

  it('restores a queued message when scope deletion rejects before provider dispatch', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'desktop');
    const deletionAdmissionError = Object.assign(
      new Error('Chat scope is being deleted'),
      { code: 'CHAT_SCOPE_DELETING' },
    );
    harness.setDispatchImpl(() => Promise.reject(deletionAdmissionError));

    harness.service.onTurnTerminal(target(), 'complete');
    await jest.runOnlyPendingTimersAsync();

    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1'),
    ).toEqual([
      expect.objectContaining({
        queue: [expect.objectContaining({ text: 'second' })],
      }),
    ]);
  });

  it('drops pending worktree messages and cancels their scheduled drain during deletion', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'desktop');
    harness.service.onTurnTerminal(target(), 'error');

    harness.service.beginWorktreeDeletion('project-1', 'worktree-1').commit();
    await jest.runAllTimersAsync();

    expect(
      harness.dispatched.map(({ request: sent }) => sent.userMessageId),
    ).toEqual(['message-1']);
    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1'),
    ).toEqual([]);
  });

  it('restores pending worktree messages when deletion is rolled back', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'desktop');
    harness.service.onTurnTerminal(target(), 'error');

    const deletion = harness.service.beginWorktreeDeletion(
      'project-1',
      'worktree-1',
    );
    await jest.runAllTimersAsync();
    expect(harness.dispatched).toHaveLength(1);

    deletion.rollback();
    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1'),
    ).toEqual([
      expect.objectContaining({
        queue: [expect.objectContaining({ text: 'second' })],
      }),
    ]);
    await jest.runAllTimersAsync();
    expect(
      harness.dispatched.map(({ request: sent }) => sent.userMessageId),
    ).toEqual(['message-1', 'message-2']);
  });

  it('releases a stale active turn and drains pending messages after post-teardown rollback', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'desktop');

    const deletion = harness.service.beginWorktreeDeletion(
      'project-1',
      'worktree-1',
    );
    deletion.rollback({ sessionsDestroyed: true });
    await jest.runAllTimersAsync();

    expect(
      harness.dispatched.map(({ request: sent }) => sent.userMessageId),
    ).toEqual(['message-1', 'message-2']);
  });

  it('does not restore or retry a queued message discarded during an in-flight drain', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'desktop');
    let rejectActivation: ((error: Error) => void) | undefined;
    let activationStarted: (() => void) | undefined;
    const activating = new Promise<void>((resolve) => {
      activationStarted = resolve;
    });
    let blockActivation = true;
    harness.setPersistRuntimeImpl((_target, queuedMessageIds, turnActive) => {
      if (blockActivation && turnActive && queuedMessageIds.length === 0) {
        blockActivation = false;
        activationStarted?.();
        return new Promise<void>((_resolve, reject) => {
          rejectActivation = reject;
        });
      }
      return Promise.resolve();
    });

    harness.service.onTurnTerminal(target(), 'complete');
    await jest.runOnlyPendingTimersAsync();
    await activating;
    harness.service.beginWorktreeDeletion('project-1', 'worktree-1').commit();
    rejectActivation?.(new Error('scope is being deleted'));
    await Promise.resolve();
    await jest.runAllTimersAsync();

    expect(
      harness.dispatched.map(({ request: sent }) => sent.userMessageId),
    ).toEqual(['message-1']);
    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1'),
    ).toEqual([]);
  });

  it('retains a queued message when activation persistence fails before provider dispatch', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'desktop');
    let rejectedActivation = false;
    harness.setPersistRuntimeImpl((_target, queuedMessageIds, turnActive) => {
      if (!rejectedActivation && turnActive && queuedMessageIds.length === 0) {
        rejectedActivation = true;
        return Promise.reject(
          new Error('journal unavailable during queued activation'),
        );
      }
      return Promise.resolve();
    });

    harness.service.onTurnTerminal(target(), 'complete');
    await jest.runOnlyPendingTimersAsync();

    expect(rejectedActivation).toBe(true);
    expect(harness.dispatched).toHaveLength(1);
    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1'),
    ).toEqual([
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        queue: [
          {
            id: 'queue-1',
            text: 'second',
            origin: 'desktop',
            enqueuedAtMs: 1235,
            promptSource: 'human',
            supersedesUserMessageId: 'message-2',
            canSteer: true,
          },
        ],
      },
    ]);

    await jest.runOnlyPendingTimersAsync();
    expect(
      harness.dispatched.map(({ request: sent }) => sent.userMessageId),
    ).toEqual(['message-1', 'message-2']);
  });

  // CAN-1814 review (important). `dispatchDequeued` sets
  // `providerDispatchStarted = true` BEFORE awaiting dispatch, and the
  // send-time auth preflight now lives inside that dispatch. A refusal
  // therefore threw with the flag already true, `restore()` was skipped,
  // `drain()`'s bare `catch {}` swallowed the error, and `broadcastBestEffort`
  // republished a queue without the row — which `broadcast(...)` had ALREADY
  // durably persisted. The user's typed follow-up was durably enqueued and
  // then durably deleted, with no card, no error, and no log.
  it('retains a queued message refused by the auth preflight at drain', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'desktop');
    harness.setDispatchImpl(() =>
      Promise.reject(
        new TurnAuthPreflightBlockedError([
          {
            dependencyClass: 'mcp',
            dependencyId: 'srv-1:cfg-1',
            displayName: 'Prod MCP server',
            failureClass: 'unauthenticated',
            recovery: {
              kind: 'mcp_oauth',
              serverId: 'srv-1',
              configId: 'cfg-1',
            },
          },
        ]),
      ),
    );

    harness.service.onTurnTerminal(target(), 'complete');
    await jest.runOnlyPendingTimersAsync();

    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1'),
    ).toEqual([
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        queue: [
          {
            id: 'queue-1',
            text: 'second',
            origin: 'desktop',
            enqueuedAtMs: 1235,
            promptSource: 'human',
            supersedesUserMessageId: 'message-2',
            canSteer: true,
          },
        ],
      },
    ]);
  });

  it('retains a queued message when Auto cannot apply its routed model at drain', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'desktop');
    harness.setDispatchImpl(() =>
      Promise.reject(new AutoModelRoutingApplyError()),
    );

    harness.service.onTurnTerminal(target(), 'complete');
    await jest.runOnlyPendingTimersAsync();

    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1'),
    ).toEqual([
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        queue: [
          {
            id: 'queue-1',
            text: 'second',
            origin: 'desktop',
            enqueuedAtMs: 1235,
            promptSource: 'human',
            supersedesUserMessageId: 'message-2',
            canSteer: true,
          },
        ],
      },
    ]);
    const dispatchesAfterRefusal = harness.dispatched.length;
    await jest.advanceTimersByTimeAsync(5_000);
    expect(harness.dispatched).toHaveLength(dispatchesAfterRefusal);
  });

  it('retains and retries a queued message after an active Auto routing conflict', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'desktop');
    let attempt = 0;
    harness.setDispatchImpl(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new AutoModelRoutingInProgressError(1_000))
        : Promise.resolve();
    });

    harness.service.onTurnTerminal(target(), 'complete');
    await jest.advanceTimersByTimeAsync(0);

    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1'),
    ).toEqual([
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        queue: [
          {
            id: 'queue-1',
            text: 'second',
            origin: 'desktop',
            enqueuedAtMs: 1235,
            promptSource: 'human',
            supersedesUserMessageId: 'message-2',
            canSteer: true,
          },
        ],
      },
    ]);
    expect(harness.dispatched).toHaveLength(2);
    expect(harness.scheduledDelays).toContain(1_000);

    await jest.runOnlyPendingTimersAsync();
    expect(harness.dispatched).toHaveLength(3);
    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1'),
    ).toEqual([]);
  });

  it('waits for durable queue restoration before retrying an Auto routing conflict', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'desktop');
    let routingConflictRaised = false;
    let restorationAttempts = 0;
    let resolveRestoration: (() => void) | undefined;
    let markRestorationAttempted: (() => void) | undefined;
    const restorationAttempted = new Promise<void>((resolve) => {
      markRestorationAttempted = resolve;
    });
    harness.setPersistRuntimeImpl((_target, queuedMessageIds, turnActive) => {
      if (
        routingConflictRaised &&
        !turnActive &&
        queuedMessageIds.includes('queue-1')
      ) {
        restorationAttempts += 1;
        markRestorationAttempted?.();
        if (restorationAttempts === 1) {
          return Promise.reject(new Error('journal temporarily unavailable'));
        }
        return new Promise<void>((resolve) => {
          resolveRestoration = resolve;
        });
      }
      return Promise.resolve();
    });
    let dispatchAttempt = 0;
    harness.setDispatchImpl(() => {
      dispatchAttempt += 1;
      if (dispatchAttempt === 1) {
        routingConflictRaised = true;
        return Promise.reject(new AutoModelRoutingInProgressError(1_000));
      }
      return Promise.resolve();
    });

    harness.service.onTurnTerminal(target(), 'complete');
    await jest.advanceTimersByTimeAsync(0);
    await restorationAttempted;
    expect(harness.dispatched).toHaveLength(2);

    await jest.advanceTimersByTimeAsync(1_000);
    expect(restorationAttempts).toBe(2);
    expect(harness.dispatched).toHaveLength(2);

    resolveRestoration?.();
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(harness.dispatched).toHaveLength(3);
  });

  // Restoring the row must NOT arm the 500ms transient-failure retry. A
  // refusal is not transient: nothing changes until the user reconnects, so a
  // redrain loop would re-run the preflight's file reads on the main process
  // twice a second for as long as the credential stays broken. The row waits
  // in the visible queue for the next real drain trigger instead.
  it('does not busy-retry a queued message the auth preflight refused', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'desktop');
    harness.setDispatchImpl(() =>
      Promise.reject(
        new TurnAuthPreflightBlockedError([
          {
            dependencyClass: 'mcp',
            dependencyId: 'srv-1:cfg-1',
            displayName: 'Prod MCP server',
            failureClass: 'unauthenticated',
            recovery: {
              kind: 'mcp_oauth',
              serverId: 'srv-1',
              configId: 'cfg-1',
            },
          },
        ]),
      ),
    );

    harness.service.onTurnTerminal(target(), 'complete');
    await jest.runOnlyPendingTimersAsync();
    const afterFirstDrain = harness.dispatched.length;
    await jest.advanceTimersByTimeAsync(5_000);

    expect(harness.dispatched).toHaveLength(afterFirstDrain);
  });

  it('restarts an idle queue when a new send follows an auth-preflight refusal', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'desktop');
    harness.setDispatchImpl(() =>
      Promise.reject(
        new TurnAuthPreflightBlockedError([
          {
            dependencyClass: 'mcp',
            dependencyId: 'srv-1:cfg-1',
            displayName: 'Prod MCP server',
            failureClass: 'unauthenticated',
            recovery: {
              kind: 'mcp_oauth',
              serverId: 'srv-1',
              configId: 'cfg-1',
            },
          },
        ]),
      ),
    );

    harness.service.onTurnTerminal(target(), 'complete');
    await jest.runOnlyPendingTimersAsync();
    harness.setDispatchImpl(() => Promise.resolve());

    await harness.service.submit(request('message-3', 'third'), 'desktop');
    await jest.runOnlyPendingTimersAsync();

    expect(
      harness.dispatched.map(({ request: sent }) => sent.userMessageId),
    ).toEqual(['message-1', 'message-2', 'message-2']);
    expect(
      harness.service
        .getWorktreeSnapshots('project-1', 'worktree-1')[0]
        .queue.map((row) => row.text),
    ).toEqual(['third']);
  });

  it('contains persistence rejection while handling queued dispatch failure', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'desktop');
    let persistenceAttempts = 0;
    harness.setPersistRuntimeImpl(() => {
      persistenceAttempts += 1;
      return persistenceAttempts >= 3
        ? Promise.reject(new Error('journal unavailable during recovery'))
        : Promise.resolve();
    });
    harness.setDispatchImpl(() =>
      Promise.reject(new Error('provider dispatch failed')),
    );

    harness.service.onTurnTerminal(target(), 'complete');
    await jest.runOnlyPendingTimersAsync();
    await Promise.resolve();

    expect(logMainProcessWarnMock).toHaveBeenCalledTimes(1);
  });

  it('projects watcherFired metadata into queued message views', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(
      {
        ...request('message-2', 'Canopy watcher fired.'),
        watcherFired: { kind: 'Pipeline completion (Deploy)' },
      },
      'desktop',
    );

    const lastBroadcast = harness.broadcasts[harness.broadcasts.length - 1];
    expect(lastBroadcast.queue).toEqual([
      {
        id: 'queue-1',
        text: 'Canopy watcher fired.',
        origin: 'desktop',
        enqueuedAtMs: 1235,
        promptSource: 'automated',
        supersedesUserMessageId: 'message-2',
        watcherFired: { kind: 'Pipeline completion (Deploy)' },
      },
    ]);
  });

  it('consolidates adjacent queued watcher deliveries into one visible and hidden payload', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(
      {
        ...request(
          'message-2',
          'Canopy watcher fired.\nDeploy pipeline finished',
        ),
        hiddenContext: {
          kind: 'canopy-watcher-event',
          text: '<system_instruction>deploy details</system_instruction>',
        },
        watcherFired: { kind: 'Pipeline completion (Deploy)' },
      },
      'desktop',
    );
    await harness.service.submit(
      {
        ...request('message-3', 'Canopy watcher fired.\nCI checks completed'),
        hiddenContext: {
          kind: 'canopy-watcher-event',
          text: '<system_instruction>CI details</system_instruction>',
        },
        watcherFired: { kind: 'GitHub workflow run (acme/api)' },
      },
      'desktop',
    );
    await harness.service.submit(
      {
        ...request('message-3', 'Canopy watcher fired.\nCI checks completed'),
        hiddenContext: {
          kind: 'canopy-watcher-event',
          text: '<system_instruction>CI details</system_instruction>',
        },
        watcherFired: { kind: 'GitHub workflow run (acme/api)' },
      },
      'desktop',
    );

    const lastBroadcast = harness.broadcasts[harness.broadcasts.length - 1];
    expect(lastBroadcast.queue).toHaveLength(1);
    expect(lastBroadcast.queue[0]).toEqual(
      expect.objectContaining({
        id: 'queue-1',
        text: 'Deploy pipeline finished\n\nCI checks completed',
        watcherFired: {
          kind: 'Multiple watchers fired (2)',
          combinedWatchers: [
            {
              kind: 'Pipeline completion (Deploy)',
              text: 'Canopy watcher fired.\nDeploy pipeline finished',
            },
            {
              kind: 'GitHub workflow run (acme/api)',
              text: 'Canopy watcher fired.\nCI checks completed',
            },
          ],
        },
      }),
    );

    harness.service.onTurnTerminal(target(), 'complete');
    await jest.runOnlyPendingTimersAsync();

    const combinedRequest = harness.dispatched[1]?.request;
    expect(combinedRequest?.text).toBe(
      'Deploy pipeline finished\n\nCI checks completed',
    );
    expect(combinedRequest?.hiddenContext?.kind).toBe('canopy-watcher-event');
    expect(combinedRequest?.hiddenContext?.text).toContain('deploy details');
    expect(combinedRequest?.hiddenContext?.text).toContain('CI details');
    expect(combinedRequest?.consolidatedWatcherUserMessageIds).toEqual([
      'message-2',
      'message-3',
    ]);
    expect(
      combinedRequest?.hiddenContext?.text.match(/<system_instruction>/g),
    ).toHaveLength(1);
    expect(
      combinedRequest?.hiddenContext?.text.match(/<watcher_message index=/g),
    ).toHaveLength(2);
  });

  it('counts only watcher entries emitted into the combined hidden context', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(
      {
        ...request('message-2', 'first watcher'),
        hiddenContext: {
          kind: 'canopy-watcher-event',
          text: '<system_instruction>first details</system_instruction>',
        },
        watcherFired: { kind: 'Pipeline completion (Deploy)' },
      },
      'desktop',
    );
    await harness.service.submit(
      {
        ...request('message-3', 'second watcher'),
        watcherFired: { kind: 'Hook (CI guard)' },
      },
      'desktop',
    );

    harness.service.onTurnTerminal(target(), 'complete');
    await jest.runOnlyPendingTimersAsync();

    const hiddenText = harness.dispatched[1]?.request.hiddenContext?.text;
    expect(hiddenText).toContain('1 watcher event supplied hidden context');
    expect(hiddenText).toContain('<watcher_messages count="1">');
    expect(hiddenText?.match(/<watcher_message index=/g)).toHaveLength(1);
  });

  it('keeps an edited consolidated watcher row separate from later watchers', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(
      {
        ...request('message-2', 'first watcher'),
        watcherFired: { kind: 'Pipeline completion (Deploy)' },
      },
      'desktop',
    );
    await harness.service.submit(
      {
        ...request('message-3', 'second watcher'),
        watcherFired: { kind: 'Hook (CI guard)' },
      },
      'desktop',
    );

    await expect(
      harness.service.edit({
        ...target(),
        entryId: 'queue-1',
        text: 'edited watcher follow-up',
      }),
    ).resolves.toBe('applied');
    await harness.service.submit(
      {
        ...request('message-4', 'third watcher'),
        watcherFired: { kind: 'Pipeline completion (Release)' },
      },
      'desktop',
    );

    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]?.queue,
    ).toEqual([
      expect.objectContaining({
        id: 'queue-1',
        text: 'edited watcher follow-up',
      }),
      expect.objectContaining({ id: 'queue-3', text: 'third watcher' }),
    ]);
  });

  it('consolidates watcher rows after an edit lock is cancelled', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(
      {
        ...request('message-2', 'first watcher'),
        watcherFired: { kind: 'Pipeline completion (Deploy)' },
      },
      'desktop',
    );
    await harness.service.setEditLock(target(), 'queue-1', true);
    await harness.service.submit(
      {
        ...request('message-3', 'second watcher'),
        watcherFired: { kind: 'Hook (CI guard)' },
      },
      'desktop',
    );

    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]?.queue,
    ).toHaveLength(2);

    await harness.service.setEditLock(target(), 'queue-1', false);

    const queue = harness.service.getWorktreeSnapshots(
      'project-1',
      'worktree-1',
    )[0]?.queue;
    expect(queue).toHaveLength(1);
    expect(queue?.[0]?.id).toBe('queue-1');
    expect(queue?.[0]?.text).toBe('first watcher\n\nsecond watcher');
    expect(queue?.[0]?.watcherFired?.kind).toBe('Multiple watchers fired (2)');
  });

  it('rolls back edit-lock watcher consolidation when persistence fails', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(
      {
        ...request('message-2', 'first watcher'),
        watcherFired: { kind: 'Pipeline completion (Deploy)' },
      },
      'desktop',
    );
    await harness.service.setEditLock(target(), 'queue-1', true);
    await harness.service.submit(
      {
        ...request('message-3', 'second watcher'),
        watcherFired: { kind: 'Hook (CI guard)' },
      },
      'desktop',
    );
    harness.setPersistRuntimeImpl(() =>
      Promise.reject(new Error('journal unavailable')),
    );

    await expect(
      harness.service.setEditLock(target(), 'queue-1', false),
    ).rejects.toThrow('journal unavailable');

    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]?.queue,
    ).toEqual([
      expect.objectContaining({ id: 'queue-1', text: 'first watcher' }),
      expect.objectContaining({ id: 'queue-2', text: 'second watcher' }),
    ]);
  });

  it('keeps watcher rows separate when their plan modes differ', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(
      {
        ...request('message-2', 'mutable watcher'),
        planMode: false,
        watcherFired: { kind: 'Pipeline completion (Deploy)' },
      },
      'desktop',
    );
    await harness.service.submit(
      {
        ...request('message-3', 'read-only watcher'),
        planMode: true,
        watcherFired: { kind: 'Hook (CI guard)' },
      },
      'desktop',
    );

    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]?.queue,
    ).toEqual([
      expect.objectContaining({ id: 'queue-1', text: 'mutable watcher' }),
      expect.objectContaining({ id: 'queue-2', text: 'read-only watcher' }),
    ]);
  });

  it('does not consolidate watcher deliveries across an ordinary queued message', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(
      {
        ...request('message-2', 'first watcher'),
        watcherFired: { kind: 'Pipeline completion (Deploy)' },
      },
      'desktop',
    );
    await harness.service.submit(
      request('message-3', 'typed follow-up'),
      'desktop',
    );
    await harness.service.submit(
      {
        ...request('message-4', 'second watcher'),
        watcherFired: { kind: 'Hook (CI guard)' },
      },
      'desktop',
    );

    expect(
      harness.broadcasts[harness.broadcasts.length - 1]?.queue.map(
        (entry) => entry.text,
      ),
    ).toEqual(['first watcher', 'typed follow-up', 'second watcher']);
  });

  it('restores the original watcher row when consolidation persistence fails', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(
      {
        ...request('message-2', 'first watcher'),
        hiddenContext: {
          kind: 'canopy-watcher-event',
          text: '<system_instruction>first details</system_instruction>',
        },
        watcherFired: { kind: 'Pipeline completion (Deploy)' },
      },
      'desktop',
    );
    let rejectNextPersistence = true;
    harness.setPersistRuntimeImpl(() => {
      if (!rejectNextPersistence) return Promise.resolve();
      rejectNextPersistence = false;
      return Promise.reject(new Error('journal unavailable'));
    });

    await expect(
      harness.service.submit(
        {
          ...request('message-3', 'second watcher'),
          hiddenContext: {
            kind: 'canopy-watcher-event',
            text: '<system_instruction>second details</system_instruction>',
          },
          watcherFired: { kind: 'Hook (CI guard)' },
        },
        'desktop',
      ),
    ).rejects.toThrow('journal unavailable');

    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]?.queue,
    ).toEqual([
      {
        id: 'queue-1',
        text: 'first watcher',
        origin: 'desktop',
        enqueuedAtMs: 1235,
        promptSource: 'automated',
        supersedesUserMessageId: 'message-2',
        watcherFired: { kind: 'Pipeline completion (Deploy)' },
      },
    ]);
  });

  it('refreshes capability selections on prompts that have not dispatched', async () => {
    const harness = createHarness();
    const oldSelections = {
      collectionIds: ['old'],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    const nextSelections = {
      collectionIds: ['next'],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(
      {
        ...request('message-2', 'second'),
        pluginSelections: oldSelections,
        deferredToolsAllowed: true,
      },
      'desktop',
    );

    harness.service.updateQueuedPluginSelections(
      target(),
      nextSelections,
      false,
    );
    harness.service.onTurnTerminal(target(), 'complete');
    await jest.runOnlyPendingTimersAsync();

    expect(harness.dispatched[1]?.request).toEqual(
      expect.objectContaining({
        userMessageId: 'message-2',
        pluginSelections: nextSelections,
        deferredToolsAllowed: false,
      }),
    );
  });

  it('enqueues behind an autonomously resumed provider turn', async () => {
    const harness = createHarness();
    harness.setActiveProviderTurn(true);
    harness.setActiveProviderPluginSelections({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    });

    await harness.service.submit(
      request('message-1', 'follow-up during continuation'),
      'desktop',
    );

    expect(harness.dispatched).toHaveLength(0);
    expect(harness.service.isTurnActive(target())).toBe(true);
    expect(harness.broadcasts[harness.broadcasts.length - 1]).toEqual({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      queue: [
        {
          id: 'queue-1',
          text: 'follow-up during continuation',
          origin: 'desktop',
          enqueuedAtMs: 1235,
          promptSource: 'human',
          supersedesUserMessageId: 'message-1',
          canSteer: true,
        },
      ],
    });

    harness.setActiveProviderTurn(false);
    harness.service.onTurnTerminal(target(), 'complete');
    await jest.runOnlyPendingTimersAsync();

    expect(harness.dispatched.map((item) => item.request.text)).toEqual([
      'follow-up during continuation',
    ]);
  });

  it('immediately dispatches a streaming Codex send when the provider turn is already interrupted', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');

    await harness.service.submit(
      {
        ...request('message-2', 'continue'),
        providerType: 'codex',
        executionHarness: 'codex',
        recoverInterruptedCodexTurn: true,
      },
      'desktop',
    );

    expect(harness.timeline).toEqual([
      'dispatch:message-1',
      'cancel',
      'settle:message-1',
      'dispatch:message-2',
    ]);
    expect(harness.dispatched.map((item) => item.request.text)).toEqual([
      'first',
      'continue',
    ]);
    expect(harness.dispatched[1]?.fromQueue).toBe(true);
    expect(harness.broadcasts[harness.broadcasts.length - 1]?.queue).toEqual(
      [],
    );
  });

  it('does not recover its own send when a pending drain dispatches it during the durable enqueue', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    // The previous turn has already settled and armed a drain timer, but the
    // renderer still saw the tab as streaming when it sent the next message.
    harness.service.onTurnTerminal(target(), 'complete', 'message-1');
    let releaseEnqueue = (): void => undefined;
    let blocked = false;
    harness.setPersistRuntimeImpl((_target, ids, turnActive) => {
      if (blocked || turnActive || ids.length !== 1) return undefined;
      blocked = true;
      return new Promise<void>((resolve) => {
        releaseEnqueue = resolve;
      });
    });

    const recovering = harness.service.submit(
      {
        ...request('message-2', 'continue'),
        providerType: 'codex',
        executionHarness: 'codex',
        recoverInterruptedCodexTurn: true,
      },
      'desktop',
    );
    // The armed drain fires while the recovery row is still being persisted.
    await jest.advanceTimersByTimeAsync(0);
    releaseEnqueue();
    await recovering;
    await jest.runOnlyPendingTimersAsync();

    // Recovery must settle only the superseded turn, never cancel the send it
    // is recovering or close that send's freshly opened turn timer.
    expect(harness.timeline).toEqual([
      'dispatch:message-1',
      'settle:untagged',
      'dispatch:message-2',
    ]);
    expect(harness.cancelled).toEqual([]);
  });

  it('re-arms a skipped drain when the recovery enqueue fails to persist', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'queued'), 'desktop');
    // Settling the first turn arms a drain for the already-queued row.
    harness.service.onTurnTerminal(target(), 'complete', 'message-1');
    let rejectEnqueue = (): void => undefined;
    let blocked = false;
    harness.setPersistRuntimeImpl((_target, ids, turnActive) => {
      if (blocked || turnActive || ids.length !== 2) return undefined;
      blocked = true;
      return new Promise<void>((_resolve, reject) => {
        rejectEnqueue = (): void => reject(new Error('disk full'));
      });
    });

    const recovering = harness.service.submit(
      {
        ...request('message-3', 'continue'),
        providerType: 'codex',
        executionHarness: 'codex',
        recoverInterruptedCodexTurn: true,
      },
      'desktop',
    );
    // The armed drain fires while recovery is reserved and must stand down.
    await jest.advanceTimersByTimeAsync(0);
    expect(harness.timeline).toEqual(['dispatch:message-1']);
    rejectEnqueue();
    await expect(recovering).rejects.toThrow('disk full');
    await jest.runOnlyPendingTimersAsync();

    // The failed recovery must not strand the row the skipped drain owned.
    expect(harness.timeline).toEqual([
      'dispatch:message-1',
      'dispatch:message-2',
    ]);
    expect(harness.cancelled).toEqual([]);
  });

  it('recovers an interrupted Ollama turn running on the Codex harness', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');

    await harness.service.submit(
      {
        ...request('message-2', 'continue'),
        providerType: 'ollama',
        executionHarness: 'codex',
        recoverInterruptedCodexTurn: true,
      },
      'desktop',
    );

    expect(harness.timeline).toEqual([
      'dispatch:message-1',
      'cancel',
      'settle:message-1',
      'dispatch:message-2',
    ]);
  });

  it('keeps a streaming Codex send queued while the provider turn is active', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    harness.setActiveProviderTurn(true);

    await harness.service.submit(
      {
        ...request('message-2', 'continue'),
        providerType: 'codex',
        executionHarness: 'codex',
        recoverInterruptedCodexTurn: true,
      },
      'desktop',
    );

    expect(harness.cancelled).toEqual([]);
    expect(harness.dispatched).toHaveLength(1);
    expect(harness.broadcasts[harness.broadcasts.length - 1]?.queue).toEqual([
      expect.objectContaining({ text: 'continue' }),
    ]);
  });

  it('does not recover a Codex turn paused for user input', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    harness.setPendingProviderContinuation(true);

    await harness.service.submit(
      {
        ...request('message-2', 'follow-up after answer'),
        providerType: 'codex',
        executionHarness: 'codex',
        recoverInterruptedCodexTurn: true,
      },
      'desktop',
    );

    expect(harness.cancelled).toEqual([]);
    expect(harness.settled).toEqual([]);
    expect(harness.dispatched.map((item) => item.request.text)).toEqual([
      'first',
    ]);
    expect(harness.broadcasts[harness.broadcasts.length - 1]?.queue).toEqual([
      expect.objectContaining({ text: 'follow-up after answer' }),
    ]);

    harness.setPendingProviderContinuation(false);
    harness.service.onTurnTerminal(target(), 'complete', 'message-1');
    await jest.runOnlyPendingTimersAsync();

    expect(harness.dispatched.map((item) => item.request.text)).toEqual([
      'first',
      'follow-up after answer',
    ]);
  });

  it('preserves FIFO order when a later Codex send recovers an interrupted turn', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    harness.setActiveProviderTurn(true);
    await harness.service.submit(
      request('message-2', 'already queued'),
      'portal',
    );
    harness.setActiveProviderTurn(false);

    await harness.service.submit(
      {
        ...request('message-3', 'recovering send'),
        providerType: 'codex',
        executionHarness: 'codex',
        recoverInterruptedCodexTurn: true,
      },
      'desktop',
    );

    expect(harness.dispatched.map((item) => item.request.text)).toEqual([
      'first',
      'already queued',
    ]);
    expect(harness.dispatched[1]?.fromQueue).toBe(true);
    expect(harness.broadcasts[harness.broadcasts.length - 1]?.queue).toEqual([
      expect.objectContaining({ text: 'recovering send' }),
    ]);

    harness.service.onTurnTerminal(target(), 'complete', 'message-2');
    await jest.runOnlyPendingTimersAsync();

    expect(harness.dispatched.map((item) => item.request.text)).toEqual([
      'first',
      'already queued',
      'recovering send',
    ]);
  });

  it('does not mistake an in-flight Codex dispatch for an interrupted turn', async () => {
    const harness = createHarness();
    let finishDispatch = (): void => undefined;
    harness.setDispatchImpl(
      () =>
        new Promise<void>((resolve) => {
          finishDispatch = resolve;
        }),
    );

    const firstDispatch = harness.service.submit(
      request('message-1', 'first'),
      'desktop',
    );
    await Promise.resolve();
    // A terminal notification can release turnActive before the dispatch
    // promise itself finishes unwinding. The in-flight marker must still keep
    // the next send serialized.
    harness.service.onTurnTerminal(target(), 'cancelled', 'message-1');
    await harness.service.submit(
      {
        ...request('message-2', 'continue'),
        providerType: 'codex',
        executionHarness: 'codex',
        recoverInterruptedCodexTurn: true,
      },
      'desktop',
    );

    expect(harness.cancelled).toEqual([]);
    expect(harness.dispatched).toHaveLength(1);
    expect(harness.broadcasts[harness.broadcasts.length - 1]?.queue).toEqual([
      expect.objectContaining({ text: 'continue' }),
    ]);

    // Consume the terminal event's scheduled drain while dispatch is still in
    // flight. Dispatch completion must re-kick the drain after clearing its
    // in-flight marker, or the queued send remains stranded.
    await jest.runOnlyPendingTimersAsync();
    expect(harness.dispatched).toHaveLength(1);

    finishDispatch();
    await firstDispatch;
    await jest.runOnlyPendingTimersAsync();

    expect(harness.dispatched.map((item) => item.request.text)).toEqual([
      'first',
      'continue',
    ]);
    expect(harness.dispatched[1]?.fromQueue).toBe(true);
    expect(harness.broadcasts[harness.broadcasts.length - 1]?.queue).toEqual(
      [],
    );
  });

  it('returns worktree snapshots for a race-free hydration pull', async () => {
    const harness = createHarness();
    // Active turn + two queued rows on chat-1.
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'portal');
    await harness.service.submit(request('message-3', 'third'), 'desktop');

    const snapshots = harness.service.getWorktreeSnapshots(
      'project-1',
      'worktree-1',
    );
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      queue: [
        {
          id: 'queue-1',
          text: 'second',
          origin: 'portal',
          enqueuedAtMs: 1235,
          promptSource: 'human',
          supersedesUserMessageId: 'message-2',
          canSteer: true,
        },
        {
          id: 'queue-2',
          text: 'third',
          origin: 'desktop',
          enqueuedAtMs: 1236,
          promptSource: 'human',
          supersedesUserMessageId: 'message-3',
          canSteer: true,
        },
      ],
    });

    // A chat with an empty queue is omitted from the snapshot list.
    const otherWorktree = harness.service.getWorktreeSnapshots(
      'project-1',
      'worktree-2',
    );
    expect(otherWorktree).toEqual([]);
  });

  it('blocks Steer when a queued message adds a skill', async () => {
    const harness = createHarness();
    const original = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    const changed = {
      ...original,
      skillRefs: [{ sourceId: 'local', skillName: 'review' }],
    };
    await harness.service.submit(
      { ...request('message-1', 'first'), pluginSelections: original },
      'desktop',
    );
    await harness.service.submit(
      { ...request('message-2', 'second'), pluginSelections: changed },
      'desktop',
    );

    const queued = harness.service.getWorktreeSnapshots(
      'project-1',
      'worktree-1',
    )[0]?.queue[0];
    expect(queued).toEqual(
      expect.objectContaining({ steerBlockedByCapabilityChange: true }),
    );
    expect(queued).not.toHaveProperty('canSteer');
    expect(
      await harness.service.steer(target(), 'queue-1', {
        commandId: 'steer-1',
        outcome: 'applied',
        entityId: 'chat-1',
      }),
    ).toBe('busy');
    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]?.queue,
    ).toHaveLength(1);
  });

  it('blocks changed selections during an externally revived provider turn', async () => {
    const harness = createHarness();
    const active = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    harness.setActiveProviderPluginSelections(active);
    harness.setActiveProviderTurn(true);
    await harness.service.submit(
      {
        ...request('message-1', 'queued'),
        pluginSelections: {
          ...active,
          skillRefs: [{ sourceId: 'local', skillName: 'review' }],
        },
      },
      'desktop',
    );
    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]
        ?.queue[0],
    ).toEqual(
      expect.objectContaining({ steerBlockedByCapabilityChange: true }),
    );
  });

  it('blocks Steer when global plugin defaults change during the active turn', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'queued'), 'desktop');
    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]
        ?.queue[0],
    ).toEqual(expect.objectContaining({ canSteer: true }));

    harness.setCurrentPluginDefaultsRevision(1);
    harness.service.refreshGlobalPluginDefaults();
    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]
        ?.queue[0],
    ).toEqual(
      expect.objectContaining({ steerBlockedByCapabilityChange: true }),
    );
    expect(harness.broadcasts[harness.broadcasts.length - 1]?.queue[0]).toEqual(
      expect.objectContaining({ steerBlockedByCapabilityChange: true }),
    );
    expect(
      await harness.service.steer(target(), 'queue-1', {
        commandId: 'steer-global-defaults',
        outcome: 'applied',
        entityId: 'chat-1',
      }),
    ).toBe('busy');
  });

  it('blocks Steer when a revived provider session uses older global defaults', async () => {
    const harness = createHarness();
    harness.setActiveProviderTurn(true);
    harness.setActiveProviderPluginSelections({
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    });
    harness.setActiveProviderPluginDefaultsRevision(0);
    harness.setCurrentPluginDefaultsRevision(1);
    await harness.service.submit(request('message-1', 'queued'), 'desktop');
    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]
        ?.queue[0],
    ).toEqual(
      expect.objectContaining({ steerBlockedByCapabilityChange: true }),
    );
  });

  it('refreshes selections when a different provider turn revives the queue', async () => {
    const harness = createHarness();
    const empty = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    const changed = {
      ...empty,
      skillRefs: [{ sourceId: 'local', skillName: 'review' }],
    };
    await harness.service.submit(
      { ...request('message-1', 'first'), pluginSelections: empty },
      'desktop',
    );
    await harness.service.submit(
      { ...request('message-2', 'queued'), pluginSelections: empty },
      'desktop',
    );
    harness.service.onTurnTerminal(target(), 'complete', 'message-1');
    harness.setActiveProviderPluginSelections(changed);
    harness.service.confirmTurnRevived(target(), 'provider-continuation');
    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]
        ?.queue[0],
    ).toEqual(
      expect.objectContaining({ steerBlockedByCapabilityChange: true }),
    );
  });

  it.each<{
    name: string;
    before: ChatTabPluginSelections;
    after: ChatTabPluginSelections;
  }>([
    {
      name: 'removes a plugin',
      before: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [{ marketplaceId: 'market', pluginName: 'tool' }],
        mcpServerRefs: [],
      },
      after: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    },
    {
      name: 'adds an MCP server',
      before: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      after: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [{ serverId: 'server', configId: 'config' }],
      },
    },
    {
      name: 'removes a collection',
      before: {
        collectionIds: ['collection'],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      after: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    },
  ])('blocks Steer when a queued message $name', async ({ before, after }) => {
    const harness = createHarness();
    await harness.service.submit(
      { ...request('message-1', 'first'), pluginSelections: before },
      'desktop',
    );
    await harness.service.submit(
      { ...request('message-2', 'second'), pluginSelections: after },
      'desktop',
    );
    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]
        ?.queue[0],
    ).toEqual(
      expect.objectContaining({ steerBlockedByCapabilityChange: true }),
    );
  });

  it('keeps Steer available when selections only change order', async () => {
    const harness = createHarness();
    await harness.service.submit(
      {
        ...request('message-1', 'first'),
        pluginSelections: {
          collectionIds: ['a', 'b'],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        },
      },
      'desktop',
    );
    await harness.service.submit(
      {
        ...request('message-2', 'second'),
        pluginSelections: {
          collectionIds: ['b', 'a'],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        },
      },
      'desktop',
    );
    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]
        ?.queue[0],
    ).toEqual(expect.objectContaining({ canSteer: true }));
  });

  it('persists the running user-message id while later sends queue', async () => {
    const harness = createHarness();
    const persisted: Array<{
      queuedIds: readonly string[];
      activeId: string | undefined;
    }> = [];
    harness.setPersistRuntimeImpl(
      (
        _target,
        queuedIds,
        _turnActive,
        _mutation,
        _queuedMessages,
        activeId,
      ) => {
        persisted.push({ queuedIds: [...queuedIds], activeId });
      },
    );

    await harness.service.submit(request('message-1', 'first'), 'portal');
    await harness.service.submit(request('message-2', 'second'), 'portal');

    expect(persisted[persisted.length - 1]).toEqual({
      queuedIds: ['queue-1'],
      activeId: 'message-1',
    });
  });

  it('drains FIFO one turn at a time', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'desktop');
    await harness.service.submit(request('message-3', 'third'), 'portal');

    harness.service.onTurnTerminal(target(), 'complete');
    await jest.runOnlyPendingTimersAsync();
    expect(harness.dispatched.map((item) => item.request.text)).toEqual([
      'first',
      'second',
    ]);

    harness.service.onTurnTerminal(target(), 'complete');
    await jest.runOnlyPendingTimersAsync();
    expect(harness.dispatched.map((item) => item.request.text)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('rebroadcasts steerability after a queued dispatch finishes acquiring the turn', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'desktop');
    await harness.service.submit(request('message-3', 'third'), 'portal');

    harness.service.onTurnTerminal(target(), 'complete', 'message-1');
    await jest.runOnlyPendingTimersAsync();

    expect(harness.broadcasts[harness.broadcasts.length - 1]?.queue).toEqual([
      expect.objectContaining({ text: 'third', canSteer: true }),
    ]);
  });

  it('waits 500ms before draining after an error', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'desktop');
    harness.service.onTurnTerminal(target(), 'error');

    await jest.advanceTimersByTimeAsync(499);
    expect(harness.dispatched).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(harness.dispatched).toHaveLength(2);
  });

  it('refuses to drain an edit-locked head until it is unlocked', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'desktop');
    await harness.service.setEditLock(target(), 'queue-1', true);
    harness.service.onTurnTerminal(target(), 'complete');
    await jest.runOnlyPendingTimersAsync();
    expect(harness.dispatched).toHaveLength(1);

    await harness.service.setEditLock(target(), 'queue-1', false);
    await Promise.resolve();
    expect(harness.dispatched).toHaveLength(2);
  });

  it('review 2: cancels a permanently refused agent row and drains the human behind it without retry', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    try {
      const harness = createHarness();
      const mutations: ChatQueuePersistenceMutation[] = [];
      harness.setPersistRuntimeImpl(
        (_target, _ids, _active, mutation): void => {
          if (mutation) mutations.push(mutation);
        },
      );
      await harness.service.submit(request('running', 'first'), 'desktop');
      const sender = {
        kind: 'bot' as const,
        botId: 'app_advisor',
        taskId: 'origin-task',
        chatId: 'origin-chat',
      };
      const agent: ChatSendMessageRequest = {
        ...request('refused', 'agent text'),
        agentSent: {
          sender,
          chatTitle: 'Captured',
          projectLabel: 'App Advisor',
        },
        agentSenderProvenance: {
          version: 1,
          sender,
          owner: { kind: 'none' },
          capturedAt: '2026-10-16T00:00:00.000Z',
          acceptedInputId: 'refused',
        },
        hiddenContext: {
          kind: 'agent-sender-context',
          text: '<system_instruction>Sender</system_instruction>',
        },
      };
      await harness.service.submit(agent, 'desktop');
      await harness.service.submit(request('human', 'human text'), 'desktop');
      validation
        .mockClear()
        .mockRejectedValue(
          new senderContext.AgentSenderContextError(
            'not_found',
            'Private origin failure',
          ),
        );
      harness.service.onTurnTerminal(target(), 'complete');
      await jest.runOnlyPendingTimersAsync();
      await jest.runOnlyPendingTimersAsync();
      expect(
        harness.dispatched.map((item) => item.request.userMessageId),
      ).toEqual(['running', 'human']);
      expect(mutations).toContainEqual(
        expect.objectContaining({
          type: 'cancel',
          request: agent,
          lastErrorMessage:
            'The agent that sent this message can no longer reach this chat.',
        }),
      );
      expect(
        harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]
          ?.queue ?? [],
      ).toEqual([]);
      harness.service.onTurnTerminal(target(), 'complete');
      await jest.runOnlyPendingTimersAsync();
      expect(validation).toHaveBeenCalledTimes(1);
    } finally {
      validation.mockRestore();
    }
  });

  it('holds a hydrated agent input when current provenance is refused, without retrying or changing captured fields', async () => {
    const validation = jest.spyOn(
      senderContext,
      'revalidateAgentSenderRequest',
    );
    try {
      const harness = createHarness();
      const sender = {
        kind: 'bot' as const,
        botId: 'app_advisor',
        taskId: 'sender-task',
        chatId: 'sender-chat',
      };
      const captured: ChatSendMessageRequest = {
        ...request('held-agent', 'visible'),
        agentSent: {
          sender,
          chatTitle: 'Before rename',
          projectLabel: 'App Advisor',
        },
        agentSenderProvenance: {
          version: 1,
          sender,
          owner: { kind: 'none' },
          capturedAt: '2026-10-16T00:00:00.000Z',
          acceptedInputId: 'held-agent',
        },
        hiddenContext: {
          kind: 'agent-sender-context',
          text: '<system_instruction>Captured</system_instruction>',
        },
      };
      harness.service.hydratePersistedInput(captured, 'held-row', 'desktop', 1);
      validation.mockRejectedValue(
        new senderContext.AgentSenderContextError(
          'not_found',
          'Sender origin was removed',
        ),
      );
      await expect(harness.service.force(target(), 'held-row')).rejects.toThrow(
        'Sender origin was removed',
      );
      expect(harness.dispatched).toHaveLength(0);
      expect(harness.cancelled).toHaveLength(0);
      expect(
        harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]
          .queue[0],
      ).toMatchObject({ text: 'visible', agentSent: captured.agentSent });
    } finally {
      validation.mockRestore();
    }
  });

  it('retains agent attribution and immutable context through queue edit, hydration and force without watcher coalescing', async () => {
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    try {
      const harness = createHarness();
      await harness.service.submit(request('running', 'first'), 'desktop');
      const sender = {
        kind: 'bot' as const,
        botId: 'app_advisor',
        taskId: 'sender-task',
        chatId: 'sender-chat',
      };
      const agent: ChatSendMessageRequest = {
        ...request('agent-input', 'original'),
        agentSent: {
          sender,
          chatTitle: 'Captured',
          projectLabel: 'App Advisor',
        },
        agentSenderProvenance: {
          version: 1,
          sender,
          owner: { kind: 'none' },
          capturedAt: '2026-10-16T00:00:00.000Z',
          acceptedInputId: 'agent-input',
        },
        hiddenContext: {
          kind: 'agent-sender-context',
          text: '<system_instruction>Sender</system_instruction>',
        },
      };
      await harness.service.submit(agent, 'desktop');
      await harness.service.submit(
        {
          ...request('watcher', 'Watcher payload'),
          watcherFired: { kind: 'Wakeup' },
        },
        'desktop',
      );
      expect(
        harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]
          .queue,
      ).toHaveLength(2);
      expect(
        harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]
          .queue[0].agentSent,
      ).toEqual(agent.agentSent);
      await harness.service.edit({
        ...target(),
        entryId: 'queue-1',
        text: 'edited',
      });
      await harness.service.force(target(), 'queue-1');
      expect(harness.dispatched[1].request).toMatchObject({
        ...agent,
        text: 'edited',
      });
      const restarted = createHarness();
      restarted.service.hydratePersistedInput(
        agent,
        'restored-agent',
        'desktop',
        1,
      );
      restarted.service.broadcastWorktree('project-1', 'worktree-1');
      expect(
        restarted.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]
          .queue[0].agentSent,
      ).toEqual(agent.agentSent);
      await restarted.service.force(target(), 'restored-agent');
      expect(restarted.dispatched[0].request).toEqual(agent);
      expect(validation).toHaveBeenCalledWith(agent);
    } finally {
      validation.mockRestore();
    }
  });

  it('rejects edit-lock acquisition for an absent chat without creating state', async () => {
    const harness = createHarness();

    await expect(
      harness.service.setEditLock(target(), 'queue-missing', true),
    ).rejects.toThrow('This message is no longer available to edit.');

    expect(harness.broadcasts).toEqual([]);
    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1'),
    ).toEqual([]);
    // Cleanup stays idempotent when an abandoned attempt has lost its row.
    await expect(
      harness.service.setEditLock(target(), 'queue-missing', false),
    ).resolves.toBeUndefined();
  });

  it('rejects a consumed entry without locking its replacement', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'desktop');
    await harness.service.submit(request('message-3', 'third'), 'portal');
    harness.service.onTurnTerminal(target(), 'complete');
    await jest.runOnlyPendingTimersAsync();
    const broadcastsBeforeLock = harness.broadcasts.length;

    await expect(
      harness.service.setEditLock(target(), 'queue-1', true),
    ).rejects.toThrow('This message is no longer available to edit.');

    expect(harness.broadcasts).toHaveLength(broadcastsBeforeLock);
    expect(harness.broadcasts.at(-1)?.queue).toEqual([
      expect.objectContaining({ id: 'queue-2' }),
    ]);
    expect(harness.broadcasts.at(-1)?.queue[0]?.editLocked).not.toBe(true);
    await expect(
      harness.service.edit({ ...target(), entryId: 'queue-1', text: 'stale' }),
    ).resolves.toBe('not_found');
  });

  it.each(['cancel', 'unlock'] as const)(
    'rejects acquisition when %s invalidates it during persistence',
    async (operation) => {
      const harness = createHarness();
      await harness.service.submit(request('message-1', 'first'), 'desktop');
      await harness.service.submit(request('message-2', 'second'), 'desktop');
      await harness.service.submit(request('message-3', 'third'), 'portal');
      let finishLockPersistence: (() => void) | undefined;
      harness.setPersistRuntimeImpl(
        () =>
          new Promise<void>((resolve) => {
            finishLockPersistence = resolve;
          }),
      );
      const locking = harness.service.setEditLock(target(), 'queue-1', true);
      expect(finishLockPersistence).toBeDefined();
      harness.setPersistRuntimeImpl(undefined);

      if (operation === 'cancel') {
        await harness.service.cancel(target(), 'queue-1');
      } else {
        await harness.service.setEditLock(target(), 'queue-1', false);
      }
      const rejection = expect(locking).rejects.toThrow(
        'This message is no longer available to edit.',
      );
      finishLockPersistence?.();
      await rejection;

      expect(
        harness.dispatched.map(({ request }) => request.userMessageId),
      ).toEqual(['message-1']);
      expect(harness.broadcasts.at(-1)?.queue.map(({ id }) => id)).toEqual(
        operation === 'cancel' ? ['queue-2'] : ['queue-1', 'queue-2'],
      );
      expect(
        harness.broadcasts.at(-1)?.queue.every(({ editLocked }) => !editLocked),
      ).toBe(true);
    },
  );

  it('resumes draining when a failed acquisition rolls back after the turn ends', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'desktop');
    let failLockPersistence: ((error: Error) => void) | undefined;
    harness.setPersistRuntimeImpl(
      () =>
        new Promise<void>((_resolve, reject) => {
          failLockPersistence = reject;
        }),
    );
    const locking = harness.service.setEditLock(target(), 'queue-1', true);
    expect(failLockPersistence).toBeDefined();
    harness.setPersistRuntimeImpl(undefined);

    harness.service.onTurnTerminal(target(), 'complete');
    await jest.runOnlyPendingTimersAsync();
    expect(
      harness.dispatched.map(({ request }) => request.userMessageId),
    ).toEqual(['message-1']);

    const rejection = expect(locking).rejects.toThrow('disk full');
    failLockPersistence?.(new Error('disk full'));
    await rejection;
    await jest.runOnlyPendingTimersAsync();

    expect(
      harness.dispatched.map(({ request }) => request.userMessageId),
    ).toEqual(['message-1', 'message-2']);
  });

  it('acquires the intended entry when an earlier row drains during persistence', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'desktop');
    await harness.service.submit(request('message-3', 'third'), 'portal');
    let finishLockPersistence: (() => void) | undefined;
    harness.setPersistRuntimeImpl(
      () =>
        new Promise<void>((resolve) => {
          finishLockPersistence = resolve;
        }),
    );
    const locking = harness.service.setEditLock(target(), 'queue-2', true);
    harness.setPersistRuntimeImpl(undefined);

    harness.service.onTurnTerminal(target(), 'complete');
    await jest.runOnlyPendingTimersAsync();
    finishLockPersistence?.();
    await expect(locking).resolves.toBeUndefined();

    expect(harness.broadcasts.at(-1)?.queue).toEqual([
      expect.objectContaining({
        id: 'queue-2',
        text: 'third',
        editLocked: true,
      }),
    ]);
  });

  it('rejects a second acquisition of an already locked row', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'desktop');
    await harness.service.setEditLock(target(), 'queue-1', true);
    await expect(
      harness.service.setEditLock(target(), 'queue-1', true),
    ).rejects.toThrow('This message is no longer available to edit.');
    expect(harness.broadcasts.at(-1)?.queue[0]?.editLocked).toBe(true);
  });

  it('does not mistake a newer lock for a delayed abandoned acquisition', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'desktop');
    let finish: (() => void) | undefined;
    harness.setPersistRuntimeImpl(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const oldLock = harness.service.setEditLock(target(), 'queue-1', true);
    harness.setPersistRuntimeImpl(undefined);
    await harness.service.setEditLock(target(), 'queue-1', false);
    await harness.service.setEditLock(target(), 'queue-1', true);
    const rejection = expect(oldLock).rejects.toThrow(
      'This message is no longer available to edit.',
    );
    finish?.();
    await rejection;
    expect(harness.broadcasts.at(-1)?.queue[0]?.editLocked).toBe(true);
  });

  it('rolls back a lock whose persistence failed so the row remains editable', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'desktop');
    harness.setPersistRuntimeImpl(() => Promise.reject(new Error('disk full')));
    await expect(
      harness.service.setEditLock(target(), 'queue-1', true),
    ).rejects.toThrow('disk full');
    expect(harness.broadcasts.at(-1)?.queue[0]?.editLocked).not.toBe(true);
    harness.setPersistRuntimeImpl(undefined);
    await expect(
      harness.service.setEditLock(target(), 'queue-1', true),
    ).resolves.toBeUndefined();
  });

  it('releases an abandoned acquisition without releasing a newer edit lock', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'portal');
    const lock = (locked: boolean, owner: string): Promise<void> =>
      harness.service.setEditLock(target(), 'queue-1', locked, owner);
    await lock(true, 'abandoned-command');
    await lock(false, 'abandoned-command');
    expect(harness.broadcasts.at(-1)?.queue[0]?.editLocked).not.toBe(true);
    await lock(true, 'new-command');
    await lock(false, 'abandoned-command');
    expect(harness.broadcasts.at(-1)?.queue[0]?.editLocked).toBe(true);
    await lock(false, 'new-command');
    expect(harness.broadcasts.at(-1)?.queue[0]?.editLocked).not.toBe(true);
  });

  it('edits and cancels queued entries', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'desktop');
    await harness.service.submit(request('message-3', 'third'), 'desktop');
    await expect(
      harness.service.edit({
        ...target(),
        entryId: 'queue-1',
        text: 'edited',
      }),
    ).resolves.toBe('applied');
    await expect(harness.service.cancel(target(), 'queue-2')).resolves.toBe(
      'applied',
    );
    harness.service.onTurnTerminal(target(), 'complete');
    await jest.runOnlyPendingTimersAsync();

    expect(harness.dispatched.map((item) => item.request.text)).toEqual([
      'first',
      'edited',
    ]);
  });

  it('does not rebroadcast stale text when edit-lock persistence finishes after an edit', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(
      request('message-2', 'queued original'),
      'desktop',
    );

    const pendingPersistence: Array<() => void> = [];
    harness.setPersistRuntimeImpl(
      () =>
        new Promise<void>((resolve) => {
          pendingPersistence.push(resolve);
        }),
    );

    const locking = harness.service.setEditLock(target(), 'queue-1', true);
    const editing = harness.service.edit({
      ...target(),
      entryId: 'queue-1',
      text: 'queued edited',
    });
    expect(pendingPersistence).toHaveLength(2);

    pendingPersistence[1]?.();
    await editing;
    expect(harness.broadcasts.at(-1)?.queue[0]?.text).toBe('queued edited');

    pendingPersistence[0]?.();
    await expect(locking).rejects.toThrow(
      'This message is no longer available to edit.',
    );
    expect(harness.broadcasts.at(-1)?.queue[0]?.text).toBe('queued edited');
  });

  it('broadcasts a persisted edit before a later unchanged queue snapshot finishes persisting', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(
      request('message-2', 'queued original'),
      'desktop',
    );
    const broadcastsBeforeEdit = harness.broadcasts.length;

    const pendingPersistence: Array<() => void> = [];
    harness.setPersistRuntimeImpl(
      () =>
        new Promise<void>((resolve) => {
          pendingPersistence.push(resolve);
        }),
    );

    const editing = harness.service.edit({
      ...target(),
      entryId: 'queue-1',
      text: 'queued edited',
    });
    expect(harness.service.onTurnRevived(target(), 'message-1')).toBe(true);
    expect(pendingPersistence).toHaveLength(2);

    pendingPersistence[0]?.();
    await editing;
    try {
      expect(harness.broadcasts).toHaveLength(broadcastsBeforeEdit + 1);
      expect(harness.broadcasts.at(-1)?.queue[0]?.text).toBe('queued edited');
    } finally {
      pendingPersistence[1]?.();
      await Promise.resolve();
    }
  });

  it('does not rebroadcast a deleted queue when pending persistence finishes', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'queued'), 'desktop');
    const broadcastsBeforePersistence = harness.broadcasts.length;

    let resolvePersistence: (() => void) | undefined;
    harness.setPersistRuntimeImpl(
      () =>
        new Promise<void>((resolve) => {
          resolvePersistence = resolve;
        }),
    );

    const locking = harness.service.setEditLock(target(), 'queue-1', true);
    expect(resolvePersistence).toBeDefined();
    harness.service.beginWorktreeDeletion('project-1', 'worktree-1').commit();

    resolvePersistence?.();
    await expect(locking).rejects.toThrow(
      'This message is no longer available to edit.',
    );

    expect(harness.broadcasts).toHaveLength(broadcastsBeforePersistence);
    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1'),
    ).toEqual([]);
  });

  it('turns an edited async answer into ordinary text and preserves its restore correlation', async () => {
    const harness = createHarness();
    let persistedMutation: unknown;
    harness.setPersistRuntimeImpl(
      (_target, _queuedMessageIds, _turnActive, mutation) => {
        if (mutation?.type === 'edit') persistedMutation = mutation;
      },
    );
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(
      {
        ...request('message-2', 'Q: Which scope?\nA: Full'),
        asyncQuestionId: 'async-question',
      },
      'desktop',
    );

    await expect(
      harness.service.edit({
        ...target(),
        entryId: 'queue-1',
        text: 'Edited queued answer',
      }),
    ).resolves.toBe('applied');

    expect(persistedMutation).toMatchObject({
      type: 'edit',
      restoredAsyncQuestionId: 'async-question',
      request: {
        text: 'Edited queued answer',
      },
    });
    expect(persistedMutation).not.toHaveProperty('request.asyncQuestionId');
    harness.service.onTurnTerminal(target(), 'complete');
    await jest.runOnlyPendingTimersAsync();
    expect(harness.dispatched[1]?.request).toMatchObject({
      text: 'Edited queued answer',
    });
    expect(harness.dispatched[1]?.request.asyncQuestionId).toBeUndefined();
  });

  it('force cancels the active turn and dispatches the selected entry', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'portal');
    await expect(harness.service.force(target(), 'queue-1')).resolves.toBe(
      'applied',
    );

    expect(harness.cancelled).toEqual([target()]);
    expect(harness.settled).toEqual([
      { target: target(), turnUserMessageId: 'message-1' },
    ]);
    expect(harness.timeline).toEqual([
      'dispatch:message-1',
      'cancel',
      'settle:message-1',
      'dispatch:message-2',
    ]);
    expect(harness.dispatched.map((item) => item.request.text)).toEqual([
      'first',
      'second',
    ]);
    expect(harness.dispatched[1]?.origin).toBe('portal');
  });

  it('withholds a withdrawn row from drain until ownership transfer is durable', async () => {
    const harness = createHarness();
    await harness.service.submit(request('root', 'root'), 'desktop');
    let release = (): void => {
      throw new Error('Persistence release was not initialized');
    };
    harness.setPersistRuntimeImpl((_target, _ids, _active, mutation) =>
      mutation?.type === 'restore-input'
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : undefined,
    );
    const restored = harness.service.restoreWithdrawnInput(
      request('pending', 'withdrawn'),
      'pending',
      undefined,
      1,
    );
    harness.service.onTurnTerminal(target(), 'completed', 'root');
    await jest.runOnlyPendingTimersAsync();
    expect(harness.dispatched.map((item) => item.request.text)).toEqual([
      'root',
    ]);
    release();
    await restored;
    await jest.runOnlyPendingTimersAsync();
    expect(harness.dispatched.map((item) => item.request.text)).toEqual([
      'root',
      'withdrawn',
    ]);
  });

  it('rebroadcasts a restored row as steerable after recovery finishes', async () => {
    const harness = createHarness();
    await harness.service.submit(request('root', 'root'), 'desktop');

    await harness.service.restoreWithdrawnInput(
      request('pending', 'withdrawn'),
      'pending',
      undefined,
      1,
    );

    expect(harness.broadcasts[harness.broadcasts.length - 1]?.queue).toEqual([
      expect.objectContaining({
        id: 'pending',
        text: 'withdrawn',
        canSteer: true,
      }),
    ]);
  });

  it('durably consumes a restored row after authoritative pickup evidence', async () => {
    const harness = createHarness();
    let persistedMutation: ChatQueuePersistenceMutation | undefined;
    harness.setPersistRuntimeImpl((_target, _ids, _active, mutation) => {
      if (mutation?.type === 'consume-restored-input') {
        persistedMutation = mutation;
      }
    });
    await harness.service.submit(request('root', 'root'), 'desktop');
    await harness.service.restoreWithdrawnInput(
      request('pending', 'withdrawn'),
      'pending',
      undefined,
      1,
    );

    await harness.service.consumeRestoredInput(target(), 'pending');

    expect(persistedMutation).toMatchObject({
      type: 'consume-restored-input',
      request: { userMessageId: 'pending', text: 'withdrawn' },
    });
    expect(
      harness.service
        .getWorktreeSnapshots('project-1', 'worktree-1')
        .flatMap((snapshot) => snapshot.queue),
    ).toEqual([]);
  });

  it('coalesces repeated withdrawal restoration into one queued row', async () => {
    const harness = createHarness();
    await harness.service.submit(request('root', 'root'), 'desktop');
    const withdrawn = request('pending', 'withdrawn');

    await harness.service.restoreWithdrawnInput(
      withdrawn,
      'pending',
      { commandId: 'queue-once', outcome: 'applied', entityId: 'pending' },
      1,
    );
    await harness.service.restoreWithdrawnInput(
      withdrawn,
      'pending',
      { commandId: 'queue-once', outcome: 'applied', entityId: 'pending' },
      1,
    );

    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]?.queue,
    ).toEqual([
      expect.objectContaining({
        id: 'pending',
        text: 'withdrawn',
      }),
    ]);
  });

  it('restores the same withdrawn row again after a completed restoration', async () => {
    const harness = createHarness();
    await harness.service.submit(request('root', 'root'), 'desktop');
    const withdrawn = request('pending', 'withdrawn');

    await harness.service.restoreWithdrawnInput(
      withdrawn,
      'pending',
      undefined,
      1,
    );
    await expect(harness.service.cancel(target(), 'pending')).resolves.toBe(
      'applied',
    );
    await harness.service.restoreWithdrawnInput(
      withdrawn,
      'pending',
      undefined,
      2,
    );

    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]?.queue,
    ).toEqual([
      expect.objectContaining({
        id: 'pending',
        text: 'withdrawn',
      }),
    ]);
  });

  it('keeps the original agent payload and provenance when steering a queued row', async () => {
    const harness = createHarness();
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    const sender: ChatAgentSentInfo['sender'] = {
      kind: 'bot',
      botId: 'app_advisor',
      taskId: 'sender-task',
      chatId: 'sender-chat',
    };
    const agent: ChatSendMessageRequest = {
      ...request('agent-input', 'original agent text'),
      agentSent: {
        sender,
        chatTitle: 'Original sender',
        projectLabel: 'App Advisor',
      },
      agentSenderProvenance: {
        version: 1,
        sender,
        owner: { kind: 'none' },
        capturedAt: '2026-10-16T00:00:00.000Z',
        acceptedInputId: 'agent-input',
      },
      hiddenContext: {
        kind: 'agent-sender-context',
        text: 'Original trusted context',
      },
    };
    const steerQueued = jest
      .spyOn(getChatStateService().inputDelivery, 'steerQueued')
      .mockImplementation((_request, _ids, _receipt, claimed) => {
        claimed();
        return Promise.resolve();
      });
    try {
      await harness.service.submit(request('root', 'active'), 'desktop');
      await harness.service.submit(agent, 'desktop');
      const original = structuredClone(agent);
      await expect(
        harness.service.steer(target(), 'queue-1', {
          commandId: 'agent-steer',
          outcome: 'applied',
          entityId: 'chat-1',
        }),
      ).resolves.toBe('applied');
      expect(steerQueued.mock.calls[0][0]).toEqual(original);
      expect(steerQueued.mock.calls[0][0].agentSent).toEqual(
        original.agentSent,
      );
      expect(steerQueued.mock.calls[0][0].agentSenderProvenance).toEqual(
        original.agentSenderProvenance,
      );
      expect(
        harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]
          ?.queue ?? [],
      ).toEqual([]);
    } finally {
      steerQueued.mockRestore();
      validation.mockRestore();
    }
  });

  it('rechecks the steering agent before claiming and keeps the row queued on refusal', async () => {
    const harness = createHarness();
    const actor = jest
      .spyOn(senderContext, 'revalidateAgentSteeringActor')
      .mockRejectedValue(
        new senderContext.AgentSenderContextError(
          'not_found',
          'The target chat is not available.',
        ),
      );
    const steerQueued = jest
      .spyOn(getChatStateService().inputDelivery, 'steerQueued')
      .mockResolvedValue(undefined);
    try {
      await harness.service.submit(request('root', 'active'), 'desktop');
      await harness.service.submit(request('user-input', 'queued'), 'desktop');
      const steeringActor = {
        kind: 'project' as const,
        projectType: 'code' as const,
        projectId: 'project-2',
        taskId: 'task-2',
        chatId: 'chat-2',
      };
      await expect(
        harness.service.steer(target(), 'queue-1', {
          commandId: 'agent-steer',
          outcome: 'applied',
          entityId: 'chat-1',
          agentSteeringActor: steeringActor,
        }),
      ).rejects.toThrow('The target chat is not available.');
      expect(actor).toHaveBeenCalledWith(steeringActor, 'project-1');
      expect(steerQueued).not.toHaveBeenCalled();
      expect(
        harness.service
          .getWorktreeSnapshots('project-1', 'worktree-1')[0]
          ?.queue.map((row) => row.id),
      ).toEqual(['queue-1']);
    } finally {
      steerQueued.mockRestore();
      actor.mockRestore();
    }
  });

  it('never steers a different row after a cancel lands during authorization', async () => {
    const harness = createHarness();
    await harness.service.submit(request('root', 'root'), 'desktop');
    await harness.service.submit(request('a', 'cancelled'), 'desktop');
    await harness.service.submit(request('b', 'still wanted'), 'desktop');
    let release: (() => void) | undefined;
    const revalidate = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
    const steerQueued = jest
      .spyOn(getChatStateService().inputDelivery, 'steerQueued')
      .mockResolvedValue(undefined);
    try {
      const steering = harness.service.steer(target(), 'queue-1', {
        commandId: 'steer-a',
        outcome: 'applied',
        entityId: 'chat-1',
      });
      await Promise.resolve();
      await expect(harness.service.cancel(target(), 'queue-1')).resolves.toBe(
        'applied',
      );
      if (!release) throw new Error('Authorization did not start.');
      release();
      await expect(steering).resolves.toBe('not_found');
      expect(steerQueued).not.toHaveBeenCalled();
      expect(
        harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]
          ?.queue,
      ).toEqual([
        expect.objectContaining({ id: 'queue-2', text: 'still wanted' }),
      ]);
    } finally {
      revalidate.mockRestore();
      steerQueued.mockRestore();
    }
  });

  it('allows ordinary restoration after steering durably claims the row', async () => {
    const harness = createHarness();
    await harness.service.submit(request('root', 'root'), 'desktop');
    await harness.service.submit(request('pending', 'follow-up'), 'desktop');
    const steerQueued = jest
      .spyOn(getChatStateService().inputDelivery, 'steerQueued')
      .mockImplementation(
        async (queuedRequest, _queuedIds, _receipt, claimed, origin) => {
          claimed();
          await harness.service.restoreWithdrawnInput(
            queuedRequest,
            'queue-1',
            undefined,
            1,
            origin,
          );
        },
      );

    await expect(
      harness.service.steer(target(), 'queue-1', {
        commandId: 'steer-rejected',
        outcome: 'applied',
        entityId: 'chat-1',
      }),
    ).resolves.toBe('applied');

    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]?.queue,
    ).toEqual([expect.objectContaining({ id: 'queue-1', text: 'follow-up' })]);
    steerQueued.mockRestore();
  });

  it('rehydrates persisted queue rows by their stable id without duplicates', async () => {
    const harness = createHarness();
    const persisted = request('pending', 'persisted follow-up');
    const finishHydration = harness.service.beginInputHydration(
      'project-1',
      'worktree-1',
    );

    harness.service.hydratePersistedInput(persisted, 'pending', 'portal', 42);
    harness.service.hydratePersistedInput(persisted, 'pending', 'portal', 42);

    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]?.queue,
    ).toEqual([
      expect.objectContaining({
        id: 'pending',
        text: 'persisted follow-up',
        origin: 'portal',
        enqueuedAtMs: 42,
      }),
    ]);
    harness.service.releaseInputOwnership(target());
    await jest.runOnlyPendingTimersAsync();
    expect(harness.dispatched).toHaveLength(1);

    harness.service.hydratePersistedInput(persisted, 'pending', 'portal', 42);
    expect(
      harness.service
        .getWorktreeSnapshots('project-1', 'worktree-1')
        .flatMap((snapshot) => snapshot.queue),
    ).toEqual([]);
    finishHydration();
  });

  it('does not rehydrate a stable id that is already live in the host queue', async () => {
    const harness = createHarness();
    await harness.service.submit(request('root', 'root'), 'desktop');
    const queued = request('pending', 'queued once');
    await harness.service.submit(queued, 'portal');

    harness.service.hydratePersistedInput(queued, 'queue-1', 'portal', 1235);

    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]?.queue,
    ).toHaveLength(1);
  });

  it.each(['dispatch', 'cancel'])(
    'does not revive an accepted queue row from a stale snapshot after %s',
    async (action) => {
      const harness = createHarness();
      const finishHydration = harness.service.beginInputHydration(
        'project-1',
        'worktree-1',
      );
      await harness.service.submit(request('root', 'root'), 'desktop');
      const queued = request('pending', 'queued once');
      await harness.service.submit(queued, 'portal');
      if (action === 'cancel')
        await harness.service.cancel(target(), 'queue-1');
      else {
        harness.service.onTurnTerminal(target(), 'complete', 'root');
        await jest.runOnlyPendingTimersAsync();
      }
      harness.service.hydratePersistedInput(queued, 'queue-1', 'portal', 1235);
      expect(
        harness.service.getWorktreeSnapshots('project-1', 'worktree-1'),
      ).toEqual([]);
      finishHydration();
    },
  );

  it('prunes consumed input IDs after the last snapshot hydration finishes', async () => {
    const harness = createHarness();
    const finishFirst = harness.service.beginInputHydration(
      'project-1',
      'worktree-1',
    );
    const finishSecond = harness.service.beginInputHydration(
      'project-1',
      'worktree-1',
    );
    await harness.service.submit(request('root', 'root'), 'desktop');
    const queued = request('pending', 'queued once');
    await harness.service.submit(queued, 'portal');
    await harness.service.cancel(target(), 'queue-1');
    finishFirst();
    harness.service.hydratePersistedInput(queued, 'queue-1', 'portal', 1235);
    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1'),
    ).toEqual([]);
    finishSecond();
    harness.service.hydratePersistedInput(queued, 'queue-1', 'portal', 1235);
    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]?.queue,
    ).toHaveLength(1);
  });

  it('keeps the selected replacement immutable while Interrupt waits, and lets Stop invalidate it', async () => {
    const harness = createHarness();
    await harness.service.submit(request('root', 'root'), 'desktop');
    await harness.service.submit(request('selected', 'selected'), 'portal');
    let release = (): void => {
      throw new Error('Cancellation release was not initialized');
    };
    harness.setCancelImpl(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const forced = harness.service.force(target(), 'queue-1');
    await expect(
      harness.service.edit({
        ...target(),
        entryId: 'queue-1',
        text: 'changed',
      }),
    ).resolves.toBe('busy');
    await expect(harness.service.cancel(target(), 'queue-1')).resolves.toBe(
      'busy',
    );
    harness.service.invalidatePendingInputOperations(target());
    release();
    await expect(forced).resolves.toBe('busy');
    expect(harness.dispatched.map((item) => item.request.text)).toEqual([
      'root',
    ]);
    harness.service.onTurnTerminal(target(), 'cancelled', 'root');
    await jest.runOnlyPendingTimersAsync();
    expect(harness.dispatched.map((item) => item.request.text)).toEqual([
      'root',
      'selected',
    ]);
  });

  it('defers force while the previous dispatch is still unwinding', async () => {
    const harness = createHarness();
    let finishDispatch = (): void => undefined;
    harness.setDispatchImpl(
      () =>
        new Promise<void>((resolve) => {
          finishDispatch = resolve;
        }),
    );

    const firstDispatch = harness.service.submit(
      request('message-1', 'first'),
      'desktop',
    );
    await Promise.resolve();
    await harness.service.submit(request('message-2', 'second'), 'portal');
    harness.service.onTurnTerminal(target(), 'cancelled', 'message-1');

    await expect(harness.service.force(target(), 'queue-1')).resolves.toBe(
      'busy',
    );

    expect(harness.cancelled).toEqual([]);
    expect(harness.dispatched).toHaveLength(1);
    expect(harness.broadcasts[harness.broadcasts.length - 1]?.queue).toEqual([
      expect.objectContaining({ id: 'queue-1', text: 'second' }),
    ]);

    harness.setDispatchImpl(undefined);
    finishDispatch();
    await firstDispatch;
    await jest.runOnlyPendingTimersAsync();

    expect(harness.dispatched.map((item) => item.request.text)).toEqual([
      'first',
      'second',
    ]);
  });

  it.each([false, true])(
    'settles a stopped handoff after its late acceptance and before the next dispatch (queued: %s)',
    async (fromQueue) => {
      const harness = createHarness();
      if (fromQueue)
        await harness.service.submit(
          request('primer', 'prior turn'),
          'desktop',
        );
      let finishDispatch = (): void => undefined;
      harness.setDispatchImpl(
        () =>
          new Promise<void>((resolve) => {
            finishDispatch = resolve;
          }),
      );
      const first = harness.service.submit(
        request('stopped', 'first'),
        'desktop',
      );
      if (fromQueue) harness.service.onTurnTerminal(target(), 'complete');
      await jest.advanceTimersByTimeAsync(0);
      await harness.service.submit(request('next', 'second'), 'desktop');
      harness.stopPendingPreparations();
      harness.service.onTurnTerminal(target(), 'cancelled');
      finishDispatch();
      await first;
      await jest.advanceTimersByTimeAsync(0);
      expect(harness.settled).toHaveLength(1);
      expect(harness.settled[0]?.target).toMatchObject(target());
      expect(harness.settled[0]?.turnUserMessageId).toBe('stopped');
      harness.setDispatchImpl(undefined);
      await jest.advanceTimersByTimeAsync(1000);
      expect(harness.timeline.indexOf('settle:stopped')).toBeLessThan(
        harness.timeline.indexOf('dispatch:next'),
      );
    },
  );

  it.each([false, true])(
    'holds the next dispatch while stopped handoff settlement retries (queued: %s)',
    async (fromQueue) => {
      const harness = createHarness();
      if (fromQueue)
        await harness.service.submit(
          request('primer', 'prior turn'),
          'desktop',
        );
      let finishDispatch = (): void => undefined;
      harness.setDispatchImpl(
        () =>
          new Promise<void>((resolve) => {
            finishDispatch = resolve;
          }),
      );
      const first = harness.service.submit(
        request('stopped', 'first'),
        'desktop',
      );
      if (fromQueue) harness.service.onTurnTerminal(target(), 'complete');
      await jest.advanceTimersByTimeAsync(0);
      await harness.service.submit(request('next', 'second'), 'desktop');
      harness.stopPendingPreparations();
      harness.service.onTurnTerminal(target(), 'cancelled');
      let settleAttempts = 0;
      let releaseSettlement = (): void => undefined;
      harness.setSettleImpl(() => {
        settleAttempts += 1;
        if (settleAttempts === 1)
          return Promise.reject(new Error('journal unavailable'));
        return new Promise<void>((resolve) => {
          releaseSettlement = resolve;
        });
      });
      finishDispatch();
      await jest.advanceTimersByTimeAsync(1000);
      expect(
        harness.dispatched.map(({ request: item }) => item.userMessageId),
      ).not.toContain('next');
      expect(settleAttempts).toBeGreaterThan(1);
      releaseSettlement();
      await first.catch(() => undefined);
      harness.setDispatchImpl(undefined);
      await jest.advanceTimersByTimeAsync(1000);
      expect(
        harness.dispatched.map(({ request: item }) => item.userMessageId),
      ).toContain('next');
    },
  );

  it('publishes Steer availability when the initial dispatch finishes', async () => {
    const harness = createHarness();
    let finishDispatch = (): void => undefined;
    harness.setDispatchImpl(
      () =>
        new Promise<void>((resolve) => {
          finishDispatch = resolve;
        }),
    );
    const firstDispatch = harness.service.submit(
      request('message-1', 'first'),
      'desktop',
    );
    await Promise.resolve();
    await harness.service.submit(request('message-2', 'second'), 'desktop');
    expect(harness.broadcasts.at(-1)?.queue[0]?.canSteer).not.toBe(true);

    finishDispatch();
    await firstDispatch;

    expect(harness.broadcasts.at(-1)?.queue[0]).toEqual(
      expect.objectContaining({
        id: 'queue-1',
        text: 'second',
        canSteer: true,
      }),
    );
    expect(harness.dispatched).toHaveLength(1);
  });

  it('review 3: delegates local terminal cancellation only when no host queued entry matches', async () => {
    const fallback = jest
      .spyOn(getChatStateService(), 'cancelRetainedTerminalAgentInput')
      .mockResolvedValue('applied');
    try {
      const harness = createHarness();
      await harness.service.submit(request('running', 'first'), 'desktop');
      await harness.service.submit(request('queued', 'second'), 'desktop');
      expect(await harness.service.cancel(target(), 'queue-1')).toBe('applied');
      expect(fallback).not.toHaveBeenCalled();
      expect(await harness.service.cancel(target(), 'local-terminal')).toBe(
        'applied',
      );
      expect(fallback).toHaveBeenCalledWith(target(), 'local-terminal');
      fallback.mockResolvedValue('not_found');
      expect(await harness.service.cancel(target(), 'ordinary-missing')).toBe(
        'not_found',
      );
    } finally {
      fallback.mockRestore();
    }
  });

  it('falls back to canonical terminal edits only when no host queue entry exists', async () => {
    const fallback = jest
      .spyOn(getChatStateService(), 'editRetainedTerminalAgentInput')
      .mockResolvedValue('applied');
    try {
      const harness = createHarness();
      await harness.service.submit(request('running', 'first'), 'desktop');
      await harness.service.submit(request('queued', 'queued'), 'desktop');
      expect(
        await harness.service.edit({
          ...target(),
          entryId: 'queue-1',
          text: 'host edited',
        }),
      ).toBe('applied');
      expect(fallback).not.toHaveBeenCalled();
      const edit = {
        ...target(),
        entryId: 'accepted-terminal',
        text: 'terminal edited',
      };
      expect(await harness.service.edit(edit)).toBe('applied');
      expect(fallback).toHaveBeenCalledWith(edit);
      fallback.mockRejectedValueOnce(new Error('Input already committed'));
      await expect(harness.service.edit(edit)).rejects.toThrow(
        'Input already committed',
      );
    } finally {
      fallback.mockRestore();
    }
  });

  it('reports missing entries without mutating the queue', async () => {
    const fallback = jest
      .spyOn(getChatStateService(), 'editRetainedTerminalAgentInput')
      .mockResolvedValue('not_found');
    const cancelFallback = jest
      .spyOn(getChatStateService(), 'cancelRetainedTerminalAgentInput')
      .mockResolvedValue('not_found');
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');

    await expect(
      harness.service.edit({
        ...target(),
        entryId: 'missing',
        text: 'missing',
      }),
    ).resolves.toBe('not_found');
    await expect(harness.service.cancel(target(), 'missing')).resolves.toBe(
      'not_found',
    );
    await expect(harness.service.force(target(), 'missing')).resolves.toBe(
      'not_found',
    );
    expect(harness.dispatched).toHaveLength(1);
    fallback.mockRestore();
    cancelFallback.mockRestore();
  });

  it('does not acknowledge a cancellation when canonical persistence fails', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'portal');
    harness.setPersistRuntimeImpl(() =>
      Promise.reject(new Error('journal unavailable')),
    );

    await expect(harness.service.cancel(target(), 'queue-1')).rejects.toThrow(
      'journal unavailable',
    );

    expect(
      harness.service
        .getWorktreeSnapshots('project-1', 'worktree-1')[0]
        ?.queue.map((message) => message.id),
    ).toEqual(['queue-1']);
  });

  it('restores an edited request when canonical persistence fails', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'original'), 'portal');
    harness.setPersistRuntimeImpl(() =>
      Promise.reject(new Error('journal unavailable')),
    );

    await expect(
      harness.service.edit({
        ...target(),
        entryId: 'queue-1',
        text: 'edited',
      }),
    ).rejects.toThrow('journal unavailable');

    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]
        ?.queue[0]?.text,
    ).toBe('original');
  });

  it('does not cancel the active turn when the forced row is cancelled during authorization', async () => {
    const harness = createHarness();
    let finishValidation = (): void => {
      throw new Error('Validation release was not initialized');
    };
    const sender: ChatAgentSentInfo['sender'] = {
      kind: 'bot',
      botId: 'app_advisor',
      taskId: 'sender-task',
      chatId: 'sender-chat',
    };
    const agent: ChatSendMessageRequest = {
      ...request('agent-input', 'agent text'),
      agentSent: { sender, chatTitle: 'Sender', projectLabel: 'App Advisor' },
      agentSenderProvenance: {
        version: 1,
        sender,
        owner: { kind: 'none' },
        capturedAt: '2026-10-16T00:00:00.000Z',
        acceptedInputId: 'agent-input',
      },
    };
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    try {
      await harness.service.submit(request('message-1', 'first'), 'desktop');
      await harness.service.submit(agent, 'desktop');
      validation.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishValidation = resolve;
          }),
      );
      const forced = harness.service.force(target(), 'queue-1');
      await expect(harness.service.cancel(target(), 'queue-1')).resolves.toBe(
        'applied',
      );
      finishValidation();
      await expect(forced).resolves.toBe('not_found');
      expect(harness.cancelled).toEqual([]);
      expect(harness.service.isTurnActive(target())).toBe(true);
      expect(harness.dispatched.map((item) => item.request.text)).toEqual([
        'first',
      ]);
    } finally {
      validation.mockRestore();
    }
  });

  it('keeps the message and turn gate intact when force cancel rejects', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'portal');
    harness.setCancelImpl(() => Promise.reject(new Error('cancel failed')));

    await expect(harness.service.force(target(), 'queue-1')).rejects.toThrow(
      'cancel failed',
    );

    // The forced row must survive a cancel failure (not vanish), and the turn
    // gate must stay active so a lost cancel cannot wedge the queue.
    expect(harness.dispatched).toHaveLength(1);
    expect(harness.settled).toHaveLength(0);
    expect(harness.service.isTurnActive(target())).toBe(true);
    expect(
      harness.broadcasts[harness.broadcasts.length - 1]?.queue.map((m) => m.id),
    ).toEqual(['queue-1']);
  });

  it('dispatches the forced entry when cancelled-turn settlement rejects', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'portal');
    harness.setSettleImpl(() => Promise.reject(new Error('settle failed')));

    await harness.service.force(target(), 'queue-1');

    expect(harness.dispatched.map((item) => item.request.text)).toEqual([
      'first',
      'second',
    ]);
    expect(harness.service.isTurnActive(target())).toBe(true);
    expect(logMainProcessWarnMock).toHaveBeenCalledWith(
      '[chat-queue] Failed to settle cancelled turn before forced dispatch:',
      expect.objectContaining({ message: 'settle failed' }),
    );
  });

  it('edits forward attachment contexts and input mode to the dispatched turn', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'portal');

    await harness.service.edit({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      entryId: 'queue-1',
      text: 'second edited',
      attachmentPromptContexts: [
        { attachmentPath: '/tmp/a.png', promptKind: 'linear-ticket' },
      ],
      inputMode: 'voice',
    });
    harness.service.onTurnTerminal(target(), 'complete', 'message-1');
    await jest.runOnlyPendingTimersAsync();

    const dispatched = harness.dispatched[1]?.request;
    expect(dispatched?.text).toBe('second edited');
    expect(dispatched?.attachmentPromptContexts).toEqual([
      { attachmentPath: '/tmp/a.png', promptKind: 'linear-ticket' },
    ]);
    expect(dispatched?.inputMode).toBe('voice');
  });

  it.each(['updated', ''])(
    'preserves all attachments and queued identity when text changes to %j',
    async (text) => {
      const harness = createHarness();
      const original = {
        ...request('message-2', 'original'),
        fileReferences: [
          { absolutePath: '/tmp/context.txt', displayPath: 'context.txt' },
        ],
        attachmentPaths: ['/tmp/image.png'],
        attachmentPromptContexts: [
          {
            attachmentPath: '/tmp/image.png',
            promptKind: 'linear-ticket' as const,
          },
        ],
        inputMode: 'voice' as const,
      };
      await harness.service.submit(request('message-1', 'active'), 'desktop');
      await harness.service.submit(original, 'portal');
      harness.setPersistRuntimeImpl(() =>
        Promise.reject(new Error('journal unavailable')),
      );
      const edit = { ...target(), entryId: 'queue-1', text };

      await expect(
        harness.service.edit(edit, undefined, 'preserve'),
      ).rejects.toThrow('journal unavailable');
      expect(
        harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]
          ?.queue[0],
      ).toMatchObject({
        id: 'queue-1',
        text: original.text,
        fileReferences: original.fileReferences,
        attachmentPaths: original.attachmentPaths,
        attachmentPromptContexts: original.attachmentPromptContexts,
      });

      harness.setPersistRuntimeImpl(undefined);
      await expect(
        harness.service.edit(
          { ...edit, attachmentPaths: ['/tmp/replacement.png'] },
          undefined,
          'preserve',
        ),
      ).resolves.toBe('applied');
      expect(
        harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]
          ?.queue[0],
      ).toMatchObject({
        id: 'queue-1',
        text,
        fileReferences: original.fileReferences,
        attachmentPaths: original.attachmentPaths,
        attachmentPromptContexts: original.attachmentPromptContexts,
      });
      harness.service.onTurnTerminal(target(), 'complete', 'message-1');
      await jest.runOnlyPendingTimersAsync();
      expect(harness.dispatched[1]?.request).toEqual({ ...original, text });
      expect(harness.dispatched).toHaveLength(2);
    },
  );

  it('keeps desktop replacement semantics for omitted attachment fields', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'active'), 'desktop');
    await harness.service.submit(
      {
        ...request('message-2', 'original'),
        fileReferences: [
          { absolutePath: '/tmp/context.txt', displayPath: 'context.txt' },
        ],
        attachmentPaths: ['/tmp/image.png'],
        attachmentPromptContexts: [
          { attachmentPath: '/tmp/image.png', promptKind: 'linear-ticket' },
        ],
      },
      'desktop',
    );
    await harness.service.edit({
      ...target(),
      entryId: 'queue-1',
      text: 'text only',
    });
    harness.service.onTurnTerminal(target(), 'complete', 'message-1');
    await jest.runOnlyPendingTimersAsync();
    expect(harness.dispatched[1]?.request).toEqual({
      ...request('message-2', 'text only'),
      fileReferences: undefined,
      attachmentPaths: undefined,
      attachmentPromptContexts: undefined,
    });
  });

  it('mirrors attachment contexts and input mode in the broadcast view', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'message-2',
        text: 'second',
        attachmentPromptContexts: [
          { attachmentPath: '/tmp/a.png', promptKind: 'linear-ticket' },
        ],
        inputMode: 'voice',
      },
      'portal',
    );
    const view = harness.broadcasts[harness.broadcasts.length - 1]?.queue[0];
    expect(view?.attachmentPromptContexts).toEqual([
      { attachmentPath: '/tmp/a.png', promptKind: 'linear-ticket' },
    ]);
    expect(view?.inputMode).toBe('voice');
  });

  it('never starts a second dispatch while turnActive', async () => {
    const harness = createHarness();
    await Promise.all([
      harness.service.submit(request('message-1', 'first'), 'desktop'),
      harness.service.submit(request('message-2', 'second'), 'portal'),
    ]);

    expect(harness.dispatched).toHaveLength(1);
    expect(harness.service.isTurnActive(target())).toBe(true);
    expect(
      harness.broadcasts[harness.broadcasts.length - 1]?.queue,
    ).toHaveLength(1);
  });

  it('commits received autonomous turn events before replacing the provider route', async () => {
    const harness = createHarness();
    await harness.service.submit(request('original', 'original'), 'desktop');
    await harness.service.submit(request('local', 'local'), 'desktop');
    let release = (): void => {
      throw new Error('Provider event release was not initialized');
    };
    harness.setDrainEventsImpl(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    harness.service.onTurnTerminal(target(), 'complete', 'original');
    await jest.advanceTimersByTimeAsync(0);
    expect(
      harness.dispatched.map((entry) => entry.request.userMessageId),
    ).toEqual(['original']);
    // A provider pickup already arrived; durable ingress was still in flight.
    expect(harness.service.onTurnRevived(target(), 'steered')).toBe(true);
    release();
    await jest.advanceTimersByTimeAsync(0);
    expect(harness.dispatched).toHaveLength(1);
    harness.setDrainEventsImpl(undefined);
    harness.service.onTurnTerminal(target(), 'complete', 'steered');
    await jest.advanceTimersByTimeAsync(0);
    expect(
      harness.dispatched.map((entry) => entry.request.userMessageId),
    ).toEqual(['original', 'local']);
  });

  it('settles ingress before an immediate send and preserves concurrent submit order', async () => {
    const harness = createHarness();
    await harness.service.submit(request('original', 'original'), 'desktop');
    harness.service.onTurnTerminal(target(), 'complete', 'original');
    let release = (): void => {
      throw new Error('Provider event release was not initialized');
    };
    harness.setDrainEventsImpl(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const immediate = harness.service.submit(
      request('next', 'next'),
      'desktop',
    );
    await harness.service.submit(request('later', 'later'), 'portal');
    expect(
      harness.dispatched.map((entry) => entry.request.userMessageId),
    ).toEqual(['original']);
    expect(harness.service.onTurnRevived(target(), 'steered')).toBe(true);
    release();
    await immediate;
    expect(
      harness.broadcasts[harness.broadcasts.length - 1]?.queue.map(
        (entry) => entry.text,
      ),
    ).toEqual(['next', 'later']);
    expect(harness.dispatched).toHaveLength(1);
    harness.setDrainEventsImpl(undefined);
    harness.service.onTurnTerminal(target(), 'complete', 'steered');
    await jest.advanceTimersByTimeAsync(0);
    expect(
      harness.dispatched.map((entry) => entry.request.userMessageId),
    ).toEqual(['original', 'next']);
  });

  it('cancels a pending drain when the settled turn revives', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'portal');

    harness.service.onTurnTerminal(target(), 'complete', 'message-1');
    expect(harness.service.onTurnRevived(target(), 'message-1')).toBe(true);
    jest.runOnlyPendingTimers();
    await Promise.resolve();

    expect(harness.dispatched.map((item) => item.request.text)).toEqual([
      'first',
    ]);
    expect(harness.service.isTurnActive(target())).toBe(true);

    harness.service.onTurnTerminal(target(), 'complete', 'message-1');
    jest.runOnlyPendingTimers();
    await Promise.resolve();
    expect(harness.dispatched.map((item) => item.request.text)).toEqual([
      'first',
      'second',
    ]);
  });

  it('confirms an accepted revived turn after a concurrent terminal release', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'portal');

    harness.service.onTurnTerminal(target(), 'complete', 'message-1');
    expect(harness.service.onTurnRevived(target(), 'steered')).toBe(true);
    // The old root can settle after arbitration but before its pickup is
    // durably committed. Applying the accepted stamp must cancel that drain
    // without asking ownership to arbitrate the same decision again.
    harness.service.onTurnTerminal(target(), 'complete');
    harness.service.confirmTurnRevived(target(), 'steered');
    jest.runOnlyPendingTimers();
    await Promise.resolve();

    expect(harness.dispatched.map((item) => item.request.text)).toEqual([
      'first',
    ]);
    expect(harness.service.isTurnActive(target())).toBe(true);
  });

  it('refuses to revive a turn after the queue advances', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'portal');

    harness.service.onTurnTerminal(target(), 'complete', 'message-1');
    jest.runOnlyPendingTimers();
    await Promise.resolve();

    expect(harness.service.onTurnRevived(target(), 'message-1')).toBe(false);
    expect(harness.dispatched.map((item) => item.request.text)).toEqual([
      'first',
      'second',
    ]);
    expect(harness.service.isTurnActive(target())).toBe(true);
  });

  it('ignores terminal releases tagged with a superseded turn id', async () => {
    const harness = createHarness();
    await harness.service.submit(request('message-1', 'first'), 'desktop');
    await harness.service.submit(request('message-2', 'second'), 'desktop');
    await harness.service.submit(request('message-3', 'third'), 'desktop');

    // Deliberate untagged release (user Stop): drains "second".
    harness.service.onTurnTerminal(target(), 'cancelled');
    jest.runOnlyPendingTimers();
    await Promise.resolve();
    expect(harness.dispatched.map((item) => item.request.text)).toEqual([
      'first',
      'second',
    ]);
    expect(harness.service.isTurnActive(target())).toBe(true);

    // The cancelled first turn's late provider terminal must not release the
    // gate for the turn now running, nor drain "third" concurrently.
    harness.service.onTurnTerminal(target(), 'cancelled', 'message-1');
    jest.runOnlyPendingTimers();
    await Promise.resolve();
    expect(harness.dispatched).toHaveLength(2);
    expect(harness.service.isTurnActive(target())).toBe(true);

    // The running turn's own tagged terminal drains "third".
    harness.service.onTurnTerminal(target(), 'complete', 'message-2');
    jest.runOnlyPendingTimers();
    await Promise.resolve();
    expect(harness.dispatched.map((item) => item.request.text)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('drains rows queued during a failed dispatch instead of stranding them', async () => {
    const harness = createHarness();
    let resolveFirst = (): void => undefined;
    let rejectFirst: (error: Error) => void = (): void => undefined;
    harness.setDispatchImpl(
      () =>
        new Promise<void>((resolve, reject) => {
          resolveFirst = resolve;
          rejectFirst = reject;
        }),
    );

    const first = harness.service.submit(
      request('message-1', 'first'),
      'desktop',
    );
    await Promise.resolve();
    // Queued while the first dispatch is still in flight.
    harness.setDispatchImpl(undefined);
    await harness.service.submit(request('message-2', 'second'), 'desktop');
    expect(
      harness.broadcasts[harness.broadcasts.length - 1]?.queue,
    ).toHaveLength(1);

    rejectFirst(new Error('dispatch failed'));
    await expect(first).rejects.toThrow('dispatch failed');
    jest.runOnlyPendingTimers();
    await Promise.resolve();
    await Promise.resolve();

    // "first" is the recorded failed attempt; "second" drained after it.
    expect(harness.dispatched.map((item) => item.request.text)).toEqual([
      'first',
      'second',
    ]);
    expect(
      harness.broadcasts[harness.broadcasts.length - 1]?.queue,
    ).toHaveLength(0);
    void resolveFirst;
  });
});

describe('phase 09 setup acceptance', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  it.each([false, true])(
    'review: uses effective terminal mode for started agent acceptance (TUI enabled: %s)',
    async (enabled) => {
      mockIsClaudeTuiChatsEnabled.mockReturnValue(enabled);
      const { withLegacyChatMessageCommand } =
        await import('../canopy-runtime/core-chat-message-command-adapter');
      const harness = createHarness();
      jest
        .spyOn(senderContext, 'withAgentSenderAuthority')
        .mockImplementation((_request, handoff) => Promise.resolve(handoff()));
      jest
        .spyOn(senderContext, 'revalidateAgentSenderRequest')
        .mockResolvedValue(undefined);
      jest
        .spyOn(senderContext, 'agentSendTargetReadiness')
        .mockResolvedValue('ready');
      const sender = {
        kind: 'bot' as const,
        botId: 'app_advisor',
        taskId: 'sender-task',
        chatId: 'sender-chat',
      };
      const input: ChatSendMessageRequest = {
        ...request('terminal-mode-input', 'hello'),
        interfaceMode: 'claude-code',
        agentSent: { sender, chatTitle: 'Sender', projectLabel: 'App Advisor' },
        agentSenderProvenance: {
          version: 1,
          capturedAt: '2026-10-17T00:00:00.000Z',
          acceptedInputId: 'terminal-mode-input',
          sender,
          owner: { kind: 'none' },
        },
      };
      const mutations: ChatQueuePersistenceMutation[] = [];
      harness.setPersistRuntimeImpl((_target, _ids, _active, mutation) => {
        if (mutation) mutations.push(mutation);
      });
      const accepted = jest.fn();
      try {
        await withLegacyChatMessageCommand(
          {
            schemaVersion: 1,
            commandId: 'terminal-mode-command',
            projectId: input.projectId,
            worktreeId: input.worktreeId,
            command: {
              type: 'chat.send_message',
              chatId: input.chatId,
              userMessageId: input.userMessageId,
              text: input.text,
            },
          },
          () => harness.service.submit(input, 'desktop'),
          undefined,
          { onAgentSendAccepted: accepted },
        );
        expect(harness.dispatched).toHaveLength(1);
        if (enabled) {
          expect(mutations).not.toContainEqual(
            expect.objectContaining({ type: 'agent-send-accepted' }),
          );
          expect(accepted).not.toHaveBeenCalled();
        } else {
          expect(
            mutations.find(
              (mutation) => mutation.type === 'agent-send-accepted',
            ),
          ).toMatchObject({
            type: 'agent-send-accepted',
            acceptance: {
              acceptedInputId: input.userMessageId,
              disposition: 'started',
            },
            commandResult: {
              commandId: 'terminal-mode-command',
              outcome: 'applied',
            },
          });
          expect(accepted).toHaveBeenCalledWith(
            expect.objectContaining({
              acceptedInputId: input.userMessageId,
              disposition: 'started',
            }),
          );
        }
      } finally {
        harness.service.resetForTests();
        mockIsClaudeTuiChatsEnabled.mockReturnValue(false);
      }
    },
  );

  it('retains setup input durably with the real queue id before acceptance and releases only when ready', async () => {
    const { withLegacyChatMessageCommand } =
      await import('../canopy-runtime/core-chat-message-command-adapter');
    const harness = createHarness();
    let pending = true;
    jest
      .spyOn(senderContext, 'withAgentSenderAuthority')
      .mockImplementation((_request, handoff) => Promise.resolve(handoff()));
    jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    jest
      .spyOn(senderContext, 'agentSendTargetReadiness')
      .mockImplementation(() => Promise.resolve(pending ? 'pending' : 'ready'));
    const input: ChatSendMessageRequest = {
      ...request('setup-input', 'hello'),
      agentSendSetup: { version: 1 },
      agentSenderProvenance: {
        version: 1,
        capturedAt: '2026-10-17T00:00:00.000Z',
        acceptedInputId: 'setup-input',
        sender: {
          kind: 'bot',
          botId: 'app_advisor',
          taskId: 'sender-task',
          chatId: 'sender-chat',
        },
        owner: { kind: 'none' },
      },
    };
    const accepted = jest.fn();
    await withLegacyChatMessageCommand(
      {
        schemaVersion: 1,
        commandId: 'setup-command',
        projectId: input.projectId,
        worktreeId: input.worktreeId,
        command: {
          type: 'chat.send_message',
          chatId: input.chatId,
          userMessageId: input.userMessageId,
          text: input.text,
        },
      },
      () => harness.service.submit(input, 'desktop'),
      undefined,
      { onAgentSendAccepted: accepted },
    );
    expect(harness.dispatched).toHaveLength(0);
    expect(accepted).toHaveBeenCalledWith(
      expect.objectContaining({
        acceptedInputId: 'setup-input',
        disposition: 'queued',
        queuedMessageId: 'queue-1',
      }),
    );
    pending = false;
    await harness.service.submit(request('later', 'next'), 'desktop');
    await jest.runOnlyPendingTimersAsync();
    expect(harness.dispatched[0]?.request).toMatchObject({
      userMessageId: 'setup-input',
      agentSendSetup: { version: 1 },
    });
  });

  it('settles the agent acceptance row when a queued agent handoff fails with a generic error', async () => {
    const harness = createHarness();
    jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    const readiness = jest
      .spyOn(senderContext, 'agentSendTargetReadiness')
      .mockResolvedValue('pending');
    jest
      .spyOn(senderContext, 'withAgentSenderAuthority')
      .mockImplementation((_request, handoff) => handoff());
    const input: ChatSendMessageRequest = {
      ...request('blocked-setup', 'never runs'),
      agentSendSetup: { version: 1 },
      agentSenderProvenance: {
        version: 1,
        capturedAt: '2026-10-17T00:00:00.000Z',
        acceptedInputId: 'blocked-setup',
        sender: {
          kind: 'bot',
          botId: 'app_advisor',
          taskId: 'sender-task',
          chatId: 'sender-chat',
        },
        owner: { kind: 'none' },
      },
    };
    const mutations: ChatQueuePersistenceMutation[] = [];
    harness.setPersistRuntimeImpl((_target, _ids, _active, mutation) => {
      if (mutation) mutations.push(mutation);
    });
    await harness.service.submit(input, 'desktop');
    readiness.mockResolvedValue('ready');
    harness.setDispatchImpl(() =>
      Promise.reject(new Error('Model is blocked by policy')),
    );
    await jest.advanceTimersByTimeAsync(1001);
    for (let i = 0; i < 20 && harness.dispatched.length === 0; i += 1)
      await jest.advanceTimersByTimeAsync(100);
    await jest.advanceTimersByTimeAsync(100);
    expect(harness.dispatched).toHaveLength(1);
    const settled = mutations.find(
      (mutation) => mutation.type === 'settle-agent-input',
    );
    expect(settled?.request.userMessageId).toBe('blocked-setup');
    expect(settled).toMatchObject({ reason: 'Model is blocked by policy' });
    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]
        ?.queue ?? [],
    ).toHaveLength(0);
  });

  it('cancels a setup input whose owner changes while pending and permits the next unrelated row', async () => {
    const harness = createHarness();
    const validation = jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    jest
      .spyOn(senderContext, 'agentSendTargetReadiness')
      .mockResolvedValue('pending');
    const input: ChatSendMessageRequest = {
      ...request('denied-setup', 'never delivered'),
      agentSendSetup: { version: 1 },
      agentSenderProvenance: {
        version: 1,
        capturedAt: '2026-10-17T00:00:00.000Z',
        acceptedInputId: 'denied-setup',
        sender: {
          kind: 'bot',
          botId: 'app_advisor',
          taskId: 'sender-task',
          chatId: 'sender-chat',
        },
        owner: { kind: 'none' },
      },
    };
    const mutations: ChatQueuePersistenceMutation[] = [];
    harness.setPersistRuntimeImpl((_target, _ids, _active, mutation) => {
      if (mutation) mutations.push(mutation);
    });
    await harness.service.submit(input, 'desktop');
    await harness.service.submit(
      request('unrelated-next', 'next input'),
      'desktop',
    );
    validation.mockRejectedValue(
      new senderContext.AgentSenderContextError(
        'owner_boundary',
        'Changed owner',
      ),
    );
    await jest.advanceTimersByTimeAsync(1001);
    expect(mutations).toContainEqual(
      expect.objectContaining({
        type: 'cancel',
        agentSendRefusalCode: 'owner_boundary',
      }),
    );
    expect(
      harness.dispatched.map(({ request }) => request.userMessageId),
    ).toEqual(['unrelated-next']);
  });

  it('hydrates unmarked phase-08 rows without adding a setup wait or changing their payload', async () => {
    const harness = createHarness();
    const input = request('old-unmarked', 'old ordinary text');
    harness.service.hydratePersistedInput(
      structuredClone(input),
      'old-ordinary-row',
      'desktop',
      123,
    );
    await harness.service.submit(request('next', 'later'), 'desktop');
    await jest.runOnlyPendingTimersAsync();
    expect(harness.dispatched[0]?.request).toEqual(input);
    expect(harness.dispatched[0]?.request).not.toHaveProperty('agentSendSetup');
  });

  it('preserves the setup marker through the frozen phase-08 JSON row projection and hydration', async () => {
    const harness = createHarness();
    jest
      .spyOn(senderContext, 'revalidateAgentSenderRequest')
      .mockResolvedValue(undefined);
    jest
      .spyOn(senderContext, 'agentSendTargetReadiness')
      .mockResolvedValue('pending');
    const row: PersistedHostQueuedMessage = {
      id: 'old-row',
      request: {
        ...request('persisted', 'hello'),
        agentSendSetup: { version: 1 },
        agentSent: {
          sender: {
            kind: 'bot',
            botId: 'app_advisor',
            taskId: 'sender-task',
            chatId: 'sender-chat',
          },
          chatTitle: 'Sender',
          projectLabel: 'App Advisor',
        },
        agentSenderProvenance: {
          version: 1,
          capturedAt: '2026-10-17T00:00:00.000Z',
          acceptedInputId: 'persisted',
          sender: {
            kind: 'bot',
            botId: 'app_advisor',
            taskId: 'sender-task',
            chatId: 'sender-chat',
          },
          owner: { kind: 'none' },
        },
        hiddenContext: {
          kind: 'agent-sender-context',
          text: 'Captured sender note',
        },
      },
      origin: 'desktop',
      enqueuedAtMs: 123,
    };
    // Frozen phase-08 queue projection retained request wholesale, including unknown fields.
    const phase08RoundTrip = ({
      id,
      request,
      origin,
      enqueuedAtMs,
    }: PersistedHostQueuedMessage): PersistedHostQueuedMessage =>
      structuredClone({ id, request, origin, enqueuedAtMs });
    const frozenRead = phase08RoundTrip(row);
    const phase08TargetGate = (request: ChatSendMessageRequest): void => {
      if (
        (request.agentSent ||
          request.agentSenderProvenance ||
          request.hiddenContext?.kind === 'agent-sender-context') &&
        request.projectId !== 'app-advisor'
      )
        throw new senderContext.AgentSenderContextError(
          'unsupported_action',
          'Agent sender context is not supported for this target runtime.',
        );
    };
    expect(() => phase08TargetGate(frozenRead.request)).toThrow(
      'Agent sender context is not supported',
    );
    let persisted: readonly PersistedHostQueuedMessage[] | undefined;
    harness.setPersistRuntimeImpl((_target, _ids, _active, _mutation, rows) => {
      persisted = rows;
    });
    harness.service.hydratePersistedInput(
      frozenRead.request,
      frozenRead.id,
      frozenRead.origin,
      frozenRead.enqueuedAtMs,
    );
    await harness.service.submit(request('ordinary', 'next'), 'desktop');
    await jest.runOnlyPendingTimersAsync();
    expect(harness.dispatched).toHaveLength(0);
    expect(persisted?.[0]?.request.agentSendSetup).toEqual({ version: 1 });
  });
});
