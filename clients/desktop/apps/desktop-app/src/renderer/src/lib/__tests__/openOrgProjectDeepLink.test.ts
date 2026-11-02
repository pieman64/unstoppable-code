import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import {
  openOrgProject,
  openOrgProjectDeepLink,
} from '../openOrgProjectDeepLink';
const mockToast = jest.fn();
const mockSelect = jest.fn();
const mockNavigate = jest.fn();
jest.mock('@canopy/app-state', () => ({ useOrgProjectsStoreApi: jest.fn() }));
let contextEpoch = 0;
let contextRevision = 1;
let contextHydrated = true;
let appliedGeneration = 0;
const mockHydrate = jest.fn((): Promise<void> => Promise.resolve());
let organizations = [{ id: 'org', name: 'Acme' }];
let activeContext: { kind: string; organizationId: string } = {
  kind: 'organization',
  organizationId: 'org',
};
jest.mock('@/stores/workspaceContextStore', () => ({
  useWorkspaceContextStore: {
    getState: (): {
      hydrate: () => Promise<void>;
      accountEpoch: number;
      hydrated: boolean;
      appliedGeneration: number;
      state: {
        context: { kind: string; organizationId: string };
        revision: number;
        organizations: typeof organizations;
      };
    } => ({
      hydrate: mockHydrate,
      accountEpoch: contextEpoch,
      hydrated: contextHydrated,
      appliedGeneration,
      state: {
        context: activeContext,
        revision: contextRevision,
        organizations,
      },
    }),
  },
}));
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: {
    getState: (): { addToast: typeof mockToast } => ({ addToast: mockToast }),
  },
}));
jest.mock('@/stores/homeComposerStore', () => ({
  useHomeComposerStore: {
    getState: (): { selectWorkspace: typeof mockSelect } => ({
      selectWorkspace: mockSelect,
    }),
  },
}));
jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: {
    getState: (): { navigate: typeof mockNavigate } => ({
      navigate: mockNavigate,
    }),
  },
}));
interface MockSidebarItem {
  id: string;
  /** Absent for a Personal checkout. */
  owner?: {
    type: string;
    organizationId: string;
    projectId: string;
    instanceId?: string;
    bindingGeneration?: number;
  };
}
const localWorkspace: MockSidebarItem = {
  id: 'local',
  owner: { type: 'organization', organizationId: 'org', projectId: 'p' },
};
/** Mirrors the renderer list being empty until `loadProjects` resolves. */
let loadedProjects: MockSidebarItem[] = [localWorkspace];
const mockLoadProjects = jest.fn(
  (): Promise<void> =>
    Promise.resolve(void (loadedProjects = [localWorkspace])),
);
jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: {
    getState: (): {
      projects: MockSidebarItem[];
      loadProjects: typeof mockLoadProjects;
    } => ({ projects: loadedProjects, loadProjects: mockLoadProjects }),
  },
}));
const project: OrgProjectSummary = {
  id: 'p',
  organizationId: 'org',
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
  instance: null,
};
function createStore(
  listed = true,
  overrides: Partial<OrgProjectSummary> = {},
  errors: Record<string, string> = {},
): Parameters<typeof openOrgProjectDeepLink>[1] {
  const state = {
    accountEpoch: 0,
    errors,
    loading: {},
    snapshots: {
      'org:org': {
        context: 'org:org',
        revision: '1',
        fetchedAt: '',
        projects: [{ ...project, listed, ...overrides }],
      },
    },
    load: jest.fn(() => Promise.resolve()),
    requestSetup: jest.fn(),
  };
  return { getState: () => state };
}
beforeEach(() => {
  jest.clearAllMocks();
  contextEpoch = 0;
  contextRevision = 1;
  contextHydrated = true;
  appliedGeneration = 0;
  mockHydrate.mockImplementation((): Promise<void> => Promise.resolve());
  organizations = [{ id: 'org', name: 'Acme' }];
  const snapshot = getDefaultFeatureFlagSnapshot();
  snapshot.values['canopy-shared-org-projects-enabled'] = true;
  useFeatureFlagsStore.setState({ snapshot });
  loadedProjects = [localWorkspace];
  activeContext = { kind: 'organization', organizationId: 'org' };
});
it('delegates consent to the existing store', async () => {
  const store = createStore();
  await openOrgProjectDeepLink(
    { ok: true, projectId: 'p', organizationId: 'org', workspaceId: null },
    store,
  );
  expect(store.getState().requestSetup).toHaveBeenCalledWith('org', 'p');
});
it('selects the existing workspace without requesting setup', async () => {
  const store = createStore();
  await openOrgProjectDeepLink(
    { ok: true, projectId: 'p', organizationId: 'org', workspaceId: 'local' },
    store,
  );
  expect(mockSelect).toHaveBeenCalledWith('local');
  expect(store.getState().requestSetup).not.toHaveBeenCalled();
});
it('reports a neutral failure if the member dismissed the project before delivery', async () => {
  const store = createStore(false);
  await openOrgProjectDeepLink(
    { ok: true, projectId: 'p', organizationId: 'org', workspaceId: null },
    store,
  );
  expect(mockToast).toHaveBeenCalledWith('Project not available', 'error');
  expect(store.getState().requestSetup).not.toHaveBeenCalled();
});
it('loads the workspace list once before reporting a bound project missing', async () => {
  loadedProjects = [];
  const store = createStore();
  await openOrgProjectDeepLink(
    { ok: true, projectId: 'p', organizationId: 'org', workspaceId: 'local' },
    store,
  );
  expect(mockLoadProjects).toHaveBeenCalledTimes(1);
  expect(mockSelect).toHaveBeenCalledWith('local');
  expect(mockToast).not.toHaveBeenCalled();
});
it('does not select the old workspace when the context changes during the fallback load', async () => {
  loadedProjects = [];
  mockLoadProjects.mockImplementationOnce((): Promise<void> => {
    activeContext = { kind: 'personal', organizationId: '' };
    loadedProjects = [localWorkspace];
    return Promise.resolve();
  });
  const store = createStore();
  await openOrgProjectDeepLink(
    { ok: true, projectId: 'p', organizationId: 'org', workspaceId: 'local' },
    store,
  );
  expect(mockSelect).not.toHaveBeenCalled();
  expect(mockNavigate).not.toHaveBeenCalled();
  expect(mockToast).not.toHaveBeenCalled();
});

