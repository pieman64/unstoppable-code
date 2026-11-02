/**
 * @jest-environment jsdom
 */
import {
  dispatchWorkspaceComments,
  submitWorkspaceComments,
} from '../submitWorkspaceComments';
import {
  useChatStore,
  type ChatTab,
  type QueuedChatMessage,
} from '@/stores/chatStore';
import type {
  ChatActivePlanContext,
  ChatSendMessageRequest,
} from '@canopy/desktop-shared/types';

const SCOPE = { projectId: 'proj-1', worktreeId: 'wt-1' };
const KEY = `${SCOPE.projectId}/${SCOPE.worktreeId}`;

type SendMessageOptions = {
  hiddenContext?: ChatSendMessageRequest['hiddenContext'];
  activePlan?: ChatActivePlanContext;
  composerAttachmentsReserved?: boolean;
  reservedRevertAttachmentPath?: string;
  throwOnDispatchFailure?: boolean;
  onDispatchAccepted?: () => void;
  onDispatchRejected?: () => void;
  onPreDispatchRejected?: () => void;
  onQueuedWithoutDispatch?: (queue: 'renderer' | 'host') => void;
};

const HIDDEN_CONTEXT: NonNullable<ChatSendMessageRequest['hiddenContext']> = {
  kind: 'file-comment-instructions',
  text: 'Context',
};

let loadTabsForTarget: jest.Mock;
let ensureWorktreeHasChatTab: jest.Mock;
let switchTab: jest.Mock;
let sendMessage: jest.Mock;

function tab(id: string, overrides: Partial<ChatTab> = {}): ChatTab {
  return {
    id,
    title: `Chat ${id}`,
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    ...overrides,
    fastModeExplicit: overrides.fastModeExplicit ?? false,
    modelConfig: overrides.modelConfig ?? {
      thinkingLevel: 'high',
      speed: 'standard',
      fastMode: false,
    },
  };
}

/** The target chat's renderer-local queue. */
function queuedMessages(chatId = 'chat-a'): QueuedChatMessage[] {
  return (
    useChatStore
      .getState()
      .worktreeChats[KEY]?.tabs.find((entry) => entry.id === chatId)
      ?.queuedMessages ?? []
  );
}

/**
 * Parks a send in the target chat's renderer-local queue the way `sendMessage`
 * does (setup queue, hook placeholder, failed Claude terminal launch): the
 * queued copy carries the send's `hiddenContext` by reference.
 */
function parkInRendererQueue(text: string, options: SendMessageOptions): void {
  useChatStore.setState((state) => {
    const scope = state.worktreeChats[KEY];
    if (!scope) return state;
    return {
      worktreeChats: {
        ...state.worktreeChats,
        [KEY]: {
          ...scope,
          tabs: scope.tabs.map((entry) =>
            entry.id === 'chat-a'
              ? {
                  ...entry,
                  queuedMessages: [
                    ...entry.queuedMessages,
                    {
                      text,
                      dispatchOptions: { hiddenContext: options.hiddenContext },
                    },
                  ],
                }
              : entry,
          ),
        },
      },
    };
  });
}

/** Waits `ms` real milliseconds and resolves with `sentinel` — used to prove a
 * promise has (or has not) settled yet without depending on fake timers. */
function timeoutSentinel<T>(ms: number, sentinel: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(sentinel), ms);
  });
}

beforeEach(() => {
  loadTabsForTarget = jest.fn().mockResolvedValue(undefined);
  ensureWorktreeHasChatTab = jest.fn().mockResolvedValue(undefined);
  switchTab = jest.fn();
  sendMessage = jest.fn().mockResolvedValue(undefined);
  useChatStore.setState({
    worktreeChats: {},
    loadTabsForTarget,
    ensureWorktreeHasChatTab,
    switchTab,
    sendMessage,
  });
});

