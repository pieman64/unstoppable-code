/**
 * Workspace context wire contract (CAN-611, organization projects).
 *
 * A context is the navigation scope a desktop window or a portal tab is
 * looking at: the user's Personal projects or one organization's projects.
 * It is a navigation fact only. Selecting a context never grants access,
 * changes execution ownership, or reroutes uploads; authorization is always
 * re-derived from live membership and grants on the server.
 *
 * Environment-neutral by design: no React, Node, Electron, or app imports, so
 * the desktop main process, the renderer, the CLI, and the web app share one
 * definition and one serialization.
 */

export const WORKSPACE_CONTEXT_ORGANIZATION_ROLES = [
  'OWNER',
  'ADMIN',
  'MEMBER',
] as const;

export type WorkspaceContextOrganizationRole =
  (typeof WORKSPACE_CONTEXT_ORGANIZATION_ROLES)[number];

export type WorkspaceContext =
  | { readonly kind: 'personal' }
  | {
      readonly kind: 'organization';
      /** Organization external id (UUID, lower case). */
      readonly organizationId: string;
    };

export const PERSONAL_WORKSPACE_CONTEXT: WorkspaceContext = {
  kind: 'personal',
};

/** One organization the client may switch into. */
export interface WorkspaceContextOrganization {
  readonly id: string;
  readonly name: string;
  /** Public logo URL from organization branding; absent/null means no logo. */
  readonly logoUrl?: string | null;
  readonly role: WorkspaceContextOrganizationRole;
  /**
   * The organization's active GitHub App installation id (web only, REG-3091);
   * `null` when the organization has no active GitHub connection. Desktop
   * ignores it.
   */
  readonly githubInstallationId?: string | null;
}

/**
 * The main-owned (desktop) or tab-owned (web) context state. `revision` is a
 * monotonic counter per account so a stale `set` from another window can be
 * rejected instead of silently winning.
 */
export interface WorkspaceContextState {
  readonly context: WorkspaceContext;
  readonly revision: number;
  readonly organizations: readonly WorkspaceContextOrganization[];
}

const PERSONAL_SERIALIZED = 'personal';
const ORGANIZATION_PREFIX = 'org:';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function normalizeOrganizationId(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return UUID_PATTERN.test(normalized) ? normalized : null;
}

/** Validate the additive account field; old-server absence grants no org access. */
export function normalizePersonalOrganizationId(value: unknown): string | null {
  return typeof value === 'string' ? normalizeOrganizationId(value) : null;
}

/** `'personal'` or `` `org:${uuid}` ``; stable for persistence and cache keys. */
export function serializeWorkspaceContext(context: WorkspaceContext): string {
  return context.kind === 'personal'
    ? PERSONAL_SERIALIZED
    : `${ORGANIZATION_PREFIX}${context.organizationId.toLowerCase()}`;
}

/** Inverse of {@link serializeWorkspaceContext}; `null` for anything else. */
export function parseWorkspaceContext(value: string): WorkspaceContext | null {
  if (value === PERSONAL_SERIALIZED) {
    return PERSONAL_WORKSPACE_CONTEXT;
  }
  if (!value.startsWith(ORGANIZATION_PREFIX)) {
    return null;
  }
  const organizationId = normalizeOrganizationId(
    value.slice(ORGANIZATION_PREFIX.length),
  );
  return organizationId === null
    ? null
    : { kind: 'organization', organizationId };
}

export function isSameWorkspaceContext(
  left: WorkspaceContext,
  right: WorkspaceContext,
): boolean {
  if (left.kind === 'personal' || right.kind === 'personal') {
    return left.kind === right.kind;
  }
  return (
    left.organizationId.toLowerCase() === right.organizationId.toLowerCase()
  );
}

/**
 * The selected organization, when the context names one the user belongs to.
 * Organization ids compare case-insensitively, like
 * {@link isSameWorkspaceContext}. A navigation lookup only: membership is still
 * authorized on the server.
 */
export function selectedContextOrganization(
  context: WorkspaceContext,
  organizations: readonly WorkspaceContextOrganization[],
): WorkspaceContextOrganization | null {
  if (context.kind !== 'organization') return null;
  const id = context.organizationId.toLowerCase();
  return (
    organizations.find(
      (organization) => organization.id.toLowerCase() === id,
    ) ?? null
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isWorkspaceContextOrganizationRole(
  value: unknown,
): value is WorkspaceContextOrganizationRole {
  // `.some()` rather than `.includes()` so no cast is needed on the tuple.
  return (
    typeof value === 'string' &&
    WORKSPACE_CONTEXT_ORGANIZATION_ROLES.some((role) => role === value)
  );
}

/**
 * Wire guard. Requires an already-normalized organization id (lower-case UUID,
 * no surrounding whitespace): the guard does not mutate its input, so a value
 * that merely normalizes to a UUID would let a non-canonical id reach
 * persistence and cache keys. Untrusted strings go through
 * {@link parseWorkspaceContext}, which normalizes.
 */
export function isWorkspaceContext(value: unknown): value is WorkspaceContext {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === 'personal') {
    return true;
  }
  return (
    value.kind === 'organization' &&
    typeof value.organizationId === 'string' &&
    UUID_PATTERN.test(value.organizationId)
  );
}

export function isWorkspaceContextOrganization(
  value: unknown,
): value is WorkspaceContextOrganization {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.name === 'string' &&
    isWorkspaceContextOrganizationRole(value.role)
  );
}

export function isWorkspaceContextState(
  value: unknown,
): value is WorkspaceContextState {
  return (
    isRecord(value) &&
    isWorkspaceContext(value.context) &&
    typeof value.revision === 'number' &&
    Number.isInteger(value.revision) &&
    value.revision >= 0 &&
    Array.isArray(value.organizations) &&
    value.organizations.every(isWorkspaceContextOrganization)
  );
}

/** Resolve a resource organization lane; this does not authorize membership. */
export function contextOrganizationId(
  context: WorkspaceContext,
  personalOrganizationId: string | null,
): string | null {
  return context.kind === 'personal'
    ? personalOrganizationId
    : context.organizationId;
}

/**
 * USER owners retain cross-context availability. The current personal org is
 * available only in Personal; other org owners require their own org context.
 * A missing personal ID grants no organization access. After promotion, the old
 * org matches its team context and the replacement matches Personal.
 */
export function isOwnerInContext(
  ownerContext: WorkspaceContext,
  context: WorkspaceContext,
  personalOrganizationId: string | null,
): boolean {
  if (ownerContext.kind === 'personal') return true;
  if (ownerContext.organizationId === personalOrganizationId)
    return context.kind === 'personal';
  return (
    context.kind === 'organization' &&
    ownerContext.organizationId === context.organizationId
  );
}
