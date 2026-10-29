/**
 * How much of one route's provider events may be in flight (admitted, their
 * canonical commit not settled yet).
 */
export interface EventPressureLimits {
  /** Admission stops once this many charged bytes are in flight. */
  highWaterBytes: number;
  /** Admission resumes once the charged bytes fall to this. */
  lowWaterBytes: number;
  /**
   * Measure an event the cheap estimate cannot size by serializing it,
   * instead of giving it the gate alone.
   */
  measureExactly: boolean;
  /**
   * Keep arrival order for a producer that does not await each admission:
   * while a grant is on its way to a waiting event, an event that fits is
   * granted through a promise queued behind it instead of synchronously.
   */
  preserveHandOffOrder: boolean;
}

/**
 * The default: 64 KiB of estimated bytes, and an event the estimate cannot
 * size holds the gate alone. Such events are therefore committed one at a
 * time.
 */
const DEFAULT_LIMITS: EventPressureLimits = {
  highWaterBytes: 64 * 1024,
  lowWaterBytes: 32 * 1024,
  measureExactly: false,
  preserveHandOffOrder: false,
};

/**
 * While chat storage group-commits (the delta-journal experiment), several
 * commits of one chat are in flight together and share a journal sync, so
 * the bound is on bytes, not on one event at a time: 256 KiB in flight per
 * chat, a quarter of a group-commit batch, resuming at half. An event the
 * estimate cannot size is measured by its serialized length; one above the
 * bound, or that cannot be serialized, still holds the gate alone. The
 * producers then send events without awaiting each admission (the Codex
 * lane's in-flight budget), so the gate also keeps their arrival order.
 */
export const GROUP_COMMIT_EVENT_PRESSURE_LIMITS: EventPressureLimits = {
  highWaterBytes: 256 * 1024,
  lowWaterBytes: 128 * 1024,
  measureExactly: true,
  preserveHandOffOrder: true,
};
const ESTIMATE_NODE_LIMIT = 64;
const ESTIMATE_DEPTH_LIMIT = 4;

interface Charge {
  bytes: number;
  uncertain: boolean;
  /** Admitted only with nothing in flight, and nothing admitted behind it until released. */
  alone?: boolean;
}

/** How one event is admitted. */
export interface EventPressureAdmission {
  /**
   * Hold the gate alone, whatever its size: the event waits for every event
   * in flight, and none is admitted behind it until it is released. For an
   * event whose follow-up must be queued before any later provider event.
   */
  alone?: boolean;
}

interface WaitingAdmission {
  charge: Charge;
  queuedAt: number;
  resolve: (release: () => void) => void;
}

interface ActiveAdmission {
  admittedAt: number;
  previous?: ActiveAdmission;
  next?: ActiveAdmission;
}

/**
 * A cheap upper estimate for ordinary provider JSON, with an exclusive
 * admission for shapes whose size cannot be established within the budget.
 */
function estimateCharge(value: unknown): Charge {
  const seen = new Set<object>();
  let visited = 0;
  let uncertain = false;
  const visit = (current: unknown, depth: number): number => {
    if (++visited > ESTIMATE_NODE_LIMIT || depth > ESTIMATE_DEPTH_LIMIT) {
      uncertain = true;
      return 0;
    }
    if (typeof current === 'string') return current.length * 6 + 2;
    // JSON object fields with undefined are omitted; array entries become
    // null. Either way they are small and do not imply an opaque payload.
    if (current === undefined) return 16;
    if (
      current === null ||
      typeof current === 'number' ||
      typeof current === 'boolean'
    ) {
      return 32;
    }
    if (typeof current !== 'object' || seen.has(current)) {
      uncertain = true;
      return 0;
    }
    seen.add(current);
    try {
      if (
        !Array.isArray(current) &&
        Object.getPrototypeOf(current) !== Object.prototype
      ) {
        uncertain = true;
        return 0;
      }
      let bytes = 64;
      if (Array.isArray(current)) {
        // Holes serialize as null even though for-in visits no index for them.
        // Large/dense arrays also exceed this estimator's bounded work budget.
        if (current.length > ESTIMATE_NODE_LIMIT - visited) {
          uncertain = true;
          return bytes;
        }
        bytes += current.length * 5;
      }
      for (const key in current) {
        if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !('value' in descriptor)) {
          uncertain = true;
          return 0;
        }
        bytes += key.length * 6 + visit(descriptor.value, depth + 1);
        if (uncertain) return bytes;
      }
      return bytes;
    } catch {
      uncertain = true;
      return 0;
    }
  };
  const bytes = visit(value, 0);
  return { bytes: Math.max(1, bytes), uncertain };
}

