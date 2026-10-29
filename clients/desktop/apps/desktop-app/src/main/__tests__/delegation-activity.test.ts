import {
  LIVE_DELEGATES_REMOVAL_REFUSAL,
  LiveDelegationsError,
  assertNoLiveDelegationsInWorkspace,
  assertNoLiveDelegationsInWorktree,
  chatHasLiveDelegations,
  hasLiveDelegations,
  listDelegationActivity,
  parseDelegationSessionKey,
  setDelegationActivity,
  subscribeDelegationActivity,
  workspaceHasLiveDelegations,
  worktreeHasLiveDelegations,
  type DelegationActivityEntry,
} from '../agents/delegation/activity';

const owners = new Set<string>();

function set(
  owner: string,
  sessionKey: string,
  count: number,
  queued = 0,
): void {
  owners.add(owner);
  setDelegationActivity(owner, sessionKey, count, queued);
}

afterEach((): void => {
  for (const owner of Array.from(owners))
    setDelegationActivity(owner, 'cleanup/cleanup/cleanup', 0, 0);
  owners.clear();
});

describe('delegation activity aggregation', () => {
  it('aggregates every owner of a chat into one entry', (): void => {
    set('owner-a', 'project-a/wt-a/chat-a', 2, 1);
    set('owner-b', 'project-a/wt-a/chat-a', 1, 0);
    set('owner-c', 'project-a/wt-b/chat-b', 0, 3);

    expect(
      listDelegationActivity().sort((left, right) =>
        left.sessionKey.localeCompare(right.sessionKey),
      ),
    ).toEqual([
      { sessionKey: 'project-a/wt-a/chat-a', live: 3, queued: 1 },
      { sessionKey: 'project-a/wt-b/chat-b', live: 0, queued: 3 },
    ]);
  });

  it('omits chats whose delegates have all settled', (): void => {
    set('owner-a', 'project-a/wt-a/chat-a', 1);
    set('owner-a', 'project-a/wt-a/chat-a', 0);

    expect(listDelegationActivity()).toEqual([]);
  });
});

describe('subscribeDelegationActivity', () => {
  it('fires on every aggregate change, including the change to 0/0', (): void => {
    const events: DelegationActivityEntry[] = [];
    const unsubscribe = subscribeDelegationActivity((entry): void => {
      events.push(entry);
    });
    try {
      set('owner-a', 'project-a/wt-a/chat-a', 0, 1);
      set('owner-a', 'project-a/wt-a/chat-a', 1, 0);
      set('owner-b', 'project-a/wt-a/chat-a', 1, 0);
      set('owner-a', 'project-a/wt-a/chat-a', 0, 0);
      set('owner-b', 'project-a/wt-a/chat-a', 0, 0);
    } finally {
      unsubscribe();
    }

    expect(events).toEqual([
      { sessionKey: 'project-a/wt-a/chat-a', live: 0, queued: 1 },
      { sessionKey: 'project-a/wt-a/chat-a', live: 1, queued: 0 },
      { sessionKey: 'project-a/wt-a/chat-a', live: 2, queued: 0 },
      { sessionKey: 'project-a/wt-a/chat-a', live: 1, queued: 0 },
      { sessionKey: 'project-a/wt-a/chat-a', live: 0, queued: 0 },
    ]);
  });

  it('does not fire when the aggregate is unchanged', (): void => {
    const listener = jest.fn();
    set('owner-a', 'project-a/wt-a/chat-a', 1);
    const unsubscribe = subscribeDelegationActivity(listener);
    try {
      set('owner-a', 'project-a/wt-a/chat-a', 1);
      set('owner-z', 'project-z/wt-z/chat-z', 0);
    } finally {
      unsubscribe();
    }
    expect(listener).not.toHaveBeenCalled();
  });

  it('reports both chats when an owner moves between chats', (): void => {
    set('owner-a', 'project-a/wt-a/chat-a', 1);
    const events: DelegationActivityEntry[] = [];
    const unsubscribe = subscribeDelegationActivity((entry): void => {
      events.push(entry);
    });
    try {
      set('owner-a', 'project-a/wt-a/chat-b', 1);
    } finally {
      unsubscribe();
    }
    expect(events).toEqual([
      { sessionKey: 'project-a/wt-a/chat-a', live: 0, queued: 0 },
      { sessionKey: 'project-a/wt-a/chat-b', live: 1, queued: 0 },
    ]);
  });

  it('stops delivering after unsubscribe and survives a failing listener', (): void => {
    const failing = jest.fn((): void => {
      throw new Error('listener failed');
    });
    const healthy = jest.fn();
    const unsubscribeFailing = subscribeDelegationActivity(failing);
    const unsubscribeHealthy = subscribeDelegationActivity(healthy);

    expect((): void =>
      set('owner-a', 'project-a/wt-a/chat-a', 1),
    ).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(hasLiveDelegations('project-a/wt-a/chat-a')).toBe(true);

    unsubscribeFailing();
    unsubscribeHealthy();
    set('owner-a', 'project-a/wt-a/chat-a', 0);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);
  });
});

describe('delegation activity scopes', () => {
  it('parses chat session keys', (): void => {
    expect(parseDelegationSessionKey('project-a/wt-a/chat-a')).toEqual({
      projectId: 'project-a',
      worktreeId: 'wt-a',
      chatId: 'chat-a',
    });
    expect(parseDelegationSessionKey('project-a/wt-a')).toBeNull();
    expect(parseDelegationSessionKey('project-a//chat-a')).toBeNull();
  });

  it('matches chats, worktrees and workspaces by whole id segments', (): void => {
    set('owner-a', 'project-a/wt-a/chat-a', 0, 1);

    expect(chatHasLiveDelegations('project-a', 'wt-a', 'chat-a')).toBe(true);
    expect(chatHasLiveDelegations('project-a', 'wt-a', 'chat-b')).toBe(false);
    expect(worktreeHasLiveDelegations('project-a', 'wt-a')).toBe(true);
    expect(worktreeHasLiveDelegations('project-a', 'wt')).toBe(false);
    expect(worktreeHasLiveDelegations('project-a', 'wt-b')).toBe(false);
    expect(workspaceHasLiveDelegations('project-a')).toBe(true);
    expect(workspaceHasLiveDelegations('project')).toBe(false);
  });

  it('refuses removal with a conflict error while delegates are live', (): void => {
    set('owner-a', 'project-a/wt-a/chat-a', 1);

    const worktreeRefusal = ((): unknown => {
      try {
        assertNoLiveDelegationsInWorktree('project-a', 'wt-a');
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(worktreeRefusal).toBeInstanceOf(LiveDelegationsError);
    expect(worktreeRefusal).toMatchObject({
      code: 'conflict',
      message: LIVE_DELEGATES_REMOVAL_REFUSAL,
    });
    expect((): void => assertNoLiveDelegationsInWorkspace('project-a')).toThrow(
      LIVE_DELEGATES_REMOVAL_REFUSAL,
    );
    expect((): void =>
      assertNoLiveDelegationsInWorktree('project-a', 'wt-b'),
    ).not.toThrow();
    expect((): void =>
      assertNoLiveDelegationsInWorkspace('project-b'),
    ).not.toThrow();
  });
});
