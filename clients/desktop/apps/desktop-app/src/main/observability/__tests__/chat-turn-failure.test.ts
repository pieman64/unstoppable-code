import { AI_CREDITS_PROXY_ERROR_MARKER } from '@canopy/protocol';
import { BRAND } from '@canopy/brand/current';
import {
  buildAiCreditsRequiredError,
  NO_BILLING_SOURCE_ERROR_CODE,
} from '@canopy/desktop-shared/types';
import {
  CHAT_TURN_FAILURE_CATEGORIES,
  CHAT_TURN_FAILURE_DETAILS,
  ChatTurnFailureEvidence,
  classifyChatTurnFailure,
  isChatTurnFailureEvidence,
  type ChatTurnFailure,
} from '../chat-turn-failure';

function proxyBody(fields: Record<string, string>): string {
  return `unexpected status 402: ${JSON.stringify({
    error: { canopy_proxy: AI_CREDITS_PROXY_ERROR_MARKER, ...fields },
  })}`;
}

describe('classifyChatTurnFailure', () => {
  it.each<{
    name: string;
    provider: 'claude' | 'codex';
    evidence?: unknown[];
    error?: string;
    expected: ChatTurnFailure;
  }>([
    {
      name: 'an empty personal wallet behind the credits proxy',
      provider: 'codex',
      error: proxyBody({
        code: 'no_billing_source',
        reason: 'personal_wallet_empty',
      }),
      expected: { category: 'no_credits', detail: 'personal_wallet_empty' },
    },
    {
      name: 'an unavailable organization pool in a buffered event',
      provider: 'claude',
      evidence: [
        {
          type: 'result',
          is_error: true,
          result: proxyBody({
            code: 'no_billing_source',
            reason: 'organization_pool_unavailable',
          }),
        },
      ],
      expected: {
        category: 'no_credits',
        detail: 'organization_pool_unavailable',
      },
    },
    {
      name: 'a used-up credits session budget',
      provider: 'claude',
      error: proxyBody({ code: 'session_budget_exhausted' }),
      expected: { category: 'credits_budget_exhausted' },
    },
    {
      name: 'a model locked out of the library',
      provider: 'codex',
      error: proxyBody({ code: 'model_locked' }),
      expected: { category: 'model_locked', detail: 'library_locked' },
    },
    {
      name: 'a model guests may not use',
      provider: 'claude',
      error: proxyBody({ code: 'guest_model_not_allowed' }),
      expected: { category: 'model_locked', detail: 'guest_not_allowed' },
    },
    {
      name: 'a model blocked by organization policy',
      provider: 'claude',
      evidence: [
        {
          type: 'error',
          error: 'This model is blocked by your organization policy.',
          error_code: 'model_policy_blocked',
        },
      ],
      expected: { category: 'model_locked', detail: 'organization_policy' },
    },
    {
      name: 'no provider sign-in and no credits',
      provider: 'codex',
      evidence: [
        {
          type: 'error',
          error_code: NO_BILLING_SOURCE_ERROR_CODE,
          error: 'Not signed in and no credits',
        },
      ],
      expected: { category: 'no_credits', detail: 'no_sign_in_or_credits' },
    },
    {
      name: 'a credits-only model without credits',
      provider: 'claude',
      error: buildAiCreditsRequiredError(BRAND.displayName),
      expected: { category: 'no_credits', detail: 'credits_only_model' },
    },
    {
      name: 'a credits-only model abort that also carries the no-billing code',
      provider: 'codex',
      evidence: [
        {
          type: 'error',
          canopy_ai_credits_no_billing_source: true,
          error_code: NO_BILLING_SOURCE_ERROR_CODE,
          error: buildAiCreditsRequiredError(BRAND.displayName),
        },
      ],
      expected: { category: 'no_credits', detail: 'credits_only_model' },
    },
    {
      name: 'a runtime no-billing-source signal without a reason',
      provider: 'claude',
      evidence: [
        { type: 'canopy_ai_credits_no_billing_source', provider: 'claude' },
      ],
      expected: { category: 'no_credits' },
    },
    {
      name: 'a native usage limit signal',
      provider: 'codex',
      evidence: [{ type: 'canopy_usage_limit_reached', provider: 'codex' }],
      expected: { category: 'provider_quota' },
    },
    {
      name: 'a Claude rate limit',
      provider: 'claude',
      evidence: [{ type: 'assistant', error: 'rate_limit' }],
      expected: { category: 'provider_quota' },
    },
    {
      name: 'a Claude authentication failure',
      provider: 'claude',
      evidence: [{ type: 'assistant', error: 'authentication_failed' }],
      expected: { category: 'provider_auth' },
    },
    {
      name: 'a structured provider auth failure',
      provider: 'codex',
      evidence: [
        {
          type: 'canopy_auth_failure',
          failure: {
            dependencyClass: 'provider',
            dependencyId: 'codex',
            displayName: 'Codex',
            failureClass: 'expired',
            recovery: { kind: 'provider_terminal', provider: 'codex' },
          },
        },
      ],
      expected: { category: 'provider_auth' },
    },
    {
      name: 'credits proxy credentials that are unavailable',
      provider: 'claude',
      error: proxyBody({ code: 'credentials_unavailable' }),
      expected: { category: 'provider_auth' },
    },
    {
      name: 'an organization the user has left',
      provider: 'codex',
      error: proxyBody({ code: 'work_owner_not_member' }),
      expected: { category: 'organization_access' },
    },
    {
      name: 'an unavailable upstream behind the credits proxy',
      provider: 'codex',
      error: proxyBody({ code: 'upstream_unavailable' }),
      expected: { category: 'upstream_unavailable' },
    },
    {
      name: 'an overloaded Codex server',
      provider: 'codex',
      evidence: [
        {
          type: 'codex',
          event: {
            type: 'turn.failed',
            error: { message: 'busy', codexErrorInfo: 'serverOverloaded' },
          },
        },
      ],
      expected: { category: 'upstream_unavailable' },
    },
    {
      name: 'a dropped connection',
      provider: 'claude',
      evidence: [
        { type: 'error', error: 'socket hang up', code: 'ECONNRESET' },
      ],
      expected: { category: 'network' },
    },
    {
      name: 'an unreachable local model server',
      provider: 'claude',
      evidence: [
        {
          type: 'error',
          error: 'Ollama is not running',
          error_code: 'ollama_server_unavailable',
        },
      ],
      expected: { category: 'upstream_unavailable' },
    },
  ])('classifies $name', ({ provider, evidence, error, expected }) => {
    expect(classifyChatTurnFailure({ provider, evidence, error })).toEqual(
      expected,
    );
  });

  it('returns null when nothing recognizable explains the failure', () => {
    expect(
      classifyChatTurnFailure({
        provider: 'claude',
        evidence: [{ type: 'error', error: 'Something odd happened' }],
        error: 'Something odd happened',
      }),
    ).toBeNull();
  });

  it('prefers the terminal error over a buffered proxy failure', () => {
    expect(
      classifyChatTurnFailure({
        provider: 'codex',
        evidence: [
          {
            type: 'error',
            error: proxyBody({ code: 'session_budget_exhausted' }),
          },
        ],
        error: proxyBody({
          code: 'no_billing_source',
          reason: 'personal_wallet_empty',
        }),
      }),
    ).toEqual({ category: 'no_credits', detail: 'personal_wallet_empty' });
  });

  it('prefers the terminal event over an earlier buffered usage notice', () => {
    const terminalEvent = {
      type: 'codex',
      event: {
        type: 'turn.failed',
        error: {
          message: 'stream failed',
          codexErrorInfo: 'responseStreamConnectionFailed',
        },
      },
    };

    expect(
      classifyChatTurnFailure({
        provider: 'codex',
        evidence: [
          { type: 'codex', event: { type: 'rate_limit.reached' } },
          { type: 'canopy_usage_limit_reached', provider: 'codex' },
          terminalEvent,
        ],
        terminalEvent,
      }),
    ).toEqual({ category: 'network' });
  });

  it.each([
    {
      name: 'a structured Claude status',
      provider: 'claude' as const,
      terminalEvent: {
        type: 'result',
        is_error: true,
        api_error_status: 400,
        result: 'API Error: 400 messages.4.content: Invalid input',
      },
    },
    {
      name: 'a Codex status in its message',
      provider: 'codex' as const,
      terminalEvent: {
        type: 'result',
        is_error: true,
        subtype: 'codex_error',
        result: 'unexpected status 400 Bad Request: invalid input',
      },
    },
  ])(
    'reports other when $name ends the turn after an earlier usage notice',
    ({ provider, terminalEvent }) => {
      expect(
        classifyChatTurnFailure({
          provider,
          evidence: [
            { type: 'codex', event: { type: 'rate_limit.reached' } },
            { type: 'canopy_usage_limit_reached', provider },
            terminalEvent,
          ],
          terminalEvent,
        }),
      ).toEqual({ category: 'other' });
    },
  );

  it('still explains an unrecognized terminal failure from earlier evidence', () => {
    const terminalEvent = {
      type: 'result',
      is_error: true,
      result: 'Something odd happened',
    };

    expect(
      classifyChatTurnFailure({
        provider: 'claude',
        evidence: [
          { type: 'canopy_usage_limit_reached', provider: 'claude' },
          terminalEvent,
        ],
        terminalEvent,
      }),
    ).toEqual({ category: 'provider_quota' });
  });

  it('never returns raw error text', () => {
    const secret = 'sk-ant-api03-private-detail /Users/someone/project';
    const results = [
      classifyChatTurnFailure({ provider: 'claude', error: secret }),
      classifyChatTurnFailure({
        provider: 'codex',
        error: proxyBody({ code: 'no_billing_source', reason: secret }),
      }),
      classifyChatTurnFailure({
        provider: 'codex',
        error: proxyBody({ code: secret }),
      }),
    ];
    for (const result of results) {
      if (result === null) continue;
      expect(CHAT_TURN_FAILURE_CATEGORIES).toContain(result.category);
      if (result.detail !== undefined) {
        expect(CHAT_TURN_FAILURE_DETAILS).toContain(result.detail);
      }
      expect(JSON.stringify(result)).not.toContain('sk-ant');
    }
  });
});

