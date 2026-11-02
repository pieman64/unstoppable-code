import type { OrgProjectsStoreState } from '@canopy/app-state';
import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import {
  resolveOrgFolderConflict,
  type OrgFolderConflict,
} from '../orgProjectFolderConflict';

const mockProjects: { projects: SidebarItem[]; loadProjects: jest.Mock } = {
  projects: [],
  loadProjects: jest.fn(() => Promise.resolve()),
};
jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: { getState: (): typeof mockProjects => mockProjects },
}));

const owner = {
  type: 'organization',
  organizationId: 'org-a',
  projectId: 'p',
  instanceId: 'i',
  bindingGeneration: 2,
} as const satisfies OrgFolderConflict['owner'];
const conflict: OrgFolderConflict = { workspaceId: 'w', owner };

function workspace(overrides: Partial<SidebarItem> = {}): SidebarItem {
  return {
    id: 'w',
    name: 'local name',
    type: 'single-repo',
    repoPath: '/repo',
    order: 0,
    collapsed: false,
    owner,
    ...overrides,
  } as SidebarItem;
}

function project(
  overrides: Partial<OrgProjectSummary> = {},
): OrgProjectSummary {
  return {
    id: 'p',
    organizationId: 'org-a',
    name: 'Payments',
    description: null,
    kind: 'CODE',
    purpose: 'project',
    visibility: 'organization',
    memberOwned: false,
    location: 'LOCAL',
    repository: null,
    state: 'ACTIVE',
    revision: 1,
    authorizationVersion: 1,
    defaultListed: true,
    preference: 'FOLLOW_DEFAULTS',
    listed: true,
    capabilities: { use: true, administer: false, manageCloud: false },
    instance: { id: 'i', state: 'READY' },
    ...overrides,
  };
}

type CatalogState = Pick<
  OrgProjectsStoreState,
  'accountEpoch' | 'snapshots' | 'errors' | 'load' | 'loading'
>;
type Catalog = {
  -readonly [Key in keyof CatalogState]: CatalogState[Key];
};

function catalog(
  projects: OrgProjectSummary[] | null,
  options: { error?: string; onLoad?: (state: Catalog) => void } = {},
): { getState: () => Catalog; state: Catalog } {
  const state: Catalog = {
    accountEpoch: 0,
    snapshots: {},
    errors: {},
    loading: {},
    load: jest.fn((): Promise<void> => {
      if (projects !== null)
        state.snapshots = {
          'org:org-a': {
            context: 'org:org-a',
            revision: '1',
            fetchedAt: '',
            projects,
          },
        };
      if (options.error !== undefined)
        state.errors = { 'org:org-a': options.error };
      options.onLoad?.(state);
      return Promise.resolve();
    }),
  };
  return { getState: () => state, state };
}

const live = { isCurrent: (): boolean => true };

beforeEach(() => {
  jest.clearAllMocks();
  const snapshot = getDefaultFeatureFlagSnapshot();
  snapshot.values['canopy-shared-org-projects-enabled'] = true;
  useFeatureFlagsStore.setState({ snapshot });
  useWorkspaceContextStore.setState({
    state: {
      context: { kind: 'personal' },
      revision: 1,
      organizations: [{ id: 'org-a', name: 'Acme', role: 'MEMBER' }],
    },
    hydrated: true,
    accountEpoch: 0,
  });
  mockProjects.projects = [workspace()];
});

it('is ready for a usable project whose instance matches and is READY', async () => {
  const store = catalog([project()]);
  await expect(
    resolveOrgFolderConflict(conflict, store, live),
  ).resolves.toEqual({
    status: 'ready',
    organizationId: 'org-a',
    organizationName: 'Acme',
    projectId: 'p',
    projectName: 'Payments',
  });
  expect(store.state.load).toHaveBeenCalledWith(
    { kind: 'organization', organizationId: 'org-a' },
    undefined,
  );
});

it('asks for a real refresh on retry', async () => {
  const store = catalog([project()]);
  await resolveOrgFolderConflict(conflict, store, { ...live, refresh: true });
  expect(store.state.load).toHaveBeenCalledWith(
    { kind: 'organization', organizationId: 'org-a' },
    { refresh: true },
  );
});

it.each([
  ['missing', null],
  ['CLAIMED', { id: 'i', state: 'CLAIMED' as const }],
])('is unfinished when the instance is %s', async (_label, instance) => {
  const result = await resolveOrgFolderConflict(
    conflict,
    catalog([project({ instance })]),
    live,
  );
  expect(result.status).toBe('unfinished');
});

it('is unknown, not ready, for a different catalog instance', async () => {
  const result = await resolveOrgFolderConflict(
    conflict,
    catalog([project({ instance: { id: 'other', state: 'READY' } })]),
    live,
  );
  expect(result).toEqual({ status: 'unknown' });
});

it('denies without loading when the feature is disabled', async () => {
  const disabled = getDefaultFeatureFlagSnapshot();
  disabled.values['canopy-shared-org-projects-enabled'] = false;
  useFeatureFlagsStore.setState({ snapshot: disabled });
  const store = catalog([project()]);
  await expect(
    resolveOrgFolderConflict(conflict, store, live),
  ).resolves.toEqual({
    status: 'denied',
    reason: 'feature-disabled',
    organizationName: null,
  });
  expect(store.state.load).not.toHaveBeenCalled();
});

it('denies a non-member without loading or naming anything', async () => {
  useWorkspaceContextStore.setState({
    state: { context: { kind: 'personal' }, revision: 1, organizations: [] },
  });
  const store = catalog([project()]);
  await expect(
    resolveOrgFolderConflict(conflict, store, live),
  ).resolves.toEqual({
    status: 'denied',
    reason: 'not-member',
    organizationName: null,
  });
  expect(store.state.load).not.toHaveBeenCalled();
});

