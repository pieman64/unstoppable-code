const mockEnabled = jest.fn((): boolean => true);
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: (): { isEnabled: typeof mockEnabled } => ({
    isEnabled: mockEnabled,
  }),
}));
import { appendOrgProjectPlaceholderRows } from '../services/org-project-placeholder-rows';
import type {
  DesktopOrgProjectCatalogSnapshot,
  WorkspaceContext,
} from '@canopy/desktop-shared/types';
import type { PortalSessionShellState } from '@canopy/protocol/portal';
import { buildDesktopSessionSnapshot } from '../services/desktop-session-snapshot-service';

const context: WorkspaceContext = {
  kind: 'organization',
  organizationId: 'org-a',
};
const snapshot: DesktopOrgProjectCatalogSnapshot = {
  context: 'org:org-a',
  revision: 'r1',
  fetchedAt: '',
  stale: false,
  error: null,
  projects: [
    {
      id: 'catalog-project',
      organizationId: 'org-a',
      name: 'Catalog project',
      description: null,
      kind: 'CODE',
      purpose: 'project',
      visibility: 'organization',
      memberOwned: false,
      location: 'LOCAL',
      repository: {
        provider: 'github',
        host: 'github.com',
        owner: 'acme',
        name: 'repo',
        providerRepoId: '1',
        defaultBranch: 'main',
        verification: 'VERIFIED',
      },
      state: 'ACTIVE',
      revision: 1,
      authorizationVersion: 1,
      defaultListed: true,
      preference: 'FOLLOW_DEFAULTS',
      listed: true,
      capabilities: { administer: false, manageCloud: false, use: true },
      instance: null,
    },
  ],
};
const rows: PortalSessionShellState['workspaces'] = [
  { localId: 'real', name: 'Real', type: 'single-repo' },
];
const mockList = jest.fn(
  (): Promise<DesktopOrgProjectCatalogSnapshot> => Promise.resolve(snapshot),
);
const mockPeek = jest.fn(
  (): DesktopOrgProjectCatalogSnapshot | null => snapshot,
);
const mockContext = jest.fn((): { context: WorkspaceContext } => ({ context }));
const mockWriteWorkspaceIndex = jest.fn();
const mockToWorkspaceIndexEntry = jest.fn();
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(() => rows),
  writeWorkspaceIndex: (...args: unknown[]): void => {
    mockWriteWorkspaceIndex(...args);
  },
  toWorkspaceIndexEntry: (...args: unknown[]): void => {
    mockToWorkspaceIndexEntry(...args);
  },
}));
jest.mock('../services/workspace-portal-service', () => ({
  listWorkspacePortalEntities: (
    _target: unknown,
    callbacks: {
      onWorkspace: (row: PortalSessionShellState['workspaces'][number]) => void;
    },
  ): Promise<void> => {
    rows.forEach(callbacks.onWorkspace);
    return Promise.resolve();
  },
}));
jest.mock('../services/standalone-chat-service', () => ({
  listStandaloneChats: (): Promise<never[]> => Promise.resolve([]),
  projectStandaloneChatSnapshot: jest.fn(),
}));
jest.mock('../services/org-project-catalog-service', () => ({
  getOrgProjectCatalogService: (): {
    list: typeof mockList;
    peek: typeof mockPeek;
  } => ({ list: mockList, peek: mockPeek }),
}));
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): { getState: typeof mockContext } => ({
    getState: mockContext,
  }),
}));

