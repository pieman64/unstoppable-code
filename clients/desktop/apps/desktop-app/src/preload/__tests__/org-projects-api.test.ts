import {
  IPC_CHANNELS,
  type CanopyApi,
  type OrgProjectsApi,
} from '@canopy/desktop-shared/types';

type IpcRendererListener = (event: unknown, data: unknown) => void;

const exposed = new Map<string, unknown>();
const mockExposeInMainWorld = jest.fn<void, [string, unknown]>(
  (key: string, value: unknown): void => {
    exposed.set(key, value);
  },
);
const mockInvoke = jest.fn<Promise<unknown>, [string, ...unknown[]]>();
const mockOn = jest.fn<void, [string, IpcRendererListener]>();
const mockRemoveListener = jest.fn<void, [string, IpcRendererListener]>();
const mockSendSync = jest.fn<{ ollama: [] }, []>(() => ({ ollama: [] }));

jest.mock('@canopy/desktop-instrumentation/electron/preload', () => ({}));
jest.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: mockExposeInMainWorld,
  },
  ipcRenderer: {
    invoke: mockInvoke,
    on: mockOn,
    removeListener: mockRemoveListener,
    sendSync: mockSendSync,
  },
}));
jest.mock('@electron-toolkit/preload', () => ({
  electronAPI: {},
}));
jest.mock(
  '../api/bundles-api',
  (): { createBundlesAPI: () => Record<string, never> } => ({
    createBundlesAPI: (): Record<string, never> => ({}),
  }),
);
jest.mock(
  '../api/pipelines-api',
  (): { createPipelinesAPI: () => Record<string, never> } => ({
    createPipelinesAPI: (): Record<string, never> => ({}),
  }),
);
jest.mock(
  '../api/plugins-api',
  (): { createPluginsAPI: () => Record<string, never> } => ({
    createPluginsAPI: (): Record<string, never> => ({}),
  }),
);
jest.mock(
  '../api/mcp-servers-api',
  (): { createMcpServersAPI: () => Record<string, never> } => ({
    createMcpServersAPI: (): Record<string, never> => ({}),
  }),
);
jest.mock(
  '../api/skills-api',
  (): { createSkillsAPI: () => Record<string, never> } => ({
    createSkillsAPI: (): Record<string, never> => ({}),
  }),
);

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SNAPSHOT = {
  context: `org:${ORG_ID}`,
  revision: 'r1',
  projects: [],
  fetchedAt: '2026-09-10T00:00:00.000Z',
  stale: false,
  error: null,
};

function isCanopyApi(value: unknown): value is CanopyApi {
  return (
    typeof value === 'object' &&
    value !== null &&
    'orgProjects' in value &&
    typeof value.orgProjects === 'object' &&
    value.orgProjects !== null
  );
}

function loadApi(): CanopyApi {
  exposed.clear();
  jest.isolateModules((): void => {
    Object.defineProperty(process, 'contextIsolated', {
      configurable: true,
      value: true,
    });
    jest.requireActual('../index');
  });
  const api: unknown = exposed.get('api');
  if (!isCanopyApi(api)) {
    throw new Error('preload API was not exposed');
  }
  return api;
}

function loadOrgProjectsApi(): OrgProjectsApi {
  return loadApi().orgProjects;
}

