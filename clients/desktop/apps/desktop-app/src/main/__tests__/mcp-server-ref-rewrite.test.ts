import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChatTabPluginSelections,
  ChatTabsFile,
  PersistedChatTab,
  PreferencesData,
  WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';

let mockRoot = '';
let mockPreferences: Partial<PreferencesData> = {};
const mockConfigs = new Map<string, WorkspaceConfigFile>();
const mockTabs = new Map<string, PersistedChatTab>();
const mockWriteWorkspaceConfig = jest.fn(
  (id: string, config: WorkspaceConfigFile): Promise<void> => {
    mockConfigs.set(id, config);
    return Promise.resolve();
  },
);
const mockUpdateCompatibilityTab = jest.fn(
  (
    scope: { projectId: string; worktreeId: string },
    chatId: string,
    update: (tab: PersistedChatTab) => PersistedChatTab | null,
  ): Promise<{ updated: boolean }> => {
    const key = `${scope.projectId}/${scope.worktreeId}/${chatId}`;
    const tab = mockTabs.get(key);
    const next = tab ? update(tab) : null;
    if (next) mockTabs.set(key, next);
    return Promise.resolve({ updated: next !== null });
  },
);
const mockUpdateCompatibilityTabs = jest.fn(
  (
    scope: { projectId: string; worktreeId: string },
    update: (tabsFile: ChatTabsFile) => ChatTabsFile,
  ): Promise<ChatTabsFile> => {
    const prefix = `${scope.projectId}/${scope.worktreeId}/`;
    const tabs: PersistedChatTab[] = [];
    mockTabs.forEach((tab: PersistedChatTab, key: string): void => {
      if (key.startsWith(prefix)) tabs.push(tab);
    });
    const next = update({ version: 1, activeTabId: '', tabs });
    for (const tab of next.tabs) mockTabs.set(`${prefix}${tab.id}`, tab);
    return Promise.resolve(next);
  },
);
const mockBroadcast = jest.fn();
const mockBumpRevision = jest.fn();

jest.mock('../lib/paths', () => ({
  getWorkspacesRootDir: (): string => mockRoot,
}));
jest.mock('../lib/preferences-store', () => ({
  projectPreferencesForRuntime: (value: unknown): unknown => value,
  updatePreferencesFile: (
    updater: (
      latest: Partial<PreferencesData>,
    ) => Partial<PreferencesData> | null,
  ): Promise<Partial<PreferencesData>> => {
    const partial = updater(mockPreferences);
    if (partial) mockPreferences = { ...mockPreferences, ...partial };
    return Promise.resolve(mockPreferences);
  },
}));
jest.mock('../lib/preferences-broadcast', () => ({
  broadcastPreferencesSynced: (...args: unknown[]): void => {
    mockBroadcast(...args);
  },
}));
jest.mock('../agents/session-manager', () => ({
  bumpGlobalPluginDefaultsRevision: (): void => {
    mockBumpRevision();
  },
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfigDetailed: (
    id: string,
  ): Promise<{ config: WorkspaceConfigFile; authority: string }> => {
    const config = mockConfigs.get(id);
    return Promise.resolve(
      config
        ? { config, authority: 'ok' }
        : {
            config: { version: 1, type: 'multi-repo', repos: [] },
            authority: 'absent',
          },
    );
  },
  // The plugins boundary (CAN-3817) rewrites the config it reads inside the
  // workspace's write queue.
  updateWorkspaceConfig: async <T>(
    id: string,
    update: (
      config: WorkspaceConfigFile,
      read: { authority: string },
    ) => T | Promise<T>,
    options?: { shouldWrite?: (result: T) => boolean },
  ): Promise<T> => {
    const stored = mockConfigs.get(id);
    const config: WorkspaceConfigFile = structuredClone(
      stored ?? { version: 1, type: 'multi-repo', repos: [] },
    );
    const result = await update(config, {
      authority: stored ? 'ok' : 'absent',
    });
    if (!options?.shouldWrite || options.shouldWrite(result)) {
      await mockWriteWorkspaceConfig(id, config);
    }
    return result;
  },
}));
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): object => ({
    updateCompatibilityTab: mockUpdateCompatibilityTab,
    updateCompatibilityTabs: mockUpdateCompatibilityTabs,
  }),
}));

