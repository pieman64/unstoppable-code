import type { Descendant } from 'slate';
import type { CanopyClient } from '@canopy/app-core';
import { useChatStore } from '@/stores/chatStore';
import type { ChatState } from '@/stores/chat/state';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import {
  sidebarActivityStandaloneChatKey,
  sidebarActivityWorktreeChatKey,
} from '@canopy/app-state';
import {
  collectDesktopDraftKeys,
  desktopActiveChatKey,
  desktopChatScopeActivityKey,
  desktopUnreadSignature,
  loadDesktopSidebarActivityInventory,
  type DesktopActivityDraftState,
} from '../desktopSidebarActivityMode';

const COWORK = new Set(['cw']);
const wt = (chatId: string, worktree = 'wt'): string =>
  sidebarActivityWorktreeChatKey('ws', worktree, chatId);
const cw = (chatId: string): string =>
  sidebarActivityStandaloneChatKey('cw', chatId);

it('hydrates cold Cowork metadata before classifying canonical unread at inventory completion', async () => {
  const original = useStandaloneChatStore.getState();
  useStandaloneChatStore.setState({
    activeChatProjectId: 'cw',
    workEntries: [],
  });
  const refresh = jest
    .spyOn(useStandaloneChatStore.getState(), 'refreshWorkEntries')
    .mockImplementation(() => {
      useStandaloneChatStore.setState({
        workEntries: [
          {
            id: 'entry',
            title: 'Entry',
            createdAt: '2026-10-01T00:00:00Z',
            chatCount: 1,
            unreadChats: [{ chatId: 'cold' }],
          },
        ],
      });
      return Promise.resolve();
    });
  const query = jest.fn().mockResolvedValue({
    workspaces: [{ localId: 'cw', name: 'Chats', type: 'cowork' }],
    worktrees: [],
    chatSummaries: [],
    standaloneChats: [
      {
        localId: 'cold',
        projectLocalId: 'cw',
        title: 'Chat',
        hasUnread: true,
      },
    ],
  });
  const client: CanopyClient = {
    capabilities: {
      localExecution: true,
      terminalPty: true,
      fileSystemAccess: 'read',
      voice: false,
      settingsScope: 'full',
      pipelines: 'execute',
      routing: 'in-memory',
      overviewNotifications: true,
    },
    query,
    command: jest.fn(),
    subscribe: jest.fn(),
  };
  try {
    const loaded = await loadDesktopSidebarActivityInventory(client);
    expect(refresh).toHaveBeenCalledWith('cw');
    expect(loaded.unreadKeys?.has(cw('cold'))).toBe(true);
    expect(query).toHaveBeenCalledWith('session.snapshot', {
      includeChatSummaries: true,
    });
  } finally {
    refresh.mockRestore();
    useStandaloneChatStore.setState(original, true);
  }
});

it('keeps canonical worktree unread for scopes with no live tabs or badges yet', async () => {
  // Activity can open before startup hydration reaches a worktree that has no
  // persisted badge summary. The live store knows nothing about that scope,
  // so the snapshot's own unread flag must decide its membership.
  const original = useChatStore.getState();
  useChatStore.setState({
    worktreeChats: {
      'ws/live': {
        tabs: [{ id: 'live-read', unread: false }],
        activeTabId: 'live-read',
      },
    } as unknown as ChatState['worktreeChats'],
    persistedWorktreeBadges: {
      'ws/badged': { unreadChats: [] },
    } as unknown as ChatState['persistedWorktreeBadges'],
  });
  const summary = (
    worktree: string,
    chatId: string,
  ): Record<string, unknown> => ({
    scope: 'worktree',
    workspaceLocalId: 'ws',
    worktreeLocalId: worktree,
    chatId,
    localId: chatId,
    title: chatId,
    hasUnread: true,
  });
  const client: CanopyClient = {
    capabilities: {
      localExecution: true,
      terminalPty: true,
      fileSystemAccess: 'read',
      voice: false,
      settingsScope: 'full',
      pipelines: 'execute',
      routing: 'in-memory',
      overviewNotifications: true,
    },
    query: jest.fn().mockResolvedValue({
      workspaces: [{ localId: 'ws', name: 'Code', type: 'single-repo' }],
      worktrees: [],
      chatSummaries: [
        summary('cold', 'cold-unread'),
        summary('live', 'live-read'),
        summary('badged', 'badged-read'),
      ],
      standaloneChats: [],
    }),
    command: jest.fn(),
    subscribe: jest.fn(),
  };
  try {
    const loaded = await loadDesktopSidebarActivityInventory(client);
    expect([...(loaded.unreadKeys ?? [])]).toEqual([wt('cold-unread', 'cold')]);
  } finally {
    useChatStore.setState(original, true);
  }
});