describe('preload orgProjects API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns validated snapshots from list, refresh, and setPreference', async () => {
    const orgProjects = loadOrgProjectsApi();
    mockInvoke.mockResolvedValue(SNAPSHOT);
    const context = { kind: 'organization' as const, organizationId: ORG_ID };
    await expect(orgProjects.list({ context })).resolves.toEqual(SNAPSHOT);
    await expect(
      orgProjects.refresh({ context, force: true }),
    ).resolves.toEqual(SNAPSHOT);
    await expect(
      orgProjects.setPreference({
        context,
        projectId: 'p1',
        preference: 'DISMISSED',
      }),
    ).resolves.toEqual(SNAPSHOT);
    expect(mockInvoke).toHaveBeenNthCalledWith(
      1,
      IPC_CHANNELS.orgProjectsList,
      { context },
    );
    expect(mockInvoke).toHaveBeenNthCalledWith(
      3,
      IPC_CHANNELS.orgProjectsSetPreference,
      { context, projectId: 'p1', preference: 'DISMISSED' },
    );
  });

  it('rejects malformed replies and drops malformed broadcasts', async () => {
    const orgProjects = loadOrgProjectsApi();
    mockInvoke.mockResolvedValueOnce({ ...SNAPSHOT, error: 'weird' });
    await expect(
      orgProjects.list({ context: { kind: 'personal' } }),
    ).rejects.toThrow(/Malformed organization project catalog reply/);

    const callback = jest.fn();
    const unsubscribe = orgProjects.onChanged(callback);
    const handler = mockOn.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.orgProjectsChanged,
    )?.[1];
    if (typeof handler !== 'function') {
      throw new Error('org-projects:changed listener was not registered');
    }
    handler(undefined, SNAPSHOT);
    handler(undefined, { ...SNAPSHOT, projects: [{ id: 1 }] });
    expect(callback).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(mockRemoveListener).toHaveBeenCalledWith(
      IPC_CHANNELS.orgProjectsChanged,
      handler,
    );
  });
});

it('validates setup results and progress and unregisters the listener', async (): Promise<void> => {
  const api = loadOrgProjectsApi();
  const progress = {
    projectId: 'p1',
    instanceId: null,
    state: 'claiming',
    message: 'Claiming a setup slot',
    percent: null,
    updatedAt: new Date().toISOString(),
  };
  mockInvoke.mockResolvedValue(progress);
  expect(
    await api.setupStart({ projectId: 'p1', destinationRoot: '/chosen' }),
  ).toEqual(progress);
  expect(mockInvoke).toHaveBeenLastCalledWith('org-projects:setup-start', {
    projectId: 'p1',
    destinationRoot: '/chosen',
  });
  await api.setupCancel({ projectId: 'p1' });
  expect(mockInvoke).toHaveBeenLastCalledWith('org-projects:setup-cancel', {
    projectId: 'p1',
  });
  mockInvoke.mockResolvedValue({ ...progress, percent: 101 });
  await expect(
    api.setupStart({ projectId: 'p1', destinationRoot: '/chosen' }),
  ).rejects.toThrow('Malformed organization project setup reply');
  const listener = jest.fn();
  const unsubscribe = api.onSetupProgress(listener);
  const handler = mockOn.mock.calls.find(
    ([channel]) => channel === 'org-projects:setup-progress',
  )?.[1];
  if (!handler) throw new Error('Missing progress listener');
  handler(undefined, progress);
  handler(undefined, { ...progress, state: 'unknown' });
  handler(undefined, { ...progress, percent: NaN });
  expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe();
  expect(mockRemoveListener).toHaveBeenCalledWith(
    'org-projects:setup-progress',
    handler,
  );
});

it('uses dedicated desktop-only relationship channels', async (): Promise<void> => {
  const api = loadOrgProjectsApi();
  mockInvoke.mockResolvedValue({ status: 'resolved', links: [] });
  await expect(api.linksList()).resolves.toEqual({
    status: 'resolved',
    links: [],
  });
  expect(mockInvoke).toHaveBeenLastCalledWith(IPC_CHANNELS.orgProjectLinksList);
  const request: Parameters<OrgProjectsApi['linksDecide']>[0] = {
    projectId: 'project',
    personalWorkspaceId: 'personal',
    decision: 'dismiss',
  };
  mockInvoke.mockResolvedValue(null);
  await expect(api.linksDecide(request)).resolves.toBeNull();
  expect(mockInvoke).toHaveBeenLastCalledWith(
    IPC_CHANNELS.orgProjectLinksDecide,
    request,
  );
});

