import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import { findInstalledAutomationByOrigin } from '../publicAutomationInstallState';

const EXTERNAL_ID = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const CONTENT_HASH = 'a'.repeat(64);

function activity(
  id: string,
  installedFrom?: ScheduledActivity['installedFrom'],
): ScheduledActivity {
  return {
    version: 1,
    id,
    name: id,
    enabled: false,
    schedule: { kind: 'cron', expression: '0 2 * * *', timezone: 'local' },
    action: { type: 'app_advisor_prompt', prompt: 'Check the queue' },
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    failureCount: 0,
    ...(installedFrom ? { installedFrom } : {}),
  };
}

it('matches only a public-share install', (): void => {
  const found = findInstalledAutomationByOrigin(
    [
      activity('a', {
        remoteId: EXTERNAL_ID,
        contentHash: CONTENT_HASH,
        installedAt: '2026-08-19T00:00:00.000Z',
        sourceKind: 'public',
      }),
    ],
    { sourceKind: 'public', remoteId: EXTERNAL_ID },
    CONTENT_HASH,
  );
  expect(found).toEqual({ activityId: 'a', updateAvailable: false });
});

it('ignores a team-share install whose id happens to collide', (): void => {
  expect(
    findInstalledAutomationByOrigin(
      [
        activity('a', {
          remoteId: EXTERNAL_ID,
          contentHash: CONTENT_HASH,
          installedAt: '2026-08-19T00:00:00.000Z',
        }),
        activity('b', {
          remoteId: EXTERNAL_ID,
          contentHash: CONTENT_HASH,
          installedAt: '2026-08-19T00:00:00.000Z',
          sourceKind: 'shared',
        }),
      ],
      { sourceKind: 'public', remoteId: EXTERNAL_ID },
      CONTENT_HASH,
    ),
  ).toBeNull();
});

it('reports an update when the share document drifted', (): void => {
  expect(
    findInstalledAutomationByOrigin(
      [
        activity('a', {
          remoteId: EXTERNAL_ID,
          contentHash: 'b'.repeat(64),
          installedAt: '2026-08-19T00:00:00.000Z',
          sourceKind: 'public',
        }),
      ],
      { sourceKind: 'public', remoteId: EXTERNAL_ID },
      CONTENT_HASH,
    ),
  ).toEqual({ activityId: 'a', updateAvailable: true });
});

it('returns null with no installs at all', (): void => {
  expect(
    findInstalledAutomationByOrigin(
      [activity('a')],
      { sourceKind: 'public', remoteId: EXTERNAL_ID },
      CONTENT_HASH,
    ),
  ).toBeNull();
});

it('matches a curated install by its catalog key', (): void => {
  const activities = [
    activity('team', {
      remoteId: 'daily-review',
      contentHash: CONTENT_HASH,
      installedAt: '2026-08-19T00:00:00.000Z',
    }),
    activity('curated', {
      remoteId: 'daily-review',
      contentHash: 'b'.repeat(64),
      installedAt: '2026-08-19T00:00:00.000Z',
      sourceKind: 'curated',
    }),
  ];
  expect(
    findInstalledAutomationByOrigin(
      activities,
      { sourceKind: 'curated', remoteId: 'daily-review' },
      CONTENT_HASH,
    ),
  ).toEqual({ activityId: 'curated', updateAvailable: true });
});

it('treats an absent sourceKind as a team-share install', (): void => {
  expect(
    findInstalledAutomationByOrigin(
      [
        activity('team', {
          remoteId: EXTERNAL_ID,
          contentHash: CONTENT_HASH,
          installedAt: '2026-08-19T00:00:00.000Z',
        }),
      ],
      { sourceKind: 'shared', remoteId: EXTERNAL_ID },
      CONTENT_HASH,
    ),
  ).toEqual({ activityId: 'team', updateAvailable: false });
});
