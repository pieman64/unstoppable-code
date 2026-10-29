/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { shareEnvelope } from '@/test-utils/shareOperation';
import { act, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CollectionConfig,
  SharedCollectionDetail,
  UpdateSharedCollectionRequest,
} from '@canopy/desktop-shared/types/collections';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { CollectionsTab, SharedCollectionDetailModal } from '../CollectionsTab';

const refreshCollections = jest.fn(() => Promise.resolve());
const refreshShared = jest.fn(() => Promise.resolve());
const loadMoreShared = jest.fn(() => Promise.resolve());
const setSharedFilters = jest.fn();
const removeSharedRow = jest.fn();
let localCollections = [
  {
    id: 'local-collection',
    name: 'Local Collection',
    description: '',
    updatedAt: '2026-05-22T00:00:00.000Z',
    skillCount: 1,
    pluginCount: 0,
    mcpServerCount: 0,
    hasExistingShare: false,
  },
];

jest.mock('../../shared', () => ({
  DialogModal: ({
    children,
    title,
  }: {
    children: ReactNode;
    title?: string;
  }): ReactElement => (
    <div role="dialog">
      {title && <h2>{title}</h2>}
      {children}
    </div>
  ),
  EmptyState: ({
    title,
    subtitle,
  }: {
    title: string;
    subtitle: string;
  }): ReactElement => (
    <div>
      <p>{title}</p>
      <p>{subtitle}</p>
    </div>
  ),
  ErrorBanner: ({ error }: { error?: string | null }): ReactElement | null =>
    error ? <div role="alert">{error}</div> : null,
  LoadingPlaceholder: ({ label }: { label: string }): ReactElement => (
    <p>{label}</p>
  ),
  DeleteConfirmModal: ({
    title,
    message,
    confirmLabel = 'Delete',
    onConfirm,
    onCancel,
  }: {
    title: string;
    message: ReactNode;
    confirmLabel?: string;
    onConfirm: () => void;
    onCancel: () => void;
  }): ReactElement => (
    <div role="dialog" data-testid="delete-confirm-modal">
      <h2>{title}</h2>
      <div>{message}</div>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
      <button type="button" onClick={onConfirm}>
        {confirmLabel}
      </button>
    </div>
  ),
}));

jest.mock('../UnifiedTableDetailOverlays', () => ({
  UnifiedTableDetailOverlays: (): null => null,
}));

jest.mock('../../../hooks/useCollectionList', (): unknown => ({
  useCollectionList: (): unknown => ({
    collections: localCollections,
    loading: false,
    error: null,
    refresh: refreshCollections,
  }),
}));

let mockSharedCollectionScope: 'private' | 'team' = 'team';
jest.mock('../../../hooks/useSharedCollectionList', (): unknown => ({
  useSharedCollectionList: (): unknown => ({
    cloudAccount: {
      hasApiKey: true,
      capabilities: ['collections-crud-v1'],
      storageAvailable: true,
      account: {
        id: 'acct-1',
        name: 'Alice',
        email: 'alice@example.com',
        role: 'ADMIN',
      },
    },
    cloudLoading: false,
    collections: [
      {
        id: 'shared-collection',
        name: 'Shared Collection',
        description: 'Remote',
        contentHash: 'hash-shared-collection',
        itemCounts: { skills: 1, plugins: 0, customSkills: 0 },
        shareScope: mockSharedCollectionScope,
        owner: { type: 'user', id: 'user-1', name: 'Owner' },
        createdBy: {
          id: 'user-1',
          name: 'Owner',
          email: 'owner@example.test',
        },
        createdAt: '2026-05-21T00:00:00.000Z',
        updatedAt: '2026-05-22T00:00:00.000Z',
        canUpdate: true,
        canDelete: true,
      },
    ],
    loading: false,
    loadingMore: false,
    nextCursor: null,
    error: null,
    loaded: true,
    refreshShared,
    loadMoreShared,
    setFilters: setSharedFilters,
    removeSharedRow,
  }),
}));

