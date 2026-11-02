import { completeTurnTimer } from '../event-transforms';
import { reconcilePendingTurn } from '../optimistic-presentation';
import { createEmptyTab } from '../tab-utils';
import { appendConsumedClaudeTerminalInitialPrompt } from '../terminal-runtime';
import type { ChatMessage, QueuedChatMessage } from '../types';

function timer(turnId?: string): ChatMessage {
  return {
    id: turnId ? `${turnId}:timer` : 'local-timer',
    role: 'system',
    timestamp: 1_000,
    blocks: [
      {
        type: 'turn_timer',
        ...(turnId ? { turnId } : {}),
        startedAt: 1_000,
        completedAt: null,
      },
    ],
  };
}

describe('renderer canonical timer guards', () => {
  it('never closes an acknowledged canonical timer locally', () => {
    const messages = [timer('T')];
    expect(completeTurnTimer(messages, 2_000)).toBe(messages);
  });

  it('still closes a legacy local timer', () => {
    expect(completeTurnTimer([timer()], 2_000)[0]?.blocks[0]).toMatchObject({
      completedAt: 2_000,
    });
  });

  it('retires the optimistic send timer once the canonical timer commits', () => {
    const user: ChatMessage = {
      id: 'A',
      role: 'user',
      timestamp: 1_000,
      blocks: [{ type: 'text', text: 'hi' }],
    };
    const local = timer();
    expect(
      reconcilePendingTurn({
        messages: [user, local, timer('T')],
        pendingTurn: { userMessageId: 'A', timerMessage: local },
      }),
    ).toEqual({ messages: [user, timer('T')], pendingTurn: undefined });
  });

  it('gives a terminal prompt only a legacy timer and leaves runtime alone', () => {
    const queued: QueuedChatMessage = { text: 'Run it' };
    const tab = { ...createEmptyTab(), queuedMessages: [queued] };
    const next = appendConsumedClaudeTerminalInitialPrompt(tab, queued, 1_000, {
      userMessageId: 'A',
      turnTimerMessageId: 'terminal-timer',
    });

    expect(
      next.messages.find((message) => message.id === 'terminal-timer')?.blocks,
    ).toEqual([{ type: 'turn_timer', startedAt: 1_000, completedAt: null }]);
    expect({
      ...next,
      messages: tab.messages,
      queuedMessages: tab.queuedMessages,
    }).toEqual(tab);
  });
});
