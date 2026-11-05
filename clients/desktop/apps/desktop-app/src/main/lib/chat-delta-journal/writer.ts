import type {
  DelegationRegistryWriter,
  DelegationRegistryChildWrite,
  DelegationRegistryCheckpoint,
  DelegationRegistryCheckpointReader,
  DelegationRegistryCheckpointWriter,
  DelegationRegistryGenerationMutation,
  DelegationRegistryGenerationResult,
  DelegationRegistryJournalEffect,
  DelegationRegistryReceiptMutation,
  DelegationRegistrySettleMutation,
} from './delegation-registry-api';
/**
 * Delta-journal writer: commits append one framed, checksummed, hash-chained
 * record and sync the journal once; the version 2 index and transcript files
 * become lazy checkpoints.
 *
 * Only the chat state backend (`services/chat-state-v2-backend.ts`) and the
 * canonical repository's promotion use it. Writable scopes default to the
 * journal (`chat-delta-journal-write-surface.test.ts` enforces the allowlist).
 *
 * Commit order:
 * 1. Validate the revision, mutation identities and index membership.
 * 2. Externalize tool outputs over the inline budget; each artifact is synced
 *    and published before the record that references it.
 * 3. Admit the record against the in-memory transcript view, exactly where a
 *    checkpoint applying it would throw, so a journaled record always applies.
 * 4. Write the frame at the end of the verified prefix and sync the journal.
 *    Only then is the commit acknowledged. A failure once the write began
 *    leaves the writer unusable until it is reopened, because the record may
 *    be durable; its artifacts are kept.
 *
 * Group commit (`admit`, `group-commit.ts`): steps 1 to 3 run per
 * transaction and advance the in-memory state at once; step 4 is shared.
 * With no append in flight a record is written and synced immediately;
 * records admitted meanwhile are written with one append and one sync when
 * it completes, at most 256 records or 1 MiB per batch. Until a record's
 * batch is synced the in-memory state is ahead of the journal: a caller must
 * not acknowledge or publish before the record's `durable` promise resolves,
 * and every operation other than the next admission waits for the queue to
 * drain first.
 *
 * Checkpoint order (see `docs/desktop-chat-state-ownership.md`):
 * marker → transcript effects → staged index files, synced → marker
 * `publishing` → renames → directory sync → journal rotation → marker
 * removal. Recovery resumes any step.
 *
 * Transcript effects are applied in record order, except that a chat's run
 * of active-projection updates that carry their resulting transcript
 * revision is written once, at the end of the run, with that revision: the
 * files equal those of writing every update in turn. A run never spans a
 * record that changes committed rows; such a record is applied on its own,
 * between progress markers, after every open run is written. Each run write
 * is absolute, so a resumed checkpoint may repeat it.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalCardState,
  chooseSettlementCardDraft,
} from '@canopy/desktop-shared/node/delegation/card-state-rules';
import { CardStateV2Schema } from '@canopy/protocol/canopy-core';
import { isDeepStrictEqual } from 'node:util';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TranscriptDescriptor } from '@canopy/agent-transcript/transcript-storage';
import type { DelegationChildRow } from '@canopy/agent-transcript';
import type {
  PersistedChatMessage,
  PersistedCommandReceipt,
} from '@canopy/desktop-shared/types';
import {
  recordChatStorageAtomicReplacement,
  recordChatStorageDeltaJournalCheckpoint,
  recordChatStorageFileSync,
  recordChatStorageFileWrite,
  recordChatStorageIndexSerializations,
} from '@canopy/desktop-shared/node/work-counters';
import {
  artifactRelativePath,
  storedArtifactRefsOf,
} from '../chat-artifact-references';
import {
  assertChatStorageIndexes,
  type ChatStorageV2,
} from '../chat-storage-v2';
import type { ChatStorageIndexes } from '../chat-storage-transactions';
import {
  assertTranscriptIdentity,
  CreatedArtifacts,
} from '../chat-transcript-artifacts';
import {
  assertTranscriptRowWithinLimit,
  ChatTranscriptLog,
  TranscriptStreamStore,
  isDelegationChildRow,
  prepareRowsWithActiveTail,
  transcriptFieldPolicy,
  type TranscriptActiveProjection,
  type TranscriptFieldMode,
} from '../chat-transcript-log';
import type { ActiveRowAnchor } from '../chat-transcript-live-positions';
import {
  iterateAsync,
  writeBufferFully,
  writeJsonValuesCooperatively,
} from '../cooperative-json';
import type { FileHandle } from 'node:fs/promises';
import { mapWithConcurrency } from '../concurrency';
import { fsyncDirectory } from '../fsync-directory';
import { isPathInside } from '../path-safety';
import { isErrnoException, isRecord } from '../type-guards';
import {
  assertNoNewerChatStorageManifest,
  ChatDeltaJournalIntegrityError,
  DELTA_CHECKPOINT_MARKER_NAME,
  DELTA_CHECKPOINT_STAGED_SUFFIX,
  DELTA_CHECKPOINT_WORK_DIRECTORY,
  DELTA_JOURNAL_FILE_NAME,
  DELTA_JOURNAL_V2_FILE_NAME,
  DELTA_JOURNAL_V2_FORMAT,
  DELTA_JOURNAL_V2_GENESIS_DIGEST,
  DELTA_JOURNAL_FORMAT,
  DELTA_JOURNAL_GENESIS_DIGEST,
  DELTA_JOURNAL_MANIFEST_VERSION,
  DELTA_JOURNAL_QUARANTINE_PREFIX,
  FRAME_HEADER_BYTES,
  decodeDeltaJournalRecord,
  decodeDeltaJournalV2Record,
  encodeDeltaJournalFrame,
  isActiveEffect,
  isDeltaJournalStorageManifest,
  journalFileFor,
  parseChatStorageManifest,
  transcriptTargetKey,
  type DeltaJournalStorageManifest,
  type DeltaJournalTailReason,
  type DeltaJournalTranscriptEffect,
  type DeltaJournalV2TranscriptEffect,
  type Format4StorageManifest,
} from './format';
import type {
  TranscriptStreamDescriptor,
  TranscriptStreamDescriptorUpdate,
  TranscriptStreamRegistration,
  TranscriptTarget,
} from '@canopy/protocol/canopy-core';
import {
  canonicalDelegationJson,
  delegationTranscriptSettlementDigest,
} from '@canopy/desktop-shared/node/delegation/settlement-identity';
import { validateDelegationReceiptEntry } from '@canopy/desktop-shared/node/delegation/receipt-reply';
import {
  type DelegationTranscriptGeneration,
  type DelegationTranscriptGenerationEntry,
  type DelegationTranscriptGenerationRequest,
  type DelegationTranscriptRegistryIdentity,
  type DelegationTranscriptResultAnswerRequest,
  type DelegationTranscriptResultEntry,
  type DelegationTranscriptReceiptAppendResult,
  type DelegationTranscriptReceiptEntry,
  type DelegationTranscriptReceiptIdentity,
  type DelegationTranscriptResultRequest,
  type DelegationTranscriptResultsPage,
  type DelegationTranscriptGenerationsPage,
  type DelegationTranscriptRegistryPageRequest,
  type DelegationTranscriptTarget,
  type DelegationTranscriptContentRange,
  type DelegationTranscriptSettleRequest,
  type DelegationTranscriptSettleResult,
  DELEGATION_REGISTRY_MAX_ENTRY_BYTES,
} from '@canopy/desktop-shared/node/delegation/transcript-port';
import { DelegationRegistryOperationError } from './delegation-registry-error';
import { createDelegationRegistryReader } from './delegation-registry-reader';
import { DelegationRegistryStore } from './delegation-registry-store';
import {
  registryEffectIdentity,
  registryOwner,
  registryOwnerKey,
  type RegistryIdentity,
} from './delegation-registry-owner';
import {
  delegationStreamKey,
  delegationTranscriptPaths,
} from '../transcript-stream-paths';
import {
  createEmptyStreamDescriptor,
  encodeStreamRegistry,
  loadStreamCatalog,
  loadStreamRegistry,
  parseStreamRegistry,
  parseStreamCatalog,
  parseStreamDescriptor,
  applyStreamDescriptorUpdate,
  stageStreamMetadata,
  streamCatalogPath,
  streamRegistryPaths,
  validateStreamClosure,
} from './stream-registry';
import {
  checkpointAnchorCapturePath,
  encodeCheckpointAnchorCapture,
  readCheckpointAnchorCapture,
} from './checkpoint-anchors';
import {
  activeTurnDelta,
  journalCheckpointDue,
  type ActiveTurnDelta,
} from './active-turn';
import { GroupCommitQueue, type GroupCommitBatch } from './group-commit';
import { diffChatIndexes } from './index-delta';
import {
  applyTranscriptEffect,
  withTranscriptDescriptors,
} from './materialize';
import {
  applyRecordMetadata,
  assertJournalCovers,
  DELTA_INDEX_FILE_NAMES,
  readCheckpointState,
  readDeltaJournal,
  recordsAfter,
  replayIndexMetadata,
  verifyRecordArtifacts,
  primaryEffects,
  type JournalCommit,
  type DeltaCheckpointMarker,
  type DeltaCheckpointState,
  type DeltaJournalContents,
} from './replay';
import {
  ChatTranscriptOverlay,
  upsertActiveMessages,
  type TranscriptOverlayBase,
} from './transcript-overlay';
import {
  ChildJournalOverlay,
  readMergedChildStreamPage,
  type ChildStreamCompatibilitySource,
  type ChildStreamPageOptions,
} from './child-overlay';

/** The commit recreates a chat whose deletion a checkpoint must apply first. */
export class DeltaJournalCheckpointRequiredError extends Error {
  public override readonly name = 'DeltaJournalCheckpointRequiredError';
}

/** Journal size at which a checkpoint is due (P1 §A size trigger). */
export const DELTA_JOURNAL_CHECKPOINT_BYTES = 4 * 1024 * 1024;
const QUARANTINE_TEMPORARY_PREFIX = `.${DELTA_JOURNAL_QUARANTINE_PREFIX}`;
/** Streams, or stream metadata files, a checkpoint writes at once. */
const STREAM_METADATA_IO_CONCURRENCY = 16;

type Settled<T> = { ok: true; value: T } | { ok: false };

/**
 * Bounded concurrent `task` over independent streams or their metadata files, results
 * in input order. After a failure no further task starts, and every started
 * one settles before the first failure is rethrown, so no write outlives a
 * failed checkpoint into its retry.
 */
async function eachStreamMetadataFile<T, R>(
  items: readonly T[],
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  let failure: { error: unknown } | undefined;
  const settled = await mapWithConcurrency(
    items,
    STREAM_METADATA_IO_CONCURRENCY,
    async (item): Promise<Settled<R>> => {
      if (failure) return { ok: false };
      try {
        return { ok: true, value: await task(item) };
      } catch (error) {
        failure ??= { error };
        return { ok: false };
      }
    },
  );
  if (failure) throw failure.error;
  return settled.flatMap((outcome): R[] => (outcome.ok ? [outcome.value] : []));
}

/**
 * Per scope directory, advanced before this process publishes a version 2
 * manifest over a version 3 one. A writer captures it when it opens and
 * refuses every operation once it moves, so no writer can append a record
 * while the manifest on disk is version 2, even if removing the journal
 * then fails. A map lookup per operation, never a manifest read.
 */
const manifestGenerations = new Map<string, number>();

function manifestGeneration(directory: string): number {
  return manifestGenerations.get(directory) ?? 0;
}

function quarantineOrdinal(name: string): number | undefined {
  const match = /^delta-journal-tail-quarantine-(\d+)\.bin$/.exec(name);
  return match ? Number(match[1]) : undefined;
}

function isQuarantineTemporary(name: string): boolean {
  return name.startsWith(QUARANTINE_TEMPORARY_PREFIX) && name.endsWith('.tmp');
}

/**
 * An unpublished journal segment or checkpoint marker a crash left behind:
 * its atomic rename never happened, so nothing selects it.
 */
function isJournalTemporary(name: string): boolean {
  return /^(?:delta-journal(?:-v2)?\.log|delta-checkpoint\.json)\.[0-9a-f-]{36}\.tmp$/i.test(
    name,
  );
}

async function removeJournalTemporaries(directory: string): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return false;
    throw error;
  }
  let removed = false;
  for (const name of names)
    if (isJournalTemporary(name)) {
      await rm(join(directory, name), { force: true });
      removed = true;
    }
  if (removed) await fsyncDirectory(directory);
  return removed;
}

/** Retained mutation identities, as in version 2 recovery indexes. */
export const DELTA_JOURNAL_MUTATION_ID_WINDOW = 4096;

/** A transcript effect, in the shape a scope transaction receives. */
export type DeltaJournalWrite =
  | {
      chatId: string;
      target?: TranscriptTarget;
      kind:
        | 'append'
        | 'active'
        | 'active-replace'
        | 'active-upsert'
        | 'replace'
        | 'delete';
      messages?:
        | Iterable<PersistedChatMessage>
        | AsyncIterable<PersistedChatMessage>;
      activeTailCount?: number;
    }
  | {
      chatId: string;
      target?: TranscriptTarget;
      kind: 'patch';
      patches: readonly PersistedChatMessage[];
      removedMessageIds: readonly string[];
      tail: readonly PersistedChatMessage[];
      activeTailCount?: number;
    };

export interface DeltaJournalCommitInput {
  expectedRevision: number;
  /** The complete next indexes, as a version 2 transaction receives them. */
  next: ChatStorageIndexes;
  writes: readonly DeltaJournalWrite[];
  /** Identities this commit adds to `next.recovery.mutationIds`. */
  mutationIds: readonly string[];
  /** Empty-stream registrations; format 4 only. */
  streamRegistrations?: readonly {
    target: Extract<TranscriptTarget, { kind: 'delegation' }>;
    streamKey: string;
    openedAt?: number;
  }[];
  /** Card-only descriptor revisions for registered delegation streams. */
  streamDescriptorUpdates?: readonly {
    target: Extract<TranscriptTarget, { kind: 'delegation' }>;
    update: TranscriptStreamDescriptorUpdate;
  }[];
  childWrites?: readonly DelegationRegistryChildWrite[];
  /** Registry effects joined to the same durable journal record. */
  registryEffects?: readonly DelegationRegistryJournalEffect[];
  /** Artifacts the caller externalized; reclaimed only if nothing is written. */
  created?: CreatedArtifacts;
  /** Refreshes asynchronous authorization inputs before the record is written. */
  preparePublish?: () => Promise<void>;
  /** Synchronous authorization check immediately before the record is written. */
  beforePublish?: () => void;
  /**
   * Group commit's counterpart of `beforePublish`: a synchronous check as the
   * prepared record is queued; throwing discards it unqueued. It holds for
   * the record's place in the journal, because every later checkpoint first
   * makes the queued records durable.
   */
  beforeAdmit?: () => void;
}

export type DeltaJournalCommitResult =
  | { applied: true; revision: number; indexes: ChatStorageIndexes }
  | { applied: false; revision: number };

/** A record admitted for group commit ({@link ChatDeltaJournalWriter.admit}). */
export interface DeltaJournalAdmission {
  /** The admitted revision and indexes; not durable until `durable` settles. */
  result: DeltaJournalCommitResult;
  /**
   * Resolves once the record's batch is synced; rejects when that batch, or
   * one before it, failed. For a retried mutation (`applied: false`) it
   * settles with the records admitted before the retry. Only then may the
   * commit be acknowledged or published.
   */
  durable: Promise<void>;
}

/**
 * Content-free, in `ChatStateStorageDiagnostic`'s field names: the caller
 * adds the scope, `occurredAt` and `storageAuthority`, and records it as a
 * session-events storage diagnostic (never a global app event).
 */
export interface DeltaJournalDiagnostic {
  kind: 'delta_journal_torn_tail_dropped';
  /** Verified journal bytes kept. */
  journalBytes: number;
  /** Unacknowledged bytes dropped after them. */
  recordBytes: number;
  /** Verified records kept. */
  recordCount: number;
  journalTailReason: DeltaJournalTailReason;
  /** Base name of the quarantine copy (`checksum_mismatch` only). */
  journalQuarantineFile?: string;
}

export type DeltaJournalBoundary =
  | 'record-written'
  | 'record-synced'
  | 'tail-quarantined'
  | 'tail-truncated'
  | 'catalog-temp-written'
  | 'catalog-temp-synced'
  | 'segment-temp-written'
  | 'segment-temp-synced'
  | 'segment-renamed'
  | 'segment-directory-synced'
  | 'manifest-published'
  | 'manifest-temp-written'
  | 'manifest-temp-synced'
  | 'manifest-directory-synced'
  | 'writer-reopened'
  | 'checkpoint-transcripts-applied'
  | 'checkpoint-child-append-prepared'
  | 'checkpoint-metadata-staged'
  | 'checkpoint-publishing-marked'
  | 'checkpoint-descriptors-published'
  | 'checkpoint-registries-published'
  | 'checkpoint-catalog-published'
  | 'checkpoint-indexes-published'
  | 'checkpoint-journal-rotated'
  | 'checkpoint-removed-parents'
  | 'marker-removed'
  /** Answer body is durable but the settlement record is not yet admitted. */
  | 'registry-answer-published'
  /** The durable settlement record and in-memory registry overlay are visible. */
  | 'registry-settle-admitted'
  /** Final-row artifact preparation has completed, before journal admission. */
  | 'finalize-artifact'
  /** A finalize journal record is about to be admitted. */
  | 'finalize-journal'
  /** A finalize record's transcript rows have been materialized by checkpoint. */
  | 'finalize-checkpoint'
  /** A receipt effect is about to be admitted to the journal. */
  | 'receipt-effect';

export interface ChatDeltaJournalWriterOptions {
  /** Test seam: runs after each write/sync step the counters do not cover. */
  onBoundary?: (boundary: DeltaJournalBoundary) => Promise<void>;
  onDiagnostic?: (diagnostic: DeltaJournalDiagnostic) => void;
  checkpointJournalBytes?: number;
  /** Test evidence for the two intentional committed-log hash passes on settle. */
  onChildLogTotals?: (metrics: {
    readonly committedBytesRead: number;
    readonly committedRowCount: number;
    readonly appendedRowCount: number;
    readonly committedLogSegmentsRead: number;
    readonly hashBufferAllocationCount: number;
    readonly hashBufferBytesPerAllocation: number;
  }) => void;
  maxManifestVersion?: 3 | 4;
  /**
   * A format 4 checkpoint restages only the streams, registries and parents
   * its records change, and publishes the catalog. Readers accept the older
   * metadata it leaves in place; readers released before that relaxation do
   * not, so this stays off wherever a promoted scope can reach one.
   */
  incrementalStreamMetadata?: boolean;
  /**
   * The log a checkpoint writes the transcripts through. The chat state
   * backend passes the log its read paths use, so their derived caches see
   * every checkpoint. Its active projection is ignored while the writer
   * materializes or recovers.
   */
  log?: ChatTranscriptLog;
}

/** A chat's open run of active-projection updates during a checkpoint. */
interface ActiveRun {
  /** The full active rows once known; otherwise the sidecar's rows. */
  messages?: PersistedChatMessage[];
  /** Upserts to fold over the sidecar's rows, oldest first. */
  upserts: PersistedChatMessage[][];
  transcriptRevision: number;
}

/** A record framed and admitted against the in-memory view, not written. */
interface PreparedRecord {
  /** The record without a batch offset, to frame again if its batch changes. */
  base: JournalCommit;
  encoded: { frame: Buffer; digest: string };
  record: JournalCommit;
  indexes: ChatStorageIndexes;
  admitted: Map<string, ChatTranscriptOverlay>;
  admittedChildren: Map<string, ChildJournalOverlay>;
  admittedDescriptors: Map<string, TranscriptStreamDescriptor>;
  primaryRecord: boolean;
}

interface WriterState {
  /** Indexes of the last checkpoint, as on disk. */
  checkpointIndexes: ChatStorageIndexes;
  /** Metadata after every record; descriptors of touched chats are stale. */
  indexes: ChatStorageIndexes;
  /** Records after the checkpoint, in order. */
  records: JournalCommit[];
  overlays: Map<string, ChatTranscriptOverlay>;
  childOverlays: Map<string, ChildJournalOverlay>;
  descriptorOverlays: Map<string, TranscriptStreamDescriptor>;
  lastDigest: string;
  journalBytes: number;
  mutationIds: Set<string>;
  registeredTargets: TranscriptTarget[];
  primaryRecordCount: number;
}

function nonRevisionIndexState(indexes: ChatStorageIndexes): string {
  const { revision: _liveRevision, ...live } = indexes.live;
  const { revision: _archiveRevision, ...archive } = indexes.archive;
  const { mutationIds: _mutationIds, ...recovery } = indexes.recovery;
  void _liveRevision;
  void _archiveRevision;
  void _mutationIds;
  return JSON.stringify({ live, archive, recovery });
}

