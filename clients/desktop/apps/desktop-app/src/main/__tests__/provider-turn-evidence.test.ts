import {
  beginCodexSessionTurn,
  finishCodexSessionTurn,
  getCodexTurnEvidence,
  observeCodexTurnTerminal,
  recordCodexTurnEnd,
} from '../agents/provider-turn-evidence';

describe('Codex provider turn evidence', () => {
  it('holds through terminal recording and retains the end after handoff', () => {
    const key = 'provider-turn-evidence/retain';
    const terminal = {
      turnUserMessageId: 'message-1',
      outcome: 'completed' as const,
      endedAtMs: 42,
    };

    beginCodexSessionTurn(key, terminal.turnUserMessageId);
    recordCodexTurnEnd(key, terminal);

    expect(getCodexTurnEvidence(key)).toEqual({
      holdsTurn: true,
      terminal,
    });

    finishCodexSessionTurn(key, terminal.turnUserMessageId);

    expect(getCodexTurnEvidence(key)).toEqual({
      holdsTurn: false,
      terminal,
    });
  });

  it('keeps a completed raw terminal when later handoff failure is reported', () => {
    const key = 'provider-turn-evidence/completed-wins';
    beginCodexSessionTurn(key, 'message-2');
    recordCodexTurnEnd(key, {
      turnUserMessageId: 'message-2',
      outcome: 'completed',
      endedAtMs: 50,
    });

    recordCodexTurnEnd(key, {
      turnUserMessageId: 'message-2',
      outcome: 'failed',
      endedAtMs: 51,
    });

    expect(getCodexTurnEvidence(key)).toEqual({
      holdsTurn: true,
      terminal: {
        turnUserMessageId: 'message-2',
        outcome: 'completed',
        endedAtMs: 50,
      },
    });
  });

  it('clears only the matching observed end without stealing a fresh turn', () => {
    const key = 'provider-turn-evidence/fresh-turn';
    beginCodexSessionTurn(key, 'message-3');
    recordCodexTurnEnd(key, {
      turnUserMessageId: 'message-3',
      outcome: 'completed',
      endedAtMs: 60,
    });
    finishCodexSessionTurn(key, 'message-3');

    beginCodexSessionTurn(key, 'message-4');
    observeCodexTurnTerminal(key, 'message-3');
    expect(getCodexTurnEvidence(key)).toEqual({ holdsTurn: true });

    recordCodexTurnEnd(key, {
      turnUserMessageId: 'message-4',
      outcome: 'interrupted',
      endedAtMs: 61,
    });
    observeCodexTurnTerminal(key, 'message-3');
    expect(getCodexTurnEvidence(key)).toEqual({
      holdsTurn: true,
      terminal: {
        turnUserMessageId: 'message-4',
        outcome: 'interrupted',
        endedAtMs: 61,
      },
    });

    observeCodexTurnTerminal(key, 'message-4');
    expect(getCodexTurnEvidence(key)).toEqual({ holdsTurn: true });
    recordCodexTurnEnd(key, {
      turnUserMessageId: 'message-4',
      outcome: 'completed',
      endedAtMs: 62,
    });
    expect(getCodexTurnEvidence(key)).toEqual({ holdsTurn: true });
    finishCodexSessionTurn(key, 'message-4');
    expect(getCodexTurnEvidence(key)).toEqual({ holdsTurn: false });
    recordCodexTurnEnd(key, {
      turnUserMessageId: 'message-4',
      outcome: 'failed',
      endedAtMs: 63,
    });
    expect(getCodexTurnEvidence(key)).toEqual({ holdsTurn: false });
  });
});
