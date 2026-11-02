import type {
  AgentUsageOverview,
  ProviderRateLimitSnapshot,
} from '@canopy/desktop-shared/types';
import {
  describeBlockingRateLimit,
  hasBlockingRateLimit,
  sessionResumeReadiness,
  summarizeResumeReadiness,
} from '../resume-availability';
import {
  interruptedSessionHomeCopy,
  interruptedSessionsHomeCopy,
  resumeReadinessSummaryText,
} from '../resume-readiness-copy';

const NOW_MS = Date.parse('2026-07-23T12:00:00.000Z');
const SOON_MS = Date.parse('2026-07-23T14:00:00.000Z');
const LATER_MS = Date.parse('2026-07-27T18:13:00.000Z');
const WEEK_MINS = 7 * 24 * 60;

function usageFor(
  provider: 'claude' | 'codex',
  rateLimits: ProviderRateLimitSnapshot[],
): AgentUsageOverview {
  return {
    updatedAt: '2026-07-23T12:00:00.000Z',
    providers: [
      {
        provider,
        authState: 'authenticated',
        hasRemainingLimits: false,
        rateLimits,
      },
    ],
  };
}

describe('describeBlockingRateLimit', () => {
  it('returns null exactly when hasBlockingRateLimit is false', () => {
    const cases: (ProviderRateLimitSnapshot[] | undefined)[] = [
      undefined,
      [],
      [{ limitId: 'five_hour', primary: { usedPercent: 99 } }],
      [{ limitId: 'five_hour', primary: { usedPercent: 100, resetsAt: 'x' } }],
      [
        {
          limitId: 'five_hour',
          primary: {
            usedPercent: 100,
            resetsAt: '2026-07-23T10:00:00.000Z',
          },
        },
      ],
      [
        {
          limitId: 'codex',
          secondary: { usedPercent: 100, resetsAt: LATER_MS },
        },
      ],
    ];
    for (const limits of cases) {
      expect(describeBlockingRateLimit(limits, NOW_MS) === null).toBe(
        !hasBlockingRateLimit(limits, NOW_MS),
      );
    }
  });

  it('stops blocking at the exact reset boundary', () => {
    const limits: ProviderRateLimitSnapshot[] = [
      {
        limitId: 'five_hour',
        primary: { usedPercent: 100, resetsAt: SOON_MS },
      },
    ];
    expect(describeBlockingRateLimit(limits, SOON_MS - 1)).not.toBeNull();
    expect(describeBlockingRateLimit(limits, SOON_MS)).toBeNull();
  });

  it('reports the farthest reset with its own window label', () => {
    const limits: ProviderRateLimitSnapshot[] = [
      {
        limitId: 'codex',
        primary: {
          usedPercent: 100,
          resetsAt: SOON_MS,
          windowDurationMins: 300,
        },
        secondary: {
          usedPercent: 100,
          resetsAt: LATER_MS,
          windowDurationMins: WEEK_MINS,
        },
      },
    ];
    expect(describeBlockingRateLimit(limits, NOW_MS)).toEqual({
      windowLabel: 'Weekly limit',
      resetMs: LATER_MS,
    });
  });

  it('keeps the first window on a tie', () => {
    const limits: ProviderRateLimitSnapshot[] = [
      {
        limitId: 'five_hour',
        primary: { usedPercent: 100, resetsAt: SOON_MS },
      },
      {
        limitId: 'seven_day',
        primary: { usedPercent: 100, resetsAt: SOON_MS },
      },
    ];
    expect(describeBlockingRateLimit(limits, NOW_MS)).toEqual({
      windowLabel: '5-hour limit',
      resetMs: SOON_MS,
    });
  });

  it('omits the reset when another blocking window has none', () => {
    const limits: ProviderRateLimitSnapshot[] = [
      {
        limitId: 'five_hour',
        primary: { usedPercent: 100, resetsAt: LATER_MS },
      },
      { limitId: 'seven_day', primary: { usedPercent: 100 } },
    ];
    expect(describeBlockingRateLimit(limits, NOW_MS)).toEqual({
      windowLabel: '5-hour limit',
      displayResetMs: LATER_MS,
      hasAdditionalUnknownReset: true,
    });
  });
});

