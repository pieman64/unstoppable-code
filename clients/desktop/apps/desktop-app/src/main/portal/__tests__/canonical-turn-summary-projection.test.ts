import type { PersistedChatTurnState } from '@canopy/agent-transcript/turn';
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

import { subscribePortalCanonicalTurnSummaries } from '../canonical-turn-summary-projection';

const scope = { projectId: 'p', worktreeId: 'w', chatId: 'c' };

function state(
  phase: PersistedChatTurnState['phase'],
  live = 0,
): PersistedChatTurnState {
  return {
    phase,
    decisionPending: false,
    catchingUp: false,
    endedTurnIds: [],
    background: { native: [], managed: { live, queued: 0 } },
  };
}

function commit(turn: PersistedChatTurnState): void {
  for (const listener of Array.from(mockCommitListeners))
    listener({ scope, state: turn, generation: 1 });
}

describe('Portal canonical turn summaries (turn-state phase 41b)', () => {
  afterEach(() => {
    mockCommitListeners.clear();
  });

  it("re-sends a chat's summary when its turn phase or background count changes", () => {
    const emitSummary = jest.fn();
    const unsubscribe = subscribePortalCanonicalTurnSummaries(emitSummary);

    commit(state('foreground'));
    commit(state('foreground'));
    commit(state('background', 2));
    commit(state('background', 2));
    commit(state('background', 1));
    commit(state('idle'));

    expect(emitSummary.mock.calls).toEqual([
      [scope],
      [scope],
      [scope],
      [scope],
    ]);
    unsubscribe();
    commit(state('foreground'));
    expect(emitSummary).toHaveBeenCalledTimes(4);
  });
});
