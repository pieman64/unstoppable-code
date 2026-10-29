import { create } from 'zustand';
import type * as Zustand from 'zustand';
import type { OrgProjectsStoreState } from '@canopy/app-state';
import type {
  OrgProjectSetupProgress,
  OrgProjectSummary,
} from '@canopy/protocol/org-projects';
import type * as OrgProjectCatalogAdd from '@/lib/orgProjectCatalogAdd';
import type { OrgProjectAddOutcome } from '@/lib/orgProjectCatalogAdd';
import type { OrgProjectOpenOutcome } from '@/lib/openOrgProjectDeepLink';
import { useLinkedPersonalWorkspacesStore } from '@/stores/linkedPersonalWorkspacesStore';
import {
  createDesktopOrgProjectSetupSlot,
  ORG_PROJECT_LINKS_WAIT_MS,
  type OrgProjectSetupSlotStore,
} from '../desktopOrgProjectSetupSlot';

const calls: string[] = [];
const mockAdd = jest.fn<
  Promise<OrgProjectAddOutcome>,
  [unknown, { destination: string | null; onBeforeSetup?: () => void }]
>();
const mockOpen = jest.fn<Promise<OrgProjectOpenOutcome>, [unknown, unknown]>();
const mockCloseSettings = jest.fn((): void => {
  calls.push('closeSettings');
});
const mockAddToast = jest.fn();
let activeContext: { kind: string; organizationId?: string } = {
  kind: 'personal',
};
const mockSetContext = jest.fn(
  (next: { kind: string; organizationId?: string }): Promise<void> => {
    calls.push('setContext');
    activeContext = next;
    return Promise.resolve();
  },
);

jest.mock('@/lib/orgProjectCatalogAdd', () => ({
  ...jest.requireActual<typeof OrgProjectCatalogAdd>(
    '@/lib/orgProjectCatalogAdd',
  ),
  addOrgProjectToComputer: (
    store: unknown,
    options: { destination: string | null; onBeforeSetup?: () => void },
  ): Promise<OrgProjectAddOutcome> => {
    calls.push('addOrgProjectToComputer');
    return mockAdd(store, options);
  },
}));
jest.mock('@/lib/openOrgProjectDeepLink', () => ({
  openOrgProject: (
    target: unknown,
    store: unknown,
  ): Promise<OrgProjectOpenOutcome> => {
    calls.push('openOrgProject');
    return mockOpen(target, store);
  },
}));
jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: {
    getState: (): { closeSettings: () => void } => ({
      closeSettings: mockCloseSettings,
    }),
  },
}));
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: {
    getState: (): { addToast: typeof mockAddToast } => ({
      addToast: mockAddToast,
    }),
  },
}));
jest.mock('@/stores/workspaceContextStore', () => ({
  useWorkspaceContextStore: {
    getState: (): {
      state: { context: typeof activeContext };
      setContext: typeof mockSetContext;
    } => ({
      state: { context: activeContext },
      setContext: mockSetContext,
    }),
  },
}));
jest.mock('@/stores/projectsStore', () => {
  const zustand = jest.requireActual<typeof Zustand>('zustand');
  return {
    useProjectsStore: zustand.create<{ projects: unknown[] }>(() => ({
      projects: [],
    })),
  };
});

// Imported after the mock so the slot and the test share one store.
import { useProjectsStore } from '@/stores/projectsStore';

function orgStore(): OrgProjectSetupSlotStore & {
  setProgress: (progress: Record<string, OrgProjectSetupProgress>) => void;
} {
  const store = create<Pick<OrgProjectsStoreState, 'setupProgress'>>(() => ({
    setupProgress: {},
  }));
  return {
    getState: store.getState as OrgProjectSetupSlotStore['getState'],
    subscribe: store.subscribe as OrgProjectSetupSlotStore['subscribe'],
    setProgress: (setupProgress): void => store.setState({ setupProgress }),
  };
}

const project: OrgProjectSummary = {
  id: 'p1',
  organizationId: 'org',
  name: 'Launch planning',
  description: null,
  kind: 'COWORK',
  purpose: 'project',
  visibility: 'private',
  memberOwned: true,
  location: 'LOCAL',
  repository: null,
  state: 'ACTIVE',
  revision: 1,
  authorizationVersion: 1,
  defaultListed: true,
  preference: 'ADDED',
  listed: true,
  capabilities: { administer: true, manageCloud: false, use: true },
  instance: null,
};

