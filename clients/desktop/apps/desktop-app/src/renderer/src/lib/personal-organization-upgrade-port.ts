import type { PersonalOrganizationUpgradePort } from '@canopy/app-state/personal-organization-upgrade';
import { OrganizationOperationFailure } from '@canopy/app-core';
import {
  OrganizationOperationRefusalSchema,
  OrganizationInviteResultSchema,
  OrganizationInviteStatusSchema,
  PersonalOrganizationPromotionOutcomeSchema,
} from '@canopy/protocol/organizations';
import type {
  OrganizationInviteResult,
  OrganizationInviteStatus,
  PersonalOrganizationPromotionOutcome,
  PersonalProject,
  PersonalProjectOperation,
} from '@canopy/protocol/organizations';

/** Reconstruct typed errors after contextBridge has transported plain DTOs. */
export function organizationOperationReply<T>(
  schema: { parse(value: unknown): T },
  value: unknown,
): T {
  const refused = OrganizationOperationRefusalSchema.safeParse(value);
  if (refused.success)
    throw new OrganizationOperationFailure(
      refused.data.error,
      refused.data.code,
      refused.data.status,
    );
  return schema.parse(value);
}

/** Eligibility comes from the account; main rechecks it at each mutation. */
export function desktopPersonalOrganizationUpgradePort(
  accountId: string,
  canPromote: boolean,
  canInvite: boolean,
): PersonalOrganizationUpgradePort {
  const guard = async (): Promise<void> => {
    const account = await window.api.loadCanopyCloudAccount();
    if (account?.account?.id !== accountId)
      throw new Error('The account changed. Reopen this dialog.');
  };
  return {
    canPromote,
    canInvite,
    canBringProjects: canPromote,
    promote: async (request): Promise<PersonalOrganizationPromotionOutcome> => {
      await guard();
      return organizationOperationReply(
        PersonalOrganizationPromotionOutcomeSchema,
        await window.api.personalOrganizationUpgrade.promote(request),
      );
    },
    invite: async (
      organizationId,
      invite,
    ): Promise<OrganizationInviteResult> => {
      await guard();
      return organizationOperationReply(
        OrganizationInviteResultSchema,
        await window.api.personalOrganizationUpgrade.invite({
          organizationId,
          invite,
        }),
      );
    },
    reconcileInvite: async (
      organizationId,
      email,
    ): Promise<OrganizationInviteStatus> => {
      await guard();
      return organizationOperationReply(
        OrganizationInviteStatusSchema,
        await window.api.personalOrganizationUpgrade.inviteStatus({
          organizationId,
          email,
        }),
      );
    },
    listProjects: async (): Promise<readonly PersonalProject[]> => {
      await guard();
      return (await window.api.personalOrganizationUpgrade.listProjects())
        .projects;
    },
    convert: async (request): Promise<PersonalProjectOperation> => {
      await guard();
      return window.api.personalOrganizationUpgrade.convert(request);
    },
    status: async (operationId): Promise<PersonalProjectOperation | null> => {
      await guard();
      return window.api.personalOrganizationUpgrade.status({ operationId });
    },
  };
}
