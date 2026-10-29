import {
  IPC_CHANNELS,
  type CanopyApi,
  type ChatDelegationActivity,
  type ManagedDelegationApi,
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

function isCanopyApi(value: unknown): value is CanopyApi {
  return (
    typeof value === 'object' &&
    value !== null &&
    'managedDelegation' in value &&
    typeof value.managedDelegation === 'object' &&
    value.managedDelegation !== null
  );
}

function loadManagedDelegationApi(): ManagedDelegationApi {
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
  return api.managedDelegation;
}

function registeredActivityHandler(): IpcRendererListener {
  const handler = mockOn.mock.calls.find(
    ([channel]) => channel === IPC_CHANNELS.managedDelegationActivityChanged,
  )?.[1];
  if (typeof handler !== 'function') {
    throw new Error('managed-delegation activity listener was not registered');
  }
  return handler;
}

const ACTIVITY: ChatDelegationActivity = {
  projectId: 'project-a',
  worktreeId: 'wt-a',
  chatId: 'chat-a',
  live: 1,
  queued: 2,
};

describe('preload managedDelegation API', () => {
  beforeEach((): void => {
    jest.clearAllMocks();
  });

  it('invokes the activity list and stop channels with the request', async (): Promise<void> => {
    const managedDelegation = loadManagedDelegationApi();
    mockInvoke.mockResolvedValueOnce([ACTIVITY]);
    mockInvoke.mockResolvedValueOnce({ ok: true });
    mockInvoke.mockResolvedValueOnce({ ok: true, stopped: 3 });

    await expect(managedDelegation.listActivity()).resolves.toEqual([ACTIVITY]);
    await expect(
      managedDelegation.stop({
        projectId: 'project-a',
        worktreeId: 'wt-a',
        chatId: 'chat-a',
        delegationId: 'delegation-1',
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      managedDelegation.stopAll({
        projectId: 'project-a',
        worktreeId: 'wt-a',
        chatId: 'chat-a',
      }),
    ).resolves.toEqual({ ok: true, stopped: 3 });

    expect(mockInvoke).toHaveBeenNthCalledWith(
      1,
      IPC_CHANNELS.managedDelegationActivityList,
    );
    expect(mockInvoke).toHaveBeenNthCalledWith(
      2,
      IPC_CHANNELS.managedDelegationStop,
      {
        projectId: 'project-a',
        worktreeId: 'wt-a',
        chatId: 'chat-a',
        delegationId: 'delegation-1',
      },
    );
    expect(mockInvoke).toHaveBeenNthCalledWith(
      3,
      IPC_CHANNELS.managedDelegationStopAll,
      { projectId: 'project-a', worktreeId: 'wt-a', chatId: 'chat-a' },
    );
  });

  it('invokes every viewer read and user-message channel unchanged', async () => {
    const api = loadManagedDelegationApi();
    const target = {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
    };
    const transcript = {
      ...target,
      delegationId: 'child',
      beforeSequence: 10,
      limit: 100,
    };
    const message = {
      ...target,
      delegationId: 'child',
      operation: 'steer' as const,
      operationId: '11111111-1111-4111-8111-111111111111',
      message: 'Review it',
    };
    const summary = {
      projectId: 'project',
      worktreeId: 'worktree',
      delegationId: 'child',
      revision: 'a'.repeat(40),
    };
    mockInvoke.mockResolvedValue({ ok: false, error: 'read unavailable' });
    await api.message(message);
    await api.tree(target);
    await api.transcriptPage(transcript);
    await api.roots({ projectId: 'project', worktreeId: 'worktree' });
    await api.worktreeSummary(summary);
    expect(mockInvoke.mock.calls).toEqual([
      [IPC_CHANNELS.managedDelegationMessage, message],
      [IPC_CHANNELS.managedDelegationTree, target],
      [IPC_CHANNELS.managedDelegationTranscriptPage, transcript],
      [
        IPC_CHANNELS.managedDelegationRoots,
        { projectId: 'project', worktreeId: 'worktree' },
      ],
      [IPC_CHANNELS.managedDelegationWorktreeSummary, summary],
    ]);
  });
  it('exposes the native child interrupt separately from managed stop', async () => {
    loadManagedDelegationApi();
    const api = exposed.get('api');
    if (!isCanopyApi(api)) throw new Error('API missing');
    const request = {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      subagentKind: 'claude-native' as const,
      subagentId: 'toolu_child',
    };
    mockInvoke.mockResolvedValueOnce({
      ok: false,
      code: 'unsupported',
      error: 'Foreground task',
    });
    await expect(api.nativeSubagents.interrupt(request)).resolves.toMatchObject(
      { ok: false, code: 'unsupported' },
    );
    expect(mockInvoke).toHaveBeenCalledWith(
      IPC_CHANNELS.nativeSubagentInterrupt,
      request,
    );
  });

  it('invokes the changes channel with the request', async (): Promise<void> => {
    const managedDelegation = loadManagedDelegationApi();
    const request = {
      projectId: 'project-a',
      worktreeId: 'wt-a',
      delegationId: 'delegation-1',
      revision: 'a'.repeat(40),
    };
    mockInvoke.mockResolvedValueOnce({ ok: true, changes: { files: [] } });

    await expect(managedDelegation.changes(request)).resolves.toEqual({
      ok: true,
      changes: { files: [] },
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      IPC_CHANNELS.managedDelegationChanges,
      request,
    );
  });

  it('delivers activity changes and removes the exact listener', (): void => {
    const managedDelegation = loadManagedDelegationApi();
    const callback = jest.fn();
    const unsubscribe = managedDelegation.onActivityChanged(callback);
    const handler = registeredActivityHandler();

    handler(undefined, ACTIVITY);
    expect(callback).toHaveBeenCalledWith(ACTIVITY);

    unsubscribe();
    expect(mockRemoveListener).toHaveBeenCalledWith(
      IPC_CHANNELS.managedDelegationActivityChanged,
      handler,
    );
  });
});
