import { BRAND } from '@canopy/brand/current';
import type { CanopyAccountResponse } from '@canopy/protocol/canopy-server';
import {
  UpgradePersonalOrganizationResultSchema,
  OrganizationInviteResultSchema,
  OrganizationInviteStatusSchema,
  type OrganizationInviteStatus,
  ShareMemberProjectResultSchema,
  type UpgradePersonalOrganizationResult,
  type OrganizationInviteResult,
  type ShareMemberProjectResult,
  type UpgradePersonalOrganizationRequest,
  type SendOrganizationInviteRequest,
  type ShareMemberProjectRequest,
} from '@canopy/protocol/organizations';
import {
  CanopyCloudClientError,
  requestCanopyCloudJson,
  type CanopyCloudCredentialContext,
} from './client';
import { getCanopyCloudCredentials } from '../lib/canopy-cloud-account-store';

/** Caller captures this once; subsequent stages must never use another account's credentials. */
export async function personalOrganizationUpgradeCredentials(
  accountId: string,
): Promise<CanopyCloudCredentialContext> {
  const credentials = await getCanopyCloudCredentials();
  if (credentials.account?.id !== accountId)
    throw new CanopyCloudClientError('missing-api-key', 'Account changed');
  const { getCanopyCloudBaseUrl } = await import('./config');
  return {
    baseUrl: getCanopyCloudBaseUrl(),
    apiKey: credentials.apiKey,
    account: credentials.account,
    capabilities: credentials.capabilities,
  };
}

export async function promotePersonalOrganization(
  request: UpgradePersonalOrganizationRequest,
  credentialContext?: CanopyCloudCredentialContext,
): Promise<UpgradePersonalOrganizationResult> {
  const response = await requestCanopyCloudJson<unknown>(
    `/api/v1/organizations/${encodeURIComponent(request.organizationId)}/upgrade`,
    { method: 'POST', body: JSON.stringify(request), credentialContext },
  );
  const parsed = UpgradePersonalOrganizationResultSchema.safeParse(response);
  if (
    !parsed.success ||
    parsed.data.organizationId !== request.organizationId ||
    parsed.data.operationId !== request.operationId
  )
    throw new CanopyCloudClientError(
      'invalid-response',
      'Invalid promotion response',
    );
  return parsed.data;
}

export async function inviteToOrganization(
  organizationId: string,
  request: SendOrganizationInviteRequest,
  credentialContext?: CanopyCloudCredentialContext,
): Promise<OrganizationInviteResult> {
  const response = await requestCanopyCloudJson<unknown>(
    `/api/v1/organizations/${encodeURIComponent(organizationId)}/invites`,
    { method: 'POST', body: JSON.stringify(request), credentialContext },
  );
  const parsed = OrganizationInviteResultSchema.safeParse(response);
  if (!parsed.success)
    throw new CanopyCloudClientError(
      'invalid-response',
      'Invalid invitation response',
    );
  return parsed.data;
}

export async function shareMemberProject(
  request: ShareMemberProjectRequest,
  credentialContext?: CanopyCloudCredentialContext,
): Promise<ShareMemberProjectResult> {
  const response = await requestCanopyCloudJson<unknown>(
    `/api/v1/projects/${encodeURIComponent(request.projectId)}/share-with-organization`,
    { method: 'POST', body: JSON.stringify(request), credentialContext },
  );
  const parsed = ShareMemberProjectResultSchema.safeParse(response);
  if (!parsed.success || parsed.data.projectId !== request.projectId)
    throw new CanopyCloudClientError(
      'invalid-response',
      'Invalid project sharing response',
    );
  return parsed.data;
}

export async function readOrganizationInvitationStatus(
  organizationId: string,
  email: string,
  credentialContext: CanopyCloudCredentialContext,
): Promise<OrganizationInviteStatus> {
  return OrganizationInviteStatusSchema.parse(
    await requestCanopyCloudJson<unknown>(
      `/api/v1/organizations/${encodeURIComponent(organizationId)}/invites?email=${encodeURIComponent(email)}`,
      { credentialContext },
    ),
  );
}

/** Fresh server state fences web-only promotion and another desktop's observation. */
export async function readPersonalProjectConversionPolicy(
  accountId: string,
): Promise<{
  accountId: string;
  organizationIds: string[];
  excludedOrganizationIds: string[];
}> {
  const credentialContext =
    await personalOrganizationUpgradeCredentials(accountId);
  const account = await requestCanopyCloudJson<CanopyAccountResponse>(
    `/api/v1/${BRAND.web.apiNamespace}/account`,
    { credentialContext },
  );
  const current = await getCanopyCloudCredentials();
  if (account.account.id !== accountId || current.account?.id !== accountId)
    throw new CanopyCloudClientError('invalid-response', 'Account changed');
  return {
    accountId,
    organizationIds: account.organizations.map((org) => org.id),
    excludedOrganizationIds: account.organizations
      .filter((org) => org.automaticPersonalProjectConversionExcluded === true)
      .map((org) => org.id),
  };
}
