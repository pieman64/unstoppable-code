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
import { randomUUID } from 'node:crypto';
import { open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TranscriptDescriptor } from '@canopy/agent-transcript/transcript-storage';
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
  type TranscriptActiveProjection,
} from '../chat-transcript-log';
import {
  iterateAsync,
  writeBufferFully,
  writeJsonValuesCooperatively,
} from '../cooperative-json';
import type { FileHandle } from 'node:fs/promises';
import { fsyncDirectory } from '../fsync-directory';
import { isErrnoException, isRecord } from '../type-guards';
import {
  ChatDeltaJournalIntegrityError,
  DELTA_CHECKPOINT_MARKER_NAME,
  DELTA_CHECKPOINT_STAGED_SUFFIX,
  DELTA_CHECKPOINT_WORK_DIRECTORY,
  DELTA_JOURNAL_FILE_NAME,
  DELTA_JOURNAL_FORMAT,
  DELTA_JOURNAL_GENESIS_DIGEST,
  DELTA_JOURNAL_MANIFEST_VERSION,
  DELTA_JOURNAL_QUARANTINE_PREFIX,
  FRAME_HEADER_BYTES,
  decodeDeltaJournalRecord,
  encodeDeltaJournalFrame,
  isActiveEffect,
  isDeltaJournalStorageManifest,
  type DeltaJournalCommitRecord,
  type DeltaJournalStorageManifest,
  type DeltaJournalTailReason,
  type DeltaJournalTranscriptEffect,
} from './format';
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
  type DeltaCheckpointMarker,
  type DeltaCheckpointState,
  type DeltaJournalContents,
} from './replay';
import {
  ChatTranscriptOverlay,
  upsertActiveMessages,
  type TranscriptOverlayBase,
} from './transcript-overlay';

/** The commit recreates a chat whose deletion a checkpoint must apply first. */
export class DeltaJournalCheckpointRequiredError extends Error {
  public override readonly name = 'DeltaJournalCheckpointRequiredError';
}

