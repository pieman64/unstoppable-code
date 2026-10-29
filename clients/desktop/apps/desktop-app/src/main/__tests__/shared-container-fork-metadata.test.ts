// CAN-3824: the workspace metadata writes of `core.sharedContainer.fork`.
// Runs the real sidebar and persistence modules against a temporary data dir.
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
  })),
}));
jest.mock('../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  CoworkSidebarItem,
  MultiRepoSidebarItem,
  SidebarItem,
} from '@canopy/desktop-shared/types';
import type { ProjectStartPage } from '@canopy/protocol/start-page';
import { notifyPortalStructureChanged } from '../portal/portal-event-bus';
import {
  getWorkspaceConfigPath,
  getWorkspaceIndexFilePath,
  getWorkspaceWorktreesFilePath,
} from '../lib/paths';
import {
  __resetSidebarItemsStateForTests,
  getWorkspaceIndexRepository,
  readAllSidebarItems,
  writeAllSidebarItems,
} from '../lib/sidebar-items';
import { getWorkspaceType } from '../lib/workspace-registry';
import { updateWorkspaceConfig } from '../lib/workspace-persistence';
import {
  hideSharedContainerForkWorkspace,
  recordSharedContainerForkStartPage,
  SharedContainerForkMetadataRefusedError,
} from '../shared-containers/fork/fork-metadata';
import { deleteForkWorkspaceOrHide } from '../shared-containers/fork/rollback';

function coworkItem(id: string, order: number): CoworkSidebarItem {
  return {
    id,
    name: `Project ${id}`,
    type: 'cowork',
    color: '#7C3AED',
    collapsed: false,
    order,
    cowork: { createdAt: '2026-09-01T00:00:00.000Z' },
  };
}

