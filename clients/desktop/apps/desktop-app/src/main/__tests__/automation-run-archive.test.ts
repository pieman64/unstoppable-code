import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ScheduledActivityRun } from '@canopy/desktop-shared/types';
import { AutomationRunArchive } from '../automations/run-archive';
import { migrateAutomationRunArchive } from '../automations/run-archive-migration';

let root = '';
let migrationRun = false;

jest.mock('../lib/paths', () => ({
  getAutomationRunArchiveFilePath: (activityId: string): string =>
    join(root, 'automation-runs', `${activityId}.jsonl`),
  getAutomationsFilePath: (): string => join(root, 'automations.json'),
}));

jest.mock('../lib/migrations', () => ({
  hasMigrationRun: jest.fn(() => Promise.resolve(migrationRun)),
  markMigrationRun: jest.fn(() => {
    migrationRun = true;
    return Promise.resolve();
  }),
}));

function run(
  id: string,
  startedAt: string,
  status: ScheduledActivityRun['status'] = 'success',
): ScheduledActivityRun {
  return {
    id,
    activityId: 'activity-1',
    activityName: 'Archive test',
    scheduledFor: startedAt,
    manual: false,
    trigger: 'scheduled',
    executionLocation: 'local',
    status,
    startedAt,
    completedAt: startedAt,
  };
}

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(60_000);

