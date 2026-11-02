import { registryEffectIdentity } from './delegation-registry-owner';
import { DelegationRegistryOperationError } from './delegation-registry-error';
import { DelegationRegistryStore } from './delegation-registry-store';
import { createDelegationRegistryReader } from './delegation-registry-reader';
import type { DelegationTranscriptTarget } from '@canopy/desktop-shared/node/delegation/transcript-port';
import type {
  DelegationRegistryReadView,
  DelegationRegistryCheckpointReader,
  DelegationRegistryJournalEffect,
} from './delegation-registry-api';
/**
 * The shared read-only "checkpoint + journal replay" helper.
 *
 * Direct file readers that bypass `ChatStateService` (search indexing, the
 * interrupted-work scan, catalog readers and the CLI, export and portable
 * transfer, feedback bundles, shared-container publication, local-memory
 * import, archive capture and restore, recovery tools) see only the last
 * checkpoint when they read a delta-journal scope's files. This helper gives
 * them the committed state instead: the exact indexes a checkpoint would
 * write, and a read-only transcript log per chat.
 *
 * It never writes the scope. Chats that journal records changed after the
 * checkpoint are materialized on a private scratch copy, through the same
 * `ChatTranscriptLog` operations the checkpoint uses, so what a reader sees
 * is what the checkpoint will write. Callers that need a stable view hold
 * the scope lease; the helper itself takes none.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TranscriptDescriptor } from '@canopy/agent-transcript/transcript-storage';
import type { DelegationChildRow } from '@canopy/agent-transcript';
import type {
  TranscriptStreamDescriptor,
  TranscriptStreamRegistration,
  TranscriptTarget,
} from '@canopy/protocol/canopy-core';
import type { ChatStorageIndexes } from '../chat-storage-transactions';
import { storedArtifactDirectories } from '../chat-artifact-references';
import {
  ChatTranscriptLog,
  TranscriptStreamStore,
  isDelegationChildRow,
} from '../chat-transcript-log';
import { ChatTranscriptArtifacts } from '../chat-transcript-artifacts';
import {
  delegationStreamKey,
  delegationTranscriptPaths,
} from '../transcript-stream-paths';
import { isErrnoException, isRecord } from '../type-guards';
import {
  assertNoNewerChatStorageManifest,
  ChatDeltaJournalIntegrityError,
  journalFileFor,
  parseChatStorageManifest,
  transcriptTargetKey,
  type DeltaJournalTornTail,
} from './format';
import {
  loadStreamCatalog,
  applyStreamDescriptorUpdate,
  createEmptyStreamDescriptor,
  UnknownTranscriptStreamError,
  loadStreamRegistry,
  parseStreamCatalog,
  parseStreamDescriptor,
  parseStreamRegistry,
  streamCatalogPath,
  streamRegistryPaths,
  validateStreamClosure,
  validateStreamTarget,
} from './stream-registry';
import {
  ChildJournalOverlay,
  readMergedChildStreamPage,
} from './child-overlay';
import type { ActiveRowAnchor } from '../chat-transcript-live-positions';
import { DELTA_CHECKPOINT_WORK_DIRECTORY } from './format';
import { readCheckpointAnchorCapture } from './checkpoint-anchors';
import {
  applyRecordTranscripts,
  withTranscriptDescriptors,
} from './materialize';
import {
  assertJournalCovers,
  readCheckpointMarker,
  readCheckpointState,
  readDeltaJournal,
  recordsAfter,
  replayIndexMetadata,
  verifyRecordArtifacts,
  primaryEffects,
  type AssertChatStorageIndexes,
  type DeltaCheckpointMarker,
  type JournalCommit,
} from './replay';

export interface ReplayedChatScopeOptions {
  maxManifestVersion?: 3 | 4;
  /**
   * Parent of the private scratch directory used for chats changed since
   * the checkpoint. Defaults to the operating system's per-user temporary
   * directory. Prefer one on the same volume as the scope, so tool outputs
   * are linked rather than copied.
   */
  scratchRoot?: string;
}

