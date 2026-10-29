import type {
  CanopySchemaInput,
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CoreClientLease,
} from '@canopy/protocol/canopy-core';

import { CanopyClientError, toCanopyClientError } from './errors';
import type { CanopyClient } from './types';

type LeaseInstructions = Pick<
  typeof CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  | 'core.client.lease.acquire'
  | 'core.client.lease.renew'
  | 'core.client.lease.release'
>;
type Params<N extends keyof LeaseInstructions> = CanopySchemaInput<
  LeaseInstructions[N]['params']
>;

export type CanopyLeaseClient = Pick<
  CanopyClient<Record<never, never>, LeaseInstructions, Record<never, never>>,
  'instruction' | 'signal' | 'close'
> &
  Partial<Pick<CanopyClient, 'onLeaseEvicted'>>;
export type CanopyClientLeaseIdentity = Pick<
  Params<'core.client.lease.acquire'>,
  'clientInstanceId' | 'interfaceKind' | 'label'
>;
export type CanopyClientLeasePresence = Pick<
  Params<'core.client.lease.renew'>,
  'interactive' | 'foreground'
>;
export type CanopyClientLeaseReleaseReason =
  Params<'core.client.lease.release'>['reason'];
export type CanopyClientLeaseState =
  | 'idle'
  | 'acquiring'
  | 'active'
  | 'reconnecting'
  | 'released'
  | 'failed';
export type CanopyClientLeaseRegistration<C> = (
  lease: CoreClientLease,
  client: C,
) => void | Promise<void>;

export interface CanopyClientLeaseOptions<C extends CanopyLeaseClient> {
  /** The connected client; the host keeps ownership. */
  readonly client: C;
  /** Opens a replacement client after the current connection drops. */
  readonly attach: () => Promise<C>;
  /** Stable across reconnects and re-acquires. */
  readonly identity: CanopyClientLeaseIdentity;
  /** Proposal only: timing follows each reply's `renewAfterMs` and `expiresAt`. */
  readonly renewalIntervalMs: number;
  /** Read for each new acquisition and renewal. */
  readonly presence: () => CanopyClientLeasePresence;
  /** Reconnects within this window send `previousLeaseId`. Default 10 000 ms. */
  readonly reconnectGraceMs?: number;
  /** Bounds the whole release cleanup: drain, replay, release. Default 5 000 ms. */
  readonly releaseTimeoutMs?: number;
  readonly onError?: (error: CanopyClientError) => void;
}

export interface CanopyClientLease<C extends CanopyLeaseClient> {
  readonly state: CanopyClientLeaseState;
  readonly lease: CoreClientLease | null;
  /** The latest adopted client, for host calls and closing. */
  readonly client: C;
  /** Starts the lifecycle once; resolves with the first lease. */
  acquire(): Promise<CoreClientLease>;
  /** Issues `issue` once per new lease id, by key; the returned function removes it. */
  register(key: string, issue: CanopyClientLeaseRegistration<C>): () => void;
  /** Host eviction seam; ids other than the current lease are ignored. */
  notifyEvicted(leaseId: string): void;
  /** Renews now if the wall clock passed the renew point, e.g. on host resume. */
  checkClock(): void;
  /** Idempotent; stops all timers and listeners. */
  release(reason: CanopyClientLeaseReleaseReason): Promise<void>;
}

const ACQUIRE = 'core.client.lease.acquire';
const RENEW = 'core.client.lease.renew';
const RELEASE = 'core.client.lease.release';
const NOT_FOUND = 'core.client.lease.notFound';
const INVALID_STATE = 'core.client.lease.invalidState';
const REVISION_CONFLICT = 'core.client.lease.revisionConflict';
const DEFAULT_RECONNECT_GRACE_MS = 10_000;
const DEFAULT_RELEASE_TIMEOUT_MS = 5_000;
const RETRY_DELAY_MS = 1_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

type AcquireParams = Params<'core.client.lease.acquire'>;
type RenewParams = Params<'core.client.lease.renew'>;
type Phase =
  | 'idle'
  | 'acquiring'
  | 'active'
  | 'renewing'
  | 'recovering'
  | 'released';