function localWorkspace(projectId: string): {
  id: string;
  owner: {
    type: 'organization';
    organizationId: string;
    projectId: string;
    instanceId: string;
    bindingGeneration: number;
  };
} {
  return {
    id: `ws-${projectId}`,
    owner: {
      type: 'organization',
      organizationId: 'org',
      projectId,
      instanceId: 'instance',
      bindingGeneration: 1,
    },
  };
}

const loadPreferences = jest.fn(() =>
  Promise.resolve({ orgProjectDefaultDestinationRoot: '/code' }),
);
const linksList = jest.fn(() =>
  Promise.resolve({
    status: 'resolved',
    links: [{ projectId: 'p1', personalWorkspaceId: 'personal-ws' }],
  }),
);

beforeAll(() => {
  Object.defineProperty(globalThis, 'window', {
    value: { api: { loadPreferences, orgProjects: { linksList } } },
    configurable: true,
  });
});

beforeEach(() => {
  calls.length = 0;
  jest.clearAllMocks();
  activeContext = { kind: 'personal' };
  useProjectsStore.setState({ projects: [] });
  useLinkedPersonalWorkspacesStore.getState().setProjectIds([], null);
  mockAdd.mockImplementation((_store, options) => {
    options.onBeforeSetup?.();
    return Promise.resolve({ kind: 'setup-requested' });
  });
  mockOpen.mockResolvedValue('opened');
});

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe('getLocalStatuses', () => {
  it('returns the same Map until an input changes', () => {
    const store = orgStore();
    const slot = createDesktopOrgProjectSetupSlot(store);
    const first = slot.getLocalStatuses('org');
    expect(slot.getLocalStatuses('org')).toBe(first);
    store.setProgress({
      p1: {
        projectId: 'p1',
        instanceId: null,
        state: 'claiming',
        message: null,
        percent: null,
        updatedAt: '2026-10-19T00:00:00.000Z',
      },
    });
    const next = slot.getLocalStatuses('org');
    expect(next).not.toBe(first);
    expect(next.get('p1')?.state).toBe('setting-up');
    expect(slot.getLocalStatuses('org')).toBe(next);
  });

  it('keeps the same Map when the sidebar reloads without a status change', () => {
    useProjectsStore.setState({ projects: [localWorkspace('p1')] });
    const slot = createDesktopOrgProjectSetupSlot(orgStore());
    const first = slot.getLocalStatuses('org');
    useProjectsStore.setState({
      projects: [localWorkspace('p1'), { id: 'personal' }],
    });
    expect(slot.getLocalStatuses('org')).toBe(first);
    useProjectsStore.setState({ projects: [] });
    expect(slot.getLocalStatuses('org')).not.toBe(first);
  });

  it('counts links only once they are answered for this organization', () => {
    const slot = createDesktopOrgProjectSetupSlot(orgStore());
    useLinkedPersonalWorkspacesStore.getState().setProjectIds(['p1'], 'other');
    expect(slot.getLocalStatuses('org').has('p1')).toBe(false);
    useLinkedPersonalWorkspacesStore.getState().setProjectIds(['p1'], 'org');
    expect(slot.getLocalStatuses('org').get('p1')).toEqual({ state: 'ready' });
  });

  it('notifies subscribers when any input store changes, until unsubscribed', () => {
    const store = orgStore();
    const slot = createDesktopOrgProjectSetupSlot(store);
    const onChange = jest.fn();
    const unsubscribe = slot.subscribe('org', onChange);
    useProjectsStore.setState({ projects: [localWorkspace('p1')] });
    useLinkedPersonalWorkspacesStore.getState().setProjectIds(['p2'], 'org');
    store.setProgress({});
    expect(onChange).toHaveBeenCalledTimes(3);
    unsubscribe();
    useProjectsStore.setState({ projects: [] });
    expect(onChange).toHaveBeenCalledTimes(3);
  });
});

