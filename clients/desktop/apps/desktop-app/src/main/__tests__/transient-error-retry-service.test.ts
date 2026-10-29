import { withProxyFailureRestored } from '../agents/ai-credits-proxy-failure-restore';
import { AI_CREDITS_NO_BILLING_SOURCE_MESSAGE } from '@canopy/protocol';
import {
  foreignActivitySourceSnapshot,
  publishForeignChatActivity,
  publishForeignChatRetryActivity,
  resetForeignActivitySources,
} from '../services/foreign-activity-sources';
import {
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
  type ChatActiveSessionInfo,
  type ChatSendMessageRequest,
  type PersistedChatMessage,
  type PersistedChatTab,
  type TransientRetryStateEventData,
  type UsageLimitedChatTarget,
} from '@canopy/desktop-shared/types';
import { getSessionAiCreditsRoutedState } from '../agents/session-manager';
import { classifyAgentFailure } from '@canopy/desktop-shared/agent-failures';
import type { UsageLimitResumePrompt } from '@canopy/desktop-shared/lib/usage-limit-resume-prompt';

jest.mock('../agents/session-manager', () => ({
  getAllActiveSessionInfos: (): never[] => [],
  isSessionAiCreditsRouted: jest.fn(() => false),
  isSessionAccountProxyRouted: jest.fn(() => false),
  getSessionAiCreditsRoutedState: jest.fn((): boolean | undefined => false),
}));

jest.mock('../lib/claude-tui-chats', () => ({
  getEffectiveClaudeChatInterfaceMode: (
    mode: 'canopy' | 'claude-code' | 'auto' | undefined,
  ): 'canopy' | 'claude-code' | 'auto' => mode ?? 'canopy',
}));

const mockBuildExistingTabDispatchOptions = jest
  .fn()
  .mockResolvedValue({ providerType: 'claude' });
const mockSendWorktreeChatMessage = jest.fn().mockResolvedValue(undefined);

jest.mock('../services/chat-service', () => ({
  buildExistingTabDispatchOptions: (...args: unknown[]): unknown =>
    mockBuildExistingTabDispatchOptions(...args),
  sendWorktreeChatMessage: (...args: unknown[]): unknown =>
    mockSendWorktreeChatMessage(...args),
}));

const mockDispatchPipelineEditorChatMessage = jest
  .fn<Promise<void>, [ChatSendMessageRequest, unknown]>()
  .mockResolvedValue(undefined);

jest.mock('../pipeline-editor/chat-service', () => ({
  dispatchPipelineEditorChatMessage: (
    ...args: [ChatSendMessageRequest, unknown]
  ): Promise<void> => mockDispatchPipelineEditorChatMessage(...args),
}));

import {
  cancelTransientRetriesForChatId,
  cancelTransientRetriesForWorkspaceChat,
  cancelTransientRetryForChat,
  getTransientRetryStateSnapshot,
  initTransientErrorRetryService,
  noteChatSessionEvent,
  resetTransientRetryServiceForTests,
  subscribeTransientRetryActivity,
  type TransientErrorRetryServiceDependencies,
} from '../lib/transient-error-retry-service';

const TARGET: UsageLimitedChatTarget = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};

const TRANSIENT_FAILURE = {
  type: 'error',
  code: 'overloaded_error',
  error: 'Provider overloaded',
};

const CYBER_ACCESS_ERROR = {
  type: 'error',
  error: {
    type: 'invalid_request_error',
    code: 'unsupported_parameter',
    message:
      'The access_programs parameter is not enabled for this organization.',
    param: 'access_programs.cyber',
  },
  status: 400,
};
const CYBER_ACCESS_FAILURE = {
  type: 'codex',
  event: {
    type: 'turn.failed',
    error: {
      message: JSON.stringify(CYBER_ACCESS_ERROR, null, 2),
      codexErrorInfo: 'other',
    },
  },
};

interface DispatchCall {
  prompt: UsageLimitResumePrompt;
  userMessageId: string;
}

interface Harness {
  dispatchCalls: DispatchCall[];
  emitted: TransientRetryStateEventData[];
  setChatTab: (tab: PersistedChatTab | undefined) => void;
  setChatsPreference: (enabled: boolean) => void;
  setActiveSessions: (sessions: ChatActiveSessionInfo[]) => void;
}

function userMessage(text: string): PersistedChatMessage {
  return {
    id: 'user-message',
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: 1,
  };
}

function assistantMessage(text: string): PersistedChatMessage {
  return {
    id: 'assistant-message',
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp: 2,
  };
}

function chatTab(messages: PersistedChatMessage[]): PersistedChatTab {
  return {
    id: TARGET.chatId,
    title: 'Retry chat',
    messages,
    createdAt: '2026-07-17T00:00:00.000Z',
    interfaceMode: 'canopy',
  };
}

function createHarness(options?: {
  readPreferences?: () => Promise<{
    autoRetryTransientErrorsChats: boolean;
  }>;
  dispatchRetry?: TransientErrorRetryServiceDependencies['dispatchRetry'];
  useDefaultDispatch?: boolean;
}): Harness {
  let chatsPreference = true;
  let currentTab: PersistedChatTab | undefined = chatTab([
    userMessage('Original request'),
  ]);
  let activeSessions: ChatActiveSessionInfo[] = [];
  const dispatchCalls: DispatchCall[] = [];
  const emitted: TransientRetryStateEventData[] = [];
  const overrides: Partial<TransientErrorRetryServiceDependencies> = {
    readPreferences:
      options?.readPreferences ??
      ((): Promise<{ autoRetryTransientErrorsChats: boolean }> =>
        Promise.resolve({
          autoRetryTransientErrorsChats: chatsPreference,
        })),
    readChatTab: (): Promise<PersistedChatTab | undefined> =>
      Promise.resolve(currentTab),
    getActiveSessions: (): ChatActiveSessionInfo[] => activeSessions,
    emitState: (_target, data): void => {
      emitted.push(data);
    },
  };
  if (!options?.useDefaultDispatch) {
    overrides.dispatchRetry =
      options?.dispatchRetry ??
      ((_target, prompt, userMessageId): Promise<void> => {
        dispatchCalls.push({ prompt, userMessageId });
        return Promise.resolve();
      });
  }
  initTransientErrorRetryService(() => null, overrides);
  return {
    dispatchCalls,
    emitted,
    setChatTab: (tab): void => {
      currentTab = tab;
    },
    setChatsPreference: (enabled): void => {
      chatsPreference = enabled;
    },
    setActiveSessions: (sessions): void => {
      activeSessions = sessions;
    },
  };
}

