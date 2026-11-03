// CAN-3563: a degraded read of a workspace's `workspace.json` must never turn
// into a destructive rewrite. A multi-repo project lost its repositories when
// a sidebar save read the file mid-write (or hit EMFILE), got the default
// `{ type: 'multi-repo', repos: [] }`, and wrote that back. Runs the real
// sidebar-items, workspace-persistence and caller modules against a temporary
// data dir; only `node:fs/promises` is wrapped so a test can hand one
// `workspace.json` read a truncated file or an I/O error.
import type * as FsPromises from 'node:fs/promises';

type ConfigReadFault = 'truncated' | 'emfile';
const mockConfigReadFaults = new Map<string, ConfigReadFault>();
// Workspaces whose `workspace.json` stays unreadable (EACCES, as after
// `chmod 000`) on every read until the test clears it.
const mockPermissionDeniedConfigs = new Set<string>();
let mockOnInPlaceConfigWrite: ((target: string) => Promise<void>) | null = null;

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  const workspaceIdOf = (target: unknown): string | null => {
    if (typeof target !== 'string') return null;
    const match = /[\\/]workspaces[\\/]([^\\/]+)[\\/]workspace\.json$/.exec(
      target,
    );
    return match?.[1] ?? null;
  };
  return {
    ...actual,
    readFile: jest.fn(
      async (...args: Parameters<typeof actual.readFile>): Promise<unknown> => {
        const workspaceId = workspaceIdOf(args[0]);
        if (
          workspaceId !== null &&
          mockPermissionDeniedConfigs.has(workspaceId)
        ) {
          throw Object.assign(new Error('EACCES: permission denied'), {
            code: 'EACCES',
          });
        }
        const fault =
          workspaceId === null
            ? undefined
            : mockConfigReadFaults.get(workspaceId);
        if (workspaceId !== null && fault !== undefined) {
          mockConfigReadFaults.delete(workspaceId);
          if (fault === 'emfile') {
            throw Object.assign(new Error('EMFILE: too many open files'), {
              code: 'EMFILE',
            });
          }
          return '{"version": 1, "type": "multi-re';
        }
        return actual.readFile(...args);
      },
    ),
    writeFile: jest.fn(
      async (...args: Parameters<typeof actual.writeFile>): Promise<void> => {
        const [target] = args;
        const hook = mockOnInPlaceConfigWrite;
        if (hook && typeof target === 'string' && workspaceIdOf(target)) {
          // An in-place write truncates the file before the new bytes land;
          // let a concurrent reader observe that window.
          await actual.writeFile(target, '');
          await hook(target);
        }
        await actual.writeFile(...args);
      },
    ),
  };
});

const mockRecordAppDiagnostic = jest.fn();
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: mockRecordAppDiagnostic,
  })),
}));
jest.mock('../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../lib/desktop-telemetry', () => ({
  ...jest.requireActual<object>('../lib/desktop-telemetry'),
  recordWorkspaceCrudTelemetry: jest.fn(),
}));
jest.mock('../lib/git', () => ({
  ...jest.requireActual<object>('../lib/git'),
  isGitRepo: jest.fn((): Promise<boolean> => Promise.resolve(true)),
}));

import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  CoworkSidebarItem,
  MultiRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import { getWorkspaceConfigPath } from '../lib/paths';
import {
  __resetSidebarItemsStateForTests,
  readAllSidebarItems,
  readAllSidebarItemsSnapshot,
  writeAllSidebarItems,
} from '../lib/sidebar-items';
import { updateWorkspaceMetadata } from '../lib/workspace-metadata';
import {
  readWorkspaceConfigDetailed,
  writeWorkspaceConfig,
  setWorktreeRegistryReconciler,
  type PersistedFileAuthority,
} from '../lib/workspace-persistence';
import { addWorkspaceRepository } from '../lib/workspace-repositories';
import { saveWorkspaceHooksFromService } from '../services/hooks-service';
import { saveWorkspaceRepoScripts } from '../lib/script-definition-saves';
import {
  DESKTOP_SCRIPT_CALLER,
  scriptDefinitionsDispatcher,
} from './helpers/script-definitions-dispatcher';
import { updateWorkspacePlanDetection } from '../lib/workspace-script-hook-settings';

