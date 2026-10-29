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
