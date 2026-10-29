/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import { useAgentsStore } from '@/stores/agentsStore';
import { useAutomationsStore } from '@/stores/automationsStore';
import type * as PipelineListModule from '../usePipelineList';
import { AUTOMATION_PUBLIC_SHARE_CHANGED_EVENT } from '@/lib/share-links';
import {
  useCapabilityMarketplaceInventory,
  type CapabilityMarketplaceInventory,
} from '../useCapabilityMarketplaceInventory';
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});
const mockRefreshLocal = jest.fn(async (): Promise<void> => {
  await Promise.resolve();
});
const mockRefreshShared = jest.fn(async (): Promise<void> => {
  await Promise.resolve();
});
const mockSetFilters = jest.fn();
const mockCurated = jest.fn<
  { rows: never[]; loading: boolean; error: string },
  [unknown?]
>(() => ({
  rows: [],
  loading: false,
  error: 'Catalog unavailable',
}));
const mockAccount = {
  hasApiKey: true,
  account: { id: 'account' },
  capabilities: ['pipelines-crud-v1'],
};
const mockRefreshSharedAutomations = jest.fn(async (): Promise<void> => {
  await Promise.resolve();
});
const mockGetSharedAutomation = jest.fn();
const mockGetCuratedAutomation = jest.fn();
const mockSetAutomationFilters = jest.fn();
const DEFAULT_SHARED_AUTOMATIONS: readonly Record<string, unknown>[] = [
  { id: 'share-personal', owner: { type: 'user', id: 'me', name: 'Me' } },
  {
    id: 'share-org',
    owner: { type: 'organization', id: 'org', name: 'Org' },
  },
  {
    id: 'public-share',
    shareScope: 'private',
    owner: { type: 'user', id: 'me', name: 'Me' },
    publicShare: { externalId: 'public-share-id' },
  },
];
const mockSharedAutomations: {
  automations: readonly Record<string, unknown>[];
  loaded: boolean;
} = {
  automations: DEFAULT_SHARED_AUTOMATIONS,
  loaded: false,
};
const mockCuratedAutomations = jest.fn<
  { rows: never[]; loading: boolean; error: null },
  [unknown?]
>(() => ({ rows: [], loading: false, error: null }));
let mockInContextIds: ReadonlySet<string> | null = null;
let mockSharesInContext: ReadonlySet<string> | null = null;
const mockAutomationScope = {
  inContext: (activity: { id?: string }): boolean =>
    mockInContextIds === null ||
    (activity.id !== undefined && mockInContextIds.has(activity.id)),
  shareInContext: (summary: { id?: string }): boolean =>
    mockSharesInContext === null ||
    (summary.id !== undefined && mockSharesInContext.has(summary.id)),
};
jest.mock('../useSharedAutomationList', () => ({
  useSharedAutomationList: (): Record<string, unknown> => ({
    automations: mockSharedAutomations.automations,
    cloudAccount: mockAccount,
    cloudLoading: false,
    loading: false,
    loadingMore: false,
    loaded: mockSharedAutomations.loaded,
    nextCursor: 'automation-page2',
    error: null,
    setFilters: mockSetAutomationFilters,
    refreshShared: mockRefreshSharedAutomations,
    loadMoreShared: jest.fn(),
  }),
}));
jest.mock('../useCuratedAutomations', () => ({
  useCuratedAutomations: (
    options: unknown,
  ): ReturnType<typeof mockCuratedAutomations> =>
    mockCuratedAutomations(options),
}));
jest.mock('../useAutomationScope', () => ({
  useAutomationScope: (): Record<string, unknown> => mockAutomationScope,
}));

