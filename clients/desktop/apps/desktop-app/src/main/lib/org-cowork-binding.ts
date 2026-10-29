import { createHash, randomUUID } from 'node:crypto';
import type {
  ClaimOrgProjectInstanceRequest,
  ClaimOrgProjectInstanceResponse,
  CompleteOrgProjectInstanceRequest,
  EnsureOrgDefaultChatsResponse,
} from '@canopy/protocol/org-projects';
import { orgDefaultCoworkWorkspaceId } from '@canopy/protocol/ui-labels';
import type { WorkspaceOwnerBinding } from '@canopy/desktop-shared/types';
import type { WorkspaceOwnershipRead } from './workspace-persistence';
import { setupOwner } from './org-project-setup-journal';

export interface OrgCoworkBindingDeps {
  cloud: {
    ensureDefaultChats(
      organizationId: string,
    ): Promise<EnsureOrgDefaultChatsResponse>;
    claim(
      projectId: string,
      request: ClaimOrgProjectInstanceRequest,
    ): Promise<ClaimOrgProjectInstanceResponse>;
    complete(
      instanceId: string,
      request: CompleteOrgProjectInstanceRequest,
    ): Promise<void>;
  };
  readOwnership(workspaceId: string): Promise<WorkspaceOwnershipRead>;
  resolveDeviceId(): Promise<string>;
  readInstallationGeneration(deviceId: string): Promise<number>;
  isClaimConflict(error: unknown): boolean;
}

export interface BindOrgCoworkWorkspaceInput {
  organizationId: string;
  projectId: string;
  localWorkspaceId: string;
  createLocal(owner: WorkspaceOwnerBinding): Promise<void>;
  publishLocal(owner: WorkspaceOwnerBinding): Promise<void>;
  /** A member project may replace one stale, spent deterministic claim key. */
  rotateClaimKeyOnConflict?: boolean;
}

export interface OrgCoworkBindingResult {
  instanceId: string;
  owner: WorkspaceOwnerBinding;
}

export interface OrgCoworkBinding {
  bindOrgCoworkWorkspace(
    input: BindOrgCoworkWorkspaceInput,
  ): Promise<OrgCoworkBindingResult>;
  ensureOrgDefaultCoworkWorkspace(
    organizationId: string,
    createLocal: (owner: WorkspaceOwnerBinding) => Promise<void>,
    publishLocal: (owner: WorkspaceOwnerBinding) => Promise<void>,
  ): Promise<OrgCoworkBindingResult>;
}

function idempotencyKey(
  projectId: string,
  deviceId: string,
  installationGeneration: number,
  nonce?: string,
): string {
  return createHash('sha256')
    .update(
      `${projectId}:${deviceId}:${installationGeneration}${nonce ? `:${nonce}` : ''}`,
    )
    .digest('hex');
}

function existingOwner(
  ownership: WorkspaceOwnershipRead,
  input: BindOrgCoworkWorkspaceInput,
): WorkspaceOwnerBinding | null {
  if (ownership.authority !== 'ok') {
    if (ownership.authority === 'absent') return null;
    throw new Error('The local Cowork workspace configuration is unavailable');
  }
  if (
    ownership.type === 'cowork' &&
    ownership.owner?.type === 'organization' &&
    ownership.owner.organizationId === input.organizationId &&
    ownership.owner.projectId === input.projectId
  ) {
    return ownership.owner;
  }
  throw new Error('The local workspace id is already in use');
}

function ownersMatch(
  left: WorkspaceOwnerBinding | null,
  right: WorkspaceOwnerBinding,
): boolean {
  return (
    left?.type === 'organization' &&
    right.type === 'organization' &&
    left.organizationId === right.organizationId &&
    left.projectId === right.projectId &&
    left.instanceId === right.instanceId &&
    left.bindingGeneration === right.bindingGeneration
  );
}

/**
 * Pure organization-Cowork binding workflow. Product policy and host services
 * are injected so the same binder can serve the default Chats definition and
 * future user-created organization Cowork definitions.
 */
export function createOrgCoworkBinding(
  deps: OrgCoworkBindingDeps,
): OrgCoworkBinding {
  const attempts = new Map<string, Promise<OrgCoworkBindingResult>>();

  async function bind(
    input: BindOrgCoworkWorkspaceInput,
  ): Promise<OrgCoworkBindingResult> {
    const ownership = await deps.readOwnership(input.localWorkspaceId);
    const persistedOwner = existingOwner(ownership, input);
    const deviceId = await deps.resolveDeviceId();
    const installationGeneration =
      await deps.readInstallationGeneration(deviceId);
    const claimRequest = (nonce?: string): ClaimOrgProjectInstanceRequest => ({
      idempotencyKey: idempotencyKey(
        input.projectId,
        deviceId,
        installationGeneration,
        nonce,
      ),
      deviceId,
      installationGeneration,
      localWorkspaceId: input.localWorkspaceId,
    });
    let claim: ClaimOrgProjectInstanceResponse;
    try {
      claim = await deps.cloud.claim(input.projectId, claimRequest());
    } catch (error) {
      if (!input.rotateClaimKeyOnConflict || !deps.isClaimConflict(error)) {
        throw error;
      }
      claim = await deps.cloud.claim(
        input.projectId,
        claimRequest(randomUUID()),
      );
    }
    const owner = setupOwner({
      organizationId: input.organizationId,
      projectId: input.projectId,
      instanceId: claim.instanceId,
      fencingGeneration: claim.fencingGeneration,
    });
    if (!ownersMatch(persistedOwner, owner)) {
      await input.createLocal(owner);
    }
    await deps.cloud.complete(claim.instanceId, {
      operationId: claim.operationId,
      fencingGeneration: claim.fencingGeneration,
      outcome: 'ready',
    });
    await input.publishLocal(owner);
    return { instanceId: claim.instanceId, owner };
  }

  function bindOrgCoworkWorkspace(
    input: BindOrgCoworkWorkspaceInput,
  ): Promise<OrgCoworkBindingResult> {
    const previous = attempts.get(input.projectId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => bind(input));
    attempts.set(input.projectId, current);
    const cleanUp = (): void => {
      if (attempts.get(input.projectId) === current) {
        attempts.delete(input.projectId);
      }
    };
    void current.then(cleanUp, cleanUp);
    return current;
  }

  return {
    bindOrgCoworkWorkspace,
    async ensureOrgDefaultCoworkWorkspace(
      organizationId,
      createLocal,
      publishLocal,
    ): Promise<OrgCoworkBindingResult> {
      const project = await deps.cloud.ensureDefaultChats(organizationId);
      return bindOrgCoworkWorkspace({
        organizationId,
        projectId: project.id,
        localWorkspaceId: orgDefaultCoworkWorkspaceId(organizationId),
        createLocal,
        publishLocal,
      });
    },
  };
}
