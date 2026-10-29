import { parseExternalAgentSender } from '@canopy/protocol/portal/external-agent-sender';
import type { ExternalAgentSender } from '@canopy/protocol/portal';
import type { PortalCommandEnvelope } from '@canopy/desktop-shared/types';

export type PortalCommandProvenanceValidation =
  | { ok: true; origin?: ExternalAgentSender }
  | { ok: false };

/**
 * Validate the server-only envelope origin before Portal command routing or
 * async snapshot hand-off. Sender data comes only from the envelope: payload
 * keys are user data (pipeline inputs, script names), and the adapters drop
 * any payload `agentSent` and replace it with this origin.
 */
export function validatePortalCommandProvenance(
  command: PortalCommandEnvelope,
): PortalCommandProvenanceValidation {
  if (!Object.prototype.hasOwnProperty.call(command, 'origin')) {
    return { ok: true };
  }
  const origin = parseExternalAgentSender(command.origin);
  return origin ? { ok: true, origin } : { ok: false };
}