function startTransientCycle(): void {
  noteChatSessionEvent(TARGET, 'claude', TRANSIENT_FAILURE);
  noteChatSessionEvent(TARGET, 'claude', {
    type: 'result',
    is_error: false,
    result: 'Session ended',
  });
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function last<T>(values: readonly T[]): T | undefined {
  return values[values.length - 1];
}

describe('transient-error-retry-service', () => {
  let unsubscribeRetryActivity: (() => void) | undefined;
  beforeEach(() => {
    resetForeignActivitySources();
    unsubscribeRetryActivity = subscribeTransientRetryActivity(
      publishForeignChatRetryActivity,
    );
    jest.useFakeTimers();
    jest.setSystemTime(1_000);
    jest.clearAllMocks();
    jest.mocked(getSessionAiCreditsRoutedState).mockReturnValue(false);
    mockBuildExistingTabDispatchOptions.mockResolvedValue({
      providerType: 'claude',
    });
    mockSendWorktreeChatMessage.mockResolvedValue(undefined);
    mockDispatchPipelineEditorChatMessage.mockResolvedValue(undefined);
  });

  afterEach(() => {
    unsubscribeRetryActivity?.();
    resetTransientRetryServiceForTests();
    jest.useRealTimers();
  });

  function publishTurn(
    status: 'streaming' | 'idle',
    turnId = 'original-turn',
  ): void {
    publishForeignChatActivity({
      ...TARGET,
      tabs: [chatTab([])],
      removedTabIds: [],
      runtimeByChatId: {
        [TARGET.chatId]: {
          status,
          queuedMessageIds: [],
          ...(status === 'streaming'
            ? { activeTurn: { userMessageId: turnId, startedAt: 1 } }
            : {}),
        },
      },
    });
  }

  it('keeps a scheduled retry active under the original turn and completes it on cancellation without a chat commit', async (): Promise<void> => {
    createHarness();
    publishTurn('streaming');
    startTransientCycle();
    await flushPromises();
    publishTurn('idle');
    expect(foreignActivitySourceSnapshot().operations[0]).toMatchObject({
      operationId: 'original-turn',
      active: true,
    });
    cancelTransientRetryForChat(TARGET, 'stop');
    expect(foreignActivitySourceSnapshot().operations[0]).toMatchObject({
      operationId: 'original-turn',
      active: false,
    });
  });

  it('keeps dispatch and completion of a retry on the original operation', async (): Promise<void> => {
    const harness = createHarness();
    publishTurn('streaming');
    startTransientCycle();
    await flushPromises();
    publishTurn('idle');
    await jest.advanceTimersByTimeAsync(30_000);
    const retry = harness.dispatchCalls[0];
    if (retry === undefined) throw new Error('Retry did not dispatch');
    publishTurn('streaming', retry.userMessageId);
    expect(foreignActivitySourceSnapshot().operations[0]).toMatchObject({
      operationId: 'original-turn',
      active: true,
    });
    noteChatSessionEvent(TARGET, 'claude', {
      type: 'result',
      is_error: false,
      result: 'Done',
      canopy_turn_user_message_id: retry.userMessageId,
    });
    publishTurn('idle');
    expect(foreignActivitySourceSnapshot().operations[0]).toMatchObject({
      operationId: 'original-turn',
      active: false,
    });
    publishTurn('streaming', 'next-user-turn');
    // The settled turn stays as a terminal result; the next turn is its own operation.
    const operations = foreignActivitySourceSnapshot().operations;
    expect(
      operations.find((op): boolean => op.operationId === 'next-user-turn'),
    ).toMatchObject({ operationId: 'next-user-turn', active: true });
    expect(
      operations.find((op): boolean => op.operationId === 'original-turn'),
    ).toMatchObject({ operationId: 'original-turn', active: false });
  });

  it('does not schedule an application retry for a normalized Claude credits refusal', async () => {
    const harness = createHarness();
    const event = withProxyFailureRestored(
      {
        type: 'result',
        is_error: true,
        api_error_status: 402,
        result: `API Error: 402 ${AI_CREDITS_NO_BILLING_SOURCE_MESSAGE}`,
      },
      {
        code: 'no_billing_source',
        message: AI_CREDITS_NO_BILLING_SOURCE_MESSAGE,
        correlationId: null,
      },
      'claude',
    );
    expect(
      classifyAgentFailure({
        provider: 'claude',
        accountScope: 'ai_credits',
        error: event,
      }),
    ).toMatchObject({ code: 'credits_depleted' });
    noteChatSessionEvent(TARGET, 'claude', event);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(harness.dispatchCalls).toHaveLength(0);
    expect(harness.emitted).toHaveLength(0);
    expect(getTransientRetryStateSnapshot()).toEqual([]);
  });

  it('surfaces a generic terminal failure as non-retryable attention', () => {
    createHarness();

    expect(
      noteChatSessionEvent(TARGET, 'claude', {
        type: 'error',
        error: 'Repository access was denied',
      }),
    ).toEqual({
      kind: 'non_retryable_failure',
      detail: 'Repository access was denied',
    });
  });

  it('does not surface a transient provider failure as attention', () => {
    createHarness();

    expect(
      noteChatSessionEvent(TARGET, 'claude', TRANSIENT_FAILURE),
    ).toBeNull();
  });

  it('keeps the first retry scheduled across Claude synthetic Session ended', async () => {
    const harness = createHarness();

    startTransientCycle();
    await flushPromises();

    expect(harness.emitted).toMatchObject([
      { active: true, attempt: 1, exhausted: false },
    ]);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(harness.dispatchCalls).toHaveLength(1);
  });

  it('returns live retry state for renderer hydration', async () => {
    createHarness();
    startTransientCycle();
    await flushPromises();

    expect(getTransientRetryStateSnapshot()).toEqual([
      {
        ...TARGET,
        data: {
          type: 'canopy_transient_retry_state',
          provider: 'claude',
          active: true,
          attempt: 1,
          maxAttempts: 5,
          nextRetryAt: 31_000,
          exhausted: false,
        },
      },
    ]);
  });

  it('classifies retry outcomes with the provider selected at dispatch', async () => {
    const harness = createHarness();
    startTransientCycle();
    await flushPromises();
    harness.setChatTab({
      ...chatTab([userMessage('Original request')]),
      providerType: 'codex',
      model: 'gpt-6-sol',
    });

    await jest.advanceTimersByTimeAsync(30_000);
    const dispatch = harness.dispatchCalls[0];
    noteChatSessionEvent(TARGET, 'codex', {
      type: 'codex',
      event: {
        type: 'turn.failed',
        error: { codexErrorInfo: { serverOverloaded: {} } },
      },
      canopy_turn_user_message_id: dispatch?.userMessageId,
    });

    expect(last(harness.emitted)).toMatchObject({
      active: true,
      attempt: 2,
      provider: 'codex',
    });
    await jest.advanceTimersByTimeAsync(30_000);
    expect(harness.dispatchCalls).toHaveLength(2);
  });

  it('retries the exact native Codex cyber access failure but leaves the shared classifier unchanged', async () => {
    const harness = createHarness();
    expect(
      classifyAgentFailure({
        provider: 'codex',
        accountScope: 'native',
        error: CYBER_ACCESS_FAILURE,
      }),
    ).toBeNull();
    noteChatSessionEvent(TARGET, 'codex', CYBER_ACCESS_FAILURE);
    await flushPromises();
    expect(last(harness.emitted)).toMatchObject({
      active: true,
      attempt: 1,
      maxAttempts: 5,
    });
    await jest.advanceTimersByTimeAsync(30_000);
    expect(harness.dispatchCalls).toHaveLength(1);
  });

  it.each([
    ['status', { ...CYBER_ACCESS_ERROR, status: 403 }],
    ['missing status', { ...CYBER_ACCESS_ERROR, status: undefined }],
    ['envelope type', { ...CYBER_ACCESS_ERROR, type: 'response' }],
    [
      'error type',
      {
        ...CYBER_ACCESS_ERROR,
        error: { ...CYBER_ACCESS_ERROR.error, type: 'authentication_error' },
      },
    ],
    [
      'code',
      {
        ...CYBER_ACCESS_ERROR,
        error: { ...CYBER_ACCESS_ERROR.error, code: 'permission_denied' },
      },
    ],
    [
      'parameter',
      {
        ...CYBER_ACCESS_ERROR,
        error: { ...CYBER_ACCESS_ERROR.error, param: 'access_programs.other' },
      },
    ],
    [
      'message',
      {
        ...CYBER_ACCESS_ERROR,
        error: { ...CYBER_ACCESS_ERROR.error, message: 'Cyber access denied.' },
      },
    ],
  ])(
    'does not retry a cyber error with a different %s',
    async (_name, body) => {
      const harness = createHarness();
      noteChatSessionEvent(TARGET, 'codex', {
        ...CYBER_ACCESS_FAILURE,
        event: {
          type: 'turn.failed',
          error: { message: JSON.stringify(body), codexErrorInfo: 'other' },
        },
      });
      await flushPromises();
      expect(harness.emitted).toEqual([]);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it.each([
    'invalid JSON',
    `diagnostic excerpt: ${JSON.stringify(CYBER_ACCESS_ERROR)}`,
  ])('does not retry unstructured cyber error text: %s', async (message) => {
    const harness = createHarness();
    noteChatSessionEvent(TARGET, 'codex', {
      ...CYBER_ACCESS_FAILURE,
      event: { type: 'turn.failed', error: { message } },
    });
    await flushPromises();
    expect(harness.emitted).toEqual([]);
  });

  it.each([true, undefined])(
    'does not retry the cyber error with routed state %s',
    async (routed) => {
      const harness = createHarness();
      jest.mocked(getSessionAiCreditsRoutedState).mockReturnValue(routed);
      noteChatSessionEvent(TARGET, 'codex', CYBER_ACCESS_FAILURE);
      await flushPromises();
      expect(harness.emitted).toEqual([]);
    },
  );

  it('does not retry the cyber error from another provider', async () => {
    const harness = createHarness();
    noteChatSessionEvent(TARGET, 'claude', CYBER_ACCESS_FAILURE);
    await flushPromises();
    expect(harness.emitted).toEqual([]);
  });

  it.each(['cyberPolicy', 'usageLimitExceeded'])(
    'does not retry a %s rejection with an embedded cyber body',
    async (codexErrorInfo) => {
      const harness = createHarness();
      noteChatSessionEvent(TARGET, 'codex', {
        ...CYBER_ACCESS_FAILURE,
        event: {
          type: 'turn.failed',
          error: { ...CYBER_ACCESS_FAILURE.event.error, codexErrorInfo },
        },
      });
      await flushPromises();
      expect(harness.emitted).toEqual([]);
    },
  );

  it('does not use an embedded cyber body to override an authentication failure', async () => {
    const harness = createHarness();
    noteChatSessionEvent(TARGET, 'codex', {
      ...CYBER_ACCESS_FAILURE,
      event: {
        type: 'turn.failed',
        error: { ...CYBER_ACCESS_FAILURE.event.error, status: 401 },
      },
    });
    await flushPromises();
    expect(harness.emitted).toEqual([]);
  });

  it('does not promote buffered cyber error text over a different terminal failure', async () => {
    const harness = createHarness();
    noteChatSessionEvent(TARGET, 'codex', {
      type: 'codex',
      event: {
        type: 'error',
        message: CYBER_ACCESS_FAILURE.event.error.message,
      },
    });
    noteChatSessionEvent(TARGET, 'codex', {
      type: 'codex',
      event: {
        type: 'turn.failed',
        error: { message: 'Invalid request', status: 400 },
      },
    });
    await flushPromises();
    expect(harness.emitted).toEqual([]);
  });

  it('honors preference-off and cancellation for the cyber exception', async () => {
    const harness = createHarness();
    harness.setChatsPreference(false);
    noteChatSessionEvent(TARGET, 'codex', CYBER_ACCESS_FAILURE);
    await flushPromises();
    expect(harness.emitted).toEqual([]);
    harness.setChatsPreference(true);
    noteChatSessionEvent(TARGET, 'codex', CYBER_ACCESS_FAILURE);
    await flushPromises();
    expect(last(harness.emitted)?.active).toBe(true);
    cancelTransientRetryForChat(TARGET, 'user');
    await jest.advanceTimersByTimeAsync(600_000);
    expect(harness.dispatchCalls).toEqual([]);
    expect(last(harness.emitted)?.active).toBe(false);
  });

  describe('Codex local runtime failures', () => {
    function codexRuntimeFailure(
      detail: Record<string, unknown>,
      message = 'Codex app-server did not respond to thread/resume within 120s',
    ): Record<string, unknown> {
      return {
        type: 'result',
        is_error: true,
        result: message,
        subtype: 'codex_error',
        errors: [message],
        ...detail,
      };
    }
    const RESUME_TIMEOUT = {
      codex_error_code: 'app_server_request_timeout',
      codex_error_method: 'thread/resume',
    };

    it.each([
      ['an unanswered thread/resume', RESUME_TIMEOUT],
      [
        'an unanswered thread/start',
        {
          codex_error_code: 'app_server_request_timeout',
          codex_error_method: 'thread/start',
        },
      ],
      [
        'a thread that is still closing',
        { codex_error_code: 'thread_closing' },
      ],
      [
        'a shared restart that failed this chat',
        { codex_error_code: 'app_server_shared_restart' },
      ],
    ])(
      'retries %s with the original request and raises no attention',
      async (_label, detail) => {
        const harness = createHarness();
        const failure = codexRuntimeFailure(detail);
        // The shared classifier stays untouched: pipelines and background
        // helpers must not inherit this chat-only policy.
        expect(
          classifyAgentFailure({
            provider: 'codex',
            accountScope: 'native',
            events: [failure],
            error: failure,
          }),
        ).toBeNull();

        expect(noteChatSessionEvent(TARGET, 'codex', failure)).toBeNull();
        await flushPromises();
        expect(last(harness.emitted)).toMatchObject({
          active: true,
          attempt: 1,
          maxAttempts: 5,
        });
        await jest.advanceTimersByTimeAsync(30_000);
        expect(harness.dispatchCalls).toHaveLength(1);
        expect(harness.dispatchCalls[0]?.prompt.text).toBe('Original request');
      },
    );

    it('never retries an unanswered turn/start', async () => {
      const harness = createHarness();
      const message =
        'Codex app-server did not respond to turn/start within 600s';

      expect(
        noteChatSessionEvent(
          TARGET,
          'codex',
          codexRuntimeFailure(
            {
              codex_error_code: 'app_server_request_timeout',
              codex_error_method: 'turn/start',
            },
            message,
          ),
        ),
      ).toEqual({ kind: 'non_retryable_failure', detail: message });
      await flushPromises();
      await jest.advanceTimersByTimeAsync(600_000);
      expect(harness.emitted).toEqual([]);
      expect(harness.dispatchCalls).toEqual([]);
    });

    it('does not retry the same text without the structured marker', async () => {
      const harness = createHarness();

      expect(
        noteChatSessionEvent(TARGET, 'codex', codexRuntimeFailure({})),
      ).toMatchObject({ kind: 'non_retryable_failure' });
      await flushPromises();
      await jest.advanceTimersByTimeAsync(600_000);
      expect(harness.dispatchCalls).toEqual([]);
    });

    it('does not retry a marked failure from another provider', async () => {
      const harness = createHarness();

      expect(
        noteChatSessionEvent(
          TARGET,
          'claude',
          codexRuntimeFailure(RESUME_TIMEOUT),
        ),
      ).toMatchObject({ kind: 'non_retryable_failure' });
      await flushPromises();
      await jest.advanceTimersByTimeAsync(600_000);
      expect(harness.dispatchCalls).toEqual([]);
    });

    it('honors preference-off and cancellation', async () => {
      const harness = createHarness();
      harness.setChatsPreference(false);
      noteChatSessionEvent(
        TARGET,
        'codex',
        codexRuntimeFailure(RESUME_TIMEOUT),
      );
      await flushPromises();
      expect(harness.emitted).toEqual([]);
      harness.setChatsPreference(true);
      noteChatSessionEvent(
        TARGET,
        'codex',
        codexRuntimeFailure(RESUME_TIMEOUT),
      );
      await flushPromises();
      expect(last(harness.emitted)?.active).toBe(true);
      cancelTransientRetryForChat(TARGET, 'user');
      await jest.advanceTimersByTimeAsync(600_000);
      expect(harness.dispatchCalls).toEqual([]);
      expect(last(harness.emitted)?.active).toBe(false);
    });

    it('continues instead of resending after the turn already did work', async () => {
      const harness = createHarness();
      noteChatSessionEvent(TARGET, 'codex', {
        type: 'codex',
        event: {
          type: 'item.started',
          item: { id: 'cmd-1', type: 'command_execution' },
        },
      });
      noteChatSessionEvent(
        TARGET,
        'codex',
        codexRuntimeFailure(
          { codex_error_code: 'app_server_shared_restart' },
          'Codex app-server was restarted because another turn could not be interrupted cleanly. Please retry this message.',
        ),
      );
      await flushPromises();
      await jest.advanceTimersByTimeAsync(30_000);

      expect(harness.dispatchCalls).toHaveLength(1);
      expect(harness.dispatchCalls[0]?.prompt.resendsUserMessage).toBe(false);
      expect(harness.dispatchCalls[0]?.prompt.text).not.toBe(
        'Original request',
      );
    });

    it('keeps retrying while later attempts hit the same failure', async () => {
      const harness = createHarness();
      noteChatSessionEvent(
        TARGET,
        'codex',
        codexRuntimeFailure(RESUME_TIMEOUT),
      );
      await flushPromises();
      await jest.advanceTimersByTimeAsync(30_000);
      const firstDispatch = harness.dispatchCalls[0];

      expect(
        noteChatSessionEvent(TARGET, 'codex', {
          ...codexRuntimeFailure(RESUME_TIMEOUT),
          canopy_turn_user_message_id: firstDispatch?.userMessageId,
        }),
      ).toBeNull();
      expect(last(harness.emitted)).toMatchObject({ active: true, attempt: 2 });
      await jest.advanceTimersByTimeAsync(30_000);
      expect(harness.dispatchCalls).toHaveLength(2);
    });
  });

  it('pins the first retry prompt across pre-output failures', async () => {
    const harness = createHarness();
    startTransientCycle();
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);

    const firstDispatch = harness.dispatchCalls[0];
    expect(firstDispatch?.prompt.text).toBe('Original request');
    harness.setChatTab(
      chatTab([userMessage('Original request'), assistantMessage('Some work')]),
    );
    noteChatSessionEvent(TARGET, 'claude', {
      ...TRANSIENT_FAILURE,
      canopy_turn_user_message_id: firstDispatch?.userMessageId,
    });

    await jest.advanceTimersByTimeAsync(30_000);
    expect(harness.dispatchCalls[1]?.prompt.text).toBe('Original request');
  });

  it('continues after activity without replaying the original request', async () => {
    const harness = createHarness();
    startTransientCycle();
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);

    const firstDispatch = harness.dispatchCalls[0];
    noteChatSessionEvent(TARGET, 'claude', {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'I changed the file.' }] },
      canopy_turn_user_message_id: firstDispatch?.userMessageId,
    });
    noteChatSessionEvent(TARGET, 'claude', {
      ...TRANSIENT_FAILURE,
      canopy_turn_user_message_id: firstDispatch?.userMessageId,
    });

    await jest.advanceTimersByTimeAsync(120_000);
    expect(harness.dispatchCalls).toHaveLength(2);
    expect(harness.dispatchCalls[1]?.prompt).toEqual({
      text: 'Continue',
      resendsUserMessage: false,
    });
  });

  it('retains agent activity after the bounded diagnostic history evicts it', async () => {
    const harness = createHarness();
    startTransientCycle();
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);

    const firstDispatch = harness.dispatchCalls[0];
    noteChatSessionEvent(TARGET, 'claude', {
      type: 'assistant',
      message: 'I changed external state.',
      canopy_turn_user_message_id: firstDispatch?.userMessageId,
    });
    for (let index = 0; index < 31; index += 1) {
      noteChatSessionEvent(TARGET, 'claude', {
        type: 'progress',
        index,
        canopy_turn_user_message_id: firstDispatch?.userMessageId,
      });
    }
    noteChatSessionEvent(TARGET, 'claude', {
      ...TRANSIENT_FAILURE,
      canopy_turn_user_message_id: firstDispatch?.userMessageId,
    });

    await jest.advanceTimersByTimeAsync(120_000);
    expect(harness.dispatchCalls).toHaveLength(2);
    expect(harness.dispatchCalls[1]?.prompt.text).toBe('Continue');
  });

  it('starts an initial continuation retry after agent activity', async () => {
    const harness = createHarness();
    noteChatSessionEvent(TARGET, 'claude', {
      type: 'assistant',
      message: 'I already ran a side-effecting action.',
    });
    noteChatSessionEvent(TARGET, 'claude', TRANSIENT_FAILURE);
    await flushPromises();
    await jest.advanceTimersByTimeAsync(120_000);

    expect(harness.dispatchCalls).toHaveLength(1);
    expect(harness.dispatchCalls[0]?.prompt).toEqual({
      text: 'Continue',
      resendsUserMessage: false,
    });
  });

  it.each([
    [
      'capacity',
      {
        message: 'Selected model is at capacity. Please try a different model.',
        codexErrorInfo: 'serverOverloaded',
      },
    ],
    ['cyber access', CYBER_ACCESS_FAILURE.event.error],
  ])(
    'bounds Codex %s retries even when every attempt does work',
    async (_name, error) => {
      const harness = createHarness();
      harness.setChatTab({
        ...chatTab([userMessage('Original request')]),
        providerType: 'codex',
      });
      const failAfterWork = (userMessageId?: string): void => {
        noteChatSessionEvent(TARGET, 'codex', {
          type: 'codex',
          canopy_turn_user_message_id: userMessageId,
          event: {
            type: 'item.completed',
            item: {
              type: 'command_execution',
              id: 'command',
              command: 'echo done',
            },
          },
        });
        noteChatSessionEvent(TARGET, 'codex', {
          type: 'codex',
          canopy_turn_user_message_id: userMessageId,
          event: {
            type: 'turn.failed',
            error,
          },
        });
      };
      failAfterWork();
      await flushPromises();
      const delays = [30_000, 30_000, 60_000, 60_000, 120_000];
      for (let index = 0; index < delays.length; index += 1) {
        const delay = delays[index];
        await jest.advanceTimersByTimeAsync(delay - 1);
        expect(harness.dispatchCalls).toHaveLength(index);
        await jest.advanceTimersByTimeAsync(1);
        expect(harness.dispatchCalls).toHaveLength(index + 1);
        expect(harness.dispatchCalls[index]?.prompt).toEqual({
          text: 'Continue',
          resendsUserMessage: false,
        });
        failAfterWork(harness.dispatchCalls[index]?.userMessageId);
        await flushPromises();
      }
      expect(last(harness.emitted)).toMatchObject({
        active: true,
        exhausted: true,
        attempt: 5,
        nextRetryAt: null,
      });
      await jest.advanceTimersByTimeAsync(600_000);
      expect(harness.dispatchCalls).toHaveLength(5);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('routes Pipeline Assistant retries through the specialized dispatcher', async () => {
    createHarness({ useDefaultDispatch: true });
    const target: UsageLimitedChatTarget = {
      projectId: PIPELINE_EDITOR_PROJECT_ID,
      worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
      chatId: 'pipeline-editor-chat',
    };
    noteChatSessionEvent(target, 'claude', TRANSIENT_FAILURE);
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);

    expect(mockDispatchPipelineEditorChatMessage).toHaveBeenCalledTimes(1);
    expect(mockSendWorktreeChatMessage).not.toHaveBeenCalled();
    const request = mockDispatchPipelineEditorChatMessage.mock.calls[0]?.[0];
    expect(request).toMatchObject<Partial<ChatSendMessageRequest>>({
      ...target,
      text: 'Original request',
      initiationSource: 'automation',
    });
  });

  it('exposes cancellation to a dispatcher awaiting target resolution', async () => {
    let releaseResolution = (): void => undefined;
    const targetResolution = new Promise<void>((resolve) => {
      releaseResolution = resolve;
    });
    const dispatchesAfterResolution: string[] = [];
    createHarness({
      dispatchRetry: async (
        _target,
        _prompt,
        userMessageId,
        _getWindow,
        shouldContinue,
      ): Promise<void> => {
        await targetResolution;
        if (shouldContinue()) {
          dispatchesAfterResolution.push(userMessageId);
        }
      },
    });
    startTransientCycle();
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);
    cancelTransientRetryForChat(TARGET, 'cancel-during-target-resolution');
    releaseResolution();
    await flushPromises();

    expect(dispatchesAfterResolution).toHaveLength(0);
  });

  it('continues Codex retries after a tool item starts', async () => {
    const harness = createHarness();
    const codexFailure = {
      type: 'codex',
      event: {
        type: 'turn.failed',
        error: { codexErrorInfo: { serverOverloaded: {} } },
      },
    };
    noteChatSessionEvent(TARGET, 'codex', codexFailure);
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);

    const firstDispatch = harness.dispatchCalls[0];
    noteChatSessionEvent(TARGET, 'codex', {
      type: 'codex',
      event: {
        type: 'item.started',
        item: { id: 'tool-1', type: 'command_execution' },
      },
      canopy_turn_user_message_id: firstDispatch?.userMessageId,
    });
    noteChatSessionEvent(TARGET, 'codex', {
      ...codexFailure,
      canopy_turn_user_message_id: firstDispatch?.userMessageId,
    });

    await jest.advanceTimersByTimeAsync(120_000);
    expect(harness.dispatchCalls).toHaveLength(2);
    expect(harness.dispatchCalls[1]?.prompt.text).toBe('Continue');
  });

  it('continues Codex retries after a collaboration tool call starts', async () => {
    const harness = createHarness();
    const codexFailure = {
      type: 'codex',
      event: {
        type: 'turn.failed',
        error: { codexErrorInfo: { serverOverloaded: {} } },
      },
    };
    noteChatSessionEvent(TARGET, 'codex', codexFailure);
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);

    const firstDispatch = harness.dispatchCalls[0];
    noteChatSessionEvent(TARGET, 'codex', {
      type: 'codex',
      event: {
        type: 'item.started',
        item: { id: 'collab-1', type: 'collab_agent_tool_call' },
      },
      canopy_turn_user_message_id: firstDispatch?.userMessageId,
    });
    noteChatSessionEvent(TARGET, 'codex', {
      ...codexFailure,
      canopy_turn_user_message_id: firstDispatch?.userMessageId,
    });

    await jest.advanceTimersByTimeAsync(120_000);
    expect(harness.dispatchCalls).toHaveLength(2);
    expect(harness.dispatchCalls[1]?.prompt.text).toBe('Continue');
  });

  it('runs all five delays, advances attempts, and ends exhausted', async () => {
    const harness = createHarness();
    startTransientCycle();
    await flushPromises();

    for (const delay of [30_000, 30_000, 60_000, 60_000, 120_000]) {
      await jest.advanceTimersByTimeAsync(delay);
      const dispatch = harness.dispatchCalls[harness.dispatchCalls.length - 1];
      expect(dispatch).toBeDefined();
      noteChatSessionEvent(TARGET, 'claude', {
        ...TRANSIENT_FAILURE,
        canopy_turn_user_message_id: dispatch?.userMessageId,
      });
    }

    expect(harness.dispatchCalls).toHaveLength(5);
    expect(
      harness.emitted
        .filter((event) => event.active && !event.exhausted)
        .map((event) => event.attempt),
    ).toEqual([1, 2, 3, 4, 5]);
    expect(last(harness.emitted)).toMatchObject({
      active: true,
      attempt: 5,
      maxAttempts: 5,
      nextRetryAt: null,
      exhausted: true,
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('ignores a different turn id and clears on correlated success', async () => {
    const harness = createHarness();
    startTransientCycle();
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);
    const dispatch = harness.dispatchCalls[0];

    noteChatSessionEvent(TARGET, 'claude', {
      type: 'result',
      is_error: false,
      result: 'Done',
      canopy_turn_user_message_id: 'different-turn',
    });
    expect(last(harness.emitted)?.active).toBe(true);

    noteChatSessionEvent(TARGET, 'claude', {
      type: 'result',
      is_error: false,
      result: 'Done',
      canopy_turn_user_message_id: dispatch?.userMessageId,
    });
    expect(last(harness.emitted)?.active).toBe(false);
  });

  it('classifies Codex inner terminal events and lets the first terminal win', async () => {
    const harness = createHarness();
    const codexFailure = {
      type: 'codex',
      event: {
        type: 'turn.failed',
        error: { codexErrorInfo: { serverOverloaded: {} } },
      },
    };
    noteChatSessionEvent(TARGET, 'codex', codexFailure);
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);
    const firstDispatch = harness.dispatchCalls[0];

    noteChatSessionEvent(TARGET, 'codex', {
      ...codexFailure,
      canopy_turn_user_message_id: firstDispatch?.userMessageId,
    });
    noteChatSessionEvent(TARGET, 'codex', {
      ...TRANSIENT_FAILURE,
      canopy_turn_user_message_id: firstDispatch?.userMessageId,
    });
    await jest.advanceTimersByTimeAsync(30_000);
    expect(harness.dispatchCalls).toHaveLength(2);

    noteChatSessionEvent(TARGET, 'codex', {
      type: 'codex',
      event: { type: 'turn.completed' },
      canopy_turn_user_message_id: harness.dispatchCalls[1]?.userMessageId,
    });
    expect(last(harness.emitted)?.active).toBe(false);
  });

  it('honors active-turn, usage-limit, preference-off, and cancel guards', async () => {
    const activeHarness = createHarness();
    activeHarness.setActiveSessions([
      {
        ...TARGET,
        providerType: 'claude',
        turnActive: true,
        createdAt: 1,
        lastActivityAt: 1,
        turnCount: 1,
        pendingMessageCount: 0,
      },
    ]);
    startTransientCycle();
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(activeHarness.dispatchCalls).toHaveLength(0);
    expect(last(activeHarness.emitted)?.active).toBe(false);

    resetTransientRetryServiceForTests();
    const usageHarness = createHarness();
    noteChatSessionEvent(TARGET, 'claude', {
      type: 'result',
      is_error: true,
      api_error_status: 429,
      result: 'Rate limited',
    });
    await flushPromises();
    expect(usageHarness.emitted).toHaveLength(0);

    resetTransientRetryServiceForTests();
    const preferenceHarness = createHarness();
    startTransientCycle();
    await flushPromises();
    preferenceHarness.setChatsPreference(false);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(preferenceHarness.dispatchCalls).toHaveLength(0);
    expect(last(preferenceHarness.emitted)?.active).toBe(false);

    resetTransientRetryServiceForTests();
    const cancelHarness = createHarness();
    startTransientCycle();
    await flushPromises();
    cancelTransientRetryForChat(TARGET, 'test-cancel');
    await jest.advanceTimersByTimeAsync(30_000);
    expect(cancelHarness.dispatchCalls).toHaveLength(0);
    expect(last(cancelHarness.emitted)?.active).toBe(false);
  });

  it('clears instead of rerouting when a tab switches to terminal-backed mode', async () => {
    const harness = createHarness();
    startTransientCycle();
    await flushPromises();
    harness.setChatTab({
      ...chatTab([userMessage('Original request')]),
      interfaceMode: 'claude-code',
    });

    await jest.advanceTimersByTimeAsync(30_000);

    expect(harness.dispatchCalls).toHaveLength(0);
    expect(last(harness.emitted)?.active).toBe(false);
  });

  it('cancels matching project chat retries without resolving a work entry', async () => {
    const otherTarget: UsageLimitedChatTarget = {
      projectId: 'project-2',
      worktreeId: 'worktree-2',
      chatId: TARGET.chatId,
    };
    const dispatchedTargets: UsageLimitedChatTarget[] = [];
    createHarness({
      dispatchRetry: (target) => {
        dispatchedTargets.push(target);
        return Promise.resolve();
      },
    });
    startTransientCycle();
    noteChatSessionEvent(otherTarget, 'claude', TRANSIENT_FAILURE);
    await flushPromises();

    cancelTransientRetriesForWorkspaceChat(
      TARGET.projectId,
      TARGET.chatId,
      'manual-send',
    );
    await jest.advanceTimersByTimeAsync(30_000);

    expect(dispatchedTargets).toEqual([otherTarget]);
  });

  it('cancels every same-ID retry for an unscoped standalone command', async () => {
    const otherTarget: UsageLimitedChatTarget = {
      projectId: 'project-2',
      worktreeId: 'worktree-2',
      chatId: TARGET.chatId,
    };
    const dispatchedTargets: UsageLimitedChatTarget[] = [];
    createHarness({
      dispatchRetry: (target) => {
        dispatchedTargets.push(target);
        return Promise.resolve();
      },
    });
    startTransientCycle();
    noteChatSessionEvent(otherTarget, 'claude', TRANSIENT_FAILURE);
    await flushPromises();

    cancelTransientRetriesForChatId(TARGET.chatId, 'manual-send');
    await jest.advanceTimersByTimeAsync(30_000);

    expect(dispatchedTargets).toHaveLength(0);
  });

  it('retries Codex even when the tab retains a terminal-backed Claude mode', async () => {
    const harness = createHarness();
    harness.setChatTab({
      ...chatTab([userMessage('Original request')]),
      interfaceMode: 'claude-code',
    });
    noteChatSessionEvent(TARGET, 'codex', {
      type: 'codex',
      event: {
        type: 'turn.failed',
        error: { codexErrorInfo: { serverOverloaded: {} } },
      },
    });
    await flushPromises();

    await jest.advanceTimersByTimeAsync(30_000);

    expect(harness.dispatchCalls).toHaveLength(1);
    expect(last(harness.emitted)?.active).toBe(true);
  });

  it('does not resurrect a cycle cancelled during preference or dispatch awaits', async () => {
    let resolvePreference: (value: {
      autoRetryTransientErrorsChats: boolean;
    }) => void = (): void => undefined;
    const pendingPreference = new Promise<{
      autoRetryTransientErrorsChats: boolean;
    }>((resolve) => {
      resolvePreference = resolve;
    });
    const initialHarness = createHarness({
      readPreferences: () => pendingPreference,
    });
    startTransientCycle();
    cancelTransientRetryForChat(TARGET, 'cancel-during-pref');
    resolvePreference({ autoRetryTransientErrorsChats: true });
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(initialHarness.dispatchCalls).toHaveLength(0);

    resetTransientRetryServiceForTests();
    let resolveDispatch = (): void => undefined;
    const pendingDispatch = new Promise<void>((resolve) => {
      resolveDispatch = resolve;
    });
    const dispatchCalls: DispatchCall[] = [];
    const dispatchHarness = createHarness({
      dispatchRetry: (_target, prompt, userMessageId) => {
        dispatchCalls.push({ prompt, userMessageId });
        return pendingDispatch;
      },
    });
    startTransientCycle();
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);
    cancelTransientRetryForChat(TARGET, 'cancel-during-dispatch');
    resolveDispatch();
    await flushPromises();
    noteChatSessionEvent(TARGET, 'claude', {
      ...TRANSIENT_FAILURE,
      canopy_turn_user_message_id: dispatchCalls[0]?.userMessageId,
    });
    await jest.advanceTimersByTimeAsync(120_000);
    expect(dispatchCalls).toHaveLength(1);
    expect(last(dispatchHarness.emitted)?.active).toBe(false);
  });

  it('recognizes a queued retry row after its live cycle was cancelled', async () => {
    const harness = createHarness();
    startTransientCycle();
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);

    const retryUserMessageId = harness.dispatchCalls[0]?.userMessageId;
    expect(retryUserMessageId).toBeDefined();
    cancelTransientRetryForChat(TARGET, 'manual-send');

    expect(
      cancelTransientRetryForChat(
        { ...TARGET, userMessageId: retryUserMessageId },
        'queued-manual-send',
      ),
    ).toBe(true);
  });

  it('retains queued retry cancellation markers until each row is consumed', async () => {
    const harness = createHarness();
    const queuedRetries: Array<{
      target: UsageLimitedChatTarget;
      userMessageId: string;
    }> = [];

    for (let index = 0; index < 31; index += 1) {
      const target = { ...TARGET, chatId: `chat-${index}` };
      noteChatSessionEvent(target, 'claude', TRANSIENT_FAILURE);
      await flushPromises();
      await jest.advanceTimersByTimeAsync(30_000);
      const userMessageId = harness.dispatchCalls[index]?.userMessageId;
      if (!userMessageId) throw new Error('Expected a queued retry id.');
      cancelTransientRetryForChat(target, 'manual-send');
      queuedRetries.push({ target, userMessageId });
    }

    const firstQueuedRetry = queuedRetries[0];
    if (!firstQueuedRetry) throw new Error('Expected a queued retry.');
    expect(
      cancelTransientRetryForChat(
        {
          ...firstQueuedRetry.target,
          userMessageId: firstQueuedRetry.userMessageId,
        },
        'queued-manual-send',
      ),
    ).toBe(true);
    expect(
      cancelTransientRetryForChat(
        {
          ...firstQueuedRetry.target,
          userMessageId: firstQueuedRetry.userMessageId,
        },
        'queued-manual-send',
      ),
    ).toBe(false);
  });

  it('matches a fast failure delivered while dispatch is still awaiting', async () => {
    const dispatchCalls: DispatchCall[] = [];
    createHarness({
      dispatchRetry: (_target, prompt, userMessageId) => {
        dispatchCalls.push({ prompt, userMessageId });
        noteChatSessionEvent(TARGET, 'claude', {
          ...TRANSIENT_FAILURE,
          canopy_turn_user_message_id: userMessageId,
        });
        return Promise.resolve();
      },
    });
    startTransientCycle();
    await flushPromises();

    await jest.advanceTimersByTimeAsync(30_000);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(dispatchCalls).toHaveLength(2);
  });

  it('keeps the next attempt when cleanup rejects after a fast failure', async () => {
    const dispatchCalls: DispatchCall[] = [];
    createHarness({
      dispatchRetry: (_target, prompt, userMessageId) => {
        dispatchCalls.push({ prompt, userMessageId });
        if (dispatchCalls.length === 1) {
          noteChatSessionEvent(TARGET, 'claude', {
            ...TRANSIENT_FAILURE,
            canopy_turn_user_message_id: userMessageId,
          });
          return Promise.reject(new Error('late cleanup failure'));
        }
        return Promise.resolve();
      },
    });
    startTransientCycle();
    await flushPromises();

    await jest.advanceTimersByTimeAsync(30_000);
    await flushPromises();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(dispatchCalls).toHaveLength(2);
  });
});
