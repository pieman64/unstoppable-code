import {
  isResourceOwner,
  type ResourceOwner,
} from '@canopy/protocol/resource-owner';
import {
  isSameWorkspaceContext,
  isOwnerInContext,
  isWorkspaceContext,
  type WorkspaceContext,
} from '@canopy/protocol/workspace-context';
import { classifyResourceOwner } from './resource-context';

export interface InstallReceipt {
  /** Durable local aliases; editing or account switching cannot erase origin. */
  localResourceIds?: string[];
  /** Explicit removals retain provenance but no longer represent installed copies. */
  uninstalledLocalResourceIds?: string[];
  /** Per-copy SHA-256 baselines. Absent legacy multi-alias copies stay unknown. */
  localContentHashes?: Record<string, string>;
  /** A shared skill's dependencies retain origin but are not its replacement targets. */
  localResourceRoles?: Record<string, 'primary' | 'dependency'>;
  family: string;
  remoteId: string;
  /** Omitted receipts retain their authenticated scoped origin. */
  sourceKind?: 'public-share';
  shareScope: 'private' | 'team' | 'organization';
  ownerContext: WorkspaceContext;
  hash: string;
  authorizedAt: string;
  /** Historical display metadata from the authenticated source, never grants. */
  sharedByName?: string;
  /** Organization name only; a personal owner's name is not an organization. */
  ownerName?: string;
  teamName?: string;
}

type InstallReceiptDisplayNames = Pick<
  InstallReceipt,
  'sharedByName' | 'ownerName' | 'teamName'
>;

/** Use the same display snapshot normalization at install and storage boundaries. */
export function normalizeInstallReceiptDisplayNames(
  names: InstallReceiptDisplayNames,
): InstallReceiptDisplayNames {
  const sharedByName = names.sharedByName?.trim();
  const ownerName = names.ownerName?.trim();
  const teamName = names.teamName?.trim();
  return {
    ...(sharedByName ? { sharedByName } : {}),
    ...(ownerName ? { ownerName } : {}),
    ...(teamName ? { teamName } : {}),
  };
}
export interface ResourceContextSubject {
  kind: 'plugin' | 'skill' | 'mcp';
  name: string;
}
export function normalizeResourceContextSubjectName(
  name: string,
): string | undefined {
  let withoutControls = '';
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    withoutControls +=
      code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? ' ' : name.charAt(index);
  }
  const normalized = withoutControls.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 200) : undefined;
}
export type ResourceContextDecision =
  | { allow: true }
  | {
      allow: false;
      reason:
        | 'context-mismatch'
        | 'access-removed'
        | 'unknown-provenance'
        | 'missing-dependency'
        | 'unsupported-target';
      /**
       * Verification could not complete (cloud unreachable or an outage), so
       * this is not a verdict on the resource. Callers may retry later.
       */
      transient?: true;
      /** Safe display identity for the capability that could not be classified. */
      subject?: ResourceContextSubject;
    };
export interface ResourceContextInput {
  resource: {
    owner: unknown;
    provenance?: InstallReceipt;
    subject?: ResourceContextSubject;
  };
  invocation: {
    mode: 'foreground' | 'background';
    context: WorkspaceContext;
    boundBindingId?: string;
    /** Serialized binding supplied by a trusted background host. */
    executionContext?: string;
  };
  target?: {
    workspaceOwner: WorkspaceContext;
    /** Organizations whose sidebar currently exposes this Personal workspace. */
    linkedOrganizationIds?: readonly string[];
  };
}
export interface ResourceDependency {
  owner: unknown;
  available: boolean;
  dependencies?: readonly ResourceDependency[];
}
type OwnerClassification = ReturnType<typeof classifyResourceOwner>;
const portableRules: Record<
  'global' | 'personal' | 'organization' | 'unknown',
  (
    owner: OwnerClassification,
    context: WorkspaceContext,
    personalOrganizationId: string | null,
  ) => ResourceContextDecision
> = {
  global: () => ({ allow: true }),
  personal: () => ({ allow: true }),
  organization: (owner, context, personalOrganizationId) =>
    typeof owner === 'object' &&
    isOwnerInContext(
      { kind: 'organization', organizationId: owner.organizationId },
      context,
      personalOrganizationId,
    )
      ? { allow: true }
      : { allow: false, reason: 'context-mismatch' },
  unknown: () => ({ allow: false, reason: 'unknown-provenance' }),
};

