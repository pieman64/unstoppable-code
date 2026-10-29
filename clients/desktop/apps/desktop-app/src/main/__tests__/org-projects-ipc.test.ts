let mockRolloutEnabled = true;
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: (): object => ({
    isEnabled: (): boolean => mockRolloutEnabled,
  }),
}));
const mockLinksList = jest.fn();
const mockLinksDecide = jest.fn();
jest.mock('../services/org-project-relationship-service', () => ({
  listOrgProjectRelationships: mockLinksList,
  decideOrgProjectRelationship: mockLinksDecide,
}));
import type { OrgProjectSetupProgress } from '@canopy/protocol/org-projects';
const mockSetupStart = jest.fn();
const mockSetupCancel = jest.fn();
const mockSetupSubscribe = jest.fn<
  () => void,
  [(progress: OrgProjectSetupProgress) => void]
>();
const mockConvertWorkspace = jest.fn();
const mockMoveBackToPersonal = jest.fn();
const mockSetupFromFolder = jest.fn();
const mockOnOwnershipChanged = jest.fn<
  () => void,
  [(event: OrgProjectOwnershipChangedEvent) => void]
>();
jest.mock('../lib/org-project-materialization', () => ({
  getOrgProjectMaterialization: (): unknown => ({
    startSetup: mockSetupStart,
    cancelSetup: mockSetupCancel,
    subscribe: mockSetupSubscribe,
    convertWorkspace: mockConvertWorkspace,
    moveBackToPersonal: mockMoveBackToPersonal,
    setupFromFolder: mockSetupFromFolder,
    onOwnershipChanged: mockOnOwnershipChanged,
  }),
}));
const mockCodeEligibility = jest.fn<Promise<boolean>, [string]>();
jest.mock('../lib/org-cowork-binding-deps', () => ({
  getOrgMemberCodeEligibility: (organizationId: string): Promise<boolean> =>
    mockCodeEligibility(organizationId),
}));
const mockInspectFolder = jest.fn();
jest.mock('../lib/org-member-folder-inspection', () => ({
  getOrgMemberFolderInspector: (): unknown => ({ inspect: mockInspectFolder }),
}));
const mockFindRepositoryOwner = jest.fn();
jest.mock('../lib/org-repository-owner', () => ({
  getOrgRepositoryOwnerLookup: (): unknown => ({
    find: mockFindRepositoryOwner,
  }),
}));
const mockCreateMemberCodeProject = jest.fn();
const mockCreateMemberMultiRepoProject = jest.fn();
jest.mock('../lib/org-member-code-create-deps', () => ({
  getOrgMemberCodeCreator: (): unknown => ({
    create: mockCreateMemberCodeProject,
  }),
}));
jest.mock('../lib/org-member-multi-repo-create-deps', () => ({
  getOrgMemberMultiRepoCreator: (): unknown => ({
    create: mockCreateMemberMultiRepoProject,
  }),
}));
const mockMoveWorkspace = jest.fn();
jest.mock('../lib/org-project-move-deps', () => ({
  getOrgProjectMover: (): unknown => ({ move: mockMoveWorkspace }),
}));
const mockCheckRepositories = jest.fn();
jest.mock('../lib/org-member-multi-repo-sync-deps', () => ({
  getOrgMemberMultiRepoSync: (): unknown => ({
    checkRepositories: mockCheckRepositories,
  }),
}));
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): unknown => ({
    getState: (): unknown => ({
      context: { kind: 'organization', organizationId: ORG_A },
    }),
  }),
}));
import {
  IPC_CHANNELS,
  type OrgProjectOwnershipChangedEvent,
} from '@canopy/desktop-shared/types';
import type { SessionDiagnosticRecord } from '../observability/service';
import type { DesktopOrgProjectCatalogSnapshot } from '../services/org-project-catalog-service';

type RegisteredHandler = (...args: unknown[]) => unknown;
type Listener = (snapshot: DesktopOrgProjectCatalogSnapshot) => void;

const mockRegisterIpcHandler = jest.fn<void, [string, RegisteredHandler]>();
const mockList = jest.fn();
const mockRefresh = jest.fn();
const mockSetPreference = jest.fn();
const mockSubscribe = jest.fn<() => void, [Listener]>();
const mockGetAllWindows = jest.fn();

