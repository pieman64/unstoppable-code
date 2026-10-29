import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import {
  toMarketplaceLocalAutomation,
  toMarketplaceLocalAutomations,
} from '../marketplaceAutomations';

function activity(
  overrides: Partial<ScheduledActivity> = {},
): ScheduledActivity {
  return {
    version: 1,
    id: 'activity-1',
    name: 'Morning standup',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'local' },
    action: { type: 'app_advisor_prompt', prompt: 'Summarize yesterday' },
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    failureCount: 0,
    ...overrides,
  };
}

describe('toMarketplaceLocalAutomation', () => {
  it('describes when the automation runs and what it does', () => {
    expect(toMarketplaceLocalAutomation(activity())).toEqual({
      id: 'activity-1',
      name: 'Morning standup',
      description: 'Scheduled · App Advisor prompt: Summarize yesterday',
    });
  });

  it('names the project through the resolver instead of showing its id', () => {
    const row = toMarketplaceLocalAutomation(
      activity({
        schedule: {
          kind: 'one_time',
          runAt: '2026-10-01T09:00:00.000Z',
          timezone: 'local',
        },
        action: {
          type: 'worktree_pipeline',
          workspaceId: 'workspace-1',
          pipelineId: 'review',
          pipelineName: 'Review',
        },
      }),
      { workspaceName: (id) => (id === 'workspace-1' ? 'Canopy' : undefined) },
    );

    expect(row.description).toBe(
      'One-time · Run pipeline "Review" on project Canopy',
    );
  });

  it('carries the share the user published', () => {
    expect(
      toMarketplaceLocalAutomation(
        activity({
          remote: {
            remoteId: 'share-1',
            contentHash: 'a'.repeat(64),
            sharedAt: '2026-08-19T00:00:00.000Z',
          },
        }),
      ).sharedRemoteId,
    ).toBe('share-1');
  });

  it('carries install provenance without the local-only fields', () => {
    expect(
      toMarketplaceLocalAutomation(
        activity({
          installedFrom: {
            remoteId: 'daily-review',
            contentHash: 'b'.repeat(64),
            installedAt: '2026-08-19T00:00:00.000Z',
            sourceKind: 'curated',
            bundledPipelineLocalId: 'local-pipeline',
          },
        }),
      ).installedFrom,
    ).toEqual({
      remoteId: 'daily-review',
      contentHash: 'b'.repeat(64),
      sourceKind: 'curated',
    });
  });

  it('leaves the source kind absent for an install that never recorded one', () => {
    expect(
      toMarketplaceLocalAutomation(
        activity({
          installedFrom: {
            remoteId: 'share-1',
            contentHash: 'a'.repeat(64),
            installedAt: '2026-08-19T00:00:00.000Z',
          },
        }),
      ).installedFrom,
    ).toEqual({ remoteId: 'share-1', contentHash: 'a'.repeat(64) });
  });
});

describe('toMarketplaceLocalAutomations', () => {
  it('keeps the order it was given', () => {
    expect(
      toMarketplaceLocalAutomations([
        activity({ id: 'b', name: 'B' }),
        activity({ id: 'a', name: 'A' }),
      ]).map((row) => row.id),
    ).toEqual(['b', 'a']);
  });
});
