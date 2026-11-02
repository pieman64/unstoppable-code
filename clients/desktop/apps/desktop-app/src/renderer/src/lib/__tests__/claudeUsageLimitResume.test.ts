import {
  selectClaudeUsageLimitResumeAt,
  selectPipelineUsageLimitResumeAt,
  selectProviderUsageLimitResumeAt,
} from '../claudeUsageLimitResume';
import type {
  AgentUsageOverview,
  ProviderRateLimitSnapshot,
} from '@canopy/desktop-shared/types';
import type { PipelineStatusReason } from '@canopy/desktop-shared/types/pipeline';

function buildUsage(
  rateLimits: ProviderRateLimitSnapshot[] | undefined,
  provider: 'claude' | 'codex' = 'claude',
): AgentUsageOverview {
  return {
    updatedAt: '2026-06-05T00:00:00.000Z',
    providers: [
      {
        provider,
        authState: 'authenticated',
        hasRemainingLimits: true,
        ...(rateLimits ? { rateLimits } : {}),
      },
    ],
  };
}

const NOW = new Date('2026-06-05T12:00:00.000Z');

describe('selectClaudeUsageLimitResumeAt', () => {
  it('returns the farthest future reset among 100% windows', () => {
    const usage = buildUsage([
      {
        primary: {
          usedPercent: 100,
          resetsAt: '2026-06-05T17:00:00.000Z',
        },
        secondary: {
          usedPercent: 100,
          resetsAt: '2026-06-12T12:00:00.000Z',
        },
      },
    ]);

    expect(selectClaudeUsageLimitResumeAt(usage, NOW)).toBe(
      '2026-06-12T12:00:00.000Z',
    );
  });

  it('ignores windows below 100%', () => {
    const usage = buildUsage([
      {
        primary: { usedPercent: 99.9, resetsAt: '2026-06-12T12:00:00.000Z' },
        secondary: { usedPercent: 100, resetsAt: '2026-06-05T17:00:00.000Z' },
      },
    ]);

    expect(selectClaudeUsageLimitResumeAt(usage, NOW)).toBe(
      '2026-06-05T17:00:00.000Z',
    );
  });

  it('ignores missing, invalid, and past reset times', () => {
    const usage = buildUsage([
      { primary: { usedPercent: 100 } },
      {
        primary: { usedPercent: 100, resetsAt: 'not-a-date' },
        secondary: { usedPercent: 100, resetsAt: '2026-06-05T11:00:00.000Z' },
      },
    ]);

    expect(selectClaudeUsageLimitResumeAt(usage, NOW)).toBeNull();
  });

  it('returns null when there is no claude provider', () => {
    const usage = buildUsage(
      [{ primary: { usedPercent: 100, resetsAt: '2026-06-12T12:00:00.000Z' } }],
      'codex',
    );

    expect(selectClaudeUsageLimitResumeAt(usage, NOW)).toBeNull();
  });

  it('returns null when the claude provider has no rate limits', () => {
    expect(
      selectClaudeUsageLimitResumeAt(buildUsage(undefined), NOW),
    ).toBeNull();
  });

  it('considers windows across multiple snapshots', () => {
    const usage = buildUsage([
      { primary: { usedPercent: 100, resetsAt: '2026-06-05T18:00:00.000Z' } },
      { secondary: { usedPercent: 100, resetsAt: '2026-06-06T06:00:00.000Z' } },
    ]);

    expect(selectClaudeUsageLimitResumeAt(usage, NOW)).toBe(
      '2026-06-06T06:00:00.000Z',
    );
  });
});

describe('selectProviderUsageLimitResumeAt', () => {
  it('returns the farthest future reset for Codex usage limits', () => {
    const usage = buildUsage(
      [
        {
          primary: {
            usedPercent: 100,
            resetsAt: '2026-06-05T17:00:00.000Z',
          },
          secondary: {
            usedPercent: 100,
            resetsAt: '2026-06-12T12:00:00.000Z',
          },
        },
      ],
      'codex',
    );

    expect(selectProviderUsageLimitResumeAt(usage, 'codex', NOW)).toBe(
      '2026-06-12T12:00:00.000Z',
    );
  });

  it('accepts Codex reset timestamps in epoch milliseconds', () => {
    const usage = buildUsage(
      [
        {
          primary: {
            usedPercent: 100,
            resetsAt: Date.parse('2026-06-05T17:00:00.000Z'),
          },
        },
      ],
      'codex',
    );

    expect(selectProviderUsageLimitResumeAt(usage, 'codex', NOW)).toBe(
      '2026-06-05T17:00:00.000Z',
    );
  });

  it('accepts Codex reset timestamps in epoch seconds', () => {
    const usage = buildUsage(
      [
        {
          primary: {
            usedPercent: 100,
            resetsAt: Date.parse('2026-06-05T17:00:00.000Z') / 1000,
          },
        },
      ],
      'codex',
    );

    expect(selectProviderUsageLimitResumeAt(usage, 'codex', NOW)).toBe(
      '2026-06-05T17:00:00.000Z',
    );
  });

  it('returns null when the requested provider has no exhausted reset window', () => {
    const usage = buildUsage(
      [
        {
          primary: {
            usedPercent: 100,
            resetsAt: '2026-06-12T12:00:00.000Z',
          },
        },
      ],
      'codex',
    );

    expect(selectProviderUsageLimitResumeAt(usage, 'claude', NOW)).toBeNull();
  });
});

describe('selectPipelineUsageLimitResumeAt', () => {
  const reason = (
    id: string,
    accountScope: 'native' | 'ai_credits' | 'local',
    resetsAt?: string,
  ): PipelineStatusReason => ({
    id,
    kind: 'provider_usage_limit',
    code: 'rate_limit',
    provider: 'claude',
    account_scope: accountScope,
    detected_at: '2026-06-05T11:00:00.000Z',
    source: {
      job_id: 'job',
      step_id: id,
      attempt: 1,
      iteration: 1,
    },
    ...(resetsAt ? { resets_at: resetsAt } : {}),
  });

  it('uses the latest reset across every selected reason', () => {
    expect(
      selectPipelineUsageLimitResumeAt(
        [
          reason('first', 'native', '2026-06-05T17:00:00.000Z'),
          reason('second', 'native', '2026-06-06T09:00:00.000Z'),
        ],
        null,
        NOW,
      ),
    ).toBe('2026-06-06T09:00:00.000Z');
  });

  it('uses the provider snapshot only for native-account reasons', () => {
    expect(
      selectPipelineUsageLimitResumeAt(
        [reason('native', 'native')],
        '2026-06-05T18:00:00.000Z',
        NOW,
      ),
    ).toBe('2026-06-05T18:00:00.000Z');
    expect(
      selectPipelineUsageLimitResumeAt(
        [reason('credits', 'ai_credits')],
        '2026-06-05T18:00:00.000Z',
        NOW,
      ),
    ).toBeNull();
  });

  it('returns null unless every selected reason has a future reset', () => {
    expect(
      selectPipelineUsageLimitResumeAt(
        [
          reason('known', 'local', '2026-06-05T17:00:00.000Z'),
          reason('unknown', 'local'),
        ],
        null,
        NOW,
      ),
    ).toBeNull();
  });
});
