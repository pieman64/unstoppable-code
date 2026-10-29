/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AppAdvisorActionResponse,
  AppAdvisorRendererToolCancellation,
  AppAdvisorRendererToolRequest,
  AppAdvisorRendererToolResponse,
  AppAdvisorUiStateEnvelope,
} from '@canopy/desktop-shared/types';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import * as appActionDispatcher from '@/lib/app-actions/dispatcher';
import * as showFiles from '@/lib/show-files';
import { useAppAdvisorStore } from '@/stores/appAdvisorStore';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import {
  AppAdvisorMainRuntimeBridge,
  AppAdvisorWindowRuntimeBridge,
} from '../AppAdvisorRuntimeBridge';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function makeEnvelope(
  digest = 'bridge-digest',
  revision = 7,
): AppAdvisorUiStateEnvelope {
  return {
    version: 1,
    revision,
    capturedAt: new Date(0).toISOString(),
    digest,
    snapshot: {
      activePage: 'overview',
      overlays: {
        commandPaletteOpen: false,
        fileSearchPaletteOpen: false,
        prPickerOpen: false,
        canopyPortalOpen: false,
        appAdvisorOpen: false,
      },
    },
  };
}

interface BridgeHarness {
  root: Root;
  container: HTMLDivElement;
  toolListener: (request: AppAdvisorRendererToolRequest) => void;
  cancellationListener: (
    cancellation: AppAdvisorRendererToolCancellation,
  ) => void;
  completeToolRequestMock: jest.Mock<
    Promise<void>,
    [AppAdvisorRendererToolResponse]
  >;
  openWindowMock: jest.Mock;
  getAppAdvisorStateMock: jest.Mock<Promise<AppAdvisorUiStateEnvelope>, []>;
  emit: (request: AppAdvisorRendererToolRequest) => Promise<void>;
}

function getToolResponseAt(
  mock: jest.Mock<Promise<void>, [AppAdvisorRendererToolResponse]>,
  index: number,
): AppAdvisorRendererToolResponse {
  const response = mock.mock.calls[index]?.[0];
  if (!response) {
    throw new Error(`Expected App Advisor tool response at index ${index}`);
  }
  return response;
}

function setupBridge(
  surface: 'main' | 'app-advisor',
  options: { getStateRejects?: boolean } = {},
): BridgeHarness {
  const completeToolRequestMock = jest.fn<
    Promise<void>,
    [AppAdvisorRendererToolResponse]
  >(() => Promise.resolve());
  const disposeMock = jest.fn();
  const openWindowMock = jest
    .fn()
    .mockResolvedValue({ open: true, focused: true });
  const getAppAdvisorStateMock = jest.fn<
    Promise<AppAdvisorUiStateEnvelope>,
    []
  >(() =>
    options.getStateRejects
      ? Promise.reject(new Error('ipc down'))
      : Promise.resolve(makeEnvelope()),
  );
  let toolListener: (request: AppAdvisorRendererToolRequest) => void = () => {};
  let cancellationListener: (
    cancellation: AppAdvisorRendererToolCancellation,
  ) => void = () => {};
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      appAdvisor: {
        getState: getAppAdvisorStateMock,
        openWindow: openWindowMock,
        ensureWindow: jest.fn(),
        closeWindow: jest.fn(),
        toggleWindow: jest.fn(),
        getWindowState: jest
          .fn()
          .mockResolvedValue({ open: false, focused: false }),
        onWindowStateChanged: jest.fn(
          (): (() => void) => (): undefined => undefined,
        ),
        onWindowCommand: jest.fn(
          (): (() => void) => (): undefined => undefined,
        ),
        onToolRequest: jest.fn(
          (
            listener: (request: AppAdvisorRendererToolRequest) => void,
          ): (() => void) => {
            toolListener = listener;
            return disposeMock;
          },
        ),
        onToolRequestCancelled: jest.fn(
          (
            listener: (
              cancellation: AppAdvisorRendererToolCancellation,
            ) => void,
          ): (() => void) => {
            cancellationListener = listener;
            return jest.fn();
          },
        ),
        completeToolRequest: completeToolRequestMock,
        onStateChanged: jest.fn((): (() => void) => (): undefined => undefined),
      },
    },
  });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        surface === 'main'
          ? AppAdvisorMainRuntimeBridge
          : AppAdvisorWindowRuntimeBridge,
      ),
    );
  });

  return {
    root,
    container,
    completeToolRequestMock,
    openWindowMock,
    getAppAdvisorStateMock,
    get toolListener(): (request: AppAdvisorRendererToolRequest) => void {
      return toolListener;
    },
    get cancellationListener(): (
      cancellation: AppAdvisorRendererToolCancellation,
    ) => void {
      return cancellationListener;
    },
    emit: async (request: AppAdvisorRendererToolRequest): Promise<void> => {
      await act(async (): Promise<void> => {
        toolListener(request);
        await Promise.resolve();
        await Promise.resolve();
      });
    },
  };
}

