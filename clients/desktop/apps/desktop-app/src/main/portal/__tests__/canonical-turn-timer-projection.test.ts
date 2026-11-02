import type { ChatTurnEffect } from '@canopy/agent-transcript/turn';
import type {
  PersistedChatMessage,
  PortalEventEnvelope,
} from '@canopy/desktop-shared/types';
import type { ChatTurnStateCommit } from '../../services/chat-turn-state-handoff';

const mockCommitListeners = new Set<(commit: ChatTurnStateCommit) => void>();
jest.mock('../../services/chat-state-service', (): unknown => ({
  getChatStateService: () => ({
    onTurnStateCommitted: (
      listener: (commit: ChatTurnStateCommit) => void,
    ): (() => void) => {
      mockCommitListeners.add(listener);
      return (): void => {
        mockCommitListeners.delete(listener);
      };
    },
  }),
}));
jest.mock('../../lib/workspace-registry', () => ({
  isCoworkWorkspace: (id: string): boolean => id === 'cowork-workspace',
}));
jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessError: jest.fn(),
}));

import { subscribePortalCanonicalTurnTimers } from '../canonical-turn-timer-projection';

const timerRow: PersistedChatMessage = {
  id: 'T:timer',
  role: 'system',
  timestamp: 1000,
  blocks: [
    {
      type: 'turn_timer',
      turnId: 'T',
      startedAt: 1000,
      completedAt: null,
      userMessageId: 'A',
    },
  ],
};
const opened: ChatTurnEffect = {
  type: 'timer.open',
  timerId: 'T:timer',
  turnId: 'T',
  atMs: 1000,
};

function commit(
  projectId: string,
  autoRoutedModels?: Readonly<Record<string, string>>,
): void {
  for (const listener of Array.from(mockCommitListeners))
    listener({
      scope: { projectId, worktreeId: 'entry', chatId: 'chat' },
      state: {
        phase: 'foreground',
        decisionPending: false,
        catchingUp: false,
        endedTurnIds: [],
        background: { native: [], managed: { live: 0, queued: 0 } },
      },
      generation: 1,
      effects: [opened],
      timerMessages: [timerRow],
      ...(autoRoutedModels ? { autoRoutedModels } : {}),
    });
}

describe('subscribePortalCanonicalTurnTimers (phase 35c5c)', () => {
  beforeEach(() => {
    mockCommitListeners.clear();
  });

  it('carries the Auto-routed model chip on the live timer (turn-state phase 43f)', () => {
    const emit = jest.fn<void, [PortalEventEnvelope]>();
    const unsubscribe = subscribePortalCanonicalTurnTimers(emit);

    commit('workspace', { A: 'claude-sonnet-4-5' });

    const [event] = emit.mock.calls.map(([envelope]) => envelope);
    expect(JSON.stringify(event)).toContain(
      '"autoRoutedModel":"claude-sonnet-4-5"',
    );
    unsubscribe();
  });

  it('projects each commit timer row onto the host portal stream', () => {
    const emit = jest.fn<void, [PortalEventEnvelope]>();
    const unsubscribe = subscribePortalCanonicalTurnTimers(emit);

    commit('workspace');
    commit('cowork-workspace');
    commit('app-advisor');

    const message: unknown = expect.objectContaining({
      messageId: 'T:timer',
      chatId: 'chat',
      role: 'system',
    });
    const expected: unknown[] = [
      expect.objectContaining({
        type: 'portal.chat.event',
        payload: {
          scope: 'worktree',
          workspaceLocalId: 'workspace',
          worktreeLocalId: 'entry',
          chatId: 'chat',
          message,
        },
      }),
      expect.objectContaining({
        type: 'portal.chat.event',
        payload: {
          scope: 'standalone',
          projectLocalId: 'cowork-workspace',
          projectId: 'cowork-workspace',
          workEntryId: 'entry',
          chatId: 'chat',
          message,
        },
      }),
      expect.objectContaining({
        type: 'portal.app_advisor.event',
        payload: { chatId: 'chat', message },
      }),
    ];
    expect(emit.mock.calls.map(([event]) => event)).toEqual(expected);

    unsubscribe();
    commit('workspace');
    expect(emit).toHaveBeenCalledTimes(3);
  });
});
