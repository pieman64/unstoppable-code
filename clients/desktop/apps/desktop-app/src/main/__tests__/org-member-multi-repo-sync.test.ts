/* eslint-disable @typescript-eslint/unbound-method */
import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import type {
  DesktopOrgProjectCatalogSnapshot,
  WorkspaceConfigFile,
  WorkspaceRepoData,
} from '@canopy/desktop-shared/types';
import {
  createOrgMemberMultiRepoSync,
  type OrgMemberMultiRepoSyncDeps,
} from '../lib/org-member-multi-repo-sync';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const memberProjectId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const paymentsId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const billingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';

function orgProject(id: string, name: string): OrgProjectSummary {
  return {
    id,
    organizationId,
    name,
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
      name,
      providerRepoId: id.slice(-2),
      defaultBranch: 'main',
      verification: 'VERIFIED',
    },
    state: 'ACTIVE',
    revision: 1,
    authorizationVersion: 1,
    defaultListed: true,
    preference: 'FOLLOW_DEFAULTS',
    listed: true,
    capabilities: { administer: false, manageCloud: false, use: true },
    instance: null,
  };
}

const remotes: Record<string, string | null> = {
  '/projects/platform': null,
  '/repos/payments': 'git@github.com:acme/payments.git',
  '/repos/billing': 'https://github.com/acme/billing.git',
  '/repos/web3swift': 'git@github.com:skywinder/web3swift.git',
  '/repos/notes': null,
};

function repo(name: string): WorkspaceRepoData {
  return { id: name, name, repoPath: `/repos/${name}` };
}

function orgConfig(repos: WorkspaceRepoData[] = []): WorkspaceConfigFile {
  return {
    version: 1,
    type: 'multi-repo',
    sourceRepoPath: '/projects/platform',
    owner: {
      type: 'organization',
      organizationId,
      projectId: memberProjectId,
      instanceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      bindingGeneration: 0,
    },
    repos,
  };
}

function fixture(
  config: WorkspaceConfigFile,
  overrides: Partial<DesktopOrgProjectCatalogSnapshot> = {},
): OrgMemberMultiRepoSyncDeps {
  const snapshot: DesktopOrgProjectCatalogSnapshot = {
    context: `org:${organizationId}`,
    projects: [
      orgProject(paymentsId, 'payments'),
      orgProject(billingId, 'billing'),
    ],
    revision: '1',
    fetchedAt: '2026-10-02T00:00:00.000Z',
    stale: false,
    error: null,
    ...overrides,
  };
  return {
    readConfig: jest.fn(() => Promise.resolve(structuredClone(config))),
    readRemoteUrl: jest.fn((path: string) =>
      Promise.resolve(remotes[path] ?? null),
    ),
    catalog: { refresh: jest.fn(() => Promise.resolve(snapshot)) },
    organizationName: jest.fn(() => 'Acme'),
    updateRepositories: jest.fn(() => Promise.resolve('updated' as const)),
    revert: {
      removeRepo: jest.fn(() => Promise.resolve()),
      restoreRepo: jest.fn(() => Promise.resolve()),
    },
  };
}