export interface ReplayedChatScope extends DelegationRegistryCheckpointReader {
  /** Revision of the last journal record (or the checkpoint). */
  readonly revision: number;
  /** The indexes a checkpoint at `revision` would write, byte for byte. */
  readonly indexes: ChatStorageIndexes;
  /** Records after the checkpoint that this view replayed. */
  readonly recordCount: number;
  readonly journalBytes: number;
  readonly streamRegistrations: readonly TranscriptStreamRegistration[];
  descriptor(
    target: DelegationTranscriptTarget,
  ): Promise<TranscriptStreamDescriptor | undefined>;
  /** An unacknowledged partial append that was ignored. */
  readonly tornTail?: DeltaJournalTornTail;
  /** A read-only log holding this chat's committed and active rows. */
  transcript(chatId: string): ChatTranscriptLog;
  /**
   * Page one registered child stream. Its files are copied only when a
   * checkpoint's child append intent must be recovered first.
   */
  stream(
    target: Extract<TranscriptTarget, { kind: 'delegation' }>,
    options?: { before?: number; limit?: number },
  ): Promise<{ rows: readonly DelegationChildRow[]; nextBefore?: number }>;
  /** Remove the scratch copy. Logs returned earlier stop working. */
  dispose(): Promise<void>;
}

function scopeManifestPath(scope: {
  directory: string;
  scopeId: string;
}): string {
  return join(
    dirname(dirname(scope.directory)),
    'chat-storage-manifests',
    `${scope.scopeId}.json`,
  );
}

async function publishingStreamRegistrations(
  root: string,
  revision: number,
  marker: DeltaCheckpointMarker,
): Promise<
  Array<{
    entry: TranscriptStreamRegistration;
    descriptor: TranscriptStreamDescriptor;
  }>
> {
  const metadata = marker.metadata;
  if (!metadata)
    throw new ChatDeltaJournalIntegrityError(
      'Missing format-4 publishing metadata',
    );
  const digest = (bytes: Buffer): string =>
    createHash('sha256').update(bytes).digest('hex');
  const selected = async (path: string, expected?: string): Promise<Buffer> => {
    let bytes: Buffer;
    try {
      bytes = await readFile(`${path}.checkpoint`);
    } catch (error) {
      if (!(isErrnoException(error) && error.code === 'ENOENT')) throw error;
      bytes = await readFile(path);
    }
    if (expected && digest(bytes) !== expected)
      throw new ChatDeltaJournalIntegrityError(
        'Publishing stream metadata digest mismatch',
      );
    return bytes;
  };
  const catalogPath = streamCatalogPath(root);
  const catalog = parseStreamCatalog(
    await selected(catalogPath, metadata.catalog?.sha256),
  );
  if (catalog.checkpointRevision !== revision)
    throw new ChatDeltaJournalIntegrityError(
      'Publishing catalog revision mismatch',
    );
  const entries: Array<{
    entry: TranscriptStreamRegistration;
    descriptor: TranscriptStreamDescriptor;
  }> = [];
  for (const [parent, reference] of Object.entries(catalog.parents)) {
    const paths = streamRegistryPaths(root, parent, '0'.repeat(64));
    const registryBytes = await selected(
      paths.registry,
      metadata.registries.find((item) => item.path === paths.registry)?.sha256,
    );
    if (
      registryBytes.length !== reference.registryBytes ||
      digest(registryBytes) !== reference.registrySha256
    )
      throw new ChatDeltaJournalIntegrityError(
        'Publishing registry/catalog mismatch',
      );
    const registry = parseStreamRegistry(registryBytes, parent);
    if (
      registry.entries.length !== reference.entryCount ||
      registry.header.checkpointRevision !== revision
    )
      throw new ChatDeltaJournalIntegrityError(
        'Publishing registry revision/count mismatch',
      );
    for (const entry of registry.entries) {
      const item = streamRegistryPaths(root, parent, entry.streamKey);
      const descriptor = parseStreamDescriptor(
        await selected(
          item.descriptor,
          metadata.descriptors.find(
            (candidate) => candidate.path === item.descriptor,
          )?.sha256,
        ),
      );
      const body = await readFile(item.log);
      if (
        descriptor.streamKey !== entry.streamKey ||
        descriptor.checkpointRevision !== revision ||
        transcriptTargetKey(descriptor.target) !==
          transcriptTargetKey(entry.target) ||
        descriptor.committedByteLength !== body.length ||
        descriptor.committedSha256 !== digest(body)
      )
        throw new ChatDeltaJournalIntegrityError(
          'Publishing descriptor/log mismatch',
        );
      entries.push({ entry, descriptor });
    }
  }
  return entries;
}

