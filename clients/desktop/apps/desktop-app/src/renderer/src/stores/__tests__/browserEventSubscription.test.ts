import type {
  BrowserHandoff,
  BrowserServiceEvent,
  BrowserSessionSnapshot,
} from '@canopy/desktop-shared/types';
import { requestBrowserPanel } from '@/lib/browserPanelActivation';
import { registerPendingBrowserActivation } from '@/lib/panels/browser-panel-activation';
import {
  discardOpenedBrowser,
  findBrowserPanelBindings,
  handleBrowserDestroyedEvent,
  requestBrowserSessionDestruction,
} from '@/lib/panels/browser-panel-sync';
import { closePanelTab } from '@/lib/panels/chat-panel-sync';
import {
  ensureBrowserEventSubscription,
  openAppLinkInWorktreeBrowser,
} from '../browserEventSubscription';
import { useBrowserStore } from '../browserStore';
import { useSidebarStore } from '../sidebarStore';
import { useChatStore } from '../chatStore';
import { useGitHubStore } from '../githubStore';
import { getBrowserUserInteractionGeneration } from '@/lib/browserUserInteraction';
import { makeTestPreferences } from '@/test-utils/preferences';
import { routeBrowserFindResult } from '@/stores/browserFindController';
import { useSurfaceFindStore } from '@/stores/surfaceFindStore';
import {
  openSettingsPathInApp,
  settingsPathOpensInApp,
} from '@/lib/navigation/settings-destinations';

jest.mock('@/stores/browserFindController', () => ({
  routeBrowserFindResult: jest.fn(),
}));
jest.mock('@/lib/browserPanelActivation', () => ({
  requestBrowserPanel: jest.fn(),
}));
jest.mock('@/lib/panels/browser-panel-activation', () => ({
  registerPendingBrowserActivation: jest.fn(() => jest.fn()),
}));
jest.mock('@/lib/panels/browser-panel-sync', () => ({
  discardOpenedBrowser: jest.fn(),
  findBrowserPanelBindings: jest.fn(() => []),
  handleBrowserDestroyedEvent: jest.fn(),
  requestBrowserSessionDestruction: jest.fn(),
}));
jest.mock('@/lib/panels/chat-panel-sync', () => ({
  closePanelTab: jest.fn(),
}));
jest.mock('@/lib/navigation/settings-destinations', () => ({
  openSettingsPathInApp: jest.fn(() => false),
  settingsPathOpensInApp: jest.fn(() => false),
}));

/** An `openUrlFromDevServer` result; `ready` resolves to a live session. */
function opened(
  browserId: string,
  createdNewSession = true,
  ready: Promise<BrowserSessionSnapshot | null> = Promise.resolve({
    ...snapshot(),
    id: browserId,
  }),
): {
  browserId: string;
  createdNewSession: boolean;
  ready: Promise<BrowserSessionSnapshot | null>;
} {
  return { browserId, createdNewSession, ready };
}

function snapshot(): BrowserSessionSnapshot {
  return {
    id: 'browser-agent',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    createdAt: 1,
    updatedAt: 2,
    url: 'https://example.com',
    title: 'Example',
    status: 'ready',
    canGoBack: false,
    canGoForward: false,
    loading: false,
    themeMode: 'light',
    pickMode: false,
    recording: false,
  };
}

// Captured once: `ensureBrowserEventSubscription` is idempotent for the
// module's lifetime, so the first test's captured listener serves them all.
let listener: ((event: BrowserServiceEvent) => void) | undefined;

// Held as standalone mocks (rather than read back off `window.api`) so
// assertions never reference an unbound method.
const resolveOpenLinkRequest = jest.fn<Promise<boolean>, [unknown]>();
const openExternal = jest.fn<Promise<void>, [{ url: string }]>();
const savePreferences = jest.fn<Promise<unknown>, [unknown]>();

beforeEach(() => {
  jest.clearAllMocks();
  resolveOpenLinkRequest.mockResolvedValue(true);
  openExternal.mockResolvedValue(undefined);
  savePreferences.mockResolvedValue(undefined);
  jest.mocked(requestBrowserPanel).mockResolvedValue(true);
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        savePreferences,
        browser: {
          onEvent: jest.fn(
            (
              nextListener: (event: BrowserServiceEvent) => void,
            ): (() => void) => {
              listener = nextListener;
              return (): void => undefined;
            },
          ),
          loadWorktreeState: jest
            .fn()
            .mockResolvedValue({ status: 'missing', state: null }),
          saveWorktreeState: jest.fn().mockResolvedValue(undefined),
          resolveOpenLinkRequest,
          openExternal,
        },
      },
    },
  });
  useBrowserStore.setState({ worktrees: {}, dialogs: {} });
  useSidebarStore.setState({ hidden: false, persistedHidden: false });
});

it('toggles the app sidebar for a native-browser shortcut event', () => {
  ensureBrowserEventSubscription();
  listener?.({
    type: 'shortcut',
    browserId: 'browser-agent',
    snapshot: snapshot(),
    action: 'toggle-sidebar',
  });

  expect(useSidebarStore.getState().hidden).toBe(true);
  expect(savePreferences).toHaveBeenCalledWith({
    sidebarCollapsed: true,
  });
});

it('records browser-page user interaction for focus restoration guards', () => {
  ensureBrowserEventSubscription();
  const before = getBrowserUserInteractionGeneration();

  listener?.({
    type: 'user-interaction',
    browserId: 'browser-agent',
  });

  expect(getBrowserUserInteractionGeneration()).toBe(before + 1);
});

it('registers, mirrors, and reveals a browser requested by an agent tool', async () => {
  ensureBrowserEventSubscription();
  listener?.({
    type: 'open-requested',
    browserId: 'browser-agent',
    snapshot: snapshot(),
    originChatTabId: 'chat-1',
    createdNewSession: false,
  });
  await new Promise((resolve) => setImmediate(resolve));

  // The pending guard is registered before the snapshot is published.
  expect(registerPendingBrowserActivation).toHaveBeenCalledWith(
    'browser-agent',
  );
  const bucket = useBrowserStore.getState().worktrees['project-1/worktree-1'];
  expect(bucket.browserOrder).toEqual(['browser-agent']);
  expect(bucket.browsers['browser-agent']).toMatchObject({
    id: 'browser-agent',
  });
  expect(bucket.live.has('browser-agent')).toBe(true);
  // The panel reveal targets the EXACT browser id.
  expect(requestBrowserPanel).toHaveBeenCalledWith(
    'project-1',
    'worktree-1',
    'browser-agent',
    'chat-1',
    { focus: false },
  );
});

