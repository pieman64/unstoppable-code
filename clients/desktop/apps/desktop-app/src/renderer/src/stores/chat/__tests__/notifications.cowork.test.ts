// Cowork chat completion notifications: cowork targets flow through the
// toast + OS notification pipeline (they were hard-excluded before), the
// visible-key check recognizes the cowork page, toast copy uses the
// work-entry-ish chat description, and clicks route to the cowork surface.

const navigateMock = jest.fn();
let activePage = 'main';

jest.mock('../../navigationStore', () => ({
  useNavigationStore: {
    getState: (): { activePage: string; navigate: jest.Mock } => ({
      activePage,
      navigate: navigateMock,
    }),
    subscribe: jest.fn(),
  },
}));

interface CapturedToast {
  message: string;
  type: string;
  meta: Record<string, unknown> | undefined;
}
let capturedToasts: CapturedToast[] = [];
const addToastMock = jest.fn(
  (
    message: string,
    type: string,
    _onClick?: () => void,
    meta?: Record<string, unknown>,
  ): void => {
    capturedToasts.push({ message, type, meta });
  },
);
jest.mock('../../githubStore', () => ({
  useGitHubStore: {
    getState: (): { addToast: jest.Mock } => ({ addToast: addToastMock }),
  },
}));

jest.mock('../../projectsStore', () => ({
  useProjectsStore: {
    getState: (): { projects: unknown[]; hasHydratedProjects: boolean } => ({
      projects: [
        { id: 'cowork-ws', name: 'My Cowork', type: 'cowork' },
        {
          id: 'git-proj',
          name: 'Git Project',
          type: 'single-repo',
          worktrees: [{ id: 'wt-1', branchName: 'feature/x' }],
        },
      ],
      hasHydratedProjects: true,
    }),
  },
}));

jest.mock('../../activityStore', () => ({
  useActivityStore: { getState: (): unknown => ({}) },
}));
jest.mock('../../codeReviewStore', () => ({
  useCodeReviewStore: { getState: (): unknown => ({}) },
}));

jest.mock('@/lib/cowork', () => ({
  isCoworkChatTarget: (projectId: string): boolean => projectId === 'cowork-ws',
}));
jest.mock('@/lib/worktree-layout-prefs', () => ({
  getCurrentChatPanelVisible: (): boolean => true,
}));
jest.mock('@/lib/worktreeNavigation', () => ({
  canNavigateToWorktreeFromSidebarItems: (): boolean => true,
}));
jest.mock('@/lib/chatPanelReveal', () => ({
  requestChatPanelReveal: jest.fn(),
}));

let capturedOsPayloads: Record<string, unknown>[] = [];
const maybeFireOsNotificationMock = jest.fn(
  (payload: Record<string, unknown>): void => {
    capturedOsPayloads.push(payload);
  },
);
jest.mock('@/lib/osNotifications', () => ({
  maybeFireOsNotification: (payload: Record<string, unknown>): void => {
    maybeFireOsNotificationMock(payload);
  },
  shouldShowInAppNotification: (): boolean => true,
}));

jest.mock('../surface', () => ({
  canReceiveWorktreeChatActivity: (): boolean => true,
  isAppAdvisorChatTarget: (): boolean => false,
}));
jest.mock('../plan-explore-registry', () => ({
  findPlanExploreTarget: (): null => null,
  isVisiblePlanExploreChat: (): boolean => false,
}));
jest.mock('../code-review-registry', () => ({
  findCodeReviewTarget: (): null => null,
  isVisibleCodeReviewChat: (): boolean => false,
}));
jest.mock('../hydration', () => ({
  waitForWorktreeHydration: jest.fn((): Promise<void> => Promise.resolve()),
}));

const switchTabMock = jest.fn();
let worktreeChats: Record<string, unknown> = {};
jest.mock('../store-ref', () => ({
  chatStoreApi: (): {
    getState: () => {
      worktreeChats: Record<string, unknown>;
      switchTab: jest.Mock;
    };
  } => ({
    getState: () => ({ worktreeChats, switchTab: switchTabMock }),
  }),
}));

const openWorkEntryFromSidebarMock = jest.fn(
  (): Promise<void> => Promise.resolve(),
);
jest.mock('../../standaloneChatStore', () => ({
  useStandaloneChatStore: {
    getState: (): { openWorkEntryFromSidebar: jest.Mock } => ({
      openWorkEntryFromSidebar: openWorkEntryFromSidebarMock,
    }),
  },
}));

import { setStandaloneChatArchiveOverlayOpen } from '../../standaloneChatVisibility';