/** Strict by default; only a trusted host may select legacy compatibility. */
export function decideResourceContext(
  input: ResourceContextInput,
  {
    strict = true,
    personalOrganizationId = null,
  }: { strict?: boolean; personalOrganizationId?: string | null } = {},
): ResourceContextDecision {
  const { resource, invocation, target } = input;
  const owner = classifyResourceOwner(resource.owner, { strict });
  const decision = portableRules[
    typeof owner === 'object' ? 'organization' : owner
  ](owner, invocation.context, personalOrganizationId);
  if (!decision.allow) return decision;
  if (resource.provenance !== undefined) {
    if (!isInstallReceipt(resource.provenance))
      return { allow: false, reason: 'unknown-provenance' };
    if (
      resource.provenance.ownerContext.kind === 'organization' &&
      !isOwnerInContext(
        resource.provenance.ownerContext,
        invocation.context,
        personalOrganizationId,
      )
    )
      return { allow: false, reason: 'context-mismatch' };
  }
  if (
    target &&
    !isSameWorkspaceContext(target.workspaceOwner, invocation.context) &&
    !(
      target.workspaceOwner.kind === 'organization' &&
      target.workspaceOwner.organizationId === personalOrganizationId &&
      invocation.context.kind === 'personal'
    ) &&
    !(
      invocation.context.kind === 'organization' &&
      target.workspaceOwner.kind === 'personal' &&
      target.linkedOrganizationIds?.includes(
        invocation.context.organizationId,
      ) === true
    )
  ) {
    return { allow: false, reason: 'unsupported-target' };
  }
  return { allow: true };
}

/** Receipts contain provenance, never an enduring grant of access. */
export function isInstallReceipt(value: unknown): value is InstallReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const record: Record<string, unknown> = { ...value };
  return (
    (record.uninstalledLocalResourceIds === undefined ||
      (Array.isArray(record.uninstalledLocalResourceIds) &&
        record.uninstalledLocalResourceIds.every(
          (id: unknown) =>
            typeof id === 'string' &&
            Array.isArray(record.localResourceIds) &&
            record.localResourceIds.includes(id),
        ))) &&
    (record.localContentHashes === undefined ||
      (typeof record.localContentHashes === 'object' &&
        record.localContentHashes !== null &&
        !Array.isArray(record.localContentHashes) &&
        Object.entries(record.localContentHashes).every(
          ([id, hash]) =>
            Array.isArray(record.localResourceIds) &&
            record.localResourceIds.includes(id) &&
            typeof hash === 'string' &&
            /^[a-f0-9]{64}$/.test(hash),
        ))) &&
    (record.localResourceRoles === undefined ||
      (typeof record.localResourceRoles === 'object' &&
        record.localResourceRoles !== null &&
        !Array.isArray(record.localResourceRoles) &&
        Object.entries(record.localResourceRoles).every(
          ([id, role]) =>
            Array.isArray(record.localResourceIds) &&
            record.localResourceIds.includes(id) &&
            (role === 'primary' || role === 'dependency'),
        ))) &&
    ['sharedByName', 'ownerName', 'teamName'].every(
      (key) => record[key] === undefined || typeof record[key] === 'string',
    ) &&
    (record.localResourceIds === undefined ||
      (Array.isArray(record.localResourceIds) &&
        record.localResourceIds.every(
          (id: unknown) => typeof id === 'string' && id.length > 0,
        ))) &&
    ['family', 'remoteId', 'hash'].every(
      (key) => typeof record[key] === 'string' && record[key].trim().length > 0,
    ) &&
    typeof record.authorizedAt === 'string' &&
    Number.isFinite(Date.parse(record.authorizedAt)) &&
    isWorkspaceContext(record.ownerContext) &&
    (record.sourceKind === undefined ||
      (record.sourceKind === 'public-share' &&
        record.family === 'collections' &&
        record.shareScope === 'private' &&
        record.ownerContext.kind === 'personal')) &&
    ((record.shareScope === 'private' &&
      record.ownerContext.kind === 'personal') ||
      ((record.shareScope === 'team' || record.shareScope === 'organization') &&
        record.ownerContext.kind === 'organization'))
  );
}

const dependencyRules: Record<
  ResourceOwner['type'],
  (parent: ResourceOwner, child: ResourceOwner) => boolean
> = {
  system: (_parent, child) => child.type === 'system',
  user: (parent, child) =>
    child.type === 'system' ||
    (parent.type === 'user' && child.type === 'user' && parent.id === child.id),
  team: (parent, child) =>
    parent.type === 'team' &&
    ((child.type === 'team' &&
      child.id === parent.id &&
      child.organization.id === parent.organization.id) ||
      (child.type === 'organization' && child.id === parent.organization.id)),
  organization: (parent, child) =>
    parent.type === 'organization' &&
    child.type === 'organization' &&
    child.id === parent.id,
};

/** Validate every persisted edge, including nested graphs; cycles fail closed. */
export function validateDependencyGraph(
  parentOwner: unknown,
  deps: readonly ResourceDependency[],
): ResourceContextDecision {
  const visiting = new Set<ResourceDependency>();
  function valid(
    parent: unknown,
    children: readonly ResourceDependency[],
  ): boolean {
    if (!isResourceOwner(parent)) return false;
    return children.every((child) => {
      if (
        !child.available ||
        !isResourceOwner(child.owner) ||
        visiting.has(child) ||
        !dependencyRules[parent.type](parent, child.owner)
      )
        return false;
      visiting.add(child);
      const result = valid(child.owner, child.dependencies ?? []);
      visiting.delete(child);
      return result;
    });
  }
  return valid(parentOwner, deps)
    ? { allow: true }
    : { allow: false, reason: 'missing-dependency' };
}
