/** @jest-environment jsdom */
import type { AgentProviderType } from '@canopy/desktop-shared/types';
import type { ChatTab } from '../types';
import type * as PlanUtils from '../plan-utils';
import type * as Hydration from '../hydration';
import type { maybeFireOsNotification } from '@/lib/osNotifications';
import { CLAUDE_UNREAD_CHAT_NOTIFICATION_DELAY_MS } from '../constants';
import { useChatStore } from '../../chatStore';
import { useGitHubStore } from '../../githubStore';
import { useProjectsStore } from '../../projectsStore';
import {
  clearRecordedUnreadChatAgentResponsePreview,
  getChatTabAgentResponsePreview,
  getRecordedUnreadChatAgentResponsePreview,
  recordUnreadChatAgentResponsePreview,
} from '../unread-previews';

let showInApp = true;
const osNotification = jest.fn<
  ReturnType<typeof maybeFireOsNotification>,
  Parameters<typeof maybeFireOsNotification>
>();
jest.mock('@/lib/osNotifications', () => ({
  maybeFireOsNotification: (
    ...args: Parameters<typeof maybeFireOsNotification>
  ): void => {
    osNotification(...args);
  },
  shouldShowInAppNotification: (): boolean => showInApp,
}));
jest.mock('../activity-dispatch', () => ({
  dispatchActivityEvent: jest.fn(),
  shouldReconcileBackgroundProcessesAfterTurn: (): boolean => false,
}));
jest.mock('../plan-utils', () => ({
  ...jest.requireActual<typeof PlanUtils>('../plan-utils'),
  triggerPlanDetectionScan: jest.fn(),
}));
jest.mock('../hydration', () => ({
  ...jest.requireActual<typeof Hydration>('../hydration'),
  recordWorktreeChatTouch: jest.fn(),
  scheduleIdleChatUnload: jest.fn(),
}));

const toast = jest.fn();
const KEY = 'preview-project/preview-worktree';
const NEW_ANSWER = 'The new answer is ready.';
const OLD_ANSWER = 'The old cached answer.';

function tab(providerType: AgentProviderType, cached = true): ChatTab {
  return {
    id: 'preview-chat',
    title: 'Background chat',
    createdAt: '2026-10-15T00:00:00.000Z',
    messages: cached
      ? [
          {
            id: 'old',
            role: 'assistant',
            timestamp: 1,
            blocks: [{ type: 'text', text: OLD_ANSWER }],
          },
        ]
      : [],
    status: 'idle',
    error: null,
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    providerType,
    transcriptStale: true,
  };
}

function send(data: Record<string, unknown>): void {
  useChatStore.getState().handleChatEvent({
    projectId: 'preview-project',
    worktreeId: 'preview-worktree',
    chatId: 'preview-chat',
    data,
  });
}

function answer(provider: AgentProviderType): Record<string, unknown> {
  return provider === 'claude'
    ? {
        type: 'assistant',
        message: { content: [{ type: 'text', text: NEW_ANSWER }] },
      }
    : {
        type: 'codex',
        event: {
          type: 'item.completed',
          item: { id: 'answer', type: 'agent_message', text: NEW_ANSWER },
        },
      };
}

function complete(provider: AgentProviderType): void {
  if (provider === 'codex') {
    send({
      type: 'codex',
      event: { type: 'turn.completed', status: 'completed' },
    });
  }
  send({
    type: 'result',
    is_error: false,
    result: provider === 'claude' ? NEW_ANSWER : 'Turn completed',
  });
}

