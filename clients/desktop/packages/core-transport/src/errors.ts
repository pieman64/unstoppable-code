// Browser-safe: no Node imports, so the HTTP binding can throw it too.
import type { CanopyErrorPayload } from '@canopy/protocol/canopy-core';

export class CanopyTransportError extends Error {
  constructor(readonly payload: CanopyErrorPayload) {
    super(payload.message);
    this.name = 'CanopyTransportError';
  }
}
