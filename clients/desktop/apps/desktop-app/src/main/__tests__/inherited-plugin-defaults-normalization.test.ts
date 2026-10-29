import type {
  ChatTabPluginSelections,
  ChatTabsFile,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';

const mockChatStorageScopeIds = jest.fn<Promise<string[]>, [string]>();
const mockReadChatStorageDiscoveryIndex = jest.fn<
  Promise<{ tabs: Record<string, unknown>[]; runtimeByChatId: object }>,
  [string, string]
>();
const mockUpdateCompatibilityTabs = jest.fn<
  Promise<ChatTabsFile>,
  [
    { projectId: string; worktreeId: string },
    (tabsFile: ChatTabsFile) => ChatTabsFile,
  ]
>();
const mockLogMainProcessWarn = jest.fn();
type PreferencesAuthority = 'ok' | 'absent' | 'unreadable';
const mockReadPreferencesFileDetailed = jest.fn<
  Promise<{
    preferences: { globalPluginSelections?: ChatTabPluginSelections };
    authority: PreferencesAuthority;
  }>,
  []
>();
const mockHasPersistedPreferencesFile = jest.fn<Promise<boolean>, []>();

function preferencesRead(
  authority: PreferencesAuthority,
  globalPluginSelections?: ChatTabPluginSelections,
): void {
  mockReadPreferencesFileDetailed.mockResolvedValue({
    preferences: globalPluginSelections ? { globalPluginSelections } : {},
    authority,
  });
}

jest.mock('../lib/chat-storage-discovery', () => ({
  chatStorageScopeIds: (root: string): Promise<string[]> =>
    mockChatStorageScopeIds(root),
  readChatStorageDiscoveryIndex: (
    root: string,
    scopeId: string,
  ): Promise<unknown> => mockReadChatStorageDiscoveryIndex(root, scopeId),
}));
jest.mock('../lib/paths', () => ({
  getWorkspaceDir: (workspaceId: string): string => `/data/${workspaceId}`,
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: (...args: unknown[]): void => {
    mockLogMainProcessWarn(...args);
  },
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFileDetailed: (): Promise<unknown> =>
    mockReadPreferencesFileDetailed(),
  hasPersistedPreferencesFile: (): Promise<boolean> =>
    mockHasPersistedPreferencesFile(),
}));
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): {
    updateCompatibilityTabs: typeof mockUpdateCompatibilityTabs;
  } => ({ updateCompatibilityTabs: mockUpdateCompatibilityTabs }),
}));

