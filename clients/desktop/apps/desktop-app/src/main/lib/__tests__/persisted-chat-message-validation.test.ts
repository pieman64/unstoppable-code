import { isPersistedChatMessage } from '../persisted-chat-message-validation';

describe('isPersistedChatMessage', () => {
  it("keeps an event wake's cause on a stored turn timer", () => {
    const stored: unknown = JSON.parse(
      JSON.stringify({
        id: 'wake:timer',
        role: 'system',
        timestamp: 4,
        blocks: [
          {
            type: 'turn_timer',
            turnId: 'wake',
            spawnedBy: { taskId: 'task-1', toolUseId: 'tool-1', event: true },
            startedAt: 4,
            completedAt: 6,
          },
        ],
      }),
    );

    expect(isPersistedChatMessage(stored)).toBe(true);
    expect(stored).toMatchObject({
      blocks: [
        {
          spawnedBy: { taskId: 'task-1', toolUseId: 'tool-1', event: true },
        },
      ],
    });
  });
});
