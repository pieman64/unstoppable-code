/** @jest-environment jsdom */

import { act } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyCapabilities } from '@canopy/app-core';
import type { SidebarItemGroup } from '@canopy/protocol/sidebar';
import type { PortalSessionShellState } from '@canopy/protocol/portal';
import { WorktreeActionsMenu } from '@canopy/ui-shared/components';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import {
  WorkspacesSidebarSections,
  pickWorktreeRowOverrides,
  type ArchivedWorktreeEntry,
  type CoworkWorkspaceSlotContext,
  type WorktreeDndWrapperContext,
  type WorktreeRowSlotContext,
  type WorkspaceDndWrapperContext,
  type WorkspacesSidebarSectionsProps,
  type WorktreeRowOverrides,
} from '../WorkspacesSidebarSections';

const capabilities: CanopyCapabilities = {
  localExecution: false,
  terminalPty: false,
  fileSystemAccess: 'read',
  voice: false,
  settingsScope: 'api-keys-only',
  pipelines: 'read-only',
  routing: 'url',
  overviewNotifications: true,
  // The shared fixture is a client that creates worktrees; the `+` tests that
  // need the capability absent or false override it per case.
  worktreeCreation: true,
};

function shell(
  partial: Partial<PortalSessionShellState> = {},
): PortalSessionShellState {
  return {
    workspaces: [],
    worktrees: [],
    chatProjects: [],
    standaloneChats: [],
    scriptDescriptors: [],
    scriptRuns: [],
    hookDescriptors: [],
    hookRuns: [],
    plans: [],
    pipelines: [],
    pipelineRuns: [],
    chatMessages: [],
    chatSummaries: [],
    terminalSessions: [],
    terminalBuffers: {},
    changedFiles: {},
    diffSnapshots: {},
    prStatuses: {},
    fileRoots: [],
    fileTree: {},
    filePreviews: {},
    refreshing: false,
    connectionStatus: 'active',
    ...partial,
  };
}

