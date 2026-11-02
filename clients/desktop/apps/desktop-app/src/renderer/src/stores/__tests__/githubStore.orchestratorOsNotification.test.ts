import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import type * as OsNotifications from '@/lib/osNotifications';
import { useGitHubStore } from '@/stores/githubStore';

const maybeFireOsNotificationMock = jest.fn<void, unknown[]>();

jest.mock('@/lib/osNotifications', () => ({
  ...jest.requireActual<typeof OsNotifications>('@/lib/osNotifications'),
  maybeFireOsNotification: (...args: unknown[]): void => {
    maybeFireOsNotificationMock(...args);
  },
  shouldShowInAppNotification: (): boolean => false,
}));

function firedTitle(): unknown {
  const call: unknown[] | undefined =
    maybeFireOsNotificationMock.mock.calls.at(-1);
  const payload: unknown = call?.[0];
  return typeof payload === 'object' && payload !== null && 'title' in payload
    ? payload.title
    : undefined;
}

describe('githubStore OS notification title for Orchestrator chats', () => {
  beforeEach(() => {
    maybeFireOsNotificationMock.mockClear();
  });

  it.each([ORCHESTRATOR_LABEL, 'App Advisor'])(
    'titles a chat toast from workspace %p with the current name',
    (workspaceName) => {
      useGitHubStore.getState().addToast('Reply ready', 'info', undefined, {
        category: 'Chat',
        workspaceName,
        title: 'Some chat',
      });

      expect(firedTitle()).toBe(ORCHESTRATOR_LABEL);
    },
  );

  it('keeps the toast title for other workspaces', () => {
    useGitHubStore.getState().addToast('Reply ready', 'info', undefined, {
      category: 'Chat',
      workspaceName: 'Acme',
      title: 'Some chat',
    });

    expect(firedTitle()).toBe('Some chat');
  });

  it('keeps the toast title for a project that is named Orchestrator', () => {
    useGitHubStore.getState().addToast('Reply ready', 'info', undefined, {
      category: 'Chat',
      workspaceName: 'orchestrator',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      title: 'Some chat',
    });

    expect(firedTitle()).toBe('Some chat');
  });
});
