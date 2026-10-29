import {
  parseAccountProxyUsageResponse,
  parseClaudeOAuthProfilePlanType,
} from '../usage';

describe('Claude OAuth profile plan', () => {
  it.each([
    ['claude_max', 'default_claude_max_20x', 'default_claude_max_20x'],
    ['claude_max', 'default_claude_max_5x', 'default_claude_max_5x'],
    ['claude_team', 'default_claude_max_5x', 'team-premium'],
    ['claude_team', 'default_claude_max_20x', 'team'],
    ['claude_pro', null, 'pro'],
    ['claude_enterprise', null, 'enterprise'],
    ['claude_max', null, 'max'],
    ['unexpected', 'default_claude_max_20x', null],
  ])('maps %s and %s to %s', (organizationType, tier, expected) => {
    expect(
      parseClaudeOAuthProfilePlanType({
        status_code: 200,
        body: JSON.stringify({
          account: { email: 'private@example.com' },
          organization: {
            organization_type: organizationType,
            rate_limit_tier: tier,
          },
        }),
      }),
    ).toBe(expected);
  });

  it('ignores failed and malformed profile responses', () => {
    expect(
      parseClaudeOAuthProfilePlanType({
        status_code: 503,
        body: JSON.stringify({
          organization: {
            organization_type: 'claude_max',
            rate_limit_tier: 'default_claude_max_20x',
          },
        }),
      }),
    ).toBeNull();
    expect(
      parseClaudeOAuthProfilePlanType({ status_code: 200, body: '{}' }),
    ).toBeNull();
  });
});

describe('account proxy usage response parser', () => {
  it('classifies a nested provider 401 without preserving the response body', () => {
    const result = parseAccountProxyUsageResponse(
      'claude',
      {
        status_code: 401,
        header: {},
        body: JSON.stringify({ error: 'provider credential secret detail' }),
      },
      'team',
    );

    expect(result).toEqual({
      status: 'failure',
      errorInfo: { kind: 'auth' },
    });
    expect(JSON.stringify(result)).not.toContain('secret detail');
  });

  it('classifies a nested provider 429 and keeps Retry-After only', () => {
    const result = parseAccountProxyUsageResponse('codex', {
      status_code: 429,
      header: { 'Retry-After': '120' },
      body: JSON.stringify({ error: 'provider response secret' }),
    });

    expect(result).toEqual({
      status: 'failure',
      errorInfo: { kind: 'rate_limited' },
      retryAfter: '120',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('classifies malformed envelopes and provider payloads as service failures', () => {
    expect(
      parseAccountProxyUsageResponse('claude', { status_code: '200' }),
    ).toEqual({
      status: 'failure',
      errorInfo: { kind: 'service' },
    });
    expect(
      parseAccountProxyUsageResponse('claude', {
        status_code: 200,
        header: {},
        body: '{not-json',
      }),
    ).toEqual({ status: 'failure', errorInfo: { kind: 'service' } });
  });

  it('parses a successful Claude usage envelope through the shared parser', () => {
    const result = parseAccountProxyUsageResponse(
      'claude',
      {
        status_code: 200,
        header: {},
        body: JSON.stringify({
          rate_limit_tier: 'team',
          five_hour: { utilization: 40 },
        }),
      },
      'fallback',
    );

    expect(result).toMatchObject({
      status: 'success',
      rateLimits: [
        {
          limitId: 'five_hour',
          planType: 'team',
          primary: { usedPercent: 40 },
        },
      ],
    });
  });
});
