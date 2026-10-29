import {
  parseClaudeUsageDetails,
  parseCodexWhamUsage,
} from '../provider-usage-parsers';

describe('parseClaudeUsageDetails', () => {
  it('preserves legacy limits and extra usage with the supplied tier', () => {
    expect(
      parseClaudeUsageDetails(
        {
          five_hour: {
            utilization: 10,
            resets_at: '2026-07-02T22:10:01.000000+00:00',
          },
          seven_day_sonnet: { utilization: 60 },
          extra_usage: {
            is_enabled: true,
            monthly_limit: 50,
            used_credits: 12.5,
            utilization: 25,
          },
        },
        'default_claude_max_20x',
      ),
    ).toEqual({
      rateLimitTier: 'default_claude_max_20x',
      rateLimits: [
        {
          limitId: 'five_hour',
          limitName: '5-hour window',
          planType: 'default_claude_max_20x',
          primary: {
            usedPercent: 10,
            resetsAt: '2026-07-02T22:10:01.000Z',
          },
        },
        {
          limitId: 'seven_day_sonnet',
          limitName: '7-day Sonnet',
          planType: 'default_claude_max_20x',
          primary: { usedPercent: 60 },
        },
        {
          limitId: 'extra_usage',
          limitName: 'Extra usage',
          planType: 'default_claude_max_20x',
          primary: { usedPercent: 25 },
          credits: { usedUsd: 12.5, totalUsd: 50, remainingUsd: 37.5 },
        },
      ],
    });
  });

  it('prefers modern scoped limits and ignores malformed scoped entries', () => {
    expect(
      parseClaudeUsageDetails(
        {
          five_hour: { utilization: 1 },
          limits: [
            {
              kind: 'weekly_scoped',
              group: 'weekly',
              percent: 60,
              resets_at: '2026-07-03T06:00:00Z',
              scope: { model: { display_name: 'Fable' } },
            },
            { kind: 'weekly_scoped', group: 'weekly', percent: 80 },
          ],
        },
        'team-premium',
      ).rateLimits,
    ).toEqual([
      {
        limitId: 'weekly_scoped:Fable',
        limitName: '7-day Fable',
        planType: 'team-premium',
        primary: {
          usedPercent: 60,
          resetsAt: '2026-07-03T06:00:00.000Z',
          windowDurationMins: 10080,
        },
      },
    ]);
  });

  it('returns an empty snapshot for non-object payloads', () => {
    expect(parseClaudeUsageDetails(null)).toEqual({
      rateLimits: [],
      rateLimitTier: undefined,
    });
  });
});

describe('parseCodexWhamUsage', () => {
  it('maps base, review, and additional windows with true durations and credits', () => {
    const numericReset = String(Date.parse('2026-10-20T12:00:00.000Z') / 1000);
    expect(
      parseCodexWhamUsage({
        plan_type: 'pro',
        rate_limit: {
          primary_window: {
            used_percent: 42,
            limit_window_seconds: 18000,
            reset_at: numericReset,
          },
          secondary_window: {
            used_percent: 60,
            limit_window_seconds: 604800,
            reset_at: '2030-10-20T20:00:00.000Z',
          },
        },
        code_review_rate_limit: {
          primary_window: {
            used_percent: 15,
            limit_window_seconds: 604800,
            reset_at: Number(numericReset),
          },
        },
        additional_rate_limits: [
          {
            limit_id: 'gpt-5-codex',
            limit_name: 'GPT-5 Codex',
            rate_limit: {
              primary_window: {
                used_percent: '12',
                limit_window_seconds: '3600',
              },
            },
          },
          { limit_name: 'Malformed entry', rate_limit: {} },
        ],
        credits: { has_credits: true, unlimited: false, balance: '123' },
      }),
    ).toEqual([
      {
        limitId: 'codex',
        limitName: 'Codex',
        planType: 'pro',
        primary: {
          usedPercent: 42,
          windowDurationMins: 300,
          resetsAt: '2026-10-20T12:00:00.000Z',
        },
        secondary: {
          usedPercent: 60,
          windowDurationMins: 10080,
          resetsAt: '2030-10-20T20:00:00.000Z',
        },
        credits: { remainingUsd: 123 },
      },
      {
        limitId: 'code_review',
        limitName: 'Code review',
        planType: 'pro',
        primary: {
          usedPercent: 15,
          windowDurationMins: 10080,
          resetsAt: '2026-10-20T12:00:00.000Z',
        },
      },
      {
        limitId: 'gpt-5-codex',
        limitName: 'GPT-5 Codex',
        planType: 'pro',
        primary: { usedPercent: 12, windowDurationMins: 60 },
      },
    ]);
  });

  it('keeps credits separate if no base usage windows are present', () => {
    expect(
      parseCodexWhamUsage({
        rate_limit: { allowed: true },
        credits: { balance: '0' },
      }),
    ).toEqual([
      {
        limitId: 'credits',
        limitName: 'Credits',
        credits: { remainingUsd: 0 },
      },
    ]);
  });

  it('ignores malformed payloads and malformed window values', () => {
    expect(parseCodexWhamUsage(null)).toEqual([]);
    expect(
      parseCodexWhamUsage({
        rate_limit: {
          primary_window: { used_percent: 'not-a-number' },
        },
      }),
    ).toEqual([]);
  });
});
