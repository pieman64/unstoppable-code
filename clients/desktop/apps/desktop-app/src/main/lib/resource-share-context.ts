import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import type { PortalSharingExistingShare } from '@canopy/protocol/portal';
import type { ShareRemoteMetadata, ShareScope } from '@canopy/protocol/sharing';
import { getCanopyCloudBaseUrl } from '../canopy-cloud/config';

export async function assertResourceShareDestination(request: {
  shareScope?: 'private' | 'team' | 'organization';
  teamId?: string;
  organizationId?: string;
}): Promise<WorkspaceContext> {
  const { assertResourceContext, resourceContextEnabled } =
    await import('./resource-context');
  if (!resourceContextEnabled()) return { kind: 'personal' };
  let organizationId =
    request.shareScope === 'organization' ? request.organizationId : undefined;
  if (request.shareScope === 'team') {
    const { listSharedTeams } =
      await import('../pipelines/canopy-server-client');
    const team = (await listSharedTeams({})).data.find(
      (row) => row.id === request.teamId,
    );
    organizationId = team?.organization.id;
  }
  if (
    request.shareScope &&
    request.shareScope !== 'private' &&
    !organizationId
  ) {
    await assertResourceContext({ owner: undefined });
    throw new Error('Resource unavailable (unknown-provenance)');
  }
  await assertResourceContext({
    owner: organizationId
      ? { type: 'organization', id: organizationId, name: null }
      : { type: 'user', id: 'local', name: null },
  });
  return organizationId
    ? { kind: 'organization', organizationId }
    : { kind: 'personal' };
}

/** Prevent an organization-owned share from being moved outside its owner. */
export async function assertResourceShareTransition(
  sourceOwner: unknown,
  destination: WorkspaceContext,
): Promise<void> {
  const { assertResourceContext } = await import('./resource-context');
  await assertResourceContext(
    { owner: sourceOwner },
    { workspaceOwner: destination },
  );
}

/**
 * Bind a Portal share operation to the currently connected desktop account.
 * Existing unbound or differently-bound links fail closed so a 404 cannot
 * silently create a replacement share and orphan the original account's row.
 */
export async function requirePortalShareAccountId(
  remote?: ShareRemoteMetadata,
): Promise<string> {
  const { loadCanopyCloudAccountPublicState } =
    await import('./canopy-cloud-account-store');
  const state = await loadCanopyCloudAccountPublicState();
  const accountId =
    state.hasApiKey === true && state.account ? state.account.id : undefined;
  if (!accountId) {
    throw new Error('Reconnect the desktop Cloud account to continue.');
  }
  if (remote && remote.accountId !== accountId) {
    throw new Error(
      'This local share link belongs to another or unknown Cloud account.',
    );
  }
  return accountId;
}

type ExistingShareOwner =
  | { type: 'system' }
  | {
      type: 'user' | 'team' | 'organization';
      id: string;
      name?: string | null;
      organization?: { id: string; name?: string | null } | null;
    };

/** A scoped update must not implicitly remove a legacy link the owner cannot refresh. */
export async function preserveOrganizationPublicLink(
  owner: ExistingShareOwner | null | undefined,
): Promise<boolean> {
  if (!owner || (owner.type !== 'team' && owner.type !== 'organization'))
    return false;
  const { resourceContextEnabled } = await import('./resource-context');
  if (!resourceContextEnabled()) return false;
  const organizationId =
    owner.type === 'organization' ? owner.id : owner.organization?.id;
  if (!organizationId) return true;
  const { loadCanopyCloudAccountPublicState } =
    await import('./canopy-cloud-account-store');
  const account = await loadCanopyCloudAccountPublicState();
  return (
    account.personalOrganizationId === undefined ||
    organizationId.toLowerCase() !==
      account.personalOrganizationId.toLowerCase()
  );
}

/** Project a Cloud detail into the neutral state consumed by Portal UI. */
export function toPortalExistingShare(detail: {
  shareScope?: ShareScope;
  publicShare?: { upToDate?: boolean; sharePath?: string } | null;
  owner?: ExistingShareOwner | null;
}): PortalSharingExistingShare {
  const publicUrl = portalPublicUrl(detail.publicShare?.sharePath);
  const owner = detail.owner;
  const target =
    owner && (owner.type === 'team' || owner.type === 'organization')
      ? {
          id: owner.id,
          name:
            owner.name ??
            (owner.type === 'team' ? 'Shared team' : 'Shared organization'),
          ...(owner.type === 'team' && owner.organization
            ? {
                organizationId: owner.organization.id,
                ...(owner.organization.name
                  ? { secondaryLabel: owner.organization.name }
                  : {}),
              }
            : {}),
        }
      : undefined;
  return {
    audience: detail.publicShare ? 'public' : (detail.shareScope ?? 'private'),
    ...(target &&
    owner &&
    (owner.type === 'team' || owner.type === 'organization')
      ? { target, targetAudience: owner.type }
      : {}),
    ...(detail.publicShare?.upToDate === false
      ? { publicLinkStale: true }
      : {}),
    ...(publicUrl !== undefined ? { publicUrl } : {}),
  };
}

/**
 * The public link a reopened Portal Share shows, resolved against the
 * publishing account's cloud origin like a fresh share's `shareUrl`.
 */
function portalPublicUrl(sharePath: string | undefined): string | undefined {
  if (sharePath === undefined || sharePath.length === 0) return undefined;
  try {
    return new URL(sharePath, getCanopyCloudBaseUrl()).toString();
  } catch {
    // An unconfigured origin opens the dialog without the link.
    return undefined;
  }
}
