import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as StorageModule from '@canopy/core-runtime/storage';
import type { StorageOwnershipRow } from '@canopy/core-runtime/storage';
import type { SidebarItem } from '../../../types';
import {
  addWorkspaceFromRemote,
  createAndPersistNewMultiRepoWorkspace,
  createNewSingleRepoWorkspace,
  importMultiRepoWorkspaceManifestFromRepo,
  importWorkspaceFromRepoPath,
} from '../workspace-service';
import {
  archiveSingleRepoWorktree,
  createSingleRepoWorktree,
} from '../worktree-service';

jest.mock('@canopy/core-runtime/storage', () => {
  const actual = jest.requireActual<typeof StorageModule>(
    '@canopy/core-runtime/storage',
  );
  return { ...actual, STORAGE_OWNERSHIP: [...actual.STORAGE_OWNERSHIP] };
});

const actualStorage = jest.requireActual<typeof StorageModule>(
  '@canopy/core-runtime/storage',
);
// Mutated in place: modules hold the mocked array by reference.
const mockedOwnership = jest.requireMock<{
  STORAGE_OWNERSHIP: StorageOwnershipRow[];
}>('@canopy/core-runtime/storage').STORAGE_OWNERSHIP;

function setOwnership(rows: readonly StorageOwnershipRow[]): void {
  mockedOwnership.splice(0, mockedOwnership.length, ...rows);
}

const W5_NAMESPACES = [
  'workspace_index',
  'workspace_manifest',
  'worktree_list',
] as const;

function daemonOwned(namespaces: readonly string[]): StorageOwnershipRow[] {
  return actualStorage.STORAGE_OWNERSHIP.map((row) =>
    namespaces.includes(row.id)
      ? { ...row, transitionOwner: 'daemon', currentWriters: [] }
      : row,
  );
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initRepo(repoPath: string): void {
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init', '-q', '-b', 'main']);
  // Detached auto-maintenance would race the snapshots below.
  git(repoPath, ['config', 'maintenance.auto', 'false']);
  git(repoPath, [
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init',
  ]);
}

/** Every entry under `root`, with file contents, so any change shows. */
function snapshot(root: string): Record<string, string> {
  if (!fs.existsSync(root)) return {};
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(root, { recursive: true })) {
    const filePath = path.join(root, String(entry));
    files[String(entry)] = fs.statSync(filePath).isFile()
      ? fs.readFileSync(filePath, 'utf8')
      : '<dir>';
  }
  return files;
}

const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

