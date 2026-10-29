import type {
  CanopyClient,
  DomainEventMap,
  DomainEventName,
  QueryMap,
  QueryName,
  CommandMap,
  CommandName,
  Unsubscribe,
} from '@canopy/app-core';
import type { PortalChatMessage } from '@canopy/protocol/portal';
import {
  batchChatStoreUpdates,
  createChatStore as createInactiveChatStore,
  type ChatStoreState,
} from '../create-chat-store';
import {
  CLIENT_STORE_ACTIVATE,
  CLIENT_STORE_DISPOSE,
  type ClientStore,
} from '../../create-client-store';
import {
  CHAT_SEMANTIC_STALE_MS,
  configureChatRepairRequester,
  type ChatRepairRequest,
} from '../chat-repair';

type HandlerMap = {
  [K in DomainEventName]?: Array<(event: DomainEventMap[K]) => void>;
};

interface RecordedCommand {
  name: CommandName;
  args: unknown;
}

interface MockClient {
  client: CanopyClient;
  emit<K extends DomainEventName>(name: K, event: DomainEventMap[K]): void;
  subscribeCalls: DomainEventName[];
  unsubscribeCalls: DomainEventName[];
  commandCalls: RecordedCommand[];
}

function createMockClient(): MockClient {
  const handlers: HandlerMap = {};
  const subscribeCalls: DomainEventName[] = [];
  const unsubscribeCalls: DomainEventName[] = [];
  const commandCalls: RecordedCommand[] = [];

  const client: CanopyClient = {
    capabilities: {
      localExecution: true,
      terminalPty: true,
      fileSystemAccess: 'read-write',
      voice: false,
      settingsScope: 'full',
      pipelines: 'execute',
      routing: 'in-memory',
      overviewNotifications: true,
    },
    query<K extends QueryName>(): Promise<QueryMap[K]['result']> {
      return Promise.reject(new Error('query is not exercised in this test'));
    },
    command<K extends CommandName>(
      name: K,
      args: CommandMap[K]['args'],
    ): Promise<CommandMap[K]['result']> {
      commandCalls.push({ name, args });
      // The store treats persistence as best-effort and catches rejections; the
      // tests assert the call was made, not its resolution.
      return Promise.reject(new Error('command result not used in this test'));
    },
    subscribe<K extends DomainEventName>(
      name: K,
      handler: (event: DomainEventMap[K]) => void,
    ): Unsubscribe {
      subscribeCalls.push(name);
      const list = (handlers[name] ??= []);
      list.push(handler);
      return (): void => {
        unsubscribeCalls.push(name);
        handlers[name] = list.filter((h) => h !== handler);
      };
    },
  };

  return {
    client,
    emit(name, event): void {
      for (const handler of handlers[name] ?? []) {
        handler(event);
      }
    },
    subscribeCalls,
    unsubscribeCalls,
    commandCalls,
  };
}

function createChatStore(client: CanopyClient): ClientStore<ChatStoreState> {
  const store = createInactiveChatStore(client);
  store[CLIENT_STORE_ACTIVATE]?.();
  return store;
}

function chatMessage(
  partial: Partial<PortalChatMessage> &
    Pick<PortalChatMessage, 'messageId' | 'role'>,
): PortalChatMessage {
  return {
    chatId: 'c1',
    status: 'complete',
    text: '',
    createdAtMs: 0,
    ...partial,
  };
}

