import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import type { WorktreePrStatus } from '@canopy/desktop-shared/types/github';
import {
  buildHookEntries,
  countConfiguredHooks,
  hasActivePrForHookEntry,
  isPrHookActiveForRepo,
  type HookEntry,
} from '../hook-utils';

function createPrStatus(repos: WorktreePrStatus['repos']): WorktreePrStatus {
  return {
    repos,
    lastCheckedAt: '2026-04-09T00:00:00.000Z',
  };
}

function createHookEntry(overrides: Partial<HookEntry['hook']>): HookEntry {
  return {
    hook: {
      hookKey: 'hook-key',
      triggerName: 'pr:create',
      label: 'Hook',
      actions: [],
      target: 'project',
      ...overrides,
    },
  };
}

describe('hasActivePrForHookEntry', () => {
  it('matches workspace-root hooks against the canonical project root repo id', () => {
    const entry = createHookEntry({ target: 'workspace-root' });
    const prStatus = createPrStatus([
      {
        repoId: WORKSPACE_ROOT_REPO_ID,
        repoName: 'Workspace root',
        status: {
          prNumber: 42,
          prUrl: 'https://github.com/acme/repo/pull/42',
          state: 'open',
          title: 'PR',
          checkStatus: 'none',
          checkDetails: [],
          reviewStatus: 'none',
          reviewers: [],
          hasConflicts: false,
          commentCount: 0,
          updatedAt: '2026-04-09T00:00:00.000Z',
        },
      },
    ]);

    expect(hasActivePrForHookEntry(entry, prStatus)).toBe(true);
  });

  it('does not enable a repo hook when only another repo has a PR snapshot', () => {
    const entry = createHookEntry({
      target: 'workspace-repo',
      repoId: 'repo-b',
      repoName: 'Repo B',
    });
    const prStatus = createPrStatus([
      {
        repoId: 'repo-a',
        repoName: 'Repo A',
        status: {
          prNumber: 42,
          prUrl: 'https://github.com/acme/repo-a/pull/42',
          state: 'open',
          title: 'Repo A PR',
          checkStatus: 'none',
          checkDetails: [],
          reviewStatus: 'none',
          reviewers: [],
          hasConflicts: false,
          commentCount: 0,
          updatedAt: '2026-04-09T00:00:00.000Z',
        },
      },
      {
        repoId: 'repo-b',
        repoName: 'Repo B',
        status: null,
      },
    ]);

    expect(hasActivePrForHookEntry(entry, prStatus)).toBe(false);
  });
});

