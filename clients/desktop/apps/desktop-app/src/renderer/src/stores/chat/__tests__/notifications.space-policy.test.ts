// Per-space notification choices (CAN-3615) on the chat delivery paths:
// typed classes, popups and native banners gated by the originating space,
// and delayed deliveries judged at the time the work happened.

const navigateMock = jest.fn();
const activePage = 'main';

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

import {
  EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT,
  spaceNotificationScopeKey,
} from '@canopy/desktop-shared/lib/space-notification-policy';
import type {
  SpaceNotificationLevel,
  SpaceNotificationTransition,
} from '@canopy/protocol/space-notifications';
import { useSpaceNotificationStore } from '../../spaceNotificationStore';
import {
  chatNotificationScope,
  fireChatActivityNotification,
  maybeFireChatActivityNotification,
  showUnreadChatToast,
  type UnreadChatToastOptions,
} from '../notifications';
import { CLAUDE_UNREAD_CHAT_NOTIFICATION_DELAY_MS } from '../constants';

const OPTIONS: UnreadChatToastOptions = {
  projectId: 'git-proj',
  worktreeId: 'wt-1',
  chatId: 'chat-1',
  chatTitle: 'Refactor',
  reason: 'activity',
};
const KEY = spaceNotificationScopeKey({
  projectId: 'git-proj',
  worktreeId: 'wt-1',
});

function savePolicy(
  override: SpaceNotificationLevel | null,
  transitions: SpaceNotificationTransition[] = [],
): void {
  useSpaceNotificationStore.setState({
    snapshot: {
      ...EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT,
      accountKey: 'user-1',
      writesEnabled: true,
      spaces: {
        [KEY]: {
          notificationSpaceId: 'space-1',
          revision: transitions.length,
          override,
          transitions,
        },
      },
    },
  });
}

function transition(
  revision: number,
  at: number,
  priorOverride: SpaceNotificationLevel | null,
  nextOverride: SpaceNotificationLevel | null,
): SpaceNotificationTransition {
  return {
    revision,
    effectiveAt: new Date(at).toISOString(),
    priorOverride,
    nextOverride,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  capturedToasts = [];
  capturedOsPayloads = [];
  worktreeChats = {};
  useSpaceNotificationStore.setState({
    snapshot: EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT,
    progress: {},
  });
});

describe('chatNotificationScope', () => {
  it.each([
    ['activity', false, 'routine'],
    ['activity', true, 'failure'],
    ['question', false, 'attention'],
    ['plan', false, 'attention'],
  ] as const)(
    'classifies %s (failed: %s) as %s',
    (reason, failed, eventClass) => {
      expect(chatNotificationScope({ ...OPTIONS, reason, failed })).toEqual({
        projectId: 'git-proj',
        worktreeId: 'wt-1',
        eventClass,
      });
    },
  );
});

describe('notification offer completion marker', () => {
  it.each([
    ['activity', false, true],
    ['activity', true, true],
    ['question', false, undefined],
    ['plan', false, undefined],
  ] as const)(
    'marks %s (failed: %s) on both delivery paths: %s',
    (reason, failed, agentCompletion) => {
      showUnreadChatToast({ ...OPTIONS, reason, failed });
      expect(capturedToasts[0]?.meta?.agentCompletion).toBe(agentCompletion);
      fireChatActivityNotification({ ...OPTIONS, reason, failed });
      expect(capturedOsPayloads[0]?.agentCompletion).toBe(agentCompletion);
    },
  );
});

describe('chat delivery under a saved choice', () => {
  it('attaches the space to the toast so muted chats keep history only', () => {
    showUnreadChatToast({ ...OPTIONS, reason: 'question' });
    expect(capturedToasts[0]?.meta?.notificationScope).toEqual({
      projectId: 'git-proj',
      worktreeId: 'wt-1',
      eventClass: 'attention',
    });
  });

  it('raises no native banner from a muted space and keeps other spaces', () => {
    savePolicy('mute');
    fireChatActivityNotification(OPTIONS);
    expect(maybeFireOsNotificationMock).not.toHaveBeenCalled();
    fireChatActivityNotification({ ...OPTIONS, worktreeId: 'wt-2' });
    expect(maybeFireOsNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('lets a failure through Needs my attention but not a finished turn', () => {
    savePolicy('attention');
    fireChatActivityNotification(OPTIONS);
    expect(maybeFireOsNotificationMock).not.toHaveBeenCalled();
    fireChatActivityNotification({ ...OPTIONS, failed: true });
    expect(maybeFireOsNotificationMock).toHaveBeenCalledTimes(1);
  });
});

describe('delayed Claude delivery', () => {
  const DELAYED: UnreadChatToastOptions = {
    ...OPTIONS,
    providerType: 'claude',
    requireUnreadBeforeDelivery: true,
  };
  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-10-04T12:00:00.000Z') });
    worktreeChats = {
      'git-proj/wt-1': {
        tabs: [
          {
            id: 'chat-1',
            unread: true,
            status: 'idle',
            queuedMessages: [],
          },
        ],
      },
    };
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('cancels a queued banner when the space is muted before it fires', () => {
    const occurredAt = Date.now();
    maybeFireChatActivityNotification(DELAYED);
    savePolicy('mute', [transition(1, occurredAt + 1_000, null, 'mute')]);
    jest.advanceTimersByTime(CLAUDE_UNREAD_CHAT_NOTIFICATION_DELAY_MS);
    expect(maybeFireOsNotificationMock).not.toHaveBeenCalled();
  });

  it('does not deliver work from a muted interval after an unmute, but delivers new work', () => {
    const start = Date.now();
    savePolicy('mute', [transition(1, start - 1_000, null, 'mute')]);
    maybeFireChatActivityNotification(DELAYED);
    savePolicy('all', [
      transition(1, start - 1_000, null, 'mute'),
      transition(2, start + 1_000, 'mute', 'all'),
    ]);
    jest.advanceTimersByTime(CLAUDE_UNREAD_CHAT_NOTIFICATION_DELAY_MS);
    expect(maybeFireOsNotificationMock).not.toHaveBeenCalled();

    maybeFireChatActivityNotification(DELAYED);
    jest.advanceTimersByTime(CLAUDE_UNREAD_CHAT_NOTIFICATION_DELAY_MS);
    expect(maybeFireOsNotificationMock).toHaveBeenCalledTimes(1);
  });
});
