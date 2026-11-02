import { fromPersistedTab } from '../persisted-tabs';
import { localTurnActivity } from '../turn-activity';
import type { ChatMessage, ChatTab, SendingLease } from '../types';

function tab(overrides: Partial<ChatTab> = {}): ChatTab {
  return {
    ...fromPersistedTab({
      id: 'chat-1',
      title: 'Chat',
      messages: [],
      createdAt: '2026-10-27T00:00:00.000Z',
    }),
    ...overrides,
  };
}

function lease(overrides: Partial<SendingLease> = {}): SendingLease {
  return {
    userMessageId: 'user-1',
    kind: 'send',
    issuedAt: 1_000,
    deadline: 16_000,
    state: 'pending',
    ...overrides,
  };
}

const timerMessage: ChatMessage = {
  id: 'timer-1',
  role: 'system',
  blocks: [{ type: 'turn_timer', startedAt: 1_000, completedAt: null }],
  timestamp: 1_000,
};

const pendingTurn = { userMessageId: 'user-1', timerMessage };

describe('localTurnActivity', () => {
  it('reads an idle tab with no dispatch evidence as idle, not recoverable', () => {
    expect(localTurnActivity(tab(), 2_000)).toBe('idle');
  });

  it('reads a pending lease as dispatching until exactly its deadline', () => {
    const sending = tab({ sendingLease: lease() });
    expect(localTurnActivity(sending, 15_999)).toBe('dispatching');
    expect(localTurnActivity(sending, 16_000)).toBe('recoverable');
    expect(localTurnActivity(sending, 16_001)).toBe('recoverable');
  });

  it('reads an explicitly expired lease as uncertain delivery', () => {
    expect(
      localTurnActivity(
        tab({ sendingLease: lease({ state: 'expired' }) }),
        2_000,
      ),
    ).toBe('recoverable');
  });

  it('keeps the pending-turn bridge dispatching after the lease is acknowledged', () => {
    expect(
      localTurnActivity(
        tab({ sendingLease: lease({ state: 'acknowledged' }), pendingTurn }),
        2_000,
      ),
    ).toBe('dispatching');
    expect(
      localTurnActivity(
        tab({ sendingLease: lease({ state: 'acknowledged' }) }),
        2_000,
      ),
    ).toBe('idle');
    expect(localTurnActivity(tab({ pendingTurn }), 2_000)).toBe('dispatching');
  });

  it('reads a dispatched provisional first send as dispatching', () => {
    for (const phase of ['preparing', 'dispatched'] as const) {
      expect(
        localTurnActivity(
          tab({
            provisionalFirstSend: {
              userMessageId: 'user-1',
              submittedAt: 1_000,
              phase,
            },
          }),
          2_000,
        ),
      ).toBe('dispatching');
    }
  });

  it('does not treat a queued or setup-queued provisional echo as dispatching', () => {
    expect(
      localTurnActivity(
        tab({
          provisionalFirstSend: {
            userMessageId: 'user-1',
            submittedAt: 1_000,
            phase: 'queued',
          },
        }),
        2_000,
      ),
    ).toBe('idle');
    expect(
      localTurnActivity(
        tab({
          queuedForSetup: true,
          pendingUserMessages: [
            {
              id: 'user-1',
              role: 'user',
              blocks: [{ type: 'text', text: 'first prompt' }],
              timestamp: 1_000,
            },
          ],
          provisionalFirstSend: {
            userMessageId: 'user-1',
            submittedAt: 1_000,
            phase: 'preparing',
            queuedForSetup: true,
          },
        }),
        2_000,
      ),
    ).toBe('idle');
  });

  it('lets a confirmed failure win over stale Starting… markers', () => {
    expect(
      localTurnActivity(
        tab({
          status: 'error',
          pendingTurn,
          provisionalFirstSend: {
            userMessageId: 'user-1',
            submittedAt: 1_000,
            phase: 'dispatched',
          },
        }),
        2_000,
      ),
    ).toBe('recoverable');
  });

  it('lets expiry win over a stale pending-turn bridge', () => {
    expect(
      localTurnActivity(
        tab({ sendingLease: lease({ state: 'expired' }), pendingTurn }),
        2_000,
      ),
    ).toBe('recoverable');
  });

  it('lets a newer pending lease win over an earlier error', () => {
    expect(
      localTurnActivity(tab({ status: 'error', sendingLease: lease() }), 2_000),
    ).toBe('dispatching');
  });

  it('lets a confirmed current failure end an otherwise unexpired lease', () => {
    expect(
      localTurnActivity(
        tab({
          status: 'error',
          error: 'current failure',
          sendingLease: lease(),
          pendingTurn,
          messages: [
            {
              id: 'error-current',
              role: 'system',
              timestamp: 1_500,
              blocks: [{ type: 'text', text: 'current failure' }],
            },
          ],
        }),
        2_000,
      ),
    ).toBe('recoverable');
  });

  it('keeps a streaming turn streaming over stale expiry and error evidence', () => {
    expect(
      localTurnActivity(
        tab({
          status: 'streaming',
          error: 'earlier dispatch failure',
          sendingLease: lease({ state: 'expired' }),
        }),
        20_000,
      ),
    ).toBe('streaming');
  });

  it('does not read an idle terminal-backed tab as recoverable', () => {
    expect(
      localTurnActivity(tab({ interfaceMode: 'claude-code' }), 2_000),
    ).toBe('idle');
  });

  it('does not count a setup-queued provisional pending turn as in flight', () => {
    expect(
      localTurnActivity(
        tab({
          queuedForSetup: true,
          pendingTurn,
          provisionalFirstSend: {
            userMessageId: 'user-1',
            submittedAt: 1_000,
            phase: 'preparing',
            queuedForSetup: true,
          },
        }),
        2_000,
      ),
    ).toBe('idle');
  });

  it('does not let an older expired lease override a newer pending turn', () => {
    expect(
      localTurnActivity(
        tab({
          sendingLease: lease({ state: 'expired' }),
          pendingTurn: {
            userMessageId: 'user-2',
            timerMessage: {
              ...timerMessage,
              timestamp: 20_000,
            },
          },
        }),
        20_001,
      ),
    ).toBe('dispatching');
  });

  it('does not let a historical failure override a newer acknowledged bridge', () => {
    expect(
      localTurnActivity(
        tab({
          status: 'error',
          error: 'old failure',
          messages: [
            {
              id: 'error-1',
              role: 'system',
              timestamp: 500,
              blocks: [{ type: 'text', text: 'old failure' }],
            },
          ],
          pendingTurn,
          sendingLease: lease({ state: 'acknowledged' }),
        }),
        2_000,
      ),
    ).toBe('dispatching');
  });
});
