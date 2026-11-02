import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import { showAutomationCreatedToast } from '../automationToasts';
import {
  __resetForTests,
  refreshInAppNotificationPrefs,
  refreshOsNotificationPrefs,
} from '../osNotifications';
import { useGitHubStore } from '@/stores/githubStore';
import { useNavigationStore } from '@/stores/navigationStore';

type AddToast = ReturnType<typeof useGitHubStore.getState>['addToast'];

// Capture the store's real addToast before any test overrides it via
// setState, so the end-to-end pin below exercises the actual in-app /
// OS-notification gating.
const realAddToast: AddToast = useGitHubStore.getState().addToast;

function makeActivity(
  overrides: Partial<ScheduledActivity> = {},
): ScheduledActivity {
  return {
    version: 1,
    id: overrides.id ?? 'activity-1',
    name: overrides.name ?? 'Morning review',
    enabled: overrides.enabled ?? true,
    schedule: overrides.schedule ?? {
      kind: 'one_time',
      runAt: '2026-07-08T09:00:00.000Z',
      timezone: 'local',
    },
    action: overrides.action ?? {
      type: 'app_advisor_prompt',
      prompt: 'Summarize the plan.',
    },
    createdAt: overrides.createdAt ?? '2026-07-08T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-07-08T00:00:00.000Z',
    failureCount: overrides.failureCount ?? 0,
  };
}

describe('showAutomationCreatedToast', () => {
  let addToastMock: jest.Mock<void, Parameters<AddToast>>;

  beforeEach(() => {
    addToastMock = jest.fn<void, Parameters<AddToast>>();
    useGitHubStore.setState({ addToast: addToastMock });
    useNavigationStore.setState({
      activePage: 'overview',
      workflowEdit: undefined,
    });
  });

  it('adds a success toast with an Automation category and the project name', () => {
    const activity = makeActivity();

    showAutomationCreatedToast(activity, 'Canopy');

    expect(addToastMock).toHaveBeenCalledWith(
      'Scheduled task automation created',
      'success',
      expect.any(Function),
      { category: 'Automation', workspaceName: 'Canopy' },
    );
  });

  it('omits the project name when not provided', () => {
    const activity = makeActivity();

    showAutomationCreatedToast(activity);

    expect(addToastMock).toHaveBeenCalledWith(
      'Scheduled task automation created',
      'success',
      expect.any(Function),
      { category: 'Automation', workspaceName: undefined },
    );
  });

  it('the toast onClick opens the automation edit deep link for the created activity', () => {
    const activity = makeActivity({ id: 'activity-42' });

    showAutomationCreatedToast(activity);

    const onClick = addToastMock.mock.calls[0]?.[2];
    onClick?.();

    expect(useNavigationStore.getState().workflowEdit).toEqual({
      kind: 'automation',
      activityId: 'activity-42',
    });
    expect(useNavigationStore.getState().activePage).toBe('workflows-library');
  });
});

describe('showAutomationCreatedToast end-to-end gating', () => {
  let showOsNotificationMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    showOsNotificationMock = jest.fn(() => Promise.resolve({ shown: true }));
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { api: { showOsNotification: showOsNotificationMock } },
    });
    __resetForTests();
    refreshInAppNotificationPrefs({
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
        runComment: true,
        activation: true,
      },
    });
    refreshOsNotificationPrefs({
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
        runComment: true,
        activation: true,
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
        runComment: 'Default',
        activation: 'Default',
      },
    });
    useGitHubStore.setState({
      addToast: realAddToast,
      toasts: [],
      notifications: [],
    });
    useNavigationStore.setState({
      activePage: 'overview',
      workflowEdit: undefined,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    __resetForTests();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: undefined,
    });
  });

  it('renders the Automation toast in-app and fires no OS notification', () => {
    showAutomationCreatedToast(makeActivity(), 'Canopy');

    const { toasts, notifications } = useGitHubStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.message).toBe('Scheduled task automation created');
    expect(toasts[0]?.meta?.category).toBe('Automation');
    expect(notifications).toHaveLength(1);
    expect(showOsNotificationMock).not.toHaveBeenCalled();
  });
});
