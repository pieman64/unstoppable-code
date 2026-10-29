/** @jest-environment jsdom */

/**
 * Cmd/Ctrl+T in a Browser surface: the new Browser tab is bound and its
 * address bar focus requested on the keystroke, while the backend session is
 * still being created.
 */
import {
  findPanelByInstanceKey,
  makeWorktreePanelKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { useBrowserStore } from '@/stores/browserStore';
import { consumePendingBrowserUrlFocus } from '@/lib/browserUrlFocus';
import { MAX_TABS_PER_GROUP } from '@canopy/ui-shared/panels';
import { useGitHubStore } from '@/stores/githubStore';
import { requestTerminalSpawn } from '@/lib/terminalSpawnRequests';
import { runNewTabShortcut } from '../newTabShortcut';

jest.mock('@/lib/terminalSpawnRequests', () => ({
  ...jest.requireActual<Record<string, unknown>>('@/lib/terminalSpawnRequests'),
  requestTerminalSpawn: jest.fn(),
}));

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-new-tab';
const KEY = makeWorktreePanelKey(PROJECT_ID, WORKTREE_ID);

const create = jest.fn();

beforeEach(() => {
  create.mockReset().mockReturnValue(new Promise(() => undefined));
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      browser: {
        create,
        loadWorktreeState: jest
          .fn()
          .mockResolvedValue({ status: 'missing', state: null }),
        setActive: jest.fn().mockResolvedValue(undefined),
      },
    },
  });
  useBrowserStore.setState({ worktrees: {}, openingBrowserIds: {} });
  usePanelLayoutStore.getState().initializeLayout(KEY, {
    orientation: 'horizontal',
    groups: [
      {
        kind: 'browser',
        groupId: 'group-browser',
        panelId: 'panel-browser-existing',
        instance: { browserId: 'browser-existing' },
      },
    ],
    containerSize: { width: 1200, height: 700 },
  });
});

it('binds a new Browser tab on the keystroke, before its session exists', async () => {
  const surface = document.createElement('div');
  surface.setAttribute('data-browser-surface', '');
  document.body.append(surface);
  try {
    const kind = runNewTabShortcut({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      target: surface,
      createChatTab: jest.fn(),
    });
    await Promise.resolve();

    expect(kind).toBe('browser');
    const bucket = useBrowserStore.getState().worktrees[KEY];
    const newId = bucket.browserOrder[0];
    expect(newId).toBeDefined();
    expect(useBrowserStore.getState().openingBrowserIds[newId]).toBe(true);
    const location = findPanelByInstanceKey(KEY, `browser:${newId}`);
    expect(location?.groupId).toBe('group-browser');
    expect(consumePendingBrowserUrlFocus(newId)).toBe(true);
  } finally {
    surface.remove();
  }
});

it('refuses Cmd+T in a full terminal row before a terminal is spawned', () => {
  const TERMINAL_KEY = makeWorktreePanelKey(PROJECT_ID, 'worktree-terminal');
  const store = usePanelLayoutStore.getState();
  store.initializeLayout(TERMINAL_KEY, {
    orientation: 'horizontal',
    groups: [
      {
        kind: 'terminal',
        groupId: 'group-terminal',
        panelId: 'panel-terminal-0',
        instance: { terminalId: 'terminal-0' },
      },
    ],
    containerSize: { width: 1200, height: 700 },
  });
  for (let index = 1; index < MAX_TABS_PER_GROUP; index += 1) {
    store.addTab(TERMINAL_KEY, 'group-terminal', 'terminal', {
      instance: { terminalId: `terminal-${index}` },
      activate: false,
    });
  }
  store.setTabRowLimit(MAX_TABS_PER_GROUP);
  try {
    const kind = runNewTabShortcut({
      projectId: PROJECT_ID,
      worktreeId: 'worktree-terminal',
      target: null,
      createChatTab: jest.fn(),
    });

    expect(kind).toBe('terminal');
    expect(requestTerminalSpawn).not.toHaveBeenCalled();
    expect(
      useGitHubStore
        .getState()
        .toasts.some((toast) => toast.message === 'Tab limit reached (20)'),
    ).toBe(true);
  } finally {
    store.setTabRowLimit(null);
    useGitHubStore.setState({ toasts: [] });
  }
});

it('opens a chat instead of a Browser tab in a window that shows another computer', async () => {
  const api = window.api;
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ...api,
      remoteControl: {
        getContext: (): unknown => ({
          mode: 'remote',
          deviceId: 'device-b',
          name: 'Studio',
          platform: 'darwin',
        }),
      },
    },
  });
  const createChatTab = jest.fn();
  const browserTabIds = (): Array<string | undefined> =>
    Object.values(usePanelLayoutStore.getState().layouts[KEY]?.groups ?? {})
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.kind === 'browser')
      .map((tab) => tab.instance?.browserId);
  const before = browserTabIds();
  try {
    // The focused group holds the other computer's saved Browser tab.
    const kind = runNewTabShortcut({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      target: null,
      createChatTab,
    });
    await Promise.resolve();

    expect(kind).toBe('chat');
    expect(createChatTab).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(useBrowserStore.getState().worktrees[KEY]).toBeUndefined();
    expect(before).toContain('browser-existing');
    expect(browserTabIds()).toEqual(before);
  } finally {
    Object.defineProperty(window, 'api', { configurable: true, value: api });
  }
});
