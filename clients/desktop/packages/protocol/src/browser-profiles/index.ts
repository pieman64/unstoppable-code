import type { BrowserProfileDataApi } from './data';
export type * from './data';

/** Local browser profile wire contracts. Native storage locators never cross IPC. */
export type BrowserTaskScope =
  | { kind: 'worktree'; projectId: string; worktreeId: string }
  | { kind: 'cowork_work_entry'; workspaceId: string; workEntryId: string }
  | { kind: 'app_advisor_work_entry'; workEntryId: string };

export type BrowserProfileSelection =
  | { kind: 'task' }
  | { kind: 'named'; profileId: string };

export interface BrowserProfileBinding {
  selection: BrowserProfileSelection;
  resolvedProfileId: string;
  storageGeneration: number;
  runtimeGeneration: number;
  taskIncarnationId: string;
}

export interface BrowserProfileRecord {
  schemaVersion: 1;
  profileId: string;
  kind: 'task' | 'named';
  owner:
    | { kind: 'task'; taskScope: BrowserTaskScope; taskIncarnationId: string }
    | { kind: 'user'; localPrincipalId: string };
  displayName: string;
  color?: string;
  metadataRevision: number;
  agentPermissions: { allowEnable: boolean; allowClear: boolean };
  lifecycle: 'active' | 'retired' | 'cleanup_pending' | 'deleted';
  storageGeneration: number;
  createdAt: number;
  updatedAt: number;
}

export interface BrowserTaskSlot {
  schemaVersion: 1;
  scope: BrowserTaskScope;
  ownerCreatedAt: string;
  incarnationId: string;
  metadataRevision: number;
  defaultSelection: BrowserProfileSelection;
  taskProfileId?: string;
  nextStorageGeneration: number;
  /** False only while the original incarnation may still own an unallocated legacy store. */
  legacyOwnershipResolved?: boolean;
  agentClearAllowed: boolean;
  lifecycle: 'active' | 'retirement_pending' | 'retired';
  retirementOperationId?: string;
}

export interface BrowserProfilePatch {
  displayName?: string;
  color?: string;
  allowEnable?: boolean;
  allowClear?: boolean;
}

export interface BrowserNamedProfileInput extends BrowserProfilePatch {
  displayName: string;
}

export interface BrowserProfilePage {
  profiles: BrowserProfileRecord[];
  nextOffset?: number;
}

export interface BrowserProfileUsage {
  tabs: {
    browserId: string;
    projectId: string;
    worktreeId: string;
    runtimeGeneration: number;
    /** Maintenance binds the original Task; optional for older delete previews. */
    taskIncarnationId?: string;
  }[];
  defaults: BrowserTaskScope[];
}

export interface BrowserProfileDeletePreview extends BrowserProfileUsage {
  token: string;
  profileId: string;
  storageGeneration: number;
  metadataRevision: number;
  expiresAt: number;
}

/** App-owned user IPC only. Scoped agent dispatch exposes a smaller read/use API. */
export interface BrowserProfilesApi extends BrowserProfileDataApi {
  list(request?: {
    offset?: number;
    projectId?: string;
    worktreeId?: string;
  }): Promise<BrowserProfilePage>;
  get(request: { profileId: string }): Promise<BrowserProfileRecord>;
  create(request: {
    operationId: string;
    input: BrowserNamedProfileInput;
  }): Promise<BrowserProfileRecord>;
  update(request: {
    operationId: string;
    profileId: string;
    expectedMetadataRevision: number;
    patch: BrowserProfilePatch;
  }): Promise<BrowserProfileRecord>;
  context(request: {
    projectId: string;
    worktreeId: string;
  }): Promise<BrowserTaskSlot>;
  setDefault(request: {
    operationId: string;
    projectId: string;
    worktreeId: string;
    incarnationId: string;
    expectedMetadataRevision: number;
    selection: BrowserProfileSelection;
  }): Promise<BrowserTaskSlot>;
  previewDelete(request: {
    profileId: string;
    expectedMetadataRevision: number;
  }): Promise<BrowserProfileDeletePreview>;
  delete(request: {
    operationId: string;
    token: string;
  }): Promise<{ cleanupPending: boolean }>;
}

export interface ExistingBrowserTarget {
  browserId: string;
  expectedRuntimeGeneration: number;
}

export type BrowserProfileErrorCode =
  | 'invalid_request'
  | 'scope_unresolved'
  | 'scope_retired'
  | 'profile_unavailable'
  | 'agent_enable_denied'
  | 'agent_clear_denied'
  | 'stale_revision'
  | 'stale_runtime'
  | 'operation_conflict'
  | 'operation_expired'
  | 'dialog_pending'
  | 'cancelled'
  | 'unsupported_scope'
  | 'recovery_required'
  | 'storage_unavailable';

export interface ProfileMutationEnvelope<T> {
  schemaVersion: 1;
  operationId: string;
  expectedMetadataRevision?: number;
  payload: T;
}

export function isProfileRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isProfileId(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/.test(value)
  );
}

export function isBrowserTaskScope(value: unknown): value is BrowserTaskScope {
  if (!isProfileRecord(value)) return false;
  switch (value.kind) {
    case 'worktree':
      return isProfileId(value.projectId) && isProfileId(value.worktreeId);
    case 'cowork_work_entry':
      return isProfileId(value.workspaceId) && isProfileId(value.workEntryId);
    case 'app_advisor_work_entry':
      return isProfileId(value.workEntryId);
    default:
      return false;
  }
}

/** Stable, unambiguous namespace tuple; unlike legacy hyphen concatenation. */
export function browserTaskScopeTuple(scope: BrowserTaskScope): string {
  if (!isBrowserTaskScope(scope))
    throw new Error('Invalid browser task scope.');
  switch (scope.kind) {
    case 'worktree':
      return JSON.stringify([scope.kind, scope.projectId, scope.worktreeId]);
    case 'cowork_work_entry':
      return JSON.stringify([scope.kind, scope.workspaceId, scope.workEntryId]);
    case 'app_advisor_work_entry':
      return JSON.stringify([scope.kind, scope.workEntryId]);
  }
}

export function isBrowserProfileSelection(
  value: unknown,
): value is BrowserProfileSelection {
  return (
    isProfileRecord(value) &&
    (value.kind === 'task' ||
      (value.kind === 'named' && isProfileId(value.profileId)))
  );
}

export function isBrowserProfileBinding(
  value: unknown,
): value is BrowserProfileBinding {
  return (
    isProfileRecord(value) &&
    isBrowserProfileSelection(value.selection) &&
    isProfileId(value.resolvedProfileId) &&
    (value.selection.kind !== 'named' ||
      value.selection.profileId === value.resolvedProfileId) &&
    isProfileId(value.taskIncarnationId) &&
    Number.isSafeInteger(value.storageGeneration) &&
    Number(value.storageGeneration) >= 1 &&
    Number.isSafeInteger(value.runtimeGeneration) &&
    Number(value.runtimeGeneration) >= 1
  );
}
