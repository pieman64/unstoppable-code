/**
 * @jest-environment jsdom
 *
 * The floating App Advisor panel defers chat notifications to the main
 * window while the main page is up. Who notifies is decided when a delayed
 * Claude notification is scheduled: a reply that finished while the main page
 * was down never reached it, so App Advisor still delivers it if the page
 * comes back during the delay.
 */
import type { maybeFireOsNotification } from '@/lib/osNotifications';
import type { ChatTab } from '../types';
import { CLAUDE_UNREAD_CHAT_NOTIFICATION_DELAY_MS } from '../constants';
import { useChatStore } from '../../chatStore';
import { useGitHubStore } from '../../githubStore';
import { useAppAdvisorStore } from '../../appAdvisorStore';
import { useNavigationStore } from '../../navigationStore';
import {
  maybeFireChatActivityNotification,
  maybeShowUnreadChatToast,
} from '../notifications';

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

const toast = jest.fn();
const OPTIONS = {
  projectId: 'app-advisor',
  worktreeId: 'entry-1',
  chatId: 'advisor-chat',
  reason: 'activity' as const,
  providerType: 'claude' as const,
  requireUnreadBeforeDelivery: true,
};

function advisorTab(): ChatTab {
  return {
    id: 'advisor-chat',
    title: 'Advisor chat',
    createdAt: '2026-10-21T00:00:00.000Z',
    messages: [],
    status: 'idle',
    error: null,
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    providerType: 'claude',
    unread: true,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  showInApp = true;
  document.body.dataset.rendererSurface = 'app-advisor';
  document.body.setAttribute('data-app-advisor-floating', '');
  useGitHubStore.setState({ addToast: toast });
  useChatStore.setState({
    worktreeChats: {
      'app-advisor/entry-1': { activeTabId: 'other', tabs: [advisorTab()] },
    },
  });
  useNavigationStore.setState({ appAdvisorMainWindowOpen: false });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  delete document.body.dataset.rendererSurface;
  document.body.removeAttribute('data-app-advisor-floating');
  useNavigationStore.setState({ appAdvisorMainWindowOpen: true });
});

it('delivers a toast scheduled while the main page was down after it recovers', () => {
  maybeShowUnreadChatToast(OPTIONS);
  useNavigationStore.setState({ appAdvisorMainWindowOpen: true });
  jest.advanceTimersByTime(CLAUDE_UNREAD_CHAT_NOTIFICATION_DELAY_MS);

  expect(toast).toHaveBeenCalledTimes(1);
});

it('delivers an OS notification scheduled while the main page was down after it recovers', () => {
  showInApp = false;
  maybeFireChatActivityNotification(OPTIONS);
  useNavigationStore.setState({ appAdvisorMainWindowOpen: true });
  jest.advanceTimersByTime(CLAUDE_UNREAD_CHAT_NOTIFICATION_DELAY_MS);

  expect(osNotification).toHaveBeenCalledTimes(1);
});

it('leaves a reply that finished while the main page was up to the main window', () => {
  useNavigationStore.setState({ appAdvisorMainWindowOpen: true });
  maybeShowUnreadChatToast(OPTIONS);
  maybeFireChatActivityNotification(OPTIONS);
  jest.advanceTimersByTime(CLAUDE_UNREAD_CHAT_NOTIFICATION_DELAY_MS);

  expect(toast).not.toHaveBeenCalled();
  expect(osNotification).not.toHaveBeenCalled();
});

it('delivers when the main page goes down before its delayed notification is due', () => {
  useNavigationStore.setState({ appAdvisorMainWindowOpen: true });
  maybeShowUnreadChatToast(OPTIONS);
  useNavigationStore.setState({ appAdvisorMainWindowOpen: false });
  jest.advanceTimersByTime(CLAUDE_UNREAD_CHAT_NOTIFICATION_DELAY_MS);
  expect(toast).toHaveBeenCalledTimes(1);

  showInApp = false;
  useNavigationStore.setState({ appAdvisorMainWindowOpen: true });
  maybeFireChatActivityNotification(OPTIONS);
  useNavigationStore.setState({ appAdvisorMainWindowOpen: false });
  jest.advanceTimersByTime(CLAUDE_UNREAD_CHAT_NOTIFICATION_DELAY_MS);
  expect(osNotification).toHaveBeenCalledTimes(1);
});

it('delivers when the main page goes down and recovers before the delayed notification is due', () => {
  useAppAdvisorStore
    .getState()
    .syncWindowState({ open: true, focused: false, mainWindowOpen: true });
  maybeShowUnreadChatToast(OPTIONS);
  const { syncWindowState } = useAppAdvisorStore.getState();
  syncWindowState({ open: true, focused: false, mainWindowOpen: false });
  syncWindowState({ open: true, focused: false, mainWindowOpen: true });
  jest.advanceTimersByTime(CLAUDE_UNREAD_CHAT_NOTIFICATION_DELAY_MS);

  expect(toast).toHaveBeenCalledTimes(1);
});
