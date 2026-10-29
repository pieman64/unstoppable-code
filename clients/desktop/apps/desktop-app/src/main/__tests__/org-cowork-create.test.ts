/* eslint-disable @typescript-eslint/unbound-method */
import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import type { DesktopOrgProjectCatalogSnapshot } from '@canopy/desktop-shared/types';
import {
  createOrgCoworkCreator,
  type OrgCoworkCreatorDeps,
} from '../lib/org-cowork-create';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const projectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const owner = {
  type: 'organization' as const,
  organizationId,
  projectId,
  instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  bindingGeneration: 1,
};
const project: OrgProjectSummary = {
  id: projectId,
  organizationId,
  name: 'Notes',
  description: null,
  kind: 'COWORK',
  purpose: 'project',
  visibility: 'private',
  memberOwned: true,
  location: 'LOCAL',
  repository: null,
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
  fetchedAt: '2026-09-29T00:00:00.000Z',
  stale: false,
  error: null,
};

function fixture(): {
  creator: ReturnType<typeof createOrgCoworkCreator>;
  deps: OrgCoworkCreatorDeps;
} {
  const deps: OrgCoworkCreatorDeps = {
    eligible: jest.fn(() => Promise.resolve(true)),
    cloud: {
      create: jest.fn(() => Promise.resolve({ ok: true, project })),
    },
    catalog: {
      refresh: jest.fn(() => Promise.resolve(snapshot)),
    },
    binding: {
      bindOrgCoworkWorkspace: jest.fn(async (input) => {
        await input.createLocal(owner);
        await input.publishLocal(owner);
        return { instanceId: owner.instanceId, owner };
      }),
      ensureOrgDefaultCoworkWorkspace: jest.fn(),
    },
    folder: {
      preflight: jest.fn((path) =>
        Promise.resolve({ path, attachedGitRepository: true }),
      ),
    },
    blueprint: {
      resolve: jest.fn(() => Promise.reject(new Error('not configured'))),
    },
    local: {
      stage: jest.fn(() => Promise.resolve()),
      publish: jest.fn(() => Promise.resolve()),
      discard: jest.fn(() => Promise.resolve()),
    },
    telemetry: jest.fn(),
  };
  return { creator: createOrgCoworkCreator(deps), deps };
}

it('preflights before cloud creation and binds the deterministic id', async () => {
  const { creator, deps } = fixture();

  await expect(
    creator.create({ organizationId, name: ' Notes ', folderPath: '/repo' }),
  ).resolves.toEqual({
    ok: true,
    organizationProjectId: projectId,
    localWorkspaceId: `cowork-project-${projectId}`,
    attachedGitRepository: true,
  });

  expect(
    jest.mocked(deps.folder.preflight).mock.invocationCallOrder[0],
  ).toBeLessThan(
    jest.mocked(deps.cloud.create).mock.invocationCallOrder[0] ?? 0,
  );
  expect(deps.cloud.create).toHaveBeenCalledWith({
    organizationId,
    kind: 'COWORK',
    name: 'Notes',
  });
  expect(deps.binding.bindOrgCoworkWorkspace).toHaveBeenCalledWith(
    expect.objectContaining({
      localWorkspaceId: `cowork-project-${projectId}`,
      rotateClaimKeyOnConflict: true,
    }),
  );
});

it('sends a new organization Cowork project memory choice to the server', async () => {
  const { creator, deps } = fixture();
  jest.mocked(deps.cloud.create).mockResolvedValue({
    ok: true,
    project: { ...project, privateMemory: true },
  });
  await creator.create({ organizationId, name: 'Notes', privateMemory: true });
  expect(deps.cloud.create).toHaveBeenCalledWith(
    expect.objectContaining({ privateMemory: true }),
  );
});

it('keeps a private-selected Cowork project closed if the server omits its value', async () => {
  const { creator, deps } = fixture();
  await expect(
    creator.create({ organizationId, name: 'Notes', privateMemory: true }),
  ).resolves.toMatchObject({ ok: false, code: 'setup-failed' });
  expect(deps.binding.bindOrgCoworkWorkspace).not.toHaveBeenCalled();
});

it('returns cloud failures without creating anything locally', async () => {
  const { creator, deps } = fixture();
  jest.mocked(deps.cloud.create).mockRejectedValue(new Error('offline'));

  await expect(
    creator.create({ organizationId, name: 'Notes' }),
  ).resolves.toMatchObject({ ok: false, code: 'create-failed' });
  expect(deps.binding.bindOrgCoworkWorkspace).not.toHaveBeenCalled();
  expect(deps.local.stage).not.toHaveBeenCalled();
});

