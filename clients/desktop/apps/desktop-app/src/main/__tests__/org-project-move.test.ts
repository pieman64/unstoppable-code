/* eslint-disable @typescript-eslint/unbound-method */
import type {
  CreateOrgMemberCodeProjectResult,
  CreateOrgMemberMultiRepoProjectResult,
  OrgProjectConversionErrorCode,
  OrgProjectConversionResult,
  SidebarItem,
  WorkspaceOwnerBinding,
} from '@canopy/desktop-shared/types';
import {
  DEFAULT_COWORK_WORKSPACE_ID,
  orgDefaultCoworkWorkspaceId,
} from '@canopy/protocol/ui-labels';
import {
  createOrgProjectMover,
  moveCodeForConversion,
  type OrgProjectMoverDeps,
} from '../lib/org-project-move';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const projectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const owner: WorkspaceOwnerBinding = {
  type: 'organization',
  organizationId,
  projectId,
  instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  bindingGeneration: 1,
};

const single: SidebarItem = {
  type: 'single-repo',
  id: 'payments',
  name: 'Payments',
  repoPath: '/repos/payments',
  color: '',
  collapsed: false,
  order: 0,
  worktrees: [],
};
const multi: SidebarItem = {
  type: 'multi-repo',
  id: 'platform',
  name: 'Platform',
  sourceRepoPath: '/repos/platform',
  repos: [],
  color: '',
  collapsed: false,
  order: 1,
  worktrees: [],
};
const cowork: SidebarItem = {
  type: 'cowork',
  id: 'research',
  name: 'Research',
  color: '',
  collapsed: false,
  order: 2,
};

const convertedCowork: OrgProjectConversionResult = {
  ok: true,
  workspaceId: 'research',
  owner,
  ownershipTransfer: {
    version: 1,
    previousOwner: { type: 'personal' },
    organizationId,
    projectId,
    convertedAt: '2026-10-11T00:00:00.000Z',
  },
};

function fixture(items: SidebarItem[] = [single, multi, cowork]): {
  mover: ReturnType<typeof createOrgProjectMover>;
  deps: OrgProjectMoverDeps;
} {
  const deps: OrgProjectMoverDeps = {
    readItems: jest.fn(() => Promise.resolve(items)),
    eligible: jest.fn(() => Promise.resolve(true)),
    code: {
      create: jest.fn(
        (): Promise<CreateOrgMemberCodeProjectResult> =>
          Promise.resolve({
            ok: true,
            organizationProjectId: projectId,
            localWorkspaceId: 'payments',
          }),
      ),
    },
    multiRepo: {
      create: jest.fn(
        (): Promise<CreateOrgMemberMultiRepoProjectResult> =>
          Promise.resolve({
            ok: true,
            organizationProjectId: projectId,
            localWorkspaceId: 'platform',
          }),
      ),
    },
    materialization: {
      convertCoworkWorkspace: jest.fn(() => Promise.resolve(convertedCowork)),
    },
  };
  return { mover: createOrgProjectMover(deps), deps };
}

describe('dispatch by project type', (): void => {
  it('moves a single-repo project through the member Code create with its checkout', async () => {
    const { mover, deps } = fixture();

    await expect(
      mover.move({ workspaceId: 'payments', organizationId }),
    ).resolves.toEqual({
      ok: true,
      workspaceId: 'payments',
      organizationId,
      projectId,
    });
    expect(deps.eligible).toHaveBeenCalledWith(organizationId, 'code');
    expect(deps.code.create).toHaveBeenCalledWith(
      { organizationId, name: 'Payments', folderPath: '/repos/payments' },
      { scope: 'membership' },
    );
    expect(deps.multiRepo.create).not.toHaveBeenCalled();
    expect(deps.materialization.convertCoworkWorkspace).not.toHaveBeenCalled();
  });

  it('moves a multi-repo project through the member multi-repo create by its id', async () => {
    const { mover, deps } = fixture();

    await expect(
      mover.move({ workspaceId: 'platform', organizationId }),
    ).resolves.toEqual({
      ok: true,
      workspaceId: 'platform',
      organizationId,
      projectId,
    });
    expect(deps.eligible).toHaveBeenCalledWith(organizationId, 'code');
    expect(deps.multiRepo.create).toHaveBeenCalledWith(
      { organizationId, name: 'Platform', localWorkspaceId: 'platform' },
      { scope: 'membership' },
    );
  });

  it('moves a Cowork project through the Cowork conversion', async () => {
    const { mover, deps } = fixture();

    await expect(
      mover.move({ workspaceId: 'research', organizationId }),
    ).resolves.toEqual({
      ok: true,
      workspaceId: 'research',
      organizationId,
      projectId,
    });
    expect(deps.eligible).toHaveBeenCalledWith(organizationId, 'cowork');
    expect(deps.materialization.convertCoworkWorkspace).toHaveBeenCalledWith({
      workspaceId: 'research',
      organizationId,
    });
  });
});

