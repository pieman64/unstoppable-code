import type * as AgentModelStore from '../agents/agent-model-store';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImportPublicAgentRequest } from '@canopy/desktop-shared/types/agent-models';
import {
  initClaudeModels,
  IPC_CHANNELS,
  type ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import type { SharedAgentDetail } from '@canopy/desktop-shared/types/agent-models';
import type {
  InstallSubjectCapabilityPackageRequest,
  InstallSubjectCapabilityPackageResult,
} from '../skills/skill-package-install';

initClaudeModels([{ id: 'sonnet', label: 'Sonnet' }]);

let mockAgentModelsFilePath = '';
let mockResourceContextEnabled = false;
jest.mock('../agents/resource-lanes', () => ({
  agentResourceContextEnabled: (): boolean => mockResourceContextEnabled,
}));
jest.mock('../agents/agent-install-context', () => ({
  assertStoredAgentContext: jest.fn(),
  filterStoredAgentContexts: <T>(rows: T[]): Promise<T[]> =>
    Promise.resolve(rows),
  recordSharedAgentInstall: jest.fn(),
}));

const mockHandlers = new Map<string, (...args: unknown[]) => unknown>();
const mockAssertCapability = jest.fn();
const mockRefreshAgentModelsFromStore = jest.fn();
const mockBroadcastModelRegistryUpdated = jest.fn();
const mockCreateSharedAgent = jest.fn();
const mockUpdateSharedAgent = jest.fn();
const mockDeleteSharedAgent = jest.fn();
const mockGetSharedAgent = jest.fn();
const mockGetAgentPackage = jest.fn();
const mockGetAgentPackageBlob = jest.fn();
const mockGetPublicAgentPackage = jest.fn();
const mockGetPublicAgentPackageBlob = jest.fn();
const mockListSharedAgents = jest.fn();
const mockListAgentModels = jest.fn();
const mockGetAgentModel = jest.fn();
const mockSaveAgentModel = jest.fn<
  Promise<unknown>,
  Parameters<typeof AgentModelStore.saveAgentModel>
>();
const mockDeleteAgentModel = jest.fn();
const mockImportSharedAgent = jest.fn<
  Promise<unknown>,
  [SharedAgentDetail, ChatTabPluginSelections]
>();
const mockWriteAgentRemoteMetadata = jest.fn();
const mockClearAgentRemoteMetadataByRemoteId = jest.fn();
const mockFindInstalledPublicAgent = jest.fn();
const mockImportPublicAgent = jest.fn<
  Promise<unknown>,
  Parameters<typeof AgentModelStore.importPublicAgent>
>();
const mockUninstallPublicAgent = jest.fn();
const mockPublishAgentPublicShare = jest.fn();
const mockRevokeAgentPublicShare = jest.fn();
const mockInstallSubjectCapabilityPackage = jest.fn<
  Promise<unknown>,
  [InstallSubjectCapabilityPackageRequest]
>();
const mockPrepareDesktopWorkspaceTemplateRefs = jest.fn();
const mockResolveShareablePluginRefs = jest.fn(() => []);
const mockFindCapabilityPackageInstallByOwner = jest.fn();
const mockUpsertCapabilityPackageInstall = jest.fn();
const mockGetMcpServerStatusByCatalogId = jest.fn();
const mockGetMcpServerStatusByName = jest.fn();

jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (...args: unknown[]) => unknown,
  ): void => {
    mockHandlers.set(channel, handler);
  },
}));

jest.mock('../canopy-cloud/client', () => ({
  // Share handlers classify failures against the real error class.
  CanopyCloudClientError: class CanopyCloudClientError extends Error {},
  assertCanopyCloudCapability: (...args: unknown[]): Promise<void> => {
    mockAssertCapability(...args);
    return Promise.resolve();
  },
}));

jest.mock('../lib/agent-models', () => ({
  refreshAgentModelsFromStore: (): Promise<void> => {
    mockRefreshAgentModelsFromStore();
    return Promise.resolve();
  },
}));

jest.mock('../models/model-registry', () => ({
  broadcastModelRegistryUpdated: (): Promise<void> => {
    mockBroadcastModelRegistryUpdated();
    return Promise.resolve();
  },
}));

jest.mock('../plugins/shareable-plugin-resolution', () => ({
  loadShareablePluginCatalog: jest.fn(),
  resolveShareablePluginRefs: (...args: unknown[]): unknown =>
    mockResolveShareablePluginRefs(...args),
}));

jest.mock('../plugins/workspace-template-import', () => ({
  prepareDesktopWorkspaceTemplateRefs: (...args: unknown[]): unknown =>
    mockPrepareDesktopWorkspaceTemplateRefs(...args),
}));

jest.mock('../agents/canopy-server-client', () => ({
  createSharedAgent: (...args: unknown[]): unknown =>
    mockCreateSharedAgent(...args) as unknown,
  updateSharedAgent: (...args: unknown[]): unknown =>
    mockUpdateSharedAgent(...args) as unknown,
  deleteSharedAgent: (...args: unknown[]): unknown =>
    mockDeleteSharedAgent(...args) as unknown,
  getSharedAgent: (...args: unknown[]): unknown =>
    mockGetSharedAgent(...args) as unknown,
  getAgentPackage: (...args: unknown[]): unknown =>
    mockGetAgentPackage(...args) as unknown,
  getAgentPackageBlob: (...args: unknown[]): unknown =>
    mockGetAgentPackageBlob(...args) as unknown,
  getPublicAgentPackage: (...args: unknown[]): unknown =>
    mockGetPublicAgentPackage(...args) as unknown,
  getPublicAgentPackageBlob: (...args: unknown[]): unknown =>
    mockGetPublicAgentPackageBlob(...args) as unknown,
  listSharedAgents: (...args: unknown[]): unknown =>
    mockListSharedAgents(...args) as unknown,
  publishAgentPublicShare: (...args: unknown[]): unknown =>
    mockPublishAgentPublicShare(...args),
  revokeAgentPublicShare: (...args: unknown[]): unknown =>
    mockRevokeAgentPublicShare(...args),
}));

jest.mock('../skills/skill-package-install', () => ({
  installSubjectCapabilityPackage: (...args: unknown[]): unknown =>
    mockInstallSubjectCapabilityPackage(...args) as unknown,
}));

jest.mock('../pipelines/pipeline-package-install-store', () => ({
  findCapabilityPackageInstallByOwner: (...args: unknown[]): unknown =>
    mockFindCapabilityPackageInstallByOwner(...args),
  upsertCapabilityPackageInstall: (...args: unknown[]): unknown =>
    mockUpsertCapabilityPackageInstall(...args),
}));

