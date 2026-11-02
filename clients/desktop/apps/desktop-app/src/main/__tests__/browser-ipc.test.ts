import type { BrowserService } from '../browser/browser-service';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const mockWithRuntimeTarget = jest.fn<
  ReturnType<BrowserService['withRuntimeTarget']>,
  Parameters<BrowserService['withRuntimeTarget']>
>((...args) => Promise.resolve(args[1]()));
const listeners = new Map<string, (...args: unknown[]) => void>();
const mockCreate = jest.fn();
const mockProfileReady = jest.fn().mockResolvedValue(undefined);
const mockDestroy = jest.fn();
const mockDisposeLiveView = jest.fn();
const mockLoadWorktreeState = jest.fn();
const mockListWorktreeBrowsers = jest.fn();
const mockSetActiveBrowser = jest.fn();
const mockGetDialog = jest.fn();
const mockHandleDialog = jest.fn();
const mockOpenExternal = jest.fn();
const mockOpenFilePageExternally = jest.fn();
const mockAutomation = jest.fn();
const mockFromWebContents = jest.fn();
const mockGetUserInteractionGeneration = jest.fn(() => 0);
const mockRouteAppLink = jest.fn();
const mockResolveAppLinkRequest = jest.fn();
const mockGetDefaultBrowserStatus = jest.fn(() => ({
  enabled: true,
  registered: false,
  platform: 'win32' as const,
  failure: 'user-action-required' as const,
}));
const mockRefreshDefaultBrowserStatus = jest.fn(() => ({
  enabled: true,
  registered: true,
  platform: 'win32' as const,
}));
const mockLogMainProcessError = jest.fn();
const mockShowItemInFolder = jest.fn();
const mockListTransfers = jest.fn();
const mockTransferCommand = jest.fn<
  Promise<unknown>,
  [
    unknown,
    {
      revealInFolder(path: string): void;
      chooseSavePath?(defaultName: string): Promise<string | undefined>;
    },
  ]
>();
const mockSaveDownload = jest.fn<Promise<unknown>, [unknown]>();
const mockSavePdf = jest.fn<Promise<unknown>, [unknown]>();
const mockGetFileChooser = jest.fn();
const mockGetPrintRequest = jest.fn();
const mockAnswerPrintRequest = jest.fn<Promise<unknown>, [unknown]>();
const mockGetAuthRequest = jest.fn();
const mockAnswerAuthRequest = jest.fn<{ ok: boolean }, [unknown]>();
const mockAnswerFileChooser = jest.fn<Promise<unknown>, [unknown]>();
const mockShowSaveDialog = jest.fn<
  Promise<{ canceled: boolean; filePath?: string }>,
  unknown[]
>();
const mockSetLinkBrowserTargetAvailable = jest.fn<void, [boolean]>();

jest.mock('electron', () => ({
  BrowserWindow: {
    get fromWebContents(): typeof mockFromWebContents {
      return mockFromWebContents;
    },
  },
  shell: {
    get showItemInFolder(): typeof mockShowItemInFolder {
      return mockShowItemInFolder;
    },
  },
  dialog: {
    get showSaveDialog(): typeof mockShowSaveDialog {
      return mockShowSaveDialog;
    },
  },
  app: { getPath: jest.fn(() => '/Users/me/Downloads') },
  ipcMain: {
    removeHandler: jest.fn((channel: string) => {
      handlers.delete(channel);
    }),
    handle: jest.fn(
      (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      },
    ),
    on: jest.fn((channel: string, listener: (...args: unknown[]) => void) => {
      listeners.set(channel, listener);
    }),
  },
}));

jest.mock('../browser/browser-service', () => ({
  BrowserService: jest.fn().mockImplementation(() => ({
    withRuntimeTarget: mockWithRuntimeTarget,
    profileData: { ensureReady: mockProfileReady },
    create: mockCreate,
    destroy: mockDestroy,
    disposeLiveView: mockDisposeLiveView,
    loadWorktreeState: mockLoadWorktreeState,
    listWorktreeBrowsers: mockListWorktreeBrowsers,
    setActiveBrowser: mockSetActiveBrowser,
    saveWorktreeState: jest.fn(),
    setBounds: jest.fn(),
    setVisible: jest.fn(),
    navigate: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
    reload: jest.fn(),
    stop: jest.fn(),
    setTheme: jest.fn(),
    setPickMode: jest.fn(),
    startRecording: jest.fn(),
    stopRecording: jest.fn(),
    clearRecording: jest.fn(),
    getRecording: jest.fn(),
    openExternal: mockOpenExternal,
    openFilePageExternally: mockOpenFilePageExternally,
    getConsole: jest.fn(),
    getNetwork: jest.fn(),
    screenshot: jest.fn(),
    inspect: jest.fn(),
    getDialog: mockGetDialog,
    handleDialog: mockHandleDialog,
    automation: mockAutomation,
    getUserInteractionGeneration: mockGetUserInteractionGeneration,
    listTransfers: mockListTransfers,
    transferCommand: mockTransferCommand,
    saveDownload: mockSaveDownload,
    savePdf: mockSavePdf,
    getFileChooser: mockGetFileChooser,
    getPrintRequest: mockGetPrintRequest,
    answerPrintRequest: mockAnswerPrintRequest,
    getAuthRequest: mockGetAuthRequest,
    answerAuthRequest: mockAnswerAuthRequest,
    answerFileChooser: mockAnswerFileChooser,
  })),
}));

jest.mock('../browser/app-link-router', () => ({
  routeAppLink: (...args: unknown[]): unknown => mockRouteAppLink(...args),
  resolveAppLinkRequest: (...args: unknown[]): unknown =>
    mockResolveAppLinkRequest(...args),
}));

jest.mock('../browser/default-browser-registration', () => ({
  getDefaultBrowserRegistrationService: (): {
    getStatus: typeof mockGetDefaultBrowserStatus;
    refresh: typeof mockRefreshDefaultBrowserStatus;
  } => ({
    getStatus: mockGetDefaultBrowserStatus,
    refresh: mockRefreshDefaultBrowserStatus,
  }),
}));

jest.mock('../lib/main-process-logging', () => ({
  get logMainProcessError(): typeof mockLogMainProcessError {
    return mockLogMainProcessError;
  },
}));

jest.mock('../lib/link-context-menu', () => ({
  setLinkBrowserTargetAvailable: (available: boolean): void =>
    mockSetLinkBrowserTargetAvailable(available),
}));

import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { registerBrowserHandlers } from '../ipc/browser';

