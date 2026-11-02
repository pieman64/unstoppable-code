jest.mock('../shared-containers/read/reader', () => ({
  getSharedContainerReader: jest.fn(),
}));
jest.mock('../shared-containers/fork/fork-guard', () => ({
  withSharedContainerForkGuard: jest.fn(
    (
      _request: unknown,
      operation: (
        revisionRoot: string,
        revision: { revisionId: string; revisionCreatedAt: string },
      ) => unknown,
    ) =>
      operation('/replicas/container/revisions/revision', {
        revisionId: 'revision',
        revisionCreatedAt: '2026-09-02T10:30:00.000Z',
      }),
  ),
}));
jest.mock('../shared-containers/fork/code', () => ({
  forkSharedCodeContainer: jest.fn(),
}));
jest.mock('../shared-containers/fork/cowork', () => ({
  forkSharedCoworkContainer: jest.fn(),
}));
jest.mock('../shared-containers/acceptance-store', () => ({
  getSharedContainerAcceptance: jest.fn(),
}));
jest.mock('../shared-containers/canopy-server-client', () => ({
  fetchLatestSharedContainerRevision: jest.fn(),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceOwnership: jest.fn(),
}));

const callOrder: string[] = [];
jest.mock('../shared-containers/capability-package/install', () => ({
  installForkCapabilityPackage: jest.fn(() => {
    callOrder.push('install');
    return Promise.resolve([]);
  }),
}));

import { getSharedContainerReader } from '../shared-containers/read/reader';
import { forkSharedCoworkContainer } from '../shared-containers/fork/cowork';
import { forkSharedCodeContainer } from '../shared-containers/fork/code';
import { withSharedContainerForkGuard } from '../shared-containers/fork/fork-guard';
import { getSharedContainerAcceptance } from '../shared-containers/acceptance-store';
import { fetchLatestSharedContainerRevision } from '../shared-containers/canopy-server-client';
import { readWorkspaceOwnership } from '../lib/workspace-persistence';
import { installForkCapabilityPackage } from '../shared-containers/capability-package/install';
import { forkSharedContainer } from '../shared-containers/fork';
import { assertForkWorkspaceOwner } from '../shared-containers/fork/destination';
import { getOrgProjectCatalogService } from '../services/org-project-catalog-service';

jest.mock('../services/org-project-catalog-service', () => ({
  getOrgProjectCatalogService: jest.fn(),
}));
import type { SharedContainerForkRequest } from '@canopy/protocol/shared-containers';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const owner = { kind: 'personal' } as const;
const orgOwner = { kind: 'organization', organizationId: ORG } as const;
const binding = {
  type: 'organization' as const,
  organizationId: ORG,
  projectId: '33333333-3333-4333-8333-333333333333',
  instanceId: '44444444-4444-4444-8444-444444444444',
  bindingGeneration: 1,
};
const request: SharedContainerForkRequest = {
  containerId: 'container',
  revisionId: 'revision',
  sourceOwnerDisplayName: 'Ada',
  destination: { kind: 'new-workspace', owner },
};
const layout = {
  schemaVersion: 3 as const,
  containerType: 'COWORK_WORK_ENTRY' as const,
  title: 'Published Cowork work',
  repositories: [],
  files: [],
  notes: [],
  prompts: [],
  attachmentPaths: {},
  layout: {
    orientation: 0 as const,
    root: {
      type: 'leaf' as const,
      size: 1,
      tabs: [{ kind: 'chat' as const, chatId: 'published-chat' }],
      activeTabIndex: 0,
    },
  },
};
const response = {
  containerType: 'COWORK_WORK_ENTRY' as const,
  projectId: 'workspace',
  worktreeId: 'entry',
  warnings: [],
  provenance: {
    sourceContainerId: 'container',
    sourceRevisionId: 'revision',
    sourceOwnerDisplayName: 'Ada',
    forkedAt: '2026-10-23T00:00:00.000Z',
  },
};
function accept(
  access: 'direct' | 'organization',
  organizationId?: string,
): void {
  jest.mocked(getSharedContainerAcceptance).mockResolvedValue({
    access,
    organizationId,
    acceptedAt: '2026-10-23T00:00:00.000Z',
  });
  jest.mocked(fetchLatestSharedContainerRevision).mockResolvedValue({
    id: 'container',
    access,
    organizationId,
    ...(organizationId ? { organizationName: 'Acme' } : {}),
    owner: { id: 'publisher', name: 'Ada' },
  } as never);
}