/** Each phase's successors; an event moving anywhere else is stale and dropped. */
const TRANSITIONS: Record<Phase, readonly Phase[]> = {
  idle: ['acquiring', 'recovering', 'released'],
  acquiring: ['acquiring', 'active', 'recovering', 'released'],
  active: ['renewing', 'acquiring', 'recovering', 'released'],
  renewing: ['renewing', 'active', 'acquiring', 'recovering', 'released'],
  recovering: ['acquiring', 'released'],
  released: [],
};

/** `issuedFor`: the lease id of a success; `tried`: the epoch last attempted. */
type Entry<C> = {
  issue: CanopyClientLeaseRegistration<C>;
  issuedFor?: string;
  tried?: number;
};
type Mark = { readonly mono: number; readonly wall: number };
/** The renew point, and the watchdog step that notices wall-clock jumps. */
type Due = Mark & { readonly step: number };
/**
 * One keyed acquisition, with exact params for every replay. Its outcome is
 * unknown, even after an error, until a reply binds a lease.
 */
type Intent<C> = {
  readonly params: AcquireParams;
  bound?: Known<C>;
  /** Its retained lease was evicted: resolve it, then acquire fresh. */
  superseded?: boolean;
};
/** The acknowledged lease, its connection, and when that connection dropped. */
type Known<C> = {
  readonly lease: CoreClientLease;
  readonly client: C;
  readonly params: AcquireParams;
  dropped?: Mark;
};

const monotonic = (): number => performance.now();
const mark = (afterMs = 0): Mark => ({
  mono: monotonic() + afterMs,
  wall: Date.now() + afterMs,
});
const ignore = (): void => {};
const terminalError = (
  kind: 'cancelled' | 'deadline_exceeded',
  message: string,
): CanopyClientError =>
  new CanopyClientError({ kind, message, retry: { kind: 'never' } });

class LeaseOwner<C extends CanopyLeaseClient> implements CanopyClientLease<C> {
  client: C;
  private phase: Phase = 'idle';
  /** Bumped entering acquiring, recovering, or released; older results are stale. */
  private epoch = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private due: Due | null = null;
  /** The newest acquisition; only a resolved one is ever replaced. */
  private intent: Intent<C> | null = null;
  private known: Known<C> | null = null;
  private readonly owned = new Map<string, Known<C>>();
  private terminal: { error: CanopyClientError; failed: boolean } | null = null;
  private cleanup: Promise<void> | null = null;
  private replaying: number | null = null;
  /** Every lease write not yet answered; release drains them first. */
  private readonly pending = new Set<Promise<unknown>>();
  private unlisten: () => void = ignore;
  private ready: Promise<CoreClientLease> | null = null;
  private settle: {
    resolve: (lease: CoreClientLease) => void;
    reject: (error: CanopyClientError) => void;
  } | null = null;
  private readonly entries = new Map<string, Entry<C>>();

  constructor(private readonly options: CanopyClientLeaseOptions<C>) {
    this.client = options.client;
  }

  get state(): CanopyClientLeaseState {
    const { phase, terminal } = this;
    if (terminal) return terminal.failed ? 'failed' : 'released';
    if (phase === 'renewing') return 'active';
    return phase === 'recovering' ? 'reconnecting' : phase;
  }

  get lease(): CoreClientLease | null {
    const live = this.phase === 'active' || this.phase === 'renewing';
    return live ? (this.known?.lease ?? null) : null;
  }

