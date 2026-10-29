import type { SpaceNotificationClass } from '@canopy/protocol/space-notifications';
import {
  EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT,
  evaluateScopedSpaceNotification,
  spaceNotificationScopeKey,
} from '@canopy/desktop-shared/lib/space-notification-policy';
import type {
  SpaceNotificationPolicySnapshot,
  SpaceNotificationScope,
} from '@canopy/desktop-shared/types';

// The latest policy replica, published by the space notification policy
// service (CAN-3615). Kept dependency-free so low-level senders can gate
// native delivery without importing the service and its sync machinery.
let current: SpaceNotificationPolicySnapshot =
  EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT;

export function publishSpaceNotificationPolicy(
  snapshot: SpaceNotificationPolicySnapshot,
): void {
  current = snapshot;
}

/** Whether a scoped chat or pipeline occurrence may raise a native
 * notification now. Spaces without a saved choice follow the default. */
export function isSpaceNotificationDeliverable(
  scope: SpaceNotificationScope,
  eventClass: SpaceNotificationClass,
  occurredAtMs: number = Date.now(),
): boolean {
  return (
    evaluateScopedSpaceNotification(
      current,
      scope,
      eventClass,
      occurredAtMs,
    ) === 'eligible'
  );
}

/** The server id web and mobile use for this space, once registered. */
export function notificationSpaceIdFor(
  scope: SpaceNotificationScope,
): string | undefined {
  return current.spaces[spaceNotificationScopeKey(scope)]?.notificationSpaceId;
}
