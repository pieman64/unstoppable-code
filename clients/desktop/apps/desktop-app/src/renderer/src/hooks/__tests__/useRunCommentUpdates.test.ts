/*
 * `useRunCommentUpdates` is invoked directly by the `subscribe()` harness below
 * rather than from inside a rendered component. React is mocked down to a
 * pass-through `useEffect`, so the rules-of-hooks ordering guarantees this rule
 * protects do not apply here.
 */
/* eslint-disable react-hooks/rules-of-hooks */
import type { RunCommentsUpdatedEvent } from '@canopy/desktop-shared/types';

/** The subset of the OS notification payload this hook is contracted to send. */
interface RunCommentNotificationPayload {
  category: string;
  title: string;
  body: string;
  projectId: string;
  worktreeId: string;
  chatId: string;
  onClick?: () => void;
}

interface ChatStoreTestState {
  worktreeChats: Record<string, { tabs: unknown[] }>;
  setSharedRun: jest.Mock<void, [string, string, string, unknown]>;
}

// The hook only needs `useEffect` to run its body once; the surrounding React
// tree is irrelevant to the contract under test (fold the poll into the tab's
// SharedRunMetadata, notify exactly once, never for your own comment).
jest.mock('react', () => ({
  useEffect: (fn: () => void | (() => void)): void => {
    fn();
  },
}));

const maybeFireOsNotificationMock = jest.fn<
  void,
  [RunCommentNotificationPayload]
>();
jest.mock('@/lib/osNotifications', () => ({
  maybeFireOsNotification: (payload: RunCommentNotificationPayload): void => {
    maybeFireOsNotificationMock(payload);
  },
}));

const openRunCommentsMock = jest.fn<void, [unknown]>();
jest.mock('@/stores/runCommentsStore', () => ({
  openRunComments: (target: unknown): void => {
    openRunCommentsMock(target);
  },
}));

const setSharedRunMock = jest.fn<void, [string, string, string, unknown]>();
let storeState: ChatStoreTestState;
jest.mock('@/stores/chatStore', () => ({
  useChatStore: { getState: (): ChatStoreTestState => storeState },
}));

import { useRunCommentUpdates } from '../useRunCommentUpdates';

const SHARED_RUN = {
  externalId: 'run-ext-1',
  shareScope: 'organization' as const,
  sharedAt: '2026-08-01T00:00:00.000Z',
  commentRevision: 3,
  unreadCommentCount: 0,
};

function makeEvent(
  overrides: Partial<RunCommentsUpdatedEvent> = {},
): RunCommentsUpdatedEvent {
  return {
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat-1',
    externalId: 'run-ext-1',
    commentRevision: 5,
    lastSeenCommentRevision: 3,
    unreadCommentCount: 2,
    ownCommentsOnly: false,
    ...overrides,
  };
}

/** Runs the hook and returns the handler main would invoke on a poll tick. */
function subscribe(): (event: RunCommentsUpdatedEvent) => void {
  let handler: ((event: RunCommentsUpdatedEvent) => void) | null = null;
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: {
      api: {
        runs: {
          onCommentsUpdated: (
            cb: (event: RunCommentsUpdatedEvent) => void,
          ): (() => void) => {
            handler = cb;
            return (): void => {};
          },
        },
      },
    },
  });
  useRunCommentUpdates();
  if (!handler) {
    throw new Error('expected the hook to subscribe');
  }
  return handler;
}

describe('useRunCommentUpdates', () => {
  beforeEach(() => {
    maybeFireOsNotificationMock.mockReset();
    openRunCommentsMock.mockReset();
    setSharedRunMock.mockReset();
    storeState = {
      worktreeChats: {
        'project/worktree': {
          tabs: [
            {
              id: 'chat-1',
              kind: 'chat',
              title: 'Punchier hero headline',
              sharedRun: SHARED_RUN,
            },
          ],
        },
      },
      setSharedRun: setSharedRunMock,
    };
  });

  it('folds the polled revision and unread count onto the tab metadata', () => {
    subscribe()(makeEvent());

    expect(setSharedRunMock).toHaveBeenCalledWith(
      'project',
      'worktree',
      'chat-1',
      { ...SHARED_RUN, commentRevision: 5, unreadCommentCount: 2 },
    );
  });

  it('fires one OS notification under the run-comment category', () => {
    subscribe()(makeEvent());

    expect(maybeFireOsNotificationMock).toHaveBeenCalledTimes(1);
    const payload = maybeFireOsNotificationMock.mock.calls[0]?.[0];
    if (!payload) {
      throw new Error('expected a notification payload');
    }
    // A category without a CATEGORY_TO_PREF_KEY entry fails closed and never
    // fires, so the exact string matters.
    expect(payload).toMatchObject({
      category: 'Run Comment',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat-1',
    });
    expect(payload.body).toContain('2 new comments');
  });

  it('never notifies for the viewer’s own comments', () => {
    subscribe()(makeEvent({ ownCommentsOnly: true }));

    // The badge still updates — only the interruption is suppressed.
    expect(setSharedRunMock).toHaveBeenCalledTimes(1);
    expect(maybeFireOsNotificationMock).not.toHaveBeenCalled();
  });

  it('does not notify for an empty batch', () => {
    subscribe()(makeEvent({ unreadCommentCount: 0 }));

    expect(maybeFireOsNotificationMock).not.toHaveBeenCalled();
  });

  it('ignores an event for a chat that is no longer shared', () => {
    storeState.worktreeChats['project/worktree'] = {
      tabs: [{ id: 'chat-1', kind: 'chat', title: 'x' }],
    };

    subscribe()(makeEvent());

    expect(setSharedRunMock).not.toHaveBeenCalled();
    expect(maybeFireOsNotificationMock).not.toHaveBeenCalled();
  });

  it('opens the comments panel when the notification is clicked', () => {
    subscribe()(makeEvent());

    maybeFireOsNotificationMock.mock.calls[0]?.[0]?.onClick?.();
    expect(openRunCommentsMock).toHaveBeenCalledWith({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat-1',
      title: 'Punchier hero headline',
    });
  });
});
