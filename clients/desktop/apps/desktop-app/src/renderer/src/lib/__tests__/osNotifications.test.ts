import type {
  InAppNotificationPreferences,
  OsNotificationClickEvent,
  OsNotificationCloseEvent,
  OsNotificationPreferences,
  OsNotificationShowRequest,
} from '@canopy/desktop-shared/types';
import {
  __resetForTests,
  fireTestOsNotification,
  maybeFireOsNotification,
  refreshInAppNotificationPrefs,
  refreshOsNotificationPrefs,
  setOsNotificationNavigationHandler,
  setVisibleContext,
  shouldShowInAppNotification,
} from '../osNotifications';
import { useGitHubStore } from '@/stores/githubStore';
import { showGuestMergeFailureToast } from '@/components/auth/guestMergeFailure';

const enabledPreferences: OsNotificationPreferences = {
  enabled: true,
  skipWhenFocused: false,
  defaultSound: 'System',
  categories: {
    chat: true,
    script: true,
    hook: true,
    gitCommit: true,
    gitPush: true,
    prCreate: true,
    pipeline: true,
    terminal: true,
  },
  categorySounds: {
    chat: 'Default',
    script: 'Default',
    hook: 'Default',
    gitCommit: 'Default',
    gitPush: 'Default',
    prCreate: 'Default',
    pipeline: 'Default',
    terminal: 'Default',
  },
};

interface MockApi {
  showOsNotification: jest.Mock<
    Promise<{ shown: boolean }>,
    [OsNotificationShowRequest]
  >;
  onOsNotificationClicked: jest.Mock<
    () => void,
    [(event: OsNotificationClickEvent) => void]
  >;
  onOsNotificationClosed: jest.Mock<
    () => void,
    [(event: OsNotificationCloseEvent) => void]
  >;
  loadPreferences: jest.Mock;
}

let clickHandler: ((event: OsNotificationClickEvent) => void) | null = null;
let closeHandler: ((event: OsNotificationCloseEvent) => void) | null = null;
let mockApi: MockApi;
let focusMock: jest.Mock<void, []>;

function installMockWindow(focused: boolean): void {
  clickHandler = null;
  closeHandler = null;
  mockApi = {
    showOsNotification: jest.fn<
      Promise<{ shown: boolean }>,
      [OsNotificationShowRequest]
    >(() => Promise.resolve({ shown: true })),
    onOsNotificationClicked: jest.fn<
      () => void,
      [(event: OsNotificationClickEvent) => void]
    >((cb) => {
      clickHandler = cb;
      return (): void => {
        clickHandler = null;
      };
    }),
    onOsNotificationClosed: jest.fn<
      () => void,
      [(event: OsNotificationCloseEvent) => void]
    >((cb) => {
      closeHandler = cb;
      return (): void => {
        closeHandler = null;
      };
    }),
    loadPreferences: jest.fn(),
  };
  focusMock = jest.fn<void, []>();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: mockApi,
      focus: focusMock,
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      hasFocus: () => focused,
      body: { dataset: { rendererSurface: 'main' } },
    },
  });
}

