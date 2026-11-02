// CAN-4781: a new copy of an organization-access share is made in that
// organization. The fork creates its Personal checkout or Cowork project as
// before, binds it in place through the existing organization creators, and
// compensates through the supported move back when a later step fails.
import type * as WorkspacePersistenceModule from '../lib/workspace-persistence';
import type * as FsPromisesModule from 'node:fs/promises';
import type * as CanopyCloudClientModule from '../canopy-cloud/client';
import type * as OrgMemberCodeCreateModule from '../lib/org-member-code-create';

jest.mock('../lib/workspace-persistence', () => {
  const actual = jest.requireActual<typeof WorkspacePersistenceModule>(
    '../lib/workspace-persistence',
  );
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(actual),
      readWorkspaceOwnership: { value: jest.fn(), enumerable: true },
    },
  );
});
jest.mock('../lib/git', () => ({
  classifySharedContainerSymlinkTarget: jest.fn(),
  decodeUtf8SymlinkTarget: jest.fn(),
  deleteBranchIfMatches: jest.fn(),
  getRemoteUrl: jest.fn(),
  materializeGitCommitRaw: jest.fn(() => Promise.resolve()),
  resolveRefSha: jest.fn(),
}));
jest.mock('../shared-containers/fork/copy-tree', () => ({
  copySharedContainerTree: jest.fn(
    async (_source: string, destination: string) => {
      const { mkdir } =
        jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
      await mkdir(destination, { recursive: true });
    },
  ),
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
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(),
}));
jest.mock('../lib/workspace-deletion', () => ({
  deleteWorkspaceById: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/worktree-service', () => ({
  archiveMultiRepoWorktree: jest.fn(),
  archiveSingleRepoWorktree: jest.fn(),
  createMultiRepoWorktree: jest.fn(),
  createSingleRepoWorktree: jest.fn(),
}));
jest.mock('../shared-containers/fork/finalize', () => ({
  assertNoPublishedPlans: jest.fn(() => Promise.resolve()),
  copyForkAttachments: jest.fn(() => Promise.resolve({})),
  rehydrateForkChats: jest.fn(() => Promise.resolve([])),
  resolveSafeForkDestination: jest.fn(),
  writeForkFileFromReplica: jest.fn(() => Promise.resolve()),
}));
jest.mock('../shared-containers/fork/provenance', () => ({
  writeForkProvenanceForDestination: jest.fn(() => Promise.resolve()),
}));
jest.mock('../shared-containers/fork/fork-metadata', () => ({
  hideSharedContainerForkWorkspace: jest.fn(),
  recordSharedContainerForkStartPage: jest.fn(),
}));
jest.mock('../lib/cowork-workspace-crud', () => ({
  createCoworkWorkspace: jest.fn(),
  updateCoworkWorkspace: jest.fn(),
}));
jest.mock('../lib/cowork-work-entries', () => ({
  createWorkEntry: jest.fn(),
  removeWorkEntryRow: jest.fn(),
}));
jest.mock('../lib/worktree-data-cleanup', () => ({
  cleanupPersistedWorktreeData: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../lib/instruction-files', () => ({
  ensureAgentsMdSymlinkOrCopy: jest.fn(),
}));
jest.mock('../lib/org-cowork-binding-deps', () => ({
  isOrgCoworkOperationEligible: jest.fn(),
  isOrgMemberCodeOperationEligible: jest.fn(),
}));
jest.mock('../lib/org-member-code-create-deps', () => ({
  getOrgMemberCodeCreator: jest.fn(),
}));
jest.mock('../lib/org-project-materialization', () => ({
  getOrgProjectMaterialization: jest.fn(),
}));
const recordAppDiagnostic = jest.fn();
jest.mock('../observability', () => ({
  getObservabilityService: (): { recordAppDiagnostic: jest.Mock } => ({
    recordAppDiagnostic,
  }),
}));
jest.mock('../services/org-project-catalog-service', () => ({
  getOrgProjectCatalogService: jest.fn(),
}));

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  SharedContainerForkRequest,
  SharedContainerRevisionLayoutV4,
} from '@canopy/protocol/shared-containers';
import type {
  CreateOrgMemberCodeProjectRequest,
  CreateOrgMemberCodeProjectResult,
  WorkspaceOwnerBinding,
} from '@canopy/desktop-shared/types';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import { getRemoteUrl } from '../lib/git';
import { readAllSidebarItems } from '../lib/sidebar-items';
import { readWorkspaceOwnership } from '../lib/workspace-persistence';
import { deleteWorkspaceById } from '../lib/workspace-deletion';
import { findOrCreateSingleRepoWorkspaceForRepo } from '../lib/workspace-service';
import { createWorkspace } from '../lib/workspace-creation';
import { createSingleRepoWorktree } from '../lib/worktree-service';
import { createCoworkWorkspace } from '../lib/cowork-workspace-crud';
import { createWorkEntry } from '../lib/cowork-work-entries';
import {
  isOrgCoworkOperationEligible,
  isOrgMemberCodeOperationEligible,
} from '../lib/org-cowork-binding-deps';
import { getOrgMemberCodeCreator } from '../lib/org-member-code-create-deps';
import { getOrgProjectMaterialization } from '../lib/org-project-materialization';
import { getOrgProjectCatalogService } from '../services/org-project-catalog-service';
import { rehydrateForkChats } from '../shared-containers/fork/finalize';
import { forkSharedCodeContainer } from '../shared-containers/fork/code';
import { forkSharedCoworkContainer } from '../shared-containers/fork/cowork';
import {
  FORK_CREATION_KEY_GENERATIONS,
  forkOrganizationCreationKey,
} from '../shared-containers/fork/org-destination';
import { SharedContainerReplicaStore } from '../shared-containers/replica/store';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '33333333-3333-4333-8333-333333333333';
const INSTANCE = '44444444-4444-4444-8444-444444444444';
const owner = { kind: 'organization', organizationId: ORG } as const;
const REMOTE = 'https://github.com/example/repo.git';

