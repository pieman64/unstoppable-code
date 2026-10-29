import { finalizeModelRoutingSavings } from '../lib/model-routing-savings';

const attribution = {
  schemaVersion: 1 as const,
  selectionMode: 'auto' as const,
  outcome: 'selected' as const,
  executionLane: 'provider_subscription' as const,
  benchmarkModelId: 'default-model',
  selectedModelId: 'selected-model',
  routingCostUsd: 0.02,
};

describe('finalizeModelRoutingSavings', () => {
  it('retains negative savings and includes the routing cost', () => {
    expect(
      finalizeModelRoutingSavings({
        attribution,
        usageComplete: true,
        selectedExecutionCostUsd: 0.09,
        selectedCostBasis: 'api_equivalent',
        benchmark: {
          status: 'priced',
          costUsd: 0.1,
          pricingRevision: 'pricing-1',
        },
      }).savings,
    ).toEqual({
      status: 'computed',
      pricingRevision: 'pricing-1',
      selectedCostBasis: 'api_equivalent',
      benchmarkEstimatedExecutionCostUsd: 0.1,
      selectedExecutionCostUsd: 0.09,
      actualWithAutoCostUsd: 0.11,
      netEstimatedSavingsUsd: -0.01,
    });
  });

  it('does not make a monetary claim while routing cost is unresolved', () => {
    expect(
      finalizeModelRoutingSavings({
        attribution: { ...attribution, routingCostUsd: undefined },
        usageComplete: true,
        selectedExecutionCostUsd: 0.01,
        selectedCostBasis: 'gateway_actual',
        benchmark: {
          status: 'priced',
          costUsd: 0.1,
          pricingRevision: 'pricing-1',
        },
      }).savings,
    ).toEqual({ status: 'unresolved_routing_cost' });
  });

  it('rejects a local API-equivalent estimate as an AI Credits actual', () => {
    expect(
      finalizeModelRoutingSavings({
        attribution: {
          ...attribution,
          executionLane: 'ai_credits',
        },
        usageComplete: true,
        selectedExecutionCostUsd: 0.04,
        selectedCostBasis: 'api_equivalent',
        benchmark: {
          status: 'priced',
          costUsd: 0.1,
          pricingRevision: 'pricing-1',
        },
      }).savings,
    ).toEqual({ status: 'incomparable_basis' });
  });
});
