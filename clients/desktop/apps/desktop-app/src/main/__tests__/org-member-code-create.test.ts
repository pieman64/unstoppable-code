/* eslint-disable @typescript-eslint/unbound-method */
import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import type {
  DesktopOrgProjectCatalogSnapshot,
  OrgProjectConversionResult,
} from '@canopy/desktop-shared/types';
import {
  createOrgMemberCodeCreator,
  type OrgMemberCodeCreatorDeps,
} from '../lib/org-member-code-create';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const projectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const repository = {
  host: 'github.com' as const,
  owner: 'acme',
  name: 'payments',
};
const project: OrgProjectSummary = {
  id: projectId,
  organizationId,
  name: 'Payments',
  description: null,
  kind: 'CODE',
  purpose: 'project',
  visibility: 'private',
  memberOwned: true,
  location: 'LOCAL',
  repository: {
    provider: 'github',
    ...repository,
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
  capabilities: { administer: true, manageCloud: false, use: true },
  instance: null,
};
const snapshot: DesktopOrgProjectCatalogSnapshot = {
  context: `org:${organizationId}`,
  projects: [project],
  revision: '1',
  fetchedAt: '2026-09-30T00:00:00.000Z',
  stale: false,
  error: null,
};

const converted: OrgProjectConversionResult = {
  ok: true,
  workspaceId: 'personal-payments',
  owner: {
    type: 'organization',
    organizationId,
    projectId,
    instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    bindingGeneration: 1,
  },
  ownershipTransfer: {
    version: 1,
    previousOwner: { type: 'personal' },
    organizationId,
    projectId,
    convertedAt: '2026-09-30T00:00:00.000Z',
  },
};

function fixture(): {
  creator: ReturnType<typeof createOrgMemberCodeCreator>;
  deps: OrgMemberCodeCreatorDeps;
} {
  const deps: OrgMemberCodeCreatorDeps = {
    eligible: jest.fn(() => Promise.resolve(true)),
    inspect: jest.fn(() =>
      Promise.resolve({ kind: 'code', target: 'new', repository }),
    ),
    cloud: { create: jest.fn(() => Promise.resolve({ ok: true, project })) },
    catalog: { refresh: jest.fn(() => Promise.resolve(snapshot)) },
    materialization: {
      adoptCheckout: jest.fn(() =>
        Promise.resolve({ localWorkspaceId: 'payments' }),
      ),
      convertWorkspace: jest.fn(() => Promise.resolve(converted)),
    },
    repo: {
      init: jest.fn(() => Promise.resolve('/repos/payments')),
      remove: jest.fn(() => Promise.resolve()),
    },
  };
  return { creator: createOrgMemberCodeCreator(deps), deps };
}

it('creates a private Code definition and adopts a selected checkout', async () => {
  const { creator, deps } = fixture();

  await expect(
    creator.create({ organizationId, name: ' Payments ', folderPath: '/repo' }),
  ).resolves.toEqual({
    ok: true,
    organizationProjectId: projectId,
    localWorkspaceId: 'payments',
  });
  expect(deps.cloud.create).toHaveBeenCalledWith({
    organizationId,
    kind: 'CODE',
    name: 'Payments',
    repository,
  });
  expect(deps.materialization.adoptCheckout).toHaveBeenCalledWith(
    expect.objectContaining({ projectId, path: '/repo' }),
    { createdRepo: false },
  );
});

it('sends a new organization Code project memory choice to the server', async () => {
  const { creator, deps } = fixture();
  jest.mocked(deps.cloud.create).mockResolvedValue({
    ok: true,
    project: { ...project, privateMemory: true },
  });
  await creator.create({
    organizationId,
    name: 'Payments',
    privateMemory: true,
  });
  expect(deps.cloud.create).toHaveBeenCalledWith(
    expect.objectContaining({ privateMemory: true }),
  );
});

it('keeps a private-selected Code project closed if the server omits its value', async () => {
  const { creator, deps } = fixture();
  await expect(
    creator.create({ organizationId, name: 'Payments', privateMemory: true }),
  ).resolves.toMatchObject({ ok: false, code: 'setup-failed' });
  expect(deps.materialization.adoptCheckout).not.toHaveBeenCalled();
});

it('converts a Personal checkout in place with member-created rules', async () => {
  const { creator, deps } = fixture();
  jest.mocked(deps.inspect).mockResolvedValue({
    kind: 'code',
    target: 'new',
    repository,
    personalWorkspaceId: 'personal-payments',
  });

  await creator.create({
    organizationId,
    name: 'Payments',
    folderPath: '/repo',
  });

  expect(deps.materialization.convertWorkspace).toHaveBeenCalledWith(
    {
      workspaceId: 'personal-payments',
      organizationId,
      projectId,
    },
    { memberCreated: true },
  );
  expect(deps.materialization.adoptCheckout).not.toHaveBeenCalled();
});

it('carries the refused conversion code on a failed in-place conversion', async () => {
  const { creator, deps } = fixture();
  jest.mocked(deps.inspect).mockResolvedValue({
    kind: 'code',
    target: 'new',
    repository,
    personalWorkspaceId: 'personal-payments',
  });
  jest
    .mocked(deps.materialization.convertWorkspace)
    .mockResolvedValue({ ok: false, code: 'repository-unavailable' });

  await expect(
    creator.create({ organizationId, name: 'Payments', folderPath: '/repo' }),
  ).resolves.toEqual({
    ok: false,
    code: 'setup-failed',
    organizationProjectId: projectId,
    conversionCode: 'repository-unavailable',
  });
});

it('forwards the eligibility scope, selected by default', async () => {
  const { creator, deps } = fixture();

  await creator.create({ organizationId, name: 'Payments' });
  await creator.create(
    { organizationId, name: 'Payments' },
    { scope: 'membership' },
  );

  expect(jest.mocked(deps.eligible).mock.calls).toEqual([
    [organizationId, undefined],
    [organizationId, 'membership'],
  ]);
});

it('links an existing catalog project without creating a duplicate', async () => {
  const { creator, deps } = fixture();
  jest.mocked(deps.inspect).mockResolvedValue({
    kind: 'code',
    target: { projectId, projectName: 'Payments' },
    repository,
  });

  await creator.create({
    organizationId,
    name: 'Payments',
    folderPath: '/repo',
  });

  expect(deps.cloud.create).not.toHaveBeenCalled();
  expect(deps.materialization.adoptCheckout).toHaveBeenCalled();
});
it('carries the initiating account and mutation guard into in-place binding', async (): Promise<void> => {
  const { creator, deps } = fixture();
  jest.mocked(deps.inspect).mockResolvedValue({
    kind: 'code',
    target: 'new',
    repository,
    personalWorkspaceId: 'personal-payments',
  });
  const beforeMutation = jest.fn(() => Promise.resolve());
  const credentialContext = {
    baseUrl: 'https://example.com',
    apiKey: 'original',
  };
  await creator.create(
    {
      organizationId,
      name: 'Payments',
      folderPath: '/repo',
      creationKey: 'stable',
    },
    { beforeMutation, credentialContext },
  );
  expect(deps.materialization.convertWorkspace).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ beforeMutation, credentialContext }),
  );
});

