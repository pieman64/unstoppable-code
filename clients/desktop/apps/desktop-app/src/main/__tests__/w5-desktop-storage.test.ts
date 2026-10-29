import '../../__tests__/worktree-replica-compatibility';
// CAN-3880: desktop W5 writes (workspace index, manifest, worktree list) name
// `electron_main` and are refused for a daemon-owned namespace before the
// target or a temporary sibling changes. CAN-3944: composite operations admit
// every namespace at entry and hold ownership stable until they settle. Real
// filesystem and the real checked atomic writer; only the ownership rows are
// synthetic.
import type * as Storage from '@canopy/core-runtime/storage';
import type * as FsPromises from 'node:fs/promises';

type MockW5Owner = 'electron_main' | 'daemon';
const mockOwners = new Map<string, MockW5Owner>();
jest.mock('@canopy/core-runtime/storage', () => {
  const actual = jest.requireActual<typeof Storage>(
    '@canopy/core-runtime/storage',
  );
  // A getter, not a spread value, so each write reads the current owners.
  return Object.defineProperty({ ...actual }, 'STORAGE_OWNERSHIP', {
    get: (): Storage.StorageOwnershipRow[] =>
      actual.STORAGE_OWNERSHIP.map((row) => {
        const owner = mockOwners.get(row.id);
        if (owner === undefined) return row;
        return owner === 'daemon'
          ? { ...row, transitionOwner: 'daemon', currentWriters: [] }
          : { ...row, transitionOwner: 'legacy', currentWriters: [owner] };
      }),
  });
});
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({ recordAppDiagnostic: jest.fn() })),
}));
jest.mock('../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../lib/workspace-source-control', () => ({
  prepareNewWorkspaceSourceRepo: jest.fn(() => Promise.resolve('/unused')),
}));

import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  CoworkSidebarItem,
  SingleRepoSidebarItem,
  WorktreeData,
  WorktreeGitFailedEvent,
} from '@canopy/desktop-shared/types';
import { createCoworkWorkspace } from '../lib/cowork-workspace-crud';
import { getGitCommonDir } from '../lib/git';
import {
  getWorkspaceConfigPath,
  getWorkspaceDir,
  getWorkspaceIndexFilePath,
  getWorkspaceWorktreesFilePath,
  getWorktreeDataDir,
  getWorktreeDir,
} from '../lib/paths';
import { applyProjectSourceChangesToWorktree } from '../lib/project-source-change-apply';
import {
  __resetSidebarItemsStateForTests,
  readAllSidebarItems,
  getWorkspaceIndexRepository,
  writeAllSidebarItems,
} from '../lib/sidebar-items';
import {
  getWorkspaceManifestRepository,
  readWorkspaceConfig,
  setBeforeProjectPluginDefaultsChangeHandler,
  setWorktreeRegistryReconciler,
  writeWorkspaceConfig,
  writeWorkspaceWorktrees,
} from '../lib/workspace-persistence';
import {
  addWorkspaceFromRemote,
  createAndPersistNewMultiRepoWorkspace,
  createNewSingleRepoWorkspace,
  createTemporaryMultiRepoWorkspace,
  findOrCreateSingleRepoWorkspaceForRepo,
  importMultiRepoWorkspaceManifestFromRepo,
  importWorkspaceFromRepoPath,
  registerSingleRepoWorkspaceWithoutManifest,
} from '../lib/workspace-service';
import { applyWorkspaceSourceChangesToWorktree } from '../lib/workspace-source-change-apply';
import {
  archiveMultiRepoWorktree,
  archiveSingleRepoWorktree,
  createMultiRepoWorktree,
  createSingleRepoWorktree,
} from '../lib/worktree-service';
import { claimWorktreeGitSetup } from '../lib/worktree-git-setup';
import { renameWorktreeBranch } from '../lib/worktree-branch-rename';
import { recordWorktreeDiscovery } from '../lib/worktree-repair';
import { reconcileGitPendingWorktrees } from '../lib/worktree-boot-recovery';
import { updateWorkspaceMetadata } from '../lib/workspace-metadata';
import { createWorkspace } from '../lib/workspace-creation';
import { releaseAdoptedWorkspace } from '../lib/workspace-ownership';
import { convertWorkspaceType } from '../lib/workspace-type-conversion';
import { withStorageOwnershipChange } from '@canopy/desktop-shared/node/lib/storage-admission';

