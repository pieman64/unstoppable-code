/** @jest-environment jsdom */
import type { SessionViewModel } from '@canopy/app-core';
import type {
  CoworkSidebarItem,
  SidebarItem,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import {
  DESKTOP_SHARED_SIDEBAR_TEST_IDS,
  deferEmptyWorkspaces,
  desktopArchivedCount,
  insertWorktreeMenuItemAfter,
  isSnapshotWorktreeListed,
  overlayStorePresentation,
  parseDesktopWorktreeSelection,
  routeDesktopSidebarSelection,
} from '../DesktopSharedSidebarHost';

function makeSingleRepoProject(
  id: string,
  overrides: Partial<SingleRepoSidebarItem> = {},
): SingleRepoSidebarItem {
  return {
    id,
    type: 'single-repo',
    name: id,
    repoPath: `/tmp/${id}`,
    color: '#123456',
    order: 0,
    collapsed: false,
    worktrees: [],
    scripts: {},
    effectiveScripts: {},
    hooks: {},
    effectiveHooks: {},
    ...overrides,
  };
}

function makeCoworkProject(
  id: string,
  overrides: Partial<CoworkSidebarItem> = {},
): CoworkSidebarItem {
  return {
    id,
    type: 'cowork',
    name: id,
    color: '#654321',
    collapsed: false,
    order: 0,
    ...overrides,
  };
}

const snapshot = {
  standaloneChats: [{ localId: 'chat-1', projectLocalId: 'cowork-1' }],
  workspaces: [
    { localId: 'cowork-1', name: 'Cowork', type: 'cowork', layout: 'flat' },
    { localId: 'code-1', name: 'Code', type: 'single-repo', layout: 'tree' },
    // A cloud workspace classifies as `cowork` but lays out as a tree and
    // projects its chats into worktrees (REG-2819), so it must route like a
    // code workspace rather than like a flat cowork one.
    { localId: 'cloud-1', name: 'Cloud', type: 'cowork', layout: 'tree' },
  ],
} as SessionViewModel;

describe('DesktopSharedSidebarHost wiring', () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('preserves worktree ids containing slashes', () => {
    expect(parseDesktopWorktreeSelection('workspace/feature/a')).toEqual({
      kind: 'worktree',
      workspaceLocalId: 'workspace',
      worktreeLocalId: 'feature/a',
    });
  });

  it('routes native selection in both directions', () => {
    const actions = {
      navigate: jest.fn(),
      openStandaloneChat: jest.fn(),
      selectWorkspace: jest.fn(),
      selectWorktree: jest.fn(),
    };
    routeDesktopSidebarSelection(
      { kind: 'worktree', workspaceLocalId: 'w', worktreeLocalId: 't' },
      snapshot,
      actions,
    );
    routeDesktopSidebarSelection(
      { kind: 'standalone-chat', standaloneChatId: 'chat-1' },
      snapshot,
      actions,
    );
    expect(actions.selectWorktree).toHaveBeenCalledWith('w', 't');
    expect(actions.openStandaloneChat).toHaveBeenCalledWith(
      'cowork-1',
      'chat-1',
    );
    expect(actions.navigate).toHaveBeenNthCalledWith(1, 'main');
    expect(actions.navigate).toHaveBeenNthCalledWith(2, 'chat');
  });

  it('routes a flat cowork workspace selection to the chat page', () => {
    const actions = {
      navigate: jest.fn(),
      openStandaloneChat: jest.fn(),
      selectWorkspace: jest.fn(),
      selectWorktree: jest.fn(),
    };
    routeDesktopSidebarSelection(
      { kind: 'workspace', workspaceLocalId: 'cowork-1' },
      snapshot,
      actions,
    );
    expect(actions.selectWorkspace).toHaveBeenCalledWith('cowork-1');
    expect(actions.navigate).toHaveBeenCalledWith('chat');
  });

  // The shared tree header no longer selects its project (CAN-3053), but a
  // code workspace id arriving as `kind: 'workspace'` by any other path must
  // still be refused. Those ids are never in `chatProjects`, so routing
  // them on spends a `chatProject.list()` self-heal and then throws
  // `Chat project not found` — which the sidebar helper surfaces as a toast
  // telling the user to retry something that can never succeed.
  it.each([
    ['a code workspace', 'code-1'],
    ['a tree-layout cloud workspace', 'cloud-1'],
  ])('ignores a workspace selection for %s', (_label, workspaceLocalId) => {
    const actions = {
      navigate: jest.fn(),
      openStandaloneChat: jest.fn(),
      selectWorkspace: jest.fn(),
      selectWorktree: jest.fn(),
    };
    routeDesktopSidebarSelection(
      { kind: 'workspace', workspaceLocalId },
      snapshot,
      actions,
    );
    expect(actions.selectWorkspace).not.toHaveBeenCalled();
    expect(actions.navigate).not.toHaveBeenCalled();
  });

  it('ignores a workspace selection missing from the snapshot', () => {
    const actions = {
      navigate: jest.fn(),
      openStandaloneChat: jest.fn(),
      selectWorkspace: jest.fn(),
      selectWorktree: jest.fn(),
    };
    routeDesktopSidebarSelection(
      { kind: 'workspace', workspaceLocalId: 'ghost' },
      snapshot,
      actions,
    );
    expect(actions.selectWorkspace).not.toHaveBeenCalled();
    expect(actions.navigate).not.toHaveBeenCalled();
    // Unlike the expected tree-layout refusal, an unresolvable id means the
    // snapshot and the selection disagree — it must leave a trace so "clicking
    // the row does nothing" stays triageable.
    expect(consoleError).toHaveBeenCalled();
  });

  // A snapshot without `workspaces` must not throw out of a click handler.
  it('ignores a workspace selection from a snapshot with no workspaces', () => {
    const actions = {
      navigate: jest.fn(),
      openStandaloneChat: jest.fn(),
      selectWorkspace: jest.fn(),
      selectWorktree: jest.fn(),
    };
    const partial = {
      standaloneChats: [],
    } as unknown as SessionViewModel;
    expect(() =>
      routeDesktopSidebarSelection(
        { kind: 'workspace', workspaceLocalId: 'cowork-1' },
        partial,
        actions,
      ),
    ).not.toThrow();
    expect(actions.selectWorkspace).not.toHaveBeenCalled();
  });

  it('maps the stable desktop selectors used by the switched surface', () => {
    expect(DESKTOP_SHARED_SIDEBAR_TEST_IDS).toMatchObject({
      root: 'sidebar-shared-rail',
      workspacesSection: 'sidebar-section-code',
      addWorkspace: 'sidebar-section-code-add',
      worktreeActionsMenuButton: 'worktree-actions-menu-button',
      worktreeActionsMenu: 'worktree-actions-menu',
      worktreeRemoval: 'worktree-actions-menu-archive',
      worktreeDirectRemoval: 'worktree-archive-button',
      workspaceOptionsButton: 'workspace-project-options-button',
      workspaceContextMenu: 'workspace-session-context-menu',
    });
    expect(DESKTOP_SHARED_SIDEBAR_TEST_IDS.worktreeRow?.('w', 't')).toBe(
      'worktree-row',
    );
    expect(DESKTOP_SHARED_SIDEBAR_TEST_IDS.coworkWorkspace?.('cowork-1')).toBe(
      'sidebar-cowork-project-cowork-1',
    );
  });

  it('supplies no main-nav actions, because AppSidebar owns the native nav', async () => {
    // This host is nested INSIDE AppSidebar's workspaces section (and inside
    // the shadow panel), not mounted as the whole rail: AppSidebar renders
    // `sidebar-primary-navigation` above it. Supplying nav actions here made
    // SidebarSurface render a second, unstyled set of Plugins/Pipelines rows
    // directly under the native ones. Keys with no action are omitted from the
    // main nav, so supplying none is what keeps the nested surface to its
    // actual job — the workspaces list.
    const module: Record<string, unknown> =
      await import('../DesktopSharedSidebarHost');
    expect('DESKTOP_SIDEBAR_NAV_ITEM_ACTIONS' in module).toBe(false);
    expect('DESKTOP_SIDEBAR_MORE_ITEM_ACTIONS' in module).toBe(false);
  });

  it('suppresses archived counts for cowork projects', () => {
    const projects = [
      { id: 'cowork', type: 'cowork', archivedContainerCount: 3 },
      { id: 'code', type: 'single-repo', archivedContainerCount: 4 },
    ];

    expect(desktopArchivedCount(projects, 'cowork')).toBeUndefined();
    expect(desktopArchivedCount(projects, 'code')).toBe(4);
  });

  // A desktop row leaves the rail the moment the store lets go of it (its
  // archive is in flight), ahead of the snapshot. Only a cloud row, which the
  // store never holds, is the snapshot's to list regardless.
  describe('isSnapshotWorktreeListed', () => {
    const projects = [
      { id: 'code-1', type: 'single-repo', worktrees: [{ id: 'kept' }] },
      { id: 'cowork-1', type: 'cowork' },
    ];

    it('lists a desktop row the store holds', () => {
      expect(
        isSnapshotWorktreeListed(projects, {
          workspaceLocalId: 'code-1',
          localId: 'kept',
        }),
      ).toBe(true);
    });

    it('hides a desktop row the store has released', () => {
      expect(
        isSnapshotWorktreeListed(projects, {
          workspaceLocalId: 'code-1',
          localId: 'archiving',
        }),
      ).toBe(false);
      expect(
        isSnapshotWorktreeListed(projects, {
          workspaceLocalId: 'code-1',
          localId: 'archiving',
          backend: 'desktop',
        }),
      ).toBe(false);
    });

    it('lists a cloud row even inside a store project', () => {
      expect(
        isSnapshotWorktreeListed(projects, {
          workspaceLocalId: 'code-1',
          localId: 'cloud-session',
          backend: 'cloud',
        }),
      ).toBe(true);
    });

    it('leaves rows of workspaces the store does not own to the snapshot', () => {
      expect(
        isSnapshotWorktreeListed(projects, {
          workspaceLocalId: 'cloud:ws',
          localId: 'chat',
        }),
      ).toBe(true);
      expect(
        isSnapshotWorktreeListed(projects, {
          workspaceLocalId: 'cowork-1',
          localId: 'entry',
        }),
      ).toBe(true);
    });
  });

  describe('overlayStorePresentation', () => {
    const base: SessionViewModel = {
      ...snapshot,
      workspaces: [
        {
          localId: 'code-1',
          name: 'Code',
          type: 'single-repo',
          layout: 'tree',
        },
        { localId: 'cowork-1', name: 'Cowork', type: 'cowork', layout: 'flat' },
      ],
      worktrees: [
        { localId: 'wt-1', workspaceLocalId: 'code-1', branch: 'a' },
        { localId: 'wt-2', workspaceLocalId: 'code-1', branch: 'b' },
      ],
    };
    const projects: SidebarItem[] = [
      makeSingleRepoProject('code-1', {
        collapsed: true,
        worktrees: [
          {
            id: 'wt-1',
            branchName: 'a',
            createdAt: '2026-01-01T00:00:00.000Z',
            pinned: true,
          },
          {
            id: 'wt-2',
            branchName: 'b',
            createdAt: '2026-01-01T00:00:00.000Z',
            hidden: true,
          },
        ],
      }),
      makeCoworkProject('cowork-1'),
    ];

    it('reads collapse, pin, and hide from the store ahead of the snapshot', () => {
      const result = overlayStorePresentation(base, projects);
      // An unset snapshot flag already reads as expanded, so a store row that
      // agrees leaves the workspace untouched.
      expect(result.workspaces.map((w) => w.collapsed)).toEqual([
        true,
        undefined,
      ]);
      expect(result.worktrees.map((w) => [w.pinned, w.hidden])).toEqual([
        [true, false],
        [false, true],
      ]);
    });

    it('keeps the snapshot identity when the store agrees', () => {
      const agreed = overlayStorePresentation(base, projects);
      expect(overlayStorePresentation(agreed, projects)).toBe(agreed);
      expect(overlayStorePresentation(base, [])).toBe(base);
    });
    // The main-process projection orders projects by their persisted slot
    // only; pinned projects lead the Projects list (CAN-1074), as on the
    // legacy rail. Persisted order holds within each group.
    const ordered: SessionViewModel = {
      ...snapshot,
      workspaces: [
        {
          localId: 'code-1',
          name: 'Code 1',
          type: 'single-repo',
          layout: 'tree',
          order: 0,
        },
        {
          localId: 'catalog',
          name: 'Catalog',
          type: 'single-repo',
          layout: 'tree',
          order: 1,
        },
        {
          localId: 'code-2',
          name: 'Code 2',
          type: 'single-repo',
          layout: 'tree',
          order: 2,
        },
        {
          localId: 'cowork-1',
          name: 'Cowork',
          type: 'cowork',
          layout: 'flat',
          order: 3,
        },
      ],
      worktrees: [],
    };
    const orderedProjects: SidebarItem[] = [
      makeSingleRepoProject('code-1'),
      makeSingleRepoProject('code-2'),
      makeCoworkProject('cowork-1'),
    ];
    const rendered = (pinned: string[]): Array<[string, number | undefined]> =>
      [
        ...overlayStorePresentation(ordered, orderedProjects, new Set(pinned))
          .workspaces,
      ]
        .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
        .map((workspace) => [workspace.localId, workspace.order]);

    it('lifts pinned store projects into the leading slots', () => {
      // Store projects reuse their own slots (0, 2, 3); a workspace the store
      // does not own keeps its slot.
      expect(rendered(['cowork-1'])).toEqual([
        ['cowork-1', 0],
        ['catalog', 1],
        ['code-1', 2],
        ['code-2', 3],
      ]);
    });

    it('keeps persisted order within the pinned and unpinned groups', () => {
      expect(rendered(['cowork-1', 'code-2'])).toEqual([
        ['code-2', 0],
        ['catalog', 1],
        ['cowork-1', 2],
        ['code-1', 3],
      ]);
    });

    it('keeps the snapshot identity when pins do not change the order', () => {
      expect(
        overlayStorePresentation(ordered, orderedProjects, new Set(['code-1'])),
      ).toBe(ordered);
      expect(
        overlayStorePresentation(ordered, orderedProjects, new Set()),
      ).toBe(ordered);
    });
  });
  // An empty `alwaysShow: false` project lands in the Hidden disclosure, as
  // the legacy list's `hiddenProjects` did, instead of leaving the rail.
  describe('deferEmptyWorkspaces', () => {
    const base: SessionViewModel = {
      ...snapshot,
      workspaces: [
        {
          localId: 'code-1',
          name: 'Code 1',
          type: 'single-repo',
          layout: 'tree',
        },
        {
          localId: 'code-2',
          name: 'Code 2',
          type: 'single-repo',
          layout: 'tree',
        },
      ],
    };

    it('keeps an empty deferred workspace listed, marked hidden', () => {
      const result = deferEmptyWorkspaces(base, new Set(['code-2']));
      expect(result.workspaces.map((w) => [w.localId, w.hidden])).toEqual([
        ['code-1', undefined],
        ['code-2', true],
      ]);
    });

    it('keeps the snapshot identity when nothing is deferred', () => {
      expect(deferEmptyWorkspaces(base, new Set())).toBe(base);
      const deferred = deferEmptyWorkspaces(base, new Set(['code-2']));
      expect(deferEmptyWorkspaces(deferred, new Set(['code-2']))).toBe(
        deferred,
      );
    });
  });
});

