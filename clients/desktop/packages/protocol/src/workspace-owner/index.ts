/**
 * The persisted `workspace.json` owner binding, classified once for every
 * reader. Environment-neutral: the renderer, desktop main, and core runtime
 * import it, so it reads no filesystem, process, or platform state.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A trimmed, lower-case UUID, or `null` when the value is not one. */
export function normalizeUuid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return UUID_PATTERN.test(normalized) ? normalized : null;
}

export interface PersistedWorkspaceOrganizationOwner {
  readonly type: 'organization';
  /** Organization external id (lower-case UUID). */
  readonly organizationId: string;
  /** Tracked workspace (project definition) external id. */
  readonly projectId: string;
  /** Workspace instance external id claimed for this checkout. */
  readonly instanceId: string;
  readonly bindingGeneration: number;
}

export type PersistedWorkspaceOwnerClassification =
  | { readonly kind: 'personal' }
  | {
      readonly kind: 'organization';
      readonly owner: PersistedWorkspaceOrganizationOwner;
    }
  | { readonly kind: 'malformed' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Absent is Personal. A present owner is either a complete organization
 * binding or malformed: authority readers must fail closed on `malformed`,
 * while display readers may choose to show it as Personal.
 */
export function classifyPersistedWorkspaceOwner(
  value: unknown,
): PersistedWorkspaceOwnerClassification {
  if (value === undefined) return { kind: 'personal' };
  if (!isRecord(value) || value.type !== 'organization')
    return { kind: 'malformed' };
  const organizationId = normalizeUuid(value.organizationId);
  const projectId = normalizeUuid(value.projectId);
  const instanceId = normalizeUuid(value.instanceId);
  const bindingGeneration = value.bindingGeneration;
  if (
    organizationId === null ||
    projectId === null ||
    instanceId === null ||
    typeof bindingGeneration !== 'number' ||
    !Number.isInteger(bindingGeneration) ||
    bindingGeneration < 0
  )
    return { kind: 'malformed' };
  return {
    kind: 'organization',
    owner: {
      type: 'organization',
      organizationId,
      projectId,
      instanceId,
      bindingGeneration,
    },
  };
}
