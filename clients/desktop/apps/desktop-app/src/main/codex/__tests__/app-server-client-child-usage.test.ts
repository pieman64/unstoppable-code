const mockRegisterSubagentThread = jest.fn();
const mockTransport = {
  registerRootThread: jest.fn(),
  registerSubagentThread: mockRegisterSubagentThread,
  unregisterThread: jest.fn(),
  unsubscribeThreadBestEffort: jest.fn(),
};

jest.mock('../runtime-service', () => ({
  getCodexRuntimeService: (): unknown => ({
    attachInteractiveClient: (): typeof mockTransport => mockTransport,
  }),
}));

import { CodexAppServerClient } from '../app-server-client';

describe('CodexAppServerClient subagent usage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('emits normalized usage only for registered child threads and keeps root meter usage unchanged', () => {
    const events: unknown[] = [];
    const client = new CodexAppServerClient({
      cwd: '/workspace/repo',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'project/worktree/chat',
      initialThreadId: 'root-thread',
      onEvent: (event): void => {
        events.push(event);
      },
      getWindow: (): null => null,
    });

    const usage = {
      total: {
        totalTokens: 900,
        inputTokens: 500,
        cachedInputTokens: 100,
        cacheWriteInputTokens: 20,
        outputTokens: 400,
        reasoningOutputTokens: 30,
      },
      last: {
        totalTokens: 450,
        inputTokens: 250,
        cachedInputTokens: 50,
        cacheWriteInputTokens: 10,
        outputTokens: 200,
        reasoningOutputTokens: 15,
      },
      modelContextWindow: 200_000,
    };

    void client.handleConnectionNotification('thread/tokenUsage/updated', {
      params: {
        threadId: 'unregistered-thread',
        turnId: 'unregistered-turn',
        tokenUsage: usage,
      },
    });
    expect(events).toEqual([]);

    void client.handleConnectionNotification('thread/started', {
      params: {
        thread: {
          id: 'child-thread',
          source: {
            subAgent: {
              parentThreadId: 'root-thread',
              threadSpawn: {
                agentNickname: 'Planner',
                agentRole: 'planner',
              },
            },
          },
        },
      },
    });
    void client.handleConnectionNotification('thread/tokenUsage/updated', {
      params: {
        threadId: 'child-thread',
        turnId: 'child-turn',
        tokenUsage: usage,
      },
    });
    void client.handleConnectionNotification('thread/tokenUsage/updated', {
      params: {
        threadId: 'root-thread',
        turnId: 'root-turn',
        tokenUsage: usage,
      },
    });

    expect(mockRegisterSubagentThread).toHaveBeenCalledWith('child-thread');
    expect(events).toContainEqual({
      type: 'codex',
      event: {
        type: 'thread.subagent_token_usage.updated',
        thread_id: 'child-thread',
        turn_id: 'child-turn',
        total: {
          input_tokens: 500,
          cached_input_tokens: 100,
          cache_write_input_tokens: 20,
          output_tokens: 400,
          reasoning_output_tokens: 30,
        },
        last: {
          input_tokens: 250,
          cached_input_tokens: 50,
          cache_write_input_tokens: 10,
          output_tokens: 200,
          reasoning_output_tokens: 15,
        },
      },
    });
    expect(events).toContainEqual({
      type: 'codex',
      event: {
        type: 'thread.token_usage.updated',
        thread_id: 'root-thread',
        turn_id: 'root-turn',
        usage: {
          context_tokens: 450,
          context_window: 200_000,
        },
      },
    });
  });
});