const WORKSPACE_ID = 'ws-alpha';
const [INDEX, MANIFEST, LIST] = [
  'workspace_index',
  'workspace_manifest',
  'worktree_list',
] as const;
const daemonOwned = {
  name: 'StorageWriteRefusedError',
  reason: 'daemon_owned',
  writer: 'electron_main',
};
const mockBeforeWrite = jest.fn<Promise<void>, [string]>(() =>
  Promise.resolve(),
);
const mockRollback = jest.fn((): Promise<void> => Promise.resolve());
setWorktreeRegistryReconciler((id, _current, next) =>
  Promise.resolve({
    rows: next,
    beforeWrite: () => mockBeforeWrite(id),
    rollback: mockRollback,
  }),
);

function cowork(id: string, order: number): CoworkSidebarItem {
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

const recordBranchPrompt =
  (sent: boolean) =>
  (workspaceId: string, worktreeId: string): Promise<unknown> =>
    recordWorktreeDiscovery({
      kind: 'branch-prompt',
      workspaceId,
      worktreeId,
      sent,
    });
const markBranchPromptSent = recordBranchPrompt(true);
const clearBranchPromptSent = recordBranchPrompt(false);

function worktree(id: string, branchPromptSent?: boolean): WorktreeData {
  return {
    id,
    branchName: `branch-${id}`,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...(branchPromptSent === undefined ? {} : { branchPromptSent }),
  };
}

/** Every entry under `roots`, with file contents, so any change shows. */
async function snapshot(...roots: string[]): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const root of roots) {
    for (const entry of await readdir(root, { recursive: true })) {
      const target = path.join(root, entry);
      const isFile = (await stat(target)).isFile();
      files[target] = isFile ? await readFile(target, 'utf8') : '<dir>';
    }
  }
  return files;
}

async function readIndexIds(filePath: string): Promise<string[]> {
  const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('workspaces' in parsed) ||
    !Array.isArray(parsed.workspaces)
  ) {
    throw new Error(`Expected a workspace index at ${filePath}`);
  }
  return parsed.workspaces.map((entry: { id: string }) => entry.id);
}

let dataDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  jest.clearAllMocks();
  __resetSidebarItemsStateForTests();
  mockOwners.clear();
  for (const id of [INDEX, MANIFEST, LIST]) mockOwners.set(id, 'electron_main');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-w5-storage-'));
  process.env.CANOPY_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

describe('workspace_index', () => {
  it('writes the index and its backup as electron_main', async () => {
    await writeAllSidebarItems([cowork('alpha', 0)]);
    await writeAllSidebarItems([cowork('alpha', 0), cowork('beta', 1)]);

    const indexPath = getWorkspaceIndexFilePath();
    expect(await readIndexIds(indexPath)).toEqual(['alpha', 'beta']);
    expect(await readIndexIds(`${indexPath}.bak`)).toEqual(['alpha']);
  });

  it('refuses daemon-owned index and backup writes before mutation', async () => {
    await writeAllSidebarItems([cowork('alpha', 0)]);
    await writeAllSidebarItems([cowork('alpha', 0)]);
    const root = path.dirname(getWorkspaceIndexFilePath());
    const before = await snapshot(root);
    mockOwners.set('workspace_index', 'daemon');

    await expect(
      writeAllSidebarItems([cowork('alpha', 0), cowork('beta', 1)]),
    ).rejects.toMatchObject(daemonOwned);

    expect(await snapshot(root)).toEqual(before);
  });
});

