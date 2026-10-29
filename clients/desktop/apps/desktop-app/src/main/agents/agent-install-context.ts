import type { ResourceContextInput } from '@canopy/desktop-shared/lib/resource-context-policy';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import { createHash } from 'node:crypto';
import type { SharedAgentDetail } from '@canopy/desktop-shared/types/agent-models';
import { classifyResourceOwner } from '@canopy/desktop-shared/lib/resource-context';
import { createResourceInstallReceiptsStore } from '../lib/resource-install-receipts';
import { readCanopyCloudAccountWithStatus } from '../lib/canopy-cloud-account-store';
import {
  assertAgentContext,
  assertAgentContextSnapshot,
  agentContextSnapshot,
  agentResourceContextEnabled,
} from './resource-lanes';
import { getSharedAgent } from './canopy-server-client';

/** Distinguish an author-owned share link from pre-provenance import metadata. */
export async function sharedAgentIsAuthoredByCurrentAccount(
  detail: SharedAgentDetail,
): Promise<boolean> {
  const account = await readCanopyCloudAccountWithStatus();
  const accountId =
    account.status === 'ok' ? account.entry?.account?.id : undefined;
  return accountId !== undefined && detail.createdBy.id === accountId;
}

export async function assertStoredAgentContext(
  localId: string,
  projectId?: string,
  remoteId?: string,
): Promise<void> {
  if (!agentResourceContextEnabled()) return;
  const snapshot = await agentContextSnapshot();
  const account = await readCanopyCloudAccountWithStatus();
  const accountId =
    account.status === 'ok' ? account.entry?.account?.id : undefined;
  const binding = await createResourceInstallReceiptsStore(
    accountId ?? 'signed-out',
  ).findLocal('agents', localId);
  await assertAgentContextSnapshot(snapshot);
  if (!binding && remoteId) {
    const detail = await getSharedAgent(remoteId);
    await assertAgentContext({ owner: detail.owner }, projectId);
    await assertAgentContextSnapshot(snapshot);
    await recordSharedAgentInstall(detail, localId);
    await assertAgentContextSnapshot(snapshot);
    return;
  }
  if (!binding) {
    await assertAgentContext(
      {
        owner: { type: 'user', id: 'local', name: null },
      },
      projectId,
    );
    await assertAgentContextSnapshot(snapshot);
    return;
  }
  if (!accountId || binding.accountId !== accountId) {
    await assertAgentContext({ owner: undefined });
    throw new Error('Agent unavailable (access-removed)');
  }
  // An install receipt is provenance, never a grant: reauthorize the remote id.
  const detail = await getSharedAgent(binding.receipt.remoteId);
  await assertAgentContext(
    {
      owner: detail.owner,
      provenance: binding.receipt,
    },
    projectId,
  );
  await assertAgentContextSnapshot(snapshot);
}

export async function recordSharedAgentInstall(
  detail: SharedAgentDetail,
  localId: string,
): Promise<void> {
  if (!agentResourceContextEnabled()) return;
  const snapshot = await agentContextSnapshot();
  await assertAgentContext({ owner: detail.owner });
  const account = await readCanopyCloudAccountWithStatus();
  const accountId =
    account.status === 'ok' ? account.entry?.account?.id : undefined;
  if (!accountId) throw new Error('Agent unavailable (access-removed)');
  const owner = classifyResourceOwner(detail.owner, { strict: true });
  if (owner === 'unknown')
    throw new Error('Agent unavailable (unknown-provenance)');
  await assertAgentContextSnapshot(snapshot);
  await createResourceInstallReceiptsStore(accountId).record({
    family: 'agents',
    remoteId: detail.id,
    localResourceIds: [localId],
    shareScope: detail.shareScope ?? 'private',
    ownerContext:
      typeof owner === 'object'
        ? { kind: 'organization', organizationId: owner.organizationId }
        : { kind: 'personal' },
    hash: createHash('sha256')
      .update(JSON.stringify(detail.agent))
      .digest('hex'),
    authorizedAt: new Date().toISOString(),
  });
  await assertAgentContextSnapshot(snapshot);
}

export async function filterStoredAgentContexts<
  T extends { id: string; remoteId?: string; importedFromRemoteId?: string },
>(rows: T[]): Promise<T[]> {
  if (!agentResourceContextEnabled()) return rows;
  const snapshot = await agentContextSnapshot();
  const allowed = await Promise.all(
    rows.map(async (row): Promise<boolean> => {
      try {
        await assertStoredAgentContext(
          row.id,
          undefined,
          row.importedFromRemoteId ?? row.remoteId,
        );
        return true;
      } catch {
        return false;
      }
    }),
  );
  await assertAgentContextSnapshot(snapshot);
  return rows.filter((_row, index) => allowed[index]);
}

/** An organization-origin copy must not be republished as a portable private copy. */
export async function assertAgentShareOrigin(
  localId: string,
  destinationOwner: unknown,
): Promise<void> {
  if (!agentResourceContextEnabled()) return;
  const account = await readCanopyCloudAccountWithStatus();
  const accountId =
    account.status === 'ok' ? account.entry?.account?.id : undefined;
  const binding = await createResourceInstallReceiptsStore(
    accountId ?? 'signed-out',
  ).findLocal('agents', localId);
  if (binding?.receipt.ownerContext.kind !== 'organization') return;
  const resource: ResourceContextInput['resource'] = {
    owner: { type: 'system' },
    provenance: binding.receipt,
  };
  await assertAgentDestination(resource, destinationOwner);
}

export async function assertAgentOwnerDestination(
  sourceOwner: unknown,
  destinationOwner: unknown,
): Promise<void> {
  if (typeof classifyResourceOwner(sourceOwner, { strict: true }) !== 'object')
    return;
  await assertAgentDestination({ owner: sourceOwner }, destinationOwner);
}

async function assertAgentDestination(
  resource: ResourceContextInput['resource'],
  destinationOwner: unknown,
): Promise<void> {
  const owner = classifyResourceOwner(destinationOwner, { strict: true });
  const { getResourceContextPolicyService } =
    await import('../services/resource-context-policy-service');
  const decision = await getResourceContextPolicyService().decide({
    resource,
    invocation: {
      mode: 'foreground',
      context: getWorkspaceContextService().getState().context,
    },
    target: {
      workspaceOwner:
        typeof owner === 'object'
          ? { kind: 'organization', organizationId: owner.organizationId }
          : { kind: 'personal' },
    },
  });
  if (!decision.allow)
    throw new Error(`Agent unavailable (${decision.reason})`);
}