/** Journal size at which a checkpoint is due (P1 §A size trigger). */
export const DELTA_JOURNAL_CHECKPOINT_BYTES = 4 * 1024 * 1024;
const QUARANTINE_TEMPORARY_PREFIX = `.${DELTA_JOURNAL_QUARANTINE_PREFIX}`;

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
  return /^(?:delta-journal\.log|delta-checkpoint\.json)\.[0-9a-f-]{36}\.tmp$/i.test(
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
  /** Artifacts the caller externalized; reclaimed only if nothing is written. */
  created?: CreatedArtifacts;
  /** Refreshes asynchronous authorization inputs before the record is written. */
  preparePublish?: () => Promise<void>;
  /** Synchronous authorization check immediately before the record is written. */
  beforePublish?: () => void;
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
  | 'marker-removed';

export interface ChatDeltaJournalWriterOptions {
  /** Test seam: runs after each write/sync step the counters do not cover. */
  onBoundary?: (boundary: DeltaJournalBoundary) => Promise<void>;
  onDiagnostic?: (diagnostic: DeltaJournalDiagnostic) => void;
  checkpointJournalBytes?: number;
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
  base: DeltaJournalCommitRecord;
  encoded: { frame: Buffer; digest: string };
  record: DeltaJournalCommitRecord;
  indexes: ChatStorageIndexes;
  admitted: Map<string, ChatTranscriptOverlay>;
}

interface WriterState {
  /** Indexes of the last checkpoint, as on disk. */
  checkpointIndexes: ChatStorageIndexes;
  /** Metadata after every record; descriptors of touched chats are stale. */
  indexes: ChatStorageIndexes;
  /** Records after the checkpoint, in order. */
  records: DeltaJournalCommitRecord[];
  overlays: Map<string, ChatTranscriptOverlay>;
  lastDigest: string;
  journalBytes: number;
  mutationIds: Set<string>;
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

async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    await writeJsonValuesCooperatively(temporary, [value], { pretty: false });
    await rename(temporary, path);
    renamed = true;
    recordChatStorageAtomicReplacement(path);
    await fsyncDirectory(dirname(path));
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
): Promise<{ digest: string; bytes: number }> {
  const path = join(directory, DELTA_JOURNAL_FILE_NAME);
  const { frame, digest } = encodeDeltaJournalFrame({
    type: 'segment',
    v: 1,
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
      await handle.sync();
      recordChatStorageFileSync(temporary);
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    renamed = true;
    recordChatStorageAtomicReplacement(path);
    if (syncDirectory) await fsyncDirectory(directory);
  } finally {
    if (!renamed) await rm(temporary, { force: true });
  }
  return { digest, bytes: frame.length };
}

export class ChatDeltaJournalWriter {
  private readonly directory: string;
  private readonly scopeId: string;
  private readonly transcriptsRoot: string;
  private readonly journalPath: string;
  private readonly log: ChatTranscriptLog;
  private readonly base: TranscriptOverlayBase;
  private state?: WriterState;
  private poisoned?: Error;
  private tail: Promise<unknown> = Promise.resolve();
  /** Records admitted for group commit that are not durable yet. */
  private readonly groupCommit: GroupCommitQueue;
  /** True while a checkpoint or recovery reads and writes the files. */
  private materializing = false;
  /** {@link manifestGenerations} when this writer opened. */
  private readonly generation: number;

  private constructor(
    store: ChatStorageV2,
    private readonly options: ChatDeltaJournalWriterOptions,
  ) {
    this.directory = store.directory;
    this.generation = manifestGeneration(store.directory);
    this.scopeId = store.descriptor().scopeId;
    this.transcriptsRoot = join(store.directory, 'transcripts');
    this.journalPath = join(store.directory, DELTA_JOURNAL_FILE_NAME);
    this.log = options.log ?? new ChatTranscriptLog(this.transcriptsRoot);
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
    if (
      !isDeltaJournalStorageManifest(manifest) ||
      manifest.scopeId !== store.descriptor().scopeId
    )
      throw new Error('Scope does not use the delta journal');
    const writer = new ChatDeltaJournalWriter(store, options);
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
    if (manifestGeneration(this.directory) !== this.generation)
      throw new Error('Delta journal writer is closed: its scope is version 2');
    if (this.poisoned)
      throw Object.assign(new Error('Delta journal writer must be reopened'), {
        cause: this.poisoned,
      });
    if (!this.state) throw new Error('Delta journal writer is not open');
    return this.state;
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
      manifestGeneration(this.directory) === this.generation
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

  /**
   * The size trigger (P1 §A). While a turn's active rows are journaled, the
   * journal may grow to a multiple of them first (`active-turn.ts`).
   */
  public needsCheckpoint(): boolean {
    return journalCheckpointDue(
      this.current().journalBytes,
      this.options.checkpointJournalBytes ?? DELTA_JOURNAL_CHECKPOINT_BYTES,
      this.activeTurnBytes(),
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
    return this.activeTurnBytes() > 0;
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

  public receipt(commandId: string): PersistedCommandReceipt | undefined {
    return this.current().indexes.recovery.receipts.find(
      (receipt) => receipt.commandId === commandId,
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
    let journal = await readDeltaJournal(this.directory, this.scopeId);
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
    if (checkpoint.marker) {
      await this.resumeCheckpoint(journal, checkpoint, checkpoint.marker);
      journal = await readDeltaJournal(this.directory, this.scopeId);
      checkpoint = await readCheckpointState(
        this.directory,
        assertChatStorageIndexes,
      );
      assertJournalCovers(journal, checkpoint);
    }
    const records = recordsAfter(journal, checkpoint.revision);
    await verifyRecordArtifacts(this.transcriptsRoot, records);
    const metadata = replayIndexMetadata(
      checkpoint.indexes,
      records,
      assertChatStorageIndexes,
    );
    const overlays = new Map<string, ChatTranscriptOverlay>();
    for (const record of records)
      for (const effect of record.transcripts) {
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
    this.state = {
      checkpointIndexes: checkpoint.indexes,
      indexes: metadata.indexes,
      records,
      overlays,
      lastDigest: journal.lastDigest,
      journalBytes: journal.validEnd,
      mutationIds: new Set(metadata.indexes.recovery.mutationIds),
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

  /** Prepare one write: externalize, bound rows, and shape the effect. */
  private async prepareEffect(
    write: DeltaJournalWrite,
    create: boolean,
    next: ChatStorageIndexes,
    created: CreatedArtifacts,
  ): Promise<DeltaJournalTranscriptEffect> {
    const externalize = async (
      messages:
        | Iterable<PersistedChatMessage>
        | AsyncIterable<PersistedChatMessage>,
    ): Promise<PersistedChatMessage[]> => {
      const stored: PersistedChatMessage[] = [];
      for await (const message of iterateAsync(messages)) {
        const value = await this.log.artifacts.externalize(
          write.chatId,
          message,
          created,
        );
        assertTranscriptRowWithinLimit(value);
        stored.push(value);
      }
      assertUniqueIds(stored);
      return stored;
    };
    const activeTailCount = write.activeTailCount ?? 0;
    if (!Number.isSafeInteger(activeTailCount) || activeTailCount < 0)
      throw new Error('Invalid replacement active suffix');
    if (write.kind === 'patch') {
      if (create) throw new Error('A patch requires an existing transcript');
      const patches = await externalize(write.patches);
      const tail = await externalize(write.tail);
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
    const messages = await externalize(write.messages ?? []);
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
      assertTranscriptIdentity(write.chatId);
      if (changed.has(write.chatId))
        throw new Error(
          'Only one transcript effect per chat is allowed in a scope transaction',
        );
      changed.add(write.chatId);
      if ((write.kind === 'delete') === remaining.has(write.chatId))
        throw new Error(
          'Transcript effect disagrees with target index membership',
        );
    }
    for (const id of Array.from(remaining))
      if (!existing.has(id) && !changed.has(id))
        throw new Error(
          'New chat must initialize a transcript in the same transaction',
        );
    for (const id of Array.from(existing))
      if (!remaining.has(id) && !changed.has(id))
        throw new Error('Removed chat must declare its transcript deletion');
    return { existing, remaining };
  }

  /**
   * Whether the commit retries an applied one: every mutation id is retained
   * (a synced record whose acknowledgement was lost, or a record admitted
   * ahead of it).
   */
  private isAppliedRetry(
    state: WriterState,
    input: DeltaJournalCommitInput,
  ): boolean {
    if (
      input.mutationIds.length > 0 &&
      input.mutationIds.every((id) => state.mutationIds.has(id))
    )
      return true;
    if (input.mutationIds.some((id) => state.mutationIds.has(id)))
      throw new Error('Commit repeats part of an applied mutation');
    return false;
  }

  /** Frame a record and decode exactly the bytes that will be written. */
  private encodeRecord(
    state: WriterState,
    base: DeltaJournalCommitRecord,
    batchStart: number | undefined,
  ): Pick<PreparedRecord, 'encoded' | 'record'> {
    const encoded = encodeDeltaJournalFrame(
      batchStart === undefined ? base : { ...base, batchStart },
    );
    // Apply exactly the bytes being written, as recovery will.
    const record = decodeDeltaJournalRecord({
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
    const base: DeltaJournalCommitRecord = {
      type: 'commit',
      v: 1,
      prev: state.lastDigest,
      fromRevision: input.expectedRevision,
      toRevision: input.expectedRevision + 1,
      mutationIds: [...input.mutationIds],
      delta: diffChatIndexes(state.indexes, input.next),
      transcripts: effects,
    };
    const { encoded, record } = this.encodeRecord(state, base, batchStart);
    const indexes = applyRecordMetadata(
      state.indexes,
      record,
      assertChatStorageIndexes,
    );
    const admitted = new Map<string, ChatTranscriptOverlay>();
    for (const effect of record.transcripts) {
      const overlay = await this.overlayFor(state.overlays, effect);
      await overlay.apply(effect, record.toRevision);
      if (
        isActiveEffect(effect) &&
        effect.transcriptRevision !== overlay.transcriptRevision
      )
        throw new Error('Active update revision disagrees with its log');
      admitted.set(effect.chatId, overlay);
    }
    return { base, encoded, record, indexes, admitted };
  }

  /** The in-memory state once `prepared` follows `state`. */
  private advanced(state: WriterState, prepared: PreparedRecord): WriterState {
    return {
      ...state,
      indexes: prepared.indexes,
      records: [...state.records, prepared.record],
      overlays: new Map([
        ...Array.from(state.overlays),
        ...Array.from(prepared.admitted),
      ]),
      lastDigest: prepared.encoded.digest,
      journalBytes: state.journalBytes + prepared.encoded.frame.length,
      mutationIds: new Set(prepared.indexes.recovery.mutationIds),
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
        if (this.isAppliedRetry(state, input)) {
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
        if (this.isAppliedRetry(state, input)) {
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
        const durable = this.groupCommit.add(
          state.journalBytes,
          prepared.encoded.frame,
          joined,
        );
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
    if (manifestGeneration(this.directory) !== this.generation)
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
      this.state = {
        checkpointIndexes: result.indexes,
        indexes: result.indexes,
        records: [],
        overlays: new Map(),
        lastDigest: result.digest,
        journalBytes: result.journalBytes,
        mutationIds: new Set(result.indexes.recovery.mutationIds),
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
   * Apply records after `appliedThrough` to the transcript files. A
   * progress marker is on disk before the first file changes (`markerOnDisk`
   * when a resumed checkpoint already has one); it advances only around
   * records that are not runs of revisioned active updates.
   */
  private async applyTranscriptRecords(
    records: readonly DeltaJournalCommitRecord[],
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
        v: 1,
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
      const coalesced = record.transcripts.every(
        (effect) =>
          isActiveEffect(effect) && effect.transcriptRevision !== undefined,
      );
      if (coalesced) {
        for (const effect of record.transcripts)
          if (isActiveEffect(effect) && effect.transcriptRevision !== undefined)
            foldRun(effect, effect.transcriptRevision);
        continue;
      }
      // Everything before this record is applied before it is, except a run
      // this record's own append finalizes (a turn end): its rows reach the
      // log through that append, never through a sidecar rewrite.
      const finalizing = new Set(
        record.transcripts
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
      for (const effect of record.transcripts) {
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
          );
        else if (
          isActiveEffect(effect) &&
          effect.transcriptRevision !== undefined
        ) {
          foldRun(effect, effect.transcriptRevision);
          await writeRun(effect.chatId);
        } else
          await applyTranscriptEffect(
            this.log,
            this.transcriptsRoot,
            effect,
            record.toRevision,
            workDirectory,
          );
      }
      // After the last record the `publishing` marker follows; until it is
      // written, recovery re-applies this record, which converges.
      if (marked !== undefined && record !== last)
        await mark(record.toRevision);
    }
    await writeRuns();
  }

  private async runCheckpoint(
    base: ChatStorageIndexes,
    records: readonly DeltaJournalCommitRecord[],
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
    await this.applyTranscriptRecords(
      records,
      fromRevision,
      targetRevision,
      appliedThrough,
      markerOnDisk,
      workDirectory,
    );
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
    await fsyncDirectory(this.directory);
    await this.writeMarker({
      v: 1,
      phase: 'publishing',
      fromRevision,
      targetRevision,
      appliedThrough: targetRevision,
    });
    const rotated = await this.finishPublication(
      targetRevision,
      lastDigest,
      false,
    );
    recordChatStorageDeltaJournalCheckpoint();
    await rm(workDirectory, { recursive: true, force: true });
    return { indexes, ...rotated };
  }

  /** Publish staged indexes, rotate the journal, then clear the marker. */
  private async finishPublication(
    targetRevision: number,
    lastDigest: string,
    alreadyRotated: boolean,
  ): Promise<{ digest: string; journalBytes: number }> {
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
        );
    await rm(join(this.directory, DELTA_CHECKPOINT_MARKER_NAME), {
      force: true,
    });
    await fsyncDirectory(this.directory);
    await this.boundary('marker-removed');
    if (rotated) return { digest: rotated.digest, journalBytes: rotated.bytes };
    const journal = await readDeltaJournal(this.directory, this.scopeId);
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
      );
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
export async function promoteToDeltaJournal(
  store: ChatStorageV2,
): Promise<void> {
  const { scopeId } = store.descriptor();
  const manifest: unknown = JSON.parse(
    await readFile(store.manifestPath, 'utf8'),
  );
  if (!isPromotableManifest(manifest, scopeId))
    throw new Error('Only a cleaned-up version 2 scope can be promoted');
  if ((await stat(join(store.directory, 'metadata-journal.jsonl'))).size !== 0)
    throw new Error('Flush the version 2 journal before promotion');
  const indexes = await store.indexes();
  // Leftovers of an earlier delta-journal life must not be resumed.
  await rm(join(store.directory, DELTA_CHECKPOINT_MARKER_NAME), {
    force: true,
  });
  await rm(join(store.directory, DELTA_CHECKPOINT_WORK_DIRECTORY), {
    recursive: true,
    force: true,
  });
  for (const name of DELTA_INDEX_FILE_NAMES)
    await rm(
      join(store.directory, `${name}${DELTA_CHECKPOINT_STAGED_SUFFIX}`),
      {
        force: true,
      },
    );
  await fsyncDirectory(store.directory);
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
  if (!isRecord(manifest) || manifest.version !== 2) return 'absent';
  const leftovers = [
    join(store.directory, DELTA_CHECKPOINT_MARKER_NAME),
    join(store.directory, DELTA_CHECKPOINT_WORK_DIRECTORY),
    ...DELTA_INDEX_FILE_NAMES.map((name) =>
      join(store.directory, `${name}${DELTA_CHECKPOINT_STAGED_SUFFIX}`),
    ),
  ];
  const journalPath = join(store.directory, DELTA_JOURNAL_FILE_NAME);
  const journalExists = await exists(journalPath);
  let present = await removeJournalTemporaries(store.directory);
  if (journalExists) present = true;
  for (const path of leftovers) if (await exists(path)) present = true;
  if (!present) return 'absent';
  if (journalExists) {
    let empty = false;
    try {
      const journal = await readDeltaJournal(store.directory, scopeId);
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