function chatIds(indexes: ChatStorageIndexes): Set<string> {
  return new Set([
    ...indexes.live.tabs.map((tab) => tab.id),
    ...indexes.archive.archived.map((entry) => entry.tab.id),
  ]);
}

function indexedTranscriptRevision(
  indexes: ChatStorageIndexes,
  chatId: string,
): number {
  const entry =
    indexes.live.tabs.find((tab) => tab.id === chatId) ??
    indexes.archive.archived.find((candidate) => candidate.tab.id === chatId)
      ?.tab;
  return entry?.transcript?.transcriptRevision ?? 0;
}

/** Write all of `bytes` at `position`, however the system splits it. */
async function writeAt(
  handle: FileHandle,
  bytes: Buffer,
  position: number,
): Promise<void> {
  await writeBufferFully(bytes, async (buffer, offset, length) => {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      length,
      position + offset,
    );
    return bytesWritten;
  });
}

function assertUniqueIds(messages: readonly PersistedChatMessage[]): void {
  const ids = new Set<string>();
  for (const message of messages) {
    if (ids.has(message.id)) throw new Error('Duplicate prepared message id');
    ids.add(message.id);
  }
}

async function writeAtomicJson(
  path: string,
  value: unknown,
  boundary?: (point: DeltaJournalBoundary) => Promise<void>,
  boundaryPoints: {
    written: DeltaJournalBoundary;
    synced: DeltaJournalBoundary;
    published?: DeltaJournalBoundary;
    directorySynced?: DeltaJournalBoundary;
  } = {
    written: 'manifest-temp-written',
    synced: 'manifest-temp-synced',
    published: 'manifest-published',
    directorySynced: 'manifest-directory-synced',
  },
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    if (boundary) {
      const bytes = Buffer.from(JSON.stringify(value));
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await writeAt(handle, bytes, 0);
        recordChatStorageFileWrite(temporary, bytes.length, true);
        await boundary(boundaryPoints.written);
        await handle.sync();
        recordChatStorageFileSync(temporary);
        await boundary(boundaryPoints.synced);
      } finally {
        await handle.close();
      }
    } else
      await writeJsonValuesCooperatively(temporary, [value], { pretty: false });
    await rename(temporary, path);
    renamed = true;
    recordChatStorageAtomicReplacement(path);
    if (boundaryPoints.published) await boundary?.(boundaryPoints.published);
    await fsyncDirectory(dirname(path));
    if (boundaryPoints.directorySynced)
      await boundary?.(boundaryPoints.directorySynced);
  } finally {
    if (!renamed) await rm(temporary, { force: true });
  }
}

/**
 * Atomically replace the journal with a new segment holding no records. A
 * caller passing `syncDirectory: false` syncs the directory itself.
 */
async function writeJournalSegment(
  directory: string,
  scopeId: string,
  baseRevision: number,
  prev: string,
  syncDirectory = true,
  version: 1 | 2 = 1,
  boundary?: (point: DeltaJournalBoundary) => Promise<void>,
): Promise<{ digest: string; bytes: number }> {
  const path = join(
    directory,
    version === 1 ? DELTA_JOURNAL_FILE_NAME : DELTA_JOURNAL_V2_FILE_NAME,
  );
  const { frame, digest } = encodeDeltaJournalFrame({
    type: 'segment',
    v: version,
    scopeId,
    baseRevision,
    prev,
  });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await writeAt(handle, frame, 0);
      recordChatStorageFileWrite(temporary, frame.length, true);
      await boundary?.('segment-temp-written');
      await handle.sync();
      recordChatStorageFileSync(temporary);
      await boundary?.('segment-temp-synced');
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    renamed = true;
    recordChatStorageAtomicReplacement(path);
    await boundary?.('segment-renamed');
    if (syncDirectory) await fsyncDirectory(directory);
    if (syncDirectory) await boundary?.('segment-directory-synced');
  } finally {
    if (!renamed) await rm(temporary, { force: true });
  }
  return { digest, bytes: frame.length };
}

interface ChildLogTotals {
  committedRowCount: number;
  committedByteLength: number;
  committedSha256: string;
}

type ChildAdmissionEffect = Extract<
  DelegationRegistryJournalEffect,
  { kind: 'child-admission' }
>;

/**
 * Split one write's admission items into effects that each fit the registry
 * entry bound, in item order, so a large batch never exceeds it.
 */
function childAdmissionEffects(
  target: ChildAdmissionEffect['target'],
  items: ChildAdmissionEffect['items'],
): ChildAdmissionEffect[] {
  const envelope = Buffer.byteLength(
    canonicalDelegationJson({ kind: 'child-admission', target, items: [] }),
    'utf8',
  );
  const effects: ChildAdmissionEffect[] = [];
  let chunk: ChildAdmissionEffect['items'][number][] = [];
  let bytes = envelope;
  for (const item of items) {
    // One byte for the separating comma.
    const size = Buffer.byteLength(canonicalDelegationJson(item), 'utf8') + 1;
    if (
      chunk.length > 0 &&
      bytes + size > DELEGATION_REGISTRY_MAX_ENTRY_BYTES
    ) {
      effects.push({ kind: 'child-admission', target, items: chunk });
      chunk = [];
      bytes = envelope;
    }
    chunk.push(item);
    bytes += size;
  }
  if (chunk.length > 0)
    effects.push({ kind: 'child-admission', target, items: chunk });
  return effects;
}

function receiptMatches(
  receipt: ChildLogTotals,
  totals: ChildLogTotals,
): boolean {
  return (
    receipt.committedRowCount === totals.committedRowCount &&
    receipt.committedByteLength === totals.committedByteLength &&
    receipt.committedSha256 === totals.committedSha256
  );
}

function registryError(
  code:
    | 'invalid_request'
    | 'not_found'
    | 'conflict'
    | 'corruption'
    | 'answer_unavailable'
    | 'unsupported_format'
    | 'stale_identity',
  message: string,
  extra: {
    storedLastResultIndex?: number;
    storedItemRevision?: number;
  } = {},
): never {
  throw new DelegationRegistryOperationError({
    code,
    message,
    retryable: false,
    ...extra,
  });
}

function registryIdentityKey(identity: RegistryIdentity): string {
  return registryOwnerKey(identity);
}

function registryIdentityFor(
  target: DelegationTranscriptTarget,
): DelegationTranscriptRegistryIdentity {
  return { chatId: target.chatId, delegationId: target.delegationId };
}

function validRegistryId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function maximumRowTimestamp(
  existing: number | null,
  rows: readonly DelegationChildRow[],
): number | null {
  let latest = existing;
  for (const row of rows)
    if (latest === null || row.timestamp > latest) latest = row.timestamp;
  return latest;
}

export class ChatDeltaJournalWriter {
  public result(
    input: DelegationTranscriptResultRequest,
  ): Promise<DelegationTranscriptResultEntry | undefined> {
    this.assertRegistryIdentity(input);
    return this.withRegistryRead(() => this.registryReader.result(input));
  }

  public appendDelegationReceipt(
    input: DelegationRegistryReceiptMutation,
  ): Promise<DelegationTranscriptReceiptAppendResult> {
    return this.appendRegistryReceipt(input);
  }

  public receipt(commandId: string): PersistedCommandReceipt | undefined;
  public receipt(
    input: DelegationTranscriptReceiptIdentity,
  ): Promise<DelegationTranscriptReceiptEntry | undefined>;
  public receipt(
    input: string | DelegationTranscriptReceiptIdentity,
  ):
    | PersistedCommandReceipt
    | undefined
    | Promise<DelegationTranscriptReceiptEntry | undefined> {
    if (typeof input === 'string')
      return this.current().indexes.recovery.receipts.find(
        (receipt) => receipt.commandId === input,
      );
    if (this.journalVersion !== 2)
      return registryError(
        'unsupported_format',
        'Delegation receipts require a format 4 journal.',
      );
    this.assertRegistryChat(input.chatId);
    return this.withRegistryRead(() => this.registry.receipt(input));
  }

  private async appendRegistryReceipt(
    input: DelegationRegistryReceiptMutation,
  ): Promise<DelegationTranscriptReceiptAppendResult> {
    if (this.journalVersion !== 2)
      registryError(
        'unsupported_format',
        'Delegation receipts require a format 4 journal.',
      );
    if (!validRegistryId(input.mutationId))
      registryError(
        'invalid_request',
        'The receipt mutation identity is invalid.',
      );
    const validated = validateDelegationReceiptEntry(input.entry);
    if (!validated.ok) registryError('invalid_request', validated.reason);
    const entry = validated.entry;
    this.assertRegistryChat(entry.chatId);
    const identity: DelegationTranscriptReceiptIdentity = {
      chatId: entry.chatId,
      receiptKind: entry.receiptKind,
      key: entry.key,
    };
    const existing = await this.withRegistryRead(() =>
      this.registry.receipt(identity),
    );
    if (existing !== undefined) {
      if (canonicalDelegationJson(existing) !== canonicalDelegationJson(entry))
        registryError(
          'conflict',
          'Receipt identity conflicts with stored entry.',
        );
      return { entry: existing, replayed: true };
    }

    const owner = registryOwner({
      kind: 'chat_receipts',
      chatId: entry.chatId,
    });
    if (owner.kind !== 'chat_receipts')
      registryError('corruption', 'Invalid receipt registry owner.');
    const effect: DelegationRegistryJournalEffect = {
      kind: 'delegation-receipt',
      owner,
      entry,
    };
    const applied = await this.writeRegistryMutation(input.mutationId, [
      effect,
    ]);
    if (applied) return { entry, replayed: false };

    const replayedEntry = await this.withRegistryRead(() =>
      this.registry.receipt(identity),
    );
    if (replayedEntry === undefined)
      registryError('corruption', 'The committed receipt is missing.');
    if (
      canonicalDelegationJson(replayedEntry) !== canonicalDelegationJson(entry)
    )
      registryError(
        'conflict',
        'Receipt identity conflicts with stored entry.',
      );
    return { entry: replayedEntry, replayed: true };
  }

  public resultBySettlementKey(
    input: Parameters<DelegationRegistryWriter['resultBySettlementKey']>[0],
  ): Promise<DelegationTranscriptResultEntry | undefined> {
    this.assertRegistryIdentity(input);
    if (!validRegistryId(input.settlementKey))
      return Promise.reject(
        new DelegationRegistryOperationError({
          code: 'invalid_request',
          message: 'The settlement key is invalid.',
          retryable: false,
        }),
      );
    return this.withRegistryRead(() =>
      this.registryReader.resultBySettlementKey(input),
    );
  }

  public resultByGeneration(
    input: DelegationTranscriptGenerationRequest,
  ): Promise<DelegationTranscriptResultEntry | undefined> {
    this.assertRegistryIdentity(input);
    return this.withRegistryRead(() =>
      this.registryReader.resultByGeneration(input),
    );
  }

  public generation(
    input: DelegationTranscriptGenerationRequest,
  ): Promise<DelegationTranscriptGeneration | undefined> {
    this.assertRegistryIdentity(input);
    return this.withRegistryRead(() => this.registryReader.generation(input));
  }

  public resultsPage(
    input: DelegationTranscriptRegistryPageRequest,
    context: Parameters<DelegationRegistryWriter['resultsPage']>[1],
  ): Promise<DelegationTranscriptResultsPage> {
    this.assertRegistryIdentity(input);
    return this.withRegistryRead(() =>
      this.registryReader.resultsPage(input, context),
    );
  }

  public generationsPage(
    input: DelegationTranscriptRegistryPageRequest,
    context: Parameters<DelegationRegistryWriter['generationsPage']>[1],
  ): Promise<DelegationTranscriptGenerationsPage> {
    this.assertRegistryIdentity(input);
    return this.withRegistryRead(() =>
      this.registryReader.generationsPage(input, context),
    );
  }