jest.mock('../lib/paths', () => ({
  getPipelinePackageInstallStorePath: (): string => '/tmp/installs.json',
  getAgentModelsFilePath: (): string => mockAgentModelsFilePath,
}));

jest.mock('../mcp/connection-status', () => ({
  getMcpServerStatusByCatalogId: (...args: unknown[]): unknown =>
    mockGetMcpServerStatusByCatalogId(...args),
  getMcpServerStatusByName: (...args: unknown[]): unknown =>
    mockGetMcpServerStatusByName(...args),
}));

jest.mock('../agents/agent-model-store', () => ({
  listAgentModels: (...args: unknown[]): unknown =>
    mockListAgentModels(...args) as unknown,
  getAgentModel: (...args: unknown[]): unknown =>
    mockGetAgentModel(...args) as unknown,
  saveAgentModel: (
    ...args: Parameters<typeof AgentModelStore.saveAgentModel>
  ): Promise<unknown> => mockSaveAgentModel(...args),
  deleteAgentModel: (...args: unknown[]): unknown =>
    mockDeleteAgentModel(...args) as unknown,
  importSharedAgent: (...args: unknown[]): unknown =>
    mockImportSharedAgent(...args) as unknown,
  writeAgentRemoteMetadata: (...args: unknown[]): unknown =>
    mockWriteAgentRemoteMetadata(...args) as unknown,
  clearAgentRemoteMetadataByRemoteId: (...args: unknown[]): unknown =>
    mockClearAgentRemoteMetadataByRemoteId(...args) as unknown,
  findInstalledPublicAgent: (...args: unknown[]): unknown =>
    mockFindInstalledPublicAgent(...args),
  importPublicAgent: (...args: unknown[]): unknown =>
    mockImportPublicAgent(...args),
  uninstallPublicAgent: (...args: unknown[]): unknown =>
    mockUninstallPublicAgent(...args),
}));

import { registerAgentModelHandlers } from '../ipc/agent-models';

function getWindow(): {
  isDestroyed: () => boolean;
  webContents: { send: jest.Mock };
} {
  return {
    isDestroyed: (): boolean => false,
    webContents: { send: jest.fn() },
  };
}

