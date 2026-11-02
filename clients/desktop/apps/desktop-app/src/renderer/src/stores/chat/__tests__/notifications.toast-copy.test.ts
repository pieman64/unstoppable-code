// Worktree chat toast copy: the toast headline already names the worktree, so
// the message leaves out the branch, and agent replies show as plain text
// rather than raw Markdown. OS notifications have no such headline and keep
// the branch.

interface CapturedToast {
  message: string;
}
let capturedToasts: CapturedToast[] = [];
jest.mock('../../githubStore', () => ({
  useGitHubStore: {
    getState: (): { addToast: (message: string) => void } => ({
      addToast: (message: string): void => {
        capturedToasts.push({ message });
      },
    }),
  },
}));

jest.mock('../../projectsStore', () => ({
  useProjectsStore: {
    getState: (): { projects: unknown[]; hasHydratedProjects: boolean } => ({
      projects: [
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

jest.mock('../../codeReviewStore', () => ({
  useCodeReviewStore: { getState: (): unknown => ({}) },
}));
jest.mock('@/lib/cowork', () => ({
  isCoworkChatTarget: (): boolean => false,
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

let capturedOsBodies: unknown[] = [];
jest.mock('@/lib/osNotifications', () => ({
  maybeFireOsNotification: (payload: { body: unknown }): void => {
    capturedOsBodies.push(payload.body);
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
let worktreeChats: Record<string, unknown> = {};
jest.mock('../store-ref', () => ({
  chatStoreApi: (): { getState: () => { worktreeChats: object } } => ({
    getState: () => ({ worktreeChats }),
  }),
}));

import {
  fireChatActivityNotification,
  showUnreadChatToast,
  type UnreadChatToastOptions,
} from '../notifications';
import { normalizeUnreadChatPreview } from '../unread-previews';

const WORKTREE_OPTIONS: UnreadChatToastOptions = {
  projectId: 'git-proj',
  worktreeId: 'wt-1',
  chatId: 'chat-1',
  chatTitle: 'Fix the toast',
  reason: 'activity',
  agentResponsePreview: 'Done.',
};

beforeEach(() => {
  capturedToasts = [];
  capturedOsBodies = [];
  worktreeChats = {};
});

describe('worktree chat toast copy', () => {
  it('leaves the branch out of the toast message', () => {
    showUnreadChatToast(WORKTREE_OPTIONS);
    expect(capturedToasts.map((toast) => toast.message)).toEqual([
      'Fix the toast: Done.',
    ]);
  });

  it('names the chat by its generated description, not its raw title', () => {
    worktreeChats = {
      'git-proj/wt-1': {
        tabs: [
          {
            id: 'chat-1',
            title: 'Fix the toast',
            description: 'Polish toast headlines',
          },
        ],
      },
    };
    showUnreadChatToast(WORKTREE_OPTIONS);
    fireChatActivityNotification(WORKTREE_OPTIONS);
    expect(capturedToasts.map((toast) => toast.message)).toEqual([
      'Polish toast headlines: Done.',
    ]);
    expect(capturedOsBodies).toEqual([
      'feature/x: Polish toast headlines: Done.',
    ]);
  });

  it('keeps a renamed chat ahead of its generated description', () => {
    worktreeChats = {
      'git-proj/wt-1': {
        tabs: [
          {
            id: 'chat-1',
            title: 'Fix the toast',
            description: 'Polish toast headlines',
            customTitle: 'Toast work',
          },
        ],
      },
    };
    showUnreadChatToast(WORKTREE_OPTIONS);
    expect(capturedToasts.map((toast) => toast.message)).toEqual([
      'Toast work: Done.',
    ]);
  });

  it('shows only the reply when the chat has no title', () => {
    showUnreadChatToast({ ...WORKTREE_OPTIONS, chatTitle: 'New chat' });
    expect(capturedToasts.map((toast) => toast.message)).toEqual(['Done.']);
  });

  it('leaves the branch out of the fallback copy', () => {
    showUnreadChatToast({
      ...WORKTREE_OPTIONS,
      reason: 'question',
      agentResponsePreview: undefined,
    });
    expect(capturedToasts.map((toast) => toast.message)).toEqual([
      'Question waiting: Fix the toast',
    ]);
  });

  it('keeps the branch in the OS notification body', () => {
    fireChatActivityNotification(WORKTREE_OPTIONS);
    expect(capturedOsBodies).toEqual(['feature/x: Fix the toast: Done.']);
  });
});

describe('normalizeUnreadChatPreview', () => {
  it('flattens Markdown into plain text', () => {
    expect(
      normalizeUnreadChatPreview(
        'I added the delay.\n\n- **Delay:** the card waits `500ms`.\n- See [the page](http://127.0.0.1:5188/).',
      ),
    ).toBe('I added the delay. Delay: the card waits 500ms. See the page.');
  });
});
