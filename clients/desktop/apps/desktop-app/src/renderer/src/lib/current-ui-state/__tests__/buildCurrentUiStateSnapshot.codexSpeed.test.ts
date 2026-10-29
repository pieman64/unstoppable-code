/**
 * @jest-environment jsdom
 */
import type { ChatTab } from '@/stores/chat/types';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { buildCurrentUiStateSnapshot } from '../buildCurrentUiStateSnapshot';

const TARGET = { projectId: 'project-1', worktreeId: 'worktree-1' };

function codexTab(overrides: Partial<ChatTab> = {}): ChatTab {
  return {
    id: 'chat-1',
    title: 'Codex chat',
    messages: [],
    status: 'idle',
    error: null,
    createdAt: new Date(0).toISOString(),
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    providerType: 'codex',
    model: 'gpt-6-astra',
    modelConfig: { thinkingLevel: 'high', speed: 'ultrafast', fastMode: false },
    ...overrides,
  };
}

function selectTab(tab: ChatTab): void {
  useChatStore.setState({
    selectedWorktree: TARGET,
    worktreeChats: {
      [`${TARGET.projectId}/${TARGET.worktreeId}`]: {
        activeTabId: tab.id,
        tabs: [tab],
      },
    },
  });
}

beforeEach(() => {
  useChatStore.setState({ selectedWorktree: null, worktreeChats: {} });
  useNavigationStore.setState({
    activePage: 'main',
    settingsOpen: false,
    commandPaletteOpen: false,
    fileSearchPaletteOpen: false,
    prPickerOpen: false,
    canopyPortalOpen: false,
    appAdvisorOpen: false,
  });
});

describe('buildCurrentUiStateSnapshot active chat Codex speed', () => {
  it('reports the exact requested speed from the chat reporter', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'chat.activeTab': {
        chatId: 'chat-1',
        modelConfig: { speed: 'ultrafast', fastMode: false },
      },
    });

    expect(snapshot.activeChat?.modelConfig).toEqual({
      speed: 'ultrafast',
      fastMode: false,
    });
  });

  it('derives the legacy boolean from the speed instead of trusting it', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'chat.activeTab': {
        chatId: 'chat-1',
        modelConfig: { speed: 'ultrafast', fastMode: true },
      },
    });

    expect(snapshot.activeChat?.modelConfig).toEqual({
      speed: 'ultrafast',
      fastMode: false,
    });
  });

  it('reads a legacy boolean-only record as its exact speed', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'chat.activeTab': { chatId: 'chat-1', modelConfig: { fastMode: true } },
    });

    expect(snapshot.activeChat?.modelConfig).toEqual({
      speed: 'fast',
      fastMode: true,
    });
  });

  it('fills the speed from the selected chat when the reporter omits it', () => {
    selectTab(codexTab());

    const snapshot = buildCurrentUiStateSnapshot({
      'chat.activeTab': { chatId: 'chat-1', title: 'Codex chat' },
    });

    expect(snapshot.activeChat?.modelConfig).toEqual({
      speed: 'ultrafast',
      fastMode: false,
    });
  });

  it('reports the exact speed from the store when no reporter is mounted', () => {
    selectTab(codexTab());

    const snapshot = buildCurrentUiStateSnapshot({});

    expect(snapshot.activeChat?.modelConfig).toEqual({
      speed: 'ultrafast',
      fastMode: false,
    });
  });

  it('adds no speed for a reported chat the selected worktree does not hold', () => {
    selectTab(codexTab());

    const snapshot = buildCurrentUiStateSnapshot({
      'chat.activeTab': { chatId: 'other-chat' },
    });

    expect(snapshot.activeChat).toEqual({ chatId: 'other-chat' });
  });
});
