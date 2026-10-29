/** @jest-environment jsdom */
import { continueTryItChat } from '../tryItChat';
import type { CanopyApi } from '@canopy/desktop-shared/types';

const mockCommand = jest.fn();
const mockTabs = { current: [{ id: 'chat' }] };
jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: (): {
      loadTabsForTarget: () => Promise<void>;
      worktreeChats: Record<string, { tabs: { id: string }[] }>;
    } => ({
      loadTabsForTarget: (): Promise<void> => Promise.resolve(),
      worktreeChats: { 'cowork/entry': { tabs: mockTabs.current } },
    }),
  },
}));
jest.mock('@/stores/standaloneChatStore', () => ({
  useStandaloneChatStore: { getState: jest.fn() },
}));
jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: { getState: jest.fn() },
}));
const request = {
  location: { projectId: 'cowork', worktreeId: 'entry' },
  chatId: 'chat',
  requestId: 'continuation-request',
  message: 'Exact prompt',
  pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
};
beforeEach(() => {
  mockCommand.mockReset();
  mockTabs.current = [{ id: 'chat' }];
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { chat: { command: mockCommand } } as unknown as CanopyApi,
  });
});
it.each(['applied', 'already_applied'])(
  'requires the canonical %s result to name the actual chat and message',
  async (outcome) => {
    mockCommand.mockResolvedValue({
      outcome,
      entityId: 'chat',
      messageId: 'continuation-request',
    });
    await continueTryItChat(request);
    expect(mockCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: 'try-it-continuation-request',
        command: {
          type: 'chat.send_message',
          chatId: 'chat',
          userMessageId: 'continuation-request',
          text: 'Exact prompt',
        },
      }),
    );
  },
);
it.each([
  { outcome: 'already_applied', messageId: 'continuation-request' },
  { outcome: 'applied', entityId: 'other', messageId: 'continuation-request' },
  { outcome: 'applied', entityId: 'chat', messageId: 'other' },
  { outcome: 'rejected', entityId: 'chat', messageId: 'continuation-request' },
])('refuses message presence and mismatched receipts %#', async (result) => {
  mockCommand.mockResolvedValue(result);
  await expect(continueTryItChat(request)).rejects.toThrow(
    'not been acknowledged',
  );
});
it('rechecks account authorization and tab existence before dispatch', async () => {
  await expect(
    continueTryItChat({
      ...request,
      canContinue: () => Promise.resolve(false),
    }),
  ).rejects.toThrow('account changed');
  expect(mockCommand).not.toHaveBeenCalled();
  mockTabs.current = [];
  await expect(continueTryItChat(request)).rejects.toThrow(
    'no longer available',
  );
  expect(mockCommand).not.toHaveBeenCalled();
});

// CAN-4396 AC3 evidence: every attempt carries the same command and message
// identity, so main replays one receipt instead of appending a second turn.
it('keeps the command and message IDs across separate dispatch attempts', async () => {
  mockCommand
    .mockRejectedValueOnce(new Error('response lost'))
    .mockResolvedValueOnce({ outcome: 'rejected' })
    .mockResolvedValueOnce({
      outcome: 'already_applied',
      entityId: 'chat',
      messageId: 'continuation-request',
    });
  await expect(continueTryItChat(request)).rejects.toThrow('response lost');
  await expect(continueTryItChat(request)).rejects.toThrow(
    'not been acknowledged',
  );
  await expect(continueTryItChat(request)).resolves.toBeUndefined();
  expect(mockCommand).toHaveBeenCalledTimes(3);
  for (const [dispatch] of mockCommand.mock.calls)
    expect(dispatch).toMatchObject({
      commandId: 'try-it-continuation-request',
      command: { chatId: 'chat', userMessageId: 'continuation-request' },
    });
});

it('sends model effort through the strict command contract while the tab owns the model', async () => {
  mockCommand.mockResolvedValue({
    outcome: 'applied',
    entityId: 'chat',
    messageId: 'continuation-request',
  });
  await continueTryItChat({
    ...request,
    model: { model: 'opus[1m]', thinkingLevel: 'high' },
  });
  expect(mockCommand).toHaveBeenCalledWith({
    schemaVersion: 1,
    ...request.location,
    commandId: 'try-it-continuation-request',
    command: {
      type: 'chat.send_message',
      chatId: 'chat',
      userMessageId: 'continuation-request',
      text: 'Exact prompt',
      modelConfig: { thinkingLevel: 'high' },
    },
  });
});
