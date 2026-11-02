/** @jest-environment node */
import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import type {
  OrgMemberFolderInspection,
  SidebarItem,
} from '@canopy/desktop-shared/types';
import {
  createOrgMemberFolderInspector,
  type OrgMemberFolderInspectionOptions,
  type OrgMemberFolderInspectorDeps,
} from '../lib/org-member-folder-inspection';

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function project(
  overrides: Partial<OrgProjectSummary> = {},
): OrgProjectSummary {
  return {
    id: PROJECT_ID,
    organizationId: ORG_ID,
    name: 'Payments',
    description: null,
    kind: 'CODE',
    purpose: 'project',
    visibility: 'organization',
    memberOwned: false,
    location: 'LOCAL',
    repository: {
      provider: 'github',
      host: 'github.com',
      owner: 'acme',
      name: 'payments',
      providerRepoId: '42',
      defaultBranch: 'main',
      verification: 'VERIFIED',
    },
    state: 'ACTIVE',
    revision: 1,
    authorizationVersion: 1,
    defaultListed: true,
    preference: 'FOLLOW_DEFAULTS',
    listed: true,
    capabilities: { use: true, administer: false, manageCloud: false },
    instance: null,
    ...overrides,
  };
}

function personal(path = '/repo'): SidebarItem {
  return {
    type: 'single-repo',
    id: 'personal-payments',
    name: 'Personal payments',
    repoPath: path,
    color: 'blue',
    worktrees: [],
    collapsed: false,
    order: 0,
  };
}

let topLevel: string | null;
let commonDir: string;
let remoteUrl: string | null;
let multiRepo: boolean;
let manifestRepos: { name: string; url: string }[];
let items: SidebarItem[];
let projects: OrgProjectSummary[];
let catalogStale = false;
let deps: OrgMemberFolderInspectorDeps;
let assertImportable: jest.MockedFunction<
  OrgMemberFolderInspectorDeps['sidebar']['assertImportable']
>;

beforeEach(() => {
  topLevel = '/repo';
  commonDir = '/repo/.git';
  remoteUrl = 'git@github.com:acme/payments.git';
  multiRepo = false;
  catalogStale = false;
  manifestRepos = [];
  items = [];
  projects = [];
  assertImportable = jest.fn<
    ReturnType<OrgMemberFolderInspectorDeps['sidebar']['assertImportable']>,
    Parameters<OrgMemberFolderInspectorDeps['sidebar']['assertImportable']>
  >((): Promise<void> => Promise.resolve());
  deps = {
    realpath: (path): Promise<string> => Promise.resolve(path),
    git: {
      topLevel: (): Promise<string | null> => Promise.resolve(topLevel),
      commonDir: (): Promise<string> => Promise.resolve(commonDir),
      remoteUrl: (): Promise<string | null> => Promise.resolve(remoteUrl),
    },
    manifest: {
      rejectUnsafe: (): Promise<void> => Promise.resolve(),
      hasMultipleRepos: (): Promise<boolean> => Promise.resolve(multiRepo),
      repositories: (): Promise<readonly { name: string; url: string }[]> =>
        Promise.resolve(manifestRepos),
    },
    sidebar: {
      list: (): Promise<SidebarItem[]> => Promise.resolve(items),
      assertImportable,
    },
    catalog: {
      refresh: (): Promise<{
        projects: readonly OrgProjectSummary[];
        stale: boolean;
      }> => Promise.resolve({ projects, stale: catalogStale }),
    },
  };
});

async function inspect(
  options?: OrgMemberFolderInspectionOptions,
): Promise<OrgMemberFolderInspection> {
  return createOrgMemberFolderInspector(deps).inspect(ORG_ID, '/repo', options);
}

it('classifies a plain importable folder as Cowork', async () => {
  topLevel = null;
  await expect(inspect()).resolves.toEqual({ kind: 'cowork' });
});

