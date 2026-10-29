import type * as NewTabShortcutModule from '../newTabShortcut';
import type * as ChatPanelSyncModule from '../panels/chat-panel-sync';
import type * as PanelLayoutStoreModule from '@/stores/panelLayoutStore';

// The active-panel query and the canonical panel-close path are collaborators;
// the routing under test resolves the focused panel and closes it exactly the
// way its tab-strip "X" button does.
const mockGetActivePanel = jest.fn<
  ReturnType<typeof NewTabShortcutModule.getActivePanel>,
  [string]
>();
jest.mock('../newTabShortcut', () => ({
  getActivePanel: (
    panelKey: string,
  ): ReturnType<typeof NewTabShortcutModule.getActivePanel> =>
    mockGetActivePanel(panelKey),
}));

const mockClosePanelTab = jest.fn<
  void,
  Parameters<typeof ChatPanelSyncModule.closePanelTab>
>();
jest.mock('../panels/chat-panel-sync', () => ({
  closePanelTab: (layoutKey: string, groupId: string, panelId: string): void =>
    mockClosePanelTab(layoutKey, groupId, panelId),
}));

type PanelLayoutViewModel = NonNullable<
  ReturnType<typeof PanelLayoutStoreModule.getPanelLayoutViewModel>
>;

const mockGetPanelLayoutViewModel = jest.fn<
  PanelLayoutViewModel | null,
  [string]
>();
const mockMakeWorktreePanelKey = jest.fn<string, [string, string]>(
  (projectId, worktreeId) => `${projectId}/${worktreeId}`,
);
// Minimal's fixed topology: stored layout modes and groups for the last-tab rule.
let mockLayoutModes: Record<string, { mode: 'minimal' | 'advanced' }> = {};
let mockLayoutGroups: Record<
  string,
  Record<string, { tabs: Array<{ panelId: string }> }>
> = {};
jest.mock('@/stores/panelLayoutStore', () => ({
  makeWorktreePanelKey: (projectId: string, worktreeId: string): string =>
    mockMakeWorktreePanelKey(projectId, worktreeId),
  getPanelLayoutViewModel: (panelKey: string): PanelLayoutViewModel | null =>
    mockGetPanelLayoutViewModel(panelKey),
  usePanelLayoutStore: {
    getState: (): {
      layouts: Record<
        string,
        { groups: Record<string, { tabs: Array<{ panelId: string }> }> }
      >;
    } => ({
      layouts: Object.fromEntries(
        Object.entries(mockLayoutGroups).map(([key, groups]) => [
          key,
          { groups },
        ]),
      ),
    }),
  },
}));
jest.mock('@/stores/workspaceLayoutModeStore', () => ({
  getWorkspaceLayoutMode: (worktreeKey: string): 'minimal' | 'advanced' =>
    mockLayoutModes[worktreeKey]?.mode ?? 'advanced',
}));

import {
  hasCloseableTabForShortcut,
  runCloseTabShortcut,
} from '../closeTabShortcut';

beforeEach(() => {
  mockGetActivePanel.mockReset();
  mockClosePanelTab.mockReset();
  mockGetPanelLayoutViewModel.mockReset();
  mockMakeWorktreePanelKey.mockClear();
  mockLayoutModes = {};
  mockLayoutGroups = {};
});