describe('setUp', () => {
  it('switches context, waits for links, then adds; Settings close only from onBeforeSetup', async () => {
    const slot = createDesktopOrgProjectSetupSlot(orgStore());
    mockSetContext.mockImplementationOnce((next) => {
      calls.push('setContext');
      activeContext = next;
      // Links for the new organization arrive after the switch.
      setTimeout(() => {
        calls.push('links');
        useLinkedPersonalWorkspacesStore.getState().setProjectIds([], 'org');
      }, 0);
      return Promise.resolve();
    });
    await slot.setUp('org', project, signal());
    expect(mockSetContext).toHaveBeenCalledWith({
      kind: 'organization',
      organizationId: 'org',
    });
    expect(calls).toEqual([
      'setContext',
      'links',
      'addOrgProjectToComputer',
      'closeSettings',
    ]);
  });

  it('does not switch context when the organization is current', async () => {
    activeContext = { kind: 'organization', organizationId: 'org' };
    useLinkedPersonalWorkspacesStore.getState().setProjectIds([], 'org');
    const slot = createDesktopOrgProjectSetupSlot(orgStore());
    await slot.setUp('org', project, signal());
    expect(mockSetContext).not.toHaveBeenCalled();
  });

  it('passes the remembered folder for a ready Code project', async () => {
    activeContext = { kind: 'organization', organizationId: 'org' };
    useLinkedPersonalWorkspacesStore.getState().setProjectIds([], 'org');
    const slot = createDesktopOrgProjectSetupSlot(orgStore());
    await slot.setUp(
      'org',
      {
        ...project,
        kind: 'CODE',
        repository: {
          provider: 'github',
          host: 'github.com',
          owner: 'acme',
          name: 'canopy',
          providerRepoId: '1',
          defaultBranch: 'main',
          verification: 'VERIFIED',
        },
      },
      signal(),
    );
    expect(mockAdd.mock.calls[0]?.[1].destination).toBe('/code');
  });

  it('gives up waiting for links after the timeout and lets Add decide', async () => {
    jest.useFakeTimers();
    try {
      activeContext = { kind: 'organization', organizationId: 'org' };
      mockAdd.mockResolvedValueOnce({ kind: 'links-unknown' });
      const slot = createDesktopOrgProjectSetupSlot(orgStore());
      const result = slot.setUp('org', project, signal());
      const settled = expect(result).rejects.toThrow(
        "Couldn't check this computer for the project. Try again.",
      );
      await jest.advanceTimersByTimeAsync(ORG_PROJECT_LINKS_WAIT_MS);
      await settled;
      expect(mockCloseSettings).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    [
      { kind: 'listing-failed' } as const,
      "Couldn't add the project to your list. Try again.",
    ],
    [{ kind: 'setup-failed', message: 'Disk full' } as const, 'Disk full'],
  ])('rejects on %o without closing Settings', async (outcome, message) => {
    activeContext = { kind: 'organization', organizationId: 'org' };
    useLinkedPersonalWorkspacesStore.getState().setProjectIds([], 'org');
    mockAdd.mockResolvedValueOnce(outcome);
    const slot = createDesktopOrgProjectSetupSlot(orgStore());
    await expect(slot.setUp('org', project, signal())).rejects.toThrow(message);
    expect(mockCloseSettings).not.toHaveBeenCalled();
  });

  it('reports a setup that fails after Settings closed as a toast', async () => {
    activeContext = { kind: 'organization', organizationId: 'org' };
    useLinkedPersonalWorkspacesStore.getState().setProjectIds([], 'org');
    mockAdd.mockImplementationOnce((_store, options) => {
      options.onBeforeSetup?.();
      return Promise.resolve({ kind: 'setup-failed', message: 'Disk full' });
    });
    const slot = createDesktopOrgProjectSetupSlot(orgStore());
    await expect(slot.setUp('org', project, signal())).rejects.toThrow(
      'Disk full',
    );
    expect(mockCloseSettings).toHaveBeenCalledTimes(1);
    expect(mockAddToast).toHaveBeenCalledWith('Disk full', 'error');
  });

  it('rejects when the context switch fails, before adding', async () => {
    mockSetContext.mockRejectedValueOnce(new Error('ipc'));
    const slot = createDesktopOrgProjectSetupSlot(orgStore());
    await expect(slot.setUp('org', project, signal())).rejects.toThrow(
      "Couldn't switch to this organization. Try again.",
    );
    expect(mockAdd).not.toHaveBeenCalled();
    expect(mockCloseSettings).not.toHaveBeenCalled();
  });

  it('rejects with an AbortError once aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const slot = createDesktopOrgProjectSetupSlot(orgStore());
    await expect(
      slot.setUp('org', project, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(mockSetContext).not.toHaveBeenCalled();
  });

  it('refuses a project that cannot be set up here', async () => {
    const slot = createDesktopOrgProjectSetupSlot(orgStore());
    await expect(
      slot.setUp('org', { ...project, location: 'CLOUD' }, signal()),
    ).rejects.toThrow("This project can't be set up on this computer.");
    expect(mockSetContext).not.toHaveBeenCalled();
  });

  it('refuses a multi-repo project, which the catalog cannot set up', async () => {
    const slot = createDesktopOrgProjectSetupSlot(orgStore());
    await expect(
      slot.setUp('org', { ...project, topology: 'multi-repo' }, signal()),
    ).rejects.toThrow("This project can't be set up on this computer.");
    expect(mockSetContext).not.toHaveBeenCalled();
    expect(mockAdd).not.toHaveBeenCalled();
  });
});

describe('open', () => {
  it('rejects before touching context or Settings when nothing is checked out', async () => {
    const slot = createDesktopOrgProjectSetupSlot(orgStore());
    await expect(slot.open('org', project, signal())).rejects.toThrow(
      'Project not available',
    );
    expect(mockSetContext).not.toHaveBeenCalled();
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockCloseSettings).not.toHaveBeenCalled();
  });

  it('switches context, opens, then closes Settings', async () => {
    useProjectsStore.setState({ projects: [localWorkspace('p1')] });
    const slot = createDesktopOrgProjectSetupSlot(orgStore());
    await slot.open('org', project, signal());
    expect(calls).toEqual(['setContext', 'openOrgProject', 'closeSettings']);
    expect(mockOpen.mock.calls[0]?.[0]).toEqual({
      organizationId: 'org',
      projectId: 'p1',
      workspaceId: 'ws-p1',
    });
  });

  it('opens the linked Personal checkout of a project with no bound one', async () => {
    useLinkedPersonalWorkspacesStore.getState().setProjectIds(['p1'], 'org');
    useProjectsStore.setState({
      projects: [localWorkspace('other'), { id: 'personal-ws' }],
    });
    const slot = createDesktopOrgProjectSetupSlot(orgStore());
    await slot.open('org', project, signal());
    expect(calls).toEqual(['setContext', 'openOrgProject', 'closeSettings']);
    expect(mockOpen.mock.calls[0]?.[0]).toEqual({
      organizationId: 'org',
      projectId: 'p1',
      workspaceId: 'personal-ws',
      linkedPersonal: true,
    });
  });

  it('keeps Settings open when the canonical open refuses a linked checkout', async () => {
    useLinkedPersonalWorkspacesStore.getState().setProjectIds(['p1'], 'org');
    useProjectsStore.setState({ projects: [{ id: 'personal-ws' }] });
    mockOpen.mockResolvedValueOnce('unavailable');
    const slot = createDesktopOrgProjectSetupSlot(orgStore());
    await expect(slot.open('org', project, signal())).rejects.toThrow(
      'Project not available',
    );
    expect(mockCloseSettings).not.toHaveBeenCalled();
  });

  it('rejects a linked project whose checkout is gone, keeping Settings open', async () => {
    useLinkedPersonalWorkspacesStore.getState().setProjectIds(['p1'], 'org');
    const slot = createDesktopOrgProjectSetupSlot(orgStore());
    await expect(slot.open('org', project, signal())).rejects.toThrow(
      'Project not available',
    );
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockCloseSettings).not.toHaveBeenCalled();
  });

  it('rejects when unavailable and keeps Settings open', async () => {
    useProjectsStore.setState({ projects: [localWorkspace('p1')] });
    mockOpen.mockResolvedValueOnce('unavailable');
    const slot = createDesktopOrgProjectSetupSlot(orgStore());
    await expect(slot.open('org', project, signal())).rejects.toThrow(
      'Project not available',
    );
    expect(mockCloseSettings).not.toHaveBeenCalled();
  });

  it('stays silent when a newer open supersedes it', async () => {
    useProjectsStore.setState({ projects: [localWorkspace('p1')] });
    mockOpen.mockResolvedValueOnce('superseded');
    const slot = createDesktopOrgProjectSetupSlot(orgStore());
    await expect(slot.open('org', project, signal())).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(mockCloseSettings).not.toHaveBeenCalled();
  });
});