function activity(
  id: string,
  overrides: Partial<ScheduledActivity> = {},
): ScheduledActivity {
  return {
    version: 1,
    id,
    name: id,
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'local' },
    action: { type: 'app_advisor_prompt', prompt: 'Summarize the day' },
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    failureCount: 0,
    ...overrides,
  };
}
const mockLocalPipelineRows = [{ id: 'local', source: 'user' }];
const mockSharedPipelineRows = [{ id: 'shared', source: 'shared' }];
let mockUseRealPipelineList = false;
const mockSharedPipelineState = {
  rows: mockSharedPipelineRows,
  cloudAccount: mockAccount,
  cloudLoading: false,
  loading: false,
  loaded: true,
  error: null,
  nextCursor: 'shared-page2',
  loadingMore: false,
  refreshShared: mockRefreshShared,
  setFilters: mockSetFilters,
  loadMoreShared: jest.fn(),
};
jest.mock('../useSharedPipelineList', () => ({
  useSharedPipelineList: (): typeof mockSharedPipelineState =>
    mockSharedPipelineState,
}));
jest.mock('../usePipelineList', () => ({
  usePipelineList: (): Record<string, unknown> =>
    mockUseRealPipelineList
      ? {
          ...jest
            .requireActual<typeof PipelineListModule>('../usePipelineList')
            .usePipelineList(),
        }
      : {
          pipelines: mockLocalPipelineRows,
          loading: false,
          error: null,
          refresh: mockRefreshLocal,
          refreshSharedList: mockRefreshShared,
          setSharedFilters: mockSetFilters,
          loadMoreShared: jest.fn(),
          shared: {
            rows: mockSharedPipelineRows,
            cloudAccount: mockAccount,
            cloudLoading: false,
            loading: false,
            loaded: true,
            error: null,
            nextCursor: 'shared-page2',
            loadingMore: false,
          },
        },
}));
jest.mock('../useCuratedPipelines', () => ({
  useCuratedPipelines: (options: unknown): ReturnType<typeof mockCurated> =>
    mockCurated(options),
}));
jest.mock('../useCollectionList', () => ({
  useCollectionList: (): Record<string, unknown> => ({
    collections: [],
    loading: false,
    error: null,
    refresh: jest.fn(),
  }),
}));
const mockSetSkillFilters = jest.fn();
let mockSharedSkillRows: { id: string }[] = [];
const mockSetCollectionFilters = jest.fn();
let mockSharedCollectionRows: { id: string }[] = [];
const mockSkillPage: {
  nextCursor: string | null;
  loadingMore: boolean;
  error: string | null;
} = { nextCursor: null, loadingMore: false, error: null };
const mockCollectionPage: {
  nextCursor: string | null;
  loadingMore: boolean;
  error: string | null;
} = { nextCursor: null, loadingMore: false, error: null };
const mockLoadMoreSkills = jest.fn(async (): Promise<void> => {});
const mockLoadMoreCollections = jest.fn(async (): Promise<void> => {});
jest.mock('../useSharedSkillList', () => ({
  useSharedSkillList: (): Record<string, unknown> => ({
    skills: mockSharedSkillRows,
    ...mockSkillPage,
    loadMoreShared: mockLoadMoreSkills,
    cloudAccount: null,
    cloudLoading: false,
    loading: false,
    loaded: true,
    setFilters: mockSetSkillFilters,
    refreshShared: jest.fn(),
  }),
}));
jest.mock('../useSharedCollectionList', () => ({
  useSharedCollectionList: (): Record<string, unknown> => ({
    collections: mockSharedCollectionRows,
    ...mockCollectionPage,
    loadMoreShared: mockLoadMoreCollections,
    cloudAccount: null,
    cloudLoading: false,
    loading: false,
    loaded: true,
    setFilters: mockSetCollectionFilters,
    refreshShared: jest.fn(),
  }),
}));
let inventory: CapabilityMarketplaceInventory;
let curatedAutomationsEnabled: boolean | undefined;
let sharedPluginsEnabled: boolean | undefined;
let ownedAutomationSharesEnabled = false;
let sharedAgentsEnabled = false;
let ownedAgentSharesEnabled = false;
let completeSharedCatalogs = false;
const mockListOwnedAutomations = jest.fn();
let localAgentsEnabled: boolean | undefined;
const mockListSharedPlugins = jest.fn();
function Harness(): null {
  inventory = useCapabilityMarketplaceInventory('review', {
    category: 'development',
    scope: 'directory',
    triggerType: 'dispatch',
    ...(curatedAutomationsEnabled !== undefined
      ? { curatedAutomationsEnabled }
      : {}),
    ...(sharedPluginsEnabled !== undefined ? { sharedPluginsEnabled } : {}),
    ownedAutomationSharesEnabled,
    sharedAgentsEnabled,
    ownedAgentSharesEnabled,
    completeSharedCatalogs,
    ...(localAgentsEnabled !== undefined ? { localAgentsEnabled } : {}),
  });
  return null;
}
let root: Root;
beforeEach(() => {
  mockUseRealPipelineList = false;
  mockSharedSkillRows = [];
  mockSharedCollectionRows = [];
  for (const page of [mockSkillPage, mockCollectionPage]) {
    page.nextCursor = null;
    page.loadingMore = false;
    page.error = null;
  }
  mockLoadMoreSkills.mockReset();
  mockLoadMoreCollections.mockReset();
  jest.clearAllMocks();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      automations: {
        listShared: mockListOwnedAutomations,
        getShared: mockGetSharedAutomation,
        getCurated: mockGetCuratedAutomation,
      },
    },
  });
  Object.defineProperty(window, 'plugins', {
    configurable: true,
    value: { listShared: mockListSharedPlugins },
  });
  mockAccount.capabilities = ['pipelines-crud-v1'];
  mockAccount.account.id = 'account';
  mockGetSharedAutomation.mockResolvedValue({ contentHash: 'current' });
  mockGetCuratedAutomation.mockResolvedValue({ contentHash: 'current' });
  mockSharedAutomations.loaded = false;
  mockInContextIds = null;
  mockSharesInContext = null;
  curatedAutomationsEnabled = undefined;
  sharedPluginsEnabled = undefined;
  ownedAutomationSharesEnabled = false;
  sharedAgentsEnabled = false;
  ownedAgentSharesEnabled = false;
  completeSharedCatalogs = false;
  mockListOwnedAutomations.mockResolvedValue({ automations: [] });
  localAgentsEnabled = undefined;
  mockSharedAutomations.automations = DEFAULT_SHARED_AUTOMATIONS;
  useAutomationsStore.setState({
    activities: [],
    hydrated: true,
    loading: false,
    error: null,
  });
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
});

