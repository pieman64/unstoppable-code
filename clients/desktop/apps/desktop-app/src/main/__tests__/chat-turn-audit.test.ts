import {
  getChatTurnAuditStatus,
  isAgentContinuationEvent,
  isCodexSubagentFollowupEvent,
  isCodexSubagentTerminalEvent,
  isRootTerminalChatEventData,
  isTerminalChatEventData,
  readCodexRootThreadId,
  readCodexRootTurnId,
} from '../lib/chat-turn-audit';

describe('getChatTurnAuditStatus', () => {
  it('classifies a user-aborted streaming result as interrupted, not failure', () => {
    // Regression: the Claude SDK can gracefully yield a result with is_error:true
    // and terminal_reason 'aborted_streaming' when the user hits Stop mid-stream.
    const status = getChatTurnAuditStatus({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'aborted_streaming',
    });
    expect(status).toBe('interrupted');
  });

  it('classifies an aborted_tools terminal reason as interrupted', () => {
    const status = getChatTurnAuditStatus({
      type: 'result',
      is_error: true,
      terminal_reason: 'aborted_tools',
    });
    expect(status).toBe('interrupted');
  });

  it('classifies a plan handed to review as success', () => {
    expect(
      getChatTurnAuditStatus({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        terminal_reason: 'aborted_tools',
        canopy_plan_handoff: true,
      }),
    ).toBe('success');
  });

  it('classifies a genuine error (is_error, no abort terminal reason) as failure', () => {
    expect(getChatTurnAuditStatus({ type: 'result', is_error: true })).toBe(
      'failure',
    );
    expect(
      getChatTurnAuditStatus({
        type: 'result',
        is_error: true,
        terminal_reason: 'model_error',
      }),
    ).toBe('failure');
  });

  it('classifies an error event as failure', () => {
    expect(getChatTurnAuditStatus({ type: 'error', error: 'boom' })).toBe(
      'failure',
    );
  });

  it('classifies the "turn cancelled" result as cancelled', () => {
    expect(
      getChatTurnAuditStatus({ type: 'result', result: 'Turn cancelled' }),
    ).toBe('cancelled');
  });

  it('classifies aborted/ended sessions as interrupted', () => {
    expect(
      getChatTurnAuditStatus({ type: 'result', result: 'Session aborted' }),
    ).toBe('interrupted');
    expect(
      getChatTurnAuditStatus({ type: 'result', result: 'Session ended' }),
    ).toBe('interrupted');
  });

  it('classifies a normal completed turn as success', () => {
    expect(
      getChatTurnAuditStatus({
        type: 'result',
        subtype: 'success',
        is_error: false,
        terminal_reason: 'completed',
        result: 'done',
      }),
    ).toBe('success');
    expect(getChatTurnAuditStatus({ type: 'result' })).toBe('success');
  });
});

describe('Codex root turn classification', () => {
  const rootTerminal = {
    type: 'codex',
    event: { type: 'turn.completed', thread_id: 'thread-root' },
  };
  const childTerminal = {
    type: 'codex',
    event: { type: 'turn.completed', thread_id: 'thread-child' },
  };

  it.each(['error', 'turn.failed'])(
    'settles a root Codex %s as failure',
    (type) => {
      const event = {
        type: 'codex',
        event: {
          type,
          thread_id: 'thread-root',
          turn_id: 'turn-root',
          message: 'Usage limit exceeded.',
          codexErrorInfo: 'usageLimitExceeded',
        },
      };
      expect(isRootTerminalChatEventData(event, 'thread-root')).toBe(true);
      expect(getChatTurnAuditStatus(event)).toBe('failure');
      expect(
        isRootTerminalChatEventData(
          {
            ...event,
            event: {
              ...event.event,
              thread_id: 'thread-child',
            },
          },
          'thread-root',
        ),
      ).toBe(false);
    },
  );

  it('reads the root thread from the Codex initialization event', () => {
    expect(
      readCodexRootThreadId({
        type: 'system',
        subtype: 'init',
        session_id: 'thread-root',
      }),
    ).toBe('thread-root');
  });

  it('rejects a same-root error from an earlier provider turn', () => {
    const started = {
      type: 'codex',
      event: {
        type: 'turn.started',
        thread_id: 'thread-root',
        turn_id: 'turn-current',
      },
    };
    const rootTurnId = readCodexRootTurnId(started, 'thread-root');
    expect(rootTurnId).toBe('turn-current');
    expect(
      isRootTerminalChatEventData(
        {
          type: 'codex',
          event: {
            type: 'error',
            thread_id: 'thread-root',
            turn_id: 'turn-stale',
          },
        },
        'thread-root',
        rootTurnId,
      ),
    ).toBe(false);
    expect(
      isRootTerminalChatEventData(
        {
          type: 'codex',
          event: {
            type: 'error',
            thread_id: 'thread-root',
            turn_id: 'turn-current',
          },
        },
        'thread-root',
        rootTurnId,
      ),
    ).toBe(true);
  });

  it('distinguishes child completion from root completion', () => {
    expect(isCodexSubagentTerminalEvent(childTerminal, 'thread-root')).toBe(
      true,
    );
    expect(isRootTerminalChatEventData(childTerminal, 'thread-root')).toBe(
      false,
    );
    expect(isRootTerminalChatEventData(rootTerminal, 'thread-root')).toBe(true);
  });

  it('classifies routed Codex errors by their thread', () => {
    const childError = {
      type: 'codex',
      event: {
        type: 'error',
        thread_id: 'thread-child',
        message: 'Child failed',
      },
    };
    expect(isCodexSubagentTerminalEvent(childError, 'thread-root')).toBe(true);
    expect(isRootTerminalChatEventData(childError, 'thread-root')).toBe(false);
    expect(isTerminalChatEventData(childError)).toBe(false);
  });

  it.each(['turn.failed', 'error'])(
    'admits routed child %s events as settled-turn follow-ups',
    (type) => {
      expect(
        isCodexSubagentFollowupEvent(
          {
            type: 'codex',
            event: {
              type,
              thread_id: 'thread-child',
              message: 'Child failed',
              error: { message: 'Child failed' },
            },
          },
          'thread-root',
        ),
      ).toBe(true);
    },
  );

  it.each(['item.started', 'item.updated', 'item.completed'])(
    'admits routed child %s output as a settled-turn follow-up',
    (type) => {
      expect(
        isCodexSubagentFollowupEvent(
          {
            type: 'codex',
            event: {
              type,
              thread_id: 'thread-child',
              item: { id: 'child-message', type: 'agent_message' },
            },
          },
          'thread-root',
        ),
      ).toBe(true);
      expect(
        isCodexSubagentFollowupEvent(
          {
            type: 'codex',
            event: {
              type,
              thread_id: 'thread-root',
              item: { id: 'root-message', type: 'agent_message' },
            },
          },
          'thread-root',
        ),
      ).toBe(false);
    },
  );

  it('recognizes provider output that can continue a settled turn', () => {
    expect(isAgentContinuationEvent({ type: 'assistant' })).toBe(true);
    expect(
      isAgentContinuationEvent({
        type: 'codex',
        event: { type: 'item.completed' },
      }),
    ).toBe(true);
    expect(isAgentContinuationEvent(rootTerminal)).toBe(false);
  });
});