it('resumes repository conflicts after reinspection and own duplicates from the catalog', async () => {
  const { creator, deps } = fixture();
  jest
    .mocked(deps.cloud.create)
    .mockResolvedValueOnce({ ok: false, code: 'repository-project-exists' });
  jest.mocked(deps.inspect).mockResolvedValueOnce({
    kind: 'code',
    target: 'new',
    repository,
  });
  jest.mocked(deps.inspect).mockResolvedValueOnce({
    kind: 'code',
    target: { projectId, projectName: 'Payments' },
    repository,
  });

  await expect(
    creator.create({ organizationId, name: 'Payments', folderPath: '/repo' }),
  ).resolves.toMatchObject({ ok: true, organizationProjectId: projectId });

  const ownDuplicate = fixture();
  jest
    .mocked(ownDuplicate.deps.cloud.create)
    .mockResolvedValue({ ok: false, code: 'member-project-exists' });
  await expect(
    ownDuplicate.creator.create({
      organizationId,
      name: 'Payments',
      folderPath: '/repo',
    }),
  ).resolves.toMatchObject({ ok: true, organizationProjectId: projectId });
});

it('resumes an explicit project id without another cloud create', async () => {
  const { creator, deps } = fixture();

  await expect(
    creator.create({
      organizationId,
      organizationProjectId: projectId,
      name: 'Payments',
      folderPath: '/repo',
    }),
  ).resolves.toMatchObject({ ok: true, organizationProjectId: projectId });
  expect(deps.catalog.refresh).toHaveBeenCalledWith(organizationId);
  expect(deps.cloud.create).not.toHaveBeenCalled();
});