jest.mock('../ipc/register', () => ({
  registerIpcHandler: mockRegisterIpcHandler,
}));
jest.mock('../services/org-project-catalog-service', () => ({
  getOrgProjectCatalogService: (): unknown => ({
    list: mockList,
    refresh: mockRefresh,
    setPreference: mockSetPreference,
    subscribe: mockSubscribe,
  }),
}));
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: mockGetAllWindows },
}));
const mockRecordSessionDiagnostic = jest.fn<void, [SessionDiagnosticRecord]>();
jest.mock('../observability', () => ({
  getObservabilityService: (): unknown => ({
    recordSessionDiagnostic: mockRecordSessionDiagnostic,
  }),
}));

import { registerOrgProjectsHandlers } from '../ipc/org-projects';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SNAPSHOT: DesktopOrgProjectCatalogSnapshot = {
  context: `org:${ORG_A}`,
  revision: 'r1',
  projects: [],
  fetchedAt: '2026-09-10T00:00:00.000Z',
  stale: false,
  error: null,
};

function handlerFor(channel: string): RegisteredHandler {
  const call = mockRegisterIpcHandler.mock.calls.find(
    ([registered]) => registered === channel,
  );
  if (!call) throw new Error(`No IPC handler registered for ${channel}`);
  return call[1];
}

