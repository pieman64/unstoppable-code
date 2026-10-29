import {
  parseModelRoutingBacktestResultV1,
  type ModelRoutingBacktestResultV1,
} from '../index';

const result: ModelRoutingBacktestResultV1 = {
  baselineCostUsd: 10,
  autoCostUsd: 7,
  routingCostUsd: 0.1,
  savingsUsd: 3,
  savingsFraction: 0.3,
  savingsLowUsd: 2,
  savingsHighUsd: 4,
  coverageTurnCount: 100,
  eligibleTurnCount: 90,
  replayedTurnCount: 30,
  keptForCacheShare: 0.1,
  subscriptionLaneShare: 0,
  pricingRevision: 'rev-1',
  bucketGranularity: 'week',
  series: [
    {
      bucketStartIso: '2026-09-01T00:00:00.000Z',
      actualCostUsd: 10,
      autoCostUsd: 7,
    },
  ],
  modelShare: [
    {
      modelId: 'anthropic/claude-opus-5',
      actualTurnShare: 1,
      autoTurnShare: 0.5,
      actualCostShare: 1,
      autoCostShare: 0.6,
    },
  ],
  shifts: [
    {
      fromModelId: 'anthropic/claude-opus-5',
      toModelId: 'anthropic/claude-sonnet-5',
      turnCount: 15,
      baselineCostUsd: 5,
    },
  ],
};

describe('parseModelRoutingBacktestResultV1', () => {
  it('round-trips a stored result', () => {
    expect(
      parseModelRoutingBacktestResultV1(JSON.parse(JSON.stringify(result))),
    ).toEqual(result);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a missing number', { ...result, savingsUsd: undefined }],
    ['a non-finite number', { ...result, savingsUsd: Number.NaN }],
    ['an unknown granularity', { ...result, bucketGranularity: 'month' }],
    [
      'a malformed series point',
      { ...result, series: [{ bucketStartIso: 1 }] },
    ],
    ['a malformed shift', { ...result, shifts: [{ fromModelId: 'a' }] }],
  ])('rejects %s', (_label, value) => {
    expect(parseModelRoutingBacktestResultV1(value)).toBeNull();
  });
});
