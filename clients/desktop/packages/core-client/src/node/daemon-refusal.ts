import type { CanopyErrorKind } from '@canopy/protocol/canopy-core';
import { CanopyClientError, toCanopyClientError } from '../errors';
import { canopyConnectError } from './endpoint';

/**
 * Why a host refuses the daemon it found or started, carried in the error's
 * `details.refusal` so the protocol error schema stays unchanged. Additive:
 * later lanes append reasons, never rename one.
 */
export const CANOPY_DAEMON_REFUSALS = [
  /** A peer holds the W5 commit log's writer lock; waiting would not help. */
  'writer_held',
  /** A daemon without the needed operations outlived the wait. */
  'peer_held',
  /** The daemon serves the needed operations at other versions. */
  'version_skew',
  /** The daemon this launch spawned exited before it was ready. */
  'exited_before_ready',
] as const;

export type CanopyDaemonRefusal = (typeof CANOPY_DAEMON_REFUSALS)[number];

const isRefusal = (value: unknown): value is CanopyDaemonRefusal =>
  CANOPY_DAEMON_REFUSALS.some((refusal) => refusal === value);

export function canopyDaemonRefusalError(
  refusal: CanopyDaemonRefusal,
  message: string,
  kind: CanopyErrorKind = 'failed_precondition',
): CanopyClientError {
  const { payload } = canopyConnectError(kind, message);
  return new CanopyClientError({ ...payload, details: { refusal } });
}

/** The typed refusal an error carries, or `null`; reads any schema-valid payload. */
export function canopyDaemonRefusal(
  error: unknown,
): CanopyDaemonRefusal | null {
  const { details } = toCanopyClientError(error).payload;
  if (typeof details !== 'object' || details === null || Array.isArray(details))
    return null;
  const refusal: unknown = Object.getOwnPropertyDescriptor(
    details,
    'refusal',
  )?.value;
  return isRefusal(refusal) ? refusal : null;
}
