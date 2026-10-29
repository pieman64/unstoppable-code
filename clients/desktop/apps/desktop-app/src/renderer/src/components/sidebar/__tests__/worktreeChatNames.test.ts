import type { SidebarItem } from '@canopy/desktop-shared/types';
import {
  deriveWorktreeRowNaming,
  deriveWorktreeRowNamings,
  liveWorktreeChatNames,
} from '../worktreeChatNames';

const projects: SidebarItem[] = [
  {
    type: 'single-repo',
    id: 'p',
    name: 'Project',
    repoPath: '/repo',
    color: '#000',
    collapsed: false,
    order: 0,
    worktrees: [
      {
        id: 'stored',
        branchName: 'dz/stored',
        createdAt: 'c',
        chatBadges: {
          version: 2,
          chatName: 'Saved name',
          unreadChats: [],
          approvalChats: [],
          needsHydration: false,
          updatedAt: 'u',
        },
      },
      {
        id: 'live',
        branchName: 'dz/live',
        createdAt: 'c',
        chatBadges: {
          version: 2,
          chatName: 'Stale saved name',
          unreadChats: [],
          approvalChats: [],
          needsHydration: false,
          updatedAt: 'u',
        },
      },
      {
        id: 'labeled',
        branchName: 'dz/labeled',
        createdAt: 'c',
        label: 'Mine',
      },
    ],
  },
];

describe('worktree chat names', () => {
  it('uses a loaded custom chat name without overriding an explicit worktree label', () => {
    const live = liveWorktreeChatNames({
      'p/live': {
        tabs: [
          {
            title: 'Original',
            description: 'Generated',
            customTitle: 'Mine',
            createdAt: '2026-10-01',
          },
        ],
      },
      'p/labeled': {
        tabs: [
          {
            title: 'Original',
            customTitle: 'Chat name',
            createdAt: '2026-10-01',
          },
        ],
      },
    });
    const names = deriveWorktreeRowNamings(live, projects);
    expect(names['p/live']).toEqual({ title: 'Mine' });
    expect(names['p/labeled']).toEqual({
      title: undefined,
    });
  });

  it('prefers loaded chat tabs over the saved summary', () => {
    const live = liveWorktreeChatNames({
      'p/live': {
        tabs: [
          {
            title: 'add dark mode',
            description: 'Add dark mode',
            createdAt: '2026-10-01T00:00:00.000Z',
          },
        ],
      },
    });
    expect(deriveWorktreeRowNamings(live, projects)).toEqual({
      'p/stored': { title: 'Saved name' },
      'p/live': { title: 'Add dark mode' },
      'p/labeled': { title: undefined },
    });
  });

  it('trusts a loaded worktree whose chats are still unnamed', () => {
    const live = liveWorktreeChatNames({
      'p/live': {
        tabs: [{ title: 'New chat', createdAt: '2026-10-01T00:00:00.000Z' }],
      },
    });
    expect(deriveWorktreeRowNamings(live, projects)['p/live']).toEqual({
      title: undefined,
    });
  });

  it('titles a row with its chat name, leaving the subtitle to the worktree name', () => {
    expect(
      deriveWorktreeRowNaming({
        storedLabel: undefined,
        chatName: 'Add dark mode',
      }),
    ).toEqual({ title: 'Add dark mode' });
    // A label the user set still wins over the chat name.
    expect(
      deriveWorktreeRowNaming({
        storedLabel: 'Mine',
        chatName: 'Add dark mode',
      }),
    ).toEqual({ title: undefined });
    // With neither, the row keeps its branch title.
    expect(
      deriveWorktreeRowNaming({ storedLabel: '  ', chatName: undefined }),
    ).toEqual({ title: undefined });
  });
});