  public resultAnswerRange(
    input: DelegationTranscriptResultAnswerRequest,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptContentRange> {
    this.assertRegistryIdentity(input);
    return this.withRegistryRead(() =>
      this.registryReader.resultAnswerRange(input, signal),
    );
  }

  public itemAdmission(
    input: Parameters<DelegationRegistryWriter['itemAdmission']>[0],
  ): Promise<Awaited<ReturnType<DelegationRegistryWriter['itemAdmission']>>> {
    this.assertRegistryIdentity({
      chatId: input.target.chatId,
      delegationId: input.target.delegationId,
      runGeneration: input.target.runGeneration,
    });
    return this.withRegistryRead(() =>
      this.registryReader.itemAdmission(input),
    );
  }

  public async registerGeneration(
    input: DelegationRegistryGenerationMutation,
  ): Promise<DelegationRegistryGenerationResult> {
    const registration = input.registration;
    const identity = {
      chatId: registration.chatId,
      delegationId: registration.delegationId,
    };
    this.assertRegistryIdentity({
      ...identity,
      runGeneration: registration.runGeneration,
    });
    if (!validRegistryId(input.mutationId))
      registryError(
        'invalid_request',
        'The generation mutation identity is invalid.',
      );
    const entry: DelegationTranscriptGenerationEntry = {
      version: 1,
      kind: 'generation',
      chatId: registration.chatId,
      delegationId: registration.delegationId,
      runGeneration: registration.runGeneration,
      createdAt: registration.createdAt,
      store: registration.store,
      origin: {
        kind: registration.origin.kind,
        ...(registration.origin.anchorMessageId === undefined
          ? {}
          : { anchorMessageId: registration.origin.anchorMessageId }),
        ...(registration.origin.authoredItemId === undefined
          ? {}
          : { authoredItemId: registration.origin.authoredItemId }),
      },
      executionMode: registration.executionMode,
    };
    const effect: DelegationRegistryJournalEffect = {
      kind: 'delegation-generation',
      identity,
      entry,
    };
    const existing = await this.withRegistryRead(() =>
      this.registry.generationEntry({
        ...identity,
        runGeneration: entry.runGeneration,
      }),
    );
    if (existing !== undefined) {
      if (canonicalDelegationJson(existing) !== canonicalDelegationJson(entry))
        registryError(
          'conflict',
          'Generation registration conflicts with the stored entry.',
        );
      return { entry: existing, replayed: true };
    }

    const applied = await this.writeRegistryMutation(input.mutationId, [
      effect,
    ]);
    if (applied) return { entry, replayed: false };
    const replayedEntry = await this.withRegistryRead(() =>
      this.registry.generationEntry({
        ...identity,
        runGeneration: entry.runGeneration,
      }),
    );
    if (
      replayedEntry === undefined ||
      canonicalDelegationJson(replayedEntry) !== canonicalDelegationJson(entry)
    )
      registryError(
        'conflict',
        'Generation registration conflicts with the stored entry.',
      );
    return { entry: replayedEntry, replayed: true };
  }

  public settleDelegationResult(
    input: DelegationRegistrySettleMutation,
  ): Promise<DelegationTranscriptSettleResult> {
    return this.settleRegistryMutation(input);
  }

  private assertRegistryIdentity(
    identity: DelegationTranscriptRegistryIdentity & {
      readonly runGeneration?: number;
    },
  ): void {
    if (
      !validRegistryId(identity.chatId) ||
      !validRegistryId(identity.delegationId) ||
      (identity.runGeneration !== undefined &&
        (!Number.isSafeInteger(identity.runGeneration) ||
          identity.runGeneration < 0))
    )
      registryError(
        'invalid_request',
        'The delegation registry identity is invalid.',
      );
    this.assertRegistryChat(identity.chatId);
  }

  private assertRegistryChat(chatId: string): void {
    if (!validRegistryId(chatId))
      registryError(
        'invalid_request',
        'The delegation registry identity is invalid.',
      );
    try {
      assertTranscriptIdentity(chatId);
    } catch {
      registryError(
        'invalid_request',
        'The delegation registry identity is invalid.',
      );
    }
    if (!chatIds(this.current().indexes).has(chatId))
      registryError('not_found', 'The parent chat was not found.');
  }

  private async withRegistryRead<T>(read: () => Promise<T>): Promise<T> {
    return this.serial(async () => {
      await this.drainGroupCommit();
      await this.registryTail;
      this.current();
      return read();
    });
  }

  private async appendRegistryEffects(
    record: JournalCommit,
    notifySettlement = true,
  ): Promise<void> {
    if (record.v !== 2 || !record.registryEffects?.length) return;
    const effectsByChat = new Map<string, DelegationRegistryJournalEffect[]>();
    for (const effect of record.registryEffects) {
      const chatId = registryEffectIdentity(effect).chatId;
      const effects = effectsByChat.get(chatId) ?? [];
      effects.push(effect);
      effectsByChat.set(chatId, effects);
    }
    const publication = this.registryTail.then(async () => {
      for (const [chatId, effects] of Array.from(effectsByChat.entries()))
        await this.registry.append(chatId, effects);
    });
    this.registryTail = publication.then(
      () => undefined,
      () => undefined,
    );
    await publication;
    if (
      notifySettlement &&
      record.registryEffects.some(
        (effect) => effect.kind === 'delegation-result',
      )
    )
      await this.boundary('registry-settle-admitted');
  }

  private async readRegistryAnswerRange(
    input: DelegationTranscriptResultAnswerRequest,
    signal?: AbortSignal,
  ): Promise<DelegationTranscriptContentRange> {
    this.assertRegistryIdentity(input);
    if (
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 4 ||
      input.limit > 65_536
    )
      registryError('invalid_request', 'The result answer range is invalid.');
    signal?.throwIfAborted();
    const result = await this.registry.result({
      chatId: input.chatId,
      delegationId: input.delegationId,
      resultIndex: input.resultIndex,
    });
    if (!result) registryError('not_found', 'The result was not found.');
    if (result.answer.kind === 'none')
      registryError('not_found', 'The result has no answer.');
    if (result.answer.kind === 'lost')
      registryError('answer_unavailable', 'The result answer is unavailable.');
    if (result.answer.kind === 'empty') {
      if (input.offset !== 0)
        registryError('invalid_request', 'The result answer range is invalid.');
      return { text: '', byteLength: 0, encoding: 'utf8' };
    }
    try {
      const range = await this.log.artifacts.readRange(
        input.chatId,
        result.answer.ref,
        input.offset,
        input.limit,
        signal,
      );
      return { ...range, encoding: result.answer.encoding };
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT')
        registryError('corruption', 'The result answer body is missing.');
      throw error;
    }
  }

  private nextRegistryIndexes(mutationId: string): {
    expectedRevision: number;
    next: ChatStorageIndexes;
  } {
    const state = this.current();
    if (!Number.isSafeInteger(state.indexes.live.revision + 1))
      registryError(
        'invalid_request',
        'The parent chat revision is exhausted.',
      );
    const next = structuredClone(state.indexes);
    next.live.revision += 1;
    next.archive.revision = next.live.revision;
    const retained = next.recovery.mutationIds.filter(
      (candidate) => candidate !== mutationId,
    );
    next.recovery.mutationIds = [...retained, mutationId].slice(
      -DELTA_JOURNAL_MUTATION_ID_WINDOW,
    );
    return { expectedRevision: state.indexes.live.revision, next };
  }

  private async writeRegistryMutation(
    mutationId: string,
    registryEffects: readonly DelegationRegistryJournalEffect[],
    created?: CreatedArtifacts,
    childWrites?: readonly DelegationRegistryChildWrite[],
    preparePublish?: () => Promise<void>,
  ): Promise<boolean> {
    const { expectedRevision, next } = this.nextRegistryIndexes(mutationId);
    const result = await this.commit({
      expectedRevision,
      next,
      writes: [],
      mutationIds: [mutationId],
      registryEffects,
      ...(childWrites === undefined ? {} : { childWrites }),
      ...(created === undefined ? {} : { created }),
      ...(preparePublish === undefined ? {} : { preparePublish }),
    });
    return result.applied;
  }

  private async settleRegistryMutation(
    input: DelegationRegistrySettleMutation,
  ): Promise<DelegationTranscriptSettleResult> {
    const { target } = input;
    const identity = registryIdentityFor(target);
    this.assertRegistryIdentity({
      ...identity,
      runGeneration: target.runGeneration,
    });
    if (
      this.journalVersion !== 2 ||
      !validRegistryId(input.mutationId) ||
      !validRegistryId(input.mutationKey) ||
      !validRegistryId(input.resultEntry.settlementKey) ||
      !Number.isSafeInteger(input.resultEntry.resultIndex) ||
      input.resultEntry.resultIndex < 1 ||
      input.resultEntry.runGeneration !== target.runGeneration ||
      !/^[a-f0-9]{64}$/.test(input.resultEntry.settlementDigest)
    )
      registryError(
        'invalid_request',
        'The delegation settlement metadata is invalid.',
      );
    const request: DelegationTranscriptSettleRequest = {
      target,
      settlementKey: input.resultEntry.settlementKey,
      resultIndex: input.resultEntry.resultIndex,
      outcome: input.resultEntry.outcome,
      finalChanges: input.finalRows.map((row) => ({ row })),
      answer: input.answerBody,
      openRows: input.openRows ?? 'reject',
    };
    let digest: string;
    try {
      digest = delegationTranscriptSettlementDigest(request);
    } catch {
      registryError(
        'invalid_request',
        'The delegation settlement content is invalid.',
      );
    }
    if (digest !== input.resultEntry.settlementDigest)
      registryError(
        'invalid_request',
        'The delegation settlement digest does not match its content.',
      );

    // A keyed replay is decided before stream/card state and before publishing
    // any new artifact. The digest is the complete logical operation identity.
    const existing = await this.registry.resultBySettlementKey({
      ...identity,
      settlementKey: input.resultEntry.settlementKey,
    });
    if (existing) {
      if (existing.settlementDigest !== digest)
        registryError(
          'conflict',
          'The settlement key already names different content.',
        );
      return {
        settlement: {
          target,
          settlementKey: existing.settlementKey,
          streamRevision: existing.settlement.streamRevision,
          contentRevision: existing.settlement.contentRevision,
          finalItemCount: existing.settlement.finalItemCount,
          replayed: true,
        },
        result: existing,
      };
    }

    const resultForGeneration = await this.registry.resultByGeneration({
      ...identity,
      runGeneration: target.runGeneration,
    });
    if (resultForGeneration)
      registryError(
        'conflict',
        'The delegation generation already has a result.',
      );
    const lastResultIndex = await this.registry.lastResultIndex(identity);
    if (
      lastResultIndex !== undefined &&
      (lastResultIndex === Number.MAX_SAFE_INTEGER ||
        input.resultEntry.resultIndex !== lastResultIndex + 1)
    )
      registryError('conflict', 'The result index is not consecutive.', {
        storedLastResultIndex: lastResultIndex,
      });

    const state = this.current();
    if (
      !state.registeredTargets.some(
        (candidate) =>
          transcriptTargetKey(candidate) === transcriptTargetKey(target),
      )
    )
      registryError('not_found', 'The delegation stream was not registered.');
    const descriptor = await this.streamDescriptorFor(
      state.descriptorOverlays,
      target,
    );
    if (descriptor.status === 'settled')
      registryError('conflict', 'The delegation stream is already settled.');
    if (
      descriptor.streamRevision !==
      input.descriptorSettle.expectedStreamRevision
    )
      registryError(
        'stale_identity',
        'The delegation stream revision changed.',
      );
    if (!Number.isSafeInteger(descriptor.streamRevision + 1))
      registryError(
        'invalid_request',
        'The delegation stream revision is exhausted.',
      );

    const created = new CreatedArtifacts();
    let handedOff = false;
    try {
      const validationOverlay = (
        await this.childOverlayFor(state.childOverlays, target)
      ).clone();
      const validationRows: DelegationChildRow[] = [];
      for (const row of input.finalRows) {
        if (!isDelegationChildRow(row) || !row.final)
          registryError(
            'invalid_request',
            'Settlement rows must be final delegation rows.',
          );
        const validated =
          this.fieldMode === 'format4'
            ? await this.log.artifacts.externalize(
                target.chatId,
                row,
                undefined,
                { kind: 'format4', final: true, dryRun: true },
              )
            : await this.log.artifacts.externalize(
                target.chatId,
                row,
                undefined,
                transcriptFieldPolicy(this.fieldMode, true),
              );
        if (!isDelegationChildRow(validated) || !validated.final)
          registryError(
            'invalid_request',
            'Settlement rows must be final delegation rows.',
          );
        assertTranscriptRowWithinLimit(validated);
        validationRows.push(validated);
      }
      await validationOverlay.apply(validationRows);

      const sourceRows = [...input.finalRows];
      if (input.openRows === 'finalize') {
        // Synthesize only from the pending overlay's open set. Committed
        // history stays in the streaming totals pass, not a history-sized map.
        for (const row of validationOverlay.openRows) {
          if (!Number.isSafeInteger(row.itemRevision + 1))
            registryError(
              'invalid_request',
              'A child item revision is exhausted.',
            );
          sourceRows.push({
            ...row,
            itemRevision: row.itemRevision + 1,
            final: true,
          });
        }
      } else if (validationOverlay.openRows.length > 0)
        registryError('conflict', 'A delegation with open rows cannot settle.');

      let answer: DelegationTranscriptResultEntry['answer'];
      if (input.answerBody === null) answer = { kind: 'none' };
      else if ('lost' in input.answerBody)
        answer = {
          kind: 'lost',
          role: input.answerBody.role,
          sha256: input.answerBody.lost.sha256,
          length: input.answerBody.lost.length,
        };
      else if (input.answerBody.text.length === 0)
        answer = { kind: 'empty', role: input.answerBody.role };
      else {
        const ref = await this.log.artifacts.put(
          target.chatId,
          input.answerBody.text,
          created,
        );
        await this.boundary('registry-answer-published');
        answer = {
          kind: 'body',
          role: input.answerBody.role,
          byteLength: ref.byteLength,
          encoding: ref.encoding === 'utf-8' ? 'utf8' : 'utf16le',
          sha256: ref.sha256,
          ref,
        };
      }

      const storedRows: DelegationChildRow[] = [];
      for (const row of sourceRows) {
        const stored = await this.log.artifacts.externalize(
          target.chatId,
          row,
          created,
          transcriptFieldPolicy(this.fieldMode, true),
        );
        if (!isDelegationChildRow(stored) || !stored.final)
          registryError(
            'invalid_request',
            'Settlement rows must be final delegation rows.',
          );
        assertTranscriptRowWithinLimit(stored);
        storedRows.push(stored);
      }
      if (input.openRows === 'finalize')
        await this.boundary('finalize-artifact');

      const childOverlay = (
        await this.childOverlayFor(state.childOverlays, target)
      ).clone();
      const changedRows = await childOverlay.apply(storedRows);
      if (childOverlay.openRows.length > 0)
        registryError('conflict', 'A delegation with open rows cannot settle.');
      const totals = await this.childLogTotals(
        target,
        childOverlay.newlyFinalRows,
        true,
      );
      const scopeRevision = state.indexes.live.revision + 1;
      const streamRevision = descriptor.streamRevision + 1;
      const latestRowTimestamp = maximumRowTimestamp(
        descriptor.latestRowTimestamp,
        changedRows,
      );
      const settlement = {
        streamRevision,
        contentRevision: streamRevision,
        finalItemCount: totals.committedRowCount,
        finalItemsDigest: totals.committedSha256,
      };
      const result: DelegationTranscriptResultEntry = {
        ...input.resultEntry,
        answer,
        settlement,
      };
      const receipt = {
        mutationId: input.resultEntry.settlementKey,
        scopeRevision,
        streamRevision,
        committedRowCount: totals.committedRowCount,
        committedByteLength: totals.committedByteLength,
        committedSha256: totals.committedSha256,
      };
      const descriptorUpdate: TranscriptStreamDescriptorUpdate = {
        version: 1,
        target,
        expectedStreamRevision: descriptor.streamRevision,
        nextStreamRevision: streamRevision,
        status: 'settled',
        latestRowTimestamp,
        settleReceipt: receipt,
        cardState: ((): NonNullable<
          TranscriptStreamDescriptor['cardState']
        > => {
          const chosen = chooseSettlementCardDraft(descriptor.cardState, input);
          if (!chosen.ok)
            registryError('invalid_request', chosen.error.message);
          const card = CardStateV2Schema.safeParse({
            ...chosen.value,
            canonical: canonicalCardState(
              {
                outcome: input.resultEntry.outcome,
                resultIndex: input.resultEntry.resultIndex,
                answer: input.answerBody,
              },
              answer,
            ),
          });
          if (!card.success)
            registryError(
              'invalid_request',
              'The canonical card state exceeds its bound.',
            );
          return card.data;
        })(),
      };
      const registryEffect: DelegationRegistryJournalEffect = {
        kind: 'delegation-result',
        target,
        entry: result,
      };
      handedOff = true;
      const applied = await this.writeRegistryMutation(
        input.mutationId,
        [registryEffect],
        created,
        [
          {
            target,
            rows: storedRows,
            mutationKey: input.mutationKey,
            settle: {
              key: input.resultEntry.settlementKey,
              descriptorUpdate,
            },
          },
        ],
        input.openRows === 'finalize'
          ? (): Promise<void> => this.boundary('finalize-journal')
          : undefined,
      );
      if (!applied) {
        const replay = await this.registry.resultBySettlementKey({
          ...identity,
          settlementKey: result.settlementKey,
        });
        if (replay && replay.settlementDigest === digest)
          return {
            settlement: {
              target,
              settlementKey: replay.settlementKey,
              streamRevision: replay.settlement.streamRevision,
              contentRevision: replay.settlement.contentRevision,
              finalItemCount: replay.settlement.finalItemCount,
              replayed: true,
            },
            result: replay,
          };
        registryError(
          'corruption',
          'The applied settlement result is missing.',
        );
      }
      const committed = await this.registry.resultBySettlementKey({
        ...identity,
        settlementKey: result.settlementKey,
      });
      if (!committed)
        registryError(
          'corruption',
          'The committed settlement result is missing.',
        );
      return {
        settlement: {
          target,
          settlementKey: committed.settlementKey,
          streamRevision: committed.settlement.streamRevision,
          contentRevision: committed.settlement.contentRevision,
          finalItemCount: committed.settlement.finalItemCount,
          replayed: false,
        },
        result: committed,
      };
    } catch (error) {
      if (!handedOff) await created.discard();
      throw error;
    }
  }

  public highWater(
    input: DelegationRegistryCheckpoint['identity'],
  ): Promise<
    Awaited<ReturnType<DelegationRegistryCheckpointReader['highWater']>>
  > {
    if ('delegationId' in input) this.assertRegistryIdentity(input);
    else {
      if (this.journalVersion !== 2)
        registryError(
          'unsupported_format',
          'Receipt-owner checkpoints require a format 4 journal.',
        );
      this.assertRegistryChat(input.chatId);
    }
    return this.withRegistryRead(() => this.registry.highWater(input));
  }

  public answerReferences(
    chatId: string,
  ): ReturnType<DelegationRegistryCheckpointReader['answerReferences']> {
    this.assertRegistryIdentity({ chatId, delegationId: 'registry-scope' });
    return this.registry.answerReferences(chatId);
  }

  public checkpointDelegationRegistry(
    input: Parameters<
      DelegationRegistryCheckpointWriter['checkpointDelegationRegistry']
    >[0],
  ): Promise<
    Awaited<
      ReturnType<
        DelegationRegistryCheckpointWriter['checkpointDelegationRegistry']
      >
    >
  > {
    if ('delegationId' in input.identity)
      this.assertRegistryIdentity(input.identity);
    else {
      if (this.journalVersion !== 2)
        registryError(
          'unsupported_format',
          'Receipt-owner checkpoints require a format 4 journal.',
        );
      this.assertRegistryChat(input.identity.chatId);
    }
    return this.withRegistryRead(() => this.registry.checkpoint(input));
  }

  private readonly directory: string;
  private readonly scopeId: string;
  private readonly transcriptsRoot: string;
  private readonly journalPath: string;
  private readonly journalVersion: 1 | 2;
  private readonly manifest:
    | DeltaJournalStorageManifest
    | Format4StorageManifest;
  private readonly log: ChatTranscriptLog;
  private readonly base: TranscriptOverlayBase;
  private readonly registry: DelegationRegistryStore;
  private readonly registryReader: DelegationRegistryCheckpointReader;
  private state?: WriterState;
  private poisoned?: Error;
  private tail: Promise<unknown> = Promise.resolve();
  private registryTail: Promise<void> = Promise.resolve();
  /** Records admitted for group commit that are not durable yet. */
  private readonly groupCommit: GroupCommitQueue;
  /** True while a checkpoint or recovery reads and writes the files. */
  private materializing = false;
  /** {@link manifestGenerations} when this writer opened. */
  private readonly manifestGenerationAtOpen: number;

  private constructor(
    store: ChatStorageV2,
    manifest: DeltaJournalStorageManifest | Format4StorageManifest,
    private readonly options: ChatDeltaJournalWriterOptions,
  ) {
    this.directory = store.directory;
    this.manifestGenerationAtOpen = manifestGeneration(store.directory);
    this.scopeId = store.descriptor().scopeId;
    this.transcriptsRoot = join(store.directory, 'transcripts');
    this.manifest = manifest;
    this.journalVersion = manifest.version === 4 ? 2 : 1;
    this.journalPath = join(
      store.directory,
      journalFileFor(manifest) ?? DELTA_JOURNAL_FILE_NAME,
    );
    this.log = options.log ?? new ChatTranscriptLog(this.transcriptsRoot);
    this.registry = new DelegationRegistryStore(this.transcriptsRoot);
    this.registryReader = createDelegationRegistryReader({
      store: this.registry,
      readDescriptor: async (target) => {
        const state = this.current();
        if (
          !state.registeredTargets.some(
            (candidate) =>
              transcriptTargetKey(candidate) === transcriptTargetKey(target),
          )
        )
          return undefined;
        return this.streamDescriptorFor(state.descriptorOverlays, target);
      },
      readAnswerRange: async (input, signal) =>
        this.readRegistryAnswerRange(input, signal),
    });
    this.groupCommit = new GroupCommitQueue(
      (batch) => this.writeBatch(batch),
      (error): void => {
        // Any prefix of the batch may be durable, and the in-memory state
        // is ahead of the journal: a reopen decides from the bytes on disk.
        this.poisoned ??= error;
      },
    );
    const log = this.log;
    const root = this.transcriptsRoot;
    this.base = {
      exists: async (chatId: string): Promise<boolean> => {
        assertTranscriptIdentity(chatId);
        try {
          await stat(join(root, `${chatId}.jsonl`));
          return true;
        } catch (error) {
          if (isErrnoException(error) && error.code === 'ENOENT') return false;
          throw error;
        }
      },
      committedMessageState: (
        chatId: string,
        message: PersistedChatMessage,
      ): Promise<'absent' | 'identical' | 'different'> =>
        log.committedMessageState(chatId, message),
      hasCommittedMessage: (
        chatId: string,
        messageId: string,
      ): Promise<boolean> => log.hasCommittedMessage(chatId, messageId),
      activeMessages: (chatId: string): Promise<PersistedChatMessage[]> =>
        log.activeMessages(chatId),
      activeSnapshot: (
        chatId: string,
      ): ReturnType<ChatTranscriptLog['activeSnapshot']> =>
        log.activeSnapshot(chatId),
      iterate: (chatId: string): AsyncIterable<PersistedChatMessage> =>
        log.iterate(chatId),
      transcriptRevision: async (chatId: string): Promise<number> =>
        (await log.descriptor(chatId)).transcriptRevision,
    };
  }

  /**
   * Open a delta-journal scope: drop a torn tail (with a diagnostic), finish
   * an interrupted checkpoint, verify the chain and every referenced
   * artifact, and rebuild the in-memory state from checkpoint + records.
   */
  public static async open(
    store: ChatStorageV2,
    options: ChatDeltaJournalWriterOptions = {},
  ): Promise<ChatDeltaJournalWriter> {
    const manifest: unknown = JSON.parse(
      await readFile(store.manifestPath, 'utf8'),
    );
    assertNoNewerChatStorageManifest(
      manifest,
      store.descriptor().scopeId,
      options.maxManifestVersion ?? store.maxManifestVersion,
    );
    if (
      !journalFileFor(manifest) ||
      !isRecord(manifest) ||
      manifest.scopeId !== store.descriptor().scopeId
    )
      throw new Error('Scope does not use the delta journal');
    const writer = new ChatDeltaJournalWriter(
      store,
      parseChatStorageManifest(manifest),
      options,
    );
    writer.materializing = true;
    try {
      await writer.recover();
    } finally {
      writer.materializing = false;
    }
    return writer;
  }

  private async boundary(point: DeltaJournalBoundary): Promise<void> {
    await this.options.onBoundary?.(point);
  }

  private current(): WriterState {
    if (manifestGeneration(this.directory) !== this.manifestGenerationAtOpen)
      throw new Error('Delta journal writer is closed: its authority changed');
    if (this.poisoned)
      throw Object.assign(new Error('Delta journal writer must be reopened'), {
        cause: this.poisoned,
      });
    if (!this.state) throw new Error('Delta journal writer is not open');
    return this.state;
  }

  private registeredChildState(
    target: Extract<TranscriptTarget, { kind: 'delegation' }>,
  ): WriterState {
    const state = this.current();
    const identity = transcriptTargetKey(target);
    if (
      !state.registeredTargets.some(
        (candidate) => transcriptTargetKey(candidate) === identity,
      )
    )
      throw new Error('Unknown child stream');
    return state;
  }

  private async serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(work);
    this.tail = next;
    return next;
  }

  /** Open and usable; false once a failed write requires a reopen. */
  public isOpen(): boolean {
    return (
      this.state !== undefined &&
      this.poisoned === undefined &&
      manifestGeneration(this.directory) === this.manifestGenerationAtOpen
    );
  }

  /** Chats that records after the checkpoint touched and did not delete. */
  public journaledChatIds(): string[] {
    return Array.from(this.current().overlays.values())
      .filter((overlay) => !overlay.isDeleted)
      .map((overlay) => overlay.chatId);
  }

  public get revision(): number {
    return this.current().indexes.live.revision;
  }

  /** Metadata after every record. Descriptors of chats changed since the
   * last checkpoint are those of that checkpoint. */
  public indexes(): ChatStorageIndexes {
    return this.current().indexes;
  }

  public get journalBytes(): number {
    return this.current().journalBytes;
  }

  public get pendingRecordCount(): number {
    return this.current().records.length;
  }

  /** Pending records that change primary content or non-revision indexes. */
  public pendingPrimaryRecordCount(): number {
    return this.current().primaryRecordCount;
  }

  /** Registered child targets, including registrations still in the journal. */
  public childTargets(): Iterable<TranscriptTarget> {
    return this.current().registeredTargets.values();
  }

  /** Cheap guard for primary-only overlays that need no child-stream work. */
  public hasChildStreams(): boolean {
    return this.current().registeredTargets.length > 0;
  }

  /**
   * The registered stream descriptor after replaying all admitted journal
   * updates, including a pending card-state update.
   */
  public async childDescriptor(
    target: Extract<TranscriptTarget, { kind: 'delegation' }>,
  ): Promise<TranscriptStreamDescriptor> {
    return this.serial(async () => {
      const state = this.registeredChildState(target);
      const descriptor = await this.streamDescriptorFor(
        state.descriptorOverlays,
        target,
      );
      if (
        transcriptTargetKey(descriptor.target) !== transcriptTargetKey(target)
      )
        throw new ChatDeltaJournalIntegrityError(
          'Child descriptor target mismatch',
        );
      return descriptor;
    });
  }

  /**
   * Read a bounded page from the registered stream, overlaid with open and
   * journal-pending rows in the same sequence order as replay readers.
   */
  public async childPage(
    target: Extract<TranscriptTarget, { kind: 'delegation' }>,
    options: ChildStreamPageOptions = {},
  ): Promise<{ rows: readonly DelegationChildRow[]; nextBefore?: number }> {
    return this.serial(async () => {
      const state = this.registeredChildState(target);
      const descriptor = await this.streamDescriptorFor(
        state.descriptorOverlays,
        target,
      );
      if (
        transcriptTargetKey(descriptor.target) !== transcriptTargetKey(target)
      )
        throw new ChatDeltaJournalIntegrityError(
          'Child descriptor target mismatch',
        );
      const overlay = await this.childOverlayFor(state.childOverlays, target);
      const streamKey = delegationStreamKey(target);
      const child = this.childStore(target, true);
      return readMergedChildStreamPage(
        descriptor.committedRowCount,
        overlay.pendingRows,
        (pageOptions) => child.readChildStreamPage(streamKey, pageOptions),
        options,
      );
    });
  }

  /** Sequence metadata plus uncommitted rows for a compatibility reader. */
  public async childCompatibilitySnapshot(
    target: Extract<TranscriptTarget, { kind: 'delegation' }>,
  ): Promise<ChildStreamCompatibilitySource> {
    return this.serial(async () => {
      const state = this.registeredChildState(target);
      const descriptor = await this.streamDescriptorFor(
        state.descriptorOverlays,
        target,
      );
      if (
        transcriptTargetKey(descriptor.target) !== transcriptTargetKey(target)
      )
        throw new ChatDeltaJournalIntegrityError(
          'Child descriptor target mismatch',
        );
      const overlay = await this.childOverlayFor(state.childOverlays, target);
      const streamKey = delegationStreamKey(target);
      const store = this.childStore(target, true);
      return {
        committedEntries: await store.childStreamSequenceEntries(streamKey),
        ...overlay.compatibilityRows(),
        readCommittedRow: (entry) =>
          store.readChildStreamSequenceEntry(streamKey, entry),
      };
    });
  }

