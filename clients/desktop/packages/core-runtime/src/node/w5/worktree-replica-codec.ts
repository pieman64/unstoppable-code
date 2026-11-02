import { WORKSPACE_ROOT_REPO_ID } from '@canopy/protocol/ui-labels';
import type {
  ReplicaObservation,
  ReplicaRemoteIdentity,
  WorktreeReplicaState,
  WorktreeRepositoryReplica,
} from '@canopy/protocol/worktree-replica';
import { isJsonObject, withUnknownFields } from './file-store';

/** Desktop main's `validateId` charset; any other identity is unreadable. */
const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;

function id(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value))
    throw new Error(
      'Invalid replica identity: must be lowercase alphanumeric with hyphens',
    );
  return value;
}

function observation<T>(
  value: unknown,
  validate: (value: unknown) => T,
): ReplicaObservation<T> {
  if (!isJsonObject(value)) throw new Error('Invalid observation');
  if (value.state === 'unknown' && value.value === undefined)
    return { state: 'unknown' };
  if (value.state === 'known')
    return { state: 'known', value: validate(value.value) };
  throw new Error('Invalid observation');
}

function oid(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)
  )
    throw new Error('Invalid OID');
  return value;
}

function branch(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 512 ||
    /[\s:\\]|^\//.test(value) ||
    value
      .split('')
      .some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
  )
    throw new Error('Invalid branch');
  return value;
}

/** Old rows can carry display-only or invalid branch names; do not block their writes. */
export function observeReplicaBranch(
  value: string,
): ReplicaObservation<string> {
  try {
    return { state: 'known', value: branch(value) };
  } catch {
    return { state: 'unknown' };
  }
}

function remote(value: unknown): ReplicaRemoteIdentity {
  if (
    isJsonObject(value) &&
    value.state === 'local-only' &&
    value.value === undefined
  )
    return { state: 'local-only' };
  return observation(value, (fingerprint) => {
    if (
      typeof fingerprint !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(fingerprint)
    )
      throw new Error('Invalid remote fingerprint');
    return fingerprint;
  });
}

function syncMode(value: unknown): WorktreeRepositoryReplica['syncMode'] {
  if (!isJsonObject(value)) throw new Error('Invalid sync mode');
  if (value.state === 'unconfigured' && value.mode === undefined)
    return { state: 'unconfigured' };
  if (
    value.state === 'configured' &&
    (value.mode === 'handoff' ||
      value.mode === 'shared-branch' ||
      value.mode === 'isolated-branch')
  )
    return { state: 'configured', mode: value.mode };
  throw new Error('Invalid sync mode');
}

function syncState(value: unknown): WorktreeRepositoryReplica['syncState'] {
  switch (value) {
    case 'not-yet-observed':
    case 'provisioning':
    case 'in_sync':
    case 'ahead':
    case 'behind':
    case 'diverged':
    case 'conflicted':
    case 'reconciling':
    case 'unavailable':
      return value;
    default:
      throw new Error('Invalid sync state');
  }
}

function repository(
  value: unknown,
  workspaceId: string,
  worktreeId: string,
): WorktreeRepositoryReplica {
  if (!isJsonObject(value) || !isJsonObject(value.targetId))
    throw new Error('Invalid replica');
  const authorityId = id(value.authorityId);
  if (
    value.workspaceId !== workspaceId ||
    value.worktreeId !== worktreeId ||
    value.targetId.primaryAuthorityId !== authorityId
  )
    throw new Error('Mismatched replica identity');
  return {
    authorityId,
    workspaceId: id(value.workspaceId),
    worktreeId: id(value.worktreeId),
    repoId:
      value.repoId === WORKSPACE_ROOT_REPO_ID
        ? WORKSPACE_ROOT_REPO_ID
        : id(value.repoId),
    targetId: {
      primaryAuthorityId: authorityId,
      targetId:
        value.targetId.targetId === 'in_process_worker'
          ? 'in_process_worker'
          : id(value.targetId.targetId),
    },
    replicaId: id(value.replicaId),
    remoteIdentity: remote(value.remoteIdentity),
    branchName: observation(value.branchName, branch),
    baseOid: observation(value.baseOid, oid),
    localHeadOid: observation(value.localHeadOid, oid),
    observedRemoteHeadOid: observation(value.observedRemoteHeadOid, oid),
    expectedRemoteHeadOid: observation(value.expectedRemoteHeadOid, oid),
    syncMode: syncMode(value.syncMode),
    syncState: syncState(value.syncState),
  };
}