describe('sessionResumeReadiness', () => {
  const blocked = usageFor('codex', [
    {
      limitId: 'codex',
      secondary: {
        usedPercent: 100,
        resetsAt: LATER_MS,
        windowDurationMins: WEEK_MINS,
      },
    },
  ]);

  it('is ready without a provider or a provider snapshot', () => {
    expect(sessionResumeReadiness({}, blocked, NOW_MS)).toEqual({
      state: 'ready',
    });
    expect(
      sessionResumeReadiness({ provider: 'claude' }, blocked, NOW_MS),
    ).toEqual({ state: 'ready' });
    expect(
      sessionResumeReadiness({ provider: 'codex' }, undefined, NOW_MS),
    ).toEqual({ state: 'ready' });
  });

  it('waits on the provider snapshot, not the recorded reset', () => {
    expect(
      sessionResumeReadiness(
        { provider: 'codex', resetsAt: SOON_MS },
        blocked,
        NOW_MS,
      ),
    ).toEqual({
      state: 'waiting',
      provider: 'codex',
      windowLabel: 'Weekly limit',
      resetMs: LATER_MS,
      displayResetMs: LATER_MS,
    });
  });

  it('never lets a recorded reset block or schedule on its own', () => {
    const clear = usageFor('codex', [
      { limitId: 'codex', primary: { usedPercent: 40 } },
    ]);
    expect(
      sessionResumeReadiness(
        { provider: 'codex', resetsAt: LATER_MS },
        clear,
        NOW_MS,
      ),
    ).toEqual({ state: 'ready' });
    const unknownReset = usageFor('codex', [
      { limitId: 'codex', primary: { usedPercent: 100 } },
    ]);
    expect(
      sessionResumeReadiness(
        { provider: 'codex', resetsAt: LATER_MS },
        unknownReset,
        NOW_MS,
      ),
    ).toEqual({
      state: 'waiting',
      provider: 'codex',
      windowLabel: 'Usage limit',
      displayResetMs: LATER_MS,
    });
  });

  it('warns about another unknown blocking window when displaying a recorded fallback', () => {
    const snapshot = usageFor('codex', [
      {
        limitId: 'codex',
        primary: { usedPercent: 100, windowDurationMins: 300 },
        secondary: { usedPercent: 100, windowDurationMins: WEEK_MINS },
      },
    ]);
    expect(
      sessionResumeReadiness(
        { provider: 'codex', resetsAt: LATER_MS },
        snapshot,
        NOW_MS,
      ),
    ).toEqual({
      state: 'waiting',
      provider: 'codex',
      windowLabel: '5-hour limit',
      displayResetMs: LATER_MS,
      hasAdditionalUnknownReset: true,
    });
  });

  it('ignores a past recorded reset as display fallback', () => {
    const unknownReset = usageFor('codex', [
      { limitId: 'codex', primary: { usedPercent: 100 } },
    ]);
    expect(
      sessionResumeReadiness(
        { provider: 'codex', resetsAt: NOW_MS - 1 },
        unknownReset,
        NOW_MS,
      ),
    ).toEqual({
      state: 'waiting',
      provider: 'codex',
      windowLabel: 'Usage limit',
    });
  });
});

