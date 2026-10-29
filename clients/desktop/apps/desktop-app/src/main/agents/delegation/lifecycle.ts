import type { ChatQueueTarget } from '@canopy/desktop-shared/types';

interface DelegationLifecycle {
  shutdown(): Promise<void>;
  revoke(harnessId?: string): Promise<void>;
  closeScope(
    target: Omit<ChatQueueTarget, 'chatId'> & { chatId?: string },
  ): Promise<void>;
  isDeliveryActive(target: ChatQueueTarget, deliveryId: string): boolean;
  claimDelivery(target: ChatQueueTarget, deliveryId: string): boolean;
  releaseDelivery(target: ChatQueueTarget, deliveryId: string): void;
  retireDelivery(target: ChatQueueTarget, deliveryId: string): void;
}
let installed: DelegationLifecycle | undefined;

/** The disabled developer feature does not load its runtime on normal app paths. */
export function installDelegationLifecycle(
  lifecycle: DelegationLifecycle,
): void {
  installed = lifecycle;
}
export function hasDelegationLifecycle(): boolean {
  return installed !== undefined;
}
export function claimDelegationDelivery(
  target: ChatQueueTarget,
  deliveryId: string,
): boolean {
  return installed?.claimDelivery(target, deliveryId) ?? false;
}
export function releaseDelegationDelivery(
  target: ChatQueueTarget,
  deliveryId: string,
): void {
  installed?.releaseDelivery(target, deliveryId);
}
/** Forget a delivery that will never be claimed for a queued dispatch. */
export function retireDelegationDelivery(
  target: ChatQueueTarget,
  deliveryId: string,
): void {
  installed?.retireDelivery(target, deliveryId);
}
export function shutdownDelegationLifecycle(): Promise<void> {
  return installed?.shutdown() ?? Promise.resolve();
}
export function revokeDelegationLifecycle(harnessId?: string): Promise<void> {
  return installed?.revoke(harnessId) ?? Promise.resolve();
}
export function closeDelegationScope(
  target: Omit<ChatQueueTarget, 'chatId'> & { chatId?: string },
): Promise<void> {
  return installed?.closeScope(target) ?? Promise.resolve();
}

export function isDelegationDeliveryActive(
  target: ChatQueueTarget,
  deliveryId: string,
): boolean {
  return installed?.isDeliveryActive(target, deliveryId) ?? false;
}