/** The exact serialized size of an event the estimate could not establish. */
function measureCharge(value: unknown, estimate: Charge): Charge {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string') return estimate;
    return {
      bytes: Math.max(1, Buffer.byteLength(text, 'utf8')),
      uncertain: false,
    };
  } catch {
    // Not serializable (a cycle, a throwing getter): size unknown.
    return estimate;
  }
}

/**
 * One route owns one charge per provider event, across arbitration and its
 * canonical persistence queue. An oversized/uncertain event has an exclusive
 * slot. The producer must await an admission promise before sending more.
 */
export class EventPressureGate {
  private chargedBytes = 0;
  private activeCount = 0;
  private activeUncertainCount = 0;
  private exclusive = false;
  private paused = false;
  /**
   * Grants resolved to a waiter whose continuation has not run yet. Counted
   * only while the limits in effect ask for hand-off order.
   */
  private handoffs = 0;
  private readonly waiting: Array<WaitingAdmission | undefined> = [];
  private waitingHead = 0;
  private uncertainWaitingCount = 0;
  private oldestActive?: ActiveAdmission;
  private newestActive?: ActiveAdmission;
  private readonly drainWaiters = new Set<() => void>();

  /**
   * `limits` is read at every admission and release, so a change of the
   * experiment applies to the next event. Undefined: the default limits.
   */
  constructor(
    private readonly limits: () => EventPressureLimits | undefined = () =>
      undefined,
  ) {}

  private current(): EventPressureLimits {
    return this.limits() ?? DEFAULT_LIMITS;
  }

  admit(
    value: unknown,
    admission: EventPressureAdmission = {},
  ): (() => void) | Promise<() => void> {
    const estimate = estimateCharge(value);
    const limits = this.current();
    const measured =
      estimate.uncertain && limits.measureExactly
        ? measureCharge(value, estimate)
        : estimate;
    const charge: Charge =
      admission.alone === true ? { ...measured, alone: true } : measured;
    if (this.waiting.length === this.waitingHead && this.canAdmit(charge)) {
      // The default limits: granted synchronously, as before group commit.
      if (!limits.preserveHandOffOrder || this.handoffs === 0)
        return this.grant(charge);
      // A grant handed to an earlier waiter has not reached it yet (its
      // continuation is a queued microtask). Granting this event
      // synchronously would let it overtake that waiter, so it is granted
      // through a promise whose continuation is queued behind it.
      return this.handOff(this.grant(charge));
    }
    this.paused = true;
    return new Promise<() => void>((resolve) => {
      this.waiting.push({ charge, queuedAt: Date.now(), resolve });
      if (charge.uncertain) this.uncertainWaitingCount += 1;
      this.pump();
    });
  }

