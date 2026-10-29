import type { CanopyErrorPayload } from '@canopy/protocol/canopy-core';

/** One channel; stream reads pull one frame at a time to bound renderer delivery. */
export type CanopyCoreRelayRequest =
  | {
      kind: 'request' | 'openStream';
      method: string;
      params: Record<string, unknown>;
    }
  | { kind: 'readStream' | 'closeStream'; subscriptionId: string }
  | { kind: 'close' };

export type CanopyCoreRelayReply =
  | { ok: true; value: unknown }
  | { ok: false; error: CanopyErrorPayload };

export interface CanopyCoreRelayApi {
  invoke(request: CanopyCoreRelayRequest): Promise<CanopyCoreRelayReply>;
}
