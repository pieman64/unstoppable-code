import type { SidebarItem } from '@canopy/desktop-shared/types';
import { resolveStartupResumeTarget } from '../startup-resume';

function makeCodeWorkspace(
  projectId: string,
  worktreeIds: string[],
): SidebarItem {
  return {
    type: 'single-repo',
    id: projectId,
    name: projectId,
    repoPath: `/repos/${projectId}`,
    color: '#000000',
    collapsed: false,
    order: 0,
    worktrees: worktreeIds.map((id) => ({
      id,
      branchName: `branch-${id}`,
      createdAt: '2026-01-01T00:00:00.000Z',
    })),
  };
}

function makeCoworkWorkspace(workspaceId: string): SidebarItem {
  return {
    type: 'cowork',
    id: workspaceId,
    name: workspaceId,
    color: '#000000',
    collapsed: false,
    order: 0,
  };
}

describe('resolveStartupResumeTarget', () => {
  it('offers the cowork chat for a live cowork context, ignoring legacy fields', () => {
    // Cowork flows never rewrite the legacy lastSelectedWorktree* fields, so
    // they can still name an old worktree. The cowork context must win.
    const target = resolveStartupResumeTarget(
      {
        lastActiveContext: {
          kind: 'cowork',
          workspaceId: 'c1',
          workEntryId: 'entry-2',
        },
        lastSelectedWorktreeProjectId: 'p1',
        lastSelectedWorktreeId: 'w1',
      },
      [makeCodeWorkspace('p1', ['w1']), makeCoworkWorkspace('c1')],
    );

    expect(target).toEqual({
      kind: 'cowork',
      workspaceId: 'c1',
      workEntryId: 'entry-2',
    });
  });

  it('offers nothing for a cowork context whose project is gone', () => {
    const target = resolveStartupResumeTarget(
      {
        lastActiveContext: { kind: 'cowork', workspaceId: 'c-deleted' },
        lastSelectedWorktreeProjectId: 'p1',
        lastSelectedWorktreeId: 'w1',
      },
      [makeCodeWorkspace('p1', ['w1'])],
    );

    expect(target).toBeNull();
  });

  it('does not treat a same-id code project as a cowork target', () => {
    const target = resolveStartupResumeTarget(
      {
        lastActiveContext: { kind: 'cowork', workspaceId: 'p1' },
        lastSelectedWorktreeProjectId: '',
        lastSelectedWorktreeId: '',
      },
      [makeCodeWorkspace('p1', ['w1'])],
    );

    expect(target).toBeNull();
  });

  it('offers the worktree named by a worktree context when it exists', () => {
    const target = resolveStartupResumeTarget(
      {
        lastActiveContext: {
          kind: 'worktree',
          workspaceId: 'p1',
          worktreeId: 'w1',
        },
        lastSelectedWorktreeProjectId: '',
        lastSelectedWorktreeId: '',
      },
      [makeCodeWorkspace('p1', ['w1'])],
    );

    expect(target).toEqual({
      kind: 'worktree',
      projectId: 'p1',
      worktreeId: 'w1',
    });
  });

  it('prefers the worktree context over differing legacy fields', () => {
    const target = resolveStartupResumeTarget(
      {
        lastActiveContext: {
          kind: 'worktree',
          workspaceId: 'p2',
          worktreeId: 'w2',
        },
        lastSelectedWorktreeProjectId: 'p1',
        lastSelectedWorktreeId: 'w1',
      },
      [makeCodeWorkspace('p1', ['w1']), makeCodeWorkspace('p2', ['w2'])],
    );

    expect(target).toEqual({
      kind: 'worktree',
      projectId: 'p2',
      worktreeId: 'w2',
    });
  });

  it('offers nothing when the worktree context names a deleted worktree', () => {
    const target = resolveStartupResumeTarget(
      {
        lastActiveContext: {
          kind: 'worktree',
          workspaceId: 'p1',
          worktreeId: 'gone',
        },
        lastSelectedWorktreeProjectId: '',
        lastSelectedWorktreeId: '',
      },
      [makeCodeWorkspace('p1', ['w1'])],
    );

    expect(target).toBeNull();
  });

  it('does not fall back to legacy fields when the worktree context is dead', () => {
    // Legacy fields are a migration-only fallback for prefs written before
    // lastActiveContext existed; once any context is present they are stale.
    const target = resolveStartupResumeTarget(
      {
        lastActiveContext: {
          kind: 'worktree',
          workspaceId: 'p-deleted',
          worktreeId: 'w-deleted',
        },
        lastSelectedWorktreeProjectId: 'p1',
        lastSelectedWorktreeId: 'w1',
      },
      [makeCodeWorkspace('p1', ['w1'])],
    );

    expect(target).toBeNull();
  });

  it('falls back to legacy fields when no context exists and they resolve', () => {
    const target = resolveStartupResumeTarget(
      {
        lastActiveContext: null,
        lastSelectedWorktreeProjectId: 'p1',
        lastSelectedWorktreeId: 'w1',
      },
      [makeCodeWorkspace('p1', ['w1'])],
    );

    expect(target).toEqual({
      kind: 'worktree',
      projectId: 'p1',
      worktreeId: 'w1',
    });
  });

  it('offers nothing when no context exists and legacy fields are dead', () => {
    const target = resolveStartupResumeTarget(
      {
        lastActiveContext: null,
        lastSelectedWorktreeProjectId: 'p1',
        lastSelectedWorktreeId: 'gone',
      },
      [makeCodeWorkspace('p1', ['w1'])],
    );

    expect(target).toBeNull();
  });

  it('offers nothing when there is nothing to resume', () => {
    const target = resolveStartupResumeTarget(
      {
        lastActiveContext: null,
        lastSelectedWorktreeProjectId: '',
        lastSelectedWorktreeId: '',
      },
      [makeCodeWorkspace('p1', ['w1'])],
    );

    expect(target).toBeNull();
  });

  it('never offers a worktree inside a cowork project even if ids collide', () => {
    const target = resolveStartupResumeTarget(
      {
        lastActiveContext: {
          kind: 'worktree',
          workspaceId: 'c1',
          worktreeId: 'home',
        },
        lastSelectedWorktreeProjectId: '',
        lastSelectedWorktreeId: '',
      },
      [makeCoworkWorkspace('c1')],
    );

    expect(target).toBeNull();
  });
});
