/**
 * Frozen phase 11b reader contract (A0). S1 implements the resolvers and the
 * compatibility page; S2 (service) and S3 (recovery, watchers) consume them.
 * See `.mini-swarm/root-plan-11b.md` B1–B8.
 */
import type {
  AgentDelegationSnapshot,
  AgentDelegationSpawnRequest,
  AgentDelegationStatus,
  AgentDelegationTranscriptItem,
} from '@canopy/protocol/delegation';
import type { StoredDelegation } from '@canopy/desktop-shared/node/delegation/broker';
import type {
  DelegationReadMetadataSource,
  DelegationRecordReadMetadata,
} from '@canopy/desktop-shared/node/delegation/record-read-metadata';
import type {
  DelegationTranscriptGenerationEntry,
  DelegationTranscriptPortError,
  DelegationTranscriptResultEntry,
  DelegationTranscriptStreamState,
  DelegationTranscriptTarget,
} from '@canopy/desktop-shared/node/delegation/transcript-port';

/** A record as readers see it: validated read metadata beside the record. */
export interface DelegationRecordReadInput {
  readonly record: StoredDelegation;
  /** Absent, or `current.store === 'legacy'`: the unchanged legacy path. */
  readonly readMetadata?: DelegationRecordReadMetadata;
}

export type DelegationGenerationTask = Pick<
  AgentDelegationSpawnRequest,
  'description' | 'prompt' | 'executionMode'
>;

/**
 * One generation after the B2 decision table. `stream` covers rules 1, 3 and
 * 4; `settling` is rule 2; `content_unavailable` keeps metadata beside a
 * typed failure.
 */
export type ResolvedDelegationGeneration =
  | { readonly kind: 'legacy'; readonly runGeneration: number }
  | {
      readonly kind: 'stream';
      readonly runGeneration: number;
      readonly target: DelegationTranscriptTarget;
      readonly entry: DelegationTranscriptGenerationEntry;
      readonly stream: DelegationTranscriptStreamState | null;
      readonly result: DelegationTranscriptResultEntry | null;
      /** Always equal to `snapshot.status`. */
      readonly status: AgentDelegationStatus;
      /**
       * S1's B2 projection: canonical result fields and times win and clear
       * missing record values; only the current generation carries record-owned
       * execution, control, route, permission and nesting metadata; previews
       * come solely from this generation's stored card, never record bodies or
       * hydrated references. S2 uses it as the public snapshot unchanged.
       */
      readonly snapshot: AgentDelegationSnapshot;
      /** Maps to the public `runStartedAt`. */
      readonly startedAt?: number;
      /** Maps to the public `runSettledAt`. */
      readonly finishedAt?: number;
      readonly task: DelegationGenerationTask;
      /** The card or its anchor was missing: task fields are empty, never borrowed. */
      readonly taskUnavailable?: true;
    }
  | {
      readonly kind: 'settling';
      readonly runGeneration: number;
      readonly target: DelegationTranscriptTarget;
      readonly entry: DelegationTranscriptGenerationEntry;
      readonly stream: DelegationTranscriptStreamState | null;
      /** As for `stream`, with no result and running status (B2 rule 2). */
      readonly snapshot: AgentDelegationSnapshot & {
        readonly status: 'running';
      };
      readonly startedAt?: number;
      readonly finishedAt?: number;
      readonly task: DelegationGenerationTask;
      readonly taskUnavailable?: true;
    }
  | {
      readonly kind: 'content_unavailable';
      readonly runGeneration: number;
      readonly target: DelegationTranscriptTarget;
      readonly failure: DelegationTranscriptPortError;
    };

/** The watcher's metadata-only view of one captured generation (B6). */
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

/** Consumer-specific resolvers; each states the reads it may perform (B2). */
export interface DelegationRecordReader {
  /** Roots: the capsule plus at most one current-generation descriptor. */
  resolveActivity(input: DelegationRecordReadInput): Promise<number>;
  /** Watcher restart: a generation point read, falling back to result-by-generation. */
  resolveGenerationOutcome(
    input: DelegationRecordReadInput,
    runGeneration: number,
  ): Promise<DelegationGenerationOutcome>;
  /** Transcript page header: the outcome plus at most one stored parent-card read. */
  resolveGenerationHeader(
    input: DelegationRecordReadInput,
    runGeneration: number,
  ): Promise<ResolvedDelegationGeneration>;
  /** Tree: the legacy prefix plus metadata-only generation pages and one card read each. */
  resolveGenerationList(
    input: DelegationRecordReadInput,
  ): Promise<readonly ResolvedDelegationGeneration[]>;
}

/** B3 limits, frozen. */
export const DELEGATION_COMPATIBILITY_PAGE_LIMITS = Object.freeze({
  maxRows: 200,
  physicalBytes: 8 * 1024 * 1024,
  encodedBytes: 4 * 1024 * 1024,
  inlineFieldBytes: 64 * 1024,
  staleRetries: 2,
});

/** B3 omission notices; their bytes count inside every budget. */
export const DELEGATION_COMPATIBILITY_NOTICES = Object.freeze({
  image: '[Image omitted from transcript preview.]',
  images: '\n[Images omitted from transcript preview.]',
  truncated: '\n[Truncated in transcript preview.]',
});

export interface ChildStreamCompatibilityPageRequest {
  readonly target: DelegationTranscriptTarget;
  /** The descriptor revision the caller read; the page pins its normalized read revision. */
  readonly streamRevision: number;
  /** Strictly-before boundary on `delegationSequence`; absent for the newest page. */
  readonly beforeSequence?: number;
  /** Rows, 1–200. */
  readonly limit: number;
  /** Encoded bytes left after the service's own envelope (B3a). */
  readonly encodedBudget: number;
}

export type ChildStreamCompatibilityPageReply =
  | {
      readonly ok: true;
      /** Ascending; a contiguous newest suffix below `beforeSequence`. */
      readonly items: readonly AgentDelegationTranscriptItem[];
      /** Eligible older rows remain. */
      readonly hasMore: boolean;
      /** Current descriptor revision: public `revision`, `sinceRevision` checks. */
      readonly streamRevision: number;
      /** Normalized read revision the page was read at. */
      readonly readRevision: number;
    }
  | {
      readonly ok: false;
      readonly code: 'invalid_request' | 'not_found' | 'failed';
      /** Internal diagnostic; callers show fixed copy. */
      readonly reason: string;
    };

/** Options the repository passes to the recovery loader (B4). */
export interface DelegationRecoveryLoaderOptions {
  readonly readMetadata?: DelegationReadMetadataSource;
}

/** 11c adopts this for the broker watch bootstrap; 11b only freezes it (B6). */
export interface DelegationWatchBootstrapResolver {
  resolve(
    input: DelegationRecordReadInput,
    runGeneration: number,
  ): Promise<DelegationGenerationOutcome>;
}