  /** Resolve a row from the pending overlay first, then the committed index. */
  public async childRow(
    target: Extract<TranscriptTarget, { kind: 'delegation' }>,
    id: string,
  ): Promise<DelegationChildRow | undefined> {
    return this.serial(async () => {
      const state = this.registeredChildState(target);
      const overlay = await this.childOverlayFor(state.childOverlays, target);
      const pending = overlay.pendingRows.find((row) => row.id === id);
      if (pending) return pending;

      const paths = streamRegistryPaths(
        this.transcriptsRoot,
        target.chatId,
        delegationStreamKey(target),
      );
      try {
        await stat(paths.log);
      } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT')
          return undefined;
        throw error;
      }
      return this.childStore(target, true).childStreamRowById(
        delegationStreamKey(target),
        id,
      );
    });
  }

  /** Child open rows are measured separately from primary active turns. */
  public childOpenBytes(): number {
    let bytes = 0;
    for (const overlay of Array.from(this.current().childOverlays.values()))
      bytes += overlay.openBytes;
    return bytes;
  }

  /**
   * How this writer's rows store body fields, from the manifest it captured
   * at open: format 4 (journal version 2) prepares them; older is legacy.
   */
  public get fieldMode(): TranscriptFieldMode {
    return this.journalVersion === 2 ? 'format4' : 'legacy';
  }

  /** Checkpoint and recovery re-apply prepared rows: verify, never publish. */
  private get materializeFieldMode(): TranscriptFieldMode {
    return this.journalVersion === 2 ? 'format4-verify' : 'legacy';
  }

  /** Child-only artifact references awaiting checkpoint publication. */
  public async *pendingChildArtifactRefs(): AsyncGenerator<{
    parentChatId: string;
    path: string;
  }> {
    for (const overlay of Array.from(this.current().childOverlays.values()))
      for (const row of overlay.pendingRows) {
        const parentChatId = overlay.target.chatId;
        for await (const reference of this.log.artifacts.referenceClosure(
          parentChatId,
          row,
        ))
          yield {
            parentChatId,
            path: artifactRelativePath(parentChatId, {
              family: 'tool-output',
              reference,
            }),
          };
        // The closure covers tool output; visuals live on the logical blocks.
        const logical = await this.log.artifacts.expandBlocks(
          parentChatId,
          row,
        );
        for (const block of logical.blocks)
          for (const ref of storedArtifactRefsOf(block))
            if (ref.family === 'visual')
              yield {
                parentChatId,
                path: artifactRelativePath(parentChatId, ref),
              };
      }
    const state = this.current();
    const answerRefs = new Set<string>();
    for (const record of state.records) {
      if (record.v !== 2) continue;
      for (const effect of record.registryEffects ?? []) {
        if (
          effect.kind !== 'delegation-result' ||
          effect.entry.answer.kind !== 'body'
        )
          continue;
        const reference = effect.entry.answer.ref;
        const path = join(
          'transcripts',
          'tool-output',
          effect.target.chatId,
          `${reference.artifactId}.txt`,
        );
        const key = `${effect.target.chatId}\0${path}`;
        if (answerRefs.has(key)) continue;
        answerRefs.add(key);
        yield { parentChatId: effect.target.chatId, path };
      }
    }
    for (const chatId of Array.from(chatIds(state.indexes)))
      for await (const reference of this.registry.answerReferences(chatId)) {
        const path = join(
          'transcripts',
          'tool-output',
          chatId,
          `${reference.artifactId}.txt`,
        );
        const key = `${chatId}\0${path}`;
        if (answerRefs.has(key)) continue;
        answerRefs.add(key);
        yield { parentChatId: chatId, path };
      }
  }

  /**
   * The size trigger (P1 §A). While a turn's active rows are journaled, the
   * journal may grow to a multiple of them first (`active-turn.ts`).
   */
  public needsCheckpoint(): boolean {
    return journalCheckpointDue(
      this.current().journalBytes,
      this.options.checkpointJournalBytes ?? DELTA_JOURNAL_CHECKPOINT_BYTES,
      this.activeTurnBytes() + this.childOpenBytes(),
    );
  }

  /**
   * Serialized bytes of the active rows records hold ahead of the files:
   * what a checkpoint now would rewrite into active sidecars. Each overlay
   * maintains its own total, so this costs one step per journaled chat, not
   * a pass over a turn's rows: it runs after every commit.
   */
  public activeTurnBytes(): number {
    let bytes = 0;
    for (const overlay of Array.from(this.current().overlays.values()))
      bytes += overlay.activeBytes;
    return bytes;
  }

  /**
   * Whether a chat's in-progress turn holds active rows only in the journal.
   * The repository's idle checkpoint then waits for the turn to end, whose
   * record changes committed rows and is checkpointed before it is
   * acknowledged; the size trigger still applies.
   */
  public holdsActiveTurn(): boolean {
    for (const overlay of Array.from(this.current().overlays.values()))
      if (overlay.hasOrdinaryActiveRows) return true;
    return false;
  }

  public hasMutation(mutationId: string): boolean {
    return this.current().mutationIds.has(mutationId);
  }

  /**
   * Whether records after the checkpoint change a chat's committed rows, or
   * create or delete a chat, rather than only active projections and index
   * metadata. The chat state backend checkpoints such a record before it
   * acknowledges it.
   */
  public hasCommittedRowChanges(): boolean {
    for (const overlay of Array.from(this.current().overlays.values()))
      if (overlay.changesCommittedRows) return true;
    return false;
  }

  /**
   * A chat's active rows and transcript revision that records after the
   * checkpoint hold ahead of its files, for the log's read paths. Undefined
   * while the writer materializes, so checkpoints and recovery read the
   * files. Committed rows must already be checkpointed.
   */
  public activeProjection(
    chatId: string,
  ): TranscriptActiveProjection | undefined {
    if (this.materializing) return undefined;
    const overlay = this.current().overlays.get(chatId);
    if (!overlay) return undefined;
    if (overlay.changesCommittedRows)
      throw new Error(
        'Delta journal holds committed transcript rows a checkpoint has not written',
      );
    return overlay.activeProjection();
  }

  /**
   * The active rows of a chat's in-progress turn that records changed after
   * transcript revision `since`, for chat search's incremental projection
   * (see `active-turn.ts`). Undefined while the writer materializes, when
   * the journal holds no active projection for the chat, or when the change
   * since `since` is not a run of upserts: the reader then reads the rows.
   */
  public activeTurnDelta(
    chatId: string,
    since: number,
  ): ActiveTurnDelta | undefined {
    if (this.materializing) return undefined;
    const overlay = this.current().overlays.get(chatId);
    const projection = overlay?.activeProjection();
    if (!overlay || !projection) return undefined;
    return activeTurnDelta(
      this.current().records,
      chatId,
      since,
      projection,
      overlay.baseRevision,
    );
  }

  /** Committed rows in log order, including records not checkpointed yet. */
  public async committedMessages(
    chatId: string,
  ): Promise<PersistedChatMessage[]> {
    return this.serial(async () => {
      await this.drainGroupCommit();
      const overlay = this.current().overlays.get(chatId);
      const rows: PersistedChatMessage[] = [];
      for await (const message of overlay
        ? overlay.committed()
        : this.log.iterate(chatId))
        rows.push(message);
      return rows;
    });
  }

  public async activeMessages(chatId: string): Promise<PersistedChatMessage[]> {
    return this.serial(async () => {
      await this.drainGroupCommit();
      const overlay = this.current().overlays.get(chatId);
      return overlay
        ? overlay.activeMessages()
        : this.log.activeMessages(chatId);
    });
  }

  private async recover(): Promise<void> {
    await this.removeQuarantineTemporaries();
    await removeJournalTemporaries(this.directory);
    let journal = await readDeltaJournal(
      this.directory,
      this.scopeId,
      this.manifest,
    );
    const torn = journal.tornTail;
    if (torn) {
      // An append that was never synced was never acknowledged. Remove it
      // before anything else is appended after the verified prefix. A
      // complete frame with a bad checksum is kept for inspection first.
      const quarantineFile =
        torn.reason === 'checksum_mismatch'
          ? await this.quarantineTail(journal.validEnd, torn.bytes)
          : undefined;
      const handle = await open(this.journalPath, 'r+');
      try {
        await handle.truncate(journal.validEnd);
        await handle.sync();
        recordChatStorageFileSync(this.journalPath);
      } finally {
        await handle.close();
      }
      await this.boundary('tail-truncated');
      this.options.onDiagnostic?.({
        kind: 'delta_journal_torn_tail_dropped',
        journalBytes: journal.validEnd,
        recordBytes: torn.bytes,
        recordCount: journal.records.length,
        journalTailReason: torn.reason,
        ...(quarantineFile ? { journalQuarantineFile: quarantineFile } : {}),
      });
      journal = { ...journal, fileBytes: journal.validEnd };
      delete journal.tornTail;
    }
    let checkpoint = await readCheckpointState(
      this.directory,
      assertChatStorageIndexes,
    );
    assertJournalCovers(journal, checkpoint);
    const resumedCheckpoint = checkpoint.marker !== undefined;
    if (checkpoint.marker) {
      await this.resumeCheckpoint(journal, checkpoint, checkpoint.marker);
      journal = await readDeltaJournal(
        this.directory,
        this.scopeId,
        this.manifest,
      );
      checkpoint = await readCheckpointState(
        this.directory,
        assertChatStorageIndexes,
      );
      assertJournalCovers(journal, checkpoint);
    }
    if (!checkpoint.marker)
      await rm(join(this.directory, DELTA_CHECKPOINT_WORK_DIRECTORY), {
        recursive: true,
        force: true,
      });
    const checkpointedTargets: TranscriptTarget[] = [];
    if (this.journalVersion === 2) {
      if (
        (await loadStreamCatalog(this.transcriptsRoot)).checkpointRevision <
        checkpoint.revision
      )
        await this.restampStreamMetadata(checkpoint.indexes);
      await validateStreamClosure(
        this.transcriptsRoot,
        await loadStreamCatalog(this.transcriptsRoot),
        { deep: resumedCheckpoint },
      );
      const catalog = await loadStreamCatalog(this.transcriptsRoot);
      for (const parent of Object.keys(catalog.parents))
        for (const entry of (
          await loadStreamRegistry(this.transcriptsRoot, parent)
        ).entries)
          checkpointedTargets.push(entry.target);
    }
    const records = recordsAfter(journal, checkpoint.revision);
    await verifyRecordArtifacts(this.transcriptsRoot, records);
    for (const record of records)
      await this.appendRegistryEffects(record, false);
    const metadata = replayIndexMetadata(
      checkpoint.indexes,
      records,
      assertChatStorageIndexes,
    );
    const registeredTargetsByKey = new Map<string, TranscriptTarget>();
    for (const target of checkpointedTargets)
      registeredTargetsByKey.set(transcriptTargetKey(target), target);
    for (const record of records)
      if (record.v === 2)
        for (const registration of record.streamRegistrations)
          registeredTargetsByKey.set(
            transcriptTargetKey(registration.target),
            registration.target,
          );
    const presentChats = chatIds(metadata.indexes);
    const registeredTargets = Array.from(
      registeredTargetsByKey.values(),
    ).filter((target) => presentChats.has(target.chatId));
    let primaryRecordCount = 0;
    let priorIndexes = checkpoint.indexes;
    for (const record of records) {
      const nextIndexes = applyRecordMetadata(
        priorIndexes,
        record,
        assertChatStorageIndexes,
      );
      // Every format 3 record is primary; only format 4 has child-only records.
      if (
        record.v === 1 ||
        primaryEffects(record).length ||
        nonRevisionIndexState(priorIndexes) !==
          nonRevisionIndexState(nextIndexes)
      )
        primaryRecordCount += 1;
      priorIndexes = nextIndexes;
    }
    const overlays = new Map<string, ChatTranscriptOverlay>();
    for (const record of records)
      for (const effect of primaryEffects(record)) {
        const overlay = await this.overlayFor(overlays, effect);
        try {
          await overlay.apply(effect, record.toRevision);
        } catch (error) {
          // Integrity failures stay integrity failures; an operating-system
          // error may clear, so it is not made sticky.
          if (
            error instanceof ChatDeltaJournalIntegrityError ||
            isErrnoException(error)
          )
            throw error;
          throw new ChatDeltaJournalIntegrityError(
            'Delta journal record cannot be applied to its transcript',
            { cause: error },
          );
        }
        overlays.set(effect.chatId, overlay);
      }
    const childOverlays = new Map<string, ChildJournalOverlay>();
    const descriptorOverlays = new Map<string, TranscriptStreamDescriptor>();
    // Replay validates journal history, so a stream whose parent a later
    // record deleted still counts as registered for its earlier effects.
    const knownTargets = new Set(checkpointedTargets.map(transcriptTargetKey));
    for (const record of records) {
      if (record.v !== 2) continue;
      for (const registration of record.streamRegistrations) {
        const key = transcriptTargetKey(registration.target);
        knownTargets.add(transcriptTargetKey(registration.target));
        if (!descriptorOverlays.has(key))
          descriptorOverlays.set(
            key,
            createEmptyStreamDescriptor(
              registration,
              checkpoint.indexes.live.revision,
            ),
          );
      }
      for (const effect of record.transcripts) {
        if (effect.kind !== 'child-upsert' && effect.kind !== 'child-settle')
          continue;
        const key = transcriptTargetKey(effect.target);
        if (!knownTargets.has(key))
          throw new ChatDeltaJournalIntegrityError('Unregistered child target');
        const overlay = await this.childOverlayFor(
          childOverlays,
          effect.target,
        );
        await overlay.apply(effect.rows);
        childOverlays.set(key, overlay);
      }
      for (const update of record.descriptorUpdates) {
        const key = transcriptTargetKey(update.target);
        if (!knownTargets.has(key))
          throw new ChatDeltaJournalIntegrityError(
            'Unregistered descriptor target',
          );
        const descriptor = await this.streamDescriptorFor(
          descriptorOverlays,
          update.target,
        );
        descriptorOverlays.set(
          key,
          applyStreamDescriptorUpdate(descriptor, update),
        );
      }
    }
    this.state = {
      checkpointIndexes: checkpoint.indexes,
      indexes: metadata.indexes,
      records,
      overlays,
      childOverlays,
      descriptorOverlays,
      lastDigest: journal.lastDigest,
      journalBytes: journal.validEnd,
      mutationIds: new Set(metadata.indexes.recovery.mutationIds),
      registeredTargets,
      primaryRecordCount,
    };
  }

  /**
   * A quarantine copy that was never published is not evidence yet: the
   * tail it copies is still in the journal and is copied again.
   */
  private async removeQuarantineTemporaries(): Promise<void> {
    let removed = false;
    for (const name of await readdir(this.directory))
      if (isQuarantineTemporary(name)) {
        await rm(join(this.directory, name), { force: true });
        removed = true;
      }
    if (removed) await fsyncDirectory(this.directory);
  }

  /**
   * Copy the journal's dropped tail to a synced quarantine file and sync the
   * directory, before the caller truncates it. Idempotent: if a crash came
   * between an earlier copy and the truncation, the published copy with the
   * same bytes is synced and reused, never duplicated.
   */
  private async quarantineTail(
    offset: number,
    length: number,
  ): Promise<string> {
    const tail = Buffer.alloc(length);
    const journal = await open(this.journalPath, 'r');
    try {
      let read = 0;
      while (read < length) {
        const { bytesRead } = await journal.read(
          tail,
          read,
          length - read,
          offset + read,
        );
        if (bytesRead === 0) throw new Error('Delta journal tail changed');
        read += bytesRead;
      }
    } finally {
      await journal.close();
    }
    let next = 1;
    for (const name of await readdir(this.directory)) {
      const ordinal = quarantineOrdinal(name);
      if (ordinal === undefined) continue;
      next = Math.max(next, ordinal + 1);
      const path = join(this.directory, name);
      if ((await stat(path)).size !== length) continue;
      if (!tail.equals(await readFile(path))) continue;
      // Windows requires write access to sync a file handle.
      const existing = await open(path, 'r+');
      try {
        await existing.sync();
        recordChatStorageFileSync(path);
      } finally {
        await existing.close();
      }
      await fsyncDirectory(this.directory);
      await this.boundary('tail-quarantined');
      return name;
    }
    const name = `${DELTA_JOURNAL_QUARANTINE_PREFIX}${next}.bin`;
    const path = join(this.directory, name);
    const temporary = join(
      this.directory,
      `${QUARANTINE_TEMPORARY_PREFIX}${randomUUID()}.tmp`,
    );
    let renamed = false;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await writeAt(handle, tail, 0);
        recordChatStorageFileWrite(temporary, tail.length, false);
        await handle.sync();
        recordChatStorageFileSync(temporary);
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
      renamed = true;
      recordChatStorageAtomicReplacement(path);
      await fsyncDirectory(this.directory);
    } finally {
      if (!renamed) await rm(temporary, { force: true });
    }
    await this.boundary('tail-quarantined');
    return name;
  }

  private async overlayFor(
    overlays: ReadonlyMap<string, ChatTranscriptOverlay>,
    effect: DeltaJournalTranscriptEffect,
  ): Promise<ChatTranscriptOverlay> {
    const existing = overlays.get(effect.chatId);
    if (existing) return existing.clone();
    if (effect.kind === 'delete')
      return ChatTranscriptOverlay.deletedChat(effect.chatId, this.base);
    return ChatTranscriptOverlay.open(
      effect.chatId,
      this.base,
      effect.kind === 'patch' ? false : effect.create,
    );
  }

  private childStore(
    target: Extract<TranscriptTarget, { kind: 'delegation' }>,
    readOnly = false,
    checkpointAppend = false,
  ): TranscriptStreamStore {
    return new TranscriptStreamStore(
      delegationTranscriptPaths(this.transcriptsRoot, target),
      this.log.artifacts,
      (point) =>
        checkpointAppend && point === 'prepared'
          ? this.boundary('checkpoint-child-append-prepared')
          : Promise.resolve(),
      { childMode: true, readOnly },
    );
  }

  /**
   * The child log's totals once `appended` finals follow its committed rows.
   * `published` is the last checkpoint's prefix, verified before it is re-signed.
   */
  private async childLogTotals(
    target: Extract<TranscriptTarget, { kind: 'delegation' }>,
    appended: readonly DelegationChildRow[],
    readOnly: boolean,
    published?: Pick<
      TranscriptStreamDescriptor,
      'committedByteLength' | 'committedSha256'
    >,
  ): Promise<ChildLogTotals> {
    const streamKey = delegationStreamKey(target);
    const logPath = streamRegistryPaths(
      this.transcriptsRoot,
      target.chatId,
      streamKey,
    ).log;
    const hash = createHash('sha256');
    let committedRowCount = 0;
    let committedByteLength = 0;
    let committedBytesRead = 0;
    let hashBufferAllocationCount = 0;
    let hashBufferBytesPerAllocation = 0;
    let exists = true;
    try {
      await stat(logPath);
    } catch (error) {
      // A stream registered since the last checkpoint has no log yet.
      if (!(isErrnoException(error) && error.code === 'ENOENT')) throw error;
      if (published && published.committedByteLength > 0)
        throw new ChatDeltaJournalIntegrityError('Child log truncated');
      exists = false;
    }
    if (exists) {
      const committed = await this.childStore(target, readOnly).descriptor(
        streamKey,
      );
      committedRowCount = committed.committedMessageCount;
      committedByteLength = committed.committedByteLength;
      if (published && published.committedByteLength > committedByteLength)
        throw new ChatDeltaJournalIntegrityError('Child log truncated');
      const handle = await open(logPath, 'r');
      try {
        const chunk = Buffer.alloc(64 * 1024);
        hashBufferAllocationCount += 1;
        hashBufferBytesPerAllocation = chunk.length;
        for (let offset = 0; offset < committedByteLength; ) {
          // Stop at the published prefix so its digest can be checked.
          const end =
            published && offset < published.committedByteLength
              ? published.committedByteLength
              : committedByteLength;
          const { bytesRead } = await handle.read(
            chunk,
            0,
            Math.min(chunk.length, end - offset),
            offset,
          );
          if (bytesRead === 0)
            throw new ChatDeltaJournalIntegrityError('Child log truncated');
          committedBytesRead += bytesRead;
          hash.update(chunk.subarray(0, bytesRead));
          offset += bytesRead;
          if (
            published &&
            offset === published.committedByteLength &&
            hash.copy().digest('hex') !== published.committedSha256
          )
            throw new ChatDeltaJournalIntegrityError(
              'Committed child log changed since its checkpoint',
            );
        }
      } finally {
        await handle.close();
      }
    }
    if (
      published &&
      published.committedByteLength === 0 &&
      published.committedSha256 !== createHash('sha256').digest('hex')
    )
      throw new ChatDeltaJournalIntegrityError(
        'Committed child log changed since its checkpoint',
      );
    this.options.onChildLogTotals?.({
      committedBytesRead,
      committedRowCount,
      appendedRowCount: appended.length,
      committedLogSegmentsRead:
        committedByteLength > 0 && committedBytesRead > 0 ? 1 : 0,
      hashBufferAllocationCount,
      hashBufferBytesPerAllocation,
    });
    // Checkpoint appends write each final row as one JSON line.
    for (const row of appended) {
      const line = Buffer.from(`${JSON.stringify(row)}\n`, 'utf8');
      hash.update(line);
      committedRowCount += 1;
      committedByteLength += line.length;
    }
    return {
      committedRowCount,
      committedByteLength,
      committedSha256: hash.digest('hex'),
    };
  }

  private async childOverlayFor(
    overlays: ReadonlyMap<string, ChildJournalOverlay>,
    target: Extract<TranscriptTarget, { kind: 'delegation' }>,
    writable = false,
  ): Promise<ChildJournalOverlay> {
    const existing = overlays.get(transcriptTargetKey(target));
    if (existing) return existing.clone();
    const key = delegationStreamKey(target);
    const paths = streamRegistryPaths(this.transcriptsRoot, target.chatId, key);
    try {
      await stat(paths.log);
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT')
        return new ChildJournalOverlay(
          target,
          () => Promise.resolve(undefined),
          [],
        );
      throw error;
    }
    const stream = this.childStore(target, !writable);
    const openRows = await stream.activeMessages(key);
    const open: DelegationChildRow[] = [];
    for (const row of openRows) {
      if (!isDelegationChildRow(row))
        throw new ChatDeltaJournalIntegrityError('Invalid open child row');
      open.push(row);
    }
    return new ChildJournalOverlay(
      target,
      (id) => stream.childStreamRowById(key, id),
      open,
    );
  }

  private async streamDescriptorFor(
    descriptors: ReadonlyMap<string, TranscriptStreamDescriptor>,
    target: Extract<TranscriptTarget, { kind: 'delegation' }>,
  ): Promise<TranscriptStreamDescriptor> {
    const key = transcriptTargetKey(target);
    const pending = descriptors.get(key);
    if (pending) return pending;
    const streamKey = delegationStreamKey(target);
    const paths = streamRegistryPaths(
      this.transcriptsRoot,
      target.chatId,
      streamKey,
    );
    try {
      return parseStreamDescriptor(await readFile(paths.descriptor));
    } catch (error) {
      if (!(isErrnoException(error) && error.code === 'ENOENT')) throw error;
      return createEmptyStreamDescriptor(
        {
          type: 'stream',
          version: 1,
          target,
          streamKey,
          registeredAtRevision: 0,
        },
        0,
      );
    }
  }

  /**
   * Prepare one write: externalize under this writer's field mode, bound
   * rows, and shape the effect. A row's finality is where the effect puts
   * it: committed rows are final, active rows and an active suffix open. A
   * row the caller already prepared under the same mode is only verified.
   */
  private async prepareEffect(
    write: DeltaJournalWrite,
    create: boolean,
    next: ChatStorageIndexes,
    created: CreatedArtifacts,
  ): Promise<DeltaJournalTranscriptEffect> {
    const fields = this.fieldMode;
    const prepare = async (
      message: PersistedChatMessage,
      final: boolean,
    ): Promise<PersistedChatMessage> => {
      const value = await this.log.artifacts.externalize(
        write.chatId,
        message,
        created,
        transcriptFieldPolicy(fields, final),
      );
      assertTranscriptRowWithinLimit(value);
      return value;
    };
    const externalize = async (
      messages:
        | Iterable<PersistedChatMessage>
        | AsyncIterable<PersistedChatMessage>,
      activeTailCount: number,
    ): Promise<PersistedChatMessage[]> => {
      const stored: PersistedChatMessage[] = [];
      for await (const message of prepareRowsWithActiveTail(
        messages,
        activeTailCount,
        prepare,
      ))
        stored.push(message);
      assertUniqueIds(stored);
      return stored;
    };
    const activeTailCount = write.activeTailCount ?? 0;
    if (!Number.isSafeInteger(activeTailCount) || activeTailCount < 0)
      throw new Error('Invalid replacement active suffix');
    if (write.kind === 'patch') {
      if (create) throw new Error('A patch requires an existing transcript');
      const patches = await externalize(write.patches, 0);
      const tail = await externalize(write.tail, activeTailCount);
      if (activeTailCount > tail.length)
        throw new Error('Invalid replacement active suffix');
      return {
        chatId: write.chatId,
        kind: 'patch',
        patches,
        removedMessageIds: [...write.removedMessageIds],
        tail,
        activeTailCount,
        priorTranscriptRevision: indexedTranscriptRevision(next, write.chatId),
      };
    }
    if (write.kind === 'delete') {
      for await (const message of iterateAsync(write.messages ?? [])) {
        void message;
        throw new Error('Delete must not carry transcript data');
      }
      return { chatId: write.chatId, kind: 'delete' };
    }
    const messages = await externalize(
      write.messages ?? [],
      write.kind === 'replace'
        ? activeTailCount
        : write.kind === 'append'
          ? 0
          : Number.POSITIVE_INFINITY,
    );
    if (write.kind === 'replace') {
      if (activeTailCount > messages.length)
        throw new Error('Invalid replacement active suffix');
      return {
        chatId: write.chatId,
        kind: 'replace',
        create,
        messages,
        activeTailCount,
        priorTranscriptRevision: indexedTranscriptRevision(next, write.chatId),
      };
    }
    if (activeTailCount > 0)
      throw new Error('Invalid replacement active suffix');
    return { chatId: write.chatId, kind: write.kind, create, messages };
  }

  /** The version 2 transaction's checks of `next` and of the writes. */
  private validateCommit(
    state: WriterState,
    input: DeltaJournalCommitInput,
  ): { existing: Set<string>; remaining: Set<string> } {
    const { next, expectedRevision } = input;
    if (state.indexes.live.revision !== expectedRevision)
      throw new Error(
        `V2 revision conflict: expected ${expectedRevision}, current ${state.indexes.live.revision}`,
      );
    assertChatStorageIndexes(next, { allowPendingTranscriptDescriptors: true });
    const activeTabId = next.live.activeTabId;
    if (activeTabId && !next.live.tabs.some((tab) => tab.id === activeTabId))
      throw new Error('Active tab is absent from the v2 index');
    if (next.live.revision !== expectedRevision + 1)
      throw new Error('V2 revision must advance exactly once');
    if (next.recovery.mutationIds.length > DELTA_JOURNAL_MUTATION_ID_WINDOW)
      throw new Error('Mutation id window exceeded');
    const retained = new Set(next.recovery.mutationIds);
    if (input.mutationIds.some((id) => !retained.has(id)))
      throw new Error('Committed mutation ids must be retained');
    const existing = chatIds(state.indexes);
    const remaining = chatIds(next);
    assertChatStorageIndexes(next, {
      pendingTranscriptChatIds: new Set(
        Array.from(remaining).filter((id) => !existing.has(id)),
      ),
    });
    const changed = new Set<string>();
    for (const write of input.writes) {
      if (
        write.target &&
        (write.target.kind !== 'primary' ||
          write.target.chatId !== write.chatId)
      )
        throw new Error(
          'Delegation transcript content is not supported in format 4 phase 05',
        );
      assertTranscriptIdentity(write.chatId);
      const identity = transcriptTargetKey({
        kind: 'primary',
        chatId: write.chatId,
      });
      if (changed.has(identity))
        throw new Error(
          'Only one transcript effect per target is allowed in a scope transaction',
        );
      changed.add(identity);
      if ((write.kind === 'delete') === remaining.has(write.chatId))
        throw new Error(
          'Transcript effect disagrees with target index membership',
        );
    }
    for (const id of Array.from(remaining))
      if (
        !existing.has(id) &&
        !changed.has(transcriptTargetKey({ kind: 'primary', chatId: id }))
      )
        throw new Error(
          'New chat must initialize a transcript in the same transaction',
        );
    for (const id of Array.from(existing))
      if (
        !remaining.has(id) &&
        !changed.has(transcriptTargetKey({ kind: 'primary', chatId: id }))
      )
        throw new Error('Removed chat must declare its transcript deletion');
    return { existing, remaining };
  }

  private async prepareRegistrations(
    input: DeltaJournalCommitInput,
    state: WriterState,
  ): Promise<TranscriptStreamRegistration[]> {
    const requested = input.streamRegistrations ?? [];
    if (requested.length && this.journalVersion !== 2)
      throw new Error('Stream registration requires format 4');
    const parents = chatIds(input.next);
    const seen = new Set<string>();
    const existing = new Set<string>();
    for (const record of state.records)
      if (record.v === 2)
        for (const entry of record.streamRegistrations)
          existing.add(transcriptTargetKey(entry.target));
    const entries: TranscriptStreamRegistration[] = [];
    for (const item of requested) {
      assertTranscriptIdentity(item.target.chatId);
      if (!parents.has(item.target.chatId))
        throw new Error(
          'Stream registration requires a parent chat in resulting indexes',
        );
      const key = transcriptTargetKey(item.target);
      if (seen.has(key) || existing.has(key))
        throw new Error('Duplicate stream registration');
      seen.add(key);
      if (delegationStreamKey(item.target) !== item.streamKey)
        throw new Error('Stream registration key mismatch');
      const path = streamRegistryPaths(
        this.transcriptsRoot,
        item.target.chatId,
        item.streamKey,
      );
      try {
        const registry = parseStreamRegistry(
          await readFile(path.registry),
          item.target.chatId,
        );
        if (
          registry.entries.some(
            (entry) => transcriptTargetKey(entry.target) === key,
          )
        )
          throw new Error('Duplicate stream registration');
      } catch (error) {
        if (!(isErrnoException(error) && error.code === 'ENOENT')) throw error;
      }
      entries.push({
        type: 'stream',
        version: 1,
        target: item.target,
        streamKey: item.streamKey,
        registeredAtRevision: input.expectedRevision + 1,
        ...(item.openedAt === undefined ? {} : { openedAt: item.openedAt }),
      });
    }
    return entries;
  }

  /**
   * Whether the commit retries an applied one: every mutation id is retained
   * (a synced record whose acknowledgement was lost, or a record admitted
   * ahead of it).
   */
  private async isAppliedRetry(
    state: WriterState,
    input: DeltaJournalCommitInput,
    childIdentical: boolean,
  ): Promise<boolean> {
    if (
      input.mutationIds.length > 0 &&
      input.mutationIds.every((id) => state.mutationIds.has(id))
    ) {
      // A retry repeats its child content; different content would be dropped.
      if (!childIdentical)
        throw new Error(
          'Commit reuses an applied mutation with different child content or registry effects',
        );
      const matchingRecords = state.records.filter((record) =>
        record.mutationIds.some((id) => input.mutationIds.includes(id)),
      );
      if (matchingRecords.length > 0) {
        const expectedEffects = matchingRecords.flatMap((record) =>
          record.v === 2 ? (record.registryEffects ?? []) : [],
        );
        const expectedExplicitEffects = expectedEffects.filter(
          (effect) => effect.kind !== 'child-admission',
        );
        const expectedAdmissions = expectedEffects.filter(
          (effect) => effect.kind === 'child-admission',
        );
        const actualEffects = input.registryEffects ?? [];
        if (
          expectedExplicitEffects.length !== actualEffects.length ||
          expectedExplicitEffects.some(
            (effect, index) => !isDeepStrictEqual(effect, actualEffects[index]),
          )
        )
          throw new Error(
            'Commit reuses an applied mutation with different registry effects',
          );
        const actualAdmissions: DelegationRegistryJournalEffect[] = [];
        for (const write of input.childWrites ?? []) {
          if (write.mutationKey === undefined) continue;
          const items = [];
          for (const row of write.rows) {
            const item = await this.registry.itemAdmission({
              target: write.target,
              messageId: row.id,
              itemRevision: row.itemRevision,
            });
            if (item && item.mutationKey === write.mutationKey)
              items.push(item);
          }
          actualAdmissions.push(...childAdmissionEffects(write.target, items));
        }
        if (
          expectedAdmissions.length !== actualAdmissions.length ||
          expectedAdmissions.some(
            (effect, index) =>
              !isDeepStrictEqual(effect, actualAdmissions[index]),
          )
        )
          throw new Error(
            'Commit reuses an applied mutation with different child admissions',
          );
      }
      return true;
    }
    if (input.mutationIds.some((id) => state.mutationIds.has(id)))
      throw new Error('Commit repeats part of an applied mutation');
    return false;
  }

  /**
   * Durable child row state, not the bounded mutation window, decides replay.
   * `identical`: the child rows and settlements match what is stored.
   */
  private async childReplay(
    state: WriterState,
    input: DeltaJournalCommitInput,
    created: CreatedArtifacts,
  ): Promise<{ replay: boolean; identical: boolean }> {
    // Only durable child, registry or descriptor state can make a commit a
    // replay; a commit with none of them (index or mutation-window only) is
    // never one.
    if (
      !input.childWrites?.length &&
      !input.registryEffects?.length &&
      !input.streamDescriptorUpdates?.length
    )
      return { replay: false, identical: true };
    let identical = true;
    for (const write of input.childWrites ?? []) {
      const overlay = await this.childOverlayFor(
        state.childOverlays,
        write.target,
      );
      const stored: DelegationChildRow[] = [];
      for (const row of write.rows) {
        if (!isDelegationChildRow(row)) throw new Error('Invalid child row');
        // Compare the prepared row: a replay matches only the stored form.
        const externalized = await this.log.artifacts.externalize(
          write.target.chatId,
          row,
          created,
          transcriptFieldPolicy(this.fieldMode, row.final),
        );
        if (!isDelegationChildRow(externalized))
          throw new Error('Invalid externalized child row');
        stored.push(externalized);
      }
      if (!(await overlay.matches(stored))) identical = false;
      await overlay.apply(stored);
      if (write.settle) {
        const descriptor = await this.streamDescriptorFor(
          state.descriptorOverlays,
          write.target,
        );
        const update = write.settle.descriptorUpdate;
        // A reused settlement key is a replay only with the same settlement.
        if (
          descriptor.status !== 'settled' ||
          descriptor.settleReceipt?.mutationId !== write.settle.key ||
          !isDeepStrictEqual(descriptor.settleReceipt, update.settleReceipt) ||
          descriptor.streamRevision !== update.nextStreamRevision ||
          (update.cardState !== undefined &&
            !isDeepStrictEqual(descriptor.cardState, update.cardState))
        )
          identical = false;
      }
      if (write.mutationKey !== undefined) {
        for (const row of stored) {
          const admission = await this.registry.itemAdmission({
            target: write.target,
            messageId: row.id,
            itemRevision: row.itemRevision,
          });
          // An identical current revision replays under any mutation key and
          // keeps its original admission (P8); only inconsistent metadata
          // conflicts.
          if (
            (admission && admission.id !== row.id) ||
            (admission !== undefined &&
              (admission.itemRevision !== row.itemRevision ||
                !Number.isSafeInteger(admission.admittingStreamRevision) ||
                admission.admittingStreamRevision < 1))
          )
            registryError(
              'conflict',
              'Child item admission conflicts with the stored revision.',
            );
          if (!admission) identical = false;
        }
      }
    }
    for (const effect of input.registryEffects ?? [])
      if (!(await this.registryEffectMatches(effect))) identical = false;
    for (const descriptorInput of input.streamDescriptorUpdates ?? []) {
      const descriptor = await this.streamDescriptorFor(
        state.descriptorOverlays,
        descriptorInput.target,
      );
      if (
        descriptor.streamRevision !==
          descriptorInput.update.nextStreamRevision ||
        !isDeepStrictEqual(
          descriptor.cardState,
          descriptorInput.update.cardState ?? null,
        )
      )
        identical = false;
    }
    return {
      identical,
      replay:
        identical &&
        input.writes.length === 0 &&
        (input.streamRegistrations?.length ?? 0) === 0 &&
        nonRevisionIndexState(state.indexes) ===
          nonRevisionIndexState(input.next),
    };
  }

  private async registryEffectMatches(
    effect: DelegationRegistryJournalEffect,
  ): Promise<boolean> {
    if (effect.kind === 'delegation-receipt') {
      const stored = await this.registry.receipt({
        chatId: effect.entry.chatId,
        receiptKind: effect.entry.receiptKind,
        key: effect.entry.key,
      });
      if (stored === undefined) return false;
      if (
        canonicalDelegationJson(stored) !==
        canonicalDelegationJson(effect.entry)
      )
        registryError(
          'conflict',
          'Receipt identity conflicts with stored entry.',
        );
      return true;
    }
    if (effect.kind === 'delegation-generation') {
      const stored = await this.registry.generationEntry({
        ...effect.identity,
        runGeneration: effect.entry.runGeneration,
      });
      if (stored === undefined) return false;
      if (
        canonicalDelegationJson(stored) !==
        canonicalDelegationJson(effect.entry)
      )
        registryError(
          'conflict',
          'Generation registration conflicts with the stored entry.',
        );
      return true;
    }
    if (effect.kind === 'delegation-result') {
      const stored = await this.registry.resultBySettlementKey({
        chatId: effect.target.chatId,
        delegationId: effect.target.delegationId,
        settlementKey: effect.entry.settlementKey,
      });
      const byGeneration = await this.registry.resultByGeneration({
        chatId: effect.target.chatId,
        delegationId: effect.target.delegationId,
        runGeneration: effect.target.runGeneration,
      });
      if (stored === undefined && byGeneration === undefined) return false;
      if (
        !stored ||
        !byGeneration ||
        !isDeepStrictEqual(stored, effect.entry) ||
        !isDeepStrictEqual(byGeneration, effect.entry)
      )
        registryError(
          'conflict',
          'Delegation result conflicts with the stored entry.',
        );
      return true;
    }
    for (const item of effect.items) {
      const stored = await this.registry.itemAdmission({
        target: effect.target,
        messageId: item.id,
        itemRevision: item.itemRevision,
      });
      if (stored === undefined) return false;
      if (!isDeepStrictEqual(stored, item))
        registryError(
          'conflict',
          'Child admission conflicts with the stored revision.',
        );
    }
    return true;
  }

  /** Frame a record and decode exactly the bytes that will be written. */
  private encodeRecord(
    state: WriterState,
    base: JournalCommit,
    batchStart: number | undefined,
  ): Pick<PreparedRecord, 'encoded' | 'record'> {
    const encoded = encodeDeltaJournalFrame(
      batchStart === undefined ? base : { ...base, batchStart },
    );
    // Apply exactly the bytes being written, as recovery will.
    const decode =
      this.journalVersion === 1
        ? decodeDeltaJournalRecord
        : decodeDeltaJournalV2Record;
    const record = decode({
      offset: state.journalBytes,
      end: state.journalBytes + encoded.frame.length,
      digest: encoded.digest,
      payload: encoded.frame.subarray(FRAME_HEADER_BYTES),
    });
    if (record.type !== 'commit')
      throw new Error('Encoded delta journal record is not a commit');
    return { encoded, record };
  }

  /**
   * Steps 1 to 3 of the commit order: validate the transaction, externalize
   * its tool outputs, frame its record after `state` and admit that record
   * against the in-memory transcript view. Nothing is written to the
   * journal and `state` is not changed.
   */
  private async prepareRecord(
    state: WriterState,
    input: DeltaJournalCommitInput,
    created: CreatedArtifacts,
    batchStart: number | undefined,
  ): Promise<PreparedRecord> {
    if (this.checkpointRequiredFor(input.writes.map((write) => write.chatId)))
      throw new DeltaJournalCheckpointRequiredError(
        'A chat deleted since the last checkpoint is being created again',
      );
    const { existing } = this.validateCommit(state, input);
    const effects: DeltaJournalTranscriptEffect[] = [];
    for (const write of input.writes) {
      const effect = await this.prepareEffect(
        write,
        !existing.has(write.chatId),
        input.next,
        created,
      );
      // One effect per chat per record: an active update leaves the log
      // index one revision past the chat's current one.
      if (isActiveEffect(effect))
        effect.transcriptRevision =
          (state.overlays.get(effect.chatId)?.transcriptRevision ??
            (await this.base.transcriptRevision(effect.chatId))) + 1;
      effects.push(effect);
    }
    const common = {
      type: 'commit' as const,
      prev: state.lastDigest,
      fromRevision: input.expectedRevision,
      toRevision: input.expectedRevision + 1,
      mutationIds: [...input.mutationIds],
      delta: diffChatIndexes(state.indexes, input.next),
    };
    const streamRegistrations = await this.prepareRegistrations(input, state);
    if (
      this.journalVersion !== 2 &&
      (input.childWrites?.length ||
        input.registryEffects?.length ||
        input.streamDescriptorUpdates?.length)
    )
      throw new Error('Child writes require format 4');
    const knownTargets = new Set(
      Array.from(this.childTargets(), transcriptTargetKey),
    );
    for (const registration of streamRegistrations)
      knownTargets.add(transcriptTargetKey(registration.target));
    const childEffects: DeltaJournalV2TranscriptEffect[] = [];
    const admittedChildren = new Map<string, ChildJournalOverlay>();
    const admittedDescriptors = new Map<string, TranscriptStreamDescriptor>();
    const descriptorUpdates: TranscriptStreamDescriptorUpdate[] = [];
    for (const registration of streamRegistrations)
      admittedDescriptors.set(
        transcriptTargetKey(registration.target),
        createEmptyStreamDescriptor(
          registration,
          state.checkpointIndexes.live.revision,
        ),
      );
    const registryEffects: DelegationRegistryJournalEffect[] = [];
    for (const effect of input.registryEffects ?? []) {
      if (effect.kind === 'child-admission')
        throw new Error('Child admission metadata is writer-generated');
      registryEffects.push(effect);
    }
    for (const write of input.childWrites ?? []) {
      const key = transcriptTargetKey(write.target);
      if (!knownTargets.has(key))
        throw new Error('Child target is not registered');
      if (admittedChildren.has(key))
        throw new Error(
          'Only one transcript effect per target is allowed in a scope transaction',
        );
      const rows: DelegationChildRow[] = [];
      for (const row of write.rows) {
        if (!isDelegationChildRow(row)) throw new Error('Invalid child row');
        const stored = await this.log.artifacts.externalize(
          write.target.chatId,
          row,
          created,
          transcriptFieldPolicy(this.fieldMode, row.final),
        );
        if (!isDelegationChildRow(stored))
          throw new Error('Invalid externalized child row');
        assertTranscriptRowWithinLimit(stored);
        rows.push(stored);
      }
      const overlay = await this.childOverlayFor(
        state.childOverlays,
        write.target,
      );
      const changedRows = await overlay.apply(rows);
      admittedChildren.set(key, overlay);
      const descriptor =
        admittedDescriptors.get(key) ??
        (await this.streamDescriptorFor(
          state.descriptorOverlays,
          write.target,
        ));
      if (descriptor.status === 'settled')
        throw new Error('Settled child stream is immutable');
      const latestRowTimestamp = maximumRowTimestamp(
        descriptor.latestRowTimestamp,
        changedRows,
      );
      const settleUpdate = write.settle?.descriptorUpdate;
      // The writer derives the timestamp from the rows; a caller that states
      // one must agree with it.
      if (
        settleUpdate?.latestRowTimestamp !== undefined &&
        settleUpdate.latestRowTimestamp !== latestRowTimestamp
      )
        throw new Error(
          'Child settlement latest row timestamp disagrees with its rows',
        );
      const update: TranscriptStreamDescriptorUpdate = settleUpdate
        ? { ...settleUpdate, latestRowTimestamp }
        : {
            version: 1,
            target: write.target,
            expectedStreamRevision: descriptor.streamRevision,
            nextStreamRevision: descriptor.streamRevision + 1,
            latestRowTimestamp,
          };
      if (transcriptTargetKey(update.target) !== key)
        throw new Error('Child descriptor target mismatch');
      admittedDescriptors.set(
        key,
        applyStreamDescriptorUpdate(descriptor, update),
      );
      descriptorUpdates.push(update);
      if (write.settle) {
        if (
          write.settle.descriptorUpdate.target.kind !== 'delegation' ||
          transcriptTargetKey(write.settle.descriptorUpdate.target) !== key
        )
          throw new Error('Child settlement descriptor target mismatch');
        const receipt = write.settle.descriptorUpdate.settleReceipt;
        if (
          write.settle.key.length === 0 ||
          rows.some((row) => !row.final) ||
          // A settled stream is immutable, so no admitted row may stay open.
          overlay.openRows.length > 0 ||
          write.settle.descriptorUpdate.status !== 'settled' ||
          receipt?.mutationId !== write.settle.key ||
          receipt.scopeRevision !== input.expectedRevision + 1
        )
          throw new Error('Invalid child settlement');
        // The checkpoint verifies the same totals; reject now rather than journal a receipt it cannot publish.
        if (
          !receiptMatches(
            receipt,
            await this.childLogTotals(
              write.target,
              overlay.newlyFinalRows,
              true,
            ),
          )
        )
          throw new Error('Child settlement receipt disagrees with its stream');
        childEffects.push({
          kind: 'child-settle',
          target: write.target,
          rows: changedRows,
          settlementKey: write.settle.key,
        });
      } else
        childEffects.push({
          kind: 'child-upsert',
          target: write.target,
          rows: changedRows,
        });
      if (write.mutationKey !== undefined) {
        if (!validRegistryId(write.mutationKey))
          throw new Error('Invalid child mutation key');
        const mutationKey = write.mutationKey;
        const admissions = changedRows.map((row) => ({
          id: row.id,
          itemRevision: row.itemRevision,
          admittingStreamRevision: update.nextStreamRevision,
          mutationKey,
        }));
        registryEffects.push(
          ...childAdmissionEffects(write.target, admissions),
        );
      }
    }
    for (const descriptorInput of input.streamDescriptorUpdates ?? []) {
      const { target, update } = descriptorInput;
      const key = transcriptTargetKey(target);
      if (!knownTargets.has(key))
        throw new Error('Descriptor target is not registered');
      if (admittedDescriptors.has(key))
        throw new Error(
          'Only one descriptor update per target is allowed in a scope transaction',
        );
      const allowedKeys = new Set([
        'version',
        'target',
        'expectedStreamRevision',
        'nextStreamRevision',
        'cardState',
      ]);
      if (
        transcriptTargetKey(update.target) !== key ||
        Object.keys(update).some((field) => !allowedKeys.has(field))
      )
        throw new Error(
          'Card-only descriptor update contains unsupported fields',
        );
      const descriptor = await this.streamDescriptorFor(
        state.descriptorOverlays,
        target,
      );
      if (
        descriptor.streamRevision !== update.expectedStreamRevision ||
        update.nextStreamRevision !== update.expectedStreamRevision + 1
      )
        throw new Error('Card-only descriptor update revision is stale');
      admittedDescriptors.set(
        key,
        applyStreamDescriptorUpdate(descriptor, update),
      );
      descriptorUpdates.push(update);
    }
    const base: JournalCommit =
      this.journalVersion === 1
        ? { ...common, v: 1, transcripts: effects }
        : {
            ...common,
            v: 2,
            transcripts: [
              ...effects.map((effect) => {
                const { chatId, ...payload } = effect;
                return {
                  ...payload,
                  target: { kind: 'primary' as const, chatId },
                };
              }),
              ...childEffects,
            ],
            streamRegistrations,
            descriptorUpdates,
            ...(registryEffects.length === 0 ? {} : { registryEffects }),
          };
    const { encoded, record } = this.encodeRecord(state, base, batchStart);
    const indexes = applyRecordMetadata(
      state.indexes,
      record,
      assertChatStorageIndexes,
    );
    const admitted = new Map<string, ChatTranscriptOverlay>();
    for (const effect of primaryEffects(record)) {
      const overlay = await this.overlayFor(state.overlays, effect);
      await overlay.apply(effect, record.toRevision);
      if (
        isActiveEffect(effect) &&
        effect.transcriptRevision !== overlay.transcriptRevision
      )
        throw new Error('Active update revision disagrees with its log');
      admitted.set(effect.chatId, overlay);
    }
    return {
      base,
      encoded,
      record,
      indexes,
      admitted,
      admittedChildren,
      admittedDescriptors,
      primaryRecord:
        record.v === 1 ||
        primaryEffects(record).length > 0 ||
        nonRevisionIndexState(state.indexes) !== nonRevisionIndexState(indexes),
    };
  }

  /** The in-memory state once `prepared` follows `state`. */
  private advanced(state: WriterState, prepared: PreparedRecord): WriterState {
    const registrations =
      prepared.record.v === 2 ? prepared.record.streamRegistrations : [];
    const deletedParents =
      registrations.length > 0 || state.registeredTargets.length > 0
        ? new Set(
            primaryEffects(prepared.record)
              .filter((effect) => effect.kind === 'delete')
              .map((effect) => effect.chatId),
          )
        : new Set<string>();
    const registeredTargets =
      registrations.length === 0 && deletedParents.size === 0
        ? state.registeredTargets
        : Array.from(
            new Map([
              ...state.registeredTargets.map(
                (target) => [transcriptTargetKey(target), target] as const,
              ),
              ...registrations.map(
                (registration) =>
                  [
                    transcriptTargetKey(registration.target),
                    registration.target,
                  ] as const,
              ),
            ]).values(),
          ).filter((target) => !deletedParents.has(target.chatId));
    return {
      ...state,
      indexes: prepared.indexes,
      records: [...state.records, prepared.record],
      overlays: new Map([
        ...Array.from(state.overlays),
        ...Array.from(prepared.admitted),
      ]),
      childOverlays: new Map([
        ...Array.from(state.childOverlays),
        ...Array.from(prepared.admittedChildren),
      ]),
      descriptorOverlays: new Map([
        ...Array.from(state.descriptorOverlays),
        ...Array.from(prepared.admittedDescriptors),
      ]),
      lastDigest: prepared.encoded.digest,
      journalBytes: state.journalBytes + prepared.encoded.frame.length,
      mutationIds: new Set(prepared.indexes.recovery.mutationIds),
      registeredTargets,
      primaryRecordCount:
        state.primaryRecordCount + (prepared.primaryRecord ? 1 : 0),
    };
  }

  /**
   * Durably commit one transaction, alone: append its record and sync before
   * returning. Records admitted for group commit are made durable first.
   * Retrying a commit whose every mutation id is retained (a synced record
   * whose acknowledgement was lost) returns `applied: false` without writing.
   */
  public async commit(
    input: DeltaJournalCommitInput,
  ): Promise<DeltaJournalCommitResult> {
    return this.serial(async () => {
      const created = input.created ?? new CreatedArtifacts();
      let wrote = false;
      try {
        await this.drainGroupCommit();
        // Inside the `try`: a batch that failed while this commit waited
        // left the writer unusable. Nothing of this commit was written, so
        // its artifacts are discarded below.
        const state = this.current();
        const child = await this.childReplay(state, input, created);
        if (child.replay) {
          await created.discard();
          return { applied: false, revision: state.indexes.live.revision };
        }
        if (await this.isAppliedRetry(state, input, child.identical)) {
          // Files the caller created for this retry are referenced by
          // nothing: the applied record found its own artifacts in place.
          await created.discard();
          return { applied: false, revision: state.indexes.live.revision };
        }
        const prepared = await this.prepareRecord(
          state,
          input,
          created,
          undefined,
        );
        const { frame } = prepared.encoded;
        await input.preparePublish?.();
        const handle = await open(this.journalPath, 'r+');
        try {
          if (
            prepared.record.v === 2 &&
            prepared.record.registryEffects?.some(
              (effect) => effect.kind === 'delegation-receipt',
            )
          )
            await this.boundary('receipt-effect');
          // Keep the authorization decision at the exact publication
          // boundary, as version 2 transactions do before their rename.
          input.beforePublish?.();
          wrote = true;
          await writeAt(handle, frame, state.journalBytes);
          recordChatStorageFileWrite(this.journalPath, frame.length, true);
          await this.boundary('record-written');
          await handle.sync();
          recordChatStorageFileSync(this.journalPath);
          await this.boundary('record-synced');
        } finally {
          await handle.close();
        }
        this.state = this.advanced(state, prepared);
        await this.appendRegistryEffects(prepared.record);
        return {
          applied: true,
          revision: prepared.indexes.live.revision,
          indexes: prepared.indexes,
        };
      } catch (error) {
        if (wrote) {
          // The record may be durable. Keep its artifacts and require a
          // reopen, whose recovery decides from the bytes on disk.
          this.poisoned =
            error instanceof Error ? error : new Error(String(error));
        } else await created.discard();
        throw error;
      }
    });
  }

  /**
   * Admit one transaction for group commit (P1 §B): steps 1 to 3 of the
   * commit order run now, against the latest admitted state, and the
   * in-memory state advances at once so the next transaction is prepared
   * against it. Step 4 is shared: with no append in flight the record is
   * written and synced immediately; otherwise it is written with the other
   * records admitted meanwhile, as one append and one sync (see
   * `group-commit.ts`). The record must not be acknowledged or published
   * before `durable` resolves.
   *
   * A record that is not the first of its batch names the batch's start, so
   * recovery can tell that batch's unsynced tail from corruption.
   *
   * A failed append or sync leaves the writer unusable and rejects every
   * record not yet durable; their artifacts are kept, because any of them
   * may be on disk. A transaction that reaches the unusable writer was never
   * queued: it is rejected and its artifacts are discarded. A commit with
   * publish hooks is not group committed: its check belongs at the exact
   * write boundary ({@link commit}).
   */
  public async admit(
    input: DeltaJournalCommitInput,
  ): Promise<DeltaJournalAdmission> {
    if (input.preparePublish || input.beforePublish)
      throw new Error('A commit with publish hooks is not group committed');
    return this.serial(async () => {
      const created = input.created ?? new CreatedArtifacts();
      let queued = false;
      try {
        // Inside the `try`: a batch that failed while this transaction was
        // being built left the writer unusable. A record that was never
        // queued cannot be durable, so its artifacts are discarded below.
        const state = this.current();
        const child = await this.childReplay(state, input, created);
        if (child.replay) {
          await created.discard();
          return {
            result: { applied: false, revision: state.indexes.live.revision },
            durable: this.groupCommit.settled(),
          };
        }
        if (await this.isAppliedRetry(state, input, child.identical)) {
          await created.discard();
          return {
            result: { applied: false, revision: state.indexes.live.revision },
            // Not acknowledged before the record it repeats is durable.
            durable: this.groupCommit.settled(),
          };
        }
        const openBatch = this.groupCommit.joinableStart();
        let prepared = await this.prepareRecord(
          state,
          input,
          created,
          openBatch,
        );
        // Synchronous from here: the checks, the queueing and the new state
        // are one step. A batch that failed meanwhile poisoned the writer.
        if (this.current() !== state)
          throw new Error('Delta journal state changed during admission');
        input.beforeAdmit?.();
        let joined = openBatch;
        if (
          joined !== undefined &&
          (this.groupCommit.joinableStart() !== joined ||
            !this.groupCommit.fits(prepared.encoded.frame.length))
        ) {
          // Its batch is being written already, or is full: the record
          // starts the next batch and names none.
          joined = undefined;
          prepared = {
            ...prepared,
            ...this.encodeRecord(state, prepared.base, undefined),
          };
        }
        const durable = this.groupCommit
          .add(state.journalBytes, prepared.encoded.frame, joined)
          .then(async () => {
            try {
              await this.appendRegistryEffects(prepared.record);
            } catch (error) {
              this.poisoned ??=
                error instanceof Error ? error : new Error(String(error));
              throw error;
            }
          });
        // As the queue's own promise: a dropped one must not turn a failed
        // batch into an unhandled rejection.
        durable.catch(() => undefined);
        queued = true;
        this.state = this.advanced(state, prepared);
        return {
          result: {
            applied: true,
            revision: prepared.indexes.live.revision,
            indexes: prepared.indexes,
          },
          durable,
        };
      } catch (error) {
        if (!queued) await created.discard();
        throw error;
      }
    });
  }

  /** Append one batch's frames at its offset and sync the journal once. */
  private async writeBatch(batch: GroupCommitBatch): Promise<void> {
    // A demotion retired this writer: nothing may reach the journal a
    // version 2 load ignores.
    if (manifestGeneration(this.directory) !== this.manifestGenerationAtOpen)
      throw new Error('Delta journal writer is closed: its scope is version 2');
    const bytes =
      batch.frames.length === 1
        ? batch.frames[0]
        : Buffer.concat(batch.frames, batch.bytes);
    const handle = await open(this.journalPath, 'r+');
    try {
      await writeAt(handle, bytes, batch.start);
      recordChatStorageFileWrite(this.journalPath, bytes.length, true);
      await this.boundary('record-written');
      await handle.sync();
      recordChatStorageFileSync(this.journalPath);
      await this.boundary('record-synced');
    } finally {
      await handle.close();
    }
  }

  /** Wait until no admitted record is pending; a failure poisons the writer. */
  private async drainGroupCommit(): Promise<void> {
    while (this.groupCommit.active)
      await this.groupCommit.settled().catch(() => undefined);
  }

  /**
   * Settles when every record admitted so far is durable; rejects when a
   * batch failed (the writer is then no longer open). Undefined when nothing
   * is pending. Until it settles, the writer's state is ahead of the
   * journal: readers other than the next admission wait for it.
   */
  public pendingDurability(): Promise<void> | undefined {
    return this.groupCommit.active ? this.groupCommit.settled() : undefined;
  }

  /**
   * A chat deleted since the last checkpoint can be written again only after
   * a checkpoint removes its old files, because its new tool outputs share
   * the directory that deletion removes. Callers checkpoint first, before
   * externalizing anything for it.
   */
  public checkpointRequiredFor(chatIds: readonly string[]): boolean {
    const { overlays } = this.current();
    return chatIds.some((chatId) => overlays.get(chatId)?.isDeleted === true);
  }

  /** Materialize every record into the version 2 files and rotate. */
  public async checkpoint(): Promise<ChatStorageIndexes> {
    return this.serial(async () => {
      // A checkpoint applies records the journal already holds durably.
      await this.drainGroupCommit();
      return this.checkpointLocked();
    });
  }

  private async checkpointLocked(): Promise<ChatStorageIndexes> {
    const state = this.current();
    if (state.records.length === 0) return state.indexes;
    this.materializing = true;
    try {
      const result = await this.runCheckpoint(
        state.checkpointIndexes,
        state.records,
        state.checkpointIndexes.live.revision,
        state.lastDigest,
        false,
      );
      const presentChats = chatIds(result.indexes);
      this.state = {
        checkpointIndexes: result.indexes,
        indexes: result.indexes,
        records: [],
        overlays: new Map(),
        childOverlays: new Map(),
        descriptorOverlays: new Map(),
        lastDigest: result.digest,
        journalBytes: result.journalBytes,
        mutationIds: new Set(result.indexes.recovery.mutationIds),
        registeredTargets: state.registeredTargets.filter((target) =>
          presentChats.has(target.chatId),
        ),
        primaryRecordCount: 0,
      };
      return result.indexes;
    } catch (error) {
      this.poisoned = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      this.materializing = false;
    }
  }

  private async writeMarker(marker: DeltaCheckpointMarker): Promise<void> {
    await writeAtomicJson(
      join(this.directory, DELTA_CHECKPOINT_MARKER_NAME),
      marker,
    );
  }

  /**
   * Save sidecar-owned anchors before a checkpoint rewrite removes the
   * active sidecar. The synced capture is reusable after an interrupted
   * rewrite; format-3 effects deliberately remain anchor-free.
   */
  private async checkpointAnchors(
    workDirectory: string,
    checkpointFromRevision: number,
    checkpointTargetRevision: number,
    record: JournalCommit,
    effect: DeltaJournalTranscriptEffect,
    effectIndex: number,
  ): Promise<ReadonlyMap<string, ActiveRowAnchor>> {
    const identity = {
      checkpointFromRevision,
      checkpointTargetRevision,
      record,
      effectIndex,
      effect,
    };
    const existing = await readCheckpointAnchorCapture(workDirectory, identity);
    if (existing) return existing;

    let anchors = new Map<string, ActiveRowAnchor>();
    if (await this.base.exists(effect.chatId)) {
      const snapshot = this.base.activeSnapshot
        ? await this.base.activeSnapshot(effect.chatId)
        : undefined;
      anchors = snapshot?.anchors ?? anchors;
    }
    const createdDirectory = await mkdir(workDirectory, { recursive: true });
    if (createdDirectory) await fsyncDirectory(this.directory);
    await writeAtomicJson(
      checkpointAnchorCapturePath(
        workDirectory,
        record,
        effectIndex,
        effect.chatId,
      ),
      encodeCheckpointAnchorCapture(identity, anchors),
    );
    return anchors;
  }

  /**
   * Apply records after `appliedThrough` to the transcript files. A
   * progress marker is on disk before the first file changes (`markerOnDisk`
   * when a resumed checkpoint already has one); it advances only around
   * records that are not runs of revisioned active updates.
   */
  private async applyTranscriptRecords(
    records: readonly JournalCommit[],
    fromRevision: number,
    targetRevision: number,
    appliedThrough: number,
    markerOnDisk: boolean,
    workDirectory: string,
  ): Promise<void> {
    let marked: number | undefined = markerOnDisk ? appliedThrough : undefined;
    const mark = async (through: number): Promise<void> => {
      if (marked === through) return;
      await this.writeMarker({
        v: this.journalVersion,
        phase: 'transcripts',
        fromRevision,
        targetRevision,
        appliedThrough: through,
      });
      marked = through;
    };
    // Re-applying from `appliedThrough` is what recovery does, so the first
    // file change needs a marker saying so.
    const beforeWrite = async (): Promise<void> => {
      if (marked === undefined) await mark(appliedThrough);
    };
    const runs = new Map<string, ActiveRun>();
    /** A chat's open run, removed and folded to its resulting rows. */
    const takeRun = async (
      chatId: string,
    ): Promise<
      | { messages: PersistedChatMessage[]; transcriptRevision: number }
      | undefined
    > => {
      const run = runs.get(chatId);
      if (!run) return undefined;
      runs.delete(chatId);
      let messages = run.messages ?? (await this.log.activeMessages(chatId));
      for (const upserts of run.upserts)
        messages = upsertActiveMessages(messages, upserts);
      return { messages, transcriptRevision: run.transcriptRevision };
    };
    const writeRun = async (chatId: string): Promise<void> => {
      const run = await takeRun(chatId);
      if (!run) return;
      await beforeWrite();
      await this.log.writeActiveAtRevision(
        chatId,
        run.messages,
        run.transcriptRevision,
        undefined,
        this.materializeFieldMode,
      );
    };
    const writeRuns = async (): Promise<void> => {
      for (const chatId of Array.from(runs.keys())) await writeRun(chatId);
    };
    const foldRun = (
      effect: DeltaJournalTranscriptEffect,
      transcriptRevision: number,
    ): void => {
      if (!isActiveEffect(effect)) throw new Error('Not an active update');
      const run = runs.get(effect.chatId) ?? {
        upserts: [],
        transcriptRevision,
      };
      run.transcriptRevision = transcriptRevision;
      if (effect.kind !== 'active-upsert') {
        run.messages = [...effect.messages];
        run.upserts = [];
      } else if (run.messages)
        run.messages = upsertActiveMessages(run.messages, effect.messages);
      else run.upserts.push(effect.messages);
      runs.set(effect.chatId, run);
    };
    const last = records[records.length - 1];
    for (const record of records) {
      if (record.toRevision <= appliedThrough) continue;
      const effects = primaryEffects(record);
      // A child-only record changes no primary transcript: its rows are
      // applied from every record below, so it neither flushes the open runs
      // nor needs a progress marker of its own.
      if (effects.length === 0) continue;
      const coalesced =
        effects.length > 0 &&
        effects.every(
          (effect) =>
            isActiveEffect(effect) && effect.transcriptRevision !== undefined,
        );
      if (coalesced) {
        for (const effect of effects)
          if (isActiveEffect(effect) && effect.transcriptRevision !== undefined)
            foldRun(effect, effect.transcriptRevision);
        continue;
      }
      // Everything before this record is applied before it is, except a run
      // this record's own append finalizes (a turn end): its rows reach the
      // log through that append, never through a sidecar rewrite.
      const finalizing = new Set(
        effects
          .filter(
            (effect) =>
              effect.kind === 'append' &&
              !effect.create &&
              runs.has(effect.chatId),
          )
          .map((effect) => effect.chatId),
      );
      for (const chatId of Array.from(runs.keys()))
        if (!finalizing.has(chatId)) await writeRun(chatId);
      // The marker claims this record's predecessors only once their runs
      // are written. Otherwise a resumed checkpoint folds the run again from
      // the records after the marker, and the append is idempotent.
      if (marked !== undefined && finalizing.size === 0)
        await mark(record.fromRevision);
      // Anchor captures are keyed by the effect's index among the primary
      // effects, as materialization reads them back.
      for (
        let effectIndex = 0;
        effectIndex < effects.length;
        effectIndex += 1
      ) {
        const effect = effects[effectIndex];
        if (!effect) throw new Error('Missing transcript effect');
        await beforeWrite();
        const run =
          effect.kind === 'append' && finalizing.has(effect.chatId)
            ? await takeRun(effect.chatId)
            : undefined;
        if (run && effect.kind === 'append')
          await this.log.appendAfterActive(
            effect.chatId,
            effect.messages,
            run.messages,
            run.transcriptRevision,
            undefined,
            this.materializeFieldMode,
          );
        else if (
          isActiveEffect(effect) &&
          effect.transcriptRevision !== undefined
        ) {
          foldRun(effect, effect.transcriptRevision);
          await writeRun(effect.chatId);
        } else {
          const anchors =
            effect.kind === 'replace' || effect.kind === 'patch'
              ? await this.checkpointAnchors(
                  workDirectory,
                  fromRevision,
                  targetRevision,
                  record,
                  effect,
                  effectIndex,
                )
              : undefined;
          await applyTranscriptEffect(
            this.log,
            this.transcriptsRoot,
            effect,
            record.toRevision,
            workDirectory,
            this.materializeFieldMode,
            anchors,
          );
        }
      }
      // After the last record the `publishing` marker follows; until it is
      // written, recovery re-applies this record, which converges.
      if (marked !== undefined && record !== last)
        await mark(record.toRevision);
    }
    await writeRuns();
    if (this.journalVersion === 2) {
      const removedParents = new Set(
        records.flatMap((record) =>
          primaryEffects(record)
            .filter((effect) => effect.kind === 'delete')
            .map((effect) => effect.chatId),
        ),
      );
      for (const record of records)
        if (record.v === 2)
          for (const registration of record.streamRegistrations) {
            if (removedParents.has(registration.target.chatId)) continue;
            const paths = streamRegistryPaths(
              this.transcriptsRoot,
              registration.target.chatId,
              registration.streamKey,
            );
            await beforeWrite();
            await mkdir(paths.streamDirectory, { recursive: true });
            const log = await open(paths.log, 'a');
            try {
              await log.sync();
            } finally {
              await log.close();
            }
          }
      const children = new Map<string, ChildJournalOverlay>();
      const changed = new Set<string>();
      for (const record of records) {
        if (record.v !== 2) continue;
        for (const effect of record.transcripts) {
          if (effect.kind !== 'child-upsert' && effect.kind !== 'child-settle')
            continue;
          if (removedParents.has(effect.target.chatId)) continue;
          const key = transcriptTargetKey(effect.target);
          const overlay = await this.childOverlayFor(
            children,
            effect.target,
            true,
          );
          await overlay.apply(effect.rows, true);
          children.set(key, overlay);
          changed.add(key);
        }
      }
      const overlays = Array.from(changed).flatMap((key) => {
        const overlay = children.get(key);
        return overlay?.hasChanges ? [overlay] : [];
      });
      if (overlays.length > 0) await beforeWrite();
      // Each stream's files are its own, so streams overlap their writes and
      // syncs. Recovery re-applies a stream a crash stops, by committed row id.
      await eachStreamMetadataFile(overlays, async (overlay) => {
        const store = this.childStore(overlay.target, false, true);
        const streamKey = delegationStreamKey(overlay.target);
        if (overlay.newlyFinalRows.length)
          await store.appendChildFinalRows(
            streamKey,
            overlay.newlyFinalRows,
            overlay.openRows,
            targetRevision,
            this.materializeFieldMode,
          );
        else
          await store.writeChildOpenRows(
            streamKey,
            overlay.openRows,
            targetRevision,
            this.materializeFieldMode,
          );
      });
    }
  }

  private async stageCheckpointStreamMetadata(
    records: readonly JournalCommit[],
    indexes: ChatStorageIndexes,
  ): Promise<NonNullable<DeltaCheckpointMarker['metadata']>> {
    const removedParents = new Set<string>();
    const registrations = new Map<string, TranscriptStreamRegistration[]>();
    const childTimestamps = new Map<string, number>();
    const updates = new Map<string, TranscriptStreamDescriptorUpdate[]>();
    // Streams whose log, status or settlement these records may change.
    const changedStreams = new Set<string>();
    const changedParents = new Set<string>();
    // Reader-first: released readers before the relaxed closure checks need
    // every descriptor and registry restamped at each checkpoint.
    const incremental = this.options.incrementalStreamMetadata === true;
    for (const record of records) {
      for (const effect of primaryEffects(record))
        if (effect.kind === 'delete') removedParents.add(effect.chatId);
      if (record.v === 2) {
        for (const entry of record.streamRegistrations) {
          const list = registrations.get(entry.target.chatId) ?? [];
          list.push(entry);
          registrations.set(entry.target.chatId, list);
        }
        for (const effect of record.transcripts)
          if (
            effect.kind === 'child-upsert' ||
            effect.kind === 'child-settle'
          ) {
            const key = transcriptTargetKey(effect.target);
            changedStreams.add(key);
            changedParents.add(effect.target.chatId);
            for (const row of effect.rows)
              childTimestamps.set(
                key,
                Math.max(
                  childTimestamps.get(key) ?? row.timestamp,
                  row.timestamp,
                ),
              );
          }
        for (const update of record.descriptorUpdates) {
          const key = transcriptTargetKey(update.target);
          changedStreams.add(key);
          changedParents.add(update.target.chatId);
          const list = updates.get(key) ?? [];
          list.push(update);
          updates.set(key, list);
        }
      }
    }
    const digest = (bytes: Buffer): string =>
      createHash('sha256').update(bytes).digest('hex');
    const stage = async (path: string, bytes: Buffer): Promise<void> => {
      await stageStreamMetadata(path, bytes);
      await fsyncDirectory(dirname(path));
    };
    const childDescriptor = async (
      entry: TranscriptStreamRegistration,
      prior: ReturnType<typeof createEmptyStreamDescriptor>,
    ): Promise<ReturnType<typeof createEmptyStreamDescriptor>> => {
      const key = transcriptTargetKey(entry.target);
      let descriptor = prior;
      for (const update of updates.get(key) ?? [])
        descriptor = applyStreamDescriptorUpdate(descriptor, update);
      const totals = await this.childLogTotals(entry.target, [], false, prior);
      const windowLatest = childTimestamps.get(key);
      const next: TranscriptStreamDescriptor = {
        ...descriptor,
        checkpointRevision: indexes.live.revision,
        committedRowCount: totals.committedRowCount,
        committedByteLength: totals.committedByteLength,
        committedSha256: totals.committedSha256,
        // Revisions keep their row's original time; never move backwards.
        latestRowTimestamp:
          windowLatest === undefined
            ? descriptor.latestRowTimestamp
            : Math.max(
                windowLatest,
                descriptor.latestRowTimestamp ?? windowLatest,
              ),
      };
      if (next.settleReceipt && !receiptMatches(next.settleReceipt, totals))
        throw new ChatDeltaJournalIntegrityError(
          'Child settlement receipt disagrees with committed stream',
        );
      return next;
    };
    // A stream these records leave alone keeps its committed totals, so its
    // log is not reread. A log whose size moved takes the verifying path;
    // deep closure checks at capture, copy and recovery still hash it.
    const unchangedDescriptor = async (
      entry: TranscriptStreamRegistration,
      existing: ReturnType<typeof createEmptyStreamDescriptor>,
      log: string,
    ): Promise<ReturnType<typeof createEmptyStreamDescriptor>> => {
      let size: number | undefined;
      try {
        size = (await stat(log)).size;
      } catch (error) {
        if (!(isErrnoException(error) && error.code === 'ENOENT')) throw error;
      }
      return size === existing.committedByteLength
        ? { ...existing, checkpointRevision: indexes.live.revision }
        : childDescriptor(entry, existing);
    };
    const descriptors: { path: string; sha256: string }[] = [];
    const registries: { path: string; sha256: string }[] = [];
    const catalogPath = streamCatalogPath(this.transcriptsRoot);
    const parents: Record<
      string,
      { entryCount: number; registrySha256: string; registryBytes: number }
    > = { ...parseStreamCatalog(await readFile(catalogPath)).parents };
    const present = chatIds(indexes);
    // A parent removed outside the journal (a compatibility transaction)
    // leaves the catalog like one deleted in these records.
    for (const parent of Object.keys(parents))
      if (!present.has(parent)) removedParents.add(parent);
    for (const parent of Array.from(removedParents)) delete parents[parent];
    const catalogued = new Set(Object.keys(parents));
    const plans: Array<{
      parent: string;
      registry: string;
      prior: TranscriptStreamRegistration[];
      entries: TranscriptStreamRegistration[];
    }> = [];
    for (const parent of Array.from(
      new Set([...Object.keys(parents), ...Array.from(registrations.keys())]),
    )) {
      const entries = registrations.get(parent) ?? [];
      if (removedParents.has(parent) || !present.has(parent)) continue;
      // Incrementally, a parent these records leave alone keeps its registry,
      // its descriptors and its catalog entry from an earlier checkpoint.
      if (
        incremental &&
        entries.length === 0 &&
        !changedParents.has(parent) &&
        catalogued.has(parent)
      )
        continue;
      const first = entries[0];
      const paths = streamRegistryPaths(
        this.transcriptsRoot,
        parent,
        first?.streamKey ?? '0'.repeat(64),
      );
      let prior: TranscriptStreamRegistration[] = [];
      try {
        prior = parseStreamRegistry(
          await readFile(paths.registry),
          parent,
        ).entries;
      } catch (error) {
        if (!(isErrnoException(error) && error.code === 'ENOENT')) throw error;
        // Only a first registration has no registry; a catalogued one is lost.
        if (catalogued.has(parent))
          throw new ChatDeltaJournalIntegrityError(
            'Missing known stream registry',
          );
      }
      plans.push({ parent, registry: paths.registry, prior, entries });
    }
    // Every stream to restage in the scope does so in one bounded pool:
    // incrementally only the changed ones, otherwise every registered one.
    descriptors.push(
      ...(await eachStreamMetadataFile(
        plans.flatMap(({ parent, prior }) =>
          prior
            .filter(
              (entry) =>
                !incremental ||
                changedStreams.has(transcriptTargetKey(entry.target)),
            )
            .map((entry) => ({ parent, entry })),
        ),
        async ({ parent, entry }) => {
          const entryPaths = streamRegistryPaths(
            this.transcriptsRoot,
            parent,
            entry.streamKey,
          );
          const existing = parseStreamDescriptor(
            await readFile(entryPaths.descriptor),
          );
          if (
            transcriptTargetKey(existing.target) !==
              transcriptTargetKey(entry.target) ||
            existing.streamKey !== entry.streamKey
          )
            throw new ChatDeltaJournalIntegrityError(
              'Known descriptor disagrees with registry',
            );
          const bytes = Buffer.from(
            JSON.stringify(
              changedStreams.has(transcriptTargetKey(entry.target))
                ? await childDescriptor(entry, existing)
                : await unchangedDescriptor(entry, existing, entryPaths.log),
            ),
          );
          await stage(entryPaths.descriptor, bytes);
          return { path: entryPaths.descriptor, sha256: digest(bytes) };
        },
      )),
    );
    const registryFiles: Array<{
      parent: string;
      path: string;
      bytes: Buffer;
      entryCount: number;
    }> = [];
    for (const { parent, registry, prior, entries } of plans) {
      const identities = new Set(
        prior.map((entry) => transcriptTargetKey(entry.target)),
      );
      for (const entry of entries) {
        const identity = transcriptTargetKey(entry.target);
        if (identities.has(identity))
          throw new ChatDeltaJournalIntegrityError(
            'Duplicate stream registration at checkpoint',
          );
        identities.add(identity);
        const entryPaths = streamRegistryPaths(
          this.transcriptsRoot,
          parent,
          entry.streamKey,
        );
        await mkdir(entryPaths.streamDirectory, { recursive: true });
        // Every directory mkdir may have created: v2, the parent, delegations,
        // and the transcripts root that holds delegations.
        const chatDirectory = dirname(entryPaths.parentDirectory);
        for (const directory of [
          entryPaths.parentDirectory,
          chatDirectory,
          dirname(chatDirectory),
          dirname(dirname(chatDirectory)),
        ])
          await fsyncDirectory(directory);
        const log = await open(entryPaths.log, 'a');
        try {
          await log.sync();
        } finally {
          await log.close();
        }
        await fsyncDirectory(entryPaths.streamDirectory);
        const descriptor = Buffer.from(
          JSON.stringify(
            await childDescriptor(
              entry,
              createEmptyStreamDescriptor(entry, indexes.live.revision),
            ),
          ),
        );
        await stage(entryPaths.descriptor, descriptor);
        descriptors.push({
          path: entryPaths.descriptor,
          sha256: digest(descriptor),
        });
        prior.push(entry);
      }
      // Its registry changes only with a registration.
      if (incremental && entries.length === 0 && catalogued.has(parent))
        continue;
      registryFiles.push({
        parent,
        path: registry,
        bytes: encodeStreamRegistry(parent, indexes.live.revision, prior),
        entryCount: prior.length,
      });
    }
    await eachStreamMetadataFile(registryFiles, ({ path, bytes }) =>
      stage(path, bytes),
    );
    for (const { parent, path, bytes, entryCount } of registryFiles) {
      registries.push({ path, sha256: digest(bytes) });
      parents[parent] = {
        entryCount,
        registrySha256: digest(bytes),
        registryBytes: bytes.length,
      };
    }
    const catalogBytes = Buffer.from(
      JSON.stringify({
        version: 1,
        checkpointRevision: indexes.live.revision,
        parents,
      }),
    );
    await stage(catalogPath, catalogBytes);
    return {
      descriptors,
      registries,
      catalog: { path: catalogPath, sha256: digest(catalogBytes) },
      removedParents: Array.from(removedParents),
    };
  }

  private async runCheckpoint(
    base: ChatStorageIndexes,
    records: readonly JournalCommit[],
    appliedThrough: number,
    lastDigest: string,
    markerOnDisk: boolean,
  ): Promise<{
    indexes: ChatStorageIndexes;
    digest: string;
    journalBytes: number;
  }> {
    const fromRevision = base.live.revision;
    const targetRevision =
      records[records.length - 1]?.toRevision ?? fromRevision;
    const workDirectory = join(this.directory, DELTA_CHECKPOINT_WORK_DIRECTORY);
    await this.checkpointRegistryRecords(records);
    await this.applyTranscriptRecords(
      records,
      fromRevision,
      targetRevision,
      appliedThrough,
      markerOnDisk,
      workDirectory,
    );
    if (
      records.some(
        (record) =>
          record.v === 2 &&
          record.transcripts.some((effect) => effect.kind === 'child-settle'),
      )
    )
      await this.boundary('finalize-checkpoint');
    await this.boundary('checkpoint-transcripts-applied');
    const metadata = replayIndexMetadata(
      base,
      records,
      assertChatStorageIndexes,
    );
    const descriptors = new Map<string, TranscriptDescriptor>();
    for (const chatId of Array.from(metadata.touched))
      descriptors.set(chatId, await this.log.descriptor(chatId));
    const indexes = withTranscriptDescriptors(
      metadata.indexes,
      descriptors,
      metadata.turnCountFromDescriptor,
    );
    assertChatStorageIndexes(indexes);
    const values: Record<(typeof DELTA_INDEX_FILE_NAMES)[number], unknown> = {
      'live-index.json': indexes.live,
      'archive-index.json': indexes.archive,
      'recovery-index.json': indexes.recovery,
    };
    for (const name of DELTA_INDEX_FILE_NAMES) {
      await writeJsonValuesCooperatively(
        join(this.directory, `${name}${DELTA_CHECKPOINT_STAGED_SUFFIX}`),
        [values[name]],
        { pretty: false },
      );
      recordChatStorageIndexSerializations(1);
    }
    const streamMetadata =
      this.journalVersion === 2
        ? await this.stageCheckpointStreamMetadata(records, indexes)
        : undefined;
    await this.boundary('checkpoint-metadata-staged');
    await fsyncDirectory(this.directory);
    await this.writeMarker({
      v: this.journalVersion,
      phase: 'publishing',
      fromRevision,
      targetRevision,
      appliedThrough: targetRevision,
      ...(streamMetadata ? { metadata: streamMetadata } : {}),
    });
    await this.boundary('checkpoint-publishing-marked');
    const rotated = await this.finishPublication(
      targetRevision,
      lastDigest,
      false,
      streamMetadata,
    );
    recordChatStorageDeltaJournalCheckpoint();
    await rm(workDirectory, { recursive: true, force: true });
    return { indexes, ...rotated };
  }

  private async checkpointRegistryRecords(
    records: readonly JournalCommit[],
  ): Promise<void> {
    const identities = new Map<string, RegistryIdentity>();
    for (const record of records) {
      if (record.v !== 2) continue;
      for (const effect of record.registryEffects ?? []) {
        const identity = registryEffectIdentity(effect);
        identities.set(registryIdentityKey(identity), identity);
      }
    }
    // Each chat's registry is its own files, so chats overlap their appends
    // and syncs. A chat's identities write their segments together and share
    // one manifest update, folded in this order.
    const chats = new Map<string, RegistryIdentity[]>();
    for (const identity of Array.from(identities.values()))
      chats.set(identity.chatId, [
        ...(chats.get(identity.chatId) ?? []),
        identity,
      ]);
    const settled = await Promise.allSettled(
      Array.from(chats.values(), async (chat) => {
        const highWaters: DelegationRegistryCheckpoint[] = [];
        for (const identity of chat)
          highWaters.push(await this.registry.highWater(identity));
        await this.registry.checkpointChat(highWaters);
      }),
    );
    // Every chat has stopped writing before a failure poisons the writer.
    for (const result of settled)
      if (result.status === 'rejected') throw result.reason;
  }

  /** Publish one staged stream metadata file, verifying its digest. */
  private async publishStagedStreamItem(item: {
    path: string;
    sha256: string;
  }): Promise<void> {
    if (
      item.path === this.transcriptsRoot ||
      !isPathInside(this.transcriptsRoot, item.path) ||
      !/^[a-f0-9]{64}$/.test(item.sha256)
    )
      throw new ChatDeltaJournalIntegrityError(
        'Invalid checkpoint metadata path or digest',
      );
    const staged = `${item.path}.checkpoint`;
    let bytes: Buffer;
    try {
      bytes = await readFile(staged);
    } catch (error) {
      if (!(isErrnoException(error) && error.code === 'ENOENT')) throw error;
      bytes = await readFile(item.path);
    }
    if (createHash('sha256').update(bytes).digest('hex') !== item.sha256)
      throw new ChatDeltaJournalIntegrityError(
        'Staged stream metadata digest mismatch',
      );
    if (await exists(staged)) {
      await rename(staged, item.path);
      await fsyncDirectory(dirname(item.path));
    }
  }

  /**
   * A compatibility transaction on checkpointed format 4 advances the indexes
   * without touching stream metadata. Re-stamp it at the checkpoint revision;
   * the catalog publishes last, so an interrupted run repeats on next open.
   */
  private async restampStreamMetadata(
    indexes: ChatStorageIndexes,
  ): Promise<void> {
    const metadata = await this.stageCheckpointStreamMetadata([], indexes);
    // The indexes already exclude these parents, so their trees go before the
    // catalog stops naming them; a crash in between repeats the removal.
    for (const parent of metadata.removedParents) {
      assertTranscriptIdentity(parent);
      await rm(join(this.transcriptsRoot, 'delegations', parent), {
        recursive: true,
        force: true,
      });
      this.registry.forgetChat(parent);
    }
    const publish = (item: { path: string; sha256: string }): Promise<void> =>
      this.publishStagedStreamItem(item);
    await eachStreamMetadataFile(metadata.descriptors, publish);
    await eachStreamMetadataFile(metadata.registries, publish);
    if (metadata.catalog) await publish(metadata.catalog);
  }

  /** Publish staged indexes, rotate the journal, then clear the marker. */
  private async finishPublication(
    targetRevision: number,
    lastDigest: string,
    alreadyRotated: boolean,
    metadata?: DeltaCheckpointMarker['metadata'],
  ): Promise<{ digest: string; journalBytes: number }> {
    const publish = (item: { path: string; sha256: string }): Promise<void> =>
      this.publishStagedStreamItem(item);
    if (metadata) {
      // Each phase publishes independent files; phases keep their order.
      await eachStreamMetadataFile(metadata.descriptors, publish);
      await this.boundary('checkpoint-descriptors-published');
      await eachStreamMetadataFile(metadata.registries, publish);
      await this.boundary('checkpoint-registries-published');
      if (metadata.catalog) await publish(metadata.catalog);
      await this.boundary('checkpoint-catalog-published');
    }
    for (const name of DELTA_INDEX_FILE_NAMES) {
      const staged = join(
        this.directory,
        `${name}${DELTA_CHECKPOINT_STAGED_SUFFIX}`,
      );
      try {
        await rename(staged, join(this.directory, name));
      } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') continue;
        throw error;
      }
      recordChatStorageAtomicReplacement(join(this.directory, name));
    }
    await fsyncDirectory(this.directory);
    await this.boundary('checkpoint-indexes-published');
    // One directory sync makes the rotation and the marker's removal durable.
    // Recovery accepts either surviving alone: a rotated journal under a
    // `publishing` marker finishes publication, and an unrotated journal
    // without a marker continues from the published checkpoint.
    const rotated = alreadyRotated
      ? undefined
      : await writeJournalSegment(
          this.directory,
          this.scopeId,
          targetRevision,
          lastDigest,
          false,
          this.journalVersion,
        );
    await this.boundary('checkpoint-journal-rotated');
    if (metadata) {
      for (const parent of metadata.removedParents)
        assertTranscriptIdentity(parent);
      for (const parent of metadata.removedParents) {
        await rm(join(this.transcriptsRoot, 'delegations', parent), {
          recursive: true,
          force: true,
        });
        this.registry.forgetChat(parent);
      }
      await this.boundary('checkpoint-removed-parents');
    }
    await rm(join(this.directory, DELTA_CHECKPOINT_MARKER_NAME), {
      force: true,
    });
    await fsyncDirectory(this.directory);
    await this.boundary('marker-removed');
    if (rotated) return { digest: rotated.digest, journalBytes: rotated.bytes };
    const journal = await readDeltaJournal(
      this.directory,
      this.scopeId,
      this.manifest,
    );
    return { digest: journal.lastDigest, journalBytes: journal.validEnd };
  }

  /** Recovery: finish the checkpoint a crash interrupted. */
  private async resumeCheckpoint(
    journal: DeltaJournalContents,
    checkpoint: DeltaCheckpointState,
    marker: DeltaCheckpointMarker,
  ): Promise<void> {
    if (marker.targetRevision !== journal.lastRevision)
      throw new ChatDeltaJournalIntegrityError(
        'Interrupted checkpoint does not cover the whole journal',
      );
    if (marker.phase === 'publishing') {
      const rotated =
        journal.segment.baseRevision === marker.targetRevision &&
        journal.records.length === 0;
      await this.finishPublication(
        marker.targetRevision,
        journal.lastDigest,
        rotated,
        marker.metadata,
      );
      await rm(join(this.directory, DELTA_CHECKPOINT_WORK_DIRECTORY), {
        recursive: true,
        force: true,
      });
      return;
    }
    const records = recordsAfter(journal, checkpoint.revision);
    await verifyRecordArtifacts(
      this.transcriptsRoot,
      recordsAfter(journal, checkpoint.transcriptProgress),
    );
    await this.runCheckpoint(
      checkpoint.indexes,
      records,
      checkpoint.transcriptProgress,
      journal.lastDigest,
      true,
    );
  }
}