function multiRepoItem(id: string, order: number): MultiRepoSidebarItem {
  return {
    id,
    name: `Project ${id}`,
    type: 'multi-repo',
    color: '#0EA5E9',
    collapsed: false,
    order,
    repos: [],
    worktrees: [
      {
        id: `${id}-tree`,
        branchName: `${id}-branch`,
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    ],
  };
}

const SEEDED: SidebarItem[] = [
  coworkItem('alpha', 0),
  multiRepoItem('fork', 1),
  multiRepoItem('gamma', 2),
];

/** An entry this version cannot read, as a newer app could write. */
const FUTURE_ENTRY = {
  id: 'future',
  name: 'Future',
  type: 'notebook',
  color: '#000000',
  collapsed: false,
  order: 9,
};

const START_PAGE: ProjectStartPage = {
  kind: 'file',
  repoId: 'repo-a',
  path: 'README.md',
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(filePath: string): Promise<JsonRecord> {
  const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`Expected an object at ${filePath}`);
  return parsed;
}

async function readIndexEntries(): Promise<JsonRecord[]> {
  const workspaces = (await readJson(getWorkspaceIndexFilePath())).workspaces;
  if (!Array.isArray(workspaces)) throw new Error('Expected an index');
  return workspaces.filter(isRecord);
}

async function inode(filePath: string): Promise<number> {
  return (await stat(filePath)).ino;
}

/** The identity of every manifest and worktree list, to prove none moved. */
async function workspaceFileInodes(): Promise<Record<string, number>> {
  return {
    alpha: await inode(getWorkspaceConfigPath('alpha')),
    fork: await inode(getWorkspaceConfigPath('fork')),
    forkWorktrees: await inode(getWorkspaceWorktreesFilePath('fork')),
    gamma: await inode(getWorkspaceConfigPath('gamma')),
    gammaWorktrees: await inode(getWorkspaceWorktreesFilePath('gamma')),
  };
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
}

describe('shared-container fork metadata (real fs)', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    __resetSidebarItemsStateForTests();
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-fork-metadata-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    await writeAllSidebarItems(SEEDED);
    jest.clearAllMocks();
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('recordSharedContainerForkStartPage', () => {
    it('sets the start page in the destination manifest only', async () => {
      const manifestPath = getWorkspaceConfigPath('fork');
      await writeFile(
        manifestPath,
        JSON.stringify({
          ...(await readJson(manifestPath)),
          futureManifestField: 'kept',
        }),
      );
      const indexBefore = await inode(getWorkspaceIndexFilePath());
      const before = await workspaceFileInodes();

      await expect(
        recordSharedContainerForkStartPage({
          source: 'code_fork',
          workspaceId: 'fork',
          startPage: START_PAGE,
        }),
      ).resolves.toEqual({ workspaceId: 'fork', startPage: START_PAGE });

      expect(await readJson(manifestPath)).toMatchObject({
        type: 'multi-repo',
        startPage: START_PAGE,
        futureManifestField: 'kept',
      });
      expect(await inode(getWorkspaceIndexFilePath())).toBe(indexBefore);
      const after = await workspaceFileInodes();
      expect(after).toEqual({ ...before, fork: after.fork });
    });

    it('keeps a manifest change another writer commits while it waits', async () => {
      // A writer queued first holds the manifest queue; the start page is
      // applied to what it committed instead of to an earlier read (F9).
      let release = (): void => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const repository = updateWorkspaceConfig('fork', async (config) => {
        await held;
        config.repos = [{ id: 'repo-a', name: 'a', repoPath: '/repos/a' }];
      });
      const recording = recordSharedContainerForkStartPage({
        source: 'code_fork',
        workspaceId: 'fork',
        startPage: START_PAGE,
      });
      release();
      await Promise.all([repository, recording]);

      expect(await readJson(getWorkspaceConfigPath('fork'))).toMatchObject({
        repos: [{ id: 'repo-a', name: 'a', repoPath: '/repos/a' }],
        startPage: START_PAGE,
      });
    });

    it('refuses a destination without a manifest and creates none', async () => {
      const error = await refusal(
        recordSharedContainerForkStartPage({
          source: 'code_fork',
          workspaceId: 'missing',
          startPage: START_PAGE,
        }),
      );

      expect(error).toBeInstanceOf(SharedContainerForkMetadataRefusedError);
      expect(error).toMatchObject({ reason: 'not-found' });
      await expect(
        readFile(getWorkspaceConfigPath('missing'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses an unreadable manifest and leaves it as it is', async () => {
      const manifestPath = getWorkspaceConfigPath('fork');
      await writeFile(manifestPath, '{"version": 1,');

      const error = await refusal(
        recordSharedContainerForkStartPage({
          source: 'code_fork',
          workspaceId: 'fork',
          startPage: START_PAGE,
        }),
      );

      expect(error).toBeInstanceOf(SharedContainerForkMetadataRefusedError);
      expect(error).toMatchObject({
        reason: 'configuration-unavailable',
        message:
          "This project's settings could not be read, so they were not changed. Try again.",
      });
      expect(await readFile(manifestPath, 'utf8')).toBe('{"version": 1,');
    });

    it.each<[string, Parameters<typeof recordSharedContainerForkStartPage>[0]]>(
      [
        [
          'workspace id',
          {
            source: 'code_fork',
            workspaceId: '../escape',
            startPage: START_PAGE,
          },
        ],
        [
          'start page',
          {
            source: 'code_fork',
            workspaceId: 'fork',
            startPage: JSON.parse('{"kind":"file"}') as ProjectStartPage,
          },
        ],
        [
          'source',
          {
            source: JSON.parse('"renderer"') as 'code_fork',
            workspaceId: 'fork',
            startPage: START_PAGE,
          },
        ],
      ],
    )('refuses an invalid %s before reading', async (_label, request) => {
      const before = await readFile(getWorkspaceConfigPath('fork'), 'utf8');

      const error = await refusal(recordSharedContainerForkStartPage(request));

      expect(error).toBeInstanceOf(SharedContainerForkMetadataRefusedError);
      expect(error).toMatchObject({ reason: 'invalid-request' });
      expect(await readFile(getWorkspaceConfigPath('fork'), 'utf8')).toBe(
        before,
      );
    });
  });

  describe('hideSharedContainerForkWorkspace', () => {
    it('removes only the fork index entry, without rewriting any manifest or worktree list (F8)', async () => {
      const index = await readJson(getWorkspaceIndexFilePath());
      await writeFile(
        getWorkspaceIndexFilePath(),
        JSON.stringify({
          ...index,
          futureTopLevel: { enabled: true },
          workspaces: [
            ...(await readIndexEntries()).map((entry) =>
              entry.id === 'gamma' ? { ...entry, futureField: 'kept' } : entry,
            ),
            FUTURE_ENTRY,
          ],
        }),
      );
      const before = await workspaceFileInodes();

      await expect(
        hideSharedContainerForkWorkspace({
          source: 'code_fork',
          workspaceId: 'fork',
        }),
      ).resolves.toEqual({ status: 'hidden' });

      // Post-commit invalidation: the hidden workspace leaves the type
      // registry before any later sidebar read.
      expect(getWorkspaceType('fork')).toBeNull();
      expect(getWorkspaceType('gamma')).toBe('multi-repo');
      const written = await readJson(getWorkspaceIndexFilePath());
      expect(written.futureTopLevel).toEqual({ enabled: true });
      expect(
        (await readIndexEntries()).map((entry) => [entry.id, entry.order]),
      ).toEqual([
        ['alpha', 0],
        ['gamma', 1],
        ['future', 9],
      ]);
      expect(
        (await readIndexEntries()).find((entry) => entry.id === 'gamma'),
      ).toMatchObject({ futureField: 'kept' });
      expect(await workspaceFileInodes()).toEqual(before);
      expect(
        (await readAllSidebarItems()).items.map((item) => item.id),
      ).toEqual(['alpha', 'gamma']);
      expect(notifyPortalStructureChanged).toHaveBeenCalled();
    });

    it('keeps a workspace another writer indexes while the rollback hides the fork (F8)', async () => {
      // The fallback used to rewrite the whole sidebar from a snapshot read
      // outside the index queue, dropping an entry indexed meanwhile.
      let release = (): void => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const indexing = getWorkspaceIndexRepository().update(
        async ({ entries }) => {
          await held;
          return {
            result: null,
            entries: [
              ...entries,
              {
                id: 'late',
                name: 'Late',
                type: 'cowork' as const,
                color: '#7C3AED',
                collapsed: false,
                order: 3,
              },
            ],
          };
        },
      );
      const hiding = refusal(
        deleteForkWorkspaceOrHide(
          { source: 'cowork_fork', workspaceId: 'fork' },
          () => Promise.reject(new Error('delete failed')),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      release();
      const [, error] = await Promise.all([indexing, hiding]);

      expect(error).toMatchObject({ message: 'delete failed' });
      expect((await readIndexEntries()).map((entry) => entry.id)).toEqual([
        'alpha',
        'gamma',
        'late',
      ]);
    });

    it('reports both failures when the rollback can neither delete nor hide', async () => {
      await writeFile(getWorkspaceIndexFilePath(), '{"version": 1,');

      const error = await refusal(
        deleteForkWorkspaceOrHide(
          { source: 'code_fork', workspaceId: 'fork' },
          () => Promise.reject(new Error('delete failed')),
        ),
      );

      expect(error).toMatchObject({
        name: 'AggregateError',
        message: 'Failed to delete or hide fork workspace fork',
        errors: [
          expect.objectContaining({ message: 'delete failed' }),
          expect.objectContaining({ reason: 'index-unavailable' }),
        ],
      });
    });

    it('reports a workspace that is not indexed without writing', async () => {
      const indexBefore = await readFile(getWorkspaceIndexFilePath(), 'utf8');

      await expect(
        hideSharedContainerForkWorkspace({
          source: 'code_fork',
          workspaceId: 'missing',
        }),
      ).resolves.toEqual({ status: 'not-found' });

      expect(await readFile(getWorkspaceIndexFilePath(), 'utf8')).toBe(
        indexBefore,
      );
    });

    it('refuses an unreadable index and leaves it as it is', async () => {
      await writeFile(getWorkspaceIndexFilePath(), '{"version": 1,');

      const error = await refusal(
        hideSharedContainerForkWorkspace({
          source: 'code_fork',
          workspaceId: 'fork',
        }),
      );

      expect(error).toBeInstanceOf(SharedContainerForkMetadataRefusedError);
      expect(error).toMatchObject({ reason: 'index-unavailable' });
      expect(await readFile(getWorkspaceIndexFilePath(), 'utf8')).toBe(
        '{"version": 1,',
      );
    });

    it('refuses an invalid workspace id before reading', async () => {
      const error = await refusal(
        hideSharedContainerForkWorkspace({
          source: 'code_fork',
          workspaceId: '../escape',
        }),
      );

      expect(error).toBeInstanceOf(SharedContainerForkMetadataRefusedError);
      expect(error).toMatchObject({ reason: 'invalid-request' });
    });
  });
});