import {
  effectiveChatPluginSelections,
  projectDefaultsForChat,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';
import {
  normalizeTabForInheritedPluginDefaults,
  normalizeWorkspaceChatsForInheritedPluginDefaults,
} from '../lib/inherited-plugin-defaults-normalization';

const linear = { serverId: 'linear', configId: 'default' };
const github = { serverId: 'github', configId: 'default' };
const pluginA = { marketplaceId: 'mkt', pluginName: 'plug-a' };

function selections(
  overrides: Partial<ChatTabPluginSelections> = {},
): ChatTabPluginSelections {
  return {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
    ...overrides,
  };
}

function tab(overrides: Partial<PersistedChatTab> = {}): PersistedChatTab {
  return {
    id: 'chat-1',
    title: 'Chat',
    createdAt: '2026-09-01T00:00:00.000Z',
    messages: [],
    ...overrides,
  };
}

describe('normalizeTabForInheritedPluginDefaults', () => {
  it('drops seeded copies of the project defaults and keeps own choices', () => {
    const result = normalizeTabForInheritedPluginDefaults(
      tab({
        pluginSelections: selections({
          mcpServerRefs: [linear, github],
          pluginRefs: [pluginA],
        }),
      }),
      selections({ mcpServerRefs: [linear] }),
    );
    expect(result?.pluginSelections?.mcpServerRefs).toEqual([github]);
    expect(result?.pluginSelections?.pluginRefs).toEqual([pluginA]);
    expect(result?.inheritedPluginDefaultsVersion).toBe(1);
  });

  it('turns off the project defaults a chat lacked, keeping its own selection', () => {
    const own = selections({ mcpServerRefs: [github] });
    const result = normalizeTabForInheritedPluginDefaults(
      tab({
        pluginSelections: own,
        disabledGlobalPluginSelections: { pluginRefs: [pluginA] },
      }),
      selections({ mcpServerRefs: [linear] }),
    );
    expect(result?.pluginSelections).toBe(own);
    expect(result?.disabledGlobalPluginSelections).toEqual({
      pluginRefs: [pluginA],
      mcpServerRefs: [linear],
    });
    expect(result?.inheritedPluginDefaultsVersion).toBe(1);
  });

  it('leaves on a project default the chat had through the global layer', () => {
    const result = normalizeTabForInheritedPluginDefaults(
      tab({ pluginSelections: selections() }),
      selections({ mcpServerRefs: [linear, github] }),
      { global: selections({ mcpServerRefs: [linear] }) },
    );
    expect(result?.disabledGlobalPluginSelections).toEqual({
      mcpServerRefs: [github],
    });
  });

  it('keeps a default the chat chose itself although it turned off the global copy', () => {
    const result = normalizeTabForInheritedPluginDefaults(
      tab({
        pluginSelections: selections({ mcpServerRefs: [linear] }),
        disabledGlobalPluginSelections: { mcpServerRefs: [linear] },
      }),
      selections({ mcpServerRefs: [linear] }),
      { global: selections({ mcpServerRefs: [linear] }) },
    );
    expect(result?.pluginSelections?.mcpServerRefs).toEqual([]);
    expect(result?.disabledGlobalPluginSelections).toBeUndefined();
  });

  it('never runs twice for the same chat', () => {
    expect(
      normalizeTabForInheritedPluginDefaults(
        tab({
          inheritedPluginDefaultsVersion: 1,
          pluginSelections: selections({ mcpServerRefs: [linear] }),
        }),
        selections({ mcpServerRefs: [linear] }),
      ),
    ).toBeNull();
  });

  it('leaves file tabs alone', () => {
    expect(
      normalizeTabForInheritedPluginDefaults(
        tab({ kind: 'file', filePath: '/tmp/a.ts' }),
        selections({ mcpServerRefs: [linear] }),
      ),
    ).toBeNull();
  });
});

// What the chat's next turn resolves, as the overlay composes it.
function nextTurn(
  chat: PersistedChatTab,
  projectDefaults: ChatTabPluginSelections,
): ChatTabPluginSelections {
  return effectiveChatPluginSelections({
    local: chat.pluginSelections,
    projectDefaults: projectDefaultsForChat(chat, projectDefaults),
    chatTombstones: chat.disabledGlobalPluginSelections,
  });
}

describe('a chat created before live project defaults', () => {
  const before = selections({ mcpServerRefs: [linear] });
  const after = selections({ mcpServerRefs: [linear, github] });

  it('never gains a default it lacked, and gets defaults added later', () => {
    // The user unchecked the seeded Linear copy.
    const legacy = tab({ pluginSelections: selections() });
    expect(nextTurn(legacy, before).mcpServerRefs).toEqual([]);
    const normalized = normalizeTabForInheritedPluginDefaults(legacy, before);
    if (!normalized) throw new Error('Expected a normalized chat');
    expect(nextTurn(normalized, before).mcpServerRefs).toEqual([]);
    expect(nextTurn(normalized, after).mcpServerRefs).toEqual([github]);
  });

  it('keeps a default it had until the project removes it', () => {
    const legacy = tab({ pluginSelections: before });
    expect(nextTurn(legacy, before).mcpServerRefs).toEqual([linear]);
    const normalized = normalizeTabForInheritedPluginDefaults(legacy, before);
    if (!normalized) throw new Error('Expected a normalized chat');
    expect(nextTurn(normalized, before).mcpServerRefs).toEqual([linear]);
    expect(nextTurn(normalized, selections()).mcpServerRefs).toEqual([]);
  });
});

describe('normalizeWorkspaceChatsForInheritedPluginDefaults', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    preferencesRead('ok');
    mockHasPersistedPreferencesFile.mockResolvedValue(true);
    mockUpdateCompatibilityTabs.mockImplementation((_scope, update) =>
      Promise.resolve(update({ version: 1, activeTabId: '', tabs: [] })),
    );
  });

  it('only loads scopes whose discovery index lists a legacy chat', async () => {
    mockChatStorageScopeIds.mockResolvedValue(['wt-current', 'wt-legacy']);
    mockReadChatStorageDiscoveryIndex.mockImplementation((_root, scope) =>
      Promise.resolve(
        scope === 'wt-legacy'
          ? { tabs: [{ id: 'chat-1' }], runtimeByChatId: {} }
          : {
              tabs: [{ id: 'chat-2', inheritedPluginDefaultsVersion: 1 }],
              runtimeByChatId: {},
            },
      ),
    );

    await normalizeWorkspaceChatsForInheritedPluginDefaults(
      'ws-1',
      selections({ mcpServerRefs: [linear] }),
    );

    expect(mockChatStorageScopeIds).toHaveBeenCalledWith('/data/ws-1');
    expect(mockUpdateCompatibilityTabs).toHaveBeenCalledTimes(1);
    expect(mockUpdateCompatibilityTabs.mock.calls[0]?.[0]).toEqual({
      projectId: 'ws-1',
      worktreeId: 'wt-legacy',
    });
  });

  it('rewrites the authoritative tabs through the chat state service', async () => {
    mockChatStorageScopeIds.mockResolvedValue(['wt-1']);
    mockReadChatStorageDiscoveryIndex.mockResolvedValue({
      tabs: [{ id: 'legacy' }],
      runtimeByChatId: {},
    });
    await normalizeWorkspaceChatsForInheritedPluginDefaults(
      'ws-1',
      selections({ mcpServerRefs: [linear] }),
    );
    expect(mockReadPreferencesFileDetailed).toHaveBeenCalledTimes(1);
    const update = mockUpdateCompatibilityTabs.mock.calls[0]?.[1];
    if (!update) throw new Error('Expected a chat state update');
    const current: ChatTabsFile = {
      version: 1,
      activeTabId: 'legacy',
      tabs: [
        tab({
          id: 'legacy',
          pluginSelections: selections({ mcpServerRefs: [linear, github] }),
        }),
        tab({
          id: 'current',
          inheritedPluginDefaultsVersion: 1,
          pluginSelections: selections({ mcpServerRefs: [linear] }),
        }),
      ],
    };
    const next = update(current);
    expect(next.tabs[0]?.pluginSelections?.mcpServerRefs).toEqual([github]);
    expect(next.tabs[0]?.inheritedPluginDefaultsVersion).toBe(1);
    expect(next.tabs[0]?.disabledGlobalPluginSelections).toBeUndefined();
    expect(next.tabs[1]).toBe(current.tabs[1]);
    const unchanged: ChatTabsFile = {
      version: 1,
      activeTabId: 'current',
      tabs: [tab({ id: 'current', inheritedPluginDefaultsVersion: 1 })],
    };
    expect(update(unchanged)).toBe(unchanged);
  });

  it('measures what a chat had against the global layer and the project tombstones', async () => {
    preferencesRead('ok', selections({ mcpServerRefs: [linear, github] }));
    mockChatStorageScopeIds.mockResolvedValue(['wt-1']);
    mockReadChatStorageDiscoveryIndex.mockResolvedValue({
      tabs: [{ id: 'legacy' }],
      runtimeByChatId: {},
    });
    await normalizeWorkspaceChatsForInheritedPluginDefaults(
      'ws-1',
      selections({ mcpServerRefs: [linear, github] }),
      { mcpServerRefs: [github] },
    );
    const update = mockUpdateCompatibilityTabs.mock.calls[0]?.[1];
    if (!update) throw new Error('Expected a chat state update');
    const next = update({
      version: 1,
      activeTabId: 'legacy',
      tabs: [tab({ id: 'legacy', pluginSelections: selections() })],
    });
    // Linear reached the chat through the global layer; GitHub didn't,
    // because the project turned its global copy off.
    expect(next.tabs[0]?.disabledGlobalPluginSelections).toEqual({
      mcpServerRefs: [github],
    });
  });

  it('refuses to normalize, writing no tombstones, when preferences cannot be read', async () => {
    preferencesRead('unreadable');
    mockChatStorageScopeIds.mockResolvedValue(['wt-1']);
    mockReadChatStorageDiscoveryIndex.mockResolvedValue({
      tabs: [{ id: 'legacy' }],
      runtimeByChatId: {},
    });

    await expect(
      normalizeWorkspaceChatsForInheritedPluginDefaults(
        'ws-1',
        selections({ mcpServerRefs: [linear] }),
      ),
    ).rejects.toThrow('global plugin defaults');

    expect(mockUpdateCompatibilityTabs).not.toHaveBeenCalled();
  });

  it('refuses to normalize when only the last good preferences remain', async () => {
    preferencesRead('absent');
    mockHasPersistedPreferencesFile.mockResolvedValue(true);
    mockChatStorageScopeIds.mockResolvedValue(['wt-1']);

    await expect(
      normalizeWorkspaceChatsForInheritedPluginDefaults(
        'ws-1',
        selections({ mcpServerRefs: [linear] }),
      ),
    ).rejects.toThrow('global plugin defaults');

    expect(mockUpdateCompatibilityTabs).not.toHaveBeenCalled();
  });

  it('normalizes against no global layer when there are no preferences yet', async () => {
    preferencesRead('absent');
    mockHasPersistedPreferencesFile.mockResolvedValue(false);
    mockChatStorageScopeIds.mockResolvedValue(['wt-1']);
    mockReadChatStorageDiscoveryIndex.mockResolvedValue({
      tabs: [{ id: 'legacy' }],
      runtimeByChatId: {},
    });
    await normalizeWorkspaceChatsForInheritedPluginDefaults(
      'ws-1',
      selections({ mcpServerRefs: [linear] }),
    );
    const update = mockUpdateCompatibilityTabs.mock.calls[0]?.[1];
    if (!update) throw new Error('Expected a chat state update');
    const next = update({
      version: 1,
      activeTabId: 'legacy',
      tabs: [tab({ id: 'legacy', pluginSelections: selections() })],
    });
    expect(next.tabs[0]?.disabledGlobalPluginSelections).toEqual({
      mcpServerRefs: [linear],
    });
  });

  it('normalizes a scope from its chats when its discovery index is unreadable', async () => {
    mockChatStorageScopeIds.mockResolvedValue(['wt-broken', 'wt-ok']);
    mockReadChatStorageDiscoveryIndex.mockImplementation((_root, scope) =>
      scope === 'wt-broken'
        ? Promise.reject(new Error('corrupt live index'))
        : Promise.resolve({ tabs: [{ id: 'legacy' }], runtimeByChatId: {} }),
    );

    await normalizeWorkspaceChatsForInheritedPluginDefaults('ws-1', undefined);

    expect(
      mockUpdateCompatibilityTabs.mock.calls.map(([scope]) => scope.worktreeId),
    ).toEqual(['wt-broken', 'wt-ok']);
  });

  it('fails after trying every scope when one cannot be normalized', async () => {
    mockChatStorageScopeIds.mockResolvedValue(['wt-broken', 'wt-ok']);
    mockReadChatStorageDiscoveryIndex.mockResolvedValue({
      tabs: [{ id: 'legacy' }],
      runtimeByChatId: {},
    });
    mockUpdateCompatibilityTabs.mockImplementation((scope, update) =>
      scope.worktreeId === 'wt-broken'
        ? Promise.reject(new Error('chat storage unavailable'))
        : Promise.resolve(update({ version: 1, activeTabId: '', tabs: [] })),
    );

    await expect(
      normalizeWorkspaceChatsForInheritedPluginDefaults('ws-1', undefined),
    ).rejects.toThrow('1 chat scope');

    expect(mockUpdateCompatibilityTabs).toHaveBeenCalledTimes(2);
    expect(mockLogMainProcessWarn).toHaveBeenCalledTimes(1);
  });

  // A refused keyed defaults change normalizes again on retry (CAN-4409).
  it('never rewrites a scope a second normalization finds already normalized', async () => {
    mockChatStorageScopeIds.mockResolvedValue(['wt-1']);
    // An unreadable index loads the scope in full, so no skip hides a write.
    mockReadChatStorageDiscoveryIndex.mockRejectedValue(new Error('corrupt'));
    let stored: ChatTabsFile = {
      version: 1,
      activeTabId: 'legacy',
      tabs: [
        tab({
          id: 'legacy',
          pluginSelections: selections({ mcpServerRefs: [linear, github] }),
        }),
      ],
    };
    const writes: ChatTabsFile[] = [];
    mockUpdateCompatibilityTabs.mockImplementation((_scope, update) => {
      const next = update(stored);
      if (next !== stored) writes.push((stored = next));
      return Promise.resolve(next);
    });
    const previousDefaults = selections({ mcpServerRefs: [linear] });

    await normalizeWorkspaceChatsForInheritedPluginDefaults(
      'ws-1',
      previousDefaults,
    );
    expect(writes).toHaveLength(1);
    expect(stored.tabs[0]).toMatchObject({
      inheritedPluginDefaultsVersion: 1,
      pluginSelections: { mcpServerRefs: [github] },
    });

    const normalized = stored;
    await normalizeWorkspaceChatsForInheritedPluginDefaults(
      'ws-1',
      previousDefaults,
    );
    expect(mockUpdateCompatibilityTabs).toHaveBeenCalledTimes(2);
    expect(writes).toHaveLength(1);
    expect(stored).toBe(normalized);
  });

  it('fails when the chat scopes cannot be listed', async () => {
    mockChatStorageScopeIds.mockRejectedValue(new Error('EACCES'));

    await expect(
      normalizeWorkspaceChatsForInheritedPluginDefaults('ws-1', undefined),
    ).rejects.toThrow('EACCES');
  });
});
