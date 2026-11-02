import type { ChatTurnEffect } from '@canopy/agent-transcript/turn';
import type { PersistedChatMessage } from '../../types';
import { projectPersistedChatTranscript } from '../persisted-chat-projection';
import { projectCanonicalPortalTurnTimers } from '../runtime-chat-projection';

const user: PersistedChatMessage = {
  id: 'A',
  role: 'user',
  timestamp: 1_000,
  blocks: [{ type: 'text', text: 'Resume twice' }],
};

function timer(
  turnId: string | undefined,
  completedAt: number | null,
  id = turnId ? `${turnId}:timer` : 'legacy-timer',
): PersistedChatMessage {
  return {
    id,
    role: 'system',
    timestamp: 1_000,
    blocks: [
      {
        type: 'turn_timer',
        ...(turnId ? { turnId } : {}),
        startedAt: 1_000,
        completedAt,
      },
    ],
  };
}

const reply: PersistedChatMessage = {
  id: 'reply',
  role: 'assistant',
  timestamp: 2_000,
  blocks: [{ type: 'text', text: 'Done' }],
};

describe('canonical portal turn timers', () => {
  it('stamps the Auto-routed model on a live timer row (turn-state phase 43f)', () => {
    const base = timer('T1', 2_000);
    const anchoredTimer: PersistedChatMessage = {
      ...base,
      blocks: base.blocks.map((block) =>
        block.type === 'turn_timer' ? { ...block, userMessageId: 'A' } : block,
      ),
    };
    const close: ChatTurnEffect = {
      type: 'timer.close',
      timerId: 'T1:timer',
      turnId: 'T1',
      atMs: 2_000,
    };
    const [routed] = projectCanonicalPortalTurnTimers({
      scope: 'worktree',
      chatId: 'chat',
      effects: [close],
      timerMessages: [anchoredTimer],
      autoRoutedModels: { A: 'claude-sonnet-4-5' },
    });
    expect(
      routed?.parts?.find((part) => part.kind === 'turn_timer')?.data,
    ).toMatchObject({ autoRoutedModel: 'claude-sonnet-4-5' });

    // A turn Auto didn't route carries no chip.
    const [unrouted] = projectCanonicalPortalTurnTimers({
      scope: 'worktree',
      chatId: 'chat',
      effects: [close],
      timerMessages: [anchoredTimer],
      autoRoutedModels: { other: 'claude-sonnet-4-5' },
    });
    expect(
      unrouted?.parts?.find((part) => part.kind === 'turn_timer')?.data,
    ).not.toHaveProperty('autoRoutedModel');
  });

  it('projects two executions that share an anchor as two timer rows', () => {
    const projected = projectPersistedChatTranscript({
      scope: 'worktree',
      chatId: 'chat',
      messages: [user, timer('T1', 2_000), reply, timer('T2', 3_000)],
    });
    const timerIds = projected
      .filter((message) =>
        message.parts?.some((part) => part.kind === 'turn_timer'),
      )
      .map((message) => message.messageId);
    expect(timerIds).toEqual(['T1:timer', 'T2:timer']);
  });

  it('still converges a legacy untagged timer onto the live anchor id', () => {
    const projected = projectPersistedChatTranscript({
      scope: 'worktree',
      chatId: 'chat',
      messages: [user, timer(undefined, 2_000)],
    });
    expect(projected.map((message) => message.messageId)).toContain(
      'A:turn-timer',
    );
  });

  it('projects each committed canonical timer once, keyed by its persisted id', () => {
    const effects: ChatTurnEffect[] = [
      { type: 'timer.open', timerId: 'T:timer', turnId: 'T', atMs: 1_000 },
      { type: 'timer.close', timerId: 'T:timer', turnId: 'T', atMs: 2_000 },
      { type: 'turn.ended', turnId: 'T', outcome: 'failed' },
    ];
    const rows = projectCanonicalPortalTurnTimers({
      scope: 'worktree',
      chatId: 'chat',
      effects,
      timerMessages: [timer('T', 2_000)],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      messageId: 'T:timer',
      status: 'complete',
      parts: [
        {
          kind: 'turn_timer',
          data: { completedAt: 2_000, endReason: 'failed' },
        },
      ],
    });
  });

  it('projects an open canonical timer as streaming', () => {
    const rows = projectCanonicalPortalTurnTimers({
      scope: 'worktree',
      chatId: 'chat',
      effects: [
        { type: 'timer.open', timerId: 'T:timer', turnId: 'T', atMs: 1_000 },
      ],
      timerMessages: [timer('T', null)],
    });
    expect(rows).toMatchObject([{ messageId: 'T:timer', status: 'streaming' }]);
  });

  it('projects a timer row that a binding-only commit rewrote', () => {
    const base = timer('W', null);
    const woken: PersistedChatMessage = {
      ...base,
      blocks: base.blocks.map((block) =>
        block.type === 'turn_timer'
          ? {
              ...block,
              spawnedBy: { toolUseId: 'monitor-call', event: true },
            }
          : block,
      ),
    };
    const rows = projectCanonicalPortalTurnTimers({
      scope: 'worktree',
      chatId: 'chat',
      effects: [],
      timerMessages: [woken, timer('OTHER', null, 'X:timer')],
    });
    // The wake's new cause reaches the Portal; a row whose id names another
    // turn is still not fabricated.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      messageId: 'W:timer',
      status: 'streaming',
    });
  });

  it('fabricates nothing for a missing or mismatched canonical timer row', () => {
    const effects: ChatTurnEffect[] = [
      { type: 'timer.open', timerId: 'T:timer', turnId: 'T', atMs: 1_000 },
    ];
    expect(
      projectCanonicalPortalTurnTimers({
        scope: 'worktree',
        chatId: 'chat',
        effects,
        timerMessages: [],
      }),
    ).toEqual([]);
    expect(
      projectCanonicalPortalTurnTimers({
        scope: 'worktree',
        chatId: 'chat',
        effects,
        timerMessages: [timer('OTHER', null, 'T:timer')],
      }),
    ).toEqual([]);
  });
});
