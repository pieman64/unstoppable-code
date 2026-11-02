/** @jest-environment jsdom */
import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import type { LiveChatNavigationTarget } from '../live-chat-navigation';
import { navigateToLiveChat } from '../live-chat-navigation';

const mockNavigate = jest.fn();
const mockOpenAppAdvisor = jest.fn();
const mockSwitchTab = jest.fn();
const mockOpenWorkEntry = jest.fn();
const mockNavigateToWorktreeChat = jest.fn<
  Promise<void>,
  [LiveChatNavigationTarget]
>();
const mockNavigateToUnreadChat = jest.fn<
  Promise<void>,
  [LiveChatNavigationTarget]
>();
const mockReveal = jest.fn();
const mockToast = jest.fn();
let mockTabs = [{ id: 'chat' }];
jest.mock('@/lib/cowork', () => ({
  isCoworkChatTarget: (id: string): boolean => id === 'cowork',
}));
jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: {
    getState: (): object => ({
      navigate: mockNavigate,
      openAppAdvisor: mockOpenAppAdvisor,
    }),
  },
}));
jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: (): object => ({
      switchTab: mockSwitchTab,
      worktreeChats: {
        'cowork/entry': { tabs: mockTabs },
        'code/entry': { tabs: mockTabs },
      },
    }),
  },
  navigateToWorktreeChat: (target: LiveChatNavigationTarget): Promise<void> =>
    mockNavigateToWorktreeChat(target),
}));
jest.mock('@/stores/chat/notifications', () => ({
  navigateToUnreadChat: (target: LiveChatNavigationTarget): Promise<void> =>
    mockNavigateToUnreadChat(target),
}));
jest.mock('@/stores/standaloneChatStore', () => ({
  useStandaloneChatStore: {
    getState: (): object => ({
      openWorkEntryFromSidebar: mockOpenWorkEntry,
      activeChatProjectId: 'cowork',
      activeWorkEntryId: 'entry',
    }),
  },
}));
jest.mock('@/lib/chatPanelReveal', () => ({
  requestChatPanelReveal: (...args: unknown[]): void => {
    mockReveal(...args);
  },
}));
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: { getState: (): object => ({ addToast: mockToast }) },
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockTabs = [{ id: 'chat' }];
  mockOpenWorkEntry.mockResolvedValue(undefined);
  mockNavigateToWorktreeChat.mockResolvedValue(undefined);
});

it('keeps code worktree navigation and its exact tab target', async () => {
  await navigateToLiveChat({
    projectId: 'code',
    worktreeId: 'entry',
    chatId: 'chat',
  });
  expect(mockNavigateToWorktreeChat).toHaveBeenCalledWith({
    projectId: 'code',
    worktreeId: 'entry',
    chatId: 'chat',
    openArchivedTranscript: false,
  });
  expect(mockOpenWorkEntry).not.toHaveBeenCalled();
});

it('opens the cowork entry, selects the exact tab and reveals a collapsed panel', async () => {
  await navigateToLiveChat({
    projectId: 'cowork',
    worktreeId: 'entry',
    chatId: 'chat',
  });
  expect(mockOpenWorkEntry).toHaveBeenCalledWith('cowork', 'entry');
  expect(mockSwitchTab).toHaveBeenCalledWith('chat', {
    projectId: 'cowork',
    worktreeId: 'entry',
  });
  expect(mockNavigate).toHaveBeenCalledWith('chat');
  expect(mockReveal).toHaveBeenCalledWith('cowork', 'entry', 'chat');
});

it('opens an App Advisor chat in its own window', async () => {
  await navigateToLiveChat({
    projectId: APP_ADVISOR_PROJECT_ID,
    worktreeId: 'entry',
    chatId: 'chat',
  });
  expect(mockOpenAppAdvisor).toHaveBeenCalledWith({ chatId: 'chat' });
});