describe('openOrgProject with a linked Personal checkout', () => {
  const personal: MockSidebarItem = { id: 'personal' };
  it('selects the linked checkout, which has no owner', async () => {
    loadedProjects = [personal];
    const outcome = await openOrgProject(
      {
        organizationId: 'org',
        projectId: 'p',
        workspaceId: 'personal',
        linkedPersonal: true,
      },
      createStore(),
    );
    expect(outcome).toBe('opened');
    expect(mockSelect).toHaveBeenCalledWith('personal');
  });
  it('refuses an org-bound workspace named as a linked checkout', async () => {
    const outcome = await openOrgProject(
      {
        organizationId: 'org',
        projectId: 'p',
        workspaceId: 'local',
        linkedPersonal: true,
      },
      createStore(),
    );
    expect(outcome).toBe('unavailable');
    expect(mockSelect).not.toHaveBeenCalled();
  });
  it('keeps the usability guard for a linked checkout', async () => {
    loadedProjects = [personal];
    const outcome = await openOrgProject(
      {
        organizationId: 'org',
        projectId: 'p',
        workspaceId: 'personal',
        linkedPersonal: true,
      },
      createStore(true, { state: 'ARCHIVED' }),
    );
    expect(outcome).toBe('unavailable');
    expect(mockSelect).not.toHaveBeenCalled();
  });
});

