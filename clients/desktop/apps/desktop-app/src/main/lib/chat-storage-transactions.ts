import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import { storedArtifactRefsOf } from './chat-artifact-references';
import {
  type ChatStorageV2,
  type ChatLiveIndex,
  type ChatArchiveIndex,
  type ChatRecoveryIndex,
  assertChatStorageIndexes,
} from './chat-storage-v2';
import {
  ChatTranscriptIntegrityError,
  ChatTranscriptLog,
  readCompleteTranscriptMessages,
  type TranscriptDescriptor,
} from './chat-transcript-log';
import {
  CreatedArtifacts,
  assertTranscriptIdentity,
} from './chat-transcript-artifacts';
import {
  recordChatStorageAtomicReplacement,
  recordChatStorageCommit,
  recordChatStorageIndexParses,
  recordChatStorageIndexSerializations,
  recordChatStoragePayloadPass,
} from '@canopy/desktop-shared/node/work-counters';
import { iterateAsync, writeJsonValuesCooperatively } from './cooperative-json';
import { fsyncDirectory } from './fsync-directory';
import { isErrnoException, isRecord } from './type-guards';

export interface ChatStorageIndexes {
  live: ChatLiveIndex;
  archive: ChatArchiveIndex;
  recovery: ChatRecoveryIndex;
}
export interface ChatTranscriptWrite {
  chatId: string;
  kind: 'append' | 'active' | 'active-replace' | 'replace' | 'delete';
  messages?:
    | Iterable<PersistedChatMessage>
    | AsyncIterable<PersistedChatMessage>;
  /** Rewrites may preserve a mutable suffix in the active sidecar. */
  activeTailCount?: number;
}
interface PreparedWrite {
  chatId: string;
  kind: ChatTranscriptWrite['kind'];
  create: boolean;
  count: number;
  sha256: string;
  activeTailCount?: number;
}
interface PendingCommit {
  v: 2;
  transactionId: string;
  expectedRevision: number;
  indexes: ChatStorageIndexes;
  writes: PreparedWrite[];
}
type Checkpoint = 'prepared' | 'journal' | 'transcripts' | 'indexes';
const tails = new Map<string, Promise<unknown>>();

/**
 * Payload bytes a commit may keep parsed between validating its payloads and
 * applying them, so each payload is read once. A payload beyond the budget is
 * not held in memory: it is read again for the admission checks of an
 * existing chat's append or active write, and again when it is applied.
 */
const RETAINED_PAYLOAD_BYTES = 8 * 1024 * 1024;

/** Validated payload rows by write index, kept for the rest of one commit. */
type ValidatedPayloads = ReadonlyMap<number, readonly PersistedChatMessage[]>;

export interface ChatStorageTransactionsOptions {
  /** Overrides {@link RETAINED_PAYLOAD_BYTES}; tests use it to force rereads. */
  retainedPayloadBytes?: number;
}

/** The entry of `chatId`, live or archived, if the indexes hold it. */
function indexedTab(
  indexes: ChatStorageIndexes,
  chatId: string,
): ChatLiveIndex['tabs'][number] | undefined {
  return (
    indexes.live.tabs.find((tab) => tab.id === chatId) ??
    indexes.archive.archived.find((entry) => entry.tab.id === chatId)?.tab
  );
}

/**
 * Copy-on-write: returns indexes whose entry for `chatId` carries
 * `descriptor`, sharing every untouched object with `indexes`, which is left
 * unchanged. Keys keep their positions, so the serialized bytes are those an
 * in-place assignment would produce.
 */
export function withTranscriptDescriptor(
  indexes: ChatStorageIndexes,
  chatId: string,
  descriptor: TranscriptDescriptor,
): ChatStorageIndexes {
  const liveIndex = indexes.live.tabs.findIndex((tab) => tab.id === chatId);
  if (liveIndex !== -1) {
    const tabs = indexes.live.tabs.slice();
    tabs[liveIndex] = { ...tabs[liveIndex], transcript: descriptor };
    return { ...indexes, live: { ...indexes.live, tabs } };
  }
  const archiveIndex = indexes.archive.archived.findIndex(
    (entry) => entry.tab.id === chatId,
  );
  if (archiveIndex === -1)
    throw new Error('Transcript effect targets an unknown indexed chat');
  const archived = indexes.archive.archived.slice();
  const entry = archived[archiveIndex];
  archived[archiveIndex] = {
    ...entry,
    tab: { ...entry.tab, transcript: descriptor },
    ...(descriptor.userMessageCount !== undefined
      ? { turnCount: descriptor.userMessageCount }
      : {}),
  };
  return { ...indexes, archive: { ...indexes.archive, archived } };
}

