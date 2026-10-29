/**
 * Applies journal records to transcript files through `ChatTranscriptLog`,
 * the same operations a version 2 scope transaction performs, so a
 * checkpoint writes the bytes the version 2 path would have written.
 *
 * Used in place by the checkpoint writer and on a private scratch copy by the
 * read-only replay helper.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { TranscriptDescriptor } from '@canopy/agent-transcript/transcript-storage';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import type { ChatStorageIndexes } from '../chat-storage-transactions';
import {
  readCompleteTranscriptMessages,
  type ChatTranscriptLog,
} from '../chat-transcript-log';
import { writeJsonValuesCooperatively } from '../cooperative-json';
import { isErrnoException } from '../type-guards';
import {
  ChatDeltaJournalIntegrityError,
  type DeltaJournalCommitRecord,
  type DeltaJournalPatchEffect,
  type DeltaJournalTranscriptEffect,
} from './format';
import { upsertActiveMessages } from './transcript-overlay';

/** The rewrite revision a version 2 transaction assigns a replaced log. */
function rewriteRevision(toRevision: number, prior: number): number {
  return Math.max(toRevision, prior + 1);
}

async function ensureTranscript(
  log: ChatTranscriptLog,
  transcriptsRoot: string,
  effect: Exclude<DeltaJournalTranscriptEffect, { kind: 'delete' }>,
): Promise<void> {
  try {
    await stat(join(transcriptsRoot, `${effect.chatId}.jsonl`));
  } catch (error) {
    const create = effect.kind === 'patch' ? false : effect.create;
    if (!(isErrnoException(error) && error.code === 'ENOENT')) throw error;
    if (!create)
      throw new ChatDeltaJournalIntegrityError(
        `Transcript ${effect.chatId} is missing`,
        { cause: error },
      );
    await log.initialize(effect.chatId);
  }
}

async function replaceWithSuffix(
  log: ChatTranscriptLog,
  chatId: string,
  committed:
    | Iterable<PersistedChatMessage>
    | AsyncIterable<PersistedChatMessage>,
  mutable: readonly PersistedChatMessage[],
  revision: number,
): Promise<void> {
  await log.replace(chatId, committed, revision);
  if (mutable.length) await log.writeActive(chatId, mutable);
}

async function applyPatch(
  log: ChatTranscriptLog,
  effect: DeltaJournalPatchEffect,
  toRevision: number,
  workDirectory: string,
): Promise<void> {
  const tailIds = new Set(effect.tail.map((message) => message.id));
  const dropped = new Set([
    ...effect.removedMessageIds,
    ...Array.from(tailIds),
  ]);
  const replacements = new Map(
    effect.patches.map((message) => [message.id, message]),
  );
  await mkdir(workDirectory, { recursive: true });
  // Stage the surviving rows first: the replacement must not read the log it
  // is rewriting, and a long history must not be held in memory.
  const staged = join(workDirectory, `${effect.chatId}.${randomUUID()}.jsonl`);
  try {
    await writeJsonValuesCooperatively(
      staged,
      (async function* (): AsyncGenerator<PersistedChatMessage> {
        for await (const row of log.iterate(effect.chatId))
          if (!dropped.has(row.id)) yield replacements.get(row.id) ?? row;
      })(),
      { pretty: false, separator: '\n', trailingSeparator: true },
    );
    const split = effect.tail.length - effect.activeTailCount;
    const tail = effect.tail;
    await replaceWithSuffix(
      log,
      effect.chatId,
      (async function* (): AsyncGenerator<PersistedChatMessage> {
        yield* readCompleteTranscriptMessages(staged);
        yield* tail.slice(0, split);
      })(),
      tail.slice(split),
      rewriteRevision(toRevision, effect.priorTranscriptRevision),
    );
  } finally {
    await rm(staged, { force: true });
  }
}

/** Apply one effect through the log, as a version 2 transaction would. */
export async function applyTranscriptEffect(
  log: ChatTranscriptLog,
  transcriptsRoot: string,
  effect: DeltaJournalTranscriptEffect,
  toRevision: number,
  workDirectory: string,
): Promise<void> {
  if (effect.kind === 'delete') {
    await log.remove(effect.chatId);
    return;
  }
  await ensureTranscript(log, transcriptsRoot, effect);
  switch (effect.kind) {
    case 'append':
      return log.append(effect.chatId, effect.messages);
    case 'active':
      return log.writeActive(effect.chatId, effect.messages);
    case 'active-replace':
      return log.replaceActive(effect.chatId, effect.messages);
    case 'active-upsert':
      return log.writeActive(
        effect.chatId,
        upsertActiveMessages(
          await log.activeMessages(effect.chatId),
          effect.messages,
        ),
      );
    case 'replace': {
      const split = effect.messages.length - effect.activeTailCount;
      const rows = effect.messages;
      return replaceWithSuffix(
        log,
        effect.chatId,
        rows.slice(0, split),
        rows.slice(split),
        rewriteRevision(toRevision, effect.priorTranscriptRevision),
      );
    }
    case 'patch':
      return applyPatch(log, effect, toRevision, workDirectory);
  }
}

/**
 * Apply one record's transcript effects in order. Re-applying a record over
 * a partial application of the same record converges, as recovery of a
 * version 2 transaction does; records are therefore applied strictly in
 * order and progress is recorded per record.
 */
export async function applyRecordTranscripts(
  log: ChatTranscriptLog,
  transcriptsRoot: string,
  record: DeltaJournalCommitRecord,
  workDirectory: string,
): Promise<void> {
  for (const effect of record.transcripts)
    await applyTranscriptEffect(
      log,
      transcriptsRoot,
      effect,
      record.toRevision,
      workDirectory,
    );
}

/**
 * Set each touched chat's descriptor from its transcript files, as a version
 * 2 transaction does after writing them. `turnCountFromDescriptor` names the
 * archived chats whose turn count was last set by a transcript write.
 */
export function withTranscriptDescriptors(
  indexes: ChatStorageIndexes,
  descriptors: ReadonlyMap<string, TranscriptDescriptor>,
  turnCountFromDescriptor: ReadonlySet<string>,
): ChatStorageIndexes {
  if (descriptors.size === 0) return indexes;
  return {
    ...indexes,
    live: {
      ...indexes.live,
      tabs: indexes.live.tabs.map((tab) => {
        const descriptor = descriptors.get(tab.id);
        return descriptor ? { ...tab, transcript: descriptor } : tab;
      }),
    },
    archive: {
      ...indexes.archive,
      archived: indexes.archive.archived.map((entry) => {
        const descriptor = descriptors.get(entry.tab.id);
        if (!descriptor) return entry;
        return {
          ...entry,
          tab: { ...entry.tab, transcript: descriptor },
          ...(turnCountFromDescriptor.has(entry.tab.id) &&
          descriptor.userMessageCount !== undefined
            ? { turnCount: descriptor.userMessageCount }
            : {}),
        };
      }),
    },
  };
}
