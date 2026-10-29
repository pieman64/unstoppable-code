import type { WatcherMessageDeliveryAckRequest } from '@canopy/desktop-shared/types';

interface WatcherDeliveryIdentity {
  watcherId: string;
  deliveryId: string;
}

interface DeliveryEntry {
  receipt: Promise<void>;
  startedAt: number;
  finalAck?: WatcherMessageDeliveryAckRequest;
}

type AcknowledgeWatcherDelivery = (
  request: WatcherMessageDeliveryAckRequest,
) => Promise<unknown>;

const MAX_COMPLETED_DELIVERIES = 500;
const PENDING_DELIVERY_EXPIRY_MS = 30 * 60_000;

function deliveryKey(command: WatcherDeliveryIdentity): string {
  return `${command.watcherId}:${command.deliveryId}`;
}

/**
 * Coordinates the two-stage watcher delivery handshake inside one renderer.
 * Receipt is acknowledged before serialized work begins, while completion is
 * replayable so a main-process retry cannot enqueue the same follow-up twice.
 */
export class WatcherDeliveryDeduplicator {
  private readonly deliveries = new Map<string, DeliveryEntry>();

  constructor(private readonly acknowledge: AcknowledgeWatcherDelivery) {}

  begin(command: WatcherDeliveryIdentity): boolean {
    const key = deliveryKey(command);
    const receipt = this.safeAcknowledge({
      watcherId: command.watcherId,
      deliveryId: command.deliveryId,
      stage: 'received',
      ok: true,
    });
    let existing = this.deliveries.get(key);
    if (
      existing &&
      !existing.finalAck &&
      Date.now() - existing.startedAt >= PENDING_DELIVERY_EXPIRY_MS
    ) {
      this.deliveries.delete(key);
      existing = undefined;
    }
    if (existing) {
      const finalAck = existing.finalAck;
      if (finalAck) {
        void receipt.then(() => this.safeAcknowledge(finalAck));
      }
      return false;
    }
    this.deliveries.set(key, { receipt, startedAt: Date.now() });
    return true;
  }

  complete(
    command: WatcherDeliveryIdentity,
    result: { ok: boolean; error?: string },
  ): void {
    const key = deliveryKey(command);
    const entry = this.deliveries.get(key);
    if (!entry) return;
    const finalAck: WatcherMessageDeliveryAckRequest = {
      watcherId: command.watcherId,
      deliveryId: command.deliveryId,
      stage: 'completed',
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
    };
    entry.finalAck = finalAck;
    void entry.receipt.then(() => {
      if (!result.ok && this.deliveries.get(key) === entry) {
        this.deliveries.delete(key);
      }
      return this.safeAcknowledge(finalAck);
    });
    this.pruneCompleted();
  }

  private async safeAcknowledge(
    request: WatcherMessageDeliveryAckRequest,
  ): Promise<void> {
    try {
      await this.acknowledge(request);
    } catch {
      // Main falls back to its delivery timeout if this best-effort IPC fails.
    }
  }

  private pruneCompleted(): void {
    let completedCount = 0;
    this.deliveries.forEach((entry) => {
      if (entry.finalAck) completedCount += 1;
    });
    if (completedCount <= MAX_COMPLETED_DELIVERIES) return;
    this.deliveries.forEach((entry, key) => {
      if (completedCount <= MAX_COMPLETED_DELIVERIES) return;
      if (entry.finalAck) {
        this.deliveries.delete(key);
        completedCount -= 1;
      }
    });
  }
}