function isPromotableManifest(
  value: unknown,
  scopeId: string,
): value is {
  version: 2;
  scopeId: string;
  sourceDigest: string;
  cleanupComplete: true;
} {
  return (
    isRecord(value) &&
    value.version === 2 &&
    value.scopeId === scopeId &&
    typeof value.sourceDigest === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sourceDigest) &&
    value.cleanupComplete === true
  );
}

/**
 * Promote a settled version 2 scope to the delta journal: a fresh segment at
 * the current revision, then the version 3 manifest. The caller holds the
 * scope lease. Before the manifest is published the scope stays version 2
 * and the journal file is ignored. The version 3 manifest keeps the version
 * 2 manifest verbatim (`demotesTo`), so demotion restores its exact bytes.
 */
/** Leftovers of an earlier delta-journal life must not be resumed. */
async function clearCheckpointLeftovers(directory: string): Promise<void> {
  await rm(join(directory, DELTA_CHECKPOINT_MARKER_NAME), { force: true });
  await rm(join(directory, DELTA_CHECKPOINT_WORK_DIRECTORY), {
    recursive: true,
    force: true,
  });
  for (const name of DELTA_INDEX_FILE_NAMES)
    await rm(join(directory, `${name}${DELTA_CHECKPOINT_STAGED_SUFFIX}`), {
      force: true,
    });
  await fsyncDirectory(directory);
}

