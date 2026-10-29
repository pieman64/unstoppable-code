import type { SidebarItem, WorktreeData } from '@canopy/desktop-shared/types';
import {
  buildSidebarWorkspaceFilterOptions,
  buildWorktreeStatusMap,
  partitionSidebarWorkspaces,
  sortProjectsByOrder,
  type WorktreeStatusKeySets,
} from '../sidebarWorkspacesDerivation';

function makeWorktree(
  id: string,
  overrides: Partial<WorktreeData> = {},
): WorktreeData {
  return {
    id,
    branchName: id,
    createdAt: '2026-05-04T00:00:00.000Z',
    ...overrides,
  };
}

function makeProject(
  id: string,
  order: number,
  overrides: Partial<SidebarItem> = {},
): SidebarItem {
  const base: SidebarItem = {
    id,
    type: 'single-repo',
    name: id,
    repoPath: `/tmp/${id}`,
    color: '#123456',
    order,
    collapsed: false,
    worktrees: [makeWorktree(`${id}-wt`)],
    scripts: {},
    effectiveScripts: {},
    hooks: {},
    effectiveHooks: {},
  };
  return { ...base, ...overrides };
}

function makeCoworkProject(
  id: string,
  order: number,
  overrides: Partial<SidebarItem> = {},
): SidebarItem {
  return {
    id,
    type: 'cowork',
    name: id,
    color: '#123456',
    order,
    collapsed: false,
    ...overrides,
  };
}

function emptyKeySets(): WorktreeStatusKeySets {
  return {
    unreadWorktreeKeys: new Set<string>(),
    unseenPipelineWorktreeKeys: new Set<string>(),
    unseenFailedPipelineWorktreeKeys: new Set<string>(),
    streamingWorktreeKeys: new Set<string>(),
    pipelineRunningWorktreeKeys: new Set<string>(),
    awaitingApprovalKeys: new Set<string>(),
    pipelinePausedWorktreeKeys: new Set<string>(),
  };
}

