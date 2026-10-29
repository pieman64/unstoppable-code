import {
  IPC_CHANNELS,
  type BrowserApi,
  type BrowserListTransfersRequest,
  type BrowserSetActiveRequest,
  type BrowserTransferCommand,
  type CanopyApi,
} from '@canopy/desktop-shared/types';

type IpcRendererListener = (event: unknown, data: unknown) => void;

const exposed = new Map<string, unknown>();
const mockExposeInMainWorld = jest.fn<void, [string, unknown]>(
  (key, value): void => {
    exposed.set(key, value);
  },
);
const mockInvoke = jest.fn<Promise<unknown>, [string, ...unknown[]]>();
const mockOn = jest.fn<void, [string, IpcRendererListener]>();
const mockRemoveListener = jest.fn<void, [string, IpcRendererListener]>();
const mockSendSync = jest.fn<unknown, [string]>(() => ({
  claude: [],
  codex: [],
  ollama: [],
  aliases: {},
}));

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
  createBundlesAPI: (): object => ({}),
}));
jest.mock('../api/pipelines-api', () => ({
  createPipelinesAPI: (): object => ({}),
}));
jest.mock('../api/plugins-api', () => ({
  createPluginsAPI: (): object => ({}),
}));
jest.mock('../api/mcp-servers-api', () => ({
  createMcpServersAPI: (): object => ({}),
}));
jest.mock('../api/skills-api', () => ({ createSkillsAPI: (): object => ({}) }));

function loadBrowserApi(): BrowserApi {
  exposed.clear();
  jest.isolateModules((): void => {
    Object.defineProperty(process, 'contextIsolated', {
      configurable: true,
      value: true,
    });
    jest.requireActual('../index');
  });
  const api = exposed.get('api') as CanopyApi | undefined;
  if (!api) throw new Error('preload API was not exposed');
  return api.browser;
}

