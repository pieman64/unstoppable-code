/**
 * Read-only recovery of a delta-journal scope: the last checkpoint, the
 * verified journal records after it, and the index metadata those records
 * produce. Nothing here writes; the checkpoint writer and the read-only
 * replay helper both start from this plan.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PersistedChatMessage } from '@canopy/agent-transcript/types';
import type { ChatStorageIndexes } from '../chat-storage-transactions';
import { storedArtifactRefsOf } from '../chat-artifact-references';
import { ChatTranscriptArtifacts } from '../chat-transcript-artifacts';
import { isErrnoException, isRecord } from '../type-guards';
import {
  ChatDeltaJournalIntegrityError,
  DELTA_CHECKPOINT_MARKER_NAME,
  DELTA_CHECKPOINT_STAGED_SUFFIX,
  DELTA_JOURNAL_FILE_NAME,
  decodeDeltaJournalRecord,
  decodeDeltaJournalV2Record,
  journalFileFor,
  transcriptTargetKey,
  effectRowsWithFinality,
  scanDeltaJournalFrames,
  type DeltaJournalCommitRecord,
  type DeltaJournalSegmentRecord,
  type DeltaJournalTornTail,
  type DeltaJournalV2CommitRecord,
  type DeltaJournalV2SegmentRecord,
  type DeltaJournalTranscriptEffect,
} from './format';
import {
  applyChatIndexDelta,
  IndexDeltaMismatchError,
  restoreTranscriptDescriptors,
} from './index-delta';

/** The version 2 index contract, injected to keep this module acyclic. */
export type AssertChatStorageIndexes = (
  indexes: unknown,
) => asserts indexes is ChatStorageIndexes;

export const DELTA_INDEX_FILE_NAMES = [
  'live-index.json',
  'archive-index.json',
  'recovery-index.json',
] as const;

export type JournalCommit =
  | DeltaJournalCommitRecord
  | DeltaJournalV2CommitRecord;
export function primaryEffects(
  record: JournalCommit,
): DeltaJournalTranscriptEffect[] {
  if (record.v === 1) return record.transcripts;
  return record.transcripts.flatMap((effect) => {
    if (
      effect.kind === 'child-upsert' ||
      effect.kind === 'child-settle' ||
      effect.target.kind !== 'primary'
    )
      return [];
    const { target, ...payload } = effect;
    return [{ ...payload, chatId: target.chatId }];
  });
}

export interface DeltaJournalContents {
  segment: DeltaJournalSegmentRecord | DeltaJournalV2SegmentRecord;
  /** Verified commit records, in file order. */
  records: JournalCommit[];
  /** Digest of the last verified frame; the next record chains from it. */
  lastDigest: string;
  /** Revision after the last verified record. */
  lastRevision: number;
  /** End of the verified prefix; an append continues here. */
  validEnd: number;
  fileBytes: number;
  /** Unacknowledged bytes after the verified prefix, never applied. */
  tornTail?: DeltaJournalTornTail;
}

export interface DeltaCheckpointMarker {
  v: 1 | 2;
  /**
   * `transcripts`: records after `fromRevision` are being applied to the
   * transcript files; `appliedThrough` is the last record fully applied.
   * `publishing`: every index file was staged at `targetRevision`; staged
   * files still present have not been renamed into place yet.
   */
  phase: 'transcripts' | 'publishing';
  fromRevision: number;
  targetRevision: number;
  appliedThrough: number;
  /** Format-4 authoritative metadata staged before publication. */
  metadata?: {
    descriptors: { path: string; sha256: string }[];
    registries: { path: string; sha256: string }[];
    catalog?: { path: string; sha256: string };
    removedParents: string[];
  };
}

export interface DeltaCheckpointState {
  /** Indexes of the last complete (or completing) checkpoint. */
  indexes: ChatStorageIndexes;
  revision: number;
  /** Records through this revision are already in the transcript files. */
  transcriptProgress: number;
  marker?: DeltaCheckpointMarker;
}

export interface MetadataReplay {
  /** Index metadata after every record; touched descriptors are stale. */
  indexes: ChatStorageIndexes;
  /** Chats whose transcript a replayed record changed and that remain. */
  touched: Set<string>;
  /** Archived chats whose turn count a transcript write last set. */
  turnCountFromDescriptor: Set<string>;
}