function currentTab(): ChatTab {
  const current = useChatStore.getState().worktreeChats[KEY]?.tabs[0];
  if (!current) throw new Error('missing preview tab');
  return current;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  showInApp = true;
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      chat: {
        command: jest
          .fn()
          .mockResolvedValue({ revision: 1, outcome: { type: 'applied' } }),
      },
    },
  });
  useGitHubStore.setState({
    addToast: toast,
    requestKnownPrFastRefresh: jest.fn().mockResolvedValue(false),
  });
  useProjectsStore.setState({
    projects: [],
    fastRefreshWorktreeDiffStats: jest.fn(),
  });
  useChatStore.setState({
    selectedWorktree: null,
    worktreeChats: {},
    chatStateSync: { [KEY]: { phase: 'live', revision: 1 } },
    runtimeByChatId: {},
    unreadWorktreeKeys: new Set(),
  });
  clearRecordedUnreadChatAgentResponsePreview(
    'preview-project',
    'preview-worktree',
    'preview-chat',
  );
  clearRecordedUnreadChatAgentResponsePreview(
    'other-project',
    'other-worktree',
    'preview-chat',
  );
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe.each<AgentProviderType>(['claude', 'codex'])(
  '%s stale unread previews',
  (provider) => {
    it.each([true, false])(
      'uses the final raw answer with cached answer=%s',
      (cached) => {
        useChatStore.setState({
          worktreeChats: {
            [KEY]: { activeTabId: 'other', tabs: [tab(provider, cached)] },
          },
        });
        send(answer(provider));
        complete(provider);
        jest.advanceTimersByTime(CLAUDE_UNREAD_CHAT_NOTIFICATION_DELAY_MS);
        expect(toast).toHaveBeenCalledWith(
          expect.stringContaining(NEW_ANSWER),
          'info',
          expect.any(Function),
          expect.any(Object),
        );
        expect(getChatTabAgentResponsePreview(currentTab())).toBe(NEW_ANSWER);
        expect(currentTab().messages).toEqual(tab(provider, cached).messages);
      },
    );

    it.each([true, false])(
      'uses the final raw answer for OS notifications with cached answer=%s',
      (cached) => {
        showInApp = false;
        useChatStore.setState({
          worktreeChats: {
            [KEY]: { activeTabId: 'other', tabs: [tab(provider, cached)] },
          },
        });
        send(answer(provider));
        complete(provider);
        jest.advanceTimersByTime(CLAUDE_UNREAD_CHAT_NOTIFICATION_DELAY_MS);
        expect(osNotification).toHaveBeenCalledTimes(1);
        expect(osNotification.mock.calls[0]?.[0].body).toContain(NEW_ANSWER);
        expect(getChatTabAgentResponsePreview(currentTab())).toBe(NEW_ANSWER);
      },
    );

    it('preserves the cached-row preference when not stale', () => {
      const fresh = tab(provider);
      delete fresh.transcriptStale;
      useChatStore.setState({
        worktreeChats: { [KEY]: { activeTabId: 'other', tabs: [fresh] } },
      });
      send(answer(provider));
      complete(provider);
      jest.advanceTimersByTime(CLAUDE_UNREAD_CHAT_NOTIFICATION_DELAY_MS);
      expect(toast).toHaveBeenCalledWith(
        expect.stringContaining(OLD_ANSWER),
        'info',
        expect.any(Function),
        expect.any(Object),
      );
      expect(getChatTabAgentResponsePreview(currentTab())).toBe(OLD_ANSWER);
    });

    it('clears the stale preview on the next turn start and on read', () => {
      useChatStore.setState({
        worktreeChats: {
          [KEY]: { activeTabId: 'other', tabs: [tab(provider)] },
        },
      });
      send(answer(provider));
      complete(provider);
      expect(getChatTabAgentResponsePreview(currentTab())).toBe(NEW_ANSWER);
      send(
        provider === 'claude'
          ? { type: 'canopy_user_prompt', text: 'Next turn' }
          : { type: 'codex', event: { type: 'turn.started' } },
      );
      expect(
        getRecordedUnreadChatAgentResponsePreview(
          'preview-project',
          'preview-worktree',
          'preview-chat',
        ),
      ).toBeUndefined();
      send(answer(provider));
      useChatStore
        .getState()
        .markTargetRead('preview-project', 'preview-worktree', {
          tabId: 'preview-chat',
        });
      expect(
        getRecordedUnreadChatAgentResponsePreview(
          'preview-project',
          'preview-worktree',
          'preview-chat',
        ),
      ).toBeUndefined();
    });
  },
);

it('falls back to cached rows when a chat id has previews in multiple scopes', () => {
  recordUnreadChatAgentResponsePreview(
    'preview-project',
    'preview-worktree',
    'preview-chat',
    answer('claude'),
    true,
  );
  recordUnreadChatAgentResponsePreview(
    'other-project',
    'other-worktree',
    'preview-chat',
    answer('codex'),
    true,
  );
  expect(getChatTabAgentResponsePreview(tab('claude'))).toBe(OLD_ANSWER);
  clearRecordedUnreadChatAgentResponsePreview(
    'other-project',
    'other-worktree',
    'preview-chat',
  );
  expect(getChatTabAgentResponsePreview(tab('claude'))).toBe(NEW_ANSWER);
});

it('invalidates a stale-only preview when current rows are read after catch-up', () => {
  recordUnreadChatAgentResponsePreview(
    'preview-project',
    'preview-worktree',
    'preview-chat',
    answer('claude'),
    true,
  );
  const fresh = tab('claude');
  delete fresh.transcriptStale;
  expect(getChatTabAgentResponsePreview(fresh)).toBe(OLD_ANSWER);
  expect(
    getRecordedUnreadChatAgentResponsePreview(
      'preview-project',
      'preview-worktree',
      'preview-chat',
    ),
  ).toBeUndefined();
});

it('bounds stale previews and removes evicted index entries', () => {
  try {
    for (let index = 0; index < 513; index += 1) {
      recordUnreadChatAgentResponsePreview(
        'bounded',
        'worktree',
        `chat-${index}`,
        answer('claude'),
        true,
      );
    }
    expect(
      getRecordedUnreadChatAgentResponsePreview(
        'bounded',
        'worktree',
        'chat-0',
      ),
    ).toBeUndefined();
    expect(
      getChatTabAgentResponsePreview({ ...tab('claude'), id: 'chat-0' }),
    ).toBe(OLD_ANSWER);
    expect(
      getChatTabAgentResponsePreview({ ...tab('claude'), id: 'chat-512' }),
    ).toBe(NEW_ANSWER);
  } finally {
    for (let index = 0; index < 513; index += 1) {
      clearRecordedUnreadChatAgentResponsePreview(
        'bounded',
        'worktree',
        `chat-${index}`,
      );
    }
  }
});