describe('preload browser API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('versions user profile commands and preserves structured permission errors', async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true, value: { profiles: [] } });
    const api = loadBrowserApi();
    expect(await api.profiles.list()).toEqual({ profiles: [] });
    expect(mockInvoke).toHaveBeenCalledWith(IPC_CHANNELS.browserProfiles, {
      schemaVersion: 1,
      method: 'list',
      request: {},
    });
    mockInvoke.mockResolvedValueOnce({
      ok: false,
      error: { code: 'stale_revision', message: 'Refresh this profile.' },
    });
    await expect(
      api.profiles.get({ profileId: 'profile' }),
    ).rejects.toMatchObject({
      code: 'stale_revision',
      message: 'Refresh this profile.',
    });
  });

  it('invokes browser:set-active with the untouched request and resolves void', async () => {
    const request: BrowserSetActiveRequest = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      browserId: 'browser-1',
    };
    mockInvoke.mockResolvedValue(undefined);

    await expect(loadBrowserApi().setActive(request)).resolves.toBeUndefined();

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith(
      IPC_CHANNELS.browserSetActive,
      request,
    );
    expect(mockInvoke.mock.calls[0]?.[1]).toBe(request);
  });

  it('captures the last delivered generation and rejects an old response after switching', async () => {
    const api = loadBrowserApi();
    api.onEvent(() => undefined);
    const event = mockOn.mock.calls.find(
      (call) => call[0] === IPC_CHANNELS.browserEvent,
    )?.[1];
    event?.(
      {},
      {
        type: 'snapshot',
        browserId: 'browser-1',
        snapshot: { id: 'browser-1', profile: { runtimeGeneration: 1 } },
      },
    );
    let complete: ((value: unknown) => void) | undefined;
    mockInvoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const pending = api.screenshot({ browserId: 'browser-1' });
    expect(mockInvoke).toHaveBeenCalledWith(IPC_CHANNELS.browserScreenshot, {
      browserId: 'browser-1',
      expectedRuntimeGeneration: 1,
    });
    event?.(
      {},
      {
        type: 'snapshot',
        browserId: 'browser-1',
        snapshot: { id: 'browser-1', profile: { runtimeGeneration: 2 } },
      },
    );
    complete?.({ dataUrl: 'old-account-image' });
    await expect(pending).rejects.toMatchObject({ code: 'stale_runtime' });
    mockInvoke.mockResolvedValue(undefined);
    await expect(
      api.navigate({
        browserId: 'browser-1',
        expectedRuntimeGeneration: 1,
        url: 'https://example.test',
      }),
    ).rejects.toMatchObject({ code: 'stale_runtime' });
    expect(
      mockInvoke.mock.calls[mockInvoke.mock.calls.length - 1]?.[1],
    ).toMatchObject({
      expectedRuntimeGeneration: 1,
    });
  });

  it.each([
    {
      allow: true,
      value: {
        ok: true,
        completed: false,
        receipt: { status: 'outcome_unknown', outcomeReason: 'runtime_lost' },
      },
    },
    {
      allow: false,
      value: {
        ok: true,
        completed: false,
        browser: {},
        receipt: { status: 'outcome_unknown', outcomeReason: 'runtime_lost' },
      },
    },
    {
      allow: false,
      value: {
        ok: true,
        completed: false,
        receipt: {
          status: 'outcome_unknown',
          outcomeReason: 'dispatch_timeout',
        },
      },
    },
    {
      allow: false,
      value: { ok: true, completed: true, receipt: { status: 'executed' } },
    },
  ])(
    'preserves only the snapshot-free runtime-lost automation receipt across an epoch event ($allow)',
    async ({ allow, value }) => {
      const api = loadBrowserApi();
      api.onEvent(() => undefined);
      const event = mockOn.mock.calls.find(
        (call) => call[0] === IPC_CHANNELS.browserEvent,
      )?.[1];
      event?.(
        {},
        {
          type: 'snapshot',
          browserId: 'browser-1',
          snapshot: { id: 'browser-1', profile: { runtimeGeneration: 4 } },
        },
      );
      let complete: (value: unknown) => void = () => {};
      mockInvoke.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
      const pending = api.automation({
        browserId: 'browser-1',
        command: { kind: 'press', key: 'Enter' },
      });
      event?.(
        {},
        {
          type: 'snapshot',
          browserId: 'browser-1',
          snapshot: { id: 'browser-1', profile: { runtimeGeneration: 5 } },
        },
      );
      complete(value);
      if (allow) await expect(pending).resolves.toEqual(value);
      else
        await expect(pending).rejects.toMatchObject({ code: 'stale_runtime' });
    },
  );

  it('does not apply the runtime-lost exception to another browser channel', async () => {
    const api = loadBrowserApi();
    api.onEvent(() => undefined);
    const event = mockOn.mock.calls.find(
      (call) => call[0] === IPC_CHANNELS.browserEvent,
    )?.[1];
    event?.(
      {},
      {
        type: 'snapshot',
        snapshot: { id: 'browser-1', profile: { runtimeGeneration: 4 } },
      },
    );
    let complete: (value: unknown) => void = () => {};
    mockInvoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const pending = api.screenshot({ browserId: 'browser-1' });
    event?.(
      {},
      {
        type: 'snapshot',
        snapshot: { id: 'browser-1', profile: { runtimeGeneration: 5 } },
      },
    );
    complete({
      ok: true,
      completed: false,
      receipt: { status: 'outcome_unknown', outcomeReason: 'runtime_lost' },
    });
    await expect(pending).rejects.toMatchObject({ code: 'stale_runtime' });
  });

  describe('transfers', () => {
    it('invokes browser:list-transfers with the untouched request and resolves the result', async () => {
      const request: BrowserListTransfersRequest = {
        browserId: 'browser-1',
        status: 'paused',
        limit: 10,
      };
      const result = { transfers: [], total: 0, offset: 0, limit: 10 };
      mockInvoke.mockResolvedValue(result);

      await expect(loadBrowserApi().listTransfers(request)).resolves.toBe(
        result,
      );

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke.mock.calls[0]?.[0]).toBe(
        IPC_CHANNELS.browserListTransfers,
      );
      expect(mockInvoke.mock.calls[0]?.[1]).toBe(request);
    });

    it('invokes browser:transfer-command with the untouched command and resolves the result', async () => {
      const command: BrowserTransferCommand = {
        kind: 'cancel',
        browserId: 'browser-1',
        transferId: 'transfer-1',
      };
      const result = { ok: true };
      mockInvoke.mockResolvedValue(result);

      await expect(loadBrowserApi().transferCommand(command)).resolves.toBe(
        result,
      );

      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockInvoke.mock.calls[0]?.[0]).toBe(
        IPC_CHANNELS.browserTransferCommand,
      );
      expect(mockInvoke.mock.calls[0]?.[1]).toBe(command);
    });

    it('is not runtime-generation scoped: no generation is sent and a mid-call generation change does not reject', async () => {
      const api = loadBrowserApi();
      api.onEvent(() => undefined);
      const event = mockOn.mock.calls.find(
        (call) => call[0] === IPC_CHANNELS.browserEvent,
      )?.[1];
      event?.(
        {},
        {
          type: 'snapshot',
          browserId: 'browser-1',
          snapshot: { id: 'browser-1', profile: { runtimeGeneration: 1 } },
        },
      );
      let complete: ((value: unknown) => void) | undefined;
      mockInvoke.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
      const request: BrowserListTransfersRequest = { browserId: 'browser-1' };
      const pending = api.listTransfers(request);
      expect(mockInvoke.mock.calls[0]?.[1]).toBe(request);
      expect(request).not.toHaveProperty('expectedRuntimeGeneration');
      event?.(
        {},
        {
          type: 'snapshot',
          browserId: 'browser-1',
          snapshot: { id: 'browser-1', profile: { runtimeGeneration: 2 } },
        },
      );
      const result = { transfers: [], total: 0, offset: 0, limit: 25 };
      complete?.(result);
      await expect(pending).resolves.toBe(result);

      mockInvoke.mockResolvedValue({ ok: true });
      await expect(
        api.transferCommand({ kind: 'allow_more', browserId: 'browser-1' }),
      ).resolves.toEqual({ ok: true });
      expect(mockInvoke.mock.calls[1]?.[1]).toStrictEqual({
        kind: 'allow_more',
        browserId: 'browser-1',
      });
    });
  });

  it('propagates invocation failures', async () => {
    const error = new Error('set-active failed');
    mockInvoke.mockRejectedValue(error);

    await expect(
      loadBrowserApi().setActive({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: null,
      }),
    ).rejects.toBe(error);
  });
});