import {
  MCP_SERVER_REF_REWRITE_INCOMPLETE,
  rewriteMcpServerRefs,
} from '../mcp/server-ref-rewrite';
import {
  rewriteMcpSelections,
  rewriteMcpServerRefList,
} from '../mcp/server-ref-matching';

const device = { serverId: 'dev-1', configId: 'cfg-1' };
const cloud = { serverId: 'custom:abc', configId: 'default' };

function selections(
  refs: Array<{ serverId: string; configId: string }>,
): ChatTabPluginSelections {
  return {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: refs,
  };
}

async function seedScope(
  workspaceId: string,
  scopeId: string,
  tabs: Array<Pick<PersistedChatTab, 'id'> & Partial<PersistedChatTab>>,
): Promise<void> {
  const root = join(mockRoot, workspaceId);
  await mkdir(join(root, 'chat-storage-manifests'), { recursive: true });
  await mkdir(join(root, 'chat-storage-v2', scopeId), { recursive: true });
  await writeFile(
    join(root, 'chat-storage-manifests', `${scopeId}.json`),
    JSON.stringify({ version: 2, scopeId }),
  );
  await writeFile(
    join(root, 'chat-storage-v2', scopeId, 'live-index.json'),
    JSON.stringify({ version: 2, tabs, runtimeByChatId: {} }),
  );
  for (const tab of tabs) {
    const persisted: PersistedChatTab = {
      title: 'Chat',
      createdAt: '2026-09-01T00:00:00.000Z',
      messages: [],
      ...structuredClone(tab),
    };
    mockTabs.set(`${workspaceId}/${scopeId}/${tab.id}`, persisted);
  }
}

beforeEach(async (): Promise<void> => {
  mockRoot = await mkdtemp(join(tmpdir(), 'mcp-ref-rewrite-'));
  mockPreferences = {};
  mockConfigs.clear();
  mockTabs.clear();
  jest.clearAllMocks();
});
afterEach(async (): Promise<void> => {
  await rm(mockRoot, { recursive: true, force: true });
});

describe('rewriteMcpServerRefList', (): void => {
  it('replaces matching refs in place and drops the duplicate it makes', (): void => {
    expect(
      rewriteMcpServerRefList(
        [
          { serverId: 'other', configId: 'x' },
          device,
          { serverId: 'dev-1', configId: 'cfg-2' },
          cloud,
        ],
        [{ serverId: 'dev-1' }],
        cloud,
      ),
    ).toEqual([{ serverId: 'other', configId: 'x' }, cloud]);
  });
  it('matches one config when the matcher names it', (): void => {
    expect(
      rewriteMcpServerRefList(
        [device, { serverId: 'dev-1', configId: 'cfg-2' }],
        [{ serverId: 'dev-1', configId: 'cfg-2' }],
        cloud,
      ),
    ).toEqual([device, cloud]);
  });
  it('reports no change when nothing matches', (): void => {
    expect(
      rewriteMcpServerRefList([device], [{ serverId: 'missing' }], cloud),
    ).toBeNull();
  });
});

describe('rewriteMcpSelections', (): void => {
  it('drops handler overrides for the moved server only', (): void => {
    const input: ChatTabPluginSelections = {
      ...selections([device]),
      mcpHttpAuthPreferences: [
        { target: { kind: 'standalone', ...device }, handler: 'provider' },
        {
          target: {
            kind: 'plugin',
            marketplaceId: 'm',
            pluginName: 'p',
            serverName: 's',
          },
          handler: 'canopy',
        },
      ],
    };
    expect(rewriteMcpSelections(input, [{ serverId: 'dev-1' }], cloud)).toEqual(
      {
        ...selections([cloud]),
        mcpHttpAuthPreferences: [input.mcpHttpAuthPreferences?.[1]],
      },
    );
  });
});