describe('org-projects IPC', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRolloutEnabled = true;
    mockGetAllWindows.mockReturnValue([]);
    mockList.mockResolvedValue(SNAPSHOT);
    mockRefresh.mockResolvedValue(SNAPSHOT);
    mockSetPreference.mockResolvedValue(SNAPSHOT);
    mockCodeEligibility.mockResolvedValue('eligible');
    mockInspectFolder.mockResolvedValue({
      kind: 'code',
      target: 'new',
      repository: null,
    });
    mockCreateMemberCodeProject.mockResolvedValue({
      ok: false,
      code: 'create-failed',
    });
  });

  it('refuses catalog IPC calls after runtime disable without invoking the service', async (): Promise<void> => {
    registerOrgProjectsHandlers();
    const request = {
      context: { kind: 'organization', organizationId: ORG_A },
      projectId: 'p1',
      preference: 'ADDED',
    };
    mockRolloutEnabled = false;
    for (const channel of [
      IPC_CHANNELS.orgProjectsList,
      IPC_CHANNELS.orgProjectsRefresh,
      IPC_CHANNELS.orgProjectsSetPreference,
    ]) {
      await expect(handlerFor(channel)({}, request)).resolves.toMatchObject({
        context: `org:${ORG_A}`,
        projects: [],
        error: 'unavailable',
      });
    }
    expect(mockList).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockSetPreference).not.toHaveBeenCalled();
    mockRolloutEnabled = true;
    await expect(
      handlerFor(IPC_CHANNELS.orgProjectsList)({}, request),
    ).resolves.toBe(SNAPSHOT);
  });

  it('records a session diagnostic, without paths or names, when links are unknown', async (): Promise<void> => {
    registerOrgProjectsHandlers();
    const list = handlerFor(IPC_CHANNELS.orgProjectLinksList);
    mockLinksList.mockResolvedValueOnce({
      status: 'unknown',
      reason: 'remote-unavailable',
    });
    await expect(list({})).resolves.toEqual({
      status: 'unknown',
      reason: 'remote-unavailable',
    });
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledTimes(1);
    const [record] = mockRecordSessionDiagnostic.mock.calls[0] ?? [];
    expect(record).toMatchObject({
      version: 1,
      kind: 'org_project_links_unknown',
      reason: 'remote-unavailable',
      sessionKey: 'org-project-links',
      projectId: '',
      worktreeId: '',
      chatId: '',
      providerType: 'unknown',
    });
    expect(Object.keys(record ?? {}).sort()).toEqual([
      'chatId',
      'kind',
      'projectId',
      'providerType',
      'reason',
      'sessionKey',
      'timestamp',
      'version',
      'worktreeId',
    ]);
    mockLinksList.mockResolvedValueOnce({ status: 'resolved', links: [] });
    await expect(list({})).resolves.toEqual({ status: 'resolved', links: [] });
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledTimes(1);
  });

  it('records a bounded session diagnostic before rejecting a failed links IPC', async (): Promise<void> => {
    registerOrgProjectsHandlers();
    const list = handlerFor(IPC_CHANNELS.orgProjectLinksList);
    mockLinksList.mockRejectedValueOnce(new Error('/private/path leaked'));

    await expect(list({})).rejects.toThrow('/private/path leaked');
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledTimes(1);
    const [record] = mockRecordSessionDiagnostic.mock.calls[0] ?? [];
    expect(record).toEqual({
      version: 1,
      timestamp: record?.timestamp,
      kind: 'org_project_links_unknown',
      reason: 'request-failed',
      sessionKey: 'org-project-links',
      projectId: '',
      worktreeId: '',
      chatId: '',
      providerType: 'unknown',
    });
    expect(typeof record?.timestamp).toBe('string');
  });

  it('validates the context before listing or refreshing', async () => {
    registerOrgProjectsHandlers();
    const list = handlerFor(IPC_CHANNELS.orgProjectsList);
    await expect(list({}, { context: { kind: 'team' } })).rejects.toThrow(
      /context/i,
    );
    await expect(
      list({}, { context: { kind: 'organization', organizationId: 'Bad Id' } }),
    ).rejects.toThrow(/invalid/i);
    await expect(
      list({}, { context: { kind: 'organization', organizationId: ORG_A } }),
    ).resolves.toBe(SNAPSHOT);
    expect(mockList).toHaveBeenCalledWith({
      kind: 'organization',
      organizationId: ORG_A,
    });

    const refresh = handlerFor(IPC_CHANNELS.orgProjectsRefresh);
    await refresh({}, { context: { kind: 'personal' }, force: true });
    expect(mockRefresh).toHaveBeenCalledWith(
      { kind: 'personal' },
      { force: true },
    );
    // CAN-3489: the Add project dialog also re-reads GitHub; only a literal
    // `true` asks for it.
    await refresh(
      {},
      {
        context: { kind: 'organization', organizationId: ORG_A },
        repositories: true,
      },
    );
    expect(mockRefresh).toHaveBeenLastCalledWith(
      { kind: 'organization', organizationId: ORG_A },
      { force: false, repositories: true },
    );
    await refresh({}, { context: { kind: 'personal' }, repositories: 'yes' });
    expect(mockRefresh).toHaveBeenLastCalledWith(
      { kind: 'personal' },
      { force: false },
    );
  });

  it('validates the project id and preference before writing', async () => {
    registerOrgProjectsHandlers();
    const set = handlerFor(IPC_CHANNELS.orgProjectsSetPreference);
    await expect(
      set(
        {},
        { context: { kind: 'personal' }, projectId: 'p!', preference: 'ADDED' },
      ),
    ).rejects.toThrow(/project id/i);
    await expect(
      set(
        {},
        { context: { kind: 'personal' }, projectId: 'p1', preference: 'MAYBE' },
      ),
    ).rejects.toThrow(/preference/i);
    await set(
      {},
      {
        context: { kind: 'personal' },
        projectId: 'p1',
        preference: 'DISMISSED',
      },
    );
    expect(mockSetPreference).toHaveBeenCalledWith(
      { kind: 'personal' },
      'p1',
      'DISMISSED',
    );
  });

  it('broadcasts catalog changes to every live window', () => {
    const send = jest.fn();
    mockGetAllWindows.mockReturnValue([
      { isDestroyed: (): boolean => false, webContents: { send } },
      { isDestroyed: (): boolean => true, webContents: { send: jest.fn() } },
    ]);
    registerOrgProjectsHandlers();
    const listener = mockSubscribe.mock.calls[0]?.[0];
    listener?.(SNAPSHOT);
    expect(send).toHaveBeenCalledWith(
      IPC_CHANNELS.orgProjectsChanged,
      SNAPSHOT,
    );
  });
});

it('registers materialization start and cancel handlers', (): void => {
  registerOrgProjectsHandlers();
  expect(() => handlerFor('org-projects:setup-start')).not.toThrow();
  expect(() => handlerFor('org-projects:setup-cancel')).not.toThrow();
});

