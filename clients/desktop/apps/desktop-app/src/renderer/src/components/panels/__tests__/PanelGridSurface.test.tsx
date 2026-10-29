/**
 * @jest-environment jsdom
 */
import {
  setTestLabsFeatures,
  setTestEarlyAccessFeatures,
} from '@/test-utils/labsExperiments';

import { act, Children, isValidElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PanelGridSurfaceServices } from '@canopy/ui-app/panel-grid-surface';
import type { ChatTab } from '@/stores/chatStore';
import { useChatStore } from '@/stores/chatStore';
import type { PanelGroupModel, PanelTabModel } from '@canopy/ui-shared/panels';
import { resetExperimentalFeaturesStoreForTest } from '@/stores/experimentalFeaturesStore';
import { usePanelLayoutStore } from '@/stores/panelLayoutStore';
import { useWorkspaceLayoutModeStore } from '@/stores/workspaceLayoutModeStore';
import {
  ChatGroupArchivedChatsAccessory,
  type ChatGroupArchivedChatsAccessoryProps,
} from '../ChatGroupArchivedChatsAccessory';
import { PanelGridSurface } from '../PanelGridSurface';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { noteChatIntent, endChatIntent } from '@/stores/chat/chat-prefetch';

jest.mock('@/stores/chat/chat-prefetch', () => ({
  noteChatIntent: jest.fn(),
  endChatIntent: jest.fn(),
}));

const mockOpenShare = jest.fn();
let capturedServices: PanelGridSurfaceServices | undefined;

jest.mock('@canopy/ui-app/panel-grid-surface', () => ({
  PanelGridSurface: (props: { services: PanelGridSurfaceServices }): null => {
    capturedServices = props.services;
    return null;
  },
}));
jest.mock('@/hooks/useShareRunAction', () => ({
  useShareRunAction: (): Record<string, unknown> => ({
    entryVisible: jest.fn(() => true),
    target: null,
    open: mockOpenShare,
    close: jest.fn(),
    submit: jest.fn(),
    checkEligibility: jest.fn(),
    onShared: jest.fn(),
  }),
}));
jest.mock('@/hooks/useExportSessionAction', () => ({
  useExportSessionAction: (): Record<string, unknown> => ({
    target: null,
    open: jest.fn(),
    close: jest.fn(),
    confirm: jest.fn(),
  }),
}));
let mockAccess: { mode: string; runAllowed?: boolean } = {
  mode: 'read-write',
};
jest.mock('@/lib/workspace-access', () => ({
  useWorkspaceAccess: (): { mode: string; runAllowed?: boolean } => mockAccess,
}));
jest.mock('@/stores/workspaceLayoutModeStore', () => {
  const state = {
    entries: {
      'project-1/worktree-1': { status: 'ready', mode: 'classic' },
    },
    load: jest.fn().mockResolvedValue(undefined),
  };
  const useWorkspaceLayoutModeStore = (
    selector: (value: typeof state) => unknown,
  ): unknown => selector(state);
  useWorkspaceLayoutModeStore.getState = (): typeof state => state;
  return { useWorkspaceLayoutModeStore };
});
jest.mock('@/lib/panels/persistence-bridge', () => ({
  ensureWorktreePanelLayout: jest.fn(),
  disposeWorktreePanelHydration: jest.fn(),
  refreshLiveMinimalLayout: jest.fn(),
}));
jest.mock('@/lib/panels/terminal-panel-sync', () => ({
  initTerminalPanelSync: jest.fn(),
}));
// The chat-routing sync rewrites real layouts; these tests seed partial ones.
jest.mock('@/lib/panels/early-access-panel-rules', () => ({
  ensureEarlyAccessPanelRulesSync: jest.fn(),
}));
jest.mock('@/lib/panels/registry', () => ({
  getPanelDefinition: (): { canPopOut: boolean } => ({ canPopOut: false }),
  renderPanelContent: jest.fn(),
}));
jest.mock('../SidePanelEmptyState', () => ({
  SidePanelEmptyState: (): null => null,
}));
jest.mock('@/lib/session-transfer-eligibility', () => ({
  canTransferChatSession: (): boolean => true,
}));
jest.mock('@/components/panels/ChatGroupArchivedChatsAccessory', () => ({
  ChatGroupArchivedChatsAccessory: (): null => null,
}));

const CHAT_GROUP: PanelGroupModel = {
  groupId: 'group-chat',
  tabs: [],
  activePanelId: null,
};

/**
 * The archive accessory the grid offers a group, or null without one. The
 * accessory is a fragment that can also hold the early-access Activity toggle.
 */