it.each([
  ['absent', []],
  ['inactive', [project({ state: 'ARCHIVED' })]],
  [
    'unusable',
    [
      project({
        capabilities: { use: false, administer: false, manageCloud: false },
      }),
    ],
  ],
])('denies a project that is %s without its name', async (_label, projects) => {
  await expect(
    resolveOrgFolderConflict(conflict, catalog(projects), live),
  ).resolves.toEqual({
    status: 'denied',
    reason: 'unavailable',
    organizationName: 'Acme',
  });
});

it('stays unknown when the refresh fails, even with stale ready data', async () => {
  const store = catalog([project()], { error: 'offline' });
  await expect(
    resolveOrgFolderConflict(conflict, store, live),
  ).resolves.toEqual({ status: 'unknown' });
});

it('reads the catalog live after the load', async () => {
  const store = catalog(null, {
    onLoad: (state): void => {
      state.snapshots = {
        'org:org-a': {
          context: 'org:org-a',
          revision: '2',
          fetchedAt: '',
          projects: [project({ name: 'Renamed' })],
        },
      };
    },
  });
  const result = await resolveOrgFolderConflict(conflict, store, live);
  expect(result).toMatchObject({ status: 'ready', projectName: 'Renamed' });
});

it('reloads the workspace list once before giving up on the binding', async () => {
  mockProjects.projects = [];
  mockProjects.loadProjects.mockImplementationOnce((): Promise<void> => {
    mockProjects.projects = [workspace()];
    return Promise.resolve();
  });
  const result = await resolveOrgFolderConflict(
    conflict,
    catalog([project()]),
    live,
  );
  expect(mockProjects.loadProjects).toHaveBeenCalledTimes(1);
  expect(result.status).toBe('ready');
});

it.each([
  ['removed', (): SidebarItem[] => []],
  [
    'rebound',
    (): SidebarItem[] => [
      workspace({ owner: { ...owner, bindingGeneration: 3 } }),
    ],
  ],
  [
    'ambiguous',
    (): SidebarItem[] => [workspace(), workspace({ id: 'second' })],
  ],
])('is unknown when the local binding is %s', async (_label, rows) => {
  mockProjects.projects = rows();
  await expect(
    resolveOrgFolderConflict(conflict, catalog([project()]), live),
  ).resolves.toEqual({ status: 'unknown' });
});

it('is superseded by an account change during the load', async () => {
  const store = catalog([project()], {
    onLoad: (): void => {
      useWorkspaceContextStore.setState({ accountEpoch: 1 });
    },
  });
  await expect(
    resolveOrgFolderConflict(conflict, store, live),
  ).resolves.toEqual({ status: 'superseded' });
});

it("is superseded when the caller's request is replaced", async () => {
  let current = true;
  const store = catalog([project()], {
    onLoad: (): void => {
      current = false;
    },
  });
  await expect(
    resolveOrgFolderConflict(conflict, store, { isCurrent: () => current }),
  ).resolves.toEqual({ status: 'superseded' });
});

it('rechecks the feature after catalog loading', async () => {
  const store = catalog([project()], {
    onLoad: (): void => {
      const snapshot = getDefaultFeatureFlagSnapshot();
      snapshot.values['canopy-shared-org-projects-enabled'] = false;
      useFeatureFlagsStore.setState({ snapshot });
    },
  });
  await expect(
    resolveOrgFolderConflict(conflict, store, live),
  ).resolves.toMatchObject({
    status: 'denied',
    reason: 'feature-disabled',
  });
});

it('reads readiness again after the fallback workspace load', async () => {
  const store = catalog([project()]);
  mockProjects.projects = [];
  mockProjects.loadProjects.mockImplementationOnce((): Promise<void> => {
    mockProjects.projects = [workspace()];
    store.state.snapshots = {
      'org:org-a': {
        context: 'org:org-a',
        revision: '2',
        fetchedAt: '',
        projects: [project({ instance: { id: 'i', state: 'CLAIMED' } })],
      },
    };
    return Promise.resolve();
  });
  await expect(
    resolveOrgFolderConflict(conflict, store, live),
  ).resolves.toMatchObject({ status: 'unfinished' });
});

it('does not disclose a project after membership disappears during workspace loading', async () => {
  mockProjects.projects = [];
  mockProjects.loadProjects.mockImplementationOnce((): Promise<void> => {
    mockProjects.projects = [workspace()];
    useWorkspaceContextStore.setState({
      state: { context: { kind: 'personal' }, revision: 1, organizations: [] },
    });
    return Promise.resolve();
  });
  await expect(
    resolveOrgFolderConflict(conflict, catalog([project()]), live),
  ).resolves.toEqual({
    status: 'denied',
    reason: 'not-member',
    organizationName: null,
  });
});

it('does not authorize stale READY data when a newer catalog refresh is still loading', async () => {
  const store = catalog([project()], {
    onLoad: (state): void => {
      state.loading = { 'org:org-a': true };
    },
  });
  await expect(
    resolveOrgFolderConflict(conflict, store, live),
  ).resolves.toEqual({ status: 'unknown' });
});

it('reloads ambiguous local rows once so a stale conflict can recover', async () => {
  mockProjects.projects = [workspace(), workspace({ id: 'stale-second' })];
  mockProjects.loadProjects.mockImplementationOnce((): Promise<void> => {
    mockProjects.projects = [workspace()];
    return Promise.resolve();
  });
  await expect(
    resolveOrgFolderConflict(conflict, catalog([project()]), live),
  ).resolves.toMatchObject({ status: 'ready' });
  expect(mockProjects.loadProjects).toHaveBeenCalledTimes(1);
});
