import {
  buildSidebarActivitySnapshot,
  sidebarActivityStandaloneChatKey,
  sidebarActivityWorktreeChatKey,
  type SidebarActivityBuildInput,
  type SidebarActivityInventory,
} from '../sidebar-activity-mode-model';

type Inventory = {
  -readonly [K in keyof SidebarActivityInventory]: SidebarActivityInventory[K][number][];
};

function inventory(): Inventory {
  return {
    workspaces: [
      { localId: 'ws-a', name: 'Alpha', type: 'single-repo' },
      {
        localId: 'ws-m',
        name: 'Multi',
        type: 'multi-repo',
        repos: [
          { id: 'repo-1', name: 'api', repoPath: '/x/api' },
          { id: 'repo-2', name: 'web', repoPath: '/x/web' },
        ],
      },
      { localId: 'cw', name: 'Chats', type: 'cowork' },
      {
        localId: 'ws-hidden',
        name: 'Hidden',
        type: 'single-repo',
        hidden: true,
      },
    ],
    worktrees: [
      { localId: 'wt-1', workspaceLocalId: 'ws-a', branch: 'feat/one' },
      { localId: 'wt-2', workspaceLocalId: 'ws-m', branch: 'feat/two' },
      {
        localId: 'wt-hidden',
        workspaceLocalId: 'ws-a',
        branch: 'hidden',
        hidden: true,
      },
      { localId: 'wt-h', workspaceLocalId: 'ws-hidden', branch: 'h' },
    ],
    standaloneChats: [],
    chatSummaries: [],
  };
}

function summary(
  chatId: string,
  extra: Partial<Inventory['chatSummaries'][number]> = {},
): Inventory['chatSummaries'][number] {
  return {
    chatId,
    scope: 'worktree',
    workspaceLocalId: 'ws-a',
    worktreeLocalId: 'wt-1',
    title: `Chat ${chatId}`,
    lastMessageRole: 'assistant',
    lastMessageAt: '2026-10-01T10:00:00.000Z',
    ...extra,
  };
}

function standalone(
  localId: string,
  extra: Partial<Inventory['standaloneChats'][number]> = {},
): Inventory['standaloneChats'][number] {
  return {
    localId,
    projectLocalId: 'cw',
    title: `Cowork ${localId}`,
    lastMessageRole: 'assistant',
    lastMessageAt: '2026-10-01T10:00:00.000Z',
    ...extra,
  };
}

const wtKey = (chatId: string, wt = 'wt-1', ws = 'ws-a'): string =>
  sidebarActivityWorktreeChatKey(ws, wt, chatId);

function keys(list: readonly { key: string }[]): string[] {
  return list.map((entry) => entry.key);
}

