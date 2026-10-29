/* eslint-disable @typescript-eslint/unbound-method */
import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import type { OrgProjectConversionResult } from '@canopy/desktop-shared/types';
import {
  createOrgMemberMultiRepoCreator,
  type OrgMemberMultiRepoCreatorDeps,
} from '../lib/org-member-multi-repo-create';
import { resolveMultiRepoRepositories } from '../lib/org-member-multi-repo-repositories';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const paymentsId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const billingId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const multiRepoProjectId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

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

const converted: OrgProjectConversionResult = {
  ok: true,
  workspaceId: 'acme-platform',
  owner: {
    type: 'organization',
    organizationId,
    projectId: multiRepoProjectId,
    instanceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    bindingGeneration: 0,
  },
  ownershipTransfer: {
    version: 1,
    previousOwner: { type: 'personal' },
    organizationId,
    projectId: multiRepoProjectId,
    convertedAt: '2026-10-02T00:00:00.000Z',
  },
};

function fixture(): {
  creator: ReturnType<typeof createOrgMemberMultiRepoCreator>;
  deps: OrgMemberMultiRepoCreatorDeps;
} {
  const deps: OrgMemberMultiRepoCreatorDeps = {
    eligible: jest.fn(() => Promise.resolve(true)),
    inspect: jest.fn(() =>
      Promise.resolve({ kind: 'multi-repo' as const, repositoryCount: 2 }),
    ),
    workspace: {
      create: jest.fn(() => Promise.resolve('acme-platform')),
      importFolder: jest.fn(() => Promise.resolve('imported-platform')),
      remove: jest.fn(() => Promise.resolve()),
    },
    materialization: {
      adoptMultiRepoWorkspace: jest.fn(() => Promise.resolve(converted)),
    },
  };
  return { creator: createOrgMemberMultiRepoCreator(deps), deps };
}

describe('Create new multi-repo in an organization (CAN-3546)', (): void => {
  it('passes its memory choice into the server definition conversion', async () => {
    const { creator, deps } = fixture();
    await creator.create({
      organizationId,
      name: 'Platform',
      privateMemory: true,
    });
    expect(deps.materialization.adoptMultiRepoWorkspace).toHaveBeenCalledWith(
      { workspaceId: 'acme-platform', organizationId },
      { memberCreated: true, privateMemory: true },
    );
  });
  it('creates an empty local multi-repo project and binds it, for its settings to fill', async () => {
    const { creator, deps } = fixture();

    await expect(
      creator.create({ organizationId, name: ' Acme platform ' }),
    ).resolves.toEqual({
      ok: true,
      organizationProjectId: multiRepoProjectId,
      localWorkspaceId: 'acme-platform',
    });
    expect(deps.workspace.create).toHaveBeenCalledWith('Acme platform');
    // The member's own project may have no repository yet.
    expect(deps.materialization.adoptMultiRepoWorkspace).toHaveBeenCalledWith(
      { workspaceId: 'acme-platform', organizationId },
      { memberCreated: true },
    );
    expect(deps.workspace.remove).not.toHaveBeenCalled();
  });

  it('creates nothing without a name', async () => {
    const { creator, deps } = fixture();

    await expect(
      creator.create({ organizationId, name: '   ' }),
    ).resolves.toEqual({ ok: false, code: 'create-failed' });
    expect(deps.workspace.create).not.toHaveBeenCalled();
    expect(deps.materialization.adoptMultiRepoWorkspace).not.toHaveBeenCalled();
  });

  it('removes the new local project when the organization refuses it', async () => {
    const { creator, deps } = fixture();
    jest
      .mocked(deps.materialization.adoptMultiRepoWorkspace)
      .mockResolvedValue({ ok: false, code: 'member-project-limit' });

    await expect(
      creator.create({ organizationId, name: 'Acme platform' }),
    ).resolves.toEqual({ ok: false, code: 'limit-reached' });
    expect(deps.workspace.remove).toHaveBeenCalledWith('acme-platform', {
      sourceRepo: true,
    });
  });

  it('keeps the local project after a failed setup and retries the same one', async () => {
    const { creator, deps } = fixture();
    jest
      .mocked(deps.materialization.adoptMultiRepoWorkspace)
      .mockResolvedValueOnce({ ok: false, code: 'offline' });

    await expect(
      creator.create({ organizationId, name: 'Acme platform' }),
    ).resolves.toEqual({
      ok: false,
      code: 'setup-failed',
      localWorkspaceId: 'acme-platform',
      conversionCode: 'offline',
    });
    expect(deps.workspace.remove).not.toHaveBeenCalled();

    await expect(
      creator.create({
        organizationId,
        name: 'Acme platform',
        localWorkspaceId: 'acme-platform',
      }),
    ).resolves.toEqual({
      ok: true,
      organizationProjectId: multiRepoProjectId,
      localWorkspaceId: 'acme-platform',
    });
    expect(deps.workspace.create).toHaveBeenCalledTimes(1);
    expect(
      deps.materialization.adoptMultiRepoWorkspace,
    ).toHaveBeenLastCalledWith(
      { workspaceId: 'acme-platform', organizationId },
      { memberCreated: true },
    );
  });

  it('forwards the eligibility scope, selected by default', async () => {
    const { creator, deps } = fixture();

    await creator.create({ organizationId, name: 'Acme platform' });
    await creator.create(
      { organizationId, name: 'Acme platform', localWorkspaceId: 'acme' },
      { scope: 'membership' },
    );

    expect(jest.mocked(deps.eligible).mock.calls).toEqual([
      [organizationId, undefined],
      [organizationId, 'membership'],
    ]);
  });

  it('creates nothing when the organization cannot take member projects', async () => {
    const { creator, deps } = fixture();
    jest.mocked(deps.eligible).mockResolvedValue(false);

    await expect(
      creator.create({ organizationId, name: 'Acme platform' }),
    ).resolves.toEqual({ ok: false, code: 'unavailable' });
    expect(deps.workspace.create).not.toHaveBeenCalled();
  });
});