// Desktop-only row menu items land beside the shared item they belong with,
// and never after the Hide and removal group (CAN-3053).
describe('insertWorktreeMenuItemAfter', () => {
  const item = (
    key: 'branch-info' | 'add-repository' | 'toggle-hidden' | 'archive',
    separatorBefore?: boolean,
  ): {
    key: typeof key;
    label: string;
    icon: null;
    separatorBefore?: boolean;
  } => ({
    key,
    label: key,
    icon: null,
    ...(separatorBefore ? { separatorBefore } : {}),
  });
  const split = { key: 'split-workspace' as const, label: 'Split', icon: null };

  it('follows its anchor', () => {
    expect(
      insertWorktreeMenuItemAfter(
        [item('branch-info'), item('add-repository'), item('archive', true)],
        split,
        'add-repository',
      ).map((entry) => entry.key),
    ).toEqual(['branch-info', 'add-repository', 'split-workspace', 'archive']);
  });

  it('precedes the separated tail without its anchor', () => {
    expect(
      insertWorktreeMenuItemAfter(
        [item('branch-info'), item('toggle-hidden', true), item('archive')],
        split,
        'add-repository',
      ).map((entry) => entry.key),
    ).toEqual(['branch-info', 'split-workspace', 'toggle-hidden', 'archive']);
  });

  it('appends to a menu with neither', () => {
    expect(
      insertWorktreeMenuItemAfter(
        [item('branch-info')],
        split,
        'add-repository',
      ).map((entry) => entry.key),
    ).toEqual(['branch-info', 'split-workspace']);
  });
});