describe('project root hook visibility', () => {
  it('does not build workspace-root hook entries for local-only multi-repo projects', () => {
    const entries = buildHookEntries(
      {
        type: 'multi-repo',
        id: 'workspace-a',
        name: 'Workspace A',
        color: '#111111',
        repos: [
          {
            id: 'repo-a',
            name: 'Repo A',
            repoPath: '/repos/repo-a',
            effectiveHooks: {
              'pr:create': [{ type: 'command', command: 'echo repo' }],
            },
          },
        ],
        worktrees: [],
        collapsed: false,
        order: 0,
        effectiveHooks: {
          'pr:create': [{ type: 'command', command: 'echo root' }],
        },
      } as never,
      'wt-1',
      {},
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.hook.target).toBe('workspace-repo');
  });

  it('does not count workspace-root hooks for local-only multi-repo projects', () => {
    const count = countConfiguredHooks(
      [
        {
          type: 'multi-repo',
          id: 'workspace-a',
          name: 'Workspace A',
          color: '#111111',
          repos: [
            {
              id: 'repo-a',
              name: 'Repo A',
              repoPath: '/repos/repo-a',
              effectiveHooks: {
                'pr:create': [{ type: 'command', command: 'echo repo' }],
              },
            },
          ],
          worktrees: [],
          collapsed: false,
          order: 0,
          effectiveHooks: {
            'pr:create': [{ type: 'command', command: 'echo root' }],
          },
        } as never,
      ],
      'workspace-a',
      'wt-1',
      {},
    );

    expect(count).toBe(1);
  });

  it('builds workspace-root hook entries from worktree canopy hooks even when sourceRepoPath is missing', () => {
    const entries = buildHookEntries(
      {
        type: 'multi-repo',
        id: 'workspace-a',
        name: 'Workspace A',
        color: '#111111',
        repos: [],
        worktrees: [],
        collapsed: false,
        order: 0,
        worktreeEffective: {
          'wt-1': {
            effectiveHooks: {
              'pr:create': [{ type: 'command', command: 'echo root' }],
            },
          },
        },
      } as never,
      'wt-1',
      {},
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.hook.target).toBe('workspace-root');
  });

  it('counts workspace-root hooks from worktree canopy hooks even when sourceRepoPath is missing', () => {
    const count = countConfiguredHooks(
      [
        {
          type: 'multi-repo',
          id: 'workspace-a',
          name: 'Workspace A',
          color: '#111111',
          repos: [],
          worktrees: [],
          collapsed: false,
          order: 0,
          worktreeEffective: {
            'wt-1': {
              effectiveHooks: {
                'pr:create': [{ type: 'command', command: 'echo root' }],
              },
            },
          },
        } as never,
      ],
      'workspace-a',
      'wt-1',
      {},
    );

    expect(count).toBe(1);
  });

  it('shows non-overridden repo hooks alongside local overrides', () => {
    const entries = buildHookEntries(
      {
        type: 'multi-repo',
        id: 'workspace-a',
        name: 'Workspace A',
        color: '#111111',
        repos: [
          {
            id: 'repo-a',
            name: 'Repo A',
            repoPath: '/repos/repo-a',
            hooks: {
              'pr:create': [{ type: 'command', command: 'echo local create' }],
            },
            effectiveHooks: {
              'pr:create': [{ type: 'command', command: 'echo local create' }],
              'pr:merged': [{ type: 'command', command: 'echo inherited' }],
            },
          },
        ],
        worktrees: [],
        collapsed: false,
        order: 0,
      } as never,
      'wt-1',
      {},
    );

    expect(entries.map((entry) => entry.hook.triggerName)).toEqual([
      'pr:create',
      'pr:merged',
    ]);
  });

  it('preserves inherited repo hooks when the worktree snapshot only contains local overrides', () => {
    const entries = buildHookEntries(
      {
        type: 'multi-repo',
        id: 'workspace-a',
        name: 'Workspace A',
        color: '#111111',
        repos: [
          {
            id: 'repo-a',
            name: 'Repo A',
            repoPath: '/repos/repo-a',
            hooks: {
              'pr:create': [{ type: 'command', command: 'echo local create' }],
            },
            effectiveHooks: {
              'pr:create': [{ type: 'command', command: 'echo local create' }],
              'pr:merged': [{ type: 'command', command: 'echo inherited' }],
            },
          },
        ],
        worktrees: [],
        collapsed: false,
        order: 0,
        worktreeEffective: {
          'wt-1': {
            repos: {
              'repo-a': {
                effectiveHooks: {
                  'pr:create': [
                    { type: 'command', command: 'echo local create' },
                  ],
                },
              },
            },
          },
        },
      } as never,
      'wt-1',
      {},
    );

    expect(entries.map((entry) => entry.hook.triggerName)).toEqual([
      'pr:create',
      'pr:merged',
    ]);
  });

  it('counts inherited repo hooks when the worktree snapshot only contains local overrides', () => {
    const count = countConfiguredHooks(
      [
        {
          type: 'multi-repo',
          id: 'workspace-a',
          name: 'Workspace A',
          color: '#111111',
          repos: [
            {
              id: 'repo-a',
              name: 'Repo A',
              repoPath: '/repos/repo-a',
              hooks: {
                'pr:create': [
                  { type: 'command', command: 'echo local create' },
                ],
              },
              effectiveHooks: {
                'pr:create': [
                  { type: 'command', command: 'echo local create' },
                ],
                'pr:merged': [{ type: 'command', command: 'echo inherited' }],
              },
            },
          ],
          worktrees: [],
          collapsed: false,
          order: 0,
          worktreeEffective: {
            'wt-1': {
              repos: {
                'repo-a': {
                  effectiveHooks: {
                    'pr:create': [
                      { type: 'command', command: 'echo local create' },
                    ],
                  },
                },
              },
            },
          },
        } as never,
      ],
      'workspace-a',
      'wt-1',
      {},
    );

    expect(count).toBe(2);
  });

  it('falls back to base repo hooks when the worktree-effective repo hook map is empty', () => {
    const entries = buildHookEntries(
      {
        type: 'multi-repo',
        id: 'workspace-a',
        name: 'Workspace A',
        color: '#111111',
        repos: [
          {
            id: 'repo-a',
            name: 'Repo A',
            repoPath: '/repos/repo-a',
            effectiveHooks: {
              'pr:create': [{ type: 'command', command: 'echo inherited' }],
            },
          },
        ],
        worktrees: [],
        collapsed: false,
        order: 0,
        worktreeEffective: {
          'wt-1': {
            repos: {
              'repo-a': {
                effectiveHooks: {},
              },
            },
          },
        },
      } as never,
      'wt-1',
      {},
    );

    expect(entries.map((entry) => entry.hook.triggerName)).toEqual([
      'pr:create',
    ]);
  });
});

