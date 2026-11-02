import { isAbsolute } from 'node:path';
import type {
  SharedContainerForkDestination,
  SharedContainerForkErrorCode,
  SharedContainerForkRequest,
} from '@canopy/protocol/shared-containers';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import { isSameWorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  classifyPersistedWorkspaceOwner,
  normalizeUuid,
} from '@canopy/protocol/workspace-owner';
import { isRecord } from '../../lib/type-guards';
import { validateId } from '../../lib/validation';
import { readWorkspaceOwnership } from '../../lib/workspace-persistence';
import { getSharedContainerAcceptance } from '../acceptance-store';
import { fetchLatestSharedContainerRevision } from '../canopy-server-client';

export class SharedContainerForkError extends Error {
  /** The failure this refusal reports, kept for diagnostics only. */
  readonly failure: unknown;

  constructor(
    readonly code: SharedContainerForkErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.failure = options?.cause;
    this.name = 'SharedContainerForkError';
  }
}

export function forkSourceNotAccepted(): SharedContainerForkError {
  return new SharedContainerForkError(
    'source-unavailable',
    'Accept the share before making a copy.',
  );
}

function invalidDestination(): never {
  throw new SharedContainerForkError(
    'invalid-destination',
    'Choose a valid destination for the copy.',
  );
}

function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

/** Normalize untrusted owner ids once, before receipt fingerprinting. */
export function validateForkDestination(
  value: unknown,
): SharedContainerForkDestination {
  if (!isRecord(value)) return invalidDestination();
  if (value.kind === 'existing-workspace') {
    if (!onlyKeys(value, ['kind', 'workspaceId'])) return invalidDestination();
    try {
      validateId(value.workspaceId, 'workspaceId');
    } catch {
      return invalidDestination();
    }
    return { kind: 'existing-workspace', workspaceId: value.workspaceId };
  }
  if (
    value.kind !== 'new-workspace' ||
    !onlyKeys(value, ['kind', 'owner', 'parentDirectory']) ||
    !isRecord(value.owner)
  )
    return invalidDestination();
  let owner: WorkspaceContext;
  if (value.owner.kind === 'personal' && onlyKeys(value.owner, ['kind'])) {
    owner = { kind: 'personal' };
  } else if (
    value.owner.kind === 'organization' &&
    onlyKeys(value.owner, ['kind', 'organizationId'])
  ) {
    const organizationId = normalizeUuid(value.owner.organizationId);
    if (!organizationId) return invalidDestination();
    owner = { kind: 'organization', organizationId };
  } else return invalidDestination();
  if (
    value.parentDirectory !== undefined &&
    (typeof value.parentDirectory !== 'string' ||
      value.parentDirectory.includes('\0') ||
      !isAbsolute(value.parentDirectory))
  )
    return invalidDestination();
  return {
    kind: 'new-workspace',
    owner,
    ...(typeof value.parentDirectory === 'string'
      ? { parentDirectory: value.parentDirectory }
      : {}),
  };
}

export interface ForkSourceContext {
  owner: WorkspaceContext;
  organizationId?: string;
  organizationName?: string;
  acceptedAt: string;
  access: 'direct' | 'organization';
}

/** Acceptance anchors the access lane; a fresh server read authorizes it. */
export async function resolveForkSourceContext(
  request: SharedContainerForkRequest,
): Promise<ForkSourceContext> {
  const accepted = await getSharedContainerAcceptance(request.containerId);
  if (!accepted) {
    throw forkSourceNotAccepted();
  }
  const organizationId =
    accepted.organizationId === undefined
      ? undefined
      : normalizeUuid(accepted.organizationId);
  if (organizationId === null) {
    throw new SharedContainerForkError(
      'source-unavailable',
      'The share’s organization could not be verified.',
    );
  }
  if (
    request.organizationId !== undefined &&
    normalizeUuid(request.organizationId) !== organizationId
  ) {
    throw new SharedContainerForkError(
      'owner-mismatch',
      'The copy must stay in the context where the share was accepted.',
    );
  }
  const access =
    accepted.access ?? (organizationId ? 'organization' : 'direct');
  if (access === 'organization' && !organizationId) {
    throw new SharedContainerForkError(
      'source-unavailable',
      'The share’s organization could not be verified.',
    );
  }
  let source;
  try {
    source = await fetchLatestSharedContainerRevision(
      request.containerId,
      organizationId,
    );
  } catch {
    throw new SharedContainerForkError(
      'source-unavailable',
      'The share is unavailable. The copy wasn’t made.',
    );
  }
  if (
    source.id !== request.containerId ||
    (source.access !== 'direct' && source.access !== 'organization') ||
    // A direct acceptance stays Personal when a later server read can also
    // authorize organization access. An org acceptance cannot downgrade.
    (access === 'organization' && source.access !== 'organization') ||
    (source.organizationId === undefined
      ? undefined
      : normalizeUuid(source.organizationId)) !== organizationId
  ) {
    throw new SharedContainerForkError(
      'source-unavailable',
      'The share’s access changed. Open the share again before making a copy.',
    );
  }
  const latestAcceptance = await getSharedContainerAcceptance(
    request.containerId,
  );
  if (
    !latestAcceptance ||
    latestAcceptance.acceptedAt !== accepted.acceptedAt ||
    latestAcceptance.organizationId !== accepted.organizationId ||
    latestAcceptance.access !== accepted.access
  ) {
    throw new SharedContainerForkError(
      'source-unavailable',
      'The share’s access changed. Open the share again before making a copy.',
    );
  }

  return {
    owner:
      access === 'organization' && organizationId
        ? { kind: 'organization', organizationId }
        : { kind: 'personal' },
    organizationId,
    organizationName: source.organizationName,
    acceptedAt: accepted.acceptedAt,
    access,
  };
}

