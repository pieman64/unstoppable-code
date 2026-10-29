// CAN-3824: a code fork into a new project records the published start page
// through the `core.sharedContainer.fork` metadata command, and a refused
// record fails the fork, whose rollback removes the project it created.
jest.mock('../lib/git', () => ({
  classifySharedContainerSymlinkTarget: jest.fn(),
  decodeUtf8SymlinkTarget: jest.fn(),
  deleteBranchIfMatches: jest.fn(),
  getRemoteUrl: jest.fn(),
  materializeGitCommitRaw: jest.fn(() => Promise.resolve()),
  resolveRefSha: jest.fn(),
}));
jest.mock('../shared-containers/fork/copy-tree', () => ({
  copySharedContainerTree: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/unique-destination', () => ({
  ensureUniqueDestination: jest.fn((parent: string, name: string) =>
    Promise.resolve(`${parent}/${name}`),
  ),
}));
jest.mock('../lib/workspace-service', () => ({
  findOrCreateSingleRepoWorkspaceForRepo: jest.fn(),
}));
jest.mock('../lib/workspace-creation', () => ({ createWorkspace: jest.fn() }));
jest.mock('../lib/workspace-repo-mutators', () => ({
  addRepoToWorkspaceConfig: jest.fn(),
}));
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(() =>
    Promise.resolve({ version: 1, items: [] }),
  ),
}));
jest.mock('../lib/workspace-deletion', () => ({
  deleteWorkspaceById: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/worktree-service', () => ({
  archiveMultiRepoWorktree: jest.fn(),
  archiveSingleRepoWorktree: jest.fn(),
  createMultiRepoWorktree: jest.fn(),
  createSingleRepoWorktree: jest.fn(() =>
    Promise.resolve({ id: 'fork-tree', branchName: 'fork-branch' }),
  ),
}));
jest.mock('../shared-containers/fork/finalize', () => ({
  copyForkAttachments: jest.fn(() => Promise.resolve({})),
  rehydrateForkChats: jest.fn(() => Promise.resolve([])),
  resolveSafeForkDestination: jest.fn(),
}));
jest.mock('../shared-containers/fork/provenance', () => ({
  writeForkProvenanceForDestination: jest.fn(() => Promise.resolve()),
}));
jest.mock('../shared-containers/fork/fork-metadata', () => ({
  hideSharedContainerForkWorkspace: jest.fn(),
  recordSharedContainerForkStartPage: jest.fn(),
}));

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SharedContainerRevisionLayoutV4 } from '@canopy/protocol/shared-containers';
import { deleteWorkspaceById } from '../lib/workspace-deletion';
import { findOrCreateSingleRepoWorkspaceForRepo } from '../lib/workspace-service';
import { createSingleRepoWorktree } from '../lib/worktree-service';
import { forkSharedCodeContainer } from '../shared-containers/fork/code';
import type * as ForkMetadataModule from '../shared-containers/fork/fork-metadata';
import {
  hideSharedContainerForkWorkspace,
  recordSharedContainerForkStartPage,
} from '../shared-containers/fork/fork-metadata';
import { SharedContainerReplicaStore } from '../shared-containers/replica/store';

const { SharedContainerForkMetadataRefusedError } = jest.requireActual<
  typeof ForkMetadataModule
>('../shared-containers/fork/fork-metadata');

const LAYOUT: SharedContainerRevisionLayoutV4 = {
  schemaVersion: 4,
  containerType: 'CODE_WORKTREE',
  title: 'Fork',
  repositories: [
    {
      repoId: 'published-repo',
      repoName: 'Repo',
      remoteUrl: 'https://github.com/example/repo.git',
      owner: 'example',
      repository: 'repo',
      baseCommitSha: 'a'.repeat(40),
      files: [],
    },
  ],
  files: [],
  notes: [],
  prompts: [],
  attachmentPaths: {},
  layout: {
    orientation: 0,
    root: { type: 'leaf', size: 1, tabs: [], activeTabIndex: 0 },
  },
  startPage: {
    kind: 'file',
    repoId: 'published-repo',
    relativePath: 'README.md',
  },
};

describe('code fork start page', () => {
  let tempPath: string;

  function fork(): ReturnType<typeof forkSharedCodeContainer> {
    return forkSharedCodeContainer({
      request: {
        containerId: 'container-1',
        revisionId: 'revision-1',
        organizationId: 'organization-1',
        sourceOwnerDisplayName: 'Ada',
        destination: { kind: 'new-workspace', parentDirectory: tempPath },
      },
      provenance: {
        sourceContainerId: 'container-1',
        sourceRevisionId: 'revision-1',
        sourceOwnerDisplayName: 'Ada',
        organizationId: 'organization-1',
        forkedAt: '2026-10-13T00:00:00.000Z',
      },
      revisionRoot: join(tempPath, 'revision'),
      layout: LAYOUT,
      store: new SharedContainerReplicaStore(join(tempPath, 'replicas')),
    });
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    tempPath = await mkdtemp(join(tmpdir(), 'fork-start-page-'));
    jest.mocked(findOrCreateSingleRepoWorkspaceForRepo).mockResolvedValue({
      created: true,
      workspace: {
        id: 'fork-project',
        type: 'single-repo',
        name: 'Fork',
        color: '#000000',
        collapsed: false,
        order: 0,
        repoPath: join(tempPath, 'Repo'),
        worktrees: [],
      },
    });
  });

  afterEach(async () => {
    await rm(tempPath, { recursive: true, force: true });
  });

  it('records the mapped start page on the project it created', async () => {
    jest.mocked(recordSharedContainerForkStartPage).mockResolvedValue({
      workspaceId: 'fork-project',
      startPage: { kind: 'file', path: 'README.md' },
    });

    await expect(fork()).resolves.toMatchObject({
      projectId: 'fork-project',
      worktreeId: 'fork-tree',
    });

    expect(recordSharedContainerForkStartPage).toHaveBeenCalledWith(
      {
        source: 'code_fork',
        workspaceId: 'fork-project',
        startPage: { kind: 'file', path: 'README.md' },
      },
      undefined,
    );
    expect(
      jest.mocked(recordSharedContainerForkStartPage).mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      jest.mocked(createSingleRepoWorktree).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('fails the fork and removes the created project when the record is refused', async () => {
    const refused = new SharedContainerForkMetadataRefusedError(
      'not-found',
      'Fork destination project fork-project no longer exists',
    );
    jest.mocked(recordSharedContainerForkStartPage).mockRejectedValue(refused);

    await expect(fork()).rejects.toBe(refused);

    expect(createSingleRepoWorktree).not.toHaveBeenCalled();
    expect(deleteWorkspaceById).toHaveBeenCalledWith(
      'fork-project',
      'shared_container_fork',
    );
    expect(hideSharedContainerForkWorkspace).not.toHaveBeenCalled();
  });
});