describe('W5 CLI storage writes', () => {
  const originalDataDir = process.env.CANOPY_DATA_DIR;
  let tempDir: string;
  let workspacesDir: string;
  let indexPath: string;
  const existingIndex = pretty({
    version: 1,
    workspaces: [
      {
        id: 'existing',
        name: 'Existing',
        type: 'single-repo',
        color: '#0284c7',
        collapsed: false,
        order: 0,
      },
    ],
  });

  beforeEach(() => {
    tempDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-w5-cli-storage-')),
    );
    process.env.CANOPY_DATA_DIR = path.join(tempDir, 'data');
    workspacesDir = path.join(tempDir, 'data', 'workspaces');
    indexPath = path.join(workspacesDir, 'index.json');
    fs.mkdirSync(path.join(workspacesDir, 'existing'), { recursive: true });
    fs.writeFileSync(indexPath, existingIndex, 'utf8');
    setOwnership(actualStorage.STORAGE_OWNERSHIP);
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function importRepo(): Promise<{ id: string; repoPath: string }> {
    const repoPath = path.join(tempDir, 'repo');
    initRepo(repoPath);
    const item = await importWorkspaceFromRepoPath(repoPath);
    return { id: item.id, repoPath };
  }

  it('persists index, backup, manifest and worktree list shapes', async () => {
    const { id, repoPath } = await importRepo();

    expect(fs.readFileSync(`${indexPath}.bak`, 'utf8')).toBe(existingIndex);
    const index: unknown = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    expect(fs.readFileSync(indexPath, 'utf8')).toBe(pretty(index));
    expect(index).toMatchObject({
      version: 1,
      workspaces: [{ id: 'existing' }, { id, type: 'single-repo', order: 1 }],
    });
    expect(
      fs.readFileSync(path.join(workspacesDir, id, 'workspace.json'), 'utf8'),
    ).toBe(
      pretty({
        version: 1,
        type: 'single-repo',
        repoPath,
        repos: [],
      }),
    );
    expect(
      fs.readFileSync(path.join(workspacesDir, id, 'worktrees.json'), 'utf8'),
    ).toBe(pretty({ version: 1, worktrees: [] }));
    expect(
      Object.keys(snapshot(workspacesDir)).filter((name) =>
        name.endsWith('.tmp'),
      ),
    ).toEqual([]);
  });

  it('refuses a corrupted index without replacing it or writing a backup', async () => {
    fs.writeFileSync(indexPath, '{"version": 1, "work', 'utf8');
    const before = snapshot(workspacesDir);

    await expect(importRepo()).rejects.toThrow(
      'The project list could not be read, so the project was not added',
    );
    expect(snapshot(workspacesDir)).toEqual(before);
  });

  it('round-trips the worktree list through create and archive', async () => {
    const { id } = await importRepo();
    const created = await createSingleRepoWorktree({
      workspaceId: id,
      branchName: 'feature',
      startPostCreateSetup: false,
    });
    const listPath = path.join(workspacesDir, id, 'worktrees.json');
    expect(fs.readFileSync(listPath, 'utf8')).toBe(
      pretty({
        version: 1,
        worktrees: [
          {
            id: created.id,
            branchName: 'feature',
            createdAt: created.createdAt,
          },
        ],
      }),
    );

    await archiveSingleRepoWorktree({
      workspaceId: id,
      worktreeId: created.id,
    });
    expect(fs.readFileSync(listPath, 'utf8')).toBe(
      pretty({ version: 1, worktrees: [] }),
    );
  });

  it.each(W5_NAMESPACES)(
    'refuses a project import before any W5 write when %s is daemon-owned',
    async (namespace) => {
      setOwnership(daemonOwned([namespace]));
      const before = snapshot(workspacesDir);

      await expect(importRepo()).rejects.toMatchObject({
        name: 'StorageWriteRefusedError',
        namespaceId: namespace,
        writer: 'desktop_cli',
        reason: 'daemon_owned',
      });
      expect(snapshot(workspacesDir)).toEqual(before);
    },
  );

  it.each([
    ['import', importWorkspaceFromRepoPath],
    ['manifest import', importMultiRepoWorkspaceManifestFromRepo],
    [
      'remote add',
      (repo: string): Promise<SidebarItem> =>
        addWorkspaceFromRemote(repo, path.join(tempDir, 'clone')),
    ],
    [
      'new project',
      (): Promise<SidebarItem> => createNewSingleRepoWorkspace('New'),
    ],
    [
      'new multi-repo project',
      (): Promise<SidebarItem> => createAndPersistNewMultiRepoWorkspace('New'),
    ],
  ] as const)(
    'refuses %s before changing any source or metadata',
    async (_label, run) => {
      const repoPath = path.join(tempDir, 'repo');
      initRepo(repoPath);
      setOwnership(daemonOwned(['workspace_index']));
      const before = snapshot(tempDir);

      await expect(run(repoPath)).rejects.toMatchObject({
        namespaceId: 'workspace_index',
        reason: 'daemon_owned',
      });
      expect(snapshot(tempDir)).toEqual(before);
    },
  );

  it('refuses worktree create before adding a checkout or branch', async () => {
    const { id, repoPath } = await importRepo();
    setOwnership(daemonOwned(['worktree_list']));
    const before = snapshot(workspacesDir);

    await expect(
      createSingleRepoWorktree({
        workspaceId: id,
        branchName: 'feature',
        startPostCreateSetup: false,
      }),
    ).rejects.toMatchObject({ namespaceId: 'worktree_list' });
    expect(snapshot(workspacesDir)).toEqual(before);
    expect(git(repoPath, ['branch', '--list', 'feature'])).toBe('');
  });

  it('refuses worktree archive before removing the checkout', async () => {
    const { id } = await importRepo();
    const created = await createSingleRepoWorktree({
      workspaceId: id,
      branchName: 'feature',
      startPostCreateSetup: false,
    });
    setOwnership(daemonOwned(['worktree_list']));
    const before = snapshot(workspacesDir);

    await expect(
      archiveSingleRepoWorktree({ workspaceId: id, worktreeId: created.id }),
    ).rejects.toMatchObject({ namespaceId: 'worktree_list' });
    expect(snapshot(workspacesDir)).toEqual(before);
  });
});