describe('osNotifications', () => {
  beforeEach(() => {
    installMockWindow(false);
    __resetForTests();
    refreshOsNotificationPrefs(enabledPreferences);
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: undefined,
    });
    __resetForTests();
  });

  it('dispatches a show request through IPC for enabled categories', () => {
    maybeFireOsNotification({
      title: 'Pipeline',
      body: 'Pipeline failed',
      category: 'Pipeline',
      projectId: 'project-a',
      worktreeId: 'worktree-a',
    });

    expect(mockApi.showOsNotification).toHaveBeenCalledTimes(1);
    const [request] = mockApi.showOsNotification.mock.calls[0];
    expect(request.title).toBe('Pipeline');
    expect(request.body).toBe('Pipeline failed');
    expect(typeof request.id).toBe('string');
  });

  it('does not dispatch when the master toggle is off', () => {
    refreshOsNotificationPrefs({ ...enabledPreferences, enabled: false });

    maybeFireOsNotification({
      title: 'Pipeline',
      body: 'Pipeline failed',
      category: 'Pipeline',
    });

    expect(mockApi.showOsNotification).not.toHaveBeenCalled();
  });

  it.each(['Chat', 'Pipeline'] as const)(
    'never delivers a disabled %s completion to the OS',
    (category) => {
      refreshOsNotificationPrefs({ ...enabledPreferences, enabled: false });
      maybeFireOsNotification({
        title: 'Finished',
        body: 'Done',
        category,
        agentCompletion: true,
      });
      expect(mockApi.showOsNotification).not.toHaveBeenCalled();
      expect(mockApi.onOsNotificationClicked).not.toHaveBeenCalled();
      expect(mockApi.loadPreferences).not.toHaveBeenCalled();
    },
  );

  it('delivers enabled completion markers through the unchanged OS payload', () => {
    maybeFireOsNotification({
      title: 'Finished',
      body: 'Done',
      category: 'Chat',
      agentCompletion: true,
    });
    expect(mockApi.showOsNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Finished', body: 'Done' }),
    );
    expect(mockApi.showOsNotification.mock.calls[0][0]).not.toHaveProperty(
      'agentCompletion',
    );
  });

  it('does not dispatch before preferences have been loaded', () => {
    __resetForTests();

    maybeFireOsNotification({
      title: 'Pipeline',
      body: 'Pipeline failed',
      category: 'Pipeline',
    });

    expect(mockApi.showOsNotification).not.toHaveBeenCalled();
  });

  it('does not dispatch when the payload has no category', () => {
    maybeFireOsNotification({
      title: 'Pipeline',
      body: 'Pipeline failed',
    });

    expect(mockApi.showOsNotification).not.toHaveBeenCalled();
  });

  it('does not dispatch when the category is disabled', () => {
    refreshOsNotificationPrefs({
      ...enabledPreferences,
      categories: { ...enabledPreferences.categories, pipeline: false },
    });

    maybeFireOsNotification({
      title: 'Pipeline',
      body: 'Pipeline failed',
      category: 'Pipeline',
    });

    expect(mockApi.showOsNotification).not.toHaveBeenCalled();
  });

  it('suppresses a notification when the window is focused on the same chat', () => {
    installMockWindow(true);
    __resetForTests();
    refreshOsNotificationPrefs({
      ...enabledPreferences,
      skipWhenFocused: true,
    });
    setVisibleContext('project-a/worktree-a', 'chat-a');

    maybeFireOsNotification({
      title: 'Chat',
      body: 'New chat activity',
      category: 'Chat',
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      chatId: 'chat-a',
    });

    expect(mockApi.showOsNotification).not.toHaveBeenCalled();
  });

  it('still fires when focused if viewing a different chat', () => {
    installMockWindow(true);
    __resetForTests();
    refreshOsNotificationPrefs({
      ...enabledPreferences,
      skipWhenFocused: true,
    });
    setVisibleContext('project-a/worktree-a', 'chat-b');

    maybeFireOsNotification({
      title: 'Chat',
      body: 'New chat activity',
      category: 'Chat',
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      chatId: 'chat-a',
    });

    expect(mockApi.showOsNotification).toHaveBeenCalledTimes(1);
  });

  it('lets a payload without chat ids say whether it is on screen', () => {
    installMockWindow(true);
    __resetForTests();
    refreshOsNotificationPrefs({
      ...enabledPreferences,
      skipWhenFocused: true,
    });
    setVisibleContext('project-a/worktree-a', 'chat-a');

    maybeFireOsNotification({
      title: 'App Advisor',
      body: 'New App Advisor activity',
      category: 'Chat',
      visible: false,
    });
    expect(mockApi.showOsNotification).toHaveBeenCalledTimes(1);

    maybeFireOsNotification({
      title: 'App Advisor',
      body: 'New App Advisor activity',
      category: 'Chat',
      visible: true,
    });
    expect(mockApi.showOsNotification).toHaveBeenCalledTimes(1);
  });

  it('invokes the navigation handler when a click event arrives without an explicit onClick', () => {
    const navigate = jest.fn();
    setOsNotificationNavigationHandler(navigate);

    maybeFireOsNotification({
      title: 'Pipeline',
      body: 'Pipeline failed',
      category: 'Pipeline',
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      chatId: 'chat-a',
    });

    const [request] = mockApi.showOsNotification.mock.calls[0];
    clickHandler?.({ id: request.id });

    expect(navigate).toHaveBeenCalledWith({
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      chatId: 'chat-a',
    });
  });

  it('prefers an explicit onClick over the navigation handler', () => {
    const navigate = jest.fn();
    const onClick = jest.fn();
    setOsNotificationNavigationHandler(navigate);

    maybeFireOsNotification({
      title: 'Chat',
      body: 'New chat activity',
      category: 'Chat',
      projectId: 'project-a',
      worktreeId: 'worktree-a',
      onClick,
    });

    const [request] = mockApi.showOsNotification.mock.calls[0];
    clickHandler?.({ id: request.id });

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('discards a pending entry when a close event arrives', () => {
    const onClick = jest.fn();

    maybeFireOsNotification({
      title: 'Chat',
      body: 'New chat activity',
      category: 'Chat',
      onClick,
    });

    const [request] = mockApi.showOsNotification.mock.calls[0];
    closeHandler?.({ id: request.id });
    // Clicks after close should be ignored since the entry has been cleaned up.
    clickHandler?.({ id: request.id });

    expect(onClick).not.toHaveBeenCalled();
  });

  it('fires the test notification regardless of category gates when master toggle is on', async () => {
    const result = await fireTestOsNotification();
    expect(result).toBe('shown');
    expect(mockApi.showOsNotification).toHaveBeenCalledTimes(1);
  });

  it('resolves the category sound when firing a real notification', () => {
    refreshOsNotificationPrefs({
      ...enabledPreferences,
      defaultSound: 'Pop',
      categorySounds: {
        ...enabledPreferences.categorySounds,
        chat: 'Ping',
      },
    });

    maybeFireOsNotification({
      title: 'Chat',
      body: 'New chat activity',
      category: 'Chat',
    });

    const [request] = mockApi.showOsNotification.mock.calls[0];
    expect(request.sound).toBe('Ping');
    expect(request.silent).toBe(false);
  });

  it('falls back to the top-level defaultSound when category sound is Default', () => {
    refreshOsNotificationPrefs({
      ...enabledPreferences,
      defaultSound: 'Submarine',
    });

    maybeFireOsNotification({
      title: 'Pipeline',
      body: 'Done',
      category: 'Pipeline',
    });

    const [request] = mockApi.showOsNotification.mock.calls[0];
    expect(request.sound).toBe('Submarine');
    expect(request.silent).toBe(false);
  });

  it('sets silent=true and omits sound when the category resolves to None', () => {
    refreshOsNotificationPrefs({
      ...enabledPreferences,
      categorySounds: {
        ...enabledPreferences.categorySounds,
        chat: 'None',
      },
    });

    maybeFireOsNotification({
      title: 'Chat',
      body: 'hi',
      category: 'Chat',
    });

    const [request] = mockApi.showOsNotification.mock.calls[0];
    expect(request.silent).toBe(true);
    expect(request.sound).toBeUndefined();
  });

  it('omits sound when the top-level default is System (use OS default)', () => {
    refreshOsNotificationPrefs({
      ...enabledPreferences,
      defaultSound: 'System',
    });

    maybeFireOsNotification({
      title: 'Pipeline',
      body: 'Done',
      category: 'Pipeline',
    });

    const [request] = mockApi.showOsNotification.mock.calls[0];
    expect(request.silent).toBe(false);
    expect(request.sound).toBeUndefined();
  });

  it('fireTestOsNotification applies the provided categoryKey sound', async () => {
    refreshOsNotificationPrefs({
      ...enabledPreferences,
      categorySounds: {
        ...enabledPreferences.categorySounds,
        gitPush: 'Glass',
      },
    });

    await fireTestOsNotification({ categoryKey: 'gitPush' });

    const [request] = mockApi.showOsNotification.mock.calls[0];
    expect(request.sound).toBe('Glass');
  });

  it('fireTestOsNotification respects soundOverride for previewing a choice', async () => {
    await fireTestOsNotification({ soundOverride: 'Hero' });

    const [request] = mockApi.showOsNotification.mock.calls[0];
    expect(request.sound).toBe('Hero');
  });

  it('returns disabled from fireTestOsNotification when master toggle is off', async () => {
    refreshOsNotificationPrefs({ ...enabledPreferences, enabled: false });
    const result = await fireTestOsNotification();
    expect(result).toBe('disabled');
    expect(mockApi.showOsNotification).not.toHaveBeenCalled();
  });

  describe('unmapped categories (no NotificationCategoryKey)', () => {
    const enabledInAppPreferences: InAppNotificationPreferences = {
      enabled: true,
      placement: 'bottom-right',
      categories: {
        chat: true,
        script: true,
        hook: true,
        gitCommit: true,
        gitPush: true,
        prCreate: true,
        pipeline: true,
        terminal: true,
      },
    };

    it('maybeFireOsNotification fails closed for the Automation category', () => {
      maybeFireOsNotification({
        title: 'Automation',
        body: 'Scheduled task automation created',
        category: 'Automation',
      });

      expect(mockApi.showOsNotification).not.toHaveBeenCalled();
    });

    it('maybeFireOsNotification fails closed for the Account category', () => {
      // Signing in happens with the app in the foreground and the modal on
      // screen, so a native banner would be pure noise. `Account` is left out
      // of CATEGORY_TO_PREF_KEY on purpose to guarantee that.
      maybeFireOsNotification({
        title: 'Sign in successful',
        body: "You're connected.",
        category: 'Account',
      });

      expect(mockApi.showOsNotification).not.toHaveBeenCalled();
    });

    it('shouldShowInAppNotification allows the Account category when the master toggle is on', () => {
      refreshInAppNotificationPrefs(enabledInAppPreferences);

      expect(shouldShowInAppNotification('Account')).toBe(true);
    });

    it('does not let a persistent Account toast bypass the master toggle', () => {
      jest.useFakeTimers();
      try {
        refreshInAppNotificationPrefs({
          ...enabledInAppPreferences,
          enabled: false,
        });
        useGitHubStore.setState({ toasts: [], notifications: [] });

        useGitHubStore.getState().addToast('Signed in', 'success', undefined, {
          category: 'Account',
          persistent: true,
        });

        expect(useGitHubStore.getState().toasts).toHaveLength(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it('still surfaces a guest merge failure when the master toggle is off', () => {
      jest.useFakeTimers();
      try {
        refreshInAppNotificationPrefs({
          ...enabledInAppPreferences,
          enabled: false,
        });
        useGitHubStore.setState({ toasts: [], notifications: [] });

        showGuestMergeFailureToast();

        expect(useGitHubStore.getState().toasts).toHaveLength(1);
        expect(useGitHubStore.getState().toasts[0]?.type).toBe('warning');
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not let toast lifetime bypass a per-category toggle', () => {
      jest.useFakeTimers();
      try {
        refreshInAppNotificationPrefs({
          ...enabledInAppPreferences,
          categories: {
            ...enabledInAppPreferences.categories,
            pipeline: false,
          },
        });
        useGitHubStore.setState({ toasts: [], notifications: [] });

        useGitHubStore.getState().addToast('Finished', 'success', undefined, {
          category: 'Pipeline',
          persistent: true,
        });

        expect(useGitHubStore.getState().toasts).toHaveLength(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it('shouldShowInAppNotification allows the Automation category when the master toggle is on', () => {
      refreshInAppNotificationPrefs(enabledInAppPreferences);

      expect(shouldShowInAppNotification('Automation')).toBe(true);
    });

    it('shouldShowInAppNotification still gates the Automation category behind the master toggle', () => {
      refreshInAppNotificationPrefs({
        ...enabledInAppPreferences,
        enabled: false,
      });

      expect(shouldShowInAppNotification('Automation')).toBe(false);
    });

    it('shouldShowInAppNotification still honors per-category toggles for mapped categories', () => {
      refreshInAppNotificationPrefs({
        ...enabledInAppPreferences,
        categories: { ...enabledInAppPreferences.categories, pipeline: false },
      });

      expect(shouldShowInAppNotification('Pipeline')).toBe(false);
      expect(shouldShowInAppNotification('Chat')).toBe(true);
    });
  });
});
