import type * as CoworkRecordsModule from '../lib/cowork-workspace-records';
import { recordNewCoworkWorkspace } from '../lib/cowork-workspace-records';
jest.mock('../lib/cowork-workspace-records', () => ({
  ...jest.requireActual<typeof CoworkRecordsModule>(
    '../lib/cowork-workspace-records',
  ),
  recordNewCoworkWorkspace: jest.fn(
    (
      request: CoworkRecordsModule.CoworkCreationRecord,
    ): Promise<CoworkSidebarItem> =>
      Promise.resolve({
        id: 'folder',
        name: request.name,
        type: 'cowork',
        color: '#7C3AED',
        collapsed: false,
        order: 0,
        externalPath: request.externalPath,
      }),
  ),
}));
import type * as CompositionRecords from '../lib/workspace-composition-records';
jest.mock('../lib/workspace-composition-records', () => {
  const actual = jest.requireActual<typeof CompositionRecords>(
    '../lib/workspace-composition-records',
  );
  return {
    ...actual,
    createTemporaryCompositionRecords: jest.fn(),
    indexTemporaryCompositionWorkspace: jest.fn(),
    cleanupCompositionDestination: jest.fn(),
  };
});
import {
  createTemporaryCompositionRecords,
  cleanupCompositionDestination,
} from '../lib/workspace-composition-records';
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(),
  readWorkspaceIndexEntry: jest.fn(() => Promise.resolve(null)),
  writeAllSidebarItems: jest.fn(),
}));

jest.mock('../lib/paths', () => ({
  getDataDir: jest.fn(() => '/data'),
  getDefaultReposDir: jest.fn(() => '/data/repos'),
  getWorkspaceClaudeMdPath: jest.fn(
    (workspaceId: string) => `/data/workspaces/${workspaceId}/CLAUDE.md`,
  ),
  getWorkspaceDir: jest.fn(
    (workspaceId: string) => `/data/workspaces/${workspaceId}`,
  ),
  getWorkspaceWorktreesFilePath: jest.fn(
    (workspaceId: string) => `/data/workspaces/${workspaceId}/worktrees.json`,
  ),
}));

jest.mock('../lib/git', () => ({
  cloneRepo: jest.fn(),
  getGitCommonDir: jest.fn((repoPath: string) =>
    Promise.resolve(`${repoPath}/.git`),
  ),
  initLocalRepo: jest.fn(),
  isGitRepo: jest.fn(),
  getRemoteUrl: jest.fn(() => Promise.resolve(null)),
}));

// The functions workspace-service uses; the fence-refresh branch is asserted
// through them rather than through the real filesystem. The owner refresh
// (CAN-3819) decides on the detailed read and records a binding write.
jest.mock('../lib/workspace-persistence', () => {
  const readWorkspaceConfigDetailed = jest.fn<
    Promise<{
      config: { owner?: unknown; ownershipTransfer?: unknown };
      authority: 'ok' | 'absent' | 'unreadable';
      ownerMalformed: boolean;
    }>,
    [string]
  >();
  const writeWorkspaceConfig = jest.fn();
  return {
    readWorkspaceConfig: jest.fn(),
    readWorkspaceConfigDetailed,
    writeWorkspaceConfig,
    writeWorkspaceWorktrees: jest.fn(() => Promise.resolve()),
    updateWorkspaceOwnership: jest.fn(
      async (
        workspaceId: string,
        update: (current: {
          authority: 'ok';
          owner?: unknown;
          ownershipTransfer?: unknown;
        }) => { owner?: unknown; ownershipTransfer?: unknown } | null,
      ): Promise<string> => {
        const detail = await readWorkspaceConfigDetailed(workspaceId);
        if (detail.authority === 'absent') return 'absent';
        if (detail.authority !== 'ok' || detail.ownerMalformed)
          return 'unreadable';
        const next = update({
          authority: 'ok',
          owner: detail.config.owner,
          ownershipTransfer: detail.config.ownershipTransfer,
        });
        if (next === null) return 'declined';
        await writeWorkspaceConfig(
          workspaceId,
          { ...detail.config, ...next },
          { ownership: 'replace' },
        );
        return 'written';
      },
    ),
  };
});

jest.mock('../lib/canopy-json', () => ({
  hasManifestRepos: jest.fn(() => false),
  readCanopyJson: jest.fn(() => Promise.resolve({ version: 1 })),
  writeCanopyJson: jest.fn(() => Promise.resolve()),
}));

// The fixtures use paths that don't exist on disk; the missing-folder test
// opts into the real check.
jest.mock('@canopy/desktop-shared/node/lib/import-folder', () => ({
  ...jest.requireActual<typeof ImportFolderModule>(
    '@canopy/desktop-shared/node/lib/import-folder',
  ),
  assertImportFolderExists: jest.fn(() => Promise.resolve()),
}));

// Real writes; the detached-work tests hold one open.
jest.mock('../lib/atomic-file', () => {
  const actual =
    jest.requireActual<typeof AtomicFileModule>('../lib/atomic-file');
  return {
    ...actual,
    writeFileAtomically: jest.fn(actual.writeFileAtomically),
  };
});

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertImportFolderExists } from '@canopy/desktop-shared/node/lib/import-folder';
import type * as ImportFolderModule from '@canopy/desktop-shared/node/lib/import-folder';
import type * as AtomicFileModule from '../lib/atomic-file';