describe('runCloseTabShortcut (context-aware ⌘W, ECW-7984)', () => {
  it('closes the active browser panel like its "X" button', () => {
    mockGetActivePanel.mockReturnValue({
      groupId: 'group-1',
      panelId: 'panel-browser-7',
      kind: 'browser',
    });

    const kind = runCloseTabShortcut({
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });

    expect(kind).toBe('browser');
    expect(mockClosePanelTab).toHaveBeenCalledWith(
      'project-a/wt-1',
      'group-1',
      'panel-browser-7',
    );
  });

  it('closes the active one-session terminal panel', () => {
    mockGetActivePanel.mockReturnValue({
      groupId: 'group-2',
      panelId: 'panel-terminal',
      kind: 'terminal',
    });

    const kind = runCloseTabShortcut({
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });

    expect(kind).toBe('terminal');
    expect(mockClosePanelTab).toHaveBeenCalledWith(
      'project-a/wt-1',
      'group-2',
      'panel-terminal',
    );
  });

  it('closes the active chat panel through the same panel-close path', () => {
    // Chat is not special-cased: the same close path honors last-chat
    // replacement and refuses to close a streaming chat, matching the button.
    mockGetActivePanel.mockReturnValue({
      groupId: 'group-chat',
      panelId: 'panel-chat-seed',
      kind: 'chat',
    });

    const kind = runCloseTabShortcut({
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });

    expect(kind).toBe('chat');
    expect(mockClosePanelTab).toHaveBeenCalledWith(
      'project-a/wt-1',
      'group-chat',
      'panel-chat-seed',
    );
  });

  it('is a no-op when the worktree has no active panel', () => {
    mockGetActivePanel.mockReturnValue(null);

    const kind = runCloseTabShortcut({
      projectId: 'project-a',
      worktreeId: 'wt-1',
    });

    expect(kind).toBeNull();
    expect(mockClosePanelTab).not.toHaveBeenCalled();
  });

  it('routes to the auxiliary layout when a layoutKey is provided', () => {
    mockGetActivePanel.mockReturnValue({
      groupId: 'aux-group',
      panelId: 'panel-browser-aux',
      kind: 'browser',
    });

    runCloseTabShortcut({
      projectId: 'project-a',
      worktreeId: 'wt-1',
      layoutKey: 'aux:window-2',
    });

    expect(mockGetActivePanel).toHaveBeenCalledWith('aux:window-2');
    expect(mockClosePanelTab).toHaveBeenCalledWith(
      'aux:window-2',
      'aux-group',
      'panel-browser-aux',
    );
  });
});

