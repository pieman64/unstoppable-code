import {
  EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT,
  evaluateScopedSpaceNotification,
  spaceNotificationScopeKey,
} from '../space-notification-policy';
import type { SpaceNotificationPolicySnapshot } from '../../types';

const SCOPE = { projectId: 'project', worktreeId: 'worktree' };
const MUTED_AT = Date.parse('2026-10-04T12:00:00.000Z');

function snapshot(serverOffsetMs: number): SpaceNotificationPolicySnapshot {
  return {
    ...EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT,
    accountKey: 'user',
    serverOffsetMs,
    spaces: {
      [spaceNotificationScopeKey(SCOPE)]: {
        notificationSpaceId: 'space',
        revision: 2,
        override: 'all',
        transitions: [
          {
            revision: 1,
            effectiveAt: new Date(MUTED_AT).toISOString(),
            priorOverride: null,
            nextOverride: 'mute',
          },
          {
            revision: 2,
            effectiveAt: new Date(MUTED_AT + 60_000).toISOString(),
            priorOverride: 'mute',
            nextOverride: 'all',
          },
        ],
      },
    },
  };
}

it('follows the default for a space with no saved state', () => {
  expect(
    evaluateScopedSpaceNotification(
      EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT,
      SCOPE,
      'routine',
      MUTED_AT,
    ),
  ).toBe('eligible');
});

it('orders local work on the server clock', () => {
  // Local clock 30s behind the server: local MUTED_AT+40s is server +70s,
  // after the unmute, so new work is delivered.
  expect(
    evaluateScopedSpaceNotification(
      snapshot(30_000),
      SCOPE,
      'routine',
      MUTED_AT + 40_000,
    ),
  ).toBe('eligible');
  // With no offset the same local time falls inside the muted interval.
  expect(
    evaluateScopedSpaceNotification(
      snapshot(0),
      SCOPE,
      'routine',
      MUTED_AT + 40_000,
    ),
  ).toBe('suppressed');
  // Work from before the mute is cancelled by it, even after the unmute.
  expect(
    evaluateScopedSpaceNotification(
      snapshot(0),
      SCOPE,
      'attention',
      MUTED_AT - 1_000,
    ),
  ).toBe('cancelled');
});