describe('sortProjectsByOrder', () => {
  it('sorts ascending by order without mutating the input', () => {
    const input = [
      makeProject('c', 2),
      makeProject('a', 0),
      makeProject('b', 1),
    ];
    const sorted = sortProjectsByOrder(input);

    expect(sorted.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    // Original array order is preserved (no in-place mutation).
    expect(input.map((p) => p.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('partitionSidebarWorkspaces', () => {
  it('sorts by order and keeps standard projects visible', () => {
    const projects = [makeProject('b', 1), makeProject('a', 0)];
    const { sortedProjects, visibleProjects, hiddenProjects } =
      partitionSidebarWorkspaces(projects, []);

    expect(sortedProjects.map((p) => p.id)).toEqual(['a', 'b']);
    expect(visibleProjects.map((p) => p.id)).toEqual(['a', 'b']);
    expect(hiddenProjects).toEqual([]);
  });

  it('filters out projects whose id is in the hidden filter set', () => {
    const projects = [makeProject('a', 0), makeProject('b', 1)];
    const { visibleProjects, hiddenProjects } = partitionSidebarWorkspaces(
      projects,
      ['a'],
    );

    expect(visibleProjects.map((p) => p.id)).toEqual(['b']);
    // Filtered-out workspaces never land in the hidden group either.
    expect(hiddenProjects).toEqual([]);
  });

  it('keeps alwaysShow!==false projects visible even with only hidden worktrees', () => {
    const project = makeProject('a', 0, {
      alwaysShow: true,
      worktrees: [makeWorktree('a-wt', { hidden: true })],
    });
    const { visibleProjects, hiddenProjects } = partitionSidebarWorkspaces(
      [project],
      [],
    );

    expect(visibleProjects.map((p) => p.id)).toEqual(['a']);
    expect(hiddenProjects).toEqual([]);
  });

  it('moves alwaysShow===false projects with no visible worktrees into the hidden group', () => {
    const project = makeProject('a', 0, {
      alwaysShow: false,
      worktrees: [makeWorktree('a-wt', { hidden: true })],
    });
    const { visibleProjects, hiddenProjects } = partitionSidebarWorkspaces(
      [project],
      [],
    );

    expect(visibleProjects).toEqual([]);
    expect(hiddenProjects.map((p) => p.id)).toEqual(['a']);
  });

  it('keeps alwaysShow===false projects visible while they have a non-hidden worktree', () => {
    const project = makeProject('a', 0, {
      alwaysShow: false,
      worktrees: [
        makeWorktree('a-wt', { hidden: true }),
        makeWorktree('a-wt-2'),
      ],
    });
    const { visibleProjects, hiddenProjects } = partitionSidebarWorkspaces(
      [project],
      [],
    );

    expect(visibleProjects.map((p) => p.id)).toEqual(['a']);
    expect(hiddenProjects).toEqual([]);
  });

  it('keeps hidden-by-default cowork projects visible while they have work entries', () => {
    const project = makeCoworkProject('cowork-a', 0, {
      alwaysShow: false,
      workEntryCount: 1,
    });
    const { visibleProjects, hiddenProjects } = partitionSidebarWorkspaces(
      [project],
      [],
    );

    expect(visibleProjects.map((entry) => entry.id)).toEqual(['cowork-a']);
    expect(hiddenProjects).toEqual([]);
  });

  it('hides hidden-by-default cowork projects with no work entries', () => {
    const project = makeCoworkProject('cowork-a', 0, {
      alwaysShow: false,
      workEntryCount: 0,
    });
    const { visibleProjects, hiddenProjects } = partitionSidebarWorkspaces(
      [project],
      [],
    );

    expect(visibleProjects).toEqual([]);
    expect(hiddenProjects.map((entry) => entry.id)).toEqual(['cowork-a']);
  });

  it('excludes filter-hidden projects from the hidden group even when they qualify', () => {
    const project = makeProject('a', 0, {
      alwaysShow: false,
      worktrees: [makeWorktree('a-wt', { hidden: true })],
    });
    const { visibleProjects, hiddenProjects } = partitionSidebarWorkspaces(
      [project],
      ['a'],
    );

    expect(visibleProjects).toEqual([]);
    expect(hiddenProjects).toEqual([]);
  });
});

describe('buildSidebarWorkspaceFilterOptions', () => {
  it('maps each project with the metadata needed by its canonical icon', () => {
    const projects = [
      makeProject('a', 0, {
        name: 'Alpha',
        color: '#aaa',
        worktrees: [makeWorktree('w1'), makeWorktree('w2')],
      }),
    ];
    const options = buildSidebarWorkspaceFilterOptions(projects);

    expect(options).toEqual([
      {
        id: 'a',
        name: 'Alpha',
        color: '#aaa',
        kind: 'single-repo',
        repoPath: '/tmp/a',
        temporary: undefined,
        worktreeCount: 2,
      },
    ]);
  });
});

describe('buildWorktreeStatusMap', () => {
  it('resolves per-worktree status with the documented priority', () => {
    const projects = [
      makeProject('p', 0, {
        worktrees: [
          makeWorktree('done', { status: 'done' }),
          makeWorktree('unread'),
          makeWorktree('working'),
          makeWorktree('planning'),
          makeWorktree('idle'),
        ],
      }),
    ];

    const keys = emptyKeySets();
    keys.unreadWorktreeKeys.add('p/unread');
    keys.streamingWorktreeKeys.add('p/working');
    keys.awaitingApprovalKeys.add('p/planning');
    // `done` also flagged unread to prove done wins.
    keys.unreadWorktreeKeys.add('p/done');

    const map = buildWorktreeStatusMap(projects, keys);

    expect(map.get('p/done')).toBe('done');
    expect(map.get('p/unread')).toBe('unread');
    expect(map.get('p/working')).toBe('working');
    expect(map.get('p/planning')).toBe('planning');
    expect(map.get('p/idle')).toBe('idle');
  });

  it('treats pipeline running as working and pipeline paused as planning', () => {
    const projects = [
      makeProject('p', 0, {
        worktrees: [makeWorktree('run'), makeWorktree('paused')],
      }),
    ];
    const keys = emptyKeySets();
    keys.pipelineRunningWorktreeKeys.add('p/run');
    keys.pipelinePausedWorktreeKeys.add('p/paused');

    const map = buildWorktreeStatusMap(projects, keys);

    expect(map.get('p/run')).toBe('working');
    expect(map.get('p/paused')).toBe('planning');
  });
});

describe('partitionSidebarWorkspaces context scoping (CAN-2954)', () => {
  const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const owned = (organizationId: string): SidebarItem['owner'] => ({
    type: 'organization',
    organizationId,
    projectId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    instanceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    bindingGeneration: 1,
  });
  const projects = [
    makeProject('personal', 0),
    makeProject('acme', 1, { owner: owned(ORG_A) }),
    makeProject('zen', 2, {
      owner: owned(ORG_B),
      alwaysShow: false,
      worktrees: [],
    }),
  ];

  it('keeps every row when no context is given', () => {
    const { sortedProjects } = partitionSidebarWorkspaces(projects, []);
    expect(sortedProjects.map((p) => p.id)).toEqual([
      'personal',
      'acme',
      'zen',
    ]);
  });

  it('shows only unowned rows in the Personal context', () => {
    const { sortedProjects, visibleProjects } = partitionSidebarWorkspaces(
      projects,
      [],
      undefined,
      { kind: 'personal' },
    );
    expect(sortedProjects.map((p) => p.id)).toEqual(['personal']);
    expect(visibleProjects.map((p) => p.id)).toEqual(['personal']);
  });

  it('shows only that organization in an organization context, then applies visibility', () => {
    const acme = partitionSidebarWorkspaces(projects, [], undefined, {
      kind: 'organization',
      organizationId: ORG_A,
    });
    expect(acme.visibleProjects.map((p) => p.id)).toEqual(['acme']);
    expect(acme.hiddenProjects).toEqual([]);

    const zen = partitionSidebarWorkspaces(projects, [], undefined, {
      kind: 'organization',
      organizationId: ORG_B,
    });
    expect(zen.visibleProjects).toEqual([]);
    expect(zen.hiddenProjects.map((p) => p.id)).toEqual(['zen']);
  });

  it('admits only linked Personal workspaces alongside the organization without changing ownership', () => {
    const linked = makeProject('linked', 3);
    const input = [...projects, linked];
    const result = partitionSidebarWorkspaces(
      input,
      [],
      undefined,
      { kind: 'organization', organizationId: ORG_A },
      ['linked', 'zen'],
    );
    expect(result.sortedProjects.map((project) => project.id)).toEqual([
      'acme',
      'linked',
    ]);
    expect(result.visibleProjects).toContain(linked);
    expect(result.hiddenProjects).toEqual([]);
    expect(linked.owner).toBeUndefined();
    expect(
      partitionSidebarWorkspaces(input, [], undefined, { kind: 'personal' }, [
        'zen',
      ]).visibleProjects.map((project) => project.id),
    ).toEqual(['personal', 'linked']);
    expect(
      partitionSidebarWorkspaces(
        input,
        ['linked'],
        undefined,
        { kind: 'organization', organizationId: ORG_A },
        ['linked'],
      ).visibleProjects.map((project) => project.id),
    ).toEqual(['acme']);
  });

  it('applies the hidden filter on top of the context', () => {
    const acme = partitionSidebarWorkspaces(projects, ['acme'], undefined, {
      kind: 'organization',
      organizationId: ORG_A,
    });
    expect(acme.visibleProjects).toEqual([]);
    expect(acme.hiddenProjects).toEqual([]);
  });
});