it.each([
  'pipelines',
  'sharedSkills',
  'sharedCollections',
  'sharedAgents',
  'sharedPlugins',
] as const)(
  'keeps %s stable while its source inventory is unchanged',
  async (key) => {
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    const previous = inventory[key];
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    // PluginsPage caches the selected projected entry in an effect. A new
    // array on every render rebuilds that entry and keeps the effect running.
    expect(inventory[key]).toBe(previous);
  },
);

it('publishes changed shared rows after preserving an unchanged snapshot', async () => {
  mockSharedSkillRows = [{ id: 'first' }];
  await act(async () => {
    root.render(<Harness />);
    await Promise.resolve();
  });
  const previous = inventory.sharedSkills;
  mockSharedSkillRows = [...mockSharedSkillRows, { id: 'second' }];
  await act(async () => {
    root.render(<Harness />);
    await Promise.resolve();
  });
  expect(inventory.sharedSkills).not.toBe(previous);
  expect(inventory.sharedSkills.map((row) => row.id)).toEqual([
    'first',
    'second',
  ]);
});

it('keeps marketplace pipelines stable through the real pipeline inventory hook', async () => {
  mockUseRealPipelineList = true;
  const list = jest
    .fn()
    .mockResolvedValue({ success: true, data: mockLocalPipelineRows });
  Object.defineProperty(window, 'pipelines', {
    configurable: true,
    value: { list },
  });
  await act(async () => {
    root.render(<Harness />);
    await Promise.resolve();
  });
  expect(inventory.pipelines.map((row) => row.id)).toEqual(['local', 'shared']);
  const previous = inventory.pipelines;
  await act(async () => {
    root.render(<Harness />);
    await Promise.resolve();
  });
  expect(inventory.pipelines).toBe(previous);
  expect(list).toHaveBeenCalledTimes(1);

  list.mockResolvedValue({
    success: true,
    data: [...mockLocalPipelineRows, { id: 'new', source: 'user' }],
  });
  await act(async () => {
    await inventory.refreshPipelines();
  });
  expect(inventory.pipelines.map((row) => row.id)).toEqual([
    'local',
    'new',
    'shared',
  ]);
  expect(inventory.pipelines).not.toBe(previous);
});
it('refreshes local and shared sources together and retains valid inventory during catalog failure', async () => {
  await act(async () => {
    await Promise.resolve();
    root.render(<Harness />);
  });
  expect(inventory.pipelines.map((row) => row.id)).toEqual(['local', 'shared']);
  await act(async () => {
    await inventory.refreshPipelines();
  });
  expect(mockRefreshLocal).toHaveBeenCalledTimes(1);
  expect(mockRefreshShared).toHaveBeenCalledTimes(1);
  expect(inventory.sharedPipelineNextCursor).toBe('shared-page2');
  expect(mockSetFilters).toHaveBeenCalledWith({
    q: 'review',
    triggerType: 'dispatch',
  });
  expect(mockCurated).toHaveBeenLastCalledWith(
    expect.objectContaining({
      q: 'review',
      category: 'development',
      scope: 'directory',
      triggerType: 'dispatch',
      enabled: true,
    }),
  );
});