it('maps the member cap without binding locally', async () => {
  const { creator, deps } = fixture();
  jest
    .mocked(deps.cloud.create)
    .mockResolvedValue({ ok: false, code: 'limit-reached' });

  await expect(
    creator.create({ organizationId, name: 'Notes' }),
  ).resolves.toMatchObject({ ok: false, code: 'limit-reached' });
  expect(deps.local.stage).not.toHaveBeenCalled();
});

it('checks eligibility before validating the project name', async () => {
  const { creator, deps } = fixture();
  jest.mocked(deps.eligible).mockResolvedValue(false);

  await expect(
    creator.create({ organizationId, name: '   ' }),
  ).resolves.toEqual({
    ok: false,
    code: 'unavailable',
    attachedGitRepository: false,
  });
  expect(deps.cloud.create).not.toHaveBeenCalled();
});

it('discards a staged workspace when binding fails before completion', async () => {
  const { creator, deps } = fixture();
  jest
    .mocked(deps.binding.bindOrgCoworkWorkspace)
    .mockImplementation(async (input) => {
      await input.createLocal(owner);
      throw new Error('complete failed');
    });

  await expect(
    creator.create({ organizationId, name: 'Notes' }),
  ).resolves.toMatchObject({
    ok: false,
    code: 'setup-failed',
    organizationProjectId: projectId,
  });
  expect(deps.local.discard).toHaveBeenCalledWith(
    `cowork-project-${projectId}`,
    projectId,
  );
});

it('keeps the staged workspace when publishing fails after completion', async () => {
  const { creator, deps } = fixture();
  jest.mocked(deps.local.publish).mockRejectedValue(new Error('index offline'));

  await expect(
    creator.create({ organizationId, name: 'Notes' }),
  ).resolves.toMatchObject({ ok: false, code: 'setup-failed' });
  expect(deps.local.discard).not.toHaveBeenCalled();
});

it('resumes only a forced-catalog Cowork project with use access', async () => {
  const { creator, deps } = fixture();

  await creator.create({
    organizationId,
    organizationProjectId: projectId,
    name: 'Notes',
  });

  expect(deps.catalog.refresh).toHaveBeenCalledWith(organizationId);
  expect(deps.cloud.create).not.toHaveBeenCalled();
  expect(deps.binding.bindOrgCoworkWorkspace).toHaveBeenCalled();
});

it('keeps an existing project in setup-failed when retry preflight fails', async () => {
  const { creator, deps } = fixture();
  jest
    .mocked(deps.folder.preflight)
    .mockRejectedValue(new Error('folder unavailable'));

  await expect(
    creator.create({
      organizationId,
      organizationProjectId: projectId,
      name: 'Notes',
      folderPath: '/repo',
    }),
  ).resolves.toEqual({
    ok: false,
    code: 'setup-failed',
    organizationProjectId: projectId,
    attachedGitRepository: false,
  });
  expect(deps.cloud.create).not.toHaveBeenCalled();
  expect(deps.binding.bindOrgCoworkWorkspace).not.toHaveBeenCalled();
});

it('excludes its deterministic workspace when resuming an attached folder', async () => {
  const { creator, deps } = fixture();
  const localWorkspaceId = `cowork-project-${projectId}`;
  jest
    .mocked(deps.folder.preflight)
    .mockImplementation((path, excludeWorkspaceId) => {
      if (excludeWorkspaceId !== localWorkspaceId) {
        return Promise.reject(new Error('folder is already imported'));
      }
      return Promise.resolve({ path, attachedGitRepository: true });
    });

  await expect(
    creator.create({
      organizationId,
      organizationProjectId: projectId,
      name: 'Notes',
      folderPath: '/repo',
    }),
  ).resolves.toEqual({
    ok: true,
    organizationProjectId: projectId,
    localWorkspaceId,
    attachedGitRepository: true,
  });
  expect(deps.folder.preflight).toHaveBeenCalledWith('/repo', localWorkspaceId);
  expect(deps.cloud.create).not.toHaveBeenCalled();
});

it('sets up a catalog project without creating another definition', async () => {
  const { creator, deps } = fixture();

  await expect(
    creator.setUp({ organizationId, projectId, name: 'Notes' }),
  ).resolves.toEqual({ instanceId: owner.instanceId, owner });
  expect(deps.cloud.create).not.toHaveBeenCalled();
});