describe('catalog placeholders in the desktop snapshot', () => {
  beforeEach((): void => {
    jest.clearAllMocks();
    mockEnabled.mockReturnValue(true);
    mockList.mockResolvedValue(snapshot);
    mockPeek.mockReturnValue(snapshot);
    mockContext.mockReturnValue({ context });
  });
  it('appends a catalog row without writing to the filesystem workspace index', async (): Promise<void> => {
    const before = structuredClone(rows);
    const result = await buildDesktopSessionSnapshot();
    expect(result.workspaces).toEqual([
      ...rows,
      {
        localId: 'org-project:catalog-project',
        name: 'Catalog project',
        type: 'single-repo',
        backend: 'desktop',
        owner: {
          type: 'organization',
          organizationId: 'org-a',
          projectId: 'catalog-project',
        },
        placeholder: { projectId: 'catalog-project', state: 'ready-to-set-up' },
      },
    ]);
    expect(rows).toEqual(before);
    expect(mockWriteWorkspaceIndex).not.toHaveBeenCalled();
    expect(mockToWorkspaceIndexEntry).not.toHaveBeenCalled();
    expect(result.worktrees).toEqual([]);
  });
  it('does not append placeholders to a scoped snapshot', async (): Promise<void> => {
    const scoped = await buildDesktopSessionSnapshot({
      workspaceLocalId: 'ws-1',
    });
    expect(scoped.workspaces.some((row) => row.placeholder !== undefined)).toBe(
      false,
    );
    const overview = await buildDesktopSessionSnapshot({});
    expect(
      overview.workspaces.some((row) => row.placeholder !== undefined),
    ).toBe(true);
  });

  it('does not read the catalog with the feature flag off', async (): Promise<void> => {
    mockEnabled.mockReturnValue(false);
    expect((await buildDesktopSessionSnapshot()).workspaces).toEqual(rows);
    expect(mockList).not.toHaveBeenCalled();
  });
  it('does not read the catalog under Personal', async (): Promise<void> => {
    mockContext.mockReturnValue({ context: { kind: 'personal' } });
    expect((await buildDesktopSessionSnapshot()).workspaces).toEqual(rows);
    expect(mockList).not.toHaveBeenCalled();
  });
  it('keeps real rows when reading the catalog fails', async (): Promise<void> => {
    mockPeek.mockImplementation((): never => {
      throw new Error('offline');
    });
    expect((await buildDesktopSessionSnapshot()).workspaces).toEqual(rows);
  });

  it('reads the catalog cache instead of driving its refresh side effects', async (): Promise<void> => {
    // `list()` is not a read: it refreshes a stale entry and clears an
    // unavailable one, and both `remember()` and broadcast. That broadcast
    // schedules another session-snapshot invalidation, which builds another
    // snapshot, which calls `list()` again — a cycle that never settles while
    // the catalog is stale or unavailable. Snapshot construction has to use
    // the side-effect-free cached read.
    await buildDesktopSessionSnapshot();
    expect(mockList).not.toHaveBeenCalled();
    expect(mockPeek).toHaveBeenCalledWith(context);
  });

  it('omits catalog rows when nothing is cached yet', async (): Promise<void> => {
    mockPeek.mockReturnValue(null);
    const result = await buildDesktopSessionSnapshot();
    expect(result.workspaces).toEqual(rows);
  });
});

describe('appendOrgProjectPlaceholderRows', () => {
  it('deduplicates against bound rows and never mutates the input', (): void => {
    const bound: PortalSessionShellState['workspaces'] = [
      {
        ...rows[0],
        localId: 'bound',
        name: 'Bound',
        type: 'single-repo',
        owner: {
          type: 'organization',
          organizationId: 'org-a',
          projectId: 'catalog-project',
        },
      },
    ];
    expect(appendOrgProjectPlaceholderRows(bound, snapshot, context)).toEqual(
      bound,
    );
    expect(
      appendOrgProjectPlaceholderRows(rows, snapshot, context),
    ).toHaveLength(2);
    expect(rows).toHaveLength(1);
  });
  it('ignores personal, unavailable, mismatched, unlisted, archived, ready and multi-repo projects', (): void => {
    expect(
      appendOrgProjectPlaceholderRows(rows, snapshot, { kind: 'personal' }),
    ).toEqual(rows);
    expect(
      appendOrgProjectPlaceholderRows(
        rows,
        { ...snapshot, error: 'unavailable' },
        context,
      ),
    ).toEqual(rows);
    expect(
      appendOrgProjectPlaceholderRows(
        rows,
        { ...snapshot, context: 'org:other' },
        context,
      ),
    ).toEqual(rows);
    for (const patch of [
      { listed: false },
      { state: 'ARCHIVED' },
      { instance: { id: 'instance', state: 'READY' } },
      // A converted multi-repo project cannot be set up from the catalog.
      { topology: 'multi-repo' },
    ] as const) {
      expect(
        appendOrgProjectPlaceholderRows(
          rows,
          {
            ...snapshot,
            projects: snapshot.projects.map((project) => ({
              ...project,
              ...patch,
            })),
          },
          context,
        ),
      ).toEqual(rows);
    }
  });
  it.each(['offline', 'access-changed'] as const)(
    'projects the %s snapshot state',
    (error): void => {
      expect(
        appendOrgProjectPlaceholderRows(
          rows,
          { ...snapshot, error },
          context,
        )[1]?.placeholder?.state,
      ).toBe(error);
    },
  );
});
