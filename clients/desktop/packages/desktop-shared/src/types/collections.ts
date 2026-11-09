// ---------------------------------------------------------------------------
// Local Collection types.
//
// A "Collection" is the user-facing name for what was historically called a
// "Bundle". The wire shapes for shared Collections AND the neutral local
// catalog shapes (item refs, index entries, `CollectionConfig`) live in
// `@canopy/protocol/collections`; this file re-exports them and defines only
// the on-disk file envelopes and the preload-side API surface.
//
// `BundleConfig`, `BundleSkillRef`, and `BundlesAPI` remain as deprecated
// aliases (see `./bundles.ts`) so older persisted state and downstream
// consumers can migrate at their own pace.
// ---------------------------------------------------------------------------

import type { ShareOperationResult } from '@canopy/protocol/sharing';
import type {
  ApplyCollectionUpdateRequest,
  ApplyCollectionUpdateResult,
  DuplicateLocalCollectionRequest,
  CollectionConfig,
  CollectionIndexEntry,
  CollectionShareScope,
  ListSharedCollectionsResponse,
  SharedCollectionCustomSkillPayload,
  SharedCollectionDetail,
  SharedCollectionPublicShareInfo,
} from '@canopy/protocol/collections';
import type {
  PipelinePackageEnvironmentRequirement,
  PipelinePackageRef,
} from '@canopy/protocol/pipelines';
import type {
  PipelinePackageAnalysisSummary,
  PipelinePackageInvocationDismissal,
  PipelinePackageReadiness,
} from '@canopy/execution-engine/types/pipeline';

/** File envelope for `collections/index.json`. */
export interface CollectionIndexFile {
  version: 2;
  /** 2 once every entry was re-projected with sharedSource. */
  entrySchema?: 2;
  /** 1 once canonical member counts and opaque local revisions have been projected. */
  memberCountsSchema?: 1;
  collections: CollectionIndexEntry[];
}

/** File envelope for `collections/collection-<id>.json`. */
export interface CollectionConfigFile {
  version: 2;
  collection: CollectionConfig;
}

/**
 * Desktop-local request to list shared Collections from the configured
 * Canopy Cloud backend. The wire-side `serverId`-carrying type lives in
 * `@canopy/protocol/collections` and is unchanged.
 */
export interface ListSharedCollectionsRequest {
  limit?: number;
  cursor?: string;
  query?: string;
  createdBy?: 'me' | 'anyone';
}

/**
 * Desktop-local request to create a shared Collection on the configured
 * Canopy Cloud backend.
 */
export interface CreateSharedCollectionRequest {
  /** Desktop-local origin for share authorization; never sent to the server. */
  sourceCollectionId?: string;
  /** Raw Collection document bytes; the server validates structure. */
  rawCollection: string;
  customSkills?: SharedCollectionCustomSkillPayload[];
  shareScope?: CollectionShareScope;
  teamId?: string;
  organizationId?: string;
  capabilityPackage?: PipelinePackageRef | null;
  committedPackageUploadId?: string;
}

/**
 * Desktop-local request to update a shared Collection on the configured
 * Canopy Cloud backend.
 */
export interface UpdateSharedCollectionRequest {
  /** Local source whose author-side cloud link is updated after success. */
  sourceCollectionId?: string;
  collectionId: string;
  rawCollection: string;
  customSkills?: SharedCollectionCustomSkillPayload[];
  expectedContentHash?: string;
  shareScope?: CollectionShareScope;
  teamId?: string;
  organizationId?: string;
  capabilityPackage?: PipelinePackageRef | null;
  committedPackageUploadId?: string;
}

export interface AnalyzeCollectionCapabilityPackageRequest {
  collectionId: string;
  rawCollection: string;
  dismissedInvocations?: PipelinePackageInvocationDismissal[];
}

export interface CommitCollectionCapabilityPackageRequest {
  analysisId: string;
  selectedOptionalResourceIds?: string[];
}

export interface InstallCollectionCapabilityPackageRequest {
  collectionId: string;
  localCollectionId?: string;
  /** Main creates and owns the new collection until the package commits. */
  createCollection?: Pick<
    CollectionConfig,
    'name' | 'description' | 'sharedSource'
  >;
  packageRef: PipelinePackageRef;
  /** Read the package pinned to the anonymous public share. */
  fromPublicShare?: boolean;
}

export interface InstallCollectionCapabilityPackageResult {
  collection: CollectionConfig;
  installedSkills: Array<{ name: string; localName: string }>;
  mcpServerRefs: Array<{ serverId: string; configId: string }>;
  unmetRequirements: PipelinePackageEnvironmentRequirement[];
  uninstalledResourceLabels: string[];
  keptLocalFiles: string[];
}

export interface SharedCollectionImportReadiness {
  collection: SharedCollectionDetail;
  requirements: PipelinePackageReadiness['requirements'];
}

