import {
  ORG_REPOSITORY_OWNER_URL_MAX_LENGTH,
  type OrgRepositoryOwnerLookup,
} from '@canopy/protocol/org-projects';
import type {
  PortalCommandEnvelope,
  PortalCommandPayloadMap,
} from '@canopy/protocol/portal';
import { getOrgRepositoryOwnerLookup } from '../../lib/org-repository-owner';
import type { PortalAdapterContext } from './types';
import { isRecord } from './validation';

/** Read-only advice from the same bounded lookup used by desktop Add project. */
export async function handlePortalOrgProjectsFindRepositoryOwner(
  command: PortalCommandEnvelope<unknown>,
  context: PortalAdapterContext,
): Promise<void> {
  const payload = command.payload;
  if (
    !isRecord(payload) ||
    typeof payload.remoteUrl !== 'string' ||
    payload.remoteUrl.trim().length === 0 ||
    payload.remoteUrl.length > ORG_REPOSITORY_OWNER_URL_MAX_LENGTH
  ) {
    context.fail(
      command,
      'invalid_payload',
      'Invalid repository owner request',
    );
    return;
  }

  const request: PortalCommandPayloadMap['portal.org_projects.find_repository_owner'] =
    {
      remoteUrl: payload.remoteUrl,
    };
  let result: OrgRepositoryOwnerLookup;
  try {
    result = await getOrgRepositoryOwnerLookup().find(request);
  } catch {
    result = { kind: 'none' };
  }
  context.complete(command, result);
}
