/** @jest-environment node */
import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import {
  createOrgRepositoryOwnerLookup,
  type OrgRepositoryOwnerLookupDeps,
} from '../lib/org-repository-owner';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROJECT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const REPOSITORY: NonNullable<OrgProjectSummary['repository']> = {
  provider: 'github',
  host: 'github.com',
  owner: 'acme',
  name: 'payments',
  providerRepoId: '42',
  defaultBranch: 'main',
  verification: 'VERIFIED',
};

function project(
  overrides: Partial<OrgProjectSummary> = {},
): OrgProjectSummary {
  return {
    id: PROJECT_ID,
    organizationId: ORG_A,
    name: 'Payments',
    description: null,
    kind: 'CODE',
    purpose: 'project',
    visibility: 'organization',
    memberOwned: false,
    location: 'LOCAL',
    repository: REPOSITORY,
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

let enabled: boolean;
let capabilities: string[];
let accountId: string | null;
let catalogs: Record<string, OrgProjectSummary[] | null>;
let topLevel: string | null;
let commonDir: string;
let remoteUrl: string | null;
let loadCatalog: jest.Mock<Promise<OrgProjectSummary[] | null>, [string]>;
let readRemote: jest.Mock<Promise<string | null>, [string]>;
/** Whether an organization's Existing folder could take the folder. */
let placeable: boolean;
let canPlace: jest.Mock<Promise<boolean>, [string]>;

function deps(
  overrides: Partial<OrgRepositoryOwnerLookupDeps> = {},
): OrgRepositoryOwnerLookupDeps {
  return {
    enabled: (): boolean => enabled,
    access: () =>
      Promise.resolve({
        accountId,
        capabilities,
        organizations: [
          { id: ORG_A, name: 'Acme' },
          { id: ORG_B, name: 'Beta' },
        ],
      }),
    realpath: (path: string): Promise<string> => Promise.resolve(path),
    git: {
      topLevel: (): Promise<string | null> => Promise.resolve(topLevel),
      commonDir: (): Promise<string> => Promise.resolve(commonDir),
      remoteUrl: readRemote,
    },
    loadCatalog,
    canPlace,
    timeoutMs: 3_000,
    ...overrides,
  };
}

beforeEach(() => {
  enabled = true;
  capabilities = ['org-projects-v1'];
  accountId = 'account-1';
  catalogs = { [ORG_A]: [project()], [ORG_B]: [] };
  topLevel = '/repo';
  commonDir = '/repo/.git';
  remoteUrl = 'git@github.com:acme/payments.git';
  loadCatalog = jest.fn((organizationId: string) =>
    Promise.resolve(
      organizationId in catalogs ? (catalogs[organizationId] ?? null) : [],
    ),
  );
  readRemote = jest.fn<Promise<string | null>, [string]>(() =>
    Promise.resolve(remoteUrl),
  );
  placeable = true;
  canPlace = jest.fn<Promise<boolean>, [string]>(() =>
    Promise.resolve(placeable),
  );
});

const ACME_OWNER = {
  kind: 'organization',
  organizationId: ORG_A,
  organizationName: 'Acme',
  projectId: PROJECT_ID,
  projectName: 'Payments',
  repositoryName: 'acme/payments',
};

describe('organization repository owner lookup', () => {
  it('names the one organization project that holds a folder repository', async () => {
    await expect(
      createOrgRepositoryOwnerLookup(deps()).find({ path: '/repo' }),
    ).resolves.toEqual(ACME_OWNER);
    expect(readRemote).toHaveBeenCalledWith('/repo');
  });

  it('matches a clone URL, including another spelling of the same repository', async () => {
    const lookup = createOrgRepositoryOwnerLookup(deps());
    await expect(
      lookup.find({ remoteUrl: 'https://github.com/Acme/payments.git' }),
    ).resolves.toEqual(ACME_OWNER);
    await expect(
      lookup.find({ remoteUrl: 'https://github.com/acme/other.git' }),
    ).resolves.toEqual({ kind: 'none' });
    expect(readRemote).not.toHaveBeenCalled();
  });

  it('answers with names and ids only, never the folder path it was asked about (CAN-3592)', async () => {
    const result = await createOrgRepositoryOwnerLookup(deps()).find({
      path: '/repo',
    });
    expect(result).toEqual(ACME_OWNER);
    expect(JSON.stringify(result)).not.toContain('/repo');
    expect(Object.keys(result)).toEqual([
      'kind',
      'organizationId',
      'organizationName',
      'projectId',
      'projectName',
      'repositoryName',
    ]);
  });

  it('never names an organization the member is not in (CAN-3592)', async () => {
    // Acme's catalog holds the repository, but the member is only in Beta:
    // Acme's catalog is never consulted and nothing is named.
    const lookup = createOrgRepositoryOwnerLookup(
      deps({
        access: () =>
          Promise.resolve({
            accountId,
            capabilities,
            organizations: [{ id: ORG_B, name: 'Beta' }],
          }),
      }),
    );
    await expect(lookup.find({ path: '/repo' })).resolves.toEqual({
      kind: 'none',
    });
    expect(loadCatalog).not.toHaveBeenCalledWith(ORG_A);
  });

  it('never guesses between organizations or projects', async () => {
    catalogs[ORG_B] = [
      project({
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        organizationId: ORG_B,
      }),
    ];
    await expect(
      createOrgRepositoryOwnerLookup(deps()).find({ path: '/repo' }),
    ).resolves.toEqual({ kind: 'none' });
    catalogs[ORG_B] = [];
    catalogs[ORG_A] = [
      project({
        repository: {
          ...REPOSITORY,
          verification: 'UNVERIFIED',
          providerRepoId: null,
        },
      }),
      project({
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        repository: {
          ...REPOSITORY,
          verification: 'UNVERIFIED',
          providerRepoId: null,
        },
      }),
    ];
    await expect(
      createOrgRepositoryOwnerLookup(deps()).find({ path: '/repo' }),
    ).resolves.toEqual({ kind: 'none' });
  });

  it.each<[string, Partial<OrgProjectSummary>]>([
    ['member-owned', { memberOwned: true }],
    ['private', { visibility: 'private' }],
    ['archived', { state: 'ARCHIVED' }],
    [
      'not usable',
      { capabilities: { use: false, administer: false, manageCloud: false } },
    ],
    ['Cowork', { kind: 'COWORK', repository: null }],
    ['the default Chats', { purpose: 'default-chats' }],
    ['multi-repo', { topology: 'multi-repo' }],
  ])('ignores a %s project', async (_case, overrides) => {
    catalogs[ORG_A] = [project(overrides)];
    await expect(
      createOrgRepositoryOwnerLookup(deps()).find({ path: '/repo' }),
    ).resolves.toEqual({ kind: 'none' });
  });

  it('says nothing for a folder that is not a top-level checkout with an origin', async () => {
    const lookup = createOrgRepositoryOwnerLookup(deps());
    topLevel = null;
    await expect(lookup.find({ path: '/repo' })).resolves.toEqual({
      kind: 'none',
    });
    topLevel = '/';
    await expect(lookup.find({ path: '/repo' })).resolves.toEqual({
      kind: 'none',
    });
    topLevel = '/repo';
    commonDir = '/main/.git/worktrees/repo';
    await expect(lookup.find({ path: '/repo' })).resolves.toEqual({
      kind: 'none',
    });
    commonDir = '/repo/.git';
    remoteUrl = null;
    await expect(lookup.find({ path: '/repo' })).resolves.toEqual({
      kind: 'none',
    });
  });

  it('says nothing while the rollout flag, capability or account is missing', async () => {
    const lookup = createOrgRepositoryOwnerLookup(deps());
    enabled = false;
    await expect(lookup.find({ path: '/repo' })).resolves.toEqual({
      kind: 'none',
    });
    enabled = true;
    capabilities = [];
    await expect(lookup.find({ path: '/repo' })).resolves.toEqual({
      kind: 'none',
    });
    capabilities = ['org-projects-v1'];
    accountId = null;
    await expect(lookup.find({ path: '/repo' })).resolves.toEqual({
      kind: 'none',
    });
    expect(readRemote).not.toHaveBeenCalled();
    expect(loadCatalog).not.toHaveBeenCalled();
  });

  it('says nothing when another organization catalog is unknown or a read fails', async () => {
    catalogs[ORG_B] = null;
    await expect(
      createOrgRepositoryOwnerLookup(deps()).find({ path: '/repo' }),
    ).resolves.toEqual({ kind: 'none' });
    catalogs[ORG_B] = [];
    readRemote.mockRejectedValueOnce(new Error('git failed'));
    await expect(
      createOrgRepositoryOwnerLookup(deps()).find({ path: '/repo' }),
    ).resolves.toEqual({ kind: 'none' });
  });

  it('says nothing when the lookup runs past its time box', async () => {
    jest.useFakeTimers();
    try {
      const lookup = createOrgRepositoryOwnerLookup(
        deps({
          loadCatalog: () => new Promise((): void => undefined),
          timeoutMs: 3_000,
        }),
      );
      const answer = lookup.find({ path: '/repo' });
      await jest.advanceTimersByTimeAsync(3_000);
      await expect(answer).resolves.toEqual({ kind: 'none' });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('a folder the organization could not take', (): void => {
  it('answers none when the folder overlaps another project, so the nudge never offers an add that would be refused', async (): Promise<void> => {
    placeable = false;

    await expect(
      createOrgRepositoryOwnerLookup(deps()).find({ path: '/repo' }),
    ).resolves.toEqual({ kind: 'none' });
    expect(canPlace).toHaveBeenCalledWith('/repo');
  });

  it('answers none when the placement check fails', async (): Promise<void> => {
    canPlace.mockRejectedValue(new Error('unreadable'));

    await expect(
      createOrgRepositoryOwnerLookup(deps()).find({ path: '/repo' }),
    ).resolves.toEqual({ kind: 'none' });
  });

  it('does not check placement for a clone URL', async (): Promise<void> => {
    placeable = false;

    await expect(
      createOrgRepositoryOwnerLookup(deps()).find({
        remoteUrl: 'git@github.com:acme/payments.git',
      }),
    ).resolves.toEqual(ACME_OWNER);
    expect(canPlace).not.toHaveBeenCalled();
  });
});