export async function promoteToDeltaJournal(
  store: ChatStorageV2,
): Promise<void> {
  const { scopeId } = store.descriptor();
  const manifest: unknown = JSON.parse(
    await readFile(store.manifestPath, 'utf8'),
  );
  assertNoNewerChatStorageManifest(manifest, scopeId, store.maxManifestVersion);
  if (
    isRecord(manifest) &&
    manifest.version === 4 &&
    store.maxManifestVersion === 4
  ) {
    if (journalFileFor(manifest)) return;
    const checkpointed = parseChatStorageManifest(manifest);
    if (checkpointed.version !== 4) throw new Error('Expected format 4');
    if (
      (await stat(join(store.directory, 'metadata-journal.jsonl'))).size !== 0
    )
      throw new Error('Flush the version 2 journal before promotion');
    const indexes = await store.indexes();
    await clearCheckpointLeftovers(store.directory);
    await writeJournalSegment(
      store.directory,
      scopeId,
      indexes.live.revision,
      DELTA_JOURNAL_V2_GENESIS_DIGEST,
      true,
      2,
    );
    await writeAtomicJson(store.manifestPath, {
      ...checkpointed,
      migrationId: randomUUID(),
      sourceRevision: indexes.live.revision,
      journal: DELTA_JOURNAL_V2_FORMAT,
    });
    return;
  }
  if (!isPromotableManifest(manifest, scopeId))
    throw new Error('Only a cleaned-up version 2 scope can be promoted');
  if ((await stat(join(store.directory, 'metadata-journal.jsonl'))).size !== 0)
    throw new Error('Flush the version 2 journal before promotion');
  const indexes = await store.indexes();
  await clearCheckpointLeftovers(store.directory);
  await writeJournalSegment(
    store.directory,
    scopeId,
    indexes.live.revision,
    DELTA_JOURNAL_GENESIS_DIGEST,
  );
  const promoted: DeltaJournalStorageManifest = {
    version: DELTA_JOURNAL_MANIFEST_VERSION,
    scopeId,
    migrationId: randomUUID(),
    sourceRevision: indexes.live.revision,
    sourceDigest: manifest.sourceDigest,
    cleanupComplete: true,
    journal: DELTA_JOURNAL_FORMAT,
    demotesTo: manifest,
  };
  await writeAtomicJson(store.manifestPath, promoted);
}