describe('agent model IPC handlers', () => {
  beforeEach(() => {
    mockHandlers.clear();
    jest.clearAllMocks();
    mockAssertCapability.mockResolvedValue(undefined);
    mockRefreshAgentModelsFromStore.mockResolvedValue(undefined);
    mockBroadcastModelRegistryUpdated.mockResolvedValue(undefined);
    mockListAgentModels.mockResolvedValue([]);
    mockGetMcpServerStatusByCatalogId.mockResolvedValue(null);
    mockGetMcpServerStatusByName.mockResolvedValue(null);
    mockUpsertCapabilityPackageInstall.mockResolvedValue(undefined);
    registerAgentModelHandlers(getWindow as never);
  });

  it('creates a shared agent, stores remote metadata, and broadcasts changes', async () => {
    const detail = {
      id: 'shared-agent-id',
      contentHash: 'server-hash',
      createdBy: { id: 'account-a' },
      agent: { id: 'agent_model_reviewer' },
    };
    mockCreateSharedAgent.mockResolvedValue(detail);

    const handler = mockHandlers.get(IPC_CHANNELS.agentsSharedCreate);
    await expect(handler?.({}, { agent: detail.agent })).resolves.toEqual({
      ok: true,
      value: detail,
    });

    expect(mockAssertCapability).toHaveBeenCalledWith('agents-crud-v1');
    expect(mockWriteAgentRemoteMetadata).toHaveBeenCalledWith({
      id: 'agent_model_reviewer',
      remoteId: 'shared-agent-id',
      remoteAccountId: 'account-a',
      remoteContentHash: 'server-hash',
    });
    expect(mockRefreshAgentModelsFromStore).toHaveBeenCalledTimes(1);
    expect(mockBroadcastModelRegistryUpdated).toHaveBeenCalledTimes(1);
  });

  it('passes scoped uninstall identity to the main store', async (): Promise<void> => {
    const importedShare = {
      remoteId: '11111111-1111-4111-8111-111111111111',
      contentHash: 'remote-hash',
    };
    mockDeleteAgentModel.mockResolvedValue(true);
    await mockHandlers.get(IPC_CHANNELS.agentsDelete)?.(
      {},
      { id: 'agent_model_reviewer', importedShare },
    );
    expect(mockDeleteAgentModel).toHaveBeenCalledWith(
      'agent_model_reviewer',
      importedShare,
    );
  });

  it('validates local Agent ids before store operations', async () => {
    mockGetAgentModel.mockResolvedValue({ id: 'agent_model_reviewer' });
    const getHandler = mockHandlers.get(IPC_CHANNELS.agentsGet);
    await expect(getHandler?.({}, 'agent_model_reviewer')).resolves.toEqual({
      id: 'agent_model_reviewer',
    });
    expect(() => getHandler?.({}, 'bad id')).toThrow('Invalid agent id');
    expect(mockGetAgentModel).toHaveBeenCalledTimes(1);
  });

  it('validates shared Agent ids before cloud operations', async () => {
    const handler = mockHandlers.get(IPC_CHANNELS.agentsImportShared);
    await expect(handler?.({}, { agentId: 'not a valid id' })).rejects.toThrow(
      'Invalid shared agent id',
    );
    expect(mockGetSharedAgent).not.toHaveBeenCalled();
  });

  it('installs a shared Agent package and maps its skills into the saved Agent', async () => {
    const agentId = '11111111-1111-4111-8111-111111111111';
    const digest = `pp:v1:${'A'.repeat(43)}`;
    const detail = {
      id: agentId,
      contentHash: 'server-hash',
      package: {
        version: 1,
        digest,
        resources: [],
        environmentRequirements: [],
        totalFiles: 1,
        totalBytes: 10,
      },
      agent: {
        version: 1,
        id: 'agent_model_reviewer',
        name: 'Reviewer',
        baseModel: 'sonnet',
        instructions: 'Review.',
        plugins: [],
      },
    };
    const importedAgent = {
      ...detail.agent,
      pluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
      },
      contentHash: 'local-hash',
    };
    mockGetSharedAgent.mockResolvedValue(detail);
    mockImportSharedAgent.mockResolvedValue({
      agent: importedAgent,
      requestedId: detail.agent.id,
      finalId: detail.agent.id,
      idChanged: false,
    });
    mockGetAgentPackage.mockResolvedValue({ digest, manifest: {} });
    let finalizedHash: string | undefined;
    mockInstallSubjectCapabilityPackage.mockImplementation(async (request) => {
      const installed: InstallSubjectCapabilityPackageResult = {
        supportingFileCount: 0,
        installedSkills: [{ name: 'Helper', localName: 'helper-2' }],
        uninstalledResourceLabels: [],
        keptLocalFiles: [],
      };
      if (!request.finalizeInstall || !request.rollbackFinalization) {
        throw new Error('missing install transaction callbacks');
      }
      finalizedHash = await request.finalizeInstall(installed);
      return installed;
    });
    mockSaveAgentModel.mockImplementation((request: unknown) =>
      Promise.resolve({
        ...(request as Record<string, unknown>),
        contentHash: 'final-local-hash',
      }),
    );

    const handler = mockHandlers.get(IPC_CHANNELS.agentsImportShared);
    await expect(
      handler?.({}, { agentId, installMissing: true }),
    ).resolves.toMatchObject({ agent: { id: detail.agent.id } });

    expect(mockGetAgentPackage).toHaveBeenCalledWith(agentId, digest);
    expect(mockInstallSubjectCapabilityPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: { kind: 'agent', localId: detail.agent.id },
        originExternalId: agentId,
        packageRef: { version: 1, digest },
      }),
    );
    const installRequest =
      mockInstallSubjectCapabilityPackage.mock.calls[0]?.[0];
    expect(typeof installRequest?.finalizeInstall).toBe('function');
    expect(typeof installRequest?.rollbackFinalization).toBe('function');
    expect(finalizedHash).toBe('final-local-hash');
    const savedRequest = mockSaveAgentModel.mock.calls[0]?.[0] as
      | {
          id: string;
          pluginSelections: {
            skillRefs: Array<{ sourceId: string; skillName: string }>;
          };
        }
      | undefined;
    expect(savedRequest?.id).toBe(detail.agent.id);
    expect(savedRequest?.pluginSelections.skillRefs).toEqual([
      { sourceId: 'custom:app', skillName: 'helper-2' },
    ]);
  });

  it('imports the exact shared Agent snapshot that the user reviewed', async () => {
    const agentId = '11111111-1111-4111-8111-111111111111';
    const reviewed: SharedAgentDetail = {
      id: agentId,
      contentHash: 'reviewed-hash',
      agent: {
        version: 1 as const,
        id: 'agent_model_reviewer',
        name: 'Reviewer',
        baseModel: 'sonnet',
        instructions: 'Review the approved snapshot.',
        plugins: [],
      },
    };
    const changed = {
      ...reviewed,
      contentHash: 'changed-hash',
      agent: {
        ...reviewed.agent,
        instructions: 'Publisher changed these instructions after review.',
      },
    };
    mockGetSharedAgent.mockResolvedValue(changed);
    mockImportSharedAgent.mockImplementation((detail) =>
      Promise.resolve({
        agent: detail.agent,
        requestedId: detail.agent.id,
        finalId: detail.agent.id,
        idChanged: false,
      }),
    );

    await mockHandlers.get(IPC_CHANNELS.agentsImportShared)?.(
      {},
      { agentId, installMissing: true, reviewedAgent: reviewed },
    );

    expect(mockImportSharedAgent).toHaveBeenCalledWith(
      reviewed,
      expect.objectContaining({
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
      }),
    );
  });

  it('does not create a shared Agent when its package download fails', async () => {
    const agentId = '11111111-1111-4111-8111-111111111111';
    const digest = `pp:v1:${'A'.repeat(43)}`;
    mockGetSharedAgent.mockResolvedValue({
      id: agentId,
      contentHash: 'server-hash',
      package: {
        version: 1,
        digest,
        resources: [],
        environmentRequirements: [],
        totalFiles: 1,
        totalBytes: 10,
      },
      agent: {
        version: 1,
        id: 'agent_model_reviewer',
        name: 'Reviewer',
        baseModel: 'sonnet',
        instructions: 'Review.',
        plugins: [],
      },
    });
    mockGetAgentPackage.mockRejectedValue(new Error('package unavailable'));

    await expect(
      mockHandlers.get(IPC_CHANNELS.agentsImportShared)?.(
        {},
        { agentId, installMissing: true },
      ),
    ).rejects.toThrow('package unavailable');

    expect(mockImportSharedAgent).not.toHaveBeenCalled();
  });

  it('removes a newly imported shared Agent when final package provenance fails', async () => {
    const agentId = '11111111-1111-4111-8111-111111111111';
    const digest = `pp:v1:${'A'.repeat(43)}`;
    const detail = {
      id: agentId,
      contentHash: 'server-hash',
      package: {
        version: 1,
        digest,
        resources: [],
        environmentRequirements: [],
        totalFiles: 1,
        totalBytes: 10,
      },
      agent: {
        version: 1 as const,
        id: 'agent_model_reviewer',
        name: 'Reviewer',
        baseModel: 'sonnet',
        instructions: 'Review.',
        plugins: [],
      },
    };
    const importedAgent = {
      ...detail.agent,
      contentHash: 'base-local-hash',
      pluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    };
    mockGetSharedAgent.mockResolvedValue(detail);
    mockGetAgentPackage.mockResolvedValue({ digest, manifest: {} });
    mockImportSharedAgent.mockResolvedValue({
      agent: importedAgent,
      requestedId: detail.agent.id,
      finalId: detail.agent.id,
      idChanged: false,
    });
    mockSaveAgentModel.mockImplementation((request: unknown) =>
      Promise.resolve({
        ...(request as Record<string, unknown>),
        contentHash: 'final-local-hash',
      }),
    );
    mockInstallSubjectCapabilityPackage.mockImplementation(async (request) => {
      const installed: InstallSubjectCapabilityPackageResult = {
        supportingFileCount: 0,
        installedSkills: [{ name: 'helper', localName: 'helper' }],
        uninstalledResourceLabels: [],
        keptLocalFiles: [],
      };
      if (!request.finalizeInstall || !request.rollbackFinalization) {
        throw new Error('missing install transaction callbacks');
      }
      await request.finalizeInstall(installed);
      await request.rollbackFinalization();
      throw new Error('ledger read-only');
    });

    await expect(
      mockHandlers.get(IPC_CHANNELS.agentsImportShared)?.(
        {},
        { agentId, installMissing: true },
      ),
    ).rejects.toThrow('ledger read-only');

    expect(mockDeleteAgentModel).toHaveBeenCalledWith(
      detail.agent.id,
      undefined,
      'final-local-hash',
    );
  });

  it('restores locally configured MCP requirements while importing a shared Agent package', async () => {
    const agentId = '11111111-1111-4111-8111-111111111111';
    const digest = `pp:v1:${'A'.repeat(43)}`;
    const detail = {
      id: agentId,
      contentHash: 'server-hash',
      package: {
        version: 1,
        digest,
        resources: [],
        environmentRequirements: [
          {
            id: 'mcp:slack',
            kind: 'mcp',
            displayName: 'slack',
            required: true,
            affectedSteps: [],
            setupHint: 'Connect Slack in Settings.',
          },
        ],
        totalFiles: 0,
        totalBytes: 0,
      },
      agent: {
        version: 1,
        id: 'agent_model_reviewer',
        name: 'Reviewer',
        baseModel: 'sonnet',
        instructions: 'Review.',
        plugins: [],
      },
    };
    const importedAgent = {
      ...detail.agent,
      pluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
      },
      contentHash: 'local-hash',
    };
    mockGetSharedAgent.mockResolvedValue(detail);
    mockGetMcpServerStatusByCatalogId.mockResolvedValue({
      serverId: 'slack-local',
      connectionStatus: 'connected',
      configs: [{ configId: 'work' }],
    });
    mockImportSharedAgent.mockImplementation(
      (_detail: unknown, pluginSelections: ChatTabPluginSelections) =>
        Promise.resolve({
          agent: { ...importedAgent, pluginSelections },
          requestedId: detail.agent.id,
          finalId: detail.agent.id,
          idChanged: false,
        }),
    );
    mockGetAgentPackage.mockResolvedValue({ digest, manifest: {} });
    mockInstallSubjectCapabilityPackage.mockResolvedValue({
      installedSkills: [],
    });
    mockSaveAgentModel.mockImplementation((request: unknown) =>
      Promise.resolve(request),
    );

    await mockHandlers.get(IPC_CHANNELS.agentsImportShared)?.(
      {},
      { agentId, installMissing: true },
    );

    expect(mockImportSharedAgent).toHaveBeenCalledWith(
      detail,
      expect.objectContaining({
        mcpServerRefs: [{ serverId: 'slack-local', configId: 'work' }],
      }),
    );
  });

  it('validates and imports a public Agent without assigning remote metadata', async () => {
    const document = {
      version: 1,
      id: 'agent_model_reviewer',
      name: 'Reviewer',
      baseModel: 'sonnet',
      instructions: 'Review.',
      plugins: [],
    };
    const imported = { id: document.id, name: document.name };
    const provenance = {
      externalId: '11111111-1111-4111-8111-111111111111',
      contentHash: 'public-hash',
    };
    mockImportPublicAgent.mockResolvedValue(imported);
    const handler = mockHandlers.get(IPC_CHANNELS.agentsImportPublic);
    await expect(
      handler?.({}, { agent: document, ...provenance }),
    ).resolves.toBe(imported);
    expect(mockImportPublicAgent).toHaveBeenCalledWith(
      document,
      expect.objectContaining({
        collectionIds: [],
        pluginRefs: [],
        skillRefs: [],
      }),
      provenance.externalId,
      provenance.contentHash,
    );
    expect(mockWriteAgentRemoteMetadata).not.toHaveBeenCalled();
  });

  it('installs missing public Agent refs before resolving and importing them', async () => {
    const plugin = {
      type: 'claude_plugin' as const,
      marketplace: { type: 'github' as const, repo: 'acme/tools' },
      plugin_name: 'reviewer',
    };
    const document = {
      version: 1 as const,
      id: 'agent_model_reviewer',
      name: 'Reviewer',
      baseModel: 'sonnet',
      instructions: 'Review.',
      plugins: [plugin],
    };
    const imported = {
      id: document.id,
      name: document.name,
      pluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [
          { marketplaceId: 'github:acme:tools', pluginName: 'reviewer' },
        ],
      },
    };
    mockPrepareDesktopWorkspaceTemplateRefs.mockResolvedValue(undefined);
    mockResolveShareablePluginRefs.mockReturnValue([
      {
        ref: plugin,
        matchState: 'matched',
        catalogKey: 'plugin:github:acme:tools:reviewer',
        selection: {
          kind: 'plugin',
          marketplaceId: 'github:acme:tools',
          pluginName: 'reviewer',
        },
      },
    ]);
    mockImportPublicAgent.mockResolvedValue(imported);

    await expect(
      mockHandlers.get(IPC_CHANNELS.agentsImportPublic)?.(
        {},
        {
          agent: document,
          externalId: '11111111-1111-4111-8111-111111111111',
          contentHash: 'public-hash',
          installMissing: true,
        },
      ),
    ).resolves.toBe(imported);

    expect(mockPrepareDesktopWorkspaceTemplateRefs).toHaveBeenCalledWith([
      plugin,
    ]);
    expect(mockImportPublicAgent).toHaveBeenCalledWith(
      document,
      expect.objectContaining({
        pluginRefs: [
          { marketplaceId: 'github:acme:tools', pluginName: 'reviewer' },
        ],
      }),
      '11111111-1111-4111-8111-111111111111',
      'public-hash',
    );
  });

  it('imports a public Agent that inherits the default model with its plugins', async () => {
    const plugin = {
      type: 'claude_plugin' as const,
      marketplace: { type: 'github' as const, repo: 'acme/tools' },
      plugin_name: 'reviewer',
    };
    const document = {
      version: 1 as const,
      id: 'agent_model_reviewer',
      name: 'Reviewer',
      baseModel: 'default',
      instructions: 'Review.',
      plugins: [plugin],
    };
    mockResolveShareablePluginRefs.mockReturnValue([
      {
        ref: plugin,
        matchState: 'matched',
        catalogKey: 'plugin:github:acme:tools:reviewer',
        selection: {
          kind: 'plugin',
          marketplaceId: 'github:acme:tools',
          pluginName: 'reviewer',
        },
      },
    ]);
    mockImportPublicAgent.mockResolvedValue({ id: document.id });

    await mockHandlers.get(IPC_CHANNELS.agentsImportPublic)?.(
      {},
      {
        agent: document,
        externalId: '11111111-1111-4111-8111-111111111111',
        contentHash: 'public-hash',
      },
    );

    // No provider exists until a chat resolves the default.
    expect(mockResolveShareablePluginRefs).toHaveBeenLastCalledWith(
      [plugin],
      undefined,
      {},
    );
    expect(mockImportPublicAgent).toHaveBeenCalledWith(
      document,
      expect.objectContaining({
        pluginRefs: [
          { marketplaceId: 'github:acme:tools', pluginName: 'reviewer' },
        ],
      }),
      '11111111-1111-4111-8111-111111111111',
      'public-hash',
    );
  });

  it('restores locally configured MCP requirements while importing a public Agent package', async () => {
    const digest = `pp:v1:${'A'.repeat(43)}`;
    const document = {
      version: 1 as const,
      id: 'agent_model_reviewer',
      name: 'Reviewer',
      baseModel: 'sonnet',
      instructions: 'Review.',
      plugins: [],
    };
    const packageSummary = {
      version: 1 as const,
      digest,
      resources: [],
      environmentRequirements: [
        {
          id: 'mcp:slack',
          kind: 'mcp' as const,
          displayName: 'slack',
          required: true,
          affectedSteps: [],
          setupHint: 'Connect Slack in Settings.',
        },
      ],
      totalFiles: 0,
      totalBytes: 0,
    };
    mockGetMcpServerStatusByCatalogId.mockResolvedValue({
      serverId: 'slack-local',
      connectionStatus: 'connected',
      configs: [{ configId: 'work' }],
    });
    mockImportPublicAgent.mockImplementation((_agent, pluginSelections) =>
      Promise.resolve({
        ...document,
        contentHash: 'local-hash',
        pluginSelections,
      }),
    );
    mockGetPublicAgentPackage.mockResolvedValue({
      digest,
      manifest: { pipelineContentHash: 'package-content-hash' },
    });
    mockInstallSubjectCapabilityPackage.mockImplementation(async (request) => {
      const installed: InstallSubjectCapabilityPackageResult = {
        supportingFileCount: 0,
        installedSkills: [],
        uninstalledResourceLabels: [],
        keptLocalFiles: [],
      };
      if (!request.finalizeInstall) throw new Error('missing finalizer');
      const localContentHash = await request.finalizeInstall(installed);
      expect(localContentHash).toBe('final-local-hash');
      return installed;
    });
    mockSaveAgentModel.mockImplementation((request: unknown) =>
      Promise.resolve({
        ...(request as Record<string, unknown>),
        contentHash: 'final-local-hash',
      }),
    );

    await mockHandlers.get(IPC_CHANNELS.agentsImportPublic)?.(
      {},
      {
        agent: document,
        externalId: '11111111-1111-4111-8111-111111111111',
        contentHash: 'public-hash',
        package: packageSummary,
        installMissing: true,
      },
    );

    expect(mockImportPublicAgent).toHaveBeenCalledWith(
      document,
      expect.objectContaining({
        mcpServerRefs: [{ serverId: 'slack-local', configId: 'work' }],
      }),
      '11111111-1111-4111-8111-111111111111',
      'public-hash',
    );
    const installRequest =
      mockInstallSubjectCapabilityPackage.mock.calls[0]?.[0];
    expect(typeof installRequest?.finalizeInstall).toBe('function');
    expect(typeof installRequest?.rollbackFinalization).toBe('function');
    expect(mockUpsertCapabilityPackageInstall).not.toHaveBeenCalled();
  });

  it('does not import a public Agent when its package download fails', async () => {
    const digest = `pp:v1:${'A'.repeat(43)}`;
    const document = {
      version: 1 as const,
      id: 'agent_model_reviewer',
      name: 'Reviewer',
      baseModel: 'sonnet',
      instructions: 'Review.',
      plugins: [],
    };
    mockGetPublicAgentPackage.mockRejectedValue(new Error('package offline'));

    await expect(
      mockHandlers.get(IPC_CHANNELS.agentsImportPublic)?.(
        {},
        {
          agent: document,
          externalId: '11111111-1111-4111-8111-111111111111',
          contentHash: 'public-hash',
          package: {
            version: 1,
            digest,
            resources: [],
            environmentRequirements: [],
            totalFiles: 0,
            totalBytes: 0,
          },
          installMissing: true,
        },
      ),
    ).rejects.toThrow('package offline');

    expect(mockImportPublicAgent).not.toHaveBeenCalled();
    expect(mockInstallSubjectCapabilityPackage).not.toHaveBeenCalled();
  });

  it('removes a newly imported Agent when final package provenance fails', async () => {
    const digest = `pp:v1:${'A'.repeat(43)}`;
    const document = {
      version: 1 as const,
      id: 'agent_model_reviewer',
      name: 'Reviewer',
      baseModel: 'sonnet',
      instructions: 'Review.',
      plugins: [],
    };
    const imported = {
      ...document,
      contentHash: 'base-local-hash',
      pluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    };
    mockFindInstalledPublicAgent.mockResolvedValue(null);
    mockImportPublicAgent.mockResolvedValue(imported);
    mockGetPublicAgentPackage.mockResolvedValue({
      digest,
      manifest: { pipelineContentHash: 'package-content-hash' },
    });
    mockSaveAgentModel.mockImplementation((request: unknown) =>
      Promise.resolve({
        ...(request as Record<string, unknown>),
        contentHash: 'final-local-hash',
      }),
    );
    mockInstallSubjectCapabilityPackage.mockImplementation(async (request) => {
      const installed: InstallSubjectCapabilityPackageResult = {
        supportingFileCount: 0,
        installedSkills: [{ name: 'helper', localName: 'helper' }],
        uninstalledResourceLabels: [],
        keptLocalFiles: [],
      };
      if (!request.finalizeInstall || !request.rollbackFinalization) {
        throw new Error('missing install transaction callbacks');
      }
      await request.finalizeInstall(installed);
      await request.rollbackFinalization();
      throw new Error('ledger read-only');
    });

    await expect(
      mockHandlers.get(IPC_CHANNELS.agentsImportPublic)?.(
        {},
        {
          agent: document,
          externalId: '11111111-1111-4111-8111-111111111111',
          contentHash: 'public-hash',
          package: {
            version: 1,
            digest,
            resources: [],
            environmentRequirements: [],
            totalFiles: 0,
            totalBytes: 0,
          },
          installMissing: true,
        },
      ),
    ).rejects.toThrow('ledger read-only');

    expect(mockDeleteAgentModel).toHaveBeenCalledWith(
      document.id,
      undefined,
      'final-local-hash',
    );
  });

  it('rejects a public Agent import when requested portable refs remain unavailable', async () => {
    const skill = {
      type: 'skill' as const,
      source: { type: 'github' as const, repo: 'acme/tools' },
      skill_name: 'reviewer',
    };
    const document = {
      version: 1 as const,
      id: 'agent_model_reviewer',
      name: 'Reviewer',
      baseModel: 'sonnet',
      instructions: 'Review.',
      plugins: [skill],
    };
    mockPrepareDesktopWorkspaceTemplateRefs.mockResolvedValue(undefined);
    mockResolveShareablePluginRefs.mockReturnValue([
      {
        ref: skill,
        matchState: 'unmatched',
        displayName: 'reviewer',
      },
    ]);

    await expect(
      mockHandlers.get(IPC_CHANNELS.agentsImportPublic)?.(
        {},
        {
          agent: document,
          externalId: '11111111-1111-4111-8111-111111111111',
          contentHash: 'public-hash',
          installMissing: true,
        },
      ),
    ).rejects.toThrow('unavailable skill');
    expect(mockImportPublicAgent).not.toHaveBeenCalled();
  });

  it('detects and safely uninstalls public Agents through validated provenance', async () => {
    const document = {
      version: 1,
      id: 'agent_model_reviewer',
      name: 'Reviewer',
      baseModel: 'sonnet',
      instructions: 'Review.',
      plugins: [],
    };
    const provenance = {
      externalId: '11111111-1111-4111-8111-111111111111',
      contentHash: 'public-hash',
    };
    const installed = { id: document.id, name: document.name };
    mockFindInstalledPublicAgent.mockResolvedValue(installed);
    await expect(
      mockHandlers.get(IPC_CHANNELS.agentsDetectPublic)?.(
        {},
        { agent: document, ...provenance },
      ),
    ).resolves.toBe(installed);
    expect(mockFindInstalledPublicAgent).toHaveBeenCalledWith(
      document,
      expect.objectContaining({ collectionIds: [] }),
      provenance.externalId,
      provenance.contentHash,
    );

    mockUninstallPublicAgent.mockResolvedValue(true);
    await expect(
      mockHandlers.get(IPC_CHANNELS.agentsUninstallPublic)?.(
        {},
        { agentId: document.id, ...provenance },
      ),
    ).resolves.toBeUndefined();
    expect(mockUninstallPublicAgent).toHaveBeenCalledWith(
      document.id,
      provenance.externalId,
      provenance.contentHash,
    );
    expect(mockRefreshAgentModelsFromStore).toHaveBeenCalledTimes(1);
  });

  it('recognizes a packaged public Agent after package skills change its selections', async () => {
    const digest = `pp:v1:${'A'.repeat(43)}`;
    const document = {
      version: 1 as const,
      id: 'agent_model_reviewer',
      name: 'Reviewer',
      baseModel: 'sonnet',
      instructions: 'Review.',
      plugins: [],
    };
    const installed = {
      id: document.id,
      name: document.name,
      baseModel: document.baseModel,
      instructions: document.instructions,
      contentHash: 'installed-local-hash',
      pluginSelections: {
        collectionIds: [],
        skillRefs: [{ sourceId: 'custom:app', skillName: 'helper-2' }],
        pluginRefs: [],
      },
      publicShareExternalId: '11111111-1111-4111-8111-111111111111',
      publicShareContentHash: 'public-hash',
    };
    mockFindInstalledPublicAgent
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(installed);
    mockListAgentModels.mockResolvedValue([installed]);
    mockFindCapabilityPackageInstallByOwner.mockResolvedValue({
      owner: { kind: 'agent', localId: document.id },
      originExternalId: installed.publicShareExternalId,
      localContentHash: 'installed-local-hash',
      pipelineContentHash: 'package-content-hash',
      packageDigest: digest,
      installedAt: '2026-09-23T00:00:00.000Z',
    });

    await expect(
      mockHandlers.get(IPC_CHANNELS.agentsDetectPublic)?.(
        {},
        {
          agent: document,
          externalId: installed.publicShareExternalId,
          contentHash: installed.publicShareContentHash,
          package: {
            version: 1,
            digest,
            resources: [],
            environmentRequirements: [],
            totalFiles: 1,
            totalBytes: 10,
          },
        },
      ),
    ).resolves.toBe(installed);
    expect(mockFindCapabilityPackageInstallByOwner).toHaveBeenCalledWith(
      '/tmp/installs.json',
      { kind: 'agent', localId: document.id },
    );
  });

  it('reuses an installed packaged public Agent instead of importing a duplicate', async () => {
    const digest = `pp:v1:${'A'.repeat(43)}`;
    const document = {
      version: 1 as const,
      id: 'agent_model_reviewer',
      name: 'Reviewer',
      baseModel: 'sonnet',
      instructions: 'Review.',
      plugins: [],
    };
    const installed = {
      id: document.id,
      name: document.name,
      baseModel: document.baseModel,
      instructions: document.instructions,
      contentHash: 'installed-local-hash',
      pluginSelections: {
        collectionIds: [],
        skillRefs: [{ sourceId: 'custom:app', skillName: 'helper-2' }],
        pluginRefs: [],
      },
      publicShareExternalId: '11111111-1111-4111-8111-111111111111',
      publicShareContentHash: 'public-hash',
    };
    mockFindInstalledPublicAgent
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(installed);
    mockListAgentModels.mockResolvedValue([installed]);
    mockFindCapabilityPackageInstallByOwner.mockResolvedValue({
      owner: { kind: 'agent', localId: document.id },
      originExternalId: installed.publicShareExternalId,
      localContentHash: installed.contentHash,
      pipelineContentHash: 'package-content-hash',
      packageDigest: digest,
      installedAt: '2026-09-23T00:00:00.000Z',
    });

    await expect(
      mockHandlers.get(IPC_CHANNELS.agentsImportPublic)?.(
        {},
        {
          agent: document,
          externalId: installed.publicShareExternalId,
          contentHash: installed.publicShareContentHash,
          package: {
            version: 1,
            digest,
            resources: [],
            environmentRequirements: [],
            totalFiles: 1,
            totalBytes: 10,
          },
          installMissing: true,
        },
      ),
    ).resolves.toBe(installed);

    expect(mockGetPublicAgentPackage).not.toHaveBeenCalled();
    expect(mockImportPublicAgent).not.toHaveBeenCalled();
    expect(mockInstallSubjectCapabilityPackage).not.toHaveBeenCalled();
  });

  it('does not recognize a packaged public Agent after its local selections change', async () => {
    const digest = `pp:v1:${'A'.repeat(43)}`;
    const document = {
      version: 1 as const,
      id: 'agent_model_reviewer',
      name: 'Reviewer',
      baseModel: 'sonnet',
      instructions: 'Review.',
      plugins: [],
    };
    const edited = {
      id: document.id,
      name: document.name,
      baseModel: document.baseModel,
      instructions: document.instructions,
      contentHash: 'edited-local-hash',
      pluginSelections: {
        collectionIds: [],
        skillRefs: [{ sourceId: 'custom:app', skillName: 'recipient-edit' }],
        pluginRefs: [],
      },
      publicShareExternalId: '11111111-1111-4111-8111-111111111111',
      publicShareContentHash: 'public-hash',
    };
    mockFindInstalledPublicAgent
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(edited);
    mockListAgentModels.mockResolvedValue([edited]);
    mockFindCapabilityPackageInstallByOwner.mockResolvedValue({
      owner: { kind: 'agent', localId: document.id },
      originExternalId: edited.publicShareExternalId,
      localContentHash: 'installed-local-hash',
      pipelineContentHash: 'package-content-hash',
      packageDigest: digest,
      installedAt: '2026-09-23T00:00:00.000Z',
    });

    await expect(
      mockHandlers.get(IPC_CHANNELS.agentsDetectPublic)?.(
        {},
        {
          agent: document,
          externalId: edited.publicShareExternalId,
          contentHash: edited.publicShareContentHash,
          package: {
            version: 1,
            digest,
            resources: [],
            environmentRequirements: [],
            totalFiles: 1,
            totalBytes: 10,
          },
        },
      ),
    ).resolves.toBeNull();
  });

  it('probes machine-specific readiness for a public Agent package', async () => {
    const digest = `pp:v1:${'A'.repeat(43)}`;
    const request = {
      agent: {
        version: 1 as const,
        id: 'agent_model_reviewer',
        name: 'Reviewer',
        baseModel: 'sonnet',
        instructions: 'Review.',
        plugins: [],
      },
      externalId: '11111111-1111-4111-8111-111111111111',
      contentHash: 'public-hash',
      package: {
        version: 1 as const,
        digest,
        resources: [],
        environmentRequirements: [
          {
            id: 'mcp:slack',
            kind: 'mcp' as const,
            displayName: 'slack',
            required: true,
            affectedSteps: [],
            setupHint: 'Connect Slack in Settings.',
          },
        ],
        totalFiles: 0,
        totalBytes: 0,
      },
    };
    mockGetMcpServerStatusByCatalogId.mockResolvedValue({
      serverId: 'slack-local',
      connectionStatus: 'connected',
      configs: [{ configId: 'work' }],
    });

    const handler = mockHandlers.get('agents:public-import-readiness');
    expect(handler).toBeDefined();
    await expect(handler?.({}, request)).resolves.toMatchObject({
      status: 'ready',
      distributionMode: 'package',
      requirements: [
        expect.objectContaining({
          id: 'mcp:slack',
          status: 'available',
          detail: 'MCP server is connected.',
        }),
      ],
    });
  });

  it.each([
    ['has no install ledger', null],
    [
      'has a stale package digest',
      {
        owner: { kind: 'agent', localId: 'agent_model_reviewer' },
        originExternalId: '11111111-1111-4111-8111-111111111111',
        localContentHash: 'public-hash',
        pipelineContentHash: 'package-content-hash',
        packageDigest: `pp:v1:${'B'.repeat(43)}`,
        installedAt: '2026-09-23T00:00:00.000Z',
      },
    ],
  ])(
    'does not detect an exact-definition packaged Agent when it %s',
    async (_label, ledger) => {
      const digest = `pp:v1:${'A'.repeat(43)}`;
      const document = {
        version: 1 as const,
        id: 'agent_model_reviewer',
        name: 'Reviewer',
        baseModel: 'sonnet',
        instructions: 'Review.',
        plugins: [],
      };
      const installed = {
        ...document,
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
        },
        publicShareExternalId: '11111111-1111-4111-8111-111111111111',
        publicShareContentHash: 'public-hash',
      };
      mockFindInstalledPublicAgent.mockResolvedValue(installed);
      mockListAgentModels.mockResolvedValue([installed]);
      mockFindCapabilityPackageInstallByOwner.mockResolvedValue(ledger);

      await expect(
        mockHandlers.get(IPC_CHANNELS.agentsDetectPublic)?.(
          {},
          {
            agent: document,
            externalId: installed.publicShareExternalId,
            contentHash: installed.publicShareContentHash,
            package: {
              version: 1,
              digest,
              resources: [],
              environmentRequirements: [],
              totalFiles: 0,
              totalBytes: 0,
            },
          },
        ),
      ).resolves.toBeNull();
    },
  );

  it('rejects malformed public Agent IPC before store access', async () => {
    const handler = mockHandlers.get(IPC_CHANNELS.agentsImportPublic);
    await expect(handler?.({}, { agent: { name: 'bad' } })).rejects.toThrow();
    expect(mockImportPublicAgent).not.toHaveBeenCalled();
  });

  it('publishes and revokes public links through validated authenticated ids', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    mockPublishAgentPublicShare.mockResolvedValue({ externalId: 'share-id' });
    await expect(
      mockHandlers.get(IPC_CHANNELS.agentsPublicSharePublish)?.({}, id),
    ).resolves.toEqual({ externalId: 'share-id' });
    await expect(
      mockHandlers.get(IPC_CHANNELS.agentsPublicShareRevoke)?.({}, id),
    ).resolves.toBeUndefined();
    expect(mockPublishAgentPublicShare).toHaveBeenCalledWith(id);
    expect(mockRevokeAgentPublicShare).toHaveBeenCalledWith(id);
    expect(mockAssertCapability).toHaveBeenCalledTimes(2);
  });

  it('updates an existing shared agent and stores returned remote metadata', async () => {
    const detail = {
      id: 'shared-agent-id',
      contentHash: 'server-hash-next',
      createdBy: { id: 'account-a' },
      agent: { id: 'agent_model_reviewer' },
    };
    mockUpdateSharedAgent.mockResolvedValue(detail);

    const request = {
      agentId: 'shared-agent-id',
      agent: detail.agent,
      expectedContentHash: 'server-hash',
    };
    const handler = mockHandlers.get(IPC_CHANNELS.agentsSharedUpdate);
    await expect(handler?.({}, request)).resolves.toEqual({
      ok: true,
      value: detail,
    });

    expect(mockUpdateSharedAgent).toHaveBeenCalledWith(request);
    expect(mockWriteAgentRemoteMetadata).toHaveBeenCalledWith({
      id: 'agent_model_reviewer',
      remoteId: 'shared-agent-id',
      remoteAccountId: 'account-a',
      remoteContentHash: 'server-hash-next',
    });
  });

  it('clears all local remote metadata after deleting shared copies', async () => {
    mockClearAgentRemoteMetadataByRemoteId.mockResolvedValue(2);

    const handler = mockHandlers.get(IPC_CHANNELS.agentsSharedDelete);
    await expect(
      handler?.({}, { agentId: 'shared-agent-id' }),
    ).resolves.toBeUndefined();

    expect(mockDeleteSharedAgent).toHaveBeenCalledWith({
      agentId: 'shared-agent-id',
    });
    expect(mockClearAgentRemoteMetadataByRemoteId).toHaveBeenCalledWith(
      'shared-agent-id',
    );
    expect(mockRefreshAgentModelsFromStore).toHaveBeenCalledTimes(1);
    expect(mockBroadcastModelRegistryUpdated).toHaveBeenCalledTimes(1);
  });
});

