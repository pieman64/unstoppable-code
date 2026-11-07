import type { IpcRendererEvent } from 'electron';
import type { ShareOperationResult } from '@canopy/protocol/sharing';
import { ipcRenderer } from '../ipc-router';
import { SKILLS_CHANNELS } from '@canopy/desktop-shared/constants/skill-channels';
import type {
  PipelinePackageAnalysisSummary,
  PipelinePackageReadiness,
} from '@canopy/desktop-shared/types/pipeline';
import type {
  AnalyzeSkillCapabilityPackageRequest,
  CommitSkillCapabilityPackageRequest,
  CommitSkillCapabilityPackageResponse,
  CreateSharedSkillRequest,
  InstallSkillCapabilityPackageRequest,
  InstallSkillCapabilityPackageResult,
  SkillDependencyReadinessRequest,
  DeleteSharedSkillRequest,
  ListSharedSkillsRequest,
  ListSharedSkillsResponse,
  SaveCustomSkillRequest,
  RecordSkillShareOriginRequest,
  SharedSkillDetail,
  SharedSkillPublicShareInfo,
  SkillUpdateProgress,
  SkillsAPI,
  UpdateSharedSkillRequest,
  WriteRawSkillRequest,
  WriteRawSkillResult,
  DesktopSharedSkillDetail,
} from '@canopy/desktop-shared/types/skills';

export type { SkillsAPI };

export function createSkillsAPI(): SkillsAPI {
  return {
    listMarketplace: () => ipcRenderer.invoke(SKILLS_CHANNELS.MARKETPLACE_LIST),
    loadSkills: () => ipcRenderer.invoke(SKILLS_CHANNELS.LOAD),
    fetchAvailable: (source: string) =>
      ipcRenderer.invoke(SKILLS_CHANNELS.FETCH_AVAILABLE, source),
    installSkills: (source: string, skillNames: string[]) =>
      ipcRenderer.invoke(SKILLS_CHANNELS.INSTALL, source, skillNames),
    removeSkill: (sourceId: string, skillName: string) =>
      ipcRenderer.invoke(SKILLS_CHANNELS.REMOVE, sourceId, skillName),
    updateSkill: (sourceId: string, skillName: string) =>
      ipcRenderer.invoke(SKILLS_CHANNELS.UPDATE, sourceId, skillName),
    checkUpdates: () => ipcRenderer.invoke(SKILLS_CHANNELS.CHECK_UPDATES),
    onUpdateProgress: (callback): (() => void) => {
      const handler = (_event: IpcRendererEvent, payload: unknown): void => {
        callback(payload as SkillUpdateProgress);
      };
      ipcRenderer.on(SKILLS_CHANNELS.UPDATE_PROGRESS, handler);
      return () => {
        ipcRenderer.removeListener(SKILLS_CHANNELS.UPDATE_PROGRESS, handler);
      };
    },
    onChanged: (callback): (() => void) => {
      const handler = (): void => callback();
      ipcRenderer.on(SKILLS_CHANNELS.CHANGED, handler);
      return () => {
        ipcRenderer.removeListener(SKILLS_CHANNELS.CHANGED, handler);
      };
    },
    readContent: (sourceId: string, skillName: string) =>
      ipcRenderer.invoke(SKILLS_CHANNELS.READ_CONTENT, sourceId, skillName),
    listFiles: (sourceId: string, skillName: string) =>
      ipcRenderer.invoke(SKILLS_CHANNELS.LIST_FILES, sourceId, skillName),
    readFile: (sourceId: string, skillName: string, filePath: string) =>
      ipcRenderer.invoke(
        SKILLS_CHANNELS.READ_FILE,
        sourceId,
        skillName,
        filePath,
      ),
    saveCustomSkill: (payload: SaveCustomSkillRequest) =>
      ipcRenderer.invoke(SKILLS_CHANNELS.SAVE_CUSTOM, payload),

    // ---- Raw SKILL.md helpers ---------------------------------------------
    readRawSkill: (skillId: string): Promise<string> =>
      ipcRenderer.invoke(SKILLS_CHANNELS.READ_RAW, skillId),
    writeRawSkill: (
      input: WriteRawSkillRequest,
    ): Promise<WriteRawSkillResult> =>
      ipcRenderer.invoke(SKILLS_CHANNELS.WRITE_RAW, input),

    // ---- Shared (Canopy Cloud) CRUD ---------------------------------------
    listShared: (
      request: ListSharedSkillsRequest,
    ): Promise<ListSharedSkillsResponse> =>
      ipcRenderer.invoke(SKILLS_CHANNELS.SHARED_LIST, request),
    getShared: (skillId: string): Promise<DesktopSharedSkillDetail> =>
      ipcRenderer.invoke(SKILLS_CHANNELS.SHARED_GET, skillId),
    createShared: (
      request: CreateSharedSkillRequest,
    ): Promise<ShareOperationResult<SharedSkillDetail>> =>
      ipcRenderer.invoke(SKILLS_CHANNELS.SHARED_CREATE, request),
    updateShared: (
      request: UpdateSharedSkillRequest,
    ): Promise<ShareOperationResult<SharedSkillDetail>> =>
      ipcRenderer.invoke(SKILLS_CHANNELS.SHARED_UPDATE, request),
    deleteShared: (request: DeleteSharedSkillRequest): Promise<void> =>
      ipcRenderer.invoke(SKILLS_CHANNELS.SHARED_DELETE, request),
    publishPublicShare: (
      skillId: string,
    ): Promise<SharedSkillPublicShareInfo> =>
      ipcRenderer.invoke(SKILLS_CHANNELS.SHARED_PUBLISH_PUBLIC, skillId),
    revokePublicShare: (skillId: string): Promise<void> =>
      ipcRenderer.invoke(SKILLS_CHANNELS.SHARED_REVOKE_PUBLIC, skillId),

    // ---- Capability package -----------------------------------------------
    analyzeCapabilityPackage: (
      request: AnalyzeSkillCapabilityPackageRequest,
    ): Promise<PipelinePackageAnalysisSummary> =>
      ipcRenderer.invoke(SKILLS_CHANNELS.PACKAGE_ANALYZE, request),
    cancelCapabilityPackageAnalysis: (analysisId: string): Promise<void> =>
      ipcRenderer.invoke(SKILLS_CHANNELS.PACKAGE_CANCEL_ANALYSIS, analysisId),
    commitCapabilityPackage: (
      request: CommitSkillCapabilityPackageRequest,
    ): Promise<ShareOperationResult<CommitSkillCapabilityPackageResponse>> =>
      ipcRenderer.invoke(SKILLS_CHANNELS.PACKAGE_COMMIT, request),
    installCapabilityPackage: (
      request: InstallSkillCapabilityPackageRequest,
    ): Promise<InstallSkillCapabilityPackageResult> =>
      ipcRenderer.invoke(SKILLS_CHANNELS.PACKAGE_INSTALL, request),
    getDependencyReadiness: (
      request: SkillDependencyReadinessRequest,
    ): Promise<PipelinePackageReadiness> =>
      ipcRenderer.invoke(SKILLS_CHANNELS.DEPENDENCY_READINESS, request),
    recordShareOrigin: (
      request: RecordSkillShareOriginRequest,
    ): Promise<void> =>
      ipcRenderer.invoke(SKILLS_CHANNELS.RECORD_SHARE_ORIGIN, request),
  };
}