import type {
  CoworkSidebarItem,
  WorkspaceOwnerBinding,
  MultiRepoSidebarItem,
  SidebarItem,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import {
  hasManifestRepos,
  readCanopyJson,
  writeCanopyJson,
} from '../lib/canopy-json';
import { getGitCommonDir, getRemoteUrl, isGitRepo } from '../lib/git';
import { getDataDir } from '../lib/paths';
import {
  readAllSidebarItems,
  readWorkspaceIndexEntry,
  writeAllSidebarItems,
} from '../lib/sidebar-items';
import {
  acquireSplitDestinationWorkspaceLease,
  acquireSplitDestinationWorkspaceLeases,
  checkAddWorkspaceFromFolder,
  createTemporaryMultiRepoWorkspace,
  findOrCreateSingleRepoWorkspaceForRepo,
  getWorkspaceItem,
  importWorkspaceFromRepoPath,
  listWorkspaceItems,
  registerSingleRepoWorkspaceWithoutManifest,
  toWorkspaceCliRecord,
} from '../lib/workspace-service';
import { serializeChatProjectOperation } from '../lib/chat-project-operation-queue';
import { WorkspaceCreationRefusedError } from '../lib/workspace-creation-refusal';

const mockedReadAllSidebarItems = jest.mocked(readAllSidebarItems);
const mockedReadWorkspaceIndexEntry = jest.mocked(readWorkspaceIndexEntry);
const mockedWriteAllSidebarItems = jest.mocked(writeAllSidebarItems);
const mockedIsGitRepo = jest.mocked(isGitRepo);
const mockedGetGitCommonDir = jest.mocked(getGitCommonDir);
const mockedHasManifestRepos = jest.mocked(hasManifestRepos);
const mockedGetDataDir = jest.mocked(getDataDir);
const mockedAssertImportFolderExists = jest.mocked(assertImportFolderExists);

function buildCoworkWorkspace(
  overrides?: Partial<CoworkSidebarItem>,
): CoworkSidebarItem {
  return {
    type: 'cowork',
    id: 'existing-cowork',
    name: 'Existing Cowork',
    color: '#abcdef',
    collapsed: false,
    order: 3,
    ...overrides,
  };
}

function buildSingleRepoWorkspace(): SingleRepoSidebarItem {
  return {
    type: 'single-repo',
    id: 'single',
    name: 'Single',
    repoPath: '/repos/single',
    color: '#123456',
    worktrees: [
      {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ],
    collapsed: false,
    order: 1,
  };
}

function buildMultiRepoWorkspace(): MultiRepoSidebarItem {
  return {
    type: 'multi-repo',
    id: 'multi',
    name: 'Multi',
    color: '#654321',
    repos: [
      {
        id: 'app',
        name: 'App',
        repoPath: '/repos/app',
        source: 'manifest',
        manifestUrl: 'git@example.com:org/app.git',
      },
    ],
    worktrees: [],
    collapsed: true,
    order: 2,
    sourceRepoPath: '/repos/source',
  };
}

/** The service reads the detailed form; keep both stubs in step. */
function setPersistedConfig(
  persistence: {
    readWorkspaceConfig: jest.Mock;
    readWorkspaceConfigDetailed: jest.Mock;
  },
  config: unknown,
  authority: 'ok' | 'absent' | 'unreadable' = 'ok',
): void {
  persistence.readWorkspaceConfig.mockResolvedValue(config);
  persistence.readWorkspaceConfigDetailed.mockResolvedValue({
    config,
    authority,
    ownerMalformed: false,
  });
}

describe('workspace-service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists persisted sidebar projects unchanged', async () => {
    const items: SidebarItem[] = [
      buildSingleRepoWorkspace(),
      buildMultiRepoWorkspace(),
    ];
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items });

    await expect(listWorkspaceItems()).resolves.toEqual(items);
  });

  it('hides empty temporary multi-repo projects unless explicitly requested', async () => {
    const visible = buildSingleRepoWorkspace();
    const hidden: MultiRepoSidebarItem = {
      ...buildMultiRepoWorkspace(),
      id: 'temp',
      temporary: true,
      worktrees: [],
    };
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [visible, hidden],
    });

    await expect(listWorkspaceItems()).resolves.toEqual([visible]);
    await expect(
      listWorkspaceItems({ includeEmptyTemporary: true }),
    ).resolves.toEqual([visible, hidden]);
  });

  it('lists kept empty temporary projects while the bypass also returns retired projects', async () => {
    const kept: MultiRepoSidebarItem = {
      ...buildMultiRepoWorkspace(),
      id: 'kept',
      temporary: true,
      alwaysShow: true,
      worktrees: [],
      archivedContainerCount: 0,
    };
    const disposable = { ...kept, id: 'disposable', alwaysShow: false };
    const legacy = { ...kept, id: 'legacy', alwaysShow: undefined };
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [kept, disposable, legacy],
    });
    await expect(listWorkspaceItems()).resolves.toEqual([kept]);
    await expect(
      listWorkspaceItems({ includeEmptyTemporary: true }),
    ).resolves.toEqual([kept, disposable, legacy]);
  });

  it('keeps an empty temporary project visible while it owns archives', async () => {
    const archived: MultiRepoSidebarItem = {
      ...buildMultiRepoWorkspace(),
      id: 'temp-archived',
      temporary: true,
      worktrees: [],
      archivedContainerCount: 1,
    };
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [archived],
    });

    await expect(listWorkspaceItems()).resolves.toEqual([archived]);
  });

  it('gets a project by id from persisted state', async () => {
    const single = buildSingleRepoWorkspace();
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [single, buildMultiRepoWorkspace()],
    });

    await expect(getWorkspaceItem('single')).resolves.toEqual(single);
  });

  it('reports when a split destination project already existed', async () => {
    const existing = buildSingleRepoWorkspace();
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [existing],
    });

    await expect(
      findOrCreateSingleRepoWorkspaceForRepo(existing.repoPath),
    ).resolves.toEqual({ workspace: existing, created: false });
    expect(mockedWriteAllSidebarItems).not.toHaveBeenCalled();
  });

  it.each(['mismatched', 'absent', 'unreadable'] as const)(
    'refuses to refresh a %s persisted binding',
    async (kind) => {
      // The refresh writes an owner over workspace.json, so the file has to be
      // readable and still be the binding it was. A file that changed
      // underneath, or that cannot be read, is refused rather than overwritten
      // — which would otherwise erase the repo path and settings with it.
      const owner: WorkspaceOwnerBinding = {
        type: 'organization',
        organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        bindingGeneration: 5,
      };
      const existing = { ...buildSingleRepoWorkspace(), owner };
      mockedReadAllSidebarItems.mockResolvedValue({
        version: 1,
        items: [existing],
      });
      const persistence: {
        readWorkspaceConfig: jest.Mock;
        readWorkspaceConfigDetailed: jest.Mock;
        writeWorkspaceConfig: jest.Mock;
      } = jest.requireMock('../lib/workspace-persistence');
      const base = {
        version: 1,
        type: 'single-repo',
        repoPath: existing.repoPath,
        repos: [],
      };
      if (kind === 'mismatched')
        setPersistedConfig(persistence, {
          ...base,
          owner: {
            ...owner,
            projectId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          },
        });
      else setPersistedConfig(persistence, base, kind);
      persistence.writeWorkspaceConfig.mockClear();

      await expect(
        findOrCreateSingleRepoWorkspaceForRepo(existing.repoPath, undefined, {
          owner: { ...owner, bindingGeneration: 6 },
          localWorkspaceId: existing.id,
        }),
      ).rejects.toThrow('different organization binding');
      expect(persistence.writeWorkspaceConfig).not.toHaveBeenCalled();
    },
  );

  it('trusts workspace.json over a stale sidebar snapshot', async () => {
    // The sidebar list is read before the lock, so it can already be behind
    // what is on disk. Comparing the incoming fence against the snapshot would
    // let a caller whose generation is newer than the snapshot but older than
    // the persisted binding write backward over it.
    const owner: WorkspaceOwnerBinding = {
      type: 'organization',
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      bindingGeneration: 5,
    };
    const existing = {
      ...buildSingleRepoWorkspace(),
      owner: { ...owner, bindingGeneration: 5 },
    };
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [existing],
    });
    const persistence: {
      readWorkspaceConfig: jest.Mock;
      readWorkspaceConfigDetailed: jest.Mock;
      writeWorkspaceConfig: jest.Mock;
    } = jest.requireMock('../lib/workspace-persistence');
    // Disk is ahead of the snapshot.
    setPersistedConfig(persistence, {
      version: 1,
      type: 'single-repo',
      repoPath: existing.repoPath,
      repos: [],
      owner: { ...owner, bindingGeneration: 9 },
    });
    persistence.writeWorkspaceConfig.mockClear();

    const result = await findOrCreateSingleRepoWorkspaceForRepo(
      existing.repoPath,
      undefined,
      {
        owner: { ...owner, bindingGeneration: 6 },
        localWorkspaceId: existing.id,
      },
    );
    expect(persistence.writeWorkspaceConfig).not.toHaveBeenCalled();
    expect(result.workspace.owner).toMatchObject({ bindingGeneration: 9 });
  });

  it('refuses a fence that moves backward and reports the one it kept', async () => {
    // A generation only ever advances. A lower one is a stale caller, not a
    // re-claim, and writing it would undo a claim the server already issued.
    const owner: WorkspaceOwnerBinding = {
      type: 'organization',
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      bindingGeneration: 5,
    };
    const existing = { ...buildSingleRepoWorkspace(), owner };
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [existing],
    });
    const persistence: {
      readWorkspaceConfig: jest.Mock;
      readWorkspaceConfigDetailed: jest.Mock;
      writeWorkspaceConfig: jest.Mock;
    } = jest.requireMock('../lib/workspace-persistence');
    setPersistedConfig(persistence, {
      version: 1,
      type: 'single-repo',
      repoPath: existing.repoPath,
      repos: [],
      owner,
    });
    persistence.writeWorkspaceConfig.mockClear();

    const stale = await findOrCreateSingleRepoWorkspaceForRepo(
      existing.repoPath,
      undefined,
      {
        owner: { ...owner, bindingGeneration: 4 },
        localWorkspaceId: existing.id,
      },
    );
    expect(persistence.writeWorkspaceConfig).not.toHaveBeenCalled();
    expect(stale.workspace.owner).toMatchObject({ bindingGeneration: 5 });

    // And a real re-claim still refreshes, returning what the workspace now says.
    const advanced = await findOrCreateSingleRepoWorkspaceForRepo(
      existing.repoPath,
      undefined,
      {
        owner: { ...owner, bindingGeneration: 6 },
        localWorkspaceId: existing.id,
      },
    );
    expect(advanced.workspace.owner).toMatchObject({ bindingGeneration: 6 });
  });

  it('refuses an explicit id the index already holds', async () => {
    // An index entry whose config write never landed cannot be projected into
    // a sidebar item, and if its directory is missing too the id would look
    // free. Nothing written down proves that entry is this setup's.
    const owner: WorkspaceOwnerBinding = {
      type: 'organization',
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      bindingGeneration: 1,
    };
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items: [] });
    // Once: `buildAvailableWorkspaceId` polls this same reader in a loop, so a
    // standing stub would make every candidate look taken.
    mockedReadWorkspaceIndexEntry.mockResolvedValueOnce({
      id: 'repo',
      name: 'repo',
      type: 'single-repo',
      color: '',
      collapsed: false,
      order: 0,
    });

    await expect(
      findOrCreateSingleRepoWorkspaceForRepo('/tmp/repo', undefined, {
        owner,
        localWorkspaceId: 'repo',
      }),
    ).rejects.toThrow('Workspace identity is already in use');
  });

  it('refuses a workspace directory that does not say who owns it', async () => {
    // A directory with no sidebar row may only be reused by the setup that
    // owns it, and a missing or unreadable `workspace.json` is not that setup
    // saying so — it is the absence of an answer.
    const owner: WorkspaceOwnerBinding = {
      type: 'organization',
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      bindingGeneration: 1,
    };
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items: [] });
    // A real directory, so the existence check is the production one.
    const dataDir = await mkdtemp(join(tmpdir(), 'workspace-identity-'));
    await mkdir(join(dataDir, 'repo'));
    const paths: { getWorkspaceDir: jest.Mock } =
      jest.requireMock('../lib/paths');
    // Only `repo` is occupied; every other id resolves to a path that is not
    // there, so id allocation still terminates.
    paths.getWorkspaceDir.mockImplementation((workspaceId: string): string =>
      join(dataDir, workspaceId),
    );
    const persistence: {
      readWorkspaceConfig: jest.Mock;
      readWorkspaceConfigDetailed: jest.Mock;
      writeWorkspaceConfig: jest.Mock;
    } = jest.requireMock('../lib/workspace-persistence');
    setPersistedConfig(persistence, {
      version: 1,
      type: 'single-repo',
      repoPath: '/tmp/repo',
      repos: [],
    });

    await expect(
      findOrCreateSingleRepoWorkspaceForRepo('/tmp/repo', undefined, {
        owner,
        localWorkspaceId: 'repo',
      }),
    ).rejects.toThrow('Workspace identity is already in use');

    // Nor does another claim of the same project: a different instance is a
    // different setup, and adopting the directory would overwrite the binding
    // of a checkout it never made.
    setPersistedConfig(persistence, {
      version: 1,
      type: 'single-repo',
      repoPath: '/tmp/repo',
      repos: [],
      owner: {
        ...owner,
        instanceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      },
    });
    await expect(
      findOrCreateSingleRepoWorkspaceForRepo('/tmp/repo', undefined, {
        owner,
        localWorkspaceId: 'repo',
      }),
    ).rejects.toThrow('Workspace identity is already in use');

    // Nor a stale generation: reusing the directory would write an older fence
    // over one a newer server claim already issued.
    setPersistedConfig(persistence, {
      version: 1,
      type: 'single-repo',
      repoPath: '/tmp/repo',
      repos: [],
      owner: { ...owner, bindingGeneration: owner.bindingGeneration + 1 },
    });
    await expect(
      findOrCreateSingleRepoWorkspaceForRepo('/tmp/repo', undefined, {
        owner,
        localWorkspaceId: 'repo',
      }),
    ).rejects.toThrow('Workspace identity is already in use');
  });

  it('refreshes a moved fence on the same organization binding and refuses a different one', async () => {
    // A re-claim after an expired lease keeps the organization, project and
    // instance and only bumps the fence. Refusing that would leave a promoted
    // checkout unable to complete; a genuinely different binding still must.
    const owner = {
      type: 'organization' as const,
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      bindingGeneration: 1,
    };
    const existing = { ...buildSingleRepoWorkspace(), owner };
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [existing],
    });

    const persistence: {
      readWorkspaceConfig: jest.Mock;
      readWorkspaceConfigDetailed: jest.Mock;
      writeWorkspaceConfig: jest.Mock;
    } = jest.requireMock('../lib/workspace-persistence');
    setPersistedConfig(persistence, {
      version: 1,
      type: 'single-repo',
      repoPath: existing.repoPath,
      repos: [],
      owner,
    });

    await expect(
      findOrCreateSingleRepoWorkspaceForRepo(existing.repoPath, undefined, {
        owner: { ...owner, bindingGeneration: 2 },
        localWorkspaceId: existing.id,
      }),
    ).resolves.toMatchObject({ created: false });
    expect(persistence.writeWorkspaceConfig).toHaveBeenCalledWith(
      existing.id,
      expect.objectContaining({ owner: { ...owner, bindingGeneration: 2 } }),
      // A fence refresh is a binding write, not an ordinary config write.
      { ownership: 'replace' },
    );

    await expect(
      findOrCreateSingleRepoWorkspaceForRepo(existing.repoPath, undefined, {
        owner: { ...owner, projectId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
        localWorkspaceId: existing.id,
      }),
    ).rejects.toThrow('different organization binding');
  });

  it('reports when it created a split destination project', async () => {
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items: [] });

    await expect(
      findOrCreateSingleRepoWorkspaceForRepo('/repos/new', 'New Repo'),
    ).resolves.toMatchObject({
      created: true,
      workspace: {
        type: 'single-repo',
        name: 'New Repo',
        repoPath: '/repos/new',
      },
    });
    expect(mockedWriteAllSidebarItems).toHaveBeenCalledTimes(1);
  });

  it('waits for an in-flight template install before persisting a created project', async () => {
    let markInitialRead!: () => void;
    const initialRead = new Promise<void>((resolve) => {
      markInitialRead = resolve;
    });
    let readCount = 0;
    mockedReadAllSidebarItems.mockImplementation(() => {
      readCount += 1;
      if (readCount === 1) {
        markInitialRead();
      }
      return Promise.resolve({ version: 1, items: [] });
    });
    let releaseInstall!: () => void;
    let markInstallStarted!: () => void;
    const installGate = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });
    const installStarted = new Promise<void>((resolve) => {
      markInstallStarted = resolve;
    });
    const install = serializeChatProjectOperation(async () => {
      markInstallStarted();
      await installGate;
    });
    await installStarted;

    const creation = findOrCreateSingleRepoWorkspaceForRepo(
      '/repos/new',
      'New Repo',
    );
    await initialRead;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockedWriteAllSidebarItems).not.toHaveBeenCalled();

    releaseInstall();
    await Promise.all([install, creation]);
    expect(mockedWriteAllSidebarItems).toHaveBeenCalledTimes(1);
  });

  it('serializes split destination creation by repository identity', async () => {
    let persisted: SingleRepoSidebarItem | undefined;
    let releaseFirstWrite: (() => void) | undefined;
    const firstWriteStarted = new Promise<void>((resolve) => {
      mockedWriteAllSidebarItems.mockImplementationOnce(async (items) => {
        persisted = items.find(
          (item): item is SingleRepoSidebarItem => item.type === 'single-repo',
        );
        resolve();
        await new Promise<void>((release) => {
          releaseFirstWrite = release;
        });
        return { version: 1, items };
      });
    });
    mockedReadAllSidebarItems.mockImplementation(() =>
      Promise.resolve({
        version: 1,
        items: persisted ? [persisted] : [],
      }),
    );
    mockedGetGitCommonDir.mockResolvedValue('/repos/shared/.git');

    const first = findOrCreateSingleRepoWorkspaceForRepo(
      '/repos/shared',
      'Shared',
    );
    await firstWriteStarted;
    const second = findOrCreateSingleRepoWorkspaceForRepo(
      '/repos/shared-worktree',
      'Shared',
    );
    releaseFirstWrite?.();

    await expect(first).resolves.toMatchObject({ created: true });
    await expect(second).resolves.toMatchObject({ created: false });
    expect(mockedWriteAllSidebarItems).toHaveBeenCalledTimes(1);
  });

  it('holds a split destination identity lease across rollback cleanup', async () => {
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items: [] });
    mockedGetGitCommonDir.mockResolvedValue('/repos/shared/.git');

    const releaseLease =
      await acquireSplitDestinationWorkspaceLease('/repos/shared');
    const first = await findOrCreateSingleRepoWorkspaceForRepo(
      '/repos/shared',
      'Shared',
      { splitDestinationLeaseHeld: true },
    );
    let secondSettled = false;
    const second = findOrCreateSingleRepoWorkspaceForRepo(
      '/repos/shared-worktree',
      'Shared',
    ).finally(() => {
      secondSettled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [first.workspace],
    });
    releaseLease();

    await expect(second).resolves.toMatchObject({
      workspace: first.workspace,
      created: false,
    });
  });

  it('acquires multi-repo split destination leases without lock cycles', async () => {
    mockedGetGitCommonDir.mockImplementation((repoPath: string) =>
      Promise.resolve(`${repoPath}/.git`),
    );
    const releaseFirst = await acquireSplitDestinationWorkspaceLeases([
      '/repos/alpha',
      '/repos/bravo',
    ]);
    let secondSettled = false;
    const second = acquireSplitDestinationWorkspaceLeases([
      '/repos/bravo',
      '/repos/alpha',
    ]).finally(() => {
      secondSettled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    releaseFirst();
    const releaseSecond = await second;
    releaseSecond();
  });

  it('serializes project id allocation across repository identities', async () => {
    let persistedItems: SidebarItem[] = [];
    let releaseFirstWrite: (() => void) | undefined;
    let signalFirstWriteStarted: () => void = () => {};
    const firstWriteStarted = new Promise<void>((resolve) => {
      signalFirstWriteStarted = resolve;
    });
    mockedGetGitCommonDir.mockImplementation((repoPath: string) =>
      Promise.resolve(`${repoPath}/.git`),
    );
    mockedReadAllSidebarItems.mockImplementation(() =>
      Promise.resolve({ version: 1, items: persistedItems }),
    );
    mockedWriteAllSidebarItems.mockImplementation(async (items) => {
      persistedItems = [
        ...persistedItems.filter(
          (existing) => !items.some((item) => item.id === existing.id),
        ),
        ...items,
      ];
      if (mockedWriteAllSidebarItems.mock.calls.length === 1) {
        signalFirstWriteStarted();
        await new Promise<void>((resolve) => {
          releaseFirstWrite = resolve;
        });
      }
      return { version: 1, items: persistedItems };
    });

    const first = findOrCreateSingleRepoWorkspaceForRepo(
      '/repos/alpha',
      'Shared',
    );
    await firstWriteStarted;
    const second = findOrCreateSingleRepoWorkspaceForRepo(
      '/repos/bravo',
      'Shared',
    );
    releaseFirstWrite?.();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.created).toBe(true);
    expect(secondResult.created).toBe(true);
    expect(firstResult.workspace.id).not.toBe(secondResult.workspace.id);
    expect(mockedWriteAllSidebarItems).toHaveBeenCalledTimes(2);
    expect(persistedItems).toHaveLength(2);
  });

  it('serializes single-repo projects for deterministic CLI output', () => {
    const record = toWorkspaceCliRecord(buildSingleRepoWorkspace());

    expect(record).toMatchObject({
      id: 'single',
      type: 'single-repo',
      rootPath: '/repos/single',
      repoPath: '/repos/single',
      repoCount: 1,
      worktreeCount: 1,
      repos: [{ id: 'single', name: 'Single', repoPath: '/repos/single' }],
    });
  });

  it('serializes source-backed multi-repo projects for CLI output', () => {
    const record = toWorkspaceCliRecord(buildMultiRepoWorkspace());

    expect(record).toMatchObject({
      id: 'multi',
      type: 'multi-repo',
      rootPath: '/repos/source',
      sourceRepoPath: '/repos/source',
      repoCount: 1,
      worktreeCount: 0,
      repos: [
        {
          id: 'app',
          name: 'App',
          repoPath: '/repos/app',
          source: 'manifest',
          manifestUrl: 'git@example.com:org/app.git',
        },
      ],
    });
  });

  describe('checkAddWorkspaceFromFolder', () => {
    beforeEach(() => {
      mockedIsGitRepo.mockResolvedValue(true);
      mockedHasManifestRepos.mockReturnValue(false);
      mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items: [] });
    });

    it('returns not-tracked for an untracked git repository', async () => {
      await expect(
        checkAddWorkspaceFromFolder({ repoPath: '/untracked' }),
      ).resolves.toEqual({
        status: 'not-tracked',
      });
    });

    it('leaves non-git validation to import, even for a tracked folder', async () => {
      mockedIsGitRepo.mockResolvedValue(false);
      mockedReadAllSidebarItems.mockResolvedValue({
        version: 1,
        items: [buildCoworkWorkspace({ externalPath: '/plain/folder' })],
      });
      await expect(
        checkAddWorkspaceFromFolder({ repoPath: '/plain/folder' }),
      ).resolves.toEqual({
        status: 'not-tracked',
      });
      expect(mockedReadAllSidebarItems).not.toHaveBeenCalled();
    });

    it.each([
      buildSingleRepoWorkspace(),
      { ...buildMultiRepoWorkspace(), temporary: true },
    ])(
      'projects Personal $type duplicates without names or paths, including empty temporary projects',
      async (workspace) => {
        mockedReadAllSidebarItems.mockResolvedValue({
          version: 1,
          items: [workspace],
        });
        const repoPath =
          workspace.type === 'single-repo'
            ? workspace.repoPath
            : workspace.sourceRepoPath;
        if (!repoPath) throw new Error('Fixture must have a repository path');
        await expect(
          checkAddWorkspaceFromFolder({ repoPath }),
        ).resolves.toEqual({
          status: 'already-tracked',
          workspaceId: workspace.id,
          owner: null,
        });
      },
    );

    it.each([buildSingleRepoWorkspace(), buildMultiRepoWorkspace()])(
      'projects the complete organization binding for a $type duplicate without local metadata',
      async (workspace) => {
        const owner: WorkspaceOwnerBinding = {
          type: 'organization',
          organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          bindingGeneration: 7,
        };
        mockedReadAllSidebarItems.mockResolvedValue({
          version: 1,
          items: [{ ...workspace, owner }],
        });
        const repoPath =
          workspace.type === 'single-repo'
            ? workspace.repoPath
            : workspace.sourceRepoPath;
        if (!repoPath) throw new Error('Fixture must have a repository path');
        await expect(
          checkAddWorkspaceFromFolder({ repoPath }),
        ).resolves.toEqual({
          status: 'already-tracked',
          workspaceId: workspace.id,
          owner,
        });
      },
    );

    it.each([
      '/repos/Single',
      '/repos/single/',
      '/repos/single/nested',
      '/repos/../repos/single',
      '/repos/app',
    ])(
      'does not normalize or match child repositories: %s',
      async (repoPath) => {
        mockedReadAllSidebarItems.mockResolvedValue({
          version: 1,
          items: [buildSingleRepoWorkspace(), buildMultiRepoWorkspace()],
        });
        await expect(
          checkAddWorkspaceFromFolder({ repoPath }),
        ).resolves.toEqual({ status: 'not-tracked' });
      },
    );

    it.each([false, true])(
      'rejects conflicting local matches regardless of collection order (%s)',
      async (reverse) => {
        const items = [
          buildSingleRepoWorkspace(),
          {
            ...buildMultiRepoWorkspace(),
            sourceRepoPath: '/repos/single',
            owner: {
              type: 'organization',
              organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              bindingGeneration: 7,
            } satisfies WorkspaceOwnerBinding,
          },
        ];
        mockedReadAllSidebarItems.mockResolvedValue({
          version: 1,
          items: reverse ? items.reverse() : items,
        });
        await expect(
          checkAddWorkspaceFromFolder({ repoPath: '/repos/single' }),
        ).rejects.toThrow('conflicting tracked workspace bindings');
      },
    );

    it('reads no manifests or remotes and writes no workspace or repository content', async () => {
      await checkAddWorkspaceFromFolder({ repoPath: '/untracked' });
      expect(readCanopyJson).not.toHaveBeenCalled();
      expect(getRemoteUrl).not.toHaveBeenCalled();
      expect(writeCanopyJson).not.toHaveBeenCalled();
      expect(mockedWriteAllSidebarItems).not.toHaveBeenCalled();
    });

    it('does not authorize an import after a duplicate is introduced', async () => {
      await expect(
        checkAddWorkspaceFromFolder({ repoPath: '/repos/single' }),
      ).resolves.toEqual({ status: 'not-tracked' });
      mockedReadAllSidebarItems.mockResolvedValue({
        version: 1,
        items: [buildSingleRepoWorkspace()],
      });
      await expect(
        importWorkspaceFromRepoPath('/repos/single'),
      ).rejects.toThrow(
        'This repository is already tracked as project "Single"',
      );
      expect(mockedWriteAllSidebarItems).not.toHaveBeenCalled();
    });
  });

  describe('authoritative repository duplicate checks', () => {
    it.each([buildSingleRepoWorkspace(), buildMultiRepoWorkspace()])(
      'both import entry points retain the error for a $type duplicate',
      async (workspace) => {
        mockedIsGitRepo.mockResolvedValue(true);
        mockedHasManifestRepos.mockReturnValue(false);
        mockedReadAllSidebarItems.mockResolvedValue({
          version: 1,
          items: [workspace],
        });
        const repoPath =
          workspace.type === 'single-repo'
            ? workspace.repoPath
            : workspace.sourceRepoPath;
        if (!repoPath) throw new Error('Fixture must have a repository path');
        const error = `This repository is already tracked as project "${workspace.name}"`;
        await expect(importWorkspaceFromRepoPath(repoPath)).rejects.toThrow(
          error,
        );
        await expect(
          registerSingleRepoWorkspaceWithoutManifest(repoPath),
        ).rejects.toThrow(error);
        expect(mockedWriteAllSidebarItems).not.toHaveBeenCalled();
      },
    );
  });

  describe('importWorkspaceFromRepoPath', () => {
    beforeEach(() => {
      mockedHasManifestRepos.mockReturnValue(false);
      mockedWriteAllSidebarItems.mockResolvedValue({ version: 1, items: [] });
    });

    it('imports a git repo as a single-repo project unchanged', async () => {
      mockedIsGitRepo.mockResolvedValue(true);
      mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items: [] });

      const result = await importWorkspaceFromRepoPath('/git/repo');

      expect(result).toMatchObject({
        type: 'single-repo',
        name: 'repo',
        repoPath: '/git/repo',
      });
      expect(mockedWriteAllSidebarItems).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            type: 'single-repo',
            repoPath: '/git/repo',
          }),
        ],
        {
          preserveEmptyTemporary: false,
          preserveUnmentionedWorkspaceIds: true,
          replaceOwnershipWorkspaceIds: ['repo-2'],
        },
      );
    });

    it('imports a non-git folder as an external cowork project', async () => {
      mockedIsGitRepo.mockResolvedValue(false);
      mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items: [] });

      const result = await importWorkspaceFromRepoPath('/plain/folder');

      expect(result).toMatchObject({
        type: 'cowork',
        name: 'folder',
        externalPath: '/plain/folder',
      });
      expect(jest.mocked(recordNewCoworkWorkspace)).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'external_import',
          name: 'folder',
          externalPath: '/plain/folder',
        }),
      );
    });

    it('rejects a folder that does not exist without registering or creating it (CAN-3799)', async () => {
      const { assertImportFolderExists: realAssertImportFolderExists } =
        jest.requireActual<typeof ImportFolderModule>(
          '@canopy/desktop-shared/node/lib/import-folder',
        );
      mockedAssertImportFolderExists.mockImplementationOnce(
        realAssertImportFolderExists,
      );
      mockedIsGitRepo.mockResolvedValue(false);
      mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items: [] });
      const parentDir = await mkdtemp(join(tmpdir(), 'canopy-missing-import-'));
      const missingPath = join(parentDir, 'does-not-exist');

      await expect(importWorkspaceFromRepoPath(missingPath)).rejects.toThrow(
        `Couldn't add the folder because it doesn't exist: ${missingPath}. Choose an existing folder.`,
      );
      expect(mockedIsGitRepo).not.toHaveBeenCalled();
      expect(mockedWriteAllSidebarItems).not.toHaveBeenCalled();
      expect(existsSync(missingPath)).toBe(false);
    });

    it('rejects adding the same non-git folder twice', async () => {
      mockedIsGitRepo.mockResolvedValue(false);
      const existing = buildCoworkWorkspace({ externalPath: '/plain/folder' });
      mockedReadAllSidebarItems.mockResolvedValue({
        version: 1,
        items: [existing],
      });

      await expect(
        importWorkspaceFromRepoPath('/plain/folder'),
      ).rejects.toThrow(/already tracked/);
      expect(mockedWriteAllSidebarItems).not.toHaveBeenCalled();
    });

    it('rejects a non-git folder nested inside an existing project', async () => {
      mockedIsGitRepo.mockResolvedValue(false);
      const existing = buildSingleRepoWorkspace();
      mockedReadAllSidebarItems.mockResolvedValue({
        version: 1,
        items: [existing],
      });

      await expect(
        importWorkspaceFromRepoPath('/repos/single/nested'),
      ).rejects.toThrow(/nested inside an existing project/);
      expect(mockedWriteAllSidebarItems).not.toHaveBeenCalled();
    });

    it('rejects a non-git folder inside the Canopy data directory', async () => {
      mockedIsGitRepo.mockResolvedValue(false);
      mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items: [] });

      await expect(
        importWorkspaceFromRepoPath('/data/workspaces/some-folder'),
      ).rejects.toThrow(/app data directory/);
      expect(mockedWriteAllSidebarItems).not.toHaveBeenCalled();
    });

    it('rejects a folder that contains the Canopy data directory', async () => {
      // Simulate a nested data dir (e.g. '~/.canopy') so the containing
      // folder under test (the home directory) isn't the filesystem root,
      // matching the real-world "attach ~ as a cowork folder" scenario.
      mockedGetDataDir.mockReturnValueOnce('/Users/demo/.canopy');
      mockedIsGitRepo.mockResolvedValue(false);
      mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items: [] });

      await expect(importWorkspaceFromRepoPath('/Users/demo')).rejects.toThrow(
        /contains the app data directory/,
      );
      expect(mockedWriteAllSidebarItems).not.toHaveBeenCalled();
    });

    it('rejects a tracked repository before writing canopy.json into it (CAN-3806 F7)', async () => {
      mockedIsGitRepo.mockResolvedValue(true);
      jest.mocked(readCanopyJson).mockResolvedValue(null);
      const existing = buildSingleRepoWorkspace();
      mockedReadAllSidebarItems.mockResolvedValue({
        version: 1,
        items: [existing],
      });

      const result = importWorkspaceFromRepoPath(existing.repoPath);

      await expect(result).rejects.toBeInstanceOf(
        WorkspaceCreationRefusedError,
      );
      await expect(result).rejects.toMatchObject({
        reason: 'already-tracked',
        message: 'This repository is already tracked as project "Single"',
      });
      expect(writeCanopyJson).not.toHaveBeenCalled();
      expect(mockedWriteAllSidebarItems).not.toHaveBeenCalled();
    });

    it('allocates the project id inside the index commit (CAN-3806 D12)', async () => {
      mockedIsGitRepo.mockResolvedValue(true);
      let persistedItems: SidebarItem[] = [];
      mockedReadAllSidebarItems.mockImplementation(() =>
        Promise.resolve({ version: 1, items: persistedItems }),
      );
      mockedWriteAllSidebarItems.mockImplementation((items) => {
        persistedItems = [
          ...persistedItems.filter(
            (existing) => !items.some((item) => item.id === existing.id),
          ),
          ...items,
        ];
        return Promise.resolve({ version: 1, items });
      });

      // Both imports start before either commits, under the same name.
      const [first, second] = await Promise.all([
        importWorkspaceFromRepoPath('/alpha/app'),
        importWorkspaceFromRepoPath('/bravo/app'),
      ]);

      expect(first.id).not.toBe(second.id);
      expect(persistedItems.map((item) => item.id)).toEqual([
        first.id,
        second.id,
      ]);
    });

    it('rejects a folder that contains an existing project root', async () => {
      // '/repos/single' is an existing single-repo workspace root; '/repos'
      // contains it, which would give an agent operating in that cowork
      // workspace access to every git workspace nested under it.
      mockedIsGitRepo.mockResolvedValue(false);
      const existing = buildSingleRepoWorkspace();
      mockedReadAllSidebarItems.mockResolvedValue({
        version: 1,
        items: [existing],
      });

      await expect(importWorkspaceFromRepoPath('/repos')).rejects.toThrow(
        /contains an existing project/,
      );
      expect(mockedWriteAllSidebarItems).not.toHaveBeenCalled();
    });
  });
});