describe('hasCloseableTabForShortcut (CAN-3952)', () => {
  const target = { projectId: 'app-advisor', worktreeId: 'entry-1' };

  function viewModel(
    groups: Array<{
      groupId: string;
      kinds: string[];
      collapsed?: boolean;
    }>,
  ): PanelLayoutViewModel {
    return {
      groups: groups.map((group) => ({
        groupId: group.groupId,
        tabs: group.kinds.map((kind, index) => ({
          panelId: `${group.groupId}-${kind}-${index}`,
          kind,
          title: kind,
        })),
        activePanelId:
          group.kinds.length > 0
            ? `${group.groupId}-${group.kinds[0]}-0`
            : null,
        ...(group.collapsed === true
          ? { collapsed: { edge: 'right' as const } }
          : {}),
      })),
      activeGroupId: groups[0]?.groupId ?? null,
      maximizedGroupId: null,
    };
  }

  function focusChat(): void {
    mockGetActivePanel.mockReturnValue({
      groupId: 'main',
      panelId: 'main-chat-0',
      kind: 'chat',
    });
  }

  it('has nothing to close without an active panel', () => {
    mockGetActivePanel.mockReturnValue(null);

    expect(hasCloseableTabForShortcut(target)).toBe(false);
  });

  it('has nothing to close when the active chat has no view model', () => {
    focusChat();
    mockGetPanelLayoutViewModel.mockReturnValue(null);

    expect(hasCloseableTabForShortcut(target)).toBe(false);
  });

  it('keeps the only chat even beside Minimal Side Panel tabs', () => {
    focusChat();
    mockGetPanelLayoutViewModel.mockReturnValue(
      viewModel([
        { groupId: 'main', kinds: ['chat'] },
        { groupId: 'side', kinds: ['activity-section', 'file-explorer'] },
      ]),
    );

    expect(hasCloseableTabForShortcut(target)).toBe(false);
  });

  it('closes a chat when another chat shares its group', () => {
    focusChat();
    mockGetPanelLayoutViewModel.mockReturnValue(
      viewModel([{ groupId: 'main', kinds: ['chat', 'chat'] }]),
    );

    expect(hasCloseableTabForShortcut(target)).toBe(true);
  });

  it('closes a chat when another chat lives in a different group', () => {
    focusChat();
    mockGetPanelLayoutViewModel.mockReturnValue(
      viewModel([
        { groupId: 'main', kinds: ['chat'] },
        { groupId: 'split', kinds: ['chat'] },
      ]),
    );

    expect(hasCloseableTabForShortcut(target)).toBe(true);
  });

  it('counts a chat in a collapsed group', () => {
    focusChat();
    mockGetPanelLayoutViewModel.mockReturnValue(
      viewModel([
        { groupId: 'main', kinds: ['chat'] },
        { groupId: 'collapsed', kinds: ['chat'], collapsed: true },
      ]),
    );

    expect(hasCloseableTabForShortcut(target)).toBe(true);
  });

  it.each(['terminal', 'browser'])(
    'closes an active %s panel beside a single chat',
    (kind) => {
      mockGetActivePanel.mockReturnValue({
        groupId: 'tools',
        panelId: `tools-${kind}-0`,
        kind,
      });
      mockGetPanelLayoutViewModel.mockReturnValue(
        viewModel([
          { groupId: 'main', kinds: ['chat'] },
          { groupId: 'tools', kinds: [kind] },
        ]),
      );

      expect(hasCloseableTabForShortcut(target)).toBe(true);
    },
  );

  it('reads the provided layoutKey instead of the worktree layout', () => {
    focusChat();
    mockGetPanelLayoutViewModel.mockReturnValue(
      viewModel([{ groupId: 'main', kinds: ['chat', 'chat'] }]),
    );

    hasCloseableTabForShortcut({ ...target, layoutKey: 'aux:window-2' });

    expect(mockGetActivePanel).toHaveBeenCalledWith('aux:window-2');
    expect(mockGetPanelLayoutViewModel).toHaveBeenCalledWith('aux:window-2');
    expect(mockMakeWorktreePanelKey).not.toHaveBeenCalled();
  });

  describe("under Minimal's fixed topology", () => {
    const layoutKey = 'app-advisor/entry-1';

    function focus(groupId: string, kind: string): void {
      const panelId = `${groupId}-${kind}`;
      mockGetActivePanel.mockReturnValue({ groupId, panelId, kind });
      mockLayoutGroups = {
        [layoutKey]: {
          ...mockLayoutGroups[layoutKey],
          [groupId]: { tabs: [{ panelId }] },
        },
      };
    }

    function addTab(groupId: string, panelId: string): void {
      const groups = mockLayoutGroups[layoutKey] ?? {};
      mockLayoutGroups = {
        [layoutKey]: {
          ...groups,
          [groupId]: {
            tabs: [...(groups[groupId]?.tabs ?? []), { panelId }],
          },
        },
      };
    }

    beforeEach(() => {
      mockLayoutModes = { [layoutKey]: { mode: 'minimal' } };
    });

    it.each(['activity-section', 'file-explorer'])(
      'closes a focused %s tab when another Side Panel tab remains',
      (kind) => {
        focus('group-extras', kind);
        addTab('group-extras', 'group-extras-other');

        expect(hasCloseableTabForShortcut(target)).toBe(true);
      },
    );

    it.each(['activity-section', 'file-explorer'])(
      'closes the last %s tab of the Side Panel',
      (kind) => {
        focus('group-extras', kind);
        expect(hasCloseableTabForShortcut(target)).toBe(true);
      },
    );

    it('has nothing to close when the focused tab is the last of a kept group', () => {
      focus('group-chat', 'browser');

      expect(hasCloseableTabForShortcut(target)).toBe(false);
    });

    it('closes the last tab of the bottom drawer', () => {
      focus('group-terminal', 'terminal');

      expect(hasCloseableTabForShortcut(target)).toBe(true);
    });

    it('applies no fixed-topology rule to an Advanced layout', () => {
      mockLayoutModes = { [layoutKey]: { mode: 'advanced' } };
      focus('group-extras', 'activity-section');

      expect(hasCloseableTabForShortcut(target)).toBe(true);
    });
  });
});
