import type {
  PublicSkillShareSnapshot,
  ScopedShareProvenance,
} from '@canopy/protocol/share-deep-link';
import { resourceOwnerContext } from '@canopy/protocol/resource-owner';
import { normalizePersonalOrganizationId } from '@canopy/protocol/workspace-context';
import {
  shareAttributionParts,
  type ShareAttributionPart,
  type SkillInstallScope,
} from '@canopy/ui-app/sharing/share-install-copy';
import { shareAudienceLabelText } from '@canopy/ui-shared/components';

type SkillProvenanceFacts = Pick<
  PublicSkillShareSnapshot,
  'sharedBy' | 'authorUsername' | 'scopedShare' | 'sourceRemoteId'
>;

/** The attribution facts a skill or plugin snapshot carries. */
interface ScopedShareFacts {
  readonly sharedBy?: ScopedShareProvenance;
  readonly authorUsername: string | null;
}

/** The account's explicit personal organization, compared as normalized ids. */
function isPersonalOrganization(
  organizationId: string,
  personalOrganizationId: string | null,
): boolean {
  const personal = normalizePersonalOrganizationId(personalOrganizationId);
  return (
    personal !== null &&
    normalizePersonalOrganizationId(organizationId) === personal
  );
}

/**
 * Who shared a skill or plugin, who owns it, and who can see it (CAN-5017).
 * A scoped share's authenticated provenance wins over any public username; a
 * public share keeps its existing `Shared by <author>`.
 *
 * Personal comes only from the account's explicit personal organization id,
 * never the selected context or an organization's name, and only for an
 * organization owner: a team audience stays a team.
 */
export function scopedShareAttribution(
  snapshot: ScopedShareFacts,
  personalOrganizationId: string | null,
): readonly ShareAttributionPart[] {
  const provenance = snapshot.sharedBy;
  if (provenance === undefined) {
    return shareAttributionParts({ sharerName: snapshot.authorUsername });
  }
  const { owner, shareScope } = provenance;
  const personal =
    owner.type === 'organization' &&
    isPersonalOrganization(owner.id, personalOrganizationId);
  const ownerName =
    owner.type === 'team'
      ? owner.organization.name
      : owner.type === 'organization' && !personal
        ? owner.name
        : null;
  return shareAttributionParts({
    sharerName: provenance.name,
    ownerName,
    audienceLabel: shareAudienceLabelText(shareScope, null, personal),
    audienceName: owner.type === 'team' ? owner.name : null,
  });
}

/**
 * Where the installed copy lands, from the same facts the install reads:
 * a scoped snapshot with `sourceRemoteId` installs through the owning
 * context's receipt; a public one, or a scoped one resolved with context
 * scoping off, installs as a custom skill in every context. A legacy scoped
 * snapshot without provenance or a receipt source claims no scope at all.
 */
export function skillShareInstallScope(
  snapshot: SkillProvenanceFacts,
  personalOrganizationId: string | null,
): SkillInstallScope {
  if (snapshot.scopedShare !== true) return { kind: 'all-contexts' };
  if (snapshot.sourceRemoteId === undefined) {
    return snapshot.sharedBy !== undefined
      ? { kind: 'all-contexts' }
      : { kind: 'unknown' };
  }
  const owner = snapshot.sharedBy?.owner;
  if (owner === undefined) return { kind: 'organization', name: null };
  const context = resourceOwnerContext(owner);
  if (context === 'global') return { kind: 'all-contexts' };
  if (context === 'personal') return { kind: 'personal' };
  if (isPersonalOrganization(context.organizationId, personalOrganizationId)) {
    return { kind: 'personal' };
  }
  return {
    kind: 'organization',
    name:
      owner.type === 'team'
        ? owner.organization.name
        : owner.type === 'organization'
          ? owner.name
          : null,
  };
}