function teardownBridge(harness: BridgeHarness): void {
  act(() => {
    harness.root.unmount();
  });
  harness.container.remove();
}

describe('AppAdvisorMainRuntimeBridge', () => {
  let harness: BridgeHarness;

  beforeEach(() => {
    jest.clearAllMocks();
    appActionDispatcher.__resetAppActionDispatcherForTests();
    useNavigationStore.setState({
      activePage: 'overview',
      settingsOpen: false,
      commandPaletteOpen: false,
      fileSearchPaletteOpen: false,
      prPickerOpen: false,
      canopyPortalOpen: false,
      appAdvisorOpen: false,
    });
    useCurrentUiStateStore.setState({
      revision: 7,
      envelope: makeEnvelope(),
      slices: {},
    });
    useAppAdvisorStore.setState({
      open: false,
      pendingQuestions: [],
    });
    harness = setupBridge('main');
  });

  afterEach(() => {
    teardownBridge(harness);
    jest.restoreAllMocks();
  });

  it('preserves ShowFiles presentation and per-file outcomes across the renderer bridge', async () => {
    jest.spyOn(showFiles, 'showFilesInRenderer').mockResolvedValue({
      presentation: 'background',
      reason: 'browser_handoff',
      activated: false,
      opened: 1,
      failed: 0,
      files: [
        {
          path: 'report.md',
          ok: true,
          opened: true,
          activated: false,
          deferred: false,
        },
      ],
    });
    await harness.emit({
      kind: 'show_files',
      requestId: 'show-files-result',
      payload: {
        target: { projectId: 'project', worktreeId: 'worktree' },
        origin: {
          projectId: 'project',
          worktreeId: 'worktree',
          chatTabId: 'chat',
        },
        files: [{ path: 'report.md' }],
      },
    });
    expect(
      getToolResponseAt(harness.completeToolRequestMock, 0).result,
    ).toMatchObject({
      presentation: 'background',
      reason: 'browser_handoff',
      activated: false,
      opened: 1,
      files: [{ opened: true, activated: false, deferred: false }],
    });
  });

  it('answers get_current_ui_state with the latest envelope', async () => {
    await harness.emit({
      kind: 'get_current_ui_state',
      requestId: 'ui-state-1',
    });

    expect(harness.completeToolRequestMock).toHaveBeenCalledWith({
      requestId: 'ui-state-1',
      ok: true,
      uiState: useCurrentUiStateStore.getState().getEnvelope(),
    });
  });

  it('refreshes mounted composer availability when current UI state is requested', async () => {
    const stale = makeEnvelope();
    stale.snapshot.chatHarnessPickers = [
      {
        pickerId: 'unmounted',
        model: 'gpt-shared',
        harness: 'codex',
        availableHarnesses: ['codex', 'cursor'],
      },
    ];
    useCurrentUiStateStore.setState({ envelope: stale, slices: {} });
    await harness.emit({
      kind: 'get_current_ui_state',
      requestId: 'fresh-composer-state',
    });
    expect(
      getToolResponseAt(harness.completeToolRequestMock, 0).uiState?.snapshot
        .chatHarnessPickers,
    ).toBeUndefined();
  });

  it('dispatches renderer actions through the App Advisor dispatcher', async () => {
    await harness.emit({
      kind: 'dispatch_action',
      requestId: 'dispatch-1',
      action: { type: 'navigation.go_to_page', page: 'pipelines' },
      originWorktreeId: 'entry-1',
    });

    expect(useNavigationStore.getState().activePage).toBe('workflows-library');
    expect(harness.completeToolRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'dispatch-1',
        ok: true,
        uiState: useCurrentUiStateStore.getState().getEnvelope(),
      }),
    );
  });

  it('aborts the matching renderer action when main cancels its request', async () => {
    let dispatchedSignal: AbortSignal | undefined;
    let finishDispatch: (response: AppAdvisorActionResponse) => void =
      jest.fn();
    jest.spyOn(appActionDispatcher, 'dispatchAppAction').mockImplementation(
      (request) =>
        new Promise<AppAdvisorActionResponse>((resolve) => {
          dispatchedSignal = request.signal;
          finishDispatch = resolve;
        }),
    );

    await act(async () => {
      harness.toolListener({
        kind: 'dispatch_action',
        requestId: 'dispatch-cancelled',
        action: { type: 'navigation.go_to_page', page: 'pipelines' },
      });
      await Promise.resolve();
    });
    await act(async () => {
      harness.cancellationListener({ requestId: 'dispatch-cancelled' });
      await Promise.resolve();
    });

    expect(dispatchedSignal?.aborted).toBe(true);
    finishDispatch({
      requestId: 'dispatch-cancelled',
      ok: false,
      error: { code: 'execution_failed', message: 'cancelled' },
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('aborts only the cancelled chat request when two chats share a request id (CAN-3976)', async () => {
    const signals = new Map<string, AbortSignal | undefined>();
    jest.spyOn(appActionDispatcher, 'dispatchAppAction').mockImplementation(
      (request) =>
        new Promise<AppAdvisorActionResponse>(() => {
          signals.set(request.originChatTabId ?? '', request.signal);
        }),
    );

    await act(async () => {
      for (const originChatTabId of ['chat-a', 'chat-b']) {
        harness.toolListener({
          kind: 'dispatch_action',
          requestId: 'shared-id',
          action: { type: 'navigation.go_to_page', page: 'pipelines' },
          originWorktreeId: 'entry-1',
          originChatTabId,
        });
      }
      await Promise.resolve();
    });
    await act(async () => {
      harness.cancellationListener({
        requestId: 'shared-id',
        originChatId: 'chat-a',
      });
      await Promise.resolve();
    });

    expect(signals.get('chat-a')?.aborted).toBe(true);
    expect(signals.get('chat-b')?.aborted).toBe(false);
  });

  it('starts a queued renderer action with an aborted signal when cancellation arrives first', async () => {
    let dispatchedSignal: AbortSignal | undefined;
    jest
      .spyOn(appActionDispatcher, 'dispatchAppAction')
      .mockImplementation((request) => {
        dispatchedSignal = request.signal;
        return Promise.resolve({
          requestId: request.requestId,
          ok: false,
          error: { code: 'execution_failed', message: 'cancelled' },
        });
      });

    await act(async () => {
      harness.toolListener({
        kind: 'dispatch_action',
        requestId: 'dispatch-cancelled-before-start',
        action: { type: 'navigation.go_to_page', page: 'pipelines' },
      });
      harness.cancellationListener({
        requestId: 'dispatch-cancelled-before-start',
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dispatchedSignal?.aborted).toBe(true);
  });

  it('preserves explicit cross-workspace browser targets from App Advisor', async () => {
    const response: AppAdvisorActionResponse = {
      requestId: 'workspace-browser',
      ok: true,
      result: { browsers: [], activeBrowserId: null },
    };
    const dispatchSpy = jest
      .spyOn(appActionDispatcher, 'dispatchAppAction')
      .mockResolvedValue(response);

    await harness.emit({
      kind: 'dispatch_action',
      requestId: 'workspace-browser',
      action: {
        type: 'browser.list',
        projectId: 'project-2',
        worktreeId: 'worktree-2',
      },
      originWorktreeId: 'advisor-entry-1',
    });

    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'workspace-browser',
        action: {
          type: 'browser.list',
          projectId: 'project-2',
          worktreeId: 'worktree-2',
        },
      }),
    );
  });

  it('names the App Advisor chat that made the call, for its approval', async () => {
    const dispatchSpy = jest
      .spyOn(appActionDispatcher, 'dispatchAppAction')
      .mockResolvedValue({ requestId: 'save-download', ok: true });

    await harness.emit({
      kind: 'dispatch_action',
      requestId: 'save-download',
      action: {
        type: 'browser.save_download',
        projectId: 'project-2',
        worktreeId: 'worktree-2',
        expectedRuntimeGeneration: 1,
        downloadId: 'download-1',
        path: 'report.csv',
      },
      originWorktreeId: 'advisor-entry-1',
      originChatTabId: 'advisor-chat-1',
    });

    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'save-download',
        originChat: {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'advisor-entry-1',
          chatId: 'advisor-chat-1',
        },
      }),
    );

    // A runtime serving another project's chat names that project.
    await harness.emit({
      kind: 'dispatch_action',
      requestId: 'save-download-project',
      action: {
        type: 'browser.save_download',
        projectId: 'project-2',
        worktreeId: 'worktree-2',
        expectedRuntimeGeneration: 1,
        downloadId: 'download-1',
        path: 'report.csv',
      },
      originProjectId: 'project-2',
      originWorktreeId: 'worktree-2',
      originChatTabId: 'chat-2',
    });
    expect(dispatchSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        requestId: 'save-download-project',
        originChat: {
          projectId: 'project-2',
          worktreeId: 'worktree-2',
          chatId: 'chat-2',
        },
      }),
    );
  });

  it('returns surface_unavailable (retryable) when ask_user_question reaches the main bridge', async () => {
    await harness.emit({
      kind: 'ask_user_question',
      requestId: 'wrong-surface',
      question: { question: 'q', options: ['A'] },
    });

    expect(getToolResponseAt(harness.completeToolRequestMock, 0)).toMatchObject(
      {
        requestId: 'wrong-surface',
        ok: false,
        error: {
          code: 'surface_unavailable',
          retryable: true,
        },
        uiState: { digest: 'bridge-digest' },
      },
    );
  });

  it('reuses the cached response for repeated requestIds', async () => {
    const request: AppAdvisorRendererToolRequest = {
      kind: 'dispatch_action',
      requestId: 'dispatch-cached',
      action: { type: 'navigation.go_to_page', page: 'pipelines' },
      originWorktreeId: 'entry-1',
    };

    await harness.emit(request);
    const firstResponse = getToolResponseAt(harness.completeToolRequestMock, 0);
    useNavigationStore.setState({ activePage: 'overview' });
    await harness.emit(request);

    expect(harness.completeToolRequestMock).toHaveBeenCalledTimes(2);
    expect(getToolResponseAt(harness.completeToolRequestMock, 1)).toBe(
      firstResponse,
    );
    expect(useNavigationStore.getState().activePage).toBe('overview');
  });

  it('scopes cached responses to the originating chat (CAN-3976)', async () => {
    const fromChat = (
      originChatTabId: string,
      page: 'pipelines' | 'automations',
    ): AppAdvisorRendererToolRequest => ({
      kind: 'dispatch_action',
      requestId: '1',
      action: { type: 'navigation.go_to_page', page },
      originWorktreeId: 'entry-1',
      originChatTabId,
    });

    await harness.emit(fromChat('chat-a', 'pipelines'));
    await harness.emit(fromChat('chat-b', 'automations'));

    expect(useNavigationStore.getState().activePage).toBe('workflows-library');
    const first = getToolResponseAt(harness.completeToolRequestMock, 0);
    const second = getToolResponseAt(harness.completeToolRequestMock, 1);
    expect(second).not.toBe(first);
    expect(first).toMatchObject({ requestId: '1', originChatId: 'chat-a' });
    expect(second).toMatchObject({ requestId: '1', originChatId: 'chat-b' });

    useNavigationStore.setState({ activePage: 'overview' });
    await harness.emit(fromChat('chat-a', 'pipelines'));
    expect(getToolResponseAt(harness.completeToolRequestMock, 2)).toBe(first);
    expect(useNavigationStore.getState().activePage).toBe('overview');
  });

  it('runs a requestId again after a retryable failure and replays its success', async () => {
    const dispatch = jest
      .spyOn(appActionDispatcher, 'dispatchAppAction')
      .mockResolvedValueOnce({
        requestId: 'dispatch-retried',
        ok: false,
        error: {
          code: 'execution_failed',
          message: 'Fresh source worktree status could not be verified.',
          retryable: true,
        },
      })
      .mockResolvedValue({
        requestId: 'dispatch-retried',
        ok: true,
        result: { worktreeId: 'wt-new' },
      });
    const request: AppAdvisorRendererToolRequest = {
      kind: 'dispatch_action',
      requestId: 'dispatch-retried',
      action: {
        type: 'worktree.create',
        workspaceId: 'ws-1',
        baseWorktreeId: 'wt-1',
        select: false,
      },
    };

    await harness.emit(request);
    await harness.emit(request);
    await harness.emit(request);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(
      harness.completeToolRequestMock.mock.calls.map(([response]) => ({
        ok: response.ok,
        retryable: response.error?.retryable,
      })),
    ).toEqual([
      { ok: false, retryable: true },
      { ok: true, retryable: undefined },
      { ok: true, retryable: undefined },
    ]);
  });

  it('joins a repeated requestId to the run still in flight', async () => {
    let finishDispatch: (response: AppAdvisorActionResponse) => void =
      jest.fn();
    const dispatch = jest
      .spyOn(appActionDispatcher, 'dispatchAppAction')
      .mockImplementation(
        () =>
          new Promise<AppAdvisorActionResponse>((resolve) => {
            finishDispatch = resolve;
          }),
      );
    const request: AppAdvisorRendererToolRequest = {
      kind: 'dispatch_action',
      requestId: 'dispatch-in-flight',
      action: {
        type: 'worktree.create',
        workspaceId: 'ws-1',
        baseWorktreeId: 'wt-1',
        select: false,
      },
    };

    await harness.emit(request);
    await harness.emit(request);
    expect(dispatch).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishDispatch({
        requestId: 'dispatch-in-flight',
        ok: true,
        result: { worktreeId: 'wt-new' },
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(harness.completeToolRequestMock).toHaveBeenCalledTimes(2);
    expect(getToolResponseAt(harness.completeToolRequestMock, 1)).toBe(
      getToolResponseAt(harness.completeToolRequestMock, 0),
    );
  });
});

