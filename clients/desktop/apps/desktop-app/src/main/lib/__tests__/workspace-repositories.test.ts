// CAN-3819: the typed core.workspace.repository.add / .remove boundary.
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
jest.mock('../git', () => ({
  isGitRepo: jest.fn(() => Promise.resolve(true)),
}));

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  MultiRepoSidebarItem,
  SingleRepoSidebarItem,
  WorkspaceOwnerBinding,
} from '@canopy/desktop-shared/types';
import { isGitRepo } from '../git';
import { getWorkspaceConfigPath, getWorkspaceWorktreesRootDir } from '../paths';
import {
  __resetSidebarItemsStateForTests,
  writeAllSidebarItems,
} from '../sidebar-items';
import { updateWorkspaceConfig } from '../workspace-persistence';
import {
  addWorkspaceRepository,
  removeWorkspaceRepository,
  WorkspaceRepositoryRefusedError,
  type WorkspaceRepositoryRefusal,
} from '../workspace-repositories';

const WORKSPACE_ID = 'repos-ws';
const SINGLE_ID = 'single-ws';

const OWNER: WorkspaceOwnerBinding = {
  type: 'organization',
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  bindingGeneration: 1,
};

const REPO_A = { id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' };
const REPO_B = { id: 'repo-b', name: 'Repo B', repoPath: '/repos/b' };

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function multiRepoItem(): MultiRepoSidebarItem {
  return {
    id: WORKSPACE_ID,
    name: 'Repos',
    type: 'multi-repo',
    color: '#0EA5E9',
    collapsed: false,
    order: 0,
    repos: [{ ...REPO_A }, { ...REPO_B }],
    worktrees: [],
  };
}

function singleRepoItem(): SingleRepoSidebarItem {
  return {
    id: SINGLE_ID,
    name: 'Single',
    type: 'single-repo',
    color: '#0EA5E9',
    collapsed: false,
    order: 1,
    repoPath: '/repos/single',
    worktrees: [],
  };
}

async function readManifest(
  workspaceId: string = WORKSPACE_ID,
): Promise<JsonRecord> {
  const parsed: unknown = JSON.parse(
    await readFile(getWorkspaceConfigPath(workspaceId), 'utf8'),
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
  reason: WorkspaceRepositoryRefusal,
  message: RegExp,
): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(WorkspaceRepositoryRefusedError);
  expect(error).toMatchObject({ reason });
  expect(error instanceof Error ? error.message : '').toMatch(message);
}

function add(
  repoPath: string,
  workspaceId: string = WORKSPACE_ID,
): ReturnType<typeof addWorkspaceRepository> {
  return addWorkspaceRepository({
    workspaceId,
    source: 'workspace_settings',
    repository: { repoPath },
  });
}

function remove(
  repoId: string,
  workspaceId: string = WORKSPACE_ID,
): ReturnType<typeof removeWorkspaceRepository> {
  return removeWorkspaceRepository({
    workspaceId,
    repoId,
    source: 'workspace_settings',
  });
}

const operationIdMatcher: unknown = expect.any(String);

describe('workspace repository boundary (real fs)', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    __resetSidebarItemsStateForTests();
    jest.mocked(isGitRepo).mockResolvedValue(true);
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-ws-repos-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    await writeAllSidebarItems([multiRepoItem(), singleRepoItem()]);
    await editManifest({ futureManifestField: { kept: true }, owner: OWNER });
  });

  afterEach(async () => {
    if (originalDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalDataDir;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('addWorkspaceRepository', () => {
    it('adds a repository after the others and keeps every other field', async () => {
      await expect(add('/repos/new-thing')).resolves.toEqual({
        id: 'new-thing',
        name: 'new-thing',
        repoPath: '/repos/new-thing',
        source: undefined,
        manifestUrl: undefined,
        scriptActionsOperationId: operationIdMatcher,
      });

      const manifest = await readManifest();
      expect(manifest.repos).toEqual([
        REPO_A,
        REPO_B,
        { id: 'new-thing', name: 'new-thing', repoPath: '/repos/new-thing' },
      ]);
      expect(manifest.futureManifestField).toEqual({ kept: true });
      expect(manifest.owner).toEqual(OWNER);
    });

    it('never reuses the id of a repository or of a worktree checkout', async () => {
      await mkdir(
        path.join(
          getWorkspaceWorktreesRootDir(WORKSPACE_ID),
          'otter',
          'repos',
          'b',
        ),
        { recursive: true },
      );
      const repo = await addWorkspaceRepository({
        workspaceId: WORKSPACE_ID,
        source: 'temporary_combine',
        repository: { repoPath: '/other/b', id: 'repo-a', name: 'B' },
      });
      expect(repo.id).toBe('repo-a-2');
      await expect(add('/elsewhere/b')).resolves.toMatchObject({ id: 'b-2' });
    });

    it('refuses a relative path, a folder that is not a repository and a duplicate', async () => {
      await expectRefusal(
        add('relative/path'),
        'invalid-request',
        /^repoPath must be an absolute path$/,
      );
      jest.mocked(isGitRepo).mockResolvedValueOnce(false);
      await expectRefusal(
        add('/repos/plain'),
        'not-a-repository',
        /^Not a git repository: \/repos\/plain$/,
      );
      await expectRefusal(
        add('/repos/a'),
        'duplicate',
        /^Repository already added to this project$/,
      );
      expect((await readManifest()).repos).toEqual([REPO_A, REPO_B]);
    });

    it('refuses a single-repo project', async () => {
      await expectRefusal(
        add('/repos/new', SINGLE_ID),
        'not-multi-repo',
        new RegExp(`^Project ${SINGLE_ID} is not a multi-repo project$`),
      );
      expect((await readManifest(SINGLE_ID)).repos).toEqual([]);
    });

    it('never creates a manifest for a workspace that has none', async () => {
      await expectRefusal(
        add('/repos/new', 'missing-ws'),
        'not-found',
        /^Project missing-ws not found$/,
      );
      expect(existsSync(getWorkspaceConfigPath('missing-ws'))).toBe(false);
    });

    it('refuses an unreadable manifest and leaves it as it is', async () => {
      await writeFile(getWorkspaceConfigPath(WORKSPACE_ID), '{"truncated":');
      await expectRefusal(
        add('/repos/new'),
        'configuration-unavailable',
        /could not be read/i,
      );
      expect(await readFile(getWorkspaceConfigPath(WORKSPACE_ID), 'utf8')).toBe(
        '{"truncated":',
      );
    });

    it('keeps a change queued ahead of it', async () => {
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const held = updateWorkspaceConfig(
        WORKSPACE_ID,
        async (config): Promise<void> => {
          await gate;
          config.itemSortMode = 'last-updated';
        },
      );
      const pending = add('/repos/c');
      release();
      await Promise.all([held, pending]);

      const manifest = await readManifest();
      expect(manifest.itemSortMode).toBe('last-updated');
      expect(manifest.repos).toEqual([
        REPO_A,
        REPO_B,
        { id: 'c', name: 'c', repoPath: '/repos/c' },
      ]);
    });

    it('puts a removed repository back at its position for the organization revert', async () => {
      await remove('repo-a');
      await expect(
        addWorkspaceRepository({
          workspaceId: WORKSPACE_ID,
          source: 'organization_sync_revert',
          restore: { repository: REPO_A, index: 0 },
        }),
      ).resolves.toEqual(REPO_A);
      expect((await readManifest()).repos).toEqual([REPO_A, REPO_B]);

      // A repository that is already back is left as it is.
      await addWorkspaceRepository({
        workspaceId: WORKSPACE_ID,
        source: 'organization_sync_revert',
        restore: { repository: { ...REPO_A, name: 'Stale' }, index: 1 },
      });
      expect((await readManifest()).repos).toEqual([REPO_A, REPO_B]);
    });
  });

  describe('removeWorkspaceRepository', () => {
    it('removes only the named repository and keeps every other field', async () => {
      await expect(remove('repo-a')).resolves.toEqual({ removed: REPO_A });

      const manifest = await readManifest();
      expect(manifest.repos).toEqual([REPO_B]);
      expect(manifest.futureManifestField).toEqual({ kept: true });
      expect(manifest.owner).toEqual(OWNER);
    });

    it('leaves the manifest unwritten when the repository is not there', async () => {
      const before = await readFile(
        getWorkspaceConfigPath(WORKSPACE_ID),
        'utf8',
      );
      await expect(remove('repo-z')).resolves.toEqual({ removed: null });
      expect(await readFile(getWorkspaceConfigPath(WORKSPACE_ID), 'utf8')).toBe(
        before,
      );
    });

    it('never creates a manifest for a workspace that has none', async () => {
      await expectRefusal(
        remove('repo-a', 'missing-ws'),
        'not-found',
        /^Project missing-ws not found$/,
      );
      expect(existsSync(getWorkspaceConfigPath('missing-ws'))).toBe(false);
    });

    it('lets a concurrent add and removal both land', async () => {
      await Promise.all([add('/repos/c'), remove('repo-b')]);
      expect((await readManifest()).repos).toEqual([
        REPO_A,
        { id: 'c', name: 'c', repoPath: '/repos/c' },
      ]);
    });
  });
});