describe('browser IPC handlers', () => {
  beforeEach(() => {
    handlers.clear();
    listeners.clear();
    jest.clearAllMocks();
    mockProfileReady.mockResolvedValue(undefined);
    mockFromWebContents.mockReturnValue(null);
    mockListWorktreeBrowsers.mockReturnValue([]);
    mockSetActiveBrowser.mockResolvedValue(undefined);
  });

  it('W1 starts persisted profile recovery at handler registration without waiting or creating a Session', () => {
    mockProfileReady.mockReturnValueOnce(new Promise(() => {}));
    registerBrowserHandlers(() => null);
    expect(mockProfileReady).toHaveBeenCalledTimes(1);
    expect(handlers.has(IPC_CHANNELS.browserProfiles)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.browserCreate)).toBe(true);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('W1 surfaces startup profile recovery failure without leaving an unhandled rejection', async () => {
    const failure = new Error('Unreadable profile recovery metadata');
    mockProfileReady.mockRejectedValueOnce(failure);
    registerBrowserHandlers(() => null);
    await Promise.resolve();
    expect(mockLogMainProcessError).toHaveBeenCalledWith(
      '[Browser] Profile startup recovery failed',
      failure,
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('registers browser lifecycle handlers and delegates create/destroy/dispose/load', async () => {
    mockCreate.mockResolvedValue({ id: 'browser-1' });
    mockDestroy.mockResolvedValue(undefined);
    mockDisposeLiveView.mockResolvedValue(undefined);
    mockLoadWorktreeState.mockReturnValue({ status: 'missing', state: null });

    registerBrowserHandlers(() => null);

    await handlers.get(IPC_CHANNELS.browserCreate)?.(
      {
        sender: {
          focus: jest.fn(),
          isDestroyed: jest.fn(() => false),
          isFocused: jest.fn(() => false),
        },
      },
      { projectId: 'project-1', worktreeId: 'worktree-1' },
    );
    await handlers.get(IPC_CHANNELS.browserDestroy)?.(
      {},
      { browserId: 'browser-1' },
    );
    await handlers.get(IPC_CHANNELS.browserDisposeLiveView)?.(
      {},
      { browserId: 'browser-1' },
    );
    const loaded = await handlers.get(IPC_CHANNELS.browserLoadWorktreeState)?.(
      {},
      { projectId: 'project-1', worktreeId: 'worktree-1' },
    );

    expect(mockCreate).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
    expect(mockDestroy).toHaveBeenCalledWith('browser-1');
    expect(mockDisposeLiveView).toHaveBeenCalledWith('browser-1');
    expect(loaded).toEqual({ status: 'missing', state: null });
  });

  it('rejects future profile command envelopes before reading or mutating profiles', async () => {
    registerBrowserHandlers(() => null);
    const response = await handlers.get(IPC_CHANNELS.browserProfiles)?.(
      {},
      {
        schemaVersion: 2,
        method: 'create',
        request: {
          operationId: 'future',
          input: { displayName: 'Future profile' },
        },
      },
    );
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
  });

  it('rejects noncanonical ids at the browser-profile IPC boundary', async () => {
    registerBrowserHandlers(() => null);
    const response = await handlers.get(IPC_CHANNELS.browserProfiles)?.(
      {},
      {
        schemaVersion: 1,
        method: 'jobGet',
        request: { jobId: 'NOT_CANONICAL' },
      },
    );
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
  });

  it('validates browser id payloads before delegating browser operations', async () => {
    registerBrowserHandlers(() => null);

    for (const channel of [
      IPC_CHANNELS.browserBack,
      IPC_CHANNELS.browserForward,
      IPC_CHANNELS.browserReload,
      IPC_CHANNELS.browserStop,
      IPC_CHANNELS.browserStartRecording,
      IPC_CHANNELS.browserStopRecording,
      IPC_CHANNELS.browserClearRecording,
      IPC_CHANNELS.browserGetRecording,
      IPC_CHANNELS.browserGetConsole,
      IPC_CHANNELS.browserGetNetwork,
      IPC_CHANNELS.browserScreenshot,
      IPC_CHANNELS.browserInspect,
      IPC_CHANNELS.browserGetDialog,
      IPC_CHANNELS.browserHandleDialog,
      IPC_CHANNELS.browserAutomation,
    ]) {
      await expect(
        (async (): Promise<void> => {
          await handlers.get(channel)?.({}, { browserId: '../bad-browser-id' });
        })(),
      ).rejects.toThrow('Invalid browserId');
    }
  });

  it('rejects an unknown screenshot purpose before delegating', async () => {
    registerBrowserHandlers(() => null);

    await expect(
      (async (): Promise<void> => {
        await handlers.get(IPC_CHANNELS.browserScreenshot)?.(
          {},
          { browserId: 'browser-1', purpose: 'thumbnail' },
        );
      })(),
    ).rejects.toThrow('Invalid browser screenshot purpose');
  });

  it('rejects an automation request without an explicit captured tab before dispatch', async () => {
    registerBrowserHandlers(() => null);
    const handler = handlers.get(IPC_CHANNELS.browserAutomation);
    await expect(
      Promise.resolve().then(() =>
        handler?.(
          { sender: { isFocused: () => false, isDestroyed: () => true } },
          {
            projectId: 'project',
            worktreeId: 'task',
            command: { kind: 'press', key: 'Enter' },
          },
        ),
      ),
    ).rejects.toThrow('explicit browserId');
    expect(mockAutomation).not.toHaveBeenCalled();
  });

  it('returns invalid_payload for malformed automation commands before runtime admission', async () => {
    registerBrowserHandlers(() => null);
    const handler = handlers.get(IPC_CHANNELS.browserAutomation);
    const sender = {
      isFocused: (): boolean => false,
      isDestroyed: (): boolean => true,
    };
    const commands: unknown[] = [
      { kind: 'future-command' },
      { kind: 'click', clickCount: 0 },
      { kind: 'click', clickCount: 1.5 },
      { kind: 'click', position: { x: -1, y: 2 } },
      { kind: 'click', position: { x: 1, y: Number.POSITIVE_INFINITY } },
      { kind: 'click', timeoutMs: 60_001 },
      { kind: 'wait_for', locator: 'button', timeoutMs: 120_001 },
    ];

    for (const command of commands) {
      const result = await handler?.(
        { sender },
        { browserId: 'browser-1', command },
      );
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'invalid_payload' },
      });
    }

    expect(mockWithRuntimeTarget).not.toHaveBeenCalled();
    expect(mockAutomation).not.toHaveBeenCalled();
  });

  it('accepts zero timeoutMs and passes the validated command through', async () => {
    mockAutomation.mockResolvedValueOnce({ ok: true, completed: true });
    registerBrowserHandlers(() => null);
    const request = {
      browserId: 'browser-1',
      command: { kind: 'wait_for', locator: 'button', timeoutMs: 0 },
    };

    await expect(
      handlers.get(IPC_CHANNELS.browserAutomation)?.(
        { sender: { isFocused: () => false, isDestroyed: () => true } },
        request,
      ),
    ).resolves.toMatchObject({ ok: true, completed: true });
    expect(mockAutomation).toHaveBeenCalledWith(
      request,
      expect.any(AbortSignal),
    );
  });

  it('passes a checked approval chat with an upload and refuses a malformed one', async () => {
    mockAutomation.mockResolvedValueOnce({ ok: true, completed: true });
    registerBrowserHandlers(() => null);
    const sender = {
      isFocused: (): boolean => false,
      isDestroyed: (): boolean => true,
    };
    const request = {
      browserId: 'browser-1',
      approvalChat: {
        projectId: 'app-advisor',
        worktreeId: 'profile-advisor',
        chatId: 'chat-1',
        extra: 'dropped',
      },
      command: {
        kind: 'upload_files',
        ref: 'r-1',
        files: [{ path: 'exports/report.csv' }],
      },
    };
    await expect(
      handlers.get(IPC_CHANNELS.browserAutomation)?.({ sender }, request),
    ).resolves.toMatchObject({ ok: true });
    expect(mockAutomation).toHaveBeenCalledWith(
      {
        ...request,
        approvalChat: {
          projectId: 'app-advisor',
          worktreeId: 'profile-advisor',
          chatId: 'chat-1',
        },
      },
      expect.any(AbortSignal),
    );

    mockAutomation.mockClear();
    for (const approvalChat of [
      'chat-1',
      { projectId: 'p', worktreeId: 'w' },
      { projectId: '../p', worktreeId: 'w', chatId: 'c' },
    ])
      await expect(
        handlers.get(IPC_CHANNELS.browserAutomation)?.(
          { sender },
          { ...request, approvalChat },
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_payload', message: 'Invalid approvalChat.' },
      });
    expect(mockAutomation).not.toHaveBeenCalled();
  });

  it('returns invalid_payload instead of throwing for an invalid cancellation key', async () => {
    registerBrowserHandlers(() => null);
    const result = await handlers.get(IPC_CHANNELS.browserAutomation)?.(
      { sender: { isFocused: () => false, isDestroyed: () => true } },
      {
        browserId: 'browser-1',
        cancellationKey: '../invalid-key',
        command: { kind: 'press', key: 'Enter' },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_payload' },
    });
    expect(mockWithRuntimeTarget).not.toHaveBeenCalled();
    expect(mockAutomation).not.toHaveBeenCalled();
  });

  it('passes a cancellable signal into automation and unregisters after completion', async () => {
    const { cancelBrowserAutomation } =
      await import('../browser/automation-cancellation');
    mockAutomation.mockImplementationOnce(
      (_request: unknown, signal: AbortSignal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => resolve({ ok: true, completed: true }),
            { once: true },
          );
        }),
    );
    registerBrowserHandlers(() => null);
    const key = 'automation-request-1';
    const pending = handlers.get(IPC_CHANNELS.browserAutomation)?.(
      { sender: { isFocused: () => false, isDestroyed: () => true } },
      {
        browserId: 'browser-1',
        cancellationKey: key,
        command: { kind: 'press', key: 'Enter' },
      },
    );
    await Promise.resolve();

    expect(mockAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ cancellationKey: key }),
      expect.any(AbortSignal),
    );
    expect(cancelBrowserAutomation(key)).toBe(true);
    await expect(pending).resolves.toMatchObject({ ok: true, completed: true });
    expect(cancelBrowserAutomation(key)).toBe(false);
  });

  it('aborts late-registered automation before dispatching input', async () => {
    const { cancelBrowserAutomation } =
      await import('../browser/automation-cancellation');
    const key = 'automation-cancel-before-register';
    expect(cancelBrowserAutomation(key)).toBe(false);
    let receivedSignal: AbortSignal | undefined;
    let inputRuns = 0;
    mockAutomation.mockImplementationOnce(
      (_request: unknown, signal: AbortSignal) => {
        receivedSignal = signal;
        if (!signal.aborted) inputRuns += 1;
        return Promise.resolve({ ok: true, completed: true });
      },
    );
    registerBrowserHandlers(() => null);

    await expect(
      handlers.get(IPC_CHANNELS.browserAutomation)?.(
        { sender: { isFocused: () => false, isDestroyed: () => true } },
        {
          browserId: 'browser-1',
          cancellationKey: key,
          command: { kind: 'press', key: 'Enter' },
        },
      ),
    ).resolves.toMatchObject({ ok: true, completed: true });

    expect(receivedSignal?.aborted).toBe(true);
    expect(inputRuns).toBe(0);
  });

  it('cancels every automation controller registered under the same key', async () => {
    const { cancelBrowserAutomation, registerBrowserAutomationCancellation } =
      await import('../browser/automation-cancellation');
    const first = new AbortController();
    const second = new AbortController();
    registerBrowserAutomationCancellation('duplicate-key', first);
    registerBrowserAutomationCancellation('duplicate-key', second);

    expect(cancelBrowserAutomation('duplicate-key')).toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(cancelBrowserAutomation('duplicate-key')).toBe(false);
  });

  it('unregisters only its controller when a cancellation key has duplicates', async () => {
    const { cancelBrowserAutomation, registerBrowserAutomationCancellation } =
      await import('../browser/automation-cancellation');
    const first = new AbortController();
    const second = new AbortController();
    const unregisterFirst = registerBrowserAutomationCancellation(
      'duplicate-unregister-key',
      first,
    );
    registerBrowserAutomationCancellation('duplicate-unregister-key', second);

    unregisterFirst();

    expect(cancelBrowserAutomation('duplicate-unregister-key')).toBe(true);
    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(true);
  });

  it('bounds cancellation tombstones and expires them after one minute', async () => {
    const { cancelBrowserAutomation, registerBrowserAutomationCancellation } =
      await import('../browser/automation-cancellation');
    jest.useFakeTimers();
    try {
      const expiredKey = 'expired-browser-cancellation';
      expect(cancelBrowserAutomation(expiredKey)).toBe(false);
      jest.advanceTimersByTime(60_001);
      const expiredController = new AbortController();
      const unregisterExpired = registerBrowserAutomationCancellation(
        expiredKey,
        expiredController,
      );
      expect(expiredController.signal.aborted).toBe(false);
      unregisterExpired();

      const firstKey = 'bounded-browser-cancellation-0';
      const latestKey = 'bounded-browser-cancellation-256';
      for (let index = 0; index <= 256; index += 1) {
        expect(
          cancelBrowserAutomation(`bounded-browser-cancellation-${index}`),
        ).toBe(false);
      }

      const evictedController = new AbortController();
      const unregisterEvicted = registerBrowserAutomationCancellation(
        firstKey,
        evictedController,
      );
      expect(evictedController.signal.aborted).toBe(false);
      unregisterEvicted();

      const latestController = new AbortController();
      const unregisterLatest = registerBrowserAutomationCancellation(
        latestKey,
        latestController,
      );
      expect(latestController.signal.aborted).toBe(true);
      unregisterLatest();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a stale expected generation before entering the automation lane', async () => {
    const { cancelBrowserAutomation } =
      await import('../browser/automation-cancellation');
    mockWithRuntimeTarget.mockRejectedValueOnce(
      new Error('Stale browser runtime generation'),
    );
    registerBrowserHandlers(() => null);

    await expect(
      handlers.get(IPC_CHANNELS.browserAutomation)?.(
        { sender: { isFocused: () => false, isDestroyed: () => true } },
        {
          browserId: 'browser-1',
          expectedRuntimeGeneration: 4,
          cancellationKey: 'stale-generation-action',
          command: { kind: 'press', key: 'Enter' },
        },
      ),
    ).rejects.toThrow('Stale browser runtime generation');
    expect(mockWithRuntimeTarget).toHaveBeenCalledWith(
      { browserId: 'browser-1', expectedRuntimeGeneration: 4 },
      expect.any(Function),
    );
    expect(mockAutomation).not.toHaveBeenCalled();
    expect(cancelBrowserAutomation('stale-generation-action')).toBe(false);
  });

  it('returns focus to the invoking renderer after browser automation', async () => {
    let rendererFocused = true;
    const focus = jest.fn(() => {
      rendererFocused = true;
    });
    const sender = {
      focus,
      isDestroyed: jest.fn(() => false),
      isFocused: jest.fn(() => rendererFocused),
    };
    mockFromWebContents.mockReturnValue({
      isDestroyed: jest.fn(() => false),
      isFocused: jest.fn(() => true),
    });
    mockAutomation.mockImplementation(() => {
      rendererFocused = false;
      return Promise.resolve({ ok: true, completed: true });
    });
    registerBrowserHandlers(() => null);

    await handlers.get(IPC_CHANNELS.browserAutomation)?.(
      { sender },
      { browserId: 'browser-1', command: { kind: 'press', key: 'Enter' } },
    );

    expect(mockAutomation).toHaveBeenCalledTimes(1);
    expect(mockFromWebContents).toHaveBeenCalledWith(sender);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('does not restore renderer focus after browser-page user interaction', async () => {
    let rendererFocused = true;
    let interactionGeneration = 0;
    let finishAutomation: (() => void) | undefined;
    const focus = jest.fn(() => {
      rendererFocused = true;
    });
    const sender = {
      focus,
      isDestroyed: jest.fn(() => false),
      isFocused: jest.fn(() => rendererFocused),
    };
    mockFromWebContents.mockReturnValue({
      isDestroyed: jest.fn(() => false),
      isFocused: jest.fn(() => true),
    });
    mockGetUserInteractionGeneration.mockImplementation(
      () => interactionGeneration,
    );
    mockAutomation.mockImplementation(
      () =>
        new Promise((resolve) => {
          rendererFocused = false;
          finishAutomation = (): void => {
            resolve({ ok: true, completed: true });
          };
        }),
    );
    registerBrowserHandlers(() => null);

    const pending = handlers.get(IPC_CHANNELS.browserAutomation)?.(
      { sender },
      { browserId: 'browser-1', command: { kind: 'press', key: 'Enter' } },
    );
    interactionGeneration += 1;
    finishAutomation?.();
    await pending;

    expect(focus).not.toHaveBeenCalled();
  });

  it.each(['1', null, { generation: 1 }])(
    'normalizes non-number automation generation %p before runtime admission',
    async (expectedRuntimeGeneration) => {
      mockAutomation.mockResolvedValue({ ok: true, completed: true });
      registerBrowserHandlers(() => null);
      await handlers.get(IPC_CHANNELS.browserAutomation)?.(
        { sender: { isFocused: () => false, isDestroyed: () => false } },
        {
          browserId: 'browser-1',
          expectedRuntimeGeneration,
          command: { kind: 'press', key: 'Enter' },
        },
      );
      expect(mockWithRuntimeTarget).toHaveBeenCalledWith(
        { browserId: 'browser-1', expectedRuntimeGeneration: undefined },
        expect.any(Function),
      );
    },
  );

  it('passes a post-dispatch unknown without a replacement snapshot', async () => {
    const receipt = {
      actionId: 'unknown-1',
      sequence: 1,
      kind: 'click',
      status: 'outcome_unknown',
      outcomeReason: 'runtime_lost',
      durationMs: 10,
    };
    mockAutomation.mockResolvedValueOnce({
      kind: 'post-dispatch-unknown',
      capturedRuntimeGeneration: 1,
      receipt,
    });
    registerBrowserHandlers(() => null);
    const result = await handlers.get(IPC_CHANNELS.browserAutomation)?.(
      { sender: { isFocused: () => false, isDestroyed: () => false } },
      {
        browserId: 'browser-1',
        expectedRuntimeGeneration: 1,
        command: { kind: 'click', ref: 'input-1' },
      },
    );
    expect(result).toEqual({ ok: true, completed: false, receipt });
    expect(result).not.toHaveProperty('browser');
  });

  it('preserves replay metadata when converting a post-dispatch unknown', async () => {
    const receipt = {
      actionId: 'unknown-1',
      sequence: 1,
      kind: 'click',
      status: 'outcome_unknown',
      outcomeReason: 'runtime_lost',
      durationMs: 10,
    };
    mockAutomation.mockResolvedValueOnce({
      kind: 'post-dispatch-unknown',
      capturedRuntimeGeneration: 1,
      repeated: true,
      dialog: { id: 'original-dialog' },
      handledDialog: { accept: true },
      receipt,
    });
    registerBrowserHandlers(() => null);
    const result = await handlers.get(IPC_CHANNELS.browserAutomation)?.(
      { sender: { isFocused: () => false, isDestroyed: () => false } },
      {
        browserId: 'browser-1',
        expectedRuntimeGeneration: 1,
        command: { kind: 'click', ref: 'input-1' },
      },
    );
    expect(result).toEqual({
      ok: true,
      completed: false,
      receipt,
      repeated: true,
      dialog: { id: 'original-dialog' },
      handledDialog: { accept: true },
    });
    expect(result).not.toHaveProperty('browser');
  });

  it('preserves predispatch error details and the additive receipt unchanged', async () => {
    const receipt = {
      actionId: 'disabled-1',
      sequence: 1,
      kind: 'fill',
      status: 'not_executed',
      durationMs: 10,
      error: { code: 'target_disabled', message: 'Disabled', retryable: true },
    };
    const failure = {
      ok: false,
      completed: false,
      receipt,
      error: { code: 'invalid_target', message: 'Disabled', details: receipt },
    };
    mockAutomation.mockResolvedValueOnce(failure);
    registerBrowserHandlers(() => null);
    const result = await handlers.get(IPC_CHANNELS.browserAutomation)?.(
      { sender: { isFocused: () => false, isDestroyed: () => false } },
      {
        browserId: 'browser-1',
        command: { kind: 'fill', ref: 'input-1', text: 'value' },
      },
    );
    expect(result).toEqual(failure);
  });

  it('validates and delegates browser JavaScript dialog operations', async () => {
    const dialog = {
      id: 'dialog-1',
      browserId: 'browser-1',
      type: 'confirm',
      message: 'Continue?',
      url: 'http://localhost:3000',
      openedAt: 1,
    };
    mockGetDialog.mockReturnValue(dialog);
    mockHandleDialog.mockResolvedValue({ dialog, accept: false });
    registerBrowserHandlers(() => null);

    const read = await handlers.get(IPC_CHANNELS.browserGetDialog)?.(
      {},
      { browserId: 'browser-1' },
    );
    const handled = await handlers.get(IPC_CHANNELS.browserHandleDialog)?.(
      {},
      {
        browserId: 'browser-1',
        dialogId: 'dialog-1',
        accept: false,
      },
    );

    expect(read).toEqual(dialog);
    expect(mockGetDialog).toHaveBeenCalledWith('browser-1');
    expect(handled).toEqual({ dialog, accept: false });
    expect(mockHandleDialog).toHaveBeenCalledWith({
      browserId: 'browser-1',
      dialogId: 'dialog-1',
      accept: false,
    });

    await expect(
      handlers.get(IPC_CHANNELS.browserHandleDialog)?.(
        {},
        {
          browserId: 'browser-1',
          dialogId: 'dialog-1',
          accept: 'yes',
        },
      ),
    ).rejects.toThrow('Invalid accept');
  });

  it('validates open-external URL payloads before delegating', async () => {
    registerBrowserHandlers(() => null);

    await expect(
      (async (): Promise<void> => {
        await handlers.get(IPC_CHANNELS.browserOpenExternal)?.(
          {},
          { url: undefined },
        );
      })(),
    ).rejects.toThrow('Invalid url: must be a string');
  });

  it('delegates a local file page to the session-bound opener', async () => {
    mockOpenFilePageExternally.mockResolvedValue(undefined);
    registerBrowserHandlers(() => null);

    await handlers.get(IPC_CHANNELS.browserOpenExternal)?.(
      {},
      { url: 'file:///tmp/site/index.html', browserId: 'browser-1' },
    );

    expect(mockOpenFilePageExternally).toHaveBeenCalledWith(
      'browser-1',
      'file:///tmp/site/index.html',
    );
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it.each([undefined, 42])(
    'rejects a local file page with browserId %p',
    async (browserId) => {
      registerBrowserHandlers(() => null);

      await expect(
        (async (): Promise<void> => {
          await handlers.get(IPC_CHANNELS.browserOpenExternal)?.(
            {},
            { url: 'file:///tmp/site/index.html', browserId },
          );
        })(),
      ).rejects.toThrow('Invalid browserId');
      expect(mockOpenFilePageExternally).not.toHaveBeenCalled();
      expect(mockOpenExternal).not.toHaveBeenCalled();
    },
  );

  it.each([{ browserId: 'browser-1' }, {}])(
    'keeps http pages on the always-external path (%p)',
    async (extra) => {
      mockOpenExternal.mockResolvedValue(undefined);
      registerBrowserHandlers(() => null);

      await handlers.get(IPC_CHANNELS.browserOpenExternal)?.(
        {},
        { url: 'https://example.com', ...extra },
      );

      expect(mockOpenExternal).toHaveBeenCalledWith('https://example.com');
      expect(mockOpenFilePageExternally).not.toHaveBeenCalled();
    },
  );

  it('validates and delegates app-link URL payloads', async () => {
    mockRouteAppLink.mockResolvedValue('in-app');
    registerBrowserHandlers(() => null);
    const sender = { id: 7 };

    await expect(
      handlers.get(IPC_CHANNELS.browserOpenLink)?.(
        { sender },
        { url: undefined },
      ),
    ).rejects.toThrow('Invalid url: must be a string');

    await expect(
      handlers.get(IPC_CHANNELS.browserOpenLink)?.(
        { sender },
        { url: 'file:///tmp/not-web-content' },
      ),
    ).rejects.toThrow('Invalid url: must be an http or https URL');
    expect(mockRouteAppLink).not.toHaveBeenCalled();

    await expect(
      handlers.get(IPC_CHANNELS.browserOpenLink)?.(
        { sender },
        { url: 'https://example.com' },
      ),
    ).resolves.toBeUndefined();
    expect(mockRouteAppLink).toHaveBeenCalledWith({
      url: 'https://example.com',
      sender,
      source: 'app-link',
    });
  });

  it('takes link browser target reports as one-way messages', () => {
    registerBrowserHandlers(() => null);
    // An invoke's reply flushes the chat state held back for the renderer.
    expect(handlers.has(IPC_CHANNELS.browserReportLinkBrowserTarget)).toBe(
      false,
    );
    expect(listeners.has(IPC_CHANNELS.browserReportLinkBrowserTarget)).toBe(
      true,
    );
  });

  it('stores the link browser target reported by the main window only', () => {
    const mainSender = { id: 7 };
    registerBrowserHandlers(
      () => ({ webContents: mainSender }) as unknown as BrowserWindow,
    );
    const report = listeners.get(IPC_CHANNELS.browserReportLinkBrowserTarget);

    report?.({ sender: mainSender }, { available: true });
    report?.({ sender: { id: 8 } }, { available: false });
    report?.({ sender: mainSender }, { available: false });

    expect(mockSetLinkBrowserTargetAvailable.mock.calls).toEqual([
      [true],
      [false],
    ]);
  });

  it('ignores link browser target reports without a main window', () => {
    registerBrowserHandlers(() => null);
    listeners.get(IPC_CHANNELS.browserReportLinkBrowserTarget)?.(
      { sender: { id: 7 } },
      { available: true },
    );
    expect(mockSetLinkBrowserTargetAvailable).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing payload', undefined],
    ['a missing field', {}],
    ['a non-boolean field', { available: 'yes' }],
  ])('ignores a link browser target report with %s', (_name, payload) => {
    const mainSender = { id: 7 };
    registerBrowserHandlers(
      () => ({ webContents: mainSender }) as unknown as BrowserWindow,
    );

    listeners.get(IPC_CHANNELS.browserReportLinkBrowserTarget)?.(
      { sender: mainSender },
      payload,
    );
    expect(mockSetLinkBrowserTargetAvailable).not.toHaveBeenCalled();
  });

  it('accepts app-link request responses only through the broker', async () => {
    mockResolveAppLinkRequest.mockReturnValue(true);
    registerBrowserHandlers(() => null);
    const sender = { id: 7 };

    const result = await handlers.get(
      IPC_CHANNELS.browserResolveOpenLinkRequest,
    )?.(
      { sender },
      { requestId: 'request-1', handled: true, phase: 'reserve' },
    );

    expect(result).toBe(true);
    expect(mockResolveAppLinkRequest).toHaveBeenCalledWith(sender, {
      requestId: 'request-1',
      handled: true,
      phase: 'reserve',
    });
  });

  it('returns verified OS default-browser registration state', async () => {
    registerBrowserHandlers(() => null);

    await expect(
      handlers.get(IPC_CHANNELS.browserGetDefaultRegistrationStatus)?.({}),
    ).resolves.toEqual({
      enabled: true,
      registered: true,
      platform: 'win32',
    });
    expect(mockRefreshDefaultBrowserStatus).toHaveBeenCalledTimes(1);
  });

  describe('set active browser', () => {
    it('delegates an owned browser once with the exact scope ids', async () => {
      mockListWorktreeBrowsers.mockReturnValue([
        {
          id: 'browser-1',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      ]);
      registerBrowserHandlers(() => null);

      await handlers.get(IPC_CHANNELS.browserSetActive)?.(
        {},
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          browserId: 'browser-1',
        },
      );

      expect(mockListWorktreeBrowsers).toHaveBeenCalledWith(
        'project-1',
        'worktree-1',
      );
      expect(mockSetActiveBrowser).toHaveBeenCalledTimes(1);
      expect(mockSetActiveBrowser).toHaveBeenCalledWith(
        'project-1',
        'worktree-1',
        'browser-1',
      );
    });

    it('delegates null as an explicit clear without an ownership lookup', async () => {
      registerBrowserHandlers(() => null);

      await handlers.get(IPC_CHANNELS.browserSetActive)?.(
        {},
        {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          browserId: null,
        },
      );

      expect(mockListWorktreeBrowsers).not.toHaveBeenCalled();
      expect(mockSetActiveBrowser).toHaveBeenCalledWith(
        'project-1',
        'worktree-1',
        null,
      );
    });

    it.each([
      undefined,
      {},
      { projectId: 'project-1', worktreeId: 'worktree-1' },
      { projectId: '', worktreeId: 'worktree-1', browserId: null },
      { projectId: 'project-1', worktreeId: '', browserId: null },
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: '',
      },
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        browserId: undefined,
      },
    ])('rejects a missing or malformed request %#', async (request) => {
      registerBrowserHandlers(() => null);

      await expect(
        handlers.get(IPC_CHANNELS.browserSetActive)?.({}, request),
      ).rejects.toThrow();
      expect(mockSetActiveBrowser).not.toHaveBeenCalled();
    });

    it('rejects a browser outside the supplied project/worktree without changing selection', async () => {
      let savedActiveBrowserId: string | null = 'browser-current';
      mockListWorktreeBrowsers.mockReturnValue([
        {
          id: 'browser-other',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      ]);
      mockSetActiveBrowser.mockImplementation(
        (_projectId, _worktreeId, browserId: string | null) => {
          savedActiveBrowserId = browserId;
          return Promise.resolve();
        },
      );
      registerBrowserHandlers(() => null);

      await expect(
        handlers.get(IPC_CHANNELS.browserSetActive)?.(
          {},
          {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            browserId: 'browser-cross-scope',
          },
        ),
      ).rejects.toThrow('does not belong');

      expect(mockSetActiveBrowser).not.toHaveBeenCalled();
      expect(savedActiveBrowserId).toBe('browser-current');
    });
  });

  describe('browser transfers', () => {
    const transferId = '3f2b8c1e-5a47-4d0e-9b1c-7a6d2e4f8a90';
    const transfer = {
      kind: 'download' as const,
      id: transferId,
      browserId: 'browser-1',
      source: 'user' as const,
      origin: 'https://example.test/file.zip',
      fileName: 'file.zip',
      receivedBytes: 1,
      totalBytes: 2,
      status: 'in_progress' as const,
      startedAt: 1,
    };

    const anyFunction: unknown = expect.any(Function);
    const invoke = (channel: string, request: unknown): Promise<unknown> =>
      Promise.resolve(handlers.get(channel)?.({}, request));

    describe('list', () => {
      it('delegates the validated request and returns the service result', async () => {
        const result = {
          transfers: [transfer],
          total: 1,
          offset: 0,
          limit: 25,
        };
        mockListTransfers.mockReturnValue(result);
        registerBrowserHandlers(() => null);

        await expect(
          invoke(IPC_CHANNELS.browserListTransfers, {
            browserId: 'browser-1',
            kind: 'download',
            status: 'paused',
            offset: 3,
            limit: 100,
          }),
        ).resolves.toBe(result);

        expect(mockListTransfers).toHaveBeenCalledWith({
          browserId: 'browser-1',
          kind: 'download',
          status: 'paused',
          offset: 3,
          limit: 100,
        });
      });

      it('accepts a request with only a browserId', async () => {
        mockListTransfers.mockReturnValue({
          transfers: [],
          total: 0,
          offset: 0,
          limit: 25,
        });
        registerBrowserHandlers(() => null);

        await invoke(IPC_CHANNELS.browserListTransfers, {
          browserId: 'browser-1',
        });

        expect(mockListTransfers).toHaveBeenCalledWith({
          browserId: 'browser-1',
        });
      });

      it('is not runtime-generation scoped even when a generation is sent', async () => {
        mockListTransfers.mockReturnValue({
          transfers: [],
          total: 0,
          offset: 0,
          limit: 25,
        });
        registerBrowserHandlers(() => null);

        await invoke(IPC_CHANNELS.browserListTransfers, {
          browserId: 'browser-1',
          expectedRuntimeGeneration: 7,
        });

        expect(mockWithRuntimeTarget).not.toHaveBeenCalled();
        expect(mockListTransfers).toHaveBeenCalledWith({
          browserId: 'browser-1',
        });
      });

      it('does not forward unknown extra fields', async () => {
        mockListTransfers.mockReturnValue({
          transfers: [],
          total: 0,
          offset: 0,
          limit: 25,
        });
        registerBrowserHandlers(() => null);

        await invoke(IPC_CHANNELS.browserListTransfers, {
          browserId: 'browser-1',
          limit: 5,
          path: '/etc/passwd',
        });

        expect(mockListTransfers).toHaveBeenCalledWith({
          browserId: 'browser-1',
          limit: 5,
        });
      });

      it.each([
        ['null', null],
        ['an array', []],
        ['a string', 'browser-1'],
      ])('rejects %s as the request', async (_label, request) => {
        registerBrowserHandlers(() => null);
        await expect(
          invoke(IPC_CHANNELS.browserListTransfers, request),
        ).rejects.toThrow('Invalid browser list-transfers request');
        expect(mockListTransfers).not.toHaveBeenCalled();
      });

      it('forwards an upload listing', async () => {
        mockListTransfers.mockReturnValue({
          transfers: [],
          total: 0,
          offset: 0,
          limit: 25,
        });
        registerBrowserHandlers(() => null);

        await invoke(IPC_CHANNELS.browserListTransfers, {
          browserId: 'browser-1',
          kind: 'upload',
          status: 'cancelled',
        });

        expect(mockListTransfers).toHaveBeenCalledWith({
          browserId: 'browser-1',
          kind: 'upload',
          status: 'cancelled',
        });
      });

      it.each([
        ['a missing browserId', {}, 'Invalid browserId'],
        [
          'a noncanonical browserId',
          { browserId: '../bad' },
          'Invalid browserId',
        ],
        [
          'an unknown kind',
          { browserId: 'browser-1', kind: 'print' },
          'Invalid browser transfer kind',
        ],
        [
          'an unknown status',
          { browserId: 'browser-1', status: 'done' },
          'Invalid browser transfer status',
        ],
        [
          'a negative offset',
          { browserId: 'browser-1', offset: -1 },
          'Invalid browser transfer offset',
        ],
        [
          'a fractional offset',
          { browserId: 'browser-1', offset: 1.5 },
          'Invalid browser transfer offset',
        ],
        [
          'a string offset',
          { browserId: 'browser-1', offset: '1' },
          'Invalid browser transfer offset',
        ],
        [
          'limit 0',
          { browserId: 'browser-1', limit: 0 },
          'Invalid browser transfer limit',
        ],
        [
          'limit 101',
          { browserId: 'browser-1', limit: 101 },
          'Invalid browser transfer limit',
        ],
        [
          'a fractional limit',
          { browserId: 'browser-1', limit: 2.5 },
          'Invalid browser transfer limit',
        ],
      ])('rejects %s', async (_label, request, message) => {
        registerBrowserHandlers(() => null);
        await expect(
          invoke(IPC_CHANNELS.browserListTransfers, request),
        ).rejects.toThrow(message);
        expect(mockListTransfers).not.toHaveBeenCalled();
      });

      it.each([
        'in_progress',
        'paused',
        'complete',
        'cancelled',
        'interrupted',
        'failed',
      ])('accepts status %s', async (status) => {
        mockListTransfers.mockReturnValue({
          transfers: [],
          total: 0,
          offset: 0,
          limit: 25,
        });
        registerBrowserHandlers(() => null);
        await invoke(IPC_CHANNELS.browserListTransfers, {
          browserId: 'browser-1',
          status,
        });
        expect(mockListTransfers).toHaveBeenCalledWith({
          browserId: 'browser-1',
          status,
        });
      });
    });

    describe('command', () => {
      it.each(['cancel', 'resume', 'show', 'save_copy', 'attach'] as const)(
        'delegates %s with the transfer id and returns the result',
        async (kind) => {
          const result = { ok: true, transfer };
          mockTransferCommand.mockResolvedValue(result);
          registerBrowserHandlers(() => null);

          await expect(
            invoke(IPC_CHANNELS.browserTransferCommand, {
              kind,
              browserId: 'browser-1',
              transferId,
            }),
          ).resolves.toBe(result);

          expect(mockTransferCommand).toHaveBeenCalledWith(
            { kind, browserId: 'browser-1', transferId },
            { revealInFolder: anyFunction, chooseSavePath: anyFunction },
          );
        },
      );

      it('delegates allow_more without a transfer id', async () => {
        mockTransferCommand.mockResolvedValue({ ok: true });
        registerBrowserHandlers(() => null);

        await invoke(IPC_CHANNELS.browserTransferCommand, {
          kind: 'allow_more',
          browserId: 'browser-1',
        });

        expect(mockTransferCommand).toHaveBeenCalledWith(
          { kind: 'allow_more', browserId: 'browser-1' },
          { revealInFolder: anyFunction, chooseSavePath: anyFunction },
        );
      });

      it('is not runtime-generation scoped even when a generation is sent', async () => {
        mockTransferCommand.mockResolvedValue({ ok: true });
        registerBrowserHandlers(() => null);

        await invoke(IPC_CHANNELS.browserTransferCommand, {
          kind: 'cancel',
          browserId: 'browser-1',
          transferId,
          expectedRuntimeGeneration: 3,
        });

        expect(mockWithRuntimeTarget).not.toHaveBeenCalled();
      });

      it('does not forward unknown extra fields', async () => {
        mockTransferCommand.mockResolvedValue({ ok: true });
        registerBrowserHandlers(() => null);

        await invoke(IPC_CHANNELS.browserTransferCommand, {
          kind: 'show',
          browserId: 'browser-1',
          transferId,
          path: '/etc/passwd',
        });
        await invoke(IPC_CHANNELS.browserTransferCommand, {
          kind: 'allow_more',
          browserId: 'browser-1',
          transferId,
        });

        expect(mockTransferCommand.mock.calls[0]?.[0]).toStrictEqual({
          kind: 'show',
          browserId: 'browser-1',
          transferId,
        });
        expect(mockTransferCommand.mock.calls[1]?.[0]).toStrictEqual({
          kind: 'allow_more',
          browserId: 'browser-1',
        });
      });

      it('reveals a path through the Electron shell only via the host adapter', async () => {
        mockTransferCommand.mockResolvedValue({ ok: true });
        registerBrowserHandlers(() => null);

        await invoke(IPC_CHANNELS.browserTransferCommand, {
          kind: 'show',
          browserId: 'browser-1',
          transferId,
        });

        expect(mockShowItemInFolder).not.toHaveBeenCalled();
        const host = mockTransferCommand.mock.calls[0]?.[1];
        host?.revealInFolder('/tmp/downloads/file.zip');
        expect(mockShowItemInFolder).toHaveBeenCalledWith(
          '/tmp/downloads/file.zip',
        );
      });

      it.each([
        ['null', null],
        ['an array', []],
        ['a string', 'cancel'],
      ])('rejects %s as the command', async (_label, command) => {
        registerBrowserHandlers(() => null);
        await expect(
          invoke(IPC_CHANNELS.browserTransferCommand, command),
        ).rejects.toThrow('Invalid browser transfer command');
        expect(mockTransferCommand).not.toHaveBeenCalled();
      });

      it.each([
        ['an unknown kind', { kind: 'delete', browserId: 'browser-1' }],
        ['a missing kind', { browserId: 'browser-1' }],
        ['a bad browserId', { kind: 'allow_more', browserId: '../bad' }],
        ['a missing browserId', { kind: 'allow_more' }],
      ])('rejects %s', async (_label, command) => {
        registerBrowserHandlers(() => null);
        await expect(
          invoke(IPC_CHANNELS.browserTransferCommand, command),
        ).rejects.toThrow(/Invalid browser transfer command|Invalid browserId/);
        expect(mockTransferCommand).not.toHaveBeenCalled();
      });

      it.each(['cancel', 'resume', 'show', 'save_copy', 'attach'])(
        'rejects %s with a missing or invalid transferId',
        async (kind) => {
          registerBrowserHandlers(() => null);
          for (const extra of [
            {},
            { transferId: '' },
            { transferId: 42 },
            { transferId: '../escape' },
            { transferId: 'UPPER' },
          ]) {
            await expect(
              invoke(IPC_CHANNELS.browserTransferCommand, {
                kind,
                browserId: 'browser-1',
                ...extra,
              }),
            ).rejects.toThrow('Invalid transferId');
          }
          expect(mockTransferCommand).not.toHaveBeenCalled();
        },
      );

      it('opens the save dialog over the asking window, in Downloads', async () => {
        const window = { id: 7 };
        mockFromWebContents.mockReturnValue(window);
        mockTransferCommand.mockResolvedValue({ ok: true, dismissed: true });
        registerBrowserHandlers(() => null);
        await Promise.resolve(
          handlers.get(IPC_CHANNELS.browserTransferCommand)?.(
            { sender: {} },
            { kind: 'save_copy', browserId: 'browser-1', transferId },
          ),
        );
        const host = mockTransferCommand.mock.calls[0]?.[1];
        mockShowSaveDialog
          .mockResolvedValueOnce({
            canceled: false,
            filePath: '/Users/me/Desktop/report.csv',
          })
          .mockResolvedValueOnce({ canceled: true });

        await expect(host?.chooseSavePath?.('report.csv')).resolves.toBe(
          '/Users/me/Desktop/report.csv',
        );
        await expect(host?.chooseSavePath?.('report.csv')).resolves.toBe(
          undefined,
        );
        expect(mockShowSaveDialog).toHaveBeenCalledWith(window, {
          defaultPath: '/Users/me/Downloads/report.csv',
        });
      });
    });

    describe('answer file chooser', () => {
      const chooserId = 'chooser-0b3f6a52-6f1c-4c0e-9f4a-0d2c5b6e7a11';

      it('forwards a fresh answer for the pending chooser', async () => {
        mockAnswerFileChooser.mockResolvedValue({ ok: true });
        registerBrowserHandlers(() => null);
        await expect(
          invoke(IPC_CHANNELS.browserAnswerFileChooser, {
            browserId: 'browser-1',
            chooserId,
            answer: 'choose',
            paths: ['/etc/passwd'],
          }),
        ).resolves.toEqual({ ok: true });
        expect(mockAnswerFileChooser.mock.calls[0]?.[0]).toStrictEqual({
          browserId: 'browser-1',
          chooserId,
          answer: 'choose',
        });
      });

      it.each([
        ['no request', null],
        [
          'a bad chooser id',
          { browserId: 'browser-1', chooserId: '../x', answer: 'dismiss' },
        ],
        [
          'an unknown answer',
          { browserId: 'browser-1', chooserId, answer: 'accept' },
        ],
      ])('rejects %s', async (_label, request) => {
        registerBrowserHandlers(() => null);
        await expect(
          invoke(IPC_CHANNELS.browserAnswerFileChooser, request),
        ).rejects.toThrow(/Invalid/);
        expect(mockAnswerFileChooser).not.toHaveBeenCalled();
      });
    });

    describe('save download', () => {
      const chat = {
        projectId: 'app-advisor',
        worktreeId: 'entry-1',
        chatId: 'chat-1',
      };

      it('forwards a fresh request with the approving chat', async () => {
        const result = { ok: true };
        mockSaveDownload.mockResolvedValue(result);
        registerBrowserHandlers(() => null);

        await expect(
          invoke(IPC_CHANNELS.browserSaveDownload, {
            browserId: 'browser-1',
            downloadId: transferId,
            path: 'exports/report.csv',
            overwrite: true,
            timeoutMs: 5000,
            approvalChat: { ...chat, extra: 'dropped' },
            expectedRuntimeGeneration: 3,
            absolutePath: '/etc/passwd',
          }),
        ).resolves.toBe(result);
        expect(mockSaveDownload.mock.calls[0]?.[0]).toStrictEqual({
          browserId: 'browser-1',
          downloadId: transferId,
          path: 'exports/report.csv',
          overwrite: true,
          timeoutMs: 5000,
          approvalChat: chat,
        });
        expect(mockWithRuntimeTarget).not.toHaveBeenCalled();
      });

      it.each([
        ['no request', null],
        ['a missing path', { browserId: 'browser-1', downloadId: transferId }],
        [
          'a blank path',
          { browserId: 'browser-1', downloadId: transferId, path: '  ' },
        ],
        [
          'a path past 4096 characters',
          {
            browserId: 'browser-1',
            downloadId: transferId,
            path: 'a'.repeat(4097),
          },
        ],
        [
          'a non-boolean overwrite',
          {
            browserId: 'browser-1',
            downloadId: transferId,
            path: 'report.csv',
            overwrite: 'yes',
          },
        ],
        [
          'a timeout past two minutes',
          {
            browserId: 'browser-1',
            downloadId: transferId,
            path: 'report.csv',
            timeoutMs: 120001,
          },
        ],
        [
          'a bad chat id',
          {
            browserId: 'browser-1',
            downloadId: transferId,
            path: 'report.csv',
            approvalChat: { ...chat, chatId: '../other' },
          },
        ],
        [
          'a bad download id',
          { browserId: 'browser-1', downloadId: 'UPPER', path: 'report.csv' },
        ],
      ])('rejects %s', async (_label, request) => {
        registerBrowserHandlers(() => null);
        await expect(
          invoke(IPC_CHANNELS.browserSaveDownload, request),
        ).rejects.toThrow(/Invalid/);
        expect(mockSaveDownload).not.toHaveBeenCalled();
      });
    });

    describe('save pdf', () => {
      it('forwards the print options inside the runtime target', async () => {
        const result = { ok: true };
        mockSavePdf.mockResolvedValue(result);
        registerBrowserHandlers(() => null);

        await expect(
          invoke(IPC_CHANNELS.browserSavePdf, {
            browserId: 'browser-1',
            expectedRuntimeGeneration: 3,
            fileName: 'Invoice',
            landscape: true,
            printBackground: false,
            scale: 0.5,
            paperFormat: 'a4',
            pageRanges: '1-2',
            displayHeaderFooter: true,
            timeoutMs: 5000,
            path: '/etc/passwd',
          }),
        ).resolves.toBe(result);
        const forwarded = {
          browserId: 'browser-1',
          expectedRuntimeGeneration: 3,
          fileName: 'Invoice',
          landscape: true,
          printBackground: false,
          scale: 0.5,
          paperFormat: 'a4',
          pageRanges: '1-2',
          displayHeaderFooter: true,
          timeoutMs: 5000,
        };
        expect(mockSavePdf.mock.calls[0]?.[0]).toStrictEqual(forwarded);
        expect(mockWithRuntimeTarget.mock.calls[0]?.[0]).toStrictEqual(
          forwarded,
        );
      });

      it('accepts any action id the shared schema accepts, trimmed', async () => {
        mockSavePdf.mockResolvedValue({ ok: true });
        registerBrowserHandlers(() => null);
        await invoke(IPC_CHANNELS.browserSavePdf, {
          browserId: 'browser-1',
          actionId: ' Invoice_PDF.step-2 ',
        });
        expect(mockSavePdf.mock.calls[0]?.[0]).toStrictEqual({
          browserId: 'browser-1',
          actionId: 'Invoice_PDF.step-2',
        });
      });

      it.each([
        ['no request', null],
        ['a blank action id', { browserId: 'browser-1', actionId: '  ' }],
        [
          'an action id past 128 characters',
          { browserId: 'browser-1', actionId: 'a'.repeat(129) },
        ],
        ['a blank file name', { browserId: 'browser-1', fileName: ' ' }],
        [
          'a file name past 120 characters',
          { browserId: 'browser-1', fileName: 'a'.repeat(121) },
        ],
        ['a scale out of range', { browserId: 'browser-1', scale: 3 }],
        [
          'an unknown paper format',
          { browserId: 'browser-1', paperFormat: 'a5' },
        ],
        ['a non-string page range', { browserId: 'browser-1', pageRanges: 1 }],
        [
          'a non-boolean landscape',
          { browserId: 'browser-1', landscape: 'yes' },
        ],
        [
          'a timeout past 60 seconds',
          { browserId: 'browser-1', timeoutMs: 60_001 },
        ],
      ])('rejects %s', async (_label, request) => {
        registerBrowserHandlers(() => null);
        await expect(
          invoke(IPC_CHANNELS.browserSavePdf, request),
        ).rejects.toThrow(/Invalid/);
        expect(mockSavePdf).not.toHaveBeenCalled();
      });
    });

    describe('sign-ins', () => {
      const authRequestId = 'auth-0b6f2c1e-6a35-4c58-9d2a-1f0c2c4b5e7a';

      it('reads the pending sign-in and forwards the user’s answer', async () => {
        mockGetAuthRequest.mockReturnValue({ id: authRequestId });
        mockAnswerAuthRequest.mockReturnValue({ ok: true });
        registerBrowserHandlers(() => null);
        await expect(
          invoke(IPC_CHANNELS.browserGetAuthRequest, {
            browserId: 'browser-1',
          }),
        ).resolves.toEqual({ id: authRequestId });
        await invoke(IPC_CHANNELS.browserAnswerAuthRequest, {
          browserId: 'browser-1',
          authRequestId,
          answer: 'sign_in',
          username: 'ada',
          password: 'secret',
          extra: 'dropped',
        });
        await invoke(IPC_CHANNELS.browserAnswerAuthRequest, {
          browserId: 'browser-1',
          authRequestId,
          answer: 'cancel',
          username: 'ignored',
        });
        expect(mockAnswerAuthRequest.mock.calls.map(([call]) => call)).toEqual([
          {
            browserId: 'browser-1',
            authRequestId,
            answer: 'sign_in',
            username: 'ada',
            password: 'secret',
          },
          { browserId: 'browser-1', authRequestId, answer: 'cancel' },
        ]);
      });

      it.each([
        ['no request', null],
        [
          'an unknown answer',
          { browserId: 'browser-1', authRequestId, answer: 'accept' },
        ],
        [
          'a sign-in without credentials',
          { browserId: 'browser-1', authRequestId, answer: 'sign_in' },
        ],
        [
          'a password past 4096 characters',
          {
            browserId: 'browser-1',
            authRequestId,
            answer: 'sign_in',
            username: 'ada',
            password: 'p'.repeat(4097),
          },
        ],
      ])('rejects %s without echoing it', async (_label, request) => {
        registerBrowserHandlers(() => null);
        await expect(
          invoke(IPC_CHANNELS.browserAnswerAuthRequest, request),
        ).rejects.toThrow('Invalid browser sign-in answer');
        expect(mockAnswerAuthRequest).not.toHaveBeenCalled();
      });
    });

    describe('print requests', () => {
      const printRequestId = 'print-0b6f2c1e-6a35-4c58-9d2a-1f0c2c4b5e7a';

      it('reads the pending print request and forwards answers', async () => {
        const request = { id: printRequestId };
        mockGetPrintRequest.mockReturnValue(request);
        mockAnswerPrintRequest.mockResolvedValue({ ok: true });
        registerBrowserHandlers(() => null);
        await expect(
          invoke(IPC_CHANNELS.browserGetPrintRequest, {
            browserId: 'browser-1',
          }),
        ).resolves.toBe(request);
        expect(mockGetPrintRequest).toHaveBeenCalledWith('browser-1');
        for (const answer of ['save_pdf', 'print', 'dismiss'] as const)
          await expect(
            invoke(IPC_CHANNELS.browserAnswerPrintRequest, {
              browserId: 'browser-1',
              printRequestId,
              answer,
              extra: 'dropped',
            }),
          ).resolves.toEqual({ ok: true });
        expect(mockAnswerPrintRequest.mock.calls.map(([call]) => call)).toEqual(
          ['save_pdf', 'print', 'dismiss'].map((answer) => ({
            browserId: 'browser-1',
            printRequestId,
            answer,
          })),
        );
      });

      it.each([
        ['no request', null],
        [
          'an unknown answer',
          { browserId: 'browser-1', printRequestId, answer: 'accept' },
        ],
        [
          'a malformed id',
          { browserId: 'browser-1', printRequestId: '../x', answer: 'dismiss' },
        ],
      ])('rejects %s', async (_label, request) => {
        registerBrowserHandlers(() => null);
        await expect(
          invoke(IPC_CHANNELS.browserAnswerPrintRequest, request),
        ).rejects.toThrow();
        expect(mockAnswerPrintRequest).not.toHaveBeenCalled();
      });
    });

    it('reads the pending file chooser for a valid browser id only', async () => {
      const chooser = { id: 'chooser-1' };
      mockGetFileChooser.mockReturnValue(chooser);
      registerBrowserHandlers(() => null);
      await expect(
        invoke(IPC_CHANNELS.browserGetFileChooser, { browserId: 'browser-1' }),
      ).resolves.toBe(chooser);
      expect(mockGetFileChooser).toHaveBeenCalledWith('browser-1');
      await expect(
        invoke(IPC_CHANNELS.browserGetFileChooser, { browserId: '../x' }),
      ).rejects.toThrow();
      expect(mockGetFileChooser).toHaveBeenCalledTimes(1);
    });
  });
});