describe('workspace_manifest', () => {
  it('admits repository document updates used by plugin pruning', async () => {
    await writeWorkspaceConfig(WORKSPACE_ID, {
      version: 1,
      type: 'multi-repo',
      repos: [],
    });
    const manifests = getWorkspaceManifestRepository();
    await manifests.serialize(WORKSPACE_ID, async () => {
      const previous = await manifests.read(WORKSPACE_ID);
      if (previous.authority !== 'ok') throw new Error('Expected manifest');
      await manifests.replaceDocument(
        WORKSPACE_ID,
        { ...previous.document, sourceRepoPath: '/source' },
        previous,
      );
    });
    expect(await readWorkspaceConfig(WORKSPACE_ID)).toMatchObject({
      sourceRepoPath: '/source',
    });
  });

  it('refuses a daemon-owned repository operation before its callback', async () => {
    mockOwners.set('workspace_manifest', 'daemon');
    const before = await snapshot(dataDir);
    const operation = jest.fn(async (): Promise<void> => {});
    await expect(
      getWorkspaceManifestRepository().serialize(WORKSPACE_ID, operation),
    ).rejects.toMatchObject(daemonOwned);
    expect(operation).not.toHaveBeenCalled();
    expect(await snapshot(dataDir)).toEqual(before);
  });

  it('writes workspace.json as electron_main', async () => {
    await writeWorkspaceConfig(WORKSPACE_ID, {
      version: 1,
      type: 'multi-repo',
      repos: [],
    });

    expect(await readWorkspaceConfig(WORKSPACE_ID)).toMatchObject({
      version: 1,
      type: 'multi-repo',
      repos: [],
    });
  });

  it('refuses a daemon-owned manifest write before mutation', async () => {
    await writeWorkspaceConfig(WORKSPACE_ID, {
      version: 1,
      type: 'multi-repo',
      repos: [],
    });
    const before = await snapshot(getWorkspaceDir(WORKSPACE_ID));
    mockOwners.set('workspace_manifest', 'daemon');
    const normalizeChats = jest.fn((): Promise<void> => Promise.resolve());
    setBeforeProjectPluginDefaultsChangeHandler(normalizeChats);

    await expect(
      writeWorkspaceConfig(WORKSPACE_ID, {
        version: 1,
        type: 'multi-repo',
        repos: [{ id: 'r', name: 'R', repoPath: '/repos/r' }],
        defaultPluginSelections: {
          collectionIds: ['c'],
          skillRefs: [],
          pluginRefs: [],
        },
      }),
    ).rejects.toMatchObject(daemonOwned);

    setBeforeProjectPluginDefaultsChangeHandler(undefined);
    expect(normalizeChats).not.toHaveBeenCalled();
    expect(await snapshot(getWorkspaceDir(WORKSPACE_ID))).toEqual(before);
  });
});

