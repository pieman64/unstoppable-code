/** @jest-environment jsdom */
// A turn main holds for its worktree's Git setup shows the shared setup
// status in its starting slot; once the setup is done it reads Starting….

import { renderToStaticMarkup } from 'react-dom/server';
import type {
  ChatRuntimeState,
  SidebarItem,
} from '@canopy/desktop-shared/types';
import { CanopyClientProvider } from '@canopy/app-state';
import { CompactQueueProvider } from '@canopy/ui-shared/components';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import { ChatMessageList } from '../ChatMessageList';
import type { ChatMessage, ChatTab } from '@/stores/chatStore';
import { toActiveTranscriptView } from '../types';
import { createEmptyTab } from '@/stores/chat/tab-utils';
import type * as ChatRenderStoresTestUtils from '@/test-utils/chatRenderStores';

const mockChatState: {
  selectedWorktree: { projectId: string; worktreeId: string };
  worktreeChats: Record<
    string,
    { activeTabId: string; tabs: Array<Partial<ChatTab>> }
  >;
  runtimeByChatId: Record<string, ChatRuntimeState>;
  pendingQuestions: Record<string, never>;
  pendingApprovals: Record<string, never>;
} = {
  selectedWorktree: { projectId: 'project', worktreeId: 'worktree' },
  worktreeChats: {
    'project/worktree': {
      activeTabId: 'chat-1',
      tabs: [{ id: 'chat-1', messages: [] }],
    },
  },
  runtimeByChatId: {},
  pendingQuestions: {},
  pendingApprovals: {},
};

jest.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: typeof mockChatState) => unknown): unknown =>
    selector(mockChatState),
  ...jest
    .requireActual<
      typeof ChatRenderStoresTestUtils
    >('@/test-utils/chatRenderStores')
    .mockChatRenderHooks(() => mockChatState),
}));

jest.mock('@/hooks/useInvocableInventory', () => ({
  useInvocableInventory: (): { entries: [] } => ({ entries: [] }),
}));

jest.mock('@/stores/fileListStore', () => ({
  getWorktreeCacheKey: (projectId: string, worktreeId: string): string =>
    `${projectId}/${worktreeId}`,
  useFileListStore: (
    selector: (state: {
      indexCache: Record<string, never>;
      indexErrors: Record<string, never>;
      indexLoading: Set<string>;
      fetchFileIndex: jest.Mock;
    }) => unknown,
  ): unknown =>
    selector({
      indexCache: {},
      indexErrors: {},
      indexLoading: new Set(),
      fetchFileIndex: jest.fn(),
    }),
}));

const mockProjectsState: { projects: SidebarItem[] } = { projects: [] };

// Keep the render fixture independent of the real store's circular imports.
jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: Object.assign(
    (selector: (state: typeof mockProjectsState) => unknown): unknown =>
      selector(mockProjectsState),
    { getState: () => mockProjectsState },
  ),
}));

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const CREATED_AT = new Date(NOW - 8_000).toISOString();

const heldUser: ChatMessage = {
  id: 'held-user',
  role: 'user',
  timestamp: NOW - 2_000,
  blocks: [{ type: 'text', text: 'Fix the deck' }],
};

const startingRuntime = {
  status: 'starting' as const,
  activeTurn: { userMessageId: 'held-user', startedAt: NOW - 2_000 },
};

type WorktreeOverrides = {
  createdAt?: string;
  splitRecoveryRequired?: true;
};

function project(
  setupPhase: 'git-pending' | 'git-ready',
  overrides: WorktreeOverrides = {},
): SidebarItem {
  return {
    type: 'single-repo',
    id: 'project',
    name: 'canopy',
    repoPath: '/repos/canopy',
    color: '#000000',
    collapsed: false,
    order: 0,
    worktrees: [
      {
        id: 'worktree',
        branchName: 'feature/deck',
        createdAt: CREATED_AT,
        setupPhase,
        ...overrides,
      },
    ],
  };
}

function render(
  setupPhase: 'git-pending' | 'git-ready',
  overrides?: WorktreeOverrides,
): HTMLElement {
  mockProjectsState.projects = [project(setupPhase, overrides)];
  const tab: ChatTab = {
    ...createEmptyTab(),
    id: 'chat-1',
    status: 'streaming',
    messages: [heldUser],
  };
  mockChatState.worktreeChats['project/worktree'] = {
    activeTabId: 'chat-1',
    tabs: [tab],
  };
  const view = toActiveTranscriptView(tab, startingRuntime);
  const html = renderToStaticMarkup(
    <CanopyClientProvider client={ipcCanopyClient}>
      <CompactQueueProvider value={false}>
        <ChatMessageList
          messages={view.messages}
          startingTurnUserMessageId={view.startingTurnUserMessageId}
          queuedMessages={[]}
          chatId="chat-1"
          onClearQueuedMessage={jest.fn()}
        />
      </CompactQueueProvider>
    </CanopyClientProvider>,
  );
  return new DOMParser().parseFromString(html, 'text/html').body;
}

describe('ChatMessageList setup status for a held first turn', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows the sent prompt once and the setup status while Git setup runs', () => {
    const doc = render('git-pending');
    const status = doc.querySelector('[data-testid="turn-starting-status"]');
    expect(status?.getAttribute('data-turn-header')).toBe('setup');
    expect(status?.querySelector('[role="status"]')?.textContent).toBe(
      "Setting up this chat's copy of canopy",
    );
    // Clocked from the worktree's creation, not the message.
    expect(status?.querySelector('[data-turn-setup-clock]')?.textContent).toBe(
      ' · 0:08',
    );
    expect(doc.textContent?.split('Fix the deck')).toHaveLength(2);
  });

  it('clocks a split destination from the held message, not the source worktree it copies its creation time from', () => {
    const status = render('git-pending', {
      createdAt: new Date(NOW - 3 * 24 * 60 * 60 * 1_000).toISOString(),
      splitRecoveryRequired: true,
    }).querySelector('[data-testid="turn-starting-status"]');
    expect(status?.getAttribute('data-turn-header')).toBe('setup');
    expect(status?.querySelector('[data-turn-setup-clock]')?.textContent).toBe(
      ' · 0:02',
    );
  });

  it('reads Starting… once the setup is done', () => {
    const status = render('git-ready').querySelector(
      '[data-testid="turn-starting-status"]',
    );
    expect(status?.getAttribute('data-turn-header')).toBe('starting');
    expect(status?.textContent).toContain('Starting…');
    expect(status?.textContent).not.toContain('Setting up');
  });
});