it('validates and forwards member Code eligibility, inspection, create, and folder setup', async (): Promise<void> => {
  registerOrgProjectsHandlers();
  await expect(
    handlerFor(IPC_CHANNELS.orgProjectsMemberCodeEligibility)({}, ORG_A),
  ).resolves.toBe('eligible');
  expect(mockCodeEligibility).toHaveBeenCalledWith(ORG_A);

  await expect(
    handlerFor(IPC_CHANNELS.orgProjectsInspectFolder)(
      {},
      {
        organizationId: ORG_A,
        path: '/repo',
      },
    ),
  ).resolves.toMatchObject({ kind: 'code' });
  expect(mockInspectFolder).toHaveBeenCalledWith(ORG_A, '/repo');

  const create = {
    organizationId: ORG_A,
    name: 'Payments',
    folderPath: '/repo',
  };
  await handlerFor(IPC_CHANNELS.orgProjectsCreateMemberCodeProject)({}, create);
  expect(mockCreateMemberCodeProject).toHaveBeenCalledWith(create);

  mockSetupFromFolder.mockResolvedValue({
    projectId: 'project',
    instanceId: null,
    state: 'claiming',
    message: 'Claiming',
    percent: null,
    updatedAt: new Date().toISOString(),
  });
  await handlerFor(IPC_CHANNELS.orgProjectsSetupFromFolder)(
    {},
    {
      projectId: 'project',
      path: '/repo',
    },
  );
  expect(mockSetupFromFolder).toHaveBeenCalledWith('project', '/repo');

  await expect(
    handlerFor(IPC_CHANNELS.orgProjectsInspectFolder)(
      {},
      {
        organizationId: '../bad',
        path: '/repo',
      },
    ),
  ).rejects.toThrow();
});

it.each([
  [
    IPC_CHANNELS.orgProjectsCreateMemberCodeProject,
    mockCreateMemberCodeProject,
  ],
  [
    IPC_CHANNELS.orgProjectsCreateMemberMultiRepoProject,
    mockCreateMemberMultiRepoProject,
  ],
])('forwards and validates private memory for %s', async (channel, create) => {
  registerOrgProjectsHandlers();
  const request = {
    organizationId: ORG_A,
    name: 'Private',
    privateMemory: true,
  };
  await handlerFor(channel)({}, request);
  expect(create).toHaveBeenCalledWith(request);

  await handlerFor(channel)({}, { ...request, privateMemory: false });
  expect(create).toHaveBeenCalledWith({ ...request, privateMemory: false });

  await expect(
    handlerFor(channel)({}, { ...request, privateMemory: 'yes' }),
  ).rejects.toThrow(/Invalid member/i);
});

it('converts a Personal folder selected for repository-less setup', async (): Promise<void> => {
  jest.clearAllMocks();
  registerOrgProjectsHandlers();
  mockInspectFolder.mockResolvedValue({
    kind: 'code',
    target: 'new',
    repository: null,
    personalWorkspaceId: 'personal',
  });
  mockConvertWorkspace.mockResolvedValue({
    ok: true,
    workspaceId: 'personal',
    owner: {
      type: 'organization',
      organizationId: ORG_A,
      projectId: 'project',
      instanceId: 'instance',
      bindingGeneration: 1,
    },
    ownershipTransfer: {
      version: 1,
      previousOwner: { type: 'personal' },
      organizationId: ORG_A,
      projectId: 'project',
      convertedAt: '2026-10-01T00:00:00.000Z',
    },
  });

  await expect(
    handlerFor(IPC_CHANNELS.orgProjectsSetupFromFolder)(
      {},
      { projectId: 'project', path: '/repo' },
    ),
  ).resolves.toMatchObject({
    projectId: 'project',
    instanceId: 'instance',
    state: 'ready',
  });
  expect(mockConvertWorkspace).toHaveBeenCalledWith(
    {
      workspaceId: 'personal',
      organizationId: ORG_A,
      projectId: 'project',
    },
    { memberCreated: true },
  );
  expect(mockSetupFromFolder).not.toHaveBeenCalled();
});