describe('dispatchWorkspaceComments', () => {
  it('accepted dispatch targets the owning worktree chat and calls switchTab', async () => {
    useChatStore.setState({
      worktreeChats: {
        [KEY]: { tabs: [tab('chat-a')], activeTabId: 'chat-a' },
      },
    });
    let sentOptions: SendMessageOptions | undefined;
    sendMessage.mockImplementation(
      (
        _t: unknown,
        _f: unknown,
        _target: unknown,
        _mode: unknown,
        options: SendMessageOptions,
      ) => {
        sentOptions = options;
        options.onDispatchAccepted?.();
        return Promise.resolve();
      },
    );

    await expect(
      dispatchWorkspaceComments(SCOPE, 'hi', HIDDEN_CONTEXT),
    ).resolves.toEqual({ ok: true, chatId: 'chat-a' });

    expect(loadTabsForTarget).not.toHaveBeenCalled();
    expect(ensureWorktreeHasChatTab).not.toHaveBeenCalled();
    expect(switchTab).toHaveBeenCalledWith('chat-a', SCOPE);
    expect(sendMessage).toHaveBeenCalledWith(
      'hi',
      undefined,
      { ...SCOPE, chatId: 'chat-a' },
      undefined,
      expect.objectContaining({
        hiddenContext: HIDDEN_CONTEXT,
        throwOnDispatchFailure: true,
      }),
    );
    // The composer's staged attachments and revert summary belong to the
    // user's next message, never to a comment handoff: none are reserved.
    expect(sentOptions?.composerAttachmentsReserved).toBe(true);
    expect(sentOptions).not.toHaveProperty('reservedRevertAttachmentPath');
    // File and diagram comments are about no tracked plan.
    expect(sentOptions).not.toHaveProperty('activePlan');
  });

  it('sends to the requested chat over the active one, and only while it is loaded', async () => {
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          tabs: [tab('chat-a'), tab('chat-plan')],
          activeTabId: 'chat-a',
        },
      },
    });
    sendMessage.mockImplementation(
      (
        _t: unknown,
        _f: unknown,
        _target: unknown,
        _mode: unknown,
        options: SendMessageOptions,
      ) => {
        options.onDispatchAccepted?.();
        return Promise.resolve();
      },
    );

    await expect(
      dispatchWorkspaceComments(SCOPE, 'hi', HIDDEN_CONTEXT, {
        chatId: 'chat-plan',
      }),
    ).resolves.toEqual({ ok: true, chatId: 'chat-plan' });
    expect(switchTab).toHaveBeenCalledWith('chat-plan', SCOPE);
    expect(sendMessage).toHaveBeenCalledWith(
      'hi',
      undefined,
      { ...SCOPE, chatId: 'chat-plan' },
      undefined,
      expect.anything(),
    );

    // A requested chat that is gone refuses rather than redirecting the
    // comments to another chat.
    sendMessage.mockClear();
    await expect(
      dispatchWorkspaceComments(SCOPE, 'hi', HIDDEN_CONTEXT, {
        chatId: 'chat-closed',
      }),
    ).resolves.toEqual({ ok: false, reason: 'no-chat' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("forwards the plan panel's active plan, with the viewed revision, to sendMessage", async () => {
    useChatStore.setState({
      worktreeChats: {
        [KEY]: { tabs: [tab('chat-a')], activeTabId: 'chat-a' },
      },
    });
    const sentOptions: SendMessageOptions[] = [];
    sendMessage.mockImplementation(
      (
        _t: unknown,
        _f: unknown,
        _target: unknown,
        _mode: unknown,
        options: SendMessageOptions,
      ) => {
        sentOptions.push(options);
        options.onDispatchAccepted?.();
        return Promise.resolve();
      },
    );
    const activePlan: ChatActivePlanContext = {
      planId: 'plan-1',
      viewedRevisionNumber: 2,
    };

    await expect(
      dispatchWorkspaceComments(SCOPE, 'hi', HIDDEN_CONTEXT, { activePlan }),
    ).resolves.toEqual({ ok: true, chatId: 'chat-a' });
    await expect(
      submitWorkspaceComments(SCOPE, 'again', HIDDEN_CONTEXT, {
        activePlan: { planId: 'plan-2' },
      }),
    ).resolves.toBe(true);

    expect(sentOptions.map((options) => options.activePlan)).toEqual([
      { planId: 'plan-1', viewedRevisionNumber: 2 },
      { planId: 'plan-2' },
    ]);
    // The active plan rides beside the comment instructions, never inside.
    expect(sentOptions[0]?.hiddenContext).toEqual(HIDDEN_CONTEXT);
  });

  it('dispatches synchronously on the fast path (no await before sendMessage)', () => {
    useChatStore.setState({
      worktreeChats: {
        [KEY]: { tabs: [tab('chat-a')], activeTabId: 'chat-a' },
      },
    });
    sendMessage.mockImplementation(() => new Promise(() => {}));

    void dispatchWorkspaceComments(SCOPE, 'hi', HIDDEN_CONTEXT);

    // No microtask/await has run yet: these must already have happened
    // synchronously within the call above.
    expect(switchTab).toHaveBeenCalledWith('chat-a', SCOPE);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('RED: pre-dispatch rejection resolves { ok: false, reason: "rejected" } instead of hanging forever', async () => {
    useChatStore.setState({
      worktreeChats: {
        [KEY]: { tabs: [tab('chat-a')], activeTabId: 'chat-a' },
      },
    });
    sendMessage.mockImplementation(
      (
        _t: unknown,
        _f: unknown,
        _target: unknown,
        _mode: unknown,
        options: SendMessageOptions,
      ) => {
        options.onPreDispatchRejected?.();
        return Promise.resolve();
      },
    );

    const sentinel = Symbol('did-not-settle');
    const raced = await Promise.race([
      dispatchWorkspaceComments(SCOPE, 'hi', HIDDEN_CONTEXT),
      timeoutSentinel(200, sentinel),
    ]);

    expect(raced).toEqual({ ok: false, reason: 'rejected' });
  });

  it('RED: loads unloaded chats then creates a chat when none is editable', async () => {
    // No entry for KEY in worktreeChats at all.
    loadTabsForTarget.mockImplementation(() => {
      useChatStore.setState((state) => ({
        worktreeChats: {
          ...state.worktreeChats,
          [KEY]: {
            tabs: [tab('file-1', { kind: 'file', filePath: '/repo/a.ts' })],
            activeTabId: 'file-1',
          },
        },
      }));
      return Promise.resolve();
    });
    ensureWorktreeHasChatTab.mockImplementation(() => {
      useChatStore.setState((state) => ({
        worktreeChats: {
          ...state.worktreeChats,
          [KEY]: { tabs: [tab('new-chat')], activeTabId: 'new-chat' },
        },
      }));
      return Promise.resolve();
    });
    sendMessage.mockImplementation(
      (
        _t: unknown,
        _f: unknown,
        _target: unknown,
        _mode: unknown,
        options: SendMessageOptions,
      ) => {
        options.onDispatchAccepted?.();
        return Promise.resolve();
      },
    );

    await expect(
      dispatchWorkspaceComments(SCOPE, 'hi', HIDDEN_CONTEXT),
    ).resolves.toEqual({ ok: true, chatId: 'new-chat' });

    expect(loadTabsForTarget).toHaveBeenCalledWith('proj-1', 'wt-1');
    expect(ensureWorktreeHasChatTab).toHaveBeenCalledWith(SCOPE);
    expect(switchTab).toHaveBeenCalledWith('new-chat', SCOPE);
  });

  it('resolves { ok: false, reason: "no-chat" } when creation does not produce an editable chat', async () => {
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          tabs: [tab('file-1', { kind: 'file', filePath: '/repo/a.ts' })],
          activeTabId: 'file-1',
        },
      },
    });
    // ensureWorktreeHasChatTab resolves without adding an editable tab.

    await expect(
      dispatchWorkspaceComments(SCOPE, 'hi', HIDDEN_CONTEXT),
    ).resolves.toEqual({ ok: false, reason: 'no-chat' });

    expect(ensureWorktreeHasChatTab).toHaveBeenCalledWith(SCOPE);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(switchTab).not.toHaveBeenCalled();
  });

  it('resolves { ok: false, reason: "no-chat" } when resolving the owning chat throws', async () => {
    useChatStore.setState({ worktreeChats: {} });
    loadTabsForTarget.mockRejectedValue(new Error('load failed'));

    await expect(
      dispatchWorkspaceComments(SCOPE, 'hi', HIDDEN_CONTEXT),
    ).resolves.toEqual({ ok: false, reason: 'no-chat' });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  describe('when the send is parked instead of dispatched', () => {
    /** Someone else's queued message, sharing the caller's context object. */
    const unrelated: QueuedChatMessage = {
      text: 'earlier draft',
      dispatchOptions: { hiddenContext: HIDDEN_CONTEXT },
    };

    beforeEach(() => {
      useChatStore.setState({
        worktreeChats: {
          [KEY]: {
            tabs: [tab('chat-a', { queuedMessages: [unrelated] })],
            activeTabId: 'chat-a',
          },
        },
      });
    });

    it('RED: a failed Claude launch that leaves the comments in the renderer queue is not sent, and withdraws them', async () => {
      sendMessage.mockImplementation(
        (
          text: string,
          _f: unknown,
          _target: unknown,
          _mode: unknown,
          options: SendMessageOptions,
        ) => {
          parkInRendererQueue(text, options);
          // The launch fails after sendMessage returns; acceptance never fires.
          setTimeout(() => options.onQueuedWithoutDispatch?.('renderer'), 0);
          return Promise.resolve();
        },
      );

      await expect(
        dispatchWorkspaceComments(SCOPE, 'hi', HIDDEN_CONTEXT),
      ).resolves.toEqual({ ok: false, reason: 'rejected' });
      // Nothing is left behind to duplicate a retry, and nobody else's
      // queued message is touched.
      expect(queuedMessages()).toEqual([unrelated]);
    });

    it('RED: a setup or hook queue that accepts then parks the comments is not sent, and withdraws them', async () => {
      sendMessage.mockImplementation(
        (
          text: string,
          _f: unknown,
          _target: unknown,
          _mode: unknown,
          options: SendMessageOptions,
        ) => {
          parkInRendererQueue(text, options);
          options.onDispatchAccepted?.();
          options.onQueuedWithoutDispatch?.('renderer');
          return Promise.resolve();
        },
      );

      await expect(
        dispatchWorkspaceComments(SCOPE, 'hi', HIDDEN_CONTEXT),
      ).resolves.toEqual({ ok: false, reason: 'rejected' });
      expect(queuedMessages()).toEqual([unrelated]);
    });

    it('is sent when the host queue owns the comments', async () => {
      sendMessage.mockImplementation(
        (
          _t: unknown,
          _f: unknown,
          _target: unknown,
          _mode: unknown,
          options: SendMessageOptions,
        ) => {
          options.onDispatchAccepted?.();
          options.onQueuedWithoutDispatch?.('host');
          return Promise.resolve();
        },
      );

      await expect(
        dispatchWorkspaceComments(SCOPE, 'hi', HIDDEN_CONTEXT),
      ).resolves.toEqual({ ok: true, chatId: 'chat-a' });
      expect(queuedMessages()).toEqual([unrelated]);
    });

    it('RED: is not sent when a renderer queue report finds no queued copy', async () => {
      sendMessage.mockImplementation(
        (
          _t: unknown,
          _f: unknown,
          _target: unknown,
          _mode: unknown,
          options: SendMessageOptions,
        ) => {
          // Comments never ask for the setup queue's immediate flush, so a
          // missing copy was removed (deleted bubble, closed or rebuilt tab),
          // not dispatched.
          options.onDispatchAccepted?.();
          options.onQueuedWithoutDispatch?.('renderer');
          return Promise.resolve();
        },
      );

      await expect(
        dispatchWorkspaceComments(SCOPE, 'hi', HIDDEN_CONTEXT),
      ).resolves.toEqual({ ok: false, reason: 'rejected' });
      expect(queuedMessages()).toEqual([unrelated]);
    });

    it('RED: a launch that fails after the user removed the queued copy is not sent', async () => {
      sendMessage.mockImplementation(
        (
          text: string,
          _f: unknown,
          _target: unknown,
          _mode: unknown,
          options: SendMessageOptions,
        ) => {
          parkInRendererQueue(text, options);
          setTimeout(() => {
            // The user deletes the queued bubble, then the launch fails.
            useChatStore.getState().clearQueuedMessage(1, {
              ...SCOPE,
              chatId: 'chat-a',
            });
            options.onQueuedWithoutDispatch?.('renderer');
          }, 0);
          return Promise.resolve();
        },
      );

      await expect(
        dispatchWorkspaceComments(SCOPE, 'hi', HIDDEN_CONTEXT),
      ).resolves.toEqual({ ok: false, reason: 'rejected' });
      expect(queuedMessages()).toEqual([unrelated]);
    });

    it('keeps a sent result, and the queued copy, when a renderer report arrives after acceptance settled', async () => {
      sendMessage.mockImplementation(
        (
          text: string,
          _f: unknown,
          _target: unknown,
          _mode: unknown,
          options: SendMessageOptions,
        ) => {
          parkInRendererQueue(text, options);
          // The terminal accepted the prompt; the launch fails later.
          options.onDispatchAccepted?.();
          setTimeout(() => options.onQueuedWithoutDispatch?.('renderer'), 0);
          return Promise.resolve();
        },
      );

      await expect(
        dispatchWorkspaceComments(SCOPE, 'hi', HIDDEN_CONTEXT),
      ).resolves.toEqual({ ok: true, chatId: 'chat-a' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(queuedMessages()).toHaveLength(2);
    });

    it('RED: submitWorkspaceComments reports renderer-queued comments as not sent', async () => {
      sendMessage.mockImplementation(
        (
          text: string,
          _f: unknown,
          _target: unknown,
          _mode: unknown,
          options: SendMessageOptions,
        ) => {
          parkInRendererQueue(text, options);
          options.onDispatchAccepted?.();
          options.onQueuedWithoutDispatch?.('renderer');
          return Promise.resolve();
        },
      );

      await expect(
        submitWorkspaceComments(SCOPE, 'hi', HIDDEN_CONTEXT),
      ).resolves.toBe(false);
      expect(queuedMessages()).toEqual([unrelated]);
    });
  });

  it('resolves { ok: false, reason: "rejected" } when dispatch is rejected after being enqueued', async () => {
    useChatStore.setState({
      worktreeChats: {
        [KEY]: { tabs: [tab('chat-a')], activeTabId: 'chat-a' },
      },
    });
    sendMessage.mockImplementation(
      (
        _t: unknown,
        _f: unknown,
        _target: unknown,
        _mode: unknown,
        options: SendMessageOptions,
      ) => {
        options.onDispatchRejected?.();
        return Promise.resolve();
      },
    );

    await expect(
      dispatchWorkspaceComments(SCOPE, 'hi', HIDDEN_CONTEXT),
    ).resolves.toEqual({ ok: false, reason: 'rejected' });
  });

  it('resolves { ok: false, reason: "rejected" } when sendMessage throws', async () => {
    useChatStore.setState({
      worktreeChats: {
        [KEY]: { tabs: [tab('chat-a')], activeTabId: 'chat-a' },
      },
    });
    sendMessage.mockRejectedValue(new Error('provider unavailable'));

    await expect(
      dispatchWorkspaceComments(SCOPE, 'hi', HIDDEN_CONTEXT),
    ).resolves.toEqual({ ok: false, reason: 'rejected' });
  });

  it('does not settle merely because sendMessage resolves (Claude terminal-launch path)', async () => {
    useChatStore.setState({
      worktreeChats: {
        [KEY]: { tabs: [tab('chat-a')], activeTabId: 'chat-a' },
      },
    });
    let acceptLater: (() => void) | undefined;
    sendMessage.mockImplementation(
      (
        _t: unknown,
        _f: unknown,
        _target: unknown,
        _mode: unknown,
        options: SendMessageOptions,
      ) => {
        acceptLater = options.onDispatchAccepted;
        // sendMessage's own await resolves immediately, before acceptance.
        return Promise.resolve();
      },
    );

    const pending = dispatchWorkspaceComments(SCOPE, 'hi', HIDDEN_CONTEXT);
    const sentinel = Symbol('still-pending');
    const raced = await Promise.race([pending, timeoutSentinel(50, sentinel)]);
    expect(raced).toBe(sentinel);

    acceptLater?.();
    await expect(pending).resolves.toEqual({ ok: true, chatId: 'chat-a' });
  });
});

describe('submitWorkspaceComments', () => {
  it('resolves false on pre-dispatch rejection instead of hanging', async () => {
    useChatStore.setState({
      worktreeChats: {
        [KEY]: { tabs: [tab('chat-a')], activeTabId: 'chat-a' },
      },
    });
    sendMessage.mockImplementation(
      (
        _t: unknown,
        _f: unknown,
        _target: unknown,
        _mode: unknown,
        options: SendMessageOptions,
      ) => {
        options.onPreDispatchRejected?.();
        return Promise.resolve();
      },
    );

    const sentinel = 'did-not-settle';
    const raced = await Promise.race([
      submitWorkspaceComments(SCOPE, 'hi', HIDDEN_CONTEXT),
      timeoutSentinel(200, sentinel),
    ]);

    expect(raced).toBe(false);
  });

  it('resolves true when dispatch is accepted', async () => {
    useChatStore.setState({
      worktreeChats: {
        [KEY]: { tabs: [tab('chat-a')], activeTabId: 'chat-a' },
      },
    });
    sendMessage.mockImplementation(
      (
        _t: unknown,
        _f: unknown,
        _target: unknown,
        _mode: unknown,
        options: SendMessageOptions,
      ) => {
        options.onDispatchAccepted?.();
        return Promise.resolve();
      },
    );

    await expect(
      submitWorkspaceComments(SCOPE, 'hi', HIDDEN_CONTEXT),
    ).resolves.toBe(true);
  });

  it('resolves false when dispatch is rejected', async () => {
    useChatStore.setState({
      worktreeChats: {
        [KEY]: { tabs: [tab('chat-a')], activeTabId: 'chat-a' },
      },
    });
    sendMessage.mockImplementation(
      (
        _t: unknown,
        _f: unknown,
        _target: unknown,
        _mode: unknown,
        options: SendMessageOptions,
      ) => {
        options.onDispatchRejected?.();
        return Promise.resolve();
      },
    );

    await expect(
      submitWorkspaceComments(SCOPE, 'hi', HIDDEN_CONTEXT),
    ).resolves.toBe(false);
  });

  it('resolves false when no chat exists or can be created', async () => {
    useChatStore.setState({
      worktreeChats: { [KEY]: { tabs: [], activeTabId: '' } },
    });

    await expect(
      submitWorkspaceComments(SCOPE, 'hi', HIDDEN_CONTEXT),
    ).resolves.toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
