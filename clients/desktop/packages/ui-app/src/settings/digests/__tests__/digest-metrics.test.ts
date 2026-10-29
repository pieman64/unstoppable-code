import { readHeadlineMetrics } from '../digest-metrics';

function keysOf(metrics: unknown, subjectType: string): string[] {
  return readHeadlineMetrics(metrics, subjectType).map((entry) => entry.key);
}

function fullMetrics(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    turnTotals: { turnCount: 12345, totalCostUsd: 6658.47 },
    worktreeCount: 4,
    planCount: 2,
    mergedPullRequestCount: 7,
    contributors: [{}, {}, {}],
    ...overrides,
  };
}

describe('readHeadlineMetrics ranked sets', () => {
  it('renders the user four outcome first and cost last', () => {
    expect(keysOf(fullMetrics(), 'USER')).toEqual([
      'merged',
      'worktrees',
      'plans',
      'cost',
    ]);
  });

  it('swaps Contributors into slot three for an organization', () => {
    // Contributors is the denominator that makes the other numbers
    // interpretable, so it outranks Plans on the org view only.
    expect(keysOf(fullMetrics(), 'ORGANIZATION')).toEqual([
      'merged',
      'worktrees',
      'contributors',
      'cost',
    ]);
  });

  it('never renders Turns while every primary has a value', () => {
    // Turns is redundant with Spend and paints red when work gets more
    // efficient, so it is fallback-only on both sets.
    expect(keysOf(fullMetrics(), 'USER')).not.toContain('turns');
    expect(keysOf(fullMetrics(), 'ORGANIZATION')).not.toContain('turns');
  });

  it('substitutes Turns into the Spend slot for a user view without costs', () => {
    // `projectMetrics` sets `includeCosts: false` for the share page and any
    // viewer below `usageStatsMinRole`, which is most reads.
    const withheld = fullMetrics({ turnTotals: { turnCount: 12345 } });

    expect(keysOf(withheld, 'USER')).toEqual([
      'merged',
      'worktrees',
      'plans',
      'turns',
    ]);
  });

  it('substitutes Plans, not Turns, into the org Spend slot', () => {
    const withheld = fullMetrics({ turnTotals: { turnCount: 12345 } });

    expect(keysOf(withheld, 'ORGANIZATION')).toEqual([
      'merged',
      'worktrees',
      'contributors',
      'plans',
    ]);
  });

  it('substitutes in place rather than appending', () => {
    // A missing count must not push Spend out of the last slot.
    const noWorktrees = fullMetrics({ worktreeCount: null });

    expect(keysOf(noWorktrees, 'USER')).toEqual([
      'merged',
      'turns',
      'plans',
      'cost',
    ]);
  });

  it('keeps a Spend card whose value survived without a baseline', () => {
    // Present value, withheld baseline: still a real card, so it must not be
    // substituted away just because the trend chip cannot render.
    const resolved = readHeadlineMetrics(
      fullMetrics({ previousPeriod: { worktreeCount: 2 } }),
      'USER',
    );

    expect(resolved.at(-1)).toMatchObject({
      key: 'cost',
      value: 6658.47,
      previousValue: null,
    });
  });

  it('consumes each fallback at most once', () => {
    const sparse = {
      turnTotals: { turnCount: 900 },
      planCount: 5,
      mergedPullRequestCount: 7,
      contributors: [{}],
    };

    // Worktrees and Spend are both missing; Plans covers the first hole and
    // Turns the second, with no key repeated.
    expect(keysOf(sparse, 'ORGANIZATION')).toEqual([
      'merged',
      'plans',
      'contributors',
      'turns',
    ]);
  });

  it('never exceeds four cards', () => {
    for (const subjectType of ['USER', 'ORGANIZATION']) {
      expect(
        readHeadlineMetrics(fullMetrics(), subjectType).length,
      ).toBeLessThanOrEqual(4);
    }
  });

  it('drops slots instead of wrapping when a legacy row exhausts the chain', () => {
    // A maximally sparse pre-rollup row still renders one clean short row.
    const legacy = { mergedPullRequestCount: 3 };

    expect(keysOf(legacy, 'USER')).toEqual(['merged']);
  });

  it('spends a valueless fallback without filling the slot it was shifted for', () => {
    // The minimal drop, and the ordinary one: an anonymous share or
    // featured-profile read withholds `Spend`, and a row predating the turn
    // rollup has no `turnCount`. `Turns` is the user set's only fallback, so
    // it is shifted off the chain, found valueless, discarded, and the `Spend`
    // slot is dropped — one valueless primary, one dropped card.
    const shareRead = {
      mergedPullRequestCount: 7,
      worktreeCount: 4,
      planCount: 2,
      turnTotals: {},
    };

    expect(keysOf(shareRead, 'USER')).toEqual(['merged', 'worktrees', 'plans']);
  });

  it('keeps four org cards when one missing metric still leaves a valued fallback', () => {
    // The org chain is two deep, so a single missing metric is absorbed: with
    // `Spend` withheld and no `planCount`, `Turns` still fills the slot. This
    // is the shape `digest-surfacing.spec.mjs` asserts end to end. It is NOT
    // evidence that the org set cannot drop — see the next test.
    const orgMemberRead = {
      mergedPullRequestCount: 7,
      worktreeCount: 4,
      planCount: null,
      contributors: [{}, {}],
      turnTotals: { turnCount: 900 },
    };

    expect(keysOf(orgMemberRead, 'ORGANIZATION')).toEqual([
      'merged',
      'worktrees',
      'contributors',
      'turns',
    ]);
  });

  it('drops an org slot once both fallbacks are valueless', () => {
    // Two missing metrics rather than one: `Spend` withheld, and a legacy row
    // carrying neither `planCount` nor `turnCount`. One valueless primary
    // against zero valued fallbacks, so the org set drops too — it is harder
    // to exhaust than the user set, not immune.
    const orgLegacyRead = {
      mergedPullRequestCount: 7,
      worktreeCount: 4,
      planCount: null,
      contributors: [{}, {}],
      turnTotals: {},
    };

    expect(keysOf(orgLegacyRead, 'ORGANIZATION')).toEqual([
      'merged',
      'worktrees',
      'contributors',
    ]);
  });

  it('drops exactly `valuelessPrimaries - valuedFallbacks` slots', () => {
    // The rule the docblock states, exercised where two primaries are
    // valueless and one fallback has a value: 4 - (2 - 1) = 3 cards.
    const twoValuelessPrimaries = {
      mergedPullRequestCount: 7,
      worktreeCount: null,
      planCount: null,
      contributors: [{}, {}],
      turnTotals: { turnCount: 900 },
    };

    expect(keysOf(twoValuelessPrimaries, 'ORGANIZATION')).toEqual([
      'merged',
      'turns',
      'contributors',
    ]);
  });
});