describe('AutomationRunArchive', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'automation-run-archive-'));
    migrationRun = false;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('folds transitions and returns stable newest-first cursor pages', async () => {
    const archive = new AutomationRunArchive();
    await archive.appendRun(
      run('run-1', '2026-09-11T10:00:00.000Z', 'running'),
    );
    await archive.appendRun(
      run('run-2', '2026-09-11T11:00:00.000Z', 'success'),
    );
    await archive.appendRun(
      run('run-1', '2026-09-11T10:00:00.000Z', 'failure'),
    );

    const first = await archive.readRuns('activity-1', { limit: 1 });
    expect(first).toMatchObject({
      totalCount: 2,
      runs: [{ id: 'run-2' }],
    });
    expect(first.nextCursor).not.toBeNull();

    const second = await archive.readRuns('activity-1', {
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second).toMatchObject({
      totalCount: 2,
      nextCursor: null,
      runs: [{ id: 'run-1', status: 'failure' }],
    });
  });

  it('keeps a valid append readable after a truncated final line', async () => {
    const filePath = join(root, 'automation-runs', 'activity-1.jsonl');
    await mkdir(join(root, 'automation-runs'), { recursive: true });
    await writeFile(filePath, '{"id":"truncated-run"', 'utf8');

    const archive = new AutomationRunArchive();
    const completed = run('completed-run', '2026-09-11T12:00:00.000Z');
    await archive.appendRun(completed);

    await expect(archive.readRuns('activity-1')).resolves.toMatchObject({
      totalCount: 1,
      runs: [{ id: completed.id, status: 'success' }],
    });
  });

  it('skips records with malformed optional fields before returning history', async () => {
    const filePath = join(root, 'automation-runs', 'activity-1.jsonl');
    await mkdir(join(root, 'automation-runs'), { recursive: true });
    const valid = run('valid-run', '2026-09-11T12:00:00.000Z');
    const corrupt = [
      { ...valid, id: 'bad-completed', completedAt: 'not-a-date' },
      { ...valid, id: 'bad-trigger', trigger: 'unknown' },
      { ...valid, id: 'bad-location', executionLocation: 'cloud' },
      { ...valid, id: 'bad-duration', durationMs: -1 },
      { ...valid, id: 'bad-recovered', recovered: 'yes' },
      { ...valid, id: 'bad-cancellable', cancellable: 'yes' },
      { ...valid, id: 'bad-target', target: { workspaceId: 42 } },
      { ...valid, id: 'bad-output', ifCommandOutput: {} },
      { ...valid, id: 'bad-error-output', ifCommandError: [] },
      { ...valid, id: 'bad-omitted', omittedCount: 0 },
      {
        ...valid,
        id: 'bad-truncation',
        missedOccurrencesTruncated: 'yes',
      },
      { ...valid, id: 'bad-error', error: {} },
      { ...valid, id: 'bad-result', result: { chatId: 42 } },
      { ...valid, id: 'bad-skip-reason', skipReason: 'unknown' },
      { ...valid, id: 'bad-key', idempotencyKey: {} },
      { ...valid, id: 'bad-key-scope', idempotencyScope: 'unknown' },
    ];
    await writeFile(
      filePath,
      `${[...corrupt, valid].map((entry) => JSON.stringify(entry)).join('\n')}\n`,
      'utf8',
    );

    await expect(
      new AutomationRunArchive().readRuns('activity-1'),
    ).resolves.toMatchObject({
      totalCount: 1,
      runs: [{ id: valid.id }],
    });
  });

  it('keeps independent complete histories for different activities', async () => {
    const archive = new AutomationRunArchive();
    for (const activityId of ['activity-a', 'activity-b']) {
      for (let index = 0; index < 150; index += 1) {
        await archive.appendRun({
          ...run(
            `${activityId}-run-${index}`,
            new Date(
              Date.parse('2026-09-11T12:00:00.000Z') - index,
            ).toISOString(),
          ),
          activityId,
        });
      }
    }

    expect(
      (await archive.readRuns('activity-a', { limit: 200 })).totalCount,
    ).toBe(150);
    expect(
      (await archive.readRuns('activity-b', { limit: 200 })).totalCount,
    ).toBe(150);
  });

  it('compacts duplicate transitions and enforces age and count retention', async () => {
    const archive = new AutomationRunArchive();
    for (let index = 0; index < 1_010; index += 1) {
      const startedAt = new Date(
        Date.parse('2026-09-11T12:00:00.000Z') - index * 1_000,
      ).toISOString();
      await archive.appendRun(run(`run-${index}`, startedAt));
    }
    await archive.appendRun(
      run('expired', '2020-01-01T00:00:00.000Z', 'success'),
    );

    await archive.compactActivityArchive('activity-1', {
      retentionDays: 90,
      now: new Date('2026-09-11T12:00:00.000Z'),
    });

    const page = await archive.readRuns('activity-1', { limit: 2_000 });
    expect(page.totalCount).toBe(1_000);
    expect(page.runs.some((entry) => entry.id === 'expired')).toBe(false);
    const raw = await readFile(
      join(root, 'automation-runs', 'activity-1.jsonl'),
      'utf8',
    );
    expect(raw.trim().split('\n')).toHaveLength(1_000);
  }, 120_000);

  it('enforces the hard cap during normal appends', async () => {
    const archive = new AutomationRunArchive();
    for (let index = 0; index < 1_001; index += 1) {
      await archive.appendRun(
        run(
          `run-${index}`,
          new Date(
            Date.parse('2026-09-11T12:00:00.000Z') - index * 1_000,
          ).toISOString(),
        ),
      );
    }

    const page = await archive.readRuns('activity-1', { limit: 2_000 });
    expect(page.totalCount).toBe(1_000);
    expect(page.runs.some((entry) => entry.id === 'run-1000')).toBe(false);
  });

  it('migrates the legacy hot window once without removing it', async () => {
    const legacyRun = run('legacy-run', '2026-09-10T12:00:00.000Z');
    const corruptLegacyRun = { ...legacyRun, id: 'corrupt', error: {} };
    const filePath = join(root, 'automations.json');
    await mkdir(root, { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        activities: [],
        recentRuns: [legacyRun, corruptLegacyRun],
      }),
      'utf8',
    );

    await migrateAutomationRunArchive();
    await migrateAutomationRunArchive();

    const archived = await new AutomationRunArchive().readRuns('activity-1');
    expect(archived.runs).toEqual([legacyRun]);
    expect(
      (
        await readFile(
          join(root, 'automation-runs', 'activity-1.jsonl'),
          'utf8',
        )
      )
        .trim()
        .split('\n'),
    ).toHaveLength(1);
    const persisted: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    expect(
      typeof persisted === 'object' &&
        persisted !== null &&
        'recentRuns' in persisted
        ? persisted.recentRuns
        : undefined,
    ).toEqual([legacyRun, corruptLegacyRun]);
  });
});
