jest.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
  BrowserWindow: jest.fn(),
  ipcMain: {
    removeHandler: jest.fn(),
    handle: jest.fn(),
  },
}));

jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

jest.mock('../lib/window-send', () => ({
  sendToWindowDetailed: jest.fn(() => ({ delivered: true })),
}));

import {
  IPC_CHANNELS,
  type AppAdvisorBrowserAction,
  type AppAdvisorRendererToolRequest,
  APP_ADVISOR_PROJECT_ID,
  type AppAdvisorRendererToolResponse,
  type AppAdvisorUiStateEnvelope,
  type AppAdvisorWorkspaceSettingsFile,
} from '@canopy/desktop-shared/types';
import { MAX_ARCHIVE_RETENTION_DAYS } from '@canopy/desktop-shared/lib/archive-retention';
import { ASK_USER_TIMEOUT_MS } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import { BrowserWindow } from 'electron';
import { EventEmitter } from 'node:events';
import { registerBrowserAutomationCancellation } from '../browser/automation-cancellation';
import { registerIpcHandler } from '../ipc/register';
import {
  completeAppAdvisorAskUserRequest,
  getCachedAppAdvisorUiStateForChat,
  getLatestAppAdvisorUiState,
  listAnsweredAppAdvisorAskUserQuestions,
  redeliverPendingAppAdvisorAskUserRequests,
  registerAppAdvisorHandlers,
  requestAppAdvisorRendererTool,
  requestCurrentAppAdvisorUiState,
  setLatestAppAdvisorUiState,
  setRemoteAppAdvisorWindowHostResolver,
  setRendererToolSurfaceRouter,
  type AppAdvisorWorkspaceOperations,
  type RemoteAppAdvisorWindowHost,
  type AppAdvisorWindowAccessors,
} from '../ipc/app-advisor';
import { sendToWindowDetailed } from '../lib/window-send';

const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedSendToWindowDetailed = jest.mocked(sendToWindowDetailed);

type RegisteredIpcHandler = (event: unknown, ...args: unknown[]) => unknown;
type WindowRef = ReturnType<AppAdvisorWindowAccessors['getMainWindow']>;

function isRegisteredIpcHandler(value: unknown): value is RegisteredIpcHandler {
  return typeof value === 'function';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findToolRequestByActionField(
  field: string,
  expected: string,
): Record<string, unknown> {
  for (const [, channel, payload] of mockedSendToWindowDetailed.mock.calls) {
    if (
      channel === IPC_CHANNELS.appAdvisorToolRequest &&
      isRecord(payload) &&
      isRecord(payload.action) &&
      payload.action[field] === expected
    ) {
      return payload;
    }
  }
  throw new Error(`Expected tool request with ${field}=${expected}`);
}

function uiState(): AppAdvisorUiStateEnvelope {
  return {
    version: 1,
    revision: 1,
    capturedAt: '2026-05-21T00:00:00.000Z',
    digest: 'digest',
    snapshot: {
      activePage: 'main',
      archivedContainers: { count: 0, viewerOpen: false },
      overlays: {
        commandPaletteOpen: false,
        fileSearchPaletteOpen: false,
        prPickerOpen: false,
        canopyPortalOpen: false,
        appAdvisorOpen: true,
      },
    },
  };
}

function makeAccessors(): AppAdvisorWindowAccessors & {
  mainWindow: WindowRef;
  advisorWindow: WindowRef;
} {
  const mainWindow: WindowRef = null;
  const advisorWindow: WindowRef = null;
  return {
    mainWindow,
    advisorWindow,
    getMainWindow: () => mainWindow,
    getAppAdvisorWindow: () => advisorWindow,
    openAppAdvisorWindow: jest.fn(() =>
      Promise.resolve({ open: true, focused: true }),
    ),
    ensureAppAdvisorWindow: jest.fn(() =>
      Promise.resolve({ open: false, focused: false }),
    ),
    closeAppAdvisorWindow: jest.fn(() =>
      Promise.resolve({ open: false, focused: false }),
    ),
    toggleAppAdvisorWindow: jest.fn(() =>
      Promise.resolve({ open: true, focused: true }),
    ),
    getAppAdvisorWindowState: () => ({ open: true, focused: true }),
    markAppAdvisorWindowRendererReady: jest.fn(() => ({
      open: true,
      focused: true,
    })),
    setAppAdvisorFloatingSize: jest.fn(),
  };
}

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const call = mockedRegisterIpcHandler.mock.calls.find(
    ([registeredChannel]) => registeredChannel === channel,
  );
  if (!call) {
    throw new Error(`Expected handler for ${channel}`);
  }
  const handler: unknown = call[1];
  if (!isRegisteredIpcHandler(handler)) {
    throw new Error(`Expected registered handler for ${channel}`);
  }
  return handler;
}

function respond(response: AppAdvisorRendererToolResponse): void {
  getHandler(IPC_CHANNELS.appAdvisorToolResponse)(
    { sender: { id: 'app-window' } },
    response,
  );
}

function browserDispatchRequest(
  requestId: string,
  action: AppAdvisorBrowserAction,
): AppAdvisorRendererToolRequest {
  return {
    kind: 'dispatch_action',
    requestId,
    action,
    originWorktreeId: 'entry-1',
  };
}