it('allows a caller-created folder inside the app data directory', async () => {
  await expect(inspect({ allowInsideDataDir: true })).resolves.toMatchObject({
    kind: 'code',
  });
  expect(assertImportable).toHaveBeenCalledWith('/repo', [], {
    allowInsideDataDir: true,
  });
});

it.each([
  ['inside-repo', (): void => void (topLevel = '/repo-root')],
  ['linked-worktree', (): void => void (commonDir = '/main/.git')],
] as const)('refuses %s repositories', async (reason, arrange) => {
  arrange();
  await expect(inspect()).resolves.toEqual({ kind: 'refused', reason });
});

it('recognizes a Personal project and a usable catalog match', async () => {
  items = [personal()];
  projects = [project()];
  await expect(inspect()).resolves.toEqual({
    kind: 'code',
    target: { projectId: PROJECT_ID, projectName: 'Payments' },
    repository: { host: 'github.com', owner: 'acme', name: 'payments' },
    personalWorkspaceId: 'personal-payments',
  });
  expect(assertImportable).toHaveBeenCalledWith('/repo', [], {
    allowInsideDataDir: true,
  });
});

it('returns a new Code target for no origin or a non-GitHub origin', async () => {
  remoteUrl = null;
  await expect(inspect()).resolves.toEqual({
    kind: 'code',
    target: 'new',
    repository: null,
  });
  remoteUrl = 'https://gitlab.com/acme/payments.git';
  await expect(inspect()).resolves.toEqual({
    kind: 'code',
    target: 'new',
    repository: null,
  });
});