describe('createChatStore', () => {
  it('does not repair an old unmatched tool use when the latest turn is clean', () => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
    const mock = createMockClient();
    const repairs = jest.fn<void, [ChatRepairRequest]>();
    configureChatRepairRequester(mock.client, repairs);
    const store = createChatStore(mock.client);
    mock.emit('chat.message', {
      occurredAt: new Date().toISOString(),
      scope: 'worktree',
      workspaceLocalId: 'ws',
      worktreeLocalId: 'wt',
      chatId: 'c1',
      message: chatMessage({
        messageId: 'old-assistant-tool',
        role: 'assistant',
        createdAtMs: Date.now(),
        parts: [{ kind: 'tool_use' }],
      }),
    });
    mock.emit('chat.message', {
      occurredAt: new Date().toISOString(),
      scope: 'worktree',
      workspaceLocalId: 'ws',
      worktreeLocalId: 'wt',
      chatId: 'c1',
      message: chatMessage({
        messageId: 'latest-user',
        role: 'user',
        createdAtMs: Date.now() + 1,
      }),
    });
    mock.emit('chat.message', {
      occurredAt: new Date().toISOString(),
      scope: 'worktree',
      workspaceLocalId: 'ws',
      worktreeLocalId: 'wt',
      chatId: 'c1',
      message: chatMessage({
        messageId: 'latest-assistant',
        role: 'assistant',
        createdAtMs: Date.now() + 2,
      }),
    });
    jest.advanceTimersByTime(CHAT_SEMANTIC_STALE_MS);
    expect(repairs).not.toHaveBeenCalled();
    store[CLIENT_STORE_DISPOSE]?.();
    jest.useRealTimers();
  });

  it('repairs a latest-turn unmatched tool use once after silence', () => {
    jest.useFakeTimers();
    jest.setSystemTime(1_250_000);
    const mock = createMockClient();
    const repairs = jest.fn();
    configureChatRepairRequester(mock.client, repairs);
    const store = createChatStore(mock.client);
    mock.emit('chat.message', {
      occurredAt: new Date().toISOString(),
      scope: 'worktree',
      workspaceLocalId: 'ws',
      worktreeLocalId: 'wt',
      chatId: 'c1',
      message: chatMessage({
        messageId: 'latest-user',
        role: 'user',
        createdAtMs: Date.now(),
      }),
    });
    const unmatchedTool = chatMessage({
      messageId: 'latest-tool',
      role: 'assistant',
      createdAtMs: Date.now(),
      parts: [{ kind: 'tool_use' }],
    });
    mock.emit('chat.message', {
      occurredAt: new Date().toISOString(),
      scope: 'worktree',
      workspaceLocalId: 'ws',
      worktreeLocalId: 'wt',
      chatId: 'c1',
      message: unmatchedTool,
    });

    jest.advanceTimersByTime(CHAT_SEMANTIC_STALE_MS);
    expect(repairs).toHaveBeenCalledTimes(1);
    expect(repairs).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'c1',
        scope: 'worktree',
        workspaceLocalId: 'ws',
        worktreeLocalId: 'wt',
        trigger: 'semantic',
      }),
    );
    store[CLIENT_STORE_DISPOSE]?.();
    jest.useRealTimers();
  });

  it.each(['ingest', 'hydrate'] as const)(
    'schedules semantic repair from the final batched %s state',
    (method) => {
      jest.useFakeTimers();
      jest.setSystemTime(1_275_000);
      const mock = createMockClient();
      const repairs = jest.fn();
      configureChatRepairRequester(mock.client, repairs);
      const store = createChatStore(mock.client);
      const user = chatMessage({
        messageId: 'latest-user',
        role: 'user',
        createdAtMs: Date.now(),
      });
      store.getState().hydrate('c1', [user]);
      const notify = jest.fn();
      const unsubscribe = store.subscribe(notify);
      const tool = chatMessage({
        messageId: 'latest-tool',
        role: 'assistant',
        createdAtMs: Date.now() + 1,
        parts: [{ kind: 'tool_use' }],
      });
      const apply = (message: PortalChatMessage): void => {
        if (method === 'hydrate')
          store.getState().hydrate('c1', [user, message]);
        else
          mock.emit('chat.message', {
            occurredAt: new Date().toISOString(),
            scope: 'worktree',
            workspaceLocalId: 'ws',
            worktreeLocalId: 'wt',
            chatId: 'c1',
            message,
          });
      };
      try {
        batchChatStoreUpdates(() => {
          apply(tool);
          batchChatStoreUpdates(() => apply({ ...tool, text: 'Running' }));
          expect(notify).not.toHaveBeenCalled();
        });
        expect(notify).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(CHAT_SEMANTIC_STALE_MS);
        expect(repairs).toHaveBeenCalledTimes(1);
        expect(repairs).toHaveBeenCalledWith(
          expect.objectContaining({
            chatId: 'c1',
            trigger: 'semantic',
          }),
        );
        jest.advanceTimersByTime(CHAT_SEMANTIC_STALE_MS);
        expect(repairs).toHaveBeenCalledTimes(1);

        repairs.mockClear();
        notify.mockClear();
        batchChatStoreUpdates(() => {
          apply({ ...tool, updatedAtMs: Date.now() + 2 });
          apply({
            ...tool,
            updatedAtMs: Date.now() + 3,
            parts: [{ kind: 'tool_use', data: { result: 'done' } }],
          });
        });
        expect(notify).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(CHAT_SEMANTIC_STALE_MS);
        expect(repairs).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
        store[CLIENT_STORE_DISPOSE]?.();
        jest.useRealTimers();
      }
    },
  );

  it('does not repeat repair after an identical authoritative replay', () => {
    jest.useFakeTimers();
    jest.setSystemTime(1_350_000);
    const mock = createMockClient();
    const repairs = jest.fn();
    configureChatRepairRequester(mock.client, repairs);
    const store = createChatStore(mock.client);
    const unmatchedTool = chatMessage({
      messageId: 'latest-tool',
      role: 'assistant',
      createdAtMs: Date.now(),
      parts: [{ kind: 'tool_use' }],
    });
    mock.emit('chat.message', {
      occurredAt: new Date().toISOString(),
      scope: 'worktree',
      chatId: 'c1',
      message: unmatchedTool,
    });
    jest.advanceTimersByTime(CHAT_SEMANTIC_STALE_MS);
    expect(repairs).toHaveBeenCalledTimes(1);

    mock.emit('chat.message', {
      occurredAt: new Date().toISOString(),
      scope: 'worktree',
      chatId: 'c1',
      message: unmatchedTool,
    });
    jest.advanceTimersByTime(CHAT_SEMANTIC_STALE_MS);
    expect(repairs).toHaveBeenCalledTimes(1);
    store[CLIENT_STORE_DISPOSE]?.();
    jest.useRealTimers();
  });

  it('allows repair after the stale thread changes', () => {
    jest.useFakeTimers();
    jest.setSystemTime(1_450_000);
    const mock = createMockClient();
    const repairs = jest.fn();
    configureChatRepairRequester(mock.client, repairs);
    const store = createChatStore(mock.client);
    mock.emit('chat.message', {
      occurredAt: new Date().toISOString(),
      scope: 'worktree',
      chatId: 'c1',
      message: chatMessage({
        messageId: 'latest-tool',
        role: 'assistant',
        createdAtMs: Date.now(),
        parts: [{ kind: 'tool_use' }],
      }),
    });
    jest.advanceTimersByTime(CHAT_SEMANTIC_STALE_MS);
    expect(repairs).toHaveBeenCalledTimes(1);

    mock.emit('chat.message', {
      occurredAt: new Date().toISOString(),
      scope: 'worktree',
      chatId: 'c1',
      message: chatMessage({
        messageId: 'latest-progress',
        role: 'assistant',
        createdAtMs: Date.now(),
      }),
    });
    jest.advanceTimersByTime(CHAT_SEMANTIC_STALE_MS);
    expect(repairs).toHaveBeenCalledTimes(2);
    store[CLIENT_STORE_DISPOSE]?.();
    jest.useRealTimers();
  });

  it('requests semantic repair for an open turn timer after event silence', () => {
    jest.useFakeTimers();
    jest.setSystemTime(1_500_000);
    const mock = createMockClient();
    const repairs = jest.fn();
    configureChatRepairRequester(mock.client, repairs);
    const store = createChatStore(mock.client);
    mock.emit('chat.message', {
      occurredAt: new Date().toISOString(),
      scope: 'worktree',
      workspaceLocalId: 'ws',
      worktreeLocalId: 'wt',
      chatId: 'c1',
      message: chatMessage({
        messageId: 'user-1:turn-timer',
        role: 'system',
        status: 'streaming',
        createdAtMs: Date.now(),
        parts: [{ kind: 'turn_timer' }],
      }),
    });
    jest.advanceTimersByTime(CHAT_SEMANTIC_STALE_MS);
    expect(repairs).toHaveBeenCalledTimes(1);
    store[CLIENT_STORE_DISPOSE]?.();
    jest.useRealTimers();
  });

  it('does not repair a complete tool pair or a chat still receiving events', () => {
    jest.useFakeTimers();
    jest.setSystemTime(2_000_000);
    const mock = createMockClient();
    const repairs = jest.fn();
    configureChatRepairRequester(mock.client, repairs);
    const store = createChatStore(mock.client);
    for (const [messageId, kind] of [
      ['tool', 'tool_use'],
      ['result', 'tool_result'],
    ] as const) {
      mock.emit('chat.message', {
        occurredAt: new Date().toISOString(),
        scope: 'worktree',
        workspaceLocalId: 'ws',
        worktreeLocalId: 'wt',
        chatId: 'complete',
        message: chatMessage({
          chatId: 'complete',
          messageId,
          role: 'assistant',
          createdAtMs: Date.now(),
          parts: [{ kind, data: { toolUseId: 'call-1' } }],
        }),
      });
    }
    mock.emit('chat.message', {
      occurredAt: new Date().toISOString(),
      scope: 'worktree',
      workspaceLocalId: 'ws',
      worktreeLocalId: 'wt',
      chatId: 'active',
      message: chatMessage({
        chatId: 'active',
        messageId: 'open',
        role: 'assistant',
        createdAtMs: Date.now(),
        parts: [{ kind: 'tool_use' }],
      }),
    });
    jest.advanceTimersByTime(CHAT_SEMANTIC_STALE_MS - 1);
    mock.emit('chat.message', {
      occurredAt: new Date().toISOString(),
      scope: 'worktree',
      workspaceLocalId: 'ws',
      worktreeLocalId: 'wt',
      chatId: 'active',
      message: chatMessage({
        chatId: 'active',
        messageId: 'progress',
        role: 'assistant',
        createdAtMs: Date.now(),
      }),
    });
    jest.advanceTimersByTime(2);
    expect(repairs).not.toHaveBeenCalled();
    store[CLIENT_STORE_DISPOSE]?.();
    jest.useRealTimers();
  });

  it('does not repair a persisted snapshot tool use with a folded result', () => {
    jest.useFakeTimers();
    jest.setSystemTime(2_500_000);
    const mock = createMockClient();
    const repairs = jest.fn();
    configureChatRepairRequester(mock.client, repairs);
    const store = createChatStore(mock.client);
    mock.emit('chat.message', {
      occurredAt: new Date().toISOString(),
      scope: 'worktree',
      chatId: 'c1',
      message: chatMessage({
        messageId: 'persisted-tool',
        role: 'assistant',
        createdAtMs: 10,
        parts: [
          {
            kind: 'tool_use',
            data: {
              toolUseId: 'call-1',
              toolName: 'Bash',
              input: 'pwd',
              result: { output: '/repo', isError: false },
            },
          },
        ],
      }),
    });

    jest.advanceTimersByTime(CHAT_SEMANTIC_STALE_MS);
    expect(repairs).not.toHaveBeenCalled();
    store[CLIENT_STORE_DISPOSE]?.();
    jest.useRealTimers();
  });

  it('repairs a hydrated latest-turn unmatched tool use once after silence', () => {
    jest.useFakeTimers();
    jest.setSystemTime(2_600_000);
    const mock = createMockClient();
    const repairs = jest.fn();
    configureChatRepairRequester(mock.client, repairs);
    const store = createChatStore(mock.client);
    store.getState().hydrate(
      'c1',
      [
        chatMessage({
          messageId: 'latest-user',
          role: 'user',
          createdAtMs: Date.now(),
        }),
        chatMessage({
          messageId: 'pending-tool',
          role: 'assistant',
          createdAtMs: Date.now() + 1,
          parts: [
            {
              kind: 'tool_use',
              data: { toolUseId: 'call-1', toolName: 'Bash', input: 'pwd' },
            },
          ],
        }),
      ],
      {
        route: {
          scope: 'worktree',
          workspaceLocalId: 'ws',
          worktreeLocalId: 'wt',
        },
      },
    );

    jest.advanceTimersByTime(CHAT_SEMANTIC_STALE_MS);
    expect(repairs).toHaveBeenCalledTimes(1);
    expect(repairs).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'c1',
        scope: 'worktree',
        workspaceLocalId: 'ws',
        worktreeLocalId: 'wt',
        trigger: 'semantic',
      }),
    );
    store[CLIENT_STORE_DISPOSE]?.();
    jest.useRealTimers();
  });

  it('does not reset semantic silence for an identical hydration', () => {
    jest.useFakeTimers();
    jest.setSystemTime(2_625_000);
    const mock = createMockClient();
    const repairs = jest.fn();
    configureChatRepairRequester(mock.client, repairs);
    const store = createChatStore(mock.client);
    const snapshot = [
      chatMessage({
        messageId: 'pending-tool',
        role: 'assistant',
        createdAtMs: Date.now(),
        parts: [{ kind: 'tool_use' }],
      }),
    ];
    store.getState().hydrate('c1', snapshot);
    jest.advanceTimersByTime(CHAT_SEMANTIC_STALE_MS / 2);

    store.getState().hydrate('c1', snapshot);
    jest.advanceTimersByTime(CHAT_SEMANTIC_STALE_MS / 2);

    expect(repairs).toHaveBeenCalledTimes(1);
    store[CLIENT_STORE_DISPOSE]?.();
    jest.useRealTimers();
  });

  it('resets semantic silence when hydration changes authoritative content', () => {
    jest.useFakeTimers();
    jest.setSystemTime(2_637_500);
    const mock = createMockClient();
    const repairs = jest.fn();
    configureChatRepairRequester(mock.client, repairs);
    const store = createChatStore(mock.client);
    const pendingTool = chatMessage({
      messageId: 'pending-tool',
      role: 'assistant',
      createdAtMs: Date.now(),
      parts: [{ kind: 'tool_use' }],
    });
    store.getState().hydrate('c1', [pendingTool]);
    jest.advanceTimersByTime(CHAT_SEMANTIC_STALE_MS / 2);

    store.getState().hydrate('c1', [
      pendingTool,
      chatMessage({
        messageId: 'progress',
        role: 'assistant',
        createdAtMs: Date.now(),
      }),
    ]);
    jest.advanceTimersByTime(CHAT_SEMANTIC_STALE_MS / 2);
    expect(repairs).not.toHaveBeenCalled();
    jest.advanceTimersByTime(CHAT_SEMANTIC_STALE_MS / 2);

    expect(repairs).toHaveBeenCalledTimes(1);
    store[CLIENT_STORE_DISPOSE]?.();
    jest.useRealTimers();
  });

  it('re-arms a hydrated semantic check until a requester is registered', () => {
    jest.useFakeTimers();
    jest.setSystemTime(2_650_000);
    const mock = createMockClient();
    const repairs = jest.fn<void, [ChatRepairRequest]>();
    const store = createChatStore(mock.client);
    store.getState().hydrate('c1', [
      chatMessage({
        messageId: 'pending-tool',
        role: 'assistant',
        createdAtMs: Date.now(),
        parts: [{ kind: 'tool_use', data: { toolUseId: 'call-1' } }],
      }),
    ]);

    jest.advanceTimersByTime(CHAT_SEMANTIC_STALE_MS);
    expect(repairs).not.toHaveBeenCalled();

    configureChatRepairRequester(mock.client, repairs);
    jest.advanceTimersByTime(CHAT_SEMANTIC_STALE_MS);
    expect(repairs).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(CHAT_SEMANTIC_STALE_MS);
    expect(repairs).toHaveBeenCalledTimes(1);
    store[CLIENT_STORE_DISPOSE]?.();
    jest.useRealTimers();
  });

  it('does not loop when the host declines a chat repair route', () => {
    jest.useFakeTimers();
    jest.setSystemTime(2_675_000);
    const mock = createMockClient();
    const repairs = jest.fn(() => false);
    configureChatRepairRequester(mock.client, repairs);
    const store = createChatStore(mock.client);
    store.getState().hydrate('c1', [
      chatMessage({
        messageId: 'pending-cloud-tool',
        role: 'assistant',
        createdAtMs: Date.now(),
        parts: [{ kind: 'tool_use', data: { toolUseId: 'call-1' } }],
      }),
    ]);

    jest.advanceTimersByTime(CHAT_SEMANTIC_STALE_MS * 2);

    expect(repairs).toHaveBeenCalledTimes(1);
    store[CLIENT_STORE_DISPOSE]?.();
    jest.useRealTimers();
  });

  it('does not repair a healthy hydrated thread with a folded tool result', () => {
    jest.useFakeTimers();
    jest.setSystemTime(2_700_000);
    const mock = createMockClient();
    const repairs = jest.fn();
    configureChatRepairRequester(mock.client, repairs);
    const store = createChatStore(mock.client);
    store.getState().hydrate('c1', [
      chatMessage({
        messageId: 'persisted-tool',
        role: 'assistant',
        createdAtMs: Date.now(),
        parts: [
          {
            kind: 'tool_use',
            data: {
              toolUseId: 'call-1',
              toolName: 'Bash',
              input: 'pwd',
              result: { output: '/repo', isError: false },
            },
          },
        ],
      }),
    ]);

    jest.advanceTimersByTime(CHAT_SEMANTIC_STALE_MS);
    expect(repairs).not.toHaveBeenCalled();
    store[CLIENT_STORE_DISPOSE]?.();
    jest.useRealTimers();
  });

  it('carries standalone routing and retries the same signature after dispatch failure', () => {
    jest.useFakeTimers();
    jest.setSystemTime(2_750_000);
    const mock = createMockClient();
    const repairs = jest.fn<void, [ChatRepairRequest]>();
    configureChatRepairRequester(mock.client, repairs);
    const store = createChatStore(mock.client);
    mock.emit('chat.message', {
      occurredAt: new Date().toISOString(),
      scope: 'standalone',
      chatId: 'standalone-1',
      message: chatMessage({
        chatId: 'standalone-1',
        messageId: 'pending-tool',
        role: 'assistant',
        createdAtMs: 1,
        parts: [{ kind: 'tool_use', data: { toolUseId: 'call-1' } }],
      }),
    });

    jest.advanceTimersByTime(CHAT_SEMANTIC_STALE_MS);
    expect(repairs).toHaveBeenCalledTimes(1);
    const request = repairs.mock.calls[0]?.[0];
    expect(request).toEqual(
      expect.objectContaining({
        chatId: 'standalone-1',
        scope: 'standalone',
        workspaceLocalId: undefined,
        worktreeLocalId: undefined,
      }),
    );
    request?.onDispatchFailure();
    jest.advanceTimersByTime(CHAT_SEMANTIC_STALE_MS);
    expect(repairs).toHaveBeenCalledTimes(2);
    store[CLIENT_STORE_DISPOSE]?.();
    jest.useRealTimers();
  });

  it('releases a consumed signature when dispatch is throttle-skipped', () => {
    jest.useFakeTimers();
    jest.setSystemTime(2_800_000);
    const mock = createMockClient();
    const repairs = jest.fn<void, [ChatRepairRequest]>((request): void => {
      request.onDispatchFailure();
    });
    configureChatRepairRequester(mock.client, repairs);
    const store = createChatStore(mock.client);
    mock.emit('chat.message', {
      occurredAt: new Date().toISOString(),
      scope: 'worktree',
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      chatId: 'throttled-chat',
      message: chatMessage({
        chatId: 'throttled-chat',
        messageId: 'pending-tool',
        role: 'assistant',
        createdAtMs: 1,
        parts: [{ kind: 'tool_use', data: { toolUseId: 'call-1' } }],
      }),
    });

    jest.advanceTimersByTime(CHAT_SEMANTIC_STALE_MS);
    expect(repairs).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(CHAT_SEMANTIC_STALE_MS);
    expect(repairs).toHaveBeenCalledTimes(2);
    store[CLIENT_STORE_DISPOSE]?.();
    jest.useRealTimers();
  });

  it('measures semantic silence from browser arrival despite remote clock skew', () => {
    jest.useFakeTimers();
    jest.setSystemTime(3_000_000);
    const mock = createMockClient();
    const repairs = jest.fn();
    configureChatRepairRequester(mock.client, repairs);
    const store = createChatStore(mock.client);
    mock.emit('chat.message', {
      occurredAt: new Date().toISOString(),
      scope: 'worktree',
      chatId: 'future-clock',
      message: chatMessage({
        chatId: 'future-clock',
        messageId: 'pending-tool',
        role: 'assistant',
        createdAtMs: Date.now() + 3_600_000,
        parts: [{ kind: 'tool_use', data: { toolUseId: 'call-1' } }],
      }),
    });

    jest.advanceTimersByTime(CHAT_SEMANTIC_STALE_MS);
    expect(repairs).toHaveBeenCalledTimes(1);
    expect(store.getState().threads['future-clock']?.lastEventAt).toBe(
      6_600_000,
    );
    store[CLIENT_STORE_DISPOSE]?.();
    jest.useRealTimers();
  });
  it('hydrates and replaces the host-owned queued-message mirror', () => {
    const store = createChatStore(createMockClient().client);
    const first = {
      id: 'queue-1',
      text: 'follow up',
      origin: 'portal' as const,
      enqueuedAtMs: 123,
    };

    store.getState().hydrate('c1', [], { queuedMessages: [first] });
    expect(store.getState().threads.c1?.queuedMessages).toEqual([first]);

    store.getState().hydrate('c1', [], { queuedMessages: [] });
    expect(store.getState().threads.c1?.queuedMessages).toEqual([]);
  });

  it('clears steering capabilities when an authoritative hydration supplies undefined', () => {
    const store = createChatStore(createMockClient().client);
    const capabilities = {
      provider: 'claude' as const,
      generation: 'generation-1',
      steer: true,
      withdraw: true,
      interrupt: true,
    };

    store.getState().hydrate('c1', [], { steeringCapabilities: capabilities });
    expect(store.getState().threads.c1?.steeringCapabilities).toEqual(
      capabilities,
    );

    store.getState().hydrate('c1', [], {});
    expect(store.getState().threads.c1?.steeringCapabilities).toEqual(
      capabilities,
    );

    store.getState().hydrate('c1', [], { steeringCapabilities: undefined });
    expect(store.getState().threads.c1?.steeringCapabilities).toBeUndefined();
  });

  it('subscribes to chat.message on activation', () => {
    const mock = createMockClient();
    const store = createInactiveChatStore(mock.client);
    expect(mock.subscribeCalls).toEqual([]);
    store[CLIENT_STORE_ACTIVATE]?.();
    expect(mock.subscribeCalls).toContain('chat.message');
  });

  it('disposes its transport subscription idempotently', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);
    store[CLIENT_STORE_DISPOSE]?.();
    store[CLIENT_STORE_DISPOSE]?.();
    expect(mock.unsubscribeCalls).toEqual(['chat.message']);
  });

  it('ingests a streaming frame into a new thread and flips status to streaming', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);

    mock.emit('chat.message', {
      occurredAt: '2026-07-01T00:00:00.000Z',
      scope: 'worktree',
      chatId: 'c1',
      message: chatMessage({
        messageId: 'a1',
        role: 'assistant',
        status: 'streaming',
        text: 'thinking',
        createdAtMs: 5,
        updatedAtMs: 7,
      }),
    });

    const thread = store.getState().threads['c1'];
    expect(thread.messages).toHaveLength(1);
    expect(thread.status).toBe('streaming');
    expect(thread.error).toBeNull();
    expect(thread.lastEventAt).toBe(7);
  });

  describe('seedTabSettings (restore path)', () => {
    it('applies persisted settings without scheduling a persist', () => {
      jest.useFakeTimers();
      try {
        const mock = createMockClient();
        const store = createChatStore(mock.client);
        store.getState().seedTabSettings('c1', {
          planMode: true,
          proposalMode: 'required',
          thinkingLevel: 'max',
        });
        const thread = store.getState().threads['c1'];
        expect(thread.planMode).toBe(true);
        expect(thread.proposalMode).toBe('required');
        expect(thread.thinkingLevel).toBe('max');
        // Seeding must NOT echo back through chat.persistTabSettings — flush
        // any would-be debounce and assert no command was issued.
        jest.advanceTimersByTime(1_000);
        expect(mock.commandCalls).toHaveLength(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it('setPlanMode (user edit) still persists after a seed', () => {
      jest.useFakeTimers();
      try {
        const mock = createMockClient();
        const store = createChatStore(mock.client);
        store.getState().seedTabSettings('c1', {
          planMode: true,
          proposalMode: 'optional',
          thinkingLevel: 'high',
        });
        store.getState().setPlanMode('c1', false);
        jest.advanceTimersByTime(1_000);
        expect(
          mock.commandCalls.filter((c) => c.name === 'chat.persistTabSettings'),
        ).toHaveLength(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it('an ifAbsent seed does not overwrite an earlier authoritative seed', () => {
      const store = createChatStore(createMockClient().client);
      store.getState().seedTabSettings('chat-1', {
        planMode: false,
        proposalMode: 'optional',
        thinkingLevel: 'xhigh',
      });
      // The late localStorage promise:
      store
        .getState()
        .seedTabSettings(
          'chat-1',
          { planMode: false, proposalMode: 'optional', thinkingLevel: 'off' },
          { ifAbsent: true },
        );
      expect(store.getState().threads['chat-1']?.thinkingLevel).toBe('xhigh');
    });

    it('an ifAbsent seed applies when nothing seeded before', () => {
      const store = createChatStore(createMockClient().client);
      store
        .getState()
        .seedTabSettings(
          'chat-2',
          { planMode: true, proposalMode: 'optional', thinkingLevel: 'high' },
          { ifAbsent: true },
        );
      expect(store.getState().threads['chat-2']?.thinkingLevel).toBe('high');
    });
  });

  describe('turn-timer working indicator (CAN-1006)', () => {
    const emitTo = (
      mock: ReturnType<typeof createMockClient>,
      message: PortalChatMessage,
    ): void =>
      mock.emit('chat.message', {
        occurredAt: '2026-07-01T00:00:00.000Z',
        scope: 'worktree',
        chatId: 'c1',
        message,
      });
    const turnTimer = (
      status: 'streaming' | 'complete',
      createdAtMs: number,
    ): PortalChatMessage =>
      chatMessage({
        messageId: 'u1:turn-timer',
        role: 'system',
        status,
        parts: [
          {
            kind: 'turn_timer',
            data: {
              startedAt: 0,
              completedAt: status === 'complete' ? createdAtMs : null,
            },
          },
        ],
        createdAtMs,
      });
    const assistantComplete = (createdAtMs: number): PortalChatMessage =>
      chatMessage({
        messageId: `a${createdAtMs}`,
        role: 'assistant',
        status: 'complete',
        text: 'done',
        createdAtMs,
      });

    it('raises the indicator on a streaming turn-timer start frame (relay path)', () => {
      const mock = createMockClient();
      const store = createChatStore(mock.client);
      emitTo(mock, turnTimer('streaming', 1));
      expect(store.getState().threads['c1'].status).toBe('streaming');
    });

    it('keeps the indicator up when a complete content frame arrives mid-turn', () => {
      const mock = createMockClient();
      const store = createChatStore(mock.client);
      emitTo(mock, turnTimer('streaming', 1));
      emitTo(mock, assistantComplete(2));
      expect(store.getState().threads['c1'].status).toBe('streaming');
    });

    it('keeps complete relayed content unfolded while the host turn is active', () => {
      const store = createChatStore(createMockClient().client);

      store.getState().hydrate(
        'c1',
        [
          chatMessage({
            messageId: 'u1',
            role: 'user',
            text: 'inspect',
            createdAtMs: 1,
          }),
          chatMessage({
            messageId: 'tool',
            role: 'assistant',
            parts: [{ kind: 'tool_use' }],
            createdAtMs: 2,
          }),
          chatMessage({
            messageId: 'answer',
            role: 'assistant',
            text: 'still working',
            createdAtMs: 3,
          }),
        ],
        { status: 'streaming', turnActive: true },
      );

      const [group] = store.getState().threads['c1'].turnGroups;
      expect(group.complete).toBe(false);
      expect(group.intermediateMessageIds).toEqual([]);
      expect(group.finalMessageIds).toEqual(['tool', 'answer']);
    });

    it('lowers the indicator on the terminal turn-timer frame', () => {
      const mock = createMockClient();
      const store = createChatStore(mock.client);
      emitTo(mock, turnTimer('streaming', 1));
      emitTo(mock, assistantComplete(2));
      emitTo(mock, turnTimer('complete', 3));
      expect(store.getState().threads['c1'].status).toBe('idle');
    });

    it('a lone complete assistant frame (no active turn) stays idle', () => {
      const mock = createMockClient();
      const store = createChatStore(mock.client);
      emitTo(mock, assistantComplete(1));
      expect(store.getState().threads['c1'].status).toBe('idle');
    });

    it('keeps the error on a failed turn — the terminal timer does not clear it', () => {
      const mock = createMockClient();
      const store = createChatStore(mock.client);
      // Portal failed-turn sequence: streaming start → assistant `failed` →
      // the projector's terminal timer frame (always `complete`). The error
      // must survive so the transcript's error banner renders (CAN-1006 review).
      emitTo(mock, turnTimer('streaming', 1));
      emitTo(
        mock,
        chatMessage({
          messageId: 'a1',
          role: 'assistant',
          status: 'failed',
          text: 'boom',
          createdAtMs: 2,
        }),
      );
      emitTo(mock, turnTimer('complete', 3));
      const thread = store.getState().threads['c1'];
      expect(thread.status).toBe('error');
      expect(thread.error).toBe('boom');
      expect(thread.turnActive).toBe(false);
    });
  });

  it('orders messages by createdAtMs regardless of arrival order', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);

    const emit = (m: PortalChatMessage): void =>
      mock.emit('chat.message', {
        occurredAt: '2026-07-01T00:00:00.000Z',
        scope: 'worktree',
        chatId: 'c1',
        message: m,
      });

    emit(chatMessage({ messageId: 'a1', role: 'assistant', createdAtMs: 30 }));
    emit(chatMessage({ messageId: 'u1', role: 'user', createdAtMs: 10 }));
    emit(chatMessage({ messageId: 'a0', role: 'assistant', createdAtMs: 20 }));

    expect(
      store.getState().threads['c1'].messages.map((m) => m.messageId),
    ).toEqual(['u1', 'a0', 'a1']);
  });

  it('hydrates messages in authoritative presentation order', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);

    store.getState().hydrate('c1', [
      chatMessage({
        messageId: 'u1',
        role: 'user',
        createdAtMs: 10,
        presentationOrder: 0,
      }),
      chatMessage({
        messageId: 'u2',
        role: 'user',
        createdAtMs: 20,
        presentationOrder: 2,
      }),
      chatMessage({
        messageId: 'a1',
        role: 'assistant',
        createdAtMs: 30,
        presentationOrder: 1,
      }),
      chatMessage({
        messageId: 'a2',
        role: 'assistant',
        createdAtMs: 40,
        presentationOrder: 3,
      }),
    ]);

    expect(
      store.getState().threads['c1'].messages.map((m) => m.messageId),
    ).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  it('reorders cached messages when only presentation order changes', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);
    const emit = (message: PortalChatMessage): void =>
      mock.emit('chat.message', {
        occurredAt: '2026-07-01T00:00:00.000Z',
        scope: 'worktree',
        chatId: 'c1',
        message,
      });

    store.getState().hydrate('c1', [
      chatMessage({
        messageId: 'u1',
        role: 'user',
        createdAtMs: 10,
        presentationOrder: 0,
      }),
      chatMessage({
        messageId: 'u2',
        role: 'user',
        createdAtMs: 20,
        presentationOrder: 1,
      }),
      chatMessage({
        messageId: 'a1',
        role: 'assistant',
        createdAtMs: 30,
        presentationOrder: 2,
      }),
    ]);
    emit(
      chatMessage({
        messageId: 'u2',
        role: 'user',
        createdAtMs: 20,
        presentationOrder: 2,
      }),
    );
    emit(
      chatMessage({
        messageId: 'a1',
        role: 'assistant',
        createdAtMs: 30,
        presentationOrder: 1,
      }),
    );

    expect(
      store.getState().threads['c1'].messages.map((m) => m.messageId),
    ).toEqual(['u1', 'a1', 'u2']);
  });

  // An optimistic user row and a provisional streaming assistant row carry no
  // `presentationOrder` while the authoritative v2 rows around them do. Such a
  // row keeps its chronological slot; the ordered rows permute only among the
  // slots they already occupy, so authoritative order governs canonical
  // content without dragging a client-only row away from where it was typed.
  // REG-2981. An idle send mints an optimistic bubble; the host can then accept
  // it as a QUEUED turn before the POST is acknowledged, at which point the
  // prompt would render twice — bubble plus queue row. The accepted row names
  // the host user-message id it stands for, and the bubble bound to that id
  // (via `bindOptimisticSend`) is the one retracted. Correlation is exact, so
  // an in-flight outbox row — which supersedes nothing — is left alone.
  it('retracts the bound optimistic echo when an accepted queue row supersedes it', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);
    store.getState().addOptimisticUserMessage('c1', {
      text: 'hello',
      createdAtMs: 1_000,
      localId: 'send-1',
    });
    store.getState().bindOptimisticSend('c1', {
      optimisticLocalId: 'optimistic-send-1',
      userMessageId: 'msg-1',
    });
    expect(
      store.getState().threads['c1'].messages.map((m) => m.messageId),
    ).toEqual(['optimistic-send-1']);

    store.getState().hydrate('c1', [], {
      queuedMessages: [
        {
          id: 'conversation-v2-request:req-1',
          text: 'hello',
          origin: 'portal',
          enqueuedAtMs: 1_000,
          supersedesUserMessageId: 'msg-1',
        },
      ],
    });

    expect(
      store.getState().threads['c1'].messages.map((m) => m.messageId),
    ).toEqual([]);
  });

  // Removing the bubble is not enough: the optimistic send also raised the
  // thread's runtime ownership (status/turnActive) so the composer shows Stop.
  // The later ACK rollback returns early once the bubble is gone, and the
  // authoritative RUNNING/terminal frames carry the canonical id, so they never
  // match the stale owner — leaving the composer stuck. Release the ownership
  // with the bubble.
  it('releases optimistic runtime ownership when an accepted queue row supersedes the bubble', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);
    store.getState().addOptimisticUserMessage('c3', {
      text: 'hello',
      createdAtMs: 1_000,
      localId: 'send-3',
    });
    store.getState().bindOptimisticSend('c3', {
      optimisticLocalId: 'optimistic-send-3',
      userMessageId: 'msg-3',
    });
    expect(store.getState().threads['c3'].turnActive).toBe(true);

    store.getState().hydrate('c3', [], {
      queuedMessages: [
        {
          id: 'conversation-v2-request:req-3',
          text: 'hello',
          origin: 'portal',
          enqueuedAtMs: 1_000,
          supersedesUserMessageId: 'msg-3',
        },
      ],
    });

    const thread = store.getState().threads['c3'];
    expect(thread.messages).toEqual([]);
    expect(thread.turnActive).toBe(false);
    expect(thread.status).toBe('idle');
  });

  it('leaves the optimistic echo alone for a queue row that supersedes nothing', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);
    store.getState().addOptimisticUserMessage('c2', {
      text: 'hello',
      createdAtMs: 1_000,
      localId: 'send-2',
    });
    store.getState().bindOptimisticSend('c2', {
      optimisticLocalId: 'optimistic-send-2',
      userMessageId: 'msg-2',
    });

    store.getState().hydrate('c2', [], {
      queuedMessages: [
        {
          id: 'conversation-v2-request:req-2',
          text: 'hello',
          origin: 'portal',
          enqueuedAtMs: 1_000,
        },
      ],
    });

    expect(
      store.getState().threads['c2'].messages.map((m) => m.messageId),
    ).toEqual(['optimistic-send-2']);
  });

  it('pins an unordered message to its chronological slot', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);

    store.getState().hydrate('c1', [
      chatMessage({
        messageId: 'a1',
        role: 'assistant',
        createdAtMs: 30,
        presentationOrder: 0,
      }),
      chatMessage({
        messageId: 'u1',
        role: 'user',
        createdAtMs: 10,
        presentationOrder: 1,
      }),
      chatMessage({ messageId: 'x1', role: 'user', createdAtMs: 20 }),
    ]);

    expect(
      store.getState().threads['c1'].messages.map((m) => m.messageId),
    ).toEqual(['a1', 'x1', 'u1']);
  });

  it('refreshes cached presentation order when older history is hydrated', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);

    store.getState().hydrate('c1', [
      chatMessage({
        messageId: 'u2',
        role: 'user',
        createdAtMs: 20,
        presentationOrder: 0,
      }),
      chatMessage({
        messageId: 'a2',
        role: 'assistant',
        createdAtMs: 40,
        presentationOrder: 1,
      }),
    ]);
    store.getState().hydrate('c1', [
      chatMessage({
        messageId: 'u1',
        role: 'user',
        createdAtMs: 10,
        presentationOrder: 0,
      }),
      chatMessage({
        messageId: 'a1',
        role: 'assistant',
        createdAtMs: 30,
        presentationOrder: 1,
      }),
      chatMessage({
        messageId: 'u2',
        role: 'user',
        createdAtMs: 20,
        presentationOrder: 2,
      }),
      chatMessage({
        messageId: 'a2',
        role: 'assistant',
        createdAtMs: 40,
        presentationOrder: 3,
      }),
    ]);

    expect(
      store.getState().threads['c1'].messages.map((m) => m.messageId),
    ).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  it('upserts a message in place when the same id streams again', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);

    const emit = (text: string, status: PortalChatMessage['status']): void =>
      mock.emit('chat.message', {
        occurredAt: '2026-07-01T00:00:00.000Z',
        scope: 'worktree',
        chatId: 'c1',
        message: chatMessage({
          messageId: 'a1',
          role: 'assistant',
          text,
          status,
          createdAtMs: 5,
        }),
      });

    emit('partial', 'streaming');
    emit('partial answer', 'complete');

    const thread = store.getState().threads['c1'];
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0].text).toBe('partial answer');
    expect(thread.status).toBe('idle');
  });

  it('reports an error status with text on a failed assistant frame', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);

    mock.emit('chat.message', {
      occurredAt: '2026-07-01T00:00:00.000Z',
      scope: 'worktree',
      chatId: 'c1',
      message: chatMessage({
        messageId: 'a1',
        role: 'assistant',
        status: 'failed',
        text: 'boom',
        createdAtMs: 5,
      }),
    });

    const thread = store.getState().threads['c1'];
    expect(thread.status).toBe('error');
    expect(thread.error).toBe('boom');
  });

  it('does not let a user frame change the streaming status', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);

    mock.emit('chat.message', {
      occurredAt: '2026-07-01T00:00:00.000Z',
      scope: 'worktree',
      chatId: 'c1',
      message: chatMessage({
        messageId: 'a1',
        role: 'assistant',
        status: 'streaming',
        text: 'x',
        createdAtMs: 5,
      }),
    });
    mock.emit('chat.message', {
      occurredAt: '2026-07-01T00:00:01.000Z',
      scope: 'worktree',
      chatId: 'c1',
      message: chatMessage({
        messageId: 'u2',
        role: 'user',
        text: 'next',
        createdAtMs: 6,
      }),
    });

    expect(store.getState().threads['c1'].status).toBe('streaming');
  });

  it('keeps separate threads isolated by chatId', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);

    mock.emit('chat.message', {
      occurredAt: '2026-07-01T00:00:00.000Z',
      scope: 'worktree',
      chatId: 'c1',
      message: chatMessage({ messageId: 'a1', role: 'assistant', text: 'one' }),
    });
    mock.emit('chat.message', {
      occurredAt: '2026-07-01T00:00:00.000Z',
      scope: 'worktree',
      chatId: 'c2',
      message: chatMessage({
        messageId: 'b1',
        role: 'assistant',
        text: 'two',
        chatId: 'c2',
      }),
    });

    expect(store.getState().threads['c1'].messages).toHaveLength(1);
    expect(store.getState().threads['c2'].messages).toHaveLength(1);
    expect(store.getState().threads['c1'].messages[0].text).toBe('one');
  });

  it('hydrate seeds a thread and computes turn groups; reset clears it', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);

    store.getState().hydrate('c1', [
      chatMessage({
        messageId: 'u1',
        role: 'user',
        text: 'hi',
        createdAtMs: 1,
      }),
      chatMessage({
        messageId: 'a1',
        role: 'assistant',
        text: 'hello',
        createdAtMs: 2,
      }),
    ]);

    const seeded = store.getState().threads['c1'];
    expect(seeded.messages).toHaveLength(2);
    expect(seeded.status).toBe('idle');
    expect(seeded.turnGroups).toHaveLength(1);
    expect(seeded.turnGroups[0].finalMessageIds).toEqual(['a1']);

    store.getState().reset('c1');
    expect(store.getState().threads['c1']).toBeUndefined();
  });

  it('re-hydrating the same chatId merges older history and recomputes turn groups', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);

    store.getState().hydrate('c1', [
      chatMessage({
        messageId: 'u1',
        role: 'user',
        text: 'hi',
        createdAtMs: 1,
      }),
      chatMessage({
        messageId: 'a1',
        role: 'assistant',
        text: 'first',
        createdAtMs: 2,
      }),
    ]);

    // A later full-history snapshot fills older rows instead of replacing the
    // cached tail that rendered immediately.
    store.getState().hydrate('c1', [
      chatMessage({
        messageId: 'u2',
        role: 'user',
        text: 'yo',
        createdAtMs: 3,
      }),
      chatMessage({
        messageId: 'a2',
        role: 'assistant',
        text: 'second',
        createdAtMs: 4,
      }),
    ]);

    const thread = store.getState().threads['c1'];
    expect(thread.messages.map((m) => m.messageId)).toEqual([
      'u1',
      'a1',
      'u2',
      'a2',
    ]);
    expect(thread.turnGroups).toHaveLength(2);
    expect(thread.turnGroups[1].userMessageId).toBe('u2');
    expect(thread.turnGroups[1].finalMessageIds).toEqual(['a2']);
  });

  it('keeps transcript and turn-group references for a no-op re-hydrate', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);
    const snapshot = [
      chatMessage({
        messageId: 'u1',
        role: 'user',
        text: 'hi',
        createdAtMs: 1,
      }),
      chatMessage({
        messageId: 'a1',
        role: 'assistant',
        text: 'hello',
        createdAtMs: 2,
      }),
    ];

    store.getState().hydrate('c1', snapshot);
    const before = store.getState().threads['c1'];

    // Portal projection updates rebuild the snapshot objects even when this
    // chat's content did not change.
    store.getState().hydrate(
      'c1',
      snapshot.map((message) => ({ ...message })),
    );
    const after = store.getState().threads['c1'];

    expect(after).toBe(before);
    expect(after.messages).toBe(before.messages);
    expect(after.turnGroups).toBe(before.turnGroups);
  });

  it('applies explicit host state when re-hydration leaves the transcript unchanged', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);
    const snapshot = [
      chatMessage({
        messageId: 'u1',
        role: 'user',
        text: 'hi',
        createdAtMs: 1,
      }),
    ];

    store.getState().hydrate('c1', snapshot);
    const before = store.getState().threads['c1'];
    store.getState().hydrate('c1', snapshot, {
      status: 'streaming',
      turnActive: true,
      route: {
        scope: 'worktree',
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'worktree-1',
      },
      settings: {
        planMode: true,
        proposalMode: 'required',
        thinkingLevel: 'max',
        pendingPlanExit: { plan: 'review' },
      },
    });

    const after = store.getState().threads['c1'];
    expect(after).not.toBe(before);
    expect(after.messages).toBe(before.messages);
    expect(after.turnGroups).not.toBe(before.turnGroups);
    expect(after.turnGroups[0].complete).toBe(false);
    expect(after.status).toBe('streaming');
    expect(after.turnActive).toBe(true);
    expect(after.route).toEqual({
      scope: 'worktree',
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'worktree-1',
    });
    expect(after.planMode).toBe(true);
    expect(after.proposalMode).toBe('required');
    expect(after.thinkingLevel).toBe('max');
    expect(after.pendingPlanExit).toEqual({ plan: 'review' });
  });

  it('merges full history without clobbering live or optimistic entries', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);

    store.getState().hydrate('c1', [
      chatMessage({
        messageId: 'cached',
        role: 'assistant',
        text: 'cached tail',
        createdAtMs: 20,
      }),
    ]);
    store.getState().addOptimisticUserMessage('c1', {
      text: 'still sending',
      createdAtMs: 30,
      localId: 'local-1',
    });
    mock.emit('chat.message', {
      occurredAt: '2026-07-01T00:00:00.000Z',
      scope: 'worktree',
      chatId: 'c1',
      message: chatMessage({
        messageId: 'live',
        role: 'assistant',
        status: 'streaming',
        text: 'live delta',
        createdAtMs: 40,
      }),
    });

    store.getState().hydrate('c1', [
      chatMessage({
        messageId: 'old-user',
        role: 'user',
        text: 'older question',
        createdAtMs: 1,
      }),
      chatMessage({
        messageId: 'old-answer',
        role: 'assistant',
        text: 'older answer',
        createdAtMs: 2,
      }),
      chatMessage({
        messageId: 'cached',
        role: 'assistant',
        text: 'stale cached copy',
        createdAtMs: 20,
      }),
    ]);

    const thread = store.getState().threads['c1'];
    expect(thread.messages.map((message) => message.messageId)).toEqual([
      'old-user',
      'old-answer',
      'cached',
      'optimistic-local-1',
      'live',
    ]);
    expect(
      thread.messages.find((message) => message.messageId === 'cached')?.text,
    ).toBe('cached tail');
    expect(thread.status).toBe('streaming');
  });

  it('uses timer completion to order terminal history after live frames', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);
    const timerParts: PortalChatMessage['parts'] = [
      {
        kind: 'turn_timer',
        data: { startedAt: 100, completedAt: null },
      },
    ];

    mock.emit('chat.message', {
      occurredAt: '2026-07-01T00:00:00.000Z',
      scope: 'worktree',
      chatId: 'c1',
      message: chatMessage({
        messageId: 'u1:turn-timer',
        role: 'system',
        status: 'streaming',
        parts: timerParts,
        createdAtMs: 100,
      }),
    });

    mock.emit('chat.message', {
      occurredAt: '2026-07-01T00:00:01.000Z',
      scope: 'worktree',
      chatId: 'c1',
      message: chatMessage({
        messageId: 'a1',
        role: 'assistant',
        text: 'done',
        createdAtMs: 200,
      }),
    });

    store.getState().hydrate('c1', [
      chatMessage({
        messageId: 'u1:turn-timer',
        role: 'system',
        status: 'complete',
        parts: [
          {
            kind: 'turn_timer',
            data: { startedAt: 100, completedAt: 300 },
          },
        ],
        createdAtMs: 100,
      }),
    ]);

    const thread = store.getState().threads['c1'];
    expect(
      thread.messages.find((message) => message.messageId === 'u1:turn-timer')
        ?.status,
    ).toBe('complete');
    expect(thread.status).toBe('idle');
    expect(thread.turnActive).toBe(false);
  });

  it('hydrate dedupes same-id input rows, keeping the last occurrence (last-wins)', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);

    // Snapshot inputs can carry the same logical message twice — e.g. a cached
    // live frame plus its history re-push. Only one row per messageId may
    // survive, and the LATER occurrence (the fresher projection) must win.
    store.getState().hydrate('c1', [
      chatMessage({
        messageId: 'u1',
        role: 'user',
        text: 'hi',
        createdAtMs: 1,
      }),
      chatMessage({
        messageId: 'a1',
        role: 'assistant',
        text: 'stale partial',
        status: 'streaming',
        createdAtMs: 2,
      }),
      chatMessage({
        messageId: 'a1',
        role: 'assistant',
        text: 'final answer',
        status: 'complete',
        createdAtMs: 2,
      }),
    ]);

    const thread = store.getState().threads['c1'];
    expect(thread.messages.map((m) => m.messageId)).toEqual(['u1', 'a1']);
    expect(thread.messages[1].text).toBe('final answer');
    expect(thread.messages[1].status).toBe('complete');
    expect(thread.turnGroups).toHaveLength(1);
    expect(thread.turnGroups[0].finalMessageIds).toEqual(['a1']);
  });

  it('hydrate unifies a user echo with its canonical row by clientRequestId', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);

    // The cloud send path echoes the user message under a client-minted id
    // (`msg-<ts>`) carrying the send's clientRequestId; a later mid-session
    // hydrate merges the canonical row under the server's uuid. Same
    // clientRequestId = same message — the thread must hold ONE row (under the
    // canonical id, so future refetches keep matching it), never both.
    mock.emit('chat.message', {
      occurredAt: '2026-07-01T00:00:00.000Z',
      scope: 'worktree',
      chatId: 'c1',
      message: chatMessage({
        messageId: 'msg-1000',
        clientRequestId: 'req-1',
        role: 'user',
        text: 'hi this is a test',
        createdAtMs: 1_000,
      }),
    });

    store.getState().hydrate('c1', [
      chatMessage({
        messageId: 'canonical-uuid-1',
        clientRequestId: 'req-1',
        role: 'user',
        text: 'hi this is a test',
        createdAtMs: 4_000,
      }),
      chatMessage({
        messageId: 'canonical-assistant-1',
        role: 'assistant',
        text: 'the reply',
        createdAtMs: 5_000,
      }),
    ]);

    const thread = store.getState().threads['c1'];
    const userRows = thread.messages.filter(
      (message) => message.role === 'user',
    );
    expect(userRows).toHaveLength(1);
    expect(userRows[0].messageId).toBe('canonical-uuid-1');
    expect(userRows[0].text).toBe('hi this is a test');
  });

  it('ingest keeps canonical data and ordering when a late user echo shares its clientRequestId', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);

    store.getState().hydrate('c1', [
      chatMessage({
        messageId: 'canonical-uuid-1',
        clientRequestId: 'req-1',
        role: 'user',
        text: 'hi this is a test',
        sourceKey: 'canonical-source',
        parts: [{ kind: 'attachment', data: { name: 'brief.pdf' } }],
        createdAtMs: 1_000,
        updatedAtMs: 1_500,
      }),
      chatMessage({
        messageId: 'canonical-assistant-1',
        role: 'assistant',
        text: 'the reply',
        createdAtMs: 2_000,
      }),
    ]);

    mock.emit('chat.message', {
      occurredAt: '2026-07-01T00:00:05.000Z',
      scope: 'worktree',
      chatId: 'c1',
      message: chatMessage({
        messageId: 'msg-2000',
        clientRequestId: 'req-1',
        role: 'user',
        text: 'hi this is a test',
        createdAtMs: 5_000,
      }),
    });

    const thread = store.getState().threads['c1'];
    expect(thread.messages.map((message) => message.messageId)).toEqual([
      'canonical-uuid-1',
      'canonical-assistant-1',
    ]);
    expect(thread.messages[0].createdAtMs).toBe(1_000);
    expect(thread.messages[0].sourceKey).toBe('canonical-source');
    expect(thread.messages[0].parts).toEqual([
      { kind: 'attachment', data: { name: 'brief.pdf' } },
    ]);
    expect(thread.messages[0].updatedAtMs).toBe(1_500);
    expect(thread.turnGroups).toHaveLength(1);
    expect(thread.turnGroups[0].userMessageId).toBe('canonical-uuid-1');
    expect(thread.turnGroups[0].finalMessageIds).toEqual([
      'canonical-assistant-1',
    ]);
  });

  it('updates one streamed row in a large transcript without duplicating or reordering messages', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);
    const history = Array.from({ length: 2_000 }, (_, index) =>
      chatMessage({
        messageId: `message-${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        text: `history ${index}`,
        createdAtMs: index,
        updatedAtMs: index,
      }),
    );

    store.getState().hydrate('c1', history);
    mock.emit('chat.message', {
      occurredAt: '2026-07-01T00:00:01.000Z',
      scope: 'worktree',
      chatId: 'c1',
      message: chatMessage({
        messageId: 'message-1999',
        role: 'assistant',
        text: 'fresh streamed replacement',
        status: 'streaming',
        createdAtMs: 1999,
        updatedAtMs: 3000,
      }),
    });
    mock.emit('chat.message', {
      occurredAt: '2026-07-01T00:00:02.000Z',
      scope: 'worktree',
      chatId: 'c1',
      message: chatMessage({
        messageId: 'message-1999',
        role: 'assistant',
        text: 'final streamed replacement',
        status: 'complete',
        createdAtMs: 1999,
        updatedAtMs: 3500,
      }),
    });

    const messages = store.getState().threads.c1?.messages ?? [];
    expect(messages).toHaveLength(history.length);
    expect(messages.map((message) => message.messageId)).toEqual(
      history.map((message) => message.messageId),
    );
    expect(messages[1999]).toMatchObject({
      messageId: 'message-1999',
      text: 'final streamed replacement',
      status: 'complete',
      updatedAtMs: 3500,
    });
  });
});

describe('createChatStore — settings & optimistic (CAN-739)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  const persistCalls = (mock: ReturnType<typeof createMockClient>): unknown[] =>
    mock.commandCalls
      .filter((c) => c.name === 'chat.persistTabSettings')
      .map((c) => c.args);

  it('defaults settings and exposes plan-mode / thinking-level', () => {
    const store = createChatStore(createMockClient().client);
    store.getState().setPlanMode('c1', true);
    const thread = store.getState().threads['c1'];
    expect(thread.planMode).toBe(true);
    expect(thread.proposalMode).toBe('optional');
    expect(thread.thinkingLevel).toBe('high');
  });

  it('debounce-persists the latest settings once through chat.persistTabSettings', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);

    store.getState().setPlanMode('c1', true);
    store.getState().setThinkingLevel('c1', 'max');
    // Rapid changes are debounced — nothing persisted yet.
    expect(persistCalls(mock)).toHaveLength(0);

    jest.advanceTimersByTime(500);

    const calls = persistCalls(mock);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      chatId: 'c1',
      settings: { planMode: true, thinkingLevel: 'max' },
    });
  });

  it('cycles the thinking level provider-aware', () => {
    const store = createChatStore(createMockClient().client);
    store.getState().setThinkingLevel('c1', 'off');
    store.getState().cycleThinkingLevel('c1', 'claude');
    expect(store.getState().threads['c1'].thinkingLevel).toBe('medium');
  });

  it('flushPersist persists immediately and cancels the pending debounce', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);
    store.getState().setPlanMode('c1', true);
    expect(persistCalls(mock)).toHaveLength(0);
    store.getState().flushPersist('c1');
    expect(persistCalls(mock)).toHaveLength(1);
    // The in-flight debounce must not fire a second persist.
    jest.advanceTimersByTime(500);
    expect(persistCalls(mock)).toHaveLength(1);
  });

  it('preserves settings across a message ingest and captures routing for persistence', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);
    store.getState().setPlanMode('c1', true);
    store.getState().setThinkingLevel('c1', 'xhigh');

    mock.emit('chat.message', {
      occurredAt: '2026-07-01T00:00:00.000Z',
      scope: 'worktree',
      workspaceLocalId: 'ws1',
      worktreeLocalId: 'wt1',
      chatId: 'c1',
      message: {
        messageId: 'a1',
        chatId: 'c1',
        role: 'assistant',
        status: 'complete',
        text: 'done',
        createdAtMs: 5,
      },
    });

    const thread = store.getState().threads['c1'];
    expect(thread.planMode).toBe(true);
    expect(thread.thinkingLevel).toBe('xhigh');
    expect(thread.messages).toHaveLength(1);

    store.getState().flushPersist('c1');
    expect(persistCalls(mock)[0]).toMatchObject({
      chatId: 'c1',
      scope: 'worktree',
      workspaceLocalId: 'ws1',
      worktreeLocalId: 'wt1',
    });
  });

  it('reconciles an optimistic echo when the authoritative frame arrives', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);

    store
      .getState()
      .addOptimisticUserMessage('c1', { text: 'hello', createdAtMs: 100 });
    let thread = store.getState().threads['c1'];
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0].messageId.startsWith('optimistic-')).toBe(true);

    mock.emit('chat.message', {
      occurredAt: '2026-07-01T00:00:00.000Z',
      scope: 'worktree',
      chatId: 'c1',
      message: {
        messageId: 'srv-1',
        chatId: 'c1',
        role: 'user',
        status: 'complete',
        text: 'hello',
        createdAtMs: 300,
      },
    });

    thread = store.getState().threads['c1'];
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0].messageId).toBe('srv-1');
  });

  it('does not insert an optimistic echo when the authoritative frame already arrived', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);

    // Server frame lands first (faster than the UI's optimistic insert).
    mock.emit('chat.message', {
      occurredAt: '2026-07-01T00:00:00.000Z',
      scope: 'worktree',
      chatId: 'c1',
      message: {
        messageId: 'srv-1',
        chatId: 'c1',
        role: 'user',
        status: 'complete',
        text: 'hello',
        createdAtMs: 100,
      },
    });
    store
      .getState()
      .addOptimisticUserMessage('c1', { text: 'hello', createdAtMs: 150 });

    const thread = store.getState().threads['c1'];
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0].messageId).toBe('srv-1');
  });

  describe('optimistic working indicator (send-time raise)', () => {
    const turnTimer = (
      status: PortalChatMessage['status'],
      createdAtMs: number,
      messageId = 'u1:turn-timer',
    ): PortalChatMessage =>
      chatMessage({
        messageId,
        role: 'system',
        status,
        parts: [
          {
            kind: 'turn_timer',
            data: {
              startedAt: 0,
              completedAt: status === 'streaming' ? null : createdAtMs,
            },
          },
        ],
        createdAtMs,
      });
    const emitTo = (
      mock: ReturnType<typeof createMockClient>,
      message: PortalChatMessage,
    ): void =>
      mock.emit('chat.message', {
        occurredAt: '2026-07-01T00:00:00.000Z',
        scope: 'worktree',
        chatId: 'c1',
        message,
      });

    it('raises status/turnActive immediately on the optimistic echo', () => {
      const mock = createMockClient();
      const store = createChatStore(mock.client);

      store
        .getState()
        .addOptimisticUserMessage('c1', { text: 'hello', createdAtMs: 100 });

      const thread = store.getState().threads['c1'];
      expect(thread.status).toBe('streaming');
      expect(thread.turnActive).toBe(true);
      expect(thread.error).toBeNull();
    });

    it('adopts a provisional optimistic turn into the canonical chat', () => {
      const store = createChatStore(createMockClient().client);
      store.getState().addOptimisticUserMessage('pending-t1', {
        text: 'hello',
        createdAtMs: 100,
        localId: 'optimistic-first',
      });

      store.getState().adoptThread('pending-t1', 'c1');

      expect(store.getState().threads['pending-t1']).toBeUndefined();
      const adopted = store.getState().threads.c1;
      expect(adopted.status).toBe('streaming');
      expect(adopted.turnActive).toBe(true);
      expect(adopted.messages).toEqual([
        expect.objectContaining({
          messageId: 'optimistic-first',
          chatId: 'c1',
        }),
      ]);
    });

    it('moves seeded settings ownership to the canonical chat during adoption', () => {
      const store = createChatStore(createMockClient().client);
      store.getState().seedTabSettings('pending-t1', {
        planMode: true,
        proposalMode: 'required',
        thinkingLevel: 'max',
      });

      store.getState().adoptThread('pending-t1', 'c1');
      store.getState().seedTabSettings(
        'c1',
        {
          planMode: false,
          proposalMode: 'optional',
          thinkingLevel: 'medium',
        },
        { ifAbsent: true },
      );

      expect(store.getState().seededSettingsChatIds).toEqual({ c1: true });
      expect(store.getState().threads.c1).toEqual(
        expect.objectContaining({
          planMode: true,
          proposalMode: 'required',
          thinkingLevel: 'max',
        }),
      );
    });

    it('merges canonical frames that arrive before provisional adoption', () => {
      const mock = createMockClient();
      const store = createChatStore(mock.client);
      store.getState().addOptimisticUserMessage('pending-t1', {
        text: 'hello',
        createdAtMs: 100,
        localId: 'optimistic-first',
      });
      emitTo(
        mock,
        chatMessage({
          messageId: 'server-user',
          role: 'user',
          text: 'hello',
          createdAtMs: 100,
        }),
      );
      emitTo(mock, turnTimer('streaming', 101, 'server-user:turn-timer'));

      store.getState().adoptThread('pending-t1', 'c1');

      const adopted = store.getState().threads.c1;
      expect(adopted.status).toBe('streaming');
      expect(adopted.turnActive).toBe(true);
      expect(
        adopted.messages.some((message) =>
          message.messageId.startsWith('optimistic-'),
        ),
      ).toBe(false);

      emitTo(mock, turnTimer('complete', 102, 'server-user:turn-timer'));
      expect(store.getState().threads.c1.status).toBe('idle');
      expect(store.getState().threads.c1.turnActive).toBe(false);
    });

    it('clears a previous error when a new send starts', () => {
      const mock = createMockClient();
      const store = createChatStore(mock.client);
      emitTo(
        mock,
        chatMessage({
          messageId: 'a1',
          role: 'assistant',
          status: 'failed',
          text: 'boom',
          createdAtMs: 10,
        }),
      );
      expect(store.getState().threads['c1'].status).toBe('error');

      store
        .getState()
        .addOptimisticUserMessage('c1', { text: 'retry', createdAtMs: 100 });

      const thread = store.getState().threads['c1'];
      expect(thread.status).toBe('streaming');
      expect(thread.error).toBeNull();
    });

    it('raises the indicator even on the late-echo path (echo skipped)', () => {
      const mock = createMockClient();
      const store = createChatStore(mock.client);
      // Server user frame lands before the UI inserts its echo.
      emitTo(
        mock,
        chatMessage({
          messageId: 'srv-1',
          role: 'user',
          status: 'complete',
          text: 'hello',
          createdAtMs: 100,
        }),
      );

      store
        .getState()
        .addOptimisticUserMessage('c1', { text: 'hello', createdAtMs: 150 });

      const thread = store.getState().threads['c1'];
      expect(thread.messages).toHaveLength(1);
      expect(thread.status).toBe('streaming');
      expect(thread.turnActive).toBe(true);
    });

    it('rolls back only the failed optimistic bubble and preserves thread data', () => {
      const mock = createMockClient();
      const store = createChatStore(mock.client);
      emitTo(
        mock,
        chatMessage({
          messageId: 'old-user',
          role: 'user',
          text: 'older question',
          createdAtMs: 1,
        }),
      );
      emitTo(
        mock,
        chatMessage({
          messageId: 'old-answer',
          role: 'assistant',
          text: 'older answer',
          createdAtMs: 2,
        }),
      );
      const queuedMessages = [
        {
          id: 'queue-1',
          text: 'queued follow-up',
          origin: 'portal' as const,
          enqueuedAtMs: 3,
        },
      ];
      store.getState().hydrate('c1', [], {
        queuedMessages,
        route: {
          scope: 'worktree',
          workspaceLocalId: 'workspace-1',
          worktreeLocalId: 'worktree-1',
        },
        settings: {
          planMode: true,
          proposalMode: 'required',
          thinkingLevel: 'max',
          pendingPlanExit: { plan: 'review' },
        },
      });

      store.getState().addOptimisticUserMessage('c1', {
        text: 'will fail',
        createdAtMs: 100,
        localId: 'optimistic-failed-send',
      });
      const raised = store.getState().threads['c1'];
      expect(raised.status).toBe('streaming');
      expect(raised.turnActive).toBe(true);
      expect(raised.error).toBeNull();
      expect(
        raised.messages.some(
          (message) => message.messageId === 'optimistic-failed-send',
        ),
      ).toBe(true);
      expect(
        raised.turnGroups.some(
          (group) => group.userMessageId === 'optimistic-failed-send',
        ),
      ).toBe(true);

      store.getState().rollbackOptimisticSend('c1', {
        localId: 'optimistic-failed-send',
      });

      const rolledBack = store.getState().threads['c1'];
      expect(rolledBack.status).toBe('idle');
      expect(rolledBack.turnActive).toBe(false);
      expect(rolledBack.error).toBeNull();
      expect(rolledBack.messages.map((message) => message.messageId)).toEqual([
        'old-user',
        'old-answer',
      ]);
      expect(
        rolledBack.turnGroups.some(
          (group) => group.userMessageId === 'optimistic-failed-send',
        ),
      ).toBe(false);
      expect(rolledBack.queuedMessages).toBe(queuedMessages);
      expect(rolledBack.route).toEqual({
        scope: 'worktree',
        workspaceLocalId: 'workspace-1',
        worktreeLocalId: 'worktree-1',
      });
      expect(rolledBack.planMode).toBe(true);
      expect(rolledBack.proposalMode).toBe('required');
      expect(rolledBack.thinkingLevel).toBe('max');
      expect(rolledBack.pendingPlanExit).toEqual({ plan: 'review' });
      expect(rolledBack.lastEventAt).toBe(2);
    });

    it('restores the pre-send error baseline instead of forcing idle', () => {
      const store = createChatStore(createMockClient().client);
      store.getState().hydrate('c1', [], {
        status: 'error',
        error: 'previous turn failed',
        turnActive: false,
      });
      const errorBaseline = store.getState().threads['c1'];
      expect(errorBaseline.status).toBe('error');
      expect(errorBaseline.error).toBe('previous turn failed');

      store.getState().addOptimisticUserMessage('c1', {
        text: 'retry that',
        createdAtMs: 100,
        localId: 'optimistic-from-error',
      });
      const raised = store.getState().threads['c1'];
      expect(raised.status).toBe('streaming');
      expect(raised.error).toBeNull();
      expect(raised.turnActive).toBe(true);

      store
        .getState()
        .rollbackOptimisticSend('c1', { localId: 'optimistic-from-error' });

      const rolledBack = store.getState().threads['c1'];
      expect(rolledBack.status).toBe('error');
      expect(rolledBack.error).toBe('previous turn failed');
      expect(rolledBack.turnActive).toBe(false);
      expect(
        rolledBack.messages.some(
          (message) => message.messageId === 'optimistic-from-error',
        ),
      ).toBe(false);
    });

    it('keeps unknown and repeated rollbacks referentially inert', () => {
      const store = createChatStore(createMockClient().client);
      store.getState().addOptimisticUserMessage('c1', {
        text: 'hello',
        createdAtMs: 100,
        localId: 'optimistic-owned',
      });

      const beforeUnknown = store.getState().threads['c1'];
      store.getState().rollbackOptimisticSend('c1', {
        localId: 'optimistic-unknown',
      });
      expect(store.getState().threads['c1']).toBe(beforeUnknown);

      store
        .getState()
        .rollbackOptimisticSend('c1', { localId: 'optimistic-owned' });
      const afterFirst = store.getState().threads['c1'];
      store
        .getState()
        .rollbackOptimisticSend('c1', { localId: 'optimistic-owned' });
      expect(store.getState().threads['c1']).toBe(afterFirst);
    });

    it('does not let an older rejection lower a newer optimistic owner', () => {
      const store = createChatStore(createMockClient().client);
      store.getState().addOptimisticUserMessage('c1', {
        text: 'first',
        createdAtMs: 100,
        localId: 'optimistic-a',
      });
      store.getState().addOptimisticUserMessage('c1', {
        text: 'second',
        createdAtMs: 101,
        localId: 'optimistic-b',
      });

      const beforeRollback = store.getState().threads['c1'];
      store
        .getState()
        .rollbackOptimisticSend('c1', { localId: 'optimistic-a' });

      const afterRollback = store.getState().threads['c1'];
      expect(afterRollback).toBe(beforeRollback);
      expect(afterRollback.status).toBe('streaming');
      expect(afterRollback.turnActive).toBe(true);
      expect(
        afterRollback.messages.map((message) => message.messageId),
      ).toEqual(['optimistic-a', 'optimistic-b']);
    });

    it('makes rollback a no-op after a matching authoritative echo arrives', () => {
      const mock = createMockClient();
      const store = createChatStore(mock.client);
      store.getState().addOptimisticUserMessage('c1', {
        text: 'hello',
        createdAtMs: 100,
        localId: 'optimistic-owned',
      });
      emitTo(
        mock,
        chatMessage({
          messageId: 'server-user',
          role: 'user',
          text: 'hello',
          createdAtMs: 200,
        }),
      );

      const authoritative = store.getState().threads['c1'];
      expect(
        authoritative.messages.map((message) => message.messageId),
      ).toEqual(['server-user']);
      store
        .getState()
        .rollbackOptimisticSend('c1', { localId: 'optimistic-owned' });
      expect(store.getState().threads['c1']).toBe(authoritative);
    });

    it('rebinds to the authoritative echo before a matching streaming timer takes ownership', () => {
      const mock = createMockClient();
      const store = createChatStore(mock.client);
      store.getState().addOptimisticUserMessage('c1', {
        text: 'hello',
        createdAtMs: 10_000,
        localId: 'optimistic-owned',
      });
      emitTo(
        mock,
        chatMessage({
          messageId: 'server-user',
          role: 'user',
          text: 'hello',
          createdAtMs: 10_001,
        }),
      );
      // The timer clock is far behind the client. Canonical turn identity, not
      // timestamps, decides that the real turn has started.
      emitTo(mock, turnTimer('streaming', 1, 'server-user:turn-timer'));

      const authoritative = store.getState().threads['c1'];
      store
        .getState()
        .rollbackOptimisticSend('c1', { localId: 'optimistic-owned' });
      const afterRollback = store.getState().threads['c1'];
      expect(afterRollback).toBe(authoritative);
      expect(afterRollback.status).toBe('streaming');
      expect(afterRollback.turnActive).toBe(true);
      expect(
        afterRollback.messages.some(
          (message) => message.messageId === 'server-user',
        ),
      ).toBe(true);
    });

    it('lets a matching terminal timer complete after the authoritative echo', () => {
      const mock = createMockClient();
      const store = createChatStore(mock.client);
      store.getState().addOptimisticUserMessage('c1', {
        text: 'hello',
        createdAtMs: 100,
        localId: 'optimistic-owned',
      });
      emitTo(
        mock,
        chatMessage({
          messageId: 'server-user',
          role: 'user',
          text: 'hello',
          createdAtMs: 150,
        }),
      );
      emitTo(mock, turnTimer('complete', 200, 'server-user:turn-timer'));

      const authoritative = store.getState().threads['c1'];
      expect(authoritative.status).toBe('idle');
      expect(authoritative.turnActive).toBe(false);
      store
        .getState()
        .rollbackOptimisticSend('c1', { localId: 'optimistic-owned' });
      expect(store.getState().threads['c1']).toBe(authoritative);
      expect(
        authoritative.messages.map((message) => message.messageId),
      ).toEqual(['server-user', 'server-user:turn-timer']);
    });

    it('does not let ahead-clock authoritative history preempt a later owner', () => {
      const store = createChatStore(createMockClient().client);
      store.getState().hydrate('c1', [
        chatMessage({
          messageId: 'future-history',
          role: 'assistant',
          text: 'older turn from an ahead clock',
          createdAtMs: 50_000,
          updatedAtMs: 60_000,
        }),
      ]);
      store.getState().addOptimisticUserMessage('c1', {
        text: 'hello',
        createdAtMs: 100,
        localId: 'optimistic-owned',
      });

      store
        .getState()
        .rollbackOptimisticSend('c1', { localId: 'optimistic-owned' });
      const rolledBack = store.getState().threads['c1'];
      expect(rolledBack.status).toBe('idle');
      expect(rolledBack.turnActive).toBe(false);
      expect(rolledBack.messages.map((message) => message.messageId)).toEqual([
        'future-history',
      ]);
    });

    it('retains ownership across a delayed content-only authoritative frame', () => {
      const mock = createMockClient();
      const store = createChatStore(mock.client);
      store.getState().addOptimisticUserMessage('c1', {
        text: 'hello',
        createdAtMs: 100,
        localId: 'optimistic-owned',
      });
      emitTo(
        mock,
        chatMessage({
          messageId: 'old-answer',
          role: 'assistant',
          status: 'complete',
          text: 'delayed prior-turn content',
          createdAtMs: 1,
        }),
      );

      store
        .getState()
        .rollbackOptimisticSend('c1', { localId: 'optimistic-owned' });
      const rolledBack = store.getState().threads['c1'];
      expect(rolledBack.status).toBe('idle');
      expect(rolledBack.turnActive).toBe(false);
      expect(rolledBack.messages.map((message) => message.messageId)).toEqual([
        'old-answer',
      ]);
    });

    it('treats a failed assistant as takeover even when it is the first host frame', () => {
      const mock = createMockClient();
      const store = createChatStore(mock.client);
      store.getState().addOptimisticUserMessage('c1', {
        text: 'hello',
        createdAtMs: 100,
        localId: 'optimistic-owned',
      });
      emitTo(
        mock,
        chatMessage({
          messageId: 'failed-answer',
          role: 'assistant',
          status: 'failed',
          text: 'host failed the accepted turn',
          createdAtMs: 200,
        }),
      );

      const authoritative = store.getState().threads['c1'];
      expect(authoritative.status).toBe('error');
      expect(authoritative.error).toBe('host failed the accepted turn');
      store
        .getState()
        .rollbackOptimisticSend('c1', { localId: 'optimistic-owned' });
      expect(store.getState().threads['c1']).toBe(authoritative);
      expect(
        authoritative.messages.some(
          (message) => message.messageId === 'optimistic-owned',
        ),
      ).toBe(true);
    });

    it('ignores a newly hydrated terminal timer from an older turn', () => {
      const store = createChatStore(createMockClient().client);
      store.getState().addOptimisticUserMessage('c1', {
        text: 'hello',
        createdAtMs: 100,
        localId: 'optimistic-owned',
      });
      store
        .getState()
        .hydrate('c1', [turnTimer('complete', 200, 'old:turn-timer')]);

      const raised = store.getState().threads['c1'];
      expect(raised.status).toBe('streaming');
      expect(raised.turnActive).toBe(true);
      store
        .getState()
        .rollbackOptimisticSend('c1', { localId: 'optimistic-owned' });
      const afterRollback = store.getState().threads['c1'];
      expect(afterRollback.status).toBe('idle');
      expect(afterRollback.turnActive).toBe(false);
      expect(
        afterRollback.messages.map((message) => message.messageId),
      ).toEqual(['old:turn-timer']);
    });

    it('clears ownership when hydration reconciles the optimistic echo', () => {
      const store = createChatStore(createMockClient().client);
      store.getState().addOptimisticUserMessage('c1', {
        text: 'hello',
        createdAtMs: 100,
        localId: 'optimistic-owned',
      });
      store.getState().hydrate('c1', [
        chatMessage({
          messageId: 'server-user',
          role: 'user',
          text: 'hello',
          createdAtMs: 200,
        }),
      ]);

      const authoritative = store.getState().threads['c1'];
      expect(
        authoritative.messages.map((message) => message.messageId),
      ).toEqual(['server-user']);
      store
        .getState()
        .rollbackOptimisticSend('c1', { localId: 'optimistic-owned' });
      expect(store.getState().threads['c1']).toBe(authoritative);
    });

    it('does not clear ownership for repeated pre-baseline lifecycle history', () => {
      const store = createChatStore(createMockClient().client);
      const priorTimer = turnTimer('complete', 50, 'prior:turn-timer');
      store.getState().hydrate('c1', [priorTimer]);
      store.getState().addOptimisticUserMessage('c1', {
        text: 'hello',
        createdAtMs: 100,
        localId: 'optimistic-owned',
      });

      store
        .getState()
        .hydrate('c1', [turnTimer('complete', 60, 'prior:turn-timer')]);
      store
        .getState()
        .rollbackOptimisticSend('c1', { localId: 'optimistic-owned' });
      const rolledBack = store.getState().threads['c1'];
      expect(rolledBack.status).toBe('idle');
      expect(rolledBack.turnActive).toBe(false);
      expect(rolledBack.messages.map((message) => message.messageId)).toEqual([
        'prior:turn-timer',
      ]);
    });

    it('keeps a repeated old terminal snapshot from lowering a new optimistic turn', () => {
      const store = createChatStore(createMockClient().client);
      const priorTimer = turnTimer('complete', 50, 'prior:turn-timer');
      store.getState().hydrate('c1', [priorTimer]);
      store.getState().addOptimisticUserMessage('c1', {
        text: 'hello',
        createdAtMs: 100,
        localId: 'optimistic-owned',
      });

      store.getState().hydrate('c1', [{ ...priorTimer }]);

      const thread = store.getState().threads['c1'];
      expect(thread.status).toBe('streaming');
      expect(thread.turnActive).toBe(true);
      expect(thread.messages.map((message) => message.messageId)).toEqual([
        'prior:turn-timer',
        'optimistic-owned',
      ]);
    });

    it('keeps a live terminal frame from an older turn out of the owned lifecycle', () => {
      const mock = createMockClient();
      const store = createChatStore(mock.client);
      store.getState().addOptimisticUserMessage('c1', {
        text: 'hello',
        createdAtMs: 100,
        localId: 'optimistic-owned',
      });

      emitTo(mock, turnTimer('complete', 200, 'old-user:turn-timer'));

      const thread = store.getState().threads['c1'];
      expect(thread.status).toBe('streaming');
      expect(thread.turnActive).toBe(true);
      store
        .getState()
        .rollbackOptimisticSend('c1', { localId: 'optimistic-owned' });
      expect(store.getState().threads['c1'].status).toBe('idle');
    });

    it('allows a matching terminal timer without observing its streaming start', () => {
      const mock = createMockClient();
      const store = createChatStore(mock.client);
      store.getState().addOptimisticUserMessage('c1', {
        text: 'hello',
        createdAtMs: 100,
        localId: 'optimistic-owned',
      });
      emitTo(
        mock,
        chatMessage({
          messageId: 'server-user',
          role: 'user',
          text: 'hello',
          createdAtMs: 150,
        }),
      );

      emitTo(mock, turnTimer('complete', 200, 'server-user:turn-timer'));

      const thread = store.getState().threads['c1'];
      expect(thread.status).toBe('idle');
      expect(thread.turnActive).toBe(false);
    });

    it('does not let turn A terminal state regress the newer turn B owner', () => {
      const mock = createMockClient();
      const store = createChatStore(mock.client);
      store.getState().addOptimisticUserMessage('c1', {
        text: 'first',
        createdAtMs: 100,
        localId: 'optimistic-a',
      });
      store.getState().addOptimisticUserMessage('c1', {
        text: 'second',
        createdAtMs: 200,
        localId: 'optimistic-b',
      });
      emitTo(
        mock,
        chatMessage({
          messageId: 'server-b',
          role: 'user',
          text: 'second',
          createdAtMs: 250,
        }),
      );

      emitTo(mock, turnTimer('complete', 300, 'server-a:turn-timer'));

      const thread = store.getState().threads['c1'];
      expect(thread.status).toBe('streaming');
      expect(thread.turnActive).toBe(true);
      expect(thread.messages.map((message) => message.messageId)).toEqual([
        'optimistic-a',
        'server-b',
        'server-a:turn-timer',
      ]);
    });

    it('treats explicit hydrated runtime state as authoritative takeover', () => {
      const store = createChatStore(createMockClient().client);
      store.getState().addOptimisticUserMessage('c1', {
        text: 'hello',
        createdAtMs: 100,
        localId: 'optimistic-owned',
      });
      store.getState().hydrate('c1', [], {
        status: 'error',
        error: 'host failed',
        turnActive: false,
      });

      const authoritative = store.getState().threads['c1'];
      store
        .getState()
        .rollbackOptimisticSend('c1', { localId: 'optimistic-owned' });
      expect(store.getState().threads['c1']).toBe(authoritative);
      expect(authoritative.status).toBe('error');
      expect(authoritative.error).toBe('host failed');
      expect(authoritative.turnActive).toBe(false);
    });

    it('keeps queue-only hydration neutral to rollback ownership', () => {
      const store = createChatStore(createMockClient().client);
      store.getState().addOptimisticUserMessage('c1', {
        text: 'hello',
        createdAtMs: 100,
        localId: 'optimistic-owned',
      });
      const queuedMessages = [
        {
          id: 'queue-1',
          text: 'queued follow-up',
          origin: 'portal' as const,
          enqueuedAtMs: 101,
        },
      ];
      store.getState().hydrate('c1', [], { queuedMessages });

      store
        .getState()
        .rollbackOptimisticSend('c1', { localId: 'optimistic-owned' });
      const rolledBack = store.getState().threads['c1'];
      expect(rolledBack.status).toBe('idle');
      expect(rolledBack.turnActive).toBe(false);
      expect(rolledBack.messages).toEqual([]);
      expect(rolledBack.queuedMessages).toBe(queuedMessages);
    });

    it('does not register rollback ownership on the late-echo path', () => {
      const mock = createMockClient();
      const store = createChatStore(mock.client);
      emitTo(
        mock,
        chatMessage({
          messageId: 'server-user',
          role: 'user',
          text: 'hello',
          createdAtMs: 100,
        }),
      );
      store.getState().addOptimisticUserMessage('c1', {
        text: 'hello',
        createdAtMs: 150,
        localId: 'optimistic-owned',
      });

      const lateEcho = store.getState().threads['c1'];
      store
        .getState()
        .rollbackOptimisticSend('c1', { localId: 'optimistic-owned' });
      expect(store.getState().threads['c1']).toBe(lateEcho);
    });

    it('clears ownership on reset and client disposal', () => {
      const store = createChatStore(createMockClient().client);
      store.getState().addOptimisticUserMessage('c1', {
        text: 'reset send',
        createdAtMs: 100,
        localId: 'optimistic-reset',
      });
      store.getState().reset('c1');
      const afterReset = store.getState();
      store
        .getState()
        .rollbackOptimisticSend('c1', { localId: 'optimistic-reset' });
      expect(store.getState()).toBe(afterReset);

      store.getState().addOptimisticUserMessage('c1', {
        text: 'disposed send',
        createdAtMs: 200,
        localId: 'optimistic-disposed',
      });
      store[CLIENT_STORE_DISPOSE]?.();
      const beforeLateRejection = store.getState().threads['c1'];
      store.getState().rollbackOptimisticSend('c1', {
        localId: 'optimistic-disposed',
      });
      expect(store.getState().threads['c1']).toBe(beforeLateRejection);
    });

    it('keeps ownership after matching streaming so a stale live terminal cannot complete the turn', () => {
      const mock = createMockClient();
      const store = createChatStore(mock.client);
      store
        .getState()
        .addOptimisticUserMessage('c1', { text: 'hello', createdAtMs: 100 });
      emitTo(
        mock,
        chatMessage({
          messageId: 'server-user',
          role: 'user',
          text: 'hello',
          createdAtMs: 150,
        }),
      );
      emitTo(mock, turnTimer('streaming', 200, 'server-user:turn-timer'));
      expect(store.getState().threads['c1'].status).toBe('streaming');
      emitTo(mock, turnTimer('complete', 250, 'old-user:turn-timer'));
      expect(store.getState().threads['c1'].status).toBe('streaming');
      expect(store.getState().threads['c1'].turnActive).toBe(true);
      emitTo(mock, turnTimer('complete', 300, 'server-user:turn-timer'));

      const thread = store.getState().threads['c1'];
      expect(thread.status).toBe('idle');
      expect(thread.turnActive).toBe(false);
    });

    it('live streaming timer rebinds an owner when the authoritative echo is outside the reconciliation window', () => {
      const mock = createMockClient();
      const store = createChatStore(mock.client);
      store
        .getState()
        .addOptimisticUserMessage('c1', { text: 'hello', createdAtMs: 100 });
      emitTo(
        mock,
        chatMessage({
          messageId: 'server-user',
          role: 'user',
          text: 'hello',
          createdAtMs: 1_101,
        }),
      );

      emitTo(mock, turnTimer('streaming', 1_102, 'server-user:turn-timer'));
      expect(store.getState().threads['c1'].status).toBe('streaming');
      expect(store.getState().threads['c1'].turnActive).toBe(true);
      emitTo(mock, turnTimer('complete', 1_103, 'server-user:turn-timer'));

      const completed = store.getState().threads['c1'];
      expect(completed.status).toBe('idle');
      expect(completed.turnActive).toBe(false);
      store.getState().rollbackOptimisticSend('c1', {
        localId: 'optimistic-100-user',
      });
      expect(store.getState().threads['c1']).toBe(completed);
    });

    it('hydrate rebinds an unbound owner to the newest streaming timer and accepts its terminal frame', () => {
      const store = createChatStore(createMockClient().client);
      store
        .getState()
        .addOptimisticUserMessage('c1', { text: 'hello', createdAtMs: 100 });
      store.getState().hydrate('c1', [
        chatMessage({
          messageId: 'server-user',
          role: 'user',
          text: 'hello',
          createdAtMs: 1_101,
        }),
        turnTimer('streaming', 1_102, 'older-start:turn-timer'),
        turnTimer('streaming', 1_103, 'server-user:turn-timer'),
      ]);

      expect(store.getState().threads['c1'].status).toBe('streaming');
      expect(store.getState().threads['c1'].turnActive).toBe(true);
      store
        .getState()
        .hydrate('c1', [
          turnTimer('complete', 1_104, 'server-user:turn-timer'),
        ]);

      const completed = store.getState().threads['c1'];
      expect(completed.status).toBe('idle');
      expect(completed.turnActive).toBe(false);
      store.getState().rollbackOptimisticSend('c1', {
        localId: 'optimistic-100-user',
      });
      expect(store.getState().threads['c1']).toBe(completed);
    });

    it('keeps ownership after matching streaming so a stale hydrated terminal cannot complete the turn', () => {
      const mock = createMockClient();
      const store = createChatStore(mock.client);
      store
        .getState()
        .addOptimisticUserMessage('c1', { text: 'hello', createdAtMs: 100 });
      emitTo(
        mock,
        chatMessage({
          messageId: 'server-user',
          role: 'user',
          text: 'hello',
          createdAtMs: 150,
        }),
      );
      emitTo(mock, turnTimer('streaming', 200, 'server-user:turn-timer'));

      store
        .getState()
        .hydrate('c1', [turnTimer('complete', 250, 'old-user:turn-timer')]);
      expect(store.getState().threads['c1'].status).toBe('streaming');
      expect(store.getState().threads['c1'].turnActive).toBe(true);

      store
        .getState()
        .hydrate('c1', [
          turnTimer('complete', 250, 'old-user:turn-timer'),
          turnTimer('complete', 300, 'server-user:turn-timer'),
        ]);
      const thread = store.getState().threads['c1'];
      expect(thread.status).toBe('idle');
      expect(thread.turnActive).toBe(false);
    });

    it('a snapshot hydrate without host status does not lower the optimistic raise', () => {
      const mock = createMockClient();
      const store = createChatStore(mock.client);
      store
        .getState()
        .addOptimisticUserMessage('c1', { text: 'hello', createdAtMs: 100 });

      // Portal snapshot growth re-pushes already-known history with no
      // explicit host status; the in-flight optimistic raise must survive.
      store.getState().hydrate('c1', [
        chatMessage({
          messageId: 'old-user',
          role: 'user',
          text: 'older question',
          createdAtMs: 1,
        }),
        chatMessage({
          messageId: 'old-answer',
          role: 'assistant',
          text: 'older answer',
          createdAtMs: 2,
        }),
      ]);

      const thread = store.getState().threads['c1'];
      expect(thread.status).toBe('streaming');
      expect(thread.turnActive).toBe(true);
    });
  });

  it('reset cancels a pending persist', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);
    store.getState().setPlanMode('c1', true);
    store.getState().reset('c1');
    jest.advanceTimersByTime(500);
    expect(persistCalls(mock)).toHaveLength(0);
  });
});

describe('createChatStore — bindOptimisticSend (identity reconcile)', () => {
  const userEcho = (
    args: Partial<PortalChatMessage> & Pick<PortalChatMessage, 'messageId'>,
  ): PortalChatMessage =>
    chatMessage({
      role: 'user',
      text: 'hello',
      createdAtMs: 60_000,
      ...args,
    });

  const emitEcho = (
    mock: ReturnType<typeof createMockClient>,
    chatId: string,
    message: PortalChatMessage,
  ): void => {
    mock.emit('chat.message', {
      occurredAt: '2026-08-27T00:00:00.000Z',
      scope: 'app_advisor',
      chatId,
      message: { ...message, chatId },
    });
  };

  it('adoption with a pre-landed bound echo never text-collapses a second same-text send', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);
    // Provisional thread: the bound first send plus a second identical send
    // still in flight.
    store.getState().addOptimisticUserMessage('pending', {
      text: 'hello',
      createdAtMs: 59_900,
      localId: 'optimistic-1-1',
    });
    store.getState().addOptimisticUserMessage('pending', {
      text: 'hello',
      createdAtMs: 59_950,
      localId: 'optimistic-1-2',
    });
    store.getState().bindOptimisticSend('pending', {
      optimisticLocalId: 'optimistic-1-1',
      userMessageId: 'msg-real',
    });
    // The canonical echo landed on the target before adoption (within skew
    // of both optimistic rows).
    emitEcho(mock, 'canonical', userEcho({ messageId: 'msg-real' }));

    store.getState().adoptThread('pending', 'canonical');

    const ids = store
      .getState()
      .threads['canonical'].messages.map((m) => m.messageId)
      .sort();
    expect(ids).toEqual(['msg-real', 'optimistic-1-2'].sort());
  });

  it('a consumed echo never suppresses a new same-text send within the skew window', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);
    // First send: bound, echo arrives, binding consumed.
    store.getState().addOptimisticUserMessage('c1', {
      text: 'hello',
      createdAtMs: 59_800,
      localId: 'optimistic-1-1',
    });
    store.getState().bindOptimisticSend('c1', {
      optimisticLocalId: 'optimistic-1-1',
      userMessageId: 'msg-real',
    });
    emitEcho(mock, 'c1', userEcho({ messageId: 'msg-real' }));
    expect(store.getState().threads['c1'].messages).toHaveLength(1);

    // A NEW identical send within the skew window of the consumed echo: its
    // optimistic row must insert (not be mistaken for the consumed echo's
    // late-echo case) and own its own lifecycle.
    store.getState().addOptimisticUserMessage('c1', {
      text: 'hello',
      createdAtMs: 60_100,
      localId: 'optimistic-1-2',
    });
    store.getState().bindOptimisticSend('c1', {
      optimisticLocalId: 'optimistic-1-2',
      userMessageId: 'msg-real-2',
    });

    const ids = store
      .getState()
      .threads['c1'].messages.map((m) => m.messageId)
      .sort();
    expect(ids).toEqual(['msg-real', 'optimistic-1-2'].sort());

    // The consumed FIRST turn's terminal timer must not end the new turn.
    emitEcho(mock, 'c1', {
      ...chatMessage({
        messageId: 'msg-real:turn-timer',
        role: 'system',
        status: 'complete',
        parts: [
          {
            kind: 'turn_timer',
            data: { startedAt: 60_000, completedAt: 60_050 },
          },
        ],
        createdAtMs: 60_051,
      }),
    });
    expect(store.getState().threads['c1'].turnActive).toBe(true);

    // The new send's own echo reconciles it by identity.
    emitEcho(
      mock,
      'c1',
      userEcho({ messageId: 'msg-real-2', createdAtMs: 62_000 }),
    );
    const finalIds = store
      .getState()
      .threads['c1'].messages.map((m) => m.messageId)
      .sort();
    expect(finalIds).toEqual(
      ['msg-real', 'msg-real-2', 'msg-real:turn-timer'].sort(),
    );
  });

  it('a previously consumed echo never collapses a later send via hydrate or adoption', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);
    // Consume a bound echo via ingest.
    store.getState().addOptimisticUserMessage('c1', {
      text: 'hello',
      createdAtMs: 59_800,
      localId: 'optimistic-1-1',
    });
    store.getState().bindOptimisticSend('c1', {
      optimisticLocalId: 'optimistic-1-1',
      userMessageId: 'msg-real',
    });
    emitEcho(mock, 'c1', userEcho({ messageId: 'msg-real' }));

    // New same-text send in flight, then a reconnect snapshot that carries
    // the OLD consumed echo again: hydrate must not collapse the new row.
    store.getState().addOptimisticUserMessage('c1', {
      text: 'hello',
      createdAtMs: 60_100,
      localId: 'optimistic-1-2',
    });
    store
      .getState()
      .hydrate('c1', [userEcho({ messageId: 'msg-real', chatId: 'c1' })]);
    expect(
      store
        .getState()
        .threads['c1'].messages.map((m) => m.messageId)
        .sort(),
    ).toEqual(['msg-real', 'optimistic-1-2'].sort());
  });

  it('reset(chatId) clears the consumed-echo memory for a reused chat id', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);
    store.getState().addOptimisticUserMessage('c1', {
      text: 'hello',
      createdAtMs: 59_800,
      localId: 'optimistic-1-1',
    });
    store.getState().bindOptimisticSend('c1', {
      optimisticLocalId: 'optimistic-1-1',
      userMessageId: 'msg-real',
    });
    emitEcho(mock, 'c1', userEcho({ messageId: 'msg-real' }));
    store.getState().reset('c1');

    // The reused chat id starts clean: the old echo id (arriving fresh in
    // the new thread) participates in normal matching again.
    store.getState().addOptimisticUserMessage('c1', {
      text: 'hello',
      createdAtMs: 60_100,
      localId: 'optimistic-2-1',
    });
    emitEcho(mock, 'c1', userEcho({ messageId: 'msg-real' }));
    // Text-skew fallback reconciles the unbound optimistic row as usual.
    expect(
      store.getState().threads['c1'].messages.map((m) => m.messageId),
    ).toEqual(['msg-real']);
  });

  it('consuming a binding never text-collapses a second same-text send (ingest)', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);
    // Two deliberately identical sends: the older one is bound and its echo
    // arrives; the newer one is still in flight and must keep its bubble.
    store.getState().addOptimisticUserMessage('c1', {
      text: 'hello',
      createdAtMs: 59_900,
      localId: 'optimistic-1-1',
    });
    store.getState().addOptimisticUserMessage('c1', {
      text: 'hello',
      createdAtMs: 59_950,
      localId: 'optimistic-1-2',
    });
    store.getState().bindOptimisticSend('c1', {
      optimisticLocalId: 'optimistic-1-1',
      userMessageId: 'msg-real',
    });

    // The echo (createdAtMs 60_000) is within RECONCILE_SKEW_MS of BOTH
    // optimistic rows — the identity consume must remove only the bound one.
    emitEcho(mock, 'c1', userEcho({ messageId: 'msg-real' }));

    const ids = store
      .getState()
      .threads['c1'].messages.map((m) => m.messageId)
      .sort();
    expect(ids).toEqual(['msg-real', 'optimistic-1-2'].sort());
  });

  it('a hydrated bound echo never text-collapses a second same-text send', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);
    store.getState().addOptimisticUserMessage('c1', {
      text: 'hello',
      createdAtMs: 59_900,
      localId: 'optimistic-1-1',
    });
    store.getState().addOptimisticUserMessage('c1', {
      text: 'hello',
      createdAtMs: 59_950,
      localId: 'optimistic-1-2',
    });
    store.getState().bindOptimisticSend('c1', {
      optimisticLocalId: 'optimistic-1-1',
      userMessageId: 'msg-real',
    });

    // Reconnect snapshot carries the bound echo (within skew of both rows).
    store
      .getState()
      .hydrate('c1', [userEcho({ messageId: 'msg-real', chatId: 'c1' })]);

    const ids = store
      .getState()
      .threads['c1'].messages.map((m) => m.messageId)
      .sort();
    expect(ids).toEqual(['msg-real', 'optimistic-1-2'].sort());

    // The surviving send's raise ownership must NOT have been rebound onto
    // the consumed echo: the consumed turn's terminal timer must leave the
    // surviving turn's lifecycle active.
    emitEcho(mock, 'c1', {
      ...chatMessage({
        messageId: 'msg-real:turn-timer',
        role: 'system',
        status: 'complete',
        parts: [
          {
            kind: 'turn_timer',
            data: { startedAt: 60_000, completedAt: 61_000 },
          },
        ],
        createdAtMs: 60_001,
      }),
    });
    expect(store.getState().threads['c1'].turnActive).toBe(true);
  });

  it('removes the bound optimistic echo by identity beyond the skew window', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);
    store.getState().addOptimisticUserMessage('c1', {
      text: 'hello',
      createdAtMs: 1_000,
      localId: 'optimistic-1-1',
    });
    store.getState().bindOptimisticSend('c1', {
      optimisticLocalId: 'optimistic-1-1',
      userMessageId: 'msg-real',
    });

    // 59s past the optimistic insert — far outside RECONCILE_SKEW_MS, so the
    // text-based fallback alone would have stranded both bubbles.
    emitEcho(mock, 'c1', userEcho({ messageId: 'msg-real' }));

    let thread = store.getState().threads['c1'];
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0].messageId).toBe('msg-real');
    // The send-time raise survives the reconcile (the turn is in flight).
    expect(thread.turnActive).toBe(true);

    // The raise ownership rebound onto the authoritative user id: the turn's
    // terminal timer frame now ends the lifecycle.
    emitEcho(
      mock,
      'c1',
      chatMessage({
        messageId: 'msg-real:turn-timer',
        role: 'system',
        status: 'complete',
        parts: [
          {
            kind: 'turn_timer',
            data: { startedAt: 60_000, completedAt: 61_000 },
          },
        ],
        createdAtMs: 60_001,
      }),
    );
    thread = store.getState().threads['c1'];
    expect(thread.turnActive).toBe(false);
    expect(thread.status).toBe('idle');
  });

  it('reconciles the bound echo delivered via a snapshot hydrate beyond the skew window', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);
    store.getState().addOptimisticUserMessage('c1', {
      text: 'hello',
      createdAtMs: 1_000,
      localId: 'optimistic-1-1',
    });
    store.getState().bindOptimisticSend('c1', {
      optimisticLocalId: 'optimistic-1-1',
      userMessageId: 'msg-real',
    });

    store
      .getState()
      .hydrate('c1', [userEcho({ messageId: 'msg-real', chatId: 'c1' })]);

    const thread = store.getState().threads['c1'];
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0].messageId).toBe('msg-real');
  });

  it('clears the binding on rollbackOptimisticSend of that localId', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);
    store.getState().addOptimisticUserMessage('c1', {
      text: 'first',
      createdAtMs: 1_000,
      localId: 'optimistic-1-1',
    });
    store.getState().bindOptimisticSend('c1', {
      optimisticLocalId: 'optimistic-1-1',
      userMessageId: 'msg-a',
    });
    store.getState().rollbackOptimisticSend('c1', {
      localId: 'optimistic-1-1',
    });
    expect(store.getState().threads['c1'].messages).toHaveLength(0);

    // A NEWER unbound send must not be deleted by the rolled-back send's late
    // echo — the binding died with the rollback.
    store.getState().addOptimisticUserMessage('c1', {
      text: 'second',
      createdAtMs: 2_000,
      localId: 'optimistic-2-2',
    });
    emitEcho(mock, 'c1', userEcho({ messageId: 'msg-a', text: 'first' }));

    const thread = store.getState().threads['c1'];
    expect(thread.messages.map((message) => message.messageId).sort()).toEqual([
      'msg-a',
      'optimistic-2-2',
    ]);
  });

  it('normalizes an unprefixed localId when rolling back a bound send', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);
    store.getState().addOptimisticUserMessage('c1', {
      text: 'first',
      createdAtMs: 1_000,
      localId: 'send-1',
    });
    store.getState().bindOptimisticSend('c1', {
      optimisticLocalId: 'send-1',
      userMessageId: 'msg-a',
    });

    store.getState().rollbackOptimisticSend('c1', { localId: 'send-1' });

    expect(store.getState().threads['c1'].messages).toHaveLength(0);

    store.getState().addOptimisticUserMessage('c1', {
      text: 'second',
      createdAtMs: 2_000,
      localId: 'send-2',
    });
    emitEcho(mock, 'c1', userEcho({ messageId: 'msg-a', text: 'first' }));

    expect(
      store
        .getState()
        .threads['c1'].messages.map((message) => message.messageId)
        .sort(),
    ).toEqual(['msg-a', 'optimistic-send-2'].sort());
  });

  it('keeps only the latest binding per chat', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);
    store.getState().addOptimisticUserMessage('c1', {
      text: 'one',
      createdAtMs: 1_000,
      localId: 'optimistic-1-1',
    });
    store.getState().bindOptimisticSend('c1', {
      optimisticLocalId: 'optimistic-1-1',
      userMessageId: 'msg-a',
    });
    store.getState().addOptimisticUserMessage('c1', {
      text: 'two',
      createdAtMs: 2_000,
      localId: 'optimistic-2-2',
    });
    store.getState().bindOptimisticSend('c1', {
      optimisticLocalId: 'optimistic-2-2',
      userMessageId: 'msg-b',
    });

    // Only the latest send reconciles by identity; the superseded older
    // binding no longer deletes anything by id.
    emitEcho(mock, 'c1', userEcho({ messageId: 'msg-b', text: 'two' }));
    const messageIds = store
      .getState()
      .threads['c1'].messages.map((message) => message.messageId)
      .sort();
    expect(messageIds).toEqual(['msg-b', 'optimistic-1-1']);
  });

  it('carries the binding onto the adopted chat id (App Advisor first send)', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);
    store.getState().addOptimisticUserMessage('pending-app-advisor', {
      text: 'hello',
      createdAtMs: 1_000,
      localId: 'optimistic-1-1',
    });
    store.getState().bindOptimisticSend('pending-app-advisor', {
      optimisticLocalId: 'optimistic-1-1',
      userMessageId: 'msg-real',
    });

    store.getState().adoptThread('pending-app-advisor', 'canonical-chat');
    expect(store.getState().threads['pending-app-advisor']).toBeUndefined();

    emitEcho(mock, 'canonical-chat', userEcho({ messageId: 'msg-real' }));

    const thread = store.getState().threads['canonical-chat'];
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0].messageId).toBe('msg-real');
    expect(thread.messages[0].chatId).toBe('canonical-chat');
  });

  it('consumes the binding during adoption when the echo already landed on the target', () => {
    const mock = createMockClient();
    const store = createChatStore(mock.client);
    // The canonical echo wins the race and lands before adoption.
    emitEcho(mock, 'canonical-chat', userEcho({ messageId: 'msg-real' }));

    store.getState().addOptimisticUserMessage('pending-app-advisor', {
      text: 'hello',
      createdAtMs: 1_000,
      localId: 'optimistic-1-1',
    });
    store.getState().bindOptimisticSend('pending-app-advisor', {
      optimisticLocalId: 'optimistic-1-1',
      userMessageId: 'msg-real',
    });
    store.getState().adoptThread('pending-app-advisor', 'canonical-chat');

    const thread = store.getState().threads['canonical-chat'];
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0].messageId).toBe('msg-real');
  });
});

it('keeps attachments on optimistic and ingested user messages', () => {
  const mock = createMockClient();
  const store = createChatStore(mock.client);
  const attachments = [
    {
      attachmentId: '11111111-1111-4111-8111-111111111111',
      filename: 'shot.png',
      mediaType: 'image/png',
      size: 10,
    },
  ];

  store.getState().addOptimisticUserMessage('c1', {
    text: 'see attached',
    createdAtMs: 100,
    localId: 'local-att',
    attachments,
  });
  expect(store.getState().threads['c1']?.messages[0]?.attachments).toEqual(
    attachments,
  );

  mock.emit('chat.message', {
    occurredAt: '2026-07-01T00:00:00.000Z',
    scope: 'worktree',
    chatId: 'c1',
    message: chatMessage({
      messageId: 'srv-att',
      role: 'user',
      text: 'see attached',
      createdAtMs: 150,
      attachments,
    }),
  });
  const messages = store.getState().threads['c1']?.messages ?? [];
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ messageId: 'srv-att', attachments });
});

describe('user attachment retention', () => {
  const attachments = [
    {
      attachmentId: 'upload-1',
      filename: 'shot.png',
      mediaType: 'image/png',
      size: 10,
    },
  ];
  const row = chatMessage({
    messageId: 'server-1',
    role: 'user',
    text: 'sent',
    createdAtMs: 100,
  });

  it.each([false, true])(
    'retains attachments on text-only frames and hydration (replace=%s)',
    (replaceMessages) => {
      const store = createChatStore(createMockClient().client);
      store.getState().hydrate('c1', [{ ...row, attachments }]);
      store.getState().ingestMessageEvent({
        chatId: 'c1',
        scope: 'worktree',
        occurredAt: new Date(200).toISOString(),
        message: { ...row, updatedAtMs: 200 },
      });
      expect(store.getState().threads['c1']?.messages).toEqual([
        { ...row, updatedAtMs: 200, attachments },
      ]);
      store
        .getState()
        .hydrate('c1', [{ ...row, updatedAtMs: 300 }], { replaceMessages });
      expect(store.getState().threads['c1']?.messages).toEqual([
        { ...row, updatedAtMs: 300, attachments },
      ]);
      store[CLIENT_STORE_DISPOSE]?.();
    },
  );

  it('enriches same-revision attachments without rewinding text or status', () => {
    const store = createChatStore(createMockClient().client);
    store.getState().hydrate('c1', [row]);
    store
      .getState()
      .hydrate('c1', [
        { ...row, text: 'stale text', status: 'streaming', attachments },
      ]);
    expect(store.getState().threads['c1']?.messages).toEqual([
      { ...row, attachments },
    ]);
    store[CLIENT_STORE_DISPOSE]?.();
  });

  it.each(['ingest', 'hydrate'] as const)(
    'retains attachments across identity-bound slow acceptance via %s',
    (path) => {
      const store = createChatStore(createMockClient().client);
      store.getState().addOptimisticUserMessage('c1', {
        text: row.text,
        createdAtMs: 1,
        localId: 'local-1',
        attachments,
      });
      store.getState().bindOptimisticSend('c1', {
        optimisticLocalId: 'local-1',
        userMessageId: row.messageId,
      });
      const accepted = { ...row, createdAtMs: 10000 };
      if (path === 'hydrate') store.getState().hydrate('c1', [accepted]);
      else
        store.getState().ingestMessageEvent({
          chatId: 'c1',
          scope: 'worktree',
          occurredAt: new Date(10000).toISOString(),
          message: accepted,
        });
      expect(store.getState().threads['c1']?.messages).toEqual([
        { ...accepted, attachments },
      ]);
      store[CLIENT_STORE_DISPOSE]?.();
    },
  );

  it.each([false, true])(
    'retains attachments across unbound legacy history reconciliation (replace=%s)',
    (replaceMessages) => {
      const store = createChatStore(createMockClient().client);
      const actions = store.getState();
      actions.addOptimisticUserMessage('c1', {
        text: row.text,
        createdAtMs: 50,
        attachments,
      });
      store.getState().hydrate('c1', [row], { replaceMessages });
      expect(store.getState().threads['c1']?.messages).toEqual([
        { ...row, attachments },
      ]);
      store[CLIENT_STORE_DISPOSE]?.();
    },
  );

  it('retains attachments when canonical history replaces a client-request echo', () => {
    const store = createChatStore(createMockClient().client);
    store
      .getState()
      .hydrate('c1', [{ ...row, clientRequestId: 'request-1', attachments }]);
    store
      .getState()
      .hydrate('c1', [
        { ...row, messageId: 'canonical', clientRequestId: 'request-1' },
      ]);
    expect(store.getState().threads['c1']?.messages).toEqual([
      {
        ...row,
        messageId: 'canonical',
        clientRequestId: 'request-1',
        attachments,
      },
    ]);
    store[CLIENT_STORE_DISPOSE]?.();
  });
});

it('looks up streaming replacements through the message index after hydration and insertion', () => {
  const mock = createMockClient();
  const store = createChatStore(mock.client);
  store.getState().hydrate(
    'c1',
    Array.from({ length: 100 }, (_, i) =>
      chatMessage({ messageId: String(i), role: 'assistant', createdAtMs: i }),
    ),
  );
  const prior = store.getState().threads.c1.messages;
  const scan = jest.spyOn(prior, 'findIndex');
  mock.emit('chat.message', {
    scope: 'worktree',
    chatId: 'c1',
    occurredAt: '',
    message: chatMessage({
      messageId: '99',
      role: 'assistant',
      status: 'streaming',
      createdAtMs: 99,
      text: 'delta',
    }),
  });
  expect(scan).not.toHaveBeenCalled();
  expect(store.getState().threads.c1.messages[99].text).toBe('delta');
  expect(store.getState().threads.c1.messages[0]).toBe(prior[0]);
  scan.mockRestore();
  store[CLIENT_STORE_DISPOSE]?.();
});
