/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const mockRefreshChargedTurn = jest.fn();
const mockInvalidateAvailability = jest.fn();
const mockInvalidateUsage = jest.fn();
const mockInvalidateSharedRead = jest.fn();

jest.mock('@/hooks/useAiCreditsAvailability', () => ({
  get invalidateAiCreditsAvailabilityCache(): typeof mockInvalidateAvailability {
    return mockInvalidateAvailability;
  },
}));
jest.mock('@/hooks/useAiCreditsUsage', () => ({
  get invalidateAiCreditsUsageCache(): typeof mockInvalidateUsage {
    return mockInvalidateUsage;
  },
  get refreshAiCreditsAfterChargedTurn(): typeof mockRefreshChargedTurn {
    return mockRefreshChargedTurn;
  },
}));
// The THIRD AI-Credits cache. It gates whether `ModelRecoveryModal` auto-commits
// a model on coverage, so an exhaustion event that dropped the other two but not
// this one would leave a click after exhaustion able to commit a model whose
// credits are gone.
jest.mock('@/lib/openBillingPage', () => ({
  get invalidateSharedAiCreditsRead(): typeof mockInvalidateSharedRead {
    return mockInvalidateSharedRead;
  },
}));

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useChatEventSubscriptions } from '../useChatEventSubscriptions';
import { useChatStore } from '@/stores/chatStore';
import { useTransientRetryBannerStore } from '@/stores/transientRetryBannerStore';
import { useIngestionLagStore } from '@/stores/ingestionLagStore';
import { useAiCreditsBannerStore } from '@/stores/aiCreditsBannerStore';
import type { ChatEvent } from '@canopy/desktop-shared/types';
import { AI_CREDITS_NO_BILLING_SOURCE_EVENT_TYPE } from '@canopy/desktop-shared/types';

const defaultHandleChatEvent = useChatStore.getState().handleChatEvent;

function HookHarness(): null {
  useChatEventSubscriptions();
  return null;
}

