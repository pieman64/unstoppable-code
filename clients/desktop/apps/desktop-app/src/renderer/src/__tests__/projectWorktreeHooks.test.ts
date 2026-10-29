import type { SingleRepoSidebarItem } from '@canopy/desktop-shared/types';
import {
  getSingleRepoWorktreeEffectiveHooks,
  type AppliedProjectWorktreeHooks,
} from '../lib/projectWorktreeHooks';

function createProject(
  overrides: Partial<SingleRepoSidebarItem> = {},
): SingleRepoSidebarItem {
  return {
    type: 'single-repo',
    id: 'project-1',
    name: 'Project',
    repoPath: '/repo',
    color: '#000000',
    collapsed: false,
    order: 0,
    worktrees: [],
    effectiveHooks: {
      'pr:create': [{ type: 'command', command: 'echo create' }],
      'pr:merged': [{ type: 'command', command: 'echo merged' }],
    },
    ...overrides,
  };
}

describe('getSingleRepoWorktreeEffectiveHooks', () => {
  it('prefers the applied worktree overlay when present', () => {
    const project = createProject();
    const appliedHooks: AppliedProjectWorktreeHooks = {
      'project-1/wt-1': {
        'pr:create': [{ type: 'command', command: 'echo override' }],
      },
    };

    expect(
      getSingleRepoWorktreeEffectiveHooks(project, 'wt-1', appliedHooks),
    ).toEqual({
      'pr:create': [{ type: 'command', command: 'echo override' }],
    });
  });

  it('falls back to the project effective hooks when no overlay exists', () => {
    const project = createProject();

    expect(getSingleRepoWorktreeEffectiveHooks(project, 'wt-1', {})).toEqual(
      project.effectiveHooks,
    );
  });

  it('falls back to the project effective hooks when the applied worktree overlay is empty', () => {
    const project = createProject();

    expect(
      getSingleRepoWorktreeEffectiveHooks(project, 'wt-1', {
        'project-1/wt-1': {},
      }),
    ).toEqual(project.effectiveHooks);
  });
});