describe('openOrgProject with an expected binding (CAN-3648)', () => {
  const expectedBinding = {
    type: 'organization',
    organizationId: 'org',
    projectId: 'p',
    instanceId: 'i',
    bindingGeneration: 2,
  } as const;
  const boundWorkspace: MockSidebarItem = {
    id: 'local',
    owner: { ...expectedBinding },
  };
  const target = {
    organizationId: 'org',
    projectId: 'p',
    workspaceId: 'local',
    expectedBinding,
  };
  const ready = { instance: { id: 'i', state: 'READY' as const } };

  beforeEach(() => {
    loadedProjects = [boundWorkspace];
    mockLoadProjects.mockImplementation((): Promise<void> => Promise.resolve());
  });

  it('opens the exact binding when its instance is READY', async () => {
    await expect(
      openOrgProject(target, createStore(true, ready)),
    ).resolves.toBe('opened');
    expect(mockSelect).toHaveBeenCalledWith('local');
    expect(mockNavigate).toHaveBeenCalledWith('home');
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('silently supersedes an away-and-back context switch during hydration', async () => {
    let release: () => void = () => {};
    mockHydrate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const opening = openOrgProject(target, createStore(true, ready));
    activeContext = { kind: 'personal', organizationId: '' };
    contextRevision += 1;
    appliedGeneration += 1;
    activeContext = { kind: 'organization', organizationId: 'org' };
    contextRevision += 1;
    appliedGeneration += 1;
    release();
    await expect(opening).resolves.toBe('superseded');
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('allows initial hydration to establish the target context revision', async () => {
    contextHydrated = false;
    contextRevision = 0;
    activeContext = { kind: 'personal', organizationId: '' };
    mockHydrate.mockImplementationOnce((): Promise<void> => {
      contextHydrated = true;
      contextRevision = 10;
      activeContext = { kind: 'organization', organizationId: 'org' };
      return Promise.resolve();
    });
    await expect(
      openOrgProject(target, createStore(true, ready)),
    ).resolves.toBe('opened');
    expect(mockSelect).toHaveBeenCalledWith('local');
    expect(mockNavigate).toHaveBeenCalledWith('home');
  });

  it('allows a duplicate broadcast of the committed scope during hydration', async () => {
    mockHydrate.mockImplementationOnce((): Promise<void> => {
      appliedGeneration += 1;
      return Promise.resolve();
    });
    await expect(
      openOrgProject(target, createStore(true, ready)),
    ).resolves.toBe('opened');
    expect(mockSelect).toHaveBeenCalledWith('local');
  });

  it.each([
    ['not READY', { instance: { id: 'i', state: 'CLAIMED' as const } }],
    [
      'a different instance',
      { instance: { id: 'x', state: 'READY' as const } },
    ],
    ['missing', { instance: null }],
  ])('is unavailable when the instance is %s', async (_label, overrides) => {
    await expect(
      openOrgProject(target, createStore(true, overrides)),
    ).resolves.toBe('unavailable');
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('is unavailable when the catalog refresh failed', async () => {
    await expect(
      openOrgProject(
        target,
        createStore(true, ready, { 'org:org': 'offline' }),
      ),
    ).resolves.toBe('unavailable');
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('never selects a rebound workspace', async () => {
    loadedProjects = [
      { id: 'local', owner: { ...expectedBinding, bindingGeneration: 3 } },
    ];
    await expect(
      openOrgProject(target, createStore(true, ready)),
    ).resolves.toBe('unavailable');
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('is superseded outside the target organization', async () => {
    activeContext = { kind: 'organization', organizationId: 'other' };
    await expect(
      openOrgProject(target, createStore(true, ready)),
    ).resolves.toBe('superseded');
    expect(mockSelect).not.toHaveBeenCalled();
  });
  it('refuses a target after membership is revoked', async () => {
    organizations = [];
    await expect(
      openOrgProject(target, createStore(true, ready)),
    ).resolves.toBe('unavailable');
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('refuses ambiguous local project bindings', async () => {
    loadedProjects = [boundWorkspace, { ...boundWorkspace, id: 'other' }];
    await expect(
      openOrgProject(target, createStore(true, ready)),
    ).resolves.toBe('unavailable');
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('silently supersedes a rejected load after an external context switch', async () => {
    const store = createStore(true, ready);
    jest.mocked(store.getState().load).mockImplementationOnce(() => {
      activeContext = { kind: 'personal', organizationId: '' };
      return Promise.reject(new Error('offline'));
    });
    await expect(openOrgProject(target, store)).resolves.toBe('superseded');
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('silently supersedes a workspace-context account change even before the catalog epoch changes', async () => {
    const store = createStore(true, ready);
    jest.mocked(store.getState().load).mockImplementationOnce(() => {
      contextEpoch += 1;
      return Promise.resolve();
    });
    await expect(openOrgProject(target, store)).resolves.toBe('superseded');
    expect(mockSelect).not.toHaveBeenCalled();
  });
  it('silently supersedes a context excursion back to the same organization', async () => {
    const store = createStore(true, ready);
    jest.mocked(store.getState().load).mockImplementationOnce(() => {
      contextRevision += 2;
      return Promise.resolve();
    });
    await expect(openOrgProject(target, store)).resolves.toBe('superseded');
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('a refused newer deep link supersedes an open already loading', async () => {
    const store = createStore(true, ready);
    let release: () => void = () => {};
    jest.mocked(store.getState().load).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const opening = openOrgProject(target, store);
    await Promise.resolve();
    await Promise.resolve();
    await openOrgProjectDeepLink({ ok: false }, store);
    release();
    await expect(opening).resolves.toBe('superseded');
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledTimes(1);
  });
});