/** Explicit, opt-in format-3 to format-4 authority transition. */
export async function promoteToFormat4Journal(
  store: ChatStorageV2,
  options: DeltaJournalDemotionOptions = {},
): Promise<ChatDeltaJournalWriter> {
  if (store.maxManifestVersion !== 4)
    throw new Error('Format 4 promotion requires a ceiling-4 store');
  const scopeId = store.descriptor().scopeId;
  const raw: unknown = JSON.parse(await readFile(store.manifestPath, 'utf8'));
  assertNoNewerChatStorageManifest(raw, scopeId, 4);
  if (isRecord(raw) && raw.version === 4) {
    const current = parseChatStorageManifest(raw);
    if (current.version !== 4 || !current.journal)
      throw new Error('Format 4 scope is not journaled');
    return ChatDeltaJournalWriter.open(store, options);
  }
  if (!isDeltaJournalStorageManifest(raw) || raw.scopeId !== scopeId)
    throw new Error('Only a settled format 3 scope can be promoted');
  const { writer: provided, ...writerOptions } = options;
  const writer =
    provided ?? (await ChatDeltaJournalWriter.open(store, writerOptions));
  await writer.checkpoint();
  const revision = writer.revision;
  manifestGenerations.set(
    store.directory,
    manifestGeneration(store.directory) + 1,
  );
  const v1 = await readDeltaJournal(store.directory, scopeId, raw);
  if (v1.records.length || v1.tornTail || v1.segment.baseRevision !== revision)
    throw new Error('Format 3 promotion requires a verified empty journal');
  const catalog = streamCatalogPath(join(store.directory, 'transcripts'));
  await mkdir(dirname(catalog), { recursive: true });
  await fsyncDirectory(join(store.directory, 'transcripts'));
  await writeAtomicJson(
    catalog,
    {
      version: 1,
      checkpointRevision: revision,
      parents: {},
    },
    options.onBoundary,
    {
      written: 'catalog-temp-written',
      synced: 'catalog-temp-synced',
    },
  );
  await writeJournalSegment(
    store.directory,
    scopeId,
    revision,
    DELTA_JOURNAL_V2_GENESIS_DIGEST,
    true,
    2,
    options.onBoundary,
  );
  const next: Format4StorageManifest = {
    version: 4,
    scopeId,
    migrationId: randomUUID(),
    sourceRevision: revision,
    sourceDigest: raw.sourceDigest,
    cleanupComplete: true,
    journal: DELTA_JOURNAL_V2_FORMAT,
  };
  await writeAtomicJson(store.manifestPath, next, options.onBoundary);
  try {
    await rm(join(store.directory, DELTA_JOURNAL_FILE_NAME), { force: true });
    await fsyncDirectory(store.directory);
  } catch {
    /* An unselected empty v1 segment is harmless. */
  }
  const opened = await ChatDeltaJournalWriter.open(store, writerOptions);
  await options.onBoundary?.('writer-reopened');
  return opened;
}

