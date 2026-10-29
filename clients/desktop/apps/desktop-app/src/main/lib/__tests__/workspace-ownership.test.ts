// CAN-3819: internal.workspace.ownership.record. Runs the real sidebar and
// persistence modules against a temporary data dir.
let mockOrgProjectsEnabled = true;
jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): unknown => ({
    isEnabled: (): boolean => mockOrgProjectsEnabled,
  }),
}));
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

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  SingleRepoSidebarItem,
  WorkspaceOwnerBinding,
} from '@canopy/desktop-shared/types';
import { getWorkspaceConfigPath, getWorkspaceIndexFilePath } from '../paths';
import {
  __resetSidebarItemsStateForTests,
  writeAllSidebarItems,
} from '../sidebar-items';
import { updateWorkspaceConfig } from '../workspace-persistence';
import {
  rebindWorkspaceHookExecutionContexts,
  recordOrganizationHookBindings,
  recordPersonalCatalogId,
  recordWorkspaceOwner,
  refreshOrganizationOwner,
  releaseAdoptedWorkspace,
  WorkspaceOwnershipRecordRefusedError,
} from '../workspace-ownership';

type JsonRecord = Record<string, unknown>;
type OrganizationOwner = Extract<
  WorkspaceOwnerBinding,
  { type: 'organization' }
>;

const OWNER: OrganizationOwner = {
  type: 'organization',
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  bindingGeneration: 2,
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(filePath: string): Promise<JsonRecord> {
  const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`Expected an object in ${filePath}`);
  return parsed;
}

async function indexedIds(): Promise<string[]> {
  const index = await readJson(getWorkspaceIndexFilePath());
  const workspaces: unknown[] = Array.isArray(index.workspaces)
    ? index.workspaces
    : [];
  return workspaces.flatMap((entry) =>
    isRecord(entry) && typeof entry.id === 'string' ? [entry.id] : [],
  );
}

function project(id: string, order: number): SingleRepoSidebarItem {
  return {
    id,
    name: id,
    type: 'single-repo',
    color: '#0EA5E9',
    collapsed: false,
    order,
    repoPath: `/repos/${id}`,
    worktrees: [],
  };
}

async function bind(
  workspaceId: string,
  owner: OrganizationOwner,
): Promise<void> {
  await updateWorkspaceConfig(
    workspaceId,
    (config): void => {
      config.owner = owner;
    },
    { ownership: 'replace' },
  );
}