describe('WorkspacesSidebarSections', () => {
  let container: HTMLDivElement;
  let root: Root;
  let state: PortalSessionShellState;
  let scrollIntoViewDescriptor: PropertyDescriptor | undefined;
  let matchMediaDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    matchMediaDescriptor = Object.getOwnPropertyDescriptor(
      window,
      'matchMedia',
    );
    scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollIntoView',
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    state = shell({
      workspaces: [
        {
          localId: 'workspace',
          name: 'Workspace',
          type: 'single-repo',
          itemSortMode: 'manual',
        },
      ],
      worktrees: [
        {
          localId: 'visible',
          workspaceLocalId: 'workspace',
          label: 'Human label',
          branch: 'main',
          scriptStatus: 'running',
          hookStatus: 'running',
        },
        {
          localId: 'hidden',
          workspaceLocalId: 'workspace',
          branch: 'hidden',
          hidden: true,
        },
      ],
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (scrollIntoViewDescriptor) {
      Object.defineProperty(
        HTMLElement.prototype,
        'scrollIntoView',
        scrollIntoViewDescriptor,
      );
    } else {
      delete HTMLElement.prototype.scrollIntoView;
    }
    if (matchMediaDescriptor) {
      Object.defineProperty(window, 'matchMedia', matchMediaDescriptor);
    } else {
      delete window.matchMedia;
    }
  });

  it('forwards row pointer and keyboard intent for the matching worktree', () => {
    const onWorktreeIntent = jest.fn();
    const onSelectWorktree = jest.fn();
    act(() =>
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={onSelectWorktree}
          onWorktreeIntent={onWorktreeIntent}
        />,
      ),
    );
    const row = container.querySelector('[data-worktree-id="visible"]');
    const frame = row?.closest('[data-sidebar-variant]');
    if (!(row instanceof HTMLElement) || !(frame instanceof HTMLElement))
      throw new Error('Missing worktree row');
    act(() => {
      row.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
      row.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
      frame.focus();
      frame.blur();
    });
    expect(onWorktreeIntent.mock.calls).toEqual([
      ['workspace', 'visible', 'start', 'pointer'],
      ['workspace', 'visible', 'end', 'pointer'],
      ['workspace', 'visible', 'start', 'focus'],
      ['workspace', 'visible', 'end', 'focus'],
    ]);
    expect(onSelectWorktree).not.toHaveBeenCalled();
  });

  // Web chat parity, slice 6: the chat sidebar moved from `quiet` to desktop's
  // `detailed` profile. The one thing `quiet` dropped that is unreadable rather
  // than merely noisy — a `cloud:task:<uuid>` id with no branch behind it —
  // stays dropped under BOTH profiles, because that is a data problem and not
  // a presentation choice.
  it('renders the enabled Code group list through the real section seam', () => {
    act(() =>
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={{
            ...capabilities,
            itemGrouping: true,
            worktreeReordering: true,
          }}
          selected={null}
          onSelectWorktree={jest.fn()}
          itemGroupCommandsFor={() => ({
            create: jest.fn(),
            update: jest.fn(),
            ungroup: jest.fn(),
            moveItem: jest.fn(),
            moveGroup: jest.fn(),
          })}
        />,
      ),
    );
    expect(
      container.querySelector('[data-testid="sidebar-code-item-groups"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Human label');
  });

  // A web rail paints its flat list on the server and the item-group list once
  // it can edit groups; it asks for `hairline` so no row moves between them.
  it("spaces a project's rows the same with and without group commands when asked", () => {
    state.worktrees.push({
      localId: 'second',
      workspaceLocalId: 'workspace',
      label: 'Second label',
      branch: 'second',
    });
    // The row-gap utility that separates two adjacent rows: the one on their
    // nearest common ancestor, which spaces its children.
    const gapBetweenRows = (): string[] => {
      const first = container.querySelector('[data-worktree-id="visible"]');
      let shared = container.querySelector('[data-worktree-id="second"]');
      if (!first || !shared) throw new Error('rows not rendered');
      while (shared !== null && !shared.contains(first)) {
        shared = shared.parentElement;
      }
      const classes = shared?.getAttribute('class')?.split(/\s+/) ?? [];
      return classes.filter(
        (token) => token.startsWith('space-y-') || token.startsWith('gap-'),
      );
    };
    const renderRail = (groupCommands: boolean): void =>
      act(() =>
        root.render(
          <WorkspacesSidebarSections
            state={state}
            capabilities={{ ...capabilities, itemGrouping: true }}
            selected={null}
            onSelectWorktree={jest.fn()}
            worktreeRowGap="hairline"
            {...(groupCommands
              ? {
                  itemGroupCommandsFor: () => ({
                    create: jest.fn(),
                    update: jest.fn(),
                    ungroup: jest.fn(),
                    moveItem: jest.fn(),
                    moveGroup: jest.fn(),
                  }),
                }
              : {})}
          />,
        ),
      );

    renderRail(true);
    expect(
      container.querySelector('[data-testid="sidebar-code-item-groups"]'),
    ).not.toBeNull();
    const withCommands = gapBetweenRows();
    renderRail(false);
    expect(
      container.querySelector('[data-testid="sidebar-code-item-groups"]'),
    ).toBeNull();
    expect(gapBetweenRows()).toEqual(withCommands);
  });

  it('offers cloud tree grouping and membership drag without manual ordering', () => {
    state.workspaces[0] = {
      ...state.workspaces[0],
      type: 'cowork',
      layout: 'tree',
      itemSortMode: 'last-updated',
    };
    act(() =>
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={{
            ...capabilities,
            itemGrouping: true,
            worktreeReordering: false,
          }}
          renderWorktreeDragHandle={(context) => (
            <span data-cloud-membership-drag={String(context.sortable)} />
          )}
          selected={null}
          onSelectWorktree={jest.fn()}
          itemGroupCommandsFor={() => ({
            create: jest.fn(),
            update: jest.fn(),
            ungroup: jest.fn(),
            moveItem: jest.fn(),
            moveGroup: jest.fn(),
          })}
        />,
      ),
    );
    expect(
      container.querySelector('[data-testid="sidebar-code-item-groups"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-sidebar-group-drag-source="item:visible"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-cloud-membership-drag="true"]'),
    ).not.toBeNull();
  });

  it('offers no drag to a row its host withholds grouping from', () => {
    state.workspaces[0] = {
      ...state.workspaces[0],
      type: 'cowork',
      layout: 'tree',
      itemSortMode: 'last-updated',
    };
    const workspaceCapabilities = {
      ...capabilities,
      itemGrouping: true,
      worktreeReordering: false,
    };
    act(() =>
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={workspaceCapabilities}
          // Desktop's cloud sessions: the local store cannot persist them.
          capabilitiesFor={(localId) =>
            localId === 'visible'
              ? { ...workspaceCapabilities, itemGrouping: false }
              : workspaceCapabilities
          }
          renderWorktreeDragHandle={(context) => (
            <span data-cloud-membership-drag={String(context.sortable)} />
          )}
          selected={null}
          onSelectWorktree={jest.fn()}
          itemGroupCommandsFor={() => ({
            create: jest.fn(),
            update: jest.fn(),
            ungroup: jest.fn(),
            moveItem: jest.fn(),
            moveGroup: jest.fn(),
          })}
        />,
      ),
    );
    expect(
      container.querySelector('[data-cloud-membership-drag="true"]'),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-sidebar-group-drag-source="item:visible"]')
        ?.getAttribute('data-drag-disabled'),
    ).toBe('true');
  });

  it('renders additive group metadata without mutation controls on an older host', () => {
    state.workspaces[0].itemGroups = [
      {
        id: 'grp-read',
        name: 'Read only',
        color: 'neutral',
        collapsed: false,
        memberIds: ['visible'],
      },
    ];
    act(() =>
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={jest.fn()}
        />,
      ),
    );
    expect(container.textContent).toContain('Read only');
    expect(
      container.querySelector('[data-testid="sidebar-item-group-create"]'),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="sidebar-item-group-menu-trigger"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector('[aria-roledescription="sortable"]'),
    ).toBeNull();
  });

  it('gives grouped selected-pin copies unique inert header identities and live status', () => {
    const sidebar = document.createElement('div');
    sidebar.dataset.testid = 'app-sidebar';
    for (const band of ['top', 'bottom']) {
      const host = document.createElement('div');
      host.setAttribute(`data-sidebar-selected-pin-${band}`, '');
      for (const part of ['header', 'group-header', 'row']) {
        const node = document.createElement('div');
        node.setAttribute('data-sidebar-selected-pin-part', part);
        host.appendChild(node);
      }
      sidebar.appendChild(host);
    }
    container.replaceWith(sidebar);
    sidebar.appendChild(container);
    const selectedGroup: SidebarItemGroup = {
      id: 'grp-selected',
      name: 'Release',
      color: 'neutral',
      collapsed: true,
      labelHidden: true,
      memberIds: ['visible'],
    };
    state.workspaces[0].itemGroups = [selectedGroup];
    state.worktrees[0].isStreaming = true;
    const render = (): void =>
      act(() =>
        root.render(
          <WorkspacesSidebarSections
            state={state}
            capabilities={{ ...capabilities, itemGrouping: true }}
            selected={{
              kind: 'worktree',
              workspaceLocalId: 'workspace',
              worktreeLocalId: 'visible',
            }}
            onSelectWorktree={jest.fn()}
            itemGroupCommandsFor={() => ({
              create: jest.fn(),
              update: jest.fn(),
              ungroup: jest.fn(),
              moveItem: jest.fn(),
              moveGroup: jest.fn(),
            })}
          />,
        ),
      );
    render();
    expect(
      sidebar.querySelectorAll('[data-testid="sidebar-item-group-header"]'),
    ).toHaveLength(1);
    const selectedGroupHeader = sidebar.querySelector(
      '[data-testid="sidebar-item-group-header"]',
    );
    expect(
      selectedGroupHeader
        ?.querySelector('span[id$="-label"]')
        ?.classList.contains('sr-only'),
    ).toBe(true);
    expect(
      selectedGroupHeader?.querySelector(
        '[data-testid="sidebar-item-group-counter"]',
      )?.textContent,
    ).toBe('1 worktree');
    for (const band of ['top', 'bottom']) {
      const copy = sidebar.querySelector(`[data-sidebar-selected-pin-${band}]`);
      expect(
        copy?.querySelectorAll(
          `[data-testid="sidebar-item-group-header-pin-${band}"]`,
        ),
      ).toHaveLength(1);
      expect(
        copy?.querySelector('[aria-label="Active work in group"]'),
      ).not.toBeNull();
      expect(
        copy
          ?.querySelector(
            `[data-testid="sidebar-item-group-header-frame-pin-${band}"]`,
          )
          ?.hasAttribute('inert'),
      ).toBe(true);
      expect(
        copy?.querySelector('[aria-roledescription="sortable"]'),
      ).toBeNull();
    }
    selectedGroup.collapsed = false;
    render();
    expect(
      sidebar.querySelectorAll('[data-testid="sidebar-item-group-header"]'),
    ).toHaveLength(0);
    for (const band of ['top', 'bottom']) {
      const copy = sidebar.querySelector(`[data-sidebar-selected-pin-${band}]`);
      expect(
        copy?.querySelectorAll(
          `[data-testid="sidebar-item-group-header-pin-${band}"]`,
        ),
      ).toHaveLength(0);
    }
    act(() => root.unmount());
    root = createRoot(container);
    sidebar.replaceWith(container);
  });

  describe("rowPresentation: 'detailed'", () => {
    function renderDetailed(next: PortalSessionShellState): void {
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={next}
            capabilities={capabilities}
            selected={null}
            onSelectWorktree={jest.fn()}
            rowPresentation="detailed"
          />,
        );
      });
    }

    it('drops the unreadable worktree id from a repoless row', () => {
      renderDetailed(
        shell({
          workspaces: [
            {
              localId: 'ws',
              name: 'My workspace',
              type: 'cowork',
              layout: 'tree',
              backend: 'cloud',
            },
          ],
          worktrees: [
            {
              localId: 'cloud:task:681134d1',
              workspaceLocalId: 'ws',
              branch: 'cloud',
              backend: 'cloud',
              label: 'Redfish hook sizes',
            },
          ],
        }),
      );
      expect(container.textContent).toContain('Redfish hook sizes');
      expect(container.textContent).not.toContain('cloud:task:681134d1');
      expect(
        container.querySelector('[data-worktree-single-line="true"]'),
      ).not.toBeNull();
    });

    it('keeps the worktree id on a repo-backed row', () => {
      renderDetailed(state);
      expect(container.textContent).toContain('visible');
    });

    // `SidebarSection` renders header content as a flex item, and
    // `WorkspaceSectionHeader` carries the `flex-1` that makes it span the
    // rail. The sticky-header wrapper sits between the two, so it has to pass
    // that through: as a plain block it took `flex: 0 1 auto` and collapsed to
    // the project name, and hover/selection painted a short pill while the
    // worktree rows below stayed full width.
    it('lets the project header span the rail rather than its own name', () => {
      renderDetailed(state);
      const header = container.querySelector<HTMLElement>(
        '.sidebar-workspace-sticky-header',
      );
      expect(header).not.toBeNull();
      expect(header?.className).toContain('flex-1');
      expect(header?.className).toContain('min-w-0');
      expect(header?.parentElement?.className).toContain('flex');
    });
  });

  it('lets the host name a row while its stored label stays untouched', () => {
    const seen: string[] = [];
    act(() => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={jest.fn()}
          deriveWorktreeRowLabel={({ worktree }) => {
            seen.push(worktree.label ?? '');
            return worktree.localId === 'visible'
              ? 'Fix the sidebar toggle'
              : undefined;
          }}
        />,
      );
    });
    const titles = Array.from(
      container.querySelectorAll('[data-testid="worktree-row-title"]'),
    ).map((title) => title.textContent);
    expect(titles).toContain('Fix the sidebar toggle');
    expect(titles).not.toContain('Human label');
    expect(seen).toContain('Human label');
  });

  describe("rowPresentation: 'quiet'", () => {
    /** A repoless (cloud) workspace whose worktree ids are unreadable uuids. */
    function coworkState(
      backend: 'cloud' | 'remote-control' = 'cloud',
    ): PortalSessionShellState {
      return shell({
        workspaces: [
          {
            localId: 'ws',
            name: 'My workspace',
            // Repoless (so `cowork`) but tree-shaped — the cloud combination.
            type: 'cowork',
            layout: 'tree',
            backend,
          },
        ],
        worktrees: [
          {
            localId: 'cloud:task:681134d1',
            workspaceLocalId: 'ws',
            branch: 'cloud',
            backend,
            label: 'Redfish hook sizes',
          },
        ],
      });
    }

    function renderQuiet(
      next: PortalSessionShellState,
      props: Partial<WorkspacesSidebarSectionsProps> = {},
    ): void {
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={next}
            capabilities={capabilities}
            selected={null}
            onSelectWorktree={jest.fn()}
            rowPresentation="quiet"
            {...props}
          />,
        );
      });
    }

    it('drops the unreadable worktree id from a repoless row', () => {
      renderQuiet(coworkState());
      expect(container.textContent).toContain('Redfish hook sizes');
      // The id was the row's entire second line, and on a cloud chat it is a
      // `cloud:task:<uuid>` with no branch, PR, or diff to replace it.
      expect(container.textContent).not.toContain('cloud:task:681134d1');
    });

    it('KEEPS the worktree id on a repo-backed row — one pane of glass', () => {
      // A remote-control or code workspace still has a real identity to show,
      // so `quiet` must not touch it.
      renderQuiet(state);
      expect(container.textContent).toContain('visible');
    });

    it('KEEPS the worktree id when a cowork-classified row gains a real branch', () => {
      const repoBackedCowork = coworkState();
      repoBackedCowork.worktrees[0] = {
        ...repoBackedCowork.worktrees[0],
        branch: 'feature/repo-backed-cloud',
      };

      renderQuiet(repoBackedCowork);

      // A Cowork row's client reports no `worktreeIdPresentation`, so a real
      // branch on it changes nothing: the id still survives the quiet chat
      // presentation. Only a client that reports `'branch'` drops the slot.
      expect(container.textContent).toContain('cloud:task:681134d1');
    });

    describe('a cloud repository row (worktreeIdPresentation)', () => {
      const repositoryId = 'cloud:task:681134d1';
      const branch = 'feature/repo-backed-cloud';

      /** A repository project: classified `single-repo`, laid out as a tree. */
      function repositoryState(): PortalSessionShellState {
        return shell({
          workspaces: [
            {
              localId: 'cloud:ws:repo',
              name: 'Repository',
              type: 'single-repo',
              layout: 'tree',
              backend: 'cloud',
            },
          ],
          worktrees: [
            {
              localId: repositoryId,
              workspaceLocalId: 'cloud:ws:repo',
              branch,
              backend: 'cloud',
            },
          ],
        });
      }

      const titles = (): (string | null)[] =>
        Array.from(
          container.querySelectorAll('[data-testid="worktree-row-title"]'),
        ).map((title) => title.textContent);

      it('shows the real branch and no id slot for a cloud repository row', () => {
        renderQuiet(repositoryState(), {
          capabilitiesFor: () => ({
            ...capabilities,
            worktreeIdPresentation: 'branch',
          }),
        });

        expect(titles()).toEqual([branch]);
        // The id names no local checkout, so it must not become the row's
        // second line.
        expect(container.textContent).not.toContain(repositoryId);
      });

      it('drops the id slot under the detailed profile too', () => {
        renderQuiet(repositoryState(), {
          rowPresentation: undefined,
          capabilitiesFor: () => ({
            ...capabilities,
            worktreeIdPresentation: 'branch',
          }),
        });

        expect(titles()).toEqual([branch]);
        expect(container.textContent).not.toContain(repositoryId);
      });

      it('resolves the presentation per row, from the row id', () => {
        const mixed = repositoryState();
        renderQuiet(
          shell({
            workspaces: [
              ...mixed.workspaces,
              {
                localId: 'ws-code',
                name: 'Code',
                type: 'single-repo',
                layout: 'tree',
                backend: 'remote-control',
              },
            ],
            worktrees: [
              ...mixed.worktrees,
              {
                localId: 'code-row',
                workspaceLocalId: 'ws-code',
                branch: 'main',
                backend: 'remote-control',
              },
            ],
          }),
          {
            capabilitiesFor: (localId) =>
              localId === repositoryId
                ? { ...capabilities, worktreeIdPresentation: 'branch' }
                : capabilities,
          },
        );

        // The neighbouring Remote Control row keeps its id beside its branch.
        expect(container.textContent).not.toContain(repositoryId);
        expect(container.textContent).toContain('code-row');
      });

      it.each(['id-and-branch', undefined] as const)(
        'keeps the id slot when the client reports %s',
        (worktreeIdPresentation) => {
          renderQuiet(repositoryState(), {
            capabilitiesFor: () => ({
              ...capabilities,
              worktreeIdPresentation,
            }),
          });

          expect(titles()).toEqual([branch]);
          expect(container.textContent).toContain(repositoryId);
        },
      );

      it('drops the id from the drag preview as well', () => {
        let preview: ReactNode = null;
        act(() => {
          root.render(
            <WorkspacesSidebarSections
              state={repositoryState()}
              capabilities={capabilities}
              capabilitiesFor={() => ({
                ...capabilities,
                worktreeIdPresentation: 'branch',
              })}
              selected={null}
              onSelectWorktree={jest.fn()}
              onCreateWorktree={jest.fn()}
              wrapWorktreeList={(context, list) => {
                preview = context.renderDragPreview?.(repositoryId) ?? null;
                return list;
              }}
            />,
          );
        });
        const host = document.createElement('div');
        document.body.appendChild(host);
        const previewRoot = createRoot(host);

        act(() => previewRoot.render(<>{preview}</>));
        expect(host.textContent).toContain(branch);
        expect(host.textContent).not.toContain(repositoryId);

        act(() => previewRoot.unmount());
        host.remove();
      });
    });

    it('withholds the backend pip when every project shares one backend', () => {
      renderQuiet(coworkState());
      expect(
        container.querySelector('[data-testid="workspace-backend-pip"]'),
      ).toBeNull();
    });

    it('renders the backend pip once the sidebar holds more than one backend', () => {
      const mixed = coworkState();
      renderQuiet(
        shell({
          workspaces: [
            ...mixed.workspaces,
            {
              localId: 'ws-2',
              name: 'Paired desktop',
              type: 'cowork',
              layout: 'tree',
              backend: 'remote-control',
            },
          ],
          worktrees: [
            ...mixed.worktrees,
            {
              localId: 'wt-2',
              workspaceLocalId: 'ws-2',
              branch: 'main',
              backend: 'remote-control',
            },
          ],
        }),
      );
      expect(
        container.querySelector('[data-testid="workspace-backend-pip"]'),
      ).not.toBeNull();
    });

    it('shows the count only while the section is collapsed', () => {
      renderQuiet(coworkState());
      const counter = (): Element | null =>
        container.querySelector('[data-testid="workspace-section-counter"]');
      expect(counter()).toBeNull();

      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[aria-label="Collapse My workspace"]',
          )
          ?.click(),
      );
      // Collapsed is the one state where the rows it counts are off screen.
      expect(counter()?.textContent).toBe('1');
    });

    it("defaults to 'detailed': pip and count at rest", () => {
      renderQuiet(coworkState(), { rowPresentation: undefined });
      expect(container.textContent).toContain('Redfish hook sizes');
      // The unreadable id is dropped under every profile now (see the
      // `'detailed'` block above); the pip and the at-rest count are what
      // still distinguish the default from `quiet`.
      expect(container.textContent).not.toContain('cloud:task:681134d1');
      expect(
        container.querySelector('[data-testid="workspace-backend-pip"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="workspace-section-counter"]'),
      ).not.toBeNull();
    });
  });

  // CAN-3053: right-click opens the row's existing ⋯ menu, anchored at the
  // pointer, matching the legacy desktop rail. `WorktreeRow` already accepted
  // an `onContextMenu` prop; the regression was that the shared rail never
  // wired one up.
  describe('right-click actions menu', () => {
    function renderWithMenu(
      items: readonly Parameters<typeof WorktreeActionsMenu>[0]['items'],
    ): void {
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={state}
            capabilities={capabilities}
            selected={null}
            onSelectWorktree={jest.fn()}
            renderWorktreeActions={() => ({
              node: (
                <WorktreeActionsMenu
                  items={items}
                  accessibleLabel="Actions for visible"
                  triggerTestId="worktree-actions-menu-button"
                  menuTestId="worktree-actions-menu"
                />
              ),
              buttonCount: 1,
            })}
          />,
        );
      });
    }

    it('opens the actions menu anchored at the pointer', () => {
      const onArchive = jest.fn();
      renderWithMenu([
        {
          key: 'archive',
          label: 'Archive',
          icon: null,
          onSelect: onArchive,
        },
      ]);
      const row = container.querySelector<HTMLElement>(
        '[data-worktree-id="visible"]',
      );
      if (!row) throw new Error('worktree row missing');
      expect(
        document.querySelector('[data-testid="worktree-actions-menu"]'),
      ).toBeNull();

      let defaultPrevented = false;
      act(() => {
        const event = new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 111,
          clientY: 222,
        });
        defaultPrevented = !row.dispatchEvent(event);
      });

      expect(defaultPrevented).toBe(true);
      const menu = document.querySelector<HTMLElement>(
        '[data-testid="worktree-actions-menu"]',
      );
      expect(menu).not.toBeNull();
      expect(menu?.textContent).toContain('Archive');
      expect(menu?.style.top).toBe(`${222 + 4}px`);
      expect(menu?.style.right).toBe(`${window.innerWidth - 111}px`);
    });

    it('leaves the native browser menu alone when the row has no menu', () => {
      renderWithMenu([]);
      const row = container.querySelector<HTMLElement>(
        '[data-worktree-id="visible"]',
      );
      if (!row) throw new Error('worktree row missing');

      let defaultPrevented = false;
      act(() => {
        const event = new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        });
        defaultPrevented = !row.dispatchEvent(event);
      });

      expect(defaultPrevented).toBe(false);
      expect(
        document.querySelector('[data-testid="worktree-actions-menu"]'),
      ).toBeNull();
    });

    // PR #4127 review: the row's own dialogs (Set label, Branch info) portal
    // to `document.body` via `renderWorktreeDialogs`, but they are still
    // React CHILDREN of the row's `SidebarRowFrame` — React bubbles a
    // portaled child's synthetic events through the React tree, not the DOM
    // tree, so a right-click on the portaled dialog's own content used to
    // reach this row's handler and hijack the native Cut/Copy/Paste menu.
    it('does not hijack a right-click inside a portaled row dialog', () => {
      const onArchive = jest.fn();
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={state}
            capabilities={capabilities}
            selected={null}
            onSelectWorktree={jest.fn()}
            renderWorktreeActions={() => ({
              node: (
                <WorktreeActionsMenu
                  items={[
                    {
                      key: 'archive',
                      label: 'Archive',
                      icon: null,
                      onSelect: onArchive,
                    },
                  ]}
                  accessibleLabel="Actions for visible"
                  triggerTestId="worktree-actions-menu-button"
                  menuTestId="worktree-actions-menu"
                />
              ),
              buttonCount: 1,
            })}
            renderWorktreeDialogs={() =>
              createPortal(
                <input data-testid="row-label-dialog-input" defaultValue="x" />,
                document.body,
              )
            }
          />,
        );
      });
      const dialogInput = document.querySelector<HTMLElement>(
        '[data-testid="row-label-dialog-input"]',
      );
      expect(dialogInput).not.toBeNull();
      // Not nested in the row's real DOM — only in the React tree.
      const row = container.querySelector('[data-worktree-id="visible"]');
      expect(row?.contains(dialogInput)).toBe(false);

      let defaultPrevented = false;
      act(() => {
        const event = new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 5,
          clientY: 5,
        });
        defaultPrevented = !dialogInput?.dispatchEvent(event);
      });

      expect(defaultPrevented).toBe(false);
      expect(
        document.querySelector('[data-testid="worktree-actions-menu"]'),
      ).toBeNull();
    });
  });

  it('renders selected runtime rows and the hidden-worktree disclosure', () => {
    act(() => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={capabilities}
          selected={{
            kind: 'worktree',
            workspaceLocalId: 'workspace',
            worktreeLocalId: 'visible',
          }}
          onSelectWorktree={jest.fn()}
          creationEnabled
          onCreateWorktree={jest.fn()}
          testIds={{
            hiddenWorktreesToggle: (id) => `hidden-${id}`,
          }}
        />,
      );
    });
    expect(container.textContent).toContain('Workspace');
    expect(container.textContent).toContain('Human label');
    expect(container.textContent).toContain('visible');
    expect(
      container
        .querySelector('[data-worktree-id="visible"]')
        ?.getAttribute('data-worktree-layout'),
    ).toBe('classic');
    expect(container.textContent).not.toContain('hidden');
    expect(
      container.querySelector('[data-testid="hidden-workspace"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-worktree-id="visible"]')).not.toBe(
      null,
    );
    expect(container.innerHTML).toContain('Scripts running');
    const workspaceSection = container.querySelector(
      '[data-workspace-id="workspace"]',
    );
    const counter = workspaceSection?.querySelector(
      '[data-testid="workspace-section-counter"]',
    );
    const name = workspaceSection?.querySelector(
      '[aria-label="Collapse Workspace"] > span',
    );
    expect(counter?.parentElement).toBe(name?.parentElement);
    expect(counter?.className).toContain('ml-auto');
  });

  it.each([
    ['preparing', 'active', 'Analyzing the PR diff'],
    ['running', 'active', 'Carving child branch (2/4)'],
    ['ready', 'review', 'Waiting for your plan approval'],
    ['completed', 'done', 'All child PRs created'],
    ['failed', 'active', 'Split failed'],
  ] as const)(
    'maps projected split phase %s to the existing row status %s',
    (splitPrStatus, rowStatus, splitPrStatusMessage) => {
      state = shell({
        ...state,
        worktrees: [
          {
            ...state.worktrees[0],
            splitPrStatus,
            splitPrStatusMessage,
          },
        ],
      });
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={state}
            capabilities={capabilities}
            selected={null}
            onSelectWorktree={jest.fn()}
            onCreateWorktree={jest.fn()}
          />,
        );
      });
      const split = container.querySelector('[data-split-status]');
      expect(split?.getAttribute('data-split-status')).toBe(rowStatus);
      expect(container.textContent).toContain(splitPrStatusMessage);
    },
  );

  it('spaces flat worktree rows 1px apart by default and one device pixel when asked', () => {
    const rowListClasses = (
      worktreeRowGap?: WorkspacesSidebarSectionsProps['worktreeRowGap'],
    ): string[] => {
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={state}
            capabilities={capabilities}
            selected={null}
            onSelectWorktree={jest.fn()}
            worktreeRowGap={worktreeRowGap}
          />,
        );
      });
      const list = container
        .querySelector('[data-worktree-id="visible"]')
        ?.closest('[role="list"]');
      return Array.from(list?.classList ?? []);
    };

    expect(rowListClasses()).toContain('space-y-px');
    // 1px, the nav rows' gap, so adjacent highlighted rows read apart.
    expect(rowListClasses('hairline')).toContain('space-y-px');
  });

  // Desktop renders worktrees through the item-group list, whose rows
  // otherwise sit flush against each other: between ungrouped rows (each its
  // own block) and between the rows inside one group.
  it('spaces item-group rows 1px apart when asked, and flush by default', () => {
    state.workspaces[0].itemGroups = [
      {
        id: 'grp',
        name: 'Group',
        color: 'neutral',
        collapsed: false,
        memberIds: ['visible', 'second'],
      },
    ];
    state.worktrees = [
      ...state.worktrees,
      { localId: 'second', workspaceLocalId: 'workspace', branch: 'second' },
      { localId: 'loose', workspaceLocalId: 'workspace', branch: 'loose' },
      { localId: 'loose-2', workspaceLocalId: 'workspace', branch: 'loose-2' },
    ];
    const render = (
      worktreeRowGap?: WorkspacesSidebarSectionsProps['worktreeRowGap'],
    ): void => {
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={state}
            capabilities={capabilities}
            selected={null}
            onSelectWorktree={jest.fn()}
            worktreeRowGap={worktreeRowGap}
          />,
        );
      });
    };
    // The nearest element holding both rows: the one whose spacing sets the
    // gap between them.
    const sharedParentClasses = (a: string, b: string): string[] => {
      const first = container.querySelector(`[data-worktree-id="${a}"]`);
      const second = container.querySelector(`[data-worktree-id="${b}"]`);
      let parent = first?.parentElement ?? null;
      while (parent && second && !parent.contains(second)) {
        parent = parent.parentElement;
      }
      return Array.from(parent?.classList ?? []);
    };

    render();
    expect(
      container.querySelector('[data-testid="sidebar-code-item-groups"]'),
    ).not.toBeNull();
    expect(sharedParentClasses('visible', 'second')).not.toContain(
      'space-y-px',
    );
    expect(sharedParentClasses('loose', 'loose-2')).not.toContain('space-y-px');

    render('hairline');
    expect(sharedParentClasses('visible', 'second')).toContain('space-y-px');
    expect(sharedParentClasses('loose', 'loose-2')).toContain('space-y-px');
  });

  it('lights the question dot from a chat summary awaiting an answer (portal parity)', () => {
    const render = (answered: boolean): void => {
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={shell({
              ...state,
              chatSummaries: [
                {
                  localId: 'chat',
                  chatId: 'chat',
                  scope: 'worktree',
                  workspaceLocalId: 'workspace',
                  worktreeLocalId: 'visible',
                  title: 'Release',
                  pendingQuestions: [
                    { requestId: 'q', questions: [], answered },
                  ],
                },
              ],
            })}
            capabilities={capabilities}
            selected={null}
            onSelectWorktree={jest.fn()}
            onCreateWorktree={jest.fn()}
          />,
        );
      });
    };
    render(false);
    const row = (): Element | null =>
      container.querySelector('[data-worktree-id="visible"]');
    expect(
      row()?.querySelector('[data-testid="worktree-row-question"]'),
    ).not.toBeNull();
    render(true);
    expect(
      row()?.querySelector('[data-testid="worktree-row-question"]'),
    ).toBeNull();
  });

  it('runs the host row-override hook inside each row and layers it over the snapshot', () => {
    const seen: string[] = [];
    const useOverrides = (
      context: WorktreeRowSlotContext,
    ): { hasPendingToolApproval: boolean; hasUnread: boolean } | undefined => {
      seen.push(`${context.workspace.localId}/${context.worktree.localId}`);
      return context.worktree.localId === 'visible'
        ? { hasPendingToolApproval: true, hasUnread: false }
        : undefined;
    };
    act(() => {
      root.render(
        <WorkspacesSidebarSections
          state={shell({
            ...state,
            worktrees: [
              { ...state.worktrees[0], hasUnread: true },
              {
                localId: 'other',
                workspaceLocalId: 'workspace',
                branch: 'other',
                hasUnread: true,
              },
            ],
          })}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={jest.fn()}
          onCreateWorktree={jest.fn()}
          useWorktreeRowOverrides={useOverrides}
        />,
      );
    });
    expect(seen).toEqual(
      expect.arrayContaining(['workspace/visible', 'workspace/other']),
    );
    const visible = container.querySelector('[data-worktree-id="visible"]');
    const other = container.querySelector('[data-worktree-id="other"]');
    // The host's live answer wins where it has one…
    expect(
      visible?.querySelector('[data-testid="worktree-row-tool-approval"]'),
    ).not.toBeNull();
    expect(
      visible?.querySelector('[data-testid="worktree-row-unread"]'),
    ).toBeNull();
    // …and a row it declines keeps the snapshot projection.
    expect(
      other?.querySelector('[data-testid="worktree-row-unread"]'),
    ).not.toBeNull();
  });

  it('cannot override row identity or selection even from a loosely-typed host override object (CAN-3053 finding 2)', () => {
    // A host hook is typed to return `WorktreeRowOverrides`, but nothing
    // stops it from handing back a wider object at runtime (a shared
    // variable, a spread of unrelated state). Model that here with a
    // deliberately widened return type so TypeScript's excess-property check
    // cannot catch it either — the only thing that may stop `dataWorktreeId`
    // and `selected` from reaching the row is `pickWorktreeRowOverrides`
    // filtering the spread at runtime.
    const useOverrides = (): WorktreeRowOverrides & {
      readonly dataWorktreeId: string;
      readonly selected: boolean;
    } => ({
      hasUnread: true,
      dataWorktreeId: 'evil',
      selected: true,
    });
    act(() => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={jest.fn()}
          onCreateWorktree={jest.fn()}
          useWorktreeRowOverrides={useOverrides}
        />,
      );
    });
    const row = container.querySelector('[data-worktree-id="visible"]');
    // The row's true identity survives — not the override's "evil" id, and
    // no second row was created under the spoofed id.
    expect(row).not.toBeNull();
    expect(container.querySelector('[data-worktree-id="evil"]')).toBeNull();
    // The row was never told it is selected: `selected` drives the
    // `bg-muted` selected-row background class, which must be absent here
    // since the component was rendered with `selected={null}`.
    expect(row?.className).not.toContain('bg-muted');
    // The allowed key from the same override object still applies, proving
    // the filter is an allowlist rather than a blanket rejection.
    expect(
      row?.querySelector('[data-testid="worktree-row-unread"]'),
    ).not.toBeNull();
  });

  it('hands the pipeline popover the status the row shows, override included', () => {
    const statuses: unknown[] = [];
    act(() => {
      root.render(
        <WorkspacesSidebarSections
          state={shell({
            ...state,
            worktrees: [{ ...state.worktrees[0], pipelineStatus: undefined }],
          })}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={jest.fn()}
          onCreateWorktree={jest.fn()}
          useWorktreeRowOverrides={() => ({ pipelineStatus: 'unseen-failure' })}
          renderPipelinePopover={(context) => {
            statuses.push(context.pipelineStatus);
            return null;
          }}
        />,
      );
    });
    expect(
      container.querySelector(
        '[data-worktree-id="visible"] [data-testid="worktree-row-pipeline-glyph"]',
      ),
    ).not.toBeNull();
    expect(statuses.at(-1)).toBe('unseen-failure');
  });

  it('gives the DnD wrapper a drag preview carrying the host overrides but no row identity', () => {
    let preview: ReactNode = null;
    act(() => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={{ ...capabilities, worktreeReordering: true }}
          worktreeDiffStatsStyle="complete"
          selected={null}
          onSelectWorktree={jest.fn()}
          onCreateWorktree={jest.fn()}
          useWorktreeRowOverrides={() => ({
            diffStats: { insertions: 1234, deletions: 12345 },
          })}
          wrapWorktreeList={(context, list) => {
            preview = context.renderDragPreview?.('visible') ?? null;
            return list;
          }}
        />,
      );
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const previewRoot = createRoot(host);
    act(() => previewRoot.render(<>{preview}</>));
    expect(
      host.querySelector('[data-testid="diff-stats-badge"]')?.textContent,
    ).toBe('+1234-12345');
    expect(host.querySelector('[data-worktree-id]')).toBeNull();
    act(() => previewRoot.unmount());
    host.remove();
  });

  it('projects the drag preview from the same display fields as the in-flow row (CAN-3053 finding 10)', () => {
    // Two symptoms of the drift Opus flagged: a repoless Cowork row's
    // preview falling back to a raw, full-height id (`worktreeIdSlot`/
    // `compact` were missing from the hand-built preview `rowProps`), and a
    // preview losing the PR/done badges a host supplies through
    // `derivePrStatus`/`deriveDoneLabel` (also missing). Assert both reach
    // the preview now that it is built from the same projection `renderRow`
    // uses.
    const coworkState = shell({
      workspaces: [
        // `layout: 'tree'` routes a repoless cowork workspace through the
        // ordinary worktree-tree path (`renderRow`/DnD), the same as a
        // cloud-backed project — see the "cloud-backed projects" fixture
        // below for why `type: 'cowork'` alone would route to the separate
        // cowork-slot projection instead.
        {
          localId: 'cowork',
          name: 'Cowork',
          type: 'cowork',
          layout: 'tree',
        },
        { localId: 'workspace', name: 'Workspace', type: 'single-repo' },
      ],
      worktrees: [
        {
          localId: 'cloud:task:11111111-1111-4111-8111-111111111111',
          workspaceLocalId: 'cowork',
          branch: 'cloud',
        },
        { localId: 'visible', workspaceLocalId: 'workspace', branch: 'main' },
      ],
    });
    let coworkPreview: ReactNode = null;
    let codePreview: ReactNode = null;
    act(() => {
      root.render(
        <WorkspacesSidebarSections
          state={coworkState}
          capabilities={{ ...capabilities, worktreeReordering: true }}
          selected={null}
          onSelectWorktree={jest.fn()}
          onCreateWorktree={jest.fn()}
          derivePrStatus={(context) =>
            context.worktree.localId === 'visible'
              ? { state: 'open', label: 'PR #99' }
              : undefined
          }
          wrapWorktreeList={(context, list) => {
            if (context.workspace.localId === 'cowork') {
              coworkPreview =
                context.renderDragPreview?.(
                  'cloud:task:11111111-1111-4111-8111-111111111111',
                ) ?? null;
            } else {
              codePreview = context.renderDragPreview?.('visible') ?? null;
            }
            return list;
          }}
        />,
      );
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const previewRoot = createRoot(host);

    act(() => previewRoot.render(<>{coworkPreview}</>));
    // The raw id must not leak through — `worktreeIdSlot` was omitted
    // entirely by the old hand-built preview, which fell back to showing
    // `worktreeId` itself.
    expect(host.textContent).not.toContain('cloud:task:1111');

    act(() => previewRoot.render(<>{codePreview}</>));
    expect(
      host.querySelector('[data-testid="worktree-row-pr-badge"]')?.textContent,
    ).toContain('PR #99');

    act(() => previewRoot.unmount());
    host.remove();
  });

  it('renders branch children with ancestry depths only when enabled and capable', () => {
    const groupedState = shell({
      workspaces: [
        { localId: 'workspace', name: 'Workspace', type: 'single-repo' },
      ],
      worktrees: [
        {
          localId: 'parent',
          workspaceLocalId: 'workspace',
          branch: 'feature-parent',
        },
        {
          localId: 'child',
          workspaceLocalId: 'workspace',
          branch: 'feature-child',
        },
        {
          localId: 'sibling',
          workspaceLocalId: 'workspace',
          branch: 'feature-sibling',
        },
        {
          localId: 'grandchild',
          workspaceLocalId: 'workspace',
          branch: 'feature-grandchild',
        },
      ],
    });
    const itemGroupCommandsFor: WorkspacesSidebarSectionsProps['itemGroupCommandsFor'] =
      () => ({
        create: jest.fn(),
        update: jest.fn(),
        ungroup: jest.fn(),
        moveItem: jest.fn(),
        moveGroup: jest.fn(),
      });
    const render = (
      enabled: boolean,
      options: {
        worktreeRowGap?: WorkspacesSidebarSectionsProps['worktreeRowGap'];
        itemGroups?: boolean;
      } = {},
    ): void => {
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={groupedState}
            capabilities={{
              ...capabilities,
              worktreeBranchGrouping: true,
              itemGrouping: options.itemGroups === true,
            }}
            selected={null}
            onSelectWorktree={jest.fn()}
            onCreateWorktree={jest.fn()}
            worktreeRowGap={options.worktreeRowGap}
            itemGroupCommandsFor={
              options.itemGroups ? itemGroupCommandsFor : undefined
            }
            branchGroupingEnabled={enabled}
            getBranchGrouping={() => ({
              defaultBranches: new Set(['main']),
              groupingEnabled: true,
              baseBranchByWorktreeId: new Map([
                ['parent', 'main'],
                ['child', 'feature-parent'],
                ['sibling', 'feature-parent'],
                ['grandchild', 'feature-child'],
              ]),
            })}
          />,
        );
      });
    };
    render(false);
    expect(
      container.querySelector('[data-testid="worktree-branch-group-children"]'),
    ).toBeNull();
    render(true);
    // Stacked children sit flush — no vertical gap inside the group.
    const childrenGroup = container.querySelector(
      '[data-testid="worktree-branch-group-children"]',
    );
    expect(childrenGroup?.className ?? '').not.toContain('space-y');
    // 1px guide line (thinned from the original 2px). Per-row segments join
    // flush into one continuous line, except the stack's first segment insets
    // from the top and its last segment insets from the bottom.
    const rails = Array.from(
      container.querySelectorAll(
        '[data-testid="worktree-branch-group-children"] > [data-testid="worktree-branch-group-child"] > [data-testid="worktree-nesting-rail"]',
      ),
    );
    expect(rails.length).toBeGreaterThan(1);
    for (const rail of rails) {
      expect(rail.className).toContain('w-px');
    }
    expect(rails[0]?.className).toContain('top-1.5');
    expect(rails[0]?.className).not.toContain('top-0');
    expect(rails[rails.length - 1]?.className).toContain('bottom-1.5');
    expect(rails[rails.length - 1]?.className).not.toContain('bottom-0');
    const nestedDepth = (worktreeId: string): string | null | undefined =>
      container.querySelector(
        `[data-worktree-id="${worktreeId}"] [data-testid="worktree-row-nested-child-depth"]`,
      )?.textContent;
    expect(nestedDepth('child')).toBe('1');
    expect(nestedDepth('sibling')).toBe('1');
    expect(nestedDepth('grandchild')).toBe('2');

    // With the rows spaced, a stack's rows keep 1px between them in both the
    // flat and the item-group list, and the rail reaches across each gap.
    for (const itemGroups of [false, true]) {
      render(true, { worktreeRowGap: 'hairline', itemGroups });
      expect(
        container.querySelector('[data-testid="sidebar-code-item-groups"]') !==
          null,
      ).toBe(itemGroups);
      const stackChildren = container.querySelector(
        '[data-testid="worktree-branch-group-children"]',
      );
      expect(stackChildren?.classList.contains('space-y-px')).toBe(true);
      // Parent to first child: the stack wrapper's own 1px.
      expect(
        stackChildren?.parentElement?.classList.contains('space-y-px'),
      ).toBe(true);
      const spacedRails = Array.from(
        container.querySelectorAll(
          '[data-testid="worktree-branch-group-children"] [data-testid="worktree-nesting-rail"]',
        ),
      );
      expect(spacedRails.length).toBeGreaterThan(1);
      expect(spacedRails[0]?.className).toContain('top-1.5');
      for (const rail of spacedRails.slice(1)) {
        expect(rail.className).toContain('-top-px');
      }
    }
  });

  it('preserves ancestry depth when an ancestor is hidden', () => {
    const groupedState = shell({
      workspaces: [
        { localId: 'workspace', name: 'Workspace', type: 'single-repo' },
      ],
      worktrees: [
        {
          localId: 'parent',
          workspaceLocalId: 'workspace',
          branch: 'feature-parent',
          hidden: true,
        },
        {
          localId: 'child',
          workspaceLocalId: 'workspace',
          branch: 'feature-child',
        },
        {
          localId: 'grandchild',
          workspaceLocalId: 'workspace',
          branch: 'feature-grandchild',
        },
      ],
    });

    act(() => {
      root.render(
        <WorkspacesSidebarSections
          state={groupedState}
          capabilities={{
            ...capabilities,
            worktreeBranchGrouping: true,
          }}
          selected={null}
          onSelectWorktree={jest.fn()}
          onCreateWorktree={jest.fn()}
          branchGroupingEnabled
          getBranchGrouping={() => ({
            defaultBranches: new Set(['main']),
            groupingEnabled: true,
            baseBranchByWorktreeId: new Map([
              ['parent', 'main'],
              ['child', 'feature-parent'],
              ['grandchild', 'feature-child'],
            ]),
          })}
        />,
      );
    });

    const grandchildDepth = container.querySelector(
      '[data-worktree-id="grandchild"] [data-testid="worktree-row-nested-child-depth"]',
    );
    expect(grandchildDepth?.textContent).toBe('2');
  });

  it('delegates collapse persistence without keeping a local override', () => {
    const onWorkspaceCollapsedChange = jest.fn();
    const renderSections = (): void => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={jest.fn()}
          onWorkspaceCollapsedChange={onWorkspaceCollapsedChange}
          onCreateWorktree={jest.fn()}
        />,
      );
    };
    act(renderSections);
    const collapse = container.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse Workspace"]',
    );
    act(() => collapse?.click());
    expect(onWorkspaceCollapsedChange).toHaveBeenCalledWith('workspace', true);
    expect(
      container.querySelector('[aria-label="Collapse Workspace"]'),
    ).not.toBeNull();

    state = shell({
      ...state,
      workspaces: [{ ...state.workspaces[0], collapsed: true }],
    });
    act(renderSections);
    expect(
      container.querySelector('[aria-label="Expand Workspace"]'),
    ).not.toBeNull();
  });

  it('toggles instead of selecting from the project name on coarse pointers', () => {
    window.matchMedia = jest.fn().mockImplementation(
      (query: string): MediaQueryList =>
        ({
          matches: query === '(pointer: coarse)',
          media: query,
          onchange: null,
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
          addListener: jest.fn(),
          removeListener: jest.fn(),
          dispatchEvent: jest.fn(),
        }) as MediaQueryList,
    );
    const onSelectWorkspace = jest.fn();
    const onWorkspaceCollapsedChange = jest.fn();

    act(() => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={jest.fn()}
          onSelectWorkspace={onSelectWorkspace}
          onWorkspaceCollapsedChange={onWorkspaceCollapsedChange}
          onCreateWorktree={jest.fn()}
        />,
      );
    });

    const header = container.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse Workspace"]',
    );
    expect(header?.getAttribute('aria-expanded')).toBe('true');
    expect(
      container.querySelectorAll('[aria-label="Collapse Workspace"]'),
    ).toHaveLength(1);
    act(() => header?.click());
    expect(onWorkspaceCollapsedChange).toHaveBeenCalledWith('workspace', true);
    expect(onSelectWorkspace).not.toHaveBeenCalled();
  });

  // A tree project has no project-level view on any host: selecting it parked
  // the portal on the dead-end "Select a worktree" placeholder (CAN-3053). A
  // header that cannot be reordered renders the built-in badge instead of a
  // drag handle, and that badge must not become a second way to select it.
  it.each([
    ['portal', false],
    ['desktop', true],
  ])(
    'offers no project selection from a tree header badge (%s)',
    (_host, workspaceNameTogglesCollapse) => {
      const onSelectWorkspace = jest.fn();
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={state}
            capabilities={capabilities}
            selected={null}
            onSelectWorktree={jest.fn()}
            onSelectWorkspace={onSelectWorkspace}
            workspaceNameTogglesCollapse={workspaceNameTogglesCollapse}
            onCreateWorktree={jest.fn()}
          />,
        );
      });

      expect(
        container.querySelector('[aria-label="Select Workspace"]'),
      ).toBeNull();
      const headerButtons = Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          'button[aria-label$=" Workspace"]',
        ),
      );
      expect(headerButtons.length).toBeGreaterThan(0);
      for (const button of headerButtons) {
        act(() => button.click());
      }
      expect(onSelectWorkspace).not.toHaveBeenCalled();
    },
  );

  // The affordance used to be inert: the chevron rotated and `data-collapsed`
  // was stamped, but the body rendered unconditionally, so nothing collapsed.
  it('hides the project body while collapsed, on both collapse paths', () => {
    const rows = (): number =>
      container.querySelectorAll('[data-worktree-id]').length;
    const renderSections = (
      onWorkspaceCollapsedChange?: (id: string, collapsed: boolean) => void,
    ): void => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={jest.fn()}
          onCreateWorktree={jest.fn()}
          onWorkspaceCollapsedChange={onWorkspaceCollapsedChange}
        />,
      );
    };

    // Uncontrolled: the local override drives the body.
    act(() => renderSections());
    expect(rows()).toBeGreaterThan(0);
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Collapse Workspace"]')
        ?.click(),
    );
    expect(rows()).toBe(0);
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Expand Workspace"]')
        ?.click(),
    );
    expect(rows()).toBeGreaterThan(0);
  });

  it('hides the project body for a host-persisted collapse', () => {
    state = shell({
      ...state,
      workspaces: [{ ...state.workspaces[0], collapsed: true }],
    });
    act(() => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={jest.fn()}
          onCreateWorktree={jest.fn()}
          onWorkspaceCollapsedChange={jest.fn()}
        />,
      );
    });

    expect(container.querySelectorAll('[data-worktree-id]')).toHaveLength(0);
    expect(
      container.querySelector('[aria-label="Expand Workspace"]'),
    ).not.toBeNull();
  });

  describe('empty project', () => {
    const emptyTestId = (id: string): string => `sidebar-project-${id}-empty`;
    const renderEmpty = (
      next: PortalSessionShellState,
      extra: Partial<WorkspacesSidebarSectionsProps> = {},
    ): void => {
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={next}
            capabilities={capabilities}
            selected={null}
            onSelectWorktree={jest.fn()}
            onCreateWorktree={jest.fn()}
            testIds={{ workspaceEmpty: emptyTestId }}
            {...extra}
          />,
        );
      });
    };
    const emptyLine = (id = 'workspace'): HTMLElement | null =>
      container.querySelector<HTMLElement>(
        `[data-testid="${emptyTestId(id)}"]`,
      );

    it('says an expanded project has no worktrees, in its rows surface', () => {
      renderEmpty(shell({ workspaces: state.workspaces, worktrees: [] }));

      expect(emptyLine()?.textContent).toBe('No worktrees');
      // On the title column of the rows it stands in for.
      expect(emptyLine()?.classList.contains('pl-8')).toBe(true);
      // The mark the desktop rail's layout cache and project-drag geometry
      // read to find a header's rows.
      expect(
        emptyLine()
          ?.closest('[data-sidebar-folder-content]')
          ?.getAttribute('data-sidebar-folder-content'),
      ).toBe('code-workspace');
    });

    it('names chats for a repoless tree project', () => {
      renderEmpty(
        shell({
          workspaces: [
            {
              localId: 'cloud',
              name: 'Cloud',
              type: 'cowork',
              layout: 'tree',
              backend: 'cloud',
            },
          ],
          worktrees: [],
        }),
      );

      expect(emptyLine('cloud')?.textContent).toBe('No chats');
    });

    it('shows nothing while collapsed or while archived items remain', () => {
      renderEmpty(
        shell({
          workspaces: [{ ...state.workspaces[0], collapsed: true }],
          worktrees: [],
        }),
      );
      expect(emptyLine()).toBeNull();

      renderEmpty(shell({ workspaces: state.workspaces, worktrees: [] }), {
        archivedCount: () => 1,
      });
      expect(emptyLine()).toBeNull();
    });

    it('shows nothing when the project has only hidden worktrees', () => {
      renderEmpty(
        shell({
          workspaces: state.workspaces,
          worktrees: state.worktrees.filter((row) => row.hidden === true),
        }),
      );
      expect(emptyLine()).toBeNull();
    });

    it('marks a populated project body as its rows surface', () => {
      renderEmpty(state);
      expect(emptyLine()).toBeNull();
      const row = container.querySelector('[data-worktree-id="visible"]');
      expect(
        row
          ?.closest('[data-sidebar-folder-content]')
          ?.getAttribute('data-sidebar-folder-content'),
      ).toBe('code-workspace');
    });
  });

  it('keeps local collapse state as the default fallback', () => {
    act(() => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={jest.fn()}
          onCreateWorktree={jest.fn()}
        />,
      );
    });
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Collapse Workspace"]')
        ?.click(),
    );
    expect(
      container.querySelector('[aria-label="Expand Workspace"]'),
    ).not.toBeNull();
  });

  it('filters the project partition with host-visible ids', () => {
    state = shell({
      workspaces: [
        ...state.workspaces,
        { localId: 'filtered', name: 'Filtered', type: 'single-repo' },
      ],
      worktrees: state.worktrees,
    });
    act(() => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={capabilities}
          selected={null}
          visibleWorkspaceIds={new Set(['workspace'])}
          onSelectWorktree={jest.fn()}
          onCreateWorktree={jest.fn()}
        />,
      );
    });
    expect(container.textContent).toContain('Workspace');
    expect(container.textContent).not.toContain('Filtered');
  });

  it('reports row elements and reveals a changed target once', () => {
    const scrollIntoView = jest.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    const onWorktreeRowElement = jest.fn();
    const renderSections = (
      target: {
        workspaceLocalId: string;
        worktreeLocalId: string;
      } | null,
    ): void => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={capabilities}
          selected={null}
          pendingRevealTarget={target}
          onWorktreeRowElement={onWorktreeRowElement}
          onSelectWorktree={jest.fn()}
          onCreateWorktree={jest.fn()}
        />,
      );
    };
    const target = {
      workspaceLocalId: 'workspace',
      worktreeLocalId: 'visible',
    };
    act(() => renderSections(target));
    expect(onWorktreeRowElement).toHaveBeenCalledWith(
      'workspace',
      'visible',
      expect.any(HTMLDivElement),
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(onWorktreeRowElement).toHaveBeenCalledTimes(1);
    act(() => renderSections(target));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(onWorktreeRowElement).toHaveBeenCalledTimes(1);
    act(() =>
      renderSections({
        workspaceLocalId: 'workspace',
        worktreeLocalId: 'hidden',
      }),
    );
    act(() => renderSections(target));
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it('reveals a pending hidden worktree exactly once when its row mounts', () => {
    const scrollIntoView = jest.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    act(() => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={capabilities}
          selected={null}
          pendingRevealTarget={{
            workspaceLocalId: 'workspace',
            worktreeLocalId: 'hidden',
          }}
          onSelectWorktree={jest.fn()}
          onCreateWorktree={jest.fn()}
          testIds={{
            hiddenWorktreesToggle: (id) => `hidden-worktrees-${id}`,
          }}
        />,
      );
    });
    expect(scrollIntoView).not.toHaveBeenCalled();
    const toggleHidden = (): void =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="hidden-worktrees-workspace"]',
        )
        ?.click();
    act(toggleHidden);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    act(toggleHidden);
    act(toggleHidden);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('keeps the sortable handle out of the classic subtitle flex row', () => {
    const alignedState = shell({
      workspaces: state.workspaces,
      worktrees: [
        {
          localId: 'plain',
          workspaceLocalId: 'workspace',
          label: 'Plain row',
          branch: 'plain-branch',
        },
        {
          localId: 'unread',
          workspaceLocalId: 'workspace',
          label: 'Unread row',
          branch: 'unread-branch',
          hasUnread: true,
        },
      ],
    });
    act(() => {
      root.render(
        <WorkspacesSidebarSections
          state={alignedState}
          capabilities={{
            ...capabilities,
            workspaceReordering: true,
            worktreeReordering: true,
          }}
          selected={null}
          onSelectWorktree={jest.fn()}
          renderWorktreeDragHandle={({ sortable }) =>
            sortable ? (
              <button type="button" data-testid="worktree-drag-handle" />
            ) : null
          }
        />,
      );
    });

    const assertAlignedSubtitle = (
      worktreeId: string,
      worktreeName: string,
      expectedChildren: number,
    ): Element => {
      const row = container.querySelector(`[data-worktree-id="${worktreeId}"]`);
      const leadingSlot = row?.querySelector(
        '[data-testid="worktree-row-leading-slot"]',
      );
      const subtitle = row?.querySelector(
        '[data-testid="worktree-row-subtitle"]',
      );
      const subtitleTrack = subtitle?.firstElementChild;

      expect(
        leadingSlot?.querySelector('[data-testid="worktree-drag-handle"]'),
      ).not.toBeNull();
      expect(
        subtitle?.querySelector('[data-testid="worktree-drag-handle"]'),
      ).toBeNull();
      expect(subtitleTrack?.children).toHaveLength(expectedChildren);
      expect(subtitleTrack?.lastElementChild?.textContent).toBe(worktreeName);
      expect(subtitleTrack?.className).toContain('gap-1.5');
      if (!subtitleTrack) throw new Error('subtitle track not found');
      return subtitleTrack;
    };

    assertAlignedSubtitle('plain', 'plain', 1);
    // The unread preview target lives on the right-side status dot at the
    // end of the label line — not in the leading slot and not in the
    // subtitle badge row.
    assertAlignedSubtitle('unread', 'unread', 1);
    const unreadRow = container.querySelector('[data-worktree-id="unread"]');
    expect(
      unreadRow?.querySelector(
        '[data-testid="worktree-row-leading-slot"] [data-testid="worktree-row-unread"]',
      ),
    ).toBeNull();
    expect(
      unreadRow?.querySelector('[data-testid="worktree-row-unread"]'),
    ).not.toBeNull();
  });

  describe('the project + (worktreeCreation)', () => {
    const addButtons = (): HTMLButtonElement[] =>
      Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          '[aria-label^="Create worktree for"]',
        ),
      );

    function renderProjects(
      props: Partial<WorkspacesSidebarSectionsProps> = {},
    ): void {
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={shell({
              workspaces: [
                {
                  localId: 'ws-ready',
                  name: 'Ready',
                  type: 'single-repo',
                },
                {
                  localId: 'ws-blocked',
                  name: 'Blocked',
                  type: 'single-repo',
                },
              ],
              worktrees: [
                {
                  localId: 'wt-ready',
                  workspaceLocalId: 'ws-ready',
                  branch: 'a',
                },
                {
                  localId: 'wt-blocked',
                  workspaceLocalId: 'ws-blocked',
                  branch: 'b',
                },
              ],
            })}
            capabilities={capabilities}
            selected={null}
            onSelectWorktree={jest.fn()}
            creationEnabled
            onCreateWorktree={jest.fn()}
            {...props}
          />,
        );
      });
    }

    it('is offered only for a project whose own client reports worktreeCreation', () => {
      renderProjects({
        capabilitiesFor: (localId) =>
          localId === 'ws-blocked' || localId === 'wt-blocked'
            ? { ...capabilities, worktreeCreation: false }
            : { ...capabilities, worktreeCreation: true },
      });

      expect(
        addButtons().map((button) => button.getAttribute('aria-label')),
      ).toEqual(['Create worktree for Ready']);
    });

    it('is default-deny: an unset worktreeCreation offers no +', () => {
      renderProjects({
        capabilities: { ...capabilities, worktreeCreation: undefined },
      });

      expect(addButtons()).toEqual([]);
    });

    it('still needs the host to enable creation', () => {
      renderProjects({
        creationEnabled: false,
        capabilities: { ...capabilities, worktreeCreation: true },
      });

      expect(addButtons()).toEqual([]);
    });
  });

  describe('item-group create affordances (worktreeCreation)', () => {
    const group = {
      id: 'grp-one',
      name: 'Release',
      color: 'neutral' as const,
      collapsed: false,
      memberIds: ['wt-one'],
    };
    const commands = {
      create: jest.fn(),
      update: jest.fn(),
      ungroup: jest.fn(),
      moveItem: jest.fn(),
      moveGroup: jest.fn(),
    };

    /** One grouped project; `type` picks a repository or a Cowork project. */
    function renderGrouped(
      type: 'single-repo' | 'cowork',
      props: Partial<WorkspacesSidebarSectionsProps> = {},
    ): jest.Mock {
      const onCreateWorktree = jest.fn(() => new Promise<never>(() => {}));
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={shell({
              workspaces: [
                {
                  localId: 'ws-grouped',
                  name: 'Grouped',
                  type,
                  layout: 'tree',
                  itemSortMode: 'manual',
                  itemGroups: [group],
                },
              ],
              worktrees: [
                {
                  localId: 'wt-one',
                  workspaceLocalId: 'ws-grouped',
                  branch: 'one',
                },
              ],
            })}
            capabilities={{
              ...capabilities,
              itemGrouping: true,
              worktreeCreation: true,
            }}
            selected={null}
            onSelectWorktree={jest.fn()}
            itemGroupCommandsFor={() => commands}
            creationEnabled
            onCreateWorktree={onCreateWorktree}
            {...props}
          />,
        );
      });
      return onCreateWorktree;
    }

    const headerCreate = (): HTMLButtonElement | null =>
      container.querySelector('[data-testid="sidebar-item-group-create"]');
    const open = (testId: string): void =>
      act(() =>
        (
          document.querySelector<HTMLElement>(`[data-testid="${testId}"]`) ??
          container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
        )?.click(),
      );
    const newItemsIn = (selector: string): number =>
      Array.from(
        document.querySelectorAll(`${selector} [role="menuitem"]`),
      ).filter((item) =>
        /^New (task|worktree) in group$/.test(item.textContent ?? ''),
      ).length;

    it('offers the header +, the menu item and the editor item for a project that creates', () => {
      renderGrouped('single-repo');

      expect(headerCreate()).not.toBeNull();
      open('sidebar-item-group-menu-trigger');
      expect(newItemsIn('[data-testid="sidebar-item-group-menu"]')).toBe(1);
      open('sidebar-item-group-edit');
      expect(newItemsIn('[data-testid="sidebar-item-group-editor"]')).toBe(1);
    });

    it('creates in the group from the header +', () => {
      const onCreateWorktree = renderGrouped('single-repo');

      act(() => headerCreate()?.click());

      expect(onCreateWorktree).toHaveBeenCalledWith('ws-grouped', 'grp-one');
    });

    it.each([
      [
        'a client that reports no worktreeCreation',
        {
          capabilities: {
            ...capabilities,
            itemGrouping: true,
            worktreeCreation: false,
          },
        },
      ],
      [
        'a client that leaves worktreeCreation unreported',
        {
          capabilities: {
            ...capabilities,
            itemGrouping: true,
            worktreeCreation: undefined,
          },
        },
      ],
      ['a host that does not enable creation', { creationEnabled: false }],
      [
        'a project whose host cannot take commands',
        { isWorkspaceCommandDisabled: (): boolean => true },
      ],
    ] as const)(
      'withholds every create affordance for %s, keeping the rest of the group',
      (_name, props) => {
        const onCreateWorktree = renderGrouped('single-repo', props);

        // The group itself still renders; only creation is withheld.
        expect(container.textContent).toContain('Release');
        expect(headerCreate()).toBeNull();

        if (props.isWorkspaceCommandDisabled === undefined) {
          // With commands available the menu and editor still open, minus New.
          open('sidebar-item-group-menu-trigger');
          expect(
            document.querySelector(
              '[data-testid="sidebar-item-group-ungroup"]',
            ),
          ).not.toBeNull();
          expect(newItemsIn('[data-testid="sidebar-item-group-menu"]')).toBe(0);
          open('sidebar-item-group-edit');
          expect(
            document.querySelector('[data-testid="sidebar-item-group-editor"]'),
          ).not.toBeNull();
          expect(newItemsIn('[data-testid="sidebar-item-group-editor"]')).toBe(
            0,
          );
        }
        expect(onCreateWorktree).not.toHaveBeenCalled();
      },
    );

    it('decides per project: a repository project without creation next to Cowork with its callback', () => {
      const onCreateWorktree = jest.fn(() => new Promise<never>(() => {}));
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={shell({
              workspaces: [
                {
                  localId: 'cloud:ws:repo',
                  name: 'Repository',
                  type: 'single-repo',
                  layout: 'tree',
                  backend: 'cloud',
                  itemSortMode: 'manual',
                  itemGroups: [{ ...group, id: 'grp-repo', memberIds: ['r1'] }],
                },
                {
                  localId: 'cloud:ws:cowork',
                  name: 'Cowork',
                  type: 'cowork',
                  layout: 'tree',
                  backend: 'cloud',
                  itemSortMode: 'manual',
                  itemGroups: [
                    { ...group, id: 'grp-cowork', memberIds: ['c1'] },
                  ],
                },
              ],
              worktrees: [
                {
                  localId: 'r1',
                  workspaceLocalId: 'cloud:ws:repo',
                  branch: 'feature/repo',
                  backend: 'cloud',
                },
                {
                  localId: 'c1',
                  workspaceLocalId: 'cloud:ws:cowork',
                  branch: 'cloud',
                  backend: 'cloud',
                },
              ],
            })}
            capabilities={{ ...capabilities, itemGrouping: true }}
            // The cloud adapter with the Cloud Git flag off: Cowork's
            // callback-backed creation stays, the repository's is not granted.
            capabilitiesFor={(localId) => ({
              ...capabilities,
              itemGrouping: true,
              worktreeCreation:
                localId === 'cloud:ws:cowork' || localId === 'c1',
            })}
            selected={null}
            onSelectWorktree={jest.fn()}
            itemGroupCommandsFor={() => commands}
            creationEnabled
            onCreateWorktree={onCreateWorktree}
          />,
        );
      });

      const creates = Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          '[data-testid="sidebar-item-group-create"]',
        ),
      );
      expect(
        creates.map((button) => button.getAttribute('aria-label')),
      ).toEqual(['New task in group']);
      expect(
        container
          .querySelector('[data-sidebar-item-group-id="grp-cowork"]')
          ?.contains(creates[0]),
      ).toBe(true);
      act(() => creates[0]?.click());
      expect(onCreateWorktree).toHaveBeenCalledWith(
        'cloud:ws:cowork',
        'grp-cowork',
      );
    });
  });

  it('dispatches once, renders pending, and selects a completed result', async () => {
    let resolveCommand:
      | ((value: { status: 'completed'; worktreeId: string }) => void)
      | undefined;
    const command = jest.fn(
      () =>
        new Promise<{ status: 'completed'; worktreeId: string }>((resolve) => {
          resolveCommand = resolve;
        }),
    );
    const onSelect = jest.fn();
    act(() => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={onSelect}
          creationEnabled
          onCreateWorktree={command}
        />,
      );
    });
    const add = container.querySelector<HTMLButtonElement>(
      '[aria-label="Create worktree for Workspace"]',
    );
    act(() => add?.click());
    act(() => add?.click());
    expect(command).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Creating worktree…');
    await act(async () => {
      resolveCommand?.({ status: 'completed', worktreeId: 'created' });
      await Promise.resolve();
    });
    expect(onSelect).toHaveBeenCalledWith('workspace', 'created');
    expect(container.textContent).not.toContain('Creating worktree…');
  });

  // A new worktree is inserted at the top of the unpinned rows, so its
  // placeholder has to sit there already or it jumps when the create resolves.
  it('renders the pending row first for a new worktree', () => {
    const command = jest.fn(
      () => new Promise<{ status: 'completed'; worktreeId: string }>(() => {}),
    );
    act(() => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={jest.fn()}
          creationEnabled
          onCreateWorktree={command}
        />,
      );
    });
    const add = container.querySelector<HTMLButtonElement>(
      '[aria-label="Create worktree for Workspace"]',
    );
    act(() => add?.click());

    const list = container.querySelector(
      '[data-workspace-id="workspace"] [role="list"]',
    );
    const placeholder = container.querySelector(
      '[data-testid="sidebar-worktree-creating-placeholder"]',
    );
    expect(list?.firstElementChild).toBe(placeholder);
    // The pending row is on the row grid it is about to become: its skeleton
    // dot sits in the leading slot, so the label starts on the title column.
    for (const className of ['flex', 'gap-1.5', 'pl-1.5', 'pr-2']) {
      expect(placeholder?.classList.contains(className)).toBe(true);
    }
    expect(placeholder?.classList.contains('px-3')).toBe(false);
    const slot = placeholder?.firstElementChild;
    expect(slot?.getAttribute('aria-hidden')).toBe('true');
    for (const className of ['h-5', 'w-5', 'shrink-0']) {
      expect(slot?.classList.contains(className)).toBe(true);
    }
    expect(
      slot?.querySelector(
        '[data-testid="sidebar-worktree-creating-icon-skeleton"]',
      ),
    ).not.toBeNull();
    expect(
      list?.lastElementChild?.querySelector('[data-worktree-id="visible"]'),
    ).not.toBeNull();
  });

  it('renders the pending row below pinned worktrees', () => {
    const command = jest.fn(
      () => new Promise<{ status: 'completed'; worktreeId: string }>(() => {}),
    );
    const pinnedState = shell({
      workspaces: [
        { localId: 'workspace', name: 'Workspace', type: 'single-repo' },
      ],
      worktrees: [
        {
          localId: 'pinned',
          workspaceLocalId: 'workspace',
          branch: 'pinned',
          pinned: true,
        },
        {
          localId: 'unpinned',
          workspaceLocalId: 'workspace',
          branch: 'unpinned',
        },
      ],
    });
    act(() => {
      root.render(
        <WorkspacesSidebarSections
          state={pinnedState}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={jest.fn()}
          creationEnabled
          onCreateWorktree={command}
        />,
      );
    });
    const add = container.querySelector<HTMLButtonElement>(
      '[aria-label="Create worktree for Workspace"]',
    );
    act(() => add?.click());

    const list = container.querySelector(
      '[data-workspace-id="workspace"] [role="list"]',
    );
    const children = Array.from(list?.children ?? []);
    expect(
      children[0]?.querySelector('[data-worktree-id="pinned"]'),
    ).not.toBeNull();
    expect(children[1]).toBe(
      container.querySelector(
        '[data-testid="sidebar-worktree-creating-placeholder"]',
      ),
    );
    expect(
      children[2]?.querySelector('[data-worktree-id="unpinned"]'),
    ).not.toBeNull();
  });

  it('selects the single new worktree from a pending snapshot', async () => {
    const command = jest.fn(() =>
      Promise.resolve({ status: 'pending' as const }),
    );
    const onSelect = jest.fn();
    const renderSections = (): void => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={onSelect}
          creationEnabled
          onCreateWorktree={command}
        />,
      );
    };
    act(renderSections);
    const add = container.querySelector<HTMLButtonElement>(
      '[aria-label="Create worktree for Workspace"]',
    );
    await act(async () => {
      add?.click();
      await Promise.resolve();
    });
    state = shell({
      ...state,
      worktrees: [
        ...state.worktrees,
        {
          localId: 'created',
          workspaceLocalId: 'workspace',
          branch: 'created',
        },
      ],
    });
    act(renderSections);
    expect(onSelect).toHaveBeenCalledWith('workspace', 'created');
    expect(container.textContent).not.toContain('Creating worktree…');
  });

  it('clears an ambiguous pending snapshot without selecting', async () => {
    const command = jest.fn(() =>
      Promise.resolve({ status: 'pending' as const }),
    );
    const onSelect = jest.fn();
    const renderSections = (): void => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={onSelect}
          creationEnabled
          onCreateWorktree={command}
        />,
      );
    };
    act(renderSections);
    const add = container.querySelector<HTMLButtonElement>(
      '[aria-label="Create worktree for Workspace"]',
    );
    await act(async () => {
      add?.click();
      await Promise.resolve();
    });
    state = shell({
      ...state,
      worktrees: [
        ...state.worktrees,
        {
          localId: 'created-a',
          workspaceLocalId: 'workspace',
          branch: 'created-a',
        },
        {
          localId: 'created-b',
          workspaceLocalId: 'workspace',
          branch: 'created-b',
        },
      ],
    });
    act(renderSections);
    expect(onSelect).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Creating worktree…');
  });

  it('clears pending and reports a rejected creation', async () => {
    const error = new Error('create failed');
    const command = jest.fn(async () => Promise.reject(error));
    const onCreationError = jest.fn();
    act(() => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={jest.fn()}
          onCreationError={onCreationError}
          creationEnabled
          onCreateWorktree={command}
        />,
      );
    });
    const add = container.querySelector<HTMLButtonElement>(
      '[aria-label="Create worktree for Workspace"]',
    );
    await act(async () => {
      add?.click();
      await Promise.resolve();
    });
    expect(onCreationError).toHaveBeenCalledWith('workspace', error);
    expect(container.textContent).not.toContain('Creating worktree…');
  });

  // REG-2817/REG-2819. Cloud workspaces project their chats into `worktrees`,
  // so they must render as an ordinary worktree tree. An earlier attempt
  // classified them `type: 'cowork'` ALONE to stop them looking repo-backed,
  // which routed them to the standalone-chats projection and made every cloud
  // chat vanish. REG-2817 bought time by keeping `type: 'single-repo'`; REG-2819
  // fixed it properly by splitting placement into its own `layout` axis, so
  // `type` can finally be honest.
  //
  // The assertions below are UNCHANGED across that flip — only the fixture's
  // shape moved. That is exactly what makes them a regression guard rather than
  // a restatement of the implementation.
  describe('cloud-backed projects (regression guard)', () => {
    function cloudState(): PortalSessionShellState {
      return shell({
        workspaces: [
          {
            localId: 'cloud:ws:ws-1',
            name: 'Cloud one',
            // Repoless (so `cowork`) but tree-shaped — the combination the
            // `type` union alone could not express.
            type: 'cowork',
            layout: 'tree',
            backend: 'cloud',
          },
        ],
        worktrees: [
          {
            localId: 'cloud:task:task-1',
            workspaceLocalId: 'cloud:ws:ws-1',
            branch: 'cloud',
            label: 'Cloud task',
            backend: 'cloud',
          },
        ],
      });
    }

    it('renders its chats under the project and never through the cowork slot', () => {
      const renderCoworkWorkspace = jest.fn(() => (
        <div data-testid="inline-cowork" />
      ));
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={cloudState()}
            capabilities={capabilities}
            selected={null}
            onSelectWorktree={jest.fn()}
            onCreateWorktree={jest.fn()}
            renderCoworkWorkspace={renderCoworkWorkspace}
          />,
        );
      });

      // The chat row is a worktree UNDER the workspace, not a standalone chat.
      const workspace = container.querySelector(
        '[data-workspace-id="cloud:ws:ws-1"]',
      );
      expect(workspace).not.toBeNull();
      expect(
        workspace?.querySelector('[data-worktree-id="cloud:task:task-1"]'),
      ).not.toBeNull();
      expect(container.textContent).toContain('Cloud task');
      // The cowork projection is what made them vanish.
      expect(renderCoworkWorkspace).not.toHaveBeenCalled();
      expect(
        container.querySelector('[data-testid="inline-cowork"]'),
      ).toBeNull();
    });

    it('shows session status without exposing the synthetic cloud branch', () => {
      const state = cloudState();
      const cloudWorktree = state.worktrees[0];
      if (cloudWorktree === undefined) {
        throw new Error('cloud fixture must include a session row');
      }
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={{
              ...state,
              worktrees: [{ ...cloudWorktree, hasUnread: true }],
            }}
            capabilities={capabilities}
            selected={null}
            onSelectWorktree={jest.fn()}
            onCreateWorktree={jest.fn()}
          />,
        );
      });

      const row = container.querySelector(
        '[data-worktree-id="cloud:task:task-1"]',
      );
      const title = row?.querySelector('p');
      expect(title?.textContent).toBe('Cloud task');
      expect(title?.getAttribute('title')).toBeNull();
      expect(
        row?.querySelector('[data-testid="worktree-row-unread"]'),
      ).not.toBeNull();
    });

    // The visible cost REG-2819 set out to remove: a cloud workspace is
    // repoless, so it must wear the cowork kind badge rather than claiming to
    // be a code workspace. Driven by `type` alone — no `backend` special-case.
    it('renders the cowork kind badge, with no backend special-case', () => {
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={cloudState()}
            capabilities={capabilities}
            selected={null}
            onSelectWorktree={jest.fn()}
            onCreateWorktree={jest.fn()}
          />,
        );
      });

      expect(
        container
          .querySelector('[data-workspace-id="cloud:ws:ws-1"]')
          ?.querySelector('[data-testid="workspace-kind-badge"]')
          ?.getAttribute('data-kind'),
      ).toBe('cowork');
    });

    it('uses chat terminology while creating a cloud cowork session', async () => {
      let resolveCommand:
        | ((value: { status: 'completed'; worktreeId: string }) => void)
        | undefined;
      const command = jest.fn(
        () =>
          new Promise<{ status: 'completed'; worktreeId: string }>(
            (resolve) => {
              resolveCommand = resolve;
            },
          ),
      );
      const onSelect = jest.fn();
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={cloudState()}
            capabilities={capabilities}
            selected={null}
            onSelectWorktree={onSelect}
            creationEnabled
            onCreateWorktree={command}
          />,
        );
      });

      const add = container.querySelector<HTMLButtonElement>(
        '[aria-label="Create chat for Cloud one"]',
      );
      expect(add).not.toBeNull();
      act(() => add?.click());
      act(() => add?.click());

      expect(command).toHaveBeenCalledTimes(1);
      const pending = container.querySelector('[role="status"]');
      expect(pending?.getAttribute('aria-label')).toBe('Creating chat');
      expect(pending?.textContent).toContain('Creating chat…');
      // Cowork chats are ordered newest-first, so the created chat arrives at
      // the TOP. The placeholder has to be there already or it visibly jumps
      // from the bottom of the list to the top when the create resolves.
      const list = container.querySelector(
        '[data-workspace-id="cloud:ws:ws-1"] [role="list"]',
      );
      expect(list?.firstElementChild).toBe(
        container.querySelector(
          '[data-testid="sidebar-worktree-creating-placeholder"]',
        ),
      );
      expect(
        list?.lastElementChild?.querySelector('[data-worktree-id]'),
      ).not.toBeNull();

      await act(async () => {
        resolveCommand?.({
          status: 'completed',
          worktreeId: 'cloud:task:created',
        });
        await Promise.resolve();
      });

      expect(onSelect).toHaveBeenCalledWith(
        'cloud:ws:ws-1',
        'cloud:task:created',
      );
      expect(container.textContent).not.toContain('Creating chat…');
    });

    // Both repoless kinds in one list, separated only by layout: the desktop
    // one goes to the flat projection, the cloud one stays a tree. This is the
    // combination that had no representation before the layout axis existed.
    it('splits desktop cowork from cloud by layout, not by type', () => {
      const renderCoworkWorkspace = jest.fn(
        ({ workspace }: CoworkWorkspaceSlotContext) => (
          <div data-testid={`inline-cowork-${workspace.localId}`} />
        ),
      );
      const mixed = shell({
        workspaces: [
          ...cloudState().workspaces,
          {
            localId: 'ws-cowork',
            name: 'Desktop cowork',
            type: 'cowork',
            layout: 'flat',
            backend: 'remote-control',
          },
        ],
        worktrees: cloudState().worktrees,
      });
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={mixed}
            capabilities={capabilities}
            selected={null}
            onSelectWorktree={jest.fn()}
            onCreateWorktree={jest.fn()}
            renderCoworkWorkspace={renderCoworkWorkspace}
          />,
        );
      });

      // Only the flat one is handed to the cowork slot...
      expect(renderCoworkWorkspace).toHaveBeenCalledTimes(1);
      expect(
        container.querySelector('[data-testid="inline-cowork-ws-cowork"]'),
      ).not.toBeNull();
      // ...and the cloud one still renders its rows as a tree.
      expect(
        container
          .querySelector('[data-workspace-id="cloud:ws:ws-1"]')
          ?.querySelector('[data-worktree-id="cloud:task:task-1"]'),
      ).not.toBeNull();
      // Both wear the same badge, because both genuinely are repoless.
      expect(
        Array.from(
          container.querySelectorAll('[data-testid="workspace-kind-badge"]'),
        ).map((badge) => badge.getAttribute('data-kind')),
      ).toEqual(['cowork']);
    });

    it('pips each row of a unified list with its own backend', () => {
      const mixed = shell({
        workspaces: [
          ...cloudState().workspaces,
          {
            localId: 'ws-local',
            name: 'Desktop one',
            type: 'single-repo',
            backend: 'remote-control',
          },
        ],
        worktrees: [
          ...cloudState().worktrees,
          {
            localId: 'wt-local',
            workspaceLocalId: 'ws-local',
            branch: 'feature',
            backend: 'remote-control',
          },
        ],
      });
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={mixed}
            capabilities={capabilities}
            selected={null}
            onSelectWorktree={jest.fn()}
            onCreateWorktree={jest.fn()}
          />,
        );
      });

      const pipFor = (workspaceLocalId: string): string | null | undefined =>
        container
          .querySelector(`[data-workspace-id="${workspaceLocalId}"]`)
          ?.querySelector('[data-testid="workspace-backend-pip"]')
          ?.getAttribute('data-backend');
      expect(pipFor('cloud:ws:ws-1')).toBe('cloud');
      expect(pipFor('ws-local')).toBe('remote-control');
      // One list, not two sections.
      expect(
        container.querySelectorAll('[data-testid="workspace-backend-pip"]'),
      ).toHaveLength(2);
    });

    // The rendered sequence comes from `compareWorkspaces` (order, then name,
    // then localId) — NOT from snapshot array position. A host composing two
    // backends must therefore hand out one global order; when it does not, rows
    // with colliding `order` values interleave on the name tie-break. This pins
    // the rule the web merge (`chat-shell-state.ts`) depends on.
    it('renders rows by order, so colliding orders interleave the backends', () => {
      const colliding = shell({
        workspaces: [
          {
            localId: 'cloud:ws:w1',
            name: 'Zeta',
            type: 'single-repo',
            backend: 'cloud',
            order: 0,
          },
          {
            localId: 'ws-a',
            name: 'Alpha',
            type: 'single-repo',
            backend: 'remote-control',
            order: 0,
          },
        ],
        worktrees: [],
      });
      const renderOrder = (
        state: PortalSessionShellState,
      ): readonly (string | null)[] => {
        act(() => {
          root.render(
            <WorkspacesSidebarSections
              state={state}
              capabilities={capabilities}
              selected={null}
              onSelectWorktree={jest.fn()}
              onCreateWorktree={jest.fn()}
            />,
          );
        });
        return Array.from(
          container.querySelectorAll('[data-workspace-id]'),
        ).map((row) => row.getAttribute('data-workspace-id'));
      };

      // Colliding orders: the desktop row wins the name tie-break and jumps
      // ahead of the cloud row, despite coming second in the array.
      expect(renderOrder(colliding)).toEqual(['ws-a', 'cloud:ws:w1']);

      // Offset orders — what the merge now produces — keep the blocks intact.
      expect(
        renderOrder(
          shell({
            ...colliding,
            workspaces: [
              colliding.workspaces[0],
              { ...colliding.workspaces[1], order: 1 },
            ],
          }),
        ),
      ).toEqual(['cloud:ws:w1', 'ws-a']);
    });

    it('derives the pip from the rows, not the project record', () => {
      // The workspace record and its rows disagree: rows win, because a mixed
      // workspace has to be answerable per row.
      const drifted = shell({
        workspaces: [
          {
            localId: 'ws-1',
            name: 'Workspace',
            type: 'single-repo',
            backend: 'remote-control',
          },
        ],
        worktrees: [
          {
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'cloud',
            backend: 'cloud',
          },
        ],
      });
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={drifted}
            capabilities={capabilities}
            selected={null}
            onSelectWorktree={jest.fn()}
            onCreateWorktree={jest.fn()}
          />,
        );
      });
      expect(
        container
          .querySelector('[data-testid="workspace-backend-pip"]')
          ?.getAttribute('data-backend'),
      ).toBe('cloud');
    });

    it('renders no pip for a host that fronts a single backend', () => {
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={state}
            capabilities={capabilities}
            selected={null}
            onSelectWorktree={jest.fn()}
            onCreateWorktree={jest.fn()}
          />,
        );
      });
      expect(
        container.querySelector('[data-testid="workspace-backend-pip"]'),
      ).toBeNull();
    });
  });

  it('renders a cowork project through the inline project slot', () => {
    state = shell({
      workspaces: [{ localId: 'cowork', name: 'Cowork', type: 'cowork' }],
    });
    act(() => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={(): void => {}}
          creationEnabled
          onCreateWorktree={jest.fn()}
          renderCoworkWorkspace={({ workspace }) => (
            <div data-testid="inline-cowork">{workspace.name}</div>
          )}
        />,
      );
    });
    expect(
      container.querySelector('[data-workspace-id="cowork"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="inline-cowork"]')).not.toBe(
      null,
    );
  });

  it('passes complete embedding and sortable context to the cowork slot', () => {
    const renderCoworkWorkspace = jest.fn(
      ({ workspace, hasFollowingWorkspace }: CoworkWorkspaceSlotContext) => (
        <div data-testid="inline-cowork">
          {workspace.name}:{String(hasFollowingWorkspace)}
        </div>
      ),
    );
    const wrapWorkspaceSection = jest.fn(
      (_context: WorkspaceDndWrapperContext, section: ReactNode): ReactNode =>
        section,
    );
    const onSelectWorkspace = jest.fn();
    const onWorkspaceCollapsedChange = jest.fn();
    state = shell({
      workspaces: [
        {
          localId: 'cowork',
          name: 'Cowork',
          type: 'cowork',
          collapsed: true,
          order: 7,
        },
        { localId: 'code', name: 'Code', type: 'single-repo' },
      ],
    });
    act(() => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={{
            ...capabilities,
            workspaceReordering: true,
            worktreeReordering: true,
          }}
          selected={{ kind: 'workspace', workspaceLocalId: 'cowork' }}
          onSelectWorkspace={onSelectWorkspace}
          onSelectWorktree={jest.fn()}
          onCreateWorktree={jest.fn()}
          onWorkspaceCollapsedChange={onWorkspaceCollapsedChange}
          renderCoworkWorkspace={renderCoworkWorkspace}
          wrapWorkspaceSection={wrapWorkspaceSection}
        />,
      );
    });
    const context = renderCoworkWorkspace.mock.calls[0][0];
    expect(context).toMatchObject({
      workspace: {
        localId: 'cowork',
        collapsed: true,
        order: 7,
      },
      selected: true,
      hidden: false,
      sortable: true,
      index: 1,
      hasFollowingWorkspace: false,
    });
    act(() => context.onSelect?.());
    expect(onSelectWorkspace).toHaveBeenCalledWith('cowork');
    act(() => context.onCollapsedChange?.(false));
    expect(onWorkspaceCollapsedChange).toHaveBeenCalledWith('cowork', false);
    const coworkCall = wrapWorkspaceSection.mock.calls.find(
      (call) => call[0].workspace.localId === 'cowork',
    );
    if (!coworkCall) throw new Error('cowork wrapper call missing');
    const wrapperContext = coworkCall[0];
    expect(wrapperContext.workspace.localId).toBe('cowork');
    expect(wrapperContext.sortable).toBe(true);
  });

  it('renders the host archived navigation instead of the disclosure', () => {
    act(() =>
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={jest.fn()}
          onCreateWorktree={jest.fn()}
          archivedCount={() => 2}
          renderArchivedSection={(workspaceId) => (
            <span data-testid="custom-archived">{workspaceId}</span>
          )}
        />,
      ),
    );
    expect(
      container.querySelector('[data-testid="custom-archived"]')?.textContent,
    ).toBe('workspace');
    expect(
      container.querySelector('[data-testid="archived-worktrees-section"]'),
    ).toBeNull();
  });

  it('keeps archived worktrees default-off', () => {
    act(() => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={jest.fn()}
          onCreateWorktree={jest.fn()}
        />,
      );
    });
    expect(
      container.querySelector('[data-testid="archived-worktrees-section"]'),
    ).toBeNull();
  });

  it('lazy-loads archived worktrees and wires disclosure and entry callbacks', async () => {
    let resolveLoad: (() => void) | undefined;
    const onLoadArchived = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const onArchivedExpandedChange = jest.fn();
    const onViewArchived = jest.fn();
    const onRestoreArchived = jest.fn();
    const onDeleteArchived = jest.fn();
    const render = (
      expanded: boolean,
      entries: readonly ArchivedWorktreeEntry[] | undefined,
    ): void => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={jest.fn()}
          onCreateWorktree={jest.fn()}
          archivedCount={() => 1}
          archivedEntries={() => entries}
          archivedExpanded={() => expanded}
          onArchivedExpandedChange={onArchivedExpandedChange}
          onLoadArchived={onLoadArchived}
          onViewArchived={onViewArchived}
          onRestoreArchived={onRestoreArchived}
          onDeleteArchived={onDeleteArchived}
          testIds={{
            archivedWorktreesToggle: (workspaceId) =>
              `archives-toggle-${workspaceId}`,
            archivedWorktreeRow: (_workspaceId, entryId) =>
              `archive-row-${entryId}`,
          }}
        />,
      );
    };
    act(() => render(false, undefined));
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="archives-toggle-workspace"]',
    );
    expect(toggle?.textContent).toContain('Archived (1)');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    act(() => toggle?.click());
    expect(onArchivedExpandedChange).toHaveBeenCalledWith('workspace', true);

    await act(async () => {
      render(true, undefined);
      await Promise.resolve();
    });
    expect(onLoadArchived).toHaveBeenCalledWith('workspace');
    expect(container.querySelector('[aria-label="Loading"]')).not.toBeNull();
    act(() =>
      render(true, [
        {
          id: 'archived',
          title: 'Feature branch',
          subtitle: 'feature/archive',
          timestamp: 'Jul 31',
          locked: true,
        },
      ]),
    );
    const row = container.querySelector<HTMLButtonElement>(
      '[data-testid="archive-row-archived"]',
    );
    expect(row?.textContent).toContain('Feature branch');
    expect(row?.textContent).toContain('feature/archive');
    expect(row?.textContent).toContain('Jul 31');
    expect(row?.getAttribute('data-archived-worktree-id')).toBe('archived');
    expect(row?.hasAttribute('data-worktree-id')).toBe(false);
    // The fallback archive list speaks the rail's row vocabulary: the row
    // radius and list-row hover, sidebar text, and the shared disclosure
    // chevron, rather than its own 8px corners, 13px type, and ink tints.
    const rowFrame = row?.parentElement;
    expect(rowFrame?.className).toContain('rounded-row');
    expect(rowFrame?.className).toContain('hover:bg-subtle');
    expect(rowFrame?.className).not.toContain('fg-primary/[0.04]');
    expect(row?.querySelector('.truncate')?.className).toContain('text-s');
    expect(row?.innerHTML).not.toContain('fg-primary/75');
    expect(toggle?.className).toContain('text-s');
    expect(toggle?.querySelector('svg')?.getAttribute('style')).toContain(
      'width: 14px',
    );
    expect(
      container.querySelector(
        '[data-testid="archived-worktree-lock-archived"]',
      ),
    ).not.toBeNull();
    act(() => row?.click());
    expect(onViewArchived).toHaveBeenCalledWith('workspace', 'archived');
    await act(async () => {
      resolveLoad?.();
      await Promise.resolve();
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Restore Feature branch"]',
        )
        ?.click();
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Delete Feature branch"]',
        )
        ?.click();
    });
    expect(onRestoreArchived).toHaveBeenCalledWith('workspace', 'archived');
    expect(onDeleteArchived).toHaveBeenCalledWith('workspace', 'archived');
    // The delete control warms to the destructive ink under the pointer;
    // `hover:text-danger` was never a role the stylesheet generates.
    const deleteTokens =
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Delete Feature branch"]',
        )
        ?.className.split(/\s+/) ?? [];
    expect(deleteTokens).toContain('hover:fg-destructive');
    expect(deleteTokens.some((token) => token.includes('danger'))).toBe(false);
  });

  it('settles a failed controlled archived load and retries after collapse', async () => {
    let expanded = true;
    const onLoadArchived = jest
      .fn<Promise<void>, [string]>()
      .mockRejectedValueOnce(new Error('load failed'))
      .mockResolvedValue(undefined);
    const render = (): void => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={jest.fn()}
          onCreateWorktree={jest.fn()}
          archivedCount={() => 1}
          archivedEntries={() => undefined}
          archivedExpanded={() => expanded}
          onArchivedExpandedChange={(_workspaceId, nextExpanded) => {
            expanded = nextExpanded;
          }}
          onLoadArchived={onLoadArchived}
          testIds={{
            archivedWorktreesToggle: () => 'archives-toggle',
          }}
        />,
      );
    };

    await act(async () => {
      render();
      await Promise.resolve();
    });
    expect(onLoadArchived).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[aria-label="Loading"]')).toBeNull();

    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="archives-toggle"]',
    );
    act(() => toggle?.click());
    act(() => render());
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');

    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="archives-toggle"]')
        ?.click(),
    );
    await act(async () => {
      render();
      await Promise.resolve();
    });
    expect(onLoadArchived).toHaveBeenCalledTimes(2);
  });

  it('clears a pending archived load when controlled expansion collapses', async () => {
    let expanded = true;
    let resolveLoad: (() => void) | undefined;
    const onLoadArchived = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const render = (): void => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={jest.fn()}
          onCreateWorktree={jest.fn()}
          archivedCount={() => 1}
          archivedEntries={() => undefined}
          archivedExpanded={() => expanded}
          onLoadArchived={onLoadArchived}
        />,
      );
    };

    await act(async () => {
      render();
      await Promise.resolve();
    });
    expect(container.querySelector('[aria-label="Loading"]')).not.toBeNull();

    expanded = false;
    act(() => render());
    expect(container.querySelector('[aria-label="Loading"]')).toBeNull();
    await act(async () => {
      resolveLoad?.();
      await Promise.resolve();
    });

    expanded = true;
    await act(async () => {
      render();
      await Promise.resolve();
    });
    expect(onLoadArchived).toHaveBeenCalledTimes(2);
  });

  it('does not expose archived entries as sortable worktree rows', () => {
    const wrappedIds: string[] = [];
    act(() => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={{
            ...capabilities,
            workspaceReordering: true,
            worktreeReordering: true,
          }}
          selected={null}
          onSelectWorktree={jest.fn()}
          onCreateWorktree={jest.fn()}
          archivedCount={() => 1}
          archivedEntries={() => [
            { id: 'archived', title: 'Archived worktree' },
          ]}
          archivedExpanded={() => true}
          wrapWorktreeRow={(context, row) => {
            wrappedIds.push(context.worktree.localId);
            return row;
          }}
        />,
      );
    });
    expect(wrappedIds).toEqual(['visible']);
    expect(wrappedIds).not.toContain('archived');
  });

  it('does not expose a removing worktree to sorting', () => {
    state = shell({
      ...state,
      worktrees: [
        state.worktrees[0],
        {
          localId: 'neighbor',
          workspaceLocalId: 'workspace',
          branch: 'neighbor',
        },
      ],
    });
    const wrapWorktreeRow = jest.fn(
      (_context: WorktreeRowSlotContext, row: ReactNode): ReactNode => row,
    );
    const wrapWorktreeList = jest.fn(
      (_context: WorktreeDndWrapperContext, list: ReactNode): ReactNode => list,
    );
    act(() => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={{ ...capabilities, worktreeReordering: true }}
          selected={null}
          onSelectWorktree={jest.fn()}
          isWorktreeRemovalInProgress={(_workspaceId, worktreeId) =>
            worktreeId === 'visible'
          }
          wrapWorktreeRow={wrapWorktreeRow}
          wrapWorktreeList={wrapWorktreeList}
          renderWorktreeDragHandle={({ sortable }) =>
            sortable ? <button data-testid="worktree-drag-handle" /> : null
          }
        />,
      );
    });
    expect(
      wrapWorktreeRow.mock.calls.map(([context]) => context.worktree.localId),
    ).toEqual(['neighbor']);
    expect(wrapWorktreeList.mock.calls[0]?.[0].sortableWorktreeIds).toEqual([
      'neighbor',
    ]);
    expect(
      container.querySelectorAll('[data-testid="worktree-drag-handle"]'),
    ).toHaveLength(1);
  });

  it('returns null for a cowork-only snapshot without an inline renderer', () => {
    state = shell({
      workspaces: [{ localId: 'cowork', name: 'Cowork', type: 'cowork' }],
    });
    act(() => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={(): void => {}}
          creationEnabled={false}
          onCreateWorktree={jest.fn()}
        />,
      );
    });
    expect(container.innerHTML).toBe('');
  });

  it('wraps only visible sortable worktree rows', () => {
    const wrappedIds: string[] = [];
    act(() => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={{
            ...capabilities,
            workspaceReordering: true,
            worktreeReordering: true,
          }}
          selected={null}
          onSelectWorktree={jest.fn()}
          creationEnabled
          onCreateWorktree={jest.fn()}
          wrapWorktreeRow={(context, row) => {
            wrappedIds.push(context.worktree.localId);
            return (
              <div
                key={context.worktree.localId}
                className="min-w-0"
                data-testid={`wrapped-${context.worktree.localId}`}
              >
                {row}
              </div>
            );
          }}
        />,
      );
    });
    expect(new Set(wrappedIds)).toEqual(new Set(['visible']));
    expect(container.querySelector('[data-testid="wrapped-visible"]')).not.toBe(
      null,
    );
    expect(
      container.querySelector('[data-testid="wrapped-hidden"]'),
    ).toBeNull();
  });

  // A pinned copy is the SAME worktree id as the row already in the list. Left
  // sortable, both call `useSortable({ id })` inside one `SortableContext`,
  // and dnd-kit resolves a duplicate id to a single registration — the flow
  // row's drag handle stops responding once a copy mounts. The copies are
  // portaled outside the sortable list, so they can never be drop targets
  // anyway; the only thing registering them can do is break the original.
  it('never wraps a pinned copy as a sortable row', () => {
    const sidebarRoot = document.createElement('div');
    sidebarRoot.dataset.testid = 'app-sidebar';
    for (const band of ['top', 'bottom']) {
      const group = document.createElement('div');
      group.setAttribute(`data-sidebar-selected-pin-${band}`, '');
      for (const part of ['header', 'row']) {
        const host = document.createElement('div');
        host.setAttribute('data-sidebar-selected-pin-part', part);
        group.appendChild(host);
      }
      sidebarRoot.appendChild(group);
    }
    const mount = document.createElement('div');
    sidebarRoot.appendChild(mount);
    document.body.appendChild(sidebarRoot);
    const pinnedRoot = createRoot(mount);

    const wrappedIds: string[] = [];
    try {
      act(() => {
        pinnedRoot.render(
          <WorkspacesSidebarSections
            state={state}
            capabilities={{
              ...capabilities,
              workspaceReordering: true,
              worktreeReordering: true,
            }}
            selected={{
              kind: 'worktree',
              workspaceLocalId: 'workspace',
              worktreeLocalId: 'visible',
            }}
            onSelectWorktree={jest.fn()}
            creationEnabled
            onCreateWorktree={jest.fn()}
            wrapWorktreeRow={(context, row) => {
              wrappedIds.push(context.worktree.localId);
              return row;
            }}
          />,
        );
      });

      // The pin hosts must actually have been claimed, or this asserts nothing.
      expect(
        sidebarRoot.querySelectorAll(
          '[data-testid="worktree-row-pin-top"], [data-testid$="-pin-top"]',
        ).length,
      ).toBeGreaterThan(0);
      expect(wrappedIds).toEqual(['visible']);
    } finally {
      act(() => pinnedRoot.unmount());
      sidebarRoot.remove();
    }
  });

  // Global automation selectors (`getByTestId('worktree-row-graph-badge')`)
  // must resolve to the one in-flow row. Pinned copies render the same row,
  // so their badge ids carry the pin surface, as desktop's legacy copies did.
  it("suffixes a pinned copy's badge ids so bare ids resolve to the flow row", () => {
    const sidebarRoot = document.createElement('div');
    sidebarRoot.dataset.testid = 'app-sidebar';
    for (const band of ['top', 'bottom']) {
      const group = document.createElement('div');
      group.setAttribute(`data-sidebar-selected-pin-${band}`, '');
      for (const part of ['header', 'row']) {
        const host = document.createElement('div');
        host.setAttribute('data-sidebar-selected-pin-part', part);
        group.appendChild(host);
      }
      sidebarRoot.appendChild(group);
    }
    const mount = document.createElement('div');
    sidebarRoot.appendChild(mount);
    document.body.appendChild(sidebarRoot);
    const pinnedRoot = createRoot(mount);
    try {
      act(() => {
        pinnedRoot.render(
          <WorkspacesSidebarSections
            state={state}
            capabilities={capabilities}
            selected={{
              kind: 'worktree',
              workspaceLocalId: 'workspace',
              worktreeLocalId: 'visible',
            }}
            onSelectWorktree={jest.fn()}
            onCreateWorktree={jest.fn()}
            useWorktreeRowOverrides={() => ({ graphBuildStatus: 'building' })}
          />,
        );
      });
      expect(
        sidebarRoot.querySelectorAll(
          '[data-testid="worktree-row-graph-badge-pin-top"]',
        ).length,
      ).toBeGreaterThan(0);
      expect(
        sidebarRoot.querySelectorAll(
          '[data-testid="worktree-row-graph-badge"]',
        ),
      ).toHaveLength(1);
    } finally {
      act(() => pinnedRoot.unmount());
      sidebarRoot.remove();
    }
  });

  // The rail's scroll sync locates the selected row by this mark and measures
  // its flow offset. A pinned copy carrying it too gives the sync a second,
  // contradictory answer that sits at a fixed viewport position — so the pin
  // state would be computed from the pin's own geometry rather than the row's.
  it('leaves the selection mark and dialogs on the flow row alone', () => {
    const sidebarRoot = document.createElement('div');
    sidebarRoot.dataset.testid = 'app-sidebar';
    for (const band of ['top', 'bottom']) {
      const group = document.createElement('div');
      group.setAttribute(`data-sidebar-selected-pin-${band}`, '');
      for (const part of ['header', 'row']) {
        const host = document.createElement('div');
        host.setAttribute('data-sidebar-selected-pin-part', part);
        group.appendChild(host);
      }
      sidebarRoot.appendChild(group);
    }
    const mount = document.createElement('div');
    sidebarRoot.appendChild(mount);
    document.body.appendChild(sidebarRoot);
    const pinnedRoot = createRoot(mount);

    let dialogRenders = 0;
    try {
      act(() => {
        pinnedRoot.render(
          <WorkspacesSidebarSections
            state={state}
            capabilities={capabilities}
            selected={{
              kind: 'worktree',
              workspaceLocalId: 'workspace',
              worktreeLocalId: 'visible',
            }}
            onSelectWorktree={jest.fn()}
            creationEnabled
            onCreateWorktree={jest.fn()}
            renderWorktreeDialogs={(): ReactNode => {
              dialogRenders += 1;
              return null;
            }}
          />,
        );
      });

      // Copies landed (otherwise the assertions below are vacuous)...
      expect(
        sidebarRoot.querySelectorAll('[data-testid$="-pin-top"]').length,
      ).toBeGreaterThan(0);
      // ...but exactly one element answers the sync's selection query, and it
      // is the one in flow rather than one of the pinned copies.
      const marked = sidebarRoot.querySelectorAll(
        '[data-sidebar-selected-item]',
      );
      expect(marked).toHaveLength(1);
      expect(mount.contains(marked[0])).toBe(true);
      // One user action, one dialog set — not one per pinned surface.
      expect(dialogRenders).toBe(1);
    } finally {
      act(() => pinnedRoot.unmount());
      sidebarRoot.remove();
    }
  });

  it('does not render sibling rows when a pipeline badge is hovered', () => {
    const popoverRenders = new Map<string, number>();
    state = shell({
      workspaces: [
        { localId: 'workspace', name: 'Workspace', type: 'single-repo' },
      ],
      worktrees: ['first', 'second'].map((localId) => ({
        localId,
        workspaceLocalId: 'workspace',
        branch: localId,
        pipelineStatus: 'running' as const,
      })),
    });

    act(() => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={jest.fn()}
          onCreateWorktree={jest.fn()}
          renderPipelinePopover={(context) => {
            popoverRenders.set(
              context.worktree.localId,
              (popoverRenders.get(context.worktree.localId) ?? 0) + 1,
            );
            return context.anchorRect ? <span>Pipeline popover</span> : null;
          }}
        />,
      );
    });

    const badges = container.querySelectorAll<HTMLElement>(
      '[data-testid="worktree-row-working-pipeline"]',
    );
    expect(badges).toHaveLength(2);
    const siblingRendersBefore = popoverRenders.get('second');

    act(() => {
      badges[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    expect(container.textContent).toContain('Pipeline popover');
    expect(popoverRenders.get('first')).toBeGreaterThan(1);
    expect(popoverRenders.get('second')).toBe(siblingRendersBefore);
  });

  it('moves keyboard focus from a pipeline badge into its popover list', () => {
    jest.useFakeTimers();
    state = shell({
      workspaces: [
        { localId: 'workspace', name: 'Workspace', type: 'single-repo' },
      ],
      worktrees: [
        {
          localId: 'visible',
          workspaceLocalId: 'workspace',
          branch: 'main',
          pipelineStatus: 'running',
        },
      ],
    });

    try {
      act(() => {
        root.render(
          <>
            <WorkspacesSidebarSections
              state={state}
              capabilities={capabilities}
              selected={null}
              onSelectWorktree={jest.fn()}
              onCreateWorktree={jest.fn()}
              renderPipelinePopover={(context) =>
                context.anchorRect ? (
                  <div
                    id={context.popoverListId}
                    tabIndex={0}
                    ref={(node) => {
                      if (node) context.onPopoverListReady(node);
                    }}
                    onFocus={context.onPopoverFocus}
                    onBlur={context.onPopoverBlur}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') context.onPopoverDismiss();
                    }}
                  >
                    Pipeline popover
                  </div>
                ) : null
              }
            />
            <button type="button">After popover</button>
          </>,
        );
      });

      const badge = container.querySelector<HTMLElement>(
        '[aria-label="Pipeline running"][tabindex="0"]',
      );
      if (!badge) throw new Error('pipeline badge not rendered');

      act(() => badge.focus());
      const listId = badge.getAttribute('aria-controls');
      const list = listId ? document.getElementById(listId) : null;
      expect(list).not.toBeNull();

      act(() => {
        badge.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
        );
      });
      expect(document.activeElement).toBe(list);

      act(() => {
        list?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
      expect(document.activeElement).toBe(badge);
      expect(container.textContent).not.toContain('Pipeline popover');

      act(() => {
        badge.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
      });
      expect(container.textContent).toContain('Pipeline popover');

      act(() => {
        badge.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
      });
      expect(container.textContent).not.toContain('Pipeline popover');

      act(() => {
        badge.dispatchEvent(
          new KeyboardEvent('keydown', { key: ' ', bubbles: true }),
        );
      });
      expect(container.textContent).toContain('Pipeline popover');

      act(() => {
        badge.dispatchEvent(
          new KeyboardEvent('keydown', { key: ' ', bubbles: true }),
        );
      });
      expect(container.textContent).not.toContain('Pipeline popover');

      act(() => {
        badge.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
        );
      });
      expect(container.textContent).toContain('Pipeline popover');
      expect(document.activeElement?.textContent).toBe('Pipeline popover');

      act(() => jest.advanceTimersByTime(500));
      expect(container.textContent).toContain('Pipeline popover');
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears pending list focus when pointer dismissal closes a short list', () => {
    jest.useFakeTimers();
    let scrollable = false;
    state = shell({
      workspaces: [
        { localId: 'workspace', name: 'Workspace', type: 'single-repo' },
      ],
      worktrees: [
        {
          localId: 'visible',
          workspaceLocalId: 'workspace',
          branch: 'main',
          pipelineStatus: 'running',
        },
      ],
    });

    const renderSections = (): void => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={jest.fn()}
          onCreateWorktree={jest.fn()}
          renderPipelinePopover={(context) =>
            context.anchorRect ? (
              <div
                id={context.popoverListId}
                tabIndex={scrollable ? 0 : -1}
                ref={(node) => {
                  if (node && scrollable) context.onPopoverListReady(node);
                }}
              >
                Pipeline popover
              </div>
            ) : null
          }
        />,
      );
    };

    try {
      act(renderSections);
      let badge = container.querySelector<HTMLElement>(
        '[aria-label="Pipeline running"][tabindex="0"]',
      );
      if (!badge) throw new Error('pipeline badge not rendered');

      act(() => {
        badge.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        badge.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
        );
        badge.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
        jest.advanceTimersByTime(500);
      });
      expect(container.textContent).not.toContain('Pipeline popover');

      scrollable = true;
      act(renderSections);
      badge = container.querySelector<HTMLElement>(
        '[aria-label="Pipeline running"][tabindex="0"]',
      );
      if (!badge) throw new Error('pipeline badge not rendered');
      act(() => {
        badge.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      expect(document.activeElement?.textContent).not.toBe('Pipeline popover');
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not latch the pipeline popover open from pointer focus', () => {
    jest.useFakeTimers();
    state = shell({
      workspaces: [
        { localId: 'workspace', name: 'Workspace', type: 'single-repo' },
      ],
      worktrees: [
        {
          localId: 'visible',
          workspaceLocalId: 'workspace',
          branch: 'main',
          pipelineStatus: 'running',
        },
      ],
    });

    try {
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={state}
            capabilities={capabilities}
            selected={null}
            onSelectWorktree={jest.fn()}
            onCreateWorktree={jest.fn()}
            renderPipelinePopover={(context) =>
              context.anchorRect ? <div>Pipeline popover</div> : null
            }
          />,
        );
      });

      const badge = container.querySelector<HTMLElement>(
        '[aria-label="Pipeline running"][tabindex="0"]',
      );
      if (!badge) throw new Error('pipeline badge not rendered');

      const pointerDown = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        badge.dispatchEvent(pointerDown);
        if (!pointerDown.defaultPrevented) badge.focus();
        badge.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
        jest.advanceTimersByTime(500);
      });
      expect(container.textContent).not.toContain('Pipeline popover');
    } finally {
      jest.useRealTimers();
    }
  });

  it('toggles a pipeline disclosure on synthetic click without selecting the row', () => {
    const onSelectWorktree = jest.fn();
    state = shell({
      workspaces: [
        { localId: 'workspace', name: 'Workspace', type: 'single-repo' },
      ],
      worktrees: [
        {
          localId: 'visible',
          workspaceLocalId: 'workspace',
          branch: 'main',
          pipelineStatus: 'running',
        },
      ],
    });

    act(() => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={onSelectWorktree}
          onCreateWorktree={jest.fn()}
          renderPipelinePopover={(context) =>
            context.anchorRect ? <div>Pipeline popover</div> : null
          }
        />,
      );
    });

    const badge = container.querySelector<HTMLElement>(
      '[aria-label="Pipeline running"][tabindex="0"]',
    );
    if (!badge) throw new Error('pipeline badge not rendered');

    act(() => {
      badge.dispatchEvent(
        new MouseEvent('click', { bubbles: true, detail: 0 }),
      );
    });
    expect(container.textContent).toContain('Pipeline popover');
    expect(onSelectWorktree).not.toHaveBeenCalled();

    act(() => {
      badge.dispatchEvent(
        new MouseEvent('click', { bubbles: true, detail: 0 }),
      );
    });
    expect(container.textContent).not.toContain('Pipeline popover');
    expect(onSelectWorktree).not.toHaveBeenCalled();

    act(() => {
      badge.dispatchEvent(
        new MouseEvent('click', { bubbles: true, detail: 1 }),
      );
    });
    expect(container.textContent).not.toContain('Pipeline popover');
    expect(onSelectWorktree).toHaveBeenCalledTimes(1);
  });

  it('does not update or invoke callbacks after creation unmounts', async () => {
    let resolveCommand:
      | ((value: { status: 'completed'; worktreeId: string }) => void)
      | undefined;
    const command = jest.fn(
      () =>
        new Promise<{ status: 'completed'; worktreeId: string }>((resolve) => {
          resolveCommand = resolve;
        }),
    );
    const onSelect = jest.fn();
    const onCreationError = jest.fn();
    act(() => {
      root.render(
        <WorkspacesSidebarSections
          state={state}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={onSelect}
          onCreationError={onCreationError}
          creationEnabled
          onCreateWorktree={command}
        />,
      );
    });
    const add = container.querySelector<HTMLButtonElement>(
      '[aria-label="Create worktree for Workspace"]',
    );
    act(() => add?.click());
    act(() => root.unmount());
    await act(async () => {
      resolveCommand?.({ status: 'completed', worktreeId: 'created' });
      await Promise.resolve();
    });
    expect(onSelect).not.toHaveBeenCalled();
    expect(onCreationError).not.toHaveBeenCalled();
    root = createRoot(container);
  });

  describe('per-row capability resolution (REG-2816)', () => {
    const remoteControlCapabilities: CanopyCapabilities = {
      ...capabilities,
      workspaceReordering: true,
      worktreeReordering: true,
      workspaceSettings: 'full',
      workspaceRemoval: 'delete',
      worktreeRemoval: 'archive',
      worktreeBranchGrouping: true,
    };
    const cloudCapabilities: CanopyCapabilities = {
      ...capabilities,
      workspaceReordering: true,
      worktreeReordering: false,
      workspaceSettings: 'full',
      workspaceRemoval: 'archive',
      worktreeRemoval: false,
      worktreeBranchGrouping: false,
    };
    const mixedState = (): PortalSessionShellState =>
      shell({
        workspaces: [
          {
            localId: 'remote-workspace',
            name: 'Remote control',
            type: 'single-repo',
            itemSortMode: 'manual',
          },
          {
            localId: 'cloud:workspace:one',
            name: 'Cloud',
            type: 'single-repo',
          },
        ],
        worktrees: [
          {
            localId: 'remote-worktree',
            workspaceLocalId: 'remote-workspace',
            branch: 'main',
          },
          {
            localId: 'cloud:task:one',
            workspaceLocalId: 'cloud:workspace:one',
            branch: 'task',
          },
        ],
      });
    // Mirrors the composite client: routing is by id namespace, and cloud
    // namespaces its worktrees too, so rows answer without their parent.
    const capabilitiesFor = (localId: string): CanopyCapabilities =>
      localId.startsWith('cloud:')
        ? cloudCapabilities
        : remoteControlCapabilities;

    function renderMixed(
      overrides: Partial<
        Pick<
          WorkspacesSidebarSectionsProps,
          'capabilitiesFor' | 'onRemoveWorkspace' | 'capabilities'
        >
      > = {},
    ): void {
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={mixedState()}
            capabilities={capabilities}
            capabilitiesFor={capabilitiesFor}
            selected={null}
            onSelectWorktree={jest.fn()}
            onOpenWorkspaceSettings={jest.fn()}
            onCreateWorktree={jest.fn()}
            renderWorkspaceDragHandle={({ workspace }) => (
              <button
                type="button"
                data-testid={`drag-workspace-${workspace.localId}`}
              />
            )}
            renderWorktreeActions={({ worktree, worktreeRemoval }) =>
              worktreeRemoval !== undefined && worktreeRemoval !== false
                ? {
                    node: (
                      <button
                        type="button"
                        data-testid={`archive-worktree-${worktree.localId}`}
                      />
                    ),
                    buttonCount: 1,
                  }
                : null
            }
            {...overrides}
          />,
        );
      });
    }

    it('keeps project reorder while splitting settings and worktree archive across backends', () => {
      renderMixed();

      expect(
        container.querySelector(
          '[data-testid="drag-workspace-remote-workspace"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelector(
          '[data-testid="drag-workspace-cloud:workspace:one"]',
        ),
      ).not.toBeNull();

      expect(
        container.querySelector('[aria-label="Settings for Remote control"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[aria-label="Settings for Cloud"]'),
      ).not.toBeNull();

      expect(
        container.querySelector(
          '[data-testid="archive-worktree-remote-worktree"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelector(
          '[data-testid="archive-worktree-cloud:task:one"]',
        ),
      ).toBeNull();
    });

    it('keeps cloud archive inside the full settings dialog', () => {
      const onRemoveWorkspace = jest.fn();
      renderMixed({ onRemoveWorkspace });

      const archiveCloud = container.querySelector<HTMLButtonElement>(
        '[aria-label="Archive project Cloud"]',
      );
      expect(archiveCloud).toBeNull();
      // Remote control keeps deletion in the settings danger tab.
      expect(
        container.querySelector(
          '[aria-label="Archive project Remote control"]',
        ),
      ).toBeNull();
      expect(
        container.querySelector('[aria-label="Delete Remote control"]'),
      ).toBeNull();

      expect(onRemoveWorkspace).not.toHaveBeenCalled();
    });

    it('offers fallback archive where the row has no settings dialog', () => {
      const onRemoveWorkspace = jest.fn();
      renderMixed({
        onRemoveWorkspace,
        capabilitiesFor: (localId) =>
          localId.startsWith('cloud:')
            ? { ...cloudCapabilities, workspaceSettings: false }
            : remoteControlCapabilities,
      });

      const archiveCloud = container.querySelector<HTMLButtonElement>(
        '[aria-label="Archive project Cloud"]',
      );
      expect(archiveCloud).not.toBeNull();
      act(() => archiveCloud?.click());
      expect(onRemoveWorkspace).toHaveBeenCalledWith('cloud:workspace:one');
    });

    it('withholds archive project when no host handler is supplied', () => {
      renderMixed();
      expect(
        container.querySelector('[aria-label="Archive project Cloud"]'),
      ).toBeNull();
    });

    it('makes worktreeReordering true sortable and false non-sortable per row', () => {
      // A cloud row parked inside a remote-control workspace: inheriting from
      // the parent would wrongly restore its archive affordance.
      const nestedState = shell({
        workspaces: [
          {
            localId: 'remote-workspace',
            name: 'Remote control',
            type: 'single-repo',
            itemSortMode: 'manual',
          },
        ],
        worktrees: [
          {
            localId: 'remote-worktree',
            workspaceLocalId: 'remote-workspace',
            branch: 'main',
          },
          {
            localId: 'cloud:task:nested',
            workspaceLocalId: 'remote-workspace',
            branch: 'task',
          },
        ],
      });
      const wrapWorktreeList = jest.fn(
        (_context: WorktreeDndWrapperContext, list: ReactNode): ReactNode =>
          list,
      );
      act(() => {
        root.render(
          <WorkspacesSidebarSections
            state={nestedState}
            capabilities={capabilities}
            capabilitiesFor={capabilitiesFor}
            selected={null}
            onSelectWorktree={jest.fn()}
            onCreateWorktree={jest.fn()}
            wrapWorktreeList={wrapWorktreeList}
            renderWorktreeDragHandle={({ sortable, worktree }) =>
              sortable ? (
                <button
                  type="button"
                  data-testid={`drag-worktree-${worktree.localId}`}
                />
              ) : null
            }
            renderWorktreeActions={({ worktree, worktreeRemoval }) =>
              worktreeRemoval !== undefined && worktreeRemoval !== false
                ? {
                    node: (
                      <button
                        type="button"
                        data-testid={`archive-worktree-${worktree.localId}`}
                      />
                    ),
                    buttonCount: 1,
                  }
                : null
            }
          />,
        );
      });

      expect(
        container.querySelector(
          '[data-testid="archive-worktree-remote-worktree"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelector(
          '[data-testid="archive-worktree-cloud:task:nested"]',
        ),
      ).toBeNull();
      expect(
        container.querySelector(
          '[data-testid="drag-worktree-remote-worktree"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelector(
          '[data-testid="drag-worktree-cloud:task:nested"]',
        ),
      ).toBeNull();
      expect(wrapWorktreeList).toHaveBeenCalledTimes(1);
      expect(wrapWorktreeList.mock.calls[0]?.[0].sortableWorktreeIds).toEqual([
        'remote-worktree',
      ]);
    });

    it('falls back to the flat capabilities for every row without a resolver', () => {
      // The desktop host path: no resolver, so the flat object still drives
      // every affordance exactly as it did before per-row resolution.
      renderMixed({
        capabilities: remoteControlCapabilities,
        capabilitiesFor: undefined,
        onRemoveWorkspace: jest.fn(),
      });

      for (const workspaceLocalId of [
        'remote-workspace',
        'cloud:workspace:one',
      ]) {
        expect(
          container.querySelector(
            `[data-testid="drag-workspace-${workspaceLocalId}"]`,
          ),
        ).not.toBeNull();
      }
      for (const worktreeLocalId of ['remote-worktree', 'cloud:task:one']) {
        expect(
          container.querySelector(
            `[data-testid="archive-worktree-${worktreeLocalId}"]`,
          ),
        ).not.toBeNull();
      }
      expect(
        container.querySelector('[aria-label="Settings for Cloud"]'),
      ).not.toBeNull();
      // `workspaceSettings: 'full'` keeps removal in the settings dialog.
      expect(
        container.querySelector('[aria-label="Archive project Cloud"]'),
      ).toBeNull();
    });
  });
});