/** Retire a journaled format-4 writer and retain format-4 checkpoint authority. */
export async function transitionFormat4ToCheckpointed(
  store: ChatStorageV2,
  options: DeltaJournalDemotionOptions = {},
): Promise<boolean> {
  if (store.maxManifestVersion !== 4)
    throw new Error('Format 4 transition requires a ceiling-4 store');
  const raw: unknown = JSON.parse(await readFile(store.manifestPath, 'utf8'));
  assertNoNewerChatStorageManifest(raw, store.descriptor().scopeId, 4);
  const manifest = parseChatStorageManifest(raw);
  if (manifest.version !== 4 || !manifest.journal) return false;
  const { writer: provided, ...writerOptions } = options;
  const writer =
    provided ?? (await ChatDeltaJournalWriter.open(store, writerOptions));
  await writer.checkpoint();
  const revision = writer.revision;
  manifestGenerations.set(
    store.directory,
    manifestGeneration(store.directory) + 1,
  );
  const journal = await readDeltaJournal(
    store.directory,
    manifest.scopeId,
    manifest,
  );
  if (
    journal.records.length ||
    journal.tornTail ||
    journal.segment.baseRevision !== revision
  )
    throw new Error('Format 4 transition requires a verified empty journal');
  const { journal: ignored, ...checkpointed } = manifest;
  void ignored;
  await writeAtomicJson(store.manifestPath, checkpointed, options.onBoundary);
  try {
    await rm(join(store.directory, DELTA_JOURNAL_V2_FILE_NAME), {
      force: true,
    });
    await fsyncDirectory(store.directory);
  } catch {
    /* The unselected segment can be removed on a later load. */
  }
  return true;
}

/** The version 2 manifest a demoted scope returns to. */
function demotedManifest(manifest: DeltaJournalStorageManifest): unknown {
  if (isPromotableManifest(manifest.demotesTo, manifest.scopeId))
    return manifest.demotesTo;
  // A version 3 manifest written without its predecessor (tests, or a scope
  // promoted by another build): reconstruct the version 2 fields.
  return {
    version: 2,
    scopeId: manifest.scopeId,
    migrationId: manifest.migrationId,
    sourceRevision: manifest.sourceRevision,
    sourceDigest: manifest.sourceDigest,
    cleanupComplete: true,
  };
}

/** Outcome of {@link removeStrayDeltaJournal}. */
export type StrayDeltaJournalOutcome = 'absent' | 'removed' | 'retained';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Remove the delta-journal files a version 2 scope no longer selects: an
 * empty journal left by a promotion that never published its manifest or by
 * a demotion that published the version 2 manifest before removing it, and
 * any checkpoint leftovers. A journal holding records, or bytes that are not
 * a verified empty segment, is retained: nothing proves it is redundant.
 * Quarantined journal tails are evidence and always stay.
 */
export async function removeStrayDeltaJournal(
  store: ChatStorageV2,
): Promise<StrayDeltaJournalOutcome> {
  const { scopeId } = store.descriptor();
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(store.manifestPath, 'utf8'));
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return 'absent';
    throw error;
  }
  assertNoNewerChatStorageManifest(manifest, scopeId, store.maxManifestVersion);
  if (
    !isRecord(manifest) ||
    (manifest.version !== 2 && manifest.version !== 3 && manifest.version !== 4)
  )
    return 'absent';
  const selected = journalFileFor(manifest);
  const candidates = [
    DELTA_JOURNAL_FILE_NAME,
    DELTA_JOURNAL_V2_FILE_NAME,
  ].filter((name) => name !== selected);
  const leftovers = selected
    ? []
    : [
        join(store.directory, DELTA_CHECKPOINT_MARKER_NAME),
        join(store.directory, DELTA_CHECKPOINT_WORK_DIRECTORY),
        ...DELTA_INDEX_FILE_NAMES.map((name) =>
          join(store.directory, `${name}${DELTA_CHECKPOINT_STAGED_SUFFIX}`),
        ),
      ];
  let present = await removeJournalTemporaries(store.directory);
  for (const name of candidates)
    if (await exists(join(store.directory, name))) present = true;
  for (const path of leftovers) if (await exists(path)) present = true;
  if (!present) return 'absent';
  for (const name of candidates) {
    const journalPath = join(store.directory, name);
    if (!(await exists(journalPath))) continue;
    let empty = false;
    try {
      const journal = await readDeltaJournal(
        store.directory,
        scopeId,
        name === DELTA_JOURNAL_FILE_NAME
          ? {
              version: 3,
              scopeId,
              migrationId: 'stray',
              sourceRevision: 0,
              sourceDigest: '0'.repeat(64),
              cleanupComplete: true,
              journal: DELTA_JOURNAL_FORMAT,
            }
          : {
              version: 4,
              scopeId,
              migrationId: 'stray',
              sourceRevision: 0,
              sourceDigest: '0'.repeat(64),
              cleanupComplete: true,
              journal: DELTA_JOURNAL_V2_FORMAT,
            },
      );
      empty = journal.records.length === 0 && !journal.tornTail;
    } catch {
      empty = false;
    }
    if (!empty) return 'retained';
    await rm(journalPath, { force: true });
  }
  for (const path of leftovers)
    await rm(path, { recursive: true, force: true });
  await fsyncDirectory(store.directory);
  return 'removed';
}

export interface DeltaJournalDemotionOptions extends ChatDeltaJournalWriterOptions {
  /** The scope's open writer; otherwise one is opened, recovering the scope. */
  writer?: ChatDeltaJournalWriter;
}

/**
 * Demote a delta-journal scope to version 2 storage. The caller holds the
 * scope lease, so no commit interleaves.
 *
 * 1. A full checkpoint writes every record into the version 2 files and
 *    rotates the journal to an empty segment.
 * 2. The version 2 manifest the scope had before promotion is restored,
 *    atomically, with its original bytes.
 * 3. The empty journal is removed.
 *
 * A crash before step 2 leaves a readable version 3 scope that a retry
 * demotes; after it, a version 2 scope whose empty journal
 * {@link removeStrayDeltaJournal} removes. Quarantined journal tails stay in
 * the scope directory. Returns false when the scope was not version 3; its
 * leftovers are still removed.
 */
export async function demoteFromDeltaJournal(
  store: ChatStorageV2,
  options: DeltaJournalDemotionOptions = {},
): Promise<boolean> {
  const { scopeId } = store.descriptor();
  const manifest: unknown = JSON.parse(
    await readFile(store.manifestPath, 'utf8'),
  );
  assertNoNewerChatStorageManifest(manifest, scopeId, store.maxManifestVersion);
  if (
    isRecord(manifest) &&
    manifest.version === 4 &&
    store.maxManifestVersion === 4
  )
    return transitionFormat4ToCheckpointed(store, options);
  if (
    !isDeltaJournalStorageManifest(manifest) ||
    manifest.scopeId !== scopeId
  ) {
    await removeStrayDeltaJournal(store);
    return false;
  }
  const { writer: provided, ...writerOptions } = options;
  const writer =
    provided ?? (await ChatDeltaJournalWriter.open(store, writerOptions));
  await writer.checkpoint();
  if (writer.pendingRecordCount !== 0)
    throw new Error('Delta journal demotion requires an empty journal');
  // Retire every writer of this scope before the version 2 manifest can
  // appear: from here on no record can be appended.
  manifestGenerations.set(
    store.directory,
    manifestGeneration(store.directory) + 1,
  );
  await writeAtomicJson(store.manifestPath, demotedManifest(manifest));
  try {
    await removeStrayDeltaJournal(store);
  } catch {
    // The scope is version 2 and never reads the leftover journal; the next
    // load of the scope removes it.
  }
  return true;
}