beforeEach(() => {
  jest.clearAllMocks();
  callOrder.length = 0;
  accept('direct');
  jest
    .mocked(readWorkspaceOwnership)
    .mockResolvedValue({ authority: 'ok', type: 'cowork' });
  jest.mocked(forkSharedCoworkContainer).mockResolvedValue(response);
  jest.mocked(getSharedContainerReader).mockReturnValue({
    store: {},
    readForkLayout: jest.fn(() =>
      Promise.resolve({
        root: '/replicas/container/revisions/revision',
        layout,
      }),
    ),
  } as never);
});

describe('shared-container fork routing', () => {
  // CAN-4655: the package installs after the fork commits, outside its
  // composition, and can only add warnings.
  it('installs the disclosed package after the fork and only appends warnings', async () => {
    const forked = {
      containerType: 'COWORK_WORK_ENTRY' as const,
      projectId: 'workspace',
      worktreeId: 'entry',
      warnings: ['Chat id duplicated.'],
      provenance: {
        sourceContainerId: 'container',
        sourceRevisionId: 'revision',
        sourceOwnerDisplayName: 'Ada',
        forkedAt: '2026-10-22T00:00:00.000Z',
      },
    };
    jest.mocked(forkSharedCoworkContainer).mockImplementationOnce(() => {
      callOrder.push('fork');
      return Promise.resolve(forked);
    });
    jest.mocked(installForkCapabilityPackage).mockImplementationOnce(() => {
      callOrder.push('install');
      return Promise.resolve(['Package warning.']);
    });
    const request = {
      containerId: 'container',
      revisionId: 'revision',
      sourceOwnerDisplayName: 'Ada',
      destination: { kind: 'new-workspace' as const, owner },
      expectedPackageDigest: `pp:v1:${'A'.repeat(43)}`,
    };

    await expect(forkSharedContainer(request)).resolves.toEqual({
      ...forked,
      warnings: ['Chat id duplicated.', 'Package warning.'],
    });
    expect(callOrder).toEqual(['fork', 'install']);
    expect(installForkCapabilityPackage).toHaveBeenCalledWith({
      request,
      response: forked,
    });
  });

  it('never installs when the fork itself fails', async () => {
    jest
      .mocked(forkSharedCoworkContainer)
      .mockRejectedValueOnce(new Error('Destination unavailable'));
    await expect(
      forkSharedContainer({
        containerId: 'container',
        revisionId: 'revision',
        sourceOwnerDisplayName: 'Ada',
        destination: { kind: 'new-workspace', owner },
        expectedPackageDigest: `pp:v1:${'A'.repeat(43)}`,
      }),
    ).rejects.toThrow('Destination unavailable');
    expect(installForkCapabilityPackage).not.toHaveBeenCalled();
  });

  it('routes a schema-v3 direct Cowork revision through the Personal copy path', async () => {
    await expect(forkSharedContainer(request)).resolves.toEqual(response);
    expect(forkSharedCoworkContainer).toHaveBeenCalledWith(
      expect.objectContaining({ layout }),
    );
  });

  it('rejects a Personal downgrade of an organization share at the fork boundary', async () => {
    accept('organization', ORG);
    await expect(
      forkSharedContainer({ ...request, organizationId: ORG }),
    ).rejects.toThrow();
    expect(forkSharedCoworkContainer).not.toHaveBeenCalled();
  });

  it('rejects forged organization metadata even when the two request owners agree', async () => {
    accept('organization', ORG);
    await expect(
      forkSharedContainer({
        ...request,
        organizationId: OTHER_ORG,
        destination: {
          kind: 'new-workspace',
          owner: { kind: 'organization', organizationId: OTHER_ORG },
        },
      }),
    ).rejects.toThrow();
    expect(forkSharedCoworkContainer).not.toHaveBeenCalled();
  });

  it('keeps a directly shared organization container in Personal', async () => {
    accept('direct', ORG);
    await expect(
      forkSharedContainer({ ...request, organizationId: ORG }),
    ).resolves.toEqual(response);
    await expect(
      forkSharedContainer({
        ...request,
        organizationId: ORG,
        destination: { kind: 'new-workspace', owner: orgOwner },
      }),
    ).rejects.toThrow();
  });

  it('routes a new organization copy to the engine with the share owner and organization name', async () => {
    accept('organization', ORG);
    await expect(
      forkSharedContainer({
        ...request,
        organizationId: ORG,
        destination: { kind: 'new-workspace', owner: orgOwner },
      }),
    ).resolves.toEqual(response);
    const [forwarded] =
      jest.mocked(forkSharedCoworkContainer).mock.calls[0] ?? [];
    expect(forwarded?.owner).toEqual(orgOwner);
    expect(forwarded?.organizationName).toBe('Acme');
    expect(forwarded?.request.destination).toEqual({
      kind: 'new-workspace',
      owner: orgOwner,
    });
    expect(forkSharedCodeContainer).not.toHaveBeenCalled();
  });

  it('refuses unaccepted sources even when called outside IPC', async () => {
    jest.mocked(getSharedContainerAcceptance).mockResolvedValue(null);
    await expect(forkSharedContainer(request)).rejects.toThrow();
    expect(withSharedContainerForkGuard).not.toHaveBeenCalled();
  });

  it('rechecks server authorization and refuses revoked access before effects', async () => {
    jest
      .mocked(fetchLatestSharedContainerRevision)
      .mockRejectedValue(new Error('Access revoked'));
    await expect(forkSharedContainer(request)).rejects.toThrow();
    expect(forkSharedCoworkContainer).not.toHaveBeenCalled();
  });

  it('rejects a foreign existing workspace', async () => {
    jest
      .mocked(readWorkspaceOwnership)
      .mockResolvedValue({ authority: 'ok', type: 'cowork', owner: binding });
    await expect(
      forkSharedContainer({
        ...request,
        destination: { kind: 'existing-workspace', workspaceId: 'workspace' },
      }),
    ).rejects.toThrow();
    expect(forkSharedCoworkContainer).not.toHaveBeenCalled();
  });

  it('allows a completely bound existing organization workspace', async () => {
    accept('organization', ORG);
    jest
      .mocked(readWorkspaceOwnership)
      .mockResolvedValue({ authority: 'ok', type: 'cowork', owner: binding });
    await expect(
      forkSharedContainer({
        ...request,
        organizationId: ORG,
        destination: { kind: 'existing-workspace', workspaceId: 'workspace' },
      }),
    ).resolves.toEqual(response);
  });
});

