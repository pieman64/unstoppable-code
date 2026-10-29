import {
  IPC_CHANNELS,
  type AppAdvisorApi,
  type CanopyApi,
} from '@canopy/desktop-shared/types';

type IpcRendererListener = (event: unknown, data: unknown) => void;

const exposed = new Map<string, unknown>();
const mockExposeInMainWorld = jest.fn<void, [string, unknown]>(
  (key, value): void => {
    exposed.set(key, value);
  },
);
const mockInvoke = jest.fn<Promise<unknown>, [string, ...unknown[]]>(() =>
  Promise.resolve(undefined),
);
const mockOn = jest.fn<void, [string, IpcRendererListener]>();
const mockRemoveListener = jest.fn<void, [string, IpcRendererListener]>();
const mockSendSync = jest.fn<{ ollama: [] }, []>(() => ({ ollama: [] }));

jest.mock('@canopy/desktop-instrumentation/electron/preload', () => ({}));
jest.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mockExposeInMainWorld },
  ipcRenderer: {
    invoke: mockInvoke,
    on: mockOn,
    removeListener: mockRemoveListener,
    sendSync: mockSendSync,
  },
  webUtils: { getPathForFile: jest.fn(() => '') },
}));
jest.mock('@electron-toolkit/preload', () => ({ electronAPI: {} }));
jest.mock('../api/bundles-api', () => ({
  createBundlesAPI: (): Record<string, never> => ({}),
}));
jest.mock('../api/collections-api', () => ({
  createCollectionsAPI: (): Record<string, never> => ({}),
}));
jest.mock('../api/pipelines-api', () => ({
  createPipelinesAPI: (): Record<string, never> => ({}),
}));
jest.mock('../api/plugins-api', () => ({
  createPluginsAPI: (): Record<string, never> => ({}),
}));
jest.mock('../api/mcp-servers-api', () => ({
  createMcpServersAPI: (): Record<string, never> => ({}),
}));
jest.mock('../api/skills-api', () => ({
  createSkillsAPI: (): Record<string, never> => ({}),
}));
jest.mock('../api/agents-api', () => ({
  createAgentsAPI: (): Record<string, never> => ({}),
}));
jest.mock('../api/invocable-inventory-api', () => ({
  createInvocableInventoryAPI: (): Record<string, never> => ({}),
}));

function loadCanopyApi(): CanopyApi {
  exposed.clear();
  jest.isolateModules((): void => {
    Object.defineProperty(process, 'contextIsolated', {
      configurable: true,
      value: true,
    });
    jest.requireActual('../index');
  });
  const api = exposed.get('api') as CanopyApi | undefined;
  if (!api) {
    throw new Error('preload API was not exposed');
  }
  return api;
}

function loadAppAdvisorApi(): AppAdvisorApi {
  return loadCanopyApi().appAdvisor;
}

describe('preload workspace readiness API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forwards the typed readiness request through its dedicated channel', async () => {
    const api = loadCanopyApi();
    const request = {
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
    };

    await api.getWorkspaceReadiness(request);

    expect(mockInvoke).toHaveBeenCalledWith(
      IPC_CHANNELS.workspaceReadReadiness,
      request,
    );
  });
});