const MULTI_ID = 'multi';
const NOTES_ID = 'notes';
const TRUNCATED_CONFIG = '{"version": 1, "type": "multi-repo", "re';

async function readRepoIdsOnDisk(workspaceId: string): Promise<string[]> {
  const parsed: unknown = JSON.parse(
    await readFile(getWorkspaceConfigPath(workspaceId), 'utf8'),
  );
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('repos' in parsed) ||
    !Array.isArray(parsed.repos)
  ) {
    throw new Error(`Expected a workspace config for ${workspaceId}`);
  }
  return parsed.repos.map((repo: { id: string }) => repo.id);
}

describe('workspace.json integrity (real fs)', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;

  function multiRepoItem(): MultiRepoSidebarItem {
    return {
      type: 'multi-repo',
      id: MULTI_ID,
      name: 'Multi',
      color: '#7C3AED',
      collapsed: false,
      order: 0,
      repos: [
        { id: 'api', name: 'api', repoPath: path.join(dataDir, 'src', 'api') },
        { id: 'web', name: 'web', repoPath: path.join(dataDir, 'src', 'web') },
      ],
      worktrees: [],
    };
  }

  function notesItem(): CoworkSidebarItem {
    return {
      type: 'cowork',
      id: NOTES_ID,
      name: 'Notes',
      color: '#7C3AED',
      collapsed: false,
      order: 1,
      cowork: { createdAt: '2026-09-01T00:00:00.000Z' },
    };
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    __resetSidebarItemsStateForTests();
    mockConfigReadFaults.clear();
    mockPermissionDeniedConfigs.clear();
    mockOnInPlaceConfigWrite = null;
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-config-integrity-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    await mkdir(path.join(dataDir, 'src', 'api'), { recursive: true });
    await mkdir(path.join(dataDir, 'src', 'web'), { recursive: true });
    await writeAllSidebarItems([multiRepoItem(), notesItem()]);
    expect(await readRepoIdsOnDisk(MULTI_ID)).toEqual(['api', 'web']);
  });

  afterEach(async () => {
    mockOnInPlaceConfigWrite = null;
    mockPermissionDeniedConfigs.clear();
    if (originalDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalDataDir;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it('preserves an unreadable worktree registry while saving healthy sidebar projects', async () => {
    setWorktreeRegistryReconciler((_workspaceId, _current, next) =>
      Promise.resolve({ rows: next }),
    );
    const registryPath = path.join(
      dataDir,
      'workspaces',
      MULTI_ID,
      'worktrees.json',
    );
    const configPath = getWorkspaceConfigPath(MULTI_ID);
    const configBefore = await readFile(configPath, 'utf8');
    const indexPath = path.join(dataDir, 'workspaces', 'index.json');
    const readPreservedIndexEntry = async (): Promise<unknown> => {
      const index: unknown = JSON.parse(await readFile(indexPath, 'utf8'));
      if (
        typeof index !== 'object' ||
        index === null ||
        !('workspaces' in index) ||
        !Array.isArray(index.workspaces)
      ) {
        throw new Error('Expected workspace index');
      }
      return index.workspaces.find(
        (entry: unknown) =>
          typeof entry === 'object' &&
          entry !== null &&
          'id' in entry &&
          entry.id === MULTI_ID,
      );
    };
    const indexBefore = await readPreservedIndexEntry();
    const unreadable = '{"version":1,"worktrees":[';
    await writeFile(registryPath, unreadable);
    const result = await writeAllSidebarItems([
      {
        ...multiRepoItem(),
        name: 'Stale replacement',
        color: '#ffffff',
        collapsed: true,
        repos: [],
      },
      { ...notesItem(), collapsed: true },
    ]);
    expect(await readFile(registryPath, 'utf8')).toBe(unreadable);
    expect(await readFile(configPath, 'utf8')).toBe(configBefore);
    expect(await readPreservedIndexEntry()).toEqual(indexBefore);
    expect(result.preservedWorkspaceIds).toEqual([MULTI_ID]);
    expect(result.items.map((item) => item.id)).toEqual([NOTES_ID]);
    const after = await readAllSidebarItems();
    expect(after.items.find((item) => item.id === NOTES_ID)?.collapsed).toBe(
      true,
    );
  });

  it.each<ConfigReadFault>(['truncated', 'emfile'])(
    'never reads another workspace.json (%s) when collapsing a project',
    async (fault) => {
      mockConfigReadFaults.set(MULTI_ID, fault);

      // Collapsing another project writes only that project's index entry
      // (CAN-3807), so this project's config is neither read nor written.
      await updateWorkspaceMetadata({
        workspaceId: NOTES_ID,
        patch: { collapsed: true },
        source: 'portal',
      });

      expect(mockConfigReadFaults.get(MULTI_ID)).toBe(fault);
      mockConfigReadFaults.delete(MULTI_ID);
      expect(await readRepoIdsOnDisk(MULTI_ID)).toEqual(['api', 'web']);
      const after = await readAllSidebarItems();
      expect(after.items.find((item) => item.id === NOTES_ID)?.collapsed).toBe(
        true,
      );
      expect(after.items.map((item) => item.id)).toContain(MULTI_ID);
    },
  );

  it('reports a sidebar snapshot whose worktree list has a row it cannot read as partial', async () => {
    // Inventory sync removes cloud documents only on an authoritative
    // snapshot; a left-out row must not read as a deleted worktree (CAN-3803).
    await writeFile(
      path.join(dataDir, 'workspaces', MULTI_ID, 'worktrees.json'),
      JSON.stringify({
        version: 1,
        worktrees: [{ id: 'otter', branchName: 'branch-otter' }],
      }),
    );

    const snapshot = await readAllSidebarItemsSnapshot();

    expect(snapshot.authority).toBe('partial');
    expect(snapshot.file.items.map((item) => item.id)).toContain(MULTI_ID);
  });

  it('reports an unreadable workspace.json as a load warning', async () => {
    mockConfigReadFaults.set(MULTI_ID, 'truncated');

    const loaded = await readAllSidebarItems();

    expect(loaded.items.map((item) => item.id)).toEqual([NOTES_ID]);
    expect(loaded.warnings).toEqual([
      expect.objectContaining({
        code: 'workspace-load-failed',
        workspaceId: MULTI_ID,
      }),
    ]);
  });

  it('never exposes a partially written workspace.json to a reader', async () => {
    const observed: PersistedFileAuthority[] = [];
    mockOnInPlaceConfigWrite = async (): Promise<void> => {
      observed.push((await readWorkspaceConfigDetailed(MULTI_ID)).authority);
    };

    const { config } = await readWorkspaceConfigDetailed(MULTI_ID);
    await writeWorkspaceConfig(MULTI_ID, { ...config, alwaysShow: false });
    mockOnInPlaceConfigWrite = null;

    expect(observed.filter((authority) => authority !== 'ok')).toEqual([]);
    const after = await readWorkspaceConfigDetailed(MULTI_ID);
    expect(after.authority).toBe('ok');
    expect(after.config.alwaysShow).toBe(false);
    expect(after.config.repos.map((repo) => repo.id)).toEqual(['api', 'web']);
  });

  describe('read-modify-write callers refuse an unreadable workspace.json', () => {
    beforeEach(async () => {
      await writeFile(getWorkspaceConfigPath(MULTI_ID), TRUNCATED_CONFIG);
    });

    async function expectUntouched(): Promise<void> {
      expect(await readFile(getWorkspaceConfigPath(MULTI_ID), 'utf8')).toBe(
        TRUNCATED_CONFIG,
      );
    }

    it('plain write built without reading the file', async () => {
      await expect(
        writeWorkspaceConfig(MULTI_ID, {
          version: 1,
          type: 'multi-repo',
          repos: multiRepoItem().repos,
        }),
      ).rejects.toThrow(/could not be read/i);
      await expectUntouched();
    });

    it('add repository', async () => {
      await expect(
        addWorkspaceRepository({
          workspaceId: MULTI_ID,
          source: 'workspace_settings',
          repository: { repoPath: path.join(dataDir, 'src', 'docs') },
        }),
      ).rejects.toThrow(/could not be read/i);
      await expectUntouched();
    });

    it('save project hooks', async () => {
      await expect(
        saveWorkspaceHooksFromService({ workspaceId: MULTI_ID, hooks: {} }),
      ).rejects.toThrow(/could not be read/i);
      await expectUntouched();
    });

    it('save repository scripts', async () => {
      await expect(
        saveWorkspaceRepoScripts(
          scriptDefinitionsDispatcher(),
          DESKTOP_SCRIPT_CALLER,
          {
            workspaceId: MULTI_ID,
            repos: [{ repoId: 'api', scripts: { setup: 'npm ci' } }],
          },
        ),
      ).rejects.toThrow(/could not be read/i);
      await expectUntouched();
    });

    it('save plan detection', async () => {
      await expect(
        updateWorkspacePlanDetection({
          workspaceId: MULTI_ID,
          planDetection: { disabledRuleIds: ['rule'] },
          source: 'desktop',
        }),
      ).rejects.toThrow(/could not be read/i);
      await expectUntouched();
      expect(mockRecordAppDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'workspace_config_write_refused' }),
      );
    });
  });
  describe('a renderer save that still carries the project', () => {
    // The renderer keeps a last-good item for a project whose config stopped
    // loading; a reorder sends that item back without marking it preserved.
    function reorderedStaleItems(): Array<
      MultiRepoSidebarItem | CoworkSidebarItem
    > {
      return [
        { ...notesItem(), order: 0 },
        { ...multiRepoItem(), order: 1 },
      ];
    }

    const ownershipTransfer = {
      version: 1,
      previousOwner: { type: 'personal' },
      organizationId: '6f1c2a40-8d3b-4c1e-9a7f-1b2c3d4e5f60',
      projectId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      convertedAt: '2026-09-01T00:00:00.000Z',
    };

    /** Adds fields no sidebar item carries, as a CAN-3532 conversion does. */
    async function addFieldsTheSidebarItemDoesNotCarry(): Promise<void> {
      const configPath = getWorkspaceConfigPath(MULTI_ID);
      const onDisk: unknown = JSON.parse(await readFile(configPath, 'utf8'));
      if (typeof onDisk !== 'object' || onDisk === null) {
        throw new Error('Expected a workspace config object');
      }
      await writeFile(
        configPath,
        JSON.stringify(
          {
            ...onDisk,
            ownershipTransfer,
            planDetection: { disabledRuleIds: ['rule-a'] },
            recommendedPluginOptOutKeys: ['plugin-a'],
          },
          null,
          2,
        ),
      );
    }

    it.each<'truncated' | 'permission-denied'>([
      'truncated',
      'permission-denied',
    ])('leaves a %s workspace.json byte-identical', async (fault) => {
      const configPath = getWorkspaceConfigPath(MULTI_ID);
      if (fault === 'truncated') {
        await writeFile(configPath, TRUNCATED_CONFIG);
      } else {
        await addFieldsTheSidebarItemDoesNotCarry();
      }
      const before = await readFile(configPath, 'utf8');
      const inodeBefore = (await stat(configPath)).ino;
      if (fault === 'permission-denied') {
        // As after `chmod 000` while the app runs.
        mockPermissionDeniedConfigs.add(MULTI_ID);
      }

      const result = await writeAllSidebarItems(reorderedStaleItems(), {
        replaceWorkspaceOrder: true,
        preserveUnmentionedWorkspaceIds: true,
      });
      mockPermissionDeniedConfigs.clear();

      expect(await readFile(configPath, 'utf8')).toBe(before);
      expect((await stat(configPath)).ino).toBe(inodeBefore);
      expect(result.preservedWorkspaceIds).toEqual([MULTI_ID]);
      expect(result.items.map((item) => item.id)).toEqual([NOTES_ID]);
    });

    it('keeps workspace.json fields the sidebar item does not carry', async () => {
      await addFieldsTheSidebarItemDoesNotCarry();

      await writeAllSidebarItems(reorderedStaleItems(), {
        replaceWorkspaceOrder: true,
        preserveUnmentionedWorkspaceIds: true,
      });

      const after = await readWorkspaceConfigDetailed(MULTI_ID);
      expect(after.authority).toBe('ok');
      expect(after.config.repos.map((repo) => repo.id)).toEqual(['api', 'web']);
      expect(after.config.ownershipTransfer).toEqual(ownershipTransfer);
      expect(after.config.planDetection).toEqual({
        disabledRuleIds: ['rule-a'],
      });
      expect(after.config.recommendedPluginOptOutKeys).toEqual(['plugin-a']);
    });
  });

  describe('unknown workspace.json fields (CAN-3800)', () => {
    async function readConfigOnDisk(): Promise<Record<string, unknown>> {
      const parsed: unknown = JSON.parse(
        await readFile(getWorkspaceConfigPath(MULTI_ID), 'utf8'),
      );
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('Expected a workspace config object');
      }
      return { ...parsed };
    }

    /** Fields a newer app could write that this version does not know. */
    async function addUnknownFields(): Promise<void> {
      const onDisk = await readConfigOnDisk();
      const repos = Array.isArray(onDisk.repos) ? onDisk.repos : [];
      await writeFile(
        getWorkspaceConfigPath(MULTI_ID),
        JSON.stringify(
          {
            ...onDisk,
            futureSetting: { level: 2 },
            planDetection: { disabledRuleIds: ['rule-a'] },
            repos: repos.map((repo: unknown) =>
              typeof repo === 'object' &&
              repo !== null &&
              'id' in repo &&
              repo.id === 'api'
                ? { ...repo, futureRepoField: 'kept' }
                : repo,
            ),
          },
          null,
          2,
        ),
      );
    }

    beforeEach(addUnknownFields);

    it('keeps unknown project and repository fields through a targeted update', async () => {
      await updateWorkspacePlanDetection({
        workspaceId: MULTI_ID,
        planDetection: { disabledRuleIds: ['rule-b'] },
        source: 'desktop',
      });

      const onDisk = await readConfigOnDisk();
      expect(onDisk.futureSetting).toEqual({ level: 2 });
      expect(onDisk.planDetection).toEqual({ disabledRuleIds: ['rule-b'] });
      expect(onDisk.repos).toEqual([
        expect.objectContaining({ id: 'api', futureRepoField: 'kept' }),
        expect.objectContaining({ id: 'web' }),
      ]);
      expect(JSON.stringify(onDisk.repos).match(/futureRepoField/g)).toEqual([
        'futureRepoField',
      ]);
    });

    it('keeps unknown fields through a sidebar save and a deliberate clear', async () => {
      await writeAllSidebarItems([multiRepoItem(), notesItem()]);
      const { config } = await readWorkspaceConfigDetailed(MULTI_ID);
      await writeWorkspaceConfig(MULTI_ID, {
        ...config,
        planDetection: undefined,
      });

      const onDisk = await readConfigOnDisk();
      expect(onDisk.futureSetting).toEqual({ level: 2 });
      expect(onDisk).not.toHaveProperty('planDetection');
      expect(onDisk.repos).toEqual([
        expect.objectContaining({ id: 'api', futureRepoField: 'kept' }),
        expect.objectContaining({ id: 'web' }),
      ]);
    });

    it('drops the fields of a repository the write removes', async () => {
      const { config } = await readWorkspaceConfigDetailed(MULTI_ID);
      await writeWorkspaceConfig(MULTI_ID, {
        ...config,
        repos: config.repos.filter((repo) => repo.id !== 'api'),
      });

      const onDisk = await readConfigOnDisk();
      expect(onDisk.repos).toEqual([expect.objectContaining({ id: 'web' })]);
      expect(JSON.stringify(onDisk)).not.toContain('futureRepoField');
    });
  });
});
