import type { LocalMemoryScopeRequest } from '@canopy/desktop-shared/types';
import { getUserMemoryDir, getWorkspaceMemoryDir } from '../../lib/paths';

/**
 * Where a memory scope's files live, as the cloud memory sync design's
 * resolver (docs/planning/2026-10-27-cloud-memory-sync/README.md §16.4)
 * decides it: the signed-in account's replica of the scope when this device
 * holds one, otherwise the device-local folder.
 */
export interface ResolvedLocalMemoryScope {
  scope: LocalMemoryScopeRequest;
  dir: string;
  location: 'device-local' | 'account-replica';
  /** The account whose replica holds the scope; null for a device-local one. */
  accountId: string | null;
}

/**
 * The account replicas this device holds. The sync engine (CAN-5185)
 * installs one; until then no replica exists and nothing asks for the
 * account.
 */
export interface LocalMemoryReplicaLocator {
  /** The signed-in account's ID; null when signed out or a guest. */
  signedInAccountId(): string | null;
  /**
   * The account's replica folder for the scope when one exists, whatever
   * its sync state (syncing, paused, device-only or deleted in the cloud).
   */
  replicaDir(accountId: string, scope: LocalMemoryScopeRequest): string | null;
}

let replicaLocator: LocalMemoryReplicaLocator | null = null;

/** Installs (or, with null, removes) the replica locator. */
export function setLocalMemoryReplicaLocator(
  locator: LocalMemoryReplicaLocator | null,
): void {
  replicaLocator = locator;
}

function deviceLocalDir(scope: LocalMemoryScopeRequest): string {
  return scope.scope === 'user'
    ? getUserMemoryDir()
    : getWorkspaceMemoryDir(scope.workspaceId);
}

function accountReplica(
  scope: LocalMemoryScopeRequest,
): { accountId: string; dir: string } | null {
  const accountId = replicaLocator?.signedInAccountId() ?? null;
  if (accountId === null) return null;
  const dir = replicaLocator?.replicaDir(accountId, scope) ?? null;
  return dir ? { accountId, dir } : null;
}

/**
 * The one mapping from a scope to its folder: every local memory reader and
 * writer resolves its scope here. Synchronous and free of I/O, so the turn
 * path pays nothing for it.
 */
export function resolveLocalMemoryScope(
  scope: LocalMemoryScopeRequest,
): ResolvedLocalMemoryScope {
  const replica = accountReplica(scope);
  return replica
    ? {
        scope,
        dir: replica.dir,
        location: 'account-replica',
        accountId: replica.accountId,
      }
    : {
        scope,
        dir: deviceLocalDir(scope),
        location: 'device-local',
        accountId: null,
      };
}

/** The folder {@link resolveLocalMemoryScope} picks for the scope. */
export function localMemoryScopeDir(scope: LocalMemoryScopeRequest): string {
  return accountReplica(scope)?.dir ?? deviceLocalDir(scope);
}