describe('preload App Advisor workspace API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('bridges settings and CLAUDE.md methods through their typed channels', async () => {
    const api = loadAppAdvisorApi();

    await api.settingsLoad();
    await api.settingsSave({
      description: 'Description',
      archiveRetentionDays: null,
    });
    await api.loadClaudeMd();
    await api.saveClaudeMd('# Instructions\n');

    expect(mockInvoke).toHaveBeenNthCalledWith(
      1,
      IPC_CHANNELS.appAdvisorSettingsLoad,
    );
    expect(mockInvoke).toHaveBeenNthCalledWith(
      2,
      IPC_CHANNELS.appAdvisorSettingsSave,
      { description: 'Description', archiveRetentionDays: null },
    );
    expect(mockInvoke).toHaveBeenNthCalledWith(
      3,
      IPC_CHANNELS.appAdvisorLoadClaudeMd,
    );
    expect(mockInvoke).toHaveBeenNthCalledWith(
      4,
      IPC_CHANNELS.appAdvisorSaveClaudeMd,
      '# Instructions\n',
    );
  });

  it('bridges completed watcher history through its dedicated channel', async () => {
    const api = loadAppAdvisorApi();

    await api.listCompletedWatchers();

    expect(mockInvoke).toHaveBeenCalledWith(
      IPC_CHANNELS.appAdvisorWatchersCompletedList,
    );
  });

  it('serializes UI-state reports to identifiers and booleans only', async () => {
    const api = loadAppAdvisorApi();
    const input = {
      activeWorkEntryId: 'entry-1',
      activeChatId: 'chat-1',
      navCollapsed: true,
      groupEditorId: 'grp-editor',
      settingsModalOpen: false,
      archivedOverviewOpen: true,
      archivedOverviewWorkspaceId: 'app-advisor',
      emptyTrashConfirmationOpen: true,
      emptyTrashRunning: false,
      lastArchivedOverviewRequestId: 'request-1',
      lastArchivedOverviewConfirmationOpened: true,
      chatText: 'private',
      path: '/tmp/private',
    };

    await api.reportWindowUiState(input);

    expect(mockInvoke).toHaveBeenCalledWith(
      IPC_CHANNELS.appAdvisorReportWindowUiState,
      {
        activeWorkEntryId: 'entry-1',
        activeChatId: 'chat-1',
        navCollapsed: true,
        groupEditorId: 'grp-editor',
        settingsModalOpen: false,
        archivedOverviewOpen: true,
        archivedOverviewWorkspaceId: 'app-advisor',
        emptyTrashConfirmationOpen: true,
        emptyTrashRunning: false,
        lastArchivedOverviewRequestId: 'request-1',
        lastArchivedOverviewConfirmationOpened: true,
      },
    );
  });

  it('subscribes to forwarded popout UI state and removes the exact listener', () => {
    const api = loadAppAdvisorApi();
    const callback = jest.fn();
    const unsubscribe = api.onWindowUiStateChanged(callback);
    const handler = mockOn.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.appAdvisorWindowUiStateChanged,
    )?.[1];
    if (!handler) {
      throw new Error('window UI-state listener was not registered');
    }
    const state = {
      activeWorkEntryId: 'entry-1',
      activeChatId: null,
      navCollapsed: false,
      settingsModalOpen: true,
      archivedOverviewOpen: false,
      archivedOverviewWorkspaceId: null,
      emptyTrashConfirmationOpen: false,
      emptyTrashRunning: false,
      lastArchivedOverviewRequestId: null,
      lastArchivedOverviewConfirmationOpened: null,
    };

    handler({}, state);
    unsubscribe();

    expect(callback).toHaveBeenCalledWith(state);
    expect(mockRemoveListener).toHaveBeenCalledWith(
      IPC_CHANNELS.appAdvisorWindowUiStateChanged,
      handler,
    );
  });

  it('subscribes to workspace settings changes and removes the exact listener', () => {
    const api = loadAppAdvisorApi();
    const callback = jest.fn();
    const unsubscribe = api.onSettingsChanged(callback);
    const handler = mockOn.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.appAdvisorSettingsChanged,
    )?.[1];
    if (!handler) throw new Error('settings listener was not registered');
    const settings = { version: 1, archiveRetentionDays: 3 };

    handler({}, settings);
    unsubscribe();

    expect(callback).toHaveBeenCalledWith(settings);
    expect(mockRemoveListener).toHaveBeenCalledWith(
      IPC_CHANNELS.appAdvisorSettingsChanged,
      handler,
    );
  });

  it('rejects malformed forwarded workspace settings', () => {
    const api = loadAppAdvisorApi();
    const callback = jest.fn();
    api.onSettingsChanged(callback);
    const handler = mockOn.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.appAdvisorSettingsChanged,
    )?.[1];
    if (!handler) throw new Error('settings listener was not registered');

    expect(() => handler({}, { version: 2, autoArchiveDays: 0 })).toThrow(
      'Invalid App Advisor settings',
    );
    expect(callback).not.toHaveBeenCalled();
  });

  it('rejects malformed forwarded popout UI state', () => {
    const api = loadAppAdvisorApi();
    const callback = jest.fn();
    api.onWindowUiStateChanged(callback);
    const handler = mockOn.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.appAdvisorWindowUiStateChanged,
    )?.[1];
    if (!handler) {
      throw new Error('window UI-state listener was not registered');
    }

    expect(() => handler({}, { activeChatId: 'chat-1' })).toThrow(
      'Invalid App Advisor window UI state',
    );
    expect(callback).not.toHaveBeenCalled();
  });

  it('forwards only valid App Advisor tool cancellation payloads', () => {
    const api = loadAppAdvisorApi();
    const callback = jest.fn();
    api.onToolRequestCancelled(callback);
    const handler = mockOn.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.appAdvisorToolRequestCancelled,
    )?.[1];
    if (!handler) {
      throw new Error('tool cancellation listener was not registered');
    }

    handler({}, { requestId: 'request-1' });
    handler({}, { requestId: 42 });
    handler({}, null);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({ requestId: 'request-1' });
  });

  it('validates and serializes allowlisted artifact navigation requests', async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true });
    const api = loadAppAdvisorApi();
    const request = {
      kind: 'installed_skill',
      sourceId: 'custom:app',
      skillName: 'review',
      filePath: 'references/api.md',
      route: '/plugins',
    } satisfies Parameters<AppAdvisorApi['openAgentArtifact']>[0] & {
      route: string;
    };

    await expect(api.openAgentArtifact(request)).resolves.toEqual({ ok: true });
    expect(mockInvoke).toHaveBeenCalledWith(
      IPC_CHANNELS.appAdvisorOpenAgentArtifact,
      {
        kind: 'installed_skill',
        sourceId: 'custom:app',
        skillName: 'review',
        filePath: 'references/api.md',
      },
    );

    mockInvoke.mockClear();
    await expect(
      Reflect.apply(api.openAgentArtifact.bind(api), undefined, [
        {
          kind: 'arbitrary',
          action: 'navigation.go_to_page',
        },
      ]),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'validation_failed', retryable: false },
    });
    expect(mockInvoke).not.toHaveBeenCalled();

    mockInvoke.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'authentication_failed',
        message: 'Sign in to open this artifact.',
        retryable: true,
        internalDetail: 'not copied',
      },
    });
    await expect(
      api.openAgentArtifact({ kind: 'shared_skill', skillId: 'skill-1' }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'authentication_failed',
        message: 'Sign in to open this artifact.',
        retryable: true,
      },
    });

    mockInvoke.mockRejectedValueOnce(new Error('IPC handler unavailable'));
    await expect(
      api.openAgentArtifact({ kind: 'shared_skill', skillId: 'skill-1' }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'navigation_failed',
        message: 'IPC handler unavailable',
        retryable: true,
      },
    });
  });
});