it.each([
  { authority: 'absent' },
  { authority: 'unreadable' },
  { authority: 'ok', type: 'cowork', owner: { ...binding, instanceId: '' } },
])('rejects an unusable canonical owner %j', async (current) => {
  jest.mocked(readWorkspaceOwnership).mockResolvedValue(current as never);
  await expect(
    forkSharedContainer({
      ...request,
      destination: { kind: 'existing-workspace', workspaceId: 'workspace' },
    }),
  ).rejects.toThrow();
  expect(forkSharedCoworkContainer).not.toHaveBeenCalled();
});

it.each(['organization', 'personal'] as const)(
  'allows an existing %s destination with completed conversion history',
  async (context) => {
    const organization = context === 'organization';
    if (organization) accept('organization', ORG);
    jest.mocked(readWorkspaceOwnership).mockResolvedValue({
      authority: 'ok',
      type: 'cowork',
      ...(organization ? { owner: binding } : {}),
      ownershipTransfer: {
        version: 1,
        previousOwner: { type: 'personal' },
        organizationId: ORG,
        projectId: binding.projectId,
        convertedAt: '2026-10-22T00:00:00.000Z',
        ...(!organization ? { movedBackAt: '2026-10-23T00:00:00.000Z' } : {}),
      },
    });

    await expect(
      forkSharedContainer({
        ...request,
        ...(organization ? { organizationId: ORG } : {}),
        destination: { kind: 'existing-workspace', workspaceId: 'workspace' },
      }),
    ).resolves.toEqual(response);
  },
);

it('rechecks acceptance when the replica guard is acquired', async () => {
  jest
    .mocked(withSharedContainerForkGuard)
    .mockImplementationOnce((_request, operation) => {
      jest.mocked(getSharedContainerAcceptance).mockResolvedValue(null);
      return operation('/replicas/container/revisions/revision', {
        revisionId: 'revision',
        revisionCreatedAt: '2026-09-02T10:30:00.000Z',
      });
    });
  await expect(forkSharedContainer(request)).rejects.toMatchObject({
    code: 'source-unavailable',
  });
  expect(forkSharedCoworkContainer).not.toHaveBeenCalled();
});

