/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  SidebarSurface,
  type SidebarSurfaceProps,
  type SidebarSurfaceSnapshot,
} from '../SidebarSurface';
import type { SidebarPendingProject } from '../PendingProjectRow';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const capabilities: SidebarSurfaceProps['capabilities'] = {
  localExecution: false,
  terminalPty: false,
  fileSystemAccess: 'read',
  voice: false,
  settingsScope: 'api-keys-only',
  pipelines: 'crud-only',
  routing: 'url',
  overviewNotifications: false,
  workspaceCreation: 'remote-clone',
  workspaceReordering: false,
  worktreeReordering: false,
  workspaceSettings: false,
  worktreeRemoval: 'archive',
};

const EMPTY: SidebarSurfaceSnapshot = {
  workspaces: [],
  worktrees: [],
  standaloneChats: [],
};

const ONE: SidebarSurfaceSnapshot = {
  workspaces: [
    { localId: 'workspace', name: 'Workspace', type: 'single-repo' },
  ],
  worktrees: [],
  standaloneChats: [],
};

const pending: readonly SidebarPendingProject[] = [
  { id: 'cmd-1', name: 'website', status: 'cloning' },
];

const PENDING_ROW = '[data-testid="sidebar-pending-project-cmd-1"]';

describe('SidebarSurface pending projects', () => {
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
    contentState: SidebarSurfaceProps['contentState'],
    props: Partial<SidebarSurfaceProps> = {},
    snapshot: SidebarSurfaceSnapshot = ONE,
  ): void {
    act(() => {
      root.render(
        <SidebarSurface
          variant="rail"
          snapshot={snapshot}
          selection={null}
          capabilities={capabilities}
          contentState={contentState}
          onSelect={() => undefined}
          testIds={{
            root: 'portal-sidebar',
            empty: 'portal-sidebar-empty',
            workspaceList: 'portal-workspace-list',
          }}
          {...props}
        />,
      );
    });
  }

  it('renders no pending rows by default', () => {
    render('ready');
    expect(container.querySelector('[data-pending-project-row]')).toBeNull();
  });

  it('renders pending rows inside the Projects list after the real rows', () => {
    render('ready', { pendingProjects: pending });
    const list = container.querySelector(
      '[data-testid="portal-workspace-list"]',
    );
    const row = list?.querySelector(PENDING_ROW);
    expect(row).not.toBeNull();
    const workspace = Array.from(list?.querySelectorAll('*') ?? []).find(
      (element) => element.textContent === 'Workspace',
    );
    expect(workspace).toBeDefined();
    expect(
      workspace && row
        ? workspace.compareDocumentPosition(row) &
            Node.DOCUMENT_POSITION_FOLLOWING
        : 0,
    ).toBeTruthy();
  });

  it('renders pending rows before host additional rows', () => {
    render('ready', {
      pendingProjects: pending,
      additionalRows: <div data-testid="host-additional-row">Catalog</div>,
    });
    const row = container.querySelector(PENDING_ROW);
    const host = container.querySelector('[data-testid="host-additional-row"]');
    expect(row && host).toBeTruthy();
    expect(
      row && host
        ? row.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_FOLLOWING
        : 0,
    ).toBeTruthy();
  });

  it('shows a pending row instead of the host empty state', () => {
    render('empty', { pendingProjects: pending }, EMPTY);
    expect(
      container.querySelector('[data-testid="portal-sidebar-empty"]'),
    ).toBeNull();
    expect(container.querySelector(PENDING_ROW)).not.toBeNull();
  });

  it('keeps the host empty state without pending rows', () => {
    render('empty', { pendingProjects: [] }, EMPTY);
    expect(
      container.querySelector('[data-testid="portal-sidebar-empty"]'),
    ).not.toBeNull();
  });

  it('shows a pending row instead of an organization context empty state', () => {
    render(
      'ready',
      {
        pendingProjects: pending,
        context: { kind: 'organization', organizationId: 'org-a' },
        renderContextEmptyState: () => (
          <div data-testid="context-empty">None found</div>
        ),
      },
      EMPTY,
    );
    expect(container.querySelector('[data-testid="context-empty"]')).toBeNull();
    expect(container.querySelector(PENDING_ROW)).not.toBeNull();
  });

  it('keeps pending rows outside pagination', () => {
    const many: SidebarSurfaceSnapshot = {
      workspaces: Array.from({ length: 25 }, (_, index) => ({
        localId: `project-${index + 1}`,
        name: `Project ${index + 1}`,
        type: 'single-repo' as const,
      })),
      worktrees: [],
      standaloneChats: [],
    };
    render('ready', { pendingProjects: pending }, many);
    expect(container.textContent).not.toContain('Project 25');
    expect(container.querySelector(PENDING_ROW)).not.toBeNull();
  });

  it('keeps pending rows when host rows are withheld by a collapsible section', () => {
    render('ready', {
      pendingProjects: pending,
      workspacesSectionCollapsible: true,
    });
    expect(container.querySelector(PENDING_ROW)).not.toBeNull();

    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="portal-workspaces-section-toggle"]',
    );
    act(() => toggle?.click());
    expect(container.querySelector(PENDING_ROW)).toBeNull();
    act(() => toggle?.click());
    expect(container.querySelector(PENDING_ROW)).not.toBeNull();
  });

  it('keeps a pending row and its actions without mutation handlers', () => {
    const onDismiss = jest.fn();
    render('ready', {
      pendingProjects: [
        { id: 'cmd-1', name: 'website', status: 'failed', onDismiss },
      ],
      onCreateWorkspace: undefined,
      onCreateWorktree: undefined,
    });
    const dismiss = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-pending-project-dismiss-cmd-1"]',
    );
    act(() => dismiss?.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
