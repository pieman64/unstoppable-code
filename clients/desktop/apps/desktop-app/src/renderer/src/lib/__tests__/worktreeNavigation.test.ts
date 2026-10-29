import {
  COWORK_HOME_WORKTREE_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type CoworkSidebarItem,
  type SidebarItem,
} from '@canopy/desktop-shared/types';
import { canNavigateToWorktreeFromSidebarItems } from '../worktreeNavigation';

function makeSidebarItem(projectId: string, worktreeId: string): SidebarItem {
  return {
    type: 'single-repo',
    id: projectId,
    name: 'Project',
    repoPath: '/workspace',
    color: '#000000',
    collapsed: false,
    order: 0,
    worktrees: [
      {
        id: worktreeId,
        branchName: 'feature/worktree',
        createdAt: '2026-04-28T00:00:00.000Z',
      },
    ],
  };
}

function makeCoworkItem(projectId: string): CoworkSidebarItem {
  return {
    type: 'cowork',
    id: projectId,
    name: 'Cowork',
    color: '#000000',
    collapsed: false,
    order: 0,
  };
}

describe('canNavigateToWorktreeFromSidebarItems', () => {
  it('allows known worktrees', () => {
    expect(
      canNavigateToWorktreeFromSidebarItems(
        [makeSidebarItem('project', 'worktree')],
        'project',
        'worktree',
        true,
      ),
    ).toBe(true);
  });

  it('rejects missing worktrees in loaded projects', () => {
    expect(
      canNavigateToWorktreeFromSidebarItems(
        [makeSidebarItem('project', 'worktree')],
        'project',
        'missing',
        true,
      ),
    ).toBe(false);
  });

  it('rejects missing projects after projects are loaded', () => {
    expect(
      canNavigateToWorktreeFromSidebarItems(
        [makeSidebarItem('project', 'worktree')],
        'missing-project',
        'worktree',
        true,
      ),
    ).toBe(false);
  });

  it('allows unresolved project state before projects hydrate', () => {
    expect(
      canNavigateToWorktreeFromSidebarItems([], 'project', 'worktree', false),
    ).toBe(true);
  });

  it('rejects missing projects after hydration even when the list is empty', () => {
    expect(
      canNavigateToWorktreeFromSidebarItems([], 'project', 'worktree', true),
    ).toBe(false);
  });

  it('allows standalone chat targets', () => {
    expect(
      canNavigateToWorktreeFromSidebarItems(
        [makeSidebarItem('project', 'worktree')],
        STANDALONE_CHAT_PROJECT_ID,
        'standalone-chat',
        true,
      ),
    ).toBe(true);
  });

  it('allows standalone chat targets for any worktreeId', () => {
    expect(
      canNavigateToWorktreeFromSidebarItems(
        [makeSidebarItem('project', 'worktree')],
        STANDALONE_CHAT_PROJECT_ID,
        'anything',
        true,
      ),
    ).toBe(true);
  });

  it('allows a real cowork project id navigating to its legacy home worktree', () => {
    expect(
      canNavigateToWorktreeFromSidebarItems(
        [makeCoworkItem('cowork-workspace-1')],
        'cowork-workspace-1',
        COWORK_HOME_WORKTREE_ID,
        true,
      ),
    ).toBe(true);
  });

  it('allows a real cowork project id navigating to any work-entry worktreeId', () => {
    // Work Entries occupy the worktreeId slot and are not statically known
    // to the navigation guard; the standalone store enforces selection
    // safety instead.
    expect(
      canNavigateToWorktreeFromSidebarItems(
        [makeCoworkItem('cowork-workspace-1')],
        'cowork-workspace-1',
        'work-entry-1',
        true,
      ),
    ).toBe(true);
  });
});