async function atomicValues(
  path: string,
  values: readonly unknown[],
  jsonl = false,
  onPublished?: () => void,
  preparePublish?: () => Promise<void>,
  beforePublish?: () => void,
  syncParent = true,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    await writeJsonValuesCooperatively(temporary, values, {
      pretty: false,
      separator: jsonl ? '\n' : '',
      trailingSeparator: jsonl,
    });
    await preparePublish?.();
    // Keep the authorization decision at the exact publication boundary. The
    // callback is deliberately synchronous: no other approval transition can
    // interleave between the check and starting the atomic rename.
    beforePublish?.();
    await rename(temporary, path);
    renamed = true;
    recordChatStorageAtomicReplacement(path);
    onPublished?.();
    if (syncParent) await fsyncDirectory(dirname(path));
  } finally {
    // After the rename the temporary path no longer exists; removing it again
    // only cost a failed lstat and an ENOENT error on every commit.
    if (!renamed) await rm(temporary, { force: true });
  }
}

/** Publish a synced index file; the caller syncs their shared parent once. */
async function atomicIndex(path: string, value: unknown): Promise<void> {
  await atomicValues(
    path,
    [value],
    false,
    undefined,
    undefined,
    undefined,
    false,
  );
  recordChatStorageIndexSerializations(1);
}

function assertIndexes(
  indexes: unknown,
): asserts indexes is ChatStorageIndexes {
  // New chat descriptors are filled from the prepared transcript during
  // apply; validate that final format with the disk contract after apply.
  assertChatStorageIndexes(indexes, {
    allowPendingTranscriptDescriptors: true,
  });
  if (indexes.live.revision < 0)
    throw new Error('Invalid v2 transaction indexes');
  const activeTabId = indexes.live.activeTabId;
  if (activeTabId && !indexes.live.tabs.some((tab) => tab.id === activeTabId))
    throw new Error('Active tab is absent from the v2 index');
}

function isPreparedWrite(value: unknown): value is PreparedWrite {
  return (
    isRecord(value) &&
    typeof value.chatId === 'string' &&
    ['append', 'active', 'active-replace', 'replace', 'delete'].includes(
      typeof value.kind === 'string' ? value.kind : '',
    ) &&
    typeof value.create === 'boolean' &&
    Number.isSafeInteger(value.count) &&
    typeof value.sha256 === 'string' &&
    (value.activeTailCount === undefined ||
      Number.isSafeInteger(value.activeTailCount))
  );
}

/**
 * One metadata-only write-ahead record selects synced per-chat payloads. Its
 * atomic replacement avoids partial WAL tails. Recovery finishes all effects
 * before exposing new indexes; payloads remain until every index is synced.
 */
export class ChatStorageTransactions {
  public readonly transcripts: ChatTranscriptLog;
  private readonly journalPath: string;
  private readonly retainedPayloadBytes: number;
  private deltaJournalClear?: () => boolean;
  public constructor(
    private readonly store: ChatStorageV2,
    private readonly checkpoint: (point: Checkpoint) => Promise<void> = () =>
      Promise.resolve(),
    options: ChatStorageTransactionsOptions = {},
  ) {
    this.transcripts = new ChatTranscriptLog(
      join(store.directory, 'transcripts'),
    );
    this.journalPath = join(store.directory, 'metadata-journal.jsonl');
    this.retainedPayloadBytes =
      options.retainedPayloadBytes ?? RETAINED_PAYLOAD_BYTES;
  }

  /**
   * A delta-journal scope's records may reference any artifact. Its owner
   * reports whether the journal holds none after the last checkpoint; only
   * then do the files hold every reference.
   */
  public setDeltaJournalClear(clear: (() => boolean) | undefined): void {
    this.deltaJournalClear = clear;
  }