it('keeps acknowledged deletions out of retained or stale inventory, scoped to its account', async () => {
  mockSharedSkillRows.push({ id: 'deleted' });
  await act(async () => {
    root.render(<Harness />);
    await Promise.resolve();
  });
  expect(inventory.sharedSkills.map((row) => row.id)).toEqual(['deleted']);
  act(() => {
    inventory.removeSharedResource('skill', 'deleted');
  });
  expect(inventory.sharedSkills).toEqual([]);
  // Even a stale answer/failing refresh that leaves the original rows cannot restore it.
  await act(async () => {
    root.render(<Harness />);
    await Promise.resolve();
  });
  expect(inventory.sharedSkills).toEqual([]);
  mockAccount.account.id = 'another-account';
  await act(async () => {
    root.render(<Harness />);
    await Promise.resolve();
  });
  expect(inventory.sharedSkills.map((row) => row.id)).toEqual(['deleted']);
});

it('completes shared skill and collection catalogs beyond the first 25 rows', async () => {
  mockSharedAutomations.automations = [];
  completeSharedCatalogs = true;
  for (let index = 0; index < 25; index += 1) {
    mockSharedSkillRows.push({ id: `skill-${index}` });
    mockSharedCollectionRows.push({ id: `collection-${index}` });
  }
  mockSkillPage.nextCursor = 'skills-page-2';
  mockCollectionPage.nextCursor = 'collections-page-2';
  mockLoadMoreSkills.mockImplementation(async () => {
    await Promise.resolve();
    mockSharedSkillRows = [...mockSharedSkillRows, { id: 'skill-26' }];
    mockSkillPage.nextCursor = null;
  });
  mockLoadMoreCollections.mockImplementation(async () => {
    await Promise.resolve();
    mockSharedCollectionRows = [
      ...mockSharedCollectionRows,
      { id: 'collection-26' },
    ];
    mockCollectionPage.nextCursor = null;
  });
  await act(async () => {
    root.render(<Harness />);
    await Promise.resolve();
  });
  expect(mockLoadMoreSkills).toHaveBeenCalledTimes(1);
  expect(mockLoadMoreCollections).toHaveBeenCalledTimes(1);
  await act(async () => {
    root.render(<Harness />);
    await Promise.resolve();
  });
  expect(inventory.sharedSkills.map((row) => row.id)).toContain('skill-26');
  expect(inventory.sharedCollections.map((row) => row.id)).toContain(
    'collection-26',
  );
  expect(mockLoadMoreSkills).toHaveBeenCalledTimes(1);
  expect(mockLoadMoreCollections).toHaveBeenCalledTimes(1);
});

it('does not drain default lists or retry failed owned pages automatically', async () => {
  mockSharedAutomations.automations = [];
  mockSkillPage.nextCursor = 'skills-page-2';
  mockCollectionPage.nextCursor = 'collections-page-2';
  await act(async () => {
    root.render(<Harness />);
    await Promise.resolve();
  });
  expect(mockLoadMoreSkills).not.toHaveBeenCalled();
  expect(mockLoadMoreCollections).not.toHaveBeenCalled();
  completeSharedCatalogs = true;
  mockSkillPage.error = 'Offline';
  mockCollectionPage.error = 'Offline';
  await act(async () => {
    root.render(<Harness />);
    await Promise.resolve();
  });
  expect(mockLoadMoreSkills).not.toHaveBeenCalled();
  expect(mockLoadMoreCollections).not.toHaveBeenCalled();
});

it('skips the shared source when refreshing without its Cloud capability', async () => {
  mockAccount.capabilities = [];
  await act(async () => {
    await Promise.resolve();
    root.render(<Harness />);
  });

  await act(async () => {
    await inventory.refreshPipelines();
  });

  expect(mockRefreshLocal).toHaveBeenCalledTimes(1);
  expect(mockRefreshShared).not.toHaveBeenCalled();
});