describe('AppAdvisorWindowRuntimeBridge', () => {
  let harness: BridgeHarness;

  beforeEach(() => {
    jest.clearAllMocks();
    appActionDispatcher.__resetAppActionDispatcherForTests();
    useNavigationStore.setState({
      activePage: 'overview',
      settingsOpen: false,
      commandPaletteOpen: false,
      fileSearchPaletteOpen: false,
      prPickerOpen: false,
      canopyPortalOpen: false,
      appAdvisorOpen: false,
    });
    useCurrentUiStateStore.setState({
      revision: 7,
      envelope: makeEnvelope(),
      slices: {},
    });
    useAppAdvisorStore.setState({
      open: false,
      pendingQuestions: [],
    });
    harness = setupBridge('app-advisor');
  });

  afterEach(() => {
    teardownBridge(harness);
    jest.restoreAllMocks();
  });

  it('renders ask_user_question requests and returns the selected answer with a best-effort uiState envelope from main', async () => {
    await act(async () => {
      harness.toolListener({
        kind: 'ask_user_question',
        requestId: 'question-1',
        question: {
          question: 'Choose one',
          options: ['A', 'B'],
        },
      });
      await Promise.resolve();
    });

    expect(useAppAdvisorStore.getState().pendingQuestions).toHaveLength(1);
    // The App Advisor window bridge requests the window be opened so the
    // user can actually see the prompt.
    expect(harness.openWindowMock).toHaveBeenCalledWith({ focus: true });

    await act(async () => {
      useAppAdvisorStore.getState().answerQuestion('question-1', {
        question: 'Choose one',
        selectedOptions: ['A'],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getToolResponseAt(harness.completeToolRequestMock, 0)).toMatchObject(
      {
        requestId: 'question-1',
        ok: true,
        answer: {
          question: 'Choose one',
          selectedOptions: ['A'],
        },
        uiState: { digest: 'bridge-digest' },
      },
    );
    expect(harness.getAppAdvisorStateMock).toHaveBeenCalled();
  });

  it('dismisses an in-flight ask-user card when main cancels the request', async () => {
    await act(async () => {
      harness.toolListener({
        kind: 'ask_user_question',
        requestId: 'question-cancelled',
        question: {
          question: 'Choose one',
          options: ['A', 'B'],
        },
      });
      await Promise.resolve();
    });
    expect(useAppAdvisorStore.getState().pendingQuestions).toHaveLength(1);

    await act(async () => {
      harness.cancellationListener({ requestId: 'question-cancelled' });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useAppAdvisorStore.getState().pendingQuestions).toHaveLength(0);
    expect(getToolResponseAt(harness.completeToolRequestMock, 0)).toMatchObject(
      {
        requestId: 'question-cancelled',
        ok: false,
        error: { code: 'execution_failed' },
      },
    );
  });

  it('returns surface_unavailable (retryable) when get_current_ui_state reaches the App Advisor bridge', async () => {
    harness.getAppAdvisorStateMock.mockResolvedValueOnce(
      makeEnvelope('main-window-digest', 11),
    );

    await harness.emit({
      kind: 'get_current_ui_state',
      requestId: 'wrong-surface-ui',
    });

    expect(getToolResponseAt(harness.completeToolRequestMock, 0)).toMatchObject(
      {
        requestId: 'wrong-surface-ui',
        ok: false,
        error: {
          code: 'surface_unavailable',
          retryable: true,
        },
        uiState: { digest: 'main-window-digest' },
      },
    );
    expect(harness.getAppAdvisorStateMock).toHaveBeenCalled();
  });

  it('returns surface_unavailable (retryable) when dispatch_action reaches the App Advisor bridge', async () => {
    harness.getAppAdvisorStateMock.mockResolvedValueOnce(
      makeEnvelope('main-window-dispatch-digest', 12),
    );

    await harness.emit({
      kind: 'dispatch_action',
      requestId: 'wrong-surface-dispatch',
      action: { type: 'navigation.go_to_page', page: 'pipelines' },
      originWorktreeId: 'entry-1',
    });

    // The action is NOT dispatched on this surface.
    expect(useNavigationStore.getState().activePage).toBe('overview');
    expect(getToolResponseAt(harness.completeToolRequestMock, 0)).toMatchObject(
      {
        requestId: 'wrong-surface-dispatch',
        ok: false,
        error: {
          code: 'surface_unavailable',
          retryable: true,
        },
        uiState: { digest: 'main-window-dispatch-digest' },
      },
    );
    expect(harness.getAppAdvisorStateMock).toHaveBeenCalled();
  });

  it('pins unscoped browser actions to the Work Entry that originated the turn', async () => {
    useStandaloneChatStore.setState({
      activeWorkEntryId: 'advisor-entry-selected-later',
    });
    const response: AppAdvisorActionResponse = {
      requestId: 'origin-browser',
      ok: true,
      result: { browsers: [], activeBrowserId: null },
    };
    const dispatchSpy = jest
      .spyOn(appActionDispatcher, 'dispatchAppAction')
      .mockResolvedValue(response);

    await harness.emit({
      kind: 'dispatch_action',
      requestId: 'origin-browser',
      action: { type: 'browser.list' },
      originWorktreeId: 'advisor-entry-origin',
    });

    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'origin-browser',
        action: {
          type: 'browser.list',
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'advisor-entry-origin',
        },
      }),
    );
  });
});
