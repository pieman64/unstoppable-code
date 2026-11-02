/**
 * @jest-environment jsdom
 *
 * App Advisor notification routing after the cowork classification change:
 * App Advisor entry-keyed chats keep firing toasts / OS notifications that
 * open the POPOUT window. Regular cowork notification behavior is covered by
 * the chat-store integration tests.
 */
import { registerCoworkWorkspaceIds } from '@/lib/cowork-registry';

const addToastMock = jest.fn();
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: {
    getState: (): { addToast: jest.Mock } => ({ addToast: addToastMock }),
  },
}));

const maybeFireOsNotificationMock = jest.fn();
jest.mock('@/lib/osNotifications', () => ({
  maybeFireOsNotification: (...args: unknown[]): void => {
    maybeFireOsNotificationMock(...args);
  },
  shouldShowInAppNotification: (): boolean => true,
}));

let mockMainWindowOpen = true;
let mockAdvisorFocused = false;
jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: {
    getState: (): Record<string, unknown> => ({
      activePage: 'main',
      navigate: jest.fn(),
      appAdvisorMainWindowOpen: mockMainWindowOpen,
      appAdvisorMainWindowDownCount: 0,
      appAdvisorOpen: mockAdvisorFocused,
      appAdvisorFocused: mockAdvisorFocused,
    }),
  },
}));

jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: {
    getState: (): Record<string, unknown> => ({
      projects: [],
      hasHydratedProjects: true,
    }),
  },
  isWorktreeArchiveSuppressedForChatActivity: (): boolean => false,
}));

jest.mock('@/stores/activityStore', () => ({
  useActivityStore: { getState: (): Record<string, unknown> => ({}) },
}));

jest.mock('@/stores/codeReviewStore', () => ({
  useCodeReviewStore: { getState: (): Record<string, unknown> => ({}) },
}));

// Toast copy reads the chat's tab label from the chat store.
jest.mock('@/stores/chat/store-ref', () => ({
  chatStoreApi: (): { getState: () => { worktreeChats: object } } => ({
    getState: () => ({ worktreeChats: {} }),
  }),
}));

const openWindowMock = jest.fn().mockResolvedValue({
  open: true,
  focused: true,
});

Object.defineProperty(window, 'api', {
  configurable: true,
  value: { appAdvisor: { openWindow: openWindowMock } },
  writable: true,
});

import {
  fireChatActivityNotification,
  showUnreadChatToast,
} from '../notifications';

beforeEach(() => {
  jest.clearAllMocks();
  registerCoworkWorkspaceIds([]);
});

afterEach(() => {
  registerCoworkWorkspaceIds([]);
  delete document.body.dataset.rendererSurface;
  document.body.removeAttribute('data-app-advisor-floating');
  mockMainWindowOpen = true;
  mockAdvisorFocused = false;
});

describe('App Advisor notification routing', () => {
  it('shows an App Advisor toast for entry-keyed chats and routes clicks to the popout', () => {
    showUnreadChatToast({
      projectId: 'app-advisor',
      worktreeId: 'entry-1',
      chatId: 'chat-1',
      chatTitle: 'Advisor chat',
      reason: 'activity',
    });

    expect(addToastMock).toHaveBeenCalledTimes(1);
    const [message, tone, onClick, meta] = addToastMock.mock.calls[0] as [
      string,
      string,
      () => void,
      Record<string, unknown>,
    ];
    expect(message).toContain('Orchestrator');
    expect(tone).toBe('info');
    expect(meta).toEqual({ category: 'Chat', workspaceName: 'Orchestrator' });

    // Clicking opens the POPOUT window (never main-window chat navigation).
    onClick();
    expect(openWindowMock).toHaveBeenCalledWith({
      chatId: 'chat-1',
      focus: true,
      focusComposer: true,
    });
  });

  it('fires App Advisor OS notifications with popout routing', () => {
    fireChatActivityNotification({
      projectId: 'app-advisor',
      worktreeId: 'entry-2',
      chatId: 'chat-2',
      reason: 'question',
    });

    expect(maybeFireOsNotificationMock).toHaveBeenCalledTimes(1);
    const payload = (
      maybeFireOsNotificationMock.mock.calls[0] as [
        { title: string; onClick: () => void },
      ]
    )[0];
    expect(payload.title).toBe('Orchestrator');
    payload.onClick();
    expect(openWindowMock).toHaveBeenCalledWith({
      chatId: 'chat-2',
      focus: true,
      focusComposer: true,
    });
  });

  // The main window mirrors App Advisor turns and owns their notifications.
  // The App Advisor renderer must not raise a second copy in its own panel.
  it('raises no toast or OS notification from the floating App Advisor panel', () => {
    document.body.dataset.rendererSurface = 'app-advisor';
    document.body.setAttribute('data-app-advisor-floating', '');
    const options = {
      projectId: 'app-advisor',
      worktreeId: 'entry-3',
      chatId: 'chat-3',
      reason: 'activity' as const,
    };

    showUnreadChatToast(options);
    fireChatActivityNotification(options);

    expect(addToastMock).not.toHaveBeenCalled();
    expect(maybeFireOsNotificationMock).not.toHaveBeenCalled();
  });

  // The full App Advisor window can outlive a closed main window on macOS,
  // so it keeps notifying for its own turns.
  it('still notifies from the full App Advisor window', () => {
    document.body.dataset.rendererSurface = 'app-advisor';
    const options = {
      projectId: 'app-advisor',
      worktreeId: 'entry-4',
      chatId: 'chat-4',
      reason: 'activity' as const,
    };

    showUnreadChatToast(options);
    fireChatActivityNotification(options);

    expect(addToastMock).toHaveBeenCalledTimes(1);
    expect(maybeFireOsNotificationMock).toHaveBeenCalledTimes(1);
  });

  // On macOS the main window can close while the floating panel's renderer
  // keeps running; nothing else is left to notify.
  it('notifies from the floating panel once the main window has closed', () => {
    document.body.dataset.rendererSurface = 'app-advisor';
    document.body.setAttribute('data-app-advisor-floating', '');
    mockMainWindowOpen = false;
    const options = {
      projectId: 'app-advisor',
      worktreeId: 'entry-5',
      chatId: 'chat-5',
      reason: 'activity' as const,
    };

    showUnreadChatToast(options);
    fireChatActivityNotification(options);

    expect(addToastMock).toHaveBeenCalledTimes(1);
    expect(maybeFireOsNotificationMock).toHaveBeenCalledTimes(1);
  });

  // App Advisor OS notifications carry no chat ids, so they say whether App
  // Advisor is on screen; a focused main window alone must not hide them.
  it('marks App Advisor OS notifications visible only while App Advisor is focused', () => {
    const options = {
      projectId: 'app-advisor',
      worktreeId: 'entry-6',
      chatId: 'chat-6',
      reason: 'activity' as const,
    };

    fireChatActivityNotification(options);
    mockAdvisorFocused = true;
    fireChatActivityNotification(options);

    const visible = maybeFireOsNotificationMock.mock.calls.map(
      ([payload]) => (payload as { visible?: boolean }).visible,
    );
    expect(visible).toEqual([false, true]);
  });
});
