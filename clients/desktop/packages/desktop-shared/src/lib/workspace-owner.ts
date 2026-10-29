import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  classifyPersistedWorkspaceOwner,
  normalizeUuid,
} from '@canopy/protocol/workspace-owner';
import type {
  WorkspaceOwnerBinding,
  WorkspaceOwnershipTransfer,
} from '../types';

export {
  classifyPersistedWorkspaceOwner,
  normalizeUuid,
  type PersistedWorkspaceOwnerClassification,
} from '@canopy/protocol/workspace-owner';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize a persisted `workspace.json` owner for display. Anything malformed
 * reads as Personal (`undefined`) rather than failing the workspace read,
 * because a corrupt binding must never hide a checkout the user still has on
 * disk. Authority readers use `classifyPersistedWorkspaceOwner` and fail closed.
 */
export function normalizeWorkspaceOwner(
  value: unknown,
): WorkspaceOwnerBinding | undefined {
  const classified = classifyPersistedWorkspaceOwner(value);
  return classified.kind === 'organization'
    ? { ...classified.owner }
    : undefined;
}

function readTimestamp(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

/**
 * Normalize a persisted `workspace.json` conversion record (CAN-3415).
 * Malformed records read as absent: the record is history, never authority,
 * so it cannot bind or hide a workspace on its own.
 */
export function normalizeWorkspaceOwnershipTransfer(
  value: unknown,
): WorkspaceOwnershipTransfer | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isRecord(value.previousOwner) ||
    value.previousOwner.type !== 'personal'
  )
    return undefined;
  const organizationId = normalizeUuid(value.organizationId);
  const projectId = normalizeUuid(value.projectId);
  const convertedAt = readTimestamp(value.convertedAt);
  const movedBackAt =
    value.movedBackAt === undefined
      ? undefined
      : readTimestamp(value.movedBackAt);
  if (
    organizationId === null ||
    projectId === null ||
    convertedAt === null ||
    movedBackAt === null
  )
    return undefined;
  return {
    version: 1,
    previousOwner: { type: 'personal' },
    organizationId,
    projectId,
    convertedAt,
    ...(movedBackAt === undefined ? {} : { movedBackAt }),
  };
}

/**
 * The context-scoping rule (plan chapter 03): Personal shows rows without an
 * owner; an organization context shows only rows that organization owns. A
 * missing context means "no scoping" so callers that predate contexts keep
 * today's list.
 */
export function workspaceOwnerMatchesContext(
  owner: Pick<WorkspaceOwnerBinding, 'type' | 'organizationId'> | undefined,
  context: WorkspaceContext | undefined,
): boolean {
  if (context === undefined) return true;
  if (context.kind === 'personal') return owner === undefined;
  return owner !== undefined && owner.organizationId === context.organizationId;
}
