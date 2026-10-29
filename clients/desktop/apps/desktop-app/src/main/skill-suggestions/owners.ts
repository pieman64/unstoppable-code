import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import {
  DEFAULT_COWORK_WORKSPACE_ID,
  orgDefaultCoworkWorkspaceId,
} from '@canopy/protocol/ui-labels';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import type { SkillSuggestionPartition } from './partition';

/** Organization id to name, for the organizations the user belongs to now. */
export type MemberOrganizations = ReadonlyMap<string, string>;

/** Current membership without waiting; may be empty before the service loads. */
export function memberOrganizationsNow(): MemberOrganizations {
  const organizations = getWorkspaceContextService().getState().organizations;
  return new Map(organizations.map((entry) => [entry.id, entry.name]));
}

/** Settled membership, for decisions that expire state. */
export async function readMemberOrganizations(): Promise<MemberOrganizations> {
  const service = getWorkspaceContextService();
  await service.initialize();
  await service.whenIdle();
  return memberOrganizationsNow();
}

export function isOwnerAvailable(
  owner: WorkOwner,
  organizations: MemberOrganizations,
): boolean {
  return owner.kind === 'personal' || organizations.has(owner.organizationId);
}

/** The owner's default Chats workspace: model resolution and drafting use it. */
export function defaultCoworkWorkspaceIdFor(owner: WorkOwner): string {
  return owner.kind === 'organization'
    ? orgDefaultCoworkWorkspaceId(owner.organizationId)
    : DEFAULT_COWORK_WORKSPACE_ID;
}

export function ownerLabelFor(
  partition: SkillSuggestionPartition,
  organizations: MemberOrganizations,
): string {
  const base =
    partition.owner.kind === 'organization'
      ? (organizations.get(partition.owner.organizationId) ?? 'Organization')
      : 'Personal';
  return partition.privateWorkspaceId === null
    ? base
    : `${base} · Private workspace`;
}
