import { initialChatTurnState } from '@canopy/agent-transcript/turn';
import type { PersistedChatTurnState } from '@canopy/agent-transcript/turn';
import type {
  ChatCoreMutation,
  ChatRuntimeState,
} from '@canopy/desktop-shared/types';
import {
  applyMutation,
  ChatStateInvariantError,
  reduceChatState,
} from '../chat-state-reducer';
import type { CanonicalChatState } from '../chat-state-reducer';
import { projectChatStateChanges } from '../chat-state-projection';

type RuntimeWithTurn = ChatRuntimeState & { turn: PersistedChatTurnState };

function persistedTurnState(): PersistedChatTurnState {
  const { cursors, ...persistedState } = initialChatTurnState();
  void cursors;
  return persistedState;
}

function runtimeWithTurn(turn: PersistedChatTurnState): RuntimeWithTurn {
  return {
    status: 'streaming',
    queuedMessageIds: ['before-patch'],
    lastActivityAt: 1,
    turn,
  };
}

function canonicalState(runtime: RuntimeWithTurn): CanonicalChatState {
  return {
    tabsFile: {
      version: 1,
      tabs: [
        {
          id: 'chat-1',
          title: 'Turn funnel test',
          createdAt: '2026-10-18T00:00:00.000Z',
          messages: [],
        },
      ],
      activeTabId: 'chat-1',
    },
    archivesFile: { version: 1, archived: [] },
    runtimeByChatId: { 'chat-1': runtime },
  };
}

describe('chat runtime turn funnel', () => {
  it('retains the prior turn when a whole runtime replacement omits turn', () => {
    const previousTurn = persistedTurnState();
    const current = canonicalState(runtimeWithTurn(previousTurn));
    const replacement: ChatRuntimeState = {
      status: 'idle',
      queuedMessageIds: ['after-patch'],
      lastActivityAt: 2,
    };

    const next = applyMutation(current, {
      type: 'runtime.patched',
      chatId: 'chat-1',
      runtime: replacement,
    });

    expect(next.runtimeByChatId['chat-1']).toEqual({
      ...replacement,
      turn: previousTurn,
    });
    expect(next.runtimeByChatId['chat-1']).not.toHaveProperty('activeTurn');
  });

  it('replaces the prior turn when a runtime patch explicitly supplies turn', () => {
    const previousTurn = persistedTurnState();
    const replacementTurn: PersistedChatTurnState = {
      ...persistedTurnState(),
      catchingUp: true,
    };
    const current = canonicalState(runtimeWithTurn(previousTurn));
    const replacement = runtimeWithTurn(replacementTurn);

    const next = applyMutation(current, {
      type: 'runtime.patched',
      chatId: 'chat-1',
      runtime: replacement,
    });

    expect(next.runtimeByChatId['chat-1']).toEqual(replacement);
    expect(next.runtimeByChatId['chat-1']).toMatchObject({
      turn: replacementTurn,
    });
  });

  it('continues to reject runtime patches for non-live tabs', () => {
    const current = canonicalState(runtimeWithTurn(persistedTurnState()));

    expect(() =>
      applyMutation(current, {
        type: 'runtime.patched',
        chatId: 'not-live',
        runtime: { status: 'idle', queuedMessageIds: [] },
      }),
    ).toThrow(ChatStateInvariantError);
  });

  it('projects the committed runtime snapshot so event replay matches the writer', () => {
    const previousTurn = persistedTurnState();
    const current = canonicalState(runtimeWithTurn(previousTurn));
    const mutation = {
      type: 'runtime.patched',
      chatId: 'chat-1',
      runtime: {
        status: 'idle',
        queuedMessageIds: [],
        lastActivityAt: 2,
      },
    } satisfies ChatCoreMutation;
    const committedRuntime: RuntimeWithTurn = {
      ...mutation.runtime,
      turn: previousTurn,
    };
    const committed: CanonicalChatState = {
      ...current,
      runtimeByChatId: {
        ...current.runtimeByChatId,
        'chat-1': committedRuntime,
      },
    };

    const [change] = projectChatStateChanges([mutation], {
      now: 500,
      snapshot: committed,
    });

    if (change.type !== 'runtime.patched') {
      throw new Error('Expected a projected runtime patch.');
    }
    expect(change.runtime).toEqual(committed.runtimeByChatId['chat-1']);
    expect(reduceChatState(current, [change]).runtimeByChatId).toEqual(
      committed.runtimeByChatId,
    );
  });
});