it('uses the member Code project channels', async (): Promise<void> => {
  const api = loadOrgProjectsApi();
  mockInvoke.mockResolvedValueOnce('eligible');
  await expect(api.getMemberCodeEligibility(ORG_ID)).resolves.toBe('eligible');
  expect(mockInvoke).toHaveBeenLastCalledWith(
    IPC_CHANNELS.orgProjectsMemberCodeEligibility,
    ORG_ID,
  );
  const inspection = {
    kind: 'code' as const,
    target: 'new' as const,
    repository: null,
  };
  mockInvoke.mockResolvedValueOnce(inspection);
  await expect(
    api.inspectFolder({ organizationId: ORG_ID, path: '/repo' }),
  ).resolves.toEqual(inspection);
  mockInvoke.mockResolvedValueOnce({
    ok: true,
    organizationProjectId: 'project',
    localWorkspaceId: 'workspace',
  });
  await expect(
    api.createMemberCodeProject({ organizationId: ORG_ID, name: 'Payments' }),
  ).resolves.toMatchObject({ ok: true });
});

it('converts and moves back through dedicated channels and filters ownership broadcasts', async (): Promise<void> => {
  const api = loadOrgProjectsApi();
  const request = {
    workspaceId: 'personal',
    organizationId: ORG_ID,
    projectId: 'project',
  };
  mockInvoke.mockResolvedValue({ ok: false, code: 'repository-mismatch' });
  await expect(api.convertWorkspace(request)).resolves.toEqual({
    ok: false,
    code: 'repository-mismatch',
  });
  expect(mockInvoke).toHaveBeenLastCalledWith(
    IPC_CHANNELS.orgProjectsConvertWorkspace,
    request,
  );
  const move = { workspaceId: 'personal', organizationId: ORG_ID };
  mockInvoke.mockResolvedValue({ ok: false, code: 'limit-reached' });
  await expect(api.moveWorkspace(move)).resolves.toEqual({
    ok: false,
    code: 'limit-reached',
  });
  expect(mockInvoke).toHaveBeenLastCalledWith(
    IPC_CHANNELS.orgProjectsMoveWorkspace,
    move,
  );
  mockInvoke.mockResolvedValue({ ok: false, code: 'not-converted' });
  await expect(
    api.moveBackToPersonal({ workspaceId: 'personal' }),
  ).resolves.toEqual({ ok: false, code: 'not-converted' });
  expect(mockInvoke).toHaveBeenLastCalledWith(
    IPC_CHANNELS.orgProjectsMoveBackToPersonal,
    { workspaceId: 'personal' },
  );
  const listener = jest.fn();
  const unsubscribe = api.onOwnershipChanged(listener);
  const handler = mockOn.mock.calls.find(
    ([channel]) => channel === IPC_CHANNELS.orgProjectsOwnershipChanged,
  )?.[1];
  if (!handler) throw new Error('Missing ownership listener');
  const event = {
    workspaceId: 'personal',
    organizationId: ORG_ID,
    projectId: 'project',
    owner: 'organization',
  };
  handler(undefined, event);
  handler(undefined, { ...event, owner: 'team' });
  handler(undefined, { ...event, workspaceId: 1 });
  expect(listener).toHaveBeenCalledTimes(1);
  expect(listener).toHaveBeenCalledWith(event);
  unsubscribe();
  expect(mockRemoveListener).toHaveBeenCalledWith(
    IPC_CHANNELS.orgProjectsOwnershipChanged,
    handler,
  );
});

it('looks up a repository owner on its own channel and rejects malformed replies', async (): Promise<void> => {
  const api = loadOrgProjectsApi();
  const owner = {
    kind: 'organization' as const,
    organizationId: ORG_ID,
    organizationName: 'Acme',
    projectId: 'project',
    projectName: 'Payments',
    repositoryName: 'acme/payments',
  };
  mockInvoke.mockResolvedValueOnce(owner);
  await expect(
    api.findRepositoryOwner({ path: '/repos/payments' }),
  ).resolves.toEqual(owner);
  expect(mockInvoke).toHaveBeenLastCalledWith(
    IPC_CHANNELS.orgProjectsFindRepositoryOwner,
    { path: '/repos/payments' },
  );
  mockInvoke.mockResolvedValueOnce({ kind: 'none' });
  await expect(
    api.findRepositoryOwner({
      remoteUrl: 'https://github.com/acme/payments.git',
    }),
  ).resolves.toEqual({ kind: 'none' });
  mockInvoke.mockResolvedValueOnce({ ...owner, organizationName: 42 });
  await expect(
    api.findRepositoryOwner({ path: '/repos/payments' }),
  ).rejects.toThrow('Malformed organization repository owner reply');
});