describe('WorkspacesSidebarSections context scoping (CAN-2954)', () => {
  const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
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

  const scoped = shell({
    workspaces: [
      { localId: 'personal', name: 'Personal repo', type: 'single-repo' },
      {
        localId: 'acme',
        name: 'Acme repo',
        type: 'single-repo',
        owner: { type: 'organization', organizationId: ORG_A, projectId: 'p' },
      },
    ],
    worktrees: [
      { localId: 'p-wt', workspaceLocalId: 'personal', branch: 'main' },
      { localId: 'a-wt', workspaceLocalId: 'acme', branch: 'main' },
    ],
  });

  function render(
    next: PortalSessionShellState,
    props: Partial<WorkspacesSidebarSectionsProps> = {},
  ): void {
    act(() => {
      root.render(
        <WorkspacesSidebarSections
          state={next}
          capabilities={capabilities}
          selected={null}
          onSelectWorktree={jest.fn()}
          {...props}
        />,
      );
    });
  }

  it('lists only the selected context and keeps the unscoped list without one', () => {
    render(scoped);
    expect(container.textContent).toContain('Personal repo');
    expect(container.textContent).toContain('Acme repo');

    render(scoped, { context: { kind: 'personal' } });
    expect(container.textContent).toContain('Personal repo');
    expect(container.textContent).not.toContain('Acme repo');

    render(scoped, {
      context: { kind: 'organization', organizationId: ORG_A },
    });
    expect(container.textContent).toContain('Acme repo');
    expect(container.textContent).not.toContain('Personal repo');
  });

  it('renders the host empty state only for an organization with no rows', () => {
    const renderContextEmptyState = jest.fn(
      (): ReactNode => <div data-testid="empty">Nothing here</div>,
    );
    render(scoped, {
      context: {
        kind: 'organization',
        organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      },
      renderContextEmptyState,
    });
    expect(container.querySelector('[data-testid="empty"]')).not.toBeNull();

    render(shell(), { context: { kind: 'personal' }, renderContextEmptyState });
    expect(container.querySelector('[data-testid="empty"]')).toBeNull();
  });

  describe('emptyListMark (CAN-3973)', () => {
    const emptyListMark = <span data-testid="mark" />;
    const mark = (): Element | null =>
      container.querySelector('[data-testid="mark"]');

    it('renders for an empty Personal list', () => {
      render(shell(), { context: { kind: 'personal' }, emptyListMark });
      expect(mark()).not.toBeNull();
    });

    it('renders ahead of the host empty state for an empty organization', () => {
      render(scoped, {
        context: {
          kind: 'organization',
          organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
        emptyListMark,
        renderContextEmptyState: (): ReactNode => <div data-testid="empty" />,
      });
      const shown = mark();
      const empty = container.querySelector('[data-testid="empty"]');
      if (shown === null || empty === null) throw new Error('not rendered');
      expect(
        shown.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it('stays out while the list has rows, hidden rows, or host rows', () => {
      render(scoped, { context: { kind: 'personal' }, emptyListMark });
      expect(mark()).toBeNull();

      render(
        shell({
          workspaces: [
            {
              localId: 'personal',
              name: 'Personal repo',
              type: 'single-repo',
              hidden: true,
            },
          ],
        }),
        { context: { kind: 'personal' }, emptyListMark },
      );
      expect(mark()).toBeNull();

      render(shell(), {
        context: { kind: 'personal' },
        emptyListMark,
        additionalRows: <div data-testid="extra" />,
      });
      expect(mark()).toBeNull();
    });
  });

  it('renders host-supplied rows after the workspaces, and in place of the empty state', () => {
    const additionalRows = <div data-testid="extra">Extra row</div>;
    render(scoped, {
      context: { kind: 'organization', organizationId: ORG_A },
      additionalRows,
    });
    expect(container.querySelector('[data-testid="extra"]')).not.toBeNull();
    expect(container.textContent).toContain('Acme repo');

    // These rows are not workspaces, so they never reach `partitions`: an
    // organization whose only rows are host-supplied must still show them
    // rather than the "nothing here yet" state.
    render(scoped, {
      context: {
        kind: 'organization',
        organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      },
      additionalRows,
      renderContextEmptyState: (): ReactNode => <div data-testid="empty" />,
    });
    expect(container.querySelector('[data-testid="extra"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="empty"]')).toBeNull();
  });
});

describe('pickWorktreeRowOverrides (CAN-3053 finding 2)', () => {
  it('keeps every allowlisted key present in the override object', () => {
    const overrides: WorktreeRowOverrides = {
      hasUnread: true,
      uiStatus: 'working',
      branchLabel: 'feature',
    };
    expect(pickWorktreeRowOverrides(overrides)).toStrictEqual(overrides);
  });

  it('strips a key that is not on the allowlist, even from a widened runtime object', () => {
    const widened: WorktreeRowOverrides & {
      readonly worktreeId: string;
      readonly selected: boolean;
      readonly workspaceLocalId: string;
    } = {
      hasUnread: true,
      worktreeId: 'evil',
      selected: true,
      workspaceLocalId: 'other-workspace',
    };
    expect(pickWorktreeRowOverrides(widened)).toStrictEqual({
      hasUnread: true,
    });
  });

  it('returns an empty object for an override with only disallowed keys', () => {
    const widened: WorktreeRowOverrides & { readonly selected: boolean } = {
      selected: true,
    };
    expect(pickWorktreeRowOverrides(widened)).toStrictEqual({});
  });

  it('preserves a present-but-undefined allowlisted key rather than dropping it', () => {
    const overrides: WorktreeRowOverrides = { lastKnownPrStatus: undefined };
    const picked = pickWorktreeRowOverrides(overrides);
    expect('lastKnownPrStatus' in picked).toBe(true);
    expect(picked.lastKnownPrStatus).toBeUndefined();
  });
});
