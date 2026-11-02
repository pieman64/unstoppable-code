import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import type { PersistedToolOutputReference } from '@canopy/agent-transcript/types';
import type { TranscriptStreamRegistration } from '@canopy/protocol/canopy-core';
import { storedArtifactRefsOf } from './chat-artifact-references';
import {
  checkActiveSidecarMessageRecordBudget,
  decodeActiveRowAnchors,
  encodeActiveRowAnchors,
  type ActiveRowAnchor,
  type ActiveSidecarMessageRecord,
} from './chat-transcript-live-positions';
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
  TranscriptStreamStore,
  readCompleteTranscriptMessages,
  prepareRowsWithActiveTail,
  transcriptFieldPolicy,
  type TranscriptFieldMode,
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
import {
  loadStreamCatalog,
  loadStreamRegistry,
  parseStreamDescriptor,
  streamDescriptorAnswerReferences,
  streamRegistryPaths,
} from './chat-delta-journal/stream-registry';
import {
  scanDelegationRegistryAnswerReferences,
  registrySnapshotDigest,
} from './chat-delta-journal/delegation-registry-store';
import { delegationTranscriptPaths } from './transcript-stream-paths';

/** Metadata only: maintenance scans the streams' rows in bounded slices. */
export interface ChildArtifactSnapshot {
  identity: string;
  streams: readonly {
    target: TranscriptStreamRegistration['target'];
    streamKey: string;
    committedByteLength: number;
  }[];
  identityInputs: readonly {
    streamKey: string;
    streamRevision: number;
    committedSha256: string;
    committedByteLength: number;
  }[];
}

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
  /**
   * A `replace` keeps its last `activeTailCount` rows active. For `append`:
   * absent uses the legacy sidecar-prefix append; explicit zero commits every
   * payload row with an empty resulting active set; positive keeps the last
   * `activeTailCount` rows as the complete resulting active set, in that order.
   * In either complete-active-set append, preceding rows commit in payload order.
   */
  activeTailCount?: number;
  /** Record-level anchors persisted as JSON-safe [messageId, anchor] tuples. */
  anchors?: [string, ActiveRowAnchor][];
}
interface PreparedWrite {
  chatId: string;
  kind: ChatTranscriptWrite['kind'];
  create: boolean;
  count: number;
  sha256: string;
  activeTailCount?: number;
  /**
   * New append-with-active-suffix intent encoded as the old, known
   * `active-replace` effect. Older transaction readers ignore this optional
   * field and keep every payload row active; new readers split the payload
   * into the committed append prefix and complete active suffix.
   */
  appendCommittedCount?: number;
  anchors?: [string, ActiveRowAnchor][];
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

function decodeAnchors(value: unknown): Map<string, ActiveRowAnchor> {
  const result = decodeActiveRowAnchors(value);
  if (result.status === 'invalid')
    throw new Error(`Invalid active row anchors: ${result.reason}`);
  return result.anchors;
}

/**
 * Payload bytes a commit may keep parsed between validating its payloads and
 * applying them, so each payload is read once. A payload beyond the budget is
 * not held in memory: it is read again for the admission checks of an
 * existing chat's append or active write, and again when it is applied.
 */
const RETAINED_PAYLOAD_BYTES = 8 * 1024 * 1024;

/** Validated payload rows by write index, kept for the rest of one commit. */
type ValidatedPayloads = ReadonlyMap<number, readonly PersistedChatMessage[]>;
type UncommittedIdsByWrite = ReadonlyMap<number, readonly string[]>;

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
      Number.isSafeInteger(value.activeTailCount)) &&
    (value.appendCommittedCount === undefined ||
      Number.isSafeInteger(value.appendCommittedCount)) &&
    (!Object.prototype.hasOwnProperty.call(value, 'anchors') ||
      Array.isArray(value.anchors))
  );
}