describe('worktree_list', () => {
  const seed = async (rows: WorktreeData[]): Promise<string> => {
    const filePath = getWorkspaceWorktreesFilePath(WORKSPACE_ID);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, worktrees: rows }, null, 2),
    );
    return filePath;
  };

  it('writes the registry as electron_main after group prewrite', async () => {
    const filePath = await seed([]);

    await writeWorkspaceWorktrees(WORKSPACE_ID, [worktree('wt-1')]);

    expect(mockBeforeWrite).toHaveBeenCalledTimes(1);
    expect(mockRollback).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      version: 1,
      worktrees: [worktree('wt-1')],
    });
  });

  it('refuses a daemon-owned registry write before the group pre-write', async () => {
    const filePath = await seed([worktree('wt-1')]);
    const before = await snapshot(path.dirname(filePath));
    mockOwners.set('worktree_list', 'daemon');

    await expect(
      writeWorkspaceWorktrees(WORKSPACE_ID, [
        worktree('wt-1'),
        worktree('wt-2'),
      ]),
    ).rejects.toMatchObject(daemonOwned);

    expect(mockBeforeWrite).not.toHaveBeenCalled();
    expect(await snapshot(path.dirname(filePath))).toEqual(before);
  });

  it('sets and clears the branch prompt flag as electron_main', async () => {
    const filePath = await seed([worktree('wt-1'), worktree('wt-2')]);

    await markBranchPromptSent(WORKSPACE_ID, 'wt-1');
    const marked = await readFile(filePath, 'utf8');
    await clearBranchPromptSent(WORKSPACE_ID, 'wt-1');

    expect(marked).toBe(
      JSON.stringify(
        { version: 1, worktrees: [worktree('wt-1', true), worktree('wt-2')] },
        null,
        2,
      ),
    );
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
      version: 1,
      worktrees: [worktree('wt-1', false), worktree('wt-2')],
    });
  });

  it.each([
    ['set', markBranchPromptSent, undefined],
    ['clear', clearBranchPromptSent, true],
  ] as const)(
    'refuses a daemon-owned branch prompt %s before mutation',
    async (_label, update, initial) => {
      const filePath = await seed([worktree('wt-1', initial)]);
      const before = await snapshot(path.dirname(filePath));
      mockOwners.set('worktree_list', 'daemon');

      await expect(update(WORKSPACE_ID, 'wt-1')).rejects.toMatchObject(
        daemonOwned,
      );

      expect(await snapshot(path.dirname(filePath))).toEqual(before);
    },
  );

  it('refuses failed instruction preparation before any canonical draft write', async () => {
    const fsp = jest.requireActual<typeof FsPromises>('node:fs/promises');
    const realWriteFile = fsp.writeFile;
    const write = jest
      .spyOn(fsp, 'writeFile')
      .mockImplementation((...args: Parameters<typeof realWriteFile>) =>
        typeof args[0] === 'string' && args[0].endsWith('CLAUDE.md')
          ? Promise.reject(new Error('instructions unavailable'))
          : realWriteFile(...args),
      );
    try {
      await expect(
        createAndPersistNewMultiRepoWorkspace('Draft'),
      ).rejects.toThrow('instructions unavailable');
      expect((await getWorkspaceIndexRepository().read()).entries).toEqual([]);
    } finally {
      write.mockRestore();
    }
  });

  it('seeds an empty registry for a new multi-repo project', async () => {
    const created = await createAndPersistNewMultiRepoWorkspace('New Project');

    expect(
      await readFile(getWorkspaceWorktreesFilePath(created.id), 'utf8'),
    ).toBe(JSON.stringify({ version: 1, worktrees: [] }, null, 2));
  });
});

