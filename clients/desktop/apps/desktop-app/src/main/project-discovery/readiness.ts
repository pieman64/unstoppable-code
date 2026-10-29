import type { WorkspaceOwnerBinding } from '@canopy/desktop-shared/types';
import {
  isOrgCoworkOperationEligible,
  isOrgMemberCodeOperationEligible,
} from '../lib/org-cowork-binding-deps';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import type { LegacyReadAuthority } from './sources';

export type ProjectReadiness = 'ready' | 'pending' | 'unavailable';

export interface OrganizationReadinessFacts {
  indexed: boolean;
  inventoryAuthority: LegacyReadAuthority;
  inventoryOwner?: WorkspaceOwnerBinding;
  configAuthority?: LegacyReadAuthority;
  configOwner?: WorkspaceOwnerBinding;
  configOwnerMalformed?: boolean;
}

export interface OrganizationReadinessDependencies {
  getOrganizations(): Promise<readonly { id: string; name?: string }[]>;
  isEligible(
    organizationId: string,
    options: { scope: 'membership' },
  ): Promise<boolean>;
  isMemberCodeEligible(
    organizationId: string,
    options: { scope: 'membership' },
  ): Promise<boolean>;
}

const defaultDependencies: OrganizationReadinessDependencies = {
  async getOrganizations() {
    const service = getWorkspaceContextService();
    await service.initialize();
    await service.whenIdle();
    return service.getState().organizations;
  },
  isEligible: isOrgCoworkOperationEligible,
  isMemberCodeEligible: isOrgMemberCodeOperationEligible,
};

export async function getOrganizationMemberships(): Promise<
  readonly { id: string; name?: string }[]
> {
  return defaultDependencies.getOrganizations();
}

function sameOwnerBinding(
  left: WorkspaceOwnerBinding | undefined,
  right: WorkspaceOwnerBinding | undefined,
): boolean {
  return (
    left?.type === 'organization' &&
    right?.type === 'organization' &&
    left.organizationId.toLowerCase() === right.organizationId.toLowerCase() &&
    left.projectId === right.projectId &&
    left.instanceId === right.instanceId &&
    left.bindingGeneration === right.bindingGeneration
  );
}

/**
 * Organization readiness is based on saved owner and binding facts, plus
 * membership-scoped eligibility. Index presence by itself is never readiness.
 */
export async function organizationChatsReadiness(
  organizationId: string,
  facts: OrganizationReadinessFacts,
  dependencies: OrganizationReadinessDependencies = defaultDependencies,
): Promise<ProjectReadiness> {
  const normalizedOrganizationId = organizationId.trim().toLowerCase();
  try {
    const organizations = await dependencies.getOrganizations();
    if (
      !organizations.some(
        (organization) =>
          organization.id.trim().toLowerCase() === normalizedOrganizationId,
      )
    ) {
      return 'unavailable';
    }
    if (
      !(await dependencies.isEligible(normalizedOrganizationId, {
        scope: 'membership',
      }))
    ) {
      return 'unavailable';
    }
  } catch {
    return 'unavailable';
  }

  if (facts.configOwnerMalformed === true) return 'unavailable';
  if (
    facts.inventoryAuthority === 'unreadable' ||
    (facts.inventoryAuthority === 'absent' && facts.indexed)
  ) {
    return 'unavailable';
  }
  if (!facts.indexed) {
    return facts.inventoryAuthority === 'partial' ? 'unavailable' : 'pending';
  }
  if (facts.configAuthority === undefined) return 'unavailable';
  if (
    facts.configAuthority === 'unreadable' ||
    facts.configAuthority === 'partial'
  ) {
    return 'unavailable';
  }
  if (
    facts.configAuthority === 'absent' ||
    !facts.inventoryOwner ||
    !facts.configOwner
  ) {
    return 'pending';
  }
  if (
    facts.configOwner.organizationId.toLowerCase() !== normalizedOrganizationId
  ) {
    return 'unavailable';
  }
  return sameOwnerBinding(facts.inventoryOwner, facts.configOwner)
    ? 'ready'
    : 'pending';
}

async function organizationCodeReadiness(
  organizationId: string,
  facts: OrganizationReadinessFacts,
  dependencies: OrganizationReadinessDependencies,
): Promise<ProjectReadiness> {
  const normalizedOrganizationId = organizationId.trim().toLowerCase();
  try {
    const organizations = await dependencies.getOrganizations();
    if (
      !organizations.some(
        (organization) =>
          organization.id.trim().toLowerCase() === normalizedOrganizationId,
      )
    ) {
      return 'unavailable';
    }
    if (
      !(await dependencies.isMemberCodeEligible(normalizedOrganizationId, {
        scope: 'membership',
      }))
    ) {
      return 'unavailable';
    }
  } catch {
    return 'unavailable';
  }

  if (facts.configOwnerMalformed === true) return 'unavailable';
  if (
    facts.inventoryAuthority === 'unreadable' ||
    (facts.inventoryAuthority === 'absent' && facts.indexed)
  ) {
    return 'unavailable';
  }
  if (!facts.indexed) {
    return facts.inventoryAuthority === 'partial' ? 'unavailable' : 'pending';
  }
  if (facts.configAuthority === undefined) return 'unavailable';
  if (
    facts.configAuthority === 'unreadable' ||
    facts.configAuthority === 'partial'
  ) {
    return 'unavailable';
  }
  if (
    facts.configAuthority === 'absent' ||
    !facts.inventoryOwner ||
    !facts.configOwner
  ) {
    return 'pending';
  }
  if (
    facts.configOwner.organizationId.toLowerCase() !== normalizedOrganizationId
  ) {
    return 'unavailable';
  }
  return sameOwnerBinding(facts.inventoryOwner, facts.configOwner)
    ? 'ready'
    : 'pending';
}

/** Readiness for Personal Chats likewise requires a reliable saved config. */
export function personalChatsReadiness(
  facts: OrganizationReadinessFacts,
): ProjectReadiness {
  if (
    facts.configOwnerMalformed === true ||
    facts.inventoryAuthority === 'unreadable' ||
    (facts.inventoryAuthority === 'absent' && facts.indexed) ||
    (facts.inventoryAuthority === 'partial' && !facts.indexed) ||
    facts.configAuthority === 'unreadable' ||
    facts.configAuthority === 'partial'
  ) {
    return 'unavailable';
  }
  if (!facts.indexed || facts.configAuthority === 'absent') return 'pending';
  if (facts.configAuthority !== 'ok') return 'unavailable';
  if (facts.configOwner) return 'unavailable';
  if (facts.inventoryOwner) return 'pending';
  return 'ready';
}

export function organizationProjectReadiness(
  organizationId: string,
  facts: OrganizationReadinessFacts,
  dependencies: OrganizationReadinessDependencies = defaultDependencies,
): Promise<ProjectReadiness> {
  return organizationCodeReadiness(organizationId, facts, dependencies);
}
