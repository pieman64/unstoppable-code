import { CanopyClientError, toCanopyClientError } from '@canopy/core-client';
import { canopyDaemonRefusal } from '@canopy/core-client/node';
import {
  W5AuthorityUnreachableError,
  type W5AuthorityUnreachableReason,
} from '@canopy/core-runtime/node/w5/file-store';
import type { BackgroundServiceUnreachableReason } from '@canopy/desktop-shared/lib/background-service-status';
import type {
  W5RecordPortCall,
  W5RecordPortClient,
  W5RecordPortRunner,
} from '../lib/w5-daemon-record-store';
import { isW5DaemonFlipCompiled } from '../lib/w5-flip-gate';
import { daemonUnreachableReason } from './electron-daemon-connection';

/*
 * GB4 (CAN-5542): which daemon-backed W5 record-port failures mean the
 * authority could not be reached, as opposed to a typed refusal from a live
 * one. Only these become `W5AuthorityUnreachableError`; every typed reply
 * (any `core.workspaceRecords.*` code) passes through to the host port's
 * `fromWire` unchanged and never degrades.
 */

/**
 * Q2 (a), decided 2026-11-01: a reached daemon that serves no W5 records
 * degrades as unreachable (`w5_host_unavailable`) instead of refusing with
 * the client's typed `capability_unavailable`. False restores that refusal.
 */
export const W5_HOSTLESS_DAEMON_DEGRADES = true;

export interface W5RecordPortGuardOptions {
  /**
   * The client for one call. A rejection the connection service tags
   * unreachable, or a `W5AuthorityUnreachableError`, means nothing was sent.
   */
  readonly connect: () => Promise<W5RecordPortClient>;
  /** The lease's owner: once aborted, every failure is its close. */
  readonly owner: AbortSignal;
  /** True refuses each call before connecting (GA3's reconnect latch). */
  readonly held?: () => boolean;
  /**
   * A `connect` failure GA3 tagged, before its refusal is thrown (GA3's
   * `noteFallback`). Not for `held`, a dropped sent call or
   * `w5_host_unavailable`: none carries a tag.
   */
  readonly onUnreachable?: (tag: BackgroundServiceUnreachableReason) => void;
  /** Defaults to {@link W5_HOSTLESS_DAEMON_DEGRADES}. */
  readonly degradeHostlessDaemon?: boolean;
}

/** GA3's `get` tag as this error's reason: a drop is `lost`, the rest `connect`. */
export function w5UnreachableReasonForTag(
  tag: BackgroundServiceUnreachableReason,
): W5AuthorityUnreachableReason {
  return tag === 'connection_lost' || tag === 'reconnect_failed'
    ? 'lost'
    : 'connect';
}

function typedCode(error: unknown): string | undefined {
  return error instanceof CanopyClientError ? error.payload.code : undefined;
}

/** A live overload reply remains a refusal even if its session drops next. */
function isLiveOverload(error: unknown): boolean {
  if (!(error instanceof CanopyClientError)) return false;
  const { kind, details } = error.payload;
  // Unmarked overloads fail closed on session loss; revisit with client reply provenance.
  const cause: unknown =
    typeof details === 'object' && details !== null && !Array.isArray(details)
      ? Object.getOwnPropertyDescriptor(details, 'w5HostUnavailable')?.value
      : undefined;
  return (
    (kind === 'resource_exhausted' &&
      (cause === 'queue-full' || cause === 'queued-wait')) ||
    (kind === 'unavailable' && cause === 'queued-wait')
  );
}

/** GB12's launch and pre-spawn refusals retain their handoff reasons. */
function isHandoffRefusal(error: unknown): boolean {
  if (canopyDaemonRefusal(error) !== null) return true;
  const { details } = toCanopyClientError(error).payload;
  return (
    typeof details === 'object' &&
    details !== null &&
    !Array.isArray(details) &&
    typeof Object.getOwnPropertyDescriptor(details, 'w5Handoff')?.value ===
      'string'
  );
}

/** A `connect` failure: unreachable when GA3 tagged it, else unchanged. */
function connectFailure(
  error: unknown,
  options: W5RecordPortGuardOptions,
): unknown {
  if (options.owner.aborted || error instanceof W5AuthorityUnreachableError)
    return error;
  const tag = daemonUnreachableReason(error);
  if (tag === null) return error;
  try {
    options.onUnreachable?.(tag);
  } catch {
    // An observer never changes the refusal.
  }
  // GA3's reachability tag still feeds the notice, but is not a new reason.
  if (isW5DaemonFlipCompiled() && isHandoffRefusal(error)) return error;
  return new W5AuthorityUnreachableError(
    'refused',
    w5UnreachableReasonForTag(tag),
    error,
  );
}

/** A sent call's failure: unreachable only when its own client dropped. */
function sentCallFailure(
  call: W5RecordPortCall<unknown>,
  error: unknown,
  signal: AbortSignal,
  owner: AbortSignal,
): unknown {
  if (
    owner.aborted ||
    !signal.aborted ||
    error instanceof W5AuthorityUnreachableError ||
    typedCode(error) !== undefined ||
    isLiveOverload(error)
  )
    return error;
  // A query decided nothing; an instruction may have been decided.
  return new W5AuthorityUnreachableError(
    call.kind === 'instruction' ? 'outcome-unknown' : 'refused',
    'lost',
    error,
  );
}

/** Runs each record-port call, typing the failures that never reached the authority. */
export function guardW5RecordPortCalls(
  options: W5RecordPortGuardOptions,
): W5RecordPortRunner {
  const { owner } = options;
  const degradeHostless =
    options.degradeHostlessDaemon ?? W5_HOSTLESS_DAEMON_DEGRADES;
  return async <T>(call: W5RecordPortCall<T>): Promise<T> => {
    if (!owner.aborted && options.held?.())
      throw new W5AuthorityUnreachableError('refused', 'held');
    let client: W5RecordPortClient;
    try {
      client = await options.connect();
    } catch (error) {
      throw connectFailure(error, options);
    }
    if (degradeHostless && !client.manifest.has('operations', call.operation))
      throw new W5AuthorityUnreachableError('refused', 'w5_host_unavailable');
    // The attempt's own client: a replacement connection is another attempt.
    const { signal } = client;
    if (signal.aborted && !owner.aborted)
      throw new W5AuthorityUnreachableError('refused', 'lost');
    try {
      return await call.run(client);
    } catch (error) {
      throw sentCallFailure(call, error, signal, owner);
    }
  };
}