  drain(): Promise<void> {
    if (this.activeCount === 0 && this.waiting.length === this.waitingHead) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.drainWaiters.add(resolve));
  }

  snapshot(): {
    chargedBytes: number;
    activeCount: number;
    waitingCount: number;
    waitingStorageSlots: number;
    oldestAgeMs: number;
    activeUncertainCount: number;
    uncertainWaitingCount: number;
  } {
    const oldestQueuedAt = this.waiting[this.waitingHead]?.queuedAt;
    const oldestActiveAt = this.oldestActive?.admittedAt;
    const oldestAt =
      oldestQueuedAt === undefined
        ? oldestActiveAt
        : oldestActiveAt === undefined
          ? oldestQueuedAt
          : Math.min(oldestQueuedAt, oldestActiveAt);
    return {
      chargedBytes: this.chargedBytes,
      activeCount: this.activeCount,
      waitingCount: this.waiting.length - this.waitingHead,
      waitingStorageSlots: this.waiting.length,
      oldestAgeMs: oldestAt === undefined ? 0 : Date.now() - oldestAt,
      activeUncertainCount: this.activeUncertainCount,
      uncertainWaitingCount: this.uncertainWaitingCount,
    };
  }

  /**
   * A waiter was just resolved with its grant. Its continuation runs as a
   * microtask queued at that moment; the hand-off ends right after it, with
   * a microtask queued here, behind it.
   */
  private noteHandoff(): void {
    this.handoffs += 1;
    queueMicrotask(() => {
      this.handoffs -= 1;
    });
  }

  private handOff(release: () => void): Promise<() => void> {
    // The caller attaches its continuation after this returns, so the
    // hand-off ends one microtask later than for a waiter.
    this.handoffs += 1;
    queueMicrotask(() =>
      queueMicrotask(() => {
        this.handoffs -= 1;
      }),
    );
    return Promise.resolve(release);
  }

  private canAdmit(charge: Charge): boolean {
    if (this.exclusive || this.paused) return false;
    const { highWaterBytes } = this.current();
    if (
      charge.uncertain ||
      charge.alone === true ||
      charge.bytes > highWaterBytes
    ) {
      return this.activeCount === 0;
    }
    return this.chargedBytes + charge.bytes <= highWaterBytes;
  }

  private grant(charge: Charge): () => void {
    const admission: ActiveAdmission = {
      admittedAt: Date.now(),
      previous: this.newestActive,
    };
    if (this.newestActive) this.newestActive.next = admission;
    else this.oldestActive = admission;
    this.newestActive = admission;
    this.activeCount += 1;
    if (charge.uncertain) this.activeUncertainCount += 1;
    this.chargedBytes += charge.bytes;
    const { highWaterBytes } = this.current();
    const exclusive =
      charge.uncertain ||
      charge.alone === true ||
      charge.bytes > highWaterBytes;
    if (exclusive) this.exclusive = true;
    if (this.chargedBytes >= highWaterBytes || exclusive) this.paused = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeCount -= 1;
      if (charge.uncertain) this.activeUncertainCount -= 1;
      this.chargedBytes -= charge.bytes;
      if (admission.previous) admission.previous.next = admission.next;
      else this.oldestActive = admission.next;
      if (admission.next) admission.next.previous = admission.previous;
      else this.newestActive = admission.previous;
      // The caller may retain an idempotent release closure after settlement.
      // Clear its node links so that closure cannot retain older active work.
      admission.previous = undefined;
      admission.next = undefined;
      if (exclusive) this.exclusive = false;
      if (this.chargedBytes <= this.current().lowWaterBytes)
        this.paused = false;
      this.pump();
      if (this.activeCount === 0 && this.waiting.length === this.waitingHead) {
        for (const resolve of Array.from(this.drainWaiters)) resolve();
        this.drainWaiters.clear();
      }
    };
  }

  private pump(): void {
    while (this.waitingHead < this.waiting.length) {
      const next = this.waiting[this.waitingHead];
      if (!next || !this.canAdmit(next.charge)) break;
      this.waiting[this.waitingHead] = undefined;
      this.waitingHead += 1;
      if (next.charge.uncertain) this.uncertainWaitingCount -= 1;
      next.resolve(this.grant(next.charge));
      if (this.current().preserveHandOffOrder) this.noteHandoff();
    }
    if (this.waitingHead === this.waiting.length) {
      this.waiting.length = 0;
      this.waitingHead = 0;
    } else if (
      this.waitingHead > 1024 &&
      this.waitingHead * 2 >= this.waiting.length
    ) {
      this.waiting.splice(0, this.waitingHead);
      this.waitingHead = 0;
    }
  }
}