/** The active suffix length of an append effect, including its WAL encoding. */
function appendActiveTailCount(write: PreparedWrite): number {
  if (write.appendCommittedCount !== undefined)
    return write.count - write.appendCommittedCount;
  return write.kind === 'append' ? (write.activeTailCount ?? 0) : 0;
}

function isSemanticAppend(write: PreparedWrite): boolean {
  return write.kind === 'append' || write.appendCommittedCount !== undefined;
}

/**
 * A complete-active-set append (including an explicitly empty suffix) cannot
 * use the legacy WAL `append`: older readers require physical sidecar order
 * and reject a positive `activeTailCount` on that kind. Encode it as the already
 * known `active-replace` effect and retain its semantic split in an ignored
 * extension. This bounded payload is safe on downgrade: the old effect keeps
 * all rows active instead of losing any append rows.
 */
function normalizeAppendActiveTails(pending: PendingCommit): PendingCommit {
  const writes: PreparedWrite[] = pending.writes.map((write) => {
    if (write.kind !== 'append' || write.activeTailCount === undefined)
      return write;
    const { activeTailCount: _activeTailCount, ...withoutActiveTailCount } =
      write;
    void _activeTailCount;
    return {
      ...withoutActiveTailCount,
      kind: 'active-replace',
      appendCommittedCount: write.count - write.activeTailCount,
    };
  });
  return writes.some((write, index) => write !== pending.writes[index])
    ? { ...pending, writes }
    : pending;
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
  /** Registered format-4 children share their parent chat's artifact owner. */
  public async childArtifactSnapshot(
    chatId: string,
  ): Promise<ChildArtifactSnapshot> {
    if ((await this.store.format()) !== 'v4')
      return { identity: 'no-child-streams', streams: [], identityInputs: [] };
    const root = join(this.store.directory, 'transcripts');
    const catalog = await loadStreamCatalog(root);
    const parent = catalog.parents[chatId];
    if (!parent) {
      const digest = await registrySnapshotDigest(root, chatId);
      return {
        identity: `${catalog.checkpointRevision}:no-parent:${digest}`,
        streams: [],
        identityInputs: [
          {
            streamKey: 'delegation-result-registry',
            streamRevision: 0,
            committedSha256: digest,
            committedByteLength: 0,
          },
        ],
      };
    }
    const registry = await loadStreamRegistry(root, chatId, { readOnly: true });
    const identities = [String(catalog.checkpointRevision), registry.sha256];
    const streams: Array<ChildArtifactSnapshot['streams'][number]> = [];
    const identityInputs: Array<{
      streamKey: string;
      streamRevision: number;
      committedSha256: string;
      committedByteLength: number;
    }> = [];
    for (const entry of registry.entries) {
      const paths = streamRegistryPaths(root, chatId, entry.streamKey);
      const descriptor = parseStreamDescriptor(
        await readFile(paths.descriptor),
      );
      identityInputs.push({
        streamKey: entry.streamKey,
        streamRevision: descriptor.streamRevision,
        committedSha256: descriptor.committedSha256,
        committedByteLength: descriptor.committedByteLength,
      });
      identities.push(
        JSON.stringify([
          descriptor.streamKey,
          descriptor.streamRevision,
          descriptor.committedSha256,
          descriptor.committedByteLength,
        ]),
      );
      streams.push({
        target: entry.target,
        streamKey: entry.streamKey,
        committedByteLength: descriptor.committedByteLength,
      });
    }
    const registryDigest = await registrySnapshotDigest(root, chatId);
    identities.push(registryDigest);
    identityInputs.push({
      streamKey: 'delegation-result-registry',
      streamRevision: 0,
      committedSha256: registryDigest,
      committedByteLength: 0,
    });
    return {
      identity: createHash('sha256')
        .update(identities.join('\n'))
        .digest('hex'),
      streams,
      identityInputs,
    };
  }

  /**
   * Result-registry and descriptor answer references are canonical roots
   * even when no row contains them. Nulls charge records without answers.
   */
  public async *registryAnswerReferences(
    chatId: string,
  ): AsyncGenerator<PersistedToolOutputReference | null> {
    if ((await this.store.format()) !== 'v4') return;
    yield* scanDelegationRegistryAnswerReferences(
      join(this.store.directory, 'transcripts'),
      chatId,
    );
    const root = join(this.store.directory, 'transcripts');
    const catalog = await loadStreamCatalog(root);
    if (!catalog.parents[chatId]) return;
    const registry = await loadStreamRegistry(root, chatId, {
      readOnly: true,
    });
    for (const entry of registry.entries) {
      const paths = streamRegistryPaths(root, chatId, entry.streamKey);
      const descriptor = parseStreamDescriptor(
        await readFile(paths.descriptor),
      );
      const references = Array.from(
        streamDescriptorAnswerReferences(descriptor),
      );
      if (references.length === 0) yield null;
      else for (const reference of references) yield reference;
    }
  }

  /** A read-only child store for bounded maintenance slices. */
  public childArtifactStore(
    target: TranscriptStreamRegistration['target'],
  ): TranscriptStreamStore {
    return new TranscriptStreamStore(
      delegationTranscriptPaths(
        join(this.store.directory, 'transcripts'),
        target,
      ),
      this.transcripts.artifacts,
      undefined,
      { readOnly: true, childMode: true },
    );
  }
  public constructor(
    private readonly store: ChatStorageV2,
    private readonly checkpoint: (
      point: Checkpoint,
    ) => Promise<void> = (): Promise<void> => Promise.resolve(),
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
      (!(await this.store.journalFile()) || this.deltaJournalClear?.() === true)
    );
  }
  /**
   * The field mode of the manifest this transaction selected; read inside
   * the serialized scope transaction, never cached across it.
   */
  private async fieldMode(): Promise<TranscriptFieldMode> {
    return (await this.store.format()) === 'v4' ? 'format4' : 'legacy';
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
    const effectChatIds = new Set<string>();
    for (const write of pending.writes) {
      if (effectChatIds.has(write.chatId))
        throw new Error(
          'Only one transcript effect per chat is allowed in a scope transaction',
        );
      effectChatIds.add(write.chatId);
    }
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
    const validated = await this.validatePrepared(pending);
    await this.validateAnchorProjections(pending, validated, new Map(), true);
    await this.apply(pending, validated);
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
      // Metadata-only commits prepare no rows and need no manifest read.
      const fields: TranscriptFieldMode = hasPayloads
        ? await this.fieldMode()
        : 'legacy';
      if (hasPayloads) await mkdir(directory, { recursive: true });
      const prepared: PreparedWrite[] = [];
      const payloadBytes: number[] = [];
      const explicitAnchors = new Map<number, Map<string, ActiveRowAnchor>>();
      const capturedAnchors = new Map<number, Map<string, ActiveRowAnchor>>();
      let published = false;
      try {
        const changed = new Set<string>();
        for (const [index, write] of Array.from(writes.entries())) {
          assertTranscriptIdentity(write.chatId);
          if (write.anchors !== undefined)
            explicitAnchors.set(index, decodeAnchors(write.anchors));
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
            if (write.kind === 'replace') {
              const anchors = await this.transcripts.activeRowAnchors(
                write.chatId,
              );
              if (anchors.size > 0) capturedAnchors.set(index, anchors);
            }
          }
          const hash = createHash('sha256');
          let count = 0;
          const transcript = this.transcripts;
          const input:
            | Iterable<PersistedChatMessage>
            | AsyncIterable<PersistedChatMessage> = write.messages ?? [];
          // Committed rows are final; active writes and an active suffix are open.
          const activeTailCount =
            write.kind === 'replace'
              ? (write.activeTailCount ?? 0)
              : write.kind === 'append' || write.kind === 'delete'
                ? 0
                : Number.POSITIVE_INFINITY;
          const bytes = await writeJsonValuesCooperatively(
            this.payloadPath(transactionId, index),
            (async function* (): AsyncGenerator<PersistedChatMessage> {
              for await (const stored of prepareRowsWithActiveTail(
                input,
                activeTailCount,
                (message, final) => {
                  if (write.kind === 'delete')
                    throw new Error('Delete must not carry transcript data');
                  return transcript.artifacts.externalize(
                    write.chatId,
                    message,
                    created,
                    transcriptFieldPolicy(fields, final),
                  );
                },
              )) {
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
        const validated = await this.validatePrepared(
          pending,
          payloadBytes,
          true,
        );
        const activeSnapshots = await this.readActiveSnapshots(pending);
        for (const [index, anchors] of Array.from(
          activeSnapshots.anchors.entries(),
        ))
          if (anchors.size > 0) capturedAnchors.set(index, anchors);
        const uncommittedIds = await this.validateAdmission(
          pending,
          validated,
          activeSnapshots.messages,
          activeSnapshots.anchors,
        );
        await this.capturePreparedAnchors(
          pending,
          validated,
          capturedAnchors,
          explicitAnchors,
          activeSnapshots.messages,
          uncommittedIds,
        );
        await this.validateAnchorProjections(
          pending,
          validated,
          activeSnapshots.messages,
          false,
        );
        const journalPending = normalizeAppendActiveTails(pending);
        await atomicValues(
          this.journalPath,
          [journalPending],
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
        const committed = await this.apply(journalPending, validated, fields);
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
    activeSnapshots: ReadonlyMap<number, readonly PersistedChatMessage[]>,
    activeSnapshotAnchors: ReadonlyMap<
      number,
      ReadonlyMap<string, ActiveRowAnchor>
    >,
  ): Promise<UncommittedIdsByWrite> {
    // Admission checks run against the pre-transaction state. Recovery uses
    // the committed payload and the log's idempotent replay, so these checks
    // must not be repeated against a partially applied transaction.
    const uncommittedIds = new Map<number, readonly string[]>();
    for (const [index, write] of Array.from(pending.writes.entries())) {
      if (
        write.create ||
        !['append', 'active', 'active-replace'].includes(write.kind)
      )
        continue;
      await this.transcripts.withCommittedMessageStates(
        write.chatId,
        async (committed) => {
          const active = activeSnapshots.get(index) ?? [];
          const activeAnchors = activeSnapshotAnchors.get(index) ?? new Map();
          const ids = new Set<string>();
          const appended: string[] = [];
          const ordinaryPrefix: string[] = [];
          const retained = validated.get(index);
          const activeTailCount = appendActiveTailCount(write);
          const committedPrefixLength = isSemanticAppend(write)
            ? write.count - activeTailCount
            : write.count;
          let ordinal = 0;
          for await (const message of retained
            ? iterateAsync(retained)
            : this.readPayload(pending.transactionId, index, false)) {
            ids.add(message.id);
            const state = await committed.committedMessageState(message);
            if (state === 'different')
              throw new Error(`Conflicting committed message ${message.id}`);
            if (
              state === 'identical' &&
              isSemanticAppend(write) &&
              activeTailCount > 0 &&
              ordinal >= committedPrefixLength
            )
              throw new Error(
                `Active suffix contains committed message ${message.id}`,
              );
            if (state === 'absent') {
              appended.push(message.id);
              if (
                isSemanticAppend(write) &&
                ordinal < committedPrefixLength &&
                !activeAnchors.has(message.id)
              )
                ordinaryPrefix.push(message.id);
            }
            ordinal += 1;
          }
          uncommittedIds.set(index, appended);
          if (write.kind === 'active-replace') {
            return;
          } else if (write.kind === 'active') {
            if (active.some((message) => !ids.has(message.id)))
              throw new Error(
                'Active update would discard uncommitted messages',
              );
          } else if (
            isSemanticAppend(write) &&
            write.activeTailCount !== undefined
          ) {
            for (const message of active) {
              if (ids.has(message.id)) continue;
              const state = await committed.committedMessageState(message);
              if (state === 'different')
                throw new Error(`Conflicting committed message ${message.id}`);
              if (state === 'absent')
                throw new Error(
                  'Active update would discard uncommitted messages',
                );
            }
            const ordinaryActive = active.filter(
              (message) => !activeAnchors.has(message.id),
            );
            const ordinaryActiveIds = new Set(
              ordinaryActive.map((message) => message.id),
            );
            const committedOrdinaryActivePrefix = ordinaryPrefix.filter((id) =>
              ordinaryActiveIds.has(id),
            );
            if (
              committedOrdinaryActivePrefix.some(
                (id, prefixOrdinal) =>
                  prefixOrdinal < ordinaryActive.length &&
                  ordinaryActive[prefixOrdinal].id !== id,
              )
            )
              throw new Error(
                'Finalized messages must follow active transcript order',
              );
          } else if (
            appended.some(
              (id, ordinal) =>
                ordinal < active.length && active[ordinal].id !== id,
            )
          ) {
            throw new Error(
              'Finalized messages must follow active transcript order',
            );
          }
        },
      );
    }
    return uncommittedIds;
  }

  private async readActiveSnapshots(pending: PendingCommit): Promise<{
    messages: Map<number, PersistedChatMessage[]>;
    anchors: Map<number, Map<string, ActiveRowAnchor>>;
  }> {
    const snapshots = new Map<number, PersistedChatMessage[]>();
    const anchors = new Map<number, Map<string, ActiveRowAnchor>>();
    for (const [index, write] of Array.from(pending.writes.entries())) {
      if (
        write.create ||
        !['append', 'active', 'active-replace'].includes(write.kind)
      )
        continue;
      const snapshot = await this.transcripts.activeSnapshot(write.chatId);
      snapshots.set(index, snapshot.messages);
      if (snapshot.anchors) anchors.set(index, snapshot.anchors);
    }
    return { messages: snapshots, anchors };
  }

  /**
   * Freeze the current sidecar anchors into the prepared WAL payload before
   * an ordered replacement can delete that sidecar. Only anchors whose rows
   * survive as active rows (or whose append rows are being finalized) are
   * encoded; an empty effective map keeps the legacy WAL shape byte-for-byte.
   */
  private async capturePreparedAnchors(
    pending: PendingCommit,
    validated: ValidatedPayloads,
    captured: ReadonlyMap<number, ReadonlyMap<string, ActiveRowAnchor>>,
    explicit: ReadonlyMap<number, ReadonlyMap<string, ActiveRowAnchor>>,
    activeSnapshots: ReadonlyMap<number, readonly PersistedChatMessage[]>,
    uncommittedIds: UncommittedIdsByWrite,
  ): Promise<void> {
    for (const [index, write] of Array.from(pending.writes.entries())) {
      if (write.kind === 'delete') continue;
      const candidates = new Map(captured.get(index) ?? []);
      for (const [id, anchor] of Array.from(explicit.get(index) ?? []))
        candidates.set(id, anchor);
      if (candidates.size === 0) continue;
      // Reuse admission's membership results; finalized active rows carry no anchors.
      const eligibleIds = new Set(uncommittedIds.get(index) ?? []);

      const hasCompleteAppendSuffix =
        write.kind === 'append' && write.activeTailCount !== undefined;
      const tailStart =
        write.kind === 'replace' || hasCompleteAppendSuffix
          ? write.count - (write.activeTailCount ?? 0)
          : 0;
      const survivors = new Map<string, ActiveRowAnchor>();
      const payloadIds = new Set<string>();
      const retained = validated.get(index);
      const rows = retained
        ? iterateAsync(retained)
        : this.readPayload(pending.transactionId, index, false);
      let ordinal = 0;
      for await (const message of rows) {
        payloadIds.add(message.id);
        const activeRow =
          (write.kind !== 'replace' && !hasCompleteAppendSuffix) ||
          ordinal >= tailStart;
        if (activeRow) {
          const anchor = candidates.get(message.id);
          if (
            anchor &&
            (write.kind === 'replace' ||
              write.create ||
              eligibleIds.has(message.id))
          )
            survivors.set(message.id, anchor);
        }
        ordinal += 1;
      }
      if (write.kind === 'append' && !hasCompleteAppendSuffix) {
        for (const message of activeSnapshots.get(index) ?? []) {
          if (payloadIds.has(message.id)) continue;
          const anchor = candidates.get(message.id);
          if (anchor) survivors.set(message.id, anchor);
        }
      }
      if (survivors.size > 0) write.anchors = encodeActiveRowAnchors(survivors);
    }
  }

  /**
   * Validate every persisted anchor projection before WAL publication or
   * recovery effects. The message list passed to the log's read-only validator
   * is a bounded context closure: anchored rows plus payload/active rows they
   * reference, not a materialization of a potentially large transcript.
   */
  private async validateAnchorProjections(
    pending: PendingCommit,
    validated: ValidatedPayloads,
    activeSnapshots: ReadonlyMap<number, readonly PersistedChatMessage[]>,
    recovery: boolean,
  ): Promise<void> {
    for (const [index, write] of Array.from(pending.writes.entries())) {
      if (write.anchors === undefined) continue;
      const anchors = decodeAnchors(write.anchors);
      if (anchors.size === 0) continue;

      const contextIds = new Set<string>();
      for (const [id, anchor] of Array.from(anchors)) {
        contextIds.add(id);
        contextIds.add(anchor.runId);
        if (anchor.after !== null) contextIds.add(anchor.after);
      }
      const contextRows = new Map<string, PersistedChatMessage>();
      const appendActiveIds = new Set<string>();
      const semanticAppendTailCount = appendActiveTailCount(write);
      const hasCompleteAppendSuffix =
        isSemanticAppend(write) &&
        (write.activeTailCount !== undefined ||
          write.appendCommittedCount !== undefined);
      if (isSemanticAppend(write)) {
        const activeMessages = recovery
          ? await this.transcripts.activeMessagesForAnchorValidation(
              write.chatId,
            )
          : (activeSnapshots.get(index) ?? []);
        for (const message of activeMessages) {
          appendActiveIds.add(message.id);
          if (contextIds.has(message.id)) contextRows.set(message.id, message);
        }
      }
      const activePayloadIds = new Set<string>();
      const payloadContextIds = new Set<string>();
      const tailStart =
        write.kind === 'replace'
          ? write.count - (write.activeTailCount ?? 0)
          : 0;
      const appendTailStart = write.count - semanticAppendTailCount;
      const retained = validated.get(index);
      const rows = retained
        ? iterateAsync(retained)
        : this.readPayload(pending.transactionId, index, false);
      let ordinal = 0;
      for await (const message of rows) {
        if (contextIds.has(message.id)) {
          contextRows.set(message.id, message);
          payloadContextIds.add(message.id);
          const activePayload = isSemanticAppend(write)
            ? !hasCompleteAppendSuffix || ordinal >= appendTailStart
            : write.kind !== 'replace' || ordinal >= tailStart;
          if (activePayload) activePayloadIds.add(message.id);
        }
        ordinal += 1;
      }

      if (write.kind === 'replace') {
        for (const [id, anchor] of Array.from(anchors)) {
          if (!activePayloadIds.has(id))
            throw new Error(
              `Anchored message is not active in replacement: ${id}`,
            );
          if (!payloadContextIds.has(anchor.runId))
            throw new Error(
              `Replacement payload is missing run card ${anchor.runId} for anchor ${id}`,
            );
          if (anchor.after !== null && !payloadContextIds.has(anchor.after))
            throw new Error(
              `Replacement payload is missing predecessor ${anchor.after} for anchor ${id}`,
            );
        }
      } else {
        const validActiveIds = new Set(activePayloadIds);
        if (isSemanticAppend(write) && !hasCompleteAppendSuffix)
          for (const id of Array.from(appendActiveIds)) validActiveIds.add(id);
        for (const id of Array.from(anchors.keys()))
          if (!validActiveIds.has(id))
            throw new Error(`Anchored message is not active: ${id}`);
      }

      const projection = Array.from(contextRows.values());
      await this.transcripts.validateActiveRowAnchors(
        write.chatId,
        projection,
        anchors,
      );

      for (const [id, anchor] of Array.from(anchors)) {
        const message = contextRows.get(id);
        if (!message) throw new Error(`Anchored message is not active: ${id}`);
        const finalizing =
          isSemanticAppend(write) &&
          !hasCompleteAppendSuffix &&
          activePayloadIds.has(id);
        const record: ActiveSidecarMessageRecord = {
          version: 2,
          kind: 'message',
          message,
          anchor,
          ...(finalizing ? { finalizing: true } : {}),
        };
        const budget = checkActiveSidecarMessageRecordBudget(record);
        if (!budget.withinLimit)
          throw new Error(
            `Active sidecar message record exceeds maximum size (${budget.bytes} of ${budget.ceiling} bytes)`,
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
    allowAppendActiveTail = false,
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
      if (write.anchors !== undefined) decodeAnchors(write.anchors);
      const activeCount = write.activeTailCount ?? 0;
      const appendCommittedCount = write.appendCommittedCount;
      const hasValidAppendIntent =
        appendCommittedCount !== undefined &&
        write.kind === 'active-replace' &&
        write.activeTailCount === undefined &&
        Number.isSafeInteger(appendCommittedCount) &&
        appendCommittedCount >= 0 &&
        appendCommittedCount <= write.count;
      if (
        !Number.isSafeInteger(activeCount) ||
        activeCount < 0 ||
        activeCount > write.count ||
        (appendCommittedCount !== undefined && !hasValidAppendIntent) ||
        (activeCount > 0 &&
          write.kind !== 'replace' &&
          !(allowAppendActiveTail && write.kind === 'append'))
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
        for await (const reference of this.transcripts.artifacts.referenceClosure(
          write.chatId,
          message,
        ))
          await this.transcripts.artifacts.verify(write.chatId, reference);
        // The closure covers tool output; visuals live on the logical blocks.
        const logical = await this.transcripts.artifacts.expandBlocks(
          write.chatId,
          message,
        );
        for (const block of logical.blocks)
          for (const ref of storedArtifactRefsOf(block))
            if (ref.family === 'visual')
              await this.transcripts.artifacts.verifyArtifact(
                write.chatId,
                ref,
              );
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
    selected?: TranscriptFieldMode,
  ): Promise<ChatStorageIndexes> {
    if (!validated) await this.validatePrepared(pending);
    // Payload rows were prepared before the record published: re-applying
    // them (now or in recovery) verifies and never publishes.
    const fields: TranscriptFieldMode =
      (selected ?? (await this.fieldMode())) === 'format4'
        ? 'format4-verify'
        : 'legacy';
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
      const anchors =
        write.anchors === undefined ? undefined : decodeAnchors(write.anchors);
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
          fields,
        );
        if (mutable.length)
          await this.transcripts.writeActive(
            write.chatId,
            mutable,
            anchors,
            fields,
          );
      } else {
        const messages: PersistedChatMessage[] = [];
        for await (const message of rows) messages.push(message);
        if (write.appendCommittedCount !== undefined)
          await this.transcripts.append(
            write.chatId,
            messages,
            anchors,
            appendActiveTailCount(write),
            fields,
          );
        else if (write.kind === 'append')
          await this.transcripts.append(
            write.chatId,
            messages,
            anchors,
            undefined,
            fields,
          );
        else if (write.kind === 'active-replace')
          await this.transcripts.replaceActive(
            write.chatId,
            messages,
            anchors,
            fields,
          );
        else
          await this.transcripts.writeActive(
            write.chatId,
            messages,
            anchors,
            fields,
          );
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