async function flushRendererDelivery(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeWorkspaceOperations(): AppAdvisorWorkspaceOperations {
  const settings: AppAdvisorWorkspaceSettingsFile = {
    version: 1,
    description: 'Project description',
    archiveRetentionDays: 30,
  };
  return {
    settingsLoad: jest.fn(() => Promise.resolve(settings)),
    settingsSave: jest.fn(() => Promise.resolve(settings)),
    loadClaudeMd: jest.fn(() => Promise.resolve('# Instructions\n')),
    saveClaudeMd: jest.fn(() => Promise.resolve()),
  };
}

describe('App Advisor IPC tool routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedSendToWindowDetailed.mockReturnValue({ delivered: true });
    registerAppAdvisorHandlers(makeAccessors());
  });

  it('routes a file tile to its explicit workspace while retaining the chat origin', async () => {
    const request = {
      path: '/project/report.md',
      focusReturnId: 'file-focus-return',
      target: { projectId: 'project', worktreeId: 'worktree' },
      origin: {
        projectId: 'app-advisor',
        worktreeId: 'global',
        chatTabId: 'chat',
      },
    };
    const promise = getHandler(IPC_CHANNELS.appAdvisorOpenTurnFile)(
      undefined,
      request,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const sent = mockedSendToWindowDetailed.mock.calls.find(
      ([, , payload]) => isRecord(payload) && payload.kind === 'show_files',
    )?.[2];
    expect(sent).toMatchObject({
      kind: 'show_files',
      payload: {
        files: [{ path: request.path }],
        target: request.target,
        origin: request.origin,
        focusReturnId: request.focusReturnId,
      },
    });
    if (!isRecord(sent) || typeof sent.requestId !== 'string')
      throw new Error('Missing file request');
    const result = {
      opened: 1,
      failed: 0,
      files: [{ path: request.path, ok: true, tabId: 'file-tab' }],
    };
    respond({
      requestId: sent.requestId,
      originChatId: request.origin.chatTabId,
      ok: true,
      result,
    });
    await expect(promise).resolves.toEqual({
      ...result,
      presentation: 'foreground',
    });
  });

  it('relays viewer close notifications only from the main renderer', () => {
    const mainWindow = Object.assign(new BrowserWindow(), { webContents: {} });
    const accessors = makeAccessors();
    accessors.getMainWindow = (): WindowRef => mainWindow;
    mockedRegisterIpcHandler.mockClear();
    registerAppAdvisorHandlers(accessors);
    const handler = getHandler(IPC_CHANNELS.appAdvisorTurnFileClosed);
    expect(() => handler({ sender: {} }, 'file-focus-return')).toThrow(
      'main window',
    );
    expect(() => handler({ sender: mainWindow.webContents }, '../bad')).toThrow(
      'Invalid focusReturnId',
    );
    handler({ sender: mainWindow.webContents }, 'file-focus-return');
    expect(mockedSendToWindowDetailed).toHaveBeenLastCalledWith(
      accessors.getAppAdvisorWindow(),
      IPC_CHANNELS.appAdvisorTurnFileClosed,
      'file-focus-return',
    );
  });

  it('rejects invalid file tile scopes before routing a request', async () => {
    const handler = getHandler(IPC_CHANNELS.appAdvisorOpenTurnFile);
    await expect(
      handler(undefined, {
        path: '/project/report.md',
        target: { projectId: '../project', worktreeId: 'worktree' },
        origin: {
          projectId: 'app-advisor',
          worktreeId: 'global',
          chatTabId: 'chat',
        },
      }),
    ).rejects.toThrow('Invalid projectId');
    await expect(
      handler(undefined, {
        path: '/project/report.md',
        target: { projectId: 'project', worktreeId: 'worktree' },
        origin: {
          projectId: 'project',
          worktreeId: 'global',
          chatTabId: 'chat',
        },
      }),
    ).rejects.toThrow('Invalid file opening request');
    expect(mockedSendToWindowDetailed).not.toHaveBeenCalled();
  });

  it('routes UI-state requests to the main window', async () => {
    const accessors = makeAccessors();
    const promise = requestAppAdvisorRendererTool(
      { kind: 'get_current_ui_state', requestId: 'ui-routing' },
      accessors,
    );

    expect(mockedSendToWindowDetailed).toHaveBeenCalledWith(
      accessors.mainWindow,
      IPC_CHANNELS.appAdvisorToolRequest,
      expect.objectContaining({ kind: 'get_current_ui_state' }),
    );

    respond({ requestId: 'ui-routing', ok: true, uiState: uiState() });
    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it('does not reuse cached page availability after a failed UI refresh', async () => {
    const cached = uiState();
    const snapshot = { ...cached.snapshot };
    // Keep the stale cached page values so the test still covers discarding them.
    Reflect.set(snapshot, 'availablePages', ['home', 'agents']);
    setLatestAppAdvisorUiState({ ...cached, snapshot });
    mockedSendToWindowDetailed.mockReturnValueOnce({
      delivered: false,
      reason: 'no_window',
    });
    const refreshed = await requestCurrentAppAdvisorUiState(makeAccessors());
    expect(refreshed.revision).toBe(0);
    expect(refreshed.snapshot).not.toHaveProperty('availablePages');
  });

  it('routes action dispatch requests to the main window', async () => {
    const accessors = makeAccessors();
    const promise = requestAppAdvisorRendererTool(
      {
        kind: 'dispatch_action',
        requestId: 'action-routing',
        action: { type: 'navigation.go_to_page', page: 'overview' },
        originWorktreeId: 'entry-1',
      },
      accessors,
    );

    expect(mockedSendToWindowDetailed).toHaveBeenCalledWith(
      accessors.mainWindow,
      IPC_CHANNELS.appAdvisorToolRequest,
      expect.objectContaining({ kind: 'dispatch_action' }),
    );

    respond({ requestId: 'action-routing', ok: true, uiState: uiState() });
    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it('routes App Advisor-scoped browser actions to its window and explicit project browser actions to main', async () => {
    const accessors = makeAccessors();
    const advisorPromise = requestAppAdvisorRendererTool(
      {
        kind: 'dispatch_action',
        requestId: 'advisor-browser-routing',
        action: { type: 'browser.list' },
        originWorktreeId: 'entry-1',
      },
      accessors,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(accessors.ensureAppAdvisorWindow).toHaveBeenCalledWith({
      workEntryId: 'entry-1',
    });
    expect(accessors.openAppAdvisorWindow).not.toHaveBeenCalled();
    expect(mockedSendToWindowDetailed).toHaveBeenCalledWith(
      accessors.advisorWindow,
      IPC_CHANNELS.appAdvisorToolRequest,
      expect.objectContaining({
        kind: 'dispatch_action',
        action: { type: 'browser.list' },
      }),
    );
    respond({
      requestId: 'advisor-browser-routing',
      ok: true,
      uiState: uiState(),
    });
    await expect(advisorPromise).resolves.toMatchObject({ ok: true });

    mockedSendToWindowDetailed.mockClear();
    const mainPromise = requestAppAdvisorRendererTool(
      {
        kind: 'dispatch_action',
        requestId: 'workspace-browser-routing',
        action: {
          type: 'browser.reload',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
        originWorktreeId: 'entry-1',
      },
      accessors,
    );
    expect(mockedSendToWindowDetailed).toHaveBeenCalledWith(
      accessors.mainWindow,
      IPC_CHANNELS.appAdvisorToolRequest,
      expect.objectContaining({
        kind: 'dispatch_action',
        action: {
          type: 'browser.reload',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      }),
    );
    respond({
      requestId: 'workspace-browser-routing',
      ok: true,
      uiState: uiState(),
    });
    await expect(mainPromise).resolves.toMatchObject({ ok: true });
  });

  it('does not time out a browser wait_for at the old 30-second bridge bound', async () => {
    jest.useFakeTimers();
    try {
      const accessors = makeAccessors();
      const runtimeController = new AbortController();
      registerBrowserAutomationCancellation(
        'browser-wait-30-seconds',
        runtimeController,
      );
      const promise = requestAppAdvisorRendererTool(
        browserDispatchRequest('browser-wait-30-seconds', {
          type: 'browser.wait_for',
          locator: '[data-ready]',
          timeoutMs: 30_000,
        }),
        accessors,
      );
      let response: AppAdvisorRendererToolResponse | undefined;
      void promise.then((value) => {
        response = value;
      });
      await flushRendererDelivery();

      jest.advanceTimersByTime(30_000);
      await Promise.resolve();

      expect(response).toBeUndefined();
      expect(runtimeController.signal.aborted).toBe(false);

      respond({
        requestId: 'browser-wait-30-seconds',
        ok: true,
        uiState: uiState(),
      });
      await expect(promise).resolves.toMatchObject({ ok: true });
      expect(runtimeController.signal.aborted).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('allows the maximum browser action and wait_for budgets before cancelling browser automation', async () => {
    jest.useFakeTimers();
    try {
      const accessors = makeAccessors();
      const requests: Array<{
        requestId: string;
        action: AppAdvisorBrowserAction;
      }> = [
        {
          requestId: 'browser-click-max-budget',
          action: {
            type: 'browser.click',
            locator: 'button',
            timeoutMs: 60_000,
          },
        },
        {
          requestId: 'browser-fill-max-budget',
          action: {
            type: 'browser.fill',
            locator: 'input',
            text: '',
            timeoutMs: 60_000,
          },
        },
        {
          requestId: 'browser-set-checked-max-budget',
          action: {
            type: 'browser.set_checked',
            locator: 'input[type=checkbox]',
            checked: true,
            timeoutMs: 60_000,
          },
        },
        {
          requestId: 'browser-select-option-max-budget',
          action: {
            type: 'browser.select_option',
            locator: 'select[name=country]',
            values: ['ca'],
            timeoutMs: 60_000,
          },
        },
        {
          requestId: 'browser-press-max-budget',
          action: {
            type: 'browser.press',
            locator: 'input',
            key: 'Enter',
            timeoutMs: 60_000,
          },
        },
        {
          requestId: 'hover-max',
          action: { type: 'browser.hover', ref: 'r', timeoutMs: 60_000 },
        },
        {
          requestId: 'scroll-max',
          action: {
            type: 'browser.scroll',
            direction: 'down',
            timeoutMs: 60_000,
          },
        },
        {
          requestId: 'drag-max',
          action: {
            type: 'browser.drag',
            from: { ref: 'r' },
            to: { ref: 's' },
            timeoutMs: 60_000,
          },
        },
        {
          requestId: 'browser-focus-max-budget',
          action: {
            type: 'browser.focus',
            locator: 'input',
            timeoutMs: 60_000,
          },
        },
        {
          requestId: 'browser-wait-max-budget',
          action: {
            type: 'browser.wait_for',
            text: 'Ready',
            timeoutMs: 120_000,
          },
        },
      ];
      const runtimeControllers: AbortController[] = [];
      for (const request of requests) {
        const runtimeController = new AbortController();
        runtimeControllers.push(runtimeController);
        registerBrowserAutomationCancellation(
          request.requestId,
          runtimeController,
        );
      }
      const promises = requests.map((request) =>
        requestAppAdvisorRendererTool(
          browserDispatchRequest(request.requestId, request.action),
          accessors,
        ),
      );
      await flushRendererDelivery();

      jest.advanceTimersByTime(134_999);
      await Promise.resolve();
      for (const controller of runtimeControllers) {
        expect(controller.signal.aborted).toBe(false);
      }

      jest.advanceTimersByTime(1);
      for (const promise of promises) {
        await expect(promise).resolves.toMatchObject({
          ok: false,
          error: { code: 'timeout', retryable: true },
        });
      }
      for (const controller of runtimeControllers) {
        expect(controller.signal.aborted).toBe(true);
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('adds type, fill, and select_option searchText typing budgets to the bridge deadline', async () => {
    jest.useFakeTimers();
    try {
      const accessors = makeAccessors();
      const requests: Array<{
        requestId: string;
        action: AppAdvisorBrowserAction;
        budgetMs: number;
      }> = [
        {
          requestId: 'browser-type-budget',
          action: {
            type: 'browser.type',
            locator: '#search',
            text: 't'.repeat(116),
            delayMs: 500,
          },
          budgetMs: 59_740,
        },
        {
          requestId: 'browser-fill-budget',
          action: {
            type: 'browser.fill',
            locator: '#search',
            text: 'f'.repeat(4_000),
          },
          budgetMs: 60_000,
        },
        {
          requestId: 'browser-select-search-budget',
          action: {
            type: 'browser.select_option',
            locator: '#country',
            values: ['ca'],
            searchText: 'Canada',
          },
          budgetMs: 90,
        },
        {
          requestId: 'browser-fill-over-limit-budget',
          action: {
            type: 'browser.fill',
            locator: '#search',
            text: 'f'.repeat(4_001),
          },
          budgetMs: 0,
        },
      ];
      const runtimeControllers = requests.map(() => new AbortController());
      for (let index = 0; index < requests.length; index += 1) {
        const request = requests[index];
        if (!request) throw new Error(`Missing request at index ${index}`);
        const controller = runtimeControllers[index];
        if (!controller)
          throw new Error(`Missing controller for ${request.requestId}`);
        registerBrowserAutomationCancellation(request.requestId, controller);
      }
      const promises = requests.map((request) =>
        requestAppAdvisorRendererTool(
          browserDispatchRequest(request.requestId, request.action),
          accessors,
        ),
      );
      await flushRendererDelivery();

      jest.advanceTimersByTime(29_999);
      await Promise.resolve();
      for (const controller of runtimeControllers) {
        expect(controller.signal.aborted).toBe(false);
      }

      jest.advanceTimersByTime(1);
      await expect(promises[3]).resolves.toMatchObject({
        ok: false,
        error: { code: 'timeout', retryable: true },
      });
      expect(runtimeControllers[3]?.signal.aborted).toBe(true);
      expect(runtimeControllers[1]?.signal.aborted).toBe(false);
      expect(runtimeControllers[0]?.signal.aborted).toBe(false);
      expect(runtimeControllers[2]?.signal.aborted).toBe(false);

      jest.advanceTimersByTime(89);
      for (const controller of runtimeControllers.slice(0, 3)) {
        expect(controller.signal.aborted).toBe(false);
      }

      jest.advanceTimersByTime(1);
      await expect(promises[2]).resolves.toMatchObject({
        ok: false,
        error: { code: 'timeout', retryable: true },
      });
      expect(runtimeControllers[2]?.signal.aborted).toBe(true);
      expect(runtimeControllers[0]?.signal.aborted).toBe(false);
      expect(runtimeControllers[1]?.signal.aborted).toBe(false);

      jest.advanceTimersByTime(59_649);
      expect(runtimeControllers[0]?.signal.aborted).toBe(false);
      expect(runtimeControllers[1]?.signal.aborted).toBe(false);

      jest.advanceTimersByTime(1);
      await expect(promises[0]).resolves.toMatchObject({
        ok: false,
        error: { code: 'timeout', retryable: true },
      });
      expect(runtimeControllers[0]?.signal.aborted).toBe(true);
      expect(runtimeControllers[1]?.signal.aborted).toBe(false);

      jest.advanceTimersByTime(260);
      await expect(promises[1]).resolves.toMatchObject({
        ok: false,
        error: { code: 'timeout', retryable: true },
      });
      expect(runtimeControllers[1]?.signal.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('waits as long as a question for a browser action that asks this chat, then cancels it', async () => {
    jest.useFakeTimers();
    try {
      const accessors = makeAccessors();
      const requests: Array<{
        requestId: string;
        action: AppAdvisorBrowserAction;
      }> = [
        {
          requestId: 'upload-awaiting-approval',
          action: {
            type: 'browser.upload_files',
            ref: 'r-1',
            files: [{ path: 'report.csv' }],
          },
        },
        {
          requestId: 'save-awaiting-approval',
          action: {
            type: 'browser.save_download',
            downloadId: 'download-1',
            path: 'report.csv',
          },
        },
        {
          requestId: 'request-awaiting-choice',
          action: { type: 'browser.request_files', ref: 'r-1' },
        },
      ];
      const controllers = requests.map((request) => {
        const controller = new AbortController();
        registerBrowserAutomationCancellation(request.requestId, controller);
        return controller;
      });
      const promises = requests.map((request) =>
        requestAppAdvisorRendererTool(
          browserDispatchRequest(request.requestId, request.action),
          accessors,
        ),
      );
      await flushRendererDelivery();

      // The user is still deciding, long after an ordinary tool request.
      jest.advanceTimersByTime(ASK_USER_TIMEOUT_MS - 1);
      await Promise.resolve();
      for (const controller of controllers)
        expect(controller.signal.aborted).toBe(false);

      jest.advanceTimersByTime(1);
      for (const promise of promises)
        await expect(promise).resolves.toMatchObject({
          ok: false,
          error: { code: 'timeout' },
        });
    } finally {
      jest.useRealTimers();
    }
  });

  it('uses browser timeout defaults and clamps invalid or out-of-range values', async () => {
    jest.useFakeTimers();
    try {
      const accessors = makeAccessors();
      const cases: Array<{
        requestId: string;
        action: AppAdvisorBrowserAction;
        bridgeTimeoutMs: number;
      }> = [
        {
          requestId: 'browser-click-default',
          action: { type: 'browser.click', locator: 'button' },
          bridgeTimeoutMs: 30_000,
        },
        {
          requestId: 'browser-wait-default',
          action: { type: 'browser.wait_for', text: 'Ready' },
          bridgeTimeoutMs: 30_000,
        },
        {
          requestId: 'browser-click-nan',
          action: {
            type: 'browser.click',
            locator: 'button',
            timeoutMs: Number.NaN,
          },
          bridgeTimeoutMs: 30_000,
        },
        {
          requestId: 'browser-wait-infinite',
          action: {
            type: 'browser.wait_for',
            text: 'Ready',
            timeoutMs: Number.POSITIVE_INFINITY,
          },
          bridgeTimeoutMs: 30_000,
        },
        {
          requestId: 'browser-click-low-clamp',
          action: {
            type: 'browser.click',
            locator: 'button',
            timeoutMs: 0,
          },
          bridgeTimeoutMs: 30_000,
        },
        {
          requestId: 'browser-wait-low-clamp',
          action: {
            type: 'browser.wait_for',
            text: 'Ready',
            timeoutMs: -1,
          },
          bridgeTimeoutMs: 30_000,
        },
        {
          requestId: 'browser-click-high-clamp',
          action: {
            type: 'browser.click',
            locator: 'button',
            timeoutMs: 60_001,
          },
          bridgeTimeoutMs: 135_000,
        },
        {
          requestId: 'browser-wait-high-clamp',
          action: {
            type: 'browser.wait_for',
            text: 'Ready',
            timeoutMs: 120_001,
          },
          bridgeTimeoutMs: 135_000,
        },
      ];

      for (const testCase of cases) {
        const promise = requestAppAdvisorRendererTool(
          browserDispatchRequest(testCase.requestId, testCase.action),
          accessors,
        );
        let response: AppAdvisorRendererToolResponse | undefined;
        void promise.then((value) => {
          response = value;
        });
        await flushRendererDelivery();

        jest.advanceTimersByTime(testCase.bridgeTimeoutMs - 1);
        await Promise.resolve();
        expect(response).toBeUndefined();

        jest.advanceTimersByTime(1);
        await expect(promise).resolves.toMatchObject({
          ok: false,
          error: { code: 'timeout', retryable: true },
        });
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancels browser automation when its App Advisor bridge request is aborted', async () => {
    const accessors = makeAccessors();
    const runtimeController = new AbortController();
    registerBrowserAutomationCancellation('browser-aborted', runtimeController);
    const signalController = new AbortController();
    const promise = requestAppAdvisorRendererTool(
      browserDispatchRequest('browser-aborted', {
        type: 'browser.press',
        key: 'Enter',
      }),
      accessors,
      { signal: signalController.signal },
    );
    await flushRendererDelivery();

    signalController.abort();

    await expect(promise).resolves.toMatchObject({
      ok: false,
      error: { code: 'execution_failed', message: 'ask_user_cancelled' },
    });
    expect(runtimeController.signal.aborted).toBe(true);
    expect(mockedSendToWindowDetailed).toHaveBeenCalledWith(
      accessors.advisorWindow,
      IPC_CHANNELS.appAdvisorToolRequestCancelled,
      { requestId: 'browser-aborted' },
    );
  });

  it('cancels a pre-aborted browser request without delivering it to the renderer', async () => {
    const accessors = makeAccessors();
    const runtimeController = new AbortController();
    registerBrowserAutomationCancellation(
      'browser-pre-aborted',
      runtimeController,
    );
    const signalController = new AbortController();
    signalController.abort();

    await expect(
      requestAppAdvisorRendererTool(
        browserDispatchRequest('browser-pre-aborted', {
          type: 'browser.focus',
          locator: 'input',
        }),
        accessors,
        { signal: signalController.signal },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'execution_failed', message: 'ask_user_cancelled' },
    });

    expect(runtimeController.signal.aborted).toBe(true);
    expect(mockedSendToWindowDetailed).not.toHaveBeenCalledWith(
      expect.anything(),
      IPC_CHANNELS.appAdvisorToolRequest,
      expect.anything(),
    );
  });

  it('does not cancel browser automation after a browser request succeeds', async () => {
    jest.useFakeTimers();
    try {
      const accessors = makeAccessors();
      const runtimeController = new AbortController();
      const unregister = registerBrowserAutomationCancellation(
        'browser-success-before-timeout',
        runtimeController,
      );
      const promise = requestAppAdvisorRendererTool(
        browserDispatchRequest('browser-success-before-timeout', {
          type: 'browser.click',
          locator: 'button',
          timeoutMs: 60_000,
        }),
        accessors,
      );
      await flushRendererDelivery();
      respond({
        requestId: 'browser-success-before-timeout',
        ok: true,
        uiState: uiState(),
      });
      await expect(promise).resolves.toMatchObject({ ok: true });

      jest.advanceTimersByTime(135_000);
      expect(runtimeController.signal.aborted).toBe(false);
      unregister();
    } finally {
      jest.useRealTimers();
    }
  });

  it('retains the 30-second non-browser bound without cancelling browser runtime work', async () => {
    jest.useFakeTimers();
    try {
      const accessors = makeAccessors();
      const runtimeController = new AbortController();
      const unregister = registerBrowserAutomationCancellation(
        'navigation-timeout',
        runtimeController,
      );
      const promise = requestAppAdvisorRendererTool(
        {
          kind: 'dispatch_action',
          requestId: 'navigation-timeout',
          action: { type: 'navigation.go_to_page', page: 'overview' },
          originWorktreeId: 'worktree-1',
        },
        accessors,
      );
      await flushRendererDelivery();

      jest.advanceTimersByTime(30_000);
      await expect(promise).resolves.toMatchObject({
        ok: false,
        error: { code: 'timeout', retryable: true },
      });
      expect(runtimeController.signal.aborted).toBe(false);
      unregister();
    } finally {
      jest.useRealTimers();
    }
  });

  it('passes the renderer-ready sender to the window accessor', () => {
    const accessors = makeAccessors();
    mockedRegisterIpcHandler.mockClear();
    registerAppAdvisorHandlers(accessors);
    const sender = {};

    getHandler(IPC_CHANNELS.appAdvisorWindowRendererReady)({ sender });

    expect(accessors.markAppAdvisorWindowRendererReady).toHaveBeenCalledWith(
      sender,
    );
  });

  it('routes settings and CLAUDE.md operations through the injected backend adapter', async () => {
    const accessors = makeAccessors();
    const operations = makeWorkspaceOperations();
    mockedRegisterIpcHandler.mockClear();
    registerAppAdvisorHandlers(accessors, operations);

    await expect(
      getHandler(IPC_CHANNELS.appAdvisorSettingsLoad)(undefined),
    ).resolves.toMatchObject({ version: 1 });
    await expect(
      getHandler(IPC_CHANNELS.appAdvisorSettingsSave)(undefined, {
        version: 99,
        description: 'Updated',
        archiveRetentionDays: null,
        arbitraryPath: '/tmp/escape',
      }),
    ).resolves.toMatchObject({ version: 1 });
    await expect(
      getHandler(IPC_CHANNELS.appAdvisorLoadClaudeMd)(undefined),
    ).resolves.toBe('# Instructions\n');
    await expect(
      getHandler(IPC_CHANNELS.appAdvisorSaveClaudeMd)(
        undefined,
        '# Replacement\n',
      ),
    ).resolves.toBeUndefined();

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(operations.settingsSave).toHaveBeenCalledWith({
      description: 'Updated',
      archiveRetentionDays: null,
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(operations.saveClaudeMd).toHaveBeenCalledWith('# Replacement\n');

    await expect(
      getHandler(IPC_CHANNELS.appAdvisorSettingsSave)(undefined, {
        archiveRetentionDays: 0,
      }),
    ).resolves.toMatchObject({ version: 1 });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(operations.settingsSave).toHaveBeenLastCalledWith({
      archiveRetentionDays: 0,
    });
    expect(() =>
      getHandler(IPC_CHANNELS.appAdvisorSettingsSave)(undefined, {
        archiveRetentionDays: 1.5,
      }),
    ).toThrow('Invalid App Advisor deletion retention');
    expect(() =>
      getHandler(IPC_CHANNELS.appAdvisorSettingsSave)(undefined, {
        archiveRetentionDays: MAX_ARCHIVE_RETENTION_DAYS + 1,
      }),
    ).toThrow('Invalid App Advisor deletion retention');
  });

  it('stores and forwards only identifiers and booleans from popout UI state', () => {
    const accessors = makeAccessors();
    mockedRegisterIpcHandler.mockClear();
    registerAppAdvisorHandlers(accessors);

    getHandler(IPC_CHANNELS.appAdvisorReportWindowUiState)(undefined, {
      activeWorkEntryId: 'entry-1',
      activeChatId: 'chat-1',
      navCollapsed: true,
      settingsModalOpen: false,
      archivedOverviewOpen: true,
      archivedOverviewWorkspaceId: 'app-advisor',
      emptyTrashConfirmationOpen: true,
      emptyTrashRunning: false,
      lastArchivedOverviewRequestId: 'request-1',
      lastArchivedOverviewConfirmationOpened: true,
      chatText: 'must not cross',
      arbitraryPath: '/tmp/escape',
    });

    expect(mockedSendToWindowDetailed).toHaveBeenCalledWith(
      accessors.mainWindow,
      IPC_CHANNELS.appAdvisorWindowUiStateChanged,
      {
        activeWorkEntryId: 'entry-1',
        activeChatId: 'chat-1',
        navCollapsed: true,
        groupEditorId: null,
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

  it("forwards the nav's open batch removal dialog as mode, count, and phase", () => {
    const accessors = makeAccessors();
    mockedRegisterIpcHandler.mockClear();
    registerAppAdvisorHandlers(accessors);
    const base = {
      activeWorkEntryId: 'entry-1',
      activeChatId: null,
      navCollapsed: false,
      settingsModalOpen: false,
      archivedOverviewOpen: false,
      archivedOverviewWorkspaceId: null,
      emptyTrashConfirmationOpen: false,
      emptyTrashRunning: false,
      lastArchivedOverviewRequestId: null,
      lastArchivedOverviewConfirmationOpened: null,
    };

    getHandler(IPC_CHANNELS.appAdvisorReportWindowUiState)(undefined, {
      ...base,
      batchRemovalDialog: {
        open: true,
        mode: 'delete',
        count: 2,
        phase: 'running',
        label: 'must not cross',
      },
    });

    expect(mockedSendToWindowDetailed).toHaveBeenLastCalledWith(
      accessors.mainWindow,
      IPC_CHANNELS.appAdvisorWindowUiStateChanged,
      {
        ...base,
        groupEditorId: null,
        batchRemovalDialog: {
          open: true,
          mode: 'delete',
          count: 2,
          phase: 'running',
        },
      },
    );

    getHandler(IPC_CHANNELS.appAdvisorReportWindowUiState)(undefined, {
      ...base,
      batchRemovalDialog: null,
    });
    expect(mockedSendToWindowDetailed).toHaveBeenLastCalledWith(
      accessors.mainWindow,
      IPC_CHANNELS.appAdvisorWindowUiStateChanged,
      { ...base, groupEditorId: null, batchRemovalDialog: null },
    );

    expect(() =>
      getHandler(IPC_CHANNELS.appAdvisorReportWindowUiState)(undefined, {
        ...base,
        batchRemovalDialog: {
          open: true,
          mode: 'erase',
          count: 2,
          phase: 'confirm',
        },
      }),
    ).toThrow('Invalid App Advisor window UI state');
    expect(() =>
      getHandler(IPC_CHANNELS.appAdvisorReportWindowUiState)(undefined, {
        ...base,
        batchRemovalDialog: {
          open: true,
          mode: 'archive',
          count: -1,
          phase: 'confirm',
        },
      }),
    ).toThrow('Invalid App Advisor window UI state');
  });

  it('validates artifact navigation and delegates only allowlisted targets', async () => {
    const accessors = makeAccessors();
    accessors.openAgentArtifact = jest.fn(() => Promise.resolve({ ok: true }));
    mockedRegisterIpcHandler.mockClear();
    registerAppAdvisorHandlers(accessors);
    const handler = getHandler(IPC_CHANNELS.appAdvisorOpenAgentArtifact);

    await expect(
      handler(undefined, {
        kind: 'shared_skill',
        skillId: 'skill-1',
        action: 'navigation.go_to_page',
      }),
    ).resolves.toEqual({ ok: true });
    expect(accessors.openAgentArtifact).toHaveBeenCalledWith({
      kind: 'shared_skill',
      skillId: 'skill-1',
    });

    await expect(
      handler(undefined, {
        kind: 'arbitrary',
        action: 'navigation.go_to_page',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'validation_failed', retryable: false },
    });
    expect(accessors.openAgentArtifact).toHaveBeenCalledTimes(1);

    await expect(
      handler(undefined, {
        kind: 'pipeline_execution',
        executionId: 'INVALID',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'validation_failed', retryable: false },
    });
    expect(accessors.openAgentArtifact).toHaveBeenCalledTimes(1);
  });

  it('accepts saved local Agent ids and rejects malformed ones', async () => {
    const accessors = makeAccessors();
    accessors.openAgentArtifact = jest.fn(() => Promise.resolve({ ok: true }));
    mockedRegisterIpcHandler.mockClear();
    registerAppAdvisorHandlers(accessors);
    const handler = getHandler(IPC_CHANNELS.appAdvisorOpenAgentArtifact);

    await expect(
      handler(undefined, {
        kind: 'agent_editor',
        agentId: 'agent_model_activity_reviewer',
      }),
    ).resolves.toEqual({ ok: true });
    expect(accessors.openAgentArtifact).toHaveBeenCalledWith({
      kind: 'agent_editor',
      agentId: 'agent_model_activity_reviewer',
    });

    for (const agentId of ['activity-reviewer', 'agent_model_../x']) {
      await expect(
        handler(undefined, { kind: 'agent_editor', agentId }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'validation_failed', retryable: false },
      });
    }
    expect(accessors.openAgentArtifact).toHaveBeenCalledTimes(1);
  });

  it('preserves source-specific pipeline locators in main-window routing', async () => {
    mockedRegisterIpcHandler.mockClear();
    registerAppAdvisorHandlers(makeAccessors());
    const handler = getHandler(IPC_CHANNELS.appAdvisorOpenAgentArtifact);

    const sharedPromise = handler(undefined, {
      kind: 'pipeline_editor',
      pipelineId: 'shared:canopy-cloud:remote-1',
      source: 'shared',
      sharedRemoteId: 'remote-1',
    });
    await Promise.resolve();
    const sharedRequest = findToolRequestByActionField(
      'sharedRemoteId',
      'remote-1',
    );
    expect(sharedRequest).toMatchObject({
      kind: 'dispatch_action',
      action: {
        type: 'pipeline.open_editor',
        pipelineId: 'shared:canopy-cloud:remote-1',
        sharedRemoteId: 'remote-1',
      },
    });
    if (typeof sharedRequest.requestId !== 'string') {
      throw new Error('Expected shared pipeline request id');
    }
    respond({
      requestId: sharedRequest.requestId,
      ok: true,
      uiState: uiState(),
    });
    await expect(sharedPromise).resolves.toEqual({ ok: true });

    const projectPromise = handler(undefined, {
      kind: 'pipeline_editor',
      pipelineId: 'project--build.yaml',
      source: 'project',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      repoId: 'child-repo',
    });
    await Promise.resolve();
    const projectRequest = findToolRequestByActionField(
      'projectId',
      'project-1',
    );
    expect(projectRequest).toMatchObject({
      kind: 'dispatch_action',
      action: {
        type: 'pipeline.open_editor',
        pipelineId: 'project--build.yaml',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        repoId: 'child-repo',
      },
    });
    if (typeof projectRequest.requestId !== 'string') {
      throw new Error('Expected project pipeline request id');
    }
    respond({
      requestId: projectRequest.requestId,
      ok: true,
      uiState: uiState(),
    });
    await expect(projectPromise).resolves.toEqual({ ok: true });
  });

  it('hands a pipeline run to the main window with its owner and job', async () => {
    mockedRegisterIpcHandler.mockClear();
    registerAppAdvisorHandlers(makeAccessors());
    const handler = getHandler(IPC_CHANNELS.appAdvisorOpenAgentArtifact);

    const promise = handler(undefined, {
      kind: 'pipeline_execution',
      executionId: 'execution-7',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      jobId: 'deploy_matrix-1',
    });
    await Promise.resolve();
    const request = findToolRequestByActionField('executionId', 'execution-7');
    expect(request).toMatchObject({
      kind: 'dispatch_action',
      action: {
        type: 'pipeline.open_run',
        executionId: 'execution-7',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        jobId: 'deploy_matrix-1',
      },
    });
    if (typeof request.requestId !== 'string') {
      throw new Error('Expected pipeline run request id');
    }
    respond({ requestId: request.requestId, ok: true, uiState: uiState() });
    await expect(promise).resolves.toEqual({ ok: true });

    // Without a job the action opens the run Summary.
    const summaryPromise = handler(undefined, {
      kind: 'pipeline_execution',
      executionId: 'execution-8',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
    await Promise.resolve();
    const summaryRequest = findToolRequestByActionField(
      'executionId',
      'execution-8',
    );
    expect(summaryRequest).toMatchObject({
      action: {
        type: 'pipeline.open_run',
        executionId: 'execution-8',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    });
    expect(summaryRequest.action).not.toHaveProperty('jobId');
    if (typeof summaryRequest.requestId !== 'string') {
      throw new Error('Expected pipeline run request id');
    }
    respond({
      requestId: summaryRequest.requestId,
      ok: false,
      error: {
        code: 'not_found',
        message: "Couldn't open the run. It may have been deleted.",
      },
      uiState: uiState(),
    });
    await expect(summaryPromise).resolves.toEqual({
      ok: false,
      error: {
        code: 'not_found',
        message: "Couldn't open the run. It may have been deleted.",
        retryable: false,
      },
    });
  });

  it('refuses a pipeline run handoff with a malformed job id', async () => {
    const accessors = makeAccessors();
    accessors.openAgentArtifact = jest.fn(() => Promise.resolve({ ok: true }));
    mockedRegisterIpcHandler.mockClear();
    registerAppAdvisorHandlers(accessors);

    await expect(
      getHandler(IPC_CHANNELS.appAdvisorOpenAgentArtifact)(undefined, {
        kind: 'pipeline_execution',
        executionId: 'execution-7',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        jobId: '../escape',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'validation_failed', retryable: false },
    });
    expect(accessors.openAgentArtifact).not.toHaveBeenCalled();
  });

  it('focuses the main window and routes only the allowlisted artifact action', async () => {
    const restore = jest.fn();
    const show = jest.fn();
    const focus = jest.fn();
    const moveTop = jest.fn();
    const mainWindow = Object.assign(new BrowserWindow(), {
      isDestroyed: jest.fn(() => false),
      isMinimized: jest.fn(() => true),
      isVisible: jest.fn(() => false),
      restore,
      show,
      focus,
      moveTop,
    });
    const accessors = makeAccessors();
    accessors.getMainWindow = (): WindowRef => mainWindow;
    mockedRegisterIpcHandler.mockClear();
    registerAppAdvisorHandlers(accessors);

    const promise = getHandler(IPC_CHANNELS.appAdvisorOpenAgentArtifact)(
      undefined,
      { kind: 'automation_editor', activityId: 'activity-1' },
    );
    await Promise.resolve();
    const request = findToolRequestByActionField('id', 'activity-1');
    expect(request).toMatchObject({
      kind: 'dispatch_action',
      action: { type: 'automation.open_editor', id: 'activity-1' },
    });
    if (typeof request.requestId !== 'string') {
      throw new Error('Expected automation request id');
    }
    respond({
      requestId: request.requestId,
      ok: true,
      uiState: uiState(),
    });
    await expect(promise).resolves.toEqual({ ok: true });
    expect(restore).toHaveBeenCalled();
    expect(show).toHaveBeenCalled();
    expect(focus).toHaveBeenCalled();
    expect(moveTop).toHaveBeenCalled();
  });

  it('returns a normalized error when the main renderer is unavailable', async () => {
    mockedSendToWindowDetailed.mockReturnValueOnce({
      delivered: false,
      reason: 'no_window',
    });
    mockedRegisterIpcHandler.mockClear();
    registerAppAdvisorHandlers(makeAccessors());

    await expect(
      getHandler(IPC_CHANNELS.appAdvisorOpenAgentArtifact)(undefined, {
        kind: 'automation_editor',
        activityId: 'activity-1',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'navigation_failed', retryable: true },
    });
  });

  it('routes background file presentation through the hidden-safe Advisor surface', async () => {
    const accessors = makeAccessors();
    const promise = requestAppAdvisorRendererTool(
      {
        kind: 'show_files',
        requestId: 'background-files',
        payload: {
          files: [{ path: '/tmp/report.md' }],
          target: { projectId: APP_ADVISOR_PROJECT_ID, worktreeId: 'entry' },
          origin: {
            projectId: APP_ADVISOR_PROJECT_ID,
            worktreeId: 'entry',
            chatTabId: 'chat',
          },
          intent: 'agent',
          presentation: 'background',
          reason: 'browser_handoff',
        },
      },
      accessors,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    respond({
      requestId: 'background-files',
      originChatId: 'chat',
      ok: true,
      result: {
        opened: 1,
        failed: 0,
        files: [{ path: '/tmp/report.md', ok: true }],
      },
    });
    await promise;
    expect(accessors.ensureAppAdvisorWindow).toHaveBeenCalledWith({
      workEntryId: 'entry',
    });
    expect(accessors.openAppAdvisorWindow).not.toHaveBeenCalled();
  });

  it('opens and routes ask-user requests to the App Advisor window past the normal timeout', async () => {
    jest.useFakeTimers();
    try {
      const accessors = makeAccessors();
      const promise = requestAppAdvisorRendererTool(
        {
          kind: 'ask_user_question',
          requestId: 'ask-routing',
          question: {
            id: 'question-1',
            question: 'Pick one',
            options: ['A'],
          },
        },
        accessors,
      );
      await Promise.resolve();
      await Promise.resolve();

      // CAN-1993: an agent-driven open is `background` so a window raise never
      // steals OS focus from whatever the user is doing in another app.
      expect(accessors.openAppAdvisorWindow).toHaveBeenCalledWith({
        focus: true,
        background: true,
      });
      expect(mockedSendToWindowDetailed).toHaveBeenCalledWith(
        accessors.advisorWindow,
        IPC_CHANNELS.appAdvisorToolRequest,
        expect.objectContaining({ kind: 'ask_user_question' }),
      );

      jest.advanceTimersByTime(31_000);
      respond({
        requestId: 'ask-routing',
        ok: true,
        answer: {
          questionId: 'question-1',
          question: 'Pick one',
          selectedOptions: ['a'],
        },
      });
      await expect(promise).resolves.toMatchObject({ ok: true });
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps an awaited OpenCode connect request alive beyond the ordinary action deadline', async () => {
    jest.useFakeTimers();
    try {
      const promise = requestAppAdvisorRendererTool(
        {
          kind: 'dispatch_action',
          requestId: 'opencode-slow-connect',
          action: { type: 'opencode.connection', operation: 'connect' },
          originWorktreeId: 'worktree-1',
        },
        makeAccessors(),
      );
      await Promise.resolve();
      jest.advanceTimersByTime(31_000);
      respond({
        requestId: 'opencode-slow-connect',
        ok: true,
        result: { value: { phase: 'connected' } },
      });
      await expect(promise).resolves.toMatchObject({ ok: true });
    } finally {
      jest.useRealTimers();
    }
  });

  it('times out abandoned ask-user requests after the prompt window', async () => {
    jest.useFakeTimers();
    try {
      const accessors = makeAccessors();
      const promise = requestAppAdvisorRendererTool(
        {
          kind: 'ask_user_question',
          requestId: 'ask-timeout',
          question: {
            id: 'question-1',
            question: 'Pick one',
            options: ['A'],
          },
        },
        accessors,
      );
      await Promise.resolve();
      await Promise.resolve();

      jest.advanceTimersByTime(ASK_USER_TIMEOUT_MS);
      await expect(promise).resolves.toMatchObject({
        ok: false,
        error: { code: 'timeout', retryable: true },
      });
      expect(mockedSendToWindowDetailed).toHaveBeenCalledWith(
        accessors.advisorWindow,
        IPC_CHANNELS.appAdvisorToolRequestCancelled,
        { requestId: 'ask-timeout' },
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('notifies the main renderer when a SetBaseBranch request times out', async () => {
    jest.useFakeTimers();
    try {
      const accessors = makeAccessors();
      const promise = requestAppAdvisorRendererTool(
        {
          kind: 'dispatch_action',
          requestId: 'set-base-timeout',
          action: {
            type: 'worktree.set_base_branch',
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            baseBranch: 'release/next',
          },
          originWorktreeId: 'worktree-1',
        },
        accessors,
      );
      await Promise.resolve();

      jest.advanceTimersByTime(ASK_USER_TIMEOUT_MS);
      await expect(promise).resolves.toMatchObject({
        ok: false,
        error: { code: 'timeout', retryable: true },
      });
      expect(mockedSendToWindowDetailed).toHaveBeenCalledWith(
        accessors.mainWindow,
        IPC_CHANNELS.appAdvisorToolRequestCancelled,
        { requestId: 'set-base-timeout' },
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancels and dismisses an in-flight ask-user request on abort', async () => {
    const accessors = makeAccessors();
    const controller = new AbortController();
    const promise = requestAppAdvisorRendererTool(
      {
        kind: 'ask_user_question',
        requestId: 'ask-cancelled',
        question: {
          id: 'question-1',
          question: 'Pick one',
          options: ['A'],
        },
      },
      accessors,
      { signal: controller.signal },
    );
    await Promise.resolve();
    await Promise.resolve();

    controller.abort();

    await expect(promise).resolves.toMatchObject({
      ok: false,
      error: { code: 'execution_failed', message: 'ask_user_cancelled' },
    });
    expect(mockedSendToWindowDetailed).toHaveBeenCalledWith(
      accessors.advisorWindow,
      IPC_CHANNELS.appAdvisorToolRequestCancelled,
      { requestId: 'ask-cancelled' },
    );
  });

  it('does not deliver an aborted ask-user request after window startup', async () => {
    let finishOpening: (() => void) | undefined;
    const accessors = makeAccessors();
    jest.mocked(accessors.openAppAdvisorWindow).mockReturnValue(
      new Promise((resolve) => {
        finishOpening = (): void => {
          resolve({ open: true, focused: true });
        };
      }),
    );
    const controller = new AbortController();
    const request = {
      kind: 'ask_user_question' as const,
      requestId: 'ask-cancelled-during-startup',
      question: {
        id: 'question-1',
        question: 'Pick one',
        options: ['A'],
      },
    };
    const promise = requestAppAdvisorRendererTool(request, accessors, {
      signal: controller.signal,
    });
    await Promise.resolve();

    controller.abort();
    if (!finishOpening) {
      throw new Error('Expected App Advisor window startup to begin');
    }
    finishOpening();

    await expect(promise).resolves.toMatchObject({
      ok: false,
      error: { code: 'execution_failed', message: 'ask_user_cancelled' },
    });
    await Promise.resolve();
    expect(mockedSendToWindowDetailed).not.toHaveBeenCalledWith(
      accessors.advisorWindow,
      IPC_CHANNELS.appAdvisorToolRequest,
      request,
    );
    await expect(
      requestAppAdvisorRendererTool(request, accessors),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'execution_failed', message: 'ask_user_cancelled' },
    });
  });

  it('returns surface_unavailable when the main window cannot receive UI requests', async () => {
    mockedSendToWindowDetailed.mockReturnValueOnce({
      delivered: false,
      reason: 'no_window',
    });
    const accessors = makeAccessors();

    await expect(
      requestAppAdvisorRendererTool(
        { kind: 'get_current_ui_state', requestId: 'missing-main' },
        accessors,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'surface_unavailable', retryable: true },
    });
  });
});

describe('App Advisor renderer request replay', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedSendToWindowDetailed.mockReturnValue({ delivered: true });
    registerAppAdvisorHandlers(makeAccessors());
  });

  const createWorktree = (
    requestId: string,
  ): Parameters<typeof requestAppAdvisorRendererTool>[0] => ({
    kind: 'dispatch_action',
    requestId,
    originWorktreeId: 'wt-1',
    action: {
      type: 'worktree.create',
      workspaceId: 'ws-1',
      baseWorktreeId: 'wt-1',
      select: false,
    },
  });

  it('runs a retried request again after a retryable failure, and replays a success', async () => {
    mockedSendToWindowDetailed.mockReturnValueOnce({
      delivered: false,
      reason: 'no_window',
    });
    await expect(
      requestAppAdvisorRendererTool(createWorktree('stage-1'), makeAccessors()),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'surface_unavailable', retryable: true },
    });

    // The renderer recovers: the same request id reaches it again.
    const retried = requestAppAdvisorRendererTool(
      createWorktree('stage-1'),
      makeAccessors(),
    );
    await Promise.resolve();
    await Promise.resolve();
    respond({
      requestId: 'stage-1',
      ok: true,
      result: { workspaceId: 'ws-1', worktreeId: 'wt-new' },
    });
    await expect(retried).resolves.toMatchObject({
      ok: true,
      result: { worktreeId: 'wt-new' },
    });
    expect(mockedSendToWindowDetailed).toHaveBeenCalledTimes(2);

    // A caller that lost that success replays it; nothing reaches the
    // renderer, so no second worktree is created.
    await expect(
      requestAppAdvisorRendererTool(createWorktree('stage-1'), makeAccessors()),
    ).resolves.toMatchObject({ ok: true, result: { worktreeId: 'wt-new' } });
    expect(mockedSendToWindowDetailed).toHaveBeenCalledTimes(2);
  });

  const toolRequestsSent = (): number =>
    mockedSendToWindowDetailed.mock.calls.filter(
      ([, channel]) => channel === IPC_CHANNELS.appAdvisorToolRequest,
    ).length;

  it('joins a retry to a timed-out request still running instead of running it again', async () => {
    jest.useFakeTimers();
    try {
      const original = requestAppAdvisorRendererTool(
        createWorktree('slow-1'),
        makeAccessors(),
      );
      await jest.advanceTimersByTimeAsync(30_001);
      await expect(original).resolves.toMatchObject({
        ok: false,
        error: { code: 'timeout', retryable: true },
      });

      const retried = requestAppAdvisorRendererTool(
        createWorktree('slow-1'),
        makeAccessors(),
      );
      await jest.advanceTimersByTimeAsync(1_000);
      // The renderer finishes the original creation late.
      respond({
        requestId: 'slow-1',
        ok: true,
        result: { workspaceId: 'ws-1', worktreeId: 'wt-slow' },
      });
      await expect(retried).resolves.toMatchObject({
        ok: true,
        result: { worktreeId: 'wt-slow' },
      });
      await expect(
        requestAppAdvisorRendererTool(
          createWorktree('slow-1'),
          makeAccessors(),
        ),
      ).resolves.toMatchObject({ ok: true, result: { worktreeId: 'wt-slow' } });
      expect(toolRequestsSent()).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('runs a retry again once the renderer that held the timed-out request reloads', async () => {
    jest.useFakeTimers();
    try {
      const mainWindow = Object.assign(new BrowserWindow(), {
        webContents: new EventEmitter(),
        isDestroyed: (): boolean => false,
      });
      const accessors = {
        ...makeAccessors(),
        getMainWindow: (): WindowRef => mainWindow,
      };
      const original = requestAppAdvisorRendererTool(
        createWorktree('reload-1'),
        accessors,
      );
      await jest.advanceTimersByTimeAsync(30_001);
      await expect(original).resolves.toMatchObject({
        error: { code: 'timeout' },
      });

      mainWindow.webContents.emit('did-navigate');
      const retried = requestAppAdvisorRendererTool(
        createWorktree('reload-1'),
        accessors,
      );
      await jest.advanceTimersByTimeAsync(0);
      expect(toolRequestsSent()).toBe(2);
      respond({
        requestId: 'reload-1',
        ok: true,
        result: { workspaceId: 'ws-1', worktreeId: 'wt-after-reload' },
      });
      await expect(retried).resolves.toMatchObject({ ok: true });
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops fencing a timed-out request that never settles after a bounded time', async () => {
    jest.useFakeTimers();
    try {
      const original = requestAppAdvisorRendererTool(
        createWorktree('lost-1'),
        makeAccessors(),
      );
      await jest.advanceTimersByTimeAsync(30_001);
      await expect(original).resolves.toMatchObject({
        error: { code: 'timeout' },
      });
      await jest.advanceTimersByTimeAsync(10 * 60_000);
      void requestAppAdvisorRendererTool(
        createWorktree('lost-1'),
        makeAccessors(),
      );
      await jest.advanceTimersByTimeAsync(0);
      expect(toolRequestsSent()).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('App Advisor ask-user settlement API (CAN-2565)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedSendToWindowDetailed.mockReturnValue({ delivered: true });
    registerAppAdvisorHandlers(makeAccessors());
  });

  function askUserQuestionRequest(
    requestId: string,
    chatId?: string,
  ): Parameters<typeof requestAppAdvisorRendererTool>[0] {
    return {
      kind: 'ask_user_question',
      requestId,
      question: { id: 'question-1', question: 'Pick one', options: ['A'] },
      ...(chatId ? { chatId } : {}),
    };
  }

  it('settles an awaiting question only for its own chat', async () => {
    const promise = requestAppAdvisorRendererTool(
      askUserQuestionRequest('ask-bound', 'chat-a'),
      makeAccessors(),
    );
    await Promise.resolve();
    await Promise.resolve();

    // A settlement naming another chat is a spoof and must be refused
    // without touching the pending request.
    expect(
      completeAppAdvisorAskUserRequest('ask-bound', 'chat-b', {
        question: 'Pick one',
        selectedOptions: ['A'],
      }),
    ).toBe(false);
    expect(
      completeAppAdvisorAskUserRequest('ask-bound', 'chat-a', {
        question: 'Pick one',
        selectedOptions: ['A'],
      }),
    ).toBe(true);
    await expect(promise).resolves.toMatchObject({
      ok: true,
      answer: { selectedOptions: ['A'] },
    });
    // Already settled: a second settlement finds no pending request.
    expect(completeAppAdvisorAskUserRequest('ask-bound', 'chat-a', null)).toBe(
      false,
    );
  });

  it('retains an answered question for the portal projection but not a dismissal (CAN-2608)', async () => {
    const promise = requestAppAdvisorRendererTool(
      askUserQuestionRequest('ask-answered', 'chat-a'),
      makeAccessors(),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(
      completeAppAdvisorAskUserRequest('ask-answered', 'chat-a', {
        question: 'Pick one',
        selectedOptions: ['A'],
      }),
    ).toBe(true);
    await promise;
    const retained = listAnsweredAppAdvisorAskUserQuestions().find(
      (entry) => entry.requestId === 'ask-answered',
    );
    expect(retained?.chatId).toBe('chat-a');
    expect(retained?.question.question).toBe('Pick one');
    expect(retained?.answer.selectedOptions).toEqual(['A']);

    const dismissed = requestAppAdvisorRendererTool(
      askUserQuestionRequest('ask-dismissed', 'chat-a'),
      makeAccessors(),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(
      completeAppAdvisorAskUserRequest('ask-dismissed', 'chat-a', null),
    ).toBe(true);
    await dismissed;
    expect(
      listAnsweredAppAdvisorAskUserQuestions().some(
        (entry) => entry.requestId === 'ask-dismissed',
      ),
    ).toBe(false);
  });

  it('redacts secret freeform answers and keeps one latest entry per question text (CAN-2608)', async () => {
    const secretRequest: Parameters<typeof requestAppAdvisorRendererTool>[0] = {
      kind: 'ask_user_question',
      requestId: 'ask-secret',
      question: {
        id: 'question-1',
        question: 'API key?',
        options: [],
        secret: true,
      },
      chatId: 'chat-a',
    };
    const first = requestAppAdvisorRendererTool(secretRequest, makeAccessors());
    await Promise.resolve();
    await Promise.resolve();
    expect(
      completeAppAdvisorAskUserRequest('ask-secret', 'chat-a', {
        question: 'API key?',
        selectedOptions: [],
        freeformText: 'sk-live-super-secret',
      }),
    ).toBe(true);
    await first;
    const secretEntry = listAnsweredAppAdvisorAskUserQuestions().find(
      (entry) => entry.requestId === 'ask-secret',
    );
    // The retained answer must never hold the secret in plaintext: the
    // projection puts it on the portal wire verbatim.
    expect(secretEntry?.answer.freeformText).toBe('[hidden]');

    // Same question text answered again: latest wins, one entry total.
    const repeat: Parameters<typeof requestAppAdvisorRendererTool>[0] = {
      kind: 'ask_user_question',
      requestId: 'ask-secret-2',
      question: {
        id: 'question-2',
        question: 'API key?',
        options: [],
        secret: true,
      },
      chatId: 'chat-a',
    };
    const second = requestAppAdvisorRendererTool(repeat, makeAccessors());
    await Promise.resolve();
    await Promise.resolve();
    expect(
      completeAppAdvisorAskUserRequest('ask-secret-2', 'chat-a', {
        question: 'API key?',
        selectedOptions: [],
        freeformText: 'sk-live-rotated',
      }),
    ).toBe(true);
    await second;
    const matching = listAnsweredAppAdvisorAskUserQuestions().filter(
      (entry) => entry.question.question === 'API key?',
    );
    expect(matching.map((entry) => entry.requestId)).toEqual(['ask-secret-2']);
  });

  it('refuses to settle a request with no recorded chat binding', async () => {
    const promise = requestAppAdvisorRendererTool(
      askUserQuestionRequest('ask-unbound'),
      makeAccessors(),
    );
    await Promise.resolve();
    await Promise.resolve();

    // A pending record without a chat attribution cannot be verified, so it
    // fails closed rather than letting any chatId claim it.
    expect(
      completeAppAdvisorAskUserRequest('ask-unbound', 'chat-a', null),
    ).toBe(false);

    respond({
      requestId: 'ask-unbound',
      ok: true,
      answer: {
        questionId: 'question-1',
        question: 'Pick one',
        selectedOptions: ['A'],
      },
    });
    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it('keeps the first settlement when a late renderer response races it', async () => {
    const promise = requestAppAdvisorRendererTool(
      askUserQuestionRequest('ask-race', 'chat-a'),
      makeAccessors(),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(
      completeAppAdvisorAskUserRequest('ask-race', 'chat-a', {
        question: 'Pick one',
        selectedOptions: ['A'],
      }),
    ).toBe(true);
    await expect(promise).resolves.toMatchObject({ ok: true });

    // A late renderer dismissal for the already-settled request must not
    // replace the cached settlement duplicate lookups replay.
    respond({
      requestId: 'ask-race',
      originChatId: 'chat-a',
      ok: false,
      error: {
        code: 'execution_failed',
        message: 'Orchestrator question was dismissed without an answer.',
      },
    });

    await expect(
      requestAppAdvisorRendererTool(
        askUserQuestionRequest('ask-race', 'chat-a'),
        makeAccessors(),
      ),
    ).resolves.toMatchObject({
      ok: true,
      answer: { selectedOptions: ['A'] },
    });
  });
});

describe('App Advisor renderer-tool chat scoping (CAN-3976)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedSendToWindowDetailed.mockReturnValue({ delivered: true });
    registerAppAdvisorHandlers(makeAccessors());
  });

  function dispatchRequest(
    requestId: string,
    originChatTabId: string,
    page: 'automations' | 'pipelines' = 'automations',
  ): Parameters<typeof requestAppAdvisorRendererTool>[0] {
    return {
      kind: 'dispatch_action',
      requestId,
      action: { type: 'navigation.go_to_page', page },
      originWorktreeId: 'advisor-entry',
      originChatTabId,
    };
  }

  function deliveredToolRequests(): unknown[] {
    return mockedSendToWindowDetailed.mock.calls
      .filter(([, channel]) => channel === IPC_CHANNELS.appAdvisorToolRequest)
      .map(([, , payload]) => payload);
  }

  async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  it('dispatches the same request id from two chats separately', async () => {
    const first = requestAppAdvisorRendererTool(
      dispatchRequest('scoped-1', 'chat-a', 'automations'),
      makeAccessors(),
    );
    const second = requestAppAdvisorRendererTool(
      dispatchRequest('scoped-1', 'chat-b', 'pipelines'),
      makeAccessors(),
    );
    await flush();

    expect(deliveredToolRequests()).toEqual([
      expect.objectContaining({ originChatTabId: 'chat-a' }),
      expect.objectContaining({ originChatTabId: 'chat-b' }),
    ]);
    respond({
      requestId: 'scoped-1',
      originChatId: 'chat-b',
      ok: true,
      result: { page: 'pipelines' },
    });
    respond({
      requestId: 'scoped-1',
      originChatId: 'chat-a',
      ok: true,
      result: { page: 'automations' },
    });
    await expect(first).resolves.toMatchObject({
      result: { page: 'automations' },
    });
    await expect(second).resolves.toMatchObject({
      result: { page: 'pipelines' },
    });
  });

  it('never replays a completed response to another chat', async () => {
    const first = requestAppAdvisorRendererTool(
      dispatchRequest('scoped-2', 'chat-a'),
      makeAccessors(),
    );
    await flush();
    respond({
      requestId: 'scoped-2',
      originChatId: 'chat-a',
      ok: true,
      result: { chat: 'a' },
    });
    await expect(first).resolves.toMatchObject({ result: { chat: 'a' } });

    const second = requestAppAdvisorRendererTool(
      dispatchRequest('scoped-2', 'chat-b'),
      makeAccessors(),
    );
    await flush();
    expect(deliveredToolRequests()).toHaveLength(2);
    respond({
      requestId: 'scoped-2',
      originChatId: 'chat-b',
      ok: true,
      result: { chat: 'b' },
    });
    await expect(second).resolves.toMatchObject({ result: { chat: 'b' } });
  });

  it('replays the cached and in-flight response for the same chat', async () => {
    const first = requestAppAdvisorRendererTool(
      dispatchRequest('scoped-3', 'chat-a'),
      makeAccessors(),
    );
    const inFlightDuplicate = requestAppAdvisorRendererTool(
      dispatchRequest('scoped-3', 'chat-a'),
      makeAccessors(),
    );
    await flush();
    respond({
      requestId: 'scoped-3',
      originChatId: 'chat-a',
      ok: true,
      result: { once: true },
    });
    await expect(first).resolves.toMatchObject({ result: { once: true } });
    await expect(inFlightDuplicate).resolves.toMatchObject({
      result: { once: true },
    });
    await expect(
      requestAppAdvisorRendererTool(
        dispatchRequest('scoped-3', 'chat-a'),
        makeAccessors(),
      ),
    ).resolves.toMatchObject({ result: { once: true } });
    expect(deliveredToolRequests()).toHaveLength(1);
  });

  it('does not settle a request with a response for another or no chat', async () => {
    let settled = false;
    const promise = requestAppAdvisorRendererTool(
      dispatchRequest('scoped-4', 'chat-a'),
      makeAccessors(),
    ).then((response) => {
      settled = true;
      return response;
    });
    await flush();

    respond({ requestId: 'scoped-4', originChatId: 'chat-b', ok: true });
    respond({ requestId: 'scoped-4', ok: true });
    await flush();
    expect(settled).toBe(false);

    respond({
      requestId: 'scoped-4',
      originChatId: 'chat-a',
      ok: true,
      result: { chat: 'a' },
    });
    await expect(promise).resolves.toMatchObject({ result: { chat: 'a' } });
  });

  it('times out only the request whose deadline passed', async () => {
    jest.useFakeTimers();
    try {
      const timedOut = requestAppAdvisorRendererTool(
        dispatchRequest('scoped-5', 'chat-a'),
        makeAccessors(),
      );
      await flush();
      jest.advanceTimersByTime(20_000);
      const later = requestAppAdvisorRendererTool(
        dispatchRequest('scoped-5', 'chat-b'),
        makeAccessors(),
      );
      await flush();
      jest.advanceTimersByTime(15_000);

      await expect(timedOut).resolves.toMatchObject({
        ok: false,
        error: { code: 'timeout' },
      });
      respond({
        requestId: 'scoped-5',
        originChatId: 'chat-b',
        ok: true,
        result: { chat: 'b' },
      });
      await expect(later).resolves.toMatchObject({
        ok: true,
        result: { chat: 'b' },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('aborts only the cancelled chat request', async () => {
    const controller = new AbortController();
    const aborted = requestAppAdvisorRendererTool(
      dispatchRequest('scoped-6', 'chat-a'),
      makeAccessors(),
      { signal: controller.signal },
    );
    const kept = requestAppAdvisorRendererTool(
      dispatchRequest('scoped-6', 'chat-b'),
      makeAccessors(),
    );
    await flush();

    controller.abort();
    await expect(aborted).resolves.toMatchObject({
      ok: false,
      error: { message: 'ask_user_cancelled' },
    });
    expect(mockedSendToWindowDetailed).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.appAdvisorToolRequestCancelled,
      { requestId: 'scoped-6', originChatId: 'chat-a' },
    );
    respond({
      requestId: 'scoped-6',
      originChatId: 'chat-b',
      ok: true,
      result: { chat: 'b' },
    });
    await expect(kept).resolves.toMatchObject({
      ok: true,
      result: { chat: 'b' },
    });
  });

  it('settles surface_unavailable only for the request that failed delivery', async () => {
    const kept = requestAppAdvisorRendererTool(
      dispatchRequest('scoped-7', 'chat-a'),
      makeAccessors(),
    );
    await flush();
    mockedSendToWindowDetailed.mockReturnValueOnce({
      delivered: false,
      reason: 'no_window',
    });
    await expect(
      requestAppAdvisorRendererTool(
        dispatchRequest('scoped-7', 'chat-b'),
        makeAccessors(),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'surface_unavailable' },
    });

    respond({
      requestId: 'scoped-7',
      originChatId: 'chat-a',
      ok: true,
      result: { chat: 'a' },
    });
    await expect(kept).resolves.toMatchObject({
      ok: true,
      result: { chat: 'a' },
    });
  });

  it('settles a portal answer only for the named chat question', async () => {
    const question = (
      chatId: string,
    ): ReturnType<typeof requestAppAdvisorRendererTool> =>
      requestAppAdvisorRendererTool(
        {
          kind: 'ask_user_question',
          requestId: 'scoped-ask',
          question: { id: 'question-1', question: 'Pick one', options: ['A'] },
          chatId,
        },
        makeAccessors(),
      );
    const first = question('chat-a');
    const second = question('chat-b');
    await flush();

    expect(
      completeAppAdvisorAskUserRequest('scoped-ask', 'chat-b', {
        question: 'Pick one',
        selectedOptions: ['A'],
      }),
    ).toBe(true);
    await expect(second).resolves.toMatchObject({
      ok: true,
      answer: { selectedOptions: ['A'] },
    });
    expect(completeAppAdvisorAskUserRequest('scoped-ask', 'chat-a', null)).toBe(
      true,
    );
    await expect(first).resolves.toMatchObject({
      ok: false,
      error: { code: 'execution_failed' },
    });
  });

  it('retains same-id answered questions from two chats separately', async () => {
    const question = (
      chatId: string,
    ): ReturnType<typeof requestAppAdvisorRendererTool> =>
      requestAppAdvisorRendererTool(
        {
          kind: 'ask_user_question',
          requestId: 'scoped-answered',
          question: {
            id: 'question-1',
            question: `Pick ${chatId}`,
            options: [],
          },
          chatId,
        },
        makeAccessors(),
      );
    const first = question('chat-a');
    const second = question('chat-b');
    await flush();
    for (const chatId of ['chat-a', 'chat-b']) {
      completeAppAdvisorAskUserRequest('scoped-answered', chatId, {
        question: `Pick ${chatId}`,
        selectedOptions: [chatId],
      });
    }
    await Promise.all([first, second]);

    expect(
      listAnsweredAppAdvisorAskUserQuestions()
        .filter((entry) => entry.requestId === 'scoped-answered')
        .map((entry) => [entry.chatId, entry.answer.selectedOptions]),
    ).toEqual([
      ['chat-a', ['chat-a']],
      ['chat-b', ['chat-b']],
    ]);
  });
});

describe('App Advisor renderer tools for a chat driven from another computer', () => {
  const remoteMain = new BrowserWindow();
  const remoteAdvisor = new BrowserWindow();

  function makeRemoteHost(
    windows: { main: WindowRef; advisor: WindowRef } = {
      main: remoteMain,
      advisor: remoteAdvisor,
    },
  ): RemoteAppAdvisorWindowHost {
    const closed = { open: false, focused: false, layout: 'full' as const };
    return {
      routeKey: 'controller-1',
      focusMainWindow: jest.fn(() => Promise.resolve()),
      getMainWindow: () => windows.main,
      getAppAdvisorWindow: () => windows.advisor,
      openAppAdvisorWindow: jest.fn(() =>
        Promise.resolve({ ...closed, open: true }),
      ),
      ensureAppAdvisorWindow: jest.fn(() => Promise.resolve(closed)),
      closeAppAdvisorWindow: jest.fn(() => Promise.resolve(closed)),
      toggleAppAdvisorWindow: jest.fn(() => Promise.resolve(closed)),
      getAppAdvisorWindowState: () => closed,
      markAppAdvisorWindowRendererReady: jest.fn(() => closed),
      reportAppAdvisorWindowUiState: jest.fn(),
    };
  }

  const bridgeSender = { id: 'bridge' };
  let remote: RemoteAppAdvisorWindowHost;
  let accessors: ReturnType<typeof makeAccessors>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedSendToWindowDetailed.mockReturnValue({ delivered: true });
    remote = makeRemoteHost();
    accessors = makeAccessors();
    registerAppAdvisorHandlers(accessors);
    setRemoteAppAdvisorWindowHostResolver((sender) =>
      Object.is(sender, bridgeSender) ? remote : null,
    );
    setRendererToolSurfaceRouter((request) =>
      request.kind === 'dispatch_action' &&
      request.originChatTabId === 'remote-chat'
        ? remote
        : null,
    );
  });

  afterEach(() => {
    setRemoteAppAdvisorWindowHostResolver(null);
    setRendererToolSurfaceRouter(null);
  });

  function toolRequestTargets(): unknown[] {
    return mockedSendToWindowDetailed.mock.calls
      .filter(([, channel]) => channel === IPC_CHANNELS.appAdvisorToolRequest)
      .map(([target]) => target);
  }

  it('runs actions of a chat driven from a controller in its window and others here', async () => {
    const driven = requestAppAdvisorRendererTool(
      {
        kind: 'dispatch_action',
        requestId: 'driven',
        action: { type: 'navigation.go_to_page', page: 'overview' },
        originWorktreeId: 'entry-1',
        originChatTabId: 'remote-chat',
      },
      accessors,
    );
    const local = requestAppAdvisorRendererTool(
      {
        kind: 'dispatch_action',
        requestId: 'local',
        action: { type: 'navigation.go_to_page', page: 'overview' },
        originWorktreeId: 'entry-1',
        originChatTabId: 'local-chat',
      },
      accessors,
    );
    await Promise.resolve();
    expect(toolRequestTargets()).toEqual([remoteMain, accessors.mainWindow]);
    respond({ requestId: 'driven', originChatId: 'remote-chat', ok: true });
    respond({ requestId: 'local', originChatId: 'local-chat', ok: true });
    await expect(driven).resolves.toMatchObject({ ok: true });
    await expect(local).resolves.toMatchObject({ ok: true });
  });

  it('answers App Advisor window calls from a controller with its own window', async () => {
    await getHandler(IPC_CHANNELS.appAdvisorWindowOpen)(
      { sender: bridgeSender },
      { chatId: 'chat-1' },
    );
    getHandler(IPC_CHANNELS.appAdvisorWindowRendererReady)({
      sender: bridgeSender,
    });
    expect(remote.openAppAdvisorWindow).toHaveBeenCalledWith({
      chatId: 'chat-1',
    });
    expect(remote.markAppAdvisorWindowRendererReady).toHaveBeenCalled();
    expect(accessors.openAppAdvisorWindow).not.toHaveBeenCalled();
    expect(accessors.markAppAdvisorWindowRendererReady).not.toHaveBeenCalled();

    await getHandler(IPC_CHANNELS.appAdvisorWindowOpen)(
      { sender: { id: 'app-window' } },
      undefined,
    );
    expect(accessors.openAppAdvisorWindow).toHaveBeenCalledTimes(1);
  });

  it('sends questions again only to the window that was asked', async () => {
    setRendererToolSurfaceRouter((request) =>
      request.kind === 'ask_user_question' && request.chatId === 'remote-chat'
        ? remote
        : null,
    );
    const question = {
      id: 'question-1',
      question: 'Which one?',
      options: ['A'],
    };
    void requestAppAdvisorRendererTool(
      {
        kind: 'ask_user_question',
        requestId: 'remote-q',
        question,
        chatId: 'remote-chat',
      },
      accessors,
    );
    void requestAppAdvisorRendererTool(
      {
        kind: 'ask_user_question',
        requestId: 'local-q',
        question,
        chatId: 'local-chat',
      },
      accessors,
    );
    await Promise.resolve();
    mockedSendToWindowDetailed.mockClear();

    redeliverPendingAppAdvisorAskUserRequests(() => accessors.advisorWindow);
    redeliverPendingAppAdvisorAskUserRequests(
      remote.getAppAdvisorWindow,
      remote,
    );
    expect(
      mockedSendToWindowDetailed.mock.calls.map(([target, , payload]) => [
        target,
        isRecord(payload) ? payload.requestId : null,
      ]),
    ).toEqual([
      [accessors.advisorWindow, 'local-q'],
      [remoteAdvisor, 'remote-q'],
    ]);
    respond({ requestId: 'remote-q', originChatId: 'remote-chat', ok: false });
    respond({ requestId: 'local-q', originChatId: 'local-chat', ok: false });
  });

  it('asks the controller for the UI state of a chat driven from there, without caching it', async () => {
    setRendererToolSurfaceRouter((request) =>
      request.kind === 'get_current_ui_state' &&
      request.originChatTabId === 'remote-chat'
        ? remote
        : null,
    );
    setLatestAppAdvisorUiState(uiState());
    const pendingState = requestCurrentAppAdvisorUiState(
      accessors,
      'remote-chat',
    );
    await Promise.resolve();
    expect(toolRequestTargets()).toEqual([remoteMain]);
    const remoteState = { ...uiState(), revision: 42 };
    // The controller's answer arrives through its bridge.
    getHandler(IPC_CHANNELS.appAdvisorToolResponse)(
      { sender: bridgeSender },
      {
        requestId: ((): string => {
          const payload = mockedSendToWindowDetailed.mock.calls.find(
            ([, channel]) => channel === IPC_CHANNELS.appAdvisorToolRequest,
          )?.[2];
          return isRecord(payload) && typeof payload.requestId === 'string'
            ? payload.requestId
            : '';
        })(),
        originChatId: 'remote-chat',
        ok: true,
        uiState: remoteState,
      },
    );
    await expect(pendingState).resolves.toMatchObject({ revision: 42 });
    expect(getLatestAppAdvisorUiState().revision).toBe(1);
  });

  it('sends a question again to a controller that reconnected', async () => {
    setRendererToolSurfaceRouter((request) =>
      request.kind === 'ask_user_question' && request.chatId === 'remote-chat'
        ? remote
        : null,
    );
    void requestAppAdvisorRendererTool(
      {
        kind: 'ask_user_question',
        requestId: 'reconnect-q',
        question: { id: 'question-1', question: 'Which one?', options: ['A'] },
        chatId: 'remote-chat',
      },
      accessors,
    );
    await Promise.resolve();
    mockedSendToWindowDetailed.mockClear();

    // The reconnected session has new bridge windows behind a new surface.
    const newAdvisor = new BrowserWindow();
    const reconnected = makeRemoteHost({
      main: remoteMain,
      advisor: newAdvisor,
    });
    redeliverPendingAppAdvisorAskUserRequests(
      reconnected.getAppAdvisorWindow,
      reconnected,
    );
    expect(
      mockedSendToWindowDetailed.mock.calls.map(([target, , payload]) => [
        target,
        isRecord(payload) ? payload.requestId : null,
      ]),
    ).toEqual([[newAdvisor, 'reconnect-q']]);
    respond({
      requestId: 'reconnect-q',
      originChatId: 'remote-chat',
      ok: false,
    });
  });

  it('offers no cached state to implicit targets of a chat driven from a controller', () => {
    setRendererToolSurfaceRouter((request) =>
      request.kind === 'get_current_ui_state' &&
      request.originChatTabId === 'remote-chat'
        ? remote
        : null,
    );
    setLatestAppAdvisorUiState(uiState());
    expect(getCachedAppAdvisorUiStateForChat('remote-chat')).toBeNull();
    expect(getCachedAppAdvisorUiStateForChat('local-chat')?.revision).toBe(1);
    expect(getCachedAppAdvisorUiStateForChat(undefined)?.revision).toBe(1);
  });

  it('opens a clicked file in the window that was clicked, whoever drives the chat', async () => {
    setRendererToolSurfaceRouter((request) =>
      request.kind === 'show_files' &&
      request.payload.origin.chatTabId === 'remote-chat'
        ? remote
        : null,
    );
    const request = {
      path: 'src/index.ts',
      target: { projectId: 'project-1', worktreeId: 'worktree-1' },
      origin: {
        projectId: 'app-advisor',
        worktreeId: 'global',
        chatTabId: 'remote-chat',
      },
    };
    const handler = getHandler(IPC_CHANNELS.appAdvisorOpenTurnFile);
    const opens = [
      handler({ sender: { id: 'app-window' } }, request),
      handler({ sender: bridgeSender }, request),
    ].map((open) => Promise.resolve(open).catch(() => undefined));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(toolRequestTargets()).toEqual([accessors.mainWindow, remoteMain]);
    // The window the file opened in comes forward on its own computer.
    expect(remote.focusMainWindow).toHaveBeenCalledTimes(1);
    for (const [, channel, payload] of mockedSendToWindowDetailed.mock.calls) {
      if (
        channel === IPC_CHANNELS.appAdvisorToolRequest &&
        isRecord(payload) &&
        typeof payload.requestId === 'string'
      ) {
        respond({
          requestId: payload.requestId,
          originChatId: 'remote-chat',
          ok: false,
        });
      }
    }
    await Promise.all(opens);
  });

  it("opens an artifact clicked in a controller's App Advisor in its window", async () => {
    const promise = getHandler(IPC_CHANNELS.appAdvisorOpenAgentArtifact)(
      { sender: bridgeSender },
      {
        kind: 'pipeline_execution',
        executionId: 'execution-remote',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(toolRequestTargets()).toEqual([remoteMain]);
    expect(remote.focusMainWindow).toHaveBeenCalledTimes(1);
    const request = findToolRequestByActionField(
      'executionId',
      'execution-remote',
    );
    if (typeof request.requestId !== 'string') {
      throw new Error('Expected an artifact request id');
    }
    respond({ requestId: request.requestId, ok: true, uiState: uiState() });
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("tells a controller's App Advisor when a file it opened closes", () => {
    const controllerMain = Object.assign(new BrowserWindow(), {
      webContents: bridgeSender,
    });
    remote = makeRemoteHost({ main: controllerMain, advisor: remoteAdvisor });
    getHandler(IPC_CHANNELS.appAdvisorTurnFileClosed)(
      { sender: bridgeSender },
      'file-focus-return',
    );
    expect(mockedSendToWindowDetailed).toHaveBeenLastCalledWith(
      remoteAdvisor,
      IPC_CHANNELS.appAdvisorTurnFileClosed,
      'file-focus-return',
    );
  });
});
