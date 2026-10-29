/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import {
  LayoutTierProvider,
  sidebarNavItemClassName,
  type TerminalPopoverRow,
} from '@canopy/ui-shared/components';
import type { CanopyCapabilities } from '@canopy/app-core';
import type { PortalSessionShellState } from '@canopy/protocol/portal';
import {
  DEFAULT_SIDEBAR_NAV_LAYOUT,
  type SidebarNavLayout,
} from '@canopy/protocol/sidebar';
import {
  applyBranchGroupingOverrides,
  scriptsForSave,
  SidebarSurface,
  type SidebarSurfaceProps,
  type SidebarSurfaceSnapshot,
} from '../SidebarSurface';
import { RAIL_SECTION_HEADER_PADDING_RIGHT } from '../sidebar';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const capabilities = {
  localExecution: false,
  terminalPty: false,
  fileSystemAccess: 'read' as const,
  voice: false,
  settingsScope: 'api-keys-only' as const,
  pipelines: 'crud-only' as const,
  routing: 'url' as const,
  overviewNotifications: false,
  workspaceCreation: 'remote-clone' as const,
  workspaceReordering: false,
  worktreeReordering: false,
  workspaceSettings: false,
  // Every row-removal test below passes `onArchiveWorktree`; the capability
  // has to agree, now that the row's own `worktreeRemoval` gates the
  // affordance instead of handler presence alone (REG-2816).
  worktreeRemoval: 'archive' as const,
};

const snapshot = {
  workspaces: [
    { localId: 'workspace', name: 'Workspace', type: 'single-repo' as const },
  ],
  worktrees: [
    {
      localId: 'worktree',
      workspaceLocalId: 'workspace',
      branch: 'main',
    },
  ],
  standaloneChats: [],
} as PortalSessionShellState;

/**
 * The pre-CAN-3678 arrangement: Overview through Workers in More. Tests
 * of More's own behavior pass it explicitly now that the default More is empty.
 */
const MORE_PAGES_LAYOUT: SidebarNavLayout = {
  order: [...DEFAULT_SIDEBAR_NAV_LAYOUT.order],
  moreStartIndex: DEFAULT_SIDEBAR_NAV_LAYOUT.order.indexOf('overview'),
};