describe('automations', () => {
  async function render(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      root.render(<Harness />);
    });
  }

  it('reports a failed first automation read as an error, not endless loading', async () => {
    const hydrate = jest
      .spyOn(useAutomationsStore.getState(), 'hydrate')
      .mockResolvedValue(undefined);
    try {
      useAutomationsStore.setState({
        hydrated: false,
        loading: false,
        error: null,
      });
      await render();
      // Not read yet: still loading, so no empty state flashes first.
      expect(inventory.installedInventory).toBe('loading');
      expect(inventory.loading).toBe(true);

      act(() => {
        useAutomationsStore.setState({ error: 'Automations unavailable' });
      });
      expect(inventory.installedInventory).toBe('error');
      // The page skeleton must give way to the Installed error and Retry.
      expect(inventory.loading).toBe(false);

      act(() => {
        useAutomationsStore.setState({ hydrated: true, error: null });
      });
      expect(inventory.installedInventory).toBe('ready');
    } finally {
      hydrate.mockRestore();
    }
  });

  it('loads team-shared automations only with the automations capability', async () => {
    await render();
    expect(mockRefreshSharedAutomations).not.toHaveBeenCalled();

    act(() => root.unmount());
    mockAccount.capabilities = ['automations-crud-v1'];
    root = createRoot(document.createElement('div'));
    await render();

    expect(mockRefreshSharedAutomations).toHaveBeenCalledTimes(1);
    expect(mockSetAutomationFilters).toHaveBeenCalledWith({ q: 'review' });
    expect(inventory.sharedAutomationNextCursor).toBe('automation-page2');
  });

  it('loads the curated automation catalog only with its capability', async () => {
    mockAccount.capabilities = ['automations-crud-v1'];
    await render();
    expect(mockCuratedAutomations).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: 'review', enabled: false }),
    );

    act(() => root.unmount());
    mockAccount.capabilities = ['automation-catalog-v1'];
    root = createRoot(document.createElement('div'));
    await render();

    expect(mockCuratedAutomations).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: 'review', enabled: true }),
    );
  });

  it('leaves the curated automation catalog unloaded on tabs that never list it', async () => {
    mockAccount.capabilities = ['automation-catalog-v1'];
    curatedAutomationsEnabled = false;
    await render();

    expect(mockCuratedAutomations).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it('lists local automations in the selected context and keeps every copy for install detection', async () => {
    useAutomationsStore.setState({
      activities: [
        activity('in-context', {
          remote: {
            remoteId: 'share-mine',
            contentHash: 'a'.repeat(64),
            sharedAt: '2026-08-19T00:00:00.000Z',
          },
        }),
        activity('elsewhere', {
          installedFrom: {
            remoteId: 'daily-review',
            contentHash: 'b'.repeat(64),
            installedAt: '2026-08-19T00:00:00.000Z',
            sourceKind: 'curated',
          },
        }),
      ],
    });
    mockInContextIds = new Set(['in-context']);
    await render();

    expect(inventory.localAutomations).toEqual([
      {
        id: 'in-context',
        name: 'in-context',
        description: 'Scheduled · App Advisor prompt: Summarize the day',
        sharedRemoteId: 'share-mine',
      },
    ]);
    expect(inventory.automationActivities.map((item) => item.id)).toEqual([
      'in-context',
      'elsewhere',
    ]);
  });

  it('lists only the team-shared automations of the selected context', async () => {
    mockSharesInContext = new Set(['share-org']);
    await render();

    expect(inventory.sharedAutomations.map((item) => item.id)).toEqual([
      'share-org',
    ]);
  });

  it('keeps public-link automations out of Marketplace', async () => {
    await render();

    expect(inventory.sharedAutomations.map((item) => item.id)).toEqual([
      'share-personal',
      'share-org',
    ]);
  });

  describe('additional owned-share lane', () => {
    const ME = { id: 'account', name: 'Me', email: null };
    const SOMEONE_ELSE = { id: 'someone-else', name: 'Sam', email: null };
    const ownedRows = [
      {
        id: 'mine-team',
        shareScope: 'team',
        owner: { type: 'team', id: 'team', name: 'Platform' },
        createdBy: ME,
      },
      {
        id: 'mine-public-link',
        publicShare: { externalId: 'mine-public-link' },
        shareScope: 'private',
        owner: { type: 'user', id: 'account', name: 'Me' },
        createdBy: ME,
      },
      {
        id: 'theirs-team',
        shareScope: 'team',
        owner: { type: 'team', id: 'team', name: 'Platform' },
        createdBy: SOMEONE_ELSE,
      },
      {
        id: 'theirs-private',
        shareScope: 'private',
        owner: { type: 'user', id: 'someone-else', name: 'Sam' },
        createdBy: SOMEONE_ELSE,
      },
    ];

    it("adds the viewer's public-link shares without replacing the default lane", async () => {
      mockSharedAutomations.automations = ownedRows;
      ownedAutomationSharesEnabled = true;
      mockAccount.capabilities = ['pipelines-crud-v1', 'automations-crud-v1'];
      mockListOwnedAutomations.mockResolvedValue({ automations: ownedRows });
      await render();

      expect(inventory.sharedAutomations.map((item) => item.id)).toEqual([
        'mine-team',
        'theirs-team',
        'mine-public-link',
      ]);
      expect(mockSetAutomationFilters).toHaveBeenLastCalledWith({
        q: 'review',
      });
    });

    it('keeps default shared lists unrestricted alongside the owned lane', async () => {
      ownedAutomationSharesEnabled = true;
      mockAccount.capabilities = ['automations-crud-v1'];
      mockListOwnedAutomations.mockResolvedValue({ automations: ownedRows });
      await render();
      expect(mockSetAutomationFilters).toHaveBeenLastCalledWith({
        q: 'review',
      });
      expect(mockListOwnedAutomations).toHaveBeenCalledWith(
        expect.objectContaining({ createdBy: 'me', query: 'review' }),
      );
    });

    it('keeps the default listing unchanged when the facet is off', async () => {
      mockSharedAutomations.automations = ownedRows;
      ownedAutomationSharesEnabled = false;
      await render();

      expect(inventory.sharedAutomations.map((item) => item.id)).toEqual([
        'mine-team',
        'theirs-team',
      ]);
      expect(mockSetAutomationFilters).toHaveBeenLastCalledWith({
        q: 'review',
      });
    });

    it('honors the selected Personal or organization context', async () => {
      mockSharedAutomations.automations = ownedRows;
      mockSharesInContext = new Set(['mine-public-link', 'theirs-private']);
      ownedAutomationSharesEnabled = true;
      mockAccount.capabilities = ['pipelines-crud-v1', 'automations-crud-v1'];
      mockListOwnedAutomations.mockResolvedValue({ automations: ownedRows });
      await render();

      expect(inventory.sharedAutomations.map((item) => item.id)).toEqual([
        'mine-public-link',
      ]);
    });

    it('lists nothing before the Cloud account names the viewer', async () => {
      mockSharedAutomations.automations = ownedRows;
      const previousAccount = mockAccount.account;
      Reflect.deleteProperty(mockAccount, 'account');
      ownedAutomationSharesEnabled = true;
      mockAccount.capabilities = ['pipelines-crud-v1', 'automations-crud-v1'];
      mockListOwnedAutomations.mockResolvedValue({ automations: ownedRows });
      try {
        await render();
        expect(inventory.viewerId).toBeNull();
        expect(mockListOwnedAutomations).not.toHaveBeenCalled();
        expect(inventory.sharedAutomations.map((row) => row.id)).toEqual([
          'mine-team',
          'theirs-team',
        ]);
      } finally {
        mockAccount.account = previousAccount;
      }
    });

    it('drops a revoked public link from the owned lane without remounting', async () => {
      ownedAutomationSharesEnabled = true;
      mockAccount.capabilities = ['pipelines-crud-v1', 'automations-crud-v1'];
      mockListOwnedAutomations.mockResolvedValue({ automations: ownedRows });
      await render();
      expect(inventory.sharedAutomations.map((item) => item.id)).toContain(
        'mine-public-link',
      );

      const revoked = ownedRows.map((row) =>
        row.id === 'mine-public-link' ? { ...row, publicShare: null } : row,
      );
      mockListOwnedAutomations.mockResolvedValue({ automations: revoked });
      await act(async () => {
        window.dispatchEvent(new Event(AUTOMATION_PUBLIC_SHARE_CHANGED_EVENT));
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(inventory.sharedAutomations.map((item) => item.id)).not.toContain(
        'mine-public-link',
      );
    });

    it('recovers a failed owned read through refreshOwnedShares', async () => {
      ownedAutomationSharesEnabled = true;
      mockAccount.capabilities = ['pipelines-crud-v1', 'automations-crud-v1'];
      mockListOwnedAutomations.mockRejectedValueOnce(new Error('Offline'));
      await render();
      expect(inventory.loadErrors.map((error) => error.source)).toContain(
        'Your shared automations',
      );

      mockListOwnedAutomations.mockResolvedValue({ automations: ownedRows });
      await act(async () => {
        inventory.refreshOwnedShares();
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(inventory.loadErrors.map((error) => error.source)).not.toContain(
        'Your shared automations',
      );
      expect(inventory.sharedAutomations.map((item) => item.id)).toContain(
        'mine-public-link',
      );
    });

    it('keeps all local installs independently of the owned-share lane', async () => {
      mockSharedAutomations.automations = ownedRows;
      ownedAutomationSharesEnabled = true;
      mockAccount.capabilities = ['pipelines-crud-v1', 'automations-crud-v1'];
      mockListOwnedAutomations.mockResolvedValue({ automations: ownedRows });
      useAutomationsStore.setState({
        activities: [
          activity('source', {
            remote: {
              remoteId: 'mine-public-link',
              contentHash: 'a'.repeat(64),
              sharedAt: '2026-08-19T00:00:00.000Z',
            },
          }),
          activity('unshared'),
          activity('installed-copy', {
            installedFrom: {
              remoteId: 'theirs-team',
              contentHash: 'b'.repeat(64),
              installedAt: '2026-08-19T00:00:00.000Z',
            },
          }),
        ],
      });
      await render();

      expect(inventory.localAutomations.map((item) => item.id)).toEqual([
        'source',
        'unshared',
        'installed-copy',
      ]);
      expect(inventory.automationActivities).toHaveLength(3);
    });
  });

  it('resolves an installed source hash independently of the loaded browse page', async () => {
    mockAccount.capabilities = ['automations-crud-v1'];
    mockGetSharedAutomation.mockResolvedValue({
      id: 'share-after-page-one',
      contentHash: 'c'.repeat(64),
    });
    useAutomationsStore.setState({
      activities: [
        activity('installed', {
          installedFrom: {
            remoteId: 'share-after-page-one',
            contentHash: 'a'.repeat(64),
            installedAt: '2026-08-19T00:00:00.000Z',
            sourceKind: 'shared',
          },
        }),
      ],
    });

    await render();
    await act(async () => {
      for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
    });

    expect(mockGetSharedAutomation).toHaveBeenCalledWith(
      'share-after-page-one',
    );
    expect(inventory.localAutomations).toEqual([
      expect.objectContaining({
        id: 'installed',
        sourceContentHash: 'c'.repeat(64),
      }),
    ]);
  });

  it('re-resolves installed source hashes when the Cloud account changes', async () => {
    mockAccount.capabilities = ['automations-crud-v1'];
    mockGetSharedAutomation
      .mockResolvedValueOnce({
        id: 'shared-source',
        contentHash: 'b'.repeat(64),
      })
      .mockResolvedValueOnce({
        id: 'shared-source',
        contentHash: 'c'.repeat(64),
      });
    useAutomationsStore.setState({
      activities: [
        activity('installed', {
          installedFrom: {
            remoteId: 'shared-source',
            contentHash: 'a'.repeat(64),
            installedAt: '2026-08-19T00:00:00.000Z',
            sourceKind: 'shared',
          },
        }),
      ],
    });

    await render();
    await act(async () => {
      for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
    });
    expect(inventory.localAutomations[0]?.sourceContentHash).toBe(
      'b'.repeat(64),
    );

    mockAccount.account.id = 'other-account';
    await act(async () => {
      root.render(<Harness />);
      for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
    });

    expect(mockGetSharedAutomation).toHaveBeenCalledTimes(2);
    expect(inventory.localAutomations[0]?.sourceContentHash).toBe(
      'c'.repeat(64),
    );
  });
});

describe('shared plugins', () => {
  const TEAM_OWNER = {
    type: 'team',
    id: 'team',
    name: 'Platform',
    organization: { id: 'org', name: 'Org' },
  };

  async function render(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      root.render(<Harness />);
      for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
    });
  }

  it('lists only the plugins shared with a team or organization', async () => {
    mockAccount.capabilities = ['plugins-crud-v1'];
    sharedPluginsEnabled = true;
    mockListSharedPlugins.mockResolvedValue({
      success: true,
      data: {
        serverId: 'cloud',
        data: [
          { externalId: 'team-plugin', shareScope: 'team', owner: TEAM_OWNER },
          {
            externalId: 'org-plugin',
            shareScope: 'organization',
            owner: { type: 'organization', id: 'org', name: 'Org' },
          },
          {
            externalId: 'personal-plugin',
            shareScope: 'private',
            owner: { type: 'user', id: 'me', name: 'Me' },
          },
        ],
      },
    });

    await render();

    expect(inventory.sharedPlugins.map((row) => row.externalId)).toEqual([
      'team-plugin',
      'org-plugin',
    ]);
  });

  // A cloud that predates plugin ownership answers with the caller's own
  // public-link rows and no `shareScope` or `createdBy`. Those are not shares
  // with a team or organization, and their rows lack what a shared entry reads.
  it('keeps rows from a cloud that reports no share scope out of Marketplace', async () => {
    mockAccount.capabilities = ['plugins-crud-v1'];
    sharedPluginsEnabled = true;
    mockListSharedPlugins.mockResolvedValue({
      success: true,
      data: {
        serverId: 'cloud',
        data: [
          {
            externalId: 'legacy-plugin',
            owner: { type: 'user', id: 'me', name: 'Me' },
          },
        ],
      },
    });

    await render();

    expect(mockListSharedPlugins).toHaveBeenCalledTimes(1);
    expect(inventory.sharedPlugins).toEqual([]);
  });
});

describe('shared agents', () => {
  const mockListSharedAgents = jest.fn();
  const agent = (id: string): Record<string, unknown> => ({
    id,
    name: id,
    shareScope: 'organization',
    createdBy: { id: id.startsWith('owned') ? 'account' : 'other' },
  });

  beforeEach(() => {
    mockAccount.capabilities = ['agents-crud-v1'];
    sharedAgentsEnabled = true;
    mockListSharedAgents.mockReset();
    mockListSharedAgents.mockImplementation(
      (input: { createdBy?: string; cursor?: string }) =>
        Promise.resolve(
          input.createdBy !== 'me'
            ? input.cursor
              ? { agents: [], nextCursor: null }
              : {
                  agents: [agent('other-newest'), agent('owned-newest')],
                  nextCursor: 'catalog-page-2',
                }
            : input.cursor
              ? { agents: [agent('owned-older')], nextCursor: null }
              : { agents: [agent('owned-newest')], nextCursor: 'owned-page-2' },
        ),
    );
    Object.defineProperty(window, 'agents', {
      configurable: true,
      value: { listShared: mockListSharedAgents },
    });
  });

  async function render(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      root.render(<Harness />);
      for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
    });
  }

  it('keeps every owned agent share when it lies beyond the first catalog page', async () => {
    ownedAgentSharesEnabled = true;
    await render();
    expect(inventory.sharedAgents.map((row) => row.id).sort()).toEqual([
      'other-newest',
      'owned-newest',
      'owned-older',
    ]);
    expect(mockListSharedAgents).toHaveBeenCalledWith(
      expect.objectContaining({ createdBy: 'me', cursor: 'owned-page-2' }),
    );
  });

  it('reads no owned agent lane where Shared by me is unavailable', async () => {
    await render();
    expect(inventory.sharedAgents.map((row) => row.id)).toEqual([
      'other-newest',
      'owned-newest',
    ]);
    expect(mockListSharedAgents).not.toHaveBeenCalledWith(
      expect.objectContaining({ createdBy: 'me' }),
    );
  });
});