  /**
   * A maintenance deletion is forbidden while durable replay is pending. A
   * delta-journal scope authorizes one only while its owner reports an empty
   * journal, right after a checkpoint; otherwise never.
   */
  public async journalIsClear(): Promise<boolean> {
    return (
      (await stat(this.journalPath)).size === 0 &&
      ((await this.store.format()) !== 'v3' ||
        this.deltaJournalClear?.() === true)
    );
  }
  private async serial<T>(work: () => Promise<T>): Promise<T> {
    const promise = (tails.get(this.store.directory) ?? Promise.resolve())
      .catch(() => undefined)
      .then(work);
    tails.set(this.store.directory, promise);
    try {
      return await promise;
    } finally {
      if (tails.get(this.store.directory) === promise)
        tails.delete(this.store.directory);
    }
  }
  private payloadPath(transactionId: string, index: number): string {
    assertTranscriptIdentity(transactionId);
    return join(
      this.store.directory,
      'pending-transcripts',
      transactionId,
      `${index}.jsonl`,
    );
  }
  /** Read and parse one staged payload from disk. */
  private async *readPayload(
    transactionId: string,
    index: number,
    hashed: boolean,
  ): AsyncGenerator<PersistedChatMessage> {
    recordChatStoragePayloadPass(hashed);
    yield* readCompleteTranscriptMessages(
      this.payloadPath(transactionId, index),
    );
  }
  public async load(): Promise<ChatStorageIndexes> {
    return this.serial(async () => {
      await this.recover();
      const indexes = await this.store.indexes();
      await this.assertTranscriptExtents(indexes);
      return indexes;
    });
  }
  /**
   * Each index descriptor commits in the same transaction as its transcript
   * bytes, so a log shorter than its descriptor is truncation, never history.
   * A missing log stays a per-chat read error so unrelated chats remain usable.
   */
  private async assertTranscriptExtents(
    indexes: ChatStorageIndexes,
  ): Promise<void> {
    for (const tab of [
      ...indexes.live.tabs,
      ...indexes.archive.archived.map((entry) => entry.tab),
    ]) {
      let size: number;
      try {
        size = (
          await stat(
            join(this.store.directory, 'transcripts', `${tab.id}.jsonl`),
          )
        ).size;
      } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') continue;
        throw error;
      }
      if (size < tab.transcript.committedByteLength)
        throw new ChatTranscriptIntegrityError(
          `Transcript ${tab.id} is shorter than its committed index: ${size} of ${tab.transcript.committedByteLength} bytes`,
        );
    }
  }
  private async recover(): Promise<void> {
    // Admission refuses a delta-journal (version 3) scope with
    // ChatStorageNewerFormatError: version 2 transactions never write into
    // one (its journal writer does), so loading or committing fails closed.
    await this.store.migrate(() =>
      Promise.reject(
        new Error('Scope must migrate before accepting v2 transactions'),
      ),
    );
    const text = await readFile(this.journalPath, 'utf8');
    if (!text.trim()) return;
    const parsed: unknown = JSON.parse(text);
    // The pending record carries the live, archive, and recovery indexes.
    recordChatStorageIndexParses(3);
    if (
      !isRecord(parsed) ||
      parsed.v !== 2 ||
      typeof parsed.transactionId !== 'string' ||
      !Number.isSafeInteger(parsed.expectedRevision) ||
      Number(parsed.expectedRevision) < 0 ||
      !Array.isArray(parsed.writes) ||
      !parsed.writes.every(isPreparedWrite)
    )
      throw new Error('Invalid v2 metadata journal');
    assertIndexes(parsed.indexes);
    if (parsed.indexes.live.revision !== Number(parsed.expectedRevision) + 1)
      throw new Error('Invalid v2 metadata journal');
    const pending: PendingCommit = {
      v: 2,
      transactionId: parsed.transactionId,
      expectedRevision: Number(parsed.expectedRevision),
      indexes: parsed.indexes,
      writes: parsed.writes,
    };
    assertChatStorageIndexes(pending.indexes, {
      pendingTranscriptChatIds: new Set(
        pending.writes
          .filter((write) => write.create)
          .map((write) => write.chatId),
      ),
    });
    // Each atomic index rename can be on either side of this transaction.
    // An independently restored stale WAL must never roll newer state back.
    for (const name of ['live-index.json', 'archive-index.json']) {
      const current: unknown = JSON.parse(
        await readFile(join(this.store.directory, name), 'utf8'),
      );
      recordChatStorageIndexParses(1);
      if (
        !isRecord(current) ||
        (current.revision !== pending.expectedRevision &&
          current.revision !== pending.expectedRevision + 1)
      )
        throw new Error(
          'V2 journal revision conflicts with the canonical indexes',
        );
    }
    await this.apply(pending);
    // Older metadata-only commits staged an empty payload directory. Recover
    // that legacy shape without adding a directory operation to new hot commits.
    if (pending.writes.length === 0)
      await rm(dirname(this.payloadPath(pending.transactionId, 0)), {
        recursive: true,
        force: true,
      });
  }

  /**
   * `created` collects artifact files this transaction publishes, including
   * any the caller externalized while preparing its writes. A failure before
   * the journal record publishes removes exactly those files; artifacts found
   * already in place belong to earlier transactions and are never touched.
   */
  public async commit(
    expectedRevision: number,
    next: ChatStorageIndexes,
    writes: readonly ChatTranscriptWrite[],
    created: CreatedArtifacts = new CreatedArtifacts(),
    beforePublish?: () => void,
    preparePublish?: () => Promise<void>,
  ): Promise<ChatStorageIndexes> {
    // Local diagnostics time the commit from queue admission; timing never
    // changes what or when the transaction writes.
    const requestedAt = performance.now();
    return this.serial(async () => {
      const startedAt = performance.now();
      await this.recover();
      const current = await this.store.committedIndexSummary();
      if (current.revision !== expectedRevision)
        throw new Error(
          `V2 revision conflict: expected ${expectedRevision}, current ${current.revision}`,
        );
      // The commit never modifies `next`: publication applies transcript
      // descriptors copy-on-write, so the caller's indexes need no clone.
      const indexes = next;
      assertIndexes(indexes);
      if (indexes.live.revision !== expectedRevision + 1)
        throw new Error('V2 revision must advance exactly once');
      const existing = current.chatIds;
      const remaining = new Set(
        [
          ...indexes.live.tabs,
          ...indexes.archive.archived.map((entry) => entry.tab),
        ].map((tab) => tab.id),
      );
      assertChatStorageIndexes(indexes, {
        pendingTranscriptChatIds: new Set(
          Array.from(remaining).filter((id) => !existing.has(id)),
        ),
      });
      const transactionId = randomUUID();
      const directory = dirname(this.payloadPath(transactionId, 0));
      const hasPayloads = writes.length > 0;
      if (hasPayloads) await mkdir(directory, { recursive: true });
      const prepared: PreparedWrite[] = [];
      const payloadBytes: number[] = [];
      let published = false;
      try {
        const changed = new Set<string>();
        for (const [index, write] of Array.from(writes.entries())) {
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
          if (write.kind !== 'delete' && existing.has(write.chatId)) {
            await stat(
              join(
                this.store.directory,
                'transcripts',
                `${write.chatId}.jsonl`,
              ),
            );
            await this.transcripts.descriptor(write.chatId);
          }
          const hash = createHash('sha256');
          let count = 0;
          const transcript = this.transcripts;
          const input:
            | Iterable<PersistedChatMessage>
            | AsyncIterable<PersistedChatMessage> = write.messages ?? [];
          const bytes = await writeJsonValuesCooperatively(
            this.payloadPath(transactionId, index),
            (async function* (): AsyncGenerator<PersistedChatMessage> {
              for await (const message of iterateAsync(input)) {
                if (write.kind === 'delete')
                  throw new Error('Delete must not carry transcript data');
                const stored = await transcript.artifacts.externalize(
                  write.chatId,
                  message,
                  created,
                );
                hash.update(JSON.stringify(stored)).update('\n');
                count += 1;
                yield stored;
              }
            })(),
            { pretty: false, separator: '\n', trailingSeparator: true },
          );
          payloadBytes.push(bytes);
          prepared.push({
            chatId: write.chatId,
            kind: write.kind,
            create: !existing.has(write.chatId),
            count,
            sha256: hash.digest('hex'),
            ...(write.activeTailCount !== undefined
              ? { activeTailCount: write.activeTailCount }
              : {}),
          });
        }
        for (const id of Array.from(remaining))
          if (!existing.has(id) && !changed.has(id))
            throw new Error(
              'New chat must initialize a transcript in the same transaction',
            );
        for (const id of Array.from(existing))
          if (!remaining.has(id) && !changed.has(id))
            throw new Error(
              'Removed chat must declare its transcript deletion',
            );
        if (hasPayloads) {
          await fsyncDirectory(directory);
          await fsyncDirectory(dirname(directory));
          await fsyncDirectory(this.store.directory);
        }
        await this.checkpoint('prepared');
        const pending: PendingCommit = {
          v: 2,
          transactionId,
          expectedRevision,
          indexes,
          writes: prepared,
        };
        const validated = await this.validatePrepared(pending, payloadBytes);
        await this.validateAdmission(pending, validated);
        await atomicValues(
          this.journalPath,
          [pending],
          true,
          () => {
            // A directory-sync error after rename still leaves a journal that
            // recovery can observe. Its referenced payloads must remain intact.
            published = true;
          },
          preparePublish,
          beforePublish,
        );
        // The journal record carries the live, archive, and recovery indexes.
        recordChatStorageIndexSerializations(3);
        await this.checkpoint('journal');
        const committed = await this.apply(pending, validated);
        recordChatStorageCommit({
          scopeDirectory: this.store.directory,
          durationMs: performance.now() - requestedAt,
          queueWaitMs: startedAt - requestedAt,
        });
        // Nothing else holds `committed`: the store keeps only a summary.
        return committed;
      } finally {
        if (!published) {
          if (hasPayloads)
            await rm(directory, { recursive: true, force: true });
          await created.discard();
        }
      }
    });
  }

  private async validateAdmission(
    pending: PendingCommit,
    validated: ValidatedPayloads,
  ): Promise<void> {
    // Admission checks run against the pre-transaction state. Recovery uses
    // the committed payload and the log's idempotent replay, so these checks
    // must not be repeated against a partially applied transaction.
    for (const [index, write] of Array.from(pending.writes.entries())) {
      if (
        write.create ||
        !['append', 'active', 'active-replace'].includes(write.kind)
      )
        continue;
      const active = await this.transcripts.activeMessages(write.chatId);
      const ids = new Set<string>();
      const appended: string[] = [];
      const retained = validated.get(index);
      for await (const message of retained
        ? iterateAsync(retained)
        : this.readPayload(pending.transactionId, index, false)) {
        ids.add(message.id);
        const state = await this.transcripts.committedMessageState(
          write.chatId,
          message,
        );
        if (state === 'different')
          throw new Error(`Conflicting committed message ${message.id}`);
        if (state === 'absent') appended.push(message.id);
      }
      if (write.kind === 'active-replace') {
        continue;
      } else if (write.kind === 'active') {
        if (active.some((message) => !ids.has(message.id)))
          throw new Error('Active update would discard uncommitted messages');
      } else if (
        appended.some(
          (id, ordinal) => ordinal < active.length && active[ordinal].id !== id,
        )
      ) {
        throw new Error(
          'Finalized messages must follow active transcript order',
        );
      }
    }
  }

  /**
   * Validate the complete closure before changing any canonical file. A
   * commit passes the byte length of each payload it just wrote; rows of
   * payloads within the retention budget are returned parsed, so admission
   * and publication do not read them again.
   */
  private async validatePrepared(
    pending: PendingCommit,
    payloadBytes?: readonly number[],
  ): Promise<ValidatedPayloads> {
    const validated = new Map<number, PersistedChatMessage[]>();
    let retainable = payloadBytes ? this.retainedPayloadBytes : 0;
    for (const [index, write] of Array.from(pending.writes.entries())) {
      assertTranscriptIdentity(write.chatId);
      if (
        !['append', 'active', 'active-replace', 'replace', 'delete'].includes(
          write.kind,
        ) ||
        typeof write.create !== 'boolean' ||
        !Number.isSafeInteger(write.count) ||
        write.count < 0
      )
        throw new Error('Invalid transcript effect');
      const activeCount = write.activeTailCount ?? 0;
      if (
        !Number.isSafeInteger(activeCount) ||
        activeCount < 0 ||
        activeCount > write.count ||
        (activeCount > 0 && write.kind !== 'replace')
      )
        throw new Error('Invalid replacement active suffix');
      const ids = new Set<string>();
      const hash = createHash('sha256');
      let count = 0;
      const bytes = payloadBytes?.[index];
      let rows: PersistedChatMessage[] | undefined;
      if (bytes !== undefined && bytes <= retainable) {
        rows = [];
        retainable -= bytes;
      }
      for await (const message of this.readPayload(
        pending.transactionId,
        index,
        true,
      )) {
        if (ids.has(message.id))
          throw new Error('Duplicate prepared message id');
        ids.add(message.id);
        rows?.push(message);
        hash.update(JSON.stringify(message)).update('\n');
        count += 1;
        for (const block of message.blocks)
          for (const ref of storedArtifactRefsOf(block))
            await this.transcripts.artifacts.verifyArtifact(write.chatId, ref);
      }
      if (count !== write.count || hash.digest('hex') !== write.sha256)
        throw new Error('Prepared transcript failed integrity validation');
      if (rows) validated.set(index, rows);
    }
    return validated;
  }

  /**
   * Apply a durable transaction and return the published indexes. A commit
   * passes the payloads it validated in this same serialized transaction,
   * after they were synced; recovery validates what it finds on disk.
   */
  private async apply(
    pending: PendingCommit,
    validated?: ValidatedPayloads,
  ): Promise<ChatStorageIndexes> {
    if (!validated) await this.validatePrepared(pending);
    let indexes = pending.indexes;
    for (const [index, write] of Array.from(pending.writes.entries())) {
      if (write.kind === 'delete') continue;
      const path = join(
        this.store.directory,
        'transcripts',
        `${write.chatId}.jsonl`,
      );
      try {
        await stat(path);
      } catch (error) {
        if (
          !write.create ||
          !(isErrnoException(error) && error.code === 'ENOENT')
        )
          throw error;
        await this.transcripts.initialize(write.chatId);
      }
      const retained = validated?.get(index);
      const rows = retained
        ? iterateAsync(retained)
        : this.readPayload(pending.transactionId, index, false);
      if (write.kind === 'replace') {
        const mutable: PersistedChatMessage[] = [];
        const activeCount = write.activeTailCount ?? 0;
        if (
          !Number.isSafeInteger(activeCount) ||
          activeCount < 0 ||
          activeCount > write.count
        )
          throw new Error('Invalid replacement active suffix');
        const prior = indexedTab(indexes, write.chatId);
        await this.transcripts.replace(
          write.chatId,
          (async function* (): AsyncGenerator<PersistedChatMessage> {
            let ordinal = 0;
            for await (const message of rows) {
              if (ordinal++ < write.count - activeCount) yield message;
              else mutable.push(message);
            }
          })(),
          Math.max(
            indexes.live.revision,
            (prior?.transcript.transcriptRevision ?? 0) + 1,
          ),
        );
        if (mutable.length)
          await this.transcripts.writeActive(write.chatId, mutable);
      } else {
        const messages: PersistedChatMessage[] = [];
        for await (const message of rows) messages.push(message);
        if (write.kind === 'append')
          await this.transcripts.append(write.chatId, messages);
        else if (write.kind === 'active-replace')
          await this.transcripts.replaceActive(write.chatId, messages);
        else await this.transcripts.writeActive(write.chatId, messages);
      }
      const descriptor = await this.transcripts.descriptor(write.chatId);
      indexes = withTranscriptDescriptor(indexes, write.chatId, descriptor);
    }
    // Transcript descriptors are final now. Validate the exact disk-read
    // contract before any canonical index rename or journal clearance.
    assertChatStorageIndexes(indexes);
    await this.checkpoint('transcripts');
    // The durable journal can replay any subset of these atomic renames. Each
    // index file is synced before publication; one parent-directory sync then
    // makes all three names durable before the journal is cleared.
    await atomicIndex(
      join(this.store.directory, 'live-index.json'),
      indexes.live,
    );
    await atomicIndex(
      join(this.store.directory, 'archive-index.json'),
      indexes.archive,
    );
    await atomicIndex(
      join(this.store.directory, 'recovery-index.json'),
      indexes.recovery,
    );
    await fsyncDirectory(this.store.directory);
    await this.store.recordPublishedIndexes(indexes);
    await this.checkpoint('indexes');
    for (const write of pending.writes)
      if (write.kind === 'delete') await this.transcripts.remove(write.chatId);
    await atomicValues(this.journalPath, [], true);
    if (pending.writes.length)
      await rm(dirname(this.payloadPath(pending.transactionId, 0)), {
        recursive: true,
        force: true,
      });
    return indexes;
  }
}
