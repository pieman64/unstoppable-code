import type {
  DelegationDeliveryReceipt,
  DelegationDeliveryState,
} from './types';

export interface DelegationDeliveryTransport {
  /** A receipt means native acceptance, not a queued socket write. */
  dispatch(
    this: void,
    deliveryId: string,
    channel: 'foreground' | 'background',
  ): Promise<DelegationDeliveryReceipt>;
  /** Read-only native or durable inbox lookup; never resubmit to discover state. */
  lookupReceipt(
    this: void,
    deliveryId: string,
  ): Promise<DelegationDeliveryReceipt | undefined>;
}

export interface DelegationDeliveryPersistence {
  /** Atomically persist and sync before resolving. One host owns this record. */
  commit(deliveryId: string, state: DelegationDeliveryState): Promise<void>;
}

/** A per-record serial gate. Terminal lookup never consumes this delivery. */
export class DelegationDeliveryCoordinator {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    readonly deliveryId: string,
    private readonly persistence: DelegationDeliveryPersistence,
    private state: DelegationDeliveryState = { status: 'unclaimed' },
  ) {
    if (!deliveryId || deliveryId.length > 256)
      throw new Error('Invalid delivery identity');
    this.state = Object.freeze({ ...state });
  }

  snapshot(): DelegationDeliveryState {
    return this.state;
  }
  claim(channel: 'foreground' | 'background'): Promise<boolean> {
    return this.serial(async () => {
      if (this.state.status !== 'unclaimed') return false;
      await this.write({ status: 'queued', channel });
      return true;
    });
  }

  dispatch(
    transport: DelegationDeliveryTransport,
  ): Promise<DelegationDeliveryState> {
    return this.serial(async () => {
      if (this.state.status !== 'queued') return this.state;
      const { channel } = this.state;
      await this.write({ status: 'dispatching', channel });
      let receipt: DelegationDeliveryReceipt | undefined;
      try {
        receipt = await transport.dispatch(this.deliveryId, channel);
      } catch {
        // Once dispatch begins, a rejected promise cannot prove non-acceptance.
      }
      await this.write(this.receiptState(receipt, channel));
      return this.state;
    });
  }

  reconcile(
    transport: DelegationDeliveryTransport,
  ): Promise<DelegationDeliveryState> {
    return this.serial(async () => {
      if (
        this.state.status !== 'dispatching' &&
        this.state.status !== 'uncertain'
      )
        return this.state;
      const { channel } = this.state;
      let receipt: DelegationDeliveryReceipt | undefined;
      try {
        receipt = await transport.lookupReceipt(this.deliveryId);
      } catch {
        // Retained results remain available even when native history cannot be read.
      }
      await this.write(this.receiptState(receipt, channel));
      return this.state;
    });
  }

  suppress(reason: 'parent_gone' | 'user_cancelled'): Promise<boolean> {
    return this.serial(async () => {
      if (this.state.status !== 'unclaimed' && this.state.status !== 'queued')
        return false;
      await this.write({ status: 'suppressed', reason });
      return true;
    });
  }

  private receiptState(
    receipt: DelegationDeliveryReceipt | undefined,
    channel: 'foreground' | 'background',
  ): DelegationDeliveryState {
    if (
      receipt?.deliveryId === this.deliveryId &&
      receipt.status === 'acknowledged' &&
      receipt.receiptId.length > 0 &&
      receipt.receiptId.length <= 512
    ) {
      return { status: 'acknowledged', channel, receiptId: receipt.receiptId };
    }
    return { status: 'uncertain', channel };
  }

  private async write(state: DelegationDeliveryState): Promise<void> {
    const retained = Object.freeze({ ...state });
    await this.persistence.commit(this.deliveryId, retained);
    this.state = retained;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
