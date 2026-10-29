import { PLUGINS_CHANNELS } from '@canopy/desktop-shared/constants/plugin-channels';
import type { PipelinePackageAnalysisSummary } from '@canopy/desktop-shared/types/pipeline';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const mockAnalyzeSubjectCapabilityPackage: jest.MockedFunction<
  (input: unknown) => Promise<PipelinePackageAnalysisSummary>
> = jest.fn();
const mockCloud = {
  // The capability assertion moved into the Cloud client module (CAN-2829);
  // it still funnels through the mocked capability check these cases assert.
  assertSharedPluginsSupported: jest.fn(async (): Promise<void> => {
    const { assertCanopyCloudCapability: assertCapability } = jest.requireMock<{
      assertCanopyCloudCapability: () => Promise<void>;
    }>('../canopy-cloud/client');
    await assertCapability('plugins-crud-v1');
  }),
  listSharedPlugins: jest.fn(),
  getSharedPlugin: jest.fn(),
  createSharedPlugin: jest.fn(),
  deleteSharedPlugin: jest.fn(),
  publishPluginPublicShare: jest.fn(),
  revokePluginPublicShare: jest.fn(),
};

jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (...args: unknown[]) => unknown,
  ): void => {
    handlers.set(channel, handler);
  },
}));

jest.mock('../canopy-cloud/client', () => ({
  // Share handlers classify failures against the real error class.
  CanopyCloudClientError: class CanopyCloudClientError extends Error {},
  assertCanopyCloudCapability: jest.fn(() => Promise.resolve()),
}));

jest.mock('../plugins/invocable-inventory-service', () => ({
  refreshInvocableInventoryAfterMutation: jest.fn(),
}));

jest.mock('../plugins/plugin-service', () => ({}));

jest.mock('../plugins/shareable-plugin-resolution', () => ({
  loadShareablePluginCatalog: jest.fn(),
  resolveShareablePluginRefs: jest.fn(),
}));

jest.mock('../plugins/canopy-server-client', () => mockCloud);
jest.mock('../pipelines/pipeline-package-service', () => ({
  analyzeSubjectCapabilityPackage: (
    input: unknown,
  ): Promise<PipelinePackageAnalysisSummary> =>
    mockAnalyzeSubjectCapabilityPackage(input),
}));

import { registerPluginHandlers } from '../plugins/plugin-handlers';
import { assertCanopyCloudCapability } from '../canopy-cloud/client';
import {
  loadShareablePluginCatalog,
  resolveShareablePluginRefs,
} from '../plugins/shareable-plugin-resolution';

const UUID = '2f0c9a1e-4b3d-4f6a-8c2e-1d5b7a9e0c4f';
const request = {
  serverId: 'canopy-cloud',
  ref: {
    type: 'plugin' as const,
    marketplace: { type: 'github' as const, repo: 'acme/plugins' },
    plugin_name: 'browser',
  },
  name: 'Browser',
  description: 'Browser tools',
};

