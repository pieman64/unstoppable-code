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
import { randomUUID } from 'node:crypto';
import { copyFile, link, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptDescriptor } from '@canopy/agent-transcript/transcript-storage';
import type { ChatStorageIndexes } from '../chat-storage-transactions';
import { storedArtifactDirectories } from '../chat-artifact-references';
import { ChatTranscriptLog } from '../chat-transcript-log';
import { isErrnoException } from '../type-guards';
import type { DeltaJournalTornTail } from './format';
import {
  applyRecordTranscripts,
  withTranscriptDescriptors,
} from './materialize';
import {
  assertJournalCovers,
  readCheckpointState,
  readDeltaJournal,
  recordsAfter,
  replayIndexMetadata,
  verifyRecordArtifacts,
  type AssertChatStorageIndexes,
} from './replay';

export interface ReplayedChatScopeOptions {
  /**
   * Parent of the private scratch directory used for chats changed since
   * the checkpoint. Defaults to the operating system's per-user temporary
   * directory. Prefer one on the same volume as the scope, so tool outputs
   * are linked rather than copied.
   */
  scratchRoot?: string;
}

export interface ReplayedChatScope {
  /** Revision of the last journal record (or the checkpoint). */
  readonly revision: number;
  /** The indexes a checkpoint at `revision` would write, byte for byte. */
  readonly indexes: ChatStorageIndexes;
  /** Records after the checkpoint that this view replayed. */
  readonly recordCount: number;
  readonly journalBytes: number;
  /** An unacknowledged partial append that was ignored. */
  readonly tornTail?: DeltaJournalTornTail;
  /** A read-only log holding this chat's committed and active rows. */
  transcript(chatId: string): ChatTranscriptLog;
  /** Remove the scratch copy. Logs returned earlier stop working. */
  dispose(): Promise<void>;
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

/**
 * Open a consistent read-only view of a delta-journal scope. The caller
 * disposes it. Integrity failures (a broken chain, a missing artifact, a
 * record that does not apply) reject; a torn tail is reported, not applied.
 */
export async function openReplayedChatScope(
  scope: { directory: string; scopeId: string },
  assertIndexes: AssertChatStorageIndexes,
  options: ReplayedChatScopeOptions = {},
): Promise<ReplayedChatScope> {
  const journal = await readDeltaJournal(scope.directory, scope.scopeId);
  const checkpoint = await readCheckpointState(scope.directory, assertIndexes);
  assertJournalCovers(journal, checkpoint);
  const canonicalRoot = join(scope.directory, 'transcripts');
  const metadataRecords = recordsAfter(journal, checkpoint.revision);
  const transcriptRecords = recordsAfter(
    journal,
    checkpoint.transcriptProgress,
  );
  await verifyRecordArtifacts(canonicalRoot, transcriptRecords);
  const metadata = replayIndexMetadata(
    checkpoint.indexes,
    metadataRecords,
    assertIndexes,
  );
  const materialized = new Set(
    transcriptRecords.flatMap((record) =>
      record.transcripts.map((effect) => effect.chatId),
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
    const view: ReplayedChatScope = {
      revision: indexes.live.revision,
      indexes,
      recordCount: metadataRecords.length,
      journalBytes: journal.fileBytes,
      ...(journal.tornTail ? { tornTail: journal.tornTail } : {}),
      transcript: (chatId: string): ChatTranscriptLog => {
        if (!chats.has(chatId)) throw new Error(`Unknown chat: ${chatId}`);
        return materialized.has(chatId) && scratchLog ? scratchLog : canonical;
      },
      dispose: async (): Promise<void> => {
        if (scratchDirectory)
          await rm(scratchDirectory, { recursive: true, force: true });
      },
    };
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
}): Promise<DeltaJournalSummary> {
  const journal = await readDeltaJournal(scope.directory, scope.scopeId);
  return {
    journalBytes: journal.fileBytes,
    validEnd: journal.validEnd,
    recordCount: journal.records.length,
    ...(journal.tornTail ? { tornTail: journal.tornTail } : {}),
  };
}
