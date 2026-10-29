import { appendConsumedClaudeTerminalInitialPrompt } from '../terminal-runtime';
import type { ChatMessage, ChatTab, QueuedChatMessage } from '../types';

jest.mock('../../projectsStore', (): unknown => ({
  useProjectsStore: {
    getState: (): { projects: never[] } => ({ projects: [] }),
  },
}));
jest.mock('../../pipelineRunsStore', (): unknown => ({
  usePipelineRunsStore: {
    getState: (): { summaries: never[] } => ({ summaries: [] }),
  },
}));

const agentSent: NonNullable<
  QueuedChatMessage['dispatchOptions']
>['agentSent'] = {
  sender: {
    kind: 'project',
    projectType: 'code',
    projectId: 'sender-project',
    taskId: 'sender-task',
    chatId: 'sender-chat',
  },
  chatTitle: 'Sender chat',
  projectLabel: 'Sender project',
};

function userMessage(id: string, text: string): ChatMessage {
  return {
    id,
    role: 'user',
    timestamp: 1,
    blocks: [{ type: 'text', text }],
  };
}

function queuedMessage(includeAcceptedInputId = true): QueuedChatMessage {
  return {
    text: 'Repeatable accepted request',
    dispatchOptions: {
      ...(includeAcceptedInputId
        ? { acceptedInputId: 'accepted-input-12' }
        : {}),
      agentSent,
    },
  };
}

function tabWithMessages(messages: ChatMessage[]): ChatTab {
  return {
    id: 'chat-1',
    messages,
    queuedMessages: [queuedMessage()],
  } as unknown as ChatTab;
}

describe('appendConsumedClaudeTerminalInitialPrompt', () => {
  it('does not deduplicate distinct accepted inputs just because their text matches', () => {
    const original = tabWithMessages([
      userMessage('previous-input', 'Repeatable accepted request'),
    ]);

    const result = appendConsumedClaudeTerminalInitialPrompt(
      original,
      queuedMessage(),
      2,
      {
        userMessageId: 'new-accepted-user-message',
        turnTimerMessageId: 'new-turn-timer',
      },
    );

    expect(
      result.messages.filter((message) => message.role === 'user'),
    ).toEqual([
      expect.objectContaining({ id: 'previous-input' }),
      expect.objectContaining({ id: 'new-accepted-user-message' }),
    ]);
  });

  it('matches the existing userMessageId and copies validated agent display metadata', () => {
    const original = tabWithMessages([
      userMessage('accepted-user-message', 'Repeatable accepted request'),
    ]);

    const result = appendConsumedClaudeTerminalInitialPrompt(
      original,
      queuedMessage(),
      2,
      {
        userMessageId: 'accepted-user-message',
        turnTimerMessageId: 'accepted-turn-timer',
      },
    );

    const userMessages = result.messages.filter(
      (message) => message.role === 'user',
    );
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]).toMatchObject({
      id: 'accepted-user-message',
      userMessageSource: 'agent',
      agentSent,
    });
  });

  it('ignores queued agentSent metadata when there is no accepted input id', () => {
    const result = appendConsumedClaudeTerminalInitialPrompt(
      tabWithMessages([]),
      queuedMessage(false),
      2,
      {
        userMessageId: 'ordinary-user-message',
        turnTimerMessageId: 'ordinary-turn-timer',
      },
    );

    expect(result.messages[0]).toMatchObject({
      id: 'ordinary-user-message',
      role: 'user',
    });
    expect(result.messages[0]).not.toHaveProperty('agentSent');
    expect(result.messages[0]).not.toHaveProperty('userMessageSource');
  });

  it('keeps legacy text matching and watcher attribution unchanged', () => {
    const original = tabWithMessages([
      userMessage('legacy-user-message', 'Repeatable accepted request'),
      {
        id: 'legacy-turn-timer',
        role: 'system',
        timestamp: 1,
        blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: null }],
      },
    ]);
    const legacyQueuedMessage = queuedMessage(false);
    legacyQueuedMessage.dispatchOptions = {
      watcherFired: { kind: 'Hook (CI guard)' },
    };

    const result = appendConsumedClaudeTerminalInitialPrompt(
      original,
      legacyQueuedMessage,
      2,
      {
        userMessageId: 'legacy-user-message',
        turnTimerMessageId: 'legacy-turn-timer',
      },
    );

    const userMessages = result.messages.filter(
      (message) => message.role === 'user',
    );
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]).toMatchObject({
      id: 'legacy-user-message',
      watcherFired: { kind: 'Hook (CI guard)' },
    });
  });
});
