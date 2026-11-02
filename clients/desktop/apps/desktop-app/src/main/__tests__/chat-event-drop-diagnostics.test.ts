import { buildChatSessionKey } from '../agents/session-key';
import {
  chatEventDroppedDiagnostic,
  chatEventTypeForDiagnostic,
  recordChatEventDropped,
} from '../lib/chat-event-drop-diagnostics';

const TARGET = { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' };

describe('chat event drop diagnostics', () => {
  it('records the gate, reason, event type and both turn ids', () => {
    expect(
      chatEventDroppedDiagnostic({
        ...TARGET,
        providerType: 'claude',
        gate: 'router_stamp_mismatch',
        reason: 'event_turn_is_not_route_root',
        data: {
          type: 'result',
          subtype: 'success',
          canopy_turn_user_message_id: 'old-turn',
          result: 'provider text is never recorded',
        },
        turnUserMessageId: 'route-turn',
        nowMs: 0,
      }),
    ).toEqual({
      version: 1,
      timestamp: '1970-01-01T00:00:00.000Z',
      kind: 'chat_event_dropped',
      sessionKey: buildChatSessionKey('project', 'worktree', 'chat'),
      ...TARGET,
      providerType: 'claude',
      chatEventDropGate: 'router_stamp_mismatch',
      chatEventDropReason: 'event_turn_is_not_route_root',
      eventType: 'result/success',
      eventTurnUserMessageId: 'old-turn',
      turnUserMessageId: 'route-turn',
    });
  });

  it('describes Codex envelopes by their native event and bounds fields', () => {
    expect(
      chatEventTypeForDiagnostic({
        type: 'codex_event',
        event: { type: 'turn.completed' },
      }),
    ).toBe('codex_event/turn.completed');
    expect(chatEventTypeForDiagnostic('not an event')).toBeUndefined();
    const record = chatEventDroppedDiagnostic({
      ...TARGET,
      gate: 'codex_root_completion_stale',
      reason: 'x'.repeat(500),
      data: { method: 'turn/completed' },
      providerThreadId: 'thread',
      providerTurnId: 'turn-stale',
    });
    expect(record.chatEventDropReason).toHaveLength(200);
    expect(record).toMatchObject({
      providerType: 'unknown',
      eventType: 'turn/completed',
      providerThreadId: 'thread',
      providerTurnId: 'turn-stale',
    });
  });

  it('never lets a failing sink change delivery', () => {
    const sink = jest.fn(() => {
      throw new Error('storage unavailable');
    });
    expect(() =>
      recordChatEventDropped(
        { ...TARGET, gate: 'router_no_route', reason: 'no_route', data: {} },
        sink,
      ),
    ).not.toThrow();
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ chatEventDropGate: 'router_no_route' }),
    );
  });
});