it('does not create again when an explicit retry project is missing', async () => {
  const { creator, deps } = fixture();
  jest
    .mocked(deps.catalog.refresh)
    .mockResolvedValue({ ...snapshot, projects: [] });

  await expect(
    creator.create({
      organizationId,
      organizationProjectId: projectId,
      name: 'Payments',
      folderPath: '/repo',
    }),
  ).resolves.toEqual({
    ok: false,
    code: 'setup-failed',
    organizationProjectId: projectId,
  });
  expect(deps.cloud.create).not.toHaveBeenCalled();
  expect(deps.materialization.adoptCheckout).not.toHaveBeenCalled();
});

it('maps the shared cap and refuses unusable folders before cloud creation', async () => {
  const limited = fixture();
  jest
    .mocked(limited.deps.cloud.create)
    .mockResolvedValue({ ok: false, code: 'limit-reached' });
  await expect(
    limited.creator.create({
      organizationId,
      name: 'Payments',
      folderPath: '/repo',
    }),
  ).resolves.toEqual({ ok: false, code: 'limit-reached' });
  expect(limited.deps.materialization.adoptCheckout).not.toHaveBeenCalled();

  const refused = fixture();
  jest.mocked(refused.deps.inspect).mockResolvedValue({
    kind: 'refused',
    reason: 'linked-worktree',
  });
  await expect(
    refused.creator.create({
      organizationId,
      name: 'Payments',
      folderPath: '/repo',
    }),
  ).resolves.toEqual({
    ok: false,
    code: 'refused',
    reason: 'linked-worktree',
  });
  expect(refused.deps.cloud.create).not.toHaveBeenCalled();
});

it('does not leak a hidden project after a repository conflict', async () => {
  const { creator, deps } = fixture();
  jest
    .mocked(deps.cloud.create)
    .mockResolvedValue({ ok: false, code: 'repository-project-exists' });

  await expect(
    creator.create({ organizationId, name: 'Payments', folderPath: '/repo' }),
  ).resolves.toEqual({ ok: false, code: 'refused', reason: 'no-access' });
  expect(deps.materialization.adoptCheckout).not.toHaveBeenCalled();
});

it('removes only a newly initialized repo when setup fails before completion', async () => {
  const before = fixture();
  jest
    .mocked(before.deps.materialization.adoptCheckout)
    .mockRejectedValue(new Error('claim failed'));
  await before.creator.create({ organizationId, name: 'Payments' });
  expect(before.deps.inspect).toHaveBeenCalledWith(
    organizationId,
    '/repos/payments',
    { allowInsideDataDir: true },
  );
  expect(before.deps.repo.remove).toHaveBeenCalledWith('/repos/payments');
  expect(before.deps.materialization.adoptCheckout).toHaveBeenCalledWith(
    expect.anything(),
    { createdRepo: true },
  );

  const after = fixture();
  jest
    .mocked(after.deps.materialization.adoptCheckout)
    .mockRejectedValue(
      Object.assign(new Error('index failed'), { completionSent: true }),
    );
  await after.creator.create({ organizationId, name: 'Payments' });
  expect(after.deps.repo.remove).not.toHaveBeenCalled();
});

it('removes a newly initialized repo when creation returns before setup', async () => {
  const limited = fixture();
  jest
    .mocked(limited.deps.cloud.create)
    .mockResolvedValue({ ok: false, code: 'limit-reached' });

  await expect(
    limited.creator.create({ organizationId, name: 'Payments' }),
  ).resolves.toEqual({ ok: false, code: 'limit-reached' });
  expect(limited.deps.repo.remove).toHaveBeenCalledWith('/repos/payments');

  const refused = fixture();
  jest.mocked(refused.deps.inspect).mockResolvedValue({
    kind: 'refused',
    reason: 'unreadable',
  });

  await expect(
    refused.creator.create({ organizationId, name: 'Payments' }),
  ).resolves.toEqual({
    ok: false,
    code: 'refused',
    reason: 'unreadable',
  });
  expect(refused.deps.repo.remove).toHaveBeenCalledWith('/repos/payments');
});

it('fails closed before any local or cloud mutation', async () => {
  const { creator, deps } = fixture();
  jest.mocked(deps.eligible).mockResolvedValue(false);

  await expect(
    creator.create({ organizationId, name: 'Payments' }),
  ).resolves.toEqual({ ok: false, code: 'unavailable' });
  expect(deps.repo.init).not.toHaveBeenCalled();
  expect(deps.cloud.create).not.toHaveBeenCalled();
});
