import { classifyAgentFailure } from '../agent-failures/classifier';

describe('classifyAgentFailure', () => {
  it('classifies Claude authentication before other signals', () => {
    expect(
      classifyAgentFailure({
        provider: 'claude',
        accountScope: 'native',
        events: [
          { type: 'assistant', error: 'authentication_failed' },
          { type: 'result', is_error: true, api_error_status: 429 },
        ],
      }),
    ).toMatchObject({
      kind: 'provider_authentication_required',
      code: 'authentication_failed',
      provider: 'claude',
      account_scope: 'native',
    });
  });

  it('classifies an expired Claude OAuth session as authentication even with a 429', () => {
    expect(
      classifyAgentFailure({
        provider: 'claude',
        accountScope: 'native',
        events: [
          {
            type: 'result',
            is_error: true,
            api_error_status: 429,
            result:
              'Failed to authenticate: OAuth session expired and could not be refreshed',
          },
        ],
      }),
    ).toMatchObject({
      kind: 'provider_authentication_required',
      code: 'authentication_failed',
      provider: 'claude',
      account_scope: 'native',
    });
  });

  it('classifies a structured Claude 429', () => {
    expect(
      classifyAgentFailure({
        provider: 'claude',
        accountScope: 'native',
        events: [{ type: 'result', is_error: true, api_error_status: 429 }],
      }),
    ).toMatchObject({
      kind: 'provider_usage_limit',
      code: 'http_429',
    });
  });

  it('classifies a top-level provider HTTP 429', () => {
    expect(
      classifyAgentFailure({
        provider: 'claude',
        accountScope: 'native',
        error: { status: 429, message: 'Rate limited' },
      }),
    ).toMatchObject({
      kind: 'provider_usage_limit',
      code: 'http_429',
    });
  });

  it.each([401, 429, 500])('ignores a nested tool HTTP %i status', (status) => {
    expect(
      classifyAgentFailure({
        provider: 'claude',
        accountScope: 'native',
        events: [
          {
            type: 'assistant',
            content: [{ type: 'tool_result', tool_use_result: { status } }],
          },
        ],
      }),
    ).toBeNull();
    expect(
      classifyAgentFailure({
        provider: 'codex',
        accountScope: 'native',
        events: [
          {
            type: 'codex',
            event: {
              type: 'item.completed',
              item: { type: 'tool_result', result: { status } },
            },
          },
        ],
      }),
    ).toBeNull();
  });

  it('classifies Codex usage limit and normalizes its reset timestamp', () => {
    expect(
      classifyAgentFailure({
        provider: 'codex',
        accountScope: 'native',
        events: [
          {
            type: 'codex',
            event: {
              type: 'turn.failed',
              error: {
                message: 'Usage limit reached',
                codexErrorInfo: 'usageLimitExceeded',
                resetsAt: 1_800_000_000,
              },
            },
          },
        ],
      }),
    ).toMatchObject({
      kind: 'provider_usage_limit',
      code: 'usage_limit_exceeded',
      resets_at: '2027-01-15T08:00:00.000Z',
    });
  });

  it('classifies Claude 529 as transient', () => {
    expect(
      classifyAgentFailure({
        provider: 'claude',
        accountScope: 'native',
        error: { status: 529, message: 'Provider overloaded' },
      }),
    ).toMatchObject({
      kind: 'provider_temporarily_unavailable',
      code: 'http_5xx',
    });
  });

  it('classifies a Claude server error emitted mid-response as transient', () => {
    expect(
      classifyAgentFailure({
        provider: 'claude',
        accountScope: 'native',
        events: [
          {
            type: 'assistant',
            message: {
              model: '<synthetic>',
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: 'API Error: Server error mid-response. The response above may be incomplete.',
                },
              ],
            },
            error: 'server_error',
          },
          {
            type: 'result',
            subtype: 'success',
            is_error: true,
            api_error_status: null,
            result:
              'API Error: Server error mid-response. The response above may be incomplete.',
            terminal_reason: 'api_error',
          },
        ],
      }),
    ).toMatchObject({
      kind: 'provider_temporarily_unavailable',
      code: 'internal_server_error',
    });
  });

  it('classifies the exact Claude SDK server error wrapper as transient', () => {
    expect(
      classifyAgentFailure({
        provider: 'claude',
        accountScope: 'native',
        error: new Error('Claude SDK error: server_error'),
      }),
    ).toMatchObject({
      kind: 'provider_temporarily_unavailable',
      code: 'internal_server_error',
    });
  });

  it('ignores a Claude server error shape nested in a tool payload', () => {
    expect(
      classifyAgentFailure({
        provider: 'claude',
        accountScope: 'native',
        events: [
          {
            type: 'assistant',
            content: [
              {
                type: 'tool_result',
                tool_use_result: {
                  type: 'assistant',
                  error: 'server_error',
                },
              },
            ],
          },
        ],
      }),
    ).toBeNull();
  });

  it.each([
    'Selected model is at capacity. Please try a different model.',
    'Error: Selected model is at capacity. Please try a different model.',
    'Codex query failed: Selected model is at capacity. Please try a different model.',
  ])('classifies the exact Codex capacity message: %s', (message) => {
    expect(
      classifyAgentFailure({
        provider: 'codex',
        accountScope: 'native',
        error: new Error(message),
      }),
    ).toMatchObject({
      kind: 'provider_temporarily_unavailable',
      code: 'model_capacity',
    });
  });

  it('does not use broad capacity or network substring matching', () => {
    expect(
      classifyAgentFailure({
        provider: 'codex',
        accountScope: 'native',
        error: new Error('capacity planning failed on a network diagram'),
      }),
    ).toBeNull();
  });

  it.each([
    [503, 'provider_temporarily_unavailable'],
    [401, 'provider_authentication_required'],
  ] as const)(
    'classifies the Codex unexpected-status message for HTTP %i',
    (status, kind) => {
      expect(
        classifyAgentFailure({
          provider: 'codex',
          accountScope: 'ai_credits',
          error: new Error(`unexpected status ${String(status)} Bad Gateway`),
        }),
      ).toMatchObject({ kind });
    },
  );

  it('does not classify a non-transient Codex unexpected status', () => {
    expect(
      classifyAgentFailure({
        provider: 'codex',
        accountScope: 'ai_credits',
        error: new Error('unexpected status 400 Bad Request'),
      }),
    ).toBeNull();
  });

  it('requires the exact Codex unexpected-status format', () => {
    expect(
      classifyAgentFailure({
        provider: 'codex',
        accountScope: 'ai_credits',
        error: new Error('unexpected status report 500 lines long'),
      }),
    ).toBeNull();
  });

  // The message-text status extraction is gated on `provider === 'codex'` but
  // deliberately NOT on `accountScope`: a 503 from a native ChatGPT-auth Codex
  // session is just as transient as one from the AI Credits path. Pinned here so
  // the widening stays intentional rather than an accident of gate placement.
  it.each([
    [503, 'provider_temporarily_unavailable'],
    [401, 'provider_authentication_required'],
  ] as const)(
    'classifies the native-scope Codex unexpected-status message for HTTP %i',
    (status, kind) => {
      expect(
        classifyAgentFailure({
          provider: 'codex',
          accountScope: 'native',
          error: new Error(`unexpected status ${String(status)} Bad Gateway`),
        }),
      ).toMatchObject({ kind });
    },
  );

  it('does not extract unexpected status messages for Claude', () => {
    expect(
      classifyAgentFailure({
        provider: 'claude',
        accountScope: 'native',
        error: new Error('unexpected status 503 Bad Gateway'),
      }),
    ).toBeNull();
  });

  it('keeps a record-derived status authoritative over the message', () => {
    expect(
      classifyAgentFailure({
        provider: 'codex',
        accountScope: 'ai_credits',
        error: {
          status: 200,
          message: 'unexpected status 503 Bad Gateway',
        },
      }),
    ).toBeNull();
  });

  it('uses the proxy marker to distinguish credential and transport failures', () => {
    expect(
      classifyAgentFailure({
        provider: 'codex',
        accountScope: 'ai_credits',
        error: new Error(
          'unexpected status 401: {"error":{"canopy_proxy":"CANOPY_AI_CREDITS_PROXY","code":"credentials_unavailable"}}',
        ),
      }),
    ).toMatchObject({ kind: 'provider_authentication_required' });
    expect(
      classifyAgentFailure({
        provider: 'codex',
        accountScope: 'ai_credits',
        error: new Error(
          'unexpected status 502: {"error":{"canopy_proxy":"CANOPY_AI_CREDITS_PROXY","code":"upstream_unavailable"}}',
        ),
      }),
    ).toMatchObject({ kind: 'provider_temporarily_unavailable' });
  });

  // End-to-end half of the cross-hop replay guard. `hasAmbiguousDelivery` stops
  // the PROXY replaying an ambiguous hosted failure, but the proxy relays that
  // body to Codex verbatim, so the turn-level path has to refuse it too —
  // otherwise `transient-error-retry-service` (which fires on
  // `provider_temporarily_unavailable`) dispatches a fresh billed turn seconds
  // later against a request the gateway may already be running.
  //
  // `apps/web` therefore picks the body code by delivery state: ambiguous emits
  // `proxy_internal_error`, which is SUPPRESS here, so no classification and no
  // auto-retry. These are the real wire shapes `proxyFailureBody` produces.
  it('refuses to classify an ambiguous hosted delivery as transient', () => {
    expect(
      classifyAgentFailure({
        provider: 'codex',
        accountScope: 'ai_credits',
        error: new Error(
          'unexpected status 502: {"error":{"canopy_proxy":"CANOPY_AI_CREDITS_PROXY","code":"proxy_internal_error","correlation_id":"corr-ambiguous"}}',
        ),
      }),
    ).toBeNull();
  });

  // The inverse must stay transient: nothing reached the gateway, so no turn
  // was started and the turn-level recovery is both safe and the point.
  it('keeps a never-sent hosted delivery eligible for transient recovery', () => {
    expect(
      classifyAgentFailure({
        provider: 'codex',
        accountScope: 'ai_credits',
        error: new Error(
          'unexpected status 502: {"error":{"canopy_proxy":"CANOPY_AI_CREDITS_PROXY","code":"upstream_unavailable","correlation_id":"corr-not-sent"}}',
        ),
      }),
    ).toMatchObject({ kind: 'provider_temporarily_unavailable' });
  });

  it('classifies a marked no-billing-source 402 as depleted credits, never transient', () => {
    const failure = classifyAgentFailure({
      provider: 'codex',
      accountScope: 'ai_credits',
      error: new Error(
        'unexpected status 402: {"error":{"canopy_proxy":"CANOPY_AI_CREDITS_PROXY","code":"no_billing_source"}}',
      ),
    });

    expect(failure).toMatchObject({
      kind: 'provider_usage_limit',
      code: 'credits_depleted',
    });
    expect(failure?.kind).not.toBe('provider_temporarily_unavailable');
  });

  // The hosted route emits the marked 402 for BOTH providers, so classification
  // must not be codex-only (CAN-2413 review round 2). The renderer surfaces read
  // the marker directly and never cared, but pipeline and `agent-prompt`
  // recoverable-pause handling keys off the classification — so while this was
  // gated to codex, a Claude credit exhaustion failed as an ordinary error
  // instead of pausing recoverably.
  it('classifies the same marked 402 for claude, not just codex', () => {
    expect(
      classifyAgentFailure({
        provider: 'claude',
        accountScope: 'ai_credits',
        error: new Error(
          'unexpected status 402: {"error":{"canopy_proxy":"CANOPY_AI_CREDITS_PROXY","code":"no_billing_source"}}',
        ),
      }),
    ).toMatchObject({
      kind: 'provider_usage_limit',
      code: 'credits_depleted',
    });
  });

  // The one pre-existing Claude shape the widening deliberately changes.
  // A hosted 502 carrying `proxy_internal_error` is reachable for Claude
  // (its AI-Credits turns point ANTHROPIC_BASE_URL at the hosted route), and it
  // now suppresses instead of falling through to `http_5xx`. Intended: that
  // code means AMBIGUOUS delivery, so the turn may already be billed and
  // auto-retry would double-charge.
  // NOTE the numeric `status`. An `unexpected status NNN:` *message* would make
  // this test vacuous: that message parse is gated to codex, so for Claude the
  // status list would be empty, `http_5xx` would never have been reachable, and
  // the assertion would pass with or without the widening it claims to pin.
  // A real numeric status puts the `http_5xx` branch genuinely in play, so this
  // fails if the SUPPRESS branch is ever removed.
  it('suppresses a marked Claude proxy_internal_error instead of calling it http_5xx', () => {
    const error: Error & { status?: number } = new Error(
      '{"error":{"canopy_proxy":"CANOPY_AI_CREDITS_PROXY","code":"proxy_internal_error"}}',
    );
    error.status = 502;

    expect(
      classifyAgentFailure({
        provider: 'claude',
        accountScope: 'ai_credits',
        error,
      }),
    ).toBeNull();
  });

  // The control for the test above: the identical 502 WITHOUT the marker still
  // classifies transient. This is what proves the suppression comes from the
  // proxy branch rather than from the input being unclassifiable.
  it('still classifies an unmarked Claude 502 as transient http_5xx', () => {
    const error: Error & { status?: number } = new Error('Bad gateway');
    error.status = 502;

    expect(
      classifyAgentFailure({
        provider: 'claude',
        accountScope: 'ai_credits',
        error,
      }),
    ).toMatchObject({
      kind: 'provider_temporarily_unavailable',
      code: 'http_5xx',
    });
  });

  // The other half: the majority recoverable 502 is untouched, so ordinary
  // transient recovery still works for Claude.
  it('still classifies a marked Claude upstream_unavailable as transient', () => {
    expect(
      classifyAgentFailure({
        provider: 'claude',
        accountScope: 'ai_credits',
        error: new Error(
          'unexpected status 502: {"error":{"canopy_proxy":"CANOPY_AI_CREDITS_PROXY","code":"upstream_unavailable"}}',
        ),
      }),
    ).toMatchObject({ kind: 'provider_temporarily_unavailable' });
  });

  // Widening the gate must not let a proxy failure outrank a genuine Claude
  // auth failure or rate limit: the proxy branches deliberately run after both.
  it('still lets Claude authentication outrank a marked proxy failure', () => {
    expect(
      classifyAgentFailure({
        provider: 'claude',
        accountScope: 'ai_credits',
        events: [
          { type: 'assistant', error: 'authentication_failed' },
          {
            type: 'result',
            is_error: true,
            result:
              'unexpected status 402: {"error":{"canopy_proxy":"CANOPY_AI_CREDITS_PROXY","code":"no_billing_source"}}',
          },
        ],
      }),
    ).toMatchObject({ kind: 'provider_authentication_required' });
  });

  it('lets a real 429 outrank an earlier no-billing-source proxy failure', () => {
    expect(
      classifyAgentFailure({
        provider: 'codex',
        accountScope: 'ai_credits',
        events: [
          {
            type: 'codex',
            event: {
              type: 'error',
              error: {
                message:
                  'unexpected status 402: {"error":{"canopy_proxy":"CANOPY_AI_CREDITS_PROXY","code":"no_billing_source"}}',
              },
            },
          },
        ],
        error: new Error('unexpected status 429 Too Many Requests'),
      }),
    ).toMatchObject({
      kind: 'provider_usage_limit',
      code: 'http_429',
    });
  });

  // A proxy failure buffered earlier in a turn must not shadow the genuine
  // limit that actually ended it: that would drop the usage-limit banner and
  // `resets_at`, and make the turn eligible for auto-retry into the rate limit.
  it('lets a real usage limit win over an earlier buffered proxy failure', () => {
    expect(
      classifyAgentFailure({
        provider: 'codex',
        accountScope: 'ai_credits',
        events: [
          {
            type: 'codex',
            event: {
              type: 'error',
              error: {
                message:
                  'unexpected status 502: {"error":{"canopy_proxy":"CANOPY_AI_CREDITS_PROXY","code":"upstream_unavailable"}}',
              },
            },
          },
        ],
        error: new Error('unexpected status 429 Too Many Requests'),
      }),
    ).toMatchObject({ kind: 'provider_usage_limit' });
  });

  // The message-derived status of the TERMINAL error must survive even when an
  // earlier buffered event carried a STRUCTURED status. Skipping the message
  // parse whenever `statuses` is already non-empty lets a recovered buffered
  // 502 stand in for a terminal 429, which drops the usage-limit banner and
  // `resets_at` and makes billed, non-idempotent work eligible for auto-retry.
  it('lets a terminal message status win over an earlier buffered structured status', () => {
    expect(
      classifyAgentFailure({
        provider: 'codex',
        accountScope: 'ai_credits',
        events: [
          {
            type: 'codex',
            event: { type: 'error', status: 502 },
          },
        ],
        error: new Error('unexpected status 429 Too Many Requests'),
      }),
    ).toMatchObject({ kind: 'provider_usage_limit' });
  });

  // Terminal-first must be absolute, not "terminal is also in the list".
  // Classification consumes `statuses` with `.includes()` in priority order
  // (401 -> 429 -> 5xx), so merely appending the terminal status alongside a
  // buffered one still lets the buffered value win whenever it sits higher in
  // that order. A recovered buffered 429 must not turn a terminal 503 into a
  // usage limit, which would suppress the transient banner and auto-retry.
  it('does not let an earlier buffered structured status outrank a terminal status', () => {
    expect(
      classifyAgentFailure({
        provider: 'codex',
        accountScope: 'ai_credits',
        events: [
          {
            type: 'codex',
            event: { type: 'error', status: 429 },
          },
        ],
        error: new Error('unexpected status 503 Service Unavailable'),
      }),
    ).toMatchObject({ kind: 'provider_temporarily_unavailable' });
  });

  // The terminal status collector must handle the SAME shapes the buffered one
  // does — the `{type:'codex', event:{...}}` envelope and the nested `.error`
  // record. A terminal failure whose status is structured and nested would
  // otherwise be invisible to the terminal pass, the "terminal spoke" guard
  // would not trip, and the buffered pass would re-scan the whole event list,
  // reinstating exactly the stale-signal precedence this is meant to remove.
  // These use the real retry-service call shape, `error === events[last]`.
  it('reads a nested structured status on the terminal error', () => {
    const events = [
      { type: 'codex', event: { type: 'error', status: 503 } },
      {
        type: 'codex',
        event: { type: 'turn.failed', error: { status: 400, message: 'bad' } },
      },
    ];
    expect(
      classifyAgentFailure({
        provider: 'codex',
        accountScope: 'native',
        events,
        error: events[events.length - 1],
      }),
    ).toBeNull();
  });

  it('lets a nested structured terminal 503 win over a buffered 429', () => {
    const events = [
      { type: 'codex', event: { type: 'error', status: 429 } },
      {
        type: 'codex',
        event: { type: 'turn.failed', error: { status: 503, message: 'busy' } },
      },
    ];
    expect(
      classifyAgentFailure({
        provider: 'codex',
        accountScope: 'native',
        events,
        error: events[events.length - 1],
      }),
    ).toMatchObject({ kind: 'provider_temporarily_unavailable' });
  });

  // Terminal-first must cover the STRUCTURED signals too, not just statuses and
  // proxy codes. A turn can record a structured failure it then recovered from,
  // and that record must not speak for the failure that ended the turn.
  it('does not let a buffered structured usage limit outrank a terminal transient status', () => {
    expect(
      classifyAgentFailure({
        provider: 'codex',
        accountScope: 'native',
        events: [{ codexErrorInfo: 'usageLimitExceeded' }],
        error: new Error('unexpected status 503 Service Unavailable'),
      }),
    ).toMatchObject({ kind: 'provider_temporarily_unavailable' });
  });

  it('does not let a buffered structured overload make a terminal permanent failure retryable', () => {
    expect(
      classifyAgentFailure({
        provider: 'codex',
        accountScope: 'native',
        events: [{ codexErrorInfo: 'serverOverloaded' }],
        error: new Error('unexpected status 400 Bad Request'),
      }),
    ).toBeNull();
  });

  // The proxy-code lookup must use the SAME terminal-first precedence the HTTP
  // status lookup already has. `strings` is ordered events-then-error and the
  // marker scan takes the first match, so without an explicit terminal-first
  // pass a proxy failure the turn already recovered from shadows the failure
  // that actually ended it — in both directions.
  it('lets a terminal transient status win over an earlier buffered permanent proxy code', () => {
    expect(
      classifyAgentFailure({
        provider: 'codex',
        accountScope: 'ai_credits',
        events: [
          {
            type: 'codex',
            event: {
              type: 'error',
              error: {
                message:
                  'unexpected status 502: {"error":{"canopy_proxy":"CANOPY_AI_CREDITS_PROXY","code":"invalid_request"}}',
              },
            },
          },
        ],
        error: new Error('unexpected status 503 Service Unavailable'),
      }),
    ).toMatchObject({ kind: 'provider_temporarily_unavailable' });
  });

  it('does not let an earlier buffered transient proxy code make a terminal permanent failure retryable', () => {
    expect(
      classifyAgentFailure({
        provider: 'codex',
        accountScope: 'ai_credits',
        events: [
          {
            type: 'codex',
            event: {
              type: 'error',
              error: {
                message:
                  'unexpected status 502: {"error":{"canopy_proxy":"CANOPY_AI_CREDITS_PROXY","code":"upstream_unavailable"}}',
              },
            },
          },
        ],
        error: new Error(
          'unexpected status 400: {"error":{"canopy_proxy":"CANOPY_AI_CREDITS_PROXY","code":"invalid_request"}}',
        ),
      }),
    ).toBeNull();
  });

  it.each(['codex', 'claude'] as const)(
    'never auto-retries a %s work-owner refusal (CAN-3462)',
    (provider) => {
      expect(
        classifyAgentFailure({
          provider,
          accountScope: 'ai_credits',
          error: new Error(
            'unexpected status 403: {"error":{"canopy_proxy":"CANOPY_AI_CREDITS_PROXY","code":"work_owner_not_member","correlation_id":"corr-owner"}}',
          ),
        }),
      ).toBeNull();
    },
  );

  it.each(['invalid_request', 'proxy_internal_error', 'work_owner_not_member'])(
    'does not recover the proxy marker code %s',
    (code) => {
      expect(
        classifyAgentFailure({
          provider: 'codex',
          accountScope: 'ai_credits',
          error: new Error(
            `unexpected status 502: {"error":{"canopy_proxy":"CANOPY_AI_CREDITS_PROXY","code":"${code}"}}`,
          ),
        }),
      ).toBeNull();
    },
  );

  it('does not recover invalid-request, billing, policy, or sandbox failures', () => {
    for (const codexErrorInfo of [
      'badRequest',
      'cyberPolicy',
      'sandboxError',
      'contextWindowExceeded',
    ]) {
      expect(
        classifyAgentFailure({
          provider: 'codex',
          accountScope: 'native',
          events: [{ codexErrorInfo }],
        }),
      ).toBeNull();
    }
    expect(
      classifyAgentFailure({
        provider: 'claude',
        accountScope: 'native',
        events: [{ type: 'assistant', error: 'billing_error' }],
      }),
    ).toBeNull();
  });
});
