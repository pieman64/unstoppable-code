// CAN-3817: the typed core.workspace.privateMemory.update boundary and the
// organization private memory record (internal.workspace.ownership.record).
// Runs the real sidebar and persistence modules against a temporary data dir.
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

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  MultiRepoSidebarItem,
  WorkspaceOwnerBinding,
} from '@canopy/desktop-shared/types';
import { getWorkspaceConfigPath } from '../paths';
import {
  __resetSidebarItemsStateForTests,
  writeAllSidebarItems,
} from '../sidebar-items';
import {
  updateWorkspaceConfig,
  updateWorkspaceOwnership,
} from '../workspace-persistence';
import {
  recordOrganizationPrivateMemory,
  updateWorkspacePrivateMemory,
  WorkspacePrivateMemoryRefusedError,
} from '../workspace-private-memory';

const WORKSPACE_ID = 'memory-ws';

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

function workspaceItem(): MultiRepoSidebarItem {
  return {
    id: WORKSPACE_ID,
    name: 'Memory',
    type: 'multi-repo',
    color: '#0EA5E9',
    collapsed: false,
    order: 0,
    repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' }],
    worktrees: [],
  };
}

async function readManifest(): Promise<JsonRecord> {
  const parsed: unknown = JSON.parse(
    await readFile(getWorkspaceConfigPath(WORKSPACE_ID), 'utf8'),
  );
  if (!isRecord(parsed)) throw new Error('Expected a manifest object');
  return parsed;
}

async function editManifest(extra: JsonRecord): Promise<void> {
  await writeFile(
    getWorkspaceConfigPath(WORKSPACE_ID),
    JSON.stringify({ ...(await readManifest()), ...extra }),
  );
}

async function expectRefusal(
  promise: Promise<unknown>,
  reason: WorkspacePrivateMemoryRefusedError['reason'],
  message: RegExp,
): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(WorkspacePrivateMemoryRefusedError);
  expect(error).toMatchObject({ reason });
  expect(error instanceof Error ? error.message : '').toMatch(message);
}

function setLocal(
  privateMemory: boolean,
): ReturnType<typeof updateWorkspacePrivateMemory> {
  return updateWorkspacePrivateMemory({
    workspaceId: WORKSPACE_ID,
    privateMemory,
    source: 'workspace_settings',
  });
}

function recordOrganization(
  privateMemory: boolean,
  projectId: string = OWNER.projectId,
): Promise<boolean> {
  return recordOrganizationPrivateMemory({
    workspaceId: WORKSPACE_ID,
    organizationId: OWNER.organizationId,
    projectId,
    privateMemory,
  });
}

