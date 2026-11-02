/** @jest-environment jsdom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PanelTabModel } from '@canopy/ui-shared/panels';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import {
  resetDelegationActivityStoreForTests,
  useDelegationActivityStore,
} from '@/stores/delegationActivityStore';
import {
  resetLiveBackgroundTaskStoreForTests,
  useLiveBackgroundTaskStore,
} from '@/stores/liveBackgroundTaskStore';
import {
  isBusyChatPanel,
  useBusyChatCanCloseTab,
  useBusyChatIds,
} from '../busy-chat-panels';

function makeTab(overrides: Partial<ChatTab> = {}): ChatTab {
  return {
    id: 'chat-1',
    title: 'Chat',
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    fastModeExplicit: false,
    model: 'claude-sonnet-4-5-20250514',
    providerType: 'claude',
    ...overrides,
  };
}

function applyLiveTask(chatId: string, taskTypes: readonly string[]): void {
  useLiveBackgroundTaskStore.getState().applyPush({
    projectId: 'project',
    worktreeId: 'worktree',
    chatId,
    sessionActive: true,
    liveTasks: taskTypes.map((taskType, index) => ({
      taskId: `${chatId}-${index}`,
      taskType,
    })),
  });
}

function clearLiveTask(chatId: string): void {
  useLiveBackgroundTaskStore.getState().applyPush({
    projectId: 'project',
    worktreeId: 'worktree',
    chatId,
    sessionActive: false,
    liveTasks: [],
  });
}

const CHAT_PANEL: PanelTabModel = {
  panelId: 'panel-chat-1',
  kind: 'chat',
  title: 'Chat',
  instance: { chatTabId: 'chat-1' },
};

describe('busy chat panels', () => {
  let container: HTMLDivElement;
  let root: Root;
  let busyChatIds: ReadonlySet<string>;
  let canCloseTab: ((tab: PanelTabModel) => boolean) | undefined;
  let renders: number;

  function Harness(): null {
    busyChatIds = useBusyChatIds('project', 'worktree');
    canCloseTab = useBusyChatCanCloseTab('project', 'worktree');
    renders += 1;
    return null;
  }

  beforeEach(() => {
    useChatStore.setState({
      selectedWorktree: { projectId: 'project', worktreeId: 'worktree' },
      worktreeChats: {
        'project/worktree': {
          activeTabId: 'chat-1',
          tabs: [makeTab()],
        },
      },
    });
    resetDelegationActivityStoreForTests();
    resetLiveBackgroundTaskStoreForTests();
    busyChatIds = new Set<string>();
    canCloseTab = undefined;
    renders = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetDelegationActivityStoreForTests();
    resetLiveBackgroundTaskStoreForTests();
  });

  function renderHarness(): void {
    act(() => root.render(createElement(Harness)));
  }

  it('does not mark an idle chat as busy', () => {
    renderHarness();

    expect(busyChatIds.has('chat-1')).toBe(false);
    expect(isBusyChatPanel(CHAT_PANEL, busyChatIds)).toBe(false);
    expect(canCloseTab).toBeUndefined();
  });

  it.each(['local_agent', 'local_workflow'])(
    'marks provider %s work busy',
    (taskType) => {
      applyLiveTask('chat-1', [taskType]);
      renderHarness();

      expect(busyChatIds.has('chat-1')).toBe(true);
      expect(isBusyChatPanel(CHAT_PANEL, busyChatIds)).toBe(true);
      expect(canCloseTab?.(CHAT_PANEL)).toBe(false);
    },
  );

  it('does not mark shell-only work busy', () => {
    applyLiveTask('chat-1', ['local_bash']);
    renderHarness();

    expect(busyChatIds.has('chat-1')).toBe(false);
    expect(isBusyChatPanel(CHAT_PANEL, busyChatIds)).toBe(false);
    expect(canCloseTab).toBeUndefined();
  });

  it('re-renders when provider work starts and ends without chat state changes', () => {
    renderHarness();
    const initialRenders = renders;

    act(() => applyLiveTask('chat-1', ['local_agent']));
    expect(renders).toBeGreaterThan(initialRenders);
    expect(busyChatIds.has('chat-1')).toBe(true);

    const activeRenders = renders;
    act(() => clearLiveTask('chat-1'));
    expect(renders).toBeGreaterThan(activeRenders);
    expect(busyChatIds.has('chat-1')).toBe(false);
  });

  it('keeps chats with live managed delegates busy', () => {
    useDelegationActivityStore.getState().applyActivity({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat-1',
      live: 0,
      queued: 1,
    });
    renderHarness();

    expect(busyChatIds.has('chat-1')).toBe(true);
    expect(isBusyChatPanel(CHAT_PANEL, busyChatIds)).toBe(true);
    expect(canCloseTab?.(CHAT_PANEL)).toBe(false);
  });
});
