/**
 * Frozen 11a engine boundary. S2 owns persistence/index algorithms; S3 owns
 * scope authorization and delegation -> target -> scope-lease exclusion.
 * No registry operation checkpoints implicitly or rewrites the parent chat.
 */
import type { DelegationChildRow } from '@canopy/agent-transcript';
import type {
  TranscriptStreamDescriptor,
  TranscriptStreamDescriptorUpdate,
  CardStateDraft,
} from '@canopy/protocol/canopy-core';
import type {
  DelegationTranscriptContentRange,
  DelegationTranscriptCardStateRequest,
  DelegationTranscriptStreamState,
  DelegationTranscriptPortError,
  DelegationTranscriptGeneration,
  DelegationTranscriptGenerationEntry,
  DelegationTranscriptGenerationRegistration,
  DelegationTranscriptGenerationRequest,
  DelegationTranscriptGenerationsPage,
  DelegationTranscriptRegistryIdentity,
  DelegationTranscriptRegistryPageRequest,
  DelegationTranscriptResultAnswerRequest,
  DelegationTranscriptResultEntry,
  DelegationTranscriptResultRequest,
  DelegationTranscriptResultsPage,
  DelegationTranscriptReceiptAppendResult,
  DelegationTranscriptReceiptEntry,
  DelegationTranscriptReceiptIdentity,
  DelegationTranscriptSettleRequest,
  DelegationTranscriptSettleResult,
  DelegationTranscriptTarget,
} from '@canopy/desktop-shared/node/delegation/transcript-port';
import { DELEGATION_REGISTRY_MAX_ENTRY_BYTES } from '@canopy/desktop-shared/node/delegation/transcript-port';
import { canonicalDelegationJson } from '@canopy/desktop-shared/node/delegation/settlement-identity';

/**
 * The one registry size bound, applied to whole effects by both journal
 * validation and the store. Throws when the value is not canonical JSON.
 */
export function delegationRegistryJsonFits(value: unknown): boolean {
  return (
    Buffer.byteLength(canonicalDelegationJson(value), 'utf8') <=
    DELEGATION_REGISTRY_MAX_ENTRY_BYTES
  );
}

/** Portable domain failure, preserved by S3 without matching error messages. */
export type DelegationRegistryFailure = DelegationTranscriptPortError;

/**
 * Ordinary format-4 admission. New/changed revisions atomically acquire
 * writer-built admission metadata. Identical revisions retain their original
 * metadata, never the retry's revision/key. Missing mutationKey is reserved for
 * metadata-less compatibility fixtures and cannot synthesize a replay receipt.
 */
export interface DelegationRegistryChildWrite {
  readonly target: DelegationTranscriptTarget;
  readonly rows: DelegationChildRow[];
  /** Raw caller key, never the hashed crash-retry mutation ID. */
  readonly mutationKey?: string;
  readonly settle?: {
    readonly key: string;
    readonly descriptorUpdate: TranscriptStreamDescriptorUpdate;
  };
}

/** Metadata is outside logical rows, their equality and both row/log digests. */
export interface DelegationItemAdmissionMetadata {
  readonly id: string;
  readonly itemRevision: number;
  readonly admittingStreamRevision: number;
  readonly mutationKey: string;
}

export type DelegationRegistryEntry =
  | DelegationTranscriptGenerationEntry
  | DelegationTranscriptResultEntry
  | DelegationTranscriptReceiptEntry;

/**
 * A registry owner (11c1, C1 engine). Delegation owners keep their exact key
 * (the two-element JSON `[chatId, delegationId]`), path hash, directory and
 * head bytes. The chat's receipts owner uses the three-element key
 * `["#owner", "chat_receipts", chatId]`, which no delegation key can equal, a
 * separately prefixed directory with a domain-tagged hash, and a head that
 * carries `owner: {kind: 'chat_receipts', chatId}`. Old heads decode as
 * delegation owners.
 */
export type DelegationRegistryOwner =
  | {
      readonly kind: 'delegation';
      readonly chatId: string;
      readonly delegationId: string;
    }
  | { readonly kind: 'chat_receipts'; readonly chatId: string };