describe('refusals before any create', (): void => {
  it('refuses a missing, owned, or default Chats workspace', async () => {
    const { mover, deps } = fixture([
      { ...single, owner },
      { ...cowork, id: DEFAULT_COWORK_WORKSPACE_ID },
      { ...cowork, id: orgDefaultCoworkWorkspaceId(organizationId) },
    ]);

    await expect(
      mover.move({ workspaceId: 'missing', organizationId }),
    ).resolves.toEqual({ ok: false, code: 'workspace-not-found' });
    await expect(
      mover.move({ workspaceId: 'payments', organizationId }),
    ).resolves.toEqual({ ok: false, code: 'not-personal' });
    for (const workspaceId of [
      DEFAULT_COWORK_WORKSPACE_ID,
      orgDefaultCoworkWorkspaceId(organizationId),
    ])
      await expect(
        mover.move({ workspaceId, organizationId }),
      ).resolves.toEqual({ ok: false, code: 'unsupported-workspace' });
    expect(deps.eligible).not.toHaveBeenCalled();
  });

  it('refuses an unknown project type', async () => {
    const unknown: unknown = { ...cowork, type: 'future-kind' };
    const { mover, deps } = fixture([
      // A kind a newer index may hold that this build cannot move.
      unknown as SidebarItem,
    ]);

    await expect(
      mover.move({ workspaceId: 'research', organizationId }),
    ).resolves.toEqual({ ok: false, code: 'unsupported-workspace' });
    expect(deps.eligible).not.toHaveBeenCalled();
  });

  it('answers unavailable when the organization is not eligible, and move-failed when eligibility throws', async () => {
    const { mover, deps } = fixture();
    jest.mocked(deps.eligible).mockResolvedValueOnce(false);
    await expect(
      mover.move({ workspaceId: 'payments', organizationId }),
    ).resolves.toEqual({ ok: false, code: 'unavailable' });
    jest
      .mocked(deps.eligible)
      .mockRejectedValueOnce(new Error('account store unavailable'));
    await expect(
      mover.move({ workspaceId: 'research', organizationId }),
    ).resolves.toEqual({ ok: false, code: 'move-failed' });
    expect(deps.code.create).not.toHaveBeenCalled();
    expect(deps.materialization.convertCoworkWorkspace).not.toHaveBeenCalled();
  });

  it('answers move-failed when the index cannot be read', async () => {
    const { mover, deps } = fixture();
    jest.mocked(deps.readItems).mockRejectedValueOnce(new Error('EIO'));
    await expect(
      mover.move({ workspaceId: 'payments', organizationId }),
    ).resolves.toEqual({ ok: false, code: 'move-failed' });
  });
});

