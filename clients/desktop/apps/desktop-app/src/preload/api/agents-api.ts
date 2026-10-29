import type { ShareOperationResult } from '@canopy/protocol/sharing';
import { ipcRenderer } from '../ipc-router';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type {
  AgentModelDefinition,
  AnalyzeAgentCapabilityPackageRequest,
  CommitAgentCapabilityPackageRequest,
  CommitAgentCapabilityPackageResponse,
  AgentModelsAPI,
  CreateSharedAgentRequest,
  DeleteAgentModelRequest,
  DeleteSharedAgentRequest,
  DetectPublicAgentRequest,
  ImportSharedAgentRequest,
  ImportSharedAgentResponse,
  ImportPublicAgentRequest,
  UninstallPublicAgentRequest,
  ListAgentModelsResponse,
  ListSharedAgentsRequest,
  ListSharedAgentsResponse,
  SaveAgentModelRequest,
  SharedAgentDetail,
  SharedAgentPublicShareInfo,
  SharedAgentImportReadiness,
  UpdateSharedAgentRequest,
} from '@canopy/desktop-shared/types/agent-models';
import type { PipelinePackageAnalysisSummary } from '@canopy/desktop-shared/types/pipeline';
import type { PipelinePackageReadiness } from '@canopy/desktop-shared/types/pipeline';

export type { AgentModelsAPI };

export function createAgentsAPI(): AgentModelsAPI {
  return {
    // ---- Local Agent model CRUD -------------------------------------------
    list: (): Promise<ListAgentModelsResponse> =>
      ipcRenderer.invoke(IPC_CHANNELS.agentsList),
    get: (id: string): Promise<AgentModelDefinition | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.agentsGet, id),
    save: (request: SaveAgentModelRequest): Promise<AgentModelDefinition> =>
      ipcRenderer.invoke(IPC_CHANNELS.agentsSave, request),
    delete: (request: DeleteAgentModelRequest): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.agentsDelete, request),
    importShared: (
      request: ImportSharedAgentRequest,
    ): Promise<ImportSharedAgentResponse> =>
      ipcRenderer.invoke(IPC_CHANNELS.agentsImportShared, request),
    inspectImport: (agentId: string): Promise<SharedAgentImportReadiness> =>
      ipcRenderer.invoke(IPC_CHANNELS.agentsImportReadiness, agentId),
    analyzeCapabilityPackage: (
      request: AnalyzeAgentCapabilityPackageRequest,
    ): Promise<PipelinePackageAnalysisSummary> =>
      ipcRenderer.invoke(IPC_CHANNELS.agentsPackageAnalyze, request),
    cancelCapabilityPackageAnalysis: (analysisId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.agentsPackageCancelAnalysis, analysisId),
    commitCapabilityPackage: (
      request: CommitAgentCapabilityPackageRequest,
    ): Promise<ShareOperationResult<CommitAgentCapabilityPackageResponse>> =>
      ipcRenderer.invoke(IPC_CHANNELS.agentsPackageCommit, request),
    detectPublic: (request: DetectPublicAgentRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.agentsDetectPublic, request),
    inspectPublic: (
      request: DetectPublicAgentRequest,
    ): Promise<PipelinePackageReadiness> =>
      ipcRenderer.invoke(IPC_CHANNELS.agentsPublicImportReadiness, request),
    importPublic: (request: ImportPublicAgentRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.agentsImportPublic, request),
    uninstallPublic: (request: UninstallPublicAgentRequest): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.agentsUninstallPublic, request),

    // ---- Shared (Canopy Cloud) Agent CRUD ---------------------------------
    listShared: (
      request: ListSharedAgentsRequest,
    ): Promise<ListSharedAgentsResponse> =>
      ipcRenderer.invoke(IPC_CHANNELS.agentsSharedList, request),
    getShared: (agentId: string): Promise<SharedAgentDetail> =>
      ipcRenderer.invoke(IPC_CHANNELS.agentsSharedGet, agentId),
    createShared: (
      request: CreateSharedAgentRequest,
    ): Promise<ShareOperationResult<SharedAgentDetail>> =>
      ipcRenderer.invoke(IPC_CHANNELS.agentsSharedCreate, request),
    updateShared: (
      request: UpdateSharedAgentRequest,
    ): Promise<ShareOperationResult<SharedAgentDetail>> =>
      ipcRenderer.invoke(IPC_CHANNELS.agentsSharedUpdate, request),
    deleteShared: (request: DeleteSharedAgentRequest): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.agentsSharedDelete, request),
    publishPublicShare: (
      agentId: string,
    ): Promise<SharedAgentPublicShareInfo> =>
      ipcRenderer.invoke(IPC_CHANNELS.agentsPublicSharePublish, agentId),
    revokePublicShare: (agentId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.agentsPublicShareRevoke, agentId),

    // ---- Local registry change notifications ------------------------------
    onChanged: (callback: () => void): (() => void) => {
      const handler = (): void => {
        callback();
      };
      ipcRenderer.on(IPC_CHANNELS.agentsChanged, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.agentsChanged, handler);
      };
    },
  };
}
