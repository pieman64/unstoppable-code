import {
  buildSidebarChatSearchCandidates,
  filterSidebarChatSearchResults,
  type SidebarChatSearchWorkspace,
  type SidebarChatSearchResult,
  type SidebarChatSearchStandaloneChat,
} from '../sidebar-chat-search-model';

describe('buildSidebarChatSearchCandidates', () => {
  const workspaces: SidebarChatSearchWorkspace[] = [
    { localId: 'repo-b', name: 'Repo B', order: 1, type: 'single-repo' },
    { localId: 'repo-a', name: 'Repo A', order: 0, type: 'multi-repo' },
    { localId: 'cowork', name: 'Cowork', order: 2, type: 'cowork' },
  ];
  const worktrees = [
    {
      localId: 'tree-a1',
      workspaceLocalId: 'repo-a',
      branch: 'feature/one',
      label: 'One',
    },
    { localId: 'tree-b1', workspaceLocalId: 'repo-b', branch: 'feature/two' },
  ];

  it('joins worktree chats with project and worktree display names in sidebar order', () => {
    const candidates = buildSidebarChatSearchCandidates({
      workspaces,
      worktrees,
      standaloneChats: [],
      worktreeChats: [
        {
          chatId: 'chat-b',
          title: 'Chat B',
          workspaceLocalId: 'repo-b',
          worktreeLocalId: 'tree-b1',
        },
        {
          chatId: 'chat-a',
          title: 'Chat A',
          workspaceLocalId: 'repo-a',
          worktreeLocalId: 'tree-a1',
        },
      ],
    });

    expect(candidates).toEqual([
      {
        kind: 'worktree-chat',
        workspaceLocalId: 'repo-a',
        workspaceName: 'Repo A',
        worktreeLocalId: 'tree-a1',
        worktreeName: 'One',
        chatId: 'chat-a',
        title: 'Chat A',
      },
      {
        kind: 'worktree-chat',
        workspaceLocalId: 'repo-b',
        workspaceName: 'Repo B',
        worktreeLocalId: 'tree-b1',
        worktreeName: 'feature/two',
        chatId: 'chat-b',
        title: 'Chat B',
      },
    ]);
  });

  it('orders chats within a worktree by order, then createdAt, then chatId', () => {
    const candidates = buildSidebarChatSearchCandidates({
      workspaces,
      worktrees,
      standaloneChats: [],
      worktreeChats: [
        {
          chatId: 'later',
          title: 'Later tab',
          workspaceLocalId: 'repo-a',
          worktreeLocalId: 'tree-a1',
          order: 1,
        },
        {
          chatId: 'unordered',
          title: 'Optimistic tab',
          workspaceLocalId: 'repo-a',
          worktreeLocalId: 'tree-a1',
        },
        {
          chatId: 'first',
          title: 'First tab',
          workspaceLocalId: 'repo-a',
          worktreeLocalId: 'tree-a1',
          order: 0,
        },
      ],
    });

    expect(candidates.map((candidate) => candidate.chatId)).toEqual([
      'first',
      'later',
      'unordered',
    ]);
  });

  it('finds Cowork custom names and follows the generated name after clearing', () => {
    const chat = {
      localId: 'cw-1',
      projectLocalId: 'cowork',
      title: 'New Chat',
      customTitle: 'Release notes',
      description: 'Generated name',
    };
    const candidates = (
      standaloneChat: SidebarChatSearchStandaloneChat,
    ): SidebarChatSearchResult[] =>
      buildSidebarChatSearchCandidates({
        workspaces,
        worktrees: [],
        standaloneChats: [standaloneChat],
        worktreeChats: [],
      });
    expect(
      filterSidebarChatSearchResults(candidates(chat), 'release notes')[0]
        ?.title,
    ).toBe('Release notes');
    const cleared = {
      localId: 'cw-1',
      projectLocalId: 'cowork',
      title: 'New Chat',
      description: 'Latest generated name',
    };
    expect(
      filterSidebarChatSearchResults(candidates(cleared), 'latest generated')[0]
        ?.title,
    ).toBe('Latest generated name');
    expect(
      filterSidebarChatSearchResults(candidates(cleared), 'release notes'),
    ).toEqual([]);
  });

  it('groups cowork chats under their project and assigns orphans to the primary cowork project', () => {
    const candidates = buildSidebarChatSearchCandidates({
      workspaces,
      worktrees: [],
      standaloneChats: [
        { localId: 'cw-1', projectLocalId: 'cowork', title: 'Cowork chat' },
        { localId: 'cw-2', title: 'Legacy chat' },
        {
          localId: 'cw-3',
          projectLocalId: 'cowork',
          title: 'Archived chat',
          archived: true,
        },
      ],
      worktreeChats: [],
    });

    expect(candidates).toEqual([
      {
        kind: 'standalone-chat',
        workspaceLocalId: 'cowork',
        workspaceName: 'Cowork',
        chatId: 'cw-1',
        title: 'Cowork chat',
      },
      {
        kind: 'standalone-chat',
        workspaceLocalId: 'cowork',
        workspaceName: 'Cowork',
        chatId: 'cw-2',
        title: 'Legacy chat',
      },
    ]);
  });

  // REG-2819. A cloud workspace classifies as `cowork` but keeps its chats in
  // `worktrees`. If ownership of unparented standalone chats were keyed to
  // `type`, a cloud workspace ordered first would win the primary election and
  // silently absorb desktop's legacy chats — mislabeling them in search and
  // stealing them from the workspace that actually holds them.
  it('never lets a tree-layout cloud project own unparented standalone chats', () => {
    const candidates = buildSidebarChatSearchCandidates({
      workspaces: [
        {
          localId: 'cloud',
          name: 'Cloud',
          order: 0,
          type: 'cowork',
          layout: 'tree',
        },
        ...workspaces,
      ],
      worktrees: [
        {
          localId: 'cloud-task',
          workspaceLocalId: 'cloud',
          branch: 'cloud',
          label: 'Cloud task',
        },
      ],
      standaloneChats: [{ localId: 'cw-2', title: 'Legacy chat' }],
      worktreeChats: [
        {
          chatId: 'cloud-chat',
          title: 'Cloud chat',
          workspaceLocalId: 'cloud',
          worktreeLocalId: 'cloud-task',
        },
      ],
    });

    // The cloud workspace contributes a WORKTREE chat, not a standalone one.
    expect(candidates).toContainEqual({
      kind: 'worktree-chat',
      workspaceLocalId: 'cloud',
      workspaceName: 'Cloud',
      worktreeLocalId: 'cloud-task',
      worktreeName: 'Cloud task',
      chatId: 'cloud-chat',
      title: 'Cloud chat',
    });
    // The orphan still belongs to the flat desktop cowork workspace.
    expect(candidates).toContainEqual({
      kind: 'standalone-chat',
      workspaceLocalId: 'cowork',
      workspaceName: 'Cowork',
      chatId: 'cw-2',
      title: 'Legacy chat',
    });
  });

  it('does not use a synthetic branch as cowork session search copy', () => {
    const candidates = buildSidebarChatSearchCandidates({
      workspaces: [
        {
          localId: 'cloud',
          name: 'Cloud',
          type: 'cowork',
          layout: 'tree',
        },
      ],
      worktrees: [
        {
          localId: 'cloud-task',
          workspaceLocalId: 'cloud',
          branch: 'cloud',
        },
      ],
      standaloneChats: [],
      worktreeChats: [
        {
          chatId: 'cloud-chat',
          title: 'Cloud chat',
          workspaceLocalId: 'cloud',
          worktreeLocalId: 'cloud-task',
        },
      ],
    });

    expect(candidates).toContainEqual({
      kind: 'worktree-chat',
      workspaceLocalId: 'cloud',
      workspaceName: 'Cloud',
      worktreeLocalId: 'cloud-task',
      worktreeName: 'Session',
      chatId: 'cloud-chat',
      title: 'Cloud chat',
    });
  });

  it('falls back to the Default folder name when no cowork project exists', () => {
    const candidates = buildSidebarChatSearchCandidates({
      workspaces: workspaces.filter((workspace) => workspace.type !== 'cowork'),
      worktrees: [],
      standaloneChats: [{ localId: 'cw-1', title: 'Orphan chat' }],
      worktreeChats: [],
    });

    expect(candidates).toEqual([
      {
        kind: 'standalone-chat',
        workspaceLocalId: undefined,
        workspaceName: 'Default',
        chatId: 'cw-1',
        title: 'Orphan chat',
      },
    ]);
  });

  it('keeps project-bound chats searchable in the Default folder fallback', () => {
    // With no cowork workspace, the flat Default sidebar section shows EVERY
    // non-archived standalone chat regardless of projectLocalId
    // (StandaloneChatsSidebarSection: `if (!project?.localId) return true`).
    // Search must cover that same inventory.
    const candidates = buildSidebarChatSearchCandidates({
      workspaces: workspaces.filter((workspace) => workspace.type !== 'cowork'),
      worktrees: [],
      standaloneChats: [
        { localId: 'cw-1', title: 'Orphan chat' },
        {
          localId: 'cw-2',
          projectLocalId: 'gone-workspace',
          title: 'Project-bound chat',
        },
        {
          localId: 'cw-3',
          projectLocalId: 'gone-workspace',
          title: 'Archived chat',
          archived: true,
        },
      ],
      worktreeChats: [],
    });

    expect(candidates).toEqual([
      {
        kind: 'standalone-chat',
        workspaceLocalId: undefined,
        workspaceName: 'Default',
        chatId: 'cw-1',
        title: 'Orphan chat',
      },
      {
        kind: 'standalone-chat',
        workspaceLocalId: undefined,
        workspaceName: 'Default',
        chatId: 'cw-2',
        title: 'Project-bound chat',
      },
    ]);
  });

  it('drops worktree chats whose project or worktree is no longer in the snapshot', () => {
    const candidates = buildSidebarChatSearchCandidates({
      workspaces,
      worktrees,
      standaloneChats: [],
      worktreeChats: [
        {
          chatId: 'ghost',
          title: 'Ghost chat',
          workspaceLocalId: 'repo-a',
          worktreeLocalId: 'gone-tree',
        },
        { chatId: 'no-ids', title: 'No ids chat' },
      ],
    });

    expect(candidates).toEqual([]);
  });
});

describe('filterSidebarChatSearchResults', () => {
  const candidates: SidebarChatSearchResult[] = [
    {
      kind: 'worktree-chat',
      workspaceLocalId: 'repo-a',
      workspaceName: 'Repo A',
      worktreeLocalId: 'tree-a1',
      worktreeName: 'One',
      chatId: 'chat-a',
      title: 'Fix the flaky Test',
    },
    {
      kind: 'standalone-chat',
      workspaceLocalId: 'cowork',
      workspaceName: 'Cowork',
      chatId: 'cw-1',
      title: 'Roadmap brainstorm',
    },
  ];

  it('matches chat titles case-insensitively', () => {
    expect(
      filterSidebarChatSearchResults(candidates, 'FLAKY test').map(
        (result) => result.chatId,
      ),
    ).toEqual(['chat-a']);
  });

  it('trims the query and returns nothing for a blank query', () => {
    expect(filterSidebarChatSearchResults(candidates, '   ')).toEqual([]);
    expect(
      filterSidebarChatSearchResults(candidates, ' roadmap ').map(
        (result) => result.chatId,
      ),
    ).toEqual(['cw-1']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterSidebarChatSearchResults(candidates, 'zzz')).toEqual([]);
  });
});
