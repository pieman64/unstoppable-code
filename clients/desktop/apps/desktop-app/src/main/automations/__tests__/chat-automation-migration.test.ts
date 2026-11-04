import type { LabsExperimentsSnapshot } from '@canopy/desktop-shared/lib/labs-experiments';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import { CHAT_AUTOMATION_PIPELINES_EXPERIMENT_ID } from '../chat-automation-experiment';
import {
  CHAT_AUTOMATION_MIGRATION_RELEASED,
  migratesChatAutomation,
  startChatAutomationMigration,
  type ChatAutomationMigrationLabs,
  type ChatAutomationMigrationResult,
} from '../chat-automation-migration';
import type { AutomationsService } from '../service';

jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessError: jest.fn(),
  logMainProcessInfo: jest.fn(),
  logMainProcessWarn: jest.fn(),
}));

type Snapshot = Pick<LabsExperimentsSnapshot, 'ready' | 'experiments'>;
type Entry = LabsExperimentsSnapshot['experiments'][number];

function snapshot(ready: boolean, enabled: boolean): Snapshot {
  return {
    ready,
    experiments: [
      { id: CHAT_AUTOMATION_PIPELINES_EXPERIMENT_ID, enabled } as Entry,
    ],
  };
}

function fakeLabs(initial: Snapshot): {
  labs: ChatAutomationMigrationLabs;
  publish: (next: Snapshot) => void;
  listeners: () => number;
} {
  let current = initial;
  const listeners = new Set<(next: Snapshot) => void>();
  return {
    labs: {
      getSnapshot: () => current,
      onSnapshotChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    publish: (next) => {
      current = next;
      for (const listener of Array.from(listeners)) listener(next);
    },
    listeners: () => listeners.size,
  };
}

const service = {} as AutomationsService;

function migrateMock(): jest.Mock<
  Promise<ChatAutomationMigrationResult>,
  [AutomationsService]
> {
  return jest.fn<Promise<ChatAutomationMigrationResult>, [AutomationsService]>(
    () => Promise.resolve({ converted: [], failed: [] }),
  );
}

// CAN-5479: the bulk migration ships dark until deferred.md's preconditions hold.
describe('startChatAutomationMigration', () => {
  it('is not released yet', () => {
    expect(CHAT_AUTOMATION_MIGRATION_RELEASED).toBe(false);
    const migrate = migrateMock();
    const { labs, listeners } = fakeLabs(snapshot(true, true));
    startChatAutomationMigration({ service, labs, migrate });
    expect(migrate).not.toHaveBeenCalled();
    expect(listeners()).toBe(0);
  });

  it('runs at once when the experiment is already on', () => {
    const migrate = migrateMock();
    const { labs, listeners } = fakeLabs(snapshot(true, true));
    startChatAutomationMigration({ service, labs, migrate, released: true });
    expect(migrate).toHaveBeenCalledWith(service);
    expect(listeners()).toBe(0);
  });

  it('waits for the Labs evaluation that turns the experiment on, then runs once', () => {
    const migrate = migrateMock();
    const { labs, publish, listeners } = fakeLabs(snapshot(false, true));
    startChatAutomationMigration({ service, labs, migrate, released: true });
    expect(migrate).not.toHaveBeenCalled();
    publish(snapshot(true, false));
    expect(migrate).not.toHaveBeenCalled();
    publish(snapshot(true, true));
    publish(snapshot(true, true));
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(listeners()).toBe(0);
  });

  it('stops waiting on shutdown', () => {
    const migrate = migrateMock();
    const { labs, publish, listeners } = fakeLabs(snapshot(true, false));
    const stop = startChatAutomationMigration({
      service,
      labs,
      migrate,
      released: true,
    });
    stop();
    publish(snapshot(true, true));
    expect(migrate).not.toHaveBeenCalled();
    expect(listeners()).toBe(0);
  });

  it('logs a failed migration instead of throwing', async () => {
    const { logMainProcessError } = jest.requireMock<{
      logMainProcessError: jest.Mock;
    }>('../../lib/main-process-logging');
    const migrate = migrateMock();
    migrate.mockRejectedValueOnce(new Error('disk full'));
    const { labs } = fakeLabs(snapshot(true, true));
    startChatAutomationMigration({ service, labs, migrate, released: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(logMainProcessError).toHaveBeenCalledWith(
      'Failed to migrate chat automations',
      expect.any(Error),
    );
  });
});

describe('migratesChatAutomation', () => {
  const base: ScheduledActivity = {
    version: 1,
    id: 'activity-1',
    name: 'Morning check',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action: { type: 'app_advisor_prompt', prompt: 'Summarize today' },
    createdAt: '2026-05-28T12:00:00.000Z',
    updatedAt: '2026-05-28T12:00:00.000Z',
    failureCount: 0,
  };

  it('migrates a convertible chat automation', () => {
    expect(migratesChatAutomation(base)).toBe(true);
  });

  // Conversion keeps the automation, and with it the install's checks.
  it.each(['shared', 'public', 'curated'] as const)(
    'migrates a %s install',
    (sourceKind) => {
      expect(
        migratesChatAutomation({
          ...base,
          installedFrom: {
            remoteId: 'remote-1',
            contentHash: 'a'.repeat(64),
            installedAt: '2026-05-28T12:00:00.000Z',
            sourceKind,
          },
        }),
      ).toBe(true);
    },
  );

  it('leaves an automation the conversion refuses native', () => {
    expect(
      migratesChatAutomation({
        ...base,
        action: {
          type: 'worktree_prompt',
          workspaceId: 'workspace-1',
          prompt: 'Plan the day',
          purpose: 'scheduled_task',
        },
      }),
    ).toBe(false);
  });
});
