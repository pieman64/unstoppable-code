/** @jest-environment jsdom */
import {
  setPanelLayoutFixedTopology,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { useWorkspaceLayoutModeStore } from '@/stores/workspaceLayoutModeStore';
import { setWorkspacePanelLayoutMode } from '../workspace-layout-mode-actions';
import {
  DEFAULT_ACTIVITY_GROUP_ID,
  DEFAULT_CHAT_GROUP_ID,
  DEFAULT_TERMINAL_GROUP_ID,
} from '../panel-group-ids';

jest.mock('@/stores/panelWindowsStore', () => ({
  usePanelWindowsStore: {
    getState: (): {
      auxWindows: Record<string, never>;
      disposeWorktreeAuxWindows: jest.Mock;
      focusAuxWindowForLayout: () => boolean;
    } => ({
      auxWindows: {},
      disposeWorktreeAuxWindows: jest.fn(),
      // No auxiliary windows exist, so there is never one to focus.
      focusAuxWindowForLayout: (): boolean => false,
    }),
  },
}));

const KEY = 'project-layout-mode/worktree-layout-mode';
const saveWorktreeMode = jest.fn<Promise<void>, [unknown]>();

function initializeAdvancedLayout(): void {
  usePanelLayoutStore.getState().initializeLayout(KEY, {
    orientation: 'vertical',
    groups: [
      {
        groupId: DEFAULT_CHAT_GROUP_ID,
        panelId: 'panel-chat-transition',
        kind: 'chat',
        instance: { chatTabId: 'chat-transition' },
      },
      {
        groupId: DEFAULT_ACTIVITY_GROUP_ID,
        panelId: 'panel-activity-transition',
        kind: 'activity-section',
      },
      {
        groupId: DEFAULT_TERMINAL_GROUP_ID,
        panelId: 'panel-terminal-transition',
        kind: 'terminal',
      },
    ],
  });
  useWorkspaceLayoutModeStore.setState({
    entries: {
      [KEY]: { mode: 'advanced', status: 'ready', requestId: 1 },
    },
  });
}

beforeEach(() => {
  setPanelLayoutFixedTopology(KEY, false);
  usePanelLayoutStore.setState({ layouts: {}, layoutSizeRevisions: {} });
  useWorkspaceLayoutModeStore.setState({ entries: {} });
  saveWorktreeMode.mockReset();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { panelLayout: { saveWorktreeMode } },
  });
  initializeAdvancedLayout();
});

afterEach(() => {
  setPanelLayoutFixedTopology(KEY, false);
  usePanelLayoutStore.setState({ layouts: {}, layoutSizeRevisions: {} });
  useWorkspaceLayoutModeStore.setState({ entries: {} });
});

it('locks topology while the Minimal mode save is pending', async () => {
  let finishSave: (() => void) | undefined;
  saveWorktreeMode.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishSave = resolve;
      }),
  );

  const transition = setWorkspacePanelLayoutMode(KEY, 'minimal');
  await Promise.resolve();

  expect(saveWorktreeMode).toHaveBeenCalledTimes(1);
  expect(
    usePanelLayoutStore
      .getState()
      .splitGroup(KEY, DEFAULT_CHAT_GROUP_ID, 'right', {
        groupId: 'group-race',
        panelId: 'panel-race',
        kind: 'usage',
      }),
  ).toBeNull();

  finishSave?.();
  await expect(transition).resolves.toBe(true);
});

it('clears the topology lock and restores the layout when persistence fails', async () => {
  const before = usePanelLayoutStore.getState().serializeLayout(KEY);
  saveWorktreeMode.mockRejectedValue(new Error('disk'));

  await expect(setWorkspacePanelLayoutMode(KEY, 'minimal')).resolves.toBe(
    false,
  );

  expect(usePanelLayoutStore.getState().serializeLayout(KEY)).toEqual(before);
  expect(
    usePanelLayoutStore
      .getState()
      .splitGroup(KEY, DEFAULT_CHAT_GROUP_ID, 'right', {
        groupId: 'group-after-rollback',
        panelId: 'panel-after-rollback',
        kind: 'usage',
      }),
  ).toBe('group-after-rollback');
});