export type DelegationRegistryJournalEffect =
  | {
      readonly kind: 'delegation-generation';
      readonly identity: DelegationTranscriptRegistryIdentity;
      readonly entry: DelegationTranscriptGenerationEntry;
    }
  | {
      readonly kind: 'delegation-result';
      readonly target: DelegationTranscriptTarget;
      readonly entry: DelegationTranscriptResultEntry;
    }
  | {
      readonly kind: 'child-admission';
      readonly target: DelegationTranscriptTarget;
      readonly items: readonly DelegationItemAdmissionMetadata[];
    }
  | {
      /** Exactly `delegationReceiptEffect(entry)`; the 16 KiB bound measures it. */
      readonly kind: 'delegation-receipt';
      readonly owner: Extract<
        DelegationRegistryOwner,
        { kind: 'chat_receipts' }
      >;
      readonly entry: DelegationTranscriptReceiptEntry;
    };

export interface DelegationAdmissionRequest {
  readonly target: DelegationTranscriptTarget;
  readonly messageId: string;
  readonly itemRevision: number;
}
export type DelegationSettlementKeyRequest =
  DelegationTranscriptRegistryIdentity & {
    readonly settlementKey: string;
  };

/**
 * Final rows, writer-built descriptor receipt and result are one journal mutation.
 * The answer is externalized within admission's maintenance exclusion and delete
 * lease, never before it. The input entry deliberately has no prepared answer or
 * settlement; only the writer can construct those from its admitted rows.
 * Both early replay paths compare all generation/result/admission effects.
 */
export interface DelegationRegistrySettleMutation {
  readonly cardDraft?: CardStateDraft;
  readonly cardRevision?: number;
  readonly target: DelegationTranscriptTarget;
  readonly mutationId: string;
  readonly mutationKey: string;
  readonly finalRows: readonly DelegationChildRow[];
  readonly descriptorSettle: {
    readonly expectedStreamRevision: number;
  };
  readonly resultEntry: Omit<
    DelegationTranscriptResultEntry,
    'answer' | 'settlement'
  >;
  readonly answerBody: DelegationTranscriptSettleRequest['answer'];
  /**
   * `finalize` synthesizes next-revision finals for the remaining stored open
   * rows and admits the combined prepared set through both writer stages.
   */
  readonly openRows: 'reject' | 'finalize';
}

export interface DelegationRegistryReceiptMutation {
  readonly mutationId: string;
  readonly entry: DelegationTranscriptReceiptEntry;
}

export interface DelegationRegistryGenerationMutation {
  readonly mutationId: string;
  readonly registration: DelegationTranscriptGenerationRegistration;
}
export interface DelegationRegistryGenerationResult {
  readonly entry: DelegationTranscriptGenerationEntry;
  readonly replayed: boolean;
}

/** Trusted host context; no filesystem paths and no caller-provided authority. */
export interface DelegationRegistryCursorContext {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly archive:
    | { readonly kind: 'live' }
    | { readonly kind: 'container'; readonly id: string }
    | { readonly kind: 'standalone' };
  /** Changes for an independent storage copy. */
  readonly storageIdentity: string;
}

/**
 * Decoded, validated cursor. The public cursor remains opaque and <=2048 chars.
 * Captured identity binds project/worktree/chat/archive/copy, not host paths.
 * Entries are fixed at highWater, descriptor projections are always current.
 */
export interface DelegationRegistryCursor {
  readonly version: 1;
  /** SHA-256 hex of UTF-8 canonicalDelegationJson(cursorContext). */
  readonly scopeIdentity: string;
  readonly identity: DelegationTranscriptRegistryIdentity;
  readonly kind: 'results' | 'generations';
  readonly position: number;
  readonly highWater: number;
}

/**
 * Domain errors reject with DelegationRegistryOperationError carrying failure.
 * Only missing point entries return undefined. A referenced/known answer body
 * that is missing rejects with corruption, never undefined/not_found. Lost
 * answers reject with answer_unavailable. Unexpected I/O/integrity exceptions
 * retain the existing adapter mappings. S3 must preserve structured failure.
 */