/**
 * Desktop-local request to delete a shared Collection on the configured
 * Canopy Cloud backend.
 */
export interface DeleteSharedCollectionRequest {
  collectionId: string;
}

/**
 * Preload API surface for Collections. Exposes both local CRUD and the
 * Canopy Cloud-backed shared CRUD operations.
 *
 * Local methods mirror the historical `BundlesAPI` shape with renamed
 * channels; the shared methods proxy through the configured Canopy Cloud
 * backend.
 */
export interface CollectionsAPI {
  // ---- Local CRUD ----------------------------------------------------------
  loadIndex(): Promise<CollectionIndexEntry[]>;
  loadCollection(id: string): Promise<CollectionConfig | null>;
  saveCollection(
    collection: Partial<CollectionConfig> & { name: string },
  ): Promise<CollectionConfig>;
  deleteCollection(id: string): Promise<void>;
  duplicateCollection(
    request: DuplicateLocalCollectionRequest,
  ): Promise<CollectionConfig>;
  applySharedUpdate(
    request: ApplyCollectionUpdateRequest,
  ): Promise<ApplyCollectionUpdateResult>;

  // ---- Shared (Canopy Cloud) CRUD -----------------------------------------
  listShared(
    request: ListSharedCollectionsRequest,
  ): Promise<ListSharedCollectionsResponse>;
  getShared(collectionId: string): Promise<SharedCollectionDetail>;
  createShared(
    request: CreateSharedCollectionRequest,
  ): Promise<ShareOperationResult<SharedCollectionDetail>>;
  updateShared(
    request: UpdateSharedCollectionRequest,
  ): Promise<ShareOperationResult<SharedCollectionDetail>>;
  deleteShared(request: DeleteSharedCollectionRequest): Promise<void>;
  publishPublicShare(
    collectionId: string,
  ): Promise<SharedCollectionPublicShareInfo>;
  revokePublicShare(collectionId: string): Promise<void>;
  analyzeCapabilityPackage(
    request: AnalyzeCollectionCapabilityPackageRequest,
  ): Promise<PipelinePackageAnalysisSummary>;
  cancelCapabilityPackageAnalysis(analysisId: string): Promise<void>;
  commitCapabilityPackage(
    request: CommitCollectionCapabilityPackageRequest,
  ): Promise<
    ShareOperationResult<{
      capabilityPackage: PipelinePackageRef;
      committedPackageUploadId: string;
    }>
  >;
  inspectImport(collectionId: string): Promise<SharedCollectionImportReadiness>;
  installCapabilityPackage(
    request: InstallCollectionCapabilityPackageRequest,
  ): Promise<InstallCollectionCapabilityPackageResult>;
}

// ---------------------------------------------------------------------------
// Re-export the shared (wire) shapes AND the neutral local catalog shapes so
// renderer modules can import them from
// `@canopy/desktop-shared/types/collections` rather than reaching directly
// into the protocol package.
//
// NOTE: the request shapes (`ListSharedCollectionsRequest`,
// `CreateSharedCollectionRequest`, `UpdateSharedCollectionRequest`,
// `DeleteSharedCollectionRequest`) are intentionally NOT re-exported from the
// protocol package — they are redeclared above without `serverId` for the
// desktop-local IPC layer. The protocol versions still describe the wire
// shape between desktop and Canopy Cloud (and `apps/web`) and remain
// unchanged.
//
// The local catalog shapes (`CollectionSkillRef`, `CollectionPluginRef`,
// `CollectionMcpRef`, `CollectionIndexEntry`, `CollectionConfig`) are hoisted
// to the protocol package unchanged — do NOT redefine them locally.
// ---------------------------------------------------------------------------

export type {
  ApplyCollectionUpdateRequest,
  ApplyCollectionUpdateResult,
  DuplicateLocalCollectionRequest,
  CollectionConfig,
  CollectionIndexEntry,
  CollectionIndexSharedSource,
  CollectionMcpRef,
  CollectionPluginRef,
  CollectionShareOwner,
  CollectionShareScope,
  CollectionSkillRef,
  ListSharedCollectionsResponse,
  SharedCollectionCustomSkillItem,
  SharedCollectionCustomSkillPayload,
  SharedCollectionDetail,
  SharedCollectionDocument,
  SharedCollectionExternalPluginItem,
  SharedCollectionExternalSkillItem,
  SharedCollectionItem,
  SharedCollectionItemCounts,
  SharedCollectionPublicShareInfo,
  SharedCollectionSummary,
  SharedCollectionWriteDocument,
  SharedCollectionWriteItem,
} from '@canopy/protocol/collections';

export {
  COLLECTION_SHARE_SCOPES,
  MAX_SHARED_COLLECTION_BYTES,
  MCP_SHARE_BLOCKED_MESSAGE,
  SHARED_COLLECTION_API_VERSION,
  validateSharedCollectionDocument,
} from '@canopy/protocol/collections';