describe('workspace ownership records (real fs)', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    __resetSidebarItemsStateForTests();
    mockOrgProjectsEnabled = true;
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-ws-ownership-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    await writeAllSidebarItems([project('adopted', 0), project('mine', 1)]);
  });

  afterEach(async () => {
    if (originalDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalDataDir;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('recordWorkspaceOwner', () => {
    it('replaces the binding from the current ownership and keeps the rest', async () => {
      await updateWorkspaceConfig('adopted', (config): void => {
        config.archiveRetentionDays = 5;
      });
      await expect(
        recordWorkspaceOwner({
          workspaceId: 'adopted',
          source: 'org_project_materialization',
          update: (current) =>
            current.owner === undefined ? { owner: OWNER } : null,
        }),
      ).resolves.toBe('written');
      expect(await readJson(getWorkspaceConfigPath('adopted'))).toMatchObject({
        owner: OWNER,
        archiveRetentionDays: 5,
      });

      await expect(
        recordWorkspaceOwner({
          workspaceId: 'adopted',
          source: 'org_project_materialization',
          update: (current) =>
            current.owner === undefined ? { owner: OWNER } : null,
        }),
      ).resolves.toBe('declined');
      await expect(
        recordWorkspaceOwner({
          workspaceId: 'missing',
          source: 'org_project_materialization',
          update: () => ({ owner: OWNER }),
        }),
      ).resolves.toBe('absent');
      expect(existsSync(getWorkspaceConfigPath('missing'))).toBe(false);
    });
  });

  describe('refreshOrganizationOwner', () => {
    it('only moves the fence forward on the same instance', async () => {
      await bind('adopted', OWNER);

      await expect(
        refreshOrganizationOwner({
          workspaceId: 'adopted',
          source: 'org_project_reclaim',
          owner: { ...OWNER, bindingGeneration: 1 },
        }),
      ).resolves.toEqual(OWNER);
      expect((await readJson(getWorkspaceConfigPath('adopted'))).owner).toEqual(
        OWNER,
      );

      const advanced = { ...OWNER, bindingGeneration: 3 };
      await expect(
        refreshOrganizationOwner({
          workspaceId: 'adopted',
          source: 'org_project_reclaim',
          owner: advanced,
        }),
      ).resolves.toEqual(advanced);
      expect((await readJson(getWorkspaceConfigPath('adopted'))).owner).toEqual(
        advanced,
      );
    });

    it('refuses a workspace bound to anything else and leaves it', async () => {
      await bind('adopted', OWNER);
      for (const workspaceId of ['adopted', 'mine', 'missing']) {
        const error: unknown = await refreshOrganizationOwner({
          workspaceId,
          source: 'org_project_reclaim',
          owner: {
            ...OWNER,
            instanceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            bindingGeneration: 9,
          },
        }).then(
          () => undefined,
          (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(WorkspaceOwnershipRecordRefusedError);
        expect(error).toMatchObject({
          reason: 'binding-mismatch',
          message: 'Existing workspace has a different organization binding',
        });
      }
      expect((await readJson(getWorkspaceConfigPath('adopted'))).owner).toEqual(
        OWNER,
      );
    });
  });

  describe('recordPersonalCatalogId', () => {
    it('enrolls a Personal workspace once and never an organization one', async () => {
      const id = await recordPersonalCatalogId({
        workspaceId: 'mine',
        source: 'personal_catalog_sync',
        allowed: () => Promise.resolve(true),
      });
      expect(typeof id).toBe('string');
      await expect(
        recordPersonalCatalogId({
          workspaceId: 'mine',
          source: 'personal_catalog_sync',
          allowed: () => Promise.resolve(true),
        }),
      ).resolves.toBe(id);
      expect(
        (await readJson(getWorkspaceConfigPath('mine'))).personalCatalogId,
      ).toBe(id);

      await bind('adopted', OWNER);
      await expect(
        recordPersonalCatalogId({
          workspaceId: 'adopted',
          source: 'personal_catalog_sync',
          allowed: () => Promise.resolve(true),
        }),
      ).resolves.toBeUndefined();
      await expect(
        recordPersonalCatalogId({
          workspaceId: 'mine',
          source: 'personal_catalog_sync',
          allowed: () => Promise.resolve(false),
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('recordOrganizationHookBindings', () => {
    it('binds inherited organization hooks under the persisted owner', async () => {
      await bind('adopted', OWNER);
      const sourceHooks = {
        'worktree:created': [{ type: 'chat' as const, prompt: 'Review' }],
      };

      const bound = await recordOrganizationHookBindings({
        workspaceId: 'adopted',
        source: 'hook_resolution',
        sourceHooks,
        localHooks: undefined,
        owner: OWNER,
      });

      expect(bound.owner).toEqual(OWNER);
      expect(bound.hooks).toBeDefined();
      expect((await readJson(getWorkspaceConfigPath('adopted'))).hooks).toEqual(
        bound.hooks,
      );

      mockOrgProjectsEnabled = false;
      await expect(
        recordOrganizationHookBindings({
          workspaceId: 'mine',
          source: 'hook_resolution',
          sourceHooks,
          localHooks: undefined,
          owner: OWNER,
        }),
      ).resolves.toEqual({ hooks: undefined, owner: OWNER });
      expect(
        (await readJson(getWorkspaceConfigPath('mine'))).hooks,
      ).toBeUndefined();
    });
  });

  describe('rebindWorkspaceHookExecutionContexts', () => {
    it('writes only when a hook was rebound and never creates a manifest', async () => {
      await updateWorkspaceConfig('mine', (config): void => {
        config.hooks = {
          'worktree:created': [
            {
              type: 'chat',
              id: 'review',
              prompt: 'Review',
              executionContext: 'personal',
            },
          ],
        };
      });

      await expect(
        rebindWorkspaceHookExecutionContexts({
          workspaceId: 'mine',
          source: 'background_execution_rebinding',
          previousContext: 'personal',
          nextContext: `org:${OWNER.organizationId}`,
        }),
      ).resolves.toEqual(['workspace-root:worktree:created:0']);
      expect(
        (await readJson(getWorkspaceConfigPath('mine'))).hooks,
      ).toMatchObject({
        'worktree:created': [
          { executionContext: `org:${OWNER.organizationId}` },
        ],
      });

      await expect(
        rebindWorkspaceHookExecutionContexts({
          workspaceId: 'missing',
          source: 'background_execution_rebinding',
          previousContext: 'personal',
          nextContext: `org:${OWNER.organizationId}`,
        }),
      ).resolves.toEqual([]);
      expect(existsSync(getWorkspaceConfigPath('missing'))).toBe(false);
    });
  });

  describe('releaseAdoptedWorkspace', () => {
    it('removes only the adopted entry while this instance owns it', async () => {
      await bind('adopted', OWNER);
      const index = await readJson(getWorkspaceIndexFilePath());
      await writeFile(
        getWorkspaceIndexFilePath(),
        JSON.stringify({ ...index, futureIndexField: { kept: true } }),
      );

      await expect(
        releaseAdoptedWorkspace({
          workspaceId: 'adopted',
          source: 'org_project_adoption_rollback',
          instanceId: OWNER.instanceId,
        }),
      ).resolves.toBe(true);

      expect(await indexedIds()).toEqual(['mine']);
      expect(await readJson(getWorkspaceIndexFilePath())).toMatchObject({
        futureIndexField: { kept: true },
      });
      // The adopted workspace's files stay, as before.
      expect(existsSync(getWorkspaceConfigPath('adopted'))).toBe(true);
    });

    it('keeps a workspace bound to another instance or to nobody', async () => {
      await bind('adopted', {
        ...OWNER,
        instanceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      });
      for (const workspaceId of ['adopted', 'mine']) {
        await expect(
          releaseAdoptedWorkspace({
            workspaceId,
            source: 'org_project_adoption_rollback',
            instanceId: OWNER.instanceId,
          }),
        ).resolves.toBe(false);
      }
      expect(await indexedIds()).toEqual(['adopted', 'mine']);
    });

    it('keeps a workspace whose owner cannot be read, as before', async () => {
      await bind('adopted', OWNER);
      const manifest = await readJson(getWorkspaceConfigPath('adopted'));
      await writeFile(
        getWorkspaceConfigPath('adopted'),
        JSON.stringify({ ...manifest, owner: { type: 'organization' } }),
      );

      // Not undone: the setup journal stays in flight for the next sweep.
      await expect(
        releaseAdoptedWorkspace({
          workspaceId: 'adopted',
          source: 'org_project_adoption_rollback',
          instanceId: OWNER.instanceId,
        }),
      ).resolves.toBe(false);
      expect(await indexedIds()).toEqual(['adopted', 'mine']);
    });

    it('counts a workspace that is not indexed or not readable as undone', async () => {
      await expect(
        releaseAdoptedWorkspace({
          workspaceId: 'missing',
          source: 'org_project_adoption_rollback',
          instanceId: OWNER.instanceId,
        }),
      ).resolves.toBe(true);
      await writeFile(getWorkspaceConfigPath('adopted'), '{"truncated":');
      await expect(
        releaseAdoptedWorkspace({
          workspaceId: 'adopted',
          source: 'org_project_adoption_rollback',
          instanceId: OWNER.instanceId,
        }),
      ).resolves.toBe(true);
      expect(await indexedIds()).toEqual(['adopted', 'mine']);
    });
  });
});
