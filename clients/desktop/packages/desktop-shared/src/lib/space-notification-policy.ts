import {
  evaluateSpaceNotification,
  type SpaceNotificationClass,
  type SpaceNotificationPolicyOutcome,
} from '@canopy/protocol/space-notifications';
import type {
  SpaceNotificationPolicySnapshot,
  SpaceNotificationScope,
} from '../types';

/** The replica key for one space. Ids are opaque; the separator cannot occur
 * in either. */
export function spaceNotificationScopeKey(
  scope: SpaceNotificationScope,
): string {
  return `${scope.projectId}\u001f${scope.worktreeId}`;
}

/**
 * Whether a chat or pipeline occurrence in one space may be delivered now.
 * Synchronous and allocation-light: it runs on the toast and native
 * notification paths. A space with no saved state follows the default, so
 * accounts that never chose anything behave exactly as before.
 *
 * `occurredAtMs` is the local time the occurrence happened. It is moved onto
 * the server clock before comparison with transition times, so a choice made
 * on another device orders correctly against local work.
 */
export function evaluateScopedSpaceNotification(
  snapshot: SpaceNotificationPolicySnapshot,
  scope: SpaceNotificationScope,
  eventClass: SpaceNotificationClass,
  occurredAtMs: number,
): SpaceNotificationPolicyOutcome {
  const space = snapshot.spaces[spaceNotificationScopeKey(scope)];
  if (!space) return 'eligible';
  return evaluateSpaceNotification(
    eventClass,
    {
      occurredAt: new Date(
        occurredAtMs + snapshot.serverOffsetMs,
      ).toISOString(),
    },
    space.transitions,
    space.override,
  );
}

export const EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT: SpaceNotificationPolicySnapshot =
  {
    accountKey: null,
    writesEnabled: false,
    serverOffsetMs: 0,
    syncedAt: null,
    spaces: {},
  };
