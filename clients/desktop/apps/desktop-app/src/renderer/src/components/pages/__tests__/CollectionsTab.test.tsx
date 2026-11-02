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
import type { PluginInfo } from '@canopy/desktop-shared/types/plugins';
import type { UseUnifiedTableDataReturn } from '../../../hooks/useUnifiedTableData';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { SharedCollectionDetailModal } from '../CollectionsTab';

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
  ErrorBanner: ({ error }: { error?: string | null }): ReactElement | null =>
    error ? <div role="alert">{error}</div> : null,
  LoadingPlaceholder: ({ label }: { label: string }): ReactElement => (
    <p>{label}</p>
  ),
}));

jest.mock('../UnifiedTableDetailOverlays', () => ({
  UnifiedTableDetailOverlays: (): null => null,
}));

const useUnifiedTableDataMock = jest.fn(
  (): UseUnifiedTableDataReturn => ({
    rows: [],
    sourceOptions: [],
    loading: false,
  }),
);

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

describe('SharedCollectionDetailModal', () => {
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

  const onUpdated = jest.fn();

  async function renderEditor(): Promise<void> {
    await act(async () => {
      root.render(
        <SharedCollectionDetailModal
          mode="edit"
          summary={makeSharedCollectionDetail()}
          onClose={jest.fn()}
          onUpdated={onUpdated}
        />,
      );
      await flushPromises();
    });
    await act(async () => {
      await flushPromises();
    });
  }

  beforeEach(() => {
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

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    jest.clearAllMocks();
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

  it('renders Shared by you for the loaded detail, with a re-read (CAN-4842)', async () => {
    getShared.mockResolvedValue(makeSharedCollectionDetail());
    let refresh: (() => Promise<void>) | undefined;
    const onDetailUpdated = jest.fn();
    await act(async () => {
      root.render(
        <SharedCollectionDetailModal
          mode="view"
          summary={makeSharedCollectionDetail()}
          presentation="page"
          onClose={jest.fn()}
          onUpdated={onDetailUpdated}
          renderSharedByYou={(detail, reread) => {
            refresh = reread;
            return <section data-testid="t-shared-by-you">{detail.id}</section>;
          }}
        />,
      );
      await flushPromises();
    });
    await act(async () => {
      await flushPromises();
    });
    expect(
      container.querySelector('[data-testid="t-shared-by-you"]')?.textContent,
    ).toBe('shared-collection');
    await act(async () => {
      await refresh?.();
    });
    expect(getShared).toHaveBeenCalledTimes(2);
    expect(onDetailUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'shared-collection' }),
    );
  });

  it('saves edits through updateShared and reports the updated detail', async () => {
    await renderEditor();

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
    expect(onUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'shared-collection',
        name: 'Shared Collection Updated',
      }),
    );
  });

  it('uses the required shared Collection update failure copy', async () => {
    updateShared.mockRejectedValue(new Error('update failed'));

    await renderEditor();
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
    const externalPluginInfo: PluginInfo = {
      name: 'External Plugin',
      description: '',
      version: '',
      homepage: '',
      sourcePath: '',
      marketplaceId: 'market-1',
      details: null,
      providerSupport: { claude: 'native', codex: 'none' },
      facets: {},
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
          sourceIcon: 'app',
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

    await renderEditor();
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
    await renderEditor();
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
    await renderEditor();

    expect(container.textContent).toContain('unknown type "mystery"');
    expect(findButton(container, 'Save changes').disabled).toBe(true);
    await act(async () => {
      findButton(container, 'Save changes').click();
      await flushPromises();
    });
    expect(updateShared).not.toHaveBeenCalled();
  });
});