describe('useChatEventSubscriptions', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalApi: Window['api'] | undefined;
  const unsubscribe = jest.fn();
  const getTransientRetrySnapshot = jest.fn();
  const pendingRequests = jest.fn();
  let chatEventHandler: ((event: ChatEvent) => void) | null;

  beforeEach(() => {
    jest.clearAllMocks();
    chatEventHandler = null;
    pendingRequests.mockResolvedValue([]);
    useChatStore.setState({
      pendingApprovals: {},
      worktreeChats: {},
      selectedWorktree: null,
      handleChatEvent: defaultHandleChatEvent,
    });
    useIngestionLagStore.setState({ lagByChat: {} });
    getTransientRetrySnapshot.mockResolvedValue([
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        data: {
          type: 'canopy_transient_retry_state',
          provider: 'claude',
          active: true,
          attempt: 2,
          maxAttempts: 5,
          nextRetryAt: 61_000,
          exhausted: false,
        },
      },
    ]);
    useTransientRetryBannerStore.setState({ stateByChat: {} });
    useAiCreditsBannerStore.setState({
      routingActiveByChat: {},
      usageLimitByChat: {},
      noBillingSourceByChat: {},
      dismissedUsageLimitKeyByChat: {},
    });
    originalApi = window.api;
    const subscribe = jest.fn(() => unsubscribe);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        approvals: {
          pendingRequests,
          onRequest: subscribe,
          onCancelled: subscribe,
          onAutoResolved: subscribe,
          onRuleAdded: subscribe,
        },
        chat: {
          onChatQueueUpdated: subscribe,
          onChatEvent: jest.fn((handler: (event: ChatEvent) => void) => {
            chatEventHandler = handler;
            return unsubscribe;
          }),
          onScheduledTerminalPrompt: subscribe,
          onHookTabStarted: subscribe,
          onChatSessionImported: subscribe,
          onMcpAskUser: subscribe,
          onMcpExpireAskUser: subscribe,
          onPlanExitRequest: subscribe,
          onTabDescriptionUpdated: subscribe,
          onDeferredToolsReloadEvent: subscribe,
          getTransientRetrySnapshot,
          loadTabs: jest.fn().mockResolvedValue({
            version: 1,
            tabs: [],
            activeTabId: '',
          }),
        },
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    if (originalApi === undefined) {
      Reflect.deleteProperty(window, 'api');
    } else {
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: originalApi,
      });
    }
  });

  it('hydrates retry banners that were active before the renderer loaded', async () => {
    await act(async () => {
      root.render(createElement(HookHarness));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getTransientRetrySnapshot).toHaveBeenCalledTimes(1);
    expect(
      useTransientRetryBannerStore.getState().stateByChat[
        'project-1/worktree-1/chat-1'
      ],
    ).toMatchObject({
      provider: 'claude',
      attempt: 2,
      maxAttempts: 5,
      nextRetryAt: 61_000,
    });
  });

  it('preserves approvals hydrated after the subscription mounts', async () => {
    await act(async () => {
      root.render(createElement(HookHarness));
      await Promise.resolve();
    });

    await act(async () => {
      useChatStore.setState({
        pendingApprovals: {
          stale: {
            requestId: 'stale',
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            chatId: 'chat-1',
            provider: 'claude',
            title: 'Run command',
            details: { kind: 'command', command: 'pwd' },
          },
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useChatStore.getState().pendingApprovals).toHaveProperty('stale');
    expect(pendingRequests).not.toHaveBeenCalled();
  });

  it('does not restore a retry cleared while snapshot hydration is pending', async () => {
    let resolveSnapshot = (): void => undefined;
    getTransientRetrySnapshot.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSnapshot = (): void =>
          resolve([
            {
              projectId: 'project-1',
              worktreeId: 'worktree-1',
              chatId: 'chat-1',
              data: {
                type: 'canopy_transient_retry_state',
                provider: 'claude',
                active: true,
                attempt: 2,
                maxAttempts: 5,
                nextRetryAt: 61_000,
                exhausted: false,
              },
            },
          ]);
      }),
    );

    await act(async () => {
      root.render(createElement(HookHarness));
      await Promise.resolve();
    });
    act(() => {
      chatEventHandler?.({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        data: {
          type: 'canopy_transient_retry_state',
          provider: 'claude',
          active: false,
          attempt: 2,
          maxAttempts: 5,
          nextRetryAt: null,
          exhausted: false,
        },
      });
    });
    await act(async () => {
      resolveSnapshot();
      await Promise.resolve();
    });

    expect(
      useTransientRetryBannerStore.getState().stateByChat[
        'project-1/worktree-1/chat-1'
      ],
    ).toBeUndefined();
  });

  // ECW-9091. The backstop aborts the turn before any provider request, so no
  // usage-limit event ever fires to invalidate the renderer's caches. Without
  // this branch the banner (60s renderer cache) can stay hidden while the
  // backstop (30s main cache) is already aborting — a send where nothing at all
  // appears to happen. Dropping both cached reads is what makes the error code
  // an actual signal rather than an inert marker. All THREE cached reads go:
  // the availability cache, the usage cache, and the recovery flows' retained
  // shared answer.
  it('drops all three cached AI Credits reads on a no-billing-source abort', async () => {
    await act(async () => {
      root.render(createElement(HookHarness));
      await Promise.resolve();
    });

    act(() => {
      chatEventHandler?.({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        data: {
          type: 'error',
          error_code: 'no_billing_source',
          error: "You're not signed in and have no AI Credits available.",
        },
      });
    });

    expect(mockInvalidateAvailability).toHaveBeenCalledTimes(1);
    expect(mockInvalidateUsage).toHaveBeenCalledTimes(1);
    expect(mockInvalidateSharedRead).toHaveBeenCalledTimes(1);
  });

  it('drops all three cached AI Credits reads when credits are exhausted', async () => {
    // The usage-limit branch had no coverage at all, so the recovery flows'
    // retained answer could survive the exhaustion that invalidated the other
    // two caches.
    await act(async () => {
      root.render(createElement(HookHarness));
      await Promise.resolve();
    });

    act(() => {
      chatEventHandler?.({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        data: {
          type: 'canopy_usage_limit_reached',
          provider: 'claude',
          resetsAt: 1_800_000_000_000,
        },
      });
    });

    expect(mockInvalidateAvailability).toHaveBeenCalledTimes(1);
    expect(mockInvalidateUsage).toHaveBeenCalledTimes(1);
    expect(mockInvalidateSharedRead).toHaveBeenCalledTimes(1);
  });

  // CAN-2413. The seam between the main-process emitter
  // (`emitAiCreditsNoBillingSource`) and the composer banner: the runtime 402
  // signal is a DIFFERENT event type from the pre-flight abort above, and it
  // has to reach the target-keyed store or the banner never renders for the
  // failure it exists to explain.
  it('records the runtime no-billing-source signal and drops both cached reads', async () => {
    await act(async () => {
      root.render(createElement(HookHarness));
      await Promise.resolve();
    });

    act(() => {
      chatEventHandler?.({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        data: {
          type: AI_CREDITS_NO_BILLING_SOURCE_EVENT_TYPE,
          provider: 'codex',
        },
      });
    });

    expect(
      useAiCreditsBannerStore.getState().noBillingSourceByChat[
        'project-1/worktree-1/chat-1'
      ],
    ).toMatchObject({ provider: 'codex' });
    expect(mockInvalidateAvailability).toHaveBeenCalledTimes(1);
    expect(mockInvalidateUsage).toHaveBeenCalledTimes(1);
  });

  it.each([
    { type: 'result', is_error: false },
    { type: 'result', is_error: true },
    { type: 'result', is_error: true, terminal_reason: 'aborted_streaming' },
    { type: 'codex', event: { type: 'turn.completed' } },
    { type: 'codex', event: { type: 'turn.failed' } },
  ])(
    'refreshes a charged terminal event once without a mounted composer: %j',
    async (data) => {
      await act(async () => {
        root.render(createElement(HookHarness));
        await Promise.resolve();
      });
      const emit = (eventData: unknown): void => {
        chatEventHandler?.({
          projectId: 'no-project',
          worktreeId: 'w',
          chatId: 'c',
          data: eventData,
        });
      };
      act(() => {
        emit({ type: 'canopy_user_prompt', text: 'hello' });
        // Fallback can start after the native turn, and turn off before the terminal event.
        emit({
          type: 'canopy_ai_credits_routing',
          provider: 'codex',
          active: true,
        });
        emit({
          type: 'canopy_ai_credits_routing',
          provider: 'codex',
          active: false,
        });
        emit(data);
        emit(data);
      });
      expect(mockRefreshChargedTurn).toHaveBeenCalledTimes(1);
      act(() => {
        emit({
          type: 'canopy_ai_credits_routing',
          provider: 'codex',
          active: true,
        });
        emit(data);
      });
      mockRefreshChargedTurn.mockClear();
      // Persistent provider sessions report routing at spawn, not every turn.
      act(() => {
        emit({ type: 'canopy_user_prompt', text: 'follow-up' });
        emit(data);
        emit(data);
      });
      expect(mockRefreshChargedTurn).toHaveBeenCalledTimes(1);
    },
  );

  it('leaves the AI Credits caches alone for an unrelated chat error', async () => {
    await act(async () => {
      root.render(createElement(HookHarness));
      await Promise.resolve();
    });

    act(() => {
      chatEventHandler?.({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        data: { type: 'error', error: 'something else went wrong' },
      });
    });

    expect(mockInvalidateAvailability).not.toHaveBeenCalled();
    expect(mockInvalidateUsage).not.toHaveBeenCalled();
    expect(mockInvalidateSharedRead).not.toHaveBeenCalled();
  });

  it('stores ingestion-lag events before chat routing, including a clear', async () => {
    const handleChatEvent = jest.fn<void, [ChatEvent]>();
    useChatStore.setState({ handleChatEvent });

    await act(async () => {
      root.render(createElement(HookHarness));
      await Promise.resolve();
    });

    const target = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'not-hydrated',
    };
    expect(useChatStore.getState().worktreeChats).toEqual({});
    act(() => {
      chatEventHandler?.({
        ...target,
        data: {
          type: 'canopy_ingestion_lag',
          lag: {
            lagMs: 750,
            source: 'provider',
            sampledAtMs: 1234,
            catchingUp: true,
          },
        },
      });
    });

    expect(
      useIngestionLagStore.getState().lagByChat[
        'project-1/worktree-1/not-hydrated'
      ],
    ).toMatchObject({ ...target, lag: { lagMs: 750, catchingUp: true } });
    expect(handleChatEvent).not.toHaveBeenCalled();

    act(() => {
      chatEventHandler?.({
        ...target,
        data: { type: 'canopy_ingestion_lag', lag: null },
      });
    });

    expect(
      useIngestionLagStore.getState().lagByChat[
        'project-1/worktree-1/not-hydrated'
      ],
    ).toBeUndefined();
    expect(handleChatEvent).not.toHaveBeenCalled();
  });

  it('ignores invalid ingestion-lag payloads but routes unrelated events', async () => {
    const handleChatEvent = jest.fn<void, [ChatEvent]>();
    useChatStore.setState({ handleChatEvent });
    const target = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'not-hydrated',
    };
    useIngestionLagStore.getState().setLag(target, {
      lagMs: 400,
      source: 'receipt',
      sampledAtMs: 1200,
      catchingUp: true,
    });
    const priorEntry =
      useIngestionLagStore.getState().lagByChat[
        'project-1/worktree-1/not-hydrated'
      ];

    await act(async () => {
      root.render(createElement(HookHarness));
      await Promise.resolve();
    });

    act(() => {
      chatEventHandler?.({
        ...target,
        data: {
          type: 'canopy_ingestion_lag',
          lag: {
            lagMs: -1,
            source: 'provider',
            sampledAtMs: 1300,
            catchingUp: true,
          },
        },
      });
      chatEventHandler?.({
        ...target,
        data: { type: 'canopy_ingestion_lag' },
      });
    });

    expect(
      useIngestionLagStore.getState().lagByChat[
        'project-1/worktree-1/not-hydrated'
      ],
    ).toBe(priorEntry);
    expect(handleChatEvent).not.toHaveBeenCalled();

    const unrelatedEvent: ChatEvent = {
      ...target,
      data: { type: 'ordinary_chat_event' },
    };
    act(() => chatEventHandler?.(unrelatedEvent));

    expect(handleChatEvent).toHaveBeenCalledWith(unrelatedEvent);
  });
});