describe('isChatTurnFailureEvidence', () => {
  it.each([
    [{ type: 'error', error: 'boom' }, true],
    [{ type: 'result', is_error: true, result: 'boom' }, true],
    [{ type: 'assistant', error: 'rate_limit' }, true],
    [{ type: 'canopy_usage_limit_reached', provider: 'codex' }, true],
    [{ type: 'canopy_auth_failure' }, true],
    [{ type: 'canopy_ai_credits_no_billing_source' }, true],
    [{ type: 'codex', event: { type: 'turn.failed', error: {} } }, true],
    [{ type: 'codex', event: { type: 'error', message: 'boom' } }, true],
    [{ type: 'codex', event: { type: 'rate_limit.reached' } }, true],
    [{ type: 'assistant', message: { content: [] } }, false],
    [{ type: 'result', is_error: false, result: 'done' }, false],
    [{ type: 'codex', event: { type: 'item.completed' } }, false],
  ])('treats %j as failure evidence: %s', (event, expected) => {
    expect(isChatTurnFailureEvidence(event)).toBe(expected);
  });
});

describe('ChatTurnFailureEvidence', () => {
  const ROOT_THREAD = 'root-thread';
  const derivedNotices = [
    { type: 'canopy_ai_credits_no_billing_source', provider: 'codex' },
    { type: 'canopy_usage_limit_reached', provider: 'codex' },
    {
      type: 'canopy_auth_failure',
      failure: {
        dependencyClass: 'provider',
        dependencyId: 'codex',
        displayName: 'Codex',
        failureClass: 'expired',
        recovery: { kind: 'provider_terminal', provider: 'codex' },
      },
    },
  ];

  it.each(derivedNotices)(
    'routes a $type notice that names a sub-agent to sub-agent evidence',
    (notice) => {
      for (const identity of [
        { parent_tool_use_id: 'toolu_child' },
        { thread_id: 'child-thread' },
      ]) {
        const evidence = new ChatTurnFailureEvidence();
        evidence.observe({ ...notice, ...identity }, ROOT_THREAD);

        const result = evidence.classify({ provider: 'codex' });
        expect(result.failure).toBeNull();
        expect(result.subAgentFailure).not.toBeNull();
      }
    },
  );

  it.each(derivedNotices)(
    'keeps a $type notice without sub-agent identity as root evidence',
    (notice) => {
      for (const identity of [{}, { thread_id: ROOT_THREAD }]) {
        const evidence = new ChatTurnFailureEvidence();
        evidence.observe({ ...notice, ...identity }, ROOT_THREAD);

        const result = evidence.classify({ provider: 'codex' });
        expect(result.failure).not.toBeNull();
        expect(result.subAgentFailure).toBeNull();
      }
    },
  );

  it('ignores events that cannot explain a failure', () => {
    const evidence = new ChatTurnFailureEvidence();
    evidence.observe(
      { type: 'assistant', message: { content: [] } },
      undefined,
    );

    expect(evidence.classify({ provider: 'claude' })).toEqual({
      failure: null,
      subAgentFailure: null,
    });
  });

  it('keeps only the latest events', () => {
    const evidence = new ChatTurnFailureEvidence();
    evidence.observe(
      { type: 'canopy_usage_limit_reached', provider: 'codex' },
      undefined,
    );
    for (let index = 0; index < 8; index += 1) {
      evidence.observe({ type: 'error', error: `noise ${index}` }, undefined);
    }

    expect(evidence.classify({ provider: 'codex' }).failure).toBeNull();
  });
});