it('validates setup ids and forwards start, cancel and progress', async (): Promise<void> => {
  registerOrgProjectsHandlers();
  const start = handlerFor('org-projects:setup-start');
  await expect(start({}, { projectId: '../bad' })).rejects.toThrow();
  await start({}, { projectId: 'project', destinationRoot: '/chosen' });
  await handlerFor('org-projects:setup-cancel')({}, { projectId: 'project' });
  expect(mockSetupStart).toHaveBeenCalledWith('project', '/chosen');
  expect(mockSetupCancel).toHaveBeenCalledWith('project');
  const send = jest.fn();
  mockGetAllWindows.mockReturnValue([
    { isDestroyed: (): boolean => false, webContents: { send } },
  ]);
  const progress: OrgProjectSetupProgress = {
    projectId: 'project',
    instanceId: null,
    state: 'claiming',
    message: 'Claiming a setup slot',
    percent: null,
    updatedAt: new Date().toISOString(),
  };
  mockSetupSubscribe.mock.calls.at(-1)?.[0](progress);
  expect(send).toHaveBeenCalledWith('org-projects:setup-progress', progress);
});

it.each([undefined, null, 42, {}])(
  'passes a malformed destination %s to typed coordinator validation',
  async (destinationRoot): Promise<void> => {
    registerOrgProjectsHandlers();
    await handlerFor('org-projects:setup-start')(
      {},
      { projectId: 'project', destinationRoot },
    );
    expect(mockSetupStart).toHaveBeenCalledWith('project', '');
  },
);

it('validates relationship ids and decisions before local dispatch', async (): Promise<void> => {
  registerOrgProjectsHandlers();
  const decide = handlerFor('org-projects:links-decide');
  for (const request of [
    null,
    {},
    {
      projectId: '../bad',
      personalWorkspaceId: 'personal',
      decision: 'dismiss',
    },
    { projectId: 'project', personalWorkspaceId: '../bad', decision: 'view' },
    {
      projectId: 'project',
      personalWorkspaceId: 'personal',
      decision: 'setup',
    },
  ]) {
    await expect(decide({}, request)).rejects.toThrow();
  }
  expect(mockLinksDecide).not.toHaveBeenCalled();
  const request = {
    projectId: 'project',
    personalWorkspaceId: 'personal',
    decision: 'dismiss',
  };
  await decide({}, request);
  expect(mockLinksDecide).toHaveBeenCalledWith(request);
  mockLinksList.mockResolvedValueOnce({ status: 'resolved', links: [] });
  await handlerFor('org-projects:links-list')({});
  expect(mockLinksList).toHaveBeenCalledWith();
});

it('validates conversion ids, forwards conversion and move back, and broadcasts ownership changes', async (): Promise<void> => {
  jest.clearAllMocks();
  registerOrgProjectsHandlers();
  const convert = handlerFor(IPC_CHANNELS.orgProjectsConvertWorkspace);
  const moveBack = handlerFor(IPC_CHANNELS.orgProjectsMoveBackToPersonal);
  const request = {
    workspaceId: 'personal',
    organizationId: ORG_A,
    projectId: 'project',
  };
  for (const bad of [
    null,
    { ...request, workspaceId: '../bad' },
    { ...request, organizationId: undefined },
    { ...request, projectId: 'Bad Id' },
  ])
    await expect(convert({}, bad)).rejects.toThrow();
  await expect(moveBack({}, { workspaceId: '../bad' })).rejects.toThrow();
  expect(mockConvertWorkspace).not.toHaveBeenCalled();
  expect(mockMoveBackToPersonal).not.toHaveBeenCalled();

  mockConvertWorkspace.mockResolvedValueOnce({ ok: false, code: 'disabled' });
  await expect(convert({}, { ...request, extra: 1 })).resolves.toEqual({
    ok: false,
    code: 'disabled',
  });
  expect(mockConvertWorkspace).toHaveBeenCalledWith(request);
  mockMoveBackToPersonal.mockResolvedValueOnce({
    ok: false,
    code: 'not-converted',
  });
  await moveBack({}, { workspaceId: 'personal' });
  expect(mockMoveBackToPersonal).toHaveBeenCalledWith({
    workspaceId: 'personal',
  });

  const send = jest.fn();
  mockGetAllWindows.mockReturnValue([
    { isDestroyed: (): boolean => false, webContents: { send } },
  ]);
  const event: OrgProjectOwnershipChangedEvent = {
    ...request,
    owner: 'organization',
  };
  mockOnOwnershipChanged.mock.calls.at(-1)?.[0](event);
  expect(send).toHaveBeenCalledWith(
    IPC_CHANNELS.orgProjectsOwnershipChanged,
    event,
  );
});