function accessoryPropsFor(
  services: PanelGridSurfaceServices | undefined,
): ChatGroupArchivedChatsAccessoryProps | null {
  const node: ReactNode = services?.tabStripAccessoryForGroup?.(CHAT_GROUP);
  if (!isValidElement<{ children?: ReactNode }>(node)) return null;
  for (const child of Children.toArray(node.props.children)) {
    if (
      isValidElement<ChatGroupArchivedChatsAccessoryProps>(child) &&
      child.type === ChatGroupArchivedChatsAccessory
    ) {
      return child.props;
    }
  }
  return null;
}

const EXISTING_SHARE = {
  externalId: 'run-1',
  shareScope: 'team' as const,
  teamId: 'team-1',
  teamName: 'Platform',
  sharedAt: '2026-09-24T20:00:00.000Z',
};

describe('PanelGridSurface', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    capturedServices = undefined;
    mockOpenShare.mockClear();
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        getFileTreeRoots: jest.fn().mockResolvedValue({ roots: [] }),
        resolveProjectStartPage: jest.fn().mockResolvedValue(null),
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useChatStore.setState({
      worktreeChats: {
        'project-1/worktree-1': {
          activeTabId: 'chat-1',
          tabs: [
            {
              id: 'chat-1',
              title: 'Shared session',
              messages: [],
              queuedMessages: [],
              sharedRun: EXISTING_SHARE,
            } as ChatTab,
          ],
        },
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetExperimentalFeaturesStoreForTest();
    useChatStore.setState({ selectedWorktree: null });
  });

  function renderUnloadedLayout(): void {
    act(() => {
      root.render(
        <PanelGridSurface
          projectId="project-1"
          worktreeId="worktree-unloaded"
          hostState={{} as never}
        />,
      );
    });
  }

  it('prefetches inactive chat headers only, using their bound chat id', async () => {
    const original = usePanelLayoutStore.getState();
    const key = 'project-1/worktree-1';
    original.initializeLayout(key, {
      orientation: 'horizontal',
      groups: [
        {
          kind: 'chat',
          groupId: 'group-chat',
          panelId: 'panel-chat-chat-1',
          instance: { chatTabId: 'chat-1' },
        },
      ],
      containerSize: { width: 800, height: 600 },
    });
    const inactive: PanelTabModel = {
      panelId: 'panel-chat-chat-2',
      kind: 'chat',
      title: 'Second',
      instance: { chatTabId: 'chat-2' },
    };
    const active: PanelTabModel = {
      panelId: 'panel-chat-chat-1',
      kind: 'chat',
      title: 'First',
      instance: { chatTabId: 'chat-1' },
    };
    jest.mocked(noteChatIntent).mockClear();
    jest.mocked(endChatIntent).mockClear();
    try {
      await renderGrid();
      const intent = capturedServices?.onTabIntent;
      expect(intent).toBeDefined();
      for (const source of ['pointer', 'focus'] as const) {
        intent?.('group-chat', inactive, 'start', source);
        intent?.('group-chat', inactive, 'end', source);
        intent?.('group-chat', active, 'start', source);
        intent?.('group-chat', active, 'end', source);
        intent?.(
          'group-chat',
          { ...inactive, kind: 'file-diff' },
          'start',
          source,
        );
        intent?.(
          'group-chat',
          { ...inactive, instance: undefined },
          'start',
          source,
        );
      }
      const target = {
        kind: 'chat',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-2',
      };
      expect(noteChatIntent).toHaveBeenCalledTimes(2);
      expect(noteChatIntent).toHaveBeenNthCalledWith(1, target, 'pointer');
      expect(noteChatIntent).toHaveBeenNthCalledWith(2, target, 'focus');
      expect(endChatIntent).toHaveBeenCalledTimes(2);
      expect(endChatIntent).toHaveBeenCalledWith(target);
    } finally {
      usePanelLayoutStore.setState(original);
    }
  });

  it('shows a loading card without a Labs opt-in', () => {
    renderUnloadedLayout();

    expect(
      container.querySelector('[data-testid="panel-grid-loading"]'),
    ).not.toBeNull();
    expect(container.childElementCount).toBe(1);
  });

  it('keeps the inset panel card on screen while the layout loads under early access', () => {
    setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
    renderUnloadedLayout();

    expect(
      container
        .querySelector('[data-testid="panel-grid-loading"]')
        ?.hasAttribute('data-panel-grid-loading'),
    ).toBe(true);
  });

  async function renderGrid(archivedChatsAccessory?: boolean): Promise<void> {
    await act(async () => {
      root.render(
        <PanelGridSurface
          projectId="project-1"
          worktreeId="worktree-1"
          hostState={{} as never}
          archivedChatsAccessory={archivedChatsAccessory}
        />,
      );
      await Promise.resolve();
    });
  }

  function selectWorktree(): void {
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
    });
  }

  describe('chat tab previews', () => {
    const chatTab: PanelTabModel = {
      panelId: 'panel-chat-chat-1',
      kind: 'chat',
      title: 'First',
      instance: { chatTabId: 'chat-1' },
    };

    it('offers no hover card while the experiment is off', async () => {
      await renderGrid();
      expect(capturedServices?.renderTabHoverCard).toBeUndefined();
    });

    it('offers a preview card for chat tabs once switched on', async () => {
      setTestLabsFeatures({ 'chat-tab-previews': true });
      await renderGrid();
      const renderCard = capturedServices?.renderTabHoverCard;
      expect(renderCard).toBeDefined();
      const card = renderCard?.(chatTab);
      expect(isValidElement<{ target: unknown }>(card)).toBe(true);
      expect(
        isValidElement<{ target: unknown }>(card) ? card.props.target : null,
      ).toEqual({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
      });
    });

    it('keeps other tab kinds on their tooltip', async () => {
      setTestLabsFeatures({ 'chat-tab-previews': true });
      await renderGrid();
      const renderCard = capturedServices?.renderTabHoverCard;
      expect(
        renderCard?.({ panelId: 'browser-1', kind: 'browser', title: 'Docs' }),
      ).toBeNull();
      expect(renderCard?.({ ...chatTab, instance: undefined })).toBeNull();
    });
  });

  it('offers a worktree grid no archive accessory with early access off', async () => {
    selectWorktree();
    await renderGrid(false);

    expect(capturedServices?.tabStripAccessoryForGroup).toBeUndefined();
  });

  it('keeps the scoped header-style accessory with early access off', async () => {
    await renderGrid();

    expect(accessoryPropsFor(capturedServices)).toMatchObject({
      primarySurface: false,
      variant: 'tabStrip',
    });
  });

  it('ignores a retired archived-chat-tabs opt-in on a worktree grid', async () => {
    setTestLabsFeatures({ 'archived-chat-tabs': true });
    selectWorktree();
    await renderGrid(false);
    expect(accessoryPropsFor(capturedServices)).toBeNull();
  });

  it('keeps the selected worktree archive control out of tabs with legacy Early access on', async () => {
    setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
    selectWorktree();
    await renderGrid(false);
    expect(accessoryPropsFor(capturedServices)).toBeNull();
  });

  it('leaves an unselected worktree grid without an archive accessory in early access', async () => {
    setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
    await renderGrid(false);

    // Early access always offers the strip accessory, for the Activity
    // toggle; the archive control is not in it.
    expect(accessoryPropsFor(capturedServices)).toBeNull();
  });

  it('keeps a scoped surface non-primary in the tab-strip style in early access', async () => {
    setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
    selectWorktree();
    await renderGrid();

    expect(accessoryPropsFor(capturedServices)).toMatchObject({
      primarySurface: false,
      variant: 'tabStrip',
    });
  });

  it('forwards an existing run share from the panel-tab action', async () => {
    await act(async () => {
      root.render(
        <PanelGridSurface
          projectId="project-1"
          worktreeId="worktree-1"
          hostState={{} as never}
        />,
      );
      await Promise.resolve();
    });

    capturedServices?.onShareSession?.('chat-1', document);

    expect(mockOpenShare).toHaveBeenCalledWith(
      'chat-1',
      'Shared session',
      document,
      EXISTING_SHARE,
    );
  });

  describe('Minimal Side Panel', () => {
    const KEY = 'project-1/worktree-1';
    const tab = (panelId: string, kind: string): PanelTabModel =>
      ({ panelId, kind, title: kind }) as never;
    const group = (groupId: string): PanelGroupModel =>
      ({ groupId, tabs: [], activePanelId: null }) as never;

    async function renderMinimal(
      earlyAccess: boolean,
      extrasTabs: PanelTabModel[] = [tab('panel-files', 'file-explorer')],
    ): Promise<void> {
      setTestEarlyAccessFeatures({
        enabled: earlyAccess,
        hydrated: true,
      });
      const entry = useWorkspaceLayoutModeStore.getState().entries[KEY] as {
        mode: string;
      };
      entry.mode = 'minimal';
      usePanelLayoutStore.setState({
        layouts: {
          [KEY]: {
            groups: {
              'group-chat': { tabs: [tab('chat-1', 'chat')] },
              'group-extras': { tabs: extrasTabs },
            },
          },
        } as never,
      });
      await act(async () => {
        root.render(
          <PanelGridSurface
            projectId="project-1"
            worktreeId="worktree-1"
            hostState={{} as never}
          />,
        );
        await Promise.resolve();
      });
    }

    afterEach(() => {
      // Restores the real actions a test stubbed.
      usePanelLayoutStore.setState(usePanelLayoutStore.getInitialState());
      const entry = useWorkspaceLayoutModeStore.getState().entries[KEY] as {
        mode: string;
      };
      entry.mode = 'classic';
      mockAccess = { mode: 'read-write' };
      act(() => {
        usePanelLayoutStore.setState({ layouts: {} });
        setTestEarlyAccessFeatures({ enabled: false });
      });
    });

    it('keeps filled tab behavior without a Labs opt-in', async () => {
      await renderMinimal(false);
      expect(capturedServices?.onNewTabInGroup).toBeDefined();
      expect(capturedServices?.emptyContentForGroup).toBeDefined();
      const canClose = capturedServices?.canCloseTab;
      expect(canClose?.(tab('panel-files', 'file-explorer'))).toBe(true);
      expect(canClose?.(tab('panel-activity', 'activity-section'))).toBe(true);
      // The lone chat keeps its close button.
      expect(canClose?.(tab('chat-1', 'chat'))).toBe(false);
    });

    it('opens New tabs and lets the Side Panel empty with early access on', async () => {
      await renderMinimal(true);
      expect(capturedServices?.onNewTabInGroup).toBeDefined();
      const canClose = capturedServices?.canCloseTab;
      expect(canClose?.(tab('panel-files', 'file-explorer'))).toBe(true);
      // The chat group must keep a tab, so its only one offers no close.
      expect(canClose?.(tab('chat-1', 'chat'))).toBe(false);
      const actions = { addTab: jest.fn(), openAddMenu: jest.fn() };
      expect(
        capturedServices?.emptyContentForGroup?.(
          group('group-extras'),
          actions,
        ),
      ).not.toBeUndefined();
      expect(
        capturedServices?.emptyContentForGroup?.(group('group-chat'), actions),
      ).toBeUndefined();
    });

    it('fills an empty Side Panel with a New tab with early access on', async () => {
      const addTab = jest.fn<
        string | null,
        Parameters<ReturnType<typeof usePanelLayoutStore.getState>['addTab']>
      >(() => null);
      usePanelLayoutStore.setState({
        addTab,
        collapseGroup: jest.fn(() => true),
      });
      await renderMinimal(true, []);
      expect(addTab).toHaveBeenCalledTimes(1);
      const [key, groupId, kind, opts] = addTab.mock.calls[0] ?? [];
      expect([key, groupId, kind]).toEqual([KEY, 'group-extras', 'new-tab']);
      expect(opts?.title).toBe('New tab');
      expect(opts?.activate).toBe(false);
      expect(typeof opts?.instance?.newTabId).toBe('string');
    });

    it('hides a Side Panel whose last tab closed, then fills it with a New tab', async () => {
      const addTab = jest.fn();
      const collapseGroup = jest.fn(() => true);
      usePanelLayoutStore.setState({ addTab, collapseGroup });
      await renderMinimal(true, []);
      expect(collapseGroup).toHaveBeenCalledWith(KEY, 'group-extras');
      expect(addTab).toHaveBeenCalledTimes(1);
      // Hidden first, so the New tab waits in a hidden Side Panel.
      expect(collapseGroup.mock.invocationCallOrder[0]).toBeLessThan(
        addTab.mock.invocationCallOrder[0] ?? 0,
      );
    });

    it('restores a maximized Side Panel before hiding it', async () => {
      const calls: string[] = [];
      const maximizeGroup = jest.fn(
        (_key: string, groupId: string, maximized: boolean) => {
          calls.push(`maximize:${groupId}:${String(maximized)}`);
          return true;
        },
      );
      const collapseGroup = jest.fn((_key: string, groupId: string) => {
        calls.push(`collapse:${groupId}`);
        return true;
      });
      usePanelLayoutStore.setState({
        addTab: jest.fn(),
        collapseGroup,
        maximizeGroup,
      } as never);
      const entry = useWorkspaceLayoutModeStore.getState().entries[KEY] as {
        mode: string;
      };
      entry.mode = 'minimal';
      setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
      usePanelLayoutStore.setState({
        layouts: {
          [KEY]: {
            maximizedGroupId: 'group-extras',
            groups: {
              'group-chat': { tabs: [tab('chat-1', 'chat')] },
              'group-extras': { tabs: [] },
            },
          },
        } as never,
      });
      await act(async () => {
        root.render(
          <PanelGridSurface
            projectId="project-1"
            worktreeId="worktree-1"
            hostState={{} as never}
          />,
        );
        await Promise.resolve();
      });
      expect(calls).toEqual([
        'maximize:group-extras:false',
        'collapse:group-extras',
      ]);
    });

    it('adds no New tab in a read-only shared container', async () => {
      mockAccess = { mode: 'read-only', runAllowed: false };
      const addTab = jest.fn();
      usePanelLayoutStore.setState({ addTab });
      await renderMinimal(true, []);
      expect(addTab).not.toHaveBeenCalled();
      expect(capturedServices?.onNewTabInGroup).toBeUndefined();
    });
  });
});