function text(value: string): Descendant[] {
  return [{ type: 'paragraph', children: [{ text: value }] }] as Descendant[];
}

function draftState(
  partial: Partial<DesktopActivityDraftState>,
): DesktopActivityDraftState {
  return {
    worktreeChats: {},
    tabDrafts: {},
    composerTextPresent: {},
    ...partial,
  };
}

describe('desktopChatScopeActivityKey', () => {
  it('maps Code worktree scopes and Cowork work-entry scopes', () => {
    expect(desktopChatScopeActivityKey('ws/wt', 'c1', COWORK)).toBe(wt('c1'));
    expect(desktopChatScopeActivityKey('cw/entry-1', 'c2', COWORK)).toBe(
      cw('c2'),
    );
    expect(desktopChatScopeActivityKey('nokey', 'c', COWORK)).toBeNull();
    expect(desktopChatScopeActivityKey('ws/wt', '', COWORK)).toBeNull();
  });
});

describe('collectDesktopDraftKeys', () => {
  const inventory = new Map<string, readonly string[]>([
    ['typed', [wt('typed')]],
    ['blank', [wt('blank')]],
    ['attach', [wt('attach')]],
    ['live', [cw('live')]],
    ['saved-elsewhere', [wt('saved-elsewhere', 'other')]],
    ['ambiguous', [wt('ambiguous'), wt('ambiguous', 'other')]],
  ]);

  it('counts typed text, live composer text, and attachment-only drafts', () => {
    const keys = collectDesktopDraftKeys(
      draftState({
        worktreeChats: {
          'ws/wt': {
            activeTabId: 'typed',
            tabs: [
              { id: 'typed', kind: 'chat' },
              { id: 'blank', kind: 'chat' },
              { id: 'attach', kind: 'chat', pendingAttachments: [{}] },
            ],
          },
          'cw/entry': { activeTabId: 'live', tabs: [{ id: 'live' }] },
        },
        tabDrafts: { typed: text('hello'), blank: text('   ') },
        composerTextPresent: { live: true },
      }),
      COWORK,
      inventory,
    );
    expect([...keys].sort()).toEqual(
      [wt('typed'), wt('attach'), cw('live')].sort(),
    );
  });

  it('matches unhydrated saved drafts only by an unambiguous chat id', () => {
    const keys = collectDesktopDraftKeys(
      draftState({
        tabDrafts: {
          'saved-elsewhere': text('x'),
          ambiguous: text('y'),
          'not-in-inventory': text('z'),
        },
      }),
      COWORK,
      inventory,
    );
    expect([...keys]).toEqual([wt('saved-elsewhere', 'other')]);
  });

  it('drops a hydrated draft whose scope is not the inventory row', () => {
    const keys = collectDesktopDraftKeys(
      draftState({
        worktreeChats: {
          'ws/elsewhere': { activeTabId: 'typed', tabs: [{ id: 'typed' }] },
        },
        tabDrafts: { typed: text('hello') },
      }),
      COWORK,
      inventory,
    );
    expect(keys.size).toBe(0);
  });

  it('ignores non-chat tabs', () => {
    const keys = collectDesktopDraftKeys(
      draftState({
        worktreeChats: {
          'ws/wt': {
            activeTabId: 'typed',
            tabs: [{ id: 'typed', kind: 'file' }],
          },
        },
        composerTextPresent: { typed: true },
      }),
      COWORK,
      inventory,
    );
    expect(keys.size).toBe(0);
  });

  it('does not assign an unscoped saved draft to two colliding chat ids', () => {
    const keys = collectDesktopDraftKeys(
      draftState({
        worktreeChats: {
          'ws/wt': { activeTabId: 'ambiguous', tabs: [{ id: 'ambiguous' }] },
          'ws/other': { activeTabId: 'ambiguous', tabs: [{ id: 'ambiguous' }] },
        },
        tabDrafts: { ambiguous: text('belongs to only one chat') },
      }),
      COWORK,
      inventory,
    );
    expect(keys.size).toBe(0);
  });
});