async function listOptional(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function copyOptional(source: string, target: string): Promise<void> {
  try {
    await copyFile(source, target);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return;
    throw error;
  }
}

/** Tool outputs are immutable once published, so a hard link is a copy. */
async function linkOrCopy(source: string, target: string): Promise<void> {
  try {
    await link(source, target);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return;
    await copyOptional(source, target);
  }
}

async function copyDirectory(
  source: string,
  target: string,
  copy: (from: string, to: string) => Promise<void>,
): Promise<void> {
  const names = await listOptional(source);
  if (names.length === 0) return;
  await mkdir(target, { recursive: true });
  for (const name of names) await copy(join(source, name), join(target, name));
}

/** Copy every file one chat owns into a scratch transcripts directory. */
async function copyChatFiles(
  source: string,
  target: string,
  chatId: string,
  rootNames: readonly string[],
): Promise<void> {
  const prefix = `${chatId}.`;
  for (const name of rootNames)
    if (
      name.startsWith(prefix) &&
      (['jsonl', 'index.json', 'turns.json', 'active.json'].some(
        (extension) => name === `${prefix}${extension}`,
      ) ||
        name.endsWith('.append.tmp'))
    )
      await copyOptional(join(source, name), join(target, name));
  await copyDirectory(
    join(source, 'message-index', chatId),
    join(target, 'message-index', chatId),
    copyOptional,
  );
  for (const directory of storedArtifactDirectories())
    await copyDirectory(
      join(source, directory, chatId),
      join(target, directory, chatId),
      linkOrCopy,
    );
}

/** A child sidecar whose header still names a checkpoint's staged append. */
async function hasChildAppendIntent(streamDirectory: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(
      join(streamDirectory, 'transcript.active.json'),
      'utf8',
    );
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return false;
    throw error;
  }
  const header: unknown = JSON.parse(text.split('\n', 1)[0]);
  return isRecord(header) && header.finalizing !== undefined;
}

/** Child files change only under a checkpoint marker, so this names their version. */
function checkpointGeneration(
  marker: DeltaCheckpointMarker | undefined,
  catalogRevision: number,
): string {
  return marker
    ? `${marker.phase}:${marker.fromRevision}:${marker.targetRevision}`
    : `checkpoint:${catalogRevision}`;
}

/**
 * Acquire registry/descriptor reads for journal-replay OR checkpoint-only format
 * 4 scopes, including scopes with no selected journal. Never promotes, writes,
 * implicitly checkpoints or acquires a writer. Accessors live until dispose().
 * S2 implements this opener; S3 uses it for no-writer/no-journal fallback.
 */
function registryFailure(
  code: 'unsupported_format' | 'not_found' | 'corruption' | 'invalid_request',
  message: string,
): never {
  throw new DelegationRegistryOperationError({
    code,
    message,
    retryable: false,
  });
}