export interface DelegationRegistryReader {
  result(
    input: DelegationTranscriptResultRequest,
  ): Promise<DelegationTranscriptResultEntry | undefined>;
  resultBySettlementKey(
    input: DelegationSettlementKeyRequest,
  ): Promise<DelegationTranscriptResultEntry | undefined>;
  resultByGeneration(
    input: DelegationTranscriptGenerationRequest,
  ): Promise<DelegationTranscriptResultEntry | undefined>;
  generation(
    input: DelegationTranscriptGenerationRequest,
  ): Promise<DelegationTranscriptGeneration | undefined>;
  resultsPage(
    input: DelegationTranscriptRegistryPageRequest,
    context: DelegationRegistryCursorContext,
  ): Promise<DelegationTranscriptResultsPage>;
  generationsPage(
    input: DelegationTranscriptRegistryPageRequest,
    context: DelegationRegistryCursorContext,
  ): Promise<DelegationTranscriptGenerationsPage>;
  resultAnswerRange(
    input: DelegationTranscriptResultAnswerRequest,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptContentRange>;
  itemAdmission(
    input: DelegationAdmissionRequest,
  ): Promise<DelegationItemAdmissionMetadata | undefined>;
  /** Chat-scoped point read; undefined only when absent. */
  receipt(
    input: DelegationTranscriptReceiptIdentity,
  ): Promise<DelegationTranscriptReceiptEntry | undefined>;
}

export interface DelegationRegistryWriter extends DelegationRegistryReader {
  registerGeneration(
    input: DelegationRegistryGenerationMutation,
  ): Promise<DelegationRegistryGenerationResult>;
  settleDelegationResult(
    input: DelegationRegistrySettleMutation,
  ): Promise<DelegationTranscriptSettleResult>;
  /** Identical entry replays; a different entry under the identity is `conflict`. */
  appendDelegationReceipt(
    input: DelegationRegistryReceiptMutation,
  ): Promise<DelegationTranscriptReceiptAppendResult>;
}

/**
 * Scope-facing service/repository calls capture trusted context, not a portable
 * request field. S3 supplies it to the engine/backend's required page argument;
 * S2 validates its scopeIdentity and reports invalid_request on mismatch.
 */
export interface DelegationRegistryOperations extends Omit<
  DelegationRegistryReader,
  'resultsPage' | 'generationsPage'
> {
  updateCardState(
    input: DelegationTranscriptCardStateRequest,
  ): Promise<DelegationTranscriptStreamState>;
  resultsPage(
    input: DelegationTranscriptRegistryPageRequest,
  ): Promise<DelegationTranscriptResultsPage>;
  generationsPage(
    input: DelegationTranscriptRegistryPageRequest,
  ): Promise<DelegationTranscriptGenerationsPage>;
  registerGeneration(
    input: DelegationTranscriptGenerationRegistration,
  ): Promise<DelegationRegistryGenerationResult>;
  settleDelegationResult(
    input: DelegationTranscriptSettleRequest,
  ): Promise<DelegationTranscriptSettleResult>;
  appendDelegationReceipt(
    input: DelegationTranscriptReceiptEntry,
  ): Promise<DelegationTranscriptReceiptAppendResult>;
}

/**
 * Checkpoint appends only entries after highWater. Verified segments are
 * append-only; the index is rebuildable, not canonical. Work must not grow with
 * retained entries for fixed-size appends, checkpoint batches or point reads.
 */
export interface DelegationRegistryCheckpoint {
  /** Delegation identities stay as in 11a; the receipts owner is tagged. */
  readonly identity:
    | DelegationTranscriptRegistryIdentity
    | Extract<DelegationRegistryOwner, { kind: 'chat_receipts' }>;
  readonly highWater: number;
  readonly entriesSha256: string;
}
export interface DelegationRegistryCheckpointReader extends DelegationRegistryReader {
  highWater(
    input: DelegationRegistryCheckpoint['identity'],
  ): Promise<DelegationRegistryCheckpoint>;
  /** Enumerates answer-only refs too; used for closure/capture/GC/delete fencing. */
  answerReferences(
    chatId: string,
  ): AsyncIterable<
    Extract<DelegationTranscriptResultEntry['answer'], { kind: 'body' }>['ref']
  >;
}
export interface DelegationRegistryCheckpointWriter {
  checkpointDelegationRegistry(
    input: DelegationRegistryCheckpoint,
  ): Promise<DelegationRegistryCheckpoint>;
}

/** Lease-free replay and no-journal checkpoint reads expose identical semantics. */
export interface DelegationRegistryReadView {
  /** Registry and descriptor accessors remain valid until dispose resolves. */
  readonly registry: DelegationRegistryCheckpointReader;
  dispose(): Promise<void>;
  descriptor(
    target: DelegationTranscriptTarget,
  ): Promise<TranscriptStreamDescriptor | undefined>;
}
