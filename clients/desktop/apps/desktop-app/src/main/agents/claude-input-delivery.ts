import type {
  ChatInputAdmission,
  ChatInputDeliveryEvent,
  ChatInputWithdrawal,
  ChatSteeringCapabilities,
} from '@canopy/protocol/portal';

interface Attempt {
  yielded?: boolean;
  userMessageId: string;
  admitted: boolean;
  pickedUp: boolean;
  withdrawn: boolean;
  unknown: boolean;
  completed?: boolean;
  settle?: (result: ChatInputAdmission) => void;
  withdrawalObserved?: () => void;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function withDeliveryDeadline<T>(
  operation: Promise<T>,
  milliseconds = 5000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Provider delivery confirmation timed out')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Pin-sensitive SDK seam (0.3.258 / Claude 2.1.258). These private methods
 * are intentionally checked at runtime; the SDK remains the sole I/O owner.
 * Never infer withdrawal from a false receipt or the absence of a started event.
 */
export class ClaudeInputDelivery {
  private query: Record<string, unknown> | undefined;
  private capabilities = new Set<string>();
  private attempts = new Map<string, Attempt>();
  private disposed = false;
  private frozen = false;
  private sweepOperation: Promise<void> | undefined;

  constructor(
    readonly generation: string,
    private readonly emit: (event: ChatInputDeliveryEvent) => void,
    private readonly pickup: (userMessageId: string) => boolean,
  ) {}

  setQuery(query: unknown): void {
    this.query = record(query) ? query : undefined;
  }

  getCapabilities(): ChatSteeringCapabilities {
    const live = !this.disposed && !this.frozen;
    const withdraw =
      this.capabilities.has('msg_lifecycle_v1') &&
      typeof this.query?.cancelAsyncMessage === 'function';
    const interrupt =
      this.capabilities.has('interrupt_receipt_v1') &&
      this.capabilities.has('interrupt_cancel_queued_v1') &&
      typeof this.query?.interrupt === 'function';
    return {
      provider: 'claude',
      generation: this.generation,
      steer: live && withdraw && interrupt,
      withdraw: live && withdraw,
      interrupt: !this.disposed && interrupt,
    };
  }

  hasPending(): boolean {
    return (
      !this.disposed &&
      Array.from(this.attempts.values()).some(
        (a) => !a.pickedUp && !a.withdrawn,
      )
    );
  }

  /** How many inputs the SDK has started a turn for. */
  startedCount(): number {
    return Array.from(this.attempts.values()).filter(
      (attempt) => attempt.pickedUp,
    ).length;
  }

  /** Inputs the SDK queued that no turn has started yet. */
  admittedUnstarted(): string[] {
    if (this.disposed) return [];
    return Array.from(this.attempts)
      .filter(
        ([, attempt]) =>
          attempt.admitted &&
          !attempt.pickedUp &&
          !attempt.withdrawn &&
          !attempt.unknown,
      )
      .map(([id]) => id);
  }

  claimYield(id: string): boolean {
    const attempt = this.attempts.get(id);
    if (!attempt || attempt.withdrawn || this.disposed || this.frozen)
      return false;
    attempt.yielded = true;
    return true;
  }

  private observation(
    id: string,
    phase: ChatInputDeliveryEvent['phase'],
    startsTurn?: boolean,
  ): void {
    this.emit({
      type: 'canopy_input_delivery',
      provider: 'claude',
      generation: this.generation,
      attemptId: id,
      phase,
      ...(startsTurn
        ? { startsTurn, userMessageId: this.attempts.get(id)?.userMessageId }
        : {}),
    });
  }

  observe(event: unknown): void {
    if (!record(event) || event.parent_tool_use_id != null || this.disposed)
      return;
    if (event.type === 'system' && event.subtype === 'init') {
      this.capabilities = new Set(
        Array.isArray(event.capabilities)
          ? event.capabilities.filter((s): s is string => typeof s === 'string')
          : [],
      );
      return;
    }
    if (
      event.type !== 'command_lifecycle' ||
      typeof event.command_uuid !== 'string'
    )
      return;
    const id = event.command_uuid;
    const attempt = this.attempts.get(id);
    if (!attempt) return;
    if (event.state === 'queued' && !attempt.admitted) {
      attempt.admitted = true;
      this.observation(id, 'accepted');
      attempt.settle?.({ kind: 'accepted', attemptId: id });
    } else if (event.state === 'started' && !attempt.pickedUp) {
      attempt.pickedUp = true;
      if (attempt.withdrawn) attempt.unknown = true;
      this.observation(id, 'picked-up', this.pickup(attempt.userMessageId));
      attempt.settle?.({ kind: 'accepted', attemptId: id });
    } else if (event.state === 'cancelled') {
      if (!attempt.pickedUp && !attempt.unknown && !attempt.withdrawn) {
        attempt.withdrawn = true;
        this.observation(id, 'withdrawn');
        attempt.withdrawalObserved?.();
      }
    } else if (event.state === 'completed') {
      attempt.completed = true;
      this.observation(id, 'completed');
    }
  }

  async submit(
    text: string,
    id: string,
    userMessageId: string,
    enqueue: () => void,
  ): Promise<ChatInputAdmission> {
    if (!this.getCapabilities().steer)
      return {
        kind: 'rejected',
        attemptId: id,
        reason: 'Steering is unavailable for this session',
      };
    if (this.attempts.has(id))
      return {
        kind: 'unknown',
        attemptId: id,
        reason: 'This submission identity was already used',
      };
    // The durable ledger owns historical facts. Keep a bounded correlation
    // window here and never evict an input still owned by the live query.
    if (this.attempts.size >= 1024) {
      for (const [previousId, previous] of Array.from(this.attempts)) {
        if ((previous.withdrawn && !previous.unknown) || previous.completed) {
          this.attempts.delete(previousId);
          if (this.attempts.size < 1024) break;
        }
      }
    }
    if (this.attempts.size >= 1024)
      return {
        kind: 'rejected',
        attemptId: id,
        reason:
          'Too many messages are awaiting delivery confirmation. Keep this message queued.',
      };
    const attempt: Attempt = {
      userMessageId,
      admitted: false,
      pickedUp: false,
      withdrawn: false,
      unknown: false,
    };
    this.attempts.set(id, attempt);
    try {
      const admitted = new Promise<ChatInputAdmission>((resolve) => {
        attempt.settle = resolve;
      });
      enqueue();
      return await withDeliveryDeadline(admitted);
    } catch {
      attempt.unknown = true;
      this.observation(id, 'unknown');
      return {
        kind: 'unknown',
        attemptId: id,
        reason:
          'Delivery was not confirmed. This message will not be resent automatically.',
      };
    } finally {
      delete attempt.settle;
    }
  }

  /** A failed SDK handoff has not entered the provider's input queue. */
  rejectUnaccepted(id: string, reason: string): void {
    const attempt = this.attempts.get(id);
    if (!attempt || attempt.admitted || attempt.pickedUp || attempt.withdrawn)
      return;
    attempt.withdrawn = true;
    attempt.settle?.({
      kind: 'rejected',
      attemptId: id,
      reason,
      fallback: 'ordinary',
    });
  }

  endTurn(): void {
    if (this.disposed) return;
    this.frozen = true;
    for (const id of Array.from(this.attempts.keys()))
      this.rejectUnaccepted(id, 'The delegated SDK turn has ended');
    this.dispose();
  }

  async withdraw(id: string): Promise<ChatInputWithdrawal> {
    const attempt = this.attempts.get(id);
    if (attempt?.pickedUp) return { kind: 'picked-up', attemptId: id };
    if (attempt?.withdrawn && !attempt.unknown)
      return { kind: 'withdrawn', attemptId: id, evidenceId: id };
    if (!this.getCapabilities().withdraw)
      return { kind: 'unsupported', attemptId: id };
    if (!attempt)
      return {
        kind: 'unconfirmed',
        attemptId: id,
        reason: 'This session does not own the message',
      };
    try {
      const method = this.query?.cancelAsyncMessage;
      if (typeof method !== 'function')
        return { kind: 'unsupported', attemptId: id };
      const observed = new Promise<boolean>((resolve) => {
        attempt.withdrawalObserved = (): void => resolve(true);
      });
      const receipt: unknown = await withDeliveryDeadline(
        Promise.race([
          Promise.resolve(Reflect.apply(method, this.query, [id])),
          observed,
        ]),
      );
      if (attempt.pickedUp) return { kind: 'picked-up', attemptId: id };
      if (
        (receipt === true || attempt.withdrawn) &&
        !attempt.unknown &&
        !this.disposed
      ) {
        attempt.withdrawn = true;
        this.observation(id, 'withdrawn');
        return { kind: 'withdrawn', attemptId: id, evidenceId: id };
      }
    } catch {
      /* The query may still consume the message. Keep ownership. */
    } finally {
      delete attempt.withdrawalObserved;
    }
    attempt.unknown = true;
    this.observation(id, 'unknown');
    return {
      kind: 'unconfirmed',
      attemptId: id,
      reason: 'Cancellation was not confirmed',
    };
  }

  sweep(): Promise<void> {
    if (!this.sweepOperation)
      this.sweepOperation = this.sweepOnce().finally(() => {
        this.sweepOperation = undefined;
      });
    return this.sweepOperation;
  }

  private async sweepOnce(): Promise<void> {
    if (!this.getCapabilities().interrupt)
      throw new Error('Safe interruption is unavailable for this session');
    this.frozen = true;
    try {
      // Prompt normalization can still be awaiting I/O. Withdraw those local
      // staging entries before sweeping the SDK so they cannot arrive afterward.
      for (const [id, attempt] of Array.from(this.attempts)) {
        if (!attempt.yielded && !attempt.pickedUp) {
          attempt.withdrawn = true;
          this.observation(id, 'withdrawn');
          attempt.settle?.({
            kind: 'rejected',
            attemptId: id,
            reason: 'Submission interrupted before handoff',
          });
        }
      }
      const method = this.query?.interrupt;
      if (typeof method !== 'function')
        throw new Error('Interruption is unavailable');
      const receipt: unknown = await withDeliveryDeadline(
        Promise.resolve(
          Reflect.apply(method, this.query, [{ cancelQueued: true }]),
        ),
      );
      if (
        !record(receipt) ||
        !Array.isArray(receipt.cancelled) ||
        !receipt.cancelled.every((id) => typeof id === 'string') ||
        !Array.isArray(receipt.still_queued) ||
        !receipt.still_queued.every((id) => typeof id === 'string')
      )
        throw new Error('Invalid interruption receipt');
      for (const id of receipt.cancelled) {
        const attempt = this.attempts.get(id);
        if (attempt && !attempt.pickedUp && !attempt.unknown) {
          attempt.withdrawn = true;
          this.observation(id, 'withdrawn');
        }
      }
      if (this.hasPending())
        throw new Error(
          'Pending input could not be withdrawn; replacement remains queued',
        );
    } finally {
      this.frozen = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [id, attempt] of Array.from(this.attempts)) {
      if (attempt.pickedUp || attempt.withdrawn) continue;
      attempt.unknown = true;
      this.observation(id, 'unknown');
      attempt.settle?.({
        kind: 'unknown',
        attemptId: id,
        reason: 'Provider session ended',
      });
    }
  }
}
