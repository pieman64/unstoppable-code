/** Unknown is an observation state, never an empty OID or a guessed identity. */
export type ReplicaObservation<T> =
  | { state: 'unknown' }
  | { state: 'known'; value: T };

export type ReplicaRemoteIdentity =
  | { state: 'local-only' }
  | ReplicaObservation<string>;

export interface WorktreeRepositoryReplica {
  authorityId: string;
  workspaceId: string;
  worktreeId: string;
  repoId: string;
  /** Target ids are scoped to the owning primary, including the local target. */
  targetId: { primaryAuthorityId: string; targetId: string };
  replicaId: string;
  remoteIdentity: ReplicaRemoteIdentity;
  branchName: ReplicaObservation<string>;
  baseOid: ReplicaObservation<string>;
  localHeadOid: ReplicaObservation<string>;
  observedRemoteHeadOid: ReplicaObservation<string>;
  expectedRemoteHeadOid: ReplicaObservation<string>;
  syncMode:
    | { state: 'unconfigured' }
    | {
        state: 'configured';
        mode: 'handoff' | 'shared-branch' | 'isolated-branch';
      };
  syncState:
    | 'not-yet-observed'
    | 'provisioning'
    | 'in_sync'
    | 'ahead'
    | 'behind'
    | 'diverged'
    | 'conflicted'
    | 'reconciling'
    | 'unavailable';
}

/** Revision belongs to the set; there is deliberately no aggregate sync state. */
export type WorktreeReplicaState =
  | { state: 'never-recorded' }
  | { state: 'unreadable' }
  | {
      state: 'recorded';
      primarySnapshotRevision: ReplicaObservation<number>;
      repositories: WorktreeRepositoryReplica[];
    };