it('refuses inaccessible and ambiguous organization matches', async () => {
  projects = [
    project({
      capabilities: { use: false, administer: false, manageCloud: false },
    }),
  ];
  await expect(inspect()).resolves.toEqual({
    kind: 'refused',
    reason: 'no-access',
  });
  projects = [
    project(),
    project({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
  ];
  await expect(inspect()).resolves.toEqual({
    kind: 'refused',
    reason: 'ambiguous',
  });
});

it('refuses an organization-bound or overlapping folder', async () => {
  items = [
    {
      ...personal(),
      owner: {
        type: 'organization',
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
        instanceId: 'instance',
        bindingGeneration: 1,
      },
    },
  ];
  await expect(inspect()).resolves.toEqual({
    kind: 'refused',
    reason: 'already-org-project',
  });

  items = [];
  assertImportable.mockRejectedValue(new Error('overlap'));
  await expect(inspect()).resolves.toEqual({
    kind: 'refused',
    reason: 'overlaps-project',
  });
});

it('fails closed when local inspection cannot be completed', async () => {
  deps.git.remoteUrl = (): Promise<string | null> =>
    Promise.reject(new Error('git failed'));
  await expect(inspect()).resolves.toEqual({
    kind: 'refused',
    reason: 'unreadable',
  });
});

describe('multi-repo folders (CAN-3546)', (): void => {
  const BILLING_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const billing = (): OrgProjectSummary =>
    project({
      id: BILLING_ID,
      name: 'Billing',
      repository: {
        provider: 'github',
        host: 'github.com',
        owner: 'acme',
        name: 'billing',
        providerRepoId: '43',
        defaultBranch: 'main',
        verification: 'VERIFIED',
      },
    });
  const remotes: Record<string, string | null> = {
    '/repo': null,
    '/repos/payments': 'git@github.com:acme/payments.git',
    '/repos/billing': 'git@github.com:acme/billing.git',
    '/repos/side': 'git@github.com:elsewhere/side.git',
  };
  function personalMultiRepo(repoPaths: string[]): SidebarItem {
    return {
      type: 'multi-repo',
      id: 'personal-platform',
      name: 'Platform',
      color: 'blue',
      sourceRepoPath: '/repo',
      repos: repoPaths.map((repoPath) => ({
        id: repoPath.split('/').pop() ?? repoPath,
        name: repoPath.split('/').pop() ?? repoPath,
        repoPath,
      })),
      worktrees: [],
      collapsed: false,
      order: 0,
    };
  }

  beforeEach((): void => {
    deps.git.remoteUrl = (path): Promise<string | null> =>
      Promise.resolve(remotes[path] ?? null);
    projects = [project(), billing()];
  });

  it("offers a Personal multi-repo project whose repositories are all the organization's", async () => {
    items = [personalMultiRepo(['/repos/payments', '/repos/billing'])];
    await expect(inspect()).resolves.toEqual({
      kind: 'multi-repo',
      repositoryCount: 2,
      personalWorkspaceId: 'personal-platform',
    });
  });

  it('offers a Personal multi-repo project that also has a repository without a remote (CAN-3544)', async () => {
    items = [
      personalMultiRepo(['/repos/payments', '/repos/billing', '/repos/notes']),
    ];
    await expect(inspect()).resolves.toEqual({
      kind: 'multi-repo',
      repositoryCount: 2,
      personalWorkspaceId: 'personal-platform',
    });
  });

  it('refuses rather than decides when the catalog could not be refreshed', async () => {
    items = [personalMultiRepo(['/repos/payments', '/repos/billing'])];
    catalogStale = true;
    await expect(inspect()).resolves.toEqual({
      kind: 'refused',
      reason: 'unreadable',
    });
  });

  it('refuses a Personal multi-repo project with a repository outside the organization, by name', async () => {
    items = [personalMultiRepo(['/repos/payments', '/repos/side'])];
    await expect(inspect()).resolves.toEqual({
      kind: 'refused',
      reason: 'outside-organization',
      repositories: ['side'],
    });
  });

  it('offers a multi-repo project folder whose manifest lists organization repositories', async () => {
    multiRepo = true;
    manifestRepos = [
      { name: 'payments', url: 'https://github.com/acme/payments.git' },
      { name: 'billing', url: 'https://github.com/acme/billing.git' },
    ];
    await expect(inspect()).resolves.toEqual({
      kind: 'multi-repo',
      repositoryCount: 2,
    });
  });

  it('refuses a multi-repo project folder with a repository outside the organization', async () => {
    multiRepo = true;
    manifestRepos = [
      { name: 'payments', url: 'https://github.com/acme/payments.git' },
      { name: 'side', url: 'https://github.com/elsewhere/side.git' },
    ];
    await expect(inspect()).resolves.toEqual({
      kind: 'refused',
      reason: 'outside-organization',
      repositories: ['side'],
    });
  });
});

describe('canPlace (the placement step alone, for the create-time nudge)', (): void => {
  const canPlace = (): Promise<boolean> =>
    createOrgMemberFolderInspector(deps).canPlace('/repo');

  it('takes a free folder and a Personal project own folder, without reading the catalog', async () => {
    const refresh = jest.spyOn(deps.catalog, 'refresh');

    await expect(canPlace()).resolves.toBe(true);
    items = [personal()];
    await expect(canPlace()).resolves.toBe(true);

    expect(refresh).not.toHaveBeenCalled();
  });

  it('refuses a repository nested in another project folder, as inspect does', async () => {
    // A Personal Cowork project whose folder contains the repository.
    assertImportable.mockRejectedValue(
      new Error('Cannot add a folder nested inside an existing project'),
    );

    await expect(canPlace()).resolves.toBe(false);
    await expect(inspect()).resolves.toEqual({
      kind: 'refused',
      reason: 'overlaps-project',
    });
  });

  it('refuses a folder that is already an organization project', async () => {
    items = [
      {
        ...personal(),
        owner: {
          type: 'organization',
          organizationId: ORG_ID,
          projectId: PROJECT_ID,
          instanceId: 'instance',
          bindingGeneration: 1,
        },
      },
    ];

    await expect(canPlace()).resolves.toBe(false);
  });

  it('answers false when the folder cannot be read', async () => {
    deps.realpath = (): Promise<string> => Promise.reject(new Error('gone'));

    await expect(canPlace()).resolves.toBe(false);
  });
});