function scopedRegistryReader(
  root: string,
  chats: ReadonlySet<string>,
  enabled: boolean,
  readDescriptor: (
    target: DelegationTranscriptTarget,
  ) => Promise<TranscriptStreamDescriptor | undefined>,
  records: readonly JournalCommit[] = [],
  artifacts = new ChatTranscriptArtifacts(root, true),
): DelegationRegistryCheckpointReader {
  const store = new DelegationRegistryStore(root, {
    pendingEffects: async function* (
      chatId,
    ): AsyncGenerator<DelegationRegistryJournalEffect> {
      for (const record of records) {
        if (record.v !== 2) continue;
        for (const effect of record.registryEffects ?? []) {
          const owner = registryEffectIdentity(effect).chatId;
          if (owner === chatId) yield await Promise.resolve(effect);
        }
      }
    },
  });
  const assertChat = (chatId: string): void => {
    if (!enabled)
      registryFailure(
        'unsupported_format',
        'Delegation registry requires format 4',
      );
    if (!chats.has(chatId))
      registryFailure('not_found', 'The owning chat was not found');
  };
  const reader = createDelegationRegistryReader({
    store,
    readDescriptor,
    readAnswerRange: async (input, signal) => {
      signal?.throwIfAborted();
      const entry = await store.result({
        chatId: input.chatId,
        delegationId: input.delegationId,
        resultIndex: input.resultIndex,
      });
      if (!entry) registryFailure('not_found', 'The result was not found');
      const answer = entry.answer;
      if (answer.kind !== 'body')
        registryFailure('not_found', 'The result has no answer body');
      if (
        !Number.isSafeInteger(input.offset) ||
        input.offset < 0 ||
        input.offset > answer.byteLength ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 4 ||
        input.limit > 65_536
      )
        registryFailure('invalid_request', 'The answer range is invalid');
      try {
        await artifacts.verify(input.chatId, answer.ref, signal);
      } catch (error) {
        signal?.throwIfAborted();
        if (isErrnoException(error) && error.code !== 'ENOENT') throw error;
        registryFailure(
          'corruption',
          'The known result answer is missing or damaged',
        );
      }
      try {
        const range = await artifacts.readRange(
          input.chatId,
          answer.ref,
          input.offset,
          input.limit,
          signal,
        );
        return { ...range, encoding: answer.encoding };
      } catch (error) {
        signal?.throwIfAborted();
        if (isErrnoException(error)) {
          if (error.code === 'ENOENT')
            registryFailure('corruption', 'The known result answer is missing');
          throw error;
        }
        if (
          error instanceof Error &&
          error.message.startsWith('Tool output offset splits')
        )
          registryFailure(
            'invalid_request',
            'The answer offset splits a character',
          );
        registryFailure('corruption', 'The known result answer is damaged');
      }
    },
  });
  return {
    result: (
      input,
    ): ReturnType<DelegationRegistryCheckpointReader['result']> => {
      assertChat(input.chatId);
      return reader.result(input);
    },
    resultBySettlementKey: (
      input,
    ): ReturnType<
      DelegationRegistryCheckpointReader['resultBySettlementKey']
    > => {
      assertChat(input.chatId);
      return reader.resultBySettlementKey(input);
    },
    resultByGeneration: (
      input,
    ): ReturnType<DelegationRegistryCheckpointReader['resultByGeneration']> => {
      assertChat(input.chatId);
      return reader.resultByGeneration(input);
    },
    generation: (
      input,
    ): ReturnType<DelegationRegistryCheckpointReader['generation']> => {
      assertChat(input.chatId);
      return reader.generation(input);
    },
    resultsPage: (
      input,
      context,
    ): ReturnType<DelegationRegistryCheckpointReader['resultsPage']> => {
      assertChat(input.chatId);
      return reader.resultsPage(input, context);
    },
    generationsPage: (
      input,
      context,
    ): ReturnType<DelegationRegistryCheckpointReader['generationsPage']> => {
      assertChat(input.chatId);
      return reader.generationsPage(input, context);
    },
    resultAnswerRange: (
      input,
      signal,
    ): ReturnType<DelegationRegistryCheckpointReader['resultAnswerRange']> => {
      assertChat(input.chatId);
      return reader.resultAnswerRange(input, signal);
    },
    receipt: (
      input,
    ): ReturnType<DelegationRegistryCheckpointReader['receipt']> => {
      assertChat(input.chatId);
      return reader.receipt(input);
    },
    itemAdmission: (
      input,
    ): ReturnType<DelegationRegistryCheckpointReader['itemAdmission']> => {
      assertChat(input.target.chatId);
      return reader.itemAdmission(input);
    },
    highWater: (
      input,
    ): ReturnType<DelegationRegistryCheckpointReader['highWater']> => {
      assertChat(input.chatId);
      return reader.highWater(input);
    },
    answerReferences: (
      chatId,
    ): ReturnType<DelegationRegistryCheckpointReader['answerReferences']> => {
      assertChat(chatId);
      return reader.answerReferences(chatId);
    },
  };
}

export async function openDelegationRegistryReadView(
  scope: Parameters<typeof openReplayedChatScope>[0],
  assertIndexes: AssertChatStorageIndexes,
  options: ReplayedChatScopeOptions = {},
  /** A caller's long-lived verifier keeps answer hashes across views. */
  artifacts?: ChatTranscriptArtifacts,
): Promise<DelegationRegistryReadView> {
  const manifest: unknown = JSON.parse(
    (await readFile(scopeManifestPath(scope))).toString('utf8'),
  );
  assertNoNewerChatStorageManifest(
    manifest,
    scope.scopeId,
    options.maxManifestVersion ?? 4,
  );
  const selected = parseChatStorageManifest(manifest);
  if (selected.version !== 4)
    registryFailure(
      'unsupported_format',
      'Delegation registry requires format 4',
    );
  if (journalFileFor(manifest)) {
    const replay = await openReplayedChatScope(scope, assertIndexes, options);
    return {
      registry: replay,
      descriptor: (target) => replay.descriptor(target),
      dispose: () => replay.dispose(),
    };
  }
  const checkpoint = await readCheckpointState(scope.directory, assertIndexes);
  const root = join(scope.directory, 'transcripts');
  const catalog = await loadStreamCatalog(root);
  await validateStreamClosure(root, catalog, { readOnly: true, deep: false });
  const chats = new Set([
    ...checkpoint.indexes.live.tabs.map((tab) => tab.id),
    ...checkpoint.indexes.archive.archived.map((entry) => entry.tab.id),
  ]);
  const descriptor = async (
    target: DelegationTranscriptTarget,
  ): Promise<TranscriptStreamDescriptor | undefined> => {
    if (!chats.has(target.chatId)) return undefined;
    try {
      return await validateStreamTarget(root, catalog, target, {
        readOnly: true,
        deep: false,
      });
    } catch (error) {
      if (error instanceof UnknownTranscriptStreamError) return undefined;
      throw error;
    }
  };
  return {
    registry: scopedRegistryReader(
      root,
      chats,
      true,
      descriptor,
      [],
      artifacts,
    ),
    descriptor,
    dispose: () => Promise.resolve(),
  };
}