it('places an agent-opened tab as soon as main announces it, before the session exists', async () => {
  ensureBrowserEventSubscription();
  listener?.({
    type: 'open-pending',
    browserId: 'browser-pending',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    url: 'http://localhost:4000/',
    originChatTabId: 'chat-1',
  });

  // Synchronously: a placeholder with the URL, and the panel request.
  const bucket = useBrowserStore.getState().worktrees['project-1/worktree-1'];
  expect(bucket.browsers['browser-pending']).toMatchObject({
    url: 'http://localhost:4000/',
    loading: true,
  });
  expect(bucket.live.has('browser-pending')).toBe(false);
  expect(useBrowserStore.getState().openingBrowserIds['browser-pending']).toBe(
    true,
  );
  expect(requestBrowserPanel).toHaveBeenCalledWith(
    'project-1',
    'worktree-1',
    'browser-pending',
    'chat-1',
    { focus: false },
  );

  // Main finishes: the real snapshot replaces the placeholder.
  listener?.({
    type: 'open-requested',
    browserId: 'browser-pending',
    snapshot: { ...snapshot(), id: 'browser-pending' },
    originChatTabId: 'chat-1',
    createdNewSession: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const settled = useBrowserStore.getState().worktrees['project-1/worktree-1'];
  expect(settled.live.has('browser-pending')).toBe(true);
  expect(
    useBrowserStore.getState().openingBrowserIds['browser-pending'],
  ).toBeUndefined();
});

it('does not bring back an agent-opened tab the user closed while it was opening', async () => {
  ensureBrowserEventSubscription();
  listener?.({
    type: 'open-pending',
    browserId: 'browser-closed',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    originChatTabId: 'chat-1',
  });
  // The close path drops the placeholder (backend destroy confirmed).
  useBrowserStore
    .getState()
    .dropBrowserSession('project-1', 'worktree-1', 'browser-closed');
  jest.mocked(requestBrowserPanel).mockClear();

  listener?.({
    type: 'open-requested',
    browserId: 'browser-closed',
    snapshot: { ...snapshot(), id: 'browser-closed' },
    originChatTabId: 'chat-1',
    createdNewSession: true,
  });
  await new Promise((resolve) => setImmediate(resolve));

  expect(requestBrowserPanel).not.toHaveBeenCalled();
  expect(
    useBrowserStore.getState().worktrees['project-1/worktree-1'].browsers[
      'browser-closed'
    ],
  ).toBeUndefined();
});

it('does not register an agent tab destroyed while its reveal waits on hydration', async () => {
  let finishHydration: (value: unknown) => void = () => undefined;
  Object.assign(window.api.browser, {
    loadWorktreeState: jest.fn(
      () =>
        new Promise((resolve) => {
          finishHydration = resolve;
        }),
    ),
  });
  useBrowserStore.setState({ worktrees: {}, openingBrowserIds: {} });
  ensureBrowserEventSubscription();
  listener?.({
    type: 'open-pending',
    browserId: 'browser-raced',
    projectId: 'project-2',
    worktreeId: 'worktree-2',
    originChatTabId: 'chat-1',
  });
  listener?.({
    type: 'open-requested',
    browserId: 'browser-raced',
    snapshot: {
      ...snapshot(),
      id: 'browser-raced',
      projectId: 'project-2',
      worktreeId: 'worktree-2',
    },
    originChatTabId: 'chat-1',
    createdNewSession: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  // Main destroys it while the reveal is still waiting on hydration.
  listener?.({ type: 'destroyed', browserId: 'browser-raced' });
  useBrowserStore
    .getState()
    .dropBrowserSession('project-2', 'worktree-2', 'browser-raced');
  jest.mocked(requestBrowserPanel).mockClear();
  finishHydration({ status: 'missing', state: null });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  expect(requestBrowserPanel).not.toHaveBeenCalled();
  expect(
    useBrowserStore.getState().worktrees['project-2/worktree-2']?.browsers[
      'browser-raced'
    ],
  ).toBeUndefined();
});

it('opens the in-page new-tab shortcut tab before its session exists', async () => {
  const create = jest.fn(() => new Promise(() => undefined));
  Object.assign(window.api.browser, { create });
  ensureBrowserEventSubscription();

  listener?.({
    type: 'shortcut',
    browserId: 'browser-agent',
    snapshot: snapshot(),
    action: 'new-tab',
  });
  await new Promise((resolve) => setImmediate(resolve));

  const call = jest.mocked(requestBrowserPanel).mock.calls[0];
  expect(call?.slice(0, 2)).toEqual(['project-1', 'worktree-1']);
  const newId = call?.[2] ?? '';
  expect(newId).not.toBe('browser-agent');
  expect(
    useBrowserStore.getState().worktrees['project-1/worktree-1'].browsers[
      newId
    ],
  ).toMatchObject({ url: '', status: 'idle' });
  expect(discardOpenedBrowser).not.toHaveBeenCalled();
});

it('never opens a new tab for the in-page find shortcut (CAN-3048)', async () => {
  const create = jest.fn(() => new Promise(() => undefined));
  Object.assign(window.api.browser, { create });
  ensureBrowserEventSubscription();

  listener?.({
    type: 'shortcut',
    browserId: 'browser-agent',
    snapshot: snapshot(),
    action: 'find-in-page',
  });
  await new Promise((resolve) => setImmediate(resolve));

  expect(requestBrowserPanel).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(useBrowserStore.getState().worktrees).toEqual({});
});

it('opens the find bar in browser mode for the in-page find shortcut (CAN-3048)', () => {
  const original = useSurfaceFindStore.getState().openFor;
  const openFor = jest.fn();
  useSurfaceFindStore.setState({ openFor });
  ensureBrowserEventSubscription();

  listener?.({
    type: 'shortcut',
    browserId: 'browser-agent',
    snapshot: snapshot(),
    action: 'find-in-page',
  });

  expect(openFor).toHaveBeenCalledWith('browser', 'browser-agent');
  useSurfaceFindStore.setState({ openFor: original });
});

it('routes native find results to the browser find controller (CAN-3048)', () => {
  const event = {
    type: 'find-result' as const,
    browserId: 'browser-agent',
    requestId: 1,
    activeMatchOrdinal: 1,
    matches: 2,
    finalUpdate: true,
  };
  ensureBrowserEventSubscription();

  listener?.(event);

  expect(routeBrowserFindResult).toHaveBeenCalledWith(event);
});

it('mirrors app-owned JavaScript dialog open and close events', () => {
  ensureBrowserEventSubscription();
  listener?.({
    type: 'dialog-opened',
    browserId: 'browser-agent',
    dialog: {
      id: 'dialog-1',
      browserId: 'browser-agent',
      type: 'prompt',
      message: 'Name',
      defaultPrompt: 'Initial',
      url: 'https://example.com',
      openedAt: 3,
    },
  });

  expect(useBrowserStore.getState().dialogs['browser-agent']).toMatchObject({
    id: 'dialog-1',
    type: 'prompt',
  });

  listener?.({
    type: 'dialog-closed',
    browserId: 'browser-agent',
    dialogId: 'dialog-1',
  });
  expect(useBrowserStore.getState().dialogs['browser-agent']).toBeUndefined();
});

it('rolls back only a newly-created session when its panel cannot be placed', async () => {
  const destroyBrowser = jest.fn().mockResolvedValue(undefined);
  const originalDestroyBrowser = useBrowserStore.getState().destroyBrowser;
  try {
    useBrowserStore.setState({ destroyBrowser });
    jest.mocked(requestBrowserPanel).mockResolvedValueOnce(false);
    ensureBrowserEventSubscription();

    listener?.({
      type: 'open-requested',
      browserId: 'browser-agent',
      snapshot: snapshot(),
      originChatTabId: 'chat-1',
      createdNewSession: true,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(destroyBrowser).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'browser-agent',
    );
  } finally {
    useBrowserStore.setState({ destroyBrowser: originalDestroyBrowser });
  }
});

it('preserves a reused session when its existing panel cannot be revealed', async () => {
  const destroyBrowser = jest.fn().mockResolvedValue(undefined);
  const originalDestroyBrowser = useBrowserStore.getState().destroyBrowser;
  try {
    useBrowserStore.setState({ destroyBrowser });
    jest.mocked(requestBrowserPanel).mockResolvedValueOnce(false);
    ensureBrowserEventSubscription();

    listener?.({
      type: 'open-requested',
      browserId: 'browser-agent',
      snapshot: snapshot(),
      originChatTabId: 'chat-1',
      createdNewSession: false,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(destroyBrowser).not.toHaveBeenCalled();
    expect(requestBrowserSessionDestruction).not.toHaveBeenCalled();
  } finally {
    useBrowserStore.setState({ destroyBrowser: originalDestroyBrowser });
  }
});

it('retries rollback when destroying a newly-created session fails', async () => {
  const destroyBrowser = jest
    .fn()
    .mockRejectedValue(new Error('persistence failed'));
  const originalDestroyBrowser = useBrowserStore.getState().destroyBrowser;
  try {
    useBrowserStore.setState({ destroyBrowser });
    jest.mocked(requestBrowserPanel).mockResolvedValueOnce(false);
    ensureBrowserEventSubscription();

    listener?.({
      type: 'open-requested',
      browserId: 'browser-agent',
      snapshot: snapshot(),
      originChatTabId: 'chat-1',
      createdNewSession: true,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(requestBrowserSessionDestruction).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'browser-agent',
    );
  } finally {
    useBrowserStore.setState({ destroyBrowser: originalDestroyBrowser });
  }
});

it('routes destroyed events through the lifecycle coordinator (exact id)', async () => {
  ensureBrowserEventSubscription();
  listener?.({ type: 'destroyed', browserId: 'browser-agent' });
  // The coordinator module is lazily imported by the handler.
  await new Promise((resolve) => setImmediate(resolve));

  expect(handleBrowserDestroyedEvent).toHaveBeenCalledWith('browser-agent');
});

it('contains destroyed-event coordinator failures', async () => {
  jest.mocked(handleBrowserDestroyedEvent).mockImplementationOnce(() => {
    throw new Error('coordinator failed');
  });
  ensureBrowserEventSubscription();

  listener?.({ type: 'destroyed', browserId: 'browser-agent' });
  await new Promise((resolve) => setImmediate(resolve));

  expect(handleBrowserDestroyedEvent).toHaveBeenCalledWith('browser-agent');
});

// ---------------------------------------------------------------------------
// App links (CAN-2305)
// ---------------------------------------------------------------------------

describe('app-link routing', () => {
  const originalOpenUrl = useBrowserStore.getState().openUrlFromDevServer;
  const originalSelection = useChatStore.getState().selectedWorktree;

  afterEach(() => {
    useBrowserStore.setState({ openUrlFromDevServer: originalOpenUrl });
    useChatStore.setState({ selectedWorktree: originalSelection });
  });

  it('opens an app link in the selected worktree browser and accepts the request', async () => {
    const openUrlFromDevServer = jest
      .fn()
      .mockReturnValue(opened('browser-link', true));
    useBrowserStore.setState({ openUrlFromDevServer });
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
    });
    ensureBrowserEventSubscription();

    listener?.({
      type: 'app-link-open-requested',
      requestId: 'req-1',
      url: 'https://example.com/pr/1',
      source: 'app-link',
      openInApp: true,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(resolveOpenLinkRequest).toHaveBeenCalledWith({
      requestId: 'req-1',
      handled: true,
      phase: 'acknowledge',
    });
    expect(openUrlFromDevServer).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      { url: 'https://example.com/pr/1' },
    );
    expect(requestBrowserPanel).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'browser-link',
    );
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('coalesces concurrent requests for the same worktree URL', async () => {
    let finishOpen: ((value: BrowserSessionSnapshot | null) => void) | null =
      null;
    const pendingReady = new Promise<BrowserSessionSnapshot | null>(
      (resolve) => {
        finishOpen = resolve;
      },
    );
    const openUrlFromDevServer = jest.fn(() =>
      opened('browser-link', true, pendingReady),
    );
    useBrowserStore.setState({ openUrlFromDevServer });
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
    });
    ensureBrowserEventSubscription();

    for (const requestId of ['req-concurrent-1', 'req-concurrent-2']) {
      listener?.({
        type: 'app-link-open-requested',
        requestId,
        url: 'https://example.com/pr/concurrent',
        source: 'app-link',
        openInApp: true,
      });
    }
    await new Promise((resolve) => setImmediate(resolve));
    const callsBeforeCompletion = openUrlFromDevServer.mock.calls.length;
    // The tab is already placed while its session is still opening.
    expect(requestBrowserPanel).toHaveBeenCalledTimes(1);
    finishOpen?.({ ...snapshot(), id: 'browser-link' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(callsBeforeCompletion).toBe(1);
    expect(requestBrowserPanel).toHaveBeenCalledTimes(1);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('coalesces the external fallback when concurrent placement fails', async () => {
    let finishOpen: ((value: BrowserSessionSnapshot | null) => void) | null =
      null;
    const pendingReady = new Promise<BrowserSessionSnapshot | null>(
      (resolve) => {
        finishOpen = resolve;
      },
    );
    const openUrlFromDevServer = jest.fn(() =>
      opened('browser-link', true, pendingReady),
    );
    const destroyBrowser = jest.fn().mockResolvedValue(undefined);
    const originalDestroyBrowser = useBrowserStore.getState().destroyBrowser;
    try {
      useBrowserStore.setState({ openUrlFromDevServer, destroyBrowser });
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      });
      jest.mocked(requestBrowserPanel).mockResolvedValue(false);
      ensureBrowserEventSubscription();

      for (const requestId of ['req-failed-1', 'req-failed-2']) {
        listener?.({
          type: 'app-link-open-requested',
          requestId,
          url: 'https://example.com/pr/failed',
          source: 'app-link',
          openInApp: true,
        });
      }
      await new Promise((resolve) => setImmediate(resolve));
      finishOpen?.({ ...snapshot(), id: 'browser-link' });
      await new Promise((resolve) => setImmediate(resolve));

      expect(openUrlFromDevServer).toHaveBeenCalledTimes(1);
      expect(requestBrowserPanel).toHaveBeenCalledTimes(1);
      expect(discardOpenedBrowser).toHaveBeenCalledTimes(1);
      expect(openExternal).toHaveBeenCalledTimes(1);
    } finally {
      useBrowserStore.setState({ destroyBrowser: originalDestroyBrowser });
    }
  });

  it('rolls back and falls back when app-link panel placement rejects', async () => {
    const openUrlFromDevServer = jest
      .fn()
      .mockReturnValue(opened('browser-link', true));
    const destroyBrowser = jest.fn().mockResolvedValue(undefined);
    const originalDestroyBrowser = useBrowserStore.getState().destroyBrowser;
    try {
      useBrowserStore.setState({ openUrlFromDevServer, destroyBrowser });
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      });
      jest
        .mocked(requestBrowserPanel)
        .mockRejectedValueOnce(new Error('panel layout disposed'));
      ensureBrowserEventSubscription();

      listener?.({
        type: 'app-link-open-requested',
        requestId: 'req-placement-rejected',
        url: 'https://example.com/pr/rejected',
        source: 'app-link',
        openInApp: true,
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(discardOpenedBrowser).toHaveBeenCalledWith(
        'project-1',
        'worktree-1',
        'browser-link',
      );
      expect(openExternal).toHaveBeenCalledWith({
        url: 'https://example.com/pr/rejected',
      });
    } finally {
      useBrowserStore.setState({ destroyBrowser: originalDestroyBrowser });
    }
  });

  it('declines the request with no worktree in context so main falls back', async () => {
    const openUrlFromDevServer = jest.fn();
    useBrowserStore.setState({ openUrlFromDevServer });
    useChatStore.setState({ selectedWorktree: null });
    ensureBrowserEventSubscription();

    listener?.({
      type: 'app-link-open-requested',
      requestId: 'req-2',
      url: 'https://example.com/pr/2',
      source: 'app-link',
      openInApp: true,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(resolveOpenLinkRequest).toHaveBeenCalledWith({
      requestId: 'req-2',
      handled: false,
      phase: 'acknowledge',
    });
    expect(openUrlFromDevServer).not.toHaveBeenCalled();
    // Main owns the fallback for a declined request; the renderer must not
    // also open it, or the link would open twice.
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('falls back externally and rolls back when the panel cannot be placed', async () => {
    const openUrlFromDevServer = jest
      .fn()
      .mockReturnValue(opened('browser-link', true));
    const destroyBrowser = jest.fn().mockResolvedValue(undefined);
    const originalDestroyBrowser = useBrowserStore.getState().destroyBrowser;
    try {
      useBrowserStore.setState({ openUrlFromDevServer, destroyBrowser });
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      });
      jest.mocked(requestBrowserPanel).mockResolvedValueOnce(false);
      ensureBrowserEventSubscription();

      listener?.({
        type: 'app-link-open-requested',
        requestId: 'req-3',
        url: 'https://example.com/pr/3',
        source: 'system-default',
        openInApp: true,
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(discardOpenedBrowser).toHaveBeenCalledWith(
        'project-1',
        'worktree-1',
        'browser-link',
      );
      expect(openExternal).toHaveBeenCalledWith({
        url: 'https://example.com/pr/3',
      });
    } finally {
      useBrowserStore.setState({ destroyBrowser: originalDestroyBrowser });
    }
  });

  it('reports failed completion after reserved browser creation fails', async () => {
    // The session could not be created: its tab is removed again.
    const openUrlFromDevServer = jest
      .fn()
      .mockReturnValue(opened('browser-link', true, Promise.resolve(null)));
    useBrowserStore.setState({ openUrlFromDevServer });
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
    });
    ensureBrowserEventSubscription();

    listener?.({
      type: 'app-link-open-requested',
      requestId: 'req-system-failed',
      url: 'https://example.com/from-os',
      source: 'system-default',
      awaitCompletion: true,
      openInApp: true,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(resolveOpenLinkRequest.mock.calls).toEqual([
      [
        {
          requestId: 'req-system-failed',
          handled: true,
          phase: 'acknowledge',
        },
      ],
      [
        {
          requestId: 'req-system-failed',
          handled: true,
          phase: 'reserve',
        },
      ],
      [
        {
          requestId: 'req-system-failed',
          handled: false,
          phase: 'complete',
        },
      ],
    ]);
    expect(discardOpenedBrowser).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'browser-link',
    );
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('reveals a system-default panel only after main commits ownership', async () => {
    const openUrlFromDevServer = jest
      .fn()
      .mockReturnValue(opened('browser-system', false));
    useBrowserStore.setState({ openUrlFromDevServer });
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
    });
    ensureBrowserEventSubscription();

    listener?.({
      type: 'app-link-open-requested',
      requestId: 'req-system-success',
      url: 'https://example.com/from-os',
      source: 'system-default',
      awaitCompletion: true,
      openInApp: true,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(resolveOpenLinkRequest.mock.calls).toEqual([
      [
        {
          requestId: 'req-system-success',
          handled: true,
          phase: 'acknowledge',
        },
      ],
      [
        {
          requestId: 'req-system-success',
          handled: true,
          phase: 'reserve',
        },
      ],
      [
        {
          requestId: 'req-system-success',
          handled: true,
          phase: 'complete',
        },
      ],
    ]);
    expect(jest.mocked(requestBrowserPanel).mock.calls).toEqual([
      ['project-1', 'worktree-1', 'browser-system'],
    ]);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('reports failed completion when reserved system-default reveal fails', async () => {
    const openUrlFromDevServer = jest
      .fn()
      .mockReturnValue(opened('browser-system', true));
    const destroyBrowser = jest.fn().mockResolvedValue(undefined);
    const originalDestroyBrowser = useBrowserStore.getState().destroyBrowser;
    try {
      useBrowserStore.setState({ openUrlFromDevServer, destroyBrowser });
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      });
      jest.mocked(requestBrowserPanel).mockResolvedValueOnce(false);
      ensureBrowserEventSubscription();

      listener?.({
        type: 'app-link-open-requested',
        requestId: 'req-system-reveal-failed',
        url: 'https://example.com/from-os',
        source: 'system-default',
        awaitCompletion: true,
        openInApp: true,
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(discardOpenedBrowser).toHaveBeenCalledWith(
        'project-1',
        'worktree-1',
        'browser-system',
      );
      expect(resolveOpenLinkRequest).toHaveBeenLastCalledWith({
        requestId: 'req-system-reveal-failed',
        handled: false,
        phase: 'complete',
      });
      expect(openExternal).not.toHaveBeenCalled();
    } finally {
      useBrowserStore.setState({ destroyBrowser: originalDestroyBrowser });
    }
  });

  it('does not mutate browser state when main revokes ownership before commit', async () => {
    const openUrlFromDevServer = jest
      .fn()
      .mockReturnValue(opened('browser-late', true));
    const destroyBrowser = jest.fn().mockResolvedValue(undefined);
    const originalDestroyBrowser = useBrowserStore.getState().destroyBrowser;
    try {
      useBrowserStore.setState({ openUrlFromDevServer, destroyBrowser });
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      });
      resolveOpenLinkRequest
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      ensureBrowserEventSubscription();

      listener?.({
        type: 'app-link-open-requested',
        requestId: 'req-system-late',
        url: 'https://example.com/from-os',
        source: 'system-default',
        awaitCompletion: true,
        openInApp: true,
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(requestBrowserPanel).not.toHaveBeenCalled();
      expect(openUrlFromDevServer).not.toHaveBeenCalled();
      expect(destroyBrowser).not.toHaveBeenCalled();
      expect(discardOpenedBrowser).not.toHaveBeenCalled();
      expect(openExternal).not.toHaveBeenCalled();
    } finally {
      useBrowserStore.setState({ destroyBrowser: originalDestroyBrowser });
    }
  });

  it('rolls back a new session when main rejects late completion', async () => {
    const openUrlFromDevServer = jest
      .fn()
      .mockReturnValue(opened('browser-completed-late', true));
    const destroyBrowser = jest.fn().mockResolvedValue(undefined);
    const originalDestroyBrowser = useBrowserStore.getState().destroyBrowser;
    try {
      useBrowserStore.setState({ openUrlFromDevServer, destroyBrowser });
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      });
      resolveOpenLinkRequest
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      ensureBrowserEventSubscription();

      listener?.({
        type: 'app-link-open-requested',
        requestId: 'req-system-completed-late',
        url: 'https://example.com/from-os',
        source: 'system-default',
        awaitCompletion: true,
        openInApp: true,
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(resolveOpenLinkRequest).toHaveBeenLastCalledWith({
        requestId: 'req-system-completed-late',
        handled: true,
        phase: 'complete',
      });
      expect(discardOpenedBrowser).toHaveBeenCalledWith(
        'project-1',
        'worktree-1',
        'browser-completed-late',
      );
      expect(openExternal).not.toHaveBeenCalled();
    } finally {
      useBrowserStore.setState({ destroyBrowser: originalDestroyBrowser });
    }
  });

  it('does not mutate a reused browser before main commits delivery', async () => {
    const openUrlFromDevServer = jest
      .fn()
      .mockReturnValue(opened('browser-reused', false));
    const destroyBrowser = jest.fn().mockResolvedValue(undefined);
    const setActiveBrowser = jest.fn().mockResolvedValue(undefined);
    const originalDestroyBrowser = useBrowserStore.getState().destroyBrowser;
    const originalSetActiveBrowser =
      useBrowserStore.getState().setActiveBrowser;
    try {
      useBrowserStore.setState({
        openUrlFromDevServer,
        destroyBrowser,
        setActiveBrowser,
      });
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      });
      resolveOpenLinkRequest
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      ensureBrowserEventSubscription();

      listener?.({
        type: 'app-link-open-requested',
        requestId: 'req-system-reused-late',
        url: 'https://example.com/from-os',
        source: 'system-default',
        awaitCompletion: true,
        openInApp: true,
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(requestBrowserPanel).not.toHaveBeenCalled();
      expect(openUrlFromDevServer).not.toHaveBeenCalled();
      expect(destroyBrowser).not.toHaveBeenCalled();
      expect(discardOpenedBrowser).not.toHaveBeenCalled();
      expect(setActiveBrowser).not.toHaveBeenCalled();
      expect(openExternal).not.toHaveBeenCalled();
    } finally {
      useBrowserStore.setState({
        destroyBrowser: originalDestroyBrowser,
        setActiveBrowser: originalSetActiveBrowser,
      });
    }
  });

  it('raises a recoverable toast when local-only forced the link out', async () => {
    const addToast = jest.fn<
      void,
      Parameters<ReturnType<typeof useGitHubStore.getState>['addToast']>
    >();
    const originalAddToast = useGitHubStore.getState().addToast;
    try {
      useGitHubStore.setState({ addToast });
      useBrowserStore.setState({ localServersOnly: true });
      savePreferences.mockResolvedValueOnce(
        makeTestPreferences({ inAppBrowserLocalServersOnly: false }),
      );
      ensureBrowserEventSubscription();

      listener?.({
        type: 'app-link-local-only-conflict',
        url: 'https://example.com/docs',
      });

      expect(addToast).toHaveBeenCalledTimes(1);
      const [message, type, onClick, meta] = addToast.mock.calls[0];
      expect(message).toContain('example.com');
      expect(type).toBe('warning');
      expect(onClick).toBeUndefined();
      expect(meta?.action?.label).toBe('Allow all sites');

      meta?.action?.onClick();
      await new Promise((resolve) => setImmediate(resolve));

      expect(savePreferences).toHaveBeenCalledWith({
        inAppBrowserLocalServersOnly: false,
      });
      expect(useBrowserStore.getState().localServersOnly).toBe(false);
    } finally {
      useGitHubStore.setState({ addToast: originalAddToast });
    }
  });

  it('acknowledges a context-only probe without placing a browser panel', async () => {
    const openUrlFromDevServer = jest.fn();
    useBrowserStore.setState({ openUrlFromDevServer });
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
    });
    ensureBrowserEventSubscription();

    listener?.({
      type: 'app-link-open-requested',
      requestId: 'req-context',
      url: 'https://example.com/blocked',
      source: 'app-link',
      openInApp: false,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(resolveOpenLinkRequest).toHaveBeenCalledWith({
      requestId: 'req-context',
      handled: true,
      phase: 'acknowledge',
    });
    expect(openUrlFromDevServer).not.toHaveBeenCalled();
    expect(requestBrowserPanel).not.toHaveBeenCalled();
  });

  describe('link context menu (CAN-2632)', () => {
    const originalAddToast = useGitHubStore.getState().addToast;
    const addToast = jest.fn<
      void,
      Parameters<ReturnType<typeof useGitHubStore.getState>['addToast']>
    >();

    beforeEach(() => {
      useGitHubStore.setState({ addToast });
    });

    afterEach(() => {
      useGitHubStore.setState({ addToast: originalAddToast });
    });

    function expectFailureToast(url: string): void {
      expect(addToast).toHaveBeenCalledTimes(1);
      const [message, type, , meta] = addToast.mock.calls[0];
      expect(message).toContain(new URL(url).hostname);
      expect(type).toBe('warning');
      expect(meta?.title).toBe("Couldn't open the link in the browser");
      expect(meta?.forceInApp).toBe(true);
      expect(meta?.action?.label).toBe('Open in external browser');
      // The toast offers the external browser; it never opens it by itself.
      expect(openExternal).not.toHaveBeenCalled();
      meta?.action?.onClick();
      expect(openExternal).toHaveBeenCalledWith({ url });
    }

    it('places the link in the selected worktree without an external fallback', async () => {
      const openUrlFromDevServer = jest
        .fn()
        .mockReturnValue(opened('browser-menu', true));
      useBrowserStore.setState({ openUrlFromDevServer });
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      });
      ensureBrowserEventSubscription();

      listener?.({
        type: 'app-link-open-requested',
        requestId: 'req-menu',
        url: 'https://example.com/menu?x=1#frag',
        source: 'link-context-menu',
        openInApp: true,
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(openUrlFromDevServer).toHaveBeenCalledWith(
        'project-1',
        'worktree-1',
        { url: 'https://example.com/menu?x=1#frag' },
      );
      expect(openExternal).not.toHaveBeenCalled();
      expect(addToast).not.toHaveBeenCalled();
    });

    it('raises the failure toast instead of opening externally when placement fails', async () => {
      const openUrlFromDevServer = jest
        .fn()
        .mockReturnValue(opened('browser-menu', true));
      useBrowserStore.setState({ openUrlFromDevServer });
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      });
      jest.mocked(requestBrowserPanel).mockResolvedValueOnce(false);
      ensureBrowserEventSubscription();

      listener?.({
        type: 'app-link-open-requested',
        requestId: 'req-menu-fail',
        url: 'https://example.com/menu-fail',
        source: 'link-context-menu',
        openInApp: true,
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(discardOpenedBrowser).toHaveBeenCalledWith(
        'project-1',
        'worktree-1',
        'browser-menu',
      );
      expectFailureToast('https://example.com/menu-fail');
    });

    it('declines and raises the failure toast with no worktree selected', async () => {
      const openUrlFromDevServer = jest.fn();
      useBrowserStore.setState({ openUrlFromDevServer });
      useChatStore.setState({ selectedWorktree: null });
      ensureBrowserEventSubscription();

      listener?.({
        type: 'app-link-open-requested',
        requestId: 'req-menu-none',
        url: 'https://example.com/menu-none',
        source: 'link-context-menu',
        openInApp: true,
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(resolveOpenLinkRequest).toHaveBeenCalledWith({
        requestId: 'req-menu-none',
        handled: false,
        phase: 'acknowledge',
      });
      expect(openUrlFromDevServer).not.toHaveBeenCalled();
      expectFailureToast('https://example.com/menu-none');
    });

    it('opens a chat link in the given worktree browser and reports the outcome', async () => {
      const openUrlFromDevServer = jest
        .fn()
        .mockReturnValue(opened('browser-chat', true));
      useBrowserStore.setState({ openUrlFromDevServer });
      // The message's worktree, not the selected one, receives the tab.
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
      });

      await expect(
        openAppLinkInWorktreeBrowser(
          'project-2',
          'worktree-2',
          'https://example.com/chat',
        ),
      ).resolves.toBe(true);
      expect(openUrlFromDevServer).toHaveBeenCalledWith(
        'project-2',
        'worktree-2',
        { url: 'https://example.com/chat' },
      );
      expect(addToast).not.toHaveBeenCalled();

      jest.mocked(requestBrowserPanel).mockResolvedValueOnce(false);
      await expect(
        openAppLinkInWorktreeBrowser(
          'project-2',
          'worktree-2',
          'https://example.com/chat-fail',
        ),
      ).resolves.toBe(false);
      expectFailureToast('https://example.com/chat-fail');
    });
  });
});

// Main hands links to web settings pages to the renderer first (CAN-4692).
// The renderer opens them inside Settings or declines, and main keeps
// ordinary app-link routing when it declines.
describe('settings link routing', () => {
  const settingsEvent: BrowserServiceEvent = {
    type: 'settings-link-open-requested',
    requestId: 'req-settings',
    url: 'https://app.example.test/account/billing?tab=x#y',
    path: '/account/billing?tab=x#y',
  };

  it('acknowledges the settings path as handled, then opens it in Settings', async () => {
    jest.mocked(settingsPathOpensInApp).mockReturnValue(true);
    jest.mocked(openSettingsPathInApp).mockReturnValue(true);
    ensureBrowserEventSubscription();

    listener?.(settingsEvent);
    await new Promise((resolve) => setImmediate(resolve));

    expect(settingsPathOpensInApp).toHaveBeenCalledWith(
      '/account/billing?tab=x#y',
    );
    expect(resolveOpenLinkRequest).toHaveBeenCalledWith({
      requestId: 'req-settings',
      handled: true,
      phase: 'acknowledge',
    });
    expect(resolveOpenLinkRequest).toHaveBeenCalledTimes(1);
    expect(openSettingsPathInApp).toHaveBeenCalledWith(
      '/account/billing?tab=x#y',
    );
    expect(
      jest.mocked(openSettingsPathInApp).mock.invocationCallOrder[0],
    ).toBeGreaterThan(resolveOpenLinkRequest.mock.invocationCallOrder[0]);
    expect(requestBrowserPanel).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    expect(useBrowserStore.getState().worktrees).toEqual({});
  });

  it('declines when Settings cannot open the path, leaving routing to main', async () => {
    jest.mocked(settingsPathOpensInApp).mockReturnValue(false);
    ensureBrowserEventSubscription();

    listener?.(settingsEvent);
    await new Promise((resolve) => setImmediate(resolve));

    expect(resolveOpenLinkRequest).toHaveBeenCalledWith({
      requestId: 'req-settings',
      handled: false,
      phase: 'acknowledge',
    });
    expect(openSettingsPathInApp).not.toHaveBeenCalled();
    expect(requestBrowserPanel).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  // The App Advisor window routes its own chat links but mounts no Settings,
  // so accepting there would swallow the link.
  it('declines in the App Advisor window without opening Settings', async () => {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        body: { dataset: { rendererSurface: 'app-advisor' } },
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      },
    });
    jest.mocked(settingsPathOpensInApp).mockReturnValue(true);

    try {
      ensureBrowserEventSubscription();
      listener?.(settingsEvent);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      Reflect.deleteProperty(globalThis, 'document');
    }

    expect(settingsPathOpensInApp).not.toHaveBeenCalled();
    expect(openSettingsPathInApp).not.toHaveBeenCalled();
    expect(resolveOpenLinkRequest).toHaveBeenCalledWith({
      requestId: 'req-settings',
      handled: false,
      phase: 'acknowledge',
    });
  });

  // A throw would leave main waiting out its timeout before routing the link.
  it('declines at once when deciding whether Settings opens throws', async () => {
    jest.mocked(settingsPathOpensInApp).mockImplementation(() => {
      throw new Error('navigation unavailable');
    });
    ensureBrowserEventSubscription();

    expect(() => listener?.(settingsEvent)).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));

    expect(resolveOpenLinkRequest).toHaveBeenCalledWith({
      requestId: 'req-settings',
      handled: false,
      phase: 'acknowledge',
    });
    expect(openSettingsPathInApp).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('swallows a failed acknowledgement without opening Settings', async () => {
    jest.mocked(settingsPathOpensInApp).mockReturnValue(true);
    resolveOpenLinkRequest.mockRejectedValueOnce(new Error('ipc closed'));
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    ensureBrowserEventSubscription();

    try {
      listener?.(settingsEvent);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', unhandled);
    }

    expect(resolveOpenLinkRequest).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
    expect(openSettingsPathInApp).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  // Once main accepts, it has given up its own fallback, so a Settings open
  // that still fails must not lose the click.
  it('opens the link externally when Settings fails after main accepted', async () => {
    jest.mocked(settingsPathOpensInApp).mockReturnValue(true);
    jest.mocked(openSettingsPathInApp).mockReturnValue(false);
    ensureBrowserEventSubscription();

    listener?.(settingsEvent);
    await new Promise((resolve) => setImmediate(resolve));

    expect(openSettingsPathInApp).toHaveBeenCalledWith(
      '/account/billing?tab=x#y',
    );
    expect(openExternal).toHaveBeenCalledWith({
      url: 'https://app.example.test/account/billing?tab=x#y',
    });
  });

  // `false` means main stopped waiting and already routed the link itself, so
  // opening Settings as well would open the same link twice.
  it('does not open Settings when main already timed the request out', async () => {
    jest.mocked(settingsPathOpensInApp).mockReturnValue(true);
    resolveOpenLinkRequest.mockResolvedValueOnce(false);
    ensureBrowserEventSubscription();

    listener?.(settingsEvent);
    await new Promise((resolve) => setImmediate(resolve));

    expect(resolveOpenLinkRequest).toHaveBeenCalledWith({
      requestId: 'req-settings',
      handled: true,
      phase: 'acknowledge',
    });
    expect(openSettingsPathInApp).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });
});

// Main only waits a short time for the acknowledgement and opens the link
// externally itself once that window lapses. `resolveOpenLinkRequest` reports
// whether the answer still counted, so a late "yes" must not also place a
// panel — that would open the same link twice.
describe('app-link late acknowledgement', () => {
  const originalOpenUrl = useBrowserStore.getState().openUrlFromDevServer;
  const originalSelection = useChatStore.getState().selectedWorktree;

  afterEach(() => {
    useBrowserStore.setState({ openUrlFromDevServer: originalOpenUrl });
    useChatStore.setState({ selectedWorktree: originalSelection });
  });

  it('does not open in-app when main already timed the request out', async () => {
    const openUrlFromDevServer = jest.fn();
    useBrowserStore.setState({ openUrlFromDevServer });
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
    });
    resolveOpenLinkRequest.mockResolvedValueOnce(false);
    ensureBrowserEventSubscription();

    listener?.({
      type: 'app-link-open-requested',
      requestId: 'req-late',
      url: 'https://example.com/pr/late',
      source: 'app-link',
      openInApp: true,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(openUrlFromDevServer).not.toHaveBeenCalled();
    // Main owns the external fallback for a lapsed request.
    expect(openExternal).not.toHaveBeenCalled();
  });
});

it('drops old-account events and snapshots when a tab runtime generation advances', () => {
  ensureBrowserEventSubscription();
  const first = {
    ...snapshot(),
    profile: {
      selection: { kind: 'task' as const },
      resolvedProfileId: 'task-profile',
      storageGeneration: 1,
      runtimeGeneration: 1,
      taskIncarnationId: 'incarnation',
    },
  };
  useBrowserStore.getState().registerBrowserSnapshot(first);
  listener?.({
    type: 'console',
    browserId: first.id,
    runtimeGeneration: 1,
    entry: {
      id: 'old-log',
      browserId: first.id,
      timestamp: 1,
      level: 'log',
      text: 'Old account',
    },
  });
  expect(useBrowserStore.getState().consoleEntries[first.id]).toHaveLength(1);
  const next = {
    ...first,
    title: 'New account',
    profile: { ...first.profile, runtimeGeneration: 2 },
  };
  listener?.({
    type: 'snapshot',
    browserId: first.id,
    runtimeGeneration: 2,
    snapshot: next,
  });
  expect(useBrowserStore.getState().consoleEntries[first.id]).toBeUndefined();
  listener?.({
    type: 'snapshot',
    browserId: first.id,
    runtimeGeneration: 1,
    snapshot: first,
  });
  listener?.({
    type: 'dialog-opened',
    browserId: first.id,
    runtimeGeneration: 1,
    dialog: {
      id: 'old-dialog',
      browserId: first.id,
      type: 'alert',
      message: 'Old account',
      url: first.url,
      openedAt: 1,
    },
  });
  expect(
    useBrowserStore.getState().worktrees['project-1/worktree-1'].browsers[
      first.id
    ].title,
  ).toBe('New account');
  expect(useBrowserStore.getState().dialogs[first.id]).toBeUndefined();
});

describe('browser handoffs (CAN-4663)', () => {
  const originalSelection = useChatStore.getState().selectedWorktree;
  const handoff = (
    handoffId: string,
    worktreeId = 'worktree-1',
  ): BrowserHandoff => ({
    handoffId,
    projectId: 'project-1',
    worktreeId,
    browserId: 'browser-agent',
    origin: { projectId: 'project-1', worktreeId, chatTabId: 'chat-1' },
    requestedAt: 1,
  });
  const requested = (
    value: BrowserHandoff,
    revision: number,
  ): BrowserServiceEvent => ({
    type: 'handoff-requested',
    browserId: value.browserId,
    handoff: value,
    revision,
  });
  const released = (
    handoffId: string,
    revision: number,
  ): BrowserServiceEvent => ({
    type: 'handoff-released',
    browserId: 'browser-agent',
    handoffId,
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    revision,
  });
  const flush = async (): Promise<void> => {
    for (let index = 0; index < 5; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  const pinned = (): BrowserHandoff | null =>
    useBrowserStore.getState().browserHandoffs['project-1/worktree-1']
      ?.handoff ?? null;
  const focusCalls = (): unknown[][] =>
    jest
      .mocked(requestBrowserPanel)
      .mock.calls.filter((call) => call[4]?.focus === true);

  beforeEach(() => {
    useBrowserStore.setState({ browserHandoffs: {} });
    useBrowserStore.getState().registerBrowserSnapshot(snapshot());
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
    });
    ensureBrowserEventSubscription();
  });

  afterEach(() => {
    useChatStore.setState({ selectedWorktree: originalSelection });
  });

  it('selects the handoff browser once in the selected worktree, without queueing', async () => {
    listener?.(requested(handoff('h1'), 1));
    await flush();

    expect(pinned()?.handoffId).toBe('h1');
    expect(requestBrowserPanel).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'browser-agent',
      'chat-1',
      { focus: true, queue: false },
    );

    // A repeated request for the same handoff never refocuses after the
    // user switched away.
    listener?.(requested(handoff('h1'), 2));
    await flush();
    expect(focusCalls()).toHaveLength(1);
  });

  it('leaves another worktree pending attention without focusing it', async () => {
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-2' },
    });

    listener?.(requested(handoff('h1'), 1));
    await flush();

    expect(pinned()?.handoffId).toBe('h1');
    expect(focusCalls()).toHaveLength(0);
  });

  it('places the requested browser before the handoff focuses it', async () => {
    listener?.({
      type: 'open-requested',
      browserId: 'browser-agent',
      snapshot: { ...snapshot(), id: 'browser-agent' },
      originChatTabId: 'chat-1',
      createdNewSession: false,
    });
    listener?.(requested(handoff('h1'), 1));
    await flush();

    const options = jest
      .mocked(requestBrowserPanel)
      .mock.calls.map((call) => call[4]);
    expect(options).toEqual([{ focus: false }, { focus: true, queue: false }]);
  });

  it('honors main background policy before handoff hydration arrives', async () => {
    listener?.({
      type: 'open-requested',
      browserId: 'browser-agent',
      snapshot: snapshot(),
      createdNewSession: false,
      presentation: 'background',
    });
    await flush();
    expect(requestBrowserPanel).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      'browser-agent',
      undefined,
      { focus: false, preserveSelection: true },
    );
    expect(focusCalls()).toHaveLength(0);
  });

  it.each(['worktree', 'browser-destroyed'] as const)(
    'cancels delayed focus after %s changes even if the user returns',
    async (reason) => {
      let finishPlacement: (() => void) | undefined;
      jest.mocked(requestBrowserPanel).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishPlacement = (): void => resolve(true);
          }),
      );
      listener?.({
        type: 'open-requested',
        browserId: 'browser-agent',
        snapshot: snapshot(),
        originChatTabId: 'chat-1',
        createdNewSession: false,
      });
      listener?.(requested(handoff('h1'), 1));
      await flush();
      if (reason === 'worktree') {
        useChatStore.setState({
          selectedWorktree: { projectId: 'project-1', worktreeId: 'other' },
        });
        useChatStore.setState({
          selectedWorktree: {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
          },
        });
      } else {
        listener?.({ type: 'destroyed', browserId: 'browser-agent' });
      }
      finishPlacement?.();
      await flush();
      expect(focusCalls()).toHaveLength(0);
    },
  );

  it('releases only the matching handoff and ignores out-of-order events', async () => {
    listener?.(requested(handoff('h1'), 1));
    listener?.(requested(handoff('h2'), 3));
    await flush();

    // Stale release for the replaced handoff keeps the replacement pinned.
    listener?.(released('h1', 4));
    expect(pinned()?.handoffId).toBe('h2');
    // An older event cannot resurrect anything.
    listener?.(requested(handoff('h1'), 2));
    expect(pinned()?.handoffId).toBe('h2');

    listener?.(released('h2', 5));
    expect(pinned()).toBeNull();
    await flush();
    // h1 was replaced before its focus ran, so only h2 drew attention.
    expect(focusCalls()).toHaveLength(1);
  });

  it('expires pending attention instead of focusing after a late placement', async () => {
    jest.useFakeTimers();
    let finishPlacement: (() => void) | undefined;
    try {
      jest.mocked(requestBrowserPanel).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishPlacement = (): void => resolve(true);
          }),
      );
      listener?.({
        type: 'open-requested',
        browserId: 'browser-agent',
        snapshot: snapshot(),
        originChatTabId: 'chat-1',
        createdNewSession: false,
      });
      listener?.(requested(handoff('expired'), 1));
      await jest.advanceTimersByTimeAsync(6_000);
      expect(focusCalls()).toHaveLength(0);
      finishPlacement?.();
      await jest.advanceTimersByTimeAsync(0);
      expect(focusCalls()).toHaveLength(0);
      expect(pinned()?.handoffId).toBe('expired');
    } finally {
      finishPlacement?.();
      jest.useRealTimers();
    }
  });

  it('restores protection from hydration without focus, and never over a newer event', async () => {
    const store = useBrowserStore.getState();
    store.applyBrowserHandoffHydration('project-1', 'worktree-1', {
      revision: 4,
      handoff: handoff('h1'),
    });
    expect(pinned()?.handoffId).toBe('h1');

    listener?.(released('h1', 5));
    // A snapshot taken before the release must not bring it back.
    store.applyBrowserHandoffHydration('project-1', 'worktree-1', {
      revision: 4,
      handoff: handoff('h1'),
    });
    expect(pinned()).toBeNull();
    await flush();
    expect(focusCalls()).toHaveLength(0);
  });
});

describe('transfer events', () => {
  const download = {
    kind: 'download' as const,
    id: 'download-1',
    browserId: 'browser-agent',
    source: 'user' as const,
    origin: 'https://example.com/report.csv',
    fileName: 'report.csv',
    receivedBytes: 5,
    totalBytes: 10,
    status: 'in_progress' as const,
    startedAt: 1,
  };

  beforeEach(() => {
    useBrowserStore.setState({
      transfers: {},
      blockedDownloads: {},
      downloadToasts: {},
    });
  });

  it('accepts a transfer by browser id even though it carries no runtime generation', () => {
    ensureBrowserEventSubscription();
    useBrowserStore.getState().registerBrowserSnapshot({
      ...snapshot(),
      profile: {
        selection: { kind: 'task' },
        resolvedProfileId: 'task-profile',
        storageGeneration: 1,
        runtimeGeneration: 3,
        taskIncarnationId: 'incarnation',
      },
    });

    listener?.({
      type: 'transfer',
      browserId: 'browser-agent',
      transfer: download,
    });

    expect(useBrowserStore.getState().transfers['browser-agent']).toEqual([
      download,
    ]);
  });

  it('accepts a transfer for a browser the store has not mirrored', () => {
    ensureBrowserEventSubscription();
    listener?.({
      type: 'transfer',
      browserId: 'browser-elsewhere',
      transfer: { ...download, browserId: 'browser-elsewhere' },
    });

    expect(
      useBrowserStore.getState().transfers['browser-elsewhere'],
    ).toHaveLength(1);
  });

  it('records one blocked-downloads notice per browser', () => {
    ensureBrowserEventSubscription();
    listener?.({
      type: 'download-blocked',
      browserId: 'browser-agent',
      blockedCount: 1,
    });
    listener?.({
      type: 'download-blocked',
      browserId: 'browser-agent',
      blockedCount: 1,
    });

    expect(useBrowserStore.getState().blockedDownloads).toEqual({
      'browser-agent': 1,
    });
  });
});

it('closes the pressed browser tab panel for the in-page close-tab shortcut', async () => {
  jest.mocked(findBrowserPanelBindings).mockReturnValue([
    {
      layoutKey: 'project-1/worktree-1',
      groupId: 'group-browser',
      panelId: 'panel-browser-agent',
    },
  ]);
  ensureBrowserEventSubscription();

  listener?.({
    type: 'shortcut',
    browserId: 'browser-agent',
    snapshot: snapshot(),
    action: 'close-tab',
  });
  await new Promise((resolve) => setImmediate(resolve));

  expect(findBrowserPanelBindings).toHaveBeenCalledWith('browser-agent');
  expect(closePanelTab).toHaveBeenCalledTimes(1);
  expect(closePanelTab).toHaveBeenCalledWith(
    'project-1/worktree-1',
    'group-browser',
    'panel-browser-agent',
  );
});

it('never opens a new tab for the in-page close-tab shortcut of an unbound browser', async () => {
  jest.mocked(findBrowserPanelBindings).mockReturnValue([]);
  const create = jest.fn(() => new Promise(() => undefined));
  Object.assign(window.api.browser, { create });
  ensureBrowserEventSubscription();

  listener?.({
    type: 'shortcut',
    browserId: 'browser-agent',
    snapshot: snapshot(),
    action: 'close-tab',
  });
  await new Promise((resolve) => setImmediate(resolve));

  expect(closePanelTab).not.toHaveBeenCalled();
  expect(requestBrowserPanel).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(useBrowserStore.getState().worktrees).toEqual({});
});

it('closes every panel bound to the browser for the in-page close-tab shortcut', async () => {
  jest.mocked(findBrowserPanelBindings).mockReturnValue([
    {
      layoutKey: 'project-1/worktree-1',
      groupId: 'group-browser',
      panelId: 'panel-browser-agent',
    },
    {
      layoutKey: 'app-advisor/project-1',
      groupId: 'group-advisor-browser',
      panelId: 'panel-advisor-browser-agent',
    },
  ]);
  ensureBrowserEventSubscription();

  listener?.({
    type: 'shortcut',
    browserId: 'browser-agent',
    snapshot: snapshot(),
    action: 'close-tab',
  });
  await new Promise((resolve) => setImmediate(resolve));

  expect(jest.mocked(closePanelTab).mock.calls).toEqual([
    ['project-1/worktree-1', 'group-browser', 'panel-browser-agent'],
    [
      'app-advisor/project-1',
      'group-advisor-browser',
      'panel-advisor-browser-agent',
    ],
  ]);
});

it('honors the session runtime generation main stamps on the close-tab shortcut', async () => {
  jest.mocked(findBrowserPanelBindings).mockReturnValue([
    {
      layoutKey: 'project-1/worktree-1',
      groupId: 'group-browser',
      panelId: 'panel-browser-agent',
    },
  ]);
  const profile = {
    selection: { kind: 'task' as const },
    resolvedProfileId: 'task-profile',
    storageGeneration: 1,
    runtimeGeneration: 2,
    taskIncarnationId: 'incarnation',
  };
  useBrowserStore
    .getState()
    .registerBrowserSnapshot({ ...snapshot(), profile });
  ensureBrowserEventSubscription();

  // An old-account generation is dropped like every other browser event.
  listener?.({
    type: 'shortcut',
    browserId: 'browser-agent',
    runtimeGeneration: 1,
    snapshot: { ...snapshot(), profile: { ...profile, runtimeGeneration: 1 } },
    action: 'close-tab',
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(closePanelTab).not.toHaveBeenCalled();

  // Main stamps the live session's generation, so a real keypress closes.
  listener?.({
    type: 'shortcut',
    browserId: 'browser-agent',
    runtimeGeneration: 2,
    snapshot: { ...snapshot(), profile },
    action: 'close-tab',
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(closePanelTab).toHaveBeenCalledTimes(1);
  expect(closePanelTab).toHaveBeenCalledWith(
    'project-1/worktree-1',
    'group-browser',
    'panel-browser-agent',
  );
});
