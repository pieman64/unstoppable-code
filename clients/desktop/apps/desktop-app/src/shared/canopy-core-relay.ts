import type {
  CanopyErrorPayload,
  CanopyRetryDirective,
} from '@canopy/protocol/canopy-core';

/**
 * Keyed instructions this host serves without a retained outcome (CAN-4733).
 * A same-key replay acts again, so the relay never directs one for these.
 */
const UNRETAINED_KEYED_METHODS: ReadonlySet<string> = new Set([
  'worker.filesystem.file.write',
  'worker.filesystem.directory.create',
  'worker.filesystem.entry.delete',
  'worker.filesystem.entry.copy',
  'worker.filesystem.entry.move',
]);

/** A failure's retry as the relay answers it for `method`. */
export function relayRetryFor(
  method: string | undefined,
  retry: CanopyRetryDirective,
): CanopyRetryDirective {
  return retry.kind === 'same_idempotency_key' &&
    method !== undefined &&
    UNRETAINED_KEYED_METHODS.has(method)
    ? { kind: 'never' }
    : retry;
}

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
