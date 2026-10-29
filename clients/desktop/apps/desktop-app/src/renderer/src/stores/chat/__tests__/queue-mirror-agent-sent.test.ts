import { hostQueueViewsToQueuedMessages } from '../queue-mirror';

describe('host queue mirror agent attribution', () => {
  it('carries captured agent-sent attribution onto mirror rows', () => {
    const agentSent = {
      sender: {
        kind: 'bot' as const,
        botId: 'app_advisor',
        taskId: 'source-entry',
        chatId: 'source-chat',
      },
      chatTitle: 'Release prep',
      projectLabel: 'App Advisor',
    };
    const rows = hostQueueViewsToQueuedMessages([
      {
        id: 'queue-1',
        text: 'Review the release notes.',
        origin: 'portal',
        enqueuedAtMs: 42,
        agentSent,
      },
      { id: 'queue-2', text: 'typed', origin: 'desktop', enqueuedAtMs: 43 },
    ]);

    expect(rows[0]).toMatchObject({ hostQueueEntryId: 'queue-1', agentSent });
    expect(rows[1]).not.toHaveProperty('agentSent');
  });
});
