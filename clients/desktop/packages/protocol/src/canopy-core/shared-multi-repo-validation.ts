export const SHARED_MULTI_REPO_VERSION = 1;
export const SHARED_MULTI_REPO_LIMIT = 32;
export const ORG_PROJECT_NAME_MAX_LENGTH = 256;
export const SHARED_MULTI_REPO_HOSTED_CAPABILITY = 'org-shared-multi-repo-v1';
export const SHARED_MULTI_REPO_RUNTIME_CAPABILITY =
  'org-shared-multi-repo-setup-v1';

export interface CreateSharedMultiRepoOrgProjectRequest {
  organizationId: string;
  creationKey: string;
  name: string;
  privateMemory?: boolean;
  sourceProjects: readonly { projectId: string; expectedRevision: number }[];
}

/** NFC, trimmed; lengths use UTF-16 code units, as existing project names do. */
export function normalizeOrgProjectName(name: string): string {
  return name.normalize('NFC').trim();
}

export function orgProjectNameIdentity(name: string): string {
  return normalizeOrgProjectName(name).toLowerCase();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shared bounded parser; never accepts URLs or partial repository selections. */
export function parseCreateSharedMultiRepoOrgProjectRequest(
  value: unknown,
): CreateSharedMultiRepoOrgProjectRequest | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('organizationId' in value) ||
    typeof value.organizationId !== 'string' ||
    !UUID.test(value.organizationId) ||
    !('creationKey' in value) ||
    typeof value.creationKey !== 'string' ||
    value.creationKey.trim().length === 0 ||
    value.creationKey.length > 128 ||
    !('name' in value) ||
    typeof value.name !== 'string' ||
    ('privateMemory' in value &&
      value.privateMemory !== undefined &&
      typeof value.privateMemory !== 'boolean') ||
    !('sourceProjects' in value) ||
    !Array.isArray(value.sourceProjects) ||
    value.sourceProjects.length < 1 ||
    value.sourceProjects.length > SHARED_MULTI_REPO_LIMIT
  )
    return null;
  const name = normalizeOrgProjectName(value.name);
  if (name.length === 0 || name.length > ORG_PROJECT_NAME_MAX_LENGTH)
    return null;
  const sources: { projectId: string; expectedRevision: number }[] = [];
  const seen = new Set<string>();
  const sourceProjects: unknown[] = value.sourceProjects;
  for (const source of sourceProjects) {
    if (
      typeof source !== 'object' ||
      source === null ||
      !('projectId' in source) ||
      typeof source.projectId !== 'string' ||
      !UUID.test(source.projectId) ||
      !('expectedRevision' in source) ||
      typeof source.expectedRevision !== 'number' ||
      !Number.isSafeInteger(source.expectedRevision) ||
      source.expectedRevision < 1
    )
      return null;
    const projectId = source.projectId.toLowerCase();
    if (seen.has(projectId)) return null;
    seen.add(projectId);
    sources.push({ projectId, expectedRevision: source.expectedRevision });
  }
  return {
    organizationId: value.organizationId.toLowerCase(),
    creationKey: value.creationKey,
    name,
    privateMemory: 'privateMemory' in value && value.privateMemory === true,
    sourceProjects: sources,
  };
}
