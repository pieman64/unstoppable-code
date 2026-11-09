import { toAuthDependencyFailure } from '@canopy/execution-engine/agent-failures';
import {
  CANOPY_AUTH_FAILURE_EVENT_TYPE,
  type CanopyAuthFailureEventData,
} from '@canopy/desktop-shared/types';
import type { AgentFailureClassification } from '@canopy/execution-engine/types/agent-failures';

/**
 * Build the transcript event for a provider authentication failure, or decline.
 *
 * Only `provider_authentication_required` produces an event. Quota and outage
 * classifications are represented in the wire model but have no inline
 * recovery, and emitting them here would put a reconnect affordance on a
 * failure that reconnecting cannot fix (CAN-1674, CAN-1814).
 */
export function buildProviderAuthFailureEvent(
  classification: AgentFailureClassification,
): CanopyAuthFailureEventData | null {
  if (classification.kind !== 'provider_authentication_required') {
    return null;
  }
  return {
    type: CANOPY_AUTH_FAILURE_EVENT_TYPE,
    failure: toAuthDependencyFailure(classification),
  };
}