const useUnifiedTableDataMock = jest.fn(() => ({
  rows: [],
  sourceOptions: [],
  loading: false,
}));

jest.mock('../../../hooks/useUnifiedTableData', (): unknown => ({
  useUnifiedTableData: (): unknown => useUnifiedTableDataMock(),
}));

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) =>
      candidate.textContent?.trim() === text ||
      candidate.getAttribute('aria-label') === text,
  );
  if (!button) throw new Error(`Button "${text}" not found.`);
  return button;
}

function activateSharedView(container: HTMLElement): void {
  const tab = container.querySelector<HTMLButtonElement>(
    '[data-testid="collections-view-tab-shared"]',
  );
  if (!tab) throw new Error('Shared view tab not found.');
  tab.click();
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeSharedCollectionDetail(
  overrides: Partial<SharedCollectionDetail> = {},
): SharedCollectionDetail {
  return {
    id: 'shared-collection',
    name: 'Shared Collection',
    description: 'Remote',
    contentHash: 'hash-shared-collection',
    itemCounts: { skills: 1, plugins: 0, customSkills: 0 },
    shareScope: 'private',
    owner: { type: 'user', id: 'user-1', name: 'Owner' },
    createdBy: { id: 'user-1', name: 'Owner', email: 'owner@example.test' },
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z',
    canUpdate: true,
    canDelete: true,
    rawCollection:
      '{"version":1,"name":"Shared Collection","description":"Remote","items":[]}',
    collection: {
      version: 1,
      name: 'Shared Collection',
      description: 'Remote',
      items: [],
    },
    customSkills: [],
    ...overrides,
  };
}

describe('CollectionsTab shared Collections UX', () => {
  let container: HTMLElement;
  let root: Root;
  const getShared = jest.fn<Promise<SharedCollectionDetail>, [string]>();
  const updateShared = jest.fn<
    Promise<SharedCollectionDetail>,
    [UpdateSharedCollectionRequest]
  >();
  const deleteShared = jest.fn(() => Promise.resolve());
  const saveCollection = jest.fn<
    Promise<CollectionConfig>,
    [Partial<CollectionConfig> & { name: string }]
  >();
  const installSkills = jest.fn();
  const loadSkills = jest.fn();
  const readRawSkill = jest.fn();
  const addMarketplace = jest.fn();
  const loadMarketplaces = jest.fn();
  const refreshMarketplaces = jest.fn();
  const installPlugin = jest.fn();
  const confirmSpy = jest.fn(() => true);

  beforeEach(() => {
    mockSharedCollectionScope = 'team';
    useNavigationStore.setState({ pendingShareInstall: undefined });
    useCurrentUiStateStore.setState({ revision: 0, slices: {} });
    localCollections = localCollections.map((collection) => ({
      ...collection,
      hasExistingShare: false,
      mcpServerCount: 0,
    }));
    const snapshot = getDefaultFeatureFlagSnapshot();
    useFeatureFlagsStore.setState({
      snapshot: {
        ...snapshot,
        status: 'ready',
        values: {
          ...snapshot.values,
          [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
        },
      },
    });
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: { context: { kind: 'personal' }, revision: 1, organizations: [] },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useUnifiedTableDataMock.mockReturnValue({
      rows: [],
      sourceOptions: [],
      loading: false,
    });
    getShared.mockResolvedValue(makeSharedCollectionDetail());
    updateShared.mockImplementation((request) =>
      Promise.resolve(
        makeSharedCollectionDetail({
          id: request.collectionId,
          name: 'Shared Collection Updated',
          description: '',
          itemCounts: { skills: 0, plugins: 0, customSkills: 0 },
          rawCollection: request.rawCollection,
          collection: {
            version: 1,
            name: 'Shared Collection Updated',
            description: '',
            items: [],
          },
        }),
      ),
    );
    deleteShared.mockResolvedValue(undefined);
    saveCollection.mockResolvedValue({
      id: 'local-import',
      name: 'Shared Collection',
      description: 'Remote',
      skills: [],
      plugins: [],
      mcpServers: [],
      createdAt: '2026-05-22T00:00:00.000Z',
      updatedAt: '2026-05-22T00:00:00.000Z',
    });
    installSkills.mockResolvedValue({ success: true });
    loadSkills.mockResolvedValue({ success: true, data: [] });
    readRawSkill.mockResolvedValue('---\nname: Custom Skill\n---\nBody\n');
    addMarketplace.mockResolvedValue({ success: true });
    loadMarketplaces.mockResolvedValue({
      success: true,
      data: { version: 1, lastRefreshed: '', marketplaces: [] },
    });
    refreshMarketplaces.mockResolvedValue({
      success: true,
      data: { version: 1, lastRefreshed: '', marketplaces: [] },
    });
    installPlugin.mockResolvedValue({ success: true });
    confirmSpy.mockReturnValue(true);
    Object.defineProperty(window, 'confirm', {
      configurable: true,
      value: confirmSpy,
    });
    Object.assign(window, {
      collections: {
        getShared,
        inspectImport: jest.fn(async (collectionId: string) => ({
          collection: await getShared(collectionId),
          requirements: [],
        })),
        updateShared: shareEnvelope(updateShared),
        deleteShared,
        loadCollection: jest.fn(),
        saveCollection,
      },
      skills: {
        installSkills,
        loadSkills,
        readRawSkill,
      },
      plugins: {
        addMarketplace,
        loadMarketplaces,
        refreshMarketplaces,
        installPlugin,
      },
    });
  });

  it('offers sharing for new and existing Personal collections', async () => {
    await act(async () => {
      root.render(<CollectionsTab />);
      await flushPromises();
    });
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (button) => button.getAttribute('aria-label') === 'Share collection',
      ),
    ).toBe(true);

    localCollections = localCollections.map((collection) => ({
      ...collection,
      hasExistingShare: true,
    }));
    await act(async () => {
      root.render(<CollectionsTab />);
      await flushPromises();
    });
    expect(findButton(container, 'Share collection')).toBeTruthy();
  });

  it('shows a disabled Share action for an MCP collection in Personal', async () => {
    localCollections = localCollections.map((collection) => ({
      ...collection,
      mcpServerCount: 1,
    }));
    await act(async () => {
      root.render(<CollectionsTab />);
      await flushPromises();
    });
    expect(findButton(container, 'Share collection').disabled).toBe(true);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    jest.clearAllMocks();
  });

  it('renders shared Collection View/Edit/Import/Delete actions and updates through updateShared', async () => {
    await act(async () => {
      root.render(<CollectionsTab />);
      await flushPromises();
    });
    await act(async () => {
      activateSharedView(container);
      await flushPromises();
    });

    expect(container.textContent).toContain('Shared Collection');
    // Name cell button replaces the View action.
    expect(
      Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Shared Collection'),
      ),
    ).toBeTruthy();
    expect(findButton(container, 'Edit shared collection')).toBeTruthy();
    expect(findButton(container, 'Import collection')).toBeTruthy();
    expect(findButton(container, 'Delete shared collection')).toBeTruthy();
    // CAN-2799: icon actions explain themselves with a rich tooltip that
    // opens on hover, not a native `title`.
    const importButton = findButton(container, 'Import collection');
    expect(importButton.hasAttribute('title')).toBe(false);
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    act(() => {
      importButton.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true }),
      );
    });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Import collection',
    );
    act(() => {
      importButton.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });

    await act(async () => {
      findButton(container, 'Edit shared collection').click();
      await flushPromises();
    });

    expect(container.querySelector('textarea')).not.toBeNull();

    await act(async () => {
      findButton(container, 'Save changes').click();
      await flushPromises();
    });

    expect(updateShared).toHaveBeenCalledWith({
      collectionId: 'shared-collection',
      rawCollection:
        '{"version":1,"name":"Shared Collection","description":"Remote","items":[]}',
      expectedContentHash: 'hash-shared-collection',
    });
    expect(container.textContent).toContain('Shared collection updated.');
  });

  it('uses loaded collection permission over a stale editable summary in Marketplace', async () => {
    getShared.mockResolvedValue(
      makeSharedCollectionDetail({ canUpdate: false, canDelete: true }),
    );
    await act(async () => {
      root.render(
        <SharedCollectionDetailModal
          mode="view"
          summary={makeSharedCollectionDetail()}
          presentation="page"
          onClose={jest.fn()}
          onUpdated={jest.fn()}
          onSwitchToEdit={jest.fn()}
          renderUnshare={(detail) =>
            detail.canDelete ? <button>Unshare</button> : null
          }
        />,
      );
      await flushPromises();
    });
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (b) => b.textContent === 'Edit',
      ),
    ).toBe(false);
    expect(container.textContent).toContain('Unshare');
  });

  it('reports selected Collection row metadata for App Advisor current UI state', async () => {
    await act(async () => {
      root.render(<CollectionsTab />);
      await flushPromises();
    });

    await act(async () => {
      const nameButton = Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.includes('Local Collection'),
      );
      if (!nameButton) {
        throw new Error('Local Collection name button not found.');
      }
      nameButton.click();
      await flushPromises();
    });

    expect(
      useCurrentUiStateStore.getState().slices['plugins.selectedRow'],
    ).toEqual({
      kind: 'collection',
      id: 'local-collection',
      name: 'Local Collection',
    });
  });

  it('uses the required shared Collection update failure copy', async () => {
    updateShared.mockRejectedValue(new Error('update failed'));

    await act(async () => {
      root.render(<CollectionsTab />);
      await flushPromises();
    });
    await act(async () => {
      activateSharedView(container);
      await flushPromises();
    });
    await act(async () => {
      findButton(container, 'Edit shared collection').click();
      await flushPromises();
    });
    await act(async () => {
      findButton(container, 'Save changes').click();
      await flushPromises();
    });

    expect(container.textContent).toContain(
      'Failed to update shared collection.',
    );
  });

  it('adds external skills, external plugins, and draft custom skills while promoting drafts on save', async () => {
    const externalSkillInfo = {
      name: 'External Skill',
      sourceId: 'github:owner:skills',
      description: '',
      source: 'GitHub',
      installedAt: '',
      updatedAt: '',
      updateAvailable: false,
      shareableSource: { type: 'github' as const, repo: 'owner/skills' },
    };
    const customSkillInfo = {
      name: 'Custom Skill',
      sourceId: 'custom:app',
      description: '',
      source: 'Custom',
      installedAt: '',
      updatedAt: '',
      updateAvailable: false,
      custom: true,
    };
    const externalPluginInfo = {
      name: 'External Plugin',
      description: '',
      version: '',
      homepage: '',
      sourcePath: '',
      marketplaceId: 'market-1',
      details: null,
      externalSource: null,
      cachePath: null,
      cachedAt: null,
    };

    loadSkills.mockResolvedValue({
      success: true,
      data: [externalSkillInfo, customSkillInfo],
    });
    loadMarketplaces.mockResolvedValue({
      success: true,
      data: {
        version: 1,
        lastRefreshed: '',
        marketplaces: [
          {
            id: 'market-1',
            name: 'Marketplace',
            description: '',
            sourceType: 'github',
            sourceUrl: 'https://github.com/owner/plugins',
            installLocation: '',
            lastUpdated: '',
            pluginCount: 1,
            plugins: [externalPluginInfo],
          },
        ],
      },
    });

    useUnifiedTableDataMock.mockReturnValue({
      rows: [
        {
          rowOrigin: 'catalog',
          kind: 'skill',
          key: 'github:owner:skills/External Skill',
          name: 'External Skill',
          description: '',
          source: 'github:owner:skills',
          sourceSubtitle: '',
          sourceIcon: 'repo',
          lastUpdated: '',
          original: externalSkillInfo,
        },
        {
          rowOrigin: 'catalog',
          kind: 'skill',
          key: 'custom:app/Custom Skill',
          name: 'Custom Skill',
          description: '',
          source: 'Canopy (custom)',
          sourceSubtitle: '',
          sourceIcon: 'canopy',
          lastUpdated: '',
          original: customSkillInfo,
        },
        {
          rowOrigin: 'catalog',
          kind: 'plugin',
          key: 'market-1/External Plugin',
          name: 'External Plugin',
          description: '',
          source: 'github:owner:plugins',
          sourceSubtitle: 'Marketplace',
          sourceIcon: 'marketplace',
          lastUpdated: '',
          original: externalPluginInfo,
        },
      ],
      sourceOptions: [],
      loading: false,
    });

    await act(async () => {
      root.render(<CollectionsTab />);
      await flushPromises();
    });
    await act(async () => {
      activateSharedView(container);
      await flushPromises();
    });
    await act(async () => {
      findButton(container, 'Edit shared collection').click();
      await flushPromises();
    });
    await act(async () => {
      const skillCheckbox = container.querySelector(
        'input[aria-label="Select External Skill"]',
      );
      const pluginCheckbox = container.querySelector(
        'input[aria-label="Select External Plugin"]',
      );
      const customCheckbox = container.querySelector(
        'input[aria-label="Select Custom Skill"]',
      );
      if (!skillCheckbox || !pluginCheckbox || !customCheckbox) {
        throw new Error('Expected catalog checkboxes were not rendered.');
      }
      (skillCheckbox as HTMLInputElement).click();
      (pluginCheckbox as HTMLInputElement).click();
      (customCheckbox as HTMLInputElement).click();
      await flushPromises();
    });
    await act(async () => {
      findButton(container, 'Save changes').click();
      await flushPromises();
    });

    const request = updateShared.mock.calls[0]?.[0];
    if (!request) throw new Error('updateShared was not called.');
    const rawCollection = JSON.parse(request.rawCollection) as {
      items: Array<Record<string, unknown>>;
    };
    expect(rawCollection.items).toMatchObject([
      {
        type: 'skill',
        source: { type: 'github', repo: 'owner/skills' },
        skill_name: 'External Skill',
      },
      {
        type: 'claude_plugin',
        marketplace: { type: 'github', repo: 'owner/plugins' },
        plugin_name: 'External Plugin',
      },
      { type: 'custom_skill', skill_name: 'Custom Skill' },
    ]);
    const draftItem = rawCollection.items[2];
    if (!draftItem) throw new Error('Draft item was not written.');
    expect(request.customSkills).toEqual([
      {
        clientKey: draftItem.clientKey,
        name: 'Custom Skill',
        rawSkill: '---\nname: Custom Skill\n---\nBody\n',
      },
    ]);
    expect(readRawSkill).toHaveBeenCalledWith('custom:app/Custom Skill');
  });

  it('removes linked custom skills without deleting shared skill records', async () => {
    getShared.mockResolvedValue(
      makeSharedCollectionDetail({
        collection: {
          version: 1,
          name: 'Shared Collection',
          description: 'Remote',
          items: [
            {
              type: 'custom_skill',
              skillId: 'skill-remote',
              skill_name: 'Linked Skill',
              contentHash: 'sha256:abc',
            },
          ],
        },
      }),
    );
    await act(async () => {
      root.render(<CollectionsTab />);
      await flushPromises();
    });
    await act(async () => {
      activateSharedView(container);
      await flushPromises();
    });
    await act(async () => {
      findButton(container, 'Edit shared collection').click();
      await flushPromises();
    });
    await act(async () => {
      // The linked custom skill renders as a synthetic UnifiedTable row whose
      // checkbox is initially selected. Unchecking it removes the item.
      const linkedCheckbox = container.querySelector(
        'input[aria-label="Select Linked Skill"]',
      );
      if (!linkedCheckbox) {
        throw new Error('Linked skill checkbox was not rendered.');
      }
      (linkedCheckbox as HTMLInputElement).click();
      await flushPromises();
    });
    await act(async () => {
      findButton(container, 'Save changes').click();
      await flushPromises();
    });

    const request = updateShared.mock.calls[0]?.[0];
    if (!request) throw new Error('updateShared was not called.');
    expect(JSON.parse(request.rawCollection)).toMatchObject({ items: [] });
    expect(request.customSkills).toBeUndefined();
    expect(readRawSkill).not.toHaveBeenCalled();
  });

  it('refuses to save shared Collections containing unknown item types', async () => {
    getShared.mockResolvedValue(
      makeSharedCollectionDetail({
        collection: {
          version: 1,
          name: 'Shared Collection',
          description: 'Remote',
          items: [{ type: 'mystery' } as never],
        },
      }),
    );
    await act(async () => {
      root.render(<CollectionsTab />);
      await flushPromises();
    });
    await act(async () => {
      activateSharedView(container);
      await flushPromises();
    });
    await act(async () => {
      findButton(container, 'Edit shared collection').click();
      await flushPromises();
    });

    expect(container.textContent).toContain('unknown type "mystery"');
    expect(findButton(container, 'Save changes').disabled).toBe(true);
    await act(async () => {
      findButton(container, 'Save changes').click();
      await flushPromises();
    });
    expect(updateShared).not.toHaveBeenCalled();
  });

  it('opens the shared install review from Import without writing anything', async () => {
    await act(async () => {
      root.render(<CollectionsTab />);
      await flushPromises();
    });
    await act(async () => {
      activateSharedView(container);
      await flushPromises();
    });
    await act(async () => {
      findButton(container, 'Import collection').click();
      await flushPromises();
    });

    // The review (CAN-3710) owns the install; Import only opens it.
    expect(useNavigationStore.getState().pendingShareInstall).toEqual({
      link: {
        entity: 'collection',
        externalId: 'shared-collection',
        intent: 'install',
        audience: 'TEAM',
      },
      origin: 'in-app',
    });
    expect(getShared).not.toHaveBeenCalled();
    expect(saveCollection).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="shared-collection-import-review"]'),
    ).toBeNull();
  });

  it('offers no Import on a private shared Collection, which resolves for nobody else', async () => {
    mockSharedCollectionScope = 'private';
    await act(async () => {
      root.render(<CollectionsTab />);
      await flushPromises();
    });
    await act(async () => {
      activateSharedView(container);
      await flushPromises();
    });

    expect(container.textContent).toContain('Shared Collection');
    expect(
      container.querySelector('button[aria-label="Import collection"]'),
    ).toBeNull();
  });

  it('opens a confirmation modal before deleting a shared Collection', async () => {
    await act(async () => {
      root.render(<CollectionsTab />);
      await flushPromises();
    });
    await act(async () => {
      activateSharedView(container);
      await flushPromises();
    });

    // First click only opens the modal — deleteShared must not run yet.
    await act(async () => {
      findButton(container, 'Delete shared collection').click();
      await flushPromises();
    });
    expect(deleteShared).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      'Linked custom skills will remain available as shared skills.',
    );

    // Confirming the modal triggers the actual delete.
    const dialog = container.querySelector(
      '[data-testid="delete-confirm-modal"]',
    );
    if (!dialog) throw new Error('Delete confirmation modal not rendered.');
    const confirmBtn = Array.from(dialog.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Delete',
    );
    if (!confirmBtn) throw new Error('Confirm button not found.');
    await act(async () => {
      confirmBtn.click();
      await flushPromises();
    });

    expect(deleteShared).toHaveBeenCalledWith({
      collectionId: 'shared-collection',
    });
    expect(container.textContent).toContain('Shared collection deleted.');
  });
});