describe('adding a repository in settings (CAN-3546)', (): void => {
  it("adds an organization's repository and replaces the server list", async () => {
    const deps = fixture(orgConfig([repo('payments')]));
    const add = jest.fn(() => Promise.resolve(repo('billing')));

    await expect(
      createOrgMemberMultiRepoSync(deps).addRepo(
        'acme-platform',
        '/repos/billing',
        add,
      ),
    ).resolves.toEqual(repo('billing'));

    expect(deps.catalog.refresh).toHaveBeenCalledWith(organizationId);
    expect(add).toHaveBeenCalledTimes(1);
    // The remote-less root is neutral; each repository maps to its project.
    expect(deps.updateRepositories).toHaveBeenCalledWith(memberProjectId, [
      paymentsId,
      billingId,
    ]);
    expect(deps.revert.removeRepo).not.toHaveBeenCalled();
  });

  it('refuses a repository the organization does not hold, by name, and writes nothing', async () => {
    const deps = fixture(orgConfig([repo('payments')]));
    const add = jest.fn(() => Promise.resolve(repo('web3swift')));

    await expect(
      createOrgMemberMultiRepoSync(deps).addRepo(
        'acme-platform',
        '/repos/web3swift',
        add,
      ),
    ).rejects.toThrow(
      "web3swift doesn't belong to Acme. Choose repositories that belong to Acme.",
    );

    expect(add).not.toHaveBeenCalled();
    expect(deps.updateRepositories).not.toHaveBeenCalled();
  });

  it('removes the repository again when the organization does not take the list', async () => {
    const deps = fixture(orgConfig());
    deps.updateRepositories = jest.fn(() => Promise.resolve('failed' as const));
    const add = jest.fn(() => Promise.resolve(repo('payments')));

    await expect(
      createOrgMemberMultiRepoSync(deps).addRepo(
        'acme-platform',
        '/repos/payments',
        add,
      ),
    ).rejects.toThrow("Couldn't update this project in Acme. Try again.");

    expect(add).toHaveBeenCalledTimes(1);
    expect(deps.revert.removeRepo).toHaveBeenCalledWith(
      'acme-platform',
      'payments',
    );
  });

  it('says which repositories a stale catalog let through when the server refuses them', async () => {
    const deps = fixture(orgConfig());
    deps.updateRepositories = jest.fn(() =>
      Promise.resolve('repository-mismatch' as const),
    );

    await expect(
      createOrgMemberMultiRepoSync(deps).addRepo(
        'acme-platform',
        '/repos/payments',
        () => Promise.resolve(repo('payments')),
      ),
    ).rejects.toThrow(
      "Some repositories don't belong to Acme. Choose repositories that belong to Acme.",
    );
    expect(deps.revert.removeRepo).toHaveBeenCalledWith(
      'acme-platform',
      'payments',
    );
  });

  it('writes nothing when the catalog cannot be refreshed', async () => {
    const deps = fixture(orgConfig(), { stale: true, error: 'offline' });
    const add = jest.fn(() => Promise.resolve(repo('payments')));

    await expect(
      createOrgMemberMultiRepoSync(deps).addRepo(
        'acme-platform',
        '/repos/payments',
        add,
      ),
    ).rejects.toThrow("Couldn't check this repository with Acme. Try again.");
    expect(add).not.toHaveBeenCalled();
  });

  it('adds a repository without a remote without asking the organization (CAN-3544)', async () => {
    const deps = fixture(orgConfig([repo('payments')]));
    const add = jest.fn(() => Promise.resolve(repo('notes')));

    await createOrgMemberMultiRepoSync(deps).addRepo(
      'acme-platform',
      '/repos/notes',
      add,
    );

    expect(add).toHaveBeenCalledTimes(1);
    expect(deps.catalog.refresh).not.toHaveBeenCalled();
    expect(deps.updateRepositories).not.toHaveBeenCalled();
  });

  it('leaves a Personal project alone', async () => {
    const personal: WorkspaceConfigFile = {
      version: 1,
      type: 'multi-repo',
      repos: [],
    };
    const deps = fixture(personal);
    const add = jest.fn(() => Promise.resolve(repo('web3swift')));

    await createOrgMemberMultiRepoSync(deps).addRepo(
      'platform',
      '/repos/web3swift',
      add,
    );

    expect(add).toHaveBeenCalledTimes(1);
    expect(deps.readRemoteUrl).not.toHaveBeenCalled();
    expect(deps.updateRepositories).not.toHaveBeenCalled();
  });
});

