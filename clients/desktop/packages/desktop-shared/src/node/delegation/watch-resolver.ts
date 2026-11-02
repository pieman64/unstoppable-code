import type { StoredDelegation } from './broker';
import type { DelegationRecordReadMetadata } from './record-read-metadata';
import type { StoredDelegationV3 } from './record-v3';
import type {
  DelegationTranscriptPortError,
  DelegationTranscriptResultEntry,
} from './transcript-port';

/** A body-free record and its validated canonical capsule for bootstrap reads. */
export interface DelegationWatchBootstrapInput {
  readonly record: StoredDelegation | StoredDelegationV3;
  readonly readMetadata?: DelegationRecordReadMetadata;
}

/** Metadata-only outcome for one captured generation. */
export type DelegationGenerationOutcome =
  | { readonly kind: 'unsettled' }
  | {
      readonly kind: 'settled';
      readonly result: DelegationTranscriptResultEntry;
    }
  | {
      readonly kind: 'unavailable';
      readonly failure: DelegationTranscriptPortError;
    };

/**
 * Structural seam shared by watch bootstrap and registration catch-up. A
 * resolver pins the requested generation and reads canonical metadata only.
 */
export interface DelegationWatchBootstrapResolver {
  resolve(
    input: DelegationWatchBootstrapInput,
    runGeneration: number,
  ): Promise<DelegationGenerationOutcome>;
}