it('validates move ids and returns the mover result unchanged', async (): Promise<void> => {
  jest.clearAllMocks();
  registerOrgProjectsHandlers();
  const move = handlerFor(IPC_CHANNELS.orgProjectsMoveWorkspace);
  const request = { workspaceId: 'personal', organizationId: ORG_A };
  for (const bad of [
    null,
    'personal',
    { organizationId: ORG_A },
    { workspaceId: 'personal' },
    { ...request, workspaceId: '../bad' },
    { ...request, organizationId: 'Bad Id' },
  ])
    await expect(move({}, bad)).rejects.toThrow();
  expect(mockMoveWorkspace).not.toHaveBeenCalled();

  const refused = {
    ok: false,
    code: 'limit-reached',
    organizationProjectId: 'created',
  };
  mockMoveWorkspace.mockResolvedValueOnce(refused);
  await expect(move({}, { ...request, extra: 1 })).resolves.toBe(refused);
  expect(mockMoveWorkspace).toHaveBeenCalledWith(request);
  const moved = { ok: true, ...request, projectId: 'project' };
  mockMoveWorkspace.mockResolvedValueOnce(moved);
  await expect(move({}, request)).resolves.toBe(moved);
});

it('checks repositories for an organization multi-repo project (CAN-3546)', async (): Promise<void> => {
  jest.clearAllMocks();
  registerOrgProjectsHandlers();
  const result = {
    kind: 'checked',
    organizationName: 'Acme',
    repositories: { '/repos/docs': 'outside' },
  };
  mockCheckRepositories.mockResolvedValue(result);
  const check = handlerFor(IPC_CHANNELS.orgProjectsCheckRepositories);

  await expect(
    check(
      {},
      {
        workspaceId: 'acme-platform',
        repoPaths: ['/repos/docs'],
        remoteUrls: ['https://github.com/acme/docs.git'],
      },
    ),
  ).resolves.toEqual(result);
  expect(mockCheckRepositories).toHaveBeenCalledWith({
    workspaceId: 'acme-platform',
    repoPaths: ['/repos/docs'],
    remoteUrls: ['https://github.com/acme/docs.git'],
  });

  for (const invalid of [
    null,
    { workspaceId: '../bad', repoPaths: ['/repos/docs'] },
    { workspaceId: 'acme-platform', repoPaths: ['relative/docs'] },
    { workspaceId: 'acme-platform', repoPaths: '/repos/docs' },
    { workspaceId: 'acme-platform', remoteUrls: [42] },
    { workspaceId: 'acme-platform', remoteUrls: [''] },
    {
      workspaceId: 'acme-platform',
      repoPaths: Array.from({ length: 501 }, (_, index) => `/repos/${index}`),
    },
  ]) {
    mockCheckRepositories.mockClear();
    await expect(check({}, invalid)).rejects.toThrow();
    expect(mockCheckRepositories).not.toHaveBeenCalled();
  }
});

it('validates and forwards a repository owner lookup by folder or clone URL', async (): Promise<void> => {
  registerOrgProjectsHandlers();
  const find = handlerFor(IPC_CHANNELS.orgProjectsFindRepositoryOwner);
  const owner = {
    kind: 'organization',
    organizationId: ORG_A,
    organizationName: 'Acme',
    projectId: 'project',
    projectName: 'Payments',
    repositoryName: 'acme/payments',
  };
  mockFindRepositoryOwner.mockResolvedValue(owner);
  await expect(find({}, { path: '/repos/payments' })).resolves.toEqual(owner);
  expect(mockFindRepositoryOwner).toHaveBeenLastCalledWith({
    path: '/repos/payments',
  });
  await expect(
    find({}, { remoteUrl: 'https://github.com/acme/payments.git' }),
  ).resolves.toEqual(owner);
  expect(mockFindRepositoryOwner).toHaveBeenLastCalledWith({
    remoteUrl: 'https://github.com/acme/payments.git',
  });

  for (const invalid of [
    null,
    {},
    { path: 'relative/payments' },
    { path: '' },
    { path: 42 },
    { remoteUrl: '' },
    { remoteUrl: `https://github.com/${'a'.repeat(2048)}` },
    { path: '/repos/payments', remoteUrl: 'https://github.com/acme/x.git' },
  ]) {
    mockFindRepositoryOwner.mockClear();
    await expect(find({}, invalid)).rejects.toThrow();
    expect(mockFindRepositoryOwner).not.toHaveBeenCalled();
  }
});
