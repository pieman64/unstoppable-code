// CAN-3817: the typed core.workspace.retention.update boundary. Runs the real
// manifest persistence against a temporary data dir; the archive lock and the
// activity baseline (CAN-3821) are observed, not exercised.
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
const mockReleaseLease = jest.fn();
jest.mock('../../services/split-lock-service', () => ({
  acquireWorkspaceArchiveRetentionLease: jest.fn(() => mockReleaseLease),
}));
jest.mock('../archived-containers', () => ({
  withArchivedWorkspaceOperationLock: jest.fn(
    (_workspaceId: string, work: () => Promise<unknown>) => work(),
  ),
}));
jest.mock('../workspace-activity', () => ({
  touchAllWorkspaceTargets: jest.fn(() => Promise.resolve()),
}));

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WorkspaceOwnerBinding } from '@canopy/desktop-shared/types';
import { acquireWorkspaceArchiveRetentionLease } from '../../services/split-lock-service';
import { withArchivedWorkspaceOperationLock } from '../archived-containers';
import { getWorkspaceConfigPath } from '../paths';
import { touchAllWorkspaceTargets } from '../workspace-activity';
import {
  updateWorkspaceConfig,
  updateWorkspaceOwnership,
} from '../workspace-persistence';
import {
  updateWorkspaceRetention,
  WorkspaceRetentionRefusedError,
  type WorkspaceRetentionPatch,
} from '../workspace-retention';

const WORKSPACE_ID = 'retention-ws';

const OWNER: WorkspaceOwnerBinding = {
  type: 'organization',
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  bindingGeneration: 1,
};

const ADDED_REPO = {
  id: 'repo-added',
  name: 'Added',
  repoPath: '/repos/added',
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readManifest(): Promise<JsonRecord> {
  const parsed: unknown = JSON.parse(
    await readFile(getWorkspaceConfigPath(WORKSPACE_ID), 'utf8'),
  );
  if (!isRecord(parsed)) throw new Error('Expected a manifest object');
  return parsed;
}

async function seedManifest(extra: JsonRecord = {}): Promise<void> {
  const manifestPath = getWorkspaceConfigPath(WORKSPACE_ID);
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 1,
      type: 'multi-repo',
      repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' }],
      archiveRetentionDays: null,
      futureManifestField: { kept: true },
      ...extra,
    }),
  );
}

function update(
  patch: WorkspaceRetentionPatch,
): ReturnType<typeof updateWorkspaceRetention> {
  return updateWorkspaceRetention({
    workspaceId: WORKSPACE_ID,
    patch,
    source: 'workspace_settings',
  });
}

async function expectRefusal(
  promise: Promise<unknown>,
  reason: WorkspaceRetentionRefusedError['reason'],
  message: RegExp,
): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(WorkspaceRetentionRefusedError);
  expect(error).toMatchObject({ reason });
  expect(error instanceof Error ? error.message : '').toMatch(message);
}