describe('isPrHookActiveForRepo', () => {
  const TRIGGER = 'pr:queue:removed';
  const projectHook = createHookEntry({
    hookKey: 'project:pr:queue:removed',
    triggerName: TRIGGER,
    target: 'project',
  });
  const rootHook = createHookEntry({
    hookKey: 'workspace-root:pr:queue:removed',
    triggerName: TRIGGER,
    target: 'workspace-root',
  });
  const repoHook = createHookEntry({
    hookKey: 'workspace-repo:repo-a:pr:queue:removed',
    triggerName: TRIGGER,
    target: 'workspace-repo',
    repoId: 'repo-a',
  });

  it('finds a configured project hook in a single-repo project', () => {
    expect(
      isPrHookActiveForRepo({
        entries: [projectHook],
        pausedHookKeys: [],
        isMultiRepo: false,
        repoId: undefined,
        triggerName: TRIGGER,
      }),
    ).toBe(true);
  });

  it('treats a hook paused in the worktree as absent', () => {
    expect(
      isPrHookActiveForRepo({
        entries: [projectHook],
        pausedHookKeys: [projectHook.hook.hookKey],
        isMultiRepo: false,
        repoId: undefined,
        triggerName: TRIGGER,
      }),
    ).toBe(false);
  });

  it('ignores hooks for other triggers', () => {
    expect(
      isPrHookActiveForRepo({
        entries: [createHookEntry({ triggerName: 'pr:queue:entered' })],
        pausedHookKeys: [],
        isMultiRepo: false,
        repoId: undefined,
        triggerName: TRIGGER,
      }),
    ).toBe(false);
  });

  it('matches only the scope that fires for the PR repository in a multi-repo project', () => {
    const args = {
      entries: [rootHook, repoHook],
      pausedHookKeys: [],
      isMultiRepo: true,
      triggerName: TRIGGER,
    };
    expect(
      isPrHookActiveForRepo({ ...args, repoId: WORKSPACE_ROOT_REPO_ID }),
    ).toBe(true);
    expect(isPrHookActiveForRepo({ ...args, repoId: 'repo-a' })).toBe(true);
    expect(isPrHookActiveForRepo({ ...args, repoId: 'repo-b' })).toBe(false);
    expect(
      isPrHookActiveForRepo({
        ...args,
        entries: [rootHook],
        repoId: 'repo-a',
      }),
    ).toBe(false);
  });
});