describe('Existing folder multi-repo in an organization (CAN-3546)', (): void => {
  it('moves a Personal multi-repo project in place', async () => {
    const { creator, deps } = fixture();
    jest.mocked(deps.inspect).mockResolvedValue({
      kind: 'multi-repo',
      repositoryCount: 2,
      personalWorkspaceId: 'personal-platform',
    });

    await creator.create({
      organizationId,
      name: 'Platform',
      folderPath: '/repos/platform',
    });
    expect(deps.workspace.importFolder).not.toHaveBeenCalled();
    expect(deps.materialization.adoptMultiRepoWorkspace).toHaveBeenCalledWith(
      { workspaceId: 'personal-platform', organizationId },
      { memberCreated: true },
    );
  });

  it('adds a multi-repo project folder, then binds it', async () => {
    const { creator, deps } = fixture();

    await creator.create({
      organizationId,
      name: 'Platform',
      folderPath: '/repos/platform',
    });
    expect(deps.workspace.importFolder).toHaveBeenCalledWith('/repos/platform');
    expect(deps.materialization.adoptMultiRepoWorkspace).toHaveBeenCalledWith(
      { workspaceId: 'imported-platform', organizationId },
      { memberCreated: true },
    );
  });

  it('passes on the folder refusal and adds nothing', async () => {
    const { creator, deps } = fixture();
    jest.mocked(deps.inspect).mockResolvedValue({
      kind: 'refused',
      reason: 'outside-organization',
      repositories: ['side'],
    });

    await expect(
      creator.create({
        organizationId,
        name: 'Platform',
        folderPath: '/repos/platform',
      }),
    ).resolves.toEqual({
      ok: false,
      code: 'refused',
      reason: 'outside-organization',
      repositories: ['side'],
    });
    expect(deps.workspace.importFolder).not.toHaveBeenCalled();
  });
});

describe('resolveMultiRepoRepositories', (): void => {
  const catalog = [
    orgProject(paymentsId, 'payments'),
    orgProject(billingId, 'billing'),
  ];

  it('treats a root folder without a remote as neutral', (): void => {
    expect(
      resolveMultiRepoRepositories(catalog, [
        { name: 'platform', remoteUrl: null, root: true },
        {
          name: 'payments',
          remoteUrl: 'git@github.com:acme/payments.git',
          root: false,
        },
      ]),
    ).toEqual({ ok: true, repositoryProjectIds: [paymentsId] });
  });

  it('refuses a root folder whose remote is outside the organization', (): void => {
    expect(
      resolveMultiRepoRepositories(catalog, [
        {
          name: 'platform',
          remoteUrl: 'git@github.com:elsewhere/platform.git',
          root: true,
        },
        {
          name: 'payments',
          remoteUrl: 'git@github.com:acme/payments.git',
          root: false,
        },
      ]),
    ).toEqual({
      ok: false,
      reason: 'outside-organization',
      outside: ['platform'],
    });
  });

  it('has nothing to gather from a remote-less root alone', (): void => {
    expect(
      resolveMultiRepoRepositories(catalog, [
        { name: 'platform', remoteUrl: null, root: true },
      ]),
    ).toEqual({ ok: false, reason: 'no-repositories' });
  });
});
