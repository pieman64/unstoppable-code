import type { CanopyErrorPayload } from '@canopy/protocol/canopy-core';

/**
 * How the cowork store reaches one core. Each host supplies its own carrier
 * (desktop: the renderer relay with `authority: 'web-core'`); the store never
 * names a transport, so the browser can adopt it unchanged (CAN-4095).
 */
export interface CoreCoworkInvoker {
  request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<CanopyCoreRelayLikeReply>;
  /** Rejects with {@link CoreCoworkRequestError} when the core refuses the open. */
  openStream(
    method: string,
    params: Record<string, unknown>,
  ): Promise<CoreCoworkStream>;
}

/**
 * One open stream. Each value is a stream frame as `@canopy/core-client`
 * delivers it: `{ kind: 'item', cursor, item }` or
 * `{ kind: 'end', cursor, outcome, error }`.
 */
export interface CoreCoworkStream {
  next(): Promise<{ done: true } | { done: false; value: unknown }>;
  close(): Promise<void>;
}

export type CanopyCoreRelayLikeReply =
  | { ok: true; value: unknown }
  | { ok: false; error: CanopyErrorPayload };

export class CoreCoworkRequestError extends Error {
  readonly payload: CanopyErrorPayload;

  constructor(payload: CanopyErrorPayload) {
    super(payload.message);
    this.name = 'CoreCoworkRequestError';
    this.payload = payload;
  }
}
