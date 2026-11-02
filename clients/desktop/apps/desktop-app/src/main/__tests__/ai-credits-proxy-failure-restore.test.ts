import { classifyChatTurnFailure } from '../observability/chat-turn-failure';
import { withProxyFailureRestored } from '../agents/ai-credits-proxy-failure-restore';
import {
  applyClaudeTranscriptEvent,
  createEmptyTranscriptReducerState,
  isNoBillingSourceFailureEvent,
  claudeResultErrorMessage,
} from '@canopy/agent-transcript';
import { classifyAgentFailure } from '@canopy/desktop-shared/agent-failures';
import {
  AI_CREDITS_NO_BILLING_SOURCE_MESSAGE as message,
  parseCanopyProxyError,
  type CanopyProxyError,
} from '@canopy/protocol';

const refusal: CanopyProxyError = {
  code: 'no_billing_source',
  message,
  correlationId: null,
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Expected record');
  return value;
}

describe('withProxyFailureRestored', () => {
  it('preserves Codex projection, correlation id, metadata and input', () => {
    const event = {
      type: 'codex',
      trace: 'outer',
      event: {
        type: 'turn.failed',
        result: 'untouched',
        error: { message: 'raw', code: 'other' },
        metadata: { kept: true },
      },
    };
    const original = structuredClone(event);
    const normalized = withProxyFailureRestored(event, {
      ...refusal,
      correlationId: 'host-id',
    });
    expect(normalized).toMatchObject({
      trace: 'outer',
      event: {
        result: 'untouched',
        error: { code: 'other' },
        metadata: { kept: true },
        canopy_ai_credits_no_billing_source: true,
      },
    });
    const inner = record(record(normalized).event);
    expect(parseCanopyProxyError(String(record(inner.error).message))).toEqual({
      ...refusal,
      correlationId: 'host-id',
    });
    expect(
      withProxyFailureRestored(normalized, {
        ...refusal,
        correlationId: 'host-id',
      }),
    ).toEqual(normalized);
    expect(event).toEqual(original);
  });

  it.each<NonNullable<CanopyProxyError['reason']>>([
    'personal_wallet_empty',
    'organization_pool_unavailable',
  ])(
    'preserves restored Codex billing reason %s through classification',
    (reason) => {
      const restored = withProxyFailureRestored(
        {
          type: 'codex',
          event: {
            type: 'turn.failed',
            error: { message: 'unexpected status 402' },
          },
        },
        { ...refusal, reason },
      );

      expect(
        classifyChatTurnFailure({
          provider: 'codex',
          terminalEvent: record(restored),
        }),
      ).toEqual({
        category: 'no_credits',
        detail: reason,
      });
    },
  );

  it.each(['raw result', '', undefined])(
    'restores Claude result precedence (%s) and removes raw errors fallback',
    (result) => {
      const event = {
        type: 'result',
        is_error: true,
        result,
        error: { message: 'raw', kept: true },
        errors: ['raw fallback'],
        usage: { input_tokens: 4 },
      };
      const original = structuredClone(event);
      const normalized = record(
        withProxyFailureRestored(event, refusal, 'claude'),
      );
      expect(normalized).toMatchObject({
        usage: event.usage,
        error: { kept: true },
        canopy_ai_credits_no_billing_source: true,
      });
      expect(
        parseCanopyProxyError(claudeResultErrorMessage(normalized)),
      ).toEqual(refusal);
      expect(JSON.stringify(normalized)).not.toContain('raw');
      expect(withProxyFailureRestored(normalized, refusal, 'claude')).toEqual(
        normalized,
      );
      expect(event).toEqual(original);
      const persisted = record(JSON.parse(JSON.stringify(normalized)));
      const state = applyClaudeTranscriptEvent(
        createEmptyTranscriptReducerState(),
        persisted,
        {
          now: 1,
          createMessageId: () => 'restored-message',
          childToolLiveness: { kind: 'unknown' },
        },
      );
      expect(state.aiCreditsNoBillingSource).toMatchObject({
        provider: 'claude',
      });
      const stateError = state.error;
      if (stateError === null) throw new Error('Expected restored error');
      expect(parseCanopyProxyError(stateError)).toEqual(refusal);
      expect(
        classifyAgentFailure({
          provider: 'claude',
          accountScope: 'ai_credits',
          error: persisted,
        }),
      ).toMatchObject({
        kind: 'provider_usage_limit',
        code: 'credits_depleted',
      });
    },
  );

  it('restores structured assistant/error message content without losing fields', () => {
    const event = {
      type: 'assistant',
      error: 'billing_error',
      message: {
        id: 'msg',
        content: [{ type: 'text', text: 'raw', extra: true }],
      },
    };
    const normalized = record(
      withProxyFailureRestored(event, refusal, 'claude'),
    );
    expect(normalized).toMatchObject({
      error: 'billing_error',
      message: { id: 'msg', content: [{ extra: true }] },
    });
    expect(JSON.stringify(normalized)).not.toContain('raw');
    expect(isNoBillingSourceFailureEvent(normalized, 'claude')).toBe(true);
  });

  it.each([
    {
      type: 'error',
      error: { message: 'raw', kept: true },
      message: { content: [] },
    },
    { type: 'assistant', error: 'billing_error', message: 'raw' },
  ])(
    'projects supported error text into a renderable message when content is absent: %j',
    (event) => {
      const normalized = record(
        withProxyFailureRestored(event, refusal, 'claude'),
      );
      const state = applyClaudeTranscriptEvent(
        createEmptyTranscriptReducerState(),
        normalized,
        {
          now: 1,
          createMessageId: () => 'restored-message',
          childToolLiveness: { kind: 'unknown' },
        },
      );
      expect(state.messages).toHaveLength(1);
      const block = state.messages[0]?.blocks[0];
      expect(
        block?.type === 'text' ? parseCanopyProxyError(block.text) : null,
      ).toEqual(refusal);
      if (typeof event.error === 'object')
        expect(normalized.error).toMatchObject({ kept: true });
      expect(withProxyFailureRestored(normalized, refusal, 'claude')).toEqual(
        normalized,
      );
    },
  );

  it('does not turn empty assistant text blocks into duplicate notices', () => {
    const event = {
      type: 'assistant',
      error: 'billing_error',
      message: {
        content: [
          { type: 'text', text: '' },
          { type: 'text', text: 'raw' },
        ],
      },
    };
    const normalized = record(
      withProxyFailureRestored(event, refusal, 'claude'),
    );
    expect(
      String(JSON.stringify(normalized)).match(/CANOPY_AI_CREDITS_PROXY/g),
    ).toHaveLength(1);
  });

  it('leaves raw 402 text insufficient for classification and shared detection', () => {
    const event = {
      type: 'result',
      is_error: true,
      api_error_status: 402,
      result: `API Error: 402 ${message}`,
    };
    expect(isNoBillingSourceFailureEvent(event, 'claude')).toBe(false);
    expect(
      classifyAgentFailure({
        provider: 'claude',
        accountScope: 'ai_credits',
        error: event,
      }),
    ).toBeNull();
  });
});