function invoke(channel: string, payload?: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing handler for ${channel}`);
  return Promise.resolve(handler({}, payload));
}

describe('shared plugin IPC handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    handlers.clear();
    registerPluginHandlers();
  });

  it('forwards the requested ownership facet to the backend reader', async () => {
    mockCloud.listSharedPlugins.mockResolvedValue([]);
    await invoke(PLUGINS_CHANNELS.SHARED_LIST, {
      serverId: 'canopy-cloud',
      createdBy: 'me',
      query: 'browser',
    });
    expect(mockCloud.listSharedPlugins).toHaveBeenCalledWith({
      serverId: 'canopy-cloud',
      createdBy: 'me',
      query: 'browser',
    });
  });

  it('creates and publishes a portable plugin share', async () => {
    mockCloud.createSharedPlugin.mockResolvedValue({ externalId: UUID });
    mockCloud.publishPluginPublicShare.mockResolvedValue({
      externalId: UUID,
      sharePath: `/share/plugins/${UUID}`,
    });

    await expect(
      invoke(PLUGINS_CHANNELS.SHARED_CREATE, request),
    ).resolves.toEqual({ success: true, data: { externalId: UUID } });
    await expect(
      invoke(PLUGINS_CHANNELS.SHARED_PUBLIC_PUBLISH, UUID),
    ).resolves.toEqual({
      success: true,
      data: { externalId: UUID, sharePath: `/share/plugins/${UUID}` },
    });
    expect(mockCloud.createSharedPlugin).toHaveBeenCalledWith(request);
    expect(mockCloud.publishPluginPublicShare).toHaveBeenCalledWith(UUID);
    expect(assertCanopyCloudCapability).toHaveBeenCalledTimes(2);
    expect(assertCanopyCloudCapability).toHaveBeenNthCalledWith(
      1,
      'plugins-crud-v1',
    );
    expect(assertCanopyCloudCapability).toHaveBeenNthCalledWith(
      2,
      'plugins-crud-v1',
    );
  });

  it('reports a failed capability check as not shared, before publication', async () => {
    jest
      .mocked(assertCanopyCloudCapability)
      .mockRejectedValueOnce(new Error('socket hang up'));

    await expect(
      invoke(PLUGINS_CHANNELS.SHARED_CREATE, {
        serverId: 'canopy-cloud',
        ref: { kind: 'marketplace', marketplace: 'acme', name: 'tool' },
        name: 'Tool',
      }),
    ).resolves.toMatchObject({
      success: false,
      failure: { stage: 'access', commitState: 'not-committed' },
    });
    expect(mockCloud.createSharedPlugin).not.toHaveBeenCalled();
  });

  it('wraps Cloud failures in the IPC result envelope', async () => {
    mockCloud.listSharedPlugins.mockRejectedValue(new Error('offline'));
    await expect(
      invoke(PLUGINS_CHANNELS.SHARED_LIST, { serverId: 'canopy-cloud' }),
    ).resolves.toEqual({ success: false, error: 'offline' });
  });

  it('gets and deletes an owned shared plugin', async () => {
    mockCloud.getSharedPlugin.mockResolvedValue({ externalId: UUID });
    mockCloud.deleteSharedPlugin.mockResolvedValue(undefined);

    await expect(
      invoke(PLUGINS_CHANNELS.SHARED_GET, {
        serverId: 'canopy-cloud',
        remoteId: UUID,
      }),
    ).resolves.toEqual({ success: true, data: { externalId: UUID } });
    await expect(
      invoke(PLUGINS_CHANNELS.SHARED_DELETE, {
        serverId: 'canopy-cloud',
        remoteId: UUID,
      }),
    ).resolves.toEqual({ success: true });
    expect(mockCloud.getSharedPlugin).toHaveBeenCalledWith(UUID);
    expect(mockCloud.deleteSharedPlugin).toHaveBeenCalledWith(UUID);
  });

  it('rejects malformed remote ids before calling Cloud', async () => {
    await expect(
      invoke(PLUGINS_CHANNELS.SHARED_PUBLIC_REVOKE, '../not-an-id'),
    ).resolves.toMatchObject({ success: false });
    expect(mockCloud.revokePluginPublicShare).not.toHaveBeenCalled();
  });

  it('resolves a portable enable reference and rejects malformed requests', async () => {
    jest.mocked(loadShareablePluginCatalog).mockResolvedValue({
      skills: [
        {
          sourceId: 'source',
          name: 'review',
          shareableSource: { type: 'builtin', id: 'app' },
        },
      ],
      marketplaces: [],
    } as never);
    await expect(
      invoke(PLUGINS_CHANNELS.RESOLVE_PORTABLE_ENABLE_REF, {
        enableRef: { kind: 'skill', sourceId: 'source', skillName: 'review' },
      }),
    ).resolves.toEqual({
      success: true,
      data: {
        type: 'skill',
        source: { type: 'builtin', id: 'app' },
        skill_name: 'review',
      },
    });
    await expect(
      invoke(PLUGINS_CHANNELS.RESOLVE_PORTABLE_ENABLE_REF, {
        enableRef: { kind: 'unknown' },
      }),
    ).resolves.toMatchObject({
      success: false,
      error: 'Plugin selection is invalid.',
    });
    jest
      .mocked(loadShareablePluginCatalog)
      .mockRejectedValueOnce(new Error('catalog offline'));
    await expect(
      invoke(PLUGINS_CHANNELS.RESOLVE_PORTABLE_ENABLE_REF, {
        enableRef: { kind: 'skill', sourceId: 'source', skillName: 'review' },
      }),
    ).resolves.toMatchObject({ success: false, error: 'catalog offline' });
  });

  it('resolves portable references and reports validation and catalog errors', async () => {
    const ref = {
      type: 'plugin',
      marketplace: { type: 'builtin', id: 'app' },
      plugin_name: 'review',
    };
    jest
      .mocked(loadShareablePluginCatalog)
      .mockResolvedValue({ skills: [], marketplaces: [] } as never);
    jest.mocked(resolveShareablePluginRefs).mockReturnValue([
      {
        ref,
        matchState: 'matched',
        selection: {
          kind: 'plugin',
          marketplaceId: 'market',
          pluginName: 'review',
        },
      },
    ] as never);
    await expect(
      invoke(PLUGINS_CHANNELS.RESOLVE_PORTABLE_REFS, {
        refs: [ref],
        providerType: 'claude',
      }),
    ).resolves.toMatchObject({
      success: true,
      data: {
        selections: {
          pluginRefs: [{ marketplaceId: 'market', pluginName: 'review' }],
        },
        unresolved: [],
      },
    });
    await expect(
      invoke(PLUGINS_CHANNELS.RESOLVE_PORTABLE_REFS, { refs: [{}] }),
    ).resolves.toMatchObject({
      success: false,
      error: 'Portable plugin references are invalid.',
    });
    jest
      .mocked(loadShareablePluginCatalog)
      .mockRejectedValueOnce(new Error('catalog offline'));
    await expect(
      invoke(PLUGINS_CHANNELS.RESOLVE_PORTABLE_REFS, { refs: [ref] }),
    ).resolves.toMatchObject({ success: false, error: 'catalog offline' });
  });

  it('analyzes plugin setup as a reference without packaging files', async () => {
    jest
      .mocked(loadShareablePluginCatalog)
      .mockResolvedValue({ skills: [], marketplaces: [] } as never);
    jest.mocked(resolveShareablePluginRefs).mockReturnValue([
      {
        ref: request.ref,
        matchState: 'matched',
        selection: {
          kind: 'plugin',
          marketplaceId: 'market',
          pluginName: 'browser',
        },
      },
    ] as never);
    mockAnalyzeSubjectCapabilityPackage.mockResolvedValue({
      analysisId: 'analysis-1',
      state: 'ready',
      pipelineContentHash: 'a'.repeat(64),
      blockers: [],
      expiresAt: '2026-10-01T00:10:00.000Z',
    });

    await expect(
      invoke(PLUGINS_CHANNELS.SHARED_REFERENCE_ANALYZE, { ref: request.ref }),
    ).resolves.toMatchObject({
      success: true,
      data: { analysisId: 'analysis-1' },
    });
    expect(
      mockAnalyzeSubjectCapabilityPackage.mock.calls[0]?.[0],
    ).toMatchObject({
      mode: 'reference',
      selections: {
        pluginRefs: [{ marketplaceId: 'market', pluginName: 'browser' }],
      },
    });
  });
});