describe('workspace private memory boundary (real fs)', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    __resetSidebarItemsStateForTests();
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-ws-memory-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    await writeAllSidebarItems([workspaceItem()]);
    await editManifest({ futureManifestField: { kept: true } });
  });

  afterEach(async () => {
    if (originalDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalDataDir;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('updateWorkspacePrivateMemory', () => {
    it('persists an explicit choice and keeps every other field', async () => {
      await expect(setLocal(false)).resolves.toEqual({
        workspaceId: WORKSPACE_ID,
        privateMemory: false,
      });

      const manifest = await readManifest();
      expect(manifest.privateMemory).toBe(false);
      expect(manifest.futureManifestField).toEqual({ kept: true });
      expect(manifest.repos).toEqual([
        { id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' },
      ]);
    });

    it('applies after an earlier queued repository and ownership change', async () => {
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const held = updateWorkspaceConfig(
        WORKSPACE_ID,
        async (config): Promise<void> => {
          await gate;
          config.repos.push({ ...ADDED_REPO });
          config.owner = OWNER;
        },
        { ownership: 'replace' },
      );
      const pending = setLocal(true);
      release();
      await Promise.all([held, pending]);

      const manifest = await readManifest();
      expect(manifest.repos).toEqual([
        { id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' },
        ADDED_REPO,
      ]);
      expect(manifest.owner).toEqual(OWNER);
      expect(manifest.privateMemory).toBe(true);
    });

    it('refuses once an organization policy lands ahead of it in the queue', async () => {
      await updateWorkspaceOwnership(WORKSPACE_ID, () => ({ owner: OWNER }));
      const organization = recordOrganization(false);
      const local = setLocal(true);

      await expect(organization).resolves.toBe(true);
      await expectRefusal(
        local,
        'managed-by-organization',
        /Private memory is managed by your organization/,
      );
      expect(await readManifest()).toMatchObject({
        privateMemory: false,
        privateMemoryManagedBy: 'organization',
      });
    });

    it('refuses a workspace that is not indexed', async () => {
      await expectRefusal(
        updateWorkspacePrivateMemory({
          workspaceId: 'missing-ws',
          privateMemory: true,
          source: 'workspace_settings',
        }),
        'not-found',
        /Project was not found/,
      );
    });

    it('refuses a value that is not a boolean', async () => {
      const request = {
        workspaceId: WORKSPACE_ID,
        privateMemory: true,
        source: 'workspace_settings' as const,
      };
      Reflect.set(request, 'privateMemory', 'true');

      await expectRefusal(
        updateWorkspacePrivateMemory(request),
        'invalid-patch',
        /Private memory must be a boolean/,
      );
      expect(await readManifest()).not.toHaveProperty('privateMemory');
    });

    it('refuses an unreadable manifest and leaves it as it is', async () => {
      const manifestPath = getWorkspaceConfigPath(WORKSPACE_ID);
      await writeFile(manifestPath, '{"version":1,');

      await expectRefusal(
        setLocal(true),
        'configuration-unavailable',
        /Project configuration is unavailable/,
      );

      expect(await readFile(manifestPath, 'utf8')).toBe('{"version":1,');
    });

    it('refuses a memory policy this version cannot read', async () => {
      await editManifest({ privateMemory: 'sometimes' });

      await expectRefusal(
        setLocal(true),
        'configuration-unavailable',
        /Project configuration is unavailable/,
      );

      expect((await readManifest()).privateMemory).toBe('sometimes');
    });

    it('refuses an indexed workspace without a manifest instead of creating one', async () => {
      await rm(getWorkspaceConfigPath(WORKSPACE_ID));

      await expectRefusal(
        setLocal(true),
        'configuration-unavailable',
        /Project configuration is unavailable/,
      );

      await expect(
        readFile(getWorkspaceConfigPath(WORKSPACE_ID), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe('recordOrganizationPrivateMemory', () => {
    beforeEach(async () => {
      await updateWorkspaceOwnership(WORKSPACE_ID, () => ({ owner: OWNER }));
    });

    it('stamps the inherited value and its marker together', async () => {
      await expect(recordOrganization(false)).resolves.toBe(true);

      expect(await readManifest()).toMatchObject({
        privateMemory: false,
        privateMemoryManagedBy: 'organization',
        owner: OWNER,
        futureManifestField: { kept: true },
      });
    });

    it('writes nothing when the policy is already recorded', async () => {
      await recordOrganization(true);
      const before = await readFile(getWorkspaceConfigPath(WORKSPACE_ID));

      await expect(recordOrganization(true)).resolves.toBe(false);

      expect(await readFile(getWorkspaceConfigPath(WORKSPACE_ID))).toEqual(
        before,
      );
    });

    it('refuses a workspace bound to another organization project', async () => {
      await expect(recordOrganization(true, 'wrong-project')).rejects.toThrow(
        'Organization project config is unavailable for memory policy',
      );

      expect(await readManifest()).not.toHaveProperty('privateMemory');
    });

    it('refuses an unreadable manifest and leaves it as it is', async () => {
      const manifestPath = getWorkspaceConfigPath(WORKSPACE_ID);
      await writeFile(manifestPath, '{"version":1,');

      await expectRefusal(
        recordOrganization(false),
        'configuration-unavailable',
        /Organization project config is unavailable for memory policy/,
      );

      expect(await readFile(manifestPath, 'utf8')).toBe('{"version":1,');
    });
  });
});
