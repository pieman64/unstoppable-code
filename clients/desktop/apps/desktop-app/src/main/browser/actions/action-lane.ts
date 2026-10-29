/** Serializes agent input for one live browser runtime, never user input or reads. */

export type ActionLaneNotExecutedReason =
  | 'cancelled'
  | 'timeout'
  | 'runtime_lost'
  | 'quarantined'
  | 'execution_failed';

export type ActionLaneUnknownReason =
  | 'stopped_after_dispatch'
  | 'dispatch_timeout'
  | 'runtime_lost';

export type ActionLaneOutcome<T> =
  | { status: 'executed'; sequence: number; value: T }
  | {
      status: 'not_executed';
      sequence: number;
      reason: ActionLaneNotExecutedReason;
      code: 'cancelled' | 'timeout' | 'execution_failed';
      message: string;
    }
  | {
      status: 'outcome_unknown';
      sequence: number;
      reason: ActionLaneUnknownReason;
      detail?: string;
    };

export interface ActionLaneContext {
  readonly signal: AbortSignal;
  readonly sequence: number;
  /** Call synchronously immediately before the first state-changing command. */
  readonly beginDispatch: () => void;
  /** Track every command issued after the dispatch boundary, including releases. */
  readonly trackCommand: <T>(command: Promise<T>) => Promise<T>;
  readonly registerCleanup: (cleanup: () => void | Promise<void>) => void;
}

export interface ActionLaneOptions {
  readonly runtimeKey: object;
  readonly generation: number;
  readonly isCurrent: (runtimeKey: object, generation: number) => boolean;
  readonly drainTimeoutMs?: number;
  readonly sequence?: ActionLaneSequence;
}

export interface ActionLaneRunOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly drainTimeoutMs?: number;
}

type StopReason = 'aborted' | 'timeout' | 'runtime_lost' | 'disposed';

interface QueueEntry {
  start(): Promise<void>;
  refuse(): void;
}

type ActionResult<T> =
  | { kind: 'completed'; value: T }
  | { kind: 'failed'; error: unknown }
  | { kind: 'stopped'; reason: StopReason };

const DRAIN_BOUND_MS = 10_000;
const RECOVERING_MESSAGE = 'Browser input is recovering. Try again shortly.';

export class ActionLanePreDispatchError extends Error {
  constructor(
    readonly reason:
      | 'cancelled'
      | 'timeout'
      | 'runtime_lost'
      | 'execution_failed',
  ) {
    super(`Browser action rejected before dispatch: ${reason}`);
  }
}

export class ActionLaneDispatchTimeoutError extends Error {}

/** One sequence source per browser runtime generation, including independent reads. */
export class ActionLaneSequence {
  private value = 0;

  next(): number {
    this.value += 1;
    return this.value;
  }
}

class CommandTracker {
  private readonly commands = new Set<Promise<unknown>>();
  private readonly waiters = new Set<() => void>();

  get pending(): number {
    return this.commands.size;
  }

  track<T>(command: Promise<T>): Promise<T> {
    this.commands.add(command);
    const settled = (): void => {
      this.commands.delete(command);
      this.waiters.forEach((waiter) => waiter());
    };
    void command.then(settled, settled);
    return command;
  }

  async waitForChange(): Promise<void> {
    if (this.commands.size === 0) return;
    await new Promise<void>((resolve) => {
      const notify = (): void => {
        this.waiters.delete(notify);
        resolve();
      };
      this.waiters.add(notify);
    });
  }

  onEmpty(callback: () => void): void {
    if (this.commands.size === 0) {
      callback();
      return;
    }
    const check = (): void => {
      if (this.commands.size !== 0) return;
      this.waiters.delete(check);
      callback();
    };
    this.waiters.add(check);
  }
}

export class ActionLane {
  readonly runtimeKey: object;
  readonly generation: number;

  private readonly isCurrent: ActionLaneOptions['isCurrent'];
  private readonly drainTimeoutMs: number;
  private readonly sequence: ActionLaneSequence;
  private readonly queue: QueueEntry[] = [];
  private busy = false;
  private disposed = false;
  private quarantined = false;
  private attributedSequence: number | null = null;
  private stopActive: ((reason: StopReason) => void) | null = null;

  constructor(options: ActionLaneOptions) {
    this.runtimeKey = options.runtimeKey;
    this.generation = options.generation;
    this.isCurrent = options.isCurrent;
    this.drainTimeoutMs = options.drainTimeoutMs ?? DRAIN_BOUND_MS;
    this.sequence = options.sequence ?? new ActionLaneSequence();
  }

  /** Reserves an ordered sequence without entering or waiting for the input queue. */
  reserveSequence(): number {
    return this.sequence.next();
  }

  currentAction(): number | null {
    return this.attributedSequence;
  }

  runRead<T>(read: () => T | Promise<T>): Promise<T> {
    return Promise.resolve().then(read);
  }

