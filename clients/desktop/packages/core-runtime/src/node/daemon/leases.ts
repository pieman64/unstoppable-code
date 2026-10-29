import { createHash, randomUUID } from 'node:crypto';
import type {
  CanopyErrorPayload,
  CanopySchemaOutput,
  CoreClientLease,
  CoreClientLeaseAcquireParamsSchema,
  CoreClientLeaseRenewParamsSchema,
} from '@canopy/protocol/canopy-core';

import { CanopyOperationError } from '../../runtime/errors';

/** Injected so tests drive lease and idle timers without real time. */
export interface CanopyDaemonClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): { cancel(): void };
}

export const CANOPY_SYSTEM_CLOCK: CanopyDaemonClock = {
  now: () => Date.now(),
  setTimer: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

/** ADR 13a local socket/pipe defaults; runtime configuration, not protocol constants. */
export interface CanopyLeaseOptions {
  readonly minRenewalIntervalMs?: number;
  readonly maxRenewalIntervalMs?: number;
  /** TTL is this many renewal intervals: 60 s at the 15 s default. */
  readonly missedRenewals?: number;
  /** Lease retention after transport close, honoring `previousLeaseId`. */
  readonly reconnectGraceMs?: number;
}

type AcquireParams = CanopySchemaOutput<
  typeof CoreClientLeaseAcquireParamsSchema
>;
type RenewParams = CanopySchemaOutput<typeof CoreClientLeaseRenewParamsSchema>;

export interface CanopyClientLeaseView extends CoreClientLease {
  readonly interfaceKind: AcquireParams['interfaceKind'];
  readonly label: string;
  readonly interactive: boolean;
  readonly foreground: boolean;
}

export type CanopyLeaseEnd = 'released' | 'evicted';

export interface CanopyLeaseRegistry {
  /** Leases held, including ones inside their reconnect grace. */
  readonly size: number;
  lease(connectionId: string): CanopyClientLeaseView | null;
  /** The bound connection; null inside the reconnect grace or once ended. */
  holder(leaseId: string): string | null;
  acquire(connectionId: string, params: AcquireParams): CanopyClientLeaseView;
  renew(connectionId: string, params: RenewParams): CanopyClientLeaseView;
  release(connectionId: string): boolean;
  /** Transport close: the lease survives the reconnect grace, then is evicted. */
  detach(connectionId: string): void;
  /** Fires after a lease ends; the eviction broadcast hangs off this seam. */
  onEnd(
    listener: (lease: CanopyClientLeaseView, end: CanopyLeaseEnd) => void,
  ): () => void;
  onChange(listener: () => void): () => void;
  close(): void;
}

interface LeaseRecord {
  view: CanopyClientLeaseView;
  connectionId: string | null;
  timer: { cancel(): void } | null;
  /** When the pending TTL or grace timer is due, checked again on access. */
  deadline: number;
}

const MAX_REPLAYS = 4_096;
// The catalog lease id bound; this registry issues UUIDs.
const MAX_LEASE_ID_LENGTH = 512;

function leaseError(
  kind: CanopyErrorPayload['kind'],
  code:
    | 'core.client.lease.notFound'
    | 'core.client.lease.invalidState'
    | 'core.client.lease.revisionConflict',
  message: string,
): CanopyOperationError {
  return new CanopyOperationError({
    kind,
    code,
    message,
    // Revision drift is recoverable: re-read the lease, then renew.
    retry:
      code === 'core.client.lease.revisionConflict'
        ? { kind: 'after_refresh', resource: 'core.client.lease' }
        : { kind: 'never' },
  });
}

function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive integer.`);
  return value;
}

/**
 * One lease per authenticated connection. Keyed acquire replays return the
 * original outcome; a released or evicted lease is never rebound (fence).
 */
export function createCanopyLeaseRegistry(
  options: CanopyLeaseOptions = {},
  clock: CanopyDaemonClock = CANOPY_SYSTEM_CLOCK,
): CanopyLeaseRegistry {
  const minInterval = positive(
    'minRenewalIntervalMs',
    options.minRenewalIntervalMs ?? 5_000,
  );
  const maxInterval = positive(
    'maxRenewalIntervalMs',
    options.maxRenewalIntervalMs ?? 60_000,
  );
  if (minInterval > maxInterval)
    throw new RangeError('minRenewalIntervalMs exceeds maxRenewalIntervalMs.');
  const missedRenewals = positive(
    'missedRenewals',
    options.missedRenewals ?? 4,
  );
  const graceMs = positive(
    'reconnectGraceMs',
    options.reconnectGraceMs ?? 10_000,
  );
  const leases = new Map<string, LeaseRecord>();
  const byConnection = new Map<string, LeaseRecord>();
  /** `clientInstanceId\0idempotencyKey` → the acquire's arguments and bound lease. */
  const replays = new Map<string, { args: string; leaseId: string }>();
  const endListeners = new Set<
    (lease: CanopyClientLeaseView, end: CanopyLeaseEnd) => void
  >();
  const changeListeners = new Set<() => void>();
  let closed = false;

  const changed = (): void => changeListeners.forEach((listener) => listener());
  const remember = (key: string, args: string, leaseId: string): void => {
    if (!replays.has(key) && replays.size >= MAX_REPLAYS) {
      const oldest = replays.keys().next();
      if (!oldest.done) replays.delete(oldest.value);
    }
    replays.set(key, { args, leaseId });
  };
  const schedule = (
    record: LeaseRecord,
    delayMs: number,
    end: CanopyLeaseEnd,
  ): void => {
    record.timer?.cancel();
    record.deadline = clock.now() + delayMs;
    record.timer = clock.setTimer(() => finish(record, end), delayMs);
  };
  /** A late timer never lets an expired lease be renewed or rebound. */
  const live = (record: LeaseRecord | undefined): LeaseRecord | undefined => {
    if (record && record.deadline <= clock.now()) finish(record, 'evicted');
    return record && leases.get(record.view.leaseId) === record
      ? record
      : undefined;
  };
  const refresh = (record: LeaseRecord): void => {
    const ttlMs = record.view.renewAfterMs * missedRenewals;
    record.view = {
      ...record.view,
      expiresAt: new Date(clock.now() + ttlMs).toISOString(),
    };
    schedule(record, ttlMs, 'evicted');
  };
  const bind = (record: LeaseRecord, connectionId: string): void => {
    if (record.connectionId !== null) byConnection.delete(record.connectionId);
    record.connectionId = connectionId;
    byConnection.set(connectionId, record);
    refresh(record);
  };
  function finish(record: LeaseRecord, end: CanopyLeaseEnd): void {
    if (leases.get(record.view.leaseId) !== record) return;
    record.timer?.cancel();
    leases.delete(record.view.leaseId);
    if (
      record.connectionId !== null &&
      byConnection.get(record.connectionId) === record
    )
      byConnection.delete(record.connectionId);
    endListeners.forEach((listener) => listener(record.view, end));
    changed();
  }

  return {
    get size(): number {
      return leases.size;
    },
    lease: (connectionId) => live(byConnection.get(connectionId))?.view ?? null,
    holder: (leaseId) => live(leases.get(leaseId))?.connectionId ?? null,
    acquire(connectionId, params): CanopyClientLeaseView {
      if (closed)
        throw new CanopyOperationError({
          kind: 'unavailable',
          message: 'The control plane is closed.',
          retry: { kind: 'never' },
        });
      const { _meta, previousLeaseId, renewalIntervalMs, ...args } = params;
      if ((previousLeaseId?.length ?? 0) > MAX_LEASE_ID_LENGTH)
        throw new CanopyOperationError({
          kind: 'invalid_argument',
          message: 'previousLeaseId is not a lease id.',
          retry: { kind: 'never' },
        });
      const replayKey = `${args.clientInstanceId}\0${_meta.idempotencyKey}`;
      // A fixed-size digest keeps the replay cache bounded in bytes too.
      const fingerprint = createHash('sha256')
        .update(JSON.stringify({ ...args, renewalIntervalMs, previousLeaseId }))
        .digest('base64url');
      const held = live(byConnection.get(connectionId));
      const replay = replays.get(replayKey);
      if (replay && replay.args !== fingerprint)
        throw new CanopyOperationError({
          kind: 'invalid_argument',
          message: 'The idempotency key was used with different arguments.',
          retry: { kind: 'never' },
        });
      const targetId = replay?.leaseId ?? previousLeaseId ?? null;
      const target = targetId === null ? undefined : live(leases.get(targetId));
      if (replay && !target)
        throw leaseError(
          'not_found',
          'core.client.lease.notFound',
          'The lease this acquire bound has ended.',
        );
      if (held) {
        // A held lease is only ever re-acquired as itself, by its own client;
        // any other target or client would orphan one of the two leases.
        if (
          held.view.clientInstanceId !== params.clientInstanceId ||
          (target !== undefined && target !== held)
        )
          throw leaseError(
            'failed_precondition',
            'core.client.lease.invalidState',
            'This connection already holds another client lease.',
          );
        if (!target) {
          remember(replayKey, fingerprint, held.view.leaseId);
          return held.view;
        }
      }
      const renewAfterMs = Math.min(
        maxInterval,
        Math.max(minInterval, renewalIntervalMs),
      );
      let record: LeaseRecord;
      // Retained only for the same client instance; otherwise a new lease.
      if (target && target.view.clientInstanceId === params.clientInstanceId) {
        record = target;
        if (!replay)
          record.view = {
            ...record.view,
            ...args,
            renewAfterMs,
            revision: record.view.revision + 1,
          };
      } else {
        record = {
          view: {
            ...args,
            leaseId: randomUUID(),
            expiresAt: new Date(clock.now()).toISOString(),
            renewAfterMs,
            revision: 0,
          },
          connectionId: null,
          timer: null,
          deadline: Number.POSITIVE_INFINITY,
        };
        leases.set(record.view.leaseId, record);
      }
      bind(record, connectionId);
      remember(replayKey, fingerprint, record.view.leaseId);
      changed();
      return record.view;
    },
    renew(connectionId, params): CanopyClientLeaseView {
      const record = live(byConnection.get(connectionId));
      if (!record)
        throw leaseError(
          'not_found',
          'core.client.lease.notFound',
          'This connection holds no client lease.',
        );
      if (record.view.revision !== params.expectedRevision)
        throw leaseError(
          'conflict',
          'core.client.lease.revisionConflict',
          'The lease revision changed.',
        );
      record.view = {
        ...record.view,
        interactive: params.interactive,
        foreground: params.foreground,
        revision: record.view.revision + 1,
      };
      refresh(record);
      return record.view;
    },
    release(connectionId): boolean {
      const record = live(byConnection.get(connectionId));
      if (!record) return false;
      finish(record, 'released');
      return true;
    },
    detach(connectionId): void {
      const record = live(byConnection.get(connectionId));
      if (!record) return;
      byConnection.delete(connectionId);
      record.connectionId = null;
      schedule(record, graceMs, 'evicted');
      changed();
    },
    onEnd(listener): () => void {
      endListeners.add(listener);
      return () => void endListeners.delete(listener);
    },
    onChange(listener): () => void {
      changeListeners.add(listener);
      return () => void changeListeners.delete(listener);
    },
    close(): void {
      closed = true;
      leases.forEach((record) => record.timer?.cancel());
      leases.clear();
      byConnection.clear();
      replays.clear();
      endListeners.clear();
      changeListeners.clear();
    },
  };
}

/** Background work that keeps an idle daemon alive. Empty through W5 (ADR 5). */
export interface CanopyObligationRegistry {
  readonly size: number;
  /** Returns the idempotent release. */
  hold(reason: string): () => void;
  onChange(listener: () => void): () => void;
}

export function createCanopyObligationRegistry(): CanopyObligationRegistry {
  const held = new Set<object>();
  const listeners = new Set<() => void>();
  const changed = (): void => listeners.forEach((listener) => listener());
  return {
    get size(): number {
      return held.size;
    },
    hold(): () => void {
      const token = {};
      held.add(token);
      changed();
      return () => {
        if (held.delete(token)) changed();
      };
    },
    onChange(listener): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export interface CanopyIdleGraceOptions {
  /** ADR 5: tens of seconds by default; the host tunes it from launch args or preferences. */
  readonly graceMs?: number;
}

/**
 * Calls `onIdle` once after `graceMs` with no lease and no obligation. The
 * grace starts at launch too, so a daemon nobody attaches to still exits.
 */
export function startCanopyIdleGrace(
  leases: Pick<CanopyLeaseRegistry, 'size' | 'onChange'>,
  obligations: Pick<CanopyObligationRegistry, 'size' | 'onChange'>,
  onIdle: () => void,
  options: CanopyIdleGraceOptions = {},
  clock: CanopyDaemonClock = CANOPY_SYSTEM_CLOCK,
): { close(): void } {
  const graceMs = positive('graceMs', options.graceMs ?? 30_000);
  let timer: { cancel(): void } | null = null;
  let done = false;
  const update = (): void => {
    if (done) return;
    if (leases.size + obligations.size > 0) {
      timer?.cancel();
      timer = null;
    } else
      timer ??= clock.setTimer(() => {
        done = true;
        stop();
        onIdle();
      }, graceMs);
  };
  const unsubscribe = [leases.onChange(update), obligations.onChange(update)];
  const stop = (): void => {
    timer?.cancel();
    unsubscribe.forEach((off) => off());
  };
  update();
  return {
    close: (): void => {
      done = true;
      stop();
    },
  };
}