const REPOSITORY: SharedContainerRevisionLayoutV4['repositories'][number] = {
  repoId: 'published-repo',
  repoName: 'Repo',
  remoteUrl: REMOTE,
  owner: 'example',
  repository: 'repo',
  baseCommitSha: 'a'.repeat(40),
  files: [],
};
const SNAPSHOT: SharedContainerRevisionLayoutV4['repositories'][number] = {
  repoId: 'snapshot',
  repoName: 'Snapshot',
  source: 'snapshot',
  baseCommitSha: 'a'.repeat(40),
  files: [],
  snapshot: {
    bundleArtifactIds: ['bundle'],
    treeFileCount: 0,
    treeBytes: '0',
  },
};

function codeLayout(
  repositories: SharedContainerRevisionLayoutV4['repositories'],
): SharedContainerRevisionLayoutV4 {
  return {
    schemaVersion: 4,
    containerType: 'CODE_WORKTREE',
    title: 'Shared fix',
    repositories,
    files: [],
    notes: [],
    prompts: [],
    attachmentPaths: {},
    layout: {
      orientation: 0,
      root: { type: 'leaf', size: 1, tabs: [], activeTabIndex: 0 },
    },
  };
}

const COWORK_LAYOUT: SharedContainerRevisionLayoutV4 = {
  ...codeLayout([]),
  containerType: 'COWORK_WORK_ENTRY',
  title: 'Shared notes',
};

const orgBinding: WorkspaceOwnerBinding = {
  type: 'organization',
  organizationId: ORG,
  projectId: PROJECT,
  instanceId: INSTANCE,
  bindingGeneration: 1,
};

let tempPath: string;
let bindings: Map<string, WorkspaceOwnerBinding>;
let workspaceType: 'single-repo' | 'cowork';
const create = jest.fn<
  Promise<CreateOrgMemberCodeProjectResult>,
  [
    CreateOrgMemberCodeProjectRequest,
    OrgMemberCodeCreateModule.OrgMemberCreationOptions?,
  ]
>();
const convertCoworkWorkspace = jest.fn();
const moveBackToPersonal = jest.fn();
const originalDataDir = process.env.CANOPY_DATA_DIR;

function request(
  overrides: Partial<SharedContainerForkRequest> = {},
): SharedContainerForkRequest {
  return {
    containerId: 'container',
    revisionId: 'revision',
    organizationId: ORG,
    sourceOwnerDisplayName: 'Ada',
    destination: {
      kind: 'new-workspace',
      owner,
      parentDirectory: join(tempPath, 'repos'),
    },
    ...overrides,
  };
}

function forkCode(
  layout = codeLayout([REPOSITORY]),
): ReturnType<typeof forkSharedCodeContainer> {
  workspaceType = 'single-repo';
  return forkSharedCodeContainer({
    owner,
    organizationName: 'Acme',
    request: request(),
    provenance: {
      sourceContainerId: 'container',
      sourceRevisionId: 'revision',
      sourceOwnerDisplayName: 'Ada',
      organizationId: ORG,
      forkedAt: '2026-10-23T00:00:00.000Z',
    },
    revisionRoot: join(tempPath, 'revision'),
    layout,
    store: new SharedContainerReplicaStore(join(tempPath, 'replicas')),
  });
}

function forkCowork(): ReturnType<typeof forkSharedCoworkContainer> {
  workspaceType = 'cowork';
  return forkSharedCoworkContainer({
    owner,
    organizationName: 'Acme',
    request: request(),
    provenance: {
      sourceContainerId: 'container',
      sourceRevisionId: 'revision',
      sourceOwnerDisplayName: 'Ada',
      organizationId: ORG,
      forkedAt: '2026-10-23T00:00:00.000Z',
    },
    revisionRoot: join(tempPath, 'revision'),
    layout: COWORK_LAYOUT,
    store: new SharedContainerReplicaStore(join(tempPath, 'replicas')),
  });
}