function integrity(message: string, cause?: unknown): never {
  throw new ChatDeltaJournalIntegrityError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

async function readOptional(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Decode and verify the journal's frames, hash chain and revisions. */
export async function readDeltaJournal(
  directory: string,
  scopeId: string,
  manifest?: unknown,
): Promise<DeltaJournalContents> {
  const selected =
    manifest === undefined ? DELTA_JOURNAL_FILE_NAME : journalFileFor(manifest);
  if (!selected) return integrity('Scope has no selected delta journal');
  const bytes = await readOptional(join(directory, selected));
  if (!bytes) return integrity('Delta journal is missing');
  const scan = scanDeltaJournalFrames(bytes);
  const [first, ...rest] = scan.frames;
  if (!first) return integrity('Delta journal has no segment header');
  const segment =
    selected === DELTA_JOURNAL_FILE_NAME
      ? decodeDeltaJournalRecord(first)
      : decodeDeltaJournalV2Record(first);
  if (segment.type !== 'segment' || segment.scopeId !== scopeId)
    return integrity('Delta journal segment does not belong to this scope');
  const records: JournalCommit[] = [];
  let digest = first.digest;
  let revision = segment.baseRevision;
  for (const frame of rest) {
    const record =
      segment.v === 1
        ? decodeDeltaJournalRecord(frame)
        : decodeDeltaJournalV2Record(frame);
    if (record.type !== 'commit')
      return integrity('Delta journal has a second segment header');
    if (record.prev !== digest)
      return integrity('Delta journal hash chain is broken');
    if (record.fromRevision !== revision)
      return integrity('Delta journal records skip a revision');
    records.push(record);
    digest = frame.digest;
    revision = record.toRevision;
  }
  return {
    segment,
    records,
    lastDigest: digest,
    lastRevision: revision,
    validEnd: scan.validEnd,
    fileBytes: bytes.length,
    ...(scan.tornTail ? { tornTail: scan.tornTail } : {}),
  };
}

function isMarker(value: unknown): value is DeltaCheckpointMarker {
  return (
    isRecord(value) &&
    (value.v === 1 || value.v === 2) &&
    (value.phase === 'transcripts' || value.phase === 'publishing') &&
    Number.isSafeInteger(value.fromRevision) &&
    Number.isSafeInteger(value.targetRevision) &&
    Number.isSafeInteger(value.appliedThrough) &&
    Number(value.fromRevision) <= Number(value.appliedThrough) &&
    Number(value.appliedThrough) <= Number(value.targetRevision) &&
    (value.v === 1 ||
      value.metadata === undefined ||
      (isRecord(value.metadata) &&
        Array.isArray(value.metadata.descriptors) &&
        Array.isArray(value.metadata.registries) &&
        Array.isArray(value.metadata.removedParents)))
  );
}

function parseJson(bytes: Buffer, what: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    return integrity(`${what} is not valid JSON`, error);
  }
}

export async function readCheckpointMarker(
  directory: string,
): Promise<DeltaCheckpointMarker | undefined> {
  const bytes = await readOptional(
    join(directory, DELTA_CHECKPOINT_MARKER_NAME),
  );
  if (!bytes) return undefined;
  const value = parseJson(bytes, 'Delta checkpoint marker');
  if (!isMarker(value)) return integrity('Invalid delta checkpoint marker');
  return value;
}

/**
 * The checkpoint indexes. While a checkpoint publishes, a staged index file
 * that still exists is the authoritative next version of that file.
 */
export async function readCheckpointState(
  directory: string,
  assertIndexes: AssertChatStorageIndexes,
): Promise<DeltaCheckpointState> {
  const marker = await readCheckpointMarker(directory);
  const values: unknown[] = [];
  for (const name of DELTA_INDEX_FILE_NAMES) {
    const staged =
      marker?.phase === 'publishing'
        ? await readOptional(
            join(directory, `${name}${DELTA_CHECKPOINT_STAGED_SUFFIX}`),
          )
        : undefined;
    const bytes = staged ?? (await readFile(join(directory, name)));
    values.push(parseJson(bytes, name));
  }
  const [live, archive, recovery] = values;
  const indexes = { live, archive, recovery };
  assertIndexes(indexes);
  const revision = indexes.live.revision;
  if (marker?.phase === 'publishing') {
    if (revision !== marker.targetRevision)
      return integrity('Staged checkpoint indexes have the wrong revision');
    return { indexes, revision, transcriptProgress: revision, marker };
  }
  if (marker && marker.fromRevision !== revision)
    return integrity('Delta checkpoint marker does not match its indexes');
  return {
    indexes,
    revision,
    transcriptProgress: marker?.appliedThrough ?? revision,
    ...(marker ? { marker } : {}),
  };
}

/**
 * The journal must reach the checkpoint: a checkpoint lands on a record
 * boundary, and the journal holds every record after it.
 */
export function assertJournalCovers(
  journal: DeltaJournalContents,
  checkpoint: DeltaCheckpointState,
): void {
  const boundaries = new Set([
    journal.segment.baseRevision,
    ...journal.records.map((record) => record.toRevision),
  ]);
  if (!boundaries.has(checkpoint.revision))
    integrity('Delta journal does not continue from its checkpoint');
  if (!boundaries.has(checkpoint.transcriptProgress))
    integrity('Delta checkpoint progress is not a record boundary');
  if (
    checkpoint.marker &&
    checkpoint.marker.targetRevision > journal.lastRevision
  )
    integrity('Delta checkpoint targets records the journal does not hold');
}

function chatIds(indexes: ChatStorageIndexes): Set<string> {
  return new Set([
    ...indexes.live.tabs.map((tab) => tab.id),
    ...indexes.archive.archived.map((entry) => entry.tab.id),
  ]);
}

function assertRecordMembership(
  record: JournalCommit,
  previous: Set<string>,
  next: Set<string>,
): void {
  const affected = new Set<string>();
  for (const effect of primaryEffects(record)) {
    affected.add(effect.chatId);
    const deleting = effect.kind === 'delete';
    if (deleting === next.has(effect.chatId))
      integrity('Delta journal effect disagrees with index membership');
    if (deleting) continue;
    const create = effect.kind === 'patch' ? false : effect.create;
    if (create === previous.has(effect.chatId))
      integrity('Delta journal effect disagrees with index membership');
  }
  for (const id of Array.from(next))
    if (!previous.has(id) && !affected.has(id))
      integrity('Delta journal record adds a chat without a transcript');
  for (const id of Array.from(previous))
    if (!next.has(id) && !affected.has(id))
      integrity('Delta journal record removes a chat without deleting it');
  if (record.v === 2) {
    const registrations = new Set<string>();
    for (const entry of record.streamRegistrations) {
      const key = transcriptTargetKey(entry.target);
      if (!next.has(entry.target.chatId) || registrations.has(key))
        integrity('Invalid stream registration parent or duplicate target');
      registrations.add(key);
    }
  }
}

function archivedTurnCounts(indexes: ChatStorageIndexes): Map<string, string> {
  return new Map(
    indexes.archive.archived.map((entry) => [
      entry.tab.id,
      JSON.stringify(entry.turnCount ?? null),
    ]),
  );
}

/**
 * Apply one record's index delta to `current`, check it against the record
 * and the version 2 index contract, and return the next indexes.
 */
export function applyRecordMetadata(
  current: ChatStorageIndexes,
  record: JournalCommit,
  assertIndexes: AssertChatStorageIndexes,
): ChatStorageIndexes {
  if (current.live.revision !== record.fromRevision)
    integrity('Delta journal record does not follow its indexes');
  let next: unknown;
  try {
    next = restoreTranscriptDescriptors(
      applyChatIndexDelta(current, record.delta),
      current,
    );
  } catch (error) {
    if (error instanceof IndexDeltaMismatchError)
      integrity(error.message, error);
    throw error;
  }
  try {
    assertIndexes(next);
  } catch (error) {
    return integrity('Delta journal record produced invalid indexes', error);
  }
  if (
    next.live.revision !== record.toRevision ||
    next.archive.revision !== record.toRevision
  )
    integrity('Delta journal record has the wrong revision');
  const retained = new Set(next.recovery.mutationIds);
  if (record.mutationIds.some((id) => !retained.has(id)))
    integrity('Delta journal record does not retain its mutation ids');
  assertRecordMembership(record, chatIds(current), chatIds(next));
  return next;
}

/** Index metadata after `records`, starting from the checkpoint. */
export function replayIndexMetadata(
  checkpoint: ChatStorageIndexes,
  records: readonly JournalCommit[],
  assertIndexes: AssertChatStorageIndexes,
): MetadataReplay {
  let indexes = checkpoint;
  const touched = new Set<string>();
  const turnCountFromDescriptor = new Set<string>();
  const registered = new Set<string>();
  for (const record of records) {
    if (record.v === 2)
      for (const entry of record.streamRegistrations) {
        const key = transcriptTargetKey(entry.target);
        if (registered.has(key))
          integrity('Duplicate stream registration across records');
        registered.add(key);
      }
    const next = applyRecordMetadata(indexes, record, assertIndexes);
    if (record.delta.archive && turnCountFromDescriptor.size) {
      const before = archivedTurnCounts(indexes);
      const after = archivedTurnCounts(next);
      for (const id of Array.from(turnCountFromDescriptor))
        if (!before.has(id) || before.get(id) !== after.get(id))
          turnCountFromDescriptor.delete(id);
    }
    const archived = new Set(
      next.archive.archived.map((entry) => entry.tab.id),
    );
    for (const effect of primaryEffects(record)) {
      if (effect.kind === 'delete') {
        touched.delete(effect.chatId);
        turnCountFromDescriptor.delete(effect.chatId);
        continue;
      }
      touched.add(effect.chatId);
      if (archived.has(effect.chatId))
        turnCountFromDescriptor.add(effect.chatId);
      else turnCountFromDescriptor.delete(effect.chatId);
    }
    indexes = next;
  }
  return { indexes, touched, turnCountFromDescriptor };
}

/** Records whose effects the transcript files do not hold yet. */
export function recordsAfter(
  journal: DeltaJournalContents,
  revision: number,
): JournalCommit[] {
  return journal.records.filter((record) => record.toRevision > revision);
}

/** Every row the records carry, by owning chat, with its finality. */
function recordRows(
  records: readonly JournalCommit[],
): Array<{ chatId: string; message: PersistedChatMessage; final: boolean }> {
  // A checkpoint skips child rows of parents deleted in its window, so their artifacts may be gone.
  const deleted = new Set(
    records.flatMap((record) =>
      primaryEffects(record).flatMap((effect) =>
        effect.kind === 'delete' ? [effect.chatId] : [],
      ),
    ),
  );
  return records.flatMap((record) => [
    ...primaryEffects(record).flatMap((effect) =>
      effectRowsWithFinality(effect).map((row) => ({
        chatId: effect.chatId,
        ...row,
      })),
    ),
    ...(record.v === 2
      ? record.transcripts.flatMap((effect) =>
          (effect.kind === 'child-upsert' || effect.kind === 'child-settle') &&
          !deleted.has(effect.target.chatId)
            ? effect.rows.map((message) => ({
                chatId: effect.target.chatId,
                message,
                final: message.final,
              }))
            : [],
        )
      : []),
  ]);
}

/**
 * Every artifact a not-yet-applied record references must exist and match,
 * because the writer published it before the record. A missing one fails
 * closed instead of becoming a shorter transcript. A format 4 (version 2)
 * record's rows were prepared by its writer, so they are also checked as
 * prepared: a final row's large field without a reference is an integrity
 * failure, never a new artifact.
 */
export async function verifyRecordArtifacts(
  transcriptsRoot: string,
  records: readonly JournalCommit[],
): Promise<void> {
  const artifacts = new ChatTranscriptArtifacts(transcriptsRoot, true);
  const v2 = records.some((record) => record.v === 2);
  for (const record of records) {
    if (record.v !== 2) continue;
    for (const effect of record.registryEffects ?? []) {
      if (
        effect.kind !== 'delegation-result' ||
        effect.entry.answer.kind !== 'body'
      )
        continue;
      try {
        await artifacts.verify(effect.target.chatId, effect.entry.answer.ref);
      } catch (error) {
        if (isErrnoException(error) && error.code !== 'ENOENT') throw error;
        integrity(
          `Delta journal result references a missing or damaged answer for ${effect.target.chatId}`,
          error,
        );
      }
    }
  }
  for (const { chatId, message, final } of recordRows(records)) {
    try {
      for await (const reference of artifacts.referenceClosure(chatId, message))
        await artifacts.verify(chatId, reference);
      // The closure covers tool output; visuals live on the logical blocks.
      const logical = await artifacts.expandBlocks(chatId, message);
      for (const block of logical.blocks)
        for (const ref of storedArtifactRefsOf(block))
          if (ref.family === 'visual')
            await artifacts.verifyArtifact(chatId, ref);
    } catch (error) {
      // Only absence or damage is an integrity failure; any other
      // operating-system error may clear and is retried.
      if (isErrnoException(error) && error.code !== 'ENOENT') throw error;
      integrity(
        `Delta journal record references a missing or damaged artifact for ${chatId}`,
        error,
      );
    }
    if (!v2) continue;
    try {
      await artifacts.externalize(chatId, message, undefined, {
        kind: 'format4-verify',
        final,
      });
    } catch (error) {
      if (isErrnoException(error)) throw error;
      integrity(
        `Delta journal record holds an unprepared transcript row for ${chatId}`,
        error,
      );
    }
  }
}