describe('SidebarSurface', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(
    contentState: 'waiting' | 'loading' | 'empty' | 'ready',
    props: Partial<SidebarSurfaceProps> = {},
    nextSnapshot: SidebarSurfaceSnapshot = snapshot,
    tier?: 'phone' | 'tablet' | 'desktop',
  ): void {
    act(() => {
      const surface = (
        <SidebarSurface
          variant="rail"
          snapshot={nextSnapshot}
          selection={{ kind: 'workspace', workspaceLocalId: 'workspace' }}
          capabilities={capabilities}
          contentState={contentState}
          onSelect={() => undefined}
          testIds={{
            root: 'portal-sidebar',
            loading: 'portal-sidebar-hydrating',
            empty: 'portal-sidebar-empty',
            workspaceList: 'portal-workspace-list',
          }}
          {...props}
        />
      );
      root.render(
        tier === undefined ? (
          surface
        ) : (
          <LayoutTierProvider tier={tier}>{surface}</LayoutTierProvider>
        ),
      );
    });
  }

  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('preserves filtered Projects controls across a host collapse', () => {
    const props = {
      workspacesSectionCollapsible: true,
      workspacesSectionFiltered: true,
      addWorkspaceRevealed: true,
      onCreateWorkspace: jest.fn(),
      renderWorkspacesSectionMenuItems: (): null => null,
    };
    render('ready', { ...props, workspacesSectionInitiallyCollapsed: false });
    render('ready', { ...props, workspacesSectionInitiallyCollapsed: true });
    const menu = container.querySelector(
      '[data-testid="portal-workspaces-menu"]',
    );
    const add = container.querySelector('[data-testid="portal-add-workspace"]');
    expect(menu).not.toBeNull();
    expect(add).not.toBeNull();
    for (const control of [menu, add]) {
      expect(control?.closest('[class~="pointer-fine:invisible"]')).toBeNull();
    }
  });

  describe('creation follows each row client worktreeCreation (REG-3022)', () => {
    const creatingCapabilities: CanopyCapabilities = {
      ...capabilities,
      worktreeCreation: true,
    };
    const readOnlyCapabilities: CanopyCapabilities = {
      ...capabilities,
      worktreeCreation: false,
    };
    const hostSnapshot: SidebarSurfaceSnapshot = {
      workspaces: [
        {
          localId: 'cloud:ws:cowork',
          name: 'Cowork',
          type: 'cowork',
          layout: 'tree',
          backend: 'cloud',
        },
        {
          localId: 'cloud:ws:repo',
          name: 'Repository',
          type: 'single-repo',
          layout: 'tree',
          backend: 'cloud',
        },
        {
          localId: 'ws-code',
          name: 'Desktop',
          type: 'single-repo',
          itemSortMode: 'manual',
        },
      ],
      worktrees: [
        {
          localId: 'cloud:task:cowork',
          workspaceLocalId: 'cloud:ws:cowork',
          branch: 'cloud',
          backend: 'cloud',
        },
        {
          localId: 'cloud:task:repo',
          workspaceLocalId: 'cloud:ws:repo',
          branch: 'feature/repo',
          backend: 'cloud',
        },
        { localId: 'wt-code', workspaceLocalId: 'ws-code', branch: 'main' },
      ],
      standaloneChats: [],
    };

    /** The project `+` for the named project, when the sidebar offers one. */
    const projectAdd = (name: string): Element | null =>
      container.querySelector(
        `[aria-label^="Create "][aria-label$=" for ${name}"]`,
      );

    it("hides the project + when the row's client reports no worktreeCreation", () => {
      render('ready', {
        selection: null,
        onCreateWorktree: jest.fn(),
        capabilitiesFor: () => readOnlyCapabilities,
      });

      expect(container.textContent).toContain('Workspace');
      expect(projectAdd('Workspace')).toBeNull();
    });

    it('offers the project + when the row client reports worktreeCreation', () => {
      render('ready', {
        selection: null,
        onCreateWorktree: jest.fn(),
        capabilitiesFor: () => creatingCapabilities,
      });

      expect(projectAdd('Workspace')).not.toBeNull();
    });

    it('treats an unreported worktreeCreation as unavailable', () => {
      render('ready', { selection: null, onCreateWorktree: jest.fn() });

      expect(projectAdd('Workspace')).toBeNull();
    });

    it('still withholds the + without a host create handler', () => {
      render('ready', {
        selection: null,
        capabilitiesFor: () => creatingCapabilities,
      });

      expect(projectAdd('Workspace')).toBeNull();
    });

    it('keeps Cowork and Desktop + while a repository project without the rollout loses its own', () => {
      // The cloud adapter's answers with the Cloud Git flag off: Cowork's `+`
      // is callback-backed and independent of the rollout, the repository
      // project's creation is not granted, and the desktop client always
      // creates.
      render(
        'ready',
        {
          selection: null,
          onCreateWorktree: jest.fn(),
          capabilitiesFor: (localId) =>
            localId === 'cloud:ws:repo' || localId === 'cloud:task:repo'
              ? readOnlyCapabilities
              : creatingCapabilities,
        },
        hostSnapshot,
      );

      expect(projectAdd('Cowork')).not.toBeNull();
      expect(projectAdd('Desktop')).not.toBeNull();
      expect(projectAdd('Repository')).toBeNull();
    });

    it.each([
      [
        'creation and branching',
        { worktreeCreation: true, worktreeBranching: true },
        true,
      ],
      [
        'creation without branching',
        { worktreeCreation: true, worktreeBranching: false },
        false,
      ],
      ['creation with branching unreported', { worktreeCreation: true }, false],
      [
        'branching without creation',
        { worktreeCreation: false, worktreeBranching: true },
        false,
      ],
      ['neither reported', {}, false],
    ] as const)(
      'offers the Branch from row action only for a row client that reports both: %s',
      (_name, rowReports, offered) => {
        // A cloud repository row with creation on is the case that matters:
        // `worktree.create` refuses a base worktree there, so the item must
        // not be offered however creation is granted.
        render(
          'ready',
          {
            selection: null,
            onCreateWorktree: jest.fn(),
            onCreateBranchWorktree: jest.fn(),
            capabilitiesFor: (localId) =>
              localId === 'cloud:task:repo' || localId === 'cloud:ws:repo'
                ? { ...capabilities, ...rowReports }
                : {
                    ...capabilities,
                    worktreeCreation: true,
                    worktreeBranching: true,
                  },
          },
          hostSnapshot,
        );
        const rowMenuText = (worktreeLocalId: string): string => {
          const trigger = container
            .querySelector(`[data-worktree-id="${worktreeLocalId}"]`)
            ?.querySelector<HTMLButtonElement>(
              '[data-testid="portal-worktree-actions-menu-button"]',
            );
          expect(trigger).not.toBeNull();
          act(() => trigger?.click());
          const menus = document.querySelectorAll(
            '[data-testid="portal-worktree-actions-menu"]',
          );
          expect(menus).toHaveLength(1);
          const text = menus[0].textContent ?? '';
          act(() => {
            menus[0]
              .querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[0]
              ?.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
              );
          });
          return text;
        };

        // Positive control first (a Desktop-like row that reports both), so
        // the repository assertion cannot pass by opening nothing.
        expect(rowMenuText('wt-code')).toContain('Branch from');
        expect(rowMenuText('cloud:task:repo').includes('Branch from')).toBe(
          offered,
        );
      },
    );
  });

  it('pages projects after filtering and keeps the selected project when shortened', () => {
    const many: SidebarSurfaceSnapshot = {
      workspaces: Array.from({ length: 25 }, (_, index) => ({
        localId: `project-${index + 1}`,
        name: `Project ${index + 1}`,
        type: 'single-repo',
        order: index,
        collapsed: true,
      })),
      worktrees: [],
      standaloneChats: [],
    };
    const rows = (): Element[] =>
      Array.from(container.querySelectorAll('[data-workspace-id]'));
    const click = (id: string): void => {
      const button = container.querySelector<HTMLButtonElement>(
        `[data-testid="${id}"]`,
      );
      expect(button).not.toBeNull();
      act(() => button?.click());
    };
    render('ready', { selection: null }, many);
    expect(rows()).toHaveLength(10);
    click('sidebar-projects-show-more');
    expect(rows()).toHaveLength(20);
    click('sidebar-projects-show-more');
    expect(rows()).toHaveLength(25);
    render(
      'ready',
      { selection: { kind: 'workspace', workspaceLocalId: 'project-25' } },
      many,
    );
    click('sidebar-projects-show-less');
    expect(rows()).toHaveLength(11);
    expect(container.textContent).toContain('Project 25');
    expect(
      container.querySelector('[data-testid="sidebar-projects-show-more"]')
        ?.textContent,
    ).toContain('14');

    render(
      'ready',
      {
        selection: null,
        pendingRevealTarget: {
          workspaceLocalId: 'project-25',
          worktreeLocalId: 'new-worktree',
        },
      },
      many,
    );
    expect(rows()).toHaveLength(11);
    expect(
      container.querySelector('[data-workspace-id="project-25"]'),
    ).not.toBeNull();

    render(
      'ready',
      {
        selection: { kind: 'workspace', workspaceLocalId: 'project-25' },
        projectListRetainedWorkspaceIds: ['project-23', 'project-24'],
      },
      many,
    );
    expect(rows()).toHaveLength(13);
    for (const id of ['project-23', 'project-24', 'project-25']) {
      expect(
        container.querySelector(`[data-workspace-id="${id}"]`),
      ).not.toBeNull();
    }

    // A retained row in the next page must not consume a newly revealed slot.
    render(
      'ready',
      { selection: { kind: 'workspace', workspaceLocalId: 'project-15' } },
      many,
    );
    expect(rows()).toHaveLength(11);
    click('sidebar-projects-show-more');
    expect(rows()).toHaveLength(21);
    expect(
      container.querySelector('[data-workspace-id="project-21"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="sidebar-projects-show-more"]')
        ?.textContent,
    ).toContain('4');
    click('sidebar-projects-show-less');
    expect(rows()).toHaveLength(11);

    // Filtered-out projects never consume one of the ten visible slots.
    render(
      'ready',
      {
        selection: null,
        visibleWorkspaceIds: new Set(
          many.workspaces.slice(15).map((workspace) => workspace.localId),
        ),
      },
      many,
    );
    expect(rows()).toHaveLength(10);
    expect(
      container.querySelector('[data-testid="sidebar-projects-show-more"]'),
    ).toBeNull();
    expect(rows().map((row) => row.getAttribute('data-workspace-id'))).toEqual(
      many.workspaces.slice(15).map((workspace) => workspace.localId),
    );
  });

  it('starts with a short project list when switching organization context', () => {
    const many: SidebarSurfaceSnapshot = {
      workspaces: ['a', 'b'].flatMap((organizationId) =>
        Array.from({ length: 15 }, (_, index) => ({
          localId: `${organizationId}-${index}`,
          name: `${organizationId} project ${index}`,
          type: 'single-repo' as const,
          collapsed: true,
          owner: { type: 'organization' as const, organizationId },
        })),
      ),
      worktrees: [],
      standaloneChats: [],
    };
    render(
      'ready',
      {
        selection: null,
        context: { kind: 'organization', organizationId: 'a' },
      },
      many,
    );
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-projects-show-more"]',
        )
        ?.click(),
    );
    expect(container.querySelectorAll('[data-workspace-id]')).toHaveLength(15);
    render(
      'ready',
      {
        selection: null,
        context: { kind: 'organization', organizationId: 'b' },
      },
      many,
    );
    expect(container.querySelectorAll('[data-workspace-id]')).toHaveLength(10);
    expect(
      container.querySelector('[data-testid="sidebar-projects-show-less"]'),
    ).toBeNull();
  });

  it('passes linked Personal admission through the sections in an organization', () => {
    const props = {
      context: { kind: 'organization', organizationId: 'org-a' } as const,
      linkedPersonalWorkspaceIds: ['workspace'],
    };
    render('ready', props);
    expect(container.textContent).toContain('Workspace');
    render('ready', { ...props, linkedPersonalWorkspaceIds: [] });
    expect(container.textContent).not.toContain('Workspace');
  });

  it('renders the shared chrome and blended ready content', () => {
    render('ready');
    expect(
      container.querySelector('[data-testid="portal-sidebar"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="portal-workspace-list"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('New task');
    // No More: this host serves none of the More keys, so the trigger is gone.
    // Assert the testid, not a `textContent` substring — unrelated copy
    // containing "More" would otherwise fail this for the wrong reason.
    expect(container.querySelector('[data-testid="portal-more"]')).toBeNull();
  });

  it('places host row status in the reserved trailing slot before actions', () => {
    render('ready', {
      renderWorktreeStatus: () => (
        <span data-testid="host-row-status">Shared</span>
      ),
    });

    const status = container.querySelector('[data-testid="host-row-status"]');
    expect(
      status?.closest('[data-testid="worktree-row-trailing-slot"]'),
    ).not.toBeNull();
  });

  it('does not reserve a trailing slot when the host returns no status', () => {
    render('ready', { renderWorktreeStatus: () => null });

    expect(
      container.querySelector('[data-testid="worktree-row-trailing-slot"]'),
    ).toBeNull();
  });

  it('renders shared placeholder projects in a dedicated non-commandable section', () => {
    const onCreateWorktree = jest.fn();
    const onDeleteWorkspace = jest.fn();
    const onReorderWorkspaces = jest.fn();
    render(
      'ready',
      {
        sharedWorkspaceIds: new Set(['shared-project']),
        additionalRows: <div data-testid="host-additional-row">Catalog</div>,
        onCreateWorktree,
        onDeleteWorkspace,
        onReorderWorkspaces,
      },
      {
        ...snapshot,
        workspaces: [
          ...snapshot.workspaces,
          {
            localId: 'shared-project',
            name: 'Owner project',
            type: 'cowork',
            layout: 'tree',
            backend: 'cloud',
          },
        ],
        worktrees: [
          ...snapshot.worktrees,
          {
            localId: 'shared-chat',
            workspaceLocalId: 'shared-project',
            branch: 'cloud',
            backend: 'cloud',
          },
        ],
      },
    );

    const shared = container.querySelector(
      '[data-testid="portal-shared-with-me-section"]',
    );
    expect(shared?.textContent).toContain('Shared with you');
    expect(shared?.textContent).toContain('Owner project');
    expect(
      container.querySelector('[data-testid="portal-workspace-list"]')
        ?.textContent,
    ).not.toContain('Owner project');
    expect(
      shared?.querySelector('[data-testid="portal-add-worktree"]'),
    ).toBeNull();
    expect(
      shared?.querySelector('[data-testid*="workspace-actions"]'),
    ).toBeNull();
    expect(
      container.querySelectorAll('[data-testid="host-additional-row"]'),
    ).toHaveLength(1);
  });

  // CAN-3612. The portal's Shared with me rows are not hand-rolled: they go
  // through the same workspace header and worktree row as the project list,
  // which is what keeps their titles on the standard column in the rail and
  // in the touch drawer.
  it.each([
    ['rail', 'h-8'],
    ['drawer', 'min-h-11'],
  ] as const)(
    'renders shared rows through the standard row grid in the %s',
    (variant, headerHeightClass) => {
      render(
        'ready',
        { variant, sharedWorkspaceIds: new Set(['shared-project']) },
        {
          ...snapshot,
          workspaces: [
            ...snapshot.workspaces,
            {
              localId: 'shared-project',
              name: 'Owner project',
              type: 'cowork',
              layout: 'tree',
              backend: 'cloud',
            },
          ],
          worktrees: [
            ...snapshot.worktrees,
            {
              localId: 'shared-chat',
              workspaceLocalId: 'shared-project',
              branch: 'cloud',
              backend: 'cloud',
            },
          ],
        },
      );

      const list = container.querySelector(
        '[data-testid="portal-shared-with-me-list"]',
      );
      expect(list).not.toBeNull();
      const header = Array.from(
        list?.querySelectorAll<HTMLElement>('.rounded-row') ?? [],
      ).find((element) => element.textContent?.includes('Owner project'));
      expect(header).toBeDefined();
      for (const className of ['pl-1.5', 'pr-1', headerHeightClass]) {
        expect(header?.classList.contains(className)).toBe(true);
      }
      // The child row reserves the standard leading slot.
      const slot = list?.querySelector(
        '[data-testid^="worktree-row-leading-slot"]',
      );
      expect(slot).not.toBeNull();
      expect(slot?.classList.contains('w-5')).toBe(true);
      expect(slot?.parentElement?.classList.contains('gap-1.5')).toBe(true);
    },
  );

  it('hides access-lost shared rows and their empty placeholder project', () => {
    render(
      'ready',
      {
        sharedWorkspaceIds: new Set(['shared-project']),
        hiddenWorktreeIds: new Set(['shared-chat']),
      },
      {
        ...snapshot,
        workspaces: [
          ...snapshot.workspaces,
          {
            localId: 'shared-project',
            name: 'Owner project',
            type: 'cowork',
            layout: 'tree',
            backend: 'cloud',
          },
        ],
        worktrees: [
          ...snapshot.worktrees,
          {
            localId: 'shared-chat',
            workspaceLocalId: 'shared-project',
            branch: 'cloud',
            backend: 'cloud',
          },
        ],
      },
    );

    expect(
      container.querySelector('[data-testid="portal-shared-with-me-section"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain('Owner project');
  });

  describe('chat search disclosure', () => {
    const chatSearch: Partial<SidebarSurfaceProps> = {
      chatSearch: { candidates: [], onSelectResult: () => undefined },
    };

    it("renders the permanent row and no toggle by default ('row')", () => {
      render('ready', chatSearch);
      expect(
        container.querySelector(
          '[data-testid="portal-sidebar-chat-search-input"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelector(
          '[data-testid="portal-sidebar-chat-search-toggle"]',
        ),
      ).toBeNull();
    });

    it("hides the input behind a header magnifier under 'header-icon'", () => {
      render('ready', {
        ...chatSearch,
        chatSearchPresentation: 'header-icon',
        headerSlot: <span>Brand</span>,
      });
      const toggle = container.querySelector<HTMLButtonElement>(
        '[data-testid="portal-sidebar-chat-search-toggle"]',
      );
      expect(toggle).not.toBeNull();
      expect(toggle?.getAttribute('aria-expanded')).toBe('false');
      // Never both: two search affordances is worse than either one.
      expect(
        container.querySelector(
          '[data-testid="portal-sidebar-chat-search-input"]',
        ),
      ).toBeNull();

      act(() => toggle?.click());

      // The SAME input, same testid — a disclosure change, not a rewrite — and
      // focused, so the reveal is not a dead click.
      const input = container.querySelector<HTMLInputElement>(
        '[data-testid="portal-sidebar-chat-search-input"]',
      );
      expect(input).not.toBeNull();
      expect(document.activeElement).toBe(input);
      expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    });

    it('clears a typed query on Escape, and collapses only on an empty one', () => {
      render('ready', {
        ...chatSearch,
        chatSearchPresentation: 'header-icon',
        headerSlot: <span>Brand</span>,
      });
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="portal-sidebar-chat-search-toggle"]',
          )
          ?.click(),
      );
      const input = (): HTMLInputElement | null =>
        container.querySelector<HTMLInputElement>(
          '[data-testid="portal-sidebar-chat-search-input"]',
        );

      const typed = input();
      act(() => {
        if (!typed) return;
        // React tracks the controlled value on the node, so a plain `.value =`
        // assignment is swallowed as a no-op change. Go through the prototype
        // setter the way React's own test utils do.
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set?.call(typed, 'redfish');
        typed.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(input()?.value).toBe('redfish');

      const escape = (): void =>
        act(() => {
          input()?.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
          );
        });

      // First Escape clears the query but keeps the affordance open.
      escape();
      expect(input()).not.toBeNull();
      expect(input()?.value).toBe('');

      // Second Escape, now on an empty query, puts it away.
      escape();
      expect(input()).toBeNull();
    });
  });

  it('keeps the Workspaces section static by default for existing hosts', () => {
    render('ready');
    expect(
      container.querySelector(
        '[data-testid="portal-workspaces-section-toggle"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="portal-workspace-list"]'),
    ).not.toBeNull();
  });

  it('collapses and restores the whole Workspaces section when enabled', () => {
    render('ready', {
      workspacesSectionCollapsible: true,
      additionalRows: <div data-testid="host-additional-row">Catalog</div>,
    });
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="portal-workspaces-section-toggle"]',
    );
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(
      container.querySelector('[data-testid="portal-workspace-list"]'),
    ).not.toBeNull();

    act(() => toggle?.click());
    expect(
      container.querySelector('[data-testid="portal-workspace-list"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="host-additional-row"]'),
    ).not.toBeNull();

    act(() => toggle?.click());
    expect(
      container.querySelector('[data-testid="portal-workspace-list"]'),
    ).not.toBeNull();
  });

  // The host swaps this value at the sidebar's baseline -> live data handoff:
  // the baseline leg does not know the persisted collapse, the live leg does.
  // That used to be carried by a `key` remount in the web host, which also
  // destroyed every other piece of interaction state in this component (an
  // open chat search, an open menu, a pending confirmation dialog). The key is
  // gone, so this value has to reconcile on its own.
  it('adopts a changed initial collapse from the host', () => {
    const props = {
      workspacesSectionCollapsible: true,
      workspacesSectionInitiallyCollapsed: false,
    };
    render('ready', props);
    expect(
      container.querySelector('[data-testid="portal-workspace-list"]'),
    ).not.toBeNull();

    render('ready', { ...props, workspacesSectionInitiallyCollapsed: true });
    expect(
      container.querySelector('[data-testid="portal-workspace-list"]'),
    ).toBeNull();

    render('ready', { ...props, workspacesSectionInitiallyCollapsed: false });
    expect(
      container.querySelector('[data-testid="portal-workspace-list"]'),
    ).not.toBeNull();
  });

  // ...but it must stay the INITIAL value, not a controlled one: re-rendering
  // for any other reason cannot yank the section back from where the user just
  // put it.
  it('keeps the user collapse across re-renders that do not change the prop', () => {
    const props = {
      workspacesSectionCollapsible: true,
      workspacesSectionInitiallyCollapsed: false,
    };
    render('ready', props);
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="portal-workspaces-section-toggle"]',
    );
    act(() => toggle?.click());
    expect(
      container.querySelector('[data-testid="portal-workspace-list"]'),
    ).toBeNull();

    render('ready', { ...props, workspacesSectionCollapsible: true });
    expect(
      container.querySelector('[data-testid="portal-workspace-list"]'),
    ).toBeNull();
  });

  // The reverse of the handoff above, and the dangerous direction. The web
  // rail only mounts its mutation session on `/chat`, so leaving that route
  // takes `onArchiveWorktree` away while the rail stays mounted. A removal
  // dialog left open from the live side would then confirm into an optional
  // call that does nothing and close itself, reporting a destructive action as
  // done. It must not survive the owner change.
  it('drops a command-bound dialog when the data owner changes', () => {
    const onArchiveWorktree = jest.fn();
    const live = {
      dataOwnerId: 'live',
      capabilities: {
        ...capabilities,
        worktreeRetention: 'archive-or-delete' as const,
      },
      onArchiveWorktree,
      worktreeRetentionDaysFor: (): number => 7,
    };
    render('ready', live);
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="portal-worktree-actions-menu-button"]',
        )
        ?.click(),
    );
    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="portal-worktree-actions-delete"]',
        )
        ?.click(),
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    // The owner changes and the handler is DELIBERATELY still supplied here,
    // so this pins the reset itself rather than the render guard that also
    // hides the dialog once `onArchiveWorktree` goes away.
    render('ready', { ...live, dataOwnerId: 'baseline' });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(onArchiveWorktree).not.toHaveBeenCalled();
  });

  // ...and the render guard on its own, for a host that drops the handler
  // without changing owner identity.
  it('never offers a removal confirm without a removal handler', () => {
    const live = {
      dataOwnerId: 'live',
      capabilities: {
        ...capabilities,
        worktreeRetention: 'archive-or-delete' as const,
      },
      onArchiveWorktree: jest.fn(),
      worktreeRetentionDaysFor: (): number => 7,
    };
    render('ready', live);
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="portal-worktree-actions-menu-button"]',
        )
        ?.click(),
    );
    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="portal-worktree-actions-delete"]',
        )
        ?.click(),
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    render('ready', { ...live, onArchiveWorktree: undefined });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each([
    [false, 'Set label', false],
    [true, 'Rename', true],
  ] as const)(
    'with compact hover actions %s, the worktree menu reads %s (More: %s)',
    (compactWorktreeHoverActions, labelRow, folds) => {
      render('ready', {
        compactWorktreeHoverActions,
        onUpdateWorktree: jest.fn(),
      });
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="portal-worktree-actions-menu-button"]',
          )
          ?.click(),
      );
      const labels = Array.from(
        document.querySelectorAll('[role="menuitem"]'),
        (item) => item.textContent?.trim(),
      );
      expect(labels).toContain(labelRow);
      expect(
        document.querySelector('[data-testid="worktree-actions-menu-more"]') !==
          null,
      ).toBe(folds);
    },
  );

  /** A compact (early access) host whose rows can be archived. */
  const archivable = {
    compactWorktreeHoverActions: true,
    onUpdateWorktree: jest.fn(),
    capabilities: {
      ...capabilities,
      worktreeRetention: 'archive-or-delete' as const,
    },
    onArchiveWorktree: jest.fn(),
    worktreeRetentionDaysFor: (): number => 7,
  };

  it('keeps a compact row Archive in place, disabled, while a session runs', () => {
    render('ready', {
      ...archivable,
      hasActiveWorktreeSession: () => true,
    });
    const archive = container.querySelector<HTMLButtonElement>(
      '[data-testid="portal-worktree-archive-button"]',
    );
    expect(archive).not.toBeNull();
    expect(archive?.disabled).toBe(true);
    expect(archive?.getAttribute('aria-label')).toBe(
      'Archive: Stop all sessions before archiving',
    );
  });

  it('offers a compact row Archive enabled when it can run', () => {
    render('ready', archivable);
    const archive = container.querySelector<HTMLButtonElement>(
      '[data-testid="portal-worktree-archive-button"]',
    );
    expect(archive?.disabled).toBe(false);
    expect(archive?.getAttribute('aria-label')).toBe('Archive');
  });

  // The other half of the same rule: state the USER owns crosses the handoff.
  it('keeps the section collapse across a data-owner change', () => {
    const props = {
      dataOwnerId: 'live',
      workspacesSectionCollapsible: true,
    };
    render('ready', props);
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="portal-workspaces-section-toggle"]',
        )
        ?.click(),
    );
    expect(
      container.querySelector('[data-testid="portal-workspace-list"]'),
    ).toBeNull();

    render('ready', { ...props, dataOwnerId: 'baseline' });
    expect(
      container.querySelector('[data-testid="portal-workspace-list"]'),
    ).toBeNull();
  });

  it('renders a host header slot and applies visible project ids', () => {
    render(
      'ready',
      {
        headerSlot: <button data-testid="host-filter">Filter</button>,
        visibleWorkspaceIds: new Set(['workspace']),
      },
      {
        ...snapshot,
        workspaces: [
          ...snapshot.workspaces,
          { localId: 'other', name: 'Other', type: 'single-repo' },
        ],
      },
    );
    expect(
      container.querySelector('[data-testid="host-filter"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain('Other');
  });

  describe('terminal status popover', () => {
    const runningSnapshot: SidebarSurfaceSnapshot = {
      ...snapshot,
      worktrees: [
        {
          localId: 'worktree',
          workspaceLocalId: 'workspace',
          branch: 'main',
          terminalStatus: 'running',
        },
      ],
    };

    function terminalRow(statusText: string): TerminalPopoverRow {
      return {
        terminalId: 'term-1',
        label: 'TERMINAL 1',
        statusText,
        statusClass: 'fg-info',
        dotClass: 'bg-fg-info',
      };
    }

    function terminalBadge(): HTMLElement {
      const badge = container.querySelector<HTMLElement>(
        '[data-testid="worktree-row-terminal-badge"]',
      );
      if (badge === null) throw new Error('terminal badge not rendered');
      return badge;
    }

    function popoverRowText(): string[] {
      return Array.from(
        document.querySelectorAll(
          '[data-testid="terminal-status-popover-row"]',
        ),
        (row) => row.textContent ?? '',
      );
    }

    it('reads rows from the host when it has no live source', () => {
      const getTerminalPopoverRows = jest.fn((): TerminalPopoverRow[] => [
        terminalRow('make'),
      ]);
      render('ready', { getTerminalPopoverRows }, runningSnapshot);

      expect(terminalBadge().getAttribute('aria-label')).toBe(
        'Terminal running',
      );
      act(() => terminalBadge().focus());
      expect(popoverRowText()).toEqual(['TERMINAL 1make']);
      expect(getTerminalPopoverRows).toHaveBeenCalledWith('worktree');
    });

    it('keeps an open popover live while the row status stays the same', () => {
      let rows = [terminalRow('make')];
      const listeners = new Set<() => void>();
      const subscribeTerminalPopoverRows = jest.fn(
        (_worktreeLocalId: string, onChange: () => void): (() => void) => {
          listeners.add(onChange);
          return (): void => {
            listeners.delete(onChange);
          };
        },
      );
      render(
        'ready',
        {
          getTerminalPopoverRows: (): TerminalPopoverRow[] => rows,
          subscribeTerminalPopoverRows,
        },
        runningSnapshot,
      );
      expect(subscribeTerminalPopoverRows).not.toHaveBeenCalled();

      act(() => terminalBadge().focus());
      expect(popoverRowText()).toEqual(['TERMINAL 1make']);
      expect(subscribeTerminalPopoverRows).toHaveBeenCalledWith(
        'worktree',
        expect.any(Function),
      );

      // The host's rows change without the sidebar re-rendering.
      rows = [terminalRow('exit 2')];
      act(() => {
        for (const listener of Array.from(listeners)) listener();
      });
      expect(popoverRowText()).toEqual(['TERMINAL 1exit 2']);

      act(() => terminalBadge().blur());
      expect(popoverRowText()).toEqual([]);
      expect(listeners.size).toBe(0);
    });
  });

  it('short-circuits shared create and settings dialogs when handled by host', async () => {
    const onOpenCreateWorkspaceOverride = jest.fn(() => true);
    const onOpenWorkspaceSettingsOverride = jest.fn(() => true);
    render('ready', {
      capabilities: { ...capabilities, workspaceSettings: 'full' },
      onOpenCreateWorkspaceOverride,
      onOpenWorkspaceSettingsOverride,
    });

    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="portal-add-workspace"]',
        )
        ?.click(),
    );
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Settings for Workspace"]',
        )
        ?.click(),
    );
    await flush();
    expect(onOpenCreateWorkspaceOverride).toHaveBeenCalledTimes(1);
    expect(onOpenWorkspaceSettingsOverride).toHaveBeenCalledWith(
      'workspace',
      undefined,
    );
    expect(
      document.querySelector('[data-testid="portal-create-workspace-dialog"]'),
    ).toBeNull();
    expect(
      document.querySelector(
        '[data-testid="portal-workspace-settings-dialog"]',
      ),
    ).toBeNull();
  });

  it('serves Share template only on cloud rows in a mixed web workspace list', async () => {
    const onOpenWorkspaceSettingsOverride = jest.fn(() => true);
    render(
      'ready',
      {
        capabilities: { ...capabilities, workspaceSettings: 'full' },
        onOpenWorkspaceSettingsOverride,
      },
      {
        ...snapshot,
        workspaces: [
          {
            localId: 'cloud:ws:cloud',
            name: 'Cloud workspace',
            type: 'cowork',
            layout: 'tree',
            backend: 'cloud',
          },
          {
            localId: 'remote',
            name: 'Remote workspace',
            type: 'single-repo',
            backend: 'remote-control',
          },
          {
            localId: 'desktop-code',
            name: 'Desktop code workspace',
            type: 'single-repo',
          },
        ],
        worktrees: [],
      },
    );
    await flush();

    const headerFor = (workspaceId: string): HTMLElement | null =>
      container
        .querySelector(`[data-workspace-id="${workspaceId}"]`)
        ?.querySelector<HTMLElement>('[aria-label^="Settings for "]')
        ?.closest<HTMLElement>('div.group') ?? null;

    const remoteHeader = headerFor('remote');
    expect(remoteHeader).toBeTruthy();
    act(() => {
      remoteHeader?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        }),
      );
    });
    expect(
      document.querySelector(
        '[data-testid="workspace-share-template-menu-item"]',
      ),
    ).toBeNull();

    const desktopCodeHeader = headerFor('desktop-code');
    expect(desktopCodeHeader).toBeTruthy();
    act(() => {
      desktopCodeHeader?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        }),
      );
    });
    expect(
      document.querySelector(
        '[data-testid="workspace-share-template-menu-item"]',
      ),
    ).toBeNull();

    const cloudHeader = headerFor('cloud:ws:cloud');
    expect(cloudHeader).toBeTruthy();
    act(() => {
      cloudHeader?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        }),
      );
    });

    const item = document.querySelector<HTMLElement>(
      '[data-testid="workspace-share-template-menu-item"]',
    );
    expect(item).not.toBeNull();
    act(() => item?.click());
    // Routes to the settings dialog's Share tab, not to a second transport.
    expect(onOpenWorkspaceSettingsOverride).toHaveBeenCalledWith(
      'cloud:ws:cloud',
      'share',
    );
  });

  it('drops Share template — and the whole menu — on a read-only rail', async () => {
    // No `onOpenWorkspaceSettingsOverride`: the read-only rail has no
    // settings dialog to open, so a `Share template` row would be permanently
    // dead chrome. Same policy `isServed` applies to nav rows.
    render('ready', {
      capabilities: { ...capabilities, workspaceSettings: 'full' },
    });
    await flush();

    const header = container.querySelector<HTMLElement>('div.group');
    // Guard against a vacuous pass: the row must exist for its absent menu to
    // mean anything.
    expect(header).toBeTruthy();
    act(() => {
      header?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
    });

    expect(
      document.querySelector(
        '[data-testid="workspace-share-template-menu-item"]',
      ),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="workspace-section-context-menu"]'),
    ).toBeNull();
  });

  it('gives a header the host declines no host menu rows', async () => {
    const renderWorkspaceContextMenuItems = jest.fn(
      (): JSX.Element => <button data-testid="host-menu-row">Host row</button>,
    );
    render('ready', {
      renderWorkspaceContextMenuItems,
      isWorkspaceContextMenuAvailable: () => false,
    });
    await flush();

    const header = container.querySelector<HTMLElement>('div.group');
    expect(header).toBeTruthy();
    act(() => {
      header?.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      );
    });

    expect(document.querySelector('[data-testid="host-menu-row"]')).toBeNull();
    expect(renderWorkspaceContextMenuItems).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="workspace-section-context-menu"]'),
    ).toBeNull();
  });

  it('does not open a dead create dialog when an override declines without a fallback', () => {
    const onOpenCreateWorkspaceOverride = jest.fn(() => false);
    render('ready', { onOpenCreateWorkspaceOverride });

    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="portal-add-workspace"]',
        )
        ?.click(),
    );

    expect(onOpenCreateWorkspaceOverride).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector('[data-testid="portal-create-workspace-dialog"]'),
    ).toBeNull();
  });

  it('uses host row, menu, section, and confirmation test ids', () => {
    render('ready', {
      onArchiveWorktree: jest.fn(),
      testIds: {
        workspaceSection: (workspaceId) =>
          `host-workspace-section-${workspaceId}`,
        worktreeRow: (_workspaceId, worktreeId) => `host-row-${worktreeId}`,
        worktreeActionsMenuButton: (_workspaceId, worktreeId) =>
          `host-actions-button-${worktreeId}`,
        worktreeActionsMenu: 'host-actions-menu',
        worktreeRemoval: 'host-remove',
        worktreeRemovalConfirm: 'host-remove-confirm',
      },
    });
    expect(
      container.querySelector(
        '[data-testid="host-workspace-section-workspace"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="host-row-worktree"]'),
    ).not.toBeNull();
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="host-actions-button-worktree"]',
        )
        ?.click(),
    );
    expect(
      document.querySelector('[data-testid="host-actions-menu"]'),
    ).not.toBeNull();
    act(() =>
      document
        .querySelector<HTMLButtonElement>('[data-testid="host-remove"]')
        ?.click(),
    );
    expect(
      document.querySelector('[data-testid="host-remove-confirm"]'),
    ).not.toBeNull();
  });

  it.each(['cloud', 'remote-control', undefined] as const)(
    'offers read-only debug info only on cloud rows (%s)',
    (backend) => {
      const onShowWorktreeDebugInfo = jest.fn();
      render(
        'ready',
        { onShowWorktreeDebugInfo, isWorkspaceCommandDisabled: () => true },
        {
          ...snapshot,
          workspaces: [
            {
              localId: 'workspace',
              name: 'Workspace',
              type: 'cowork',
              layout: 'tree',
              backend,
            },
          ],
          worktrees: [
            {
              localId: 'worktree',
              workspaceLocalId: 'workspace',
              branch: 'cloud',
              backend,
            },
          ],
        },
      );
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="portal-worktree-actions-menu-button"]',
          )
          ?.click(),
      );
      const item = document.querySelector<HTMLButtonElement>(
        '[data-testid="portal-worktree-actions-debug-info"]',
      );
      if (backend === 'cloud') {
        expect(item).not.toBeNull();
        expect(item?.disabled).toBe(false);
        act(() => item?.click());
        expect(onShowWorktreeDebugInfo).toHaveBeenCalledWith(
          'workspace',
          'worktree',
        );
      } else {
        expect(item).toBeNull();
        expect(onShowWorktreeDebugInfo).not.toHaveBeenCalled();
      }
    },
  );

  it('keeps Split PR default-off and requires capability plus host wiring', () => {
    render('ready');
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="portal-worktree-actions-menu-button"]',
        )
        ?.click(),
    );
    expect(
      document.querySelector(
        '[data-testid="portal-worktree-actions-split-pr"]',
      ),
    ).toBeNull();
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="portal-worktree-actions-menu-button"]',
        )
        ?.click(),
    );

    const onSplitPrRequested = jest.fn();
    render('ready', {
      capabilities: { ...capabilities, worktreeSplitPr: true },
      getSplitPrEligibilityInputs: () => ({
        prState: 'open',
        prAdditions: 600,
        prDeletions: 100,
        splitPrEnabled: true,
        thresholdLines: 500,
        isSingleRepo: true,
      }),
      onSplitPrRequested,
    });
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="portal-worktree-actions-menu-button"]',
        )
        ?.click(),
    );
    const item = document.querySelector<HTMLButtonElement>(
      '[data-testid="portal-worktree-actions-split-pr"]',
    );
    expect(item).not.toBeNull();
    act(() => item?.click());
    expect(onSplitPrRequested).toHaveBeenCalledWith('workspace', 'worktree');
  });

  it('dispatches a pipeline only for the workspace whose same-id worktree opened the dialog', () => {
    const onDispatchPipeline = jest.fn();
    render(
      'ready',
      {
        onDispatchPipeline,
        getPipelineEntries: (workspaceId) => [
          {
            id: 'build',
            name: `Build ${workspaceId}`,
            running: false,
          },
        ],
      },
      {
        ...snapshot,
        workspaces: [
          { localId: 'w1', name: 'Workspace One', type: 'single-repo' },
          { localId: 'w2', name: 'Workspace Two', type: 'single-repo' },
        ],
        worktrees: [
          { localId: 'main', workspaceLocalId: 'w1', branch: 'main' },
          { localId: 'main', workspaceLocalId: 'w2', branch: 'main' },
        ],
      },
    );

    const workspaceOne = container.querySelector('[data-workspace-id="w1"]');
    const trigger = workspaceOne?.querySelector<HTMLButtonElement>(
      '[data-testid="portal-worktree-actions-menu-button"]',
    );
    expect(trigger).not.toBeNull();
    act(() => trigger?.click());
    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="portal-worktree-actions-dispatch-pipeline"]',
        )
        ?.click(),
    );

    const dialogs = document.querySelectorAll('[role="dialog"]');
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]?.textContent).toContain('Build w1');
    expect(dialogs[0]?.textContent).not.toContain('Build w2');
    act(() =>
      Array.from(dialogs[0]?.querySelectorAll('button') ?? [])
        .find((button) => button.textContent?.includes('Build w1'))
        ?.click(),
    );
    expect(onDispatchPipeline).toHaveBeenCalledWith('w1', 'main', 'build');
  });

  // Two workspaces each own a worktree named `main`: the row callbacks must
  // address the workspace whose row was used, never the other one.
  const sameIdSnapshot: SidebarSurfaceSnapshot = {
    ...snapshot,
    workspaces: [
      { localId: 'w1', name: 'Workspace One', type: 'single-repo' },
      { localId: 'w2', name: 'Workspace Two', type: 'single-repo' },
    ],
    worktrees: [
      { localId: 'main', workspaceLocalId: 'w1', branch: 'main' },
      { localId: 'main', workspaceLocalId: 'w2', branch: 'main' },
    ],
  };
  function openRowMenu(workspaceId: string): void {
    act(() =>
      container
        .querySelector(`[data-workspace-id="${workspaceId}"]`)
        ?.querySelector<HTMLButtonElement>(
          '[data-testid="portal-worktree-actions-menu-button"]',
        )
        ?.click(),
    );
  }
  function menuItem(testId: string): HTMLButtonElement | null {
    return document.querySelector<HTMLButtonElement>(
      `[data-testid="${testId}"]`,
    );
  }

  // CAN-3053: desktop's Dispatch Pipeline opens its own dialog (working
  // directory, inputs), so the host takes the request and the shared picker
  // stays closed. The item needs no pipeline list to be offered.
  it('hands Dispatch Pipeline to a host-owned dialog when the host supplies one', () => {
    const onDispatchPipelineRequested = jest.fn();
    render(
      'ready',
      {
        capabilities: { ...capabilities, pipelines: 'execute' },
        onDispatchPipelineRequested,
      },
      sameIdSnapshot,
    );
    openRowMenu('w2');
    const item = menuItem('portal-worktree-actions-dispatch-pipeline');
    expect(item).not.toBeNull();
    act(() => item?.click());
    expect(onDispatchPipelineRequested).toHaveBeenCalledWith('w2', 'main');
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
  });

  it.each([
    [undefined, 'Dispatch pipeline'],
    [true, 'Dispatch pipeline'],
  ] as const)(
    'names the dispatch row for sentenceCaseMenuLabels=%s',
    (sentenceCaseMenuLabels, label) => {
      render(
        'ready',
        {
          capabilities: { ...capabilities, pipelines: 'execute' },
          onDispatchPipelineRequested: jest.fn(),
          sentenceCaseMenuLabels,
        },
        sameIdSnapshot,
      );
      openRowMenu('w2');
      expect(
        menuItem('portal-worktree-actions-dispatch-pipeline')?.textContent,
      ).toContain(label);
    },
  );

  it('withholds the host-owned Dispatch Pipeline from a workspace that cannot take commands', () => {
    render(
      'ready',
      {
        capabilities: { ...capabilities, pipelines: 'execute' },
        onDispatchPipelineRequested: jest.fn(),
        isWorkspaceCommandDisabled: (workspaceId) => workspaceId === 'w1',
      },
      sameIdSnapshot,
    );
    openRowMenu('w1');
    expect(menuItem('portal-worktree-actions-dispatch-pipeline')).toBeNull();
  });

  it('asks the launch predicates about the row workspace as well as its worktree', () => {
    const onLaunchWorktree = jest.fn();
    render(
      'ready',
      {
        onLaunchWorktree,
        isLaunchAvailable: (_worktreeId, workspaceId) => workspaceId === 'w1',
        isLaunchRunning: () => false,
      },
      sameIdSnapshot,
    );
    openRowMenu('w2');
    expect(menuItem('portal-worktree-actions-launch')).toBeNull();
    act(() => document.body.click());
    openRowMenu('w1');
    const launch = menuItem('portal-worktree-actions-launch');
    expect(launch).not.toBeNull();
    act(() => launch?.click());
    expect(onLaunchWorktree).toHaveBeenCalledWith('w1', 'main');
  });

  it('disables Launch while the host reports the row launch running', () => {
    render(
      'ready',
      {
        onLaunchWorktree: jest.fn(),
        isLaunchAvailable: () => true,
        isLaunchRunning: (_worktreeId, workspaceId) => workspaceId === 'w2',
      },
      sameIdSnapshot,
    );
    openRowMenu('w2');
    expect(menuItem('portal-worktree-actions-launch')?.disabled).toBe(true);
  });

  it('lets the host replace a row worktree id and keeps the plain id otherwise', () => {
    render(
      'ready',
      {
        renderWorktreeIdSlot: ({ workspace }) =>
          workspace.localId === 'w1' ? (
            <span data-testid="host-id-slot">Stop main</span>
          ) : undefined,
      },
      sameIdSnapshot,
    );
    const rowOne = container.querySelector('[data-workspace-id="w1"]');
    const rowTwo = container.querySelector('[data-workspace-id="w2"]');
    expect(
      rowOne?.querySelector('[data-testid="host-id-slot"]'),
    ).not.toBeNull();
    expect(rowTwo?.querySelector('[data-testid="host-id-slot"]')).toBeNull();
    expect(rowTwo?.textContent).toContain('main');
  });

  it('disables Split PR and removal while the projected split lock is held', () => {
    render(
      'ready',
      {
        capabilities: { ...capabilities, worktreeSplitPr: true },
        getSplitPrEligibilityInputs: () => ({
          prState: 'open',
          prAdditions: 600,
          prDeletions: 100,
          splitPrEnabled: true,
          thresholdLines: 500,
          isSingleRepo: true,
        }),
        onSplitPrRequested: jest.fn(),
        onArchiveWorktree: jest.fn(),
      },
      {
        ...snapshot,
        worktrees: [{ ...snapshot.worktrees[0], splitPrLocked: true }],
      },
    );
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="portal-worktree-actions-menu-button"]',
        )
        ?.click(),
    );
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="portal-worktree-actions-split-pr"]',
      )?.disabled,
    ).toBe(true);
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="portal-delete-worktree"]',
      )?.disabled,
    ).toBe(true);
  });

  describe('per-workspace command gate (REG-2785)', () => {
    const twoHostSnapshot: SidebarSurfaceSnapshot = {
      ...snapshot,
      workspaces: [
        {
          localId: 'cloud:ws:a',
          name: 'Cloud',
          type: 'cowork',
          layout: 'tree',
        },
        {
          localId: 'ws-remote',
          name: 'Desktop',
          type: 'single-repo',
          itemSortMode: 'manual',
        },
      ],
      worktrees: [
        {
          localId: 'cloud:task:a',
          workspaceLocalId: 'cloud:ws:a',
          branch: 'cloud',
        },
        { localId: 'wt-remote', workspaceLocalId: 'ws-remote', branch: 'main' },
      ],
    };

    function openMenu(index: number): void {
      act(() =>
        container
          .querySelectorAll<HTMLButtonElement>(
            '[data-testid="portal-worktree-actions-menu-button"]',
          )
          [index]?.click(),
      );
    }

    function renderTwoHosts(
      isWorkspaceCommandDisabled?: (workspaceLocalId: string) => boolean,
    ): void {
      render(
        'ready',
        {
          capabilities: {
            ...capabilities,
            workspaceReordering: true,
            worktreeReordering: true,
            worktreeCreation: true,
          },
          onArchiveWorktree: jest.fn(),
          onUpdateWorktree: jest.fn(),
          onCreateWorktree: jest.fn(),
          onReorderWorkspaces: jest.fn(),
          // Both reorder handlers: `SortableWorkspacesSidebar` only mounts its
          // DnD path when the host supplies each, so passing one leaves every
          // row non-draggable and the per-row gate untested.
          onReorderWorktrees: jest.fn(),
          isWorkspaceCommandDisabled,
        },
        twoHostSnapshot,
      );
    }

    it('withholds mutations for a gated project while its neighbour keeps them', () => {
      renderTwoHosts((workspaceLocalId) => workspaceLocalId === 'ws-remote');

      // Cloud row (first section) keeps archive + rename.
      openMenu(0);
      expect(
        document.querySelector('[data-testid="portal-delete-worktree"]'),
      ).not.toBeNull();
      expect(
        document.querySelector(
          '[data-testid="portal-worktree-actions-set-label"]',
        ),
      ).not.toBeNull();
      openMenu(0);

      // Gated remote row loses them, keeping the read-only branch info.
      openMenu(1);
      expect(
        document.querySelector('[data-testid="portal-delete-worktree"]'),
      ).toBeNull();
      expect(
        document.querySelector(
          '[data-testid="portal-worktree-actions-set-label"]',
        ),
      ).toBeNull();
      expect(
        document.querySelector('[data-testid="portal-worktree-actions-info"]'),
      ).not.toBeNull();
    });

    // REG-2817. The gate used to be LIST-level ("withhold while ANY member's
    // host is unreachable"), which was exact only while sections kept the
    // backends in separate lists. Merged into one list it would let a single
    // disconnected desktop row withdraw create and reorder from every cloud
    // row. Asserting the RENDERED affordances, not just the predicate's return
    // value — the predicate was already correct when this regressed.
    it('keeps a reachable row creatable and draggable while its neighbour is gated', () => {
      renderTwoHosts((workspaceLocalId) => workspaceLocalId === 'ws-remote');

      const addFor = (
        unit: 'chat' | 'worktree',
        name: string,
      ): Element | null =>
        container.querySelector(`[aria-label="Create ${unit} for ${name}"]`);
      const dragFor = (name: string): Element | null =>
        container.querySelector(`[aria-label="Reorder ${name}"]`);

      // The reachable cloud row keeps both affordances...
      expect(addFor('chat', 'Cloud')).not.toBeNull();
      expect(dragFor('Cloud')).not.toBeNull();
      // ...while the unreachable desktop row loses them.
      expect(addFor('worktree', 'Desktop')).toBeNull();
      expect(dragFor('Desktop')).toBeNull();
    });

    it('leaves every row mutable when no predicate is supplied', () => {
      renderTwoHosts(undefined);

      openMenu(1);
      expect(
        document.querySelector('[data-testid="portal-delete-worktree"]'),
      ).not.toBeNull();
      expect(
        document.querySelector(
          '[data-testid="portal-worktree-actions-set-label"]',
        ),
      ).not.toBeNull();
    });
  });

  // A host's read-only rail and its sortable rail paint the same project, so
  // a project with no stored color must get the same derived color in both.
  it('colors a colorless project the same with and without reordering', () => {
    const colorless: SidebarSurfaceSnapshot = {
      ...snapshot,
      workspaces: [
        {
          localId: 'cloud:ws:project-a',
          name: 'Alpha',
          type: 'cowork',
          layout: 'tree',
        },
      ],
      worktrees: [
        {
          localId: 'cloud:task:chat-a',
          workspaceLocalId: 'cloud:ws:project-a',
          branch: 'main',
        },
      ],
    };
    const badgeColor = (): string | undefined =>
      container.querySelector<HTMLElement>(
        '[data-testid="workspace-kind-badge"]',
      )?.style.backgroundColor;

    render('ready', {}, colorless);
    const readOnly = badgeColor();
    render(
      'ready',
      {
        capabilities: {
          ...capabilities,
          workspaceReordering: true,
          worktreeReordering: true,
        },
        onReorderWorkspaces: jest.fn(),
        onReorderWorktrees: jest.fn(),
      },
      colorless,
    );
    const sortable = badgeColor();

    expect(readOnly).toBeDefined();
    expect(readOnly).toBe(sortable);
  });

  // The project glyph is the whole icon: a tinted tile behind it left a 2px
  // band of the project color around the 16px badge and owner avatar.
  it('draws the project glyph in the drag handle without a tinted tile', () => {
    render(
      'ready',
      {
        capabilities: {
          ...capabilities,
          workspaceReordering: true,
          worktreeReordering: true,
        },
        onReorderWorkspaces: jest.fn(),
        onReorderWorktrees: jest.fn(),
      },
      {
        ...snapshot,
        workspaces: [
          {
            localId: 'workspace',
            name: 'Workspace',
            type: 'single-repo',
            color: '#F59E0B',
            avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
          },
        ],
      },
    );

    const handle = container.querySelector('[aria-label="Reorder Workspace"]');
    const badge = handle?.querySelector('[data-testid="workspace-kind-badge"]');
    expect(badge).not.toBeNull();
    expect(
      handle?.querySelector('[data-testid="workspace-owner-avatar"]'),
    ).not.toBeNull();
    for (
      let element = badge?.parentElement;
      element && element !== handle;
      element = element.parentElement
    ) {
      expect(
        element instanceof HTMLElement && element.style.backgroundColor,
      ).toBeFalsy();
    }
  });

  it('confirms retention before forwarding delete mode', () => {
    const onArchiveWorktree = jest.fn();
    render('ready', {
      capabilities: { ...capabilities, worktreeRetention: 'archive-or-delete' },
      onArchiveWorktree,
      worktreeRetentionDaysFor: () => 7,
    });
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="portal-worktree-actions-menu-button"]',
        )
        ?.click(),
    );
    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="portal-worktree-actions-delete"]',
        )
        ?.click(),
    );
    expect(document.body.textContent).toContain('kept for 7 days');
    const confirm = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
    ).find((button) => button.textContent === 'Delete');
    expect(confirm).toBeDefined();
    act(() => confirm?.click());
    expect(onArchiveWorktree).toHaveBeenCalledWith(
      'workspace',
      'worktree',
      'delete',
    );
  });

  // REG-3022 C7 (R78): a cloud repository worktree's archive saves its
  // changes first, so its client asks for the saved-changes copy. Branching on
  // the capability, never on the row's backend: a Cowork session keeps its
  // chat copy and Remote Control its checkout copy.
  it.each([
    [
      'archive',
      'archive-or-delete',
      11,
      "Archive main? Its changes are saved before it stops. If they can't be saved, you choose what happens. Archived worktrees are kept until you delete them.",
    ],
    [
      'delete',
      'archive-or-delete',
      11,
      "Delete main? It's archived first, with its changes saved. If they can't be saved, you choose what happens. Deleted worktrees are kept for 11 days, then removed. You can restore it from Archived and deleted.",
    ],
    [
      'delete',
      'archive-or-delete',
      1,
      "Delete main? It's archived first, with its changes saved. If they can't be saved, you choose what happens. Deleted worktrees are kept for 1 day, then removed. You can restore it from Archived and deleted.",
    ],
    [
      undefined,
      undefined,
      undefined,
      "Archive main? Its changes are saved before it stops. If they can't be saved, you choose what happens.",
    ],
  ] as const)(
    'uses the saved-changes %s confirmation for a client that asks for it (retention %s, %p days)',
    (mode, retention, days, message) => {
      const onArchiveWorktree = jest.fn();
      render(
        'ready',
        {
          capabilities: {
            ...capabilities,
            worktreeRemoval: 'archive',
            worktreeRemovalCopy: 'saved-changes',
            ...(retention === undefined
              ? {}
              : { worktreeRetention: retention }),
          },
          onArchiveWorktree,
          worktreeRetentionDaysFor: () => days,
        },
        {
          ...snapshot,
          worktrees: [{ ...snapshot.worktrees[0], backend: 'cloud' }],
        },
      );
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="portal-worktree-actions-menu-button"]',
          )
          ?.click(),
      );
      act(() =>
        document
          .querySelector<HTMLButtonElement>(
            `[data-testid="${mode === 'delete' ? 'portal-worktree-actions-delete' : 'portal-delete-worktree'}"]`,
          )
          ?.click(),
      );
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog?.textContent).toContain(message);
      expect(dialog?.textContent).not.toContain('Archived chats');
      expect(dialog?.textContent).not.toContain('from disk');
    },
  );

  // The desktop's own strings stay exactly as they are (the desktop host
  // overrides this dialog, but Remote Control and the legacy copy render it).
  it.each([
    [
      'remote-control',
      'archive',
      11,
      'Archive main? This removes the active checkout. Archived worktrees are kept until you delete them. Restore it from the desktop app.',
    ],
    [
      'remote-control',
      'delete',
      11,
      'Delete main? This removes the active checkout. Deleted worktrees are kept for 11 days, then removed. Restore it from the desktop app.',
    ],
    [
      undefined,
      'delete',
      undefined,
      "Delete main? This removes the active checkout. Deleted worktrees are kept for the project's retention window, then removed. Restore it from the desktop app.",
    ],
  ] as const)(
    'pins the %s %s confirmation exactly (%p days)',
    (backend, mode, days, message) => {
      render(
        'ready',
        {
          capabilities: {
            ...capabilities,
            worktreeRetention: 'archive-or-delete',
          },
          onArchiveWorktree: jest.fn(),
          worktreeRetentionDaysFor: () => days,
        },
        { ...snapshot, worktrees: [{ ...snapshot.worktrees[0], backend }] },
      );
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="portal-worktree-actions-menu-button"]',
          )
          ?.click(),
      );
      act(() =>
        document
          .querySelector<HTMLButtonElement>(
            `[data-testid="${mode === 'archive' ? 'portal-delete-worktree' : 'portal-worktree-actions-delete'}"]`,
          )
          ?.click(),
      );
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        message,
      );
    },
  );

  it.each([
    [
      'remote-control',
      'archive',
      11,
      'Archived worktrees are kept until you delete them. Restore it from the desktop app.',
    ],
    [
      undefined,
      'archive',
      undefined,
      'Archived worktrees are kept until you delete them. Restore it from the desktop app.',
    ],
    [
      'remote-control',
      'delete',
      11,
      'Deleted worktrees are kept for 11 days, then removed. Restore it from the desktop app.',
    ],
    [
      undefined,
      'delete',
      undefined,
      "Deleted worktrees are kept for the project's retention window, then removed. Restore it from the desktop app.",
    ],
    [
      'remote-control',
      'delete',
      1,
      'Deleted worktrees are kept for 1 day, then removed. Restore it from the desktop app.',
    ],
    ['cloud', 'archive', 11, 'Archived chats are kept until you delete them.'],
    [
      'cloud',
      'delete',
      11,
      'Deleted chats are kept for 11 days, then removed. You can restore it from Archived and deleted.',
    ],
  ] as const)(
    'uses %s %s confirmation copy with retention %p',
    (backend, mode, days, message) => {
      const onArchiveWorktree = jest.fn();
      render(
        'ready',
        {
          capabilities: {
            ...capabilities,
            worktreeRetention: 'archive-or-delete',
          },
          onArchiveWorktree,
          worktreeRetentionDaysFor: () => days,
        },
        { ...snapshot, worktrees: [{ ...snapshot.worktrees[0], backend }] },
      );
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="portal-worktree-actions-menu-button"]',
          )
          ?.click(),
      );
      act(() =>
        document
          .querySelector<HTMLButtonElement>(
            `[data-testid="${mode === 'archive' ? 'portal-delete-worktree' : 'portal-worktree-actions-delete'}"]`,
          )
          ?.click(),
      );
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog?.textContent).toContain(message);
      if (backend !== 'cloud')
        expect(dialog?.textContent).toContain(
          'This removes the active checkout.',
        );
      expect(onArchiveWorktree).not.toHaveBeenCalled();
      act(() =>
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="portal-delete-worktree-confirm"] [data-testid="confirm-dialog-confirm"]',
          )
          ?.click(),
      );
      expect(onArchiveWorktree).toHaveBeenCalledTimes(1);
      expect(onArchiveWorktree).toHaveBeenCalledWith(
        'workspace',
        'worktree',
        mode,
      );
    },
  );

  // A hover shortcut is a copy of a menu row. When the host withholds the row
  // (desktop, for a row it cannot mutate), the shortcut must go with it, or
  // the row keeps offering the action the host just took away.
  it.each([
    ['removal', 'delete', 'portal-worktree-delete-button', {}],
    ['show', 'toggle-hidden', 'portal-worktree-show-button', { hidden: true }],
  ] as const)(
    'withholds the %s shortcut when the host withholds its menu row',
    (_name, withheldKey, shortcutTestId, rowPatch) => {
      const renderWith = (
        transform?: SidebarSurfaceProps['transformWorktreeMenuItems'],
      ): void =>
        render(
          'ready',
          {
            capabilities: {
              ...capabilities,
              worktreeRetention: 'archive-or-delete',
            },
            onArchiveWorktree: jest.fn(),
            onUpdateWorktree: jest.fn(),
            transformWorktreeMenuItems: transform,
          },
          {
            ...snapshot,
            worktrees: [
              { ...snapshot.worktrees[0], status: 'done', ...rowPatch },
            ],
          },
        );
      const shortcut = (): Element | null => {
        // A hidden row lives in the collapsed Hidden disclosure; open it.
        const toggle = container.querySelector<HTMLButtonElement>(
          '[data-testid="portal-hidden-worktrees-toggle-workspace"]',
        );
        if (toggle && toggle.getAttribute('aria-expanded') !== 'true') {
          act(() => toggle.click());
        }
        return container.querySelector(`[data-testid="${shortcutTestId}"]`);
      };

      renderWith();
      expect(shortcut()).not.toBeNull();

      renderWith((_context, items) =>
        items.filter((item) => item.key !== withheldKey),
      );
      expect(shortcut()).toBeNull();
    },
  );

  it.each(['remote-control', undefined, 'cloud'] as const)(
    'confirms finished desktop or idle cloud hover deletion for %s and Cancel sends nothing',
    (backend) => {
      const onArchiveWorktree = jest.fn();
      render(
        'ready',
        {
          capabilities: {
            ...capabilities,
            worktreeRetention: 'archive-or-delete',
          },
          onArchiveWorktree,
          worktreeRetentionDaysFor: () => 11,
        },
        {
          ...snapshot,
          worktrees: [
            {
              ...snapshot.worktrees[0],
              backend,
              ...(backend === 'cloud' ? {} : { status: 'done' }),
            },
          ],
        },
      );
      const shortcut = container.querySelector<HTMLButtonElement>(
        '[data-testid="portal-worktree-delete-button"]',
      );
      expect(shortcut).not.toBeNull();
      act(() => shortcut?.click());
      expect(onArchiveWorktree).not.toHaveBeenCalled();
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        backend === 'cloud'
          ? 'You can restore it from Archived and deleted.'
          : 'Restore it from the desktop app.',
      );
      const cancel = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
      ).find((button) => button.textContent === 'Cancel');
      expect(cancel).toBeDefined();
      act(() => cancel?.click());
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(onArchiveWorktree).not.toHaveBeenCalled();
      act(() => shortcut?.click());
      act(() =>
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="portal-delete-worktree-confirm"] [data-testid="confirm-dialog-confirm"]',
          )
          ?.click(),
      );
      expect(onArchiveWorktree).toHaveBeenCalledTimes(1);
      expect(onArchiveWorktree).toHaveBeenCalledWith(
        'workspace',
        'worktree',
        'delete',
      );
    },
  );

  it.each([false, true])(
    'mutes a row whose removal is in flight and drops its Delete chip (done=%p)',
    (done) => {
      const onSelect = jest.fn();
      const removing = new Set<string>();
      const renderRow = (): void =>
        render(
          'ready',
          {
            capabilities: {
              ...capabilities,
              worktreeRetention: 'archive-or-delete',
            },
            onSelect,
            onArchiveWorktree: jest.fn(),
            isDirectRemovalAvailable: () => true,
            isWorktreeRemovalInProgress: (workspaceId, worktreeId) =>
              removing.has(`${workspaceId}/${worktreeId}`),
          },
          {
            ...snapshot,
            worktrees: [
              {
                ...snapshot.worktrees[0],
                ...(done ? { status: 'done' } : {}),
              },
            ],
          },
        );
      const row = (): HTMLElement | null =>
        container.querySelector<HTMLElement>('[data-worktree-id="worktree"]');
      const frame = (): HTMLElement | null =>
        row()?.closest<HTMLElement>('[data-sidebar-variant]') ?? null;
      const chip = (): Element | null =>
        container.querySelector(
          '[data-testid="portal-worktree-delete-button"]',
        );

      renderRow();
      expect(chip()).not.toBeNull();
      expect(row()?.className).not.toContain('pointer-events-none');
      expect(frame()?.getAttribute('aria-disabled')).toBeNull();

      removing.add('workspace/worktree');
      renderRow();
      expect(chip()).toBeNull();
      expect(row()?.className).toContain('pointer-events-none');
      expect(row()?.querySelector('.opacity-50')).not.toBeNull();
      expect(frame()?.getAttribute('aria-disabled')).toBe('true');
      expect(frame()?.hasAttribute('inert')).toBe(true);
      expect(row()?.innerHTML).not.toContain(
        'pointer-fine:group-hover:pr-13.5',
      );
      expect(row()?.innerHTML).toContain('pointer-fine:group-hover:pr-7');
      onSelect.mockClear();
      act(() => frame()?.click());
      expect(onSelect).not.toHaveBeenCalled();

      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="portal-worktree-actions-menu-button"]',
          )
          ?.click(),
      );
      const removal = document.querySelector<HTMLButtonElement>(
        '[data-testid="portal-worktree-actions-delete"]',
      );
      expect(removal).not.toBeNull();
      expect(removal?.disabled).toBe(true);
    },
  );

  // CAN-3053: the row reserves hover padding for exactly the chips the action
  // host renders, so the trailing status cluster (the unread dot) slides out
  // from under them instead of painting over the removal chip.
  describe('hover reserve matches the rendered action chips', () => {
    const hoverReserve = (count: 1 | 2 | 3): string =>
      `pointer-fine:group-hover:${count === 1 ? 'pr-7' : count === 2 ? 'pr-13.5' : 'pr-20'}`;
    const renderedButtons = (): number =>
      container.querySelectorAll(
        '[data-testid="worktree-row-action-chip"] button',
      ).length;
    const rowMarkup = (): string =>
      container.querySelector('[data-worktree-id="worktree"]')?.innerHTML ?? '';
    const expectReserve = (count: 1 | 2 | 3): void => {
      expect(renderedButtons()).toBe(count);
      expect(rowMarkup()).toContain(hoverReserve(count));
      expect(rowMarkup()).toContain(
        hoverReserve(count).replace('group-hover', 'group-focus-within'),
      );
      for (const other of [1, 2, 3] as const) {
        if (other !== count)
          expect(rowMarkup()).not.toContain(hoverReserve(other));
      }
    };

    it('reserves two chips for a clean, not-done row with direct removal', () => {
      render(
        'ready',
        {
          onArchiveWorktree: jest.fn(),
          isDirectRemovalAvailable: () => true,
        },
        snapshot,
      );
      expect(
        container.querySelector(
          '[data-testid="portal-worktree-delete-button"]',
        ),
      ).not.toBeNull();
      expectReserve(2);
    });

    it('reserves one chip when the not-done row has no direct removal', () => {
      render(
        'ready',
        {
          onArchiveWorktree: jest.fn(),
          isDirectRemovalAvailable: () => false,
        },
        snapshot,
      );
      expect(
        container.querySelector(
          '[data-testid="portal-worktree-delete-button"]',
        ),
      ).toBeNull();
      expectReserve(1);
    });

    it.each([
      { done: true, removable: true, count: 3 },
      { done: false, removable: true, count: 3 },
      { done: false, removable: false, count: 2 },
    ] as const)(
      'reserves $count chips for a hidden row (done=$done, removable=$removable)',
      ({ done, removable, count }) => {
        render(
          'ready',
          {
            onArchiveWorktree: jest.fn(),
            onUpdateWorktree: jest.fn(),
            isDirectRemovalAvailable: () => removable,
          },
          {
            ...snapshot,
            worktrees: [
              {
                ...snapshot.worktrees[0],
                hidden: true,
                ...(done ? { status: 'done' } : {}),
              },
            ],
          },
        );
        act(() =>
          container
            .querySelector<HTMLButtonElement>(
              '[data-testid="portal-hidden-worktrees-toggle-workspace"]',
            )
            ?.click(),
        );
        expect(
          container.querySelector(
            '[data-testid="portal-worktree-show-button"]',
          ),
        ).not.toBeNull();
        expectReserve(count);
      },
    );

    it('reserves two chips for an idle cloud row with retention removal', () => {
      render(
        'ready',
        {
          capabilities: {
            ...capabilities,
            worktreeRetention: 'archive-or-delete',
          },
          onArchiveWorktree: jest.fn(),
        },
        {
          ...snapshot,
          worktrees: [{ ...snapshot.worktrees[0], backend: 'cloud' }],
        },
      );
      expect(
        container.querySelector(
          '[data-testid="portal-worktree-delete-button"]',
        ),
      ).not.toBeNull();
      expectReserve(2);
    });

    it('drops the removal reserve while that removal is in flight', () => {
      render(
        'ready',
        {
          onArchiveWorktree: jest.fn(),
          onUpdateWorktree: jest.fn(),
          isDirectRemovalAvailable: () => true,
          isWorktreeRemovalInProgress: () => true,
        },
        snapshot,
      );
      expect(
        container.querySelector(
          '[data-testid="portal-worktree-delete-button"]',
        ),
      ).toBeNull();
      expectReserve(1);
    });
  });

  it.each(['cloud', 'remote-control', undefined] as const)(
    'blocks retention removal while the projected row is streaming (%s)',
    (backend) => {
      const onArchiveWorktree = jest.fn();
      render(
        'ready',
        {
          capabilities: {
            ...capabilities,
            worktreeRetention: 'archive-or-delete',
          },
          onArchiveWorktree,
        },
        {
          ...snapshot,
          worktrees: [
            {
              ...snapshot.worktrees[0],
              backend,
              ...(backend === 'cloud' ? {} : { status: 'done' }),
              isStreaming: true,
            },
          ],
        },
      );
      expect(
        container.querySelector(
          '[data-testid="portal-worktree-delete-button"]',
        ),
      ).toBeNull();
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="portal-worktree-actions-menu-button"]',
          )
          ?.click(),
      );
      for (const testId of [
        'portal-delete-worktree',
        'portal-worktree-actions-delete',
      ]) {
        const action = document.querySelector<HTMLButtonElement>(
          `[data-testid="${testId}"]`,
        );
        expect(action).not.toBeNull();
        expect(action?.disabled).toBe(true);
        act(() => action?.click());
      }
      expect(onArchiveWorktree).not.toHaveBeenCalled();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    },
  );

  it('lets the host replace worktree removal confirmation', () => {
    const override = jest.fn(() => true);
    render('ready', {
      onArchiveWorktree: jest.fn(),
      onConfirmWorktreeRemovalOverride: override,
    });
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="portal-worktree-actions-menu-button"]',
        )
        ?.click(),
    );
    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="portal-delete-worktree"]',
        )
        ?.click(),
    );
    // The single-item removal carries no explicit mode; the host decides.
    expect(override).toHaveBeenCalledWith(
      'workspace',
      'worktree',
      'main',
      undefined,
    );
    expect(
      document.querySelector('[data-testid="portal-delete-worktree-confirm"]'),
    ).toBeNull();
  });

  it('renders cowork projects inline at their persisted order position', () => {
    render(
      'ready',
      {},
      {
        ...snapshot,
        workspaces: [
          {
            localId: 'before',
            name: 'Before',
            type: 'single-repo',
            order: 0,
          },
          { localId: 'cowork', name: 'Cowork', type: 'cowork', order: 1 },
          {
            localId: 'after',
            name: 'After',
            type: 'single-repo',
            order: 2,
          },
        ],
        standaloneChats: [
          {
            localId: 'chat',
            projectLocalId: 'cowork',
            title: 'Cowork chat',
          },
        ],
      },
    );

    const ordered = Array.from(
      container.querySelectorAll('[data-workspace-id]'),
      (element) => element.getAttribute('data-workspace-id'),
    );
    expect(ordered).toEqual(['before', 'cowork', 'after']);
    expect(
      container.querySelector('[data-testid="portal-cowork-workspace-cowork"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="portal-standalone-chat-list"]'),
    ).toBeNull();
  });

  it('shows Personal standalone chats when an organization owns the only flat workspace', (): void => {
    render(
      'ready',
      { context: { kind: 'personal' } },
      {
        ...snapshot,
        workspaces: [
          {
            localId: 'org-cowork',
            name: 'Organization workspace',
            type: 'cowork',
            owner: {
              type: 'organization',
              organizationId: 'acme',
              projectId: 'org-project',
            },
          },
        ],
        standaloneChats: [
          { localId: 'chat', title: 'Personal chat' },
          {
            localId: 'org-chat',
            projectLocalId: 'org-cowork',
            title: 'Organization chat',
          },
        ],
      },
    );
    expect(
      container.querySelector('[data-testid="portal-standalone-chat-list"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Personal chat');
    expect(container.textContent).not.toContain('Organization chat');
  });

  it('scopes mixed flat workspace chats and ownerless chats to the active context', (): void => {
    const mixedSnapshot: SidebarSurfaceSnapshot = {
      ...snapshot,
      workspaces: [
        {
          localId: 'org-cowork',
          name: 'Organization workspace',
          type: 'cowork',
          order: 0,
          owner: {
            type: 'organization',
            organizationId: 'acme',
            projectId: 'org-project',
          },
        },
        {
          localId: 'personal-cowork',
          name: 'Personal workspace',
          type: 'cowork',
          order: 1,
        },
      ],
      standaloneChats: [
        {
          localId: 'personal-chat',
          projectLocalId: 'personal-cowork',
          title: 'Personal chat',
        },
        {
          localId: 'org-chat',
          projectLocalId: 'org-cowork',
          title: 'Organization chat',
        },
        { localId: 'ownerless-chat', title: 'Ownerless chat' },
      ],
    };

    render('ready', { context: { kind: 'personal' } }, mixedSnapshot);
    expect(container.textContent).toContain('Personal chat');
    expect(container.textContent).not.toContain('Organization chat');
    expect(container.textContent).toContain('Ownerless chat');

    render(
      'ready',
      { context: { kind: 'organization', organizationId: 'acme' } },
      mixedSnapshot,
    );
    expect(container.textContent).toContain('Organization chat');
    expect(container.textContent).not.toContain('Personal chat');
    expect(container.textContent).not.toContain('Ownerless chat');

    render('ready', {}, mixedSnapshot);
    expect(container.textContent).toContain('Personal chat');
    expect(container.textContent).toContain('Organization chat');
    expect(container.textContent).toContain('Ownerless chat');
  });

  it('hides the unowned standalone fallback in an organization context', (): void => {
    render(
      'ready',
      { context: { kind: 'organization', organizationId: 'acme' } },
      {
        ...snapshot,
        standaloneChats: [{ localId: 'chat', title: 'Legacy chat' }],
      },
    );
    expect(
      container.querySelector('[data-testid="portal-standalone-chat-list"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain('Legacy chat');
  });

  // REG-2819. The global standalone block is the fallback for hosts with no
  // FLAT workspace to own those chats. A cloud workspace is repoless (so
  // `type: 'cowork'`) but tree-shaped and owns none of them — suppressing the
  // block on its account would strand every legacy standalone chat with no
  // sidebar home at all.
  it('keeps the global standalone block when the only cowork-typed row is cloud', () => {
    render(
      'ready',
      {},
      {
        ...snapshot,
        workspaces: [
          {
            localId: 'cloud',
            name: 'Cloud',
            type: 'cowork',
            layout: 'tree',
            backend: 'cloud',
            order: 0,
          },
        ],
        worktrees: [
          {
            localId: 'cloud-task',
            workspaceLocalId: 'cloud',
            branch: 'cloud',
            label: 'Cloud task',
            backend: 'cloud',
          },
        ],
        standaloneChats: [{ localId: 'chat', title: 'Legacy chat' }],
      },
    );

    expect(
      container.querySelector('[data-testid="portal-standalone-chat-list"]'),
    ).not.toBeNull();
    // And the cloud row itself still renders as a tree, not through the slot.
    expect(
      container.querySelector('[data-testid="portal-cowork-workspace-cloud"]'),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-workspace-id="cloud"]')
        ?.querySelector('[data-worktree-id="cloud-task"]'),
    ).not.toBeNull();
  });

  // CAN-3898. The automatic default cloud workspace owns Chats when no flat
  // catch-all does, keeping its tree rows; placement follows the server's
  // marker, never the name.
  describe('cloud default Chats owner', () => {
    const cloudWorkspace = (
      localId: string,
      name: string,
      extra: Partial<SidebarSurfaceSnapshot['workspaces'][number]> = {},
    ): SidebarSurfaceSnapshot['workspaces'][number] => ({
      localId,
      name,
      type: 'cowork',
      layout: 'tree',
      backend: 'cloud',
      order: 0,
      ...extra,
    });
    const cloudTask = (
      localId: string,
      workspaceLocalId: string,
    ): SidebarSurfaceSnapshot['worktrees'][number] => ({
      localId,
      workspaceLocalId,
      branch: localId,
      label: `Task ${localId}`,
      backend: 'cloud',
    });
    const cloudSnapshot = (
      workspaces: SidebarSurfaceSnapshot['workspaces'],
      worktrees: SidebarSurfaceSnapshot['worktrees'] = [],
    ): SidebarSurfaceSnapshot => ({
      workspaces,
      worktrees,
      standaloneChats: [],
    });
    const chatsSection = (): Element | null =>
      container.querySelector('[data-testid="portal-chats-section"]');
    const projectsList = (): Element | null =>
      container.querySelector('[data-testid="portal-workspace-list"]');
    const chatsLabel = (): string | null | undefined =>
      container.querySelector('[data-testid="portal-chats-section-toggle"]')
        ?.textContent;

    it('lists the flagged default once, in Chats above Projects, without a project header', () => {
      render(
        'ready',
        { selection: null },
        cloudSnapshot(
          [
            cloudWorkspace('default', 'My project', { chatsHome: true }),
            cloudWorkspace('named', 'Named project', { order: 1 }),
          ],
          [
            cloudTask('default-task', 'default'),
            cloudTask('named-task', 'named'),
          ],
        ),
      );

      const section = chatsSection();
      expect(section?.getAttribute('data-workspace-id')).toBe('default');
      expect(chatsLabel()).toBe('Chats');
      expect(
        section?.parentElement?.querySelectorAll(
          '[data-worktree-id="default-task"]',
        ),
      ).toHaveLength(1);
      // Chats precedes the Projects header in document order.
      const header = container.querySelector(
        '[data-testid="portal-workspaces-header"]',
      );
      const chatsRow = container.querySelector(
        '[data-worktree-id="default-task"]',
      );
      expect(
        header !== null &&
          chatsRow !== null &&
          (chatsRow.compareDocumentPosition(header) &
            Node.DOCUMENT_POSITION_FOLLOWING) !==
            0,
      ).toBe(true);
      // Not in Projects, and no header or duplicate wrapper of its own.
      expect(
        projectsList()?.querySelector('[data-worktree-id="default-task"]'),
      ).toBeNull();
      expect(
        projectsList()?.querySelector('[data-worktree-id="named-task"]'),
      ).not.toBeNull();
      expect(
        container.querySelectorAll('[data-workspace-id="default"]'),
      ).toHaveLength(1);
      expect(container.textContent).not.toContain('My project');
      expect(
        container.querySelector(
          '[data-sidebar-workspace-sortable-header="default"]',
        ),
      ).toBeNull();
    });

    it('elects the same cloud owner in server HTML and the client render', () => {
      const next = cloudSnapshot(
        [cloudWorkspace('default', 'My project', { chatsHome: true })],
        [cloudTask('original', 'default')],
      );
      const server = document.createElement('div');
      server.innerHTML = renderToString(
        <SidebarSurface
          variant="rail"
          snapshot={next}
          selection={null}
          capabilities={capabilities}
          contentState="ready"
          onSelect={() => undefined}
        />,
      );
      render('ready', { selection: null }, next);
      for (const dom of [server, container]) {
        expect(
          dom
            .querySelector('[data-testid="portal-chats-section"]')
            ?.getAttribute('data-workspace-id'),
        ).toBe('default');
        expect(
          dom.querySelectorAll('[data-worktree-id="original"]'),
        ).toHaveLength(1);
        expect(
          dom.querySelector('[data-testid="portal-chats-section-toggle"]')
            ?.textContent,
        ).toBe('Chats');
      }
    });

    it('labels a renamed default by its name and keeps it in Chats', () => {
      render(
        'ready',
        { selection: null },
        cloudSnapshot(
          [cloudWorkspace('default', 'Renamed', { chatsHome: true })],
          [cloudTask('default-task', 'default')],
        ),
      );

      expect(chatsLabel()).toBe('Renamed');
      expect(chatsSection()?.getAttribute('data-workspace-id')).toBe('default');
    });

    it('keeps an unflagged project named My project in Projects', () => {
      render(
        'ready',
        { selection: null },
        cloudSnapshot(
          [cloudWorkspace('manual', 'My project')],
          [cloudTask('manual-task', 'manual')],
        ),
      );

      expect(chatsSection()).toBeNull();
      expect(
        projectsList()?.querySelector('[data-worktree-id="manual-task"]'),
      ).not.toBeNull();
      expect(container.textContent).toContain('My project');
    });

    it.each(['Personal', 'Default', 'Research', ' My project ', 'My project'])(
      'uses only the cloud provisioned name when relabeling %p',
      (name) => {
        render(
          'ready',
          { selection: null },
          cloudSnapshot([cloudWorkspace('default', name, { chatsHome: true })]),
        );
        expect(chatsLabel()).toBe(
          name.trim() === 'My project' ? 'Chats' : name,
        );
        expect(chatsSection()?.getAttribute('data-workspace-id')).toBe(
          'default',
        );
      },
    );

    it('withholds the settings override while owner commands are disabled', () => {
      render(
        'ready',
        {
          selection: null,
          capabilities: { ...capabilities, workspaceSettings: 'full' },
          isWorkspaceCommandDisabled: () => true,
          onOpenWorkspaceSettingsOverride: jest.fn(() => true),
        },
        cloudSnapshot([
          cloudWorkspace('default', 'My project', { chatsHome: true }),
        ]),
      );
      expect(chatsSection()).not.toBeNull();
      expect(
        container.querySelector('[aria-label="Chats settings"]'),
      ).toBeNull();
    });

    it('removes the owner on visibility loss without hoisting an ordinary project', () => {
      const ordinary = cloudWorkspace('ordinary', 'My project');
      render(
        'ready',
        { selection: null },
        cloudSnapshot([
          cloudWorkspace('default', 'My project', { chatsHome: true }),
          ordinary,
        ]),
      );
      expect(chatsSection()).not.toBeNull();
      render('ready', { selection: null }, cloudSnapshot([ordinary]));
      expect(chatsSection()).toBeNull();
      expect(
        container.querySelectorAll('[data-workspace-id="ordinary"]'),
      ).toHaveLength(1);
    });

    it('rejects a shared default even when a stale summary carries eligibility', () => {
      render(
        'ready',
        {
          selection: null,
          sharedWorkspaceIds: new Set(['default']),
        },
        cloudSnapshot([
          cloudWorkspace('default', 'My project', { chatsHome: true }),
        ]),
      );
      expect(chatsSection()).toBeNull();
    });

    it('starts the new context owner with its own collapse state', () => {
      const next = cloudSnapshot(
        [
          cloudWorkspace('personal', 'My project', { chatsHome: true }),
          cloudWorkspace('org', 'Organization chats', {
            chatsHome: true,
            owner: { type: 'cloud-organization', organizationId: 'acme' },
          }),
        ],
        [cloudTask('personal-task', 'personal'), cloudTask('org-task', 'org')],
      );
      render('ready', { selection: null, context: { kind: 'personal' } }, next);
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="portal-chats-section-toggle"]',
          )
          ?.click(),
      );
      expect(
        container.querySelector('[data-worktree-id="personal-task"]'),
      ).toBeNull();
      render(
        'ready',
        {
          selection: null,
          context: { kind: 'organization', organizationId: 'acme' },
        },
        next,
      );
      expect(chatsSection()?.getAttribute('data-workspace-id')).toBe('org');
      expect(
        container.querySelector('[data-worktree-id="org-task"]'),
      ).not.toBeNull();
    });

    it('keeps every headerless task reachable without project pagination', () => {
      render(
        'ready',
        { selection: null },
        cloudSnapshot(
          [cloudWorkspace('default', 'My project', { chatsHome: true })],
          Array.from({ length: 30 }, (_, index) =>
            cloudTask(`task-${index}`, 'default'),
          ),
        ),
      );
      expect(
        chatsSection()?.querySelectorAll('[data-worktree-id]'),
      ).toHaveLength(30);
      expect(
        chatsSection()?.querySelector(
          '[data-testid="portal-show-more-workspaces"]',
        ),
      ).toBeNull();
    });

    it('retains group metadata and hidden-row disclosure under the Chats header', () => {
      render(
        'ready',
        { selection: null },
        cloudSnapshot(
          [
            cloudWorkspace('default', 'My project', {
              chatsHome: true,
              itemGroups: [
                {
                  id: 'group',
                  name: 'Important conversations',
                  color: 'neutral',
                  collapsed: false,
                  memberIds: ['visible'],
                },
              ],
            }),
          ],
          [
            cloudTask('visible', 'default'),
            { ...cloudTask('hidden', 'default'), hidden: true },
          ],
        ),
      );
      expect(chatsSection()?.textContent).toContain('Important conversations');
      expect(
        chatsSection()?.querySelector('[data-worktree-id="visible"]'),
      ).not.toBeNull();
      expect(
        chatsSection()?.querySelector('[data-worktree-id="hidden"]'),
      ).toBeNull();
      const disclosure = chatsSection()?.querySelector<HTMLButtonElement>(
        '[data-testid="portal-hidden-worktrees-toggle-default"]',
      );
      expect(disclosure).not.toBeNull();
      act(() => disclosure?.click());
      expect(
        chatsSection()?.querySelector('[data-worktree-id="hidden"]'),
      ).not.toBeNull();
    });

    it('reveals the original task row through the headerless renderer', () => {
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        'scrollIntoView',
      );
      const scrollIntoView = jest.fn();
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        value: scrollIntoView,
      });
      try {
        render(
          'ready',
          {
            selection: null,
            pendingRevealTarget: {
              workspaceLocalId: 'default',
              worktreeLocalId: 'original',
            },
          },
          cloudSnapshot(
            [cloudWorkspace('default', 'My project', { chatsHome: true })],
            [cloudTask('original', 'default')],
          ),
        );
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
        expect(scrollIntoView).toHaveBeenCalledWith({
          behavior: 'smooth',
          block: 'nearest',
        });
        expect(scrollIntoView.mock.contexts[0]).toBe(
          chatsSection()?.querySelector('[data-worktree-id="original"]'),
        );
      } finally {
        if (descriptor)
          Object.defineProperty(
            HTMLElement.prototype,
            'scrollIntoView',
            descriptor,
          );
        else delete HTMLElement.prototype.scrollIntoView;
      }
    });

    it('hoists none when two workspaces carry the marker', () => {
      render(
        'ready',
        { selection: null },
        cloudSnapshot([
          cloudWorkspace('a', 'My project', { chatsHome: true }),
          cloudWorkspace('b', 'My project', { chatsHome: true, order: 1 }),
        ]),
      );

      expect(chatsSection()).toBeNull();
    });

    it('defers to a flat catch-all, leaving the cloud default in Projects', () => {
      render(
        'ready',
        { selection: null, onCreateChatsSectionChat: () => undefined },
        cloudSnapshot(
          [
            {
              localId: 'cowork-default',
              name: 'Personal',
              type: 'cowork',
              layout: 'flat',
              order: 0,
            },
            cloudWorkspace('default', 'My project', {
              chatsHome: true,
              order: 1,
            }),
          ],
          [cloudTask('default-task', 'default')],
        ),
      );

      expect(chatsSection()?.getAttribute('data-workspace-id')).toBe(
        'cowork-default',
      );
      expect(
        projectsList()?.querySelector('[data-worktree-id="default-task"]'),
      ).not.toBeNull();
    });

    it('never elects a Personal default in an organization context', () => {
      render(
        'ready',
        {
          selection: null,
          context: { kind: 'organization', organizationId: 'acme' },
        },
        cloudSnapshot(
          [
            cloudWorkspace('default', 'My project', { chatsHome: true }),
            cloudWorkspace('org', 'Org project', {
              order: 1,
              owner: { type: 'cloud-organization', organizationId: 'acme' },
            }),
          ],
          [cloudTask('default-task', 'default'), cloudTask('org-task', 'org')],
        ),
      );

      expect(chatsSection()).toBeNull();
      expect(
        container.querySelector('[data-worktree-id="default-task"]'),
      ).toBeNull();
    });

    it('creates in the elected workspace, never through the flat-owner callback', async () => {
      const onCreateWorktree = jest.fn(() =>
        Promise.resolve({
          status: 'completed' as const,
          worktreeId: 'created',
        }),
      );
      const onCreateChatsSectionChat = jest.fn();
      const onSelect = jest.fn();
      render(
        'ready',
        {
          selection: null,
          onCreateWorktree,
          onCreateChatsSectionChat,
          onSelect,
        },
        cloudSnapshot([
          cloudWorkspace('default', 'My project', { chatsHome: true }),
        ]),
      );

      // Empty, the header and its "+" stay.
      expect(chatsSection()).not.toBeNull();
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="portal-chats-section-new-chat"]',
          )
          ?.click(),
      );
      await flush();

      expect(onCreateWorktree).toHaveBeenCalledWith('default');
      expect(onCreateChatsSectionChat).not.toHaveBeenCalled();
      expect(onSelect).toHaveBeenCalledWith({
        kind: 'worktree',
        workspaceLocalId: 'default',
        worktreeLocalId: 'created',
      });
    });

    it('selects a pending cloud create when its new row arrives', async () => {
      const onCreateWorktree = jest.fn(() =>
        Promise.resolve({ status: 'pending' as const }),
      );
      const onSelect = jest.fn();
      const props = { selection: null, onCreateWorktree, onSelect };
      const workspaces = [
        cloudWorkspace('default', 'My project', { chatsHome: true }),
      ];
      render(
        'ready',
        props,
        cloudSnapshot(workspaces, [cloudTask('original', 'default')]),
      );
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="portal-chats-section-new-chat"]',
          )
          ?.click(),
      );
      await flush();
      expect(onCreateWorktree).toHaveBeenCalledWith('default');
      expect(onSelect).not.toHaveBeenCalled();
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="portal-chats-section-new-chat"]',
          )
          ?.click(),
      );
      expect(onCreateWorktree).toHaveBeenCalledTimes(1);

      // The live host removes the create affordance while its request is pending.
      render(
        'ready',
        { ...props, onCreateWorktree: undefined },
        cloudSnapshot(workspaces, [cloudTask('original', 'default')]),
      );
      await flush();

      render(
        'ready',
        { ...props, onCreateWorktree: undefined },
        cloudSnapshot(workspaces, [
          cloudTask('original', 'default'),
          cloudTask('created', 'default'),
        ]),
      );
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith({
        kind: 'worktree',
        workspaceLocalId: 'default',
        worktreeLocalId: 'created',
      });
    });

    it('allows retry after a rejected cloud header create', async () => {
      const error = new Error('Cloud create rejected');
      const onCreateWorktree = jest
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({ status: 'completed', worktreeId: 'retry' });
      const onSelect = jest.fn();
      const onGroupError = jest.fn();
      render(
        'ready',
        { selection: null, onCreateWorktree, onSelect, onGroupError },
        cloudSnapshot([
          cloudWorkspace('default', 'My project', { chatsHome: true }),
        ]),
      );
      const create = (): void =>
        act(() =>
          container
            .querySelector<HTMLButtonElement>(
              '[data-testid="portal-chats-section-new-chat"]',
            )
            ?.click(),
        );
      create();
      await flush();
      expect(onGroupError).toHaveBeenCalledWith('default', error);
      expect(onSelect).not.toHaveBeenCalled();
      create();
      await flush();
      expect(onCreateWorktree).toHaveBeenCalledTimes(2);
      expect(onSelect).toHaveBeenCalledWith({
        kind: 'worktree',
        workspaceLocalId: 'default',
        worktreeLocalId: 'retry',
      });
    });

    it('drops pending cloud selection when the elected owner leaves', async () => {
      const onCreateWorktree = jest.fn(() =>
        Promise.resolve({ status: 'pending' as const }),
      );
      const onSelect = jest.fn();
      const props = { selection: null, onCreateWorktree, onSelect };
      const workspaces = [
        cloudWorkspace('default', 'My project', { chatsHome: true }),
      ];
      render('ready', props, cloudSnapshot(workspaces));
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="portal-chats-section-new-chat"]',
          )
          ?.click(),
      );
      await flush();
      render('ready', props, cloudSnapshot([]));
      render(
        'ready',
        props,
        cloudSnapshot(workspaces, [cloudTask('created', 'default')]),
      );
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('withholds creation and settings where the owner cannot run them', () => {
      render(
        'ready',
        {
          selection: null,
          onCreateWorktree: jest.fn(),
          isWorkspaceCommandDisabled: () => true,
          onOpenWorkspaceSettingsOverride: () => true,
        },
        cloudSnapshot([
          cloudWorkspace('default', 'My project', { chatsHome: true }),
        ]),
      );

      expect(chatsSection()).not.toBeNull();
      expect(
        container.querySelector(
          '[data-testid="portal-chats-section-new-chat"]',
        ),
      ).toBeNull();
      // `workspaceSettings: false` on the row's capabilities.
      expect(
        container.querySelector(
          '[data-testid="portal-chats-section-settings"]',
        ),
      ).toBeNull();
    });

    it('opens the elected owner settings under the displayed label', async () => {
      const onOpenWorkspaceSettingsOverride = jest.fn(() => true);
      render(
        'ready',
        {
          selection: null,
          capabilities: { ...capabilities, workspaceSettings: 'full' },
          onOpenWorkspaceSettingsOverride,
        },
        cloudSnapshot([
          cloudWorkspace('default', 'My project', { chatsHome: true }),
        ]),
      );

      act(() =>
        container
          .querySelector<HTMLButtonElement>('[aria-label="Chats settings"]')
          ?.click(),
      );
      await flush();
      expect(onOpenWorkspaceSettingsOverride).toHaveBeenCalledWith(
        'default',
        undefined,
      );
    });

    it('collapses to the selected row and persists through the owner', () => {
      const onWorkspaceCollapsedChange = jest.fn();
      const selection = {
        kind: 'worktree' as const,
        workspaceLocalId: 'default',
        worktreeLocalId: 'b',
      };
      const workspaces = (collapsed: boolean): SidebarSurfaceSnapshot =>
        cloudSnapshot(
          [
            cloudWorkspace('default', 'My project', {
              chatsHome: true,
              collapsed,
            }),
          ],
          [cloudTask('a', 'default'), cloudTask('b', 'default')],
        );
      render(
        'ready',
        { selection, onWorkspaceCollapsedChange },
        workspaces(false),
      );
      expect(container.querySelectorAll('[data-worktree-id]')).toHaveLength(2);

      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="portal-chats-section-toggle"]',
          )
          ?.click(),
      );
      expect(onWorkspaceCollapsedChange).toHaveBeenCalledWith('default', true);

      render(
        'ready',
        { selection, onWorkspaceCollapsedChange },
        workspaces(true),
      );
      expect(
        Array.from(container.querySelectorAll('[data-worktree-id]'), (row) =>
          row.getAttribute('data-worktree-id'),
        ),
      ).toEqual(['b']);

      render(
        'ready',
        { selection: null, onWorkspaceCollapsedChange },
        workspaces(true),
      );
      expect(container.querySelectorAll('[data-worktree-id]')).toHaveLength(0);
      expect(chatsSection()).not.toBeNull();
    });
  });

  it('uses short worktree names for subtitles and preserves unread icons', () => {
    render(
      'ready',
      {},
      {
        ...snapshot,
        worktrees: [
          {
            localId: 'dev-raven',
            workspaceLocalId: 'workspace',
            branch: 'dev-raven-1784117275337',
          },
          {
            localId: 'dev-urchin',
            workspaceLocalId: 'workspace',
            branch: 'iurevych/hey',
            hasUnread: true,
          },
          {
            localId: 'dev-leopard',
            workspaceLocalId: 'workspace',
            branch: 'feature/labeled',
            label: 'My label',
            hasUnread: true,
          },
        ],
      },
    );

    const rows = Array.from(
      container.querySelectorAll('[data-testid="worktree-row-subtitle"]'),
    ).map((row) => row.textContent);
    expect(rows).toEqual(['dev-raven', 'dev-urchin', 'dev-leopard']);
    expect(
      container.querySelectorAll('[data-testid="worktree-row-unread"]'),
    ).toHaveLength(2);
    expect(container.textContent).toContain('iurevych/hey');
    expect(container.textContent).toContain('My label');
  });

  it('owns loading and empty presentation', () => {
    render('loading');
    expect(
      container.querySelector('[data-testid="portal-sidebar-hydrating"]'),
    ).not.toBeNull();
    render('empty');
    expect(
      container.querySelector('[data-testid="portal-sidebar-empty"]'),
    ).not.toBeNull();
  });

  describe('shared control tooltips', () => {
    function control(testId: string): HTMLElement {
      const element = document.querySelector<HTMLElement>(
        `[data-testid="${testId}"]`,
      );
      if (!element) throw new Error(`Missing control: ${testId}`);
      return element;
    }

    function expectTooltip(element: HTMLElement, text: string): void {
      const id = element.getAttribute('aria-describedby');
      expect(id).toBeTruthy();
      if (!id) throw new Error('Missing tooltip description');
      const tooltip = document.getElementById(id);
      expect(tooltip?.getAttribute('role')).toBe('tooltip');
      expect(tooltip?.textContent).toBe(text);
      expect(container.contains(tooltip)).toBe(false);
      expect(element.hasAttribute('title')).toBe(false);
    }

    // The shared tooltip opens only for keyboard-driven focus (bare
    // `.focus()` is programmatic), so a Tab keydown precedes the focus.
    function focusViaKeyboard(element: HTMLElement): void {
      act(() => {
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
        );
        element.focus();
      });
    }

    // Main nav rows and More entries name themselves; they carry no hover or
    // focus tooltip (CAN-2673 descriptions removed per design review).
    function expectNoTooltip(element: HTMLElement): void {
      expect(element.hasAttribute('aria-describedby')).toBe(false);
      expect(element.hasAttribute('title')).toBe(false);
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
    }

    function hoverDisabled(element: HTMLElement): void {
      const wrapper = element.parentElement;
      if (!wrapper) throw new Error('Missing tooltip wrapper');
      act(() => {
        wrapper.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
    }

    it('leaves enabled New Task without a tooltip', () => {
      render('ready', { onCreateTask: jest.fn() });
      const button = control('portal-create-task');
      expect(button).toHaveProperty('disabled', false);
      focusViaKeyboard(button);
      expectNoTooltip(button);
    });

    it.each(['link', 'button'] as const)(
      'leaves a main nav %s row without a tooltip',
      (kind) => {
        render('ready', {
          navItemActions: {
            plugins:
              kind === 'link'
                ? { href: '/portal/plugins/marketplace' }
                : { onSelect: jest.fn() },
          },
        });
        const row = control('portal-sidebar-nav-plugins');
        focusViaKeyboard(row);
        act(() => {
          row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        });
        expectNoTooltip(row);
      },
    );

    it('preserves the host New Task explanation while disabled', () => {
      render('ready', { createTaskTooltip: 'X' });
      const button = control('portal-create-task');
      expect(button).toHaveProperty('disabled', true);
      hoverDisabled(button);
      expectTooltip(button, 'X');
    });

    it('leaves the More trigger without a tooltip', () => {
      render('ready', {
        navLayout: MORE_PAGES_LAYOUT,
        navItemActions: { audit: { href: '#audit' } },
      });
      const trigger = control('portal-more');
      focusViaKeyboard(trigger);
      expect(trigger.hasAttribute('aria-describedby')).toBe(false);
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
    });

    it.each(['link', 'button'] as const)(
      'keeps an available More %s item tooltip-free through keyboard navigation',
      (kind) => {
        const onSelect = jest.fn();
        render('ready', {
          navLayout: MORE_PAGES_LAYOUT,
          navItemActions: {
            audit:
              kind === 'link' ? { href: '#audit', onSelect } : { onSelect },
          },
        });
        act(() => control('portal-more').click());
        act(() => {
          control('portal-more-menu').dispatchEvent(
            new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
          );
        });
        const item = control('portal-more-item-audit');
        expect(document.activeElement).toBe(item);
        expect(item.getAttribute('role')).toBe('menuitem');
        expectNoTooltip(item);
        act(() => {
          item.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
          );
        });
        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(document.querySelector('[role="menu"]')).toBeNull();
        expect(document.activeElement).toBe(control('portal-more'));
      },
    );
  });

  it('returns More-menu focus to its trigger on Escape', () => {
    // More only mounts when it has an entry: a served More key, as here, or
    // a main-nav key folded into it below 1024px.
    render('ready', {
      navLayout: MORE_PAGES_LAYOUT,
      navItemActions: { audit: { href: '/portal/audit' } },
    });
    const trigger = container.querySelector('[data-testid="portal-more"]');
    if (!(trigger instanceof HTMLButtonElement)) {
      throw new Error('More trigger missing');
    }
    act(() => trigger.click());
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    elsewhere.remove();
  });

  it('restores the More-menu accessibility attributes and stable test ids', () => {
    render('ready', {
      navLayout: MORE_PAGES_LAYOUT,
      navItemActions: {
        audit: { href: '/portal/audit' },
        workers: { href: '/portal/workers' },
      },
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="portal-more"]',
    );
    act(() => trigger?.click());

    const menu = document.body.querySelector(
      '[data-testid="portal-more-menu"]',
    );
    expect(menu).not.toBeNull();
    expect(menu?.getAttribute('role')).toBe('menu');
    expect(menu?.getAttribute('aria-label')).toBe('More');
    expect(menu?.getAttribute('aria-orientation')).toBe('vertical');
    expect(menu?.getAttribute('data-positioned')).toBe('true');
    // Opening lands focus on the first served entry (the menu itself only
    // takes focus when it has no focusable descendant).
    expect(document.activeElement).toBe(
      document.body.querySelector('[data-testid="portal-more-item-audit"]'),
    );

    for (const id of ['audit', 'workers']) {
      const item = document.body.querySelector(
        `[data-testid="portal-more-item-${id}"]`,
      );
      expect(item?.getAttribute('role')).toBe('menuitem');
    }
  });

  it('renders a host-served nav key as a first-class main-nav row', () => {
    render('ready', {
      navItemActions: { plugins: { href: '/portal/plugins/marketplace' } },
    });
    const row = container.querySelector(
      '[data-testid="portal-sidebar-nav-plugins"]',
    );
    expect(row).not.toBeNull();
    expect(row?.tagName).toBe('A');
    expect(row?.getAttribute('href')).toBe('/portal/plugins/marketplace');
    expect(row?.textContent).toContain('Customize');
    // A main-nav row, not a More entry: it renders without opening the menu.
    expect(
      document.body.querySelector('[data-testid="portal-more-menu"]'),
    ).toBeNull();
  });

  it('renders the host-supplied current destination as the current page', () => {
    render('ready', {
      navItemActions: { plugins: { href: '/portal/plugins/marketplace' } },
      currentDestination: {
        label: 'Account',
        href: '/account',
        testId: 'portal-sidebar-anchor-account',
      },
    });

    const anchor = container.querySelector(
      '[data-testid="portal-sidebar-anchor-account"]',
    );
    expect(anchor).not.toBeNull();
    expect(anchor?.tagName).toBe('A');
    expect(anchor?.getAttribute('href')).toBe('/account');
    expect(anchor?.textContent).toContain('Account');
    expect(anchor?.getAttribute('aria-current')).toBe('page');
    expect(anchor?.getAttribute('data-selected')).toBe('true');
    // ONE active-state vocabulary: the anchor is styled exactly like an active
    // nav row, so the rail cannot grow a second way of saying "current".
    // Asserted against the shared helper rather than the literal classes — the
    // literal is what let desktop and the portal describe the same row two
    // different ways in the first place.
    expect(anchor?.className).toBe(sidebarNavItemClassName(true, false));
    // It lives in the nav block, beside the served nav rows.
    expect(
      container
        .querySelector('[data-testid="portal-sidebar-menu-block"]')
        ?.contains(anchor ?? null),
    ).toBe(true);
  });

  it('renders the current destination as a non-interactive row without an href', () => {
    render('ready', {
      currentDestination: {
        label: 'Run',
        testId: 'portal-sidebar-anchor-run',
      },
    });

    const anchor = container.querySelector(
      '[data-testid="portal-sidebar-anchor-run"]',
    );
    expect(anchor?.tagName).toBe('DIV');
    expect(anchor?.getAttribute('aria-current')).toBe('page');
  });

  describe('host routing of nav anchors', () => {
    function anchor(testId: string): HTMLAnchorElement {
      const element = document.body.querySelector(`[data-testid="${testId}"]`);
      if (!(element instanceof HTMLAnchorElement)) {
        throw new Error(`Missing anchor: ${testId}`);
      }
      return element;
    }

    function click(
      element: HTMLElement,
      init: MouseEventInit = {},
    ): MouseEvent {
      const event = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
        ...init,
      });
      act(() => {
        element.dispatchEvent(event);
      });
      return event;
    }

    it('routes a primary click on a main-nav anchor through the host router', () => {
      const onNavigateHref = jest.fn();
      const onSelect = jest.fn();
      render('ready', {
        onNavigateHref,
        navItemActions: {
          plugins: { href: '/portal/plugins/marketplace', onSelect },
        },
      });
      const event = click(anchor('portal-sidebar-nav-plugins'));
      expect(event.defaultPrevented).toBe(true);
      expect(onNavigateHref).toHaveBeenCalledWith(
        '/portal/plugins/marketplace',
      );
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['meta', { metaKey: true }],
      ['ctrl', { ctrlKey: true }],
      ['shift', { shiftKey: true }],
      ['alt', { altKey: true }],
      ['middle-button', { button: 1 }],
    ] as const)(
      'leaves a %s click to the browser so link affordances keep working',
      (_name, init) => {
        const onNavigateHref = jest.fn();
        render('ready', {
          onNavigateHref,
          navItemActions: { plugins: { href: '/portal/plugins/marketplace' } },
        });
        const event = click(anchor('portal-sidebar-nav-plugins'), init);
        expect(event.defaultPrevented).toBe(false);
        expect(onNavigateHref).not.toHaveBeenCalled();
      },
    );

    it('keeps plain anchors when the host supplies no router (desktop)', () => {
      render('ready', {
        navItemActions: { plugins: { href: '/portal/plugins/marketplace' } },
      });
      const event = click(anchor('portal-sidebar-nav-plugins'));
      expect(event.defaultPrevented).toBe(false);
    });

    it('routes the current-destination anchor through the host router', () => {
      const onNavigateHref = jest.fn();
      render('ready', {
        onNavigateHref,
        currentDestination: {
          label: 'Account',
          href: '/account',
          testId: 'portal-sidebar-anchor-account',
        },
      });
      const event = click(anchor('portal-sidebar-anchor-account'));
      expect(event.defaultPrevented).toBe(true);
      expect(onNavigateHref).toHaveBeenCalledWith('/account');
    });

    it('routes a More anchor through the host router and closes the menu', () => {
      const onNavigateHref = jest.fn();
      render('ready', {
        navLayout: MORE_PAGES_LAYOUT,
        onNavigateHref,
        navItemActions: { audit: { href: '/portal/audit' } },
      });
      const trigger = container.querySelector<HTMLButtonElement>(
        '[data-testid="portal-more"]',
      );
      act(() => trigger?.click());
      const event = click(anchor('portal-more-item-audit'));
      expect(event.defaultPrevented).toBe(true);
      expect(onNavigateHref).toHaveBeenCalledWith('/portal/audit');
      expect(document.body.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
  });

  // Desktop and /chat omit the prop; neither may gain a row.
  it('renders no extra nav row when the host supplies no current destination', () => {
    render('ready', {
      navItemActions: { plugins: { href: '/portal/plugins/marketplace' } },
    });

    expect(
      container.querySelectorAll('[data-testid^="portal-sidebar-anchor-"]')
        .length,
    ).toBe(0);
  });

  // Navigation-only chrome renders no New Task button, so the nav block used to
  // be skipped entirely when the host served no nav keys — which would have
  // swallowed the anchor.
  it('still renders the current destination under navigation-only chrome', () => {
    render('ready', {
      chrome: 'navigation-only',
      currentDestination: {
        label: 'Admin',
        href: '/admin',
        testId: 'portal-sidebar-anchor-admin',
      },
    });

    expect(
      container.querySelector('[data-testid="portal-sidebar-anchor-admin"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="portal-create-task"]'),
    ).toBeNull();
  });

  it('omits main-nav keys the host cannot serve rather than showing dead rows', () => {
    render('ready', {
      navItemActions: { plugins: { href: '/portal/plugins/marketplace' } },
    });
    for (const key of ['workflows', 'remote-control']) {
      expect(
        container.querySelector(`[data-testid="portal-sidebar-nav-${key}"]`),
      ).toBeNull();
    }
  });

  it('orders main-nav rows by the canonical layout, not by host key order', () => {
    render('ready', {
      navItemActions: {
        // Deliberately reversed relative to the canonical order.
        plugins: { href: '/portal/plugins/marketplace' },
        workflows: { href: '/portal/plugins/pipelines' },
      },
    });
    const keys = Array.from(
      container.querySelectorAll('[data-testid^="portal-sidebar-nav-"]'),
    ).map((node) => node.getAttribute('data-testid'));
    expect(keys).toEqual([
      'portal-sidebar-nav-workflows',
      'portal-sidebar-nav-plugins',
    ]);
  });

  it('invokes a host onSelect nav action', () => {
    const onSelect = jest.fn();
    render('ready', { navItemActions: { plugins: { onSelect } } });
    const row = container.querySelector<HTMLButtonElement>(
      '[data-testid="portal-sidebar-nav-plugins"]',
    );
    expect(row?.tagName).toBe('BUTTON');
    act(() => row?.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('marks the active nav row as the current page', () => {
    render('ready', {
      navItemActions: {
        plugins: { href: '/portal/plugins/marketplace', active: true },
      },
    });
    const row = container.querySelector(
      '[data-testid="portal-sidebar-nav-plugins"]',
    );
    expect(row?.getAttribute('aria-current')).toBe('page');
  });

  it('omits the More trigger entirely when the host serves none of its keys', () => {
    // Web serves only main-nav keys, so More would otherwise be a button that
    // opens a list of seven things you cannot do.
    render('ready', {
      navItemActions: { plugins: { href: '/portal/plugins/marketplace' } },
    });
    expect(container.querySelector('[data-testid="portal-more"]')).toBeNull();
    expect(
      document.body.querySelector('[data-testid="portal-more-menu"]'),
    ).toBeNull();
  });

  it('orders More entries by the canonical layout, not by host key order', () => {
    render('ready', {
      navLayout: MORE_PAGES_LAYOUT,
      navItemActions: {
        // Deliberately reversed relative to the canonical layout order.
        workers: { href: '/portal/workers' },
        audit: { href: '/portal/audit' },
        overview: { href: '/portal/overview' },
      },
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="portal-more"]',
    );
    act(() => trigger?.click());

    const keys = Array.from(
      document.body.querySelectorAll('[data-testid^="portal-more-item-"]'),
    ).map((node) => node.getAttribute('data-testid'));
    expect(keys).toEqual([
      'portal-more-item-overview',
      'portal-more-item-audit',
      'portal-more-item-workers',
    ]);
  });

  it('lists only host-served More entries', () => {
    render('ready', {
      navLayout: MORE_PAGES_LAYOUT,
      navItemActions: {
        audit: { href: '/portal/audit' },
      },
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="portal-more"]',
    );
    act(() => trigger?.click());

    const plugins = document.body.querySelector(
      '[data-testid="portal-more-item-audit"]',
    );
    expect(plugins).not.toBeNull();
    expect(plugins?.tagName).toBe('A');
    expect(plugins?.getAttribute('role')).toBe('menuitem');
    expect(plugins?.getAttribute('href')).toBe('/portal/audit');
    expect(plugins?.getAttribute('aria-disabled')).not.toBe('true');
    expect(plugins?.getAttribute('title')).toBeNull();
    expect(plugins?.textContent).toContain('Audit trail');
    // The action-menu row look: small text and a quiet tertiary icon.
    expect(plugins?.className).toContain('text-xs');
    expect(
      plugins?.querySelector('span[aria-hidden="true"]')?.className,
    ).toContain('fg-tertiary');

    // Keys this host cannot serve are dropped, not rendered disabled.
    for (const id of ['overview', 'kanban', 'workers']) {
      expect(
        document.body.querySelector(`[data-testid="portal-more-item-${id}"]`),
      ).toBeNull();
    }

    // Activating the enabled link closes the menu even when a host router
    // intercepts the anchor (preventDefault suppresses FloatingMenu's own
    // close-and-focus, so the entry closes and restores trigger focus
    // explicitly — focus must not fall to <body> with the anchor unmounted).
    plugins?.addEventListener('click', (event) => event.preventDefault());
    act(() => (plugins as HTMLAnchorElement).click());
    expect(
      document.body.querySelector('[data-testid="portal-more-menu"]'),
    ).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('returns a single trigger focus on an ordinary (unprevented) anchor click', () => {
    // A hash href keeps the click genuinely unprevented without tripping
    // jsdom's not-implemented full-page navigation.
    render('ready', {
      navLayout: MORE_PAGES_LAYOUT,
      navItemActions: { audit: { href: '#audit' } },
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="portal-more"]',
    );
    if (!trigger) throw new Error('More trigger missing');
    act(() => trigger.click());
    const plugins = document.body.querySelector<HTMLAnchorElement>(
      '[data-testid="portal-more-item-audit"]',
    );
    const focusSpy = jest.spyOn(trigger, 'focus');
    act(() => plugins?.click());
    expect(
      document.body.querySelector('[data-testid="portal-more-menu"]'),
    ).toBeNull();
    // Exactly one focus: FloatingMenu's close-and-focus. The anchor branch
    // must not stack its defaultPrevented fallback focus on top of it.
    expect(focusSpy).toHaveBeenCalledTimes(1);
    focusSpy.mockRestore();
  });

  it('invokes a host onSelect More action and closes the menu', () => {
    const onSelect = jest.fn();
    render('ready', {
      navLayout: MORE_PAGES_LAYOUT,
      navItemActions: { audit: { onSelect } },
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="portal-more"]',
    );
    act(() => trigger?.click());

    const plugins = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="portal-more-item-audit"]',
    );
    expect(plugins?.tagName).toBe('BUTTON');
    expect(plugins?.disabled).toBe(false);
    act(() => plugins?.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(
      document.body.querySelector('[data-testid="portal-more-menu"]'),
    ).toBeNull();
    // FloatingMenu's close-on-select contract returns focus to the trigger.
    expect(document.activeElement).toBe(trigger);
  });

  // Below 1024px the command-enabled nav keeps New task as its one row and
  // puts Search, the served destinations, and More in one strip of icon
  // buttons, folding what does not fit into More (CAN-3942, CAN-3943). The
  // gate is WIDTH, not pointer: a coarse-pointer laptop keeps the full rail,
  // and a `navigation-only` surface never compacts because it has no More
  // trigger to fold into.
  describe('narrow-width nav strip (CAN-3942, CAN-3943)', () => {
    interface MockQueryList {
      readonly media: string;
      matches: boolean;
      readonly listeners: Set<(event: { matches: boolean }) => void>;
    }

    const originalMatchMedia = Object.getOwnPropertyDescriptor(
      window,
      'matchMedia',
    );
    let lists: Map<string, MockQueryList>;
    let queryLists: Map<string, MediaQueryList>;
    let viewportWidth: number;

    function matchesAt(query: string, width: number): boolean {
      const max = /\(max-width:\s*(\d+)px\)/.exec(query);
      return max ? width <= Number(max[1]) : false;
    }

    /**
     * ONE stable list per query, installed before the first render and never
     * replaced mid-test: the shared hook caches lists by `matchMedia` identity,
     * so swapping the mock would silently detach every live subscription.
     */
    function installViewport(width: number): void {
      viewportWidth = width;
      lists = new Map();
      queryLists = new Map();
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: (query: string): MediaQueryList => {
          const cached = queryLists.get(query);
          if (cached) return cached;
          let list = lists.get(query);
          if (!list) {
            const created: MockQueryList = {
              media: query,
              matches: matchesAt(query, viewportWidth),
              listeners: new Set(),
            };
            list = created;
            lists.set(query, created);
          }
          const target = list;
          const result = {
            get matches(): boolean {
              return target.matches;
            },
            media: query,
            addEventListener: (
              _type: string,
              listener: (event: { matches: boolean }) => void,
            ): void => {
              target.listeners.add(listener);
            },
            removeEventListener: (
              _type: string,
              listener: (event: { matches: boolean }) => void,
            ): void => {
              target.listeners.delete(listener);
            },
            dispatchEvent: (event: Event): boolean => {
              if (event.type === 'change') {
                Array.from(target.listeners).forEach((listener) => {
                  listener({ matches: target.matches });
                });
              }
              return !event.defaultPrevented;
            },
          } as unknown as MediaQueryList;
          queryLists.set(query, result);
          return result;
        },
      });
    }

    function resizeTo(width: number): void {
      act(() => {
        viewportWidth = width;
        lists.forEach((list) => {
          const next = matchesAt(list.media, width);
          if (next === list.matches) return;
          list.matches = next;
          queryLists.get(list.media)?.dispatchEvent(new Event('change'));
        });
      });
    }

    afterEach(() => {
      if (originalMatchMedia) {
        Object.defineProperty(window, 'matchMedia', originalMatchMedia);
      } else {
        Reflect.deleteProperty(window, 'matchMedia');
      }
    });

    /** Advisor, Workflows, Customize, Remote Control — the paired web state. */
    function fourKeys(
      overrides: SidebarSurfaceProps['navItemActions'] = {},
    ): Partial<SidebarSurfaceProps> {
      return {
        onOpenAppAdvisor: jest.fn(),
        navItemActions: {
          plugins: { href: '/plugins' },
          workflows: { href: '/workflows' },
          'remote-control': { href: '/remote-control' },
          ...overrides,
        },
      };
    }

    /**
     * Every main-nav key served. Resolved order: Advisor, Workflows,
     * Customize, Feed, Remote Control. Five fill the strip on their own, so
     * Search or a host More entry makes the narrow layout fold.
     */
    function fiveKeys(
      overrides: SidebarSurfaceProps['navItemActions'] = {},
    ): Partial<SidebarSurfaceProps> {
      return fourKeys({ feed: { href: '/feed' }, ...overrides });
    }

    /** Desktop's Search row, which joins the strip below the breakpoint. */
    const navSearch: Partial<SidebarSurfaceProps> = {
      chatSearch: { candidates: [], onSelectResult: () => undefined },
      chatSearchPresentation: 'nav-row',
    };

    const ADVISOR = 'portal-sidebar-advisor';
    const WORKFLOWS = 'portal-sidebar-nav-workflows';
    const PLUGINS = 'portal-sidebar-nav-plugins';
    const FEED = 'portal-sidebar-nav-feed';
    const REMOTE = 'portal-sidebar-nav-remote-control';
    const SEARCH = 'portal-sidebar-chat-search-toggle';
    const MORE = 'portal-more';
    const ALL_FIVE = [ADVISOR, WORKFLOWS, PLUGINS, FEED, REMOTE];

    function moreItem(key: string): string {
      return `portal-more-item-${key}`;
    }

    /** Inline nav destinations only, in DOM order. Advisor keeps its id. */
    function navRowIds(): string[] {
      const block = container.querySelector(
        '[data-testid="portal-sidebar-menu-block"]',
      );
      if (!block) throw new Error('Missing nav block');
      return Array.from(
        block.querySelectorAll(
          '[data-testid^="portal-sidebar-nav-"]:not([data-testid="portal-sidebar-nav-strip"]), [data-testid="portal-sidebar-advisor"]',
        ),
      ).map((node) => node.getAttribute('data-testid') ?? '');
    }

    function strip(): HTMLElement | null {
      return container.querySelector<HTMLElement>(
        '[data-testid="portal-sidebar-nav-strip"]',
      );
    }

    /** Every control in the strip, in DOM order. */
    function stripControls(): HTMLElement[] {
      const row = strip();
      if (!row) throw new Error('Missing nav strip');
      return Array.from(row.querySelectorAll<HTMLElement>('[data-testid]'));
    }

    function stripIds(): string[] {
      return stripControls().map(
        (node) => node.getAttribute('data-testid') ?? '',
      );
    }

    function moreTrigger(): HTMLButtonElement | null {
      return container.querySelector<HTMLButtonElement>(
        '[data-testid="portal-more"]',
      );
    }

    /** More items are portaled, so they are read from the document body. */
    function moreItems(): HTMLElement[] {
      return Array.from(
        document.body.querySelectorAll<HTMLElement>(
          '[data-testid^="portal-more-item-"]',
        ),
      );
    }

    function openMoreItemIds(): string[] {
      const trigger = moreTrigger();
      if (!trigger) throw new Error('More trigger missing');
      if (trigger.getAttribute('aria-expanded') !== 'true') {
        act(() => trigger.click());
      }
      return moreItems().map((node) => node.getAttribute('data-testid') ?? '');
    }

    function classes(node: Element | null): string[] {
      return (node?.getAttribute('class') ?? '').split(/\s+/);
    }

    it('keeps New task as the one row and puts the rest in one icon strip', () => {
      // The QA failure: Search, Advisor, Customize and More each took a full
      // row, so Projects started halfway down a phone drawer.
      installViewport(390);
      render('ready', {
        variant: 'drawer',
        onCreateTask: jest.fn(),
        ...navSearch,
        ...fourKeys(),
      });

      const createTask = container.querySelector(
        '[data-testid="portal-create-task"]',
      );
      expect(createTask?.textContent).toBe('New task');
      expect(strip()?.contains(createTask)).toBe(false);
      expect(stripIds()).toEqual([SEARCH, ADVISOR, WORKFLOWS, PLUGINS, REMOTE]);
      // Everything fits, so there is no overflow to open.
      expect(moreTrigger()).toBeNull();
      const controls = stripControls();
      expect(controls.map((node) => node.getAttribute('aria-label'))).toEqual([
        'Search',
        'Advisor',
        'Workflows',
        'Customize',
        'Remote Control',
      ]);
      for (const control of controls) {
        // Icon only: the accessible name carries the label.
        expect(control.textContent).toBe('');
        expect(classes(control)).toEqual(
          expect.arrayContaining(['h-11', 'w-11']),
        );
      }
    });

    it('folds what does not fit the five-slot strip into More', () => {
      installViewport(390);
      render('ready', { variant: 'drawer', ...navSearch, ...fiveKeys() });
      expect(stripIds()).toEqual([SEARCH, ADVISOR, WORKFLOWS, PLUGINS, MORE]);
      const more = moreTrigger();
      expect(more?.getAttribute('aria-label')).toBe('More');
      expect(more?.textContent).toBe('');
      expect(classes(more)).toEqual(expect.arrayContaining(['h-11', 'w-11']));
      expect(openMoreItemIds()).toEqual([
        moreItem('feed'),
        moreItem('remote-control'),
      ]);
    });

    it('gives the Search slot to a destination when Search is elsewhere', () => {
      installViewport(390);
      render('ready', {
        variant: 'drawer',
        ...fiveKeys({ audit: { href: '/audit' } }),
      });
      expect(stripIds()).toEqual([ADVISOR, WORKFLOWS, PLUGINS, FEED, MORE]);
      expect(openMoreItemIds()).toEqual([
        moreItem('remote-control'),
        moreItem('audit'),
      ]);
    });

    it('opens a tooltip naming an icon-only control on keyboard focus', () => {
      installViewport(390);
      render('ready', { variant: 'drawer', ...fiveKeys() });
      const plugins = container.querySelector<HTMLElement>(
        `[data-testid="${PLUGINS}"]`,
      );
      if (!plugins) throw new Error('Missing Customize control');
      act(() => {
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
        );
        plugins.focus();
      });
      const id = plugins.getAttribute('aria-describedby');
      expect(id).toBeTruthy();
      const tooltip = id ? document.getElementById(id) : null;
      expect(tooltip?.getAttribute('role')).toBe('tooltip');
      expect(tooltip?.textContent).toBe('Customize');
    });

    it('marks the current destination in the strip', () => {
      installViewport(390);
      render('ready', {
        variant: 'drawer',
        ...fourKeys({ workflows: { href: '/workflows', active: true } }),
      });
      const workflows = container.querySelector(`[data-testid="${WORKFLOWS}"]`);
      expect(workflows?.getAttribute('aria-current')).toBe('page');
      expect(workflows?.hasAttribute('data-selected')).toBe(true);
      expect(classes(workflows)).toContain('bg-muted');
      const plugins = container.querySelector(`[data-testid="${PLUGINS}"]`);
      expect(plugins?.hasAttribute('aria-current')).toBe(false);
      expect(classes(plugins)).not.toContain('bg-muted');
    });

    it('shows a host current destination in the strip', () => {
      installViewport(390);
      render('ready', {
        variant: 'drawer',
        ...fourKeys(),
        currentDestination: {
          label: 'Account',
          icon: <span data-icon="account" />,
          href: '/account',
          testId: 'portal-sidebar-current-destination',
        },
      });
      expect(stripIds()).toEqual([
        ADVISOR,
        WORKFLOWS,
        PLUGINS,
        REMOTE,
        'portal-sidebar-current-destination',
      ]);
      const current = container.querySelector(
        '[data-testid="portal-sidebar-current-destination"]',
      );
      expect(current?.getAttribute('aria-label')).toBe('Account');
      expect(current?.getAttribute('aria-current')).toBe('page');
      expect(current?.textContent).toBe('');
    });

    it('labels a current destination that has no icon with text', () => {
      installViewport(390);
      render('ready', {
        variant: 'drawer',
        ...fourKeys(),
        currentDestination: {
          label: 'Account',
          testId: 'portal-sidebar-current-destination',
        },
      });
      const current = container.querySelector(
        '[data-testid="portal-sidebar-current-destination"]',
      );
      expect(strip()?.contains(current)).toBe(true);
      expect(current?.textContent).toBe('Account');
      expect(current?.getAttribute('aria-current')).toBe('page');
    });

    it('follows live width across a seeded mobile tier without remounting', () => {
      installViewport(390);
      render(
        'ready',
        { variant: 'drawer', ...navSearch, ...fiveKeys() },
        snapshot,
        'phone',
      );
      const sidebar = container.querySelector('[data-testid="portal-sidebar"]');
      const phoneQuery = window.matchMedia('(max-width: 639px)');
      const mobileQuery = window.matchMedia('(max-width: 1023px)');
      expect(window.matchMedia(phoneQuery.media)).toBe(phoneQuery);
      expect(window.matchMedia(mobileQuery.media)).toBe(mobileQuery);
      expect(navRowIds()).toHaveLength(3);
      expect(strip()).not.toBeNull();
      resizeTo(1024);
      expect(navRowIds()).toHaveLength(5);
      expect(strip()).toBeNull();
      expect(moreTrigger()).toBeNull();
      resizeTo(768);
      expect(navRowIds()).toHaveLength(3);
      expect(moreTrigger()).not.toBeNull();
      expect(container.querySelector('[data-testid="portal-sidebar"]')).toBe(
        sidebar,
      );
    });

    it('renders no strip when there is nothing to put in it', () => {
      installViewport(390);
      render('ready', { variant: 'drawer', onCreateTask: jest.fn() });
      expect(strip()).toBeNull();
      expect(
        container.querySelector('[data-testid="portal-create-task"]'),
      ).not.toBeNull();
    });

    it.each([
      ['one', { navItemActions: { plugins: { href: '/plugins' } } }, [PLUGINS]],
      [
        'two',
        {
          navItemActions: {
            plugins: { href: '/plugins' },
            workflows: { href: '/workflows' },
          },
        },
        [WORKFLOWS, PLUGINS],
      ],
      ['five', fiveKeys(), ALL_FIVE],
    ] as const)(
      'does not manufacture overflow for %s served main-nav keys',
      (_label, props, rows) => {
        installViewport(390);
        render('ready', {
          navLayout: MORE_PAGES_LAYOUT,
          variant: 'drawer',
          ...props,
        });
        expect(stripIds()).toEqual(rows);
        expect(moreTrigger()).toBeNull();
      },
    );

    it('keeps host More entries reachable with nothing to fold', () => {
      installViewport(390);
      render('ready', {
        navLayout: MORE_PAGES_LAYOUT,
        variant: 'drawer',
        navItemActions: {
          plugins: { href: '/plugins' },
          audit: { href: '/audit' },
        },
      });
      expect(stripIds()).toEqual([PLUGINS, MORE]);
      expect(openMoreItemIds()).toEqual([moreItem('audit')]);
    });

    it('prepends folded keys to host More entries without losing or repeating a key', () => {
      installViewport(390);
      const navItemActions = Object.freeze({
        workflows: Object.freeze({ href: '/workflows' }),
        plugins: Object.freeze({ href: '/plugins' }),
        'remote-control': Object.freeze({ href: '/remote-control' }),
        audit: Object.freeze({ href: '/audit' }),
        // Presentational only: not served, so it reaches neither region.
        feed: Object.freeze({ active: false }),
      });
      const before = JSON.stringify(navItemActions);
      render('ready', {
        variant: 'drawer',
        ...navSearch,
        onOpenAppAdvisor: jest.fn(),
        navItemActions,
      });

      const items = openMoreItemIds();
      expect(navRowIds()).toEqual([ADVISOR, WORKFLOWS, PLUGINS]);
      expect(items).toEqual([moreItem('remote-control'), moreItem('audit')]);
      expect(new Set(items).size).toBe(items.length);
      expect(container.querySelector(`[data-testid="${FEED}"]`)).toBeNull();
      expect(
        document.body.querySelector(`[data-testid="${moreItem('feed')}"]`),
      ).toBeNull();
      expect(JSON.stringify(navItemActions)).toBe(before);
    });

    it('keeps an explicitly customized layout order in both regions', () => {
      installViewport(390);
      const order = [
        'remote-control',
        'feed',
        'plugins',
        'app-advisor',
        'workflows',
      ];
      const navLayout: NonNullable<SidebarSurfaceProps['navLayout']> =
        Object.freeze({
          order: [...order, 'audit'],
          moreStartIndex: order.length,
        });
      Object.freeze(navLayout.order);
      const before = JSON.stringify(navLayout);
      render('ready', {
        variant: 'drawer',
        navLayout,
        ...navSearch,
        ...fiveKeys({ audit: { href: '/audit' } }),
      });
      expect(navRowIds()).toEqual([REMOTE, FEED, PLUGINS]);
      expect(openMoreItemIds()).toEqual([
        moreItem('app-advisor'),
        moreItem('workflows'),
        moreItem('audit'),
      ]);
      expect(JSON.stringify(navLayout)).toBe(before);
    });

    it('promotes the active destination into the strip', () => {
      installViewport(390);
      render('ready', {
        variant: 'drawer',
        ...navSearch,
        ...fiveKeys({
          'remote-control': { href: '/remote-control', active: true },
        }),
      });
      expect(navRowIds()).toEqual([ADVISOR, WORKFLOWS, REMOTE]);
      expect(
        container
          .querySelector(`[data-testid="${REMOTE}"]`)
          ?.getAttribute('aria-current'),
      ).toBe('page');
      // The displaced key is still reachable, in resolved order.
      expect(openMoreItemIds()).toEqual([
        moreItem('plugins'),
        moreItem('feed'),
      ]);
    });

    it('prefers an already-visible active key when several are flagged', () => {
      installViewport(390);
      render('ready', {
        variant: 'drawer',
        ...navSearch,
        ...fiveKeys({
          plugins: { href: '/plugins', active: true },
          feed: { href: '/feed', active: true },
        }),
      });
      expect(navRowIds()).toEqual([ADVISOR, WORKFLOWS, PLUGINS]);
      expect(openMoreItemIds()).toEqual([
        moreItem('feed'),
        moreItem('remote-control'),
      ]);
    });

    it('promotes the first active key in resolved order when none is visible', () => {
      installViewport(390);
      render('ready', {
        variant: 'drawer',
        ...navSearch,
        ...fiveKeys({
          feed: { href: '/feed', active: true },
          'remote-control': { href: '/remote-control', active: true },
        }),
      });
      expect(navRowIds()).toEqual([ADVISOR, WORKFLOWS, FEED]);
      expect(openMoreItemIds()).toEqual([
        moreItem('plugins'),
        moreItem('remote-control'),
      ]);
    });

    /** Desktop-width rows keep their visible labels. */
    function expectLabelledRows(): void {
      expect(navRowIds()).toEqual(ALL_FIVE);
      expect(strip()).toBeNull();
      expect(
        container.querySelector(`[data-testid="${PLUGINS}"]`)?.textContent,
      ).toBe('Customize');
      expect(moreTrigger()).toBeNull();
    }

    it.each([
      [1023, true],
      [768, true],
      [1024, false],
      [1280, false],
    ])('at %ipx compacts=%s', (width, compacts) => {
      installViewport(width);
      render('ready', { variant: 'drawer', ...navSearch, ...fiveKeys() });
      if (compacts) {
        expect(navRowIds()).toHaveLength(3);
        expect(strip()).not.toBeNull();
        expect(moreTrigger()).not.toBeNull();
      } else {
        expectLabelledRows();
      }
    });

    it.each(['coarse', 'fine'] as const)(
      'keeps every labelled row at desktop width under a %s pointer',
      (pointer) => {
        installViewport(1280);
        render('ready', {
          variant: 'drawer',
          pointer,
          ...navSearch,
          ...fiveKeys(),
        });
        expectLabelledRows();
      },
    );

    it('never compacts a navigation-only surface, which has no More trigger', () => {
      installViewport(390);
      render('ready', {
        variant: 'drawer',
        chrome: 'navigation-only',
        ...fiveKeys(),
      });
      expectLabelledRows();
    });

    it('re-partitions across the breakpoint without remounting the sidebar', () => {
      installViewport(390);
      const many: SidebarSurfaceSnapshot = {
        workspaces: Array.from({ length: 25 }, (_, index) => ({
          localId: `project-${index + 1}`,
          name: `Project ${index + 1}`,
          type: 'single-repo',
          order: index,
          collapsed: true,
        })),
        worktrees: [],
        standaloneChats: [],
      };
      const props = {
        variant: 'drawer' as const,
        selection: null,
        onCreateTask: jest.fn(),
        ...navSearch,
        ...fiveKeys(),
      };
      const projectRows = (): number =>
        container.querySelectorAll('[data-workspace-id]').length;
      render('ready', props, many);
      const createTask = container.querySelector(
        '[data-testid="portal-create-task"]',
      );
      const sidebarRoot = container.querySelector(
        '[data-testid="portal-sidebar"]',
      );
      expect(createTask).not.toBeNull();
      // List state that a remount would reset.
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="sidebar-projects-show-more"]',
          )
          ?.click(),
      );
      expect(projectRows()).toBe(20);
      expect(navRowIds()).toHaveLength(3);

      resizeTo(1280);
      expectLabelledRows();

      resizeTo(390);
      expect(navRowIds()).toHaveLength(3);
      expect(moreTrigger()).not.toBeNull();

      expect(
        container.querySelector('[data-testid="portal-create-task"]'),
      ).toBe(createTask);
      expect(container.querySelector('[data-testid="portal-sidebar"]')).toBe(
        sidebarRoot,
      );
      expect(projectRows()).toBe(20);
    });

    it('leaves no orphaned popup when the breakpoint is crossed with More open', () => {
      installViewport(390);
      render('ready', { variant: 'drawer', ...navSearch, ...fiveKeys() });
      expect(openMoreItemIds()).toHaveLength(2);
      const focused = moreItems()[0];
      act(() => focused?.focus());
      expect(document.activeElement).toBe(focused);

      resizeTo(1280);
      // Every folded key is a row again, so the trigger and its menu are gone.
      expect(moreTrigger()).toBeNull();
      expect(document.body.querySelector('[role="menu"]')).toBeNull();
      expect(moreItems()).toHaveLength(0);
      expect(navRowIds()).toEqual(ALL_FIVE);
      // The same destination has become an inline row: focus follows it.
      expect(document.activeElement).toBe(
        container.querySelector(`[data-testid="${FEED}"]`),
      );

      // Coming back, More is closed and usable again.
      resizeTo(390);
      expect(moreTrigger()?.getAttribute('aria-expanded')).toBe('false');
      expect(openMoreItemIds()).toEqual([
        moreItem('feed'),
        moreItem('remote-control'),
      ]);
    });

    it('drops only the folded items from an open More that keeps host entries', () => {
      installViewport(390);
      render('ready', {
        navLayout: MORE_PAGES_LAYOUT,
        variant: 'drawer',
        ...navSearch,
        ...fiveKeys({ audit: { href: '/audit' } }),
      });
      expect(openMoreItemIds()).toHaveLength(3);
      act(() => moreItems()[0]?.focus());

      resizeTo(1280);
      expect(navRowIds()).toEqual(ALL_FIVE);
      expect(
        moreItems().map((node) => node.getAttribute('data-testid')),
      ).toEqual([moreItem('audit')]);
      expect(document.activeElement).toBe(
        container.querySelector(`[data-testid="${FEED}"]`),
      );
    });

    it('preserves a folded action callback and anchor destination', () => {
      installViewport(390);
      const onSelect = jest.fn();
      render('ready', {
        variant: 'drawer',
        ...navSearch,
        ...fiveKeys({ feed: { onSelect } }),
      });
      openMoreItemIds();
      const remote = document.body.querySelector(
        `[data-testid="${moreItem('remote-control')}"]`,
      );
      expect(remote?.tagName).toBe('A');
      expect(remote?.getAttribute('href')).toBe('/remote-control');
      expect(remote?.getAttribute('role')).toBe('menuitem');

      const feed = document.body.querySelector<HTMLButtonElement>(
        `[data-testid="${moreItem('feed')}"]`,
      );
      expect(feed?.tagName).toBe('BUTTON');
      act(() => feed?.click());
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(document.body.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(moreTrigger());
    });

    it('preserves an inline action callback and anchor destination', () => {
      installViewport(390);
      const onSelect = jest.fn();
      render('ready', {
        variant: 'drawer',
        ...fourKeys({ workflows: { onSelect } }),
      });
      const plugins = container.querySelector(`[data-testid="${PLUGINS}"]`);
      expect(plugins?.tagName).toBe('A');
      expect(plugins?.getAttribute('href')).toBe('/plugins');
      const workflows = container.querySelector<HTMLButtonElement>(
        `[data-testid="${WORKFLOWS}"]`,
      );
      expect(workflows?.tagName).toBe('BUTTON');
      act(() => workflows?.click());
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it('closes the shared More menu across responsive unmounts and reopens with fresh ARIA relationships', () => {
      installViewport(390);
      render('ready', { variant: 'drawer', ...navSearch, ...fiveKeys() });
      const sidebar = container.querySelector('[data-testid="portal-sidebar"]');
      const trigger = moreTrigger();
      if (!trigger) throw new Error('Expected compact More');
      act(() => trigger.click());
      const menu = document.body.querySelector(
        '[data-testid="portal-more-menu"]',
      );
      expect(menu).not.toBeNull();
      expect(trigger.getAttribute('aria-controls')).toBe(menu?.id);
      expect(
        menu?.querySelector('[data-testid="sidebar-more-item-customize"]'),
      ).toBeNull();
      resizeTo(1280);
      expect(
        document.body.querySelector('[data-testid="portal-more-menu"]'),
      ).toBeNull();
      resizeTo(390);
      expect(moreTrigger()?.getAttribute('aria-expanded')).toBe('false');
      expect(container.querySelector('[data-testid="portal-sidebar"]')).toBe(
        sidebar,
      );
    });

    it('returns focus to More when a focused inline row folds on resize', () => {
      installViewport(1280);
      render('ready', { variant: 'drawer', ...navSearch, ...fiveKeys() });
      const remote = container.querySelector<HTMLAnchorElement>(
        `[data-testid="${REMOTE}"]`,
      );
      act(() => remote?.focus());
      expect(document.activeElement).toBe(remote);
      resizeTo(390);
      expect(document.activeElement).toBe(moreTrigger());
      expect(openMoreItemIds()).toHaveLength(2);
    });

    it('keeps focus on a row that stays inline when it becomes an icon', () => {
      installViewport(1280);
      render('ready', { variant: 'drawer', ...navSearch, ...fiveKeys() });
      const plugins = container.querySelector<HTMLAnchorElement>(
        `[data-testid="${PLUGINS}"]`,
      );
      act(() => plugins?.focus());
      resizeTo(390);
      expect(document.activeElement).toBe(
        container.querySelector(`[data-testid="${PLUGINS}"]`),
      );
    });

    it.each([
      ['Search', SEARCH],
      ['Advisor', ADVISOR],
      ['a host current destination', 'portal-sidebar-current-destination'],
    ])(
      'keeps focus on %s when it changes presentation across the breakpoint',
      (_label, testId) => {
        installViewport(1280);
        render('ready', {
          variant: 'drawer',
          ...navSearch,
          ...fourKeys(),
          currentDestination: {
            label: 'Account',
            icon: <span data-icon="account" />,
            href: '/account',
            testId: 'portal-sidebar-current-destination',
          },
        });
        const control = (): HTMLElement | null =>
          container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
        act(() => control()?.focus());
        expect(document.activeElement).toBe(control());

        resizeTo(390);
        expect(strip()?.contains(control())).toBe(true);
        expect(document.activeElement).toBe(control());

        resizeTo(1280);
        expect(strip()).toBeNull();
        expect(document.activeElement).toBe(control());
      },
    );

    it('keeps focus usable when the focused action becomes unavailable', () => {
      installViewport(390);
      render('ready', {
        variant: 'drawer',
        ...navSearch,
        ...fiveKeys({ audit: { href: '/audit' } }),
      });
      openMoreItemIds();
      act(() => moreItems()[1]?.focus());
      render('ready', {
        variant: 'drawer',
        ...navSearch,
        ...fiveKeys({
          audit: { href: '/audit' },
          'remote-control': { active: false },
        }),
      });
      expect(document.activeElement).toBe(moreTrigger());
      expect(moreItems()).toHaveLength(2);
    });

    it.each([
      ['coarse', true],
      ['fine', false],
    ] as const)(
      'sizes both More item variants for a %s pointer',
      (pointer, touchSized) => {
        installViewport(390);
        render('ready', {
          variant: 'drawer',
          pointer,
          ...navSearch,
          ...fiveKeys({ feed: { onSelect: jest.fn() } }),
        });
        openMoreItemIds();
        const items = moreItems();
        // One button variant (Feed) and one anchor variant (Remote Control).
        expect(items.map((node) => node.tagName)).toEqual(['BUTTON', 'A']);
        for (const item of items) {
          expect(item.className.split(/\s+/).includes('min-h-11')).toBe(
            touchSized,
          );
          expect(item.className.split(/\s+/)).toContain('h-8');
        }
      },
    );

    it('recomputes the partition when the served actions change', () => {
      installViewport(390);
      render('ready', {
        variant: 'drawer',
        ...navSearch,
        ...fiveKeys({ audit: { href: '/audit' } }),
      });
      expect(openMoreItemIds()).toEqual([
        moreItem('feed'),
        moreItem('remote-control'),
        moreItem('audit'),
      ]);

      // Remote Control stops being served while More is open.
      render('ready', {
        variant: 'drawer',
        ...navSearch,
        ...fiveKeys({
          audit: { href: '/audit' },
          'remote-control': { active: false },
        }),
      });
      expect(
        moreItems().map((node) => node.getAttribute('data-testid')),
      ).toEqual([moreItem('feed'), moreItem('audit')]);

      // Down to what the strip holds: nothing left to fold, so More goes away.
      render('ready', {
        variant: 'drawer',
        ...navSearch,
        ...fourKeys({ 'remote-control': { active: false } }),
      });
      expect(stripIds()).toEqual([SEARCH, ADVISOR, WORKFLOWS, PLUGINS]);
      expect(moreTrigger()).toBeNull();
      expect(document.body.querySelector('[role="menu"]')).toBeNull();
    });

    describe('server render', () => {
      function serverRender(tier?: 'phone' | 'tablet' | 'desktop'): string {
        const surface = (
          <SidebarSurface
            variant="drawer"
            snapshot={snapshot}
            selection={null}
            capabilities={capabilities}
            contentState="ready"
            onSelect={() => undefined}
            {...navSearch}
            {...fiveKeys()}
          />
        );
        return renderToString(
          tier === undefined ? (
            surface
          ) : (
            <LayoutTierProvider tier={tier}>{surface}</LayoutTierProvider>
          ),
        );
      }

      function rowCount(html: string): number {
        return (
          html.match(
            /data-testid="portal-sidebar-(?:nav-(?!strip")[a-z-]+|advisor)"/g,
          ) ?? []
        ).length;
      }

      it('stays on the desktop tier without a provider', () => {
        const html = serverRender();
        expect(rowCount(html)).toBe(5);
        expect(html).not.toContain('data-testid="portal-sidebar-nav-strip"');
        expect(html).not.toContain('data-testid="portal-more"');
      });

      it.each(['phone', 'tablet'] as const)(
        'renders the strip on the first paint for a seeded %s tier',
        (tier) => {
          const html = serverRender(tier);
          expect(html).toContain('data-testid="portal-sidebar-nav-strip"');
          expect(rowCount(html)).toBe(3);
          expect(html).toContain('data-testid="portal-more"');
        },
      );

      it('keeps every row for a seeded desktop tier', () => {
        const html = serverRender('desktop');
        expect(rowCount(html)).toBe(5);
        expect(html).not.toContain('data-testid="portal-more"');
      });
    });
  });

  // `variant` decides the LAYOUT SHAPE — a drawer fills its parent, a rail is
  // a fixed-width column. It used to decide hit-target sizing too, which left
  // one real host unable to say what it is: the desktop rail nests this
  // surface inside its own scroll area (drawer shape) on a mouse-and-keyboard
  // machine (fine pointer), and got 44px touch rows for its trouble.
  describe('pointer sizing is independent of layout variant', () => {
    function navRowHeights(): string[] {
      return Array.from(
        container.querySelectorAll(
          '[data-testid="portal-sidebar-menu-block"] button',
        ),
      ).map((node) => node.className);
    }

    it("defaults to the variant's own assumption", () => {
      render('ready', { variant: 'drawer', onOpenAppAdvisor: jest.fn() });
      expect(navRowHeights().some((cls) => cls.includes('min-h-11'))).toBe(
        true,
      );

      render('ready', { variant: 'rail', onOpenAppAdvisor: jest.fn() });
      expect(navRowHeights().some((cls) => cls.includes('min-h-11'))).toBe(
        false,
      );
    });

    it('lets a drawer-shaped host opt out of touch sizing', () => {
      render('ready', {
        variant: 'drawer',
        pointer: 'fine',
        onOpenAppAdvisor: jest.fn(),
      });
      expect(navRowHeights().length).toBeGreaterThan(0);
      expect(navRowHeights().some((cls) => cls.includes('min-h-11'))).toBe(
        false,
      );
    });

    it('keeps the drawer layout shape when opting out', () => {
      render('ready', {
        variant: 'drawer',
        pointer: 'fine',
        onOpenAppAdvisor: jest.fn(),
      });
      const root = container.querySelector('[data-testid="portal-sidebar"]');
      // Fills its parent rather than becoming a fixed-width 42vh column.
      expect(root?.className).toContain('flex-1');
      expect(root?.className).not.toContain('h-[42vh]');
      expect(root?.getAttribute('style') ?? '').not.toContain(
        '--worktree-panel-width',
      );
    });
  });

  it('suppresses exactly the command chrome in navigation-only mode', () => {
    render('ready', { chrome: 'navigation-only', onOpenAppAdvisor: jest.fn() });

    // The command-only controls are gone — not merely disabled.
    expect(
      container.querySelector('[data-testid="portal-create-task"]'),
    ).toBeNull();
    expect(container.querySelector('[data-testid="portal-more"]')).toBeNull();

    // Navigation stays: workspace rows, the Workspaces header, and the
    // Advisor entry (plain navigation) all render as usual.
    expect(
      container.querySelector('[data-testid="portal-workspace-list"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Projects');
    expect(
      container.querySelector('[data-testid="portal-sidebar-advisor"]'),
    ).not.toBeNull();
  });

  it('drops the nav block entirely when it would render as bare padding', () => {
    // navigation-only chrome with no served nav keys leaves the block with
    // nothing in it — no New Task, no rows, no More. Without the skip it
    // still renders its own `px-2 pb-1 pt-2`, which reads as a stray gap
    // above the Workspaces divider.
    render('ready', { chrome: 'navigation-only' });

    expect(
      container.querySelector('[data-testid="portal-sidebar-menu-block"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="portal-create-task"]'),
    ).toBeNull();
    expect(container.querySelector('[data-testid="portal-more"]')).toBeNull();
    expect(
      container.querySelector('[data-testid^="portal-sidebar-nav-"]'),
    ).toBeNull();

    // The rest of the sidebar is untouched — this skips a wrapper, not nav.
    expect(
      container.querySelector('[data-testid="portal-workspace-list"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Projects');
  });

  it('keeps the nav block when command chrome renders inside it', () => {
    // The counterpart to the skip above: `commandChrome` always renders New
    // Task (disabled when there is nothing to create), so the block is never
    // empty in full chrome even with no served nav keys.
    render('ready');

    expect(
      container.querySelector('[data-testid="portal-sidebar-menu-block"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="portal-create-task"]'),
    ).not.toBeNull();
  });

  it('keeps the nav block for served rows under navigation-only chrome', () => {
    render('ready', {
      chrome: 'navigation-only',
      navItemActions: { plugins: { href: '/portal/plugins/marketplace' } },
    });

    const block = container.querySelector(
      '[data-testid="portal-sidebar-menu-block"]',
    );
    expect(block).not.toBeNull();
    // The row is what keeps it alive, not the command chrome.
    expect(
      container.querySelector('[data-testid="portal-create-task"]'),
    ).toBeNull();
    expect(
      block?.querySelector('[data-testid="portal-sidebar-nav-plugins"]'),
    ).not.toBeNull();
  });

  it('explains a disabled Create Task through the rich tooltip on hover', () => {
    render('ready', { createTaskTooltip: 'Add a project first' });
    const trigger = container.querySelector(
      '[data-testid="portal-create-task"]',
    );
    expect(trigger).not.toBeNull();
    // Never a native title (CAN-2799); the reason lives in the shared tooltip.
    expect(trigger?.getAttribute('title')).toBeNull();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    act(() => {
      trigger?.parentElement?.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true }),
      );
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
      'Add a project first',
    );
  });

  it('keeps the command chrome by default and under explicit full chrome', () => {
    // A served More key so the trigger has something to open under both
    // chrome settings; command chrome alone no longer mounts it.
    const navItemActions: SidebarSurfaceProps['navItemActions'] = {
      audit: { href: '/portal/audit' },
    };
    render('ready', { navLayout: MORE_PAGES_LAYOUT, navItemActions });
    expect(
      container.querySelector('[data-testid="portal-create-task"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="portal-more"]'),
    ).not.toBeNull();

    render('ready', {
      chrome: 'full',
      navLayout: MORE_PAGES_LAYOUT,
      navItemActions,
    });
    expect(
      container.querySelector('[data-testid="portal-create-task"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="portal-more"]'),
    ).not.toBeNull();
  });

  it('renders the first-class Advisor row only when the host provides the callback (CAN-2562)', () => {
    const onOpenAppAdvisor = jest.fn();
    render('ready', {
      navLayout: MORE_PAGES_LAYOUT,
      onOpenAppAdvisor,
    });
    let row = container.querySelector<HTMLButtonElement>(
      '[data-testid="portal-sidebar-advisor"]',
    );
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('Advisor');
    expect(row?.getAttribute('aria-current')).toBeNull();
    expect(row?.getAttribute('data-selected')).toBeNull();
    act(() => row?.click());
    expect(onOpenAppAdvisor).toHaveBeenCalledTimes(1);

    render('ready', { onOpenAppAdvisor, appAdvisorActive: true });
    row = container.querySelector<HTMLButtonElement>(
      '[data-testid="portal-sidebar-advisor"]',
    );
    expect(row?.getAttribute('aria-current')).toBe('page');
    expect(row?.getAttribute('data-selected')).toBe('true');

    // Without the callback the row is absent entirely, and the More menu
    // carries no App Advisor entry (it lives at the top level, like desktop).
    // Serve a real More key so the menu actually mounts — otherwise the
    // trigger is null, the click is a no-op, and the assertion below passes
    // trivially even if Advisor *were* rendered inside More.
    render('ready', {
      navLayout: MORE_PAGES_LAYOUT,
      navItemActions: { audit: { href: '/portal/audit' } },
    });
    expect(
      container.querySelector('[data-testid="portal-sidebar-advisor"]'),
    ).toBeNull();
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="portal-more"]',
    );
    act(() => trigger?.click());
    // The menu is genuinely open, so the absence below is a real assertion.
    expect(
      document.body.querySelector('[data-testid="portal-more-item-audit"]'),
    ).not.toBeNull();
    expect(
      document.body.querySelector(
        '[data-testid="portal-more-item-app-advisor"]',
      ),
    ).toBeNull();
  });

  it('renames and recolors through Details, then re-diffs against the refreshed snapshot', async () => {
    const onUpdateWorkspace = jest.fn().mockResolvedValue(undefined);
    const onSaveClaudeMd = jest.fn().mockResolvedValue(undefined);
    const onSaveScripts = jest.fn().mockResolvedValue(undefined);
    const settingsProps: Partial<SidebarSurfaceProps> = {
      capabilities: { ...capabilities, workspaceSettings: 'full' },
      onLoadClaudeMd: jest.fn().mockResolvedValue(''),
      onLoadScripts: jest.fn().mockResolvedValue({}),
      onSaveClaudeMd,
      onSaveScripts,
      onUpdateWorkspace,
    };
    render('ready', settingsProps);

    const gear = container.querySelector<HTMLButtonElement>(
      '[aria-label="Settings for Workspace"]',
    );
    if (!gear) throw new Error('Workspace settings gear missing');
    act(() => gear.click());
    await flush();

    const dialog = document.querySelector<HTMLElement>(
      '[data-testid="portal-workspace-settings-dialog"]',
    );
    if (!dialog) throw new Error('Workspace settings dialog missing');

    const nameInput = dialog.querySelector<HTMLInputElement>(
      '[data-testid="portal-workspace-name-input"]',
    );
    if (!nameInput) throw new Error('Name input missing');
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(nameInput, 'Renamed');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const swatch = dialog.querySelector<HTMLButtonElement>(
      '[data-testid="portal-workspace-color-swatches"] [aria-label="Color #0EA5E9"]',
    );
    if (!swatch) throw new Error('Color swatch missing');
    act(() => swatch.click());

    const save = (): void => {
      const button = document.querySelector<HTMLButtonElement>(
        '[data-testid="portal-workspace-settings-save"]',
      );
      if (!button) throw new Error('Save button missing');
      act(() => button.click());
    };
    save();
    await flush();

    // Only what actually changed travels; metadata edits are not flag-gated.
    expect(onUpdateWorkspace).toHaveBeenCalledWith('workspace', {
      name: 'Renamed',
      color: '#0EA5E9',
    });
    // CLAUDE.md and scripts were untouched, so neither save fires.
    expect(onSaveClaudeMd).not.toHaveBeenCalled();
    expect(onSaveScripts).not.toHaveBeenCalled();

    // The host's overview refresh lands. The open dialog must re-read the
    // workspace from the live snapshot rather than the object captured when it
    // opened, or the subtitle keeps naming the pre-rename workspace and every
    // later Save re-sends an update that changes nothing.
    render('ready', settingsProps, {
      ...snapshot,
      workspaces: [
        {
          localId: 'workspace',
          name: 'Renamed',
          type: 'single-repo' as const,
          color: '#0EA5E9',
        },
      ],
    });
    expect(
      document.querySelector('[data-testid="portal-workspace-settings-dialog"]')
        ?.textContent,
    ).toContain('Renamed');

    save();
    await flush();
    expect(onUpdateWorkspace).toHaveBeenCalledTimes(1);

    // A later authoritative refresh may carry metadata changed elsewhere. The
    // still-open form must adopt that pristine metadata; otherwise saving an
    // unrelated tab compares stale form values with this live baseline and
    // silently writes the old name/color back.
    render('ready', settingsProps, {
      ...snapshot,
      workspaces: [
        {
          localId: 'workspace',
          name: 'Externally renamed',
          type: 'single-repo' as const,
          color: '#22C55E',
        },
      ],
    });
    const claudeMdTab = Array.from(dialog.querySelectorAll('button')).find(
      (button) => button.textContent === 'Instructions',
    );
    if (!claudeMdTab) throw new Error('CLAUDE.md tab missing');
    act(() => claudeMdTab.click());
    const claudeMd = dialog.querySelector<HTMLTextAreaElement>(
      '[data-testid="portal-workspace-claude-md-textarea"]',
    );
    if (!claudeMd) throw new Error('CLAUDE.md textarea missing');
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set?.call(claudeMd, '# Updated instructions');
      claudeMd.dispatchEvent(new Event('input', { bubbles: true }));
    });
    save();
    await flush();

    expect(onSaveClaudeMd).toHaveBeenCalledWith(
      'workspace',
      '# Updated instructions',
    );
    expect(onUpdateWorkspace).toHaveBeenCalledTimes(1);

    // A successful save becomes the new comparison baseline. Reverting to the
    // content that was loaded when the dialog first opened is still a real
    // change and must persist instead of being mistaken for an untouched form.
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set?.call(claudeMd, '');
      claudeMd.dispatchEvent(new Event('input', { bubbles: true }));
    });
    save();
    await flush();

    expect(onSaveClaudeMd).toHaveBeenLastCalledWith('workspace', '');
    expect(onSaveClaudeMd).toHaveBeenCalledTimes(2);
  });

  it('keeps a post-save rename while authoritative snapshots catch up', async () => {
    const initialWorkspaceSnapshot = {};
    const firstSaveSnapshot = {};
    const secondSaveSnapshot = {};
    let resolveSecondSave!: () => void;
    const secondSave = new Promise<void>((resolve) => {
      resolveSecondSave = resolve;
    });
    const onUpdateWorkspace = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(secondSave);
    const settingsProps: Partial<SidebarSurfaceProps> = {
      workspaceSnapshotVersion: initialWorkspaceSnapshot,
      capabilities: { ...capabilities, workspaceSettings: 'full' },
      onLoadClaudeMd: jest.fn().mockResolvedValue(''),
      onLoadScripts: jest.fn().mockResolvedValue({}),
      onSaveClaudeMd: jest.fn().mockResolvedValue(undefined),
      onSaveScripts: jest.fn().mockResolvedValue(undefined),
      onUpdateWorkspace,
    };
    render('ready', settingsProps);

    const gear = container.querySelector<HTMLButtonElement>(
      '[aria-label="Settings for Workspace"]',
    );
    if (!gear) throw new Error('Workspace settings gear missing');
    act(() => gear.click());
    await flush();

    const nameInput = document.querySelector<HTMLInputElement>(
      '[data-testid="portal-workspace-name-input"]',
    );
    const save = document.querySelector<HTMLButtonElement>(
      '[data-testid="portal-workspace-settings-save"]',
    );
    if (!nameInput || !save) throw new Error('Settings controls missing');
    const rename = (name: string): void => {
      act(() => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set?.call(nameInput, name);
        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };

    // The command can resolve before its authoritative overview snapshot is
    // applied in this React tree. A second edit must diff against the accepted
    // first save, not the still-old snapshot.
    rename('First rename');
    act(() => save.click());
    await flush();
    rename('Workspace');
    act(() => save.click());
    await flush();
    expect(onUpdateWorkspace.mock.calls).toEqual([
      ['workspace', { name: 'First rename' }],
      ['workspace', { name: 'Workspace' }],
    ]);

    // Persisted collapse state rebuilds the rendered workspace array during
    // ordinary portal rerenders. That is not an authoritative overview and
    // must not acknowledge the second save while its request is still open.
    render('ready', settingsProps, {
      ...snapshot,
      workspaces: [...snapshot.workspaces],
    });
    await act(async () => {
      resolveSecondSave();
      await secondSave;
    });
    await flush();

    // The first save's delayed snapshot must not overwrite the newer accepted
    // edit. The later matching snapshot releases the optimistic baseline.
    render(
      'ready',
      { ...settingsProps, workspaceSnapshotVersion: firstSaveSnapshot },
      {
        ...snapshot,
        workspaces: [
          {
            localId: 'workspace',
            name: 'First rename',
            type: 'single-repo' as const,
            color: '#22C55E',
          },
        ],
      },
    );
    expect(nameInput.value).toBe('Workspace');
    const externallyChangedColor = document.querySelector<HTMLButtonElement>(
      '[data-testid="portal-workspace-color-swatches"] [aria-label="Color #22C55E"]',
    );
    expect(externallyChangedColor?.getAttribute('aria-pressed')).toBe('true');
    render(
      'ready',
      { ...settingsProps, workspaceSnapshotVersion: secondSaveSnapshot },
      {
        ...snapshot,
        workspaces: [
          {
            localId: 'workspace',
            name: 'Workspace',
            type: 'single-repo' as const,
            color: '#22C55E',
          },
        ],
      },
    );
    expect(nameInput.value).toBe('Workspace');
    expect(externallyChangedColor?.getAttribute('aria-pressed')).toBe('true');
  });

  it('adopts a conflicting authoritative metadata update after a save', async () => {
    const initialWorkspaceSnapshot = {};
    const conflictingWorkspaceSnapshot = {};
    const settingsProps: Partial<SidebarSurfaceProps> = {
      workspaceSnapshotVersion: initialWorkspaceSnapshot,
      capabilities: { ...capabilities, workspaceSettings: 'full' },
      onLoadClaudeMd: jest.fn().mockResolvedValue(''),
      onLoadScripts: jest.fn().mockResolvedValue({}),
      onSaveClaudeMd: jest.fn().mockResolvedValue(undefined),
      onSaveScripts: jest.fn().mockResolvedValue(undefined),
      onUpdateWorkspace: jest.fn().mockResolvedValue(undefined),
    };
    render('ready', settingsProps);

    const gear = container.querySelector<HTMLButtonElement>(
      '[aria-label="Settings for Workspace"]',
    );
    if (!gear) throw new Error('Workspace settings gear missing');
    act(() => gear.click());
    await flush();

    const nameInput = document.querySelector<HTMLInputElement>(
      '[data-testid="portal-workspace-name-input"]',
    );
    const save = document.querySelector<HTMLButtonElement>(
      '[data-testid="portal-workspace-settings-save"]',
    );
    if (!nameInput || !save) throw new Error('Settings controls missing');
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(nameInput, 'Saved rename');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      save.click();
    });
    await flush();

    // A newer overview may contain a same-field update made elsewhere rather
    // than echoing this command's value. Once authoritative, it must win.
    render(
      'ready',
      {
        ...settingsProps,
        workspaceSnapshotVersion: conflictingWorkspaceSnapshot,
      },
      {
        ...snapshot,
        workspaces: [
          {
            localId: 'workspace',
            name: 'External rename',
            type: 'single-repo' as const,
          },
        ],
      },
    );
    expect(nameInput.value).toBe('External rename');
  });

  it('keeps successful metadata edits when settings closes before refresh', async () => {
    const settingsProps: Partial<SidebarSurfaceProps> = {
      workspaceSnapshotVersion: {},
      capabilities: { ...capabilities, workspaceSettings: 'full' },
      onLoadClaudeMd: jest.fn().mockResolvedValue(''),
      onLoadScripts: jest.fn().mockResolvedValue({}),
      onSaveClaudeMd: jest.fn().mockResolvedValue(undefined),
      onSaveScripts: jest.fn().mockResolvedValue(undefined),
      onUpdateWorkspace: jest.fn().mockResolvedValue(undefined),
    };
    render('ready', settingsProps);

    const open = async (): Promise<void> => {
      const gear = container.querySelector<HTMLButtonElement>(
        '[aria-label="Settings for Workspace"]',
      );
      if (!gear) throw new Error('Workspace settings gear missing');
      act(() => gear.click());
      await flush();
    };
    await open();

    const nameInput = document.querySelector<HTMLInputElement>(
      '[data-testid="portal-workspace-name-input"]',
    );
    const color = document.querySelector<HTMLButtonElement>(
      '[data-testid="portal-workspace-color-swatches"] [aria-label="Color #0EA5E9"]',
    );
    const save = document.querySelector<HTMLButtonElement>(
      '[data-testid="portal-workspace-settings-save"]',
    );
    if (!nameInput || !color || !save)
      throw new Error('Settings controls missing');
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(nameInput, 'Saved rename');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      color.click();
    });
    act(() => {
      save.click();
    });
    await flush();

    const done = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Done');
    if (!done) throw new Error('Done button missing');
    act(() => done.click());
    await open();

    const reopenedName = document.querySelector<HTMLInputElement>(
      '[data-testid="portal-workspace-name-input"]',
    );
    const reopenedColor = document.querySelector<HTMLButtonElement>(
      '[data-testid="portal-workspace-color-swatches"] [aria-label="Color #0EA5E9"]',
    );
    expect(reopenedName?.value).toBe('Saved rename');
    expect(reopenedColor?.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps project settings closed when CLAUDE.md is unconfirmed', async () => {
    const onLoadClaudeMd = jest.fn().mockResolvedValue(null);
    render('ready', {
      capabilities: { ...capabilities, workspaceSettings: 'full' },
      onLoadClaudeMd,
      onLoadScripts: jest.fn().mockResolvedValue({}),
      onSaveClaudeMd: jest.fn(),
      onSaveScripts: jest.fn(),
      onUpdateWorkspace: jest.fn(),
    });

    const gear = container.querySelector<HTMLButtonElement>(
      '[aria-label="Settings for Workspace"]',
    );
    if (!gear) throw new Error('Workspace settings gear missing');
    act(() => gear.click());
    await flush();

    expect(onLoadClaudeMd).toHaveBeenCalledWith('workspace');
    expect(
      document.querySelector(
        '[data-testid="portal-workspace-settings-dialog"]',
      ),
    ).toBeNull();
  });

  it('routes worktree deletion through confirmation before archiving', () => {
    const onArchiveWorktree = jest.fn();
    render('ready', { onArchiveWorktree });

    const actions = container.querySelector<HTMLButtonElement>(
      '[data-testid="portal-worktree-actions-menu-button"]',
    );
    act(() => actions?.click());
    const remove = document.querySelector<HTMLButtonElement>(
      '[data-testid="portal-delete-worktree"]',
    );
    act(() => remove?.click());

    expect(onArchiveWorktree).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="portal-delete-worktree-confirm"]'),
    ).not.toBeNull();

    const confirm = document.querySelector<HTMLButtonElement>(
      '[data-testid="confirm-dialog-confirm"]',
    );
    act(() => confirm?.click());
    expect(onArchiveWorktree).toHaveBeenCalledWith('workspace', 'worktree');
  });

  it.each([
    ['no capability', {}, true, true],
    ['no host callback', { worktreeRepositoryAttachment: true }, false, true],
    [
      'host reports unavailable',
      { worktreeRepositoryAttachment: true },
      true,
      false,
    ],
  ])(
    'keeps Add repository out of the default menu with %s',
    (_name, capabilityPatch, wireCallback, available) => {
      render('ready', {
        capabilities: { ...capabilities, ...capabilityPatch },
        isAddRepositoryAvailable: () => available,
        onAddRepositoryRequested: wireCallback ? jest.fn() : undefined,
      });

      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="portal-worktree-actions-menu-button"]',
          )
          ?.click(),
      );
      expect(
        document.querySelector(
          '[data-testid="portal-worktree-actions-add-repository"]',
        ),
      ).toBeNull();
    },
  );

  it.each([
    ['no capability (the web host)', {}, true, true],
    ['no host callback', { workspaceMoveToOrganization: true }, false, true],
    [
      'host reports unavailable',
      { workspaceMoveToOrganization: true },
      true,
      false,
    ],
    [
      'no availability callback',
      { workspaceMoveToOrganization: true },
      true,
      undefined,
    ],
  ])(
    'offers no Move to organization with %s',
    (_name, capabilityPatch, wireCallback, available) => {
      render('ready', {
        capabilities: { ...capabilities, ...capabilityPatch },
        isWorkspaceMoveToOrganizationAvailable:
          available === undefined ? undefined : (): boolean => available,
        onMoveWorkspaceToOrganizationRequested: wireCallback
          ? jest.fn()
          : undefined,
      });

      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="portal-worktree-actions-menu-button"]',
          )
          ?.click(),
      );
      expect(
        document.querySelector(
          '[data-testid="portal-worktree-actions-move-to-organization"]',
        ),
      ).toBeNull();
    },
  );

  it('emits the project id when Move to organization is selected', () => {
    const onMoveWorkspaceToOrganizationRequested = jest.fn();
    const isWorkspaceMoveToOrganizationAvailable = jest.fn((): boolean => true);
    render('ready', {
      capabilities: { ...capabilities, workspaceMoveToOrganization: true },
      isWorkspaceMoveToOrganizationAvailable,
      onMoveWorkspaceToOrganizationRequested,
    });

    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="portal-worktree-actions-menu-button"]',
        )
        ?.click(),
    );
    const move = document.querySelector<HTMLButtonElement>(
      '[data-testid="portal-worktree-actions-move-to-organization"]',
    );
    expect(move?.textContent).toContain('Move to org…');
    act(() => move?.click());
    expect(isWorkspaceMoveToOrganizationAvailable).toHaveBeenCalledWith(
      'workspace',
    );
    expect(onMoveWorkspaceToOrganizationRequested).toHaveBeenCalledWith(
      'workspace',
    );
  });

  it('routes Add repository to the host-owned modal callback', () => {
    const onAddRepositoryRequested = jest.fn();
    render('ready', {
      capabilities: {
        ...capabilities,
        worktreeRepositoryAttachment: true,
      },
      isAddRepositoryAvailable: () => true,
      onAddRepositoryRequested,
    });

    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="portal-worktree-actions-menu-button"]',
        )
        ?.click(),
    );
    const addRepository = document.querySelector<HTMLButtonElement>(
      '[data-testid="portal-worktree-actions-add-repository"]',
    );
    expect(addRepository?.disabled).toBe(false);
    act(() => addRepository?.click());
    expect(onAddRepositoryRequested).toHaveBeenCalledWith(
      'workspace',
      'worktree',
    );
  });

  it.each([
    {
      name: 'an active session',
      props: { hasActiveWorktreeSession: (): boolean => true },
      worktree: {},
      tooltip: 'Stop active sessions before adding a repo',
    },
    {
      name: 'a done worktree',
      props: {},
      worktree: { status: 'done' },
      tooltip: 'Done worktrees cannot add repos',
    },
    {
      name: 'pending Git setup',
      props: {},
      worktree: { setupPhase: 'git-pending' },
      tooltip: 'Wait for setup to finish before adding a repo',
    },
    {
      name: 'running setup',
      props: {},
      worktree: { setupPhase: 'running-setup' },
      tooltip: 'Wait for setup to finish before adding a repo',
    },
  ])(
    'uses desktop Add repository disabled copy for $name',
    ({ props, worktree, tooltip }) => {
      render(
        'ready',
        {
          capabilities: {
            ...capabilities,
            worktreeRepositoryAttachment: true,
          },
          isAddRepositoryAvailable: () => true,
          onAddRepositoryRequested: jest.fn(),
          ...props,
        },
        {
          ...snapshot,
          worktrees: snapshot.worktrees.map((item): typeof item => ({
            ...item,
            ...worktree,
          })),
        },
      );

      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="portal-worktree-actions-menu-button"]',
          )
          ?.click(),
      );
      const addRepository = document.querySelector<HTMLButtonElement>(
        '[data-testid="portal-worktree-actions-add-repository"]',
      );
      expect(addRepository?.disabled).toBe(true);
      expect(addRepository?.title).toBe(tooltip);
    },
  );

  it.each([
    {
      name: 'active session over done and setup',
      props: { hasActiveWorktreeSession: (): boolean => true },
      worktree: { status: 'done', setupPhase: 'git-pending' },
      tooltip: 'Stop active sessions before adding a repo',
    },
    {
      name: 'done over setup',
      props: {},
      worktree: { status: 'done', setupPhase: 'git-pending' },
      tooltip: 'Done worktrees cannot add repos',
    },
  ])(
    'preserves desktop Add repository disabled precedence for $name',
    ({ props, worktree, tooltip }) => {
      render(
        'ready',
        {
          capabilities: {
            ...capabilities,
            worktreeRepositoryAttachment: true,
          },
          isAddRepositoryAvailable: () => true,
          onAddRepositoryRequested: jest.fn(),
          ...props,
        },
        {
          ...snapshot,
          worktrees: snapshot.worktrees.map((item): typeof item => ({
            ...item,
            ...worktree,
          })),
        },
      );

      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="portal-worktree-actions-menu-button"]',
          )
          ?.click(),
      );
      const addRepository = document.querySelector<HTMLButtonElement>(
        '[data-testid="portal-worktree-actions-add-repository"]',
      );
      expect(addRepository?.disabled).toBe(true);
      expect(addRepository?.title).toBe(tooltip);
    },
  );

  it('paints a pinned grouped child flat but keeps its ungroup action', () => {
    // Desktop's rule: a pinned row leads the section and is not drawn as a
    // group child, yet its base-branch relation survives for the menu.
    const pinnedSnapshot: SidebarSurfaceSnapshot = {
      ...snapshot,
      worktrees: [
        {
          localId: 'root',
          workspaceLocalId: 'workspace',
          branch: 'feature-root',
          order: 0,
        },
        {
          localId: 'child',
          workspaceLocalId: 'workspace',
          branch: 'feature-child',
          order: 1,
          pinned: true,
        },
      ],
    };
    render(
      'ready',
      {
        capabilities: { ...capabilities, worktreeBranchGrouping: true },
        branchGroupingEnabled: true,
        getBranchGrouping: () => ({
          baseBranchByWorktreeId: new Map([
            ['root', 'main'],
            ['child', 'feature-root'],
          ]),
          defaultBranches: new Set(['main']),
          groupingEnabled: true,
        }),
        onSetBranchGroupingOverride: jest.fn(),
      },
      pinnedSnapshot,
    );

    const rows = Array.from(
      container.querySelectorAll<HTMLElement>('[data-worktree-id]'),
    ).map((row) => row.dataset.worktreeId);
    expect(rows[0]).toBe('child');
    expect(
      container.querySelector(
        '[data-testid="worktree-branch-group-child"][data-child-worktree-id="child"]',
      ),
    ).toBeNull();

    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-worktree-id="child"] [aria-label="More actions"]',
        )
        ?.click(),
    );
    const labels = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).map((item) => item.textContent ?? '');
    expect(labels.some((label) => label.includes('Unstack from base'))).toBe(
      true,
    );
  });

  it('lists every pinned row before an unpinned child of a pinned root', () => {
    // CAN-1074 on desktop: pinning the base and a peer must not interleave
    // the base's unpinned child into the leading pinned group.
    const pinnedSnapshot: SidebarSurfaceSnapshot = {
      ...snapshot,
      worktrees: [
        {
          localId: 'root',
          workspaceLocalId: 'workspace',
          branch: 'feature-root',
          order: 0,
          pinned: true,
        },
        {
          localId: 'child',
          workspaceLocalId: 'workspace',
          branch: 'feature-child',
          order: 1,
        },
        {
          localId: 'peer',
          workspaceLocalId: 'workspace',
          branch: 'feature-peer',
          order: 2,
          pinned: true,
        },
      ],
    };
    render(
      'ready',
      {
        capabilities: { ...capabilities, worktreeBranchGrouping: true },
        branchGroupingEnabled: true,
        getBranchGrouping: () => ({
          baseBranchByWorktreeId: new Map([
            ['root', 'main'],
            ['child', 'feature-root'],
            ['peer', 'main'],
          ]),
          defaultBranches: new Set(['main']),
          groupingEnabled: true,
        }),
        onSetBranchGroupingOverride: jest.fn(),
      },
      pinnedSnapshot,
    );

    const rows = Array.from(
      container.querySelectorAll<HTMLElement>('[data-worktree-id]'),
    ).map((row) => row.dataset.worktreeId);
    expect(rows).toEqual(['root', 'peer', 'child']);
    expect(
      container.querySelector(
        '[data-testid="worktree-branch-group-child"][data-child-worktree-id="child"]',
      ),
    ).toBeNull();
  });

  // Two projects, so the rail renders project headers at all (a lone
  // visible project omits its header).
  const twoProjects: SidebarSurfaceSnapshot['workspaces'] = [
    { localId: 'workspace', name: 'Workspace', type: 'single-repo' },
    { localId: 'other', name: 'Other', type: 'single-repo' },
  ];

  it('marks pinned worktrees and host-reported pinned projects with the pin', () => {
    const pinnedSnapshot: SidebarSurfaceSnapshot = {
      ...snapshot,
      workspaces: twoProjects,
      worktrees: [
        {
          localId: 'pinned-row',
          workspaceLocalId: 'workspace',
          branch: 'feature-pinned',
          order: 0,
          pinned: true,
        },
        {
          localId: 'plain-row',
          workspaceLocalId: 'workspace',
          branch: 'feature-plain',
          order: 1,
        },
      ],
    };
    render(
      'ready',
      {
        isWorkspacePinned: (workspaceLocalId) =>
          workspaceLocalId === 'workspace',
      },
      pinnedSnapshot,
    );

    expect(
      container.querySelector(
        '[data-worktree-id="pinned-row"] [data-testid="worktree-row-pinned-badge"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-worktree-id="plain-row"] [data-testid="worktree-row-pinned-badge"]',
      ),
    ).toBeNull();
    expect(
      container.querySelectorAll(
        '[data-testid="workspace-section-pinned-badge"]',
      ),
    ).toHaveLength(1);
  });

  it('shows no project pin when the host reports none', () => {
    render('ready', {}, { ...snapshot, workspaces: twoProjects });
    // Both headers render; neither carries the pin.
    expect(
      container.querySelectorAll('[data-testid="workspace-section-actions"]'),
    ).toHaveLength(2);
    expect(
      container.querySelector('[data-testid="workspace-section-pinned-badge"]'),
    ).toBeNull();
  });

  it('exposes the host toggle id on each workspace header', () => {
    render(
      'ready',
      {
        workspaceNameTogglesCollapse: true,
        onSelectWorkspace: jest.fn(),
        testIds: {
          root: 'portal-sidebar',
          workspaceToggle: (workspaceLocalId, workspaceType) =>
            `${workspaceType}-toggle-${workspaceLocalId}`,
        },
      },
      {
        ...snapshot,
        workspaces: [
          {
            localId: 'aviary',
            name: 'Aviary',
            type: 'cowork',
            layout: 'flat',
          },
          {
            localId: 'code',
            name: 'Code',
            type: 'single-repo',
          },
        ],
        worktrees: [],
      },
    );
    const coworkToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="cowork-toggle-aviary"]',
    );
    expect(coworkToggle?.getAttribute('aria-expanded')).toBe('true');
    expect(
      container.querySelector('[data-testid="single-repo-toggle-code"]'),
    ).not.toBeNull();
  });

  it('ungroups a non-leaf child itself without changing its descendants', async () => {
    const onSetBranchGroupingOverride = jest.fn().mockResolvedValue(undefined);
    const chainSnapshot: SidebarSurfaceSnapshot = {
      ...snapshot,
      worktrees: [
        {
          localId: 'root',
          workspaceLocalId: 'workspace',
          branch: 'feature-root',
        },
        {
          localId: 'middle',
          workspaceLocalId: 'workspace',
          branch: 'feature-middle',
        },
        {
          localId: 'leaf',
          workspaceLocalId: 'workspace',
          branch: 'feature-leaf',
        },
      ],
    };
    render(
      'ready',
      {
        capabilities: { ...capabilities, worktreeBranchGrouping: true },
        branchGroupingEnabled: true,
        getBranchGrouping: () => ({
          baseBranchByWorktreeId: new Map([
            ['root', 'main'],
            ['middle', 'feature-root'],
            ['leaf', 'feature-middle'],
          ]),
          defaultBranches: new Set(['main']),
          groupingEnabled: true,
        }),
        onSetBranchGroupingOverride,
      },
      chainSnapshot,
    );

    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-worktree-id="middle"] [aria-label="More actions"]',
        )
        ?.click(),
    );
    const action = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((item) => item.textContent?.includes('Unstack from base'));
    await act(async () => {
      action?.click();
      await Promise.resolve();
    });

    expect(onSetBranchGroupingOverride).toHaveBeenCalledTimes(1);
    expect(onSetBranchGroupingOverride).toHaveBeenCalledWith(
      'workspace',
      'middle',
      'ungroup',
    );
  });

  it.each([
    {
      capability: 'archive' as const,
      label: 'Archive main',
      iconSelector: 'svg[data-glyph="archive"]',
      dialogTitle: 'Archive worktree?',
      dialogCopy:
        'This removes the worktree from disk while keeping its chats and eligible pipeline history.',
      confirmLabel: 'Archive',
    },
    {
      capability: 'delete' as const,
      label: 'Delete main',
      iconSelector: 'svg[data-glyph="trash-2"]',
      dialogTitle: 'Delete worktree?',
      dialogCopy:
        'This removes the worktree and its checkout and can’t be undone.',
      confirmLabel: 'Delete',
    },
  ])(
    'hover-reveals $capability presentation for a done worktree removal action',
    ({
      capability,
      label,
      iconSelector,
      dialogTitle,
      dialogCopy,
      confirmLabel,
    }) => {
      render(
        'ready',
        {
          capabilities: { ...capabilities, worktreeRemoval: capability },
          onArchiveWorktree: jest.fn(),
        },
        {
          ...snapshot,
          worktrees: snapshot.worktrees.map((worktree) => ({
            ...worktree,
            status: 'done',
          })),
        },
      );

      const removalButton = container.querySelector<HTMLButtonElement>(
        '[data-testid="portal-worktree-delete-button"]',
      );
      expect(removalButton?.getAttribute('aria-label')).toBe(label);
      expect(removalButton?.querySelector(iconSelector)).not.toBeNull();
      const chip = removalButton?.closest(
        '[data-testid="worktree-row-action-chip"]',
      );
      expect(chip?.getAttribute('data-always-visible')).toBeNull();
      const removalWrapper = removalButton?.parentElement?.parentElement;
      expect(removalWrapper?.className).toContain('opacity-0');
      expect(removalWrapper?.className).toContain(
        'group-hover/sidebar-item:opacity-100',
      );
      expect(removalWrapper?.className).toContain(
        'group-focus-within/sidebar-item:opacity-100',
      );
      expect(removalWrapper?.className).toContain('pointer-coarse:opacity-100');
      const moreButton = chip?.querySelector<HTMLButtonElement>(
        '[aria-label="More actions"]',
      );
      const moreWrapper = moreButton?.parentElement?.parentElement;
      expect(moreWrapper?.className).toContain('opacity-0');
      expect(moreWrapper?.className).toContain(
        'group-hover/sidebar-item:opacity-100',
      );
      expect(moreWrapper?.className).toContain(
        'group-focus-within/sidebar-item:opacity-100',
      );
      expect(moreWrapper?.className).toContain('pointer-coarse:opacity-100');
      const row = chip?.closest('[data-worktree-id="worktree"]');
      expect(row?.innerHTML).toContain('pointer-fine:group-hover:pr-13.5');
      expect(row?.innerHTML).toContain(
        'pointer-fine:group-focus-within:pr-13.5',
      );

      act(() => removalButton?.click());
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog?.textContent).toContain(dialogTitle);
      expect(dialog?.textContent).toContain(dialogCopy);
      expect(
        Array.from(dialog?.querySelectorAll('button') ?? []).some(
          (button) => button.textContent === confirmLabel,
        ),
      ).toBe(true);
    },
  );

  describe('chat search (CAN-1990)', () => {
    const searchCandidates = [
      {
        kind: 'worktree-chat' as const,
        workspaceLocalId: 'workspace',
        workspaceName: 'Workspace',
        worktreeLocalId: 'worktree',
        worktreeName: 'main',
        chatId: 'chat-1',
        title: 'Fix flaky tests',
      },
      {
        kind: 'standalone-chat' as const,
        workspaceLocalId: 'cowork',
        workspaceName: 'Cowork',
        chatId: 'cw-1',
        title: 'Roadmap brainstorm',
      },
    ];

    function setQuery(value: string): void {
      const input = container.querySelector<HTMLInputElement>(
        '[data-testid="portal-sidebar-chat-search-input"]',
      );
      if (!input) throw new Error('chat search input missing');
      // Set through the prototype descriptor so React's input value tracker
      // registers the change (a direct `.value` write is deduped).
      const setter = Reflect.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      act(() => {
        if (setter) Reflect.apply(setter, input, [value]);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }

    it('renders the search input only when the host wires chatSearch', () => {
      render('ready');
      expect(
        container.querySelector(
          '[data-testid="portal-sidebar-chat-search-input"]',
        ),
      ).toBeNull();

      render('ready', {
        chatSearch: { candidates: searchCandidates, onSelectResult: jest.fn() },
      });
      expect(
        container.querySelector(
          '[data-testid="portal-sidebar-chat-search-input"]',
        ),
      ).not.toBeNull();
    });

    it('hides the covered tree from keyboard and assistive tech while search is active', () => {
      render('ready', {
        testIds: {
          root: 'portal-sidebar',
          scroll: 'portal-sidebar-scroll',
          loading: 'portal-sidebar-hydrating',
          empty: 'portal-sidebar-empty',
          workspaceList: 'portal-workspace-list',
        },
        chatSearch: { candidates: searchCandidates, onSelectResult: jest.fn() },
      });
      const scroll = (): HTMLElement | null =>
        container.querySelector('[data-testid="portal-sidebar-scroll"]');
      expect(scroll()?.hasAttribute('inert')).toBe(false);
      expect(scroll()?.getAttribute('aria-hidden')).toBeNull();

      setQuery('flaky');
      expect(scroll()?.hasAttribute('inert')).toBe(true);
      expect(scroll()?.getAttribute('aria-hidden')).toBe('true');

      setQuery('');
      expect(scroll()?.hasAttribute('inert')).toBe(false);
      expect(scroll()?.getAttribute('aria-hidden')).toBeNull();
    });

    it('filters case-insensitively, shows project context, and keeps the tree mounted', () => {
      render('ready', {
        chatSearch: { candidates: searchCandidates, onSelectResult: jest.fn() },
      });
      setQuery('FLAKY');

      const results = container.querySelector(
        '[data-testid="portal-sidebar-chat-search-results"]',
      );
      expect(results).not.toBeNull();
      expect(
        results?.querySelector(
          '[data-testid="portal-sidebar-chat-search-result-chat-1"]',
        )?.textContent,
      ).toContain('Fix flaky tests');
      expect(
        results?.querySelector(
          '[data-testid="portal-sidebar-chat-search-result-chat-1"]',
        )?.textContent,
      ).toContain('Workspace');
      expect(
        results?.querySelector(
          '[data-testid="portal-sidebar-chat-search-result-cw-1"]',
        ),
      ).toBeNull();
      // The grouped tree stays mounted (scroll state preserved), covered by
      // the results overlay.
      expect(
        container.querySelector('[data-testid="portal-workspace-list"]'),
      ).not.toBeNull();
    });

    it('invokes onSelectResult with the picked candidate', () => {
      const onSelectResult = jest.fn();
      render('ready', {
        chatSearch: { candidates: searchCandidates, onSelectResult },
      });
      setQuery('roadmap');
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="portal-sidebar-chat-search-result-cw-1"]',
          )
          ?.click(),
      );
      expect(onSelectResult).toHaveBeenCalledWith(searchCandidates[1]);
    });

    it('clears the query via the clear button and restores the tree view', () => {
      render('ready', {
        chatSearch: { candidates: searchCandidates, onSelectResult: jest.fn() },
      });
      setQuery('roadmap');
      expect(
        container.querySelector(
          '[data-testid="portal-sidebar-chat-search-results"]',
        ),
      ).not.toBeNull();

      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="portal-sidebar-chat-search-clear"]',
          )
          ?.click(),
      );
      expect(
        container.querySelector(
          '[data-testid="portal-sidebar-chat-search-results"]',
        ),
      ).toBeNull();
      expect(
        container.querySelector<HTMLInputElement>(
          '[data-testid="portal-sidebar-chat-search-input"]',
        )?.value,
      ).toBe('');
    });

    it('shows an empty state for a no-match query and a syncing hint while hydrating', () => {
      render('ready', {
        chatSearch: {
          candidates: searchCandidates,
          hydrating: true,
          onSelectResult: jest.fn(),
        },
      });
      setQuery('zzz-no-match');
      const empty = container.querySelector(
        '[data-testid="portal-sidebar-chat-search-empty"]',
      );
      expect(empty).not.toBeNull();
      expect(empty?.textContent).toContain('zzz-no-match');
      expect(
        container.querySelector(
          '[data-testid="portal-sidebar-chat-search-syncing"]',
        ),
      ).not.toBeNull();
    });
  });

  // REG-2817. The two-backend split used to be rendered as labelled sections;
  // both backends now share one list, and the chrome those sections carried
  // moved to two list-level slots.
  describe('unified project list', () => {
    const unifiedSnapshot: SidebarSurfaceSnapshot = {
      ...snapshot,
      workspaces: [
        { localId: 'cloud-a', name: 'Cloud A', type: 'single-repo' },
        { localId: 'rc-a', name: 'Remote A', type: 'single-repo' },
      ],
      worktrees: [],
    };

    it('renders every project in one list, in snapshot order', () => {
      render('ready', {}, unifiedSnapshot);
      const lists = container.querySelectorAll(
        '[data-testid="portal-workspace-list"]',
      );
      expect(lists).toHaveLength(1);
      expect(
        Array.from(lists[0]?.querySelectorAll('[data-workspace-id]') ?? []).map(
          (row) => row.getAttribute('data-workspace-id'),
        ),
      ).toEqual(['cloud-a', 'rc-a']);
    });

    // REG-2818. The unified list briefly carried TWO header creation controls,
    // one per backend. There is exactly one now, and a host whose workspaces
    // can live in more than one place takes it over wholesale.
    it('offers exactly one add-workspace control, taken over by the host', () => {
      const onOpenCreateWorkspaceOverride = jest.fn(() => true);
      render('ready', { onOpenCreateWorkspaceOverride }, unifiedSnapshot);

      const header = container.querySelector('[data-testid="portal-sidebar"]');
      expect(
        header?.querySelectorAll('[aria-label="Add project"]'),
      ).toHaveLength(1);
      const add = container.querySelector<HTMLButtonElement>(
        '[data-testid="portal-add-workspace"]',
      );
      expect(add).not.toBeNull();
      act(() => add?.click());
      expect(onOpenCreateWorkspaceOverride).toHaveBeenCalledTimes(1);
      // The host owns the modal, so the shell's own create dialog stays shut.
      expect(
        document.querySelector(
          '[data-testid="portal-create-workspace-dialog"]',
        ),
      ).toBeNull();
    });

    it('renders the list footer after the rows', () => {
      render(
        'ready',
        {
          listFooter: (
            <button data-testid="connect-device">Connect a device</button>
          ),
        },
        unifiedSnapshot,
      );
      const footer = container.querySelector('[data-testid="connect-device"]');
      const list = container.querySelector(
        '[data-testid="portal-workspace-list"]',
      );
      expect(footer).not.toBeNull();
      expect(list).not.toBeNull();
      expect(
        list?.compareDocumentPosition(footer ?? list) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    // Desktop's "Shared with me": a host section that follows Projects (and
    // its Hidden disclosure) inside the rail, ahead of the list footer, and
    // stays even when Projects has nothing to list or is collapsed.
    it('renders host trailing sections after Projects and before the footer', () => {
      render(
        'ready',
        {
          trailingSections: <section data-testid="host-shared-with-me" />,
          listFooter: <span data-testid="rc-footer" />,
        },
        unifiedSnapshot,
      );
      const section = container.querySelector(
        '[data-testid="host-shared-with-me"]',
      );
      const list = container.querySelector(
        '[data-testid="portal-workspace-list"]',
      );
      const footer = container.querySelector('[data-testid="rc-footer"]');
      const rail = container.querySelector('[data-testid="portal-sidebar"]');
      expect(section).not.toBeNull();
      expect(rail?.contains(section)).toBe(true);
      expect(
        list?.compareDocumentPosition(section ?? list) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        section?.compareDocumentPosition(footer ?? section) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it.each(['empty', 'loading', 'waiting'] as const)(
      'keeps host trailing sections mounted in the %s content state',
      (contentState) => {
        render(
          contentState,
          { trailingSections: <section data-testid="host-shared-with-me" /> },
          { ...snapshot, workspaces: [], worktrees: [] },
        );
        expect(
          container.querySelector('[data-testid="host-shared-with-me"]'),
        ).not.toBeNull();
      },
    );

    // REG-2814's affordance lives here now, and the state it exists for is the
    // one where the list has nothing in it.
    it.each(['empty', 'loading', 'waiting'] as const)(
      'keeps the list footer mounted in the %s content state',
      (contentState) => {
        render(
          contentState,
          { listFooter: <span data-testid="rc-footer" /> },
          { ...snapshot, workspaces: [], worktrees: [] },
        );
        expect(
          container.querySelector('[data-testid="rc-footer"]'),
        ).not.toBeNull();
      },
    );

    it('renders no footer chrome when the host supplies neither slot', () => {
      render('ready', {}, unifiedSnapshot);
      expect(
        container.querySelector('[data-testid="connect-device"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="sidebar-footer-callout"]'),
      ).toBeNull();
    });

    // The pinned slot. Its entire reason to exist is being OUTSIDE the
    // scroller: the web Chat tab's connect/reconnect card explains why the
    // list above it is short, and an explanation that scrolls out of view with
    // the thing it is explaining is no explanation. Asserting "not contained
    // by the scroll region" is therefore the contract, not an implementation
    // detail — a refactor that moved it back inside would be the regression.
    it('pins the footer callout outside the scroll region', () => {
      render(
        'ready',
        {
          footerCallout: <span data-testid="pinned-card" />,
          testIds: {
            root: 'portal-sidebar',
            scroll: 'portal-sidebar-scroll',
            loading: 'portal-sidebar-hydrating',
            empty: 'portal-sidebar-empty',
            workspaceList: 'portal-workspace-list',
          },
        },
        unifiedSnapshot,
      );

      const callout = container.querySelector('[data-testid="pinned-card"]');
      const scroll = container.querySelector(
        '[data-testid="portal-sidebar-scroll"]',
      );
      expect(callout).not.toBeNull();
      expect(scroll).not.toBeNull();
      expect(scroll?.contains(callout ?? null)).toBe(false);

      // And it follows the list rather than preceding it — bottom of the nav,
      // not top.
      expect(
        scroll?.compareDocumentPosition(callout ?? scroll) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    // Same reasoning as the list footer: the state the card exists for is the
    // one where the desktop's rows were withheld, which is often no rows.
    it.each(['empty', 'loading', 'waiting'] as const)(
      'keeps the footer callout mounted in the %s content state',
      (contentState) => {
        render(
          contentState,
          { footerCallout: <span data-testid="pinned-card" /> },
          { ...snapshot, workspaces: [], worktrees: [] },
        );
        expect(
          container.querySelector('[data-testid="pinned-card"]'),
        ).not.toBeNull();
      },
    );

    // Three rules stacked in as many rows (callout divider, card outline,
    // status-strip divider) is what the pinned card was supposed to reduce, not
    // add to. The callout carries no rule and suppresses the strip's, leaving
    // the card's own outline as the single separator.
    //
    // Asserted on the class list rather than `getComputedStyle`: jsdom loads no
    // Tailwind, so computed borders are empty for every variant here and would
    // make this pass vacuously. This checks the presence of the width utility,
    // not a color — CAN-2734's inert-`border-<color>` hazard does not apply.
    it("carries no divider, and drops the status strip's, when both are present", () => {
      render(
        'ready',
        {
          footerCallout: <span data-testid="pinned-card" />,
          footer: <span data-testid="status-strip" />,
        },
        unifiedSnapshot,
      );
      const callout = container.querySelector(
        '[data-testid="sidebar-footer-callout"]',
      );
      const strip = container
        .querySelector('[data-testid="status-strip"]')
        ?.closest('div');
      expect(callout?.className).not.toContain('border-t');
      expect(strip?.className).not.toContain('border-t');
    });

    it('keeps the status strip divider when there is no callout above it', () => {
      render(
        'ready',
        { footer: <span data-testid="status-strip" /> },
        unifiedSnapshot,
      );
      const strip = container
        .querySelector('[data-testid="status-strip"]')
        ?.closest('div');
      expect(strip?.classList.contains('border-t')).toBe(true);
      expect(strip?.classList.contains('pt-2')).toBe(true);
    });

    it('renders the footer callout above the footer status strip', () => {
      render(
        'ready',
        {
          footerCallout: <span data-testid="pinned-card" />,
          footer: <span data-testid="status-strip" />,
        },
        unifiedSnapshot,
      );
      const callout = container.querySelector('[data-testid="pinned-card"]');
      const strip = container.querySelector('[data-testid="status-strip"]');
      expect(callout).not.toBeNull();
      expect(strip).not.toBeNull();
      expect(
        callout?.compareDocumentPosition(strip ?? callout) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });
  });

  it('saves deleted script keys as blank clearing values', () => {
    expect(
      scriptsForSave(
        { setup: 'npm install', launch: 'npm start' },
        { launch: 'npm start' },
      ),
    ).toEqual({ setup: '', launch: 'npm start' });
    expect(
      scriptsForSave({ launch: 'npm start' }, { launch: 'npm start' }),
    ).toBeUndefined();
  });

  it('stops grouping overrides at the first failure and rejects to the caller', async () => {
    const failure = new Error('override failed');
    const apply = jest
      .fn<Promise<void>, [string, 'group' | 'ungroup']>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(failure);

    await expect(
      applyBranchGroupingOverrides(
        ['first', 'failing', 'not-attempted'],
        'group',
        apply,
      ),
    ).rejects.toBe(failure);
    expect(apply.mock.calls).toEqual([
      ['first', 'group'],
      ['failing', 'group'],
    ]);
  });

  describe('per-row capability resolution (REG-2816)', () => {
    const mixedSnapshot: SidebarSurfaceSnapshot = {
      ...snapshot,
      workspaces: [
        {
          localId: 'cloud:ws:a',
          name: 'Cloud',
          type: 'cowork',
          layout: 'tree',
        },
        {
          localId: 'ws-remote',
          name: 'Desktop',
          type: 'single-repo',
          itemSortMode: 'manual',
        },
      ],
      worktrees: [
        {
          localId: 'cloud:task:a',
          workspaceLocalId: 'cloud:ws:a',
          branch: 'cloud',
          label: 'Planning session',
        },
        { localId: 'wt-remote', workspaceLocalId: 'ws-remote', branch: 'main' },
      ],
    };
    const remoteControlCapabilities: CanopyCapabilities = {
      ...capabilities,
      workspaceReordering: true,
      worktreeReordering: true,
      workspaceSettings: 'full',
      workspaceRemoval: 'delete',
      worktreeRemoval: 'archive',
      worktreeCreation: true,
      worktreeBranching: true,
    };
    const cloudCapabilities: CanopyCapabilities = {
      ...capabilities,
      workspaceReordering: true,
      worktreeReordering: false,
      workspaceSettings: false,
      workspaceRemoval: 'archive',
      worktreeRemoval: 'archive',
    };
    const capabilitiesFor = (localId: string): CanopyCapabilities =>
      localId.startsWith('cloud:')
        ? cloudCapabilities
        : remoteControlCapabilities;

    function renderMixed(
      overrides: Partial<SidebarSurfaceProps> = {},
      nextSnapshot: PortalSessionShellState = mixedSnapshot,
    ): void {
      render(
        'ready',
        {
          capabilities: remoteControlCapabilities,
          capabilitiesFor,
          onArchiveWorktree: jest.fn(),
          onCreateWorktree: jest.fn(),
          onCreateBranchWorktree: jest.fn(),
          onReorderWorkspaces: jest.fn(),
          onReorderWorktrees: jest.fn(),
          ...overrides,
        },
        nextSnapshot,
      );
    }

    it('keeps each project and worktree drag capability independent in a mixed list', () => {
      renderMixed();

      expect(
        container.querySelector(
          '[data-workspace-sortable-wrapper="ws-remote"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelector(
          '[data-workspace-sortable-wrapper="cloud:ws:a"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelector('[aria-label="Reorder Desktop"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[aria-label="Reorder Cloud"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-worktree-sortable-wrapper="wt-remote"]'),
      ).not.toBeNull();
      expect(
        container.querySelector(
          '[data-worktree-sortable-wrapper="cloud:task:a"]',
        ),
      ).toBeNull();
    });

    it('preserves manual order and dragging for older RC snapshots without a mode', () => {
      renderMixed(
        {},
        {
          ...mixedSnapshot,
          workspaces: mixedSnapshot.workspaces.map((workspace) => ({
            ...workspace,
            itemSortMode: undefined,
          })),
          worktrees: [
            {
              localId: 'wt-older',
              workspaceLocalId: 'ws-remote',
              branch: 'older',
              order: 0,
              lastActivityAt: '2026-09-01T00:00:00.000Z',
            },
            {
              localId: 'wt-newer',
              workspaceLocalId: 'ws-remote',
              branch: 'newer',
              order: 1,
              lastActivityAt: '2026-09-02T00:00:00.000Z',
            },
          ],
        },
      );
      expect(
        Array.from(container.querySelectorAll('[data-worktree-id]')).map(
          (row) => row.getAttribute('data-worktree-id'),
        ),
      ).toEqual(['wt-older', 'wt-newer']);
      expect(
        container.querySelector('[data-worktree-sortable-wrapper="wt-older"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-worktree-sortable-wrapper="wt-newer"]'),
      ).not.toBeNull();
    });

    it('keeps cloud rows in recency order when their mode is absent', () => {
      renderMixed(
        {},
        {
          ...mixedSnapshot,
          workspaces: [
            {
              localId: 'cloud:ws:a',
              name: 'Cloud',
              type: 'single-repo',
              backend: 'cloud',
            },
          ],
          worktrees: [
            {
              localId: 'cloud:older',
              workspaceLocalId: 'cloud:ws:a',
              branch: 'older',
              backend: 'cloud',
              order: 0,
              lastActivityAt: '2026-09-01T00:00:00.000Z',
            },
            {
              localId: 'cloud:newer',
              workspaceLocalId: 'cloud:ws:a',
              branch: 'newer',
              backend: 'cloud',
              order: 1,
              lastActivityAt: '2026-09-02T00:00:00.000Z',
            },
          ],
        },
      );
      expect(
        Array.from(container.querySelectorAll('[data-worktree-id]')).map(
          (row) => row.getAttribute('data-worktree-id'),
        ),
      ).toEqual(['cloud:newer', 'cloud:older']);
    });

    it('keeps only pinned RC rows draggable in recency mode', () => {
      renderMixed(
        {},
        {
          ...mixedSnapshot,
          workspaces: mixedSnapshot.workspaces.map((workspace) => ({
            ...workspace,
            itemSortMode: 'last-updated',
          })),
          worktrees: [
            ...mixedSnapshot.worktrees,
            {
              localId: 'wt-pinned',
              workspaceLocalId: 'ws-remote',
              branch: 'pinned',
              pinned: true,
            },
          ],
        },
      );
      expect(
        container.querySelector('[data-worktree-sortable-wrapper="wt-remote"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-worktree-sortable-wrapper="wt-pinned"]'),
      ).not.toBeNull();
      expect(
        container.querySelector(
          '[data-worktree-sortable-wrapper="cloud:task:a"]',
        ),
      ).toBeNull();
    });

    it('uses session actions for the repoless cloud row while preserving RC worktree actions', () => {
      renderMixed({ onUpdateWorktree: jest.fn() });

      const openRowMenu = (worktreeLocalId: string): void => {
        const trigger = container
          .querySelector(`[data-worktree-id="${worktreeLocalId}"]`)
          ?.querySelector<HTMLButtonElement>(
            '[data-testid="portal-worktree-actions-menu-button"]',
          );
        expect(trigger).not.toBeNull();
        act(() => trigger?.click());
      };

      // Exactly one menu is ever open, so a portaled menu left over from
      // another row cannot be mistaken for this row's.
      const openMenu = (): Element => {
        const menus = document.querySelectorAll(
          '[data-testid="portal-worktree-actions-menu"]',
        );
        expect(menus).toHaveLength(1);
        return menus[0];
      };

      // Positive control first: the RC row proves the menu opens and carries a
      // removal item, so the cloud assertion cannot pass by opening nothing.
      openRowMenu('wt-remote');
      expect(
        openMenu().querySelector('[data-testid="portal-delete-worktree"]'),
      ).not.toBeNull();
      expect(openMenu().textContent).toContain('Branch from');
      expect(openMenu().textContent).toContain('Branch info');
      act(() => {
        openMenu()
          .querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[0]
          ?.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
          );
      });

      openRowMenu('cloud:task:a');
      expect(
        openMenu().querySelector('[data-testid="portal-delete-worktree"]'),
      ).not.toBeNull();
      expect(openMenu().textContent).toContain('Archive session');
      expect(openMenu().textContent).not.toContain('Branch from');
      expect(openMenu().textContent).not.toContain('Branch info');
      expect(openMenu().getAttribute('aria-label')).toBe(
        'Actions for Planning session',
      );
      act(() => {
        openMenu()
          .querySelector<HTMLButtonElement>(
            '[data-testid="portal-worktree-actions-set-label"]',
          )
          ?.click();
      });
      expect(
        document
          .querySelector('[role="dialog"] input')
          ?.getAttribute('placeholder'),
      ).toBe('Session');
    });

    it('names the direct archive action for an untitled done cloud session', () => {
      renderMixed(
        {},
        {
          ...mixedSnapshot,
          worktrees: mixedSnapshot.worktrees.map((worktree) =>
            worktree.localId === 'cloud:task:a'
              ? { ...worktree, label: undefined, status: 'done' }
              : worktree,
          ),
        },
      );

      const cloudRow = container.querySelector(
        '[data-worktree-id="cloud:task:a"]',
      );
      expect(
        cloudRow
          ?.querySelector('[data-testid="portal-worktree-delete-button"]')
          ?.getAttribute('aria-label'),
      ).toBe('Archive session');
    });

    it('hides the settings affordance on a row whose client has no settings', () => {
      renderMixed({
        onLoadClaudeMd: jest.fn(),
        onLoadScripts: jest.fn(),
      });

      expect(
        container.querySelector('[aria-label="Settings for Desktop"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[aria-label="Settings for Cloud"]'),
      ).toBeNull();
    });

    // Same shape as the worktree confirm: this one awaits `onDeleteWorkspace`
    // optionally and clears itself either way, so an absent handler would read
    // as a completed removal. The host can drop that handler under a mounted
    // rail — `commandsDisabled` flips the policy to `navigation-only` when a
    // paired desktop goes offline, without changing route or tier.
    it('withdraws an open project-removal confirm when the handler goes away', () => {
      const onDeleteWorkspace = jest.fn(() => Promise.resolve());
      renderMixed({ onDeleteWorkspace });

      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[aria-label="Archive project Cloud"]',
          )
          ?.click(),
      );
      expect(
        document.querySelector(
          '[data-testid="portal-remove-workspace-confirm"]',
        ),
      ).not.toBeNull();

      renderMixed({ onDeleteWorkspace: undefined });
      expect(
        document.querySelector(
          '[data-testid="portal-remove-workspace-confirm"]',
        ),
      ).toBeNull();
      expect(onDeleteWorkspace).not.toHaveBeenCalled();
    });

    it('archives a project from the row header and confirms first', async () => {
      const onDeleteWorkspace = jest.fn(() => Promise.resolve());
      renderMixed({ onDeleteWorkspace });

      const archive = container.querySelector<HTMLButtonElement>(
        '[aria-label="Archive project Cloud"]',
      );
      expect(archive).not.toBeNull();
      // The remote-control row keeps deletion in the settings danger tab.
      expect(
        container.querySelector('[aria-label="Archive project Desktop"]'),
      ).toBeNull();
      expect(
        container.querySelector('[aria-label="Delete Desktop"]'),
      ).toBeNull();

      act(() => archive?.click());
      const confirm = document.querySelector<HTMLElement>(
        '[data-testid="portal-remove-workspace-confirm"]',
      );
      expect(confirm).not.toBeNull();
      expect(confirm?.textContent).toContain('Cloud');
      expect(onDeleteWorkspace).not.toHaveBeenCalled();

      act(() =>
        confirm
          ?.querySelector<HTMLButtonElement>(
            '[data-testid="confirm-dialog-confirm"]',
          )
          ?.click(),
      );
      await flush();
      expect(onDeleteWorkspace).toHaveBeenCalledWith('cloud:ws:a');
    });

    // Clearing the dialogs on an owner change is not enough by itself: the
    // command already in flight lands afterwards and writes state back. The
    // host's `key` used to absorb that — the continuation hit an unmounted
    // instance — so dropping the key makes these writes live. A rejection
    // arriving after the owner left and came back must not resurrect a
    // confirmation the new owner never opened.
    it('does not revive a removal confirm from a previous owner', async () => {
      let rejectRemoval: ((reason: Error) => void) | undefined;
      const onDeleteWorkspace = jest.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectRemoval = reject;
          }),
      );
      renderMixed({ onDeleteWorkspace, dataOwnerId: 'live:live' });

      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[aria-label="Archive project Cloud"]',
          )
          ?.click(),
      );
      act(() =>
        document
          .querySelector<HTMLElement>(
            '[data-testid="portal-remove-workspace-confirm"]',
          )
          ?.querySelector<HTMLButtonElement>(
            '[data-testid="confirm-dialog-confirm"]',
          )
          ?.click(),
      );
      expect(onDeleteWorkspace).toHaveBeenCalledWith('cloud:ws:a');

      // Away and back: a paired desktop drops, then returns.
      renderMixed({ onDeleteWorkspace, dataOwnerId: 'live:navigation-only' });
      renderMixed({ onDeleteWorkspace, dataOwnerId: 'live:live' });
      expect(
        document.querySelector(
          '[data-testid="portal-remove-workspace-confirm"]',
        ),
      ).toBeNull();

      rejectRemoval?.(new Error('Could not reach the project'));
      await flush();

      expect(
        document.querySelector(
          '[data-testid="portal-remove-workspace-confirm"]',
        ),
      ).toBeNull();
    });

    it('keeps the removal dialog open and shows why when archiving fails', async () => {
      const onDeleteWorkspace = jest.fn(() =>
        Promise.reject(new Error('Workspace archive rejected')),
      );
      renderMixed({ onDeleteWorkspace });

      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="workspace-section-remove"]',
          )
          ?.click(),
      );
      const confirm = (): Element | null =>
        document.querySelector(
          '[data-testid="portal-remove-workspace-confirm"]',
        );
      act(() =>
        confirm()
          ?.querySelector<HTMLButtonElement>(
            '[data-testid="confirm-dialog-confirm"]',
          )
          ?.click(),
      );
      await flush();

      expect(onDeleteWorkspace).toHaveBeenCalledWith('cloud:ws:a');
      // A rejection must not read as success: the dialog stays up, reports the
      // reason, and leaves the action retryable.
      expect(confirm()).not.toBeNull();
      expect(
        confirm()?.querySelector('[data-testid="confirm-dialog-error"]')
          ?.textContent,
      ).toContain('Workspace archive rejected');
      expect(
        confirm()?.querySelector<HTMLButtonElement>(
          '[data-testid="confirm-dialog-confirm"]',
        )?.disabled,
      ).toBe(false);
    });

    it('keeps every row on the flat capabilities without a resolver', () => {
      // The desktop host path: unchanged all-or-nothing resolution.
      renderMixed({ capabilitiesFor: undefined, onDeleteWorkspace: jest.fn() });

      expect(
        container.querySelector(
          '[data-workspace-sortable-wrapper="cloud:ws:a"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelector(
          '[data-workspace-sortable-wrapper="ws-remote"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelector('[aria-label="Archive project Cloud"]'),
      ).toBeNull();
    });
  });

  // Web chat parity, slice 6 (docs/planning/2026-09-16-web-chat-parity-sidebar).
  // Desktop's legacy AppSidebar is the visual reference; every difference the
  // audit measured is converged here, in the shared surface, so no host has to
  // restyle it locally.
  describe('desktop parity', () => {
    const chatSearch: Partial<SidebarSurfaceProps> = {
      chatSearch: { candidates: [], onSelectResult: () => undefined },
    };

    it('paints the desktop sidebar surface with no highlight overlay', () => {
      render('ready');
      const rootElement = container.querySelector<HTMLElement>(
        '[data-testid="portal-sidebar"]',
      );
      // Desktop paints the rail on `--bg-sidebar`; web painted `bg-base` under a
      // radial highlight that no desktop sidebar has.
      expect(rootElement?.className).toContain('bg-sidebar');
      expect(
        Array.from(container.querySelectorAll<HTMLElement>('div')).some(
          (element) => element.className.includes('radial-gradient'),
        ),
      ).toBe(false);
    });

    it('renders New task in the shared row vocabulary with the 14px edit glyph', () => {
      render('ready', { onCreateTask: () => undefined });
      const createTask = container.querySelector<HTMLButtonElement>(
        '[data-testid="portal-create-task"]',
      );
      // Same row as every other nav row (desktop's `SidebarNavRow`): primary
      // text, not an accent-tinted medium-weight button of its own.
      expect(createTask?.className).toContain(sidebarNavItemClassName(false));
      expect(createTask?.className).not.toContain('fg-accent');
      expect(createTask?.textContent?.trim()).toBe('New task');
      expect(createTask?.getAttribute('aria-current')).toBeNull();
      expect(createTask?.querySelector('svg')?.getAttribute('width')).toBe(
        '14px',
      );
    });

    it('marks New task current while the host shows the New Task view', () => {
      render('ready', {
        onCreateTask: () => undefined,
        createTaskActive: true,
      });
      const createTask = container.querySelector<HTMLButtonElement>(
        '[data-testid="portal-create-task"]',
      );
      expect(createTask?.getAttribute('aria-current')).toBe('page');
      expect(createTask?.className).toContain(sidebarNavItemClassName(true));
    });

    it("sizes nav row icons at desktop's 14px", () => {
      render('ready', {
        navItemActions: { plugins: { href: '/plugins' } },
      });
      expect(
        container
          .querySelector('[data-testid="portal-sidebar-nav-plugins"] svg')
          ?.getAttribute('width'),
      ).toBe('14px');
    });

    it("discloses chat search from a Search nav row under 'nav-row'", () => {
      render('ready', {
        ...chatSearch,
        chatSearchPresentation: 'nav-row',
        headerSlot: <span>Brand</span>,
      });
      const toggle = container.querySelector<HTMLButtonElement>(
        '[data-testid="portal-sidebar-chat-search-toggle"]',
      );
      // A row under New task, like desktop's Search row — not a magnifier in
      // the brand header.
      expect(toggle?.textContent?.trim()).toBe('Search');
      expect(toggle?.className).toContain(sidebarNavItemClassName(false));
      expect(
        toggle?.closest('[data-testid="portal-sidebar-menu-block"]'),
      ).not.toBeNull();
      expect(
        container.querySelector(
          '[data-testid="portal-sidebar-header"] [data-testid="portal-sidebar-chat-search-toggle"]',
        ),
      ).toBeNull();
      expect(
        container.querySelector(
          '[data-testid="portal-sidebar-chat-search-input"]',
        ),
      ).toBeNull();

      act(() => toggle?.click());

      // The SAME disclosure as the header magnifier: input revealed, focused.
      const input = container.querySelector<HTMLInputElement>(
        '[data-testid="portal-sidebar-chat-search-input"]',
      );
      expect(input).not.toBeNull();
      expect(document.activeElement).toBe(input);
      expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    });

    it('hands focus back to the Search row when Escape collapses the input', () => {
      render('ready', {
        ...chatSearch,
        chatSearchPresentation: 'nav-row',
      });
      const toggle = container.querySelector<HTMLButtonElement>(
        '[data-testid="portal-sidebar-chat-search-toggle"]',
      );
      act(() => toggle?.click());
      const input = container.querySelector<HTMLInputElement>(
        '[data-testid="portal-sidebar-chat-search-input"]',
      );
      expect(document.activeElement).toBe(input);
      // Escape on an empty query puts the input away; the focus it held must
      // land on the trigger, not fall to <body>.
      act(() => {
        input?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
      expect(
        container.querySelector(
          '[data-testid="portal-sidebar-chat-search-input"]',
        ),
      ).toBeNull();
      expect(document.activeElement).toBe(toggle);
    });

    it("renders the Projects header in desktop's quiet vocabulary", () => {
      render('ready', {
        workspacesSectionCollapsible: true,
        onOpenCreateWorkspaceOverride: () => true,
      });
      const toggle = container.querySelector<HTMLButtonElement>(
        '[data-testid="portal-workspaces-section-toggle"]',
      );
      // Desktop: 32px, product `text-s`, quaternary at rest; no 43px band with
      // rules above and below and no small bold secondary label.
      expect(toggle?.className).toContain('fg-quaternary');
      expect(toggle?.className).toContain('text-s');
      expect(toggle?.className).not.toContain('font-semibold');
      const band = container.querySelector<HTMLElement>(
        '[data-testid="portal-workspaces-header"]',
      );
      expect(band).not.toBeNull();
      expect(band?.className).not.toContain('border-y');
      expect(band?.className).toContain('h-8');
      // The chevron rests hidden and reveals on hover, as desktop's does.
      expect(
        container
          .querySelector('[data-testid="portal-workspaces-chevron"]')
          ?.getAttribute('class'),
      ).toContain('opacity-0');
      // And the add-project "+" is the shared rail button, revealed on hover.
      const add = container.querySelector<HTMLButtonElement>(
        '[data-testid="portal-add-workspace"]',
      );
      expect(add?.querySelector('svg')).not.toBeNull();
      expect(add?.closest('[class~="opacity-0"]')).not.toBeNull();
    });

    function renderChatsSection(
      props: Partial<SidebarSurfaceProps> = {},
    ): void {
      render('ready', props, {
        ...snapshot,
        workspaces: [
          {
            localId: 'cowork-default',
            name: 'Chats',
            type: 'cowork',
            order: 0,
          },
          ...snapshot.workspaces,
        ],
        standaloneChats: [
          {
            localId: 'chat',
            projectLocalId: 'cowork-default',
            title: 'A chat',
          },
        ],
      });
    }

    it('renders a host band around the Projects header, after the Chats section', (): void => {
      // The legacy section rendered its Projects header inside the rail's
      // sticky band, below Chats; a host that renders that band gets the same
      // shape, so the rail's published seat lines up with where headers stick.
      renderChatsSection({
        scrollOwner: 'host',
        renderProjectsBand: (header) => (
          <div data-testid="host-band">{header}</div>
        ),
      });
      const band = container.querySelector('[data-testid="host-band"]');
      const header = band?.querySelector('[data-sidebar-projects-header]');
      expect(header).not.toBeNull();
      expect(header?.classList.contains('sticky')).toBe(false);
      const chats = container.querySelector(
        '[data-testid="portal-chats-section"]',
      );
      expect(chats).not.toBeNull();
      expect(
        band && chats
          ? chats.compareDocumentPosition(band) &
              Node.DOCUMENT_POSITION_FOLLOWING
          : 0,
      ).toBeTruthy();
      expect(container.querySelector('div.h-3[aria-hidden="true"]')).toBeNull();
    });

    it('hides Personal standalone chats in an organization context', (): void => {
      renderChatsSection({
        context: { kind: 'organization', organizationId: 'acme' },
      });
      expect(
        container.querySelector('[data-testid="portal-chats-section"]'),
      ).toBeNull();
      expect(container.textContent).not.toContain('A chat');
    });

    it("shows this organization's Chats section, not Personal's or another organization's", (): void => {
      const orgA = '11111111-1111-4111-8111-111111111111';
      const orgB = '22222222-2222-4222-8222-222222222222';
      const orgSnapshot: SidebarSurfaceSnapshot = {
        ...snapshot,
        workspaces: [
          {
            localId: 'cowork-default',
            name: 'Chats',
            type: 'cowork',
            order: 0,
          },
          ...[orgA, orgB].map((organizationId, index) => ({
            localId: `cowork-org-${organizationId}`,
            name: 'Chats',
            type: 'cowork' as const,
            order: index + 1,
            owner: {
              type: 'organization' as const,
              organizationId,
              projectId: `chats-${organizationId}`,
            },
          })),
          ...snapshot.workspaces,
        ],
        standaloneChats: [
          {
            localId: 'personal-chat',
            projectLocalId: 'cowork-default',
            title: 'Personal chat',
          },
          {
            localId: 'org-a-chat',
            projectLocalId: `cowork-org-${orgA}`,
            title: 'Org A chat',
          },
          {
            localId: 'org-b-chat',
            projectLocalId: `cowork-org-${orgB}`,
            title: 'Org B chat',
          },
        ],
      };

      render(
        'ready',
        {
          context: { kind: 'organization', organizationId: orgA },
          // The org's Chats does not make Projects non-empty: the host still
          // gets the empty Projects list, told that Chats is listed, so it can
          // point at projects to add without claiming the org is empty.
          renderContextEmptyState: ({ chatsListed }) =>
            chatsListed ? (
              <div data-testid="organization-empty-projects" />
            ) : (
              <div data-testid="organization-empty-state" />
            ),
        },
        orgSnapshot,
      );
      const chats = container.querySelector(
        '[data-testid="portal-chats-section"]',
      );
      expect(chats?.textContent).toContain('Org A chat');
      expect(container.textContent).not.toContain('Personal chat');
      expect(container.textContent).not.toContain('Org B chat');
      expect(
        container.querySelector('[data-testid="organization-empty-state"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="organization-empty-projects"]'),
      ).not.toBeNull();
      // The org's catch-all is the hoisted section, not a project row.
      expect(
        container.querySelector(
          `[data-testid="portal-workspace-cowork-org-${orgA}"]`,
        ),
      ).toBeNull();

      render(
        'ready',
        { context: { kind: 'organization', organizationId: orgB } },
        orgSnapshot,
      );
      expect(
        container.querySelector('[data-testid="portal-chats-section"]')
          ?.textContent,
      ).toContain('Org B chat');
      expect(container.textContent).not.toContain('Org A chat');

      render('ready', { context: { kind: 'personal' } }, orgSnapshot);
      expect(
        container.querySelector('[data-testid="portal-chats-section"]')
          ?.textContent,
      ).toContain('Personal chat');
      expect(container.textContent).not.toContain('Org A chat');
    });

    it('reads an empty organization Chats and Projects the same (CAN-3550)', (): void => {
      const organizationId = '11111111-1111-4111-8111-111111111111';
      const emptyOrgSnapshot: SidebarSurfaceSnapshot = {
        ...snapshot,
        workspaces: [
          {
            localId: 'cowork-default',
            name: 'Chats',
            type: 'cowork',
            order: 0,
          },
          {
            localId: `cowork-org-${organizationId}`,
            name: 'Chats',
            type: 'cowork',
            order: 1,
            owner: {
              type: 'organization',
              organizationId,
              projectId: `chats-${organizationId}`,
            },
          },
          ...snapshot.workspaces,
        ],
        standaloneChats: [],
      };
      const hostProps: Partial<SidebarSurfaceProps> = {
        onCreateChatsSectionChat: () => undefined,
        onOpenCreateWorkspaceOverride: () => true,
        renderContextEmptyState: () => (
          <div data-testid="organization-empty-projects" />
        ),
      };
      const addProject = (): HTMLElement | null =>
        container.querySelector('[data-testid="portal-add-workspace"]');

      render(
        'ready',
        { ...hostProps, context: { kind: 'organization', organizationId } },
        emptyOrgSnapshot,
      );
      // Chats lists the row an empty Projects list does.
      expect(
        container.querySelector('[data-testid="portal-chats-section-empty"]')
          ?.textContent,
      ).toBe('None found');
      expect(
        container.querySelector(
          '[data-testid="portal-chats-section-empty-label"]',
        )?.textContent,
      ).toBe('None found');
      expect(
        container.querySelector('[data-testid="organization-empty-projects"]'),
      ).not.toBeNull();
      // Both headers keep their "+" on screen: nothing else adds to an
      // empty section.
      expect(addProject()).not.toBeNull();
      expect(addProject()?.closest('[class~="opacity-0"]')).toBeNull();
      expect(
        container
          .querySelector('[data-testid="portal-chats-section-new-chat"]')
          ?.closest('[class~="opacity-0"]'),
      ).toBeNull();

      // Personal is unchanged: no row under its empty Chats, and the
      // Projects "+" waits for a hover over a listed project.
      render(
        'ready',
        { ...hostProps, context: { kind: 'personal' } },
        emptyOrgSnapshot,
      );
      expect(
        container.querySelector('[data-testid="portal-chats-section"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="portal-chats-section-empty"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="organization-empty-projects"]'),
      ).toBeNull();
      expect(addProject()?.closest('[class~="opacity-0"]')).not.toBeNull();
    });

    it('preserves standalone chats in Personal context', (): void => {
      renderChatsSection({ context: { kind: 'personal' } });
      expect(
        container.querySelector('[data-testid="portal-chats-section"]')
          ?.textContent,
      ).toContain('A chat');
    });

    it('hoists the default chats workspace above Projects as the Chats section', () => {
      render(
        'ready',
        {},
        {
          ...snapshot,
          workspaces: [
            {
              localId: 'cowork-default',
              name: 'Chats',
              type: 'cowork',
              order: 0,
            },
            ...snapshot.workspaces,
          ],
          standaloneChats: [
            {
              localId: 'chat',
              projectLocalId: 'cowork-default',
              title: 'A chat',
            },
          ],
        },
      );
      const chatsSection = container.querySelector<HTMLElement>(
        '[data-testid="portal-chats-section"]',
      );
      const projectsHeader = container.querySelector<HTMLElement>(
        '[data-testid="portal-workspaces-header"]',
      );
      expect(chatsSection).not.toBeNull();
      expect(projectsHeader).not.toBeNull();
      // Desktop: Chats sits ABOVE the Projects header, not inside the list.
      expect(
        chatsSection && projectsHeader
          ? chatsSection.compareDocumentPosition(projectsHeader) &
              Node.DOCUMENT_POSITION_FOLLOWING
          : 0,
      ).toBeTruthy();
      expect(
        container.querySelector(
          '[data-testid="portal-workspace-list"] [data-workspace-id="cowork-default"]',
        ),
      ).toBeNull();
      expect(chatsSection?.textContent).toContain('A chat');
      // The section header is desktop's text-only header, not a folder row.
      const header = chatsSection?.querySelector<HTMLElement>(
        '[data-testid="portal-chats-section-toggle"]',
      );
      expect(header?.className).toContain('fg-quaternary');
      expect(header?.textContent?.trim()).toBe('Chats');
      // No settings control: this render supplies neither the host override
      // nor the dialog's loaders, so the action cannot run and the header
      // must not offer it. A control bound to a no-op is the phantom chrome
      // this campaign already removed once from the desktop host.
      expect(
        chatsSection?.querySelector(
          '[data-testid="portal-chats-section-settings"]',
        ),
      ).toBeNull();
    });

    it('offers Chats settings once the host can actually open them', () => {
      const onOpenWorkspaceSettingsOverride = jest.fn(() => true);
      renderChatsSection({ onOpenWorkspaceSettingsOverride });
      const settings = container.querySelector<HTMLButtonElement>(
        '[data-testid="portal-chats-section-settings"]',
      );
      expect(settings).not.toBeNull();
      act(() => settings?.click());
      expect(onOpenWorkspaceSettingsOverride).toHaveBeenCalledWith(
        'cowork-default',
        undefined,
      );
    });

    it('keeps the shared Chats header while the host supplies its own rows', () => {
      // Desktop's Chats bucket holds multi-chat Work Entries, the portal's
      // holds flat chats. The seam is the ROWS only: one header, one sticky
      // block, one set of marks — because the header is where the platforms
      // visibly drifted apart, not the row contents.
      renderChatsSection({
        renderChatsSectionRows: () => (
          <div data-testid="host-rows">Host row</div>
        ),
        onOpenWorkspaceSettingsOverride: jest.fn(() => true),
      });
      const chatsSection = container.querySelector<HTMLElement>(
        '[data-testid="portal-chats-section"]',
      );
      expect(chatsSection).not.toBeNull();
      // The shared header, its label and its settings control all survive.
      expect(
        chatsSection
          ?.querySelector('[data-testid="portal-chats-section-toggle"]')
          ?.textContent?.trim(),
      ).toBe('Chats');
      expect(
        chatsSection?.querySelector(
          '[data-testid="portal-chats-section-settings"]',
        ),
      ).not.toBeNull();
      // The host's rows replace the portal's, INSIDE the occludable block the
      // rail's sticky sync measures — so desktop's rows are measured exactly
      // as the shared ones are.
      const mask = chatsSection?.querySelector<HTMLElement>(
        '[data-sidebar-chats-mask]',
      );
      expect(mask?.querySelector('[data-testid="host-rows"]')).not.toBeNull();
      expect(chatsSection?.textContent).not.toContain('A chat');
      // The wrapper stops claiming to be a list once it only holds the host's
      // rows, which carry their own semantics.
      expect(mask?.getAttribute('role')).toBe('presentation');
    });

    it('keeps the selected chat under a collapsed Chats header, as the portal renders it', () => {
      // Collapsed projects keep their selected row; the Chats section used to
      // drop every row, so the open chat vanished from the rail.
      renderChatsSection({
        chatsSectionCollapsed: true,
        selection: { kind: 'standalone-chat', standaloneChatId: 'chat' },
      });
      const chatsSection = container.querySelector<HTMLElement>(
        '[data-testid="portal-chats-section"]',
      );
      expect(
        chatsSection
          ?.querySelector('[data-testid="portal-chats-section-toggle"]')
          ?.getAttribute('aria-expanded'),
      ).toBe('false');
      const mask = chatsSection?.querySelector<HTMLElement>(
        '[data-sidebar-chats-mask]',
      );
      expect(mask?.textContent).toContain('A chat');

      // Nothing in Chats selected: the collapse hides every row.
      renderChatsSection({ chatsSectionCollapsed: true });
      expect(container.querySelector('[data-sidebar-chats-mask]')).toBeNull();
    });

    it('asks host Chats rows for their collapsed form while they hold the selection', () => {
      renderChatsSection({
        chatsSectionCollapsed: true,
        chatsSectionHasSelectedRow: true,
        renderChatsSectionRows: ({ collapsed }) => (
          <div data-testid="host-rows" data-collapsed={String(collapsed)} />
        ),
      });
      expect(
        container
          .querySelector('[data-sidebar-chats-mask] [data-testid="host-rows"]')
          ?.getAttribute('data-collapsed'),
      ).toBe('true');
    });

    it('stacks the Chats and Projects headers when no rail seats them', () => {
      // Desktop keeps BOTH pinned, one under the other. Sharing `top-0` makes
      // them trade a single seat instead, so scrolling past Chats replaced it
      // with Projects and the Chats title disappeared.
      renderChatsSection();
      const header = container.querySelector<HTMLElement>(
        '[data-sidebar-chats-header]',
      );
      const projects = container.querySelector<HTMLElement>(
        '[data-testid="portal-workspaces-header"]',
      );
      expect(header?.className).toContain('sticky');
      expect(header?.className).toContain('top-0');
      // Projects is seated one header-height down, not at the same edge.
      expect(projects?.className).toContain('sticky');
      expect(projects?.className).toContain('top-8');
      expect(projects?.className).not.toContain('top-0');
    });

    it('leaves no box between the Chats header and the scroll content', () => {
      // A sticky element cannot leave its containing block. Any wrapper with a
      // box between this header and the scroller ends where the section ends,
      // so the header scrolls away exactly when Projects — seated one
      // header-height down — is still pinned, opening a hole with rows
      // showing through it.
      renderChatsSection();
      const header = container.querySelector<HTMLElement>(
        '[data-sidebar-chats-header]',
      );
      const scroller = container.querySelector<HTMLElement>(
        '[data-testid="portal-workspaces-header"]',
      )?.parentElement;
      expect(header).not.toBeNull();
      expect(scroller).not.toBeNull();
      for (
        let node = header?.parentElement ?? null;
        node !== null && node !== scroller;
        node = node.parentElement
      ) {
        expect(node.className).toContain('contents');
      }
    });

    it('caps the Chats list and reveals the rest behind Show all', () => {
      // Chats sits ABOVE the project list, so an uncapped list pushes every
      // project below the fold. Desktop caps at five; the portal listed all of
      // them.
      render(
        'ready',
        {},
        {
          ...snapshot,
          workspaces: [
            {
              localId: 'cowork-default',
              name: 'Chats',
              type: 'cowork',
              order: 0,
            },
            ...snapshot.workspaces,
          ],
          standaloneChats: Array.from({ length: 8 }, (_unused, index) => ({
            localId: `chat-${index}`,
            projectLocalId: 'cowork-default',
            title: `Chat ${index}`,
          })),
        },
      );
      const section = container.querySelector<HTMLElement>(
        '[data-testid="portal-chats-section"]',
      );
      expect(section?.textContent).toContain('Chat 4');
      expect(section?.textContent).not.toContain('Chat 5');
      const showAll = section?.querySelector<HTMLButtonElement>(
        '[data-testid="portal-chats-section-show-all"]',
      );
      expect(showAll).not.toBeNull();
      expect(showAll?.getAttribute('aria-label')).toBe('Show all 8 chats');
      act(() => showAll?.click());
      expect(
        container.querySelector<HTMLElement>(
          '[data-testid="portal-chats-section"]',
        )?.textContent,
      ).toContain('Chat 7');
    });

    it('carries a Projects stand-in only when it owns the scrolling', () => {
      // An expanded chat list pushes the Projects header hundreds of rows
      // down, and sticky cannot lift a header above its own place in the flow
      // — hence a stand-in at the foot of the rail. A host rail renders its
      // own, so this must not add a second.
      renderChatsSection();
      const pin = container.querySelector<HTMLButtonElement>(
        '[data-testid="portal-projects-pin-bottom"]',
      );
      expect(pin).not.toBeNull();
      // Starts hidden; the sync reveals it once the real header leaves view.
      expect(pin?.hidden).toBe(true);
      expect(pin?.getAttribute('aria-label')).toBe('Back to Projects');

      renderChatsSection({ scrollOwner: 'host' });
      expect(
        container.querySelector('[data-testid="portal-projects-pin-bottom"]'),
      ).toBeNull();
    });

    it('offers a Chats "+" only for a host that supplies chat creation', () => {
      const onCreateChatsSectionChat = jest.fn();
      renderChatsSection({ onCreateChatsSectionChat });
      const add = container.querySelector<HTMLButtonElement>(
        '[data-testid="portal-chats-section-new-chat"]',
      );
      expect(add).not.toBeNull();
      act(() => add?.click());
      expect(onCreateChatsSectionChat).toHaveBeenCalled();
    });

    it('never falls back to worktree creation for the Chats "+"', () => {
      // The Chats workspace is cowork, and a worktree create is rejected there
      // by the desktop adapter and by the portal's relay of it. An earlier
      // fallback to `onCreateWorktree` threw "Cannot create a worktree in a
      // cowork project." the first time the portal's "+" was clicked.
      const onCreateWorktree = jest.fn().mockResolvedValue({ status: 'ok' });
      renderChatsSection({ onCreateWorktree });
      expect(
        container.querySelector(
          '[data-testid="portal-chats-section-new-chat"]',
        ),
      ).toBeNull();
      expect(onCreateWorktree).not.toHaveBeenCalled();
    });

    it('marks its chat rows and scroll viewport for the shared geometry helpers', () => {
      // The Chats header's "back to the rows" click walks up to the viewport
      // and looks for rendered rows. Both lookups used desktop-only test ids,
      // so on the portal the walk found nothing and the click silently fell
      // through to a plain collapse.
      renderChatsSection();
      const section = container.querySelector<HTMLElement>(
        '[data-testid="portal-chats-section"]',
      );
      expect(section?.querySelector('[data-sidebar-chat-row]')).not.toBeNull();
      expect(container.querySelector('[data-sidebar-viewport]')).not.toBeNull();
    });

    it('seats Projects at the top edge when there is no Chats section', () => {
      render('ready', {}, snapshot);
      expect(
        container.querySelector<HTMLElement>(
          '[data-testid="portal-workspaces-header"]',
        )?.className,
      ).toContain('top-0');
    });

    it('gives the Projects header the Chats header trailing inset in a host rail', () => {
      // Classic scrollbars widen the Chats header's trailing inset. A Projects
      // header left on the plain px-1 put its "+" 3px to the right of the
      // Chats "+", and under the rail.
      renderChatsSection({
        scrollOwner: 'host',
        onCreateWorkspace: () => undefined,
        onCreateChatsSectionChat: () => undefined,
      });
      const inlineStyle = (selector: string): string =>
        container.querySelector<HTMLElement>(selector)?.getAttribute('style') ??
        '';
      const trailingInset = `padding-right: ${RAIL_SECTION_HEADER_PADDING_RIGHT}`;
      expect(inlineStyle('[data-sidebar-chats-header]')).toContain(
        trailingInset,
      );
      expect(inlineStyle('[data-sidebar-projects-header]')).toContain(
        trailingInset,
      );

      // A surface that scrolls itself has no host rail to clear.
      renderChatsSection({ onCreateWorkspace: () => undefined });
      expect(inlineStyle('[data-sidebar-projects-header]')).not.toContain(
        'padding-right',
      );
    });

    it('pins the Chats header for a host that owns the rail', () => {
      renderChatsSection({ scrollOwner: 'host' });
      const header = container.querySelector<HTMLElement>(
        '[data-sidebar-chats-header]',
      );
      expect(header?.className).toContain('sticky');
      expect(header?.style.top).toBe('1px');
    });

    it('keeps an empty Chats header whenever its "+" can start a chat', () => {
      // Desktop and portal alike (CAN-3537): the header carries the way to a
      // first chat, so a host that can create one keeps it while empty.
      render(
        'ready',
        { onCreateChatsSectionChat: () => undefined },
        {
          ...snapshot,
          workspaces: [
            {
              localId: 'cowork-default',
              name: 'Chats',
              type: 'cowork',
              order: 0,
            },
            ...snapshot.workspaces,
          ],
          standaloneChats: [],
        },
      );
      expect(
        container.querySelector('[data-testid="portal-chats-section"]'),
      ).not.toBeNull();
    });

    const emptyChatsSnapshot = (): SidebarSurfaceSnapshot => ({
      ...snapshot,
      workspaces: [
        { localId: 'cowork-default', name: 'Chats', type: 'cowork', order: 0 },
        ...snapshot.workspaces,
      ],
      standaloneChats: [],
    });

    it('lists a host line under an empty Chats header when the host names one', () => {
      render(
        'ready',
        {
          onCreateChatsSectionChat: () => undefined,
          chatsSectionEmptyLabel: 'Your chats show up here',
        },
        emptyChatsSnapshot(),
      );
      expect(
        container.querySelector('[data-testid="portal-chats-section-empty"]')
          ?.textContent,
      ).toBe('Your chats show up here');
      // The "+" stays on screen at rest: it is the only way to a first chat.
      // Listing the row must not flip the section's hover-reveal.
      const plus = container.querySelector(
        '[data-testid="portal-chats-section-new-chat"]',
      );
      expect(plus).not.toBeNull();
      expect(plus?.closest('[class~="opacity-0"]')).toBeNull();
    });

    it('lists no row for a Personal context without a label', () => {
      render(
        'ready',
        { onCreateChatsSectionChat: () => undefined },
        emptyChatsSnapshot(),
      );
      expect(
        container.querySelector('[data-testid="portal-chats-section"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="portal-chats-section-empty"]'),
      ).toBeNull();
    });

    it('does not resurrect a header for a label alone', () => {
      // No "+", no host rows, no chats: still no headline for nothing.
      render(
        'ready',
        { chatsSectionEmptyLabel: 'Your chats show up here' },
        emptyChatsSnapshot(),
      );
      expect(
        container.querySelector('[data-testid="portal-chats-section"]'),
      ).toBeNull();
    });

    it('prefers the host line over None found in an organization context', () => {
      // An organization lists its own Chats workspace, as the CAN-3550 test
      // above sets up.
      const organizationId = '11111111-1111-4111-8111-111111111111';
      const base = emptyChatsSnapshot();
      render(
        'ready',
        {
          context: { kind: 'organization', organizationId },
          onCreateChatsSectionChat: () => undefined,
          chatsSectionEmptyLabel: 'Your chats show up here',
        },
        {
          ...base,
          workspaces: [
            {
              localId: `cowork-org-${organizationId}`,
              name: 'Chats',
              type: 'cowork',
              order: 1,
              owner: {
                type: 'organization',
                organizationId,
                projectId: `chats-${organizationId}`,
              },
            },
            ...base.workspaces,
          ],
        },
      );
      expect(
        container.querySelector('[data-testid="portal-chats-section-empty"]')
          ?.textContent,
      ).toBe('Your chats show up here');
      expect(container.textContent).not.toContain('None found');
    });

    it('drops the host line once the section has a chat', () => {
      renderChatsSection({
        onCreateChatsSectionChat: () => undefined,
        chatsSectionEmptyLabel: 'Your chats show up here',
      });
      expect(
        container.querySelector('[data-testid="portal-chats-section-empty"]'),
      ).toBeNull();
      expect(container.textContent).toContain('A chat');
    });

    it('keeps the Chats header visible while the host has no rows yet', () => {
      // The portal hides an empty Chats section, but desktop's header carries
      // the only entry point to a first chat. Supplying the rows hands the
      // emptiness rule to the host along with them.
      render(
        'ready',
        {
          renderChatsSectionRows: () => null,
        },
        {
          ...snapshot,
          workspaces: [
            {
              localId: 'cowork-default',
              name: 'Chats',
              type: 'cowork',
              order: 0,
            },
            ...snapshot.workspaces,
          ],
          standaloneChats: [],
        },
      );
      expect(
        container.querySelector('[data-testid="portal-chats-section"]'),
      ).not.toBeNull();
    });

    it('keeps a user project that merely shares the catch-all name in the list', () => {
      render(
        'ready',
        {},
        {
          ...snapshot,
          workspaces: [
            { localId: 'mine', name: 'Chats', type: 'cowork', order: 0 },
            ...snapshot.workspaces,
          ],
          standaloneChats: [
            { localId: 'chat', projectLocalId: 'mine', title: 'A chat' },
          ],
        },
      );
      // Names are user-editable and non-unique: only the catch-all's stable
      // id elects the hoisted section, so this project keeps its folder row.
      expect(
        container.querySelector('[data-testid="portal-chats-section"]'),
      ).toBeNull();
      expect(
        container.querySelector(
          '[data-testid="portal-workspace-list"] [data-workspace-id="mine"]',
        ),
      ).not.toBeNull();
    });

    it('counts unparented chats for the catch-all only when it is the primary flat workspace', () => {
      render(
        'ready',
        {},
        {
          ...snapshot,
          workspaces: [
            { localId: 'mine', name: 'Personal', type: 'cowork', order: 0 },
            {
              localId: 'cowork-default',
              name: 'Chats',
              type: 'cowork',
              order: 1,
            },
            ...snapshot.workspaces,
          ],
          // Unparented: the section lists it under the PRIMARY flat workspace
          // (`mine`, first by order), so the catch-all is empty and hides.
          standaloneChats: [{ localId: 'orphan', title: 'Orphan chat' }],
        },
      );
      expect(
        container.querySelector('[data-testid="portal-chats-section"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="portal-cowork-workspace-mine"]')
          ?.textContent,
      ).toContain('Orphan chat');
    });

    it('renders no Chats headline when the default chats workspace is empty', () => {
      render(
        'ready',
        {},
        {
          ...snapshot,
          workspaces: [
            {
              localId: 'cowork-default',
              name: 'Chats',
              type: 'cowork',
              order: 0,
            },
            ...snapshot.workspaces,
          ],
          standaloneChats: [],
        },
      );
      // No headline for nothing (Daniil, 2026-09-16): neither a hoisted
      // section nor a folder row inside the list.
      expect(
        container.querySelector('[data-testid="portal-chats-section"]'),
      ).toBeNull();
      expect(container.querySelector('[data-workspace-id="chats"]')).toBeNull();
      expect(container.textContent).not.toContain('Chats');
    });

    it('keeps the sticky Projects header beneath the search results overlay', () => {
      render('ready', {
        workspacesSectionCollapsible: true,
        chatSearch: { candidates: [], onSelectResult: () => undefined },
      });
      const header = container.querySelector<HTMLElement>(
        '[data-testid="portal-workspaces-header"]',
      );
      // The header is `sticky z-10` INSIDE the scroll region and the results
      // overlay is an `absolute z-10` sibling above it; the region must open
      // its own stacking context or the header paints over the first results.
      expect(header?.className).toContain('sticky');
      expect(header?.parentElement?.className).toContain('isolate');
    });

    it('raises the Projects and Chats headers to touch size in the drawer', () => {
      render(
        'ready',
        {
          variant: 'drawer',
          workspacesSectionCollapsible: true,
          onOpenCreateWorkspaceOverride: () => true,
        },
        {
          ...snapshot,
          workspaces: [
            {
              localId: 'cowork-default',
              name: 'Chats',
              type: 'cowork',
              order: 0,
            },
            ...snapshot.workspaces,
          ],
          standaloneChats: [
            {
              localId: 'chat',
              projectLocalId: 'cowork-default',
              title: 'A chat',
            },
          ],
        },
      );
      expect(
        container.querySelector(
          '[data-testid="portal-workspaces-section-toggle"]',
        )?.className,
      ).toContain('min-h-11');
      expect(
        container.querySelector('[data-testid="portal-add-workspace"]')
          ?.className,
      ).toContain('pointer-coarse:min-h-11');
      expect(
        container.querySelector('[data-testid="portal-chats-section-toggle"]')
          ?.className,
      ).toContain('min-h-11');
    });

    it("frames the footer like desktop's account footer", () => {
      render('ready', { footer: <span data-testid="host-footer">Me</span> });
      const footer = container
        .querySelector('[data-testid="host-footer"]')
        ?.closest<HTMLElement>('[data-testid="portal-sidebar-footer"]');
      expect(footer?.className).toContain('px-2 ');
      expect(footer?.className).not.toContain('px-2.5');
      expect(footer?.className).toContain('border-t');
    });
  });
  // CAN-3053 regression: the shared rail drew only the kind badge, so every
  // GitHub-backed project lost the owner avatar desktop's `ProjectIcon` used
  // to overlay. The avatar rides on the snapshot's workspace row, and every
  // header copy — in flow, the drag handle, the pinned stand-ins — draws it.
  describe('project avatars', () => {
    const avatarUrl = 'https://github.com/unstoppabledomains.png?size=32';
    const avatarSnapshot: SidebarSurfaceSnapshot = {
      workspaces: [
        {
          localId: 'canopy',
          name: 'canopy',
          type: 'single-repo',
          avatarUrl,
        },
        {
          localId: 'suite',
          name: 'Suite',
          type: 'multi-repo',
          avatarUrl: 'https://github.com/acme.png?size=32',
        },
      ],
      worktrees: [
        { localId: 'wt-canopy', workspaceLocalId: 'canopy', branch: 'main' },
        { localId: 'wt-suite', workspaceLocalId: 'suite', branch: 'main' },
      ],
      standaloneChats: [],
    };
    const avatarIn = (workspaceLocalId: string): HTMLImageElement | null =>
      container
        .querySelector(`[data-workspace-id="${workspaceLocalId}"]`)
        ?.querySelector<HTMLImageElement>(
          '[data-testid="workspace-owner-avatar"]',
        ) ?? null;

    it('draws the owner avatar on a read-only project header', () => {
      render('ready', { selection: null }, avatarSnapshot);

      expect(avatarIn('canopy')?.getAttribute('src')).toBe(avatarUrl);
      expect(avatarIn('suite')).toBeNull();
    });

    it('draws the owner avatar inside the sortable drag handle', () => {
      render(
        'ready',
        {
          selection: null,
          capabilities: {
            ...capabilities,
            workspaceReordering: true,
            worktreeReordering: true,
          },
          onReorderWorkspaces: jest.fn(),
          onReorderWorktrees: jest.fn(),
          workspaceNameTogglesCollapse: true,
        },
        avatarSnapshot,
      );

      expect(
        container.querySelector('[aria-label="Reorder canopy"]'),
      ).not.toBeNull();
      expect(avatarIn('canopy')?.getAttribute('src')).toBe(avatarUrl);
      expect(avatarIn('suite')).toBeNull();
    });
  });
  describe('emptyProjectsSlot', () => {
    const slot = <div data-testid="empty-projects-slot">Slot</div>;
    const slotSelector = '[data-testid="empty-projects-slot"]';
    const chatsWorkspace = {
      localId: 'cowork-default',
      name: 'Chats',
      type: 'cowork' as const,
      order: 0,
    };

    function chatsSnapshot(chatCount: number): SidebarSurfaceSnapshot {
      return {
        ...snapshot,
        workspaces: [chatsWorkspace],
        worktrees: [],
        standaloneChats: Array.from({ length: chatCount }, (_, index) => ({
          localId: `chat-${index}`,
          projectLocalId: 'cowork-default',
          title: `Chat ${index}`,
        })),
      };
    }

    it('renders once under Projects, below a populated Chats section', (): void => {
      render('ready', { emptyProjectsSlot: slot }, chatsSnapshot(2));
      const chats = container.querySelector(
        '[data-testid="portal-chats-section"]',
      );
      expect(chats?.textContent).toContain('Chat 0');
      expect(container.querySelectorAll(slotSelector)).toHaveLength(1);
      const mounted = container.querySelector(slotSelector);
      if (chats === null || mounted === null) throw new Error('not rendered');
      expect(chats.contains(mounted)).toBe(false);
      expect(
        chats.compareDocumentPosition(mounted) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it('renders with zero chats without an empty Chats header', (): void => {
      render('ready', { emptyProjectsSlot: slot }, chatsSnapshot(0));
      expect(container.querySelectorAll(slotSelector)).toHaveLength(1);
      expect(
        container.querySelector('[data-testid="portal-chats-section"]'),
      ).toBeNull();
    });

    it('orders flat guest rows by activity, then keeps equal-time input order', (): void => {
      const state = chatsSnapshot(3);
      render(
        'ready',
        { emptyProjectsSlot: slot },
        {
          ...state,
          workspaces: [
            { ...chatsWorkspace, layout: 'flat', itemSortMode: 'last-updated' },
          ],
          standaloneChats: state.standaloneChats.map((chat, index) => ({
            ...chat,
            createdAt:
              index === 0 ? '2026-01-01T00:00:00Z' : '2026-02-01T00:00:00Z',
            ...(index === 0 ? { lastMessageAt: '2026-03-01T00:00:00Z' } : {}),
          })),
        },
      );
      const ids = Array.from(
        container.querySelectorAll(
          '[data-testid="portal-chats-section"] [data-standalone-chat-id]',
        ),
      ).map((row) => row.getAttribute('data-standalone-chat-id'));
      expect(ids).toEqual(['chat-0', 'chat-1', 'chat-2']);
    });

    it('renders nothing extra when omitted', (): void => {
      render('ready', {}, chatsSnapshot(2));
      const withoutSlot = container.innerHTML;
      render('ready', { emptyProjectsSlot: undefined }, chatsSnapshot(2));
      expect(container.innerHTML).toBe(withoutSlot);
      expect(container.querySelector(slotSelector)).toBeNull();
    });

    it('stays out of a non-empty Projects list', (): void => {
      render(
        'ready',
        { emptyProjectsSlot: slot },
        {
          ...chatsSnapshot(1),
          workspaces: [chatsWorkspace, ...snapshot.workspaces],
          worktrees: snapshot.worktrees,
        },
      );
      expect(container.querySelector(slotSelector)).toBeNull();
    });

    it('stays out of an organization context', (): void => {
      const organizationId = '11111111-1111-4111-8111-111111111111';
      render(
        'ready',
        {
          emptyProjectsSlot: slot,
          context: { kind: 'organization', organizationId },
        },
        {
          ...snapshot,
          workspaces: [
            {
              localId: `cowork-org-${organizationId}`,
              name: 'Chats',
              type: 'cowork' as const,
              order: 0,
              owner: {
                type: 'organization' as const,
                organizationId,
                projectId: 'chats',
              },
            },
          ],
          worktrees: [],
          standaloneChats: [
            {
              localId: 'org-chat',
              projectLocalId: `cowork-org-${organizationId}`,
              title: 'Org chat',
            },
          ],
        },
      );
      expect(container.querySelector(slotSelector)).toBeNull();
    });

    it('leaves the ordinary empty and loading states alone', (): void => {
      render('empty', { emptyProjectsSlot: slot }, chatsSnapshot(0));
      expect(container.querySelector(slotSelector)).toBeNull();
      expect(
        container.querySelector('[data-testid="portal-sidebar-empty"]'),
      ).not.toBeNull();
      render('loading', { emptyProjectsSlot: slot }, chatsSnapshot(0));
      expect(container.querySelector(slotSelector)).toBeNull();
      expect(
        container.querySelector('[data-testid="portal-sidebar-hydrating"]'),
      ).not.toBeNull();
    });
  });

  describe('Projects "+" while the list is empty (CAN-3973)', () => {
    const create: Partial<SidebarSurfaceProps> = {
      onOpenCreateWorkspaceOverride: () => true,
    };
    const chatsOnly: SidebarSurfaceSnapshot = {
      ...snapshot,
      workspaces: [
        { localId: 'cowork-default', name: 'Chats', type: 'cowork', order: 0 },
      ],
      worktrees: [],
    };
    const noWorkspaces: SidebarSurfaceSnapshot = {
      ...snapshot,
      workspaces: [],
      worktrees: [],
    };
    const withProject: SidebarSurfaceSnapshot = {
      ...snapshot,
      workspaces: [...chatsOnly.workspaces, ...snapshot.workspaces],
    };

    function expectAddProject(atRest: boolean): void {
      const add = container.querySelector(
        '[data-testid="portal-add-workspace"]',
      );
      expect(add).not.toBeNull();
      if (atRest) {
        expect(add?.closest('[class~="opacity-0"]')).toBeNull();
      } else {
        expect(add?.closest('[class~="opacity-0"]')).not.toBeNull();
      }
    }

    it('stays on screen in Personal when only the Chats catch-all is listed', (): void => {
      render('ready', { ...create, context: { kind: 'personal' } }, chatsOnly);
      expectAddProject(true);
    });

    it('keeps the empty Projects create control after collapsing its body', (): void => {
      render(
        'ready',
        { ...create, workspacesSectionCollapsible: true },
        chatsOnly,
      );
      const toggle = container.querySelector<HTMLButtonElement>(
        '[data-testid="portal-workspaces-section-toggle"]',
      );
      if (!toggle) throw new Error('Missing Projects disclosure');
      expectAddProject(true);
      act(() => toggle.click());
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expectAddProject(true);
      act(() => toggle.click());
      expectAddProject(true);
    });

    it('preserves known empty Projects across a host collapse and refreshes on expansion', (): void => {
      const collapsible = { ...create, workspacesSectionCollapsible: true };
      render('ready', collapsible, chatsOnly);
      render(
        'ready',
        { ...collapsible, workspacesSectionInitiallyCollapsed: true },
        chatsOnly,
      );
      expectAddProject(true);
      render(
        'ready',
        { ...collapsible, workspacesSectionInitiallyCollapsed: false },
        withProject,
      );
      expectAddProject(false);
    });

    it('shows creation for an initially collapsed empty partition and updates while collapsed', (): void => {
      const collapsed = {
        ...create,
        workspacesSectionCollapsible: true,
        workspacesSectionInitiallyCollapsed: true,
      };
      render('ready', collapsed, chatsOnly);
      expectAddProject(true);
      render('ready', collapsed, withProject);
      expectAddProject(false);
      render('ready', collapsed, chatsOnly);
      expectAddProject(true);
      render(
        'ready',
        {
          ...collapsed,
          pendingProjects: [
            {
              id: 'pending-project',
              name: 'Pending project',
              status: 'cloning',
            },
          ],
        },
        chatsOnly,
      );
      expectAddProject(false);
    });

    it('stays on screen in Personal with no workspaces at all', (): void => {
      render(
        'ready',
        { ...create, context: { kind: 'personal' } },
        noWorkspaces,
      );
      expectAddProject(true);
    });

    it('stays on screen beside an empty Projects slot', (): void => {
      render(
        'ready',
        {
          ...create,
          emptyProjectsSlot: <div data-testid="empty-projects-slot" />,
        },
        chatsOnly,
      );
      expect(
        container.querySelector('[data-testid="empty-projects-slot"]'),
      ).not.toBeNull();
      expectAddProject(true);
    });

    it('stays on screen beside the empty content state only', (): void => {
      render('empty', create, noWorkspaces);
      expect(
        container.querySelector('[data-testid="portal-sidebar-empty"]'),
      ).not.toBeNull();
      expectAddProject(true);

      // The list is unknown while loading or waiting, so it keeps the hover.
      render('loading', create, noWorkspaces);
      expectAddProject(false);
      render('waiting', create, noWorkspaces);
      expectAddProject(false);
    });

    it('returns to the hover reveal once a project is listed, and back', (): void => {
      render('ready', create, chatsOnly);
      expectAddProject(true);
      render('ready', create, withProject);
      expectAddProject(false);
      render('ready', create, chatsOnly);
      expectAddProject(true);
    });

    it('keeps a host reveal on a listed project', (): void => {
      render('ready', { ...create, addWorkspaceRevealed: true }, withProject);
      expectAddProject(true);
    });
  });
});

describe('SidebarSurface context row slot (CAN-4057)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(props: Partial<SidebarSurfaceProps>): void {
    act(() => {
      root.render(
        <SidebarSurface
          variant="rail"
          snapshot={snapshot}
          selection={{ kind: 'workspace', workspaceLocalId: 'workspace' }}
          contentState="ready"
          capabilities={capabilities}
          onSelect={(): void => {}}
          onCreateTask={(): void => {}}
          headerSlot={<span>Brand</span>}
          {...props}
        />,
      );
    });
  }

  it('sits below the header and above New task', () => {
    render({
      contextRowSlot: <button type="button" data-testid="host-switcher" />,
    });
    const header = container.querySelector(
      '[data-testid="portal-sidebar-header"]',
    );
    const slot = container.querySelector(
      '[data-testid="portal-sidebar-context-row"]',
    );
    const newTask = container.querySelector(
      '[data-testid="portal-create-task"]',
    );
    expect(slot?.querySelector('[data-testid="host-switcher"]')).not.toBeNull();
    expect(header?.compareDocumentPosition(slot as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(slot?.compareDocumentPosition(newTask as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('renders no wrapper without a slot', () => {
    render({});
    expect(
      container.querySelector('[data-testid="portal-sidebar-context-row"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="portal-create-task"]'),
    ).not.toBeNull();
  });
});
