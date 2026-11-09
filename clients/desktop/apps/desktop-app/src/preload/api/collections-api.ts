import type { ShareOperationResult } from '@canopy/protocol/sharing';
import { ipcRenderer } from '../ipc-router';
import { COLLECTIONS_CHANNELS } from '@canopy/desktop-shared/constants/collection-channels';
import type {
  CollectionConfig,
  AnalyzeCollectionCapabilityPackageRequest,
  CommitCollectionCapabilityPackageRequest,
  CollectionIndexEntry,
  CollectionsAPI,
  CreateSharedCollectionRequest,
  DeleteSharedCollectionRequest,
  InstallCollectionCapabilityPackageRequest,
  InstallCollectionCapabilityPackageResult,
  ListSharedCollectionsRequest,
  ListSharedCollectionsResponse,
  SharedCollectionDetail,
  SharedCollectionImportReadiness,
  UpdateSharedCollectionRequest,
} from '@canopy/desktop-shared/types/collections';
import type { PipelinePackageAnalysisSummary } from '@canopy/execution-engine/types/pipeline';
import type { PipelinePackageRef } from '@canopy/protocol/pipelines';

export type { CollectionsAPI };

/**
 * Renderer-side preload bridge for the Collections surface. Each method
 * forwards through the matching IPC channel; argument shapes match the
 * `CollectionsAPI` contract in `@canopy/desktop-shared/types/collections`.
 *
 * Errors raised on the main side propagate back as rejected promises so
 * renderer callers can `try/catch` them.
 */
export function createCollectionsAPI(): CollectionsAPI {
  return {
    // ---- Local CRUD --------------------------------------------------------
    loadIndex: (): Promise<CollectionIndexEntry[]> =>
      ipcRenderer.invoke(COLLECTIONS_CHANNELS.LOAD_INDEX),
    loadCollection: (id: string): Promise<CollectionConfig | null> =>
      ipcRenderer.invoke(COLLECTIONS_CHANNELS.LOAD_COLLECTION, id),
    saveCollection: (
      collection: Partial<CollectionConfig> & { name: string },
    ): Promise<CollectionConfig> =>
      ipcRenderer.invoke(COLLECTIONS_CHANNELS.SAVE_COLLECTION, collection),
    deleteCollection: (id: string): Promise<void> =>
      ipcRenderer.invoke(COLLECTIONS_CHANNELS.DELETE_COLLECTION, id),

    duplicateCollection: (request) =>
      ipcRenderer.invoke(COLLECTIONS_CHANNELS.DUPLICATE_COLLECTION, request),
    applySharedUpdate: (request) =>
      ipcRenderer.invoke(COLLECTIONS_CHANNELS.APPLY_SHARED_UPDATE, request),

    // ---- Shared (Canopy Cloud) CRUD ---------------------------------------
    listShared: (
      request: ListSharedCollectionsRequest,
    ): Promise<ListSharedCollectionsResponse> =>
      ipcRenderer.invoke(COLLECTIONS_CHANNELS.SHARED_LIST, request),
    getShared: (collectionId: string): Promise<SharedCollectionDetail> =>
      ipcRenderer.invoke(COLLECTIONS_CHANNELS.SHARED_GET, collectionId),
    createShared: (
      request: CreateSharedCollectionRequest,
    ): Promise<ShareOperationResult<SharedCollectionDetail>> =>
      ipcRenderer.invoke(COLLECTIONS_CHANNELS.SHARED_CREATE, request),
    updateShared: (
      request: UpdateSharedCollectionRequest,
    ): Promise<ShareOperationResult<SharedCollectionDetail>> =>
      ipcRenderer.invoke(COLLECTIONS_CHANNELS.SHARED_UPDATE, request),
    deleteShared: (request: DeleteSharedCollectionRequest): Promise<void> =>
      ipcRenderer.invoke(COLLECTIONS_CHANNELS.SHARED_DELETE, request),
    publishPublicShare: (collectionId: string) =>
      ipcRenderer.invoke(
        COLLECTIONS_CHANNELS.SHARED_PUBLIC_PUBLISH,
        collectionId,
      ),
    revokePublicShare: (collectionId: string): Promise<void> =>
      ipcRenderer.invoke(
        COLLECTIONS_CHANNELS.SHARED_PUBLIC_REVOKE,
        collectionId,
      ),
    analyzeCapabilityPackage: (
      request: AnalyzeCollectionCapabilityPackageRequest,
    ): Promise<PipelinePackageAnalysisSummary> =>
      ipcRenderer.invoke(COLLECTIONS_CHANNELS.PACKAGE_ANALYZE, request),
    cancelCapabilityPackageAnalysis: (analysisId: string): Promise<void> =>
      ipcRenderer.invoke(
        COLLECTIONS_CHANNELS.PACKAGE_CANCEL_ANALYSIS,
        analysisId,
      ),
    commitCapabilityPackage: (
      request: CommitCollectionCapabilityPackageRequest,
    ): Promise<
      ShareOperationResult<{
        capabilityPackage: PipelinePackageRef;
        committedPackageUploadId: string;
      }>
    > => ipcRenderer.invoke(COLLECTIONS_CHANNELS.PACKAGE_COMMIT, request),
    inspectImport: (
      collectionId: string,
    ): Promise<SharedCollectionImportReadiness> =>
      ipcRenderer.invoke(COLLECTIONS_CHANNELS.IMPORT_READINESS, collectionId),
    installCapabilityPackage: (
      request: InstallCollectionCapabilityPackageRequest,
    ): Promise<InstallCollectionCapabilityPackageResult> =>
      ipcRenderer.invoke(COLLECTIONS_CHANNELS.PACKAGE_INSTALL, request),
  };
}
