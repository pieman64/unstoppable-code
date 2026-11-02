import type {
  ScheduledActivity,
  ScheduledActivityRun,
} from '@canopy/desktop-shared/types';
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
      description: 'Scheduled · Orchestrator prompt: Summarize yesterday',
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
      'One-time · Run workflow "Review" on project Canopy',
    );
  });

  it('carries the share the user published', () => {
    expect(
      toMarketplaceLocalAutomation(
        activity({
          remote: {
            remoteId: 'share-1',
            contentHash: 'a'.repeat(64),
            shareScope: 'private',
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

describe('Customize workflow facets (CAN-4845)', () => {
  function run(
    overrides: Partial<ScheduledActivityRun> = {},
  ): ScheduledActivityRun {
    return {
      id: 'run-1',
      activityId: 'activity-1',
      activityName: 'Morning standup',
      scheduledFor: '2026-08-20T09:00:00.000Z',
      manual: false,
      status: 'running',
      startedAt: '2026-08-20T09:00:00.000Z',
      ...overrides,
    };
  }

  it('adds no facets without run context', () => {
    expect(toMarketplaceLocalAutomation(activity()).workflow).toBeUndefined();
  });

  it('reads the schedule, action, switch and a missing last run', () => {
    const row = toMarketplaceLocalAutomation(
      activity({
        schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
      }),
      {},
      { recentRuns: [], locale: 'en-US' },
    );
    expect(row.workflow).toEqual({
      schedule: {
        label: 'Daily · 09:00',
        tooltip: 'Every day at 09:00',
      },
      summary: 'Orchestrator prompt: Summarize yesterday',
      enabled: true,
      lastRun: null,
    });
    // Older consumers keep the description.
    expect(row.description).toBe(
      'Scheduled · Orchestrator prompt: Summarize yesterday',
    );
  });

  it('prefers a running run over the last result', () => {
    const lastResult = {
      status: 'failure' as const,
      completedAt: '2026-08-19T09:00:00.000Z',
    };
    expect(
      toMarketplaceLocalAutomation(
        activity({ lastResult, enabled: false }),
        {},
        { recentRuns: [run()] },
      ).workflow,
    ).toMatchObject({ enabled: false, lastRun: { state: 'running' } });
    expect(
      toMarketplaceLocalAutomation(
        activity({ lastResult }),
        {},
        { recentRuns: [run({ activityId: 'other' })] },
      ).workflow?.lastRun,
    ).toEqual({
      state: 'failure',
      at: Date.parse('2026-08-19T09:00:00.000Z'),
    });
  });

  it('uses a completed recent run when the activity has no last result', () => {
    expect(
      toMarketplaceLocalAutomation(
        activity(),
        {},
        {
          recentRuns: [
            run({
              status: 'success',
              completedAt: '2026-08-20T09:02:00.000Z',
              durationMs: 120_000,
            }),
          ],
        },
      ).workflow?.lastRun,
    ).toEqual({
      state: 'success',
      at: Date.parse('2026-08-20T09:02:00.000Z'),
    });
  });

  it('carries a failed run error already present in the automation snapshot', () => {
    expect(
      toMarketplaceLocalAutomation(
        activity(),
        {},
        {
          recentRuns: [
            run({
              status: 'failure',
              completedAt: '2026-08-20T09:02:00.000Z',
              error: 'Prompt failed',
              ifCommandError: 'Condition failed',
            }),
          ],
        },
      ).workflow?.lastRun,
    ).toEqual({
      state: 'failure',
      at: Date.parse('2026-08-20T09:02:00.000Z'),
      errorMessage: 'Prompt failed',
    });
  });
});