describe('local agents (CAN-4266)', () => {
  const mockListAgents = jest.fn();
  const mockUnsubscribeAgents = jest.fn();
  const mockOnAgentsChanged = jest.fn(() => mockUnsubscribeAgents);

  beforeEach(() => {
    Object.defineProperty(window, 'agents', {
      configurable: true,
      value: { list: mockListAgents, onChanged: mockOnAgentsChanged },
    });
    mockListAgents.mockResolvedValue({
      agents: [
        {
          id: 'agent_model_reviewer',
          name: 'iOS Reviewer',
          baseModel: 'claude-sonnet-4-5',
          instructions: 'Review Swift changes.',
          pluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
          },
          createdAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-02T00:00:00.000Z',
          importedFromRemoteId: 'shared-1',
        },
      ],
    });
    useAgentsStore.setState({
      agents: [],
      loading: false,
      loaded: false,
      error: null,
    });
  });

  async function render(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      root.render(<Harness />);
      for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
    });
  }

  it('hydrates and subscribes only while enabled, then cleans up', async () => {
    await render();
    expect(mockListAgents).not.toHaveBeenCalled();
    expect(inventory.localAgents).toEqual([]);
    expect(inventory.localAgentsLoading).toBe(false);

    localAgentsEnabled = true;
    await render();
    expect(mockListAgents).toHaveBeenCalledTimes(1);
    expect(mockOnAgentsChanged).toHaveBeenCalledTimes(1);
    expect(inventory.localAgents).toEqual([
      expect.objectContaining({
        id: 'agent_model_reviewer',
        name: 'iOS Reviewer',
        description: 'Review Swift changes.',
        sharedRemoteId: 'shared-1',
      }),
    ]);
    expect(inventory.localAgentDefinitions).toHaveLength(1);
    expect(inventory.localAgentsLoaded).toBe(true);

    localAgentsEnabled = false;
    await render();
    expect(mockUnsubscribeAgents).toHaveBeenCalled();
    expect(inventory.localAgents).toEqual([]);
  });

  it('reports a failed local load apart from shared failures', async () => {
    mockListAgents.mockRejectedValue(new Error('Disk is full'));
    localAgentsEnabled = true;
    await render();

    expect(inventory.localAgentsError).toContain('Disk is full');
    expect(inventory.localAgents).toEqual([]);
    expect(
      inventory.loadErrors.some((error) => error.message.includes('Disk')),
    ).toBe(false);
  });
});
