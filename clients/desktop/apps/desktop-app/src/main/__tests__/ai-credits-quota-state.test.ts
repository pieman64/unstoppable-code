import {
  clearAllProviderQuotaReached,
  clearProviderQuotaReached,
  clearSessionProxyFailure,
  consumeSessionProxyFailure,
  detectClaudeQuotaReached,
  detectAiCreditsNoBillingSource,
  detectCodexQuotaReached,
  isProviderQuotaReached,
  markProviderQuotaReached,
  recordSessionProxyFailure,
} from '../agents/ai-credits-quota-state';
import {
  AI_CREDITS_CONCURRENCY_GUARD,
  AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG,
} from '@canopy/protocol';

describe('ai-credits-quota-state', () => {
  beforeEach(() => {
    clearAllProviderQuotaReached();
  });

  describe('mark / is / clear', () => {
    it('tracks reached state per provider', () => {
      expect(isProviderQuotaReached('claude')).toBe(false);
      markProviderQuotaReached('claude');
      expect(isProviderQuotaReached('claude')).toBe(true);
      // Independent per provider.
      expect(isProviderQuotaReached('codex')).toBe(false);
    });

    it('clears explicitly', () => {
      markProviderQuotaReached('codex');
      clearProviderQuotaReached('codex');
      expect(isProviderQuotaReached('codex')).toBe(false);
    });

    it('stays reached with no reset time', () => {
      markProviderQuotaReached('claude');
      expect(isProviderQuotaReached('claude')).toBe(true);
    });

    it('auto-expires once the reset time has passed', () => {
      markProviderQuotaReached('codex', Date.now() - 1);
      expect(isProviderQuotaReached('codex')).toBe(false);
    });

    it('stays reached until the reset time arrives', () => {
      markProviderQuotaReached('codex', Date.now() + 60_000);
      expect(isProviderQuotaReached('codex')).toBe(true);
    });
  });

  describe('detectClaudeQuotaReached', () => {
    it('detects the assistant rate_limit error union', () => {
      expect(
        detectClaudeQuotaReached({ type: 'assistant', error: 'rate_limit' }),
      ).toBe(true);
    });

    it('detects a 429 error result', () => {
      expect(
        detectClaudeQuotaReached({
          type: 'result',
          is_error: true,
          api_error_status: 429,
        }),
      ).toBe(true);
    });

    it('does not treat an expired OAuth failure carrying 429 as quota', () => {
      expect(
        detectClaudeQuotaReached({
          type: 'result',
          is_error: true,
          api_error_status: 429,
          result:
            'Failed to authenticate: OAuth session expired and could not be refreshed',
        }),
      ).toBe(false);
    });

    it('ignores non-quota events', () => {
      expect(detectClaudeQuotaReached({ type: 'assistant' })).toBe(false);
      expect(
        detectClaudeQuotaReached({
          type: 'result',
          is_error: true,
          api_error_status: 500,
        }),
      ).toBe(false);
      expect(detectClaudeQuotaReached(null)).toBe(false);
    });

    it('ignores a nested tool result with an HTTP 429 status', () => {
      expect(
        detectClaudeQuotaReached({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_result', tool_use_result: { status: 429 } },
            ],
          },
        }),
      ).toBe(false);
    });

    it('does not treat the llm-proxy concurrency-guard status as a usage limit', () => {
      // A transient "request already in progress" collision (CAN-838) must not
      // trip the on-quota fallback. The proxy reserves 429 for genuine upstream
      // limits and uses the distinct guard status for its own concurrency guard.
      expect(AI_CREDITS_CONCURRENCY_GUARD.httpStatus).not.toBe(429);
      expect(
        detectClaudeQuotaReached({
          type: 'result',
          is_error: true,
          api_error_status: AI_CREDITS_CONCURRENCY_GUARD.httpStatus,
        }),
      ).toBe(false);
    });
  });

  describe('detectCodexQuotaReached', () => {
    it('detects the proactive rate_limit.reached with reset time', () => {
      expect(
        detectCodexQuotaReached({
          type: 'codex',
          event: { type: 'rate_limit.reached', resetsAt: 1_800_000_000_000 },
        }),
      ).toEqual({ reached: true, resetsAt: 1_800_000_000_000 });
    });

    it('detects a usage-limit turn.failed', () => {
      expect(
        detectCodexQuotaReached({
          type: 'codex',
          event: {
            type: 'turn.failed',
            error: { codexErrorInfo: 'usageLimitExceeded', resetsAt: 456 },
          },
        }),
        // Small values are epoch seconds and normalize to ms (CAN-4200).
      ).toEqual({ reached: true, resetsAt: 456_000 });
    });

    it('normalizes a reset time reported in epoch seconds to ms', () => {
      expect(
        detectCodexQuotaReached({
          type: 'codex',
          event: { type: 'rate_limit.reached', resetsAt: 1_800_000_000 },
        }),
      ).toEqual({ reached: true, resetsAt: 1_800_000_000_000 });
    });

    it('treats a non-positive reset time as missing', () => {
      expect(
        detectCodexQuotaReached({
          type: 'codex',
          event: { type: 'rate_limit.reached', resetsAt: 0 },
        }),
      ).toEqual({ reached: true });
    });

    it('detects a usage-limit error event', () => {
      expect(
        detectCodexQuotaReached({
          type: 'codex',
          event: { type: 'error', codexErrorInfo: { usageLimitExceeded: {} } },
        }),
      ).toEqual({ reached: true, resetsAt: undefined });
    });

    it('ignores non-quota codex events and non-codex events', () => {
      expect(
        detectCodexQuotaReached({
          type: 'codex',
          event: { type: 'turn.completed' },
        }),
      ).toEqual({ reached: false });
      expect(detectCodexQuotaReached({ type: 'assistant' })).toEqual({
        reached: false,
      });
      expect(
        detectCodexQuotaReached({
          type: 'codex',
          event: {
            type: 'item.completed',
            item: { toolResult: { statusCode: 429 } },
          },
        }),
      ).toEqual({ reached: false });
    });
  });

  describe('detectAiCreditsNoBillingSource', () => {
    const marked402 =
      'unexpected status 402: {"error":{"canopy_proxy":"CANOPY_AI_CREDITS_PROXY","code":"no_billing_source"}}';

    it('detects the marked code in nested Claude and Codex event strings', () => {
      expect(
        detectAiCreditsNoBillingSource({
          type: 'result',
          is_error: true,
          result: marked402,
        }),
      ).toBe(true);
      expect(
        detectAiCreditsNoBillingSource({
          type: 'codex',
          event: { type: 'turn.failed', error: { message: marked402 } },
        }),
      ).toBe(true);
    });

    // The scan walks the whole event, including the final assistant text, and a
    // SUCCESSFUL turn is also a `result` (`codex-session.ts` emits
    // `is_error: false` for completed turns). Without the `is_error` gate a
    // chat that merely discusses this feature — quoting the marker and the
    // code — would persist the flag and raise the recovery banner on a turn
    // that actually succeeded.
    it('ignores a SUCCESSFUL result that merely quotes the marker', () => {
      expect(
        detectAiCreditsNoBillingSource({
          type: 'result',
          is_error: false,
          result: `Here is the failure body we handle: ${marked402}`,
        }),
      ).toBe(false);
    });

    // What the BUNDLED Codex (0.148.0) actually renders. It parses the hosted
    // JSON body and surfaces only `error.message`, so the marker, the code, and
    // the correlation id never reach Canopy and no amount of string scanning
    // can recover the verdict. Verified against the staged binary by serving
    // the exact body `noBillingSourceResponse()` returns.
    const codexRendered402 =
      'unexpected status 402 Payment Required: AI Credits are unavailable for this request., url: http://127.0.0.1:49877/codex-gateway/280474a8badb19afb75758929f1344aab813952bd1b8965e/responses';

    it('cannot recover the verdict from what Codex actually renders', () => {
      expect(
        detectAiCreditsNoBillingSource({
          type: 'codex',
          event: { type: 'turn.failed', error: { message: codexRendered402 } },
        }),
      ).toBe(false);
    });

    it('honours the main-process stamp when the rendered text carries nothing', () => {
      expect(
        detectAiCreditsNoBillingSource({
          type: 'codex',
          event: {
            type: 'turn.failed',
            error: { message: codexRendered402 },
            [AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG]: true,
          },
        }),
      ).toBe(true);
      expect(
        detectAiCreditsNoBillingSource({
          type: 'result',
          is_error: true,
          result: codexRendered402,
          [AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG]: true,
        }),
      ).toBe(true);
    });

    it('keeps the stamp behind the failure-shape gate', () => {
      // A stamp can only ever be applied to a failure event, but the gate is
      // what guarantees it: without it a successful turn carrying a stray flag
      // would raise the recovery banner on a turn that worked.
      expect(
        detectAiCreditsNoBillingSource({
          type: 'result',
          is_error: false,
          result: 'all good',
          [AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG]: true,
        }),
      ).toBe(false);
    });

    it('ignores a non-boolean value in the stamp field', () => {
      expect(
        detectAiCreditsNoBillingSource({
          type: 'codex',
          event: {
            type: 'turn.failed',
            [AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG]: 'true',
          },
        }),
      ).toBe(false);
    });

    it('ignores bare 402 text and other marked proxy codes', () => {
      expect(
        detectAiCreditsNoBillingSource(
          new Error('unexpected status 402 Payment Required'),
        ),
      ).toBe(false);
      expect(
        detectAiCreditsNoBillingSource({
          message:
            'unexpected status 502: {"error":{"canopy_proxy":"CANOPY_AI_CREDITS_PROXY","code":"upstream_unavailable"}}',
        }),
      ).toBe(false);
    });
  });

  describe('proxy-observed refusal latch', () => {
    const NO_BILLING = {
      code: 'no_billing_source' as const,
      message: 'AI Credits are unavailable for this request.',
      correlationId: 'corr-402',
    };
    const OWNER_REFUSED = {
      code: 'work_owner_not_member' as const,
      message: null,
      correlationId: 'corr-403',
    };

    afterEach(() => {
      clearSessionProxyFailure('project/worktree/chat');
      clearSessionProxyFailure('other/worktree/chat');
    });

    it('hands the recorded refusal to the matching session once', () => {
      recordSessionProxyFailure('project/worktree/chat', NO_BILLING);

      expect(consumeSessionProxyFailure('project/worktree/chat')).toEqual(
        NO_BILLING,
      );
      // Read-and-clear: a verdict describes ONE turn. Leaving it set would let
      // a later, unrelated failure inherit it after the user has topped up.
      expect(
        consumeSessionProxyFailure('project/worktree/chat'),
      ).toBeUndefined();
    });

    it('carries any marked refusal, not only no-billing-source (CAN-3462)', () => {
      recordSessionProxyFailure('project/worktree/chat', OWNER_REFUSED);

      expect(consumeSessionProxyFailure('project/worktree/chat')).toEqual(
        OWNER_REFUSED,
      );
    });

    it('does not leak a verdict across sessions', () => {
      recordSessionProxyFailure('project/worktree/chat', NO_BILLING);

      expect(consumeSessionProxyFailure('other/worktree/chat')).toBeUndefined();
      expect(consumeSessionProxyFailure('project/worktree/chat')).toEqual(
        NO_BILLING,
      );
    });

    it('re-arms when the proxy records a repeat rejection, keeping the latest', () => {
      recordSessionProxyFailure('project/worktree/chat', NO_BILLING);
      expect(consumeSessionProxyFailure('project/worktree/chat')).toEqual(
        NO_BILLING,
      );

      recordSessionProxyFailure('project/worktree/chat', NO_BILLING);
      recordSessionProxyFailure('project/worktree/chat', OWNER_REFUSED);
      expect(consumeSessionProxyFailure('project/worktree/chat')).toEqual(
        OWNER_REFUSED,
      );
    });

    it('drops an unconsumed verdict when the session is torn down', () => {
      recordSessionProxyFailure('project/worktree/chat', NO_BILLING);
      clearSessionProxyFailure('project/worktree/chat');

      expect(
        consumeSessionProxyFailure('project/worktree/chat'),
      ).toBeUndefined();
    });

    it('ignores an empty session key rather than latching one for everyone', () => {
      recordSessionProxyFailure('', NO_BILLING);

      expect(consumeSessionProxyFailure('')).toBeUndefined();
    });
  });
});
