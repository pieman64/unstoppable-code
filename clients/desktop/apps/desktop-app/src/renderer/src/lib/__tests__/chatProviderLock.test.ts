import {
  APP_ADVISOR_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  initClaudeModels,
  initModelAliases,
} from '@canopy/desktop-shared/types';
import {
  canContinueOnOtherHarness,
  describeLockedProviderReason,
  getLockedProvider,
  isContinuableHarnessPair,
  type ContinuableTabLike,
} from '../chatProviderLock';

const WORKSPACE_ID = 'workspace-1';

beforeAll(() => {
  initClaudeModels([{ id: 'opus[1m]', label: 'Opus 5 1M' }]);
  initModelAliases({ opus: 'opus[1m]' });
});

function tab(overrides: Partial<ContinuableTabLike> = {}): ContinuableTabLike {
  return {
    messages: { length: 4 },
    queuedMessages: { length: 0 },
    providerType: 'claude',
    status: 'idle',
    ...overrides,
  };
}

describe('isContinuableHarnessPair', () => {
  it('accepts only differing claude/codex pairs', () => {
    expect(isContinuableHarnessPair('claude', 'codex')).toBe(true);
    expect(isContinuableHarnessPair('codex', 'claude')).toBe(true);
    expect(isContinuableHarnessPair('claude', 'claude')).toBe(false);
    expect(isContinuableHarnessPair(undefined, 'codex')).toBe(false);
  });

  it('never treats Ollama as continuable in either direction', () => {
    expect(isContinuableHarnessPair('claude', 'ollama')).toBe(false);
    expect(isContinuableHarnessPair('ollama', 'claude')).toBe(false);
    expect(isContinuableHarnessPair('ollama', 'codex')).toBe(false);
  });
});

describe('describeLockedProviderReason', () => {
  it('names both the running and the requested harness', () => {
    expect(describeLockedProviderReason('claude', 'codex')).toBe(
      'This chat is running on Claude. Start a new chat to use Codex models.',
    );
    expect(describeLockedProviderReason('codex', 'ollama')).toBe(
      'This chat is running on Codex. Start a new chat to use Ollama models.',
    );
  });
});

describe('canContinueOnOtherHarness', () => {
  it('allows an idle Claude chat to continue on Codex and back', () => {
    expect(
      canContinueOnOtherHarness(tab(), 'codex', WORKSPACE_ID),
    ).toStrictEqual({ ok: true });
    expect(
      canContinueOnOtherHarness(
        tab({ providerType: 'codex' }),
        'claude',
        WORKSPACE_ID,
      ),
    ).toStrictEqual({ ok: true });
  });

  it('allows a cowork chat', () => {
    expect(
      canContinueOnOtherHarness(tab(), 'codex', STANDALONE_CHAT_PROJECT_ID),
    ).toStrictEqual({ ok: true });
  });

  it('derives the source harness from the model when providerType is absent', () => {
    const restored = tab({ providerType: undefined, model: 'opus' });
    expect(getLockedProvider(restored)).toBe('claude');
    expect(
      canContinueOnOtherHarness(restored, 'codex', WORKSPACE_ID),
    ).toStrictEqual({ ok: true });
  });

  it('refuses a chat with no conversation state yet', () => {
    const result = canContinueOnOtherHarness(
      tab({ messages: { length: 0 }, queuedMessages: { length: 0 } }),
      'codex',
      WORKSPACE_ID,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('not-continuable');
  });

  it('refuses a same-harness target', () => {
    const result = canContinueOnOtherHarness(tab(), 'claude', WORKSPACE_ID);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('not-continuable');
  });

  it('refuses Ollama in both directions', () => {
    expect(canContinueOnOtherHarness(tab(), 'ollama', WORKSPACE_ID).ok).toBe(
      false,
    );
    expect(
      canContinueOnOtherHarness(
        tab({ providerType: 'ollama' }),
        'codex',
        WORKSPACE_ID,
      ).ok,
    ).toBe(false);
  });

  it('refuses App Advisor for v1', () => {
    const result = canContinueOnOtherHarness(
      tab(),
      'codex',
      APP_ADVISOR_PROJECT_ID,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('not-continuable');
  });

  it('refuses Claude Code terminal mode', () => {
    for (const interfaceMode of ['claude-code', 'auto'] as const) {
      const result = canContinueOnOtherHarness(
        tab({ interfaceMode }),
        'codex',
        WORKSPACE_ID,
      );
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.code).toBe('not-continuable');
    }
  });

  it('refuses file tabs', () => {
    expect(
      canContinueOnOtherHarness(tab({ kind: 'file' }), 'codex', WORKSPACE_ID)
        .ok,
    ).toBe(false);
  });

  it('refuses a read-only chat', () => {
    const result = canContinueOnOtherHarness(
      tab({ readOnly: true }),
      'codex',
      WORKSPACE_ID,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('read-only');
  });

  it('refuses a streaming chat with the busy reason', () => {
    const result = canContinueOnOtherHarness(
      tab({ status: 'streaming' }),
      'codex',
      WORKSPACE_ID,
    );
    expect(result).toStrictEqual({
      ok: false,
      code: 'busy',
      reason:
        'This chat is still working. Stop or finish the current turn, then switch.',
    });
  });

  it('refuses a chat with queued messages', () => {
    const result = canContinueOnOtherHarness(
      tab({ queuedMessages: { length: 2 } }),
      'codex',
      WORKSPACE_ID,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('queued');
  });

  it('refuses a chat with a pending plan approval', () => {
    const result = canContinueOnOtherHarness(
      tab({ pendingPlanExit: { plan: 'do the thing' } }),
      'codex',
      WORKSPACE_ID,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('pending-plan');
  });

  it('refuses a chat parked on an unanswered ask-user question', () => {
    // The tab reads `'idle'` here on purpose: `handleMcpAskUser` drops it out of
    // `'streaming'` and pauses the turn timer while the provider waits on the
    // user. So an unfinished turn is invisible to a status check, and the
    // question itself lives outside the messages the summarizer sees.
    const result = canContinueOnOtherHarness(
      tab({ status: 'idle', hasUnansweredQuestion: true }),
      'codex',
      WORKSPACE_ID,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('busy');
    expect(result.ok === false && result.reason).toContain(
      'waiting on your answer',
    );
  });

  it('allows a chat whose question has been answered', () => {
    expect(
      canContinueOnOtherHarness(
        tab({ status: 'idle', hasUnansweredQuestion: false }),
        'codex',
        WORKSPACE_ID,
      ),
    ).toStrictEqual({ ok: true });
  });

  it('allows plain plan mode with no pending exit', () => {
    expect(
      canContinueOnOtherHarness(
        tab({ pendingPlanExit: undefined }),
        'codex',
        WORKSPACE_ID,
      ),
    ).toStrictEqual({ ok: true });
  });
});