/**
 * Open a consistent read-only view of a delta-journal scope. The caller
 * disposes it. Integrity failures (a broken chain, a missing artifact, a
 * record that does not apply) reject; a torn tail is reported, not applied.
 */
export async function openReplayedChatScope(
  scope: { directory: string; scopeId: string },
  assertIndexes: AssertChatStorageIndexes,
  options: ReplayedChatScopeOptions = {},
  attempt = 0,
): Promise<ReplayedChatScope> {
  const manifestBytes = await readFile(scopeManifestPath(scope));
  const manifest: unknown = JSON.parse(manifestBytes.toString('utf8'));
  assertNoNewerChatStorageManifest(
    manifest,
    scope.scopeId,
    options.maxManifestVersion ?? 4,
  );
  if (!journalFileFor(manifest))
    throw new Error('Scope has no selected delta journal');
  let journal: Awaited<ReturnType<typeof readDeltaJournal>>;
  let checkpoint: Awaited<ReturnType<typeof readCheckpointState>>;
  try {
    journal = await readDeltaJournal(scope.directory, scope.scopeId, manifest);
    checkpoint = await readCheckpointState(scope.directory, assertIndexes);
    assertJournalCovers(journal, checkpoint);
  } catch (error) {
    const current = await readFile(scopeManifestPath(scope));
    if (attempt < 3 && !current.equals(manifestBytes))
      return openReplayedChatScope(scope, assertIndexes, options, attempt + 1);
    throw error;
  }
  const canonicalRoot = join(scope.directory, 'transcripts');
  const metadataRecords = recordsAfter(journal, checkpoint.revision);
  const selected = parseChatStorageManifest(manifest);
  const streamRegistrations: TranscriptStreamRegistration[] = [];
  // Before publication, a checkpoint may already have written child logs and sidecars.
  const checkpointInProgress = checkpoint.marker?.phase === 'transcripts';
  // Staged descriptors the publishing marker selects; the canonical catalog may still be older.
  let publishingDescriptors:
    | Map<string, TranscriptStreamDescriptor>
    | undefined;
  if (selected.version === 4) {
    if (checkpoint.marker?.phase === 'publishing') {
      const published = await publishingStreamRegistrations(
        join(scope.directory, 'transcripts'),
        checkpoint.revision,
        checkpoint.marker,
      );
      streamRegistrations.push(...published.map((item) => item.entry));
      publishingDescriptors = new Map(
        published.map((item) => [
          transcriptTargetKey(item.entry.target),
          item.descriptor,
        ]),
      );
    } else {
      const root = join(scope.directory, 'transcripts');
      const catalog = await loadStreamCatalog(root);
      // A concurrent checkpoint or journal re-entry; the caller retries.
      if (catalog.checkpointRevision !== checkpoint.revision)
        throw new ChatDeltaJournalIntegrityError(
          'Stream catalog revision does not match checkpoint',
        );
      try {
        await validateStreamClosure(root, catalog, {
          readOnly: true,
          deep: false,
          logMayExtend: checkpointInProgress,
        });
      } catch (error) {
        // A checkpoint that started after the state was read may have
        // extended a child log; reopen against its marker.
        if (
          error instanceof ChatDeltaJournalIntegrityError &&
          attempt < 3 &&
          JSON.stringify(await readCheckpointMarker(scope.directory)) !==
            JSON.stringify(checkpoint.marker)
        )
          return openReplayedChatScope(
            scope,
            assertIndexes,
            options,
            attempt + 1,
          );
        throw error;
      }
      for (const parent of Object.keys(catalog.parents))
        streamRegistrations.push(
          ...(await loadStreamRegistry(root, parent, { readOnly: true }))
            .entries,
        );
    }
    for (const record of metadataRecords)
      if (record.v === 2)
        streamRegistrations.push(...record.streamRegistrations);
    const identities = new Set(
      streamRegistrations.map((entry) => transcriptTargetKey(entry.target)),
    );
    if (identities.size !== streamRegistrations.length)
      throw new ChatDeltaJournalIntegrityError(
        'Duplicate checkpointed/pending stream registration',
      );
  }
  const transcriptRecords = recordsAfter(
    journal,
    checkpoint.transcriptProgress,
  );
  const transcriptMarker =
    checkpoint.marker?.phase === 'transcripts' ? checkpoint.marker : undefined;
  await verifyRecordArtifacts(canonicalRoot, transcriptRecords);
  const metadata = replayIndexMetadata(
    checkpoint.indexes,
    metadataRecords,
    assertIndexes,
  );
  const materialized = new Set(
    transcriptRecords.flatMap((record) =>
      primaryEffects(record).map((effect) => effect.chatId),
    ),
  );
  const canonical = new ChatTranscriptLog(canonicalRoot, undefined, {
    readOnly: true,
  });
  let scratch: string | undefined;
  try {
    let scratchLog: ChatTranscriptLog | undefined;
    if (materialized.size) {
      scratch = await mkdtemp(
        join(options.scratchRoot ?? tmpdir(), 'chat-delta-replay-'),
      );
      const scratchRoot = join(scratch, 'transcripts');
      await mkdir(scratchRoot, { recursive: true });
      const rootNames = await listOptional(canonicalRoot);
      for (const chatId of Array.from(materialized))
        await copyChatFiles(canonicalRoot, scratchRoot, chatId, rootNames);
      const writable = new ChatTranscriptLog(scratchRoot);
      for (const record of transcriptRecords)
        await applyRecordTranscripts(
          writable,
          scratchRoot,
          record,
          join(scratch, `work-${randomUUID()}`),
          // A reader never publishes: format 4 rows were prepared by their writer.
          selected.version === 4 ? 'format4-verify' : 'legacy',
          transcriptMarker
            ? async (
                captureRecord,
                effect,
                effectIndex,
              ): Promise<ReadonlyMap<string, ActiveRowAnchor> | undefined> =>
                readCheckpointAnchorCapture(
                  join(scope.directory, DELTA_CHECKPOINT_WORK_DIRECTORY),
                  {
                    checkpointFromRevision: transcriptMarker.fromRevision,
                    checkpointTargetRevision: transcriptMarker.targetRevision,
                    record: captureRecord,
                    effectIndex,
                    effect,
                  },
                )
            : undefined,
        );
      scratchLog = new ChatTranscriptLog(scratchRoot, undefined, {
        readOnly: true,
      });
    }
    const descriptors = new Map<string, TranscriptDescriptor>();
    for (const chatId of Array.from(metadata.touched))
      descriptors.set(
        chatId,
        await (
          materialized.has(chatId) && scratchLog ? scratchLog : canonical
        ).descriptor(chatId),
      );
    const indexes = withTranscriptDescriptors(
      metadata.indexes,
      descriptors,
      metadata.turnCountFromDescriptor,
    );
    assertIndexes(indexes);
    const chats = new Set([
      ...indexes.live.tabs.map((tab) => tab.id),
      ...indexes.archive.archived.map((entry) => entry.tab.id),
    ]);
    const scratchDirectory = scratch;
    const readDescriptor = async (
      target: DelegationTranscriptTarget,
    ): Promise<TranscriptStreamDescriptor | undefined> => {
      if (!chats.has(target.chatId)) return undefined;
      const key = transcriptTargetKey(target);
      const registration = streamRegistrations.find(
        (entry) => transcriptTargetKey(entry.target) === key,
      );
      if (!registration) return undefined;
      const pending = metadataRecords.some(
        (record) =>
          record.v === 2 &&
          record.streamRegistrations.some(
            (entry) => transcriptTargetKey(entry.target) === key,
          ),
      );
      let descriptor =
        publishingDescriptors?.get(key) ??
        (pending
          ? createEmptyStreamDescriptor(registration, checkpoint.revision)
          : parseStreamDescriptor(
              await readFile(
                streamRegistryPaths(
                  canonicalRoot,
                  target.chatId,
                  registration.streamKey,
                ).descriptor,
              ),
            ));
      for (const record of metadataRecords) {
        if (record.v !== 2) continue;
        for (const update of record.descriptorUpdates) {
          if (transcriptTargetKey(update.target) !== key) continue;
          descriptor = applyStreamDescriptorUpdate(descriptor, update);
        }
      }
      return descriptor;
    };
    const registry = scopedRegistryReader(
      canonicalRoot,
      chats,
      selected.version === 4,
      readDescriptor,
      metadataRecords,
    );
    const view: ReplayedChatScope = {
      ...registry,
      descriptor: readDescriptor,
      revision: indexes.live.revision,
      indexes,
      recordCount: metadataRecords.length,
      journalBytes: journal.fileBytes,
      streamRegistrations,
      ...(journal.tornTail ? { tornTail: journal.tornTail } : {}),
      transcript: (chatId: string): ChatTranscriptLog => {
        if (!chats.has(chatId)) throw new Error(`Unknown chat: ${chatId}`);
        return materialized.has(chatId) && scratchLog ? scratchLog : canonical;
      },
      stream: async (target, pageOptions = {}) => {
        if (selected.version !== 4) throw new Error('Unknown child stream');
        const identity = transcriptTargetKey(target);
        const registration = streamRegistrations.find(
          (entry) => transcriptTargetKey(entry.target) === identity,
        );
        // A parent deleted since the checkpoint takes its child streams with it.
        if (!registration || !chats.has(target.chatId))
          throw new Error('Unknown child stream');
        const checkpointed = !metadataRecords.some(
          (record) =>
            record.v === 2 &&
            record.streamRegistrations.some(
              (entry) => transcriptTargetKey(entry.target) === identity,
            ),
        );
        let committedCount = 0;
        const key = delegationStreamKey(target);
        let retrying = false;
        const retry = async (
          exhausted: Error,
        ): Promise<Awaited<ReturnType<ReplayedChatScope['stream']>>> => {
          retrying = true;
          if (attempt >= 3) throw exhausted;
          const retried = await openReplayedChatScope(
            scope,
            assertIndexes,
            options,
            attempt + 1,
          );
          try {
            return await retried.stream(target, pageOptions);
          } finally {
            await retried.dispose();
          }
        };
        const openGeneration = checkpointGeneration(
          checkpoint.marker,
          checkpoint.revision,
        );
        const currentGeneration = async (): Promise<string> => {
          const marker = await readCheckpointMarker(scope.directory);
          return checkpointGeneration(
            marker,
            marker
              ? 0
              : (await loadStreamCatalog(canonicalRoot)).checkpointRevision,
          );
        };
        const advanced = new ChatDeltaJournalIntegrityError(
          'Checkpoint advanced past this view',
        );
        // Check before and after reading: a checkpoint may start or finish meanwhile.
        if ((await currentGeneration()) !== openGeneration)
          return retry(advanced);
        const { streamDirectory, log: childLog } = streamRegistryPaths(
          canonicalRoot,
          target.chatId,
          key,
        );
        // A resumed checkpoint can append finals without changing its generation.
        const childLogBytes = async (): Promise<number> => {
          try {
            return (await stat(childLog)).size;
          } catch (error) {
            if (isErrnoException(error) && error.code === 'ENOENT') return -1;
            throw error;
          }
        };
        const startBytes = await childLogBytes();
        let childScratch: string | undefined;
        try {
          if (checkpointed && (await hasChildAppendIntent(streamDirectory))) {
            // Only a checkpoint writes the intent; this view predates it.
            if (!checkpointInProgress)
              return retry(
                new ChatDeltaJournalIntegrityError(
                  'Child append intent outside a checkpoint',
                ),
              );
            // Recovery needs a writable store, so finish the append on a copy.
            childScratch = await mkdtemp(
              join(options.scratchRoot ?? tmpdir(), 'chat-child-replay-'),
            );
            const copy = streamRegistryPaths(
              join(childScratch, 'transcripts'),
              target.chatId,
              key,
            ).streamDirectory;
            await mkdir(copy, { recursive: true });
            for (const entry of await readdir(streamDirectory, {
              withFileTypes: true,
            }))
              if (entry.isFile())
                await copyOptional(
                  join(streamDirectory, entry.name),
                  join(copy, entry.name),
                );
          }
          const child = new TranscriptStreamStore(
            delegationTranscriptPaths(
              childScratch ? join(childScratch, 'transcripts') : canonicalRoot,
              target,
            ),
            new ChatTranscriptArtifacts(canonicalRoot, true),
            () => Promise.resolve(),
            { childMode: true, readOnly: childScratch === undefined },
          );
          const checkpointedOpen: DelegationChildRow[] = [];
          if (checkpointed) {
            let descriptor = publishingDescriptors?.get(identity);
            if (!descriptor) {
              const catalog = await loadStreamCatalog(canonicalRoot);
              if (catalog.checkpointRevision !== checkpoint.revision)
                return retry(
                  new ChatDeltaJournalIntegrityError(
                    'Child catalog changed during read',
                  ),
                );
              try {
                descriptor = await validateStreamTarget(
                  canonicalRoot,
                  catalog,
                  target,
                  {
                    readOnly: true,
                    deep: !checkpointInProgress,
                    logMayExtend: checkpointInProgress,
                  },
                );
              } catch (error) {
                // A checkpoint that began after this view opened may have extended the log.
                if (
                  checkpointInProgress ||
                  !(error instanceof ChatDeltaJournalIntegrityError)
                )
                  throw error;
                return retry(error);
              }
            }
            committedCount = checkpointInProgress
              ? (await child.descriptor(key)).committedMessageCount
              : descriptor.committedRowCount;
            for (const row of await child.activeMessages(key)) {
              if (!isDelegationChildRow(row))
                throw new ChatDeltaJournalIntegrityError(
                  'Invalid child active row',
                );
              checkpointedOpen.push(row);
            }
          }
          const overlay = new ChildJournalOverlay(
            target,
            checkpointed
              ? (id: string): Promise<DelegationChildRow | undefined> =>
                  child.childStreamRowById(key, id)
              : (): Promise<DelegationChildRow | undefined> =>
                  Promise.resolve(undefined),
            checkpointedOpen,
          );
          for (const record of metadataRecords)
            if (record.v === 2)
              for (const effect of record.transcripts)
                if (
                  (effect.kind === 'child-upsert' ||
                    effect.kind === 'child-settle') &&
                  transcriptTargetKey(effect.target) === identity
                )
                  await overlay.apply(effect.rows, checkpointInProgress);
          const page = await readMergedChildStreamPage(
            committedCount,
            overlay.pendingRows,
            (pageRequest) => child.readChildStreamPage(key, pageRequest),
            pageOptions,
          );
          if (
            (await currentGeneration()) !== openGeneration ||
            (await childLogBytes()) !== startBytes
          )
            return retry(advanced);
          return page;
        } catch (error) {
          // A checkpoint may start, finish or publish an append intent mid-read.
          if (
            !retrying &&
            ((await currentGeneration()) !== openGeneration ||
              (checkpointed &&
                childScratch === undefined &&
                (await hasChildAppendIntent(streamDirectory))))
          )
            return retry(
              error instanceof Error ? error : new Error(String(error)),
            );
          throw error;
        } finally {
          if (childScratch)
            await rm(childScratch, { recursive: true, force: true });
        }
      },
      dispose: async (): Promise<void> => {
        if (scratchDirectory)
          await rm(scratchDirectory, { recursive: true, force: true });
      },
    };
    const current = await readFile(scopeManifestPath(scope));
    if (!current.equals(manifestBytes)) {
      await view.dispose();
      if (attempt >= 3)
        throw new Error('Chat journal authority changed during read');
      return openReplayedChatScope(scope, assertIndexes, options, attempt + 1);
    }
    return view;
  } catch (error) {
    if (scratch) await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}

/** The committed indexes of a delta-journal scope, read-only. */
export async function readReplayedChatIndexes(
  scope: { directory: string; scopeId: string },
  assertIndexes: AssertChatStorageIndexes,
  options: ReplayedChatScopeOptions = {},
): Promise<ChatStorageIndexes> {
  const view = await openReplayedChatScope(scope, assertIndexes, options);
  try {
    return view.indexes;
  } finally {
    await view.dispose();
  }
}

export interface DeltaJournalSummary {
  /** Size of the journal file. */
  journalBytes: number;
  /** End of its verified prefix. */
  validEnd: number;
  /** Verified commit records in the current segment. */
  recordCount: number;
  tornTail?: DeltaJournalTornTail;
}

/**
 * Size and integrity facts about a scope's journal, for content-free
 * diagnostics. Reads and verifies the journal only; never the transcripts.
 */
export async function summarizeDeltaJournal(scope: {
  directory: string;
  scopeId: string;
  maxManifestVersion?: 3 | 4;
}): Promise<DeltaJournalSummary> {
  const manifest: unknown = JSON.parse(
    await readFile(scopeManifestPath(scope), 'utf8'),
  );
  assertNoNewerChatStorageManifest(
    manifest,
    scope.scopeId,
    scope.maxManifestVersion ?? 4,
  );
  // A scope that selects no journal summarizes any leftover version 1 file.
  const journal = await readDeltaJournal(
    scope.directory,
    scope.scopeId,
    journalFileFor(manifest) ? manifest : undefined,
  );
  return {
    journalBytes: journal.fileBytes,
    validEnd: journal.validEnd,
    recordCount: journal.records.length,
    ...(journal.tornTail ? { tornTail: journal.tornTail } : {}),
  };
}