describe('removing a repository in settings (CAN-3546)', (): void => {
  it('removes it and replaces the server list', async () => {
    const deps = fixture(orgConfig([repo('payments'), repo('billing')]));
    const remove = jest.fn(() => Promise.resolve());

    await createOrgMemberMultiRepoSync(deps).removeRepo(
      'acme-platform',
      'payments',
      remove,
    );

    expect(remove).toHaveBeenCalledTimes(1);
    expect(deps.updateRepositories).toHaveBeenCalledWith(memberProjectId, [
      billingId,
    ]);
  });

  it('puts it back where it was when the organization does not take the list', async () => {
    const deps = fixture(orgConfig([repo('payments'), repo('billing')]));
    deps.updateRepositories = jest.fn(() => Promise.resolve('failed' as const));

    await expect(
      createOrgMemberMultiRepoSync(deps).removeRepo(
        'acme-platform',
        'payments',
        () => Promise.resolve(),
      ),
    ).rejects.toThrow("Couldn't update this project in Acme. Try again.");

    expect(deps.revert.restoreRepo).toHaveBeenCalledWith(
      'acme-platform',
      repo('payments'),
      0,
    );
  });

  it('removes a repository whose folder can no longer be read', async () => {
    const deps = fixture(orgConfig([repo('payments'), repo('billing')]));
    const readRemote = deps.readRemoteUrl;
    deps.readRemoteUrl = jest.fn((path: string) =>
      path === repo('payments').repoPath
        ? Promise.reject(new Error('not a git repository'))
        : readRemote(path),
    );
    const remove = jest.fn(() => Promise.resolve());

    await createOrgMemberMultiRepoSync(deps).removeRepo(
      'acme-platform',
      'payments',
      remove,
    );

    expect(remove).toHaveBeenCalledTimes(1);
    expect(deps.updateRepositories).toHaveBeenCalledWith(memberProjectId, [
      billingId,
    ]);
  });

  it('still removes a repository when another one cannot be read, leaving the server list for the next change', async () => {
    const deps = fixture(orgConfig([repo('payments'), repo('billing')]));
    const readRemote = deps.readRemoteUrl;
    deps.readRemoteUrl = jest.fn((path: string) =>
      path === repo('billing').repoPath
        ? Promise.reject(new Error('missing folder'))
        : readRemote(path),
    );
    const remove = jest.fn(() => Promise.resolve());

    await createOrgMemberMultiRepoSync(deps).removeRepo(
      'acme-platform',
      'payments',
      remove,
    );

    expect(remove).toHaveBeenCalledTimes(1);
    expect(deps.updateRepositories).not.toHaveBeenCalled();
  });

  it('removes the last repository, leaving the server project empty', async () => {
    const deps = fixture(orgConfig([repo('payments')]));

    await createOrgMemberMultiRepoSync(deps).removeRepo(
      'acme-platform',
      'payments',
      () => Promise.resolve(),
    );

    expect(deps.updateRepositories).toHaveBeenCalledWith(memberProjectId, []);
  });
});