describe('summarizeResumeReadiness and copy', () => {
  const waitingCodex = {
    state: 'waiting',
    provider: 'codex',
    windowLabel: 'Weekly limit',
    resetMs: LATER_MS,
    displayResetMs: LATER_MS,
  } as const;
  const waitingClaude = {
    state: 'waiting',
    provider: 'claude',
    windowLabel: '5-hour limit',
    resetMs: SOON_MS,
    displayResetMs: SOON_MS,
  } as const;
  const ready = { state: 'ready' } as const;

  it('deduplicates by session key and orders providers', () => {
    const summary = summarizeResumeReadiness([
      { key: 'a', kind: 'chat', readiness: waitingCodex },
      { key: 'a', kind: 'chat', readiness: waitingCodex },
      { key: 'b', kind: 'chat', readiness: waitingClaude },
      { key: 'c', kind: 'chat', readiness: ready },
    ]);
    expect(summary).toEqual({
      total: 3,
      readyCount: 1,
      waitingCount: 2,
      chatCount: 3,
      pipelineCount: 0,
      readyChatCount: 1,
      readyPipelineCount: 0,
      waitingProviders: ['claude', 'codex'],
    });
  });

  it('counts chats and pipelines with their ready subsets', () => {
    const summary = summarizeResumeReadiness([
      { key: 'a', kind: 'chat', readiness: ready },
      { key: 'b', kind: 'pipeline', readiness: ready },
      { key: 'c', kind: 'pipeline', readiness: waitingCodex },
    ]);
    expect(summary).toMatchObject({
      chatCount: 1,
      pipelineCount: 2,
      readyChatCount: 1,
      readyPipelineCount: 1,
    });
    expect(interruptedSessionsHomeCopy(summary).label).toMatch(
      /^Resume 1 chat and 1 workflow · 1 waiting for Codex reset \(.+\)$/,
    );
  });

  it.each([
    [[['chat', 1]], 'Resume 1 interrupted chat'],
    [[['chat', 3]], 'Resume 3 interrupted chats'],
    [[['pipeline', 1]], 'Resume 1 interrupted workflow'],
    [[['pipeline', 2]], 'Resume 2 interrupted workflows'],
    [
      [
        ['chat', 1],
        ['pipeline', 2],
      ],
      'Resume 1 interrupted chat and 2 workflows',
    ],
  ] as const)('names the listed kinds on Home (%j)', (kinds, label) => {
    const entries = kinds.flatMap(([kind, count]) =>
      Array.from({ length: count }, (_, index) => ({
        key: `${kind}-${index}`,
        kind,
        readiness: ready,
      })),
    );
    const copy = interruptedSessionsHomeCopy(summarizeResumeReadiness(entries));
    expect(copy.label).toBe(label);
    expect(copy.label).not.toContain('session');
  });

  it('keeps the original Home copy when everything is ready', () => {
    const summary = summarizeResumeReadiness([
      { key: 'a', kind: 'chat', readiness: ready },
      { key: 'b', kind: 'chat', readiness: ready },
    ]);
    expect(interruptedSessionsHomeCopy(summary).label).toBe(
      'Resume 2 interrupted chats',
    );
    expect(resumeReadinessSummaryText(summary)).toBe('All 2 ready now');
    expect(
      resumeReadinessSummaryText(
        summarizeResumeReadiness([
          { key: 'a', kind: 'chat', readiness: ready },
        ]),
      ),
    ).toBe('1 ready now');
  });

  it('separates waiting sessions and shows a shared reset', () => {
    const summary = summarizeResumeReadiness([
      { key: 'a', kind: 'chat', readiness: ready },
      { key: 'b', kind: 'chat', readiness: ready },
      { key: 'c', kind: 'chat', readiness: waitingCodex },
    ]);
    const copy = interruptedSessionsHomeCopy(summary);
    expect(copy.label).toMatch(
      /^Resume 2 chats · 1 waiting for Codex reset \(.+\)$/,
    );
    expect(copy.accessibleLabel).toBe(copy.label);
    expect(resumeReadinessSummaryText(summary)).toBe(
      '2 ready now · 1 waiting for Codex reset',
    );
  });

  it('keeps an all-waiting row and its summary', () => {
    const summary = summarizeResumeReadiness([
      { key: 'c', kind: 'chat', readiness: waitingCodex },
    ]);
    expect(interruptedSessionsHomeCopy(summary).label).toMatch(
      /^1 chat waiting for Codex reset \(.+\)$/,
    );
    expect(resumeReadinessSummaryText(summary)).toBe(
      '0 ready now · 1 waiting for Codex reset',
    );
  });

  it('omits the time when waiting sessions reset at different or unknown times', () => {
    const multiple = summarizeResumeReadiness([
      { key: 'a', kind: 'chat', readiness: ready },
      { key: 'b', kind: 'chat', readiness: ready },
      { key: 'c', kind: 'chat', readiness: waitingCodex },
      { key: 'd', kind: 'chat', readiness: waitingClaude },
    ]);
    expect(interruptedSessionsHomeCopy(multiple).label).toBe(
      'Resume 2 chats · 2 waiting for Claude and Codex resets',
    );
    const unknown = summarizeResumeReadiness([
      { key: 'c', kind: 'chat', readiness: waitingCodex },
      {
        key: 'd',
        kind: 'chat',
        readiness: {
          state: 'waiting',
          provider: 'codex',
          windowLabel: 'Usage limit',
        },
      },
    ]);
    expect(interruptedSessionsHomeCopy(unknown).label).toBe(
      '2 chats waiting for Codex reset',
    );
  });
});

