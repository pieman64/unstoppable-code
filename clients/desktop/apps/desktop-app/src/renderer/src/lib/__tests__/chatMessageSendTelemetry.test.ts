/**
 * @jest-environment jsdom
 */
import {
  startClientOperation,
  succeedClientOperation,
} from '@canopy/desktop-instrumentation/client';
import {
  APP_ADVISOR_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import {
  HOME_COMPOSER_KEY,
  chatMessageSendSurfaceForProject,
  markSuggestedPromptInserted,
  resetChatMessageSendTelemetryForTests,
  trackChatComposerSend,
  trackChatMessageSend,
} from '../chatMessageSendTelemetry';

jest.mock('@canopy/desktop-instrumentation/client', () => ({
  startClientOperation: jest.fn(),
  succeedClientOperation: jest.fn(),
}));

const mockStart = jest.mocked(startClientOperation);
const mockSucceed = jest.mocked(succeedClientOperation);

function lastContext(): Record<string, unknown> | undefined {
  const call = mockSucceed.mock.calls.at(-1);
  return call?.[1]?.context;
}

const send = {
  provider: 'claude',
  model: 'claude-sonnet-5-5',
  isAiCreditsBilled: false,
  isPlanMode: false,
} as const;

beforeEach(() => {
  jest.clearAllMocks();
  resetChatMessageSendTelemetryForTests();
});

describe('chatMessageSendSurfaceForProject', () => {
  it('maps App Advisor, standalone chats and worktree chats', () => {
    expect(chatMessageSendSurfaceForProject(APP_ADVISOR_PROJECT_ID)).toBe(
      'app_advisor',
    );
    expect(chatMessageSendSurfaceForProject(STANDALONE_CHAT_PROJECT_ID)).toBe(
      'standalone_chat',
    );
    expect(chatMessageSendSurfaceForProject('proj_repo')).toBe('worktree_chat');
  });

  it('reports no surface for the Pipeline Editor assistant', () => {
    expect(
      chatMessageSendSurfaceForProject(PIPELINE_EDITOR_PROJECT_ID),
    ).toBeNull();
  });
});

describe('trackChatMessageSend', () => {
  it('emits one chat send operation with the bounded properties', () => {
    trackChatMessageSend({
      surface: 'worktree_chat',
      composerKey: 'chat_1',
      ...send,
    });

    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockSucceed).toHaveBeenCalledTimes(1);
    expect(mockSucceed.mock.calls[0]?.[0]).toBe('canopy.chat_message_send');
    expect(lastContext()).toEqual({
      chat_surface: 'worktree_chat',
      composer_mode: 'default',
      is_suggested_prompt: false,
      provider: 'claude',
      model: 'claude-sonnet-5-5',
      is_ai_credits_billed: false,
    });
  });

  it('omits provider and model when the composer has none', () => {
    trackChatMessageSend({
      surface: 'home',
      composerKey: HOME_COMPOSER_KEY,
      isAiCreditsBilled: true,
      isPlanMode: true,
    });

    expect(lastContext()).not.toHaveProperty('provider');
    expect(lastContext()).not.toHaveProperty('model');
    expect(lastContext()).toMatchObject({
      is_ai_credits_billed: true,
      composer_mode: 'plan',
    });
  });

  it.each([
    [true, 'plan'],
    [false, 'default'],
  ] as const)(
    'reports isPlanMode=%s as composer_mode=%s',
    (isPlanMode, composerMode) => {
      trackChatMessageSend({
        surface: 'worktree_chat',
        composerKey: 'chat_1',
        ...send,
        isPlanMode,
      });

      expect(lastContext()).toMatchObject({ composer_mode: composerMode });
    },
  );

  it('reports Auto as the model and no provider, since Auto chooses per turn', () => {
    trackChatMessageSend({
      surface: 'worktree_chat',
      composerKey: 'chat_1',
      ...send,
      isAutoModel: true,
    });

    expect(lastContext()).toMatchObject({ model: 'auto' });
    expect(lastContext()).not.toHaveProperty('provider');
  });

  it('flags a send whose composer had a suggested prompt inserted, once', () => {
    markSuggestedPromptInserted('chat_1');

    trackChatMessageSend({
      surface: 'standalone_chat',
      composerKey: 'chat_1',
      ...send,
    });
    expect(lastContext()).toMatchObject({ is_suggested_prompt: true });

    trackChatMessageSend({
      surface: 'standalone_chat',
      composerKey: 'chat_1',
      ...send,
    });
    expect(lastContext()).toMatchObject({ is_suggested_prompt: false });
  });

  it('keeps a suggested prompt with the composer it was inserted into', () => {
    markSuggestedPromptInserted(HOME_COMPOSER_KEY);

    trackChatMessageSend({
      surface: 'worktree_chat',
      composerKey: 'chat_1',
      ...send,
    });
    expect(lastContext()).toMatchObject({ is_suggested_prompt: false });

    trackChatMessageSend({
      surface: 'home',
      composerKey: HOME_COMPOSER_KEY,
      ...send,
    });
    expect(lastContext()).toMatchObject({ is_suggested_prompt: true });
  });

  it('omits the retired first-message property on every send', () => {
    for (const surface of ['home', 'worktree_chat', 'app_advisor'] as const) {
      trackChatMessageSend({
        surface,
        composerKey: HOME_COMPOSER_KEY,
        ...send,
      });
      expect(lastContext()).not.toHaveProperty('is_first_message');
    }
  });

  it('never throws into the send path when instrumentation fails', () => {
    mockSucceed.mockImplementationOnce(() => {
      throw new Error('instrumentation down');
    });
    expect(() =>
      trackChatMessageSend({
        surface: 'home',
        composerKey: HOME_COMPOSER_KEY,
        ...send,
      }),
    ).not.toThrow();
  });
});

describe('trackChatComposerSend', () => {
  it('reports the chat target surface and keys suggested prompts by chat id', () => {
    markSuggestedPromptInserted('chat_1');
    trackChatComposerSend({
      target: { projectId: STANDALONE_CHAT_PROJECT_ID, chatId: 'chat_1' },
      ...send,
    });

    expect(lastContext()).toMatchObject({
      chat_surface: 'standalone_chat',
      is_suggested_prompt: true,
    });
  });

  it.each([
    [true, 'plan'],
    [false, 'default'],
  ] as const)(
    'forwards isPlanMode=%s as composer_mode=%s',
    (isPlanMode, composerMode) => {
      trackChatComposerSend({
        target: { projectId: 'proj_repo', chatId: 'chat_1' },
        ...send,
        isPlanMode,
      });

      expect(lastContext()).toMatchObject({
        chat_surface: 'worktree_chat',
        composer_mode: composerMode,
      });
    },
  );

  it('sends nothing for the Pipeline Editor or a composer with no target', () => {
    trackChatComposerSend({
      target: { projectId: PIPELINE_EDITOR_PROJECT_ID, chatId: 'chat_1' },
      ...send,
    });
    trackChatComposerSend({ target: undefined, ...send });

    expect(mockSucceed).not.toHaveBeenCalled();
  });
});