// Each operation admits every W5 namespace it publishes before its first
// structural change, so a refusal leaves the data directory untouched.
describe('composite operation admission', () => {
  let sources: string;
  const repo = (): string => path.join(sources, 'repo');
  const alpha = (): string => path.join(sources, 'alpha');

  beforeEach(async () => {
    sources = await mkdtemp(path.join(os.tmpdir(), 'canopy-w5-sources-'));
    execFileSync('git', ['init', '-q', repo()]);
    execFileSync('git', ['init', '-q', '-b', 'main', alpha()]);
    execFileSync('git', ['-C', alpha(), 'config', 'maintenance.auto', 'false']);
    execFileSync('git', [
      '-C',
      alpha(),
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    ]);
    // Caches the git executable in preferences.json, outside the snapshots.
    await getGitCommonDir(repo());
    await mkdir(path.join(sources, 'notes'));
    // An indexed repository sibling: sidebar publication rewrites its list.
    await writeAllSidebarItems([
      {
        id: WORKSPACE_ID,
        name: 'Alpha',
        type: 'single-repo',
        repoPath: alpha(),
        color: '#7C3AED',
        collapsed: false,
        order: 0,
        worktrees: [worktree('wt-1')],
      },
    ]);
    execFileSync('git', [
      '-C',
      alpha(),
      'worktree',
      'add',
      '-q',
      '-b',
      'branch-wt-1',
      getWorktreeDir(WORKSPACE_ID, 'wt-1'),
    ]);
    await mkdir(getWorktreeDataDir(WORKSPACE_ID, 'wt-1'), { recursive: true });
    await writeFile(path.join(getWorktreeDir(WORKSPACE_ID, 'wt-1'), 'f'), 'x');
  });
  afterEach(() => rm(sources, { recursive: true, force: true }));

  const archived = { workspaceId: WORKSPACE_ID, worktreeId: 'wt-1' };
  const target = { mode: 'new', existingWorktreeIds: [] } as const;
  type Operation = [string, () => Promise<unknown>];
  const op = (namespace: string, run: () => Promise<unknown>): Operation => [
    namespace,
    run,
  ];
  const operations: Record<string, Operation> = {
    'worktree:rename-branch': op(LIST, () =>
      renameWorktreeBranch({
        source: 'desktop',
        workspaceId: WORKSPACE_ID,
        worktreeId: 'wt-1',
        newBranchName: 'feature/renamed',
      }),
    ),
    archive: op(LIST, () => archiveSingleRepoWorktree(archived)),
    'multi-repo archive': op(LIST, () => archiveMultiRepoWorktree(archived)),
    'project source-apply': op(LIST, () =>
      applyProjectSourceChangesToWorktree(
        { projectId: WORKSPACE_ID, target },
        () => null,
      ),
    ),
    'workspace source-apply': op(MANIFEST, () =>
      applyWorkspaceSourceChangesToWorktree(
        { workspaceId: WORKSPACE_ID, target },
        () => null,
      ),
    ),
    // Created and indexed in one commit (CAN-3806), so its manifest is
    // checked before anything is written too.
    'multi-repo project manifest': op(MANIFEST, () =>
      createAndPersistNewMultiRepoWorkspace('Draft'),
    ),
    'temporary project': op(LIST, () =>
      createTemporaryMultiRepoWorkspace([
        { id: 'a', name: 'A', repoPath: repo() },
      ]),
    ),
    'new project': op(INDEX, () => createNewSingleRepoWorkspace('New')),
    'new multi-repo project': op(INDEX, () =>
      createAndPersistNewMultiRepoWorkspace('Multi'),
    ),
    'repository import': op(INDEX, () => importWorkspaceFromRepoPath(repo())),
    'manifest import': op(INDEX, () =>
      importMultiRepoWorkspaceManifestFromRepo(repo()),
    ),
    'remote add': op(INDEX, () =>
      addWorkspaceFromRemote(repo(), path.join(sources, 'clones')),
    ),
    'Cowork project': op(LIST, () => createCoworkWorkspace('Notes')),
    'sidebar save': op(LIST, () => writeAllSidebarItems([cowork('beta', 0)])),
    'folder attach': op(LIST, () =>
      importWorkspaceFromRepoPath(path.join(sources, 'notes')),
    ),
    registration: op(MANIFEST, () =>
      registerSingleRepoWorkspaceWithoutManifest(repo()),
    ),
    'find-or-create': op(LIST, () =>
      findOrCreateSingleRepoWorkspaceForRepo(repo()),
    ),
    'worktree create': op(LIST, () =>
      createSingleRepoWorktree({ workspaceId: WORKSPACE_ID }),
    ),
    'workspace create boundary': op(INDEX, () =>
      createWorkspace({
        source: 'portal',
        variant: { kind: 'new-single-repo', name: 'Boundary' },
      }),
    ),
    'metadata update': op(INDEX, () =>
      updateWorkspaceMetadata({
        workspaceId: WORKSPACE_ID,
        source: 'portal',
        patch: { name: 'Renamed', itemSortMode: 'last-updated' },
      }),
    ),
    'adoption release': op(INDEX, () =>
      releaseAdoptedWorkspace({
        workspaceId: WORKSPACE_ID,
        source: 'org_project_adoption_rollback',
        instanceId: 'instance-1',
      }),
    ),
  };

  it.each(Object.entries(operations))(
    'refuses %s before any change',
    async (_label, [namespace, run]) => {
      const before = await snapshot(dataDir, sources);
      mockOwners.set(namespace, 'daemon');

      await expect(run()).rejects.toMatchObject(daemonOwned);

      expect(
        execFileSync(
          'git',
          [
            '-C',
            getWorktreeDir(WORKSPACE_ID, 'wt-1'),
            'branch',
            '--show-current',
          ],
          { encoding: 'utf8' },
        ).trim(),
      ).toBe('branch-wt-1');
      expect(await snapshot(dataDir, sources)).toEqual(before);
    },
  );

  it('refuses a type conversion before its repository files change', async () => {
    const items = await readAllSidebarItems();
    await writeAllSidebarItems([
      ...items.items,
      {
        id: 'ws-convert',
        name: 'Convert',
        type: 'single-repo',
        repoPath: repo(),
        color: '#7C3AED',
        collapsed: false,
        order: 1,
        worktrees: [],
      },
    ]);
    const before = await snapshot(dataDir, sources);
    mockOwners.set(INDEX, 'daemon');

    await expect(
      convertWorkspaceType({
        workspaceId: 'ws-convert',
        targetType: 'multi-repo',
        claudeMdMode: 'unchanged',
        source: 'workspace_settings',
      }),
    ).rejects.toMatchObject(daemonOwned);

    expect(await snapshot(dataDir, sources)).toEqual(before);
  });

  it('refuses a boot-recovery rollback before any change', async () => {
    await writeWorkspaceWorktrees(WORKSPACE_ID, [
      { ...worktree('wt-1'), setupPhase: 'git-pending' },
    ]);
    const before = await snapshot(dataDir, sources);
    mockOwners.set(LIST, 'daemon');

    // Recovery logs each refused rollback and moves on.
    await reconcileGitPendingWorktrees();

    expect(await snapshot(dataDir, sources)).toEqual(before);
  });

  it('holds ownership through deferred worktree git setup', async () => {
    const events: string[] = [];
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const created = await createSingleRepoWorktree({
      workspaceId: WORKSPACE_ID,
      deferGitSetup: true,
      startPostCreateSetup: false,
      onGitSetupSettled: ({ outcome }) => {
        events.push(`setup ${outcome}`);
        settle();
      },
    });
    const heldSetup = claimWorktreeGitSetup(WORKSPACE_ID, created.id);
    const change = withStorageOwnershipChange([LIST], () => {
      mockOwners.set(LIST, 'daemon');
      events.push('change');
    });

    await settled;
    await change;
    await expect(heldSetup).resolves.toBe('ready');
    // Settlement is reported after the hold releases; Phase B's writes are
    // not, so an unheld Phase B would settle `failed` instead.
    expect(events.sort()).toEqual(['change', 'setup ready']);
    const listed = JSON.parse(
      await readFile(getWorkspaceWorktreesFilePath(WORKSPACE_ID), 'utf8'),
    ) as { worktrees: WorktreeData[] };
    expect(listed.worktrees.find((row) => row.id === created.id)).toMatchObject(
      { setupPhase: 'git-ready' },
    );
  });

  it('settles a queued deferred setup refused after an ownership change', async () => {
    const settled = { first: [] as string[], second: [] as string[] };
    const failed: WorktreeGitFailedEvent[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((release) => {
      releaseFirst = release;
    });
    let secondSettled!: () => void;
    const secondDone = new Promise<void>((resolve) => {
      secondSettled = resolve;
    });
    await createSingleRepoWorktree({
      workspaceId: WORKSPACE_ID,
      deferGitSetup: true,
      startPostCreateSetup: false,
      beforeGitReady: () => firstGate,
      onGitSetupSettled: ({ outcome }) => settled.first.push(outcome),
    });
    const second = await createSingleRepoWorktree({
      workspaceId: WORKSPACE_ID,
      deferGitSetup: true,
      startPostCreateSetup: false,
      onGitFailed: (event) => failed.push(event),
      onGitSetupSettled: ({ outcome }) => {
        settled.second.push(outcome);
        secondSettled();
      },
    });
    const secondHeldSetup = claimWorktreeGitSetup(WORKSPACE_ID, second.id);
    const change = withStorageOwnershipChange([LIST], () => {
      mockOwners.set(LIST, 'daemon');
    });

    releaseFirst();
    await change;
    await secondDone;

    expect(settled).toEqual({ first: ['ready'], second: ['failed'] });
    await expect(secondHeldSetup).resolves.toBe('failed');
    expect(claimWorktreeGitSetup(WORKSPACE_ID, second.id)).toBeUndefined();
    // A failure without a health issue would render the row as git-ready.
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      worktreeId: second.id,
      healthIssue: {
        status: 'broken',
        code: 'git-error',
        worktreePath: getWorktreeDir(WORKSPACE_ID, second.id),
      },
    });
    expect(
      execFileSync(
        'git',
        ['-C', alpha(), 'branch', '--list', second.branchName],
        {
          encoding: 'utf8',
        },
      ),
    ).toBe('');
    await expect(
      stat(getWorktreeDir(WORKSPACE_ID, second.id)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a refused multi-repo setup failed for the first send that claims it', async () => {
    const workspace = await createTemporaryMultiRepoWorkspace([
      { id: 'alpha', name: 'Alpha', repoPath: alpha() },
    ]);
    const settled = { first: [] as string[], second: [] as string[] };
    const failed: WorktreeGitFailedEvent[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((release) => {
      releaseFirst = release;
    });
    let secondSettled!: () => void;
    const secondDone = new Promise<void>((resolve) => {
      secondSettled = resolve;
    });
    const first = await createMultiRepoWorktree({
      workspaceId: workspace.id,
      deferGitSetup: true,
      startPostCreateSetup: false,
      beforeGitReady: () => firstGate,
      onGitSetupSettled: ({ outcome }) => settled.first.push(outcome),
    });
    const second = await createMultiRepoWorktree({
      workspaceId: workspace.id,
      deferGitSetup: true,
      startPostCreateSetup: false,
      onGitFailed: (event) => failed.push(event),
      onGitSetupSettled: ({ outcome }) => {
        settled.second.push(outcome);
        secondSettled();
      },
    });
    const change = withStorageOwnershipChange([LIST], () => {
      mockOwners.set(LIST, 'daemon');
    });

    releaseFirst();
    await change;
    await secondDone;

    expect(settled).toEqual({ first: ['ready'], second: ['failed'] });
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      worktreeId: second.id,
      healthIssue: { status: 'broken', code: 'git-error' },
    });
    expect(claimWorktreeGitSetup(workspace.id, first.id)).toBeUndefined();
    await expect(claimWorktreeGitSetup(workspace.id, second.id)).resolves.toBe(
      'failed',
    );
    expect(claimWorktreeGitSetup(workspace.id, second.id)).toBeUndefined();
  });

  it('starts post-create setup outside the create admission', async () => {
    let setupStarted = false;
    let releaseSetup!: () => void;
    const setupGate = new Promise<void>((release) => {
      releaseSetup = release;
    });
    await createSingleRepoWorktree({
      workspaceId: WORKSPACE_ID,
      startPostCreateSetup: true,
      startProjectPostCreateSetup: () => {
        setupStarted = true;
        return setupGate;
      },
    });
    const change = withStorageOwnershipChange([LIST], () => {
      mockOwners.set(LIST, 'daemon');
    });

    // A setup holding the create's admission would block the change until
    // the setup settles.
    const first = await Promise.race([
      change.then(() => 'changed'),
      new Promise((resolve) => setTimeout(resolve, 1_000, 'held')),
    ]);
    releaseSetup();
    await change;

    expect(setupStarted).toBe(true);
    expect(first).toBe('changed');
  });

  it('makes an ownership change wait for an admitted sidebar save', async () => {
    const listPath = getWorkspaceWorktreesFilePath(WORKSPACE_ID);
    let releaseList!: () => void;
    const listPending = new Promise<void>((paused) => {
      mockBeforeWrite.mockImplementationOnce(() => {
        paused();
        return new Promise((release) => {
          releaseList = release;
        });
      });
    });
    const rows = [worktree('wt-1'), worktree('wt-2')];
    const save = writeAllSidebarItems([
      {
        id: WORKSPACE_ID,
        name: 'Alpha',
        type: 'single-repo',
        repoPath: alpha(),
        color: '#7C3AED',
        collapsed: false,
        order: 0,
        worktrees: rows,
      },
    ]);
    // The index and manifest are published; the list write is pending.
    await listPending;
    let changed = false;
    const change = withStorageOwnershipChange([LIST], () => {
      mockOwners.set(LIST, 'daemon');
      changed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(changed).toBe(false);
    releaseList();
    await save;
    await change;
    expect(changed).toBe(true);
    expect(JSON.parse(await readFile(listPath, 'utf8'))).toEqual({
      version: 1,
      worktrees: rows,
    });

    const before = await snapshot(dataDir, sources);
    await expect(
      writeAllSidebarItems([cowork('beta', 0)]),
    ).rejects.toMatchObject(daemonOwned);
    expect(await snapshot(dataDir, sources)).toEqual(before);
  });

  it('holds sidebar save admission until a failed save settles every project', async () => {
    // Pause project A after its manifest and before its list write, when no
    // nested write holds the list; project B's list write then fails.
    const fsp = jest.requireActual<typeof FsPromises>('node:fs/promises');
    const realReadFile = fsp.readFile;
    const listPath = getWorkspaceWorktreesFilePath(WORKSPACE_ID);
    const manifestPath = getWorkspaceConfigPath(WORKSPACE_ID);
    let releaseList!: () => void;
    let paused!: () => void;
    const listPending = new Promise<void>((resolve) => {
      paused = resolve;
    });
    const listGate = new Promise<void>((release) => {
      releaseList = release;
    });
    let gated = false;
    const read = jest
      .spyOn(fsp, 'readFile')
      .mockImplementation(async (...args: Parameters<typeof realReadFile>) => {
        if (!gated && args[0] === listPath) {
          const manifest = await realReadFile(manifestPath, 'utf8');
          if (manifest.includes('"archiveRetentionDays": 7')) {
            gated = true;
            paused();
            await listGate;
          }
        }
        return realReadFile(...args);
      });
    mockBeforeWrite.mockImplementation((filePath) => {
      if (String(filePath).includes('ws-repo'))
        throw new Error('list unavailable');
    });
    const project = (
      id: string,
      repoPath: string,
      order: number,
    ): SingleRepoSidebarItem => ({
      id,
      name: id,
      type: 'single-repo',
      repoPath,
      color: '#7C3AED',
      collapsed: false,
      order,
      worktrees: [worktree(`${id}-wt`)],
    });
    try {
      const save = writeAllSidebarItems([
        { ...project(WORKSPACE_ID, alpha(), 0), archiveRetentionDays: 7 },
        project('ws-repo', repo(), 1),
      ]);
      const saveSettled = save.then(
        () => undefined,
        () => undefined,
      );
      await listPending;
      let changed = false;
      const change = withStorageOwnershipChange([LIST], () => {
        mockOwners.set(LIST, 'daemon');
        changed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(changed).toBe(false);
      releaseList();
      await expect(save).rejects.toThrow('list unavailable');
      await saveSettled;
      await change;
      expect(changed).toBe(true);
      // Published before the change, not refused after it.
      expect(await realReadFile(listPath, 'utf8')).toContain(
        `"id": "${WORKSPACE_ID}-wt"`,
      );
    } finally {
      releaseList();
      read.mockRestore();
    }
  });
});