describe('rewriteMcpServerRefs', (): void => {
  it('points global defaults, project defaults and saved chats at the new server', async (): Promise<void> => {
    mockPreferences = { globalPluginSelections: selections([device]) };
    mockConfigs.set('ws-a', {
      version: 1,
      type: 'multi-repo',
      repos: [],
      defaultPluginSelections: selections([device]),
      disabledGlobalPluginSelections: { mcpServerRefs: [device] },
    });
    mockConfigs.set('ws-b', {
      version: 1,
      type: 'cowork',
      repos: [],
      defaultPluginSelections: selections([]),
    });
    await mkdir(join(mockRoot, 'ws-a'), { recursive: true });
    await mkdir(join(mockRoot, 'ws-b'), { recursive: true });
    await seedScope('ws-a', 'wt-1', [
      { id: 'chat-1', pluginSelections: selections([device]) },
      { id: 'chat-2', pluginSelections: selections([]) },
      {
        id: 'chat-3',
        disabledGlobalPluginSelections: { mcpServerRefs: [device] },
      },
    ]);
    await seedScope('ws-b', 'entry-1', [
      { id: 'chat-4', pluginSelections: selections([device]) },
    ]);
    // A viewer scope without a project config is never written.
    await seedScope('viewer', 'container', [
      { id: 'chat-5', pluginSelections: selections([device]) },
    ]);

    expect(
      await rewriteMcpServerRefs({ from: [{ serverId: 'dev-1' }], to: cloud }),
    ).toEqual({ globalDefaults: true, workspaces: 1, chats: 3 });

    expect(mockPreferences.globalPluginSelections?.mcpServerRefs).toEqual([
      cloud,
    ]);
    expect(mockBumpRevision).toHaveBeenCalledTimes(1);
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(mockWriteWorkspaceConfig).toHaveBeenCalledTimes(1);
    expect(mockConfigs.get('ws-a')).toMatchObject({
      defaultPluginSelections: { mcpServerRefs: [cloud] },
      disabledGlobalPluginSelections: { mcpServerRefs: [cloud] },
    });
    expect(mockTabs.get('ws-a/wt-1/chat-1')?.pluginSelections).toEqual(
      selections([cloud]),
    );
    expect(
      mockTabs.get('ws-a/wt-1/chat-3')?.disabledGlobalPluginSelections,
    ).toEqual({ mcpServerRefs: [cloud] });
    expect(mockTabs.get('ws-b/entry-1/chat-4')?.pluginSelections).toEqual(
      selections([cloud]),
    );
    expect(mockTabs.get('viewer/container/chat-5')?.pluginSelections).toEqual(
      selections([device]),
    );
    expect(mockUpdateCompatibilityTab).toHaveBeenCalledWith(
      { projectId: 'ws-a', worktreeId: 'wt-1' },
      'chat-1',
      expect.any(Function),
      undefined,
      { metadataOnly: true },
    );
    // Untouched chats are never rewritten.
    expect(mockUpdateCompatibilityTab).not.toHaveBeenCalledWith(
      expect.anything(),
      'chat-2',
      expect.anything(),
      undefined,
      expect.anything(),
    );
  });

  it('leaves the refs of other configs alone when the move names one config', async (): Promise<void> => {
    const other = { serverId: 'dev-1', configId: 'cfg-2' };
    const otherOverride = {
      target: { kind: 'standalone' as const, ...other },
      handler: 'provider' as const,
    };
    mockPreferences = {
      globalPluginSelections: {
        ...selections([device, other]),
        mcpHttpAuthPreferences: [otherOverride],
      },
    };
    mockConfigs.set('ws-a', {
      version: 1,
      type: 'multi-repo',
      repos: [],
      defaultPluginSelections: selections([other]),
      disabledGlobalPluginSelections: { mcpServerRefs: [device, other] },
    });
    await mkdir(join(mockRoot, 'ws-a'), { recursive: true });
    await seedScope('ws-a', 'wt-1', [
      { id: 'chat-1', pluginSelections: selections([device]) },
      { id: 'chat-2', pluginSelections: selections([other]) },
      {
        id: 'chat-3',
        pluginSelections: {
          ...selections([]),
          mcpHttpAuthPreferences: [otherOverride],
        },
      },
    ]);

    expect(
      await rewriteMcpServerRefs({
        from: [{ serverId: 'dev-1', configId: 'cfg-1' }],
        to: cloud,
      }),
    ).toEqual({ globalDefaults: true, workspaces: 1, chats: 1 });

    expect(mockPreferences.globalPluginSelections).toEqual({
      ...selections([cloud, other]),
      mcpHttpAuthPreferences: [otherOverride],
    });
    expect(mockConfigs.get('ws-a')).toMatchObject({
      defaultPluginSelections: { mcpServerRefs: [other] },
      disabledGlobalPluginSelections: { mcpServerRefs: [cloud, other] },
    });
    expect(mockTabs.get('ws-a/wt-1/chat-1')?.pluginSelections).toEqual(
      selections([cloud]),
    );
    expect(mockTabs.get('ws-a/wt-1/chat-2')?.pluginSelections).toEqual(
      selections([other]),
    );
    // Chats that only use another config are never loaded for rewriting.
    const loaded = mockUpdateCompatibilityTab.mock.calls.map(
      ([, chatId]): string => chatId,
    );
    expect(loaded).toEqual(['chat-1']);
  });

  it('rewrites the chats of a scope whose discovery index is unreadable', async (): Promise<void> => {
    mockConfigs.set('ws-a', { version: 1, type: 'multi-repo', repos: [] });
    await seedScope('ws-a', 'wt-1', [
      { id: 'chat-1', pluginSelections: selections([device]) },
      { id: 'chat-2', pluginSelections: selections([]) },
    ]);
    await writeFile(
      join(mockRoot, 'ws-a', 'chat-storage-v2', 'wt-1', 'live-index.json'),
      '{ not json',
    );

    expect(
      await rewriteMcpServerRefs({ from: [{ serverId: 'dev-1' }], to: cloud }),
    ).toEqual({ globalDefaults: false, workspaces: 0, chats: 1 });
    expect(mockTabs.get('ws-a/wt-1/chat-1')?.pluginSelections).toEqual(
      selections([cloud]),
    );
    expect(mockTabs.get('ws-a/wt-1/chat-2')?.pluginSelections).toEqual(
      selections([]),
    );
  });

  it('fails after trying every scope when a chat cannot be rewritten', async (): Promise<void> => {
    mockConfigs.set('ws-a', { version: 1, type: 'multi-repo', repos: [] });
    await seedScope('ws-a', 'wt-broken', [
      { id: 'chat-1', pluginSelections: selections([device]) },
    ]);
    await seedScope('ws-a', 'wt-ok', [
      { id: 'chat-2', pluginSelections: selections([device]) },
    ]);
    mockUpdateCompatibilityTab.mockImplementationOnce(
      (): Promise<{ updated: boolean }> =>
        Promise.reject(new Error('chat storage unavailable')),
    );

    await expect(
      rewriteMcpServerRefs({ from: [{ serverId: 'dev-1' }], to: cloud }),
    ).rejects.toThrow(MCP_SERVER_REF_REWRITE_INCOMPLETE);
    expect(mockUpdateCompatibilityTab).toHaveBeenCalledTimes(2);
  });

  it('does nothing when the only source is the target itself', async (): Promise<void> => {
    mockPreferences = { globalPluginSelections: selections([cloud]) };
    expect(
      await rewriteMcpServerRefs({
        from: [{ serverId: cloud.serverId }],
        to: cloud,
      }),
    ).toEqual({ globalDefaults: false, workspaces: 0, chats: 0 });
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});