  acquire(): Promise<CoreClientLease> {
    if (this.terminal) return Promise.reject(this.terminal.error);
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      this.settle = { resolve, reject };
    });
    this.ready.catch(ignore);
    this.watch(this.client);
    if (this.client.signal.aborted) this.dropped(this.client);
    else this.fresh(null);
    return this.ready;
  }

  register(key: string, issue: CanopyClientLeaseRegistration<C>): () => void {
    const entry: Entry<C> = { issue };
    this.entries.set(key, entry);
    void this.replay();
    return () => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    };
  }

  notifyEvicted(leaseId: string): void {
    const { intent, known } = this;
    if (intent && !intent.bound && intent.params.previousLeaseId === leaseId)
      intent.superseded = true;
    if (known?.lease.leaseId !== leaseId) return;
    this.owned.delete(leaseId);
    const live = this.lease !== null;
    this.known = null;
    if (live) this.fresh(null);
  }

  checkClock(): void {
    const { due } = this;
    if (this.phase !== 'active' || !due) return;
    if (monotonic() >= due.mono || Date.now() >= due.wall)
      this.renew(null, false);
    else this.arm();
  }

  /** Terminal at once; its single cleanup never reactivates the owner. */
  release(reason: CanopyClientLeaseReleaseReason): Promise<void> {
    if (this.cleanup) return this.cleanup;
    const { client } = this;
    const pending = Array.from(this.pending);
    const open = this.intent?.bound ? null : this.intent;
    // A failed owner keeps its original error.
    this.end(terminalError('cancelled', 'The client lease was released.'));
    this.cleanup = client.signal.aborted
      ? Promise.resolve()
      : this.clean(reason, client, pending, open);
    return this.cleanup;
  }

  /**
   * One bounded pass: drain submitted writes, replay an unresolved acquire
   * once with its exact key, then release what this connection may hold, even
   * after a failed replay. Expiry, checked after every await, stops it; the
   * daemon's eviction owns any remainder.
   */
  private async clean(
    reason: CanopyClientLeaseReleaseReason,
    client: C,
    pending: Promise<unknown>[],
    open: Intent<C> | null,
  ): Promise<void> {
    const budget = new AbortController();
    const { signal } = budget;
    const timeout = terminalError('deadline_exceeded', 'Release timed out.');
    const ms = this.options.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS;
    const deadline = monotonic() + ms;
    // The timer aborts a stalled call; this check covers a starved timer.
    const live = (): void => {
      if (monotonic() >= deadline) budget.abort(timeout);
      signal.throwIfAborted();
    };
    const expired = new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    const timer = setTimeout(() => budget.abort(timeout), ms);
    const report = (error: unknown): void => {
      const failure = toCanopyClientError(signal.aborted ? timeout : error);
      if (failure.payload.code !== NOT_FOUND) this.report(failure);
    };
    try {
      await Promise.race([Promise.allSettled(pending), expired]);
      live();
      if (open && !open.bound) {
        try {
          const lease = await client.instruction(ACQUIRE, open.params, {
            signal,
          });
          open.bound = this.learn(lease, client, open.params);
        } catch (error) {
          live();
          report(error);
        }
      }
      live();
      // RELEASE is connection-scoped: drain live bindings before rebinding old ones.
      const connected = new Set(
        Array.from(this.owned.values(), (held) => held.client).filter(
          (connection) => connection === client || !connection.signal.aborted,
        ),
      );
      for (const connection of Array.from(connected)) {
        try {
          live();
          await connection.instruction(RELEASE, { reason }, { signal });
          live();
          for (const [id, held] of Array.from(this.owned))
            if (held.client === connection) this.owned.delete(id);
        } catch (error) {
          live();
          report(error);
        }
      }
      for (const held of Array.from(this.owned.values())) {
        if (client.signal.aborted) break;
        if (!held.client.signal.aborted) continue;
        try {
          live();
          const lease = await client.instruction(ACQUIRE, held.params, {
            signal,
          });
          this.learn(lease, client, held.params);
          live();
          await client.instruction(RELEASE, { reason }, { signal });
          live();
          this.owned.delete(lease.leaseId);
        } catch (error) {
          live();
          report(error);
        }
      }
    } catch (error) {
      report(error);
    } finally {
      clearTimeout(timer);
    }
  }

  /** A distinct acquisition: a new key, fixed for every replay until resolved. */
  private fresh(previousLeaseId: string | null): void {
    if (!this.to('acquiring')) return;
    let presence: CanopyClientLeasePresence;
    try {
      presence = this.presence();
    } catch (error) {
      return this.fail(toCanopyClientError(error));
    }
    const { identity, renewalIntervalMs } = this.options;
    this.intent = {
      params: {
        clientInstanceId: identity.clientInstanceId,
        interfaceKind: identity.interfaceKind,
        label: identity.label,
        ...presence,
        renewalIntervalMs,
        ...(previousLeaseId === null ? {} : { previousLeaseId }),
        _meta: { idempotencyKey: crypto.randomUUID() },
      },
    };
    void this.submit(this.intent);
  }

  private async submit(intent: Intent<C>): Promise<void> {
    const { client, epoch } = this;
    let lease: CoreClientLease;
    try {
      lease = await this.track(client.instruction(ACQUIRE, intent.params));
    } catch (error) {
      // A drop or release now owns the still-unresolved intent.
      if (epoch !== this.epoch || client.signal.aborted) return;
      // Superseded or not, an error leaves the outcome unknown: directives rule.
      const failure = toCanopyClientError(error);
      const again = (): void => void this.submit(intent);
      return this.retryOrFail(failure, 'same_idempotency_key', again);
    }
    const held = this.learn(lease, client, intent.params);
    intent.bound = held;
    if (epoch !== this.epoch) return;
    if (intent.superseded) return this.fresh(null);
    this.adopt(held);
    this.settle?.resolve(lease);
  }

  /** `sent`: the exact arguments of a failed renew, replayed on `same_request`. */
  private renew(sent: RenewParams | null, conflictRetried: boolean): void {
    const { known, client } = this;
    if (!known || !this.to('renewing')) return;
    let args: RenewParams;
    try {
      args = sent ?? {
        expectedRevision: known.lease.revision,
        ...this.presence(),
      };
    } catch (error) {
      return this.fail(toCanopyClientError(error));
    }
    const { epoch } = this;
    void this.track(client.instruction(RENEW, args)).then(
      (lease) => {
        const held = this.learn(lease, client, known.params);
        if (epoch === this.epoch) this.adopt(held);
      },
      (error: unknown) => {
        if (epoch !== this.epoch || client.signal.aborted) return;
        this.renewFailed(toCanopyClientError(error), args, conflictRetried);
      },
    );
  }

  private renewFailed(
    failure: CanopyClientError,
    args: RenewParams,
    conflictRetried: boolean,
  ): void {
    const { code, retry } = failure.payload;
    if (retry.kind !== 'after_refresh') {
      // Both mean the core no longer holds this lease: an observed eviction.
      if (code === NOT_FOUND || code === INVALID_STATE) {
        if (this.known) this.owned.delete(this.known.lease.leaseId);
        this.known = null;
        return this.fresh(null);
      }
      if (code === REVISION_CONFLICT)
        return conflictRetried ? this.fresh(null) : this.renew(null, true);
    }
    const again = (): void => this.renew(args, conflictRetried);
    this.retryOrFail(failure, 'same_request', again);
  }

  /** Every reply is owned before binding an intent or checking its epoch. */
  private learn(
    lease: CoreClientLease,
    client: C,
    params: AcquireParams,
  ): Known<C> {
    const previous = this.owned.get(lease.leaseId);
    // A late disconnected reply cannot replace a newer connected binding.
    if (previous && client.signal.aborted && !previous.client.signal.aborted)
      return previous;
    const held: Known<C> = { lease, client, params };
    this.owned.set(lease.leaseId, held);
    return held;
  }

  private adopt(held: Known<C>): void {
    if (!this.to('active')) return;
    this.known = held;
    const { lease } = held;
    const { renewAfterMs } = lease;
    const { mono, wall } = mark(renewAfterMs);
    const expires = Date.parse(lease.expiresAt);
    // An expiry already past on our clock is skew, not a deadline.
    const byExpiry = expires > wall - renewAfterMs ? expires : wall;
    const step = Math.ceil(renewAfterMs / 4);
    this.due = { mono, wall: Math.min(wall, byExpiry), step };
    this.arm();
    void this.replay();
  }

  private arm(): void {
    clearTimeout(this.timer);
    const { due } = this;
    if (!due) return;
    const delay = Math.min(
      due.mono - monotonic(),
      due.wall - Date.now(),
      due.step,
      MAX_TIMER_MS,
    );
    this.timer = setTimeout(() => this.checkClock(), Math.max(0, delay));
  }

  private watch(client: C): void {
    this.unlisten();
    const onAbort = (): void => this.dropped(client);
    const offEvicted = client.onLeaseEvicted?.(({ leaseId }) => {
      if (client === this.client) this.notifyEvicted(leaseId);
    });
    client.signal.addEventListener('abort', onAbort, { once: true });
    this.unlisten = (): void => {
      client.signal.removeEventListener('abort', onAbort);
      offEvicted?.();
    };
  }

  private dropped(client: C): void {
    if (client !== this.client || !this.to('recovering')) return;
    const { known } = this;
    if (known?.client === client) known.dropped ??= mark();
    void this.reconnect(this.epoch);
  }

  private async reconnect(epoch: number): Promise<void> {
    let client: C;
    try {
      client = await this.options.attach();
    } catch (error) {
      if (epoch !== this.epoch) return;
      const failure = toCanopyClientError(error);
      const again = (): void => void this.reconnect(epoch);
      return this.retryOrFail(failure, 'same_request', again);
    }
    if (epoch !== this.epoch || client.signal.aborted) {
      // Never adopted, so ours to close; a dead current attach is retried.
      void client.close().catch(ignore);
      const retry = (): void => void this.reconnect(epoch);
      if (epoch === this.epoch) this.timer = setTimeout(retry, RETRY_DELAY_MS);
      return;
    }
    this.client = client;
    this.watch(client);
    const { intent, known } = this;
    // An unresolved acquire replays unchanged first, whatever the grace.
    if (intent && !intent.bound) {
      if (this.to('acquiring')) void this.submit(intent);
      return;
    }
    const dropped = known?.dropped;
    // The later of both clocks: a paused laptop's wall clock moved on.
    const elapsed = dropped
      ? Math.max(monotonic() - dropped.mono, Date.now() - dropped.wall)
      : Infinity;
    const grace = this.options.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS;
    this.fresh(known && elapsed <= grace ? known.lease.leaseId : null);
  }

  /**
   * Issues registrations in insertion order, one at a time, at most once per
   * epoch: a failure waits for the next lease or connection. A result
   * landing after the epoch moved on is dropped, so it is issued again.
   */
  private async replay(): Promise<void> {
    const { epoch } = this;
    if (this.replaying === epoch) return;
    this.replaying = epoch;
    try {
      while (epoch === this.epoch) {
        const { lease, client } = this;
        if (!lease) return;
        const entry = Array.from(this.entries.values()).find(
          (candidate) =>
            candidate.issuedFor !== lease.leaseId && candidate.tried !== epoch,
        );
        if (!entry) return;
        entry.tried = epoch;
        try {
          await entry.issue(lease, client);
          if (epoch === this.epoch) entry.issuedFor = lease.leaseId;
        } catch (error) {
          this.report(toCanopyClientError(error));
        }
      }
    } finally {
      if (this.replaying === epoch) this.replaying = null;
    }
  }

  /** No refresh operation: after_refresh reaches the host intact. */
  private retryOrFail(
    error: CanopyClientError,
    replayable: 'same_request' | 'same_idempotency_key',
    again: () => void,
  ): void {
    const directive = error.payload.retry;
    if (directive.kind !== replayable) return this.fail(error);
    // Effects land before onError, so its release clears them.
    const { epoch } = this;
    const retry = (): void => void (epoch === this.epoch && again());
    this.timer = setTimeout(retry, directive.delayMs ?? RETRY_DELAY_MS);
    this.report(error);
  }

  /** Moves along TRANSITIONS; false when the event is stale for this phase. */
  private to(next: Phase): boolean {
    if (!TRANSITIONS[this.phase].includes(next)) return false;
    clearTimeout(this.timer);
    if (next !== 'active' && next !== 'renewing') {
      this.epoch += 1;
      this.due = null;
    }
    this.phase = next;
    return true;
  }

  private fail(error: CanopyClientError): void {
    this.end(error, true);
    this.report(error);
  }

  /** The first terminal cause wins; intent and lease stay for cleanup. */
  private end(error: CanopyClientError, failed = false): void {
    if (this.terminal || !this.to('released')) return;
    this.terminal = { error, failed };
    this.unlisten();
    this.unlisten = ignore;
    this.settle?.reject(error);
  }

  private track<T>(request: Promise<T>): Promise<T> {
    this.pending.add(request);
    const clear = (): void => void this.pending.delete(request);
    request.then(clear, clear);
    return request;
  }

  private presence(): CanopyClientLeasePresence {
    const { interactive, foreground } = this.options.presence();
    return { interactive, foreground };
  }

  private report(error: CanopyClientError): void {
    try {
      this.options.onError?.(error);
    } catch {
      // A throwing listener must not break the lifecycle.
    }
  }
}

export function createCanopyClientLease<C extends CanopyLeaseClient>(
  options: CanopyClientLeaseOptions<C>,
): CanopyClientLease<C> {
  return new LeaseOwner(options);
}