  run<T>(
    action: (context: ActionLaneContext) => T | Promise<T>,
    options: ActionLaneRunOptions = {},
  ): Promise<ActionLaneOutcome<T>> {
    const sequence = this.reserveSequence();
    if (this.disposed || this.quarantined)
      return Promise.resolve(
        this.notExecuted(
          sequence,
          this.quarantined && !this.disposed ? 'quarantined' : 'runtime_lost',
          this.refusalMessage(),
        ),
      );
    if (options.signal?.aborted)
      return Promise.resolve(this.notExecuted(sequence, 'cancelled'));

    return new Promise<ActionLaneOutcome<T>>((resolve) => {
      let settled = false;
      const onQueuedAbort = (): void => {
        if (settled) return;
        const index = this.queue.indexOf(entry);
        if (index < 0) return;
        this.queue.splice(index, 1);
        settled = true;
        options.signal?.removeEventListener('abort', onQueuedAbort);
        resolve(this.notExecuted(sequence, 'cancelled'));
      };
      const entry: QueueEntry = {
        start: async (): Promise<void> => {
          settled = true;
          options.signal?.removeEventListener('abort', onQueuedAbort);
          try {
            await this.execute(sequence, action, options, resolve);
          } catch (error) {
            resolve(
              this.notExecuted(
                sequence,
                'execution_failed',
                this.errorMessage(error),
              ),
            );
          }
        },
        refuse: (): void => {
          if (settled) return;
          settled = true;
          options.signal?.removeEventListener('abort', onQueuedAbort);
          resolve(
            this.notExecuted(
              sequence,
              this.quarantined && !this.disposed
                ? 'quarantined'
                : 'runtime_lost',
              this.refusalMessage(),
            ),
          );
        },
      };
      this.queue.push(entry);
      options.signal?.addEventListener('abort', onQueuedAbort, { once: true });
      this.pump();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.attributedSequence = null;
    this.stopActive?.('disposed');
    this.refuseQueue();
  }

  private pump(): void {
    if (this.busy || this.disposed || this.quarantined) return;
    const entry = this.queue.shift();
    if (!entry) return;
    this.busy = true;
    void entry.start().finally(() => {
      this.busy = false;
      this.pump();
    });
  }

  private refuseQueue(): void {
    for (const entry of this.queue.splice(0)) entry.refuse();
  }

  private refusalMessage(): string {
    return this.quarantined && !this.disposed
      ? RECOVERING_MESSAGE
      : 'The browser runtime was closed before input could be sent.';
  }

  private notExecuted(
    sequence: number,
    reason: ActionLaneNotExecutedReason,
    message?: string,
  ): ActionLaneOutcome<never> {
    return {
      status: 'not_executed',
      sequence,
      reason,
      code:
        reason === 'cancelled'
          ? 'cancelled'
          : reason === 'timeout'
            ? 'timeout'
            : 'execution_failed',
      message:
        message ??
        (reason === 'cancelled'
          ? 'The browser action was cancelled before input was sent.'
          : reason === 'timeout'
            ? 'The browser action timed out before input was sent.'
            : reason === 'runtime_lost'
              ? 'The browser runtime changed before input could be sent.'
              : 'The browser action failed before input could be sent.'),
    };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Browser action failed.';
  }

  private runtimeIsCurrent(): boolean {
    try {
      return this.isCurrent(this.runtimeKey, this.generation);
    } catch {
      return false;
    }
  }

  private async execute<T>(
    sequence: number,
    action: (context: ActionLaneContext) => T | Promise<T>,
    options: ActionLaneRunOptions,
    resolve: (outcome: ActionLaneOutcome<T>) => void,
  ): Promise<void> {
    if (this.disposed || !this.runtimeIsCurrent()) {
      resolve(this.notExecuted(sequence, 'runtime_lost'));
      return;
    }

    const controller = new AbortController();
    const tracker = new CommandTracker();
    const cleanups: Array<() => void | Promise<void>> = [];
    let dispatched = false;
    let stopReason: StopReason | null = null;
    let stopResult: (result: ActionResult<T>) => void = (): void => {};
    const stopped = new Promise<ActionResult<T>>((stop) => {
      stopResult = stop;
    });
    const stop = (reason: StopReason): void => {
      if (stopReason !== null) return;
      stopReason = reason;
      controller.abort();
      stopResult({ kind: 'stopped', reason });
    };
    const getStopReason = (): StopReason | null => stopReason;
    this.stopActive = stop;
    const onAbort = (): void => stop('aborted');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) stop('aborted');

    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (options.timeoutMs !== undefined)
      timeout = setTimeout(() => stop('timeout'), options.timeoutMs);
    const context: ActionLaneContext = {
      signal: controller.signal,
      sequence,
      beginDispatch: (): void => {
        if (dispatched) return;
        if (this.disposed) stop('disposed');
        else if (controller.signal.aborted) stop('aborted');
        else if (!this.runtimeIsCurrent()) stop('runtime_lost');
        if (stopReason !== null)
          throw new ActionLanePreDispatchError(
            stopReason === 'aborted'
              ? 'cancelled'
              : stopReason === 'timeout'
                ? 'timeout'
                : 'runtime_lost',
          );
        dispatched = true;
        this.attributedSequence = sequence;
      },
      trackCommand: <U>(command: Promise<U>): Promise<U> => {
        if (!dispatched)
          throw new Error('Commands cannot be tracked before dispatch.');
        return tracker.track(command);
      },
      registerCleanup: (cleanup: () => void | Promise<void>): void => {
        cleanups.push(cleanup);
      },
    };
    const work: Promise<ActionResult<T>> = Promise.resolve()
      .then(() => action(context))
      .then(
        (value): ActionResult<T> => ({ kind: 'completed', value }),
        (error): ActionResult<T> => ({ kind: 'failed', error }),
      );
    void tracker.track(work);
    const result = await Promise.race([work, stopped]);
    if (
      dispatched &&
      result.kind === 'failed' &&
      result.error instanceof ActionLaneDispatchTimeoutError
    )
      stop('timeout');
    if (timeout !== undefined) clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
    this.stopActive = null;
    this.attributedSequence = null;

    const lost = !this.runtimeIsCurrent();
    const finalReason = getStopReason() ?? (lost ? 'runtime_lost' : null);
    if (!dispatched) {
      const preFailure = result.kind === 'failed' ? result.error : undefined;
      resolve(
        this.notExecuted(
          sequence,
          finalReason === 'aborted'
            ? 'cancelled'
            : finalReason === 'timeout'
              ? 'timeout'
              : finalReason === 'runtime_lost' || finalReason === 'disposed'
                ? 'runtime_lost'
                : 'execution_failed',
          preFailure === undefined ? undefined : this.errorMessage(preFailure),
        ),
      );
      this.runCleanups(cleanups, tracker);
      await this.drain(tracker, options.drainTimeoutMs);
      return;
    }
    if (result.kind === 'completed' && finalReason === null) {
      resolve({ status: 'executed', sequence, value: result.value });
      this.runCleanups(cleanups, tracker);
      await this.drain(tracker, options.drainTimeoutMs);
      return;
    }

    const reason: ActionLaneUnknownReason =
      finalReason === 'runtime_lost' || finalReason === 'disposed'
        ? 'runtime_lost'
        : finalReason === 'timeout'
          ? 'dispatch_timeout'
          : 'stopped_after_dispatch';
    resolve({
      status: 'outcome_unknown',
      sequence,
      reason,
      ...(result.kind === 'failed'
        ? { detail: this.errorMessage(result.error) }
        : {}),
    });
    this.runCleanups(cleanups, tracker);
    await this.drain(tracker, options.drainTimeoutMs);
  }

  private runCleanups(
    cleanups: Array<() => void | Promise<void>>,
    tracker: CommandTracker,
  ): void {
    for (const cleanup of cleanups.reverse()) {
      try {
        const completion = Promise.resolve(cleanup());
        void tracker.track(completion);
      } catch {
        // Continue releasing other held input and prepared handles.
      }
    }
  }

  private async drain(
    tracker: CommandTracker,
    timeoutMs?: number,
  ): Promise<void> {
    if (tracker.pending === 0) return;
    let bound: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'expired'>((resolve) => {
      bound = setTimeout(
        () => resolve('expired'),
        timeoutMs ?? this.drainTimeoutMs,
      );
    });
    while (tracker.pending > 0) {
      const result = await Promise.race([
        tracker.waitForChange().then(() => 'changed'),
        expired,
      ]);
      if (result === 'expired') break;
    }
    if (bound !== undefined) clearTimeout(bound);
    if (tracker.pending === 0 || this.disposed) return;
    this.quarantined = true;
    this.refuseQueue();
    tracker.onEmpty(() => {
      if (this.disposed) return;
      this.quarantined = false;
      this.pump();
    });
  }
}

export class ActionLaneRegistry {
  private readonly lanes = new WeakMap<
    object,
    { generation: number; lane: ActionLane; sequence: ActionLaneSequence }
  >();

  laneFor(
    runtimeKey: object,
    generation: number,
    isCurrent: ActionLaneOptions['isCurrent'],
  ): ActionLane {
    const existing = this.lanes.get(runtimeKey);
    if (existing?.generation === generation) return existing.lane;
    existing?.lane.dispose();
    const sequence = new ActionLaneSequence();
    const lane = new ActionLane({
      runtimeKey,
      generation,
      isCurrent,
      sequence,
    });
    this.lanes.set(runtimeKey, { generation, lane, sequence });
    return lane;
  }

  /** Runtime teardown and replacement must call this to fence in-flight input. */
  disposeFor(runtimeKey: object): void {
    this.lanes.get(runtimeKey)?.lane.dispose();
    this.lanes.delete(runtimeKey);
  }
}
