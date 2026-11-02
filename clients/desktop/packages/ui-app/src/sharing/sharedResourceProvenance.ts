import type { WorkspaceTemplateShareSummary } from '@canopy/protocol/workspace-templates';
import {
  existingShareAudienceLabel,
  type ExistingShareAudienceLabel,
  type ExistingShareFacts,
  type ExistingShareOwner,
} from './deriveExistingShare';

/** Serializable provenance for shared-resource details on either host. */
export interface SharedResourceProvenance {
  readonly author: string | null;
  readonly organizationName: string | null;
  readonly audience: ExistingShareAudienceLabel | null;
}

/** The resource's owning organization, with structurally Personal audiences omitted. */
export function sharedResourceOrganizationName(
  owner: ExistingShareOwner | null | undefined,
  audience: ExistingShareAudienceLabel | null,
): string | null {
  if (audience?.personal) return null;
  const name =
    owner?.type === 'organization'
      ? owner.name
      : owner?.type === 'team'
        ? owner.organization?.name
        : null;
  return name?.trim() || null;
}

/** The host selects the author using its existing name/email privacy policy. */
export function sharedResourceProvenance(
  facts: ExistingShareFacts,
  author: string | null | undefined,
  personalOrganizationId: string | null = null,
): SharedResourceProvenance {
  const audience = existingShareAudienceLabel(facts, personalOrganizationId);
  return {
    author: author?.trim() || null,
    organizationName: sharedResourceOrganizationName(facts.owner, audience),
    audience,
  };
}

/** Adapt the project-template audience without changing its existing label semantics. */
export function sharedWorkspaceTemplateProvenance(
  template: Pick<
    WorkspaceTemplateShareSummary,
    'audience' | 'owner' | 'createdBy'
  >,
  personalOrganizationId: string | null = null,
): SharedResourceProvenance {
  const audience: ExistingShareAudienceLabel = {
    audience:
      template.audience === 'TEAM'
        ? 'team'
        : template.audience === 'ORGANIZATION'
          ? 'organization'
          : 'public',
    personal:
      template.audience === 'ORGANIZATION' &&
      template.owner.type === 'organization' &&
      template.owner.id === personalOrganizationId,
    ...(template.audience === 'TEAM' && template.owner.type === 'team'
      ? { teamName: template.owner.name ?? undefined }
      : {}),
  };
  return {
    author: template.createdBy.name?.trim() || null,
    organizationName: sharedResourceOrganizationName(template.owner, audience),
    audience,
  };
}
