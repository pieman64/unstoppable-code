import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import {
  installStateOf,
  installedCopiesOf,
  localBadgeForSummary,
  staleCopiesOf,
} from '../automationShareRelationship';

const REMOTE_ID = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const CURRENT = 'a'.repeat(64);
const OLDER = 'b'.repeat(64);

function activity(
  id: string,
  overrides: Partial<ScheduledActivity> = {},
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
    ...overrides,
  };
}

function installed(
  id: string,
  contentHash: string,
  sourceKind?: NonNullable<ScheduledActivity['installedFrom']>['sourceKind'],
  remoteId = REMOTE_ID,
): ScheduledActivity {
  return activity(id, {
    installedFrom: {
      remoteId,
      contentHash,
      installedAt: '2026-08-19T00:00:00.000Z',
      ...(sourceKind ? { sourceKind } : {}),
    },
  });
}

describe('installedCopiesOf', () => {
  const activities = [
    installed('legacy', CURRENT),
    installed('shared', CURRENT, 'shared'),
    installed('public', CURRENT, 'public'),
    installed('curated', CURRENT, 'curated'),
    activity('authored'),
  ];

  it.each<
    [NonNullable<ScheduledActivity['installedFrom']>['sourceKind'], string[]]
  >([
    // An install recorded before `sourceKind` existed is a team-share install.
    ['shared', ['legacy', 'shared']],
    ['public', ['public']],
    ['curated', ['curated']],
  ])('matches %s installs only in their own id namespace', (kind, ids) => {
    expect(
      installedCopiesOf(activities, {
        sourceKind: kind ?? 'shared',
        remoteId: REMOTE_ID,
      }).map((item) => item.id),
    ).toEqual(ids);
  });

  it('matches nothing for another id', () => {
    expect(
      installedCopiesOf(activities, {
        sourceKind: 'shared',
        remoteId: 'another-id',
      }),
    ).toEqual([]);
  });
});

describe('staleCopiesOf and installStateOf', () => {
  const source = {
    sourceKind: 'curated' as const,
    remoteId: 'daily-review',
    contentHash: CURRENT,
  };

  it('reports no install when no copy came from the source', () => {
    expect(installStateOf([activity('authored')], source)).toBeNull();
    expect(staleCopiesOf([activity('authored')], source)).toEqual([]);
  });

  it('reports a current install', () => {
    const activities = [installed('copy', CURRENT, 'curated', 'daily-review')];
    expect(installStateOf(activities, source)).toBe('installed');
    expect(staleCopiesOf(activities, source)).toEqual([]);
  });

  it('offers every stale copy and is not masked by a current one', () => {
    const activities = [
      installed('current', CURRENT, 'curated', 'daily-review'),
      installed('stale-a', OLDER, 'curated', 'daily-review'),
      installed('stale-b', OLDER, 'curated', 'daily-review'),
      // Same key, different namespace: a team share never counts.
      installed('team', OLDER, 'shared', 'daily-review'),
    ];
    expect(installStateOf(activities, source)).toBe('update-available');
    expect(staleCopiesOf(activities, source).map((item) => item.id)).toEqual([
      'stale-a',
      'stale-b',
    ]);
  });
});

describe('localBadgeForSummary', () => {
  const summary = { id: REMOTE_ID, contentHash: CURRENT };

  it('prefers the share the user published over an installed copy', () => {
    expect(
      localBadgeForSummary(summary, [
        installed('copy', OLDER),
        activity('source', {
          remote: {
            remoteId: REMOTE_ID,
            contentHash: CURRENT,
            shareScope: 'team',
            sharedAt: '2026-08-19T00:00:00.000Z',
          },
        }),
      ]),
    ).toBe('shared-by-you');
  });

  it('reports installed and update-available copies of a team share', () => {
    expect(localBadgeForSummary(summary, [installed('copy', CURRENT)])).toBe(
      'installed',
    );
    expect(localBadgeForSummary(summary, [installed('copy', OLDER)])).toBe(
      'update-available',
    );
  });

  it.each(['public', 'curated'] as const)(
    'ignores a %s install whose id collides with the team share',
    (sourceKind) => {
      expect(
        localBadgeForSummary(summary, [installed('copy', OLDER, sourceKind)]),
      ).toBeNull();
    },
  );
});