describe('error mapping', (): void => {
  it.each<[OrgProjectConversionErrorCode, string]>([
    ['disabled', 'unavailable'],
    ['member-project-limit', 'limit-reached'],
    ['repository-mismatch', 'repository-outside-organization'],
    ['unsupported-workspace', 'unsupported-workspace'],
    ['conversion-failed', 'move-failed'],
    ['previously-converted', 'move-failed'],
    ['workspace-not-found', 'workspace-not-found'],
    ['workspace-unreadable', 'workspace-unreadable'],
    ['not-personal', 'not-personal'],
    ['project-unavailable', 'project-unavailable'],
    ['project-already-bound', 'project-already-bound'],
    ['repository-unavailable', 'repository-unavailable'],
    ['busy', 'busy'],
    ['offline', 'offline'],
  ])('maps conversion %s to %s', async (code, expected) => {
    expect(moveCodeForConversion(code)).toBe(expected);
    const { mover, deps } = fixture();
    jest
      .mocked(deps.materialization.convertCoworkWorkspace)
      .mockResolvedValueOnce({ ok: false, code });
    await expect(
      mover.move({ workspaceId: 'research', organizationId }),
    ).resolves.toEqual({ ok: false, code: expected });
  });

  it('falls back to move-failed for an unrecognized conversion code', async () => {
    const unknown: unknown = 'something-new';
    const { mover, deps } = fixture();
    jest
      .mocked(deps.materialization.convertCoworkWorkspace)
      .mockResolvedValueOnce({
        ok: false,
        code: unknown as OrgProjectConversionErrorCode,
      });
    await expect(
      mover.move({ workspaceId: 'research', organizationId }),
    ).resolves.toEqual({ ok: false, code: 'move-failed' });
  });

  it('carries the created Cowork project on a failed conversion', async () => {
    const { mover, deps } = fixture();
    jest
      .mocked(deps.materialization.convertCoworkWorkspace)
      .mockResolvedValueOnce({
        ok: false,
        code: 'offline',
        organizationProjectId: projectId,
      });
    await expect(
      mover.move({ workspaceId: 'research', organizationId }),
    ).resolves.toEqual({
      ok: false,
      code: 'offline',
      organizationProjectId: projectId,
    });
  });

  it.each<[CreateOrgMemberCodeProjectResult, unknown]>([
    [
      { ok: false, code: 'unavailable' },
      { ok: false, code: 'unavailable' },
    ],
    [
      { ok: false, code: 'limit-reached', organizationProjectId: projectId },
      { ok: false, code: 'limit-reached', organizationProjectId: projectId },
    ],
    [
      { ok: false, code: 'refused', reason: 'outside-organization' },
      { ok: false, code: 'repository-outside-organization' },
    ],
    [
      { ok: false, code: 'refused', reason: 'no-access' },
      { ok: false, code: 'repository-outside-organization' },
    ],
    [
      { ok: false, code: 'refused', reason: 'ambiguous' },
      { ok: false, code: 'repository-outside-organization' },
    ],
    [
      { ok: false, code: 'refused', reason: 'linked-worktree' },
      { ok: false, code: 'unsupported-workspace' },
    ],
    [
      { ok: false, code: 'refused', reason: 'unreadable' },
      { ok: false, code: 'move-failed' },
    ],
    [
      {
        ok: false,
        code: 'setup-failed',
        organizationProjectId: projectId,
        conversionCode: 'repository-mismatch',
      },
      {
        ok: false,
        code: 'repository-outside-organization',
        organizationProjectId: projectId,
      },
    ],
    [
      {
        ok: false,
        code: 'setup-failed',
        organizationProjectId: projectId,
        conversionCode: 'busy',
      },
      { ok: false, code: 'busy', organizationProjectId: projectId },
    ],
    [
      { ok: false, code: 'setup-failed', organizationProjectId: projectId },
      { ok: false, code: 'move-failed', organizationProjectId: projectId },
    ],
    [
      { ok: false, code: 'create-failed' },
      { ok: false, code: 'move-failed' },
    ],
  ])('maps a single-repo create result %j', async (result, expected) => {
    const { mover, deps } = fixture();
    jest.mocked(deps.code.create).mockResolvedValueOnce(result);
    await expect(
      mover.move({ workspaceId: 'payments', organizationId }),
    ).resolves.toEqual(expected);
  });

  it.each<[CreateOrgMemberMultiRepoProjectResult, unknown]>([
    [
      { ok: false, code: 'limit-reached' },
      { ok: false, code: 'limit-reached' },
    ],
    [
      {
        ok: false,
        code: 'refused',
        reason: 'outside-organization',
        repositories: ['acme/web'],
      },
      { ok: false, code: 'repository-outside-organization' },
    ],
    [
      {
        ok: false,
        code: 'setup-failed',
        localWorkspaceId: 'platform',
        conversionCode: 'offline',
      },
      { ok: false, code: 'offline' },
    ],
    [
      { ok: false, code: 'setup-failed', localWorkspaceId: 'platform' },
      { ok: false, code: 'move-failed' },
    ],
  ])('maps a multi-repo create result %j', async (result, expected) => {
    const { mover, deps } = fixture();
    jest.mocked(deps.multiRepo.create).mockResolvedValueOnce(result);
    await expect(
      mover.move({ workspaceId: 'platform', organizationId }),
    ).resolves.toEqual(expected);
  });

  it('answers move-failed when a create throws', async () => {
    const { mover, deps } = fixture();
    jest.mocked(deps.code.create).mockRejectedValueOnce(new Error('boom'));
    await expect(
      mover.move({ workspaceId: 'payments', organizationId }),
    ).resolves.toEqual({ ok: false, code: 'move-failed' });
  });
});

describe('concurrent moves', (): void => {
  it('refuses a second move of the same project as busy before creating anything', async () => {
    const { mover, deps } = fixture();
    let finish: (result: CreateOrgMemberCodeProjectResult) => void = () => {};
    jest.mocked(deps.code.create).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );

    const first = mover.move({ workspaceId: 'payments', organizationId });
    await expect(
      mover.move({ workspaceId: 'payments', organizationId }),
    ).resolves.toEqual({ ok: false, code: 'busy' });
    expect(deps.code.create).toHaveBeenCalledTimes(1);

    finish({
      ok: true,
      organizationProjectId: projectId,
      localWorkspaceId: 'payments',
    });
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(
      mover.move({ workspaceId: 'payments', organizationId }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('lets a different project move while one is running', async () => {
    const { mover, deps } = fixture();
    jest
      .mocked(deps.code.create)
      .mockImplementationOnce(() => new Promise(() => {}));

    void mover.move({ workspaceId: 'payments', organizationId });
    await expect(
      mover.move({ workspaceId: 'platform', organizationId }),
    ).resolves.toMatchObject({ ok: true });
  });
});