function sidebar(
  items: Array<Record<string, unknown>>,
): Awaited<ReturnType<typeof readAllSidebarItems>> {
  return { version: 1, items } as never;
}

beforeEach(async () => {
  jest.clearAllMocks();
  tempPath = await mkdtemp(join(tmpdir(), 'fork-organization-'));
  process.env.CANOPY_DATA_DIR = join(tempPath, 'data');
  resetResolvedCanopyDataDirForTests();
  bindings = new Map();
  jest.mocked(isOrgMemberCodeOperationEligible).mockResolvedValue(true);
  jest.mocked(isOrgCoworkOperationEligible).mockResolvedValue(true);
  jest.mocked(readAllSidebarItems).mockImplementation(() =>
    Promise.resolve(
      sidebar([
        {
          id: 'shared-notes',
          type: 'cowork',
          name: 'Shared notes',
          worktrees: [],
        },
      ]),
    ),
  );
  jest.mocked(readWorkspaceOwnership).mockImplementation((workspaceId) =>
    Promise.resolve({
      authority: 'ok',
      type: workspaceType,
      ...(bindings.has(workspaceId)
        ? { owner: bindings.get(workspaceId) }
        : {}),
    }),
  );
  jest.mocked(getOrgProjectCatalogService).mockReturnValue({
    refresh: jest.fn(() =>
      Promise.resolve({
        stale: false,
        error: null,
        projects: [
          {
            id: PROJECT,
            organizationId: ORG,
            kind: workspaceType === 'cowork' ? 'COWORK' : 'CODE',
            state: 'ACTIVE',
            location: 'LOCAL',
            capabilities: { use: true },
            instance: { id: INSTANCE, state: 'READY' },
          },
        ],
      }),
    ),
  } as never);
  create.mockImplementation(() => {
    bindings.set('shared-fix', orgBinding);
    return Promise.resolve({
      ok: true,
      organizationProjectId: PROJECT,
      localWorkspaceId: 'shared-fix',
    });
  });
  jest.mocked(getOrgMemberCodeCreator).mockReturnValue({ create });
  convertCoworkWorkspace.mockImplementation(
    (input: { workspaceId: string }) => {
      bindings.set(input.workspaceId, orgBinding);
      return Promise.resolve({
        ok: true,
        workspaceId: input.workspaceId,
        owner: orgBinding,
      });
    },
  );
  moveBackToPersonal.mockImplementation(
    ({ workspaceId }: { workspaceId: string }) => {
      bindings.delete(workspaceId);
      return Promise.resolve({ ok: true, workspaceId });
    },
  );
  jest.mocked(getOrgProjectMaterialization).mockReturnValue({
    convertCoworkWorkspace,
    moveBackToPersonal,
  } as never);
  jest
    .mocked(findOrCreateSingleRepoWorkspaceForRepo)
    .mockImplementation((repoPath: string) =>
      Promise.resolve({
        created: true,
        workspace: {
          id: 'shared-fix',
          type: 'single-repo',
          name: 'Shared fix',
          color: '#000000',
          collapsed: false,
          order: 0,
          repoPath,
          worktrees: [],
        },
      }),
    );
  jest
    .mocked(createSingleRepoWorktree)
    .mockResolvedValue({ id: 'fork-tree', branchName: 'fork-branch' } as never);
  jest
    .mocked(createCoworkWorkspace)
    .mockResolvedValue({ id: 'shared-notes' } as never);
  jest
    .mocked(createWorkEntry)
    .mockResolvedValue({ entry: { id: 'entry' } } as never);
});