describe('buildSidebarActivitySnapshot', () => {
  it('uses projected unread without a host override and honors an authoritative empty host set', () => {
    const inv = inventory();
    inv.chatSummaries.push(summary('projected', { hasUnread: true }));
    inv.standaloneChats.push(standalone('stale', { hasUnread: true }));
    expect(
      buildSidebarActivitySnapshot({ inventory: inv }).unread,
    ).toHaveLength(2);
    const read = buildSidebarActivitySnapshot({
      inventory: inv,
      unreadKeys: new Set(),
    });
    expect(read.unread).toHaveLength(0);
    expect(read.unreplied).toHaveLength(2);
  });

  it('rejects malformed scope identities even for unread projections', () => {
    const inv = inventory();
    inv.chatSummaries.push(summary('../escape', { hasUnread: true }));
    inv.standaloneChats.push(standalone('bad/id', { hasUnread: true }));
    expect(buildSidebarActivitySnapshot({ inventory: inv })).toEqual({
      unread: [],
      drafts: [],
      unreplied: [],
    });
  });

  it('applies Unread > Drafts > Unreplied precedence with one row per chat', () => {
    const inv = inventory();
    inv.chatSummaries.push(
      summary('all'),
      summary('draft-reply'),
      summary('reply'),
      summary('user-last', { lastMessageRole: 'user' }),
    );
    const snapshot = buildSidebarActivitySnapshot({
      inventory: inv,
      unreadKeys: new Set([wtKey('all')]),
      draftKeys: new Set([
        wtKey('all'),
        wtKey('draft-reply'),
        wtKey('user-last'),
      ]),
    });
    expect(keys(snapshot.unread)).toEqual([wtKey('all')]);
    expect(keys(snapshot.drafts).sort()).toEqual(
      [wtKey('draft-reply'), wtKey('user-last')].sort(),
    );
    expect(keys(snapshot.unreplied)).toEqual([wtKey('reply')]);
  });

  it('treats an unknown role or an active turn as not Unreplied', () => {
    const inv = inventory();
    inv.chatSummaries.push(
      summary('unknown', { lastMessageRole: undefined }),
      summary('running', { turnActive: true }),
    );
    inv.standaloneChats.push(
      standalone('busy', { hasActiveChat: true }),
      standalone('legacy', { lastMessageRole: undefined }),
    );
    const snapshot = buildSidebarActivitySnapshot({ inventory: inv });
    expect(snapshot.unreplied).toEqual([]);
  });

  it('keeps an active turn eligible for Unread and Drafts', () => {
    const inv = inventory();
    inv.chatSummaries.push(summary('running', { turnActive: true }));
    inv.standaloneChats.push(
      standalone('busy', { hasActiveChat: true, hasUnread: true }),
    );
    const snapshot = buildSidebarActivitySnapshot({
      inventory: inv,
      draftKeys: new Set([wtKey('running')]),
    });
    expect(keys(snapshot.drafts)).toEqual([wtKey('running')]);
    expect(keys(snapshot.unread)).toEqual([
      sidebarActivityStandaloneChatKey('cw', 'busy'),
    ]);
  });

  it('excludes archived, hidden, missing-parent, invalid, and unsupported chats', () => {
    const inv = inventory();
    inv.chatSummaries.push(
      summary('hidden-wt', { worktreeLocalId: 'wt-hidden' }),
      summary('hidden-ws', {
        workspaceLocalId: 'ws-hidden',
        worktreeLocalId: 'wt-h',
      }),
      summary('missing-wt', { worktreeLocalId: 'nope' }),
      summary('', {}),
      summary('advisor', { scope: 'app_advisor' }),
      summary('standalone-scope', { scope: 'standalone' }),
    );
    inv.standaloneChats.push(
      standalone('archived', { archived: true }),
      standalone('orphan', { projectLocalId: 'missing' }),
      standalone('wrong-parent', { projectLocalId: 'ws-a' }),
      standalone(' '),
    );
    const snapshot = buildSidebarActivitySnapshot({
      inventory: inv,
      unreadKeys: new Set([wtKey('hidden-wt', 'wt-hidden')]),
    });
    expect(snapshot).toEqual({ unread: [], drafts: [], unreplied: [] });
  });

  it('captures worktree context, repository fallback, and Cowork context', () => {
    const inv = inventory();
    inv.chatSummaries.push(
      summary('one', { customTitle: 'Renamed', title: 'Generated' }),
      summary('multi', {
        workspaceLocalId: 'ws-m',
        worktreeLocalId: 'wt-2',
        selectedRepoId: 'repo-2',
      }),
      summary('multi-unknown-repo', {
        workspaceLocalId: 'ws-m',
        worktreeLocalId: 'wt-2',
        selectedRepoId: 'gone',
      }),
    );
    inv.standaloneChats.push(standalone('c1', { customTitle: '  ' }));
    const snapshot = buildSidebarActivitySnapshot({
      inventory: inv,
      worktreeLabel: (workspace, worktree) =>
        `${workspace.name}:${worktree.branch}`,
    });
    const byChat = new Map(
      snapshot.unreplied.map((entry) => [entry.chatId, entry]),
    );
    expect(byChat.get('one')).toMatchObject({
      kind: 'worktree-chat',
      title: 'Renamed',
      branchLabel: 'Alpha:feat/one',
      repositoryName: 'Alpha',
      workspaceLocalId: 'ws-a',
      worktreeLocalId: 'wt-1',
    });
    expect(byChat.get('multi')).toMatchObject({ repositoryName: 'web' });
    expect(byChat.get('multi-unknown-repo')).toMatchObject({
      repositoryName: 'Multi',
    });
    expect(byChat.get('c1')).toMatchObject({
      kind: 'standalone-chat',
      title: 'Cowork c1',
      projectLocalId: 'cw',
      workspaceName: 'Chats',
    });
  });

  it('defaults the worktree label to the branch', () => {
    const inv = inventory();
    inv.chatSummaries.push(summary('one'));
    const [entry] = buildSidebarActivitySnapshot({ inventory: inv }).unreplied;
    expect(entry).toMatchObject({ branchLabel: 'feat/one' });
  });

  it('keeps the same chat id in two worktrees as two rows', () => {
    const inv = inventory();
    inv.worktrees.push({
      localId: 'wt-3',
      workspaceLocalId: 'ws-a',
      branch: 'b',
    });
    inv.chatSummaries.push(
      summary('same'),
      summary('same', { worktreeLocalId: 'wt-3' }),
    );
    const snapshot = buildSidebarActivitySnapshot({ inventory: inv });
    expect(snapshot.unreplied).toHaveLength(2);
  });

  it('collapses duplicate projections without losing unread state', () => {
    const inv = inventory();
    inv.standaloneChats.push(
      standalone('dup', {
        hasUnread: true,
        lastMessageAt: '2026-10-01T09:00:00Z',
      }),
      standalone('dup', {
        title: 'Newer',
        lastMessageAt: '2026-10-01T11:00:00Z',
      }),
    );
    const snapshot = buildSidebarActivitySnapshot({ inventory: inv });
    expect(snapshot.unread).toHaveLength(1);
    expect(snapshot.unread[0]).toMatchObject({
      title: 'Newer',
      section: 'unread',
    });
    expect(snapshot.unreplied).toEqual([]);
  });

  it('orders by recency across offsets, missing times last, ties by key', () => {
    const inv = inventory();
    inv.chatSummaries.push(
      summary('utc', { lastMessageAt: '2026-10-01T10:00:00Z' }),
      // 09:30 UTC — older despite the later wall-clock digits.
      summary('offset', { lastMessageAt: '2026-10-01T12:30:00+03:00' }),
      summary('created-only', {
        lastMessageAt: undefined,
        createdAt: '2026-10-01T11:00:00Z',
      }),
      summary('invalid', { lastMessageAt: 'not a date' }),
      summary('missing', { lastMessageAt: undefined }),
      summary('tie-b', { lastMessageAt: '2026-09-01T00:00:00Z' }),
      summary('tie-a', { lastMessageAt: '2026-09-01T00:00:00.000+00:00' }),
    );
    const snapshot = buildSidebarActivitySnapshot({ inventory: inv });
    expect(snapshot.unreplied.map((entry) => entry.chatId)).toEqual([
      'created-only',
      'utc',
      'offset',
      'tie-a',
      'tie-b',
      'invalid',
      'missing',
    ]);
  });

  it('is deterministic and leaves inputs and results immutable', () => {
    const inv = inventory();
    inv.chatSummaries.push(summary('b'), summary('a'));
    const frozenCopy = JSON.stringify(inv);
    const input: SidebarActivityBuildInput = { inventory: inv };
    const first = buildSidebarActivitySnapshot(input);
    const second = buildSidebarActivitySnapshot(input);
    expect(first).toEqual(second);
    expect(JSON.stringify(inv)).toBe(frozenCopy);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.unreplied)).toBe(true);
    expect(Object.isFrozen(first.unreplied[0])).toBe(true);
  });

  it('keys cannot collide through delimiters in ids', () => {
    expect(sidebarActivityWorktreeChatKey('a/b', 'c', 'd')).not.toBe(
      sidebarActivityWorktreeChatKey('a', 'b/c', 'd'),
    );
    expect(sidebarActivityStandaloneChatKey('a', 'b')).not.toBe(
      sidebarActivityWorktreeChatKey('a', 'b', ''),
    );
  });
});