/** Rebuild known fields only: raw extensions must never reach the typed projection. */
export function parseWorktreeReplica(
  value: unknown,
  workspaceId: string,
  worktreeId: string,
): WorktreeReplicaState {
  if (value === undefined) return { state: 'never-recorded' };
  try {
    if (
      !isJsonObject(value) ||
      value.state !== 'recorded' ||
      !Array.isArray(value.repositories) ||
      value.repositories.length === 0
    )
      throw new Error('Invalid replica set');
    const repositories = value.repositories.map((entry: unknown) =>
      repository(entry, workspaceId, worktreeId),
    );
    if (
      new Set(repositories.map((entry) => entry.repoId)).size !==
        repositories.length ||
      !repositories.some((entry) => entry.repoId === WORKSPACE_ROOT_REPO_ID) ||
      repositories.some(
        (entry) => entry.authorityId !== repositories[0]?.authorityId,
      )
    )
      throw new Error('Invalid repository membership');
    return {
      state: 'recorded',
      repositories,
      primarySnapshotRevision: observation(
        value.primarySnapshotRevision,
        (revision) => {
          if (
            typeof revision !== 'number' ||
            !Number.isSafeInteger(revision) ||
            revision < 0
          )
            throw new Error('Invalid revision');
          return revision;
        },
      ),
    };
  } catch {
    return { state: 'unreadable' };
  }
}

const OBSERVATION_FIELDS: ReadonlySet<string> = new Set([
  'primarySnapshotRevision',
  'remoteIdentity',
  'branchName',
  'baseOid',
  'localHeadOid',
  'observedRemoteHeadOid',
  'expectedRemoteHeadOid',
]);

/** Merge extensions recursively, matching repositories by identity rather than order. */
export function serializeWorktreeReplica(
  next: WorktreeReplicaState,
  previous: unknown,
): unknown {
  if (next.state !== 'recorded') return previous;
  // `value` and `mode` belong to the observation and sync-mode shapes: once
  // an observation becomes unknown its old value must not survive as an
  // extension. Elsewhere they are ordinary extension fields.
  function ownedKeys(key: string | undefined): readonly string[] {
    if (key === 'syncMode') return ['mode'];
    return key !== undefined && OBSERVATION_FIELDS.has(key) ? ['value'] : [];
  }
  function merge(value: unknown, old: unknown, key?: string): unknown {
    if (Array.isArray(value)) {
      const oldEntries: unknown[] = Array.isArray(old) ? old : [];
      return value.map((entry: unknown) =>
        merge(
          entry,
          oldEntries.find(
            (candidate) =>
              isJsonObject(candidate) &&
              isJsonObject(entry) &&
              candidate.repoId === entry.repoId &&
              candidate.replicaId === entry.replicaId,
          ),
        ),
      );
    }
    if (!isJsonObject(value)) return value;
    const oldObject = isJsonObject(old) ? old : undefined;
    const merged = withUnknownFields(
      value,
      oldObject,
      new Set([...Object.keys(value), ...ownedKeys(key)]),
    );
    for (const [fieldKey, field] of Object.entries(value))
      merged[fieldKey] = merge(field, oldObject?.[fieldKey], fieldKey);
    return merged;
  }
  return merge(next, previous);
}