import {
  fireChatActivityNotification,
  getUnreadChatToastContext,
  getVisibleWorktreeKey,
  navigateToUnreadChat,
  showUnreadChatToast,
  type UnreadChatToastOptions,
} from '../notifications';

const COWORK_OPTIONS: UnreadChatToastOptions = {
  projectId: 'cowork-ws',
  worktreeId: 'entry-1',
  chatId: 'chat-1',
  chatTitle: 'Weekly report',
  reason: 'activity',
  agentResponsePreview: 'Report drafted.',
};

beforeEach(() => {
  jest.clearAllMocks();
  activePage = 'main';
  worktreeChats = {};
  capturedToasts = [];
  capturedOsPayloads = [];
  setStandaloneChatArchiveOverlayOpen(false);
});

describe('getVisibleWorktreeKey (cowork)', () => {
  it('treats the selected work entry as visible on the chat page', () => {
    activePage = 'chat';
    expect(
      getVisibleWorktreeKey({ projectId: 'cowork-ws', worktreeId: 'entry-1' }),
    ).toBe('cowork-ws/entry-1');
  });

  it('treats cowork selection as not visible away from the chat page', () => {
    activePage = 'main';
    expect(
      getVisibleWorktreeKey({ projectId: 'cowork-ws', worktreeId: 'entry-1' }),
    ).toBeNull();
  });

  it('treats cowork selection as not visible behind the archive overlay', () => {
    activePage = 'chat';
    setStandaloneChatArchiveOverlayOpen(true);
    expect(
      getVisibleWorktreeKey({ projectId: 'cowork-ws', worktreeId: 'entry-1' }),
    ).toBeNull();
  });

  it('keeps worktree selections keyed to the main page', () => {
    activePage = 'main';
    expect(
      getVisibleWorktreeKey({ projectId: 'git-proj', worktreeId: 'wt-1' }),
    ).toBe('git-proj/wt-1');
    activePage = 'chat';
    expect(
      getVisibleWorktreeKey({ projectId: 'git-proj', worktreeId: 'wt-1' }),
    ).toBeNull();
  });
});

describe('getUnreadChatToastContext (cowork)', () => {
  it('uses the chat description as the work-entry name', () => {
    worktreeChats = {
      'cowork-ws/entry-1': {
        tabs: [
          {
            id: 'chat-1',
            title: 'Weekly report',
            description: 'Q3 planning session',
          },
        ],
      },
    };
    const context = getUnreadChatToastContext(COWORK_OPTIONS);
    expect(context.worktreeName).toBe('Q3 planning session');
    expect(context.message).toBe(
      'Q3 planning session: Weekly report: Report drafted.',
    );
  });

  it('falls back to the chat title without repeating it as the label', () => {
    const context = getUnreadChatToastContext(COWORK_OPTIONS);
    expect(context.worktreeName).toBe('Weekly report');
    expect(context.message).toBe('Weekly report: Report drafted.');
  });
});

describe('cowork toast + OS notification delivery', () => {
  it('shows an in-app toast with a navigable cowork target', () => {
    showUnreadChatToast(COWORK_OPTIONS);
    expect(addToastMock).toHaveBeenCalledTimes(1);
    expect(capturedToasts[0]?.message).toBe('Weekly report: Report drafted.');
    expect(capturedToasts[0]?.type).toBe('info');
    expect(capturedToasts[0]?.meta).toMatchObject({
      category: 'Chat',
      workspaceName: 'My Cowork',
      projectId: 'cowork-ws',
      worktreeId: 'entry-1',
      chatId: 'chat-1',
    });
  });

  it('fires an OS notification for cowork chats', () => {
    fireChatActivityNotification(COWORK_OPTIONS);
    expect(maybeFireOsNotificationMock).toHaveBeenCalledTimes(1);
    expect(capturedOsPayloads[0]).toMatchObject({
      category: 'Chat',
      projectId: 'cowork-ws',
      worktreeId: 'entry-1',
      chatId: 'chat-1',
      body: 'Weekly report: Report drafted.',
    });
  });
});

describe('navigateToUnreadChat (cowork)', () => {
  it('opens the work entry on the chat page and switches to the chat', async () => {
    await navigateToUnreadChat(COWORK_OPTIONS);
    expect(openWorkEntryFromSidebarMock).toHaveBeenCalledWith(
      'cowork-ws',
      'entry-1',
    );
    expect(navigateMock).toHaveBeenCalledWith('chat');
    expect(switchTabMock).toHaveBeenCalledWith('chat-1', {
      projectId: 'cowork-ws',
      worktreeId: 'entry-1',
    });
  });
});
