import { createStore, type StoreApi } from 'zustand/vanilla';
import type { HookChatTabStartedEvent } from '@canopy/desktop-shared/types';
import type { ChatState } from '../state';
import type * as HydrationModule from '../hydration';
import { createEventsSlice } from '../slices/events';
import {
  queuePendingHydrationEvent,
  ensureHydratedAndReplayPendingEvents,
  hydratedKeys,
} from '../hydration';

let mockRendererStore: StoreApi<ChatState>;

jest.mock('@canopy/protocol/delegation', () => ({}));
jest.mock('@canopy/desktop-shared/plan-review', () => ({}));
jest.mock('../../delegationTranscriptStore', () => ({}));
jest.mock('../optimistic-presentation', () => ({}));
jest.mock('../surface', () => ({
  canReceiveWorktreeChatActivity: (): boolean => true,
}));
jest.mock('../hydration', () => ({
  ...jest.requireActual<typeof HydrationModule>('../hydration'),
  recordWorktreeChatTouch: jest.fn(),
}));
jest.mock('../turn-diffs', () => ({}));
jest.mock('../canonical-changes', () => ({}));
jest.mock('../runtime-divergence', () => ({
  installRuntimeDivergenceDetector: jest.fn(),
  tagStatusWrite: jest.fn(),
}));
jest.mock('../turn-confirmation', () => ({}));
jest.mock('../slices/messaging', () => ({}));
jest.mock('@/lib/claude-tui-chats', () => ({}));
jest.mock('../activity-dispatch', () => ({}));
jest.mock('../persistence', () => ({}));
jest.mock('../slices/revisioned', () => ({
  isScopeRevisionedLive: (): boolean => false,
}));
jest.mock('../../delegationActivityStore', () => ({}));
jest.mock('../held-completion-notices', () => ({}));
jest.mock('../../liveBackgroundTaskStore', () => ({}));
jest.mock('../../projectsStore', () => ({}));
jest.mock('../../appAdvisorWatchersStore', () => ({}));
jest.mock('../../pipelineRunsStore', () => ({}));
jest.mock('@/components/chat/agent-artifact-projection', () => ({}));
jest.mock('../utils', () => ({}));
jest.mock('../provisional-first-send', () => ({}));
jest.mock('../transcript-dedupe', () => ({}));
jest.mock('../deferred-tool-reload', () => ({}));
jest.mock('../turn-events', () => ({}));
jest.mock('../unread-previews', () => ({}));
jest.mock('../messages', () => ({}));
jest.mock('../tab-utils', () => ({}));
jest.mock('../tab-lifecycle', () => ({}));
jest.mock('../notifications', () => ({}));
jest.mock('../../activityStore', () => ({}));
jest.mock('../plan-utils', () => ({}));
jest.mock('../event-transforms', () => ({}));
jest.mock('../plan-explore-registry', () => ({}));
jest.mock('../attachments', () => ({}));
jest.mock('../code-review-registry', () => ({}));
jest.mock('../../githubStore', () => ({}));
jest.mock('../constants', () => ({}));
jest.mock('../persisted-tabs', () => ({
  fromPersistedTab: (tab: unknown): unknown => tab,
  applyQueuedHookPlaceholderTabSettings: (tab: unknown): unknown => tab,
}));
jest.mock('../discovery', () => ({}));
jest.mock('../session-restore', () => ({}));
jest.mock('../../ollamaConnectionBannerStore', () => ({}));
jest.mock('../../navigationStore', () => ({}));
jest.mock('../store-ref', () => ({
  chatStoreApi: (): StoreApi<ChatState> => mockRendererStore,
}));
jest.mock('../memory', () => ({}));
jest.mock('@/lib/cowork', () => ({}));

function fixture(): StoreApi<ChatState> {
  mockRendererStore = createStore<ChatState>()((set, get, api) => ({
    ...({
      worktreeChats: { 'p/w': { tabs: [], activeTabId: '' } },
      runtimeByChatId: {},
      chatStateSync: {},
    } as unknown as ChatState),
    ...createEventsSlice(set, get, api),
  }));
  return mockRendererStore;
}
function placeholder(chatId = 'chat-a'): HookChatTabStartedEvent {
  return {
    projectId: 'p',
    worktreeId: 'w',
    chatId,
    activateTab: false,
    tab: { id: chatId, title: 'Review', createdAt: '2026-11-05', messages: [] },
    queuedMessage: {
      queueId: `q-${chatId}`,
      text: 'Review',
      reason: 'Waiting',
    },
  };
}
it('keeps renderer-local follow-ups when recovery replays a placeholder by chat id', () => {
  const store = fixture();
  const event = placeholder();
  store.getState().handleHookTabStarted(event);
  const wc = store.getState().worktreeChats['p/w'];
  const tab = wc.tabs[0];
  const followUp = { text: 'Keep my follow-up', reason: 'Waiting' };
  store.setState({
    worktreeChats: {
      'p/w': {
        ...wc,
        tabs: [{ ...tab, queuedMessages: [...tab.queuedMessages, followUp] }],
      },
    },
  });
  store.getState().handleHookTabStarted(placeholder('chat-b'));
  store.getState().handleHookTabStarted(event);
  const tabs = store.getState().worktreeChats['p/w'].tabs;
  expect(tabs).toHaveLength(2);
  expect(tabs[0].queuedMessages.map((message) => message.text)).toEqual([
    'Review',
    'Keep my follow-up',
  ]);
});

it('removes only the matching queued placeholder on committed cancellation', () => {
  const store = fixture();
  store.getState().handleHookTabStarted(placeholder());
  store.getState().handleHookTabStarted(placeholder('chat-b'));
  const event = {
    projectId: 'p',
    worktreeId: 'w',
    chatId: 'chat-a',
    queueId: 'q-chat-a',
  };
  store.getState().handleHookQueueRemoved({ ...event, queueId: 'other' });
  expect(store.getState().worktreeChats['p/w'].tabs).toHaveLength(2);
  store.getState().handleHookQueueRemoved(event);
  store.getState().handleHookQueueRemoved(event);
  expect(
    store.getState().worktreeChats['p/w'].tabs.map((tab) => tab.id),
  ).toEqual(['chat-b']);
  const wc = store.getState().worktreeChats['p/w'];
  store.setState({
    worktreeChats: {
      'p/w': {
        ...wc,
        tabs: [
          {
            ...wc.tabs[0],
            queuedHookPlaceholder: false,
          },
        ],
      },
    },
  });
  store.getState().handleHookQueueRemoved({
    ...event,
    chatId: 'chat-b',
    queueId: 'q-chat-b',
  });
  expect(store.getState().worktreeChats['p/w'].tabs).toHaveLength(1);
  queuePendingHydrationEvent('p/w', {
    kind: 'hook-started',
    event: placeholder('chat-c'),
  });
  store.getState().handleHookQueueRemoved({
    ...event,
    chatId: 'chat-c',
    queueId: 'q-chat-c',
  });
  hydratedKeys.add('p/w');
  ensureHydratedAndReplayPendingEvents('p', 'w');
  expect(
    store.getState().worktreeChats['p/w'].tabs.map((tab) => tab.id),
  ).toEqual(['chat-b']);
  hydratedKeys.clear();
});
