import type { AgentActionErrorCode } from '@canopy/agent-actions';

export class DiscoveryError extends Error {
  constructor(
    public readonly code: AgentActionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DiscoveryError';
  }
}