it('reports a retired review chat instead of opening an unrelated change diagram', async () => {
  const target = {
    projectId: CODE_REVIEW_CHAT_PROJECT_ID,
    worktreeId: 'review-scope',
    chatId: 'chat',
  };
  await navigateToLiveChat(target);
  expect(mockNavigateToUnreadChat).not.toHaveBeenCalled();
  expect(mockToast).toHaveBeenCalledWith(
    expect.stringContaining('review chat'),
    'error',
  );
  expect(mockNavigateToWorktreeChat).not.toHaveBeenCalled();
});

it('reports an unavailable chat without an unhandled rejection', async () => {
  mockOpenWorkEntry.mockRejectedValueOnce(new Error('deleted'));
  await expect(
    navigateToLiveChat({
      projectId: 'cowork',
      worktreeId: 'entry',
      chatId: 'chat',
    }),
  ).resolves.toBeUndefined();
  expect(mockToast).toHaveBeenCalledWith(
    expect.stringContaining("Couldn't open the chat"),
    'error',
  );
  expect(mockSwitchTab).not.toHaveBeenCalled();
});

it('reports a removed tab instead of selecting a different chat', async () => {
  mockTabs = [];
  await navigateToLiveChat({
    projectId: 'cowork',
    worktreeId: 'entry',
    chatId: 'chat',
  });
  expect(mockToast).toHaveBeenCalled();
  expect(mockSwitchTab).not.toHaveBeenCalled();
  expect(mockReveal).not.toHaveBeenCalled();
});

it('resolves a legacy registry key to its current workspace and entry', async () => {
  const resolveChat = jest
    .fn()
    .mockResolvedValue({ entryId: 'entry', archivedInEntryId: null });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      standaloneChat: { init: jest.fn().mockResolvedValue(undefined) },
      workEntries: { resolveChat },
    },
  });
  try {
    await navigateToLiveChat({
      projectId: STANDALONE_CHAT_PROJECT_ID,
      worktreeId: 'legacy-workspace',
      workspaceId: 'cowork',
      chatId: 'chat',
    });
    expect(resolveChat).toHaveBeenCalledWith({
      projectId: 'cowork',
      chatId: 'chat',
    });
    expect(mockOpenWorkEntry).toHaveBeenCalledWith('cowork', 'entry');
    expect(mockReveal).toHaveBeenCalledWith('cowork', 'entry', 'chat');
  } finally {
    Reflect.deleteProperty(window, 'api');
  }
});

it('does not open or restore an archived legacy session', async () => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      standaloneChat: { init: jest.fn().mockResolvedValue(undefined) },
      workEntries: {
        resolveChat: jest
          .fn()
          .mockResolvedValue({ entryId: null, archivedInEntryId: 'archive' }),
      },
    },
  });
  try {
    await navigateToLiveChat({
      projectId: STANDALONE_CHAT_PROJECT_ID,
      worktreeId: 'legacy',
      workspaceId: 'cowork',
      chatId: 'chat',
    });
    expect(mockToast).toHaveBeenCalled();
    expect(mockOpenWorkEntry).not.toHaveBeenCalled();
  } finally {
    Reflect.deleteProperty(window, 'api');
  }
});

it('initializes a cold legacy workspace before resolving its migrated chat owner', async () => {
  const calls: string[] = [];
  let initialized = false;
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      standaloneChat: {
        init: jest.fn(() => {
          calls.push('initialize');
          initialized = true;
          return Promise.resolve();
        }),
      },
      workEntries: {
        resolveChat: jest.fn(() => {
          calls.push('resolve');
          return Promise.resolve({
            entryId: initialized ? 'entry' : null,
            archivedInEntryId: null,
          });
        }),
      },
    },
  });
  try {
    await navigateToLiveChat({
      projectId: STANDALONE_CHAT_PROJECT_ID,
      worktreeId: 'legacy',
      workspaceId: 'cowork',
      chatId: 'chat',
    });
    expect(calls).toEqual(['initialize', 'resolve']);
    expect(mockReveal).toHaveBeenCalledWith('cowork', 'entry', 'chat');
    expect(mockToast).not.toHaveBeenCalled();
  } finally {
    Reflect.deleteProperty(window, 'api');
  }
});