afterEach(async () => {
  await rm(tempPath, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  resetResolvedCanopyDataDirForTests();
});

describe('new organization code copies', () => {
  it('binds the promoted checkout to the organization and returns the bound workspace', async () => {
    await expect(forkCode()).resolves.toMatchObject({
      containerType: 'CODE_WORKTREE',
      projectId: 'shared-fix',
      worktreeId: 'fork-tree',
    });
    const promoted = join(tempPath, 'repos', 'Repo');
    expect(isOrgMemberCodeOperationEligible).toHaveBeenCalledWith(ORG, {
      scope: 'membership',
    });
    expect(create).toHaveBeenCalledWith(
      {
        organizationId: ORG,
        name: 'Shared fix',
        folderPath: promoted,
        creationKey: forkOrganizationCreationKey({
          shape: 'single-repo',
          containerId: 'container',
          revisionId: 'revision',
          organizationId: ORG,
          name: 'Shared fix',
          remoteUrl: REMOTE,
          generation: 0,
        }),
      },
      { scope: 'membership', propagateErrors: true },
    );
    // The worktree is made only once the binding is complete and authorized.
    expect(
      jest.mocked(create).mock.invocationCallOrder[0] ?? Infinity,
    ).toBeLessThan(
      jest.mocked(createSingleRepoWorktree).mock.invocationCallOrder[0] ?? 0,
    );
    expect(bindings.get('shared-fix')).toEqual(orgBinding);
    expect(moveBackToPersonal).not.toHaveBeenCalled();
    expect(deleteWorkspaceById).not.toHaveBeenCalled();
  });

  it('makes a snapshot repository with no remote a repository-less organization project', async () => {
    await expect(forkCode(codeLayout([SNAPSHOT]))).resolves.toMatchObject({
      projectId: 'shared-fix',
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        folderPath: join(tempPath, 'repos', 'Snapshot'),
        creationKey: forkOrganizationCreationKey({
          shape: 'single-repo',
          containerId: 'container',
          revisionId: 'revision',
          organizationId: ORG,
          name: 'Shared fix',
          generation: 0,
        }),
      }),
      { scope: 'membership', propagateErrors: true },
    );
  });

  it('presents the same creation key on a retry, so the organization replays its project', async () => {
    jest
      .mocked(createSingleRepoWorktree)
      .mockRejectedValueOnce(new Error('worktree failed'));
    await expect(forkCode()).rejects.toMatchObject({
      code: 'organization-creation-failed',
    });
    await expect(forkCode()).resolves.toMatchObject({
      projectId: 'shared-fix',
    });
    const [first, second] = create.mock.calls.map(([input]) => input);
    expect(first).toEqual(second);
  });

  it('releases the binding before deleting the workspace when a later step fails', async () => {
    jest
      .mocked(rehydrateForkChats)
      .mockRejectedValueOnce(new Error('chat copy failed'));

    await expect(forkCode()).rejects.toMatchObject({
      code: 'organization-creation-failed',
      message: "Couldn't make the copy in Acme. Try again.",
    });

    expect(moveBackToPersonal).toHaveBeenCalledWith({
      workspaceId: 'shared-fix',
    });
    expect(deleteWorkspaceById).toHaveBeenCalledWith(
      'shared-fix',
      'shared_container_fork',
    );
    expect(recordAppDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining<Record<string, unknown>>({
        kind: 'shared_container_org_fork_failed',
        error: expect.stringMatching(/^Error /) as unknown,
      }),
    );
    // Messages quote workspace ids and paths; diagnostics keep names only.
    expect(JSON.stringify(recordAppDiagnostic.mock.calls)).not.toContain(
      'chat copy failed',
    );
    expect(moveBackToPersonal.mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(deleteWorkspaceById).mock.invocationCallOrder[0] ?? 0,
    );
    expect(await readdir(join(tempPath, 'repos'))).toEqual([]);
  });

  it('keeps a workspace whose binding could not be released, and says so', async () => {
    moveBackToPersonal.mockResolvedValue({ ok: false, code: 'release-failed' });
    jest
      .mocked(createSingleRepoWorktree)
      .mockRejectedValueOnce(new Error('worktree failed'));
    jest
      .mocked(readAllSidebarItems)
      .mockResolvedValue(
        sidebar([{ id: 'shared-fix', type: 'single-repo', worktrees: [] }]),
      );

    await expect(forkCode()).rejects.toMatchObject({
      code: 'organization-creation-failed',
      message:
        "Couldn't make the copy in Acme, and its unfinished workspace couldn't be removed. Remove it from Acme before you try again.",
    });

    expect(deleteWorkspaceById).not.toHaveBeenCalled();
    expect(bindings.get('shared-fix')).toEqual(orgBinding);
    // The checkout of the still-bound workspace is preserved with it.
    expect(await readdir(join(tempPath, 'repos'))).toEqual(['Repo']);
  });

  const creatorRefusalCases: Array<
    [string, CreateOrgMemberCodeProjectResult, string, string]
  > = [
    [
      'unavailable',
      { ok: false, code: 'unavailable' },
      'organization-creation-unavailable',
      "You can't create projects in Acme right now, so the copy wasn't made.",
    ],
    [
      'project limit',
      { ok: false, code: 'limit-reached' },
      'organization-project-limit',
      "You've reached the limit of 100 private projects in Acme, so the copy wasn't made. Delete one to make another.",
    ],
    [
      'inaccessible repository project',
      { ok: false, code: 'refused', reason: 'no-access' },
      'organization-repository-inaccessible',
      "Acme has a project for this repository that you can't use, so the copy wasn't made.",
    ],
    [
      'ambiguous repository project',
      { ok: false, code: 'refused', reason: 'ambiguous' },
      'organization-repository-inaccessible',
      "Acme has a project for this repository that you can't use, so the copy wasn't made.",
    ],
    [
      'failed setup',
      {
        ok: false,
        code: 'setup-failed',
        organizationProjectId: PROJECT,
        conversionCode: 'offline',
      },
      'organization-creation-failed',
      "Couldn't make the copy in Acme. Try again.",
    ],
  ];

  it.each(creatorRefusalCases)(
    'maps a creator %s refusal and removes everything the attempt made',
    async (_label, result, code, message) => {
      create.mockResolvedValue(result);

      await expect(forkCode()).rejects.toMatchObject({ code, message });

      expect(createSingleRepoWorktree).not.toHaveBeenCalled();
      expect(deleteWorkspaceById).toHaveBeenCalledWith(
        'shared-fix',
        'shared_container_fork',
      );
      expect(moveBackToPersonal).not.toHaveBeenCalled();
      expect(await readdir(join(tempPath, 'repos'))).toEqual([]);
    },
  );

  it.each([
    [403, 'organization-creation-unavailable', 1],
    [404, 'organization-creation-unavailable', 4],
    [409, 'organization-creation-failed', 3],
    [500, 'organization-creation-failed', 1],
  ] as const)(
    'maps a %s server refusal after the eligibility check',
    async (status, code, attempts) => {
      const { CanopyCloudClientError } = jest.requireActual<
        typeof CanopyCloudClientModule
      >('../canopy-cloud/client');
      create.mockRejectedValue(
        new CanopyCloudClientError(
          'http-error',
          'refused',
          status,
          'forbidden',
        ),
      );

      await expect(forkCode()).rejects.toMatchObject({ code });
      // Only a key that can no longer be replayed (404) moves on; a 409 is
      // retried on the same key.
      expect(create).toHaveBeenCalledTimes(attempts);
      if (status === 409)
        expect(
          new Set(create.mock.calls.map(([input]) => input.creationKey)).size,
        ).toBe(1);
      expect(deleteWorkspaceById).toHaveBeenCalledWith(
        'shared-fix',
        'shared_container_fork',
      );
      expect(await readdir(join(tempPath, 'repos'))).toEqual([]);
    },
  );

  it('moves past a key whose project was deleted and makes the copy with the next one', async () => {
    const { CanopyCloudClientError } = jest.requireActual<
      typeof CanopyCloudClientModule
    >('../canopy-cloud/client');
    const succeed = create.getMockImplementation();
    create.mockRejectedValueOnce(
      new CanopyCloudClientError('http-error', 'gone', 404, 'not_found'),
    );
    if (succeed) create.mockImplementationOnce(succeed);

    await expect(forkCode()).resolves.toMatchObject({
      projectId: 'shared-fix',
    });
    const keys = create.mock.calls.map(([input]) => input.creationKey);
    expect(keys).toEqual([
      forkOrganizationCreationKey({
        shape: 'single-repo',
        containerId: 'container',
        revisionId: 'revision',
        organizationId: ORG,
        name: 'Shared fix',
        remoteUrl: REMOTE,
        generation: 0,
      }),
      forkOrganizationCreationKey({
        shape: 'single-repo',
        containerId: 'container',
        revisionId: 'revision',
        organizationId: ORG,
        name: 'Shared fix',
        remoteUrl: REMOTE,
        generation: 1,
      }),
    ]);
  });

  it('retries a transient conflict on the same key and makes the copy', async () => {
    const { CanopyCloudClientError } = jest.requireActual<
      typeof CanopyCloudClientModule
    >('../canopy-cloud/client');
    const succeed = create.getMockImplementation();
    create.mockRejectedValueOnce(
      new CanopyCloudClientError('http-error', 'conflict', 409, 'conflict'),
    );
    if (succeed) create.mockImplementationOnce(succeed);

    await expect(forkCode()).resolves.toMatchObject({
      projectId: 'shared-fix',
    });
    const [first, second] = create.mock.calls.map(
      ([input]) => input.creationKey,
    );
    expect(second).toBe(first);
  });

  it('gives a later snapshot copy of the same revision its own project', async () => {
    const succeed = create.getMockImplementation();
    create.mockResolvedValueOnce({
      ok: false,
      code: 'setup-failed',
      organizationProjectId: PROJECT,
      conversionCode: 'project-already-bound',
    });
    if (succeed) create.mockImplementationOnce(succeed);

    await expect(forkCode(codeLayout([SNAPSHOT]))).resolves.toMatchObject({
      projectId: 'shared-fix',
    });
    expect(create).toHaveBeenCalledTimes(2);
    const [first, second] = create.mock.calls.map(
      ([input]) => input.creationKey,
    );
    expect(second).not.toBe(first);
  });

  it('moves past an archived project of its own key, but not the repository project inspection keeps matching', async () => {
    create.mockResolvedValue({
      ok: false,
      code: 'setup-failed',
      organizationProjectId: PROJECT,
      conversionCode: 'project-unavailable',
    });
    jest.mocked(getOrgProjectCatalogService).mockReturnValue({
      refresh: jest.fn(() =>
        Promise.resolve({ stale: false, error: null, projects: [] }),
      ),
    } as never);

    await expect(forkCode()).rejects.toMatchObject({
      code: 'organization-repository-inaccessible',
    });
    // The second key reached the same archived project, so the walk stopped.
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('stops on an unavailable project that is still active', async () => {
    create.mockResolvedValue({
      ok: false,
      code: 'setup-failed',
      organizationProjectId: PROJECT,
      conversionCode: 'project-unavailable',
    });

    await expect(forkCode(codeLayout([SNAPSHOT]))).rejects.toMatchObject({
      code: 'organization-creation-failed',
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('runs the real member-code creator to convert the promoted checkout in place', async () => {
    const { createOrgMemberCodeCreator } = jest.requireActual<
      typeof OrgMemberCodeCreateModule
    >('../lib/org-member-code-create');
    const convertWorkspace = jest.fn(
      (
        request: { workspaceId: string },
        options: { memberCreated?: boolean },
      ) => {
        bindings.set(request.workspaceId, orgBinding);
        return Promise.resolve({
          ok: true,
          workspaceId: request.workspaceId,
          owner: orgBinding,
          options,
        });
      },
    );
    const cloudCreate = jest.fn(
      (request: { name: string; repository: unknown }) =>
        Promise.resolve({
          ok: true,
          project: {
            id: PROJECT,
            organizationId: ORG,
            name: request.name,
            kind: 'CODE',
            memberOwned: true,
            visibility: 'private',
            privateMemory: false,
            repository: request.repository,
            capabilities: { administer: true, use: true },
          },
        }),
    );
    const inspect = jest.fn((_organizationId: string, path: string) =>
      Promise.resolve({
        kind: 'code',
        target: 'new',
        repository: path.endsWith('Snapshot')
          ? null
          : { host: 'github.com', owner: 'example', name: 'repo' },
        personalWorkspaceId: 'shared-fix',
      }),
    );
    jest.mocked(getOrgMemberCodeCreator).mockReturnValue(
      createOrgMemberCodeCreator({
        eligible: () => Promise.resolve(true),
        inspect,
        cloud: { create: cloudCreate },
        catalog: {
          refresh: () =>
            Promise.resolve({ stale: false, error: null, projects: [] }),
        },
        materialization: {
          adoptCheckout: jest.fn(),
          convertWorkspace,
        },
        repo: { init: jest.fn(), remove: jest.fn() },
      } as never),
    );

    await expect(forkCode()).resolves.toMatchObject({
      projectId: 'shared-fix',
    });
    await expect(forkCode(codeLayout([SNAPSHOT]))).resolves.toMatchObject({
      projectId: 'shared-fix',
    });

    expect(inspect.mock.calls.map(([, path]) => path)).toEqual([
      join(tempPath, 'repos', 'Repo'),
      join(tempPath, 'repos', 'Snapshot'),
    ]);
    expect(cloudCreate.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({
        organizationId: ORG,
        kind: 'CODE',
        name: 'Shared fix',
        repository: { host: 'github.com', owner: 'example', name: 'repo' },
      }),
      expect.objectContaining({ repository: null }),
    ]);
    // Converted in place, as the member's own new project.
    expect(convertWorkspace).toHaveBeenCalledWith(
      { workspaceId: 'shared-fix', organizationId: ORG, projectId: PROJECT },
      expect.objectContaining({ memberCreated: true }),
    );
  });

  it("keeps a refusal's reason when its cleanup could not finish", async () => {
    create.mockResolvedValue({ ok: false, code: 'limit-reached' });
    jest
      .mocked(deleteWorkspaceById)
      .mockRejectedValueOnce(new Error('workspace delete failed'));

    await expect(forkCode()).rejects.toMatchObject({
      code: 'organization-project-limit',
      message:
        "You've reached the limit of 100 private projects in Acme, so the copy wasn't made. Delete one to make another. Its unfinished workspace couldn't be removed. Remove it from Acme before you try again.",
    });
  });

  it('uses the checkout name for a blank title', async () => {
    await expect(
      forkCode({ ...codeLayout([REPOSITORY]), title: '   ' }),
    ).resolves.toMatchObject({ projectId: 'shared-fix' });
    expect(create.mock.calls[0]?.[0].name).toBe('Repo');
  });

  it('offers an existing workspace when the project is already bound to a usable one', async () => {
    create.mockResolvedValue({
      ok: false,
      code: 'setup-failed',
      organizationProjectId: PROJECT,
      conversionCode: 'project-already-bound',
    });
    bindings.set('team-checkout', orgBinding);
    jest.mocked(readAllSidebarItems).mockResolvedValue(
      sidebar([
        {
          id: 'team-checkout',
          type: 'single-repo',
          owner: orgBinding,
          worktrees: [],
        },
      ]),
    );

    await expect(forkCode()).rejects.toMatchObject({
      code: 'organization-already-bound',
      message:
        'Acme already has this repository on this computer. Choose an existing workspace to add the copy there.',
    });
    expect(bindings.get('team-checkout')).toEqual(orgBinding);
    expect(deleteWorkspaceById).not.toHaveBeenCalledWith(
      'team-checkout',
      expect.anything(),
    );
  });

  it('refuses before promotion when the organization already has the repository here', async () => {
    bindings.set('team-checkout', orgBinding);
    jest.mocked(getRemoteUrl).mockResolvedValue(REMOTE);
    jest.mocked(readAllSidebarItems).mockResolvedValue(
      sidebar([
        {
          id: 'team-checkout',
          type: 'single-repo',
          repoPath: '/repos/team',
          owner: orgBinding,
          worktrees: [],
        },
      ]),
    );
    jest.mocked(getOrgProjectCatalogService).mockReturnValue({
      refresh: jest.fn(() =>
        Promise.resolve({ stale: true, error: null, projects: [] }),
      ),
    } as never);

    await expect(forkCode()).rejects.toMatchObject({
      code: 'organization-already-bound',
      message:
        "Acme already has this repository on this computer, so the copy wasn't made.",
    });
    expect(findOrCreateSingleRepoWorkspaceForRepo).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(await readdir(tempPath)).not.toContain('repos');
  });

  it('refuses before promotion when the member cannot create organization projects', async () => {
    jest.mocked(isOrgMemberCodeOperationEligible).mockResolvedValue(false);

    await expect(forkCode()).rejects.toMatchObject({
      code: 'organization-creation-unavailable',
    });
    expect(findOrCreateSingleRepoWorkspaceForRepo).not.toHaveBeenCalled();
    expect(await readdir(tempPath)).not.toContain('repos');
  });

  it('refuses a multi-repository organization copy before promotion', async () => {
    await expect(
      forkCode(codeLayout([REPOSITORY, { ...REPOSITORY, repoId: 'second' }])),
    ).rejects.toMatchObject({
      code: 'organization-shape-unsupported',
      message:
        "Shares with several repositories can't be copied into a new workspace in Acme yet, so the copy wasn't made.",
    });
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(isOrgMemberCodeOperationEligible).not.toHaveBeenCalled();
    expect(await readdir(tempPath)).not.toContain('repos');
  });

  it('never returns a copy whose binding is incomplete', async () => {
    create.mockResolvedValue({
      ok: true,
      organizationProjectId: PROJECT,
      localWorkspaceId: 'shared-fix',
    });

    await expect(forkCode()).rejects.toMatchObject({
      code: 'organization-creation-failed',
    });
    expect(createSingleRepoWorktree).not.toHaveBeenCalled();
    expect(deleteWorkspaceById).toHaveBeenCalledWith(
      'shared-fix',
      'shared_container_fork',
    );
  });

  it('names the organization generically when its display name is unknown', async () => {
    jest.mocked(isOrgMemberCodeOperationEligible).mockResolvedValue(false);
    await expect(
      forkSharedCodeContainer({
        owner,
        request: request(),
        provenance: {
          sourceContainerId: 'container',
          sourceRevisionId: 'revision',
          sourceOwnerDisplayName: 'Ada',
          forkedAt: '2026-10-23T00:00:00.000Z',
        },
        revisionRoot: join(tempPath, 'revision'),
        layout: codeLayout([REPOSITORY]),
        store: new SharedContainerReplicaStore(join(tempPath, 'replicas')),
      }),
    ).rejects.toMatchObject({
      message:
        "You can't create projects in the organization right now, so the copy wasn't made.",
    });
  });
});

describe('new organization Cowork copies', () => {
  it('binds the new Cowork project with a creation key stable for the copy', async () => {
    await expect(forkCowork()).resolves.toMatchObject({
      containerType: 'COWORK_WORK_ENTRY',
      projectId: 'shared-notes',
      worktreeId: 'entry',
    });
    expect(isOrgCoworkOperationEligible).toHaveBeenCalledWith(ORG, {
      scope: 'membership',
    });
    expect(convertCoworkWorkspace).toHaveBeenCalledWith(
      { workspaceId: 'shared-notes', organizationId: ORG },
      expect.objectContaining({
        creationKey: forkOrganizationCreationKey({
          shape: 'cowork',
          containerId: 'container',
          revisionId: 'revision',
          organizationId: ORG,
          name: 'Shared notes',
          generation: 0,
        }),
      }),
    );
    expect(
      convertCoworkWorkspace.mock.invocationCallOrder[0] ?? Infinity,
    ).toBeLessThan(
      jest.mocked(createWorkEntry).mock.invocationCallOrder[0] ?? 0,
    );
    expect(bindings.get('shared-notes')).toEqual(orgBinding);
  });

  it('releases the binding and removes the project when a later step fails', async () => {
    jest
      .mocked(rehydrateForkChats)
      .mockRejectedValueOnce(new Error('chat copy failed'));

    await expect(forkCowork()).rejects.toMatchObject({
      code: 'organization-creation-failed',
    });
    expect(moveBackToPersonal).toHaveBeenCalledWith({
      workspaceId: 'shared-notes',
    });
    expect(deleteWorkspaceById).toHaveBeenCalledWith(
      'shared-notes',
      'shared_container_fork',
    );
    expect(bindings.has('shared-notes')).toBe(false);
  });

  it.each([
    ['disabled', 'organization-creation-unavailable'],
    ['member-project-limit', 'organization-project-limit'],
    ['conversion-failed', 'organization-creation-failed'],
  ] as const)(
    'maps a %s conversion refusal and removes the Personal project',
    async (conversionCode, code) => {
      convertCoworkWorkspace.mockResolvedValue({
        ok: false,
        code: conversionCode,
      });

      await expect(forkCowork()).rejects.toMatchObject({ code });
      expect(createWorkEntry).not.toHaveBeenCalled();
      expect(deleteWorkspaceById).toHaveBeenCalledWith(
        'shared-notes',
        'shared_container_fork',
      );
    },
  );

  it('gives a later copy of the same revision its own Cowork project', async () => {
    const succeed = convertCoworkWorkspace.getMockImplementation();
    convertCoworkWorkspace.mockResolvedValueOnce({
      ok: false,
      code: 'project-already-bound',
      organizationProjectId: PROJECT,
    });
    if (succeed) convertCoworkWorkspace.mockImplementationOnce(succeed);

    await expect(forkCowork()).resolves.toMatchObject({
      projectId: 'shared-notes',
    });
    expect(convertCoworkWorkspace).toHaveBeenCalledTimes(2);
    expect(convertCoworkWorkspace).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        creationKey: forkOrganizationCreationKey({
          shape: 'cowork',
          containerId: 'container',
          revisionId: 'revision',
          organizationId: ORG,
          name: 'Shared notes',
          generation: 1,
        }),
      }),
    );
  });

  it('points to the usable workspace once every key is already bound', async () => {
    convertCoworkWorkspace.mockResolvedValue({
      ok: false,
      code: 'project-already-bound',
      organizationProjectId: PROJECT,
    });
    bindings.set('org-notes', orgBinding);
    jest.mocked(readAllSidebarItems).mockResolvedValue(
      sidebar([
        {
          id: 'shared-notes',
          type: 'cowork',
          name: 'Shared notes',
          worktrees: [],
        },
        { id: 'org-notes', type: 'cowork', owner: orgBinding, worktrees: [] },
      ]),
    );

    await expect(forkCowork()).rejects.toMatchObject({
      code: 'organization-already-bound',
      message:
        'Acme already has a copy of this share on this computer. Choose an existing Cowork project to add the copy there.',
    });
    expect(convertCoworkWorkspace).toHaveBeenCalledTimes(
      FORK_CREATION_KEY_GENERATIONS,
    );
    expect(deleteWorkspaceById).toHaveBeenCalledWith(
      'shared-notes',
      'shared_container_fork',
    );
  });

  it.each([
    [403, 'organization-creation-unavailable', 1],
    [404, 'organization-creation-unavailable', 4],
    [409, 'organization-creation-failed', 3],
  ] as const)(
    'handles a %s from the Cowork project creation',
    async (status, code, attempts) => {
      const { CanopyCloudClientError } = jest.requireActual<
        typeof CanopyCloudClientModule
      >('../canopy-cloud/client');
      convertCoworkWorkspace.mockImplementation(
        (
          _request: unknown,
          options: { onCreateRefused?: (error: unknown) => void },
        ) => {
          options.onCreateRefused?.(
            new CanopyCloudClientError('http-error', 'refused', status),
          );
          return Promise.resolve({
            ok: false,
            code: status === 409 ? 'conversion-failed' : 'project-unavailable',
          });
        },
      );

      await expect(forkCowork()).rejects.toMatchObject({ code });
      expect(convertCoworkWorkspace).toHaveBeenCalledTimes(attempts);
      expect(deleteWorkspaceById).toHaveBeenCalledWith(
        'shared-notes',
        'shared_container_fork',
      );
    },
  );

  it('reports a Cowork project limit without retrying it as a conflict', async () => {
    const { CanopyCloudClientError } = jest.requireActual<
      typeof CanopyCloudClientModule
    >('../canopy-cloud/client');
    convertCoworkWorkspace.mockImplementation(
      (
        _request: unknown,
        options: { onCreateRefused?: (error: unknown) => void },
      ) => {
        options.onCreateRefused?.(
          new CanopyCloudClientError(
            'http-error',
            'limit',
            409,
            'member_project_limit',
          ),
        );
        return Promise.resolve({ ok: false, code: 'member-project-limit' });
      },
    );

    await expect(forkCowork()).rejects.toMatchObject({
      code: 'organization-project-limit',
    });
    expect(convertCoworkWorkspace).toHaveBeenCalledTimes(1);
  });

  it('refuses before creating anything when Cowork projects are unavailable', async () => {
    jest.mocked(isOrgCoworkOperationEligible).mockResolvedValue(false);
    await expect(forkCowork()).rejects.toMatchObject({
      code: 'organization-creation-unavailable',
    });
    expect(createCoworkWorkspace).not.toHaveBeenCalled();
  });
});