describe('workspace retention boundary (real fs)', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-ws-retention-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    await seedManifest();
    jest.clearAllMocks();
  });

  afterEach(async () => {
    if (originalDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalDataDir;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it('writes the retention fields under the lease and archive lock', async () => {
    const outcome = await update({
      archiveRetentionDays: 14,
      autoArchiveDeleteBranch: true,
    });

    expect(outcome).toEqual({
      workspaceId: WORKSPACE_ID,
      activityBaselineRecorded: false,
    });
    expect(await readManifest()).toMatchObject({
      archiveRetentionDays: 14,
      autoArchiveDeleteBranch: true,
      futureManifestField: { kept: true },
    });
    expect(acquireWorkspaceArchiveRetentionLease).toHaveBeenCalledWith(
      WORKSPACE_ID,
    );
    expect(withArchivedWorkspaceOperationLock).toHaveBeenCalledWith(
      WORKSPACE_ID,
      expect.any(Function),
    );
    expect(mockReleaseLease).toHaveBeenCalledTimes(1);
    expect(touchAllWorkspaceTargets).not.toHaveBeenCalled();
  });

  it('stamps every worktree before turning Auto Delete on', async () => {
    const outcome = await update({
      archiveRetentionDays: 30,
      autoArchiveDays: 7,
    });

    expect(outcome.activityBaselineRecorded).toBe(true);
    expect(touchAllWorkspaceTargets).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(await readManifest()).toMatchObject({
      archiveRetentionDays: 30,
      autoArchiveDays: 7,
    });
  });

  it('does not stamp again when Auto Delete stays on', async () => {
    await seedManifest({ archiveRetentionDays: 30, autoArchiveDays: 7 });

    await update({ archiveRetentionDays: 30, autoArchiveDays: 14 });

    expect(touchAllWorkspaceTargets).not.toHaveBeenCalled();
  });

  it('leaves Auto Delete off when the activity baseline fails', async () => {
    jest
      .mocked(touchAllWorkspaceTargets)
      .mockRejectedValueOnce(new Error('baseline failed'));

    await expect(
      update({ archiveRetentionDays: 30, autoArchiveDays: 7 }),
    ).rejects.toThrow('baseline failed');

    expect(await readManifest()).not.toHaveProperty('autoArchiveDays');
    expect(mockReleaseLease).toHaveBeenCalledTimes(1);
  });

  it('keeps repository and ownership changes committed during the baseline', async () => {
    const concurrent: Array<Promise<unknown>> = [];
    jest.mocked(touchAllWorkspaceTargets).mockImplementationOnce(async () => {
      // Other writers start while the worktrees are stamped.
      concurrent.push(
        updateWorkspaceConfig(WORKSPACE_ID, (config): void => {
          config.repos.push({ ...ADDED_REPO });
        }),
        updateWorkspaceOwnership(WORKSPACE_ID, () => ({ owner: OWNER })),
      );
      await Promise.resolve();
    });

    await update({ archiveRetentionDays: 30, autoArchiveDays: 7 });
    await Promise.all(concurrent);

    const manifest = await readManifest();
    expect(manifest.repos).toEqual([
      { id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' },
      ADDED_REPO,
    ]);
    expect(manifest.owner).toEqual(OWNER);
    expect(manifest).toMatchObject({
      archiveRetentionDays: 30,
      autoArchiveDays: 7,
      futureManifestField: { kept: true },
    });
  });

  describe('refusals write nothing', () => {
    it.each<[string, WorkspaceRetentionPatch, RegExp]>([
      [
        'a negative retention',
        { archiveRetentionDays: -1 },
        /Archive retention must be null or an integer from 0 to/,
      ],
      [
        'a fractional retention',
        { archiveRetentionDays: 1.5 },
        /Archive retention must be null or an integer from 0 to/,
      ],
      [
        'a zero-day Auto Delete',
        { archiveRetentionDays: 30, autoArchiveDays: 0 },
        /Auto Delete inactivity must be null or an integer from 1 to/,
      ],
    ])('refuses %s', async (_name, patch, message) => {
      await expectRefusal(update(patch), 'invalid-patch', message);
      expect(acquireWorkspaceArchiveRetentionLease).not.toHaveBeenCalled();
    });

    it('refuses a branch deletion choice that is not a boolean', async () => {
      const patch: WorkspaceRetentionPatch = { archiveRetentionDays: 30 };
      Reflect.set(patch, 'autoArchiveDeleteBranch', 'yes');

      await expectRefusal(
        update(patch),
        'invalid-patch',
        /Auto Delete branch deletion must be a boolean/,
      );
    });

    it('refuses a Cowork workspace', async () => {
      await seedManifest({ type: 'cowork', cowork: {} });

      await expectRefusal(
        update({ archiveRetentionDays: 7 }),
        'unsupported-for-cowork',
        /Cowork retention is managed through cowork settings/,
      );

      expect(await readManifest()).toMatchObject({
        archiveRetentionDays: null,
      });
      expect(mockReleaseLease).toHaveBeenCalledTimes(1);
    });

    it('refuses an unreadable manifest and leaves it as it is', async () => {
      const manifestPath = getWorkspaceConfigPath(WORKSPACE_ID);
      await writeFile(manifestPath, '{"version":1,');

      await expectRefusal(
        update({ archiveRetentionDays: 30, autoArchiveDays: 7 }),
        'configuration-unavailable',
        /could not be read/,
      );

      expect(await readFile(manifestPath, 'utf8')).toBe('{"version":1,');
      expect(touchAllWorkspaceTargets).not.toHaveBeenCalled();
    });

    it('refuses a workspace without a manifest instead of creating one', async () => {
      await rm(getWorkspaceConfigPath(WORKSPACE_ID));

      await expectRefusal(
        update({ archiveRetentionDays: 7 }),
        'not-found',
        /not found/,
      );

      await expect(
        readFile(getWorkspaceConfigPath(WORKSPACE_ID), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});
