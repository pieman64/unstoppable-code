import type { AgentDelegationResult } from '@canopy/protocol/delegation';

export interface ManagedChildMessageBroker {
  deliverHostMessage(
    delegationId: string,
    message: string,
    deliveryId: string,
    failureMessage: string,
  ): Promise<AgentDelegationResult<unknown>>;
  waitHostMessage(delegationId: string, deliveryId: string): Promise<void>;
}

/** A queued message whose sender's authority went stale while it waited. */
export class ChildMessageAdmissionRefusedError extends Error {
  constructor() {
    super('The host message is no longer authorized.');
    this.name = 'ChildMessageAdmissionRefusedError';
  }
}

/**
 * Serializes trusted host messages addressed to one retained managed child.
 * The broker remains responsible for durable admission and invocation dedupe;
 * this queue only preserves recipient order across independent host sources.
 */
export class ManagedChildMessageInbox {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly broker: () => ManagedChildMessageBroker) {}

  deliver(
    delegationId: string,
    message: string,
    deliveryId: string,
    failureMessage: string,
    admit?: () => boolean,
  ): Promise<AgentDelegationResult<unknown>> {
    const prior = this.tails.get(delegationId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(delegationId, next);
    return prior
      .then(async () => {
        // Checked after the queue wait, with no await before the broker call.
        if (admit && !admit()) throw new ChildMessageAdmissionRefusedError();
        const broker = this.broker();
        const result = await broker.deliverHostMessage(
          delegationId,
          message,
          deliveryId,
          failureMessage,
        );
        if (result.ok) await broker.waitHostMessage(delegationId, deliveryId);
        return result;
      })
      .finally(() => {
        release();
        if (this.tails.get(delegationId) === next)
          this.tails.delete(delegationId);
      });
  }
}