describe('desktopUnreadSignature', () => {
  it('lets a hydrated scope override its persisted badge, even when empty', () => {
    const signature = desktopUnreadSignature(
      {
        worktreeChats: {
          'ws/wt': { activeTabId: 'a', tabs: [{ id: 'a' }] },
          'ws/two': { activeTabId: 'b', tabs: [{ id: 'b', unread: true }] },
        },
        persistedWorktreeBadges: {
          'ws/wt': { unreadChats: [{ chatId: 'a' }] },
          'ws/cold': { unreadChats: [{ chatId: 'c' }] },
        },
      },
      [
        {
          projectId: 'cw',
          entries: [
            { id: 'entry-cold', unreadChats: [{ chatId: 'x' }] },
            { id: 'entry-hot', unreadChats: [{ chatId: 'y' }] },
          ],
        },
      ],
      COWORK,
    );
    // `cw/entry-hot` is not hydrated here, so its metadata still counts.
    expect(signature.split('\n')).toEqual(
      [wt('b', 'two'), wt('c', 'cold'), cw('x'), cw('y')].sort(),
    );
  });

  it('is identical for identical membership', () => {
    const state = {
      worktreeChats: {},
      persistedWorktreeBadges: { 'ws/wt': { unreadChats: [{ chatId: 'a' }] } },
    };
    expect(desktopUnreadSignature(state, [], COWORK)).toBe(
      desktopUnreadSignature({ ...state }, [], COWORK),
    );
  });

  it('skips Cowork metadata for a hydrated work entry', () => {
    const signature = desktopUnreadSignature(
      {
        worktreeChats: {
          'cw/entry': { activeTabId: 'y', tabs: [{ id: 'y' }] },
        },
        persistedWorktreeBadges: {},
      },
      [
        {
          projectId: 'cw',
          entries: [{ id: 'entry', unreadChats: [{ chatId: 'y' }] }],
        },
      ],
      COWORK,
    );
    expect(signature).toBe('');
  });
});

describe('desktopActiveChatKey', () => {
  const state = {
    selectedWorktree: { projectId: 'ws', worktreeId: 'wt' },
    worktreeChats: {
      'ws/wt': { activeTabId: 'c1', tabs: [{ id: 'c1' }, { id: 'c2' }] },
      'cw/entry': { activeTabId: 'k', tabs: [{ id: 'k' }] },
    },
  };

  it('names only the active chat of the shown worktree', () => {
    expect(desktopActiveChatKey(state, 'main', COWORK)).toBe(wt('c1'));
    expect(desktopActiveChatKey(state, 'overview', COWORK)).toBeNull();
  });

  it('names the active Cowork chat on the chat page', () => {
    const cowork = {
      ...state,
      selectedWorktree: { projectId: 'cw', worktreeId: 'entry' },
    };
    expect(desktopActiveChatKey(cowork, 'chat', COWORK)).toBe(cw('k'));
    expect(desktopActiveChatKey(cowork, 'main', COWORK)).toBeNull();
  });

  it('returns null rather than guessing', () => {
    expect(
      desktopActiveChatKey(
        { ...state, selectedWorktree: null },
        'main',
        COWORK,
      ),
    ).toBeNull();
    expect(
      desktopActiveChatKey(
        {
          ...state,
          worktreeChats: { 'ws/wt': { activeTabId: 'gone', tabs: [] } },
        },
        'main',
        COWORK,
      ),
    ).toBeNull();
  });
});
