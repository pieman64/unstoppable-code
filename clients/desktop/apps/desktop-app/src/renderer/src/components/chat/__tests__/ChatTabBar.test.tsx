/**
 * @jest-environment jsdom
 */
import { shareEnvelope } from '@/test-utils/shareOperation';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatTabBar } from '../ChatTabBar';
import { WorkspaceAccessContext } from '@/lib/workspace-access';
import { ArchivedChatsControl } from '../ArchivedChatsControl';
import {
  useChatStore,
  WORKTREE_CHAT_OPEN_ARCHIVE_TRANSCRIPT_EVENT,
  type ChatTab,
} from '@/stores/chatStore';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { useGitHubStore } from '@/stores/githubStore';
import type { CanopyClient } from '@canopy/app-core';
import { createFileViewerStore } from '@canopy/app-state';
import { desktopFileSessionController } from '@/lib/file-viewer/desktop-file-session-controller';
import {
  resetDelegationActivityStoreForTests,
  useDelegationActivityStore,
} from '@/stores/delegationActivityStore';

const originalAddToast = useGitHubStore.getState().addToast;
const mockShareSessionAction = jest.fn().mockResolvedValue(undefined);
const mockShareRun = jest.fn().mockResolvedValue({ externalId: 'run-private' });

jest.mock('../ArchivedChatTranscriptModal', () => ({
  ArchivedChatTranscriptModal: (): null => null,
}));
jest.mock('@/lib/shareSessionAction', () => ({
  shareSessionAction: (...args: unknown[]): Promise<void> =>
    mockShareSessionAction(...args) as Promise<void>,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function makeTab(overrides: Partial<ChatTab> = {}): ChatTab {
  return {
    id: 'chat-1',
    title: 'Chat',
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-06-20T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', fastMode: false },
    fastModeExplicit: false,
    model: 'claude-sonnet-4-5-20250514',
    providerType: 'claude',
    ...overrides,
  };
}

describe('ChatTabBar current UI archive reporting', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockShareSessionAction.mockClear();
    mockShareRun.mockClear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    window.api = {
      chat: {},
      runs: { share: shareEnvelope(mockShareRun) },
      loadCanopyCloudAccount: jest.fn().mockResolvedValue({
        hasApiKey: true,
        authMode: 'oauth',
        credentialSource: 'oauth_desktop',
        capabilities: [
          'session-exports-v1',
          'runs-crud-v1',
          'teams-v1',
          'organizations-v1',
        ],
        account: { id: 'account-1', email: 'user@example.test' },
        storageAvailable: true,
      }),
    } as typeof window.api;
    window.pipelines = {
      listSharedTeams: jest.fn().mockResolvedValue({
        success: true,
        data: { data: [] },
      }),
      listSharedOrganizations: jest.fn().mockResolvedValue({
        success: true,
        data: { data: [] },
      }),
    } as typeof window.pipelines;
    useChatStore.setState({
      selectedWorktree: { projectId: 'project', worktreeId: 'worktree' },
      worktreeChats: {
        'project/worktree': {
          activeTabId: 'chat-1',
          tabs: [makeTab()],
        },
      },
      archivedChats: {},
    });
    useCurrentUiStateStore.setState({ revision: 0, slices: {} });
    useCurrentUiStateStore.getState().recomputeEnvelope();
    useCurrentUiStateStore.getState().updateSlice('chat.activeTab', {
      chatId: 'chat-1',
    });
    useGitHubStore.setState({
      toasts: [],
      notifications: [],
      addToast: originalAddToast,
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    resetDelegationActivityStoreForTests();
    delete (window as typeof window & { api?: typeof window.api }).api;
    delete (window as typeof window & { pipelines?: typeof window.pipelines })
      .pipelines;
  });

  it('retries the self-heal whenever an empty worktree scope commits again', async () => {
    const loadTabs = jest.fn().mockResolvedValue(undefined);
    useChatStore.setState({
      loadTabs,
      worktreeChats: {
        'project/worktree': { activeTabId: '', tabs: [] },
      },
    });
    await act(async () => {
      root.render(createElement(ChatTabBar));
      await Promise.resolve();
    });
    expect(loadTabs).toHaveBeenCalledTimes(1);

    // The starter tab's creation failed; the scope's next commit replaces its
    // (still empty) tabs, and the tab bar asks for the tabs again.
    await act(async () => {
      useChatStore.setState({
        worktreeChats: {
          'project/worktree': { activeTabId: '', tabs: [] },
        },
      });
      await Promise.resolve();
    });
    expect(loadTabs).toHaveBeenCalledTimes(2);
  });

  it('omits archivedChats before the archive list is loaded', async () => {
    await act(async () => {
      root.render(createElement(ChatTabBar));
      await Promise.resolve();
    });

    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.activeChat
        ?.archivedChats,
    ).toBeUndefined();
  });

  it('uses a neutral chat icon when provider metadata is not available yet', async () => {
    useChatStore.setState({
      modelDefaults: null,
      worktreeChats: {
        'project/worktree': {
          activeTabId: 'chat-1',
          tabs: [
            makeTab({
              model: undefined,
              providerType: undefined,
            }),
          ],
        },
      },
    });

    await act(async () => {
      root.render(createElement(ChatTabBar));
      await Promise.resolve();
    });

    expect(
      container.querySelector(
        '[data-app-icon="true"][data-glyph="message-circle"]',
      ),
    ).not.toBeNull();
    expect(container.querySelector('path[d^="m3.127 10.604"]')).toBeNull();
  });

  it('uses a neutral chat icon for stale persisted model ids', async () => {
    useChatStore.setState({
      modelDefaults: null,
      worktreeChats: {
        'project/worktree': {
          activeTabId: 'chat-1',
          tabs: [
            makeTab({
              model: 'retired-model',
              providerType: undefined,
            }),
          ],
        },
      },
    });

    await act(async () => {
      root.render(createElement(ChatTabBar));
      await Promise.resolve();
    });

    expect(
      container.querySelector(
        '[data-app-icon="true"][data-glyph="message-circle"]',
      ),
    ).not.toBeNull();
    expect(container.querySelector('path[d^="m3.127 10.604"]')).toBeNull();
  });

  it('uses the semantic unread color for a panel chat tab', async () => {
    useChatStore.setState({
      worktreeChats: {
        'project/worktree': {
          activeTabId: 'chat-1',
          tabs: [makeTab({ unread: true })],
        },
      },
    });

    await act(async () => {
      root.render(createElement(ChatTabBar));
      await Promise.resolve();
    });

    const unreadTab = container.querySelector<HTMLElement>(
      '[data-testid="chat-tab-chat-1"]',
    );
    expect(unreadTab?.dataset.unread).toBe('true');
    expect(unreadTab?.querySelector('.fg-info')).not.toBeNull();
    expect(unreadTab?.querySelector('.fg-warning')).toBeNull();
  });

  it('keeps the semantic unread color while a chat is streaming', async () => {
    useChatStore.setState({
      worktreeChats: {
        'project/worktree': {
          activeTabId: 'chat-1',
          tabs: [makeTab({ status: 'streaming', unread: true })],
        },
      },
    });

    await act(async () => {
      root.render(createElement(ChatTabBar));
      await Promise.resolve();
    });

    const unreadTab = container.querySelector<HTMLElement>(
      '[data-testid="chat-tab-chat-1"]',
    );
    expect(unreadTab?.dataset.unread).toBe('true');
    expect(unreadTab?.querySelector('.fg-info')).not.toBeNull();
    expect(unreadTab?.querySelector('.fg-accent')).toBeNull();
  });

  it('shows an idle chat with live delegates as working, with a disabled close that says why', async () => {
    useChatStore.setState({
      worktreeChats: {
        'project/worktree': {
          activeTabId: 'chat-1',
          tabs: [
            makeTab({ messages: [{ id: 'message-1' }] as never }),
            makeTab({ id: 'chat-2', title: 'Other' }),
          ],
        },
      },
    });
    useDelegationActivityStore.getState().applyActivity({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat-1',
      live: 1,
      queued: 0,
    });
    await act(async () => {
      root.render(createElement(ChatTabBar));
      await Promise.resolve();
    });

    const tab = container.querySelector<HTMLElement>(
      '[data-testid="chat-tab-chat-1"]',
    );
    expect(tab?.dataset.busy).toBe('true');
    expect(tab?.querySelector('[aria-label="Thinking"]')).not.toBeNull();
    const close = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-tab-chat-1-close"]',
    );
    expect(close?.getAttribute('aria-disabled')).toBe('true');
    expect(close?.dataset.closeDisabled).toBe('true');
    await act(async () => {
      close?.parentElement?.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(
      'Stop its delegates to close this chat',
    );

    await act(async () => {
      close?.click();
      await Promise.resolve();
    });
    expect(
      useChatStore
        .getState()
        .worktreeChats['project/worktree']?.tabs.map((entry) => entry.id),
    ).toEqual(['chat-1', 'chat-2']);

    // The other chat is idle with no delegates: its close stays enabled.
    expect(
      container
        .querySelector('[data-testid="chat-tab-chat-2-close"]')
        ?.getAttribute('aria-disabled'),
    ).toBeNull();

    await act(async () => {
      tab?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      await Promise.resolve();
    });
    const closeItem = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((item) => item.textContent === 'Close');
    expect(closeItem?.disabled).toBe(true);
  });

  it('returns a chat to its idle icon and enabled close when its delegates finish', async () => {
    useChatStore.setState({
      worktreeChats: {
        'project/worktree': {
          activeTabId: 'chat-1',
          tabs: [makeTab()],
        },
      },
    });
    useDelegationActivityStore.getState().applyActivity({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat-1',
      live: 0,
      queued: 1,
    });
    await act(async () => {
      root.render(createElement(ChatTabBar));
      await Promise.resolve();
    });
    expect(
      container
        .querySelector('[data-testid="chat-tab-chat-1"]')
        ?.getAttribute('data-busy'),
    ).toBe('true');

    await act(async () => {
      useDelegationActivityStore.getState().applyActivity({
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat-1',
        live: 0,
        queued: 0,
      });
      await Promise.resolve();
    });

    const tab = container.querySelector<HTMLElement>(
      '[data-testid="chat-tab-chat-1"]',
    );
    expect(tab?.dataset.busy).toBeUndefined();
    expect(tab?.querySelector('[aria-label="Thinking"]')).toBeNull();
    expect(
      container
        .querySelector('[data-testid="chat-tab-chat-1-close"]')
        ?.getAttribute('aria-disabled'),
    ).toBeNull();
  });

  it('disables close without a delegate tooltip while the chat streams', async () => {
    useChatStore.setState({
      worktreeChats: {
        'project/worktree': {
          activeTabId: 'chat-1',
          tabs: [makeTab({ status: 'streaming' })],
        },
      },
    });
    await act(async () => {
      root.render(createElement(ChatTabBar));
      await Promise.resolve();
    });
    const close = container.querySelector<HTMLButtonElement>(
      '[data-testid="chat-tab-chat-1-close"]',
    );
    expect(close?.getAttribute('aria-disabled')).toBe('true');
    // Hover-revealed like an enabled close: the spinner already says why.
    expect(close?.className).toContain('opacity-0');
  });

  it('uses the fixed amber unread color for the archive indicator', async () => {
    useChatStore.setState({
      archivedChats: {
        'project/worktree': [
          {
            chatId: 'archived-1',
            title: 'Archived chat',
            turnCount: 2,
            archivedAt: '2026-06-20T00:00:00.000Z',
            createdAt: '2026-06-19T00:00:00.000Z',
            restorable: true,
            providerType: 'claude',
            unread: true,
          },
        ],
      },
    });

    await act(async () => {
      root.render(createElement(ChatTabBar));
      await Promise.resolve();
    });

    const archiveIndicator = container.querySelector<HTMLElement>(
      '[data-testid="chat-tab-archive"]',
    );
    expect(archiveIndicator?.dataset.unread).toBe('true');
    expect(archiveIndicator?.classList.contains('text-amber-400')).toBe(true);
    expect(archiveIndicator?.classList.contains('fg-warning')).toBe(false);
  });

  it('renders the archive control as a 28px icon button with a corner count badge', async () => {
    const baseSummary = {
      title: 'Archived chat',
      turnCount: 2,
      archivedAt: '2026-06-20T00:00:00.000Z',
      createdAt: '2026-06-19T00:00:00.000Z',
      restorable: true,
      providerType: 'claude' as const,
    };
    useChatStore.setState({
      archivedChats: {
        'project/worktree': [
          { ...baseSummary, chatId: 'archived-1' },
          { ...baseSummary, chatId: 'archived-2' },
        ],
      },
    });

    await act(async () => {
      root.render(createElement(ChatTabBar));
      await Promise.resolve();
    });

    // Icon-only button on the shared 28×28 titlebar frame; the count rides a
    // small corner badge instead of widening the button.
    const control = container.querySelector<HTMLElement>(
      '[data-testid="chat-tab-archive"]',
    );
    expect(control?.classList.contains('w-7')).toBe(true);
    expect(control?.classList.contains('h-7')).toBe(true);
    const badge = container.querySelector<HTMLElement>(
      '[data-testid="chat-tab-archive-count"]',
    );
    expect(badge?.textContent).toBe('2');

    // Triple digits collapse to "99+" so the badge cannot outgrow its corner.
    await act(async () => {
      useChatStore.setState({
        archivedChats: {
          'project/worktree': Array.from({ length: 120 }, (_, index) => ({
            ...baseSummary,
            chatId: `archived-${index}`,
          })),
        },
      });
      await Promise.resolve();
    });
    expect(
      container.querySelector<HTMLElement>(
        '[data-testid="chat-tab-archive-count"]',
      )?.textContent,
    ).toBe('99+');
  });

  it('renders the tab-strip archive button in the neutral ink with a blue unread dot', async () => {
    const baseSummary = {
      title: 'Archived chat',
      turnCount: 2,
      archivedAt: '2026-06-20T00:00:00.000Z',
      createdAt: '2026-06-19T00:00:00.000Z',
      restorable: true,
      providerType: 'claude' as const,
    };
    const setArchives = async (unread: boolean): Promise<void> => {
      await act(async () => {
        useChatStore.setState({
          archivedChats: {
            'project/worktree': [
              { ...baseSummary, chatId: 'archived-1', unread },
              { ...baseSummary, chatId: 'archived-2' },
            ],
          },
        });
        await Promise.resolve();
      });
    };
    await setArchives(true);

    await act(async () => {
      root.render(
        createElement(ArchivedChatsControl, {
          scope: { projectId: 'project', worktreeId: 'worktree' },
          variant: 'tabStrip',
        }),
      );
      await Promise.resolve();
    });

    // The tab strip's own 28px icon button, as the `+` and Activity use.
    const control = container.querySelector<HTMLElement>(
      '[data-testid="chat-tab-archive"]',
    );
    expect(control?.classList.contains('h-7')).toBe(true);
    expect(control?.classList.contains('w-7')).toBe(true);
    expect(control?.classList.contains('fg-secondary')).toBe(true);
    expect(control?.classList.contains('text-amber-400')).toBe(false);
    expect(control?.dataset.unread).toBe('true');
    expect(
      container.querySelector('[data-testid="chat-tab-archive-count"]'),
    ).toBeNull();
    const dot = container.querySelector<HTMLElement>(
      '[data-testid="chat-tab-archive-unread"]',
    );
    expect(dot?.classList.contains('bg-fg-info')).toBe(true);

    // Right-click opens the shared action menu: its row leads with an icon.
    await act(async () => {
      control?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    const markAllRead = document.querySelector(
      '[data-testid="chat-tab-archive-mark-all-read"]',
    );
    expect(markAllRead?.getAttribute('role')).toBe('menuitem');
    expect(markAllRead?.firstElementChild?.querySelector('svg')).toBeInstanceOf(
      Element,
    );
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await Promise.resolve();
    });

    await setArchives(false);
    expect(
      container.querySelector('[data-testid="chat-tab-archive-unread"]'),
    ).toBeNull();
  });

  it.each([
    ['header', false],
    ['tabStrip', true],
  ] as const)(
    'opens the %s hover popover portaled out of clipping panels: %s',
    async (variant, portaled) => {
      useChatStore.setState({
        archivedChats: {
          'project/worktree': [
            {
              chatId: 'archived-1',
              title: 'Archived chat',
              turnCount: 2,
              archivedAt: '2026-06-20T00:00:00.000Z',
              createdAt: '2026-06-19T00:00:00.000Z',
              restorable: true,
              providerType: 'claude',
            },
          ],
        },
      });

      await act(async () => {
        root.render(
          createElement(ArchivedChatsControl, {
            scope: { projectId: 'project', worktreeId: 'worktree' },
            variant,
          }),
        );
        await Promise.resolve();
      });
      const control = container.querySelector<HTMLElement>(
        '[data-testid="chat-tab-archive"]',
      );
      await act(async () => {
        control?.dispatchEvent(
          new MouseEvent('pointerover', { bubbles: true }),
        );
        await Promise.resolve();
      });

      const popover = document.querySelector<HTMLElement>(
        '[data-testid="chat-tab-archive-popover"]',
      );
      expect(popover).not.toBeNull();
      // Header (develop): anchored inside the control. Tab strip (early
      // access): on the body, so a short or collapsed panel leaf (overflow
      // hidden) cannot clip it.
      expect(container.contains(popover)).toBe(!portaled);
      expect(popover?.parentElement === document.body).toBe(portaled);
      expect(popover?.classList.contains('fixed')).toBe(portaled);
    },
  );

  it('reports zero archivedChats after an empty archive list is loaded', async () => {
    useChatStore.setState({
      archivedChats: { 'project/worktree': [] },
    });

    await act(async () => {
      root.render(createElement(ChatTabBar));
      await Promise.resolve();
    });

    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.activeChat
        ?.archivedChats,
    ).toEqual({ count: 0, modalOpen: false, viewerOpen: false });
  });

  it('reports archived transcript viewer state when a viewer is open', async () => {
    useChatStore.setState({
      archivedChats: {
        'project/worktree': [
          {
            chatId: 'archived-1',
            title: 'Archived chat',
            turnCount: 2,
            archivedAt: '2026-06-20T00:00:00.000Z',
            createdAt: '2026-06-19T00:00:00.000Z',
            restorable: true,
            providerType: 'claude',
          },
        ],
      },
    });
    window.api.chat.loadArchives = jest.fn().mockResolvedValue([
      {
        chatId: 'archived-1',
        title: 'Archived chat',
        turnCount: 2,
        archivedAt: '2026-06-20T00:00:00.000Z',
        createdAt: '2026-06-19T00:00:00.000Z',
        restorable: true,
        providerType: 'claude',
      },
    ]);

    await act(async () => {
      root.render(createElement(ChatTabBar));
      await Promise.resolve();
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(WORKTREE_CHAT_OPEN_ARCHIVE_TRANSCRIPT_EVENT, {
          detail: {
            projectId: 'project',
            worktreeId: 'worktree',
            chatId: 'archived-1',
          },
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.activeChat
        ?.archivedChats,
    ).toEqual({
      count: 1,
      modalOpen: false,
      viewerOpen: true,
      viewerChatId: 'archived-1',
      viewerTitle: 'Archived chat',
    });
  });

  it('opens an archived transcript through a matching scoped control', async () => {
    const archivedSummary = {
      chatId: 'archived-cowork-chat',
      title: 'Archived Cowork chat',
      turnCount: 2,
      archivedAt: '2026-06-20T00:00:00.000Z',
      createdAt: '2026-06-19T00:00:00.000Z',
      restorable: true,
      providerType: 'claude' as const,
    };
    useChatStore.setState({
      archivedChats: {
        'cowork-project/work-entry': [archivedSummary],
      },
    });
    window.api.chat.loadArchives = jest
      .fn()
      .mockResolvedValue([archivedSummary]);
    const markArchiveRead = jest.fn().mockResolvedValue([archivedSummary]);
    window.api.chat.markArchiveRead = markArchiveRead;

    await act(async () => {
      root.render(
        createElement(ArchivedChatsControl, {
          scope: {
            projectId: 'cowork-project',
            worktreeId: 'work-entry',
          },
        }),
      );
      await Promise.resolve();
    });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(WORKTREE_CHAT_OPEN_ARCHIVE_TRANSCRIPT_EVENT, {
          detail: {
            projectId: 'cowork-project',
            worktreeId: 'work-entry',
            chatId: 'archived-cowork-chat',
          },
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(markArchiveRead).toHaveBeenCalledWith({
      projectId: 'cowork-project',
      worktreeId: 'work-entry',
      chatId: 'archived-cowork-chat',
    });
  });

  it('does not reload archives for an equivalent scoped-control rerender', async () => {
    const loadArchives = jest.fn().mockResolvedValue([]);
    window.api.chat.loadArchives = loadArchives;

    await act(async () => {
      root.render(
        createElement(ArchivedChatsControl, {
          scope: {
            projectId: 'cowork-project',
            worktreeId: 'work-entry',
          },
        }),
      );
      await Promise.resolve();
    });

    await act(async () => {
      root.render(
        createElement(ArchivedChatsControl, {
          scope: {
            projectId: 'cowork-project',
            worktreeId: 'work-entry',
          },
        }),
      );
      await Promise.resolve();
    });

    expect(loadArchives).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to the selected worktree for a malformed scope', async () => {
    const loadArchives = jest.fn().mockResolvedValue([]);
    window.api.chat.loadArchives = loadArchives;

    await act(async () => {
      root.render(
        createElement(ArchivedChatsControl, {
          scope: {
            projectId: 'cowork-project',
            worktreeId: undefined,
          } as unknown as { projectId: string; worktreeId: string },
        }),
      );
      await Promise.resolve();
    });

    expect(loadArchives).toHaveBeenCalledWith({
      projectId: 'cowork-project',
      worktreeId: undefined,
    });
  });

  it('opens a confirmation before exporting from the tab context menu', async () => {
    useChatStore.setState({
      worktreeChats: {
        'project/worktree': {
          activeTabId: 'chat-1',
          tabs: [makeTab({ messages: [{ id: 'message-1' }] as never })],
        },
      },
    });
    await act(async () => {
      root.render(createElement(ChatTabBar));
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector('[data-testid="chat-tab-chat-1"]')
        ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      await Promise.resolve();
    });

    const exportItem = document.querySelector<HTMLButtonElement>(
      '[data-testid="chat-session-export-menu-item"]',
    );
    expect(exportItem?.textContent).toBe('Export session');
    await act(async () => {
      exportItem?.click();
      await Promise.resolve();
    });
    expect(
      document.querySelector(
        '[data-testid="export-session-confirmation-modal"]',
      ),
    ).not.toBeNull();
    expect(mockShareSessionAction).not.toHaveBeenCalled();

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="export-session-confirm"]',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(mockShareSessionAction).toHaveBeenCalledWith(
      { projectId: 'project', worktreeId: 'worktree', chatId: 'chat-1' },
      { ownerDocument: document },
    );
  });

  it('opens the share picker and routes Team through redacted run sharing', async () => {
    mockShareRun.mockResolvedValueOnce({ externalId: 'run-team' });
    window.pipelines = {
      ...window.pipelines,
      listSharedTeams: jest.fn().mockResolvedValue({
        success: true,
        data: {
          data: [
            {
              id: 'team-1',
              name: 'Platform',
              organization: { id: 'org-1', name: 'Acme' },
            },
          ],
        },
      }),
    };
    useChatStore.setState({
      worktreeChats: {
        'project/worktree': {
          activeTabId: 'chat-1',
          tabs: [
            makeTab({
              messages: [
                {
                  id: 'message-1',
                  role: 'user',
                  blocks: [{ type: 'text', text: 'Share this session' }],
                  timestamp: 1,
                },
              ],
            }),
          ],
        },
      },
    });

    await act(async () => {
      root.render(createElement(ChatTabBar));
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector('[data-testid="chat-tab-session-menu"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      document
        .querySelector('[data-testid="chat-tab-session-menu-share"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="share-run-modal"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="chat-tab-session-menu-popover"]'),
    ).toBeNull();

    // A press inside the modal must not dismiss it as an outside click.
    await act(async () => {
      const team = document.querySelector(
        '[data-testid="share-run-scope-team"]',
      );
      team?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      team?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
    });
    expect(
      document.querySelector('[data-testid="share-run-modal"]'),
    ).not.toBeNull();
    await act(async () => {
      document
        .querySelector('[data-testid="share-run-team-picker-option-team-1"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(
      document.querySelector('[data-testid="share-run-disclaimer"]')
        ?.textContent,
    ).toContain('redacted');
    expect(mockShareSessionAction).not.toHaveBeenCalled();

    await act(async () => {
      document
        .querySelector('[data-testid="share-run-submit"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
    });

    expect(mockShareRun).toHaveBeenCalledWith({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat-1',
      shareScope: 'team',
      teamId: 'team-1',
    });
    expect(mockShareSessionAction).not.toHaveBeenCalled();
    await act(async () => {
      document
        .querySelector('[data-testid="share-run-done"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(
      useChatStore.getState().worktreeChats['project/worktree']?.tabs[0]
        ?.sharedRun?.shareScope,
    ).toBe('team');

    await act(async () => {
      container
        .querySelector('[data-testid="chat-tab-session-menu"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(
      document.querySelector(
        '[data-testid="chat-tab-session-menu-share-unshare"]',
      ),
    ).not.toBeNull();
  });

  describe('rename', () => {
    const renameTab = jest.fn<
      Promise<boolean>,
      [string, string | null, { projectId: string; worktreeId: string }?]
    >();

    function setInputValue(input: HTMLInputElement, value: string): void {
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      );
      descriptor?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function renameInput(): HTMLInputElement | null {
      return document.querySelector<HTMLInputElement>(
        '[data-testid="chat-tab-rename-input"]',
      );
    }

    async function openRenameDialog(): Promise<void> {
      await act(async () => {
        root.render(createElement(ChatTabBar));
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
        container
          .querySelector('[data-testid="chat-tab-chat-1"]')
          ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
        await Promise.resolve();
      });
      const item = document.querySelector<HTMLButtonElement>(
        '[data-testid="chat-tab-context-rename"]',
      );
      expect(item?.textContent).toBe('Rename…');
      await act(async () => {
        item?.click();
        await Promise.resolve();
      });
    }

    async function save(value: string): Promise<void> {
      const input = renameInput();
      if (!input) throw new Error('rename input missing');
      await act(async () => {
        setInputValue(input, value);
        await Promise.resolve();
      });
      await act(async () => {
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="chat-tab-rename-save"]',
          )
          ?.click();
        await Promise.resolve();
      });
    }

    beforeEach(() => {
      renameTab.mockReset().mockResolvedValue(true);
      useChatStore.setState({
        renameTab,
        worktreeChats: {
          'project/worktree': {
            activeTabId: 'chat-1',
            tabs: [
              makeTab({
                pinned: true,
                status: 'streaming',
                customTitle: 'Mine',
                description: 'Generated summary',
              }),
            ],
          },
        },
      });
    });

    it('labels the tab with its custom title and edits it in the dialog', async () => {
      await openRenameDialog();
      expect(
        container
          .querySelector('[data-testid="chat-tab-chat-1"]')
          ?.getAttribute('aria-label'),
      ).toBe('Mine');
      const input = renameInput();
      expect(input?.value).toBe('Mine');
      expect(input?.placeholder).toBe('Generated summary');
      expect(document.activeElement).toBe(input);
      expect(document.body.textContent).toContain(
        'Leave empty to use the generated name.',
      );

      await save('  Release notes  ');
      expect(renameTab).toHaveBeenCalledWith('chat-1', 'Release notes', {
        projectId: 'project',
        worktreeId: 'worktree',
      });
      expect(renameInput()).toBeNull();
    });

    it('clears with null and skips an unchanged name', async () => {
      await openRenameDialog();
      await save(' Mine ');
      expect(renameTab).not.toHaveBeenCalled();
      expect(renameInput()).toBeNull();

      await openRenameDialog();
      await save('   ');
      expect(renameTab).toHaveBeenCalledWith('chat-1', null, {
        projectId: 'project',
        worktreeId: 'worktree',
      });
    });

    it('closes on Cancel without saving', async () => {
      await openRenameDialog();
      await act(async () => {
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="chat-tab-rename-cancel"]',
          )
          ?.click();
        await Promise.resolve();
      });
      expect(renameInput()).toBeNull();
      expect(renameTab).not.toHaveBeenCalled();
    });

    it('keeps the draft during a generated-name update and closes when the target disappears', async () => {
      await openRenameDialog();
      const input = renameInput();
      if (!input) throw new Error('rename input missing');
      await act(async () => {
        setInputValue(input, 'Draft');
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
        useChatStore.setState({
          worktreeChats: {
            'project/worktree': {
              activeTabId: 'chat-1',
              tabs: [
                makeTab({
                  customTitle: 'Mine',
                  description: 'Latest generated',
                }),
              ],
            },
          },
        });
      });
      expect(renameInput()?.value).toBe('Draft');
      expect(renameInput()?.placeholder).toBe('Latest generated');
      await act(async () => {
        await Promise.resolve();
        useChatStore.setState({ worktreeChats: {} });
      });
      expect(renameInput()).toBeNull();
      expect(renameTab).not.toHaveBeenCalled();
    });

    it('allows Rename while a managed delegate keeps the chat busy', async () => {
      useDelegationActivityStore.getState().applyActivity({
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat-1',
        live: 1,
        queued: 0,
      });
      try {
        await openRenameDialog();
        await save('Delegate notes');
        expect(renameTab).toHaveBeenCalledWith('chat-1', 'Delegate notes', {
          projectId: 'project',
          worktreeId: 'worktree',
        });
      } finally {
        await act(async () => {
          useDelegationActivityStore.getState().reset();
          await Promise.resolve();
        });
      }
    });

    it('hides Rename on a read-only host', async () => {
      await act(async () => {
        await Promise.resolve();
        root.render(
          createElement(
            WorkspaceAccessContext.Provider,
            {
              value: {
                mode: 'read-only',
                reason: 'shared-container',
                containerType: 'CODE_WORKTREE',
                runAllowed: false,
              },
            },
            createElement(ChatTabBar),
          ),
        );
      });
      await act(async () => {
        await Promise.resolve();
        container
          .querySelector('[data-testid="chat-tab-chat-1"]')
          ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      });
      expect(
        document.querySelector('[data-testid="chat-tab-context-rename"]'),
      ).toBeNull();
    });

    it('keeps the captured scope after navigating to another worktree', async () => {
      await openRenameDialog();
      await act(async () => {
        useChatStore.setState({
          selectedWorktree: { projectId: 'project', worktreeId: 'other' },
        });
        await Promise.resolve();
      });
      await save('Elsewhere');
      expect(renameTab).toHaveBeenCalledWith('chat-1', 'Elsewhere', {
        projectId: 'project',
        worktreeId: 'worktree',
      });
    });

    it('offers no Rename for file tabs', async () => {
      useChatStore.setState({
        worktreeChats: {
          'project/worktree': {
            activeTabId: 'chat-1',
            tabs: [makeTab({ kind: 'file', filePath: '/repo/a.ts' })],
          },
        },
      });
      await act(async () => {
        root.render(createElement(ChatTabBar));
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
        container
          .querySelector('[data-testid="chat-tab-chat-1"]')
          ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
        await Promise.resolve();
      });
      expect(
        document.querySelector('[data-testid="chat-tab-context-rename"]'),
      ).toBeNull();
    });
  });
});

describe('ChatTabBar file-tab hover path', () => {
  let container: HTMLDivElement;
  let root: Root;

  function labelTitle(el: HTMLElement, label: string): string | null {
    const span = Array.from(el.querySelectorAll('span[title]')).find(
      (node) => node.textContent === label,
    );
    return span?.getAttribute('title') ?? null;
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    window.api = { chat: {} } as typeof window.api;
    useCurrentUiStateStore.setState({ revision: 0, slices: {} });
    useCurrentUiStateStore.getState().recomputeEnvelope();
    useGitHubStore.setState({
      toasts: [],
      notifications: [],
      addToast: originalAddToast,
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    delete (window as typeof window & { api?: typeof window.api }).api;
  });

  function seedFileTab(filePath: string): void {
    useChatStore.setState({
      selectedWorktree: { projectId: 'project', worktreeId: 'worktree' },
      worktreeChats: {
        'project/worktree': {
          activeTabId: 'file-1',
          tabs: [
            makeTab({
              id: 'file-1',
              kind: 'file',
              title: 'index.ts',
              filePath,
              description: filePath,
            }),
          ],
        },
      },
      archivedChats: {},
    });
  }

  it('shows the worktree-relative path on a file tab inside the project', async () => {
    window.api.getWorktreePath = jest
      .fn()
      .mockResolvedValue('/home/user/project/worktree');
    seedFileTab('/home/user/project/worktree/src/index.ts');

    await act(async () => {
      root.render(createElement(ChatTabBar));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(window.api.getWorktreePath).toHaveBeenCalledWith({
      projectId: 'project',
      worktreeId: 'worktree',
    });
    expect(labelTitle(container, 'index.ts')).toBe('src/index.ts');
  });

  it('tracks the shared file session dirty state and tooltip', async () => {
    window.api.getWorktreePath = jest
      .fn()
      .mockResolvedValue('/home/user/project/worktree');
    seedFileTab('/home/user/project/worktree/src/index.ts');

    const request = {
      projectId: 'project',
      worktreeId: 'worktree',
      fileRootLocalId: 'repo-1',
      relativePath: 'src/index.ts',
    };
    const client: CanopyClient = {
      capabilities: {
        localExecution: true,
        terminalPty: true,
        fileSystemAccess: 'read-write',
        voice: false,
        settingsScope: 'full',
        pipelines: 'execute',
        routing: 'in-memory',
        overviewNotifications: true,
      },
      query: jest.fn().mockResolvedValue({
        workspaceLocalId: 'project',
        worktreeLocalId: 'worktree',
        fileRootLocalId: 'repo-1',
        path: 'src/index.ts',
        content: 'disk content',
        size: 12,
        version: 'v1',
        truncated: false,
        modifiedAt: '2026-07-20T00:00:00.000Z',
      }),
      command: jest.fn(),
      subscribe: jest.fn(() => (): void => {}),
    };
    const store = createFileViewerStore(client);

    desktopFileSessionController.dispose();
    const detach = desktopFileSessionController.attachStore(store, {
      onSaveCommitted: (): void => {},
    });
    const key = desktopFileSessionController.registerTab('file-1', request);
    await store.getState().openFile(request);

    await act(async () => {
      root.render(createElement(ChatTabBar));
      await Promise.resolve();
    });

    const tab = container.querySelector('[data-testid="chat-tab-file-1"]');
    expect(tab?.querySelector('[aria-label="Unsaved changes"]')).toBeNull();

    act(() => {
      store.getState().updateContent(key, 'edited content');
    });
    expect(tab?.querySelector('[aria-label="Unsaved changes"]')).not.toBeNull();

    act(() => {
      store.getState().updateContent(key, 'disk content');
    });
    expect(tab?.querySelector('[aria-label="Unsaved changes"]')).toBeNull();

    act(() => {
      desktopFileSessionController.releaseTab('file-1');
      detach();
    });
  });

  it('shows the absolute path for a file tab outside the project', async () => {
    window.api.getWorktreePath = jest
      .fn()
      .mockResolvedValue('/home/user/project/worktree');
    seedFileTab('/etc/hosts/index.ts');

    await act(async () => {
      root.render(createElement(ChatTabBar));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(labelTitle(container, 'index.ts')).toBe('/etc/hosts/index.ts');
  });

  it('clears the previous worktree path while a new scope resolves', async () => {
    let resolveNextPath: ((path: string) => void) | undefined;
    window.api.getWorktreePath = jest
      .fn()
      .mockResolvedValueOnce('/home/user/project')
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveNextPath = resolve;
          }),
      );
    seedFileTab('/home/user/project/src/index.ts');

    await act(async () => {
      root.render(createElement(ChatTabBar));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(labelTitle(container, 'index.ts')).toBe('src/index.ts');

    act(() => {
      useChatStore.setState({
        selectedWorktree: {
          projectId: 'other-project',
          worktreeId: 'other-worktree',
        },
        worktreeChats: {
          'other-project/other-worktree': {
            activeTabId: 'file-1',
            tabs: [
              makeTab({
                id: 'file-1',
                kind: 'file',
                title: 'index.ts',
                filePath: '/home/user/project/other/src/index.ts',
                description: '/home/user/project/other/src/index.ts',
              }),
            ],
          },
        },
      });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(labelTitle(container, 'index.ts')).toBe(
      '/home/user/project/other/src/index.ts',
    );

    await act(async () => {
      resolveNextPath?.('/home/user/project/other');
      await Promise.resolve();
    });
    expect(labelTitle(container, 'index.ts')).toBe('src/index.ts');
  });
});
