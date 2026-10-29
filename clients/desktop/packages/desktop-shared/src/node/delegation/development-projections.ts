import type { DevelopmentDelegationBroker } from './development-broker';
import { createDelegationProjection } from './projections';
export type { DelegationTool as DevelopmentDelegationTool } from './projections';

/** The Phase 0 entry point always uses the inert development description. */
export function createDevelopmentDelegationProjection(
  harness: 'claude' | 'codex',
  namespace: string,
  broker: DevelopmentDelegationBroker,
): ReturnType<typeof createDelegationProjection> {
  return createDelegationProjection(harness, namespace, broker, {
    developmentProbe: true,
  });
}