it('rechecks authorization when the replica guard is acquired', async () => {
  const source = await jest.mocked(fetchLatestSharedContainerRevision)(
    'container',
    undefined,
  );
  jest
    .mocked(fetchLatestSharedContainerRevision)
    .mockResolvedValueOnce(source)
    .mockRejectedValueOnce(new Error('Access revoked'));
  await expect(forkSharedContainer(request)).rejects.toMatchObject({
    code: 'source-unavailable',
  });
  expect(forkSharedCoworkContainer).not.toHaveBeenCalled();
});

it('refuses access revoked while reading the fork layout before dispatching effects', async () => {
  const reader = getSharedContainerReader();
  const readLayout = reader.readForkLayout.bind(reader);
  jest.spyOn(reader, 'readForkLayout').mockImplementationOnce(async (input) => {
    const source = await readLayout(input);
    jest
      .mocked(fetchLatestSharedContainerRevision)
      .mockRejectedValue(new Error('Access revoked during layout read'));
    return source;
  });

  await expect(forkSharedContainer(request)).rejects.toMatchObject({
    code: 'source-unavailable',
  });
  expect(forkSharedCoworkContainer).not.toHaveBeenCalled();
  expect(forkSharedCodeContainer).not.toHaveBeenCalled();
});

it.each(['stale', 'denied', 'wrong-instance', 'ready'] as const)(
  'checks fresh destination project authorization: %s',
  async (state) => {
    jest.mocked(readWorkspaceOwnership).mockResolvedValue({
      authority: 'ok',
      type: 'cowork',
      owner: binding,
      ownershipTransfer: {
        version: 1,
        previousOwner: { type: 'personal' },
        organizationId: ORG,
        projectId: binding.projectId,
        convertedAt: '2026-10-22T00:00:00.000Z',
      },
    });
    const refresh = jest.fn(() =>
      Promise.resolve({
        stale: state === 'stale',
        error: null,
        projects: [
          {
            id: binding.projectId,
            organizationId: ORG,
            kind: 'COWORK',
            state: 'ACTIVE',
            location: 'LOCAL',
            capabilities: { use: state !== 'denied' },
            instance: {
              id: state === 'wrong-instance' ? 'foreign' : binding.instanceId,
              state: 'READY',
            },
          },
        ],
      }),
    );
    jest
      .mocked(getOrgProjectCatalogService)
      .mockReturnValue({ refresh } as never);
    const checked = assertForkWorkspaceOwner('workspace', orgOwner, true);
    if (state === 'ready') await expect(checked).resolves.toBeUndefined();
    else
      await expect(checked).rejects.toMatchObject({
        code: 'destination-unavailable',
      });
    expect(refresh).toHaveBeenCalledWith(orgOwner, { force: true });
  },
);

it('refuses a binding changed while destination authorization was in flight', async () => {
  jest
    .mocked(readWorkspaceOwnership)
    .mockResolvedValueOnce({ authority: 'ok', type: 'cowork', owner: binding })
    .mockResolvedValueOnce({
      authority: 'ok',
      type: 'cowork',
      owner: {
        ...binding,
        bindingGeneration: binding.bindingGeneration + 1,
      },
    });
  jest.mocked(getOrgProjectCatalogService).mockReturnValue({
    refresh: jest.fn(() =>
      Promise.resolve({
        stale: false,
        error: null,
        projects: [
          {
            id: binding.projectId,
            organizationId: ORG,
            kind: 'COWORK',
            state: 'ACTIVE',
            location: 'LOCAL',
            capabilities: { use: true },
            instance: { id: binding.instanceId, state: 'READY' },
          },
        ],
      }),
    ),
  } as never);
  await expect(
    assertForkWorkspaceOwner('workspace', orgOwner, true),
  ).rejects.toMatchObject({ code: 'destination-unavailable' });
});

it('preserves accepted direct ownership when the server also offers organization access', async () => {
  accept('direct', ORG);
  jest.mocked(fetchLatestSharedContainerRevision).mockResolvedValue({
    id: 'container',
    access: 'organization',
    organizationId: ORG,
    owner: { id: 'publisher', name: 'Ada' },
  } as never);
  await expect(
    forkSharedContainer({ ...request, organizationId: ORG }),
  ).resolves.toEqual(response);
});
