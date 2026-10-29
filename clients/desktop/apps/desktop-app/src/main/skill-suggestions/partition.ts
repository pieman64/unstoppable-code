import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import {
  peekSessionWorkOwner,
  resolveBackgroundWorkOwner,
} from '../agents/work-owner';
import { resolveLocalMemoryPolicy } from '../memory/local/policy';

/**
 * Compliance boundary for repeat-task skill suggestions (CAN-385). Every
 * recorded turn belongs to exactly one partition, and a scan, a match or a
 * helper call never combines partitions:
 *
 * - `personal`
 * - `org:<organizationId>`
 * - `<owner>/private:<workspaceId>` for a private-memory workspace, where
 *   `<owner>` is one of the two keys above.
 */
export type SkillSuggestionPartitionKey = string;

export interface SkillSuggestionPartition {
  key: SkillSuggestionPartitionKey;
  owner: WorkOwner;
  /** Set for a private-memory workspace; such partitions never expose text. */
  privateWorkspaceId: string | null;
}

const PRIVATE_SEPARATOR = '/private:';

function ownerKey(owner: WorkOwner): string {
  return owner.kind === 'organization'
    ? `org:${owner.organizationId}`
    : 'personal';
}

export function partitionKeyFor(
  owner: WorkOwner,
  privateWorkspaceId: string | null,
): SkillSuggestionPartitionKey {
  const base = ownerKey(owner);
  return privateWorkspaceId === null
    ? base
    : `${base}${PRIVATE_SEPARATOR}${privateWorkspaceId}`;
}

function parseOwnerKey(key: string): WorkOwner | null {
  if (key === 'personal') return { kind: 'personal' };
  if (key.startsWith('org:') && key.length > 'org:'.length) {
    return { kind: 'organization', organizationId: key.slice('org:'.length) };
  }
  return null;
}

export function parsePartitionKey(
  key: SkillSuggestionPartitionKey,
): SkillSuggestionPartition | null {
  const index = key.indexOf(PRIVATE_SEPARATOR);
  const owner = parseOwnerKey(index === -1 ? key : key.slice(0, index));
  if (!owner) return null;
  if (index === -1) return { key, owner, privateWorkspaceId: null };
  const workspaceId = key.slice(index + PRIVATE_SEPARATOR.length);
  return workspaceId ? { key, owner, privateWorkspaceId: workspaceId } : null;
}

export function isPrivatePartition(key: SkillSuggestionPartitionKey): boolean {
  return key.includes(PRIVATE_SEPARATOR);
}

/** Whether `key` belongs to a private partition of `workspaceId`. */
export function isPrivatePartitionOfWorkspace(
  key: SkillSuggestionPartitionKey,
  workspaceId: string,
): boolean {
  return key.endsWith(`${PRIVATE_SEPARATOR}${workspaceId}`);
}

export interface PartitionTurnIds {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

export interface PartitionResolverDeps {
  resolvePolicy: typeof resolveLocalMemoryPolicy;
  peekSessionOwner: typeof peekSessionWorkOwner;
  resolvePersistedOwner: (
    workspaceId: string,
  ) => Promise<WorkOwner | undefined>;
}

const defaultDeps: PartitionResolverDeps = {
  resolvePolicy: resolveLocalMemoryPolicy,
  peekSessionOwner: peekSessionWorkOwner,
  // In the Personal context the persisted workspace owner decides.
  resolvePersistedOwner: (workspaceId) =>
    resolveBackgroundWorkOwner({ projectId: workspaceId }, undefined),
};

/**
 * The partition a turn belongs to, or `null` when it must not be recorded:
 * the workspace policy is `blocked` or `unscoped`, or no owner is readable.
 * Does not depend on the global local-memory preference.
 */
export async function resolveTurnPartition(
  ids: PartitionTurnIds,
  deps: PartitionResolverDeps = defaultDeps,
): Promise<SkillSuggestionPartition | null> {
  const policy = await deps.resolvePolicy({
    projectId: ids.projectId,
    worktreeId: ids.worktreeId,
  });
  if (policy.kind !== 'scoped') return null;
  const owner =
    (await deps.peekSessionOwner(ids)) ??
    (await deps.resolvePersistedOwner(policy.workspaceId));
  if (!owner) return null;
  const privateWorkspaceId = policy.privateMemory ? policy.workspaceId : null;
  return {
    key: partitionKeyFor(owner, privateWorkspaceId),
    owner,
    privateWorkspaceId,
  };
}
