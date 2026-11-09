import type { GatewayModelEntry } from '@canopy/protocol/llm-gateway';
import { isSyntacticallyValidModelId } from '@canopy/execution-engine/lib/model-id';

/** Catalog eligibility only. Execution independently validates owner and funding. */
export function isOpenCodeGatewayRouteSupported(
  entry: Pick<
    GatewayModelEntry,
    'gatewayId' | 'recommendedHarness' | 'toolSchemaProfile' | 'contextWindow'
  >,
): boolean {
  return (
    entry.toolSchemaProfile === 'standard' &&
    (entry.recommendedHarness === 'claude' ||
      entry.recommendedHarness === 'codex') &&
    isSyntacticallyValidModelId(entry.gatewayId) &&
    Number.isSafeInteger(entry.contextWindow) &&
    entry.contextWindow > 0
  );
}