it('persists a validated organization owner under the claimed workspace id without a manifest write', async (): Promise<void> => {
  mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items: [] });
  const owner = {
    type: 'organization',
    organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    bindingGeneration: 7,
  } satisfies WorkspaceOwnerBinding;
  const { workspace } = await findOrCreateSingleRepoWorkspaceForRepo(
    '/repos/claimed',
    'Claimed',
    { owner, localWorkspaceId: 'claimed-identity' },
  );
  expect(workspace).toMatchObject({ id: 'claimed-identity', owner });
  expect(mockedWriteAllSidebarItems).toHaveBeenLastCalledWith(
    [expect.objectContaining({ id: 'claimed-identity', owner })],
    expect.anything(),
  );
  await expect(
    findOrCreateSingleRepoWorkspaceForRepo('/repos/invalid', 'Invalid', {
      owner: { ...owner, projectId: 'invalid' },
    }),
  ).rejects.toThrow('Invalid organization workspace binding');
});

describe('multi-repo project setup writes', () => {
  const paths: Record<string, jest.Mock> = jest.requireMock('../lib/paths');
  const defaultPaths = Object.entries(paths).map(
    ([name, mock]) => [name, mock.getMockImplementation()] as const,
  );
  afterEach(() => {
    defaultPaths.forEach(([name, impl]) =>
      paths[name].mockImplementation(impl),
    );
  });

  it('createTemporaryMultiRepoWorkspace awaits the records command before cleaning up a failure', async () => {
    await mkdir(join(process.cwd(), '.playwright/can-3823'), {
      recursive: true,
    });
    const dataDir = await mkdtemp(
      join(process.cwd(), '.playwright/can-3823/service-'),
    );
    paths.getWorkspaceDir.mockImplementation((id: string) => join(dataDir, id));
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items: [] });
    const failure = new Error('record write failed');
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest
      .mocked(createTemporaryCompositionRecords)
      .mockImplementationOnce(async () => {
        await gate;
        throw failure;
      });
    const outcome = createTemporaryMultiRepoWorkspace([]);
    const rejected = expect(outcome).rejects.toBe(failure);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(cleanupCompositionDestination).not.toHaveBeenCalled();
    release();
    await rejected;
    expect(cleanupCompositionDestination).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'temporary_workspace_create' }),
    );
    await rm(dataDir, { recursive: true, force: true });
  });
});