export function assertNewForkOwner(
  destination: Extract<
    SharedContainerForkDestination,
    { kind: 'new-workspace' }
  >,
  owner: WorkspaceContext,
): void {
  if (!isSameWorkspaceContext(destination.owner, owner)) {
    throw new SharedContainerForkError(
      'owner-mismatch',
      'The copy must stay in the context where the share was accepted.',
    );
  }
}

/** Read the canonical binding; sidebar projections can hide malformed owners. */
export async function assertForkWorkspaceOwner(
  workspaceId: string,
  owner: WorkspaceContext,
  authorize = false,
): Promise<void> {
  const current = await readWorkspaceOwnership(workspaceId);
  if (current.authority !== 'ok') {
    throw new SharedContainerForkError(
      'destination-unavailable',
      'This workspace is unavailable. Choose another destination.',
    );
  }
  const binding = classifyPersistedWorkspaceOwner(current.owner);
  if (
    binding.kind === 'malformed' ||
    (owner.kind === 'personal'
      ? binding.kind !== 'personal'
      : binding.kind !== 'organization' ||
        binding.owner.organizationId !== owner.organizationId)
  ) {
    throw new SharedContainerForkError(
      'owner-mismatch',
      'This workspace belongs to a different context. Choose another destination.',
    );
  }
  if (
    authorize &&
    owner.kind === 'organization' &&
    binding.kind === 'organization'
  ) {
    const { getOrgProjectCatalogService } =
      await import('../../services/org-project-catalog-service');
    let snapshot;
    try {
      snapshot = await getOrgProjectCatalogService().refresh(owner, {
        force: true,
      });
    } catch {
      throw new SharedContainerForkError(
        'destination-unavailable',
        'This organization workspace is unavailable. The copy wasn’t made.',
      );
    }
    const project = snapshot.projects.find(
      (item) => item.id === binding.owner.projectId,
    );
    if (
      snapshot.stale ||
      snapshot.error ||
      !project ||
      project.organizationId !== owner.organizationId ||
      !project.capabilities.use ||
      project.state !== 'ACTIVE' ||
      project.location !== 'LOCAL' ||
      project.kind !== (current.type === 'cowork' ? 'COWORK' : 'CODE') ||
      project.instance?.id !== binding.owner.instanceId ||
      project.instance.state !== 'READY'
    ) {
      throw new SharedContainerForkError(
        'destination-unavailable',
        'This organization workspace is unavailable. The copy wasn’t made.',
      );
    }
    // The network read can outlive a local ownership transfer. Match the exact
    // binding it authorized before permitting the next local effect.
    const latest = await readWorkspaceOwnership(workspaceId);
    const latestBinding = classifyPersistedWorkspaceOwner(
      latest.authority === 'ok' ? latest.owner : null,
    );
    if (
      latest.authority !== 'ok' ||
      latest.type !== current.type ||
      latestBinding.kind !== 'organization' ||
      latestBinding.owner.organizationId !== binding.owner.organizationId ||
      latestBinding.owner.projectId !== binding.owner.projectId ||
      latestBinding.owner.instanceId !== binding.owner.instanceId ||
      latestBinding.owner.bindingGeneration !== binding.owner.bindingGeneration
    ) {
      throw new SharedContainerForkError(
        'destination-unavailable',
        'This workspace changed while making the copy. Choose the destination again.',
      );
    }
  }
}
