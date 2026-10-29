const mockGetState = jest.fn<{ turnState: string } | undefined, unknown[]>();

jest.mock('../../integration/claude-terminal-session-service', () => ({
  getClaudeTerminalSessionService: (): object => ({ getState: mockGetState }),
}));

import type { PersistedChatTab } from '@canopy/desktop-shared/types';
import {
  isTerminalDrivenChat,
  resolveTerminalDrivenChat,
} from '../terminal-driven-chat';

const tab = (fields: Partial<PersistedChatTab>): PersistedChatTab => ({
  id: 'chat-1',
  title: 'Chat',
  createdAt: '2026-01-01T00:00:00.000Z',
  messages: [],
  ...fields,
});

describe('terminal-driven chats', () => {
  it.each(['claude-code', 'auto'] as const)(
    'counts a Claude tab in %s mode with a terminal session',
    (interfaceMode) => {
      expect(
        isTerminalDrivenChat(
          tab({ providerType: 'claude', interfaceMode, sdkSessionId: 's-1' }),
          undefined,
        ),
      ).toBe(true);
    },
  );

  it.each(['starting', 'running', 'cleaning_up'] as const)(
    'counts a Claude tab whose terminal turn is %s',
    (turnState) => {
      expect(
        isTerminalDrivenChat(tab({ providerType: 'claude' }), turnState),
      ).toBe(true);
    },
  );

  it('leaves app-driven, sessionless, and non-Claude tabs out', () => {
    expect(
      isTerminalDrivenChat(
        tab({
          providerType: 'claude',
          interfaceMode: 'canopy',
          sdkSessionId: 's-1',
        }),
        'idle',
      ),
    ).toBe(false);
    expect(
      isTerminalDrivenChat(
        tab({ providerType: 'claude', interfaceMode: 'claude-code' }),
        undefined,
      ),
    ).toBe(false);
    expect(
      isTerminalDrivenChat(
        tab({
          providerType: 'codex',
          interfaceMode: 'claude-code',
          sdkSessionId: 's-1',
        }),
        'running',
      ),
    ).toBe(false);
    expect(isTerminalDrivenChat(undefined, 'running')).toBe(false);
  });

  it("reads the chat's live terminal turn", async () => {
    mockGetState.mockReturnValueOnce({ turnState: 'running' });
    await expect(
      resolveTerminalDrivenChat({
        projectId: 'p1',
        worktreeId: 'w1',
        tab: tab({ providerType: 'claude' }),
      }),
    ).resolves.toBe(true);
    expect(mockGetState).toHaveBeenCalledWith('p1', 'w1', 'chat-1');
  });
});
