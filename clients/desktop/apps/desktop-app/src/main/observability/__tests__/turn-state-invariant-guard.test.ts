import {
  initialChatTurnState,
  serializeChatTurnState,
} from '@canopy/agent-transcript/turn';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import type {
  ChatTurnStateChange,
  ChatTurnStateCommit,
} from '../../services/chat-turn-state-handoff';
import type { SessionDiagnosticRecord } from '../service';
import { installTurnStateInvariantGuard } from '../turn-state-invariant-guard';

const SCOPE = { projectId: 'proj', worktreeId: 'wt', chatId: 'chat' };

function timerRow(turnId: string, open: boolean): PersistedChatMessage {
  return {
    id: `${turnId}:timer`,
    role: 'system',
    timestamp: 1,
    blocks: [
      { type: 'turn_timer', startedAt: 1, completedAt: open ? null : 2 },
    ],
  };
}

function commit(
  currentTurnId: string | undefined,
  timerMessages: PersistedChatMessage[],
  chatId = SCOPE.chatId,
): ChatTurnStateCommit {
  const state = initialChatTurnState();
  return {
    scope: { ...SCOPE, chatId },
    state: serializeChatTurnState(
      currentTurnId === undefined
        ? state
        : {
            ...state,
            phase: 'foreground',
            current: {
              id: currentTurnId,
              origin: 'user',
              startedAtMs: 1,
              pauses: [],
            },
          },
    ),
    generation: 1,
    timerMessages,
  };
}

function change(cause: ChatTurnStateChange['cause']): ChatTurnStateChange {
  return {
    scope: SCOPE,
    state: serializeChatTurnState(initialChatTurnState()),
    effects: [],
    generation: 1,
    cause,
  };
}

interface Installed {
  publish: (next: ChatTurnStateCommit) => void;
  announce: (next: ChatTurnStateChange) => void;
}

function install(
  record: (diagnostic: SessionDiagnosticRecord) => void,
): Installed {
  let committed: ((next: ChatTurnStateCommit) => void) | undefined;
  let changed: ((next: ChatTurnStateChange) => void) | undefined;
  installTurnStateInvariantGuard(record, {
    onTurnStateCommitted: (next): (() => void) => {
      committed = next;
      return () => undefined;
    },
    onTurnStateChange: (next): (() => void) => {
      changed = next;
      return () => undefined;
    },
  });
  return {
    publish: (next): void => {
      committed?.(next);
    },
    announce: (next): void => {
      changed?.(next);
    },
  };
}

function guard(): Installed & { records: SessionDiagnosticRecord[] } {
  const records: SessionDiagnosticRecord[] = [];
  return {
    records,
    ...install((record) => {
      records.push(record);
    }),
  };
}

describe('turn state invariant guard', () => {
  it('records nothing while each turn opens and closes its own timer', () => {
    const f = guard();
    f.publish(commit('a', [timerRow('a', true)]));
    f.publish(commit(undefined, [timerRow('a', false)]));
    f.publish(commit('b', [timerRow('b', true)]));
    f.publish(commit(undefined, [timerRow('b', false)]));

    expect(f.records).toEqual([]);
  });

  it('reports a settled turn state with an open timer once per chat', () => {
    const f = guard();
    f.publish(commit('a', [timerRow('a', true)]));
    f.publish(commit(undefined, []));
    f.publish(commit(undefined, []));

    expect(f.records).toEqual([
      expect.objectContaining({
        kind: 'turn_state_invariant_violation',
        ...SCOPE,
        sessionKey: 'proj/wt/chat',
        turnStateInvariant: 'settled_runtime_open_timer',
        openTimerCount: 1,
      }),
    ]);
  });

  it('reports two open timers once per chat', () => {
    const f = guard();
    f.publish(commit('a', [timerRow('a', true)]));
    f.publish(commit('b', [timerRow('b', true)]));
    f.publish(commit('c', [timerRow('c', true)]));

    expect(
      f.records.map((record) => [
        record.turnStateInvariant,
        record.openTimerCount,
      ]),
    ).toEqual([['two_open_timers', 2]]);
  });

  it.each<ChatTurnStateChange['cause']>(['restart', 'reset'])(
    'forgets open timers a %s settled or removed without a commit',
    (cause) => {
      const f = guard();
      f.publish(commit('a', [timerRow('a', true)]));
      // Host reconcile closes a dead host's timer, and reset-to-point removes
      // rows, in transactions of their own that publish no turn-state commit.
      f.announce(change(cause));
      f.publish(commit('b', [timerRow('b', true)]));
      f.publish(commit(undefined, [timerRow('b', false)]));

      expect(f.records).toEqual([]);
    },
  );

  it('keeps open timers across the other changes', () => {
    const f = guard();
    f.publish(commit('a', [timerRow('a', true)]));
    f.announce(change('hydrate'));
    f.announce(change('lifecycle'));
    f.publish(commit(undefined, []));

    expect(f.records.map((record) => record.turnStateInvariant)).toEqual([
      'settled_runtime_open_timer',
    ]);
  });

  it('keeps each chat separate', () => {
    const f = guard();
    f.publish(commit('a', [timerRow('a', true)], 'one'));
    f.publish(commit('b', [timerRow('b', true)], 'two'));

    expect(f.records).toEqual([]);
  });

  it('never lets a diagnostic failure escape into the commit', () => {
    const f = install(() => {
      throw new Error('diagnostics unavailable');
    });
    expect(() => {
      f.publish(commit(undefined, [timerRow('a', true)]));
    }).not.toThrow();
  });
});
