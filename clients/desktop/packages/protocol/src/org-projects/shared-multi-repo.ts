import type { OrgProjectSummary, OrgProjectRepository } from './index';
import type { CreateSharedMultiRepoOrgProjectRequest } from '../canopy-core/shared-multi-repo-validation';
export * from '../canopy-core/shared-multi-repo-validation';

export interface CreateSharedMultiRepoOrgProjectResponse {
  creationKey: string;
  project: OrgProjectSummary;
}

export type SharedMultiRepoEntryPoint =
  | 'combine'
  | 'convert'
  | 'add-repositories';
export interface SharedMultiRepoSelection {
  kind: 'workspace' | 'project';
  id: string;
}
export interface PrepareSharedMultiRepoParams {
  mode: SharedMultiRepoEntryPoint;
  selections: readonly SharedMultiRepoSelection[];
}
export interface PreparedSharedMultiRepo {
  organizationId: string;
  sourceProjects: readonly { projectId: string; expectedRevision: number }[];
  repositories: readonly OrgProjectRepository[];
  lockedProjectIds: readonly string[];
  suggestedName: string;
  canCreate: boolean;
}
export type SharedMultiRepoCreationState =
  | 'creating'
  | 'create-unconfirmed'
  | 'rejected'
  | 'created'
  | 'setting-up'
  | 'setup-failed'
  | 'setup-cancelled'
  | 'completion-pending'
  | 'ready'
  | 'retired'
  | 'access-blocked';
export interface SharedMultiRepoCreationStatus {
  creationKey: string;
  organizationId: string;
  deviceId: string;
  state: SharedMultiRepoCreationState;
  projectId?: string;
  errorCode?: string;
  updatedAt: string;
}
export interface CreateSharedMultiRepoParams extends PrepareSharedMultiRepoParams {
  request: CreateSharedMultiRepoOrgProjectRequest;
}

/** A retry uses the host's immutable journal, never a reconstructed preview. */
export type SharedMultiRepoCreateCommand =
  | CreateSharedMultiRepoParams
  | { creationKey: string };