describe('adding a repository to source control in settings (CAN-3546)', (): void => {
  it('refuses a repository the organization does not hold before applying', async () => {
    const deps = fixture(orgConfig());
    const apply = jest.fn(() => Promise.resolve('applied'));

    await expect(
      createOrgMemberMultiRepoSync(deps).applySourceChanges(
        'acme-platform',
        {
          workspaceId: 'acme-platform',
          target: { mode: 'new', existingWorktreeIds: [] },
          repoAdds: [
            {
              repoName: 'web3swift',
              remoteUrl: 'git@github.com:skywinder/web3swift.git',
              repoPath: '/repos/web3swift',
            },
          ],
        },
        apply,
      ),
    ).rejects.toThrow("web3swift doesn't belong to Acme.");

    expect(apply).not.toHaveBeenCalled();
    expect(deps.updateRepositories).not.toHaveBeenCalled();
  });

  it('has the organization take the new list first, and restores it when the apply fails', async () => {
    const deps = fixture(orgConfig([repo('payments')]));
    const apply = jest.fn(() => Promise.reject(new Error('worktree failed')));

    await expect(
      createOrgMemberMultiRepoSync(deps).applySourceChanges(
        'acme-platform',
        {
          workspaceId: 'acme-platform',
          target: { mode: 'new', existingWorktreeIds: [] },
          repoAdds: [
            {
              repoName: 'billing',
              remoteUrl: 'https://github.com/acme/billing.git',
              repoPath: '/repos/billing',
            },
          ],
        },
        apply,
      ),
    ).rejects.toThrow('worktree failed');

    expect(deps.updateRepositories).toHaveBeenNthCalledWith(
      1,
      memberProjectId,
      [paymentsId, billingId],
    );
    expect(deps.updateRepositories).toHaveBeenNthCalledWith(
      2,
      memberProjectId,
      [paymentsId],
    );
  });

  it('applies nothing when the organization does not take the list', async () => {
    const deps = fixture(orgConfig());
    deps.updateRepositories = jest.fn(() => Promise.resolve('failed' as const));
    const apply = jest.fn(() => Promise.resolve('applied'));

    await expect(
      createOrgMemberMultiRepoSync(deps).applySourceChanges(
        'acme-platform',
        {
          workspaceId: 'acme-platform',
          target: { mode: 'new', existingWorktreeIds: [] },
          repoAdds: [
            {
              repoName: 'billing',
              remoteUrl: 'https://github.com/acme/billing.git',
              repoPath: '/repos/billing',
            },
          ],
        },
        apply,
      ),
    ).rejects.toThrow("Couldn't update this project in Acme. Try again.");
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('checking repositories before one is chosen (CAN-3546)', (): void => {
  it('marks each repository by the rule adding it refuses by', async () => {
    const deps = fixture(orgConfig([repo('payments')]));
    deps.readRemoteUrl = jest.fn((path: string) =>
      path === '/repos/broken'
        ? Promise.reject(new Error('git failed'))
        : Promise.resolve(remotes[path] ?? null),
    );

    await expect(
      createOrgMemberMultiRepoSync(deps).checkRepositories({
        workspaceId: 'acme-platform',
        repoPaths: [
          '/repos/billing',
          '/repos/web3swift',
          '/repos/notes',
          '/repos/broken',
        ],
        remoteUrls: [
          'https://github.com/acme/payments.git',
          'https://github.com/skywinder/web3swift.git',
        ],
      }),
    ).resolves.toEqual({
      kind: 'checked',
      organizationName: 'Acme',
      repositories: {
        '/repos/billing': 'eligible',
        '/repos/web3swift': 'outside',
        // No remote: never refused (CAN-3544).
        '/repos/notes': 'neutral',
        'https://github.com/acme/payments.git': 'eligible',
        'https://github.com/skywinder/web3swift.git': 'outside',
      },
    });
    expect(deps.catalog.refresh).toHaveBeenCalledWith(organizationId);
    expect(deps.updateRepositories).not.toHaveBeenCalled();
  });

  it('reads no catalog when every repository is remote-less', async () => {
    const deps = fixture(orgConfig());

    await expect(
      createOrgMemberMultiRepoSync(deps).checkRepositories({
        workspaceId: 'acme-platform',
        repoPaths: ['/repos/notes'],
      }),
    ).resolves.toEqual({
      kind: 'checked',
      organizationName: 'Acme',
      repositories: { '/repos/notes': 'neutral' },
    });
    expect(deps.catalog.refresh).not.toHaveBeenCalled();
  });

  it('says so when the catalog cannot be refreshed', async () => {
    const deps = fixture(orgConfig(), { stale: true, error: 'offline' });

    await expect(
      createOrgMemberMultiRepoSync(deps).checkRepositories({
        workspaceId: 'acme-platform',
        repoPaths: ['/repos/payments'],
      }),
    ).resolves.toEqual({
      kind: 'failed',
      message: "Couldn't check this repository with Acme. Try again.",
    });
  });

  it('refuses nothing in a Personal project', async () => {
    const deps = fixture({ version: 1, type: 'multi-repo', repos: [] });

    await expect(
      createOrgMemberMultiRepoSync(deps).checkRepositories({
        workspaceId: 'acme-platform',
        repoPaths: ['/repos/web3swift'],
      }),
    ).resolves.toEqual({ kind: 'not-organization' });
    expect(deps.readRemoteUrl).not.toHaveBeenCalled();
  });
});

describe('automatically converted mixed projects', () => {
  it('adds a held repository while retaining unheld repositories locally', async () => {
    const deps = fixture(orgConfig([repo('payments'), repo('web3swift')]));
    const add = jest.fn(() => Promise.resolve(repo('billing')));
    await expect(
      createOrgMemberMultiRepoSync(deps).addRepo(
        'mixed',
        '/repos/billing',
        add,
      ),
    ).resolves.toEqual(repo('billing'));
    expect(deps.updateRepositories).toHaveBeenCalledWith(memberProjectId, [
      paymentsId,
      billingId,
    ]);
  });
  it('removes the final held repository and sends an empty list without releasing ownership', async () => {
    const deps = fixture(orgConfig([repo('payments'), repo('web3swift')]));
    const remove = jest.fn(() => Promise.resolve());
    await createOrgMemberMultiRepoSync(deps).removeRepo(
      'mixed',
      'payments',
      remove,
    );
    expect(remove).toHaveBeenCalledTimes(1);
    expect(deps.updateRepositories).toHaveBeenCalledWith(memberProjectId, []);
  });
  it('tolerates retained unheld source entries, including canonical duplicates, while adding a held one', async () => {
    const deps = fixture(orgConfig([repo('payments'), repo('web3swift')]));
    const apply = jest.fn(() => Promise.resolve('applied'));
    await expect(
      createOrgMemberMultiRepoSync(deps).applySourceChanges(
        'mixed',
        {
          workspaceId: 'mixed',
          target: { mode: 'new', existingWorktreeIds: [] },
          repoAdds: [
            {
              repoName: 'existing',
              remoteUrl: 'https://github.com/SKYWINDER/WEB3SWIFT.git',
              repoPath: '/repos/web3swift',
            },
            {
              repoName: 'duplicate',
              remoteUrl: 'git@github.com:acme/payments.git',
              repoPath: '/another/payments',
            },
            {
              repoName: 'billing',
              remoteUrl: remotes['/repos/billing'] ?? '',
              repoPath: '/repos/billing',
            },
          ],
        },
        apply,
      ),
    ).resolves.toBe('applied');
    expect(deps.updateRepositories).toHaveBeenCalledWith(memberProjectId, [
      paymentsId,
      billingId,
    ]);
  });
  it('does not allow a new unheld source checkout through an unrelated edit', async () => {
    const deps = fixture(orgConfig([repo('payments')]));
    const apply = jest.fn(() => Promise.resolve());
    await expect(
      createOrgMemberMultiRepoSync(deps).applySourceChanges(
        'mixed',
        {
          workspaceId: 'mixed',
          target: { mode: 'new', existingWorktreeIds: [] },
          repoAdds: [
            {
              repoName: 'web3swift',
              remoteUrl: remotes['/repos/web3swift'] ?? '',
              repoPath: '/repos/web3swift',
            },
          ],
        },
        apply,
      ),
    ).rejects.toThrow("web3swift doesn't belong to Acme.");
    expect(deps.updateRepositories).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('keeps an exact retained noncanonical remote eligible for source control', async () => {
    const remote = 'https://gitlab.com/group/subgroup/notes.git';
    const deps = fixture(orgConfig([repo('payments'), repo('notes')]));
    deps.readRemoteUrl = jest.fn((path: string) =>
      Promise.resolve(
        path === '/repos/notes' ? remote : (remotes[path] ?? null),
      ),
    );
    const apply = jest.fn(() => Promise.resolve('applied'));
    const request = {
      workspaceId: 'mixed',
      target: { mode: 'new' as const, existingWorktreeIds: [] },
      repoAdds: [
        { repoName: 'notes', repoPath: '/repos/notes', remoteUrl: remote },
      ],
    };
    const sync = createOrgMemberMultiRepoSync(deps);
    await expect(
      sync.applySourceChanges('mixed', request, apply),
    ).resolves.toBe('applied');
    expect(deps.updateRepositories).not.toHaveBeenCalled();
    apply.mockClear();
    await expect(
      sync.applySourceChanges(
        'mixed',
        {
          ...request,
          repoAdds: [
            {
              ...request.repoAdds[0],
              remoteUrl: remote.replace('notes', 'new-notes'),
            },
          ],
        },
        apply,
      ),
    ).rejects.toThrow("notes doesn't belong to Acme.");
    expect(apply).not.toHaveBeenCalled();
    expect(deps.updateRepositories).not.toHaveBeenCalled();
  });
});