describe('preload archived-container API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forwards every typed archive request and workspace retention update', async () => {
    const api = loadCanopyApi();
    const identity = { projectId: 'workspace-1', containerId: 'archive-1' };

    await api.archivedContainers.list({ projectId: 'workspace-1' });
    await api.archivedContainers.listChanges({
      ...identity,
      cursor: 'opaque-cursor',
      limit: 25,
    });
    await api.archivedContainers.readChangeDiff({
      ...identity,
      repoId: 'repo-1',
      filePath: 'src/index.ts',
    });
    await api.archivedContainers.refreshPullRequests(identity);
    await api.archivedContainers.listChats(identity);
    await api.archivedContainers.readChat({ ...identity, chatId: 'chat-1' });
    await api.archivedContainers.listExecutions(identity);
    await api.archivedContainers.readExecution({
      ...identity,
      executionId: 'execution-1',
    });
    await api.archivedContainers.readExecutionReport({
      ...identity,
      executionId: 'execution-1',
      kind: 'json',
    });
    await api.archivedContainers.readExecutionStepLog({
      ...identity,
      executionId: 'execution-1',
      jobId: 'job-1',
      stepId: 'step-1',
      attempt: 2,
    });
    await api.archivedContainers.restore(identity);
    await api.archivedContainers.delete(identity);
    await api.setWorkspaceArchiveRetention({
      workspaceId: 'workspace-1',
      archiveRetentionDays: 0,
    });

    expect(mockInvoke.mock.calls).toEqual([
      [IPC_CHANNELS.archivedContainersList, { projectId: 'workspace-1' }],
      [
        IPC_CHANNELS.archivedContainersListChanges,
        { ...identity, cursor: 'opaque-cursor', limit: 25 },
      ],
      [
        IPC_CHANNELS.archivedContainersReadChangeDiff,
        { ...identity, repoId: 'repo-1', filePath: 'src/index.ts' },
      ],
      [IPC_CHANNELS.archivedContainersRefreshPullRequests, identity],
      [IPC_CHANNELS.archivedContainersListChats, identity],
      [
        IPC_CHANNELS.archivedContainersReadChat,
        { ...identity, chatId: 'chat-1' },
      ],
      [IPC_CHANNELS.archivedContainersListExecutions, identity],
      [
        IPC_CHANNELS.archivedContainersReadExecution,
        { ...identity, executionId: 'execution-1' },
      ],
      [
        IPC_CHANNELS.archivedContainersReadExecutionReport,
        { ...identity, executionId: 'execution-1', kind: 'json' },
      ],
      [
        IPC_CHANNELS.archivedContainersReadExecutionStepLog,
        {
          ...identity,
          executionId: 'execution-1',
          jobId: 'job-1',
          stepId: 'step-1',
          attempt: 2,
        },
      ],
      [IPC_CHANNELS.archivedContainersRestore, identity],
      [IPC_CHANNELS.archivedContainersDelete, identity],
      [
        IPC_CHANNELS.workspaceSetArchiveRetention,
        { workspaceId: 'workspace-1', archiveRetentionDays: 0 },
      ],
    ]);
  });

  it('removes the exact changed-event listener during cleanup', () => {
    const api = loadCanopyApi();
    const callback = jest.fn();
    const unsubscribe = api.archivedContainers.onChanged(callback);
    const handler = mockOn.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.archivedContainersChanged,
    )?.[1];
    if (!handler) {
      throw new Error('archive changed listener was not registered');
    }

    handler({}, { workspaceId: 'workspace-1' });
    unsubscribe();

    expect(callback).toHaveBeenCalledWith({ workspaceId: 'workspace-1' });
    expect(mockRemoveListener).toHaveBeenCalledWith(
      IPC_CHANNELS.archivedContainersChanged,
      handler,
    );
  });
});