describe('public Agent IPC with the persisted import fingerprint', () => {
  const store = jest.requireActual<typeof AgentModelStore>(
    '../agents/agent-model-store',
  );
  let tempDir: string;
  beforeEach(async (): Promise<void> => {
    jest.resetAllMocks();
    mockResourceContextEnabled = true;
    mockHandlers.clear();
    registerAgentModelHandlers(() => null);
    tempDir = await mkdtemp(join(tmpdir(), 'agent-public-ipc-'));
    mockAgentModelsFilePath = join(tempDir, 'agents.json');
    mockListAgentModels.mockImplementation(store.listAgentModels);
    mockFindInstalledPublicAgent.mockImplementation(
      store.findInstalledPublicAgent,
    );
    mockImportPublicAgent.mockImplementation(store.importPublicAgent);
    mockSaveAgentModel.mockImplementation(store.saveAgentModel);
    mockUninstallPublicAgent.mockImplementation(store.uninstallPublicAgent);
    mockPrepareDesktopWorkspaceTemplateRefs.mockResolvedValue({
      unresolvedRefs: [],
    });
    mockResolveShareablePluginRefs.mockReturnValue([]);
    mockGetPublicAgentPackage.mockResolvedValue({});
  });
  afterEach(async (): Promise<void> => {
    mockResourceContextEnabled = false;
    await rm(tempDir, { recursive: true, force: true });
  });
  it.each([
    { finalized: false, edited: true },
    { finalized: true, edited: true },
    { finalized: false, edited: false },
    { finalized: true, edited: false },
  ])(
    'rolls back a new public Agent without losing edits (%j)',
    async ({ finalized, edited }): Promise<void> => {
      mockDeleteAgentModel.mockImplementation(store.deleteAgentModel);
      const request: ImportPublicAgentRequest = {
        agent: {
          version: 1,
          id: 'agent_model_reviewer',
          name: 'Reviewer',
          baseModel: 'sonnet',
          instructions: 'Review.',
          plugins: [],
        },
        externalId: '11111111-1111-4111-8111-111111111111',
        contentHash: 'public-hash',
        installMissing: true,
        package: {
          version: 1,
          digest: `pp:v1:${'A'.repeat(43)}`,
          resources: [],
          environmentRequirements: [],
          totalFiles: 1,
          totalBytes: 10,
        },
      };
      mockInstallSubjectCapabilityPackage.mockImplementation(
        async (
          installRequest,
        ): Promise<InstallSubjectCapabilityPackageResult> => {
          if (
            !installRequest.finalizeInstall ||
            !installRequest.rollbackFinalization
          )
            throw new Error('missing install transaction callbacks');
          const installed: InstallSubjectCapabilityPackageResult = {
            supportingFileCount: 0,
            installedSkills: [{ name: 'helper', localName: 'helper-2' }],
            uninstalledResourceLabels: [],
            keptLocalFiles: [],
          };
          if (finalized) await installRequest.finalizeInstall(installed);
          if (edited) {
            const current = await store.getAgentModel(request.agent.id);
            if (!current) throw new Error('missing imported Agent');
            await store.saveAgentModel({
              ...current,
              instructions: 'User edit',
            });
            if (!finalized) {
              await expect(
                installRequest.finalizeInstall(installed),
              ).rejects.toThrow('locally changed');
            }
          }
          await installRequest.rollbackFinalization();
          throw new Error('package installation failed');
        },
      );
      await expect(
        mockHandlers.get(IPC_CHANNELS.agentsImportPublic)?.({}, request),
      ).rejects.toThrow('package installation failed');
      const remaining = await store.getAgentModel(request.agent.id);
      if (edited) {
        expect(remaining).toMatchObject({ instructions: 'User edit' });
        expect(remaining?.importedContentHash).toBeUndefined();
        expect(remaining?.publicShareExternalId).toBeUndefined();
        expect(remaining?.publicShareContentHash).toBeUndefined();
        await expect(
          mockHandlers.get(IPC_CHANNELS.agentsDetectPublic)?.({}, request),
        ).resolves.toBeNull();
      } else {
        expect(remaining).toBeNull();
      }
    },
  );
  it.each([false, true])(
    'redetects an explicit public install and protects subsequent edits (package=%s)',
    async (packaged): Promise<void> => {
      const request: ImportPublicAgentRequest = {
        agent: {
          version: 1,
          id: 'agent_model_reviewer',
          name: 'Reviewer',
          baseModel: 'sonnet',
          instructions: 'Review.',
          plugins: [],
        },
        externalId: '11111111-1111-4111-8111-111111111111',
        contentHash: 'public-hash',
        installMissing: true,
        ...(packaged
          ? {
              package: {
                version: 1,
                digest: `pp:v1:${'A'.repeat(43)}`,
                resources: [],
                environmentRequirements: [],
                totalFiles: 1,
                totalBytes: 10,
              },
            }
          : {}),
      };
      mockInstallSubjectCapabilityPackage.mockImplementation(
        async (
          installRequest,
        ): Promise<InstallSubjectCapabilityPackageResult> => {
          const installed: InstallSubjectCapabilityPackageResult = {
            supportingFileCount: 0,
            installedSkills: [{ name: 'helper', localName: 'helper-2' }],
            uninstalledResourceLabels: [],
            keptLocalFiles: [],
          };
          if (!installRequest.finalizeInstall)
            throw new Error('missing finalizer');
          const localContentHash =
            await installRequest.finalizeInstall(installed);
          mockFindCapabilityPackageInstallByOwner.mockResolvedValue({
            owner: installRequest.owner,
            originExternalId: request.externalId,
            packageDigest: request.package?.digest,
            localContentHash,
          });
          return installed;
        },
      );
      await mockHandlers.get(IPC_CHANNELS.agentsImportPublic)?.({}, request);
      const imported = await store.getAgentModel(request.agent.id);
      expect(imported).not.toBeNull();
      await expect(
        mockHandlers.get(IPC_CHANNELS.agentsDetectPublic)?.({}, request),
      ).resolves.toEqual(imported);
      if (!imported) throw new Error('missing imported Agent');
      expect(imported.importedContentHash).toBe(imported.contentHash);
      await store.saveAgentModel({
        ...imported,
        instructions: 'Locally edited',
      });
      await expect(
        mockHandlers.get(IPC_CHANNELS.agentsDetectPublic)?.({}, request),
      ).resolves.toBeNull();
      await expect(
        store.uninstallPublicAgent(
          imported.id,
          request.externalId,
          request.contentHash,
        ),
      ).rejects.toThrow('locally changed');
    },
  );
});
