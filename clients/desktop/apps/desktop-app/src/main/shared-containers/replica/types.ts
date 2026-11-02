import type { SharedContainerReplicaState } from '@canopy/desktop-shared/types';
import type { SharedContainerContentRepresentation } from '@canopy/protocol/shared-containers';

export type {
  SharedContainerReplicaState,
  SharedContainerSyncPhase,
  SharedContainerSyncPhaseEvent,
} from '@canopy/desktop-shared/types';

export interface SharedContainerCachedArtifact {
  artifactId: string;
  revisionId: string;
  path: string;
  representation: SharedContainerContentRepresentation;
  hash: string;
  objectSizeBytes: string;
}

export interface SharedContainerReplicaIndex {
  version: 1;
  containers: Record<string, SharedContainerReplicaState>;
  /** Container -> stable logical artifact id -> last verified local copy. */
  artifacts: Record<string, Record<string, SharedContainerCachedArtifact>>;
  /** Container -> durable id of the promotion committed with its index state. */
  promotionCommits: Record<string, string>;
}

/** Metadata captured under the same mutation lock as the revision root. */
export interface SharedContainerReplicaRevisionSnapshot {
  revisionId: string;
  revisionCreatedAt: string;
}

/** Only an explicit state mismatch is an expected availability refusal. */
export class SharedContainerReplicaRevisionUnavailableError extends Error {
  constructor(readonly reason: 'superseded' | 'unavailable') {
    super('Shared-container revision is not available');
    this.name = 'SharedContainerReplicaRevisionUnavailableError';
  }
}
