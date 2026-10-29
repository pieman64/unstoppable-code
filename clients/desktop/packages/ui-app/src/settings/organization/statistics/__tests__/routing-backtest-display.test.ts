import type { ModelRoutingBacktestResultV1 } from '@canopy/protocol/model-routing';
import {
  createErrorMessage,
  displayedSavings,
  formatShare,
  modelLabel,
  modelShareRows,
  progressStageMessage,
  routingBacktestCopy,
  routingBacktestProgressStage,
} from '../routing-backtest-display';

function result(
  overrides: Partial<ModelRoutingBacktestResultV1> = {},
): ModelRoutingBacktestResultV1 {
  return {
    baselineCostUsd: 100,
    autoCostUsd: 60,
    routingCostUsd: 0.5,
    savingsUsd: 40,
    savingsFraction: 0.4,
    savingsLowUsd: 30,
    savingsHighUsd: 50,
    coverageTurnCount: 48_210,
    eligibleTurnCount: 30_000,
    replayedTurnCount: 1_940,
    keptForCacheShare: 0.2,
    subscriptionLaneShare: 0,
    pricingRevision: 'r1',
    bucketGranularity: 'week',
    series: [
      {
        bucketStartIso: '2026-09-01T00:00:00.000Z',
        actualCostUsd: 50,
        autoCostUsd: 30,
      },
      {
        bucketStartIso: '2026-09-08T00:00:00.000Z',
        actualCostUsd: 50,
        autoCostUsd: 30,
      },
    ],
    modelShare: [
      {
        modelId: 'anthropic/claude-sonnet-5',
        actualTurnShare: 0.3,
        autoTurnShare: 0.7,
        actualCostShare: 0.1,
        autoCostShare: 0.5,
      },
      {
        modelId: 'anthropic/claude-opus-5',
        actualTurnShare: 0.7,
        autoTurnShare: 0.3,
        actualCostShare: 0.9,
        autoCostShare: 0.5,
      },
      {
        modelId: 'anthropic/claude-haiku-5',
        actualTurnShare: 0,
        autoTurnShare: 0.001,
        actualCostShare: 0,
        autoCostShare: 0,
      },
      {
        modelId: 'openai/unused',
        actualTurnShare: 0,
        autoTurnShare: 0,
        actualCostShare: 0,
        autoCostShare: 0,
      },
    ],
    shifts: [],
    ...overrides,
  };
}

describe('routing backtest display helpers', () => {
  it('formats shares with <1% for tiny non-zero values', () => {
    expect(formatShare(0)).toBe('0%');
    expect(formatShare(0.001)).toBe('<1%');
    expect(formatShare(0.384)).toBe('38%');
    expect(formatShare(Number.NaN)).toBe('0%');
  });

  it('strips the gateway vendor prefix from model ids', () => {
    expect(modelLabel('anthropic/claude-opus-5')).toBe('claude-opus-5');
    expect(modelLabel('opus')).toBe('opus');
  });

  it('keeps every model on either side, sorted by actual then Auto share', () => {
    const rows = modelShareRows(result().modelShare);
    expect(rows.map((row) => row.label)).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-5',
    ]);
  });

  it('keeps the top nine models and folds the rest into Other models', () => {
    const shares = Array.from({ length: 14 }, (_, index) => ({
      modelId: `vendor/model-${String(index).padStart(2, '0')}`,
      actualTurnShare: index < 12 ? (14 - index) / 200 : 0,
      autoTurnShare: 0,
      actualCostShare: 0.01,
      autoCostShare: 0,
    }));
    // A model only model routing picked still ranks by its combined share.
    shares[13] = { ...shares[13], autoTurnShare: 0.5, autoCostShare: 0.4 };
    const rows = modelShareRows(shares);
    expect(rows).toHaveLength(10);
    expect(rows.slice(0, 8).map((row) => row.label)).toEqual(
      Array.from(
        { length: 8 },
        (_, i) => `model-${String(i).padStart(2, '0')}`,
      ),
    );
    expect(rows[8].label).toBe('model-13');
    const other = rows[9];
    // model-12 has no share on either side, so it never gets a row; model-08
    // through model-11 fold together.
    expect(other.label).toBe('Other models (4)');
    expect(other.actual).toBeCloseTo((6 + 5 + 4 + 3) / 200);
    expect(other.actualCost).toBeCloseTo(0.04);
  });

  it('does not fold when every model fits', () => {
    expect(modelShareRows(result().modelShare, 3)).toHaveLength(3);
  });

  it('keeps at least one model row beside Other models', () => {
    const rows = modelShareRows(result().modelShare, 0);
    expect(rows.map((row) => row.label)).toEqual([
      'claude-opus-5',
      'Other models (2)',
    ]);
  });

  it('names the progress stage from the run status and counts', () => {
    expect(
      routingBacktestProgressStage('queued', {
        replayedTurnCount: 0,
        plannedTurnCount: 2_000,
      }),
    ).toBe('preparing');
    expect(
      routingBacktestProgressStage('running', {
        replayedTurnCount: 0,
        plannedTurnCount: 0,
      }),
    ).toBe('preparing');
    expect(
      routingBacktestProgressStage('running', {
        replayedTurnCount: 400,
        plannedTurnCount: 2_000,
      }),
    ).toBe('replaying');
    expect(
      routingBacktestProgressStage('running', {
        replayedTurnCount: 2_000,
        plannedTurnCount: 2_000,
      }),
    ).toBe('totaling');
    expect(progressStageMessage('preparing')).toBe('Preparing the data…');
  });

  it('never shows negative savings', () => {
    expect(
      displayedSavings(result({ savingsUsd: -5, savingsFraction: -0.05 })),
    ).toEqual({ usd: 0, fraction: 0 });
  });

  it('speaks to the team for org runs and as the person for profile runs', () => {
    expect(routingBacktestCopy('organization').spentLabel).toBe(
      'What you spent',
    );
    expect(routingBacktestCopy('user').ranLabel).toBe('What I ran');
    expect(routingBacktestCopy('organization').replayIntro).toContain(
      'We replay your team’s past conversations',
    );
    expect(routingBacktestCopy('user').replayIntro).toContain(
      'We replay your past conversations',
    );
  });

  it('maps create error codes to actionable copy', () => {
    expect(createErrorMessage('insufficient_credits', 'x')).toBe(
      'Add AI Credits to run this estimate.',
    );
    expect(createErrorMessage(undefined, 'Fallback')).toBe('Fallback');
  });
});