describe('interruptedSessionHomeCopy', () => {
  it('offers to resume a ready entry', () => {
    expect(
      interruptedSessionHomeCopy(
        summarizeResumeReadiness([
          { key: 'a', kind: 'chat', readiness: { state: 'ready' } },
        ]),
      ),
    ).toEqual({ prefix: 'Resume' });
  });

  it('names what a waiting entry waits for, with its reset when known', () => {
    const known = interruptedSessionHomeCopy(
      summarizeResumeReadiness([
        {
          key: 'a',
          kind: 'chat',
          readiness: {
            state: 'waiting',
            provider: 'codex',
            windowLabel: 'Weekly limit',
            resetMs: LATER_MS,
            displayResetMs: LATER_MS,
          },
        },
      ]),
    );
    expect(known.prefix).toBeUndefined();
    expect(known.suffix).toMatch(/^waiting for Codex reset \(.+\)$/);
    expect(
      interruptedSessionHomeCopy(
        summarizeResumeReadiness([
          {
            key: 'a',
            kind: 'chat',
            readiness: {
              state: 'waiting',
              provider: 'codex',
              windowLabel: 'Usage limit',
            },
          },
        ]),
      ),
    ).toEqual({ suffix: 'waiting for Codex reset' });
  });
});

describe('readiness display authority', () => {
  it('does not summarize a recorded display fallback as a known provider reset', () => {
    const readiness = sessionResumeReadiness(
      { provider: 'codex', resetsAt: LATER_MS },
      usageFor('codex', [{ limitId: 'codex', primary: { usedPercent: 100 } }]),
      NOW_MS,
    );
    const summary = summarizeResumeReadiness([
      { key: 'chat', kind: 'chat', readiness },
    ]);
    expect(summary.sharedWaitingResetMs).toBeUndefined();
    expect(interruptedSessionsHomeCopy(summary).label).toBe(
      '1 chat waiting for Codex reset',
    );
  });

  it.each([Infinity, 9e15])(
    'does not describe an invalid numeric date (%s) as a reset',
    (resetsAt) => {
      const limits = [
        { limitId: 'codex', primary: { usedPercent: 100, resetsAt } },
      ];
      expect(hasBlockingRateLimit(limits, NOW_MS)).toBe(true);
      expect(
        describeBlockingRateLimit(limits, NOW_MS)?.resetMs,
      ).toBeUndefined();
    },
  );
});

it('does not display an out-of-range session reset fallback', () => {
  expect(
    sessionResumeReadiness(
      { provider: 'codex', resetsAt: 9e15 },
      usageFor('codex', [{ limitId: 'codex', primary: { usedPercent: 100 } }]),
      NOW_MS,
    ),
  ).toEqual({
    state: 'waiting',
    provider: 'codex',
    windowLabel: 'Usage limit',
  });
});
