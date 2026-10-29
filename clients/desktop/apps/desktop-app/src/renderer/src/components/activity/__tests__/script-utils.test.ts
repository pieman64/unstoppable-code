import {
  buildScriptEntries,
  countConfiguredScripts,
  findLaunchEntry,
  findWorkspaceLaunchEntry,
  hasRunScripts,
} from '../script-utils';
import type {
  MultiRepoSidebarItem,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';

describe('script utils worktree fallback', () => {
  it('falls back to base repo scripts when the worktree-effective repo script map is empty', () => {
    const entries = buildScriptEntries(
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
            effectiveScripts: {
              setup: 'npm run repo-setup',
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
                effectiveScripts: {},
              },
            },
          },
        },
      } as never,
      'wt-1',
      {},
    );

    expect(entries.map((entry) => entry.script.scriptKey)).toEqual([
      'workspace-setup',
      'workspace-repo:repo-a:setup',
    ]);
  });

  it('counts base repo scripts when the worktree-effective repo script map is empty', () => {
    const count = countConfiguredScripts(
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
              effectiveScripts: {
                setup: 'npm run repo-setup',
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
                  effectiveScripts: {},
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

  it('shows single-repo launch scripts when the worktree-effective map is empty', () => {
    const showRunButton = hasRunScripts(
      [
        {
          type: 'single-repo',
          id: 'project-a',
          name: 'Project A',
          repoPath: '/repos/project-a',
          color: '#111111',
          worktrees: [],
          collapsed: false,
          order: 0,
          effectiveScripts: {
            launch: 'npm run launch',
          },
          worktreeEffective: {
            'wt-1': {
              effectiveScripts: {},
            },
          },
        } as never,
      ],
      'project-a',
      'wt-1',
      {},
    );

    expect(showRunButton).toBe(true);
  });

  it('builds single-repo script entries from base scripts when the worktree-effective map is empty', () => {
    const entries = buildScriptEntries(
      {
        type: 'single-repo',
        id: 'project-a',
        name: 'Project A',
        repoPath: '/repos/project-a',
        color: '#111111',
        worktrees: [],
        collapsed: false,
        order: 0,
        effectiveScripts: {
          launch: 'npm run launch',
        },
        worktreeEffective: {
          'wt-1': {
            effectiveScripts: {},
          },
        },
      } as never,
      'wt-1',
      {},
    );

    expect(entries.map((entry) => entry.script.scriptName)).toEqual(['launch']);
  });

  it('presents interactive teardown through its effective background runner', () => {
    const project: SingleRepoSidebarItem = {
      type: 'single-repo',
      id: 'project-a',
      name: 'Project A',
      repoPath: '/repos/project-a',
      color: '#111111',
      worktrees: [],
      collapsed: false,
      order: 0,
      effectiveScripts: {
        teardown: {
          command: 'npm run teardown',
          interactive: true,
        },
      },
    };
    const entries = buildScriptEntries(project, 'wt-1', {});

    expect(entries).toHaveLength(1);
    expect(entries[0]?.script).toMatchObject({
      scriptName: 'teardown',
      command: 'npm run teardown',
    });
    expect(entries[0]?.script.interactive).toBeUndefined();
  });

  it('counts single-repo base scripts when the worktree-effective map is empty', () => {
    const count = countConfiguredScripts(
      [
        {
          type: 'single-repo',
          id: 'project-a',
          name: 'Project A',
          repoPath: '/repos/project-a',
          color: '#111111',
          worktrees: [],
          collapsed: false,
          order: 0,
          effectiveScripts: {
            launch: 'npm run launch',
          },
          worktreeEffective: {
            'wt-1': {
              effectiveScripts: {},
            },
          },
        } as never,
      ],
      'project-a',
      'wt-1',
      {},
    );

    expect(count).toBe(1);
  });

  it('adds a project launch entry when a child repo has a worktree-effective launch script', () => {
    const workspace: MultiRepoSidebarItem = {
      type: 'multi-repo',
      id: 'workspace-a',
      name: 'Workspace A',
      color: '#111111',
      repos: [
        {
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/repos/repo-a',
          effectiveScripts: {},
        },
      ],
      worktrees: [],
      collapsed: false,
      order: 0,
      effectiveScripts: {},
      worktreeEffective: {
        'wt-1': {
          repos: {
            'repo-a': {
              effectiveScripts: {
                launch: 'npm run launch',
              },
            },
          },
        },
      },
    };

    const entries = buildScriptEntries(workspace, 'wt-1', {});

    expect(entries.map((entry) => entry.script.scriptKey)).toEqual([
      'workspace-launch',
      'workspace-repo:repo-a:launch',
    ]);
    expect(hasRunScripts([workspace], 'workspace-a', 'wt-1', {})).toBe(true);
    expect(countConfiguredScripts([workspace], 'workspace-a', 'wt-1', {})).toBe(
      2,
    );
  });

  it('marks an aggregate project lifecycle as interactive when a child script is interactive', () => {
    const workspace: MultiRepoSidebarItem = {
      type: 'multi-repo',
      id: 'workspace-a',
      name: 'Workspace A',
      color: '#111111',
      repos: [
        {
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/repos/repo-a',
          effectiveScripts: {
            launch: {
              command: 'npm run launch-wizard',
              interactive: true,
            },
          },
        },
      ],
      worktrees: [],
      collapsed: false,
      order: 0,
      effectiveScripts: {},
    };

    const entries = buildScriptEntries(workspace, 'wt-1', {});

    expect(entries).toHaveLength(2);
    expect(entries[0]?.script).toMatchObject({
      scriptKey: 'workspace-launch',
      interactive: true,
    });
    expect(entries[1]?.script).toMatchObject({
      scriptKey: 'workspace-repo:repo-a:launch',
      interactive: true,
    });
  });

  it('adds project setup and teardown entries when child repos define those scripts', () => {
    const workspace: MultiRepoSidebarItem = {
      type: 'multi-repo',
      id: 'workspace-a',
      name: 'Workspace A',
      color: '#111111',
      repos: [
        {
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/repos/repo-a',
          effectiveScripts: {
            setup: 'npm run setup',
            teardown: 'npm run teardown',
          },
        },
      ],
      worktrees: [],
      collapsed: false,
      order: 0,
      effectiveScripts: {},
    };

    const entries = buildScriptEntries(workspace, 'wt-1', {});

    expect(entries.map((entry) => entry.script.scriptKey)).toEqual([
      'workspace-setup',
      'workspace-teardown',
      'workspace-repo:repo-a:setup',
      'workspace-repo:repo-a:teardown',
    ]);
    expect(countConfiguredScripts([workspace], 'workspace-a', 'wt-1', {})).toBe(
      4,
    );
  });

  it('selects the project launch entry instead of the earlier setup entry', () => {
    const workspace: MultiRepoSidebarItem = {
      type: 'multi-repo',
      id: 'workspace-a',
      name: 'Workspace A',
      color: '#111111',
      repos: [
        {
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/repos/repo-a',
          effectiveScripts: {
            setup: 'npm run setup',
            launch: 'npm run launch',
          },
        },
      ],
      worktrees: [],
      collapsed: false,
      order: 0,
      effectiveScripts: {},
    };

    const entries = buildScriptEntries(workspace, 'wt-1', {});
    const launchEntry = findWorkspaceLaunchEntry(entries);

    expect(entries[0]?.script.scriptKey).toBe('workspace-setup');
    expect(launchEntry?.script.scriptKey).toBe('workspace-launch');
    expect(findLaunchEntry(entries)?.script.scriptKey).toBe('workspace-launch');
  });

  it('selects a single-repo launch script entry', () => {
    const entries = buildScriptEntries(
      {
        type: 'single-repo',
        id: 'project-a',
        name: 'Project A',
        repoPath: '/repos/project-a',
        color: '#111111',
        worktrees: [],
        collapsed: false,
        order: 0,
        effectiveScripts: {
          setup: 'npm run setup',
          launch: 'npm run launch',
        },
      } as never,
      'wt-1',
      {},
    );

    expect(entries.map((entry) => entry.script.scriptKey)).toEqual([
      'project:setup',
      'project:launch',
    ]);
    expect(findLaunchEntry(entries)?.script.scriptKey).toBe('project:launch');
  });
});
