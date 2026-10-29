/**
 * On-disk format of the per-scope chat delta journal (storage manifest
 * version 3). See `docs/desktop-chat-state-ownership.md` § Delta journal.
 *
 * A journal file is a sequence of frames:
 *
 * ```text
 * offset 0   4 bytes   magic "CDJ1"
 * offset 4   4 bytes   payload length, unsigned little-endian
 * offset 8  32 bytes   SHA-256 of the payload (checksum and record digest)
 * offset 40  n bytes   payload: one UTF-8 JSON record
 * ```
 *
 * The first frame is a segment header; every later frame is a commit record.
 * Each record names the digest of the frame before it (`prev`), so the frames
 * form a hash chain anchored by the segment header. The checksum doubles as
 * the record digest, so verifying one verifies the other.
 *
 * This module is pure: it reads, writes and validates bytes and values only.
 */
import { createHash } from 'node:crypto';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import { isPersistedChatMessage } from '../persisted-chat-message-validation';
import { isRecord } from '../type-guards';
import { isIndexDelta, type IndexDelta } from './index-delta';

export const DELTA_JOURNAL_FILE_NAME = 'delta-journal.log';
/**
 * A journal tail that recovery dropped with reason `checksum_mismatch` is
 * first copied, byte for byte, to `<prefix><n>.bin` in the scope directory.
 */
export const DELTA_JOURNAL_QUARANTINE_PREFIX = 'delta-journal-tail-quarantine-';
/** Present only while a checkpoint is being written. */
export const DELTA_CHECKPOINT_MARKER_NAME = 'delta-checkpoint.json';
/** Suffix of an index file a checkpoint staged but has not yet published. */
export const DELTA_CHECKPOINT_STAGED_SUFFIX = '.checkpoint';
/** Scratch area a checkpoint uses for rewrite inputs; never authoritative. */
export const DELTA_CHECKPOINT_WORK_DIRECTORY = 'delta-checkpoint-work';
export const DELTA_JOURNAL_MANIFEST_VERSION = 3;
export const DELTA_JOURNAL_FORMAT = 'chat-delta-journal-v1';

const MAGIC = Buffer.from('CDJ1', 'ascii');
export const FRAME_HEADER_BYTES = 40;
/** A record is bounded so a reader never buffers an unbounded frame. */
export const MAX_RECORD_PAYLOAD_BYTES = 64 * 1024 * 1024;

/** Digest the first segment of a new journal chains from. */
export const DELTA_JOURNAL_GENESIS_DIGEST: string = createHash('sha256')
  .update(`${DELTA_JOURNAL_FORMAT}:genesis`)
  .digest('hex');

/**
 * The journal or its checkpoint is internally inconsistent: a corrupt frame
 * followed by a valid one, a broken hash chain, a revision gap, an invalid
 * record, or a missing referenced artifact. The scope enters
 * `recovery_error`; the files are preserved and never read as empty.
 */
export class ChatDeltaJournalIntegrityError extends Error {
  public override readonly name = 'ChatDeltaJournalIntegrityError';
  public readonly cause?: unknown;

  public constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    if (options && 'cause' in options) this.cause = options.cause;
  }
}

/**
 * The scope was written by a newer storage format than this code may change:
 * a version 3 (delta-journal) scope opened by a path that only writes the
 * version 2 files, or a journal record of a version this reader does not know.
 * It fails closed; nothing is written and nothing is read as empty.
 */
export class ChatStorageNewerFormatError extends Error {
  public override readonly name = 'ChatStorageNewerFormatError';
}

export interface DeltaJournalStorageManifest {
  version: 3;
  scopeId: string;
  migrationId: string;
  sourceRevision: number;
  sourceDigest: string;
  /** Version 3 is only ever published over a cleaned-up version 2 scope. */
  cleanupComplete: true;
  journal: typeof DELTA_JOURNAL_FORMAT;
  /**
   * The version 2 manifest the scope was promoted from, verbatim, so a
   * demotion restores its exact bytes. Readers ignore it.
   */
  demotesTo?: unknown;
}

export function isDeltaJournalStorageManifest(
  value: unknown,
): value is DeltaJournalStorageManifest {
  return (
    isRecord(value) &&
    value.version === DELTA_JOURNAL_MANIFEST_VERSION &&
    typeof value.scopeId === 'string' &&
    typeof value.migrationId === 'string' &&
    Number.isSafeInteger(value.sourceRevision) &&
    typeof value.sourceDigest === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sourceDigest) &&
    value.cleanupComplete === true &&
    value.journal === DELTA_JOURNAL_FORMAT
  );
}

export interface DeltaJournalSegmentRecord {
  type: 'segment';
  v: 1;
  scopeId: string;
  /** Revision of the checkpoint this segment continues from. */
  baseRevision: number;
  /** Digest of the last record of the previous segment, or the genesis. */
  prev: string;
}

/** Messages appended to, or written into the mutable suffix of, one chat. */
export interface DeltaJournalMessagesEffect {
  chatId: string;
  /**
   * `append` finalizes rows into the committed log. `active` and
   * `active-replace` replace the active projection (the latter may drop
   * uncommitted rows). `active-upsert` replaces active rows by id in place
   * and appends new ones, carrying only the rows that changed.
   */
  kind: 'append' | 'active' | 'active-replace' | 'active-upsert';
  /** The chat had no transcript before this record. */
  create: boolean;
  messages: PersistedChatMessage[];
  /**
   * Active kinds only, written by the phase 09 write path: the transcript
   * revision the chat's log index holds once this effect is applied. It lets
   * a checkpoint write a run of active updates once, with the revision the
   * individual writes would have reached. Readers that apply records one by
   * one ignore it.
   */
  transcriptRevision?: number;
}

/** An intentional whole-transcript rewrite (import, reset, replacement). */
export interface DeltaJournalReplaceEffect {
  chatId: string;
  kind: 'replace';
  create: boolean;
  messages: PersistedChatMessage[];
  /** The last `activeTailCount` rows become the active projection. */
  activeTailCount: number;
  /** Transcript revision the replaced log had, for the rewrite revision. */
  priorTranscriptRevision: number;
}

/**
 * A rewrite expressed against the committed rows the chat has when the
 * record applies: drop `removedMessageIds`, replace rows by id from
 * `patches`, move any row whose id is in `tail` to the end, then append
 * `tail`. The last `activeTailCount` rows of the result are active.
 */
export interface DeltaJournalPatchEffect {
  chatId: string;
  kind: 'patch';
  patches: PersistedChatMessage[];
  removedMessageIds: string[];
  tail: PersistedChatMessage[];
  activeTailCount: number;
  priorTranscriptRevision: number;
}

export interface DeltaJournalDeleteEffect {
  chatId: string;
  kind: 'delete';
}

export type DeltaJournalTranscriptEffect =
  | DeltaJournalMessagesEffect
  | DeltaJournalReplaceEffect
  | DeltaJournalPatchEffect
  | DeltaJournalDeleteEffect;

export interface DeltaJournalCommitRecord {
  type: 'commit';
  v: 1;
  prev: string;
  fromRevision: number;
  toRevision: number;
  /** Mutation identities this record applied, for idempotent retry. */
  mutationIds: string[];
  /**
   * Group commit: the byte offset of the first frame of the batch this
   * record was appended with. A batch is written with one append and one
   * sync, so none of it is acknowledged before all of it is durable. Absent
   * on a batch's first record and on a record written alone. Recovery uses
   * it only to tell an unsynced batch's damaged tail from corruption
   * followed by acknowledged data (see {@link scanDeltaJournalFrames}).
   */
  batchStart?: number;
  /** Index metadata change; never whole indexes, never descriptors. */
  delta: IndexDelta;
  /** One effect per chat, applied in order. */
  transcripts: DeltaJournalTranscriptEffect[];
}

export type DeltaJournalRecord =
  | DeltaJournalSegmentRecord
  | DeltaJournalCommitRecord;

export interface DeltaJournalFrame {
  /** Byte offset of the frame in the file. */
  offset: number;
  /** Byte offset just past the frame. */
  end: number;
  digest: string;
  payload: Buffer;
}

/**
 * Why the bytes after the verified prefix are not a frame.
 *
 * - `incomplete`: the header or the payload it declares runs past the end
 *   of the file, as an append cut short leaves it.
 * - `checksum_mismatch`: a complete header whose magic, length or checksum
 *   is invalid, as a full-length write whose sync never completed can leave
 *   it after power loss.
 *
 * Either way no verified frame follows, so the record was never
 * acknowledged and the log ends before it. A verified frame whose payload is
 * not a valid record is neither: its checksum proves those bytes were
 * written, so it fails closed instead.
 */
export type DeltaJournalTailReason = 'incomplete' | 'checksum_mismatch';

export interface DeltaJournalTornTail {
  offset: number;
  bytes: number;
  reason: DeltaJournalTailReason;
}

export interface DeltaJournalFrameScan {
  frames: DeltaJournalFrame[];
  /** Length of the longest prefix made only of complete, verified frames. */
  validEnd: number;
  /**
   * Bytes after `validEnd` that do not form a verified frame and are not
   * followed by one: an append that was never acknowledged.
   */
  tornTail?: DeltaJournalTornTail;
}

export function encodeDeltaJournalFrame(record: DeltaJournalRecord): {
  frame: Buffer;
  digest: string;
} {
  const payload = Buffer.from(JSON.stringify(record), 'utf8');
  if (payload.length > MAX_RECORD_PAYLOAD_BYTES)
    throw new Error('Delta journal record exceeds the maximum record size');
  const checksum = createHash('sha256').update(payload).digest();
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(payload.length, 4);
  checksum.copy(header, 8);
  return {
    frame: Buffer.concat([header, payload]),
    digest: checksum.toString('hex'),
  };
}

type FrameProbe = DeltaJournalFrame | 'incomplete' | 'invalid';

function probeFrame(bytes: Buffer, offset: number): FrameProbe {
  if (offset + FRAME_HEADER_BYTES > bytes.length) return 'incomplete';
  if (!bytes.subarray(offset, offset + MAGIC.length).equals(MAGIC))
    return 'invalid';
  const length = bytes.readUInt32LE(offset + 4);
  if (length > MAX_RECORD_PAYLOAD_BYTES) return 'invalid';
  const end = offset + FRAME_HEADER_BYTES + length;
  if (end > bytes.length) return 'incomplete';
  const payload = bytes.subarray(offset + FRAME_HEADER_BYTES, end);
  const checksum = createHash('sha256').update(payload).digest();
  if (!checksum.equals(bytes.subarray(offset + 8, offset + FRAME_HEADER_BYTES)))
    return 'invalid';
  return { offset, end, digest: checksum.toString('hex'), payload };
}

/**
 * Split a journal file into verified frames. An invalid or incomplete frame
 * that no verified frame follows is a torn tail: a write that was never
 * synced, so never acknowledged. Anything after it is reported, not
 * returned. A verified frame after an invalid one means acknowledged data
 * follows corruption, which fails closed, unless that frame is a later
 * record of the batch the invalid bytes are in: the batch was one unsynced
 * append, so the tail starts at the invalid bytes.
 */
export function scanDeltaJournalFrames(bytes: Buffer): DeltaJournalFrameScan {
  const frames: DeltaJournalFrame[] = [];
  let offset = 0;
  let stop: FrameProbe | undefined;
  while (offset < bytes.length) {
    const probe = probeFrame(bytes, offset);
    if (probe === 'incomplete' || probe === 'invalid') {
      stop = probe;
      break;
    }
    frames.push(probe);
    offset = probe.end;
  }
  if (offset === bytes.length) return { frames, validEnd: offset };
  let batchFollows = false;
  for (
    let candidate = bytes.indexOf(MAGIC, offset + 1);
    candidate !== -1;
    candidate = bytes.indexOf(MAGIC, candidate + 1)
  ) {
    const probe = probeFrame(bytes, candidate);
    if (typeof probe !== 'object') continue;
    // Group commit writes a batch with one append and one sync. A verified
    // frame of the batch the damage is in was never acknowledged either.
    // Any other verified frame was appended after that batch's sync.
    if (!continuesBatchFrom(probe, offset))
      throw new ChatDeltaJournalIntegrityError(
        `Delta journal is corrupt at byte ${offset} before a later valid record`,
      );
    batchFollows = true;
  }
  return {
    frames,
    validEnd: offset,
    tornTail: {
      offset,
      bytes: bytes.length - offset,
      // Whole frames follow the damage: keep them for inspection.
      reason:
        stop === 'incomplete' && !batchFollows
          ? 'incomplete'
          : 'checksum_mismatch',
    },
  };
}

/**
 * Whether a verified frame found after damage at `damagedAt` is a later
 * record of a batch that began at or before the damage: it names that
 * batch's first frame (`batchStart`), which only a record that is not the
 * first of its batch does.
 */
function continuesBatchFrom(
  frame: DeltaJournalFrame,
  damagedAt: number,
): boolean {
  let value: unknown;
  try {
    value = JSON.parse(frame.payload.toString('utf8'));
  } catch {
    return false;
  }
  return (
    isRecord(value) &&
    value.type === 'commit' &&
    isNonNegativeInteger(value.batchStart) &&
    value.batchStart <= damagedAt &&
    value.batchStart < frame.offset
  );
}

function isMessageList(value: unknown): value is PersistedChatMessage[] {
  return Array.isArray(value) && value.every(isPersistedChatMessage);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

const MESSAGE_KINDS = new Set([
  'append',
  'active',
  'active-replace',
  'active-upsert',
]);
const KNOWN_KINDS = new Set([
  ...Array.from(MESSAGE_KINDS),
  'replace',
  'patch',
  'delete',
]);

function parseEffect(value: unknown): DeltaJournalTranscriptEffect {
  if (!isRecord(value) || typeof value.chatId !== 'string')
    throw new ChatDeltaJournalIntegrityError('Invalid delta journal effect');
  const kind = value.kind;
  if (typeof kind !== 'string' || !KNOWN_KINDS.has(kind))
    throw new ChatStorageNewerFormatError(
      'Delta journal effect kind is newer than this version',
    );
  const chatId = value.chatId;
  if (kind === 'delete') return { chatId, kind };
  if (
    kind === 'append' ||
    kind === 'active' ||
    kind === 'active-replace' ||
    kind === 'active-upsert'
  ) {
    if (typeof value.create !== 'boolean' || !isMessageList(value.messages))
      throw new ChatDeltaJournalIntegrityError('Invalid delta journal effect');
    const revision = value.transcriptRevision;
    if (
      revision !== undefined &&
      (kind === 'append' || !isNonNegativeInteger(revision))
    )
      throw new ChatDeltaJournalIntegrityError('Invalid delta journal effect');
    return {
      chatId,
      kind,
      create: value.create,
      messages: value.messages,
      ...(isNonNegativeInteger(revision)
        ? { transcriptRevision: revision }
        : {}),
    };
  }
  if (
    !isNonNegativeInteger(value.activeTailCount) ||
    !isNonNegativeInteger(value.priorTranscriptRevision)
  )
    throw new ChatDeltaJournalIntegrityError('Invalid delta journal effect');
  if (kind === 'replace') {
    if (
      typeof value.create !== 'boolean' ||
      !isMessageList(value.messages) ||
      value.activeTailCount > value.messages.length
    )
      throw new ChatDeltaJournalIntegrityError('Invalid delta journal effect');
    return {
      chatId,
      kind,
      create: value.create,
      messages: value.messages,
      activeTailCount: value.activeTailCount,
      priorTranscriptRevision: value.priorTranscriptRevision,
    };
  }
  const removed = value.removedMessageIds;
  if (
    !isMessageList(value.patches) ||
    !isMessageList(value.tail) ||
    !Array.isArray(removed) ||
    !removed.every((id) => typeof id === 'string') ||
    value.activeTailCount > value.tail.length
  )
    throw new ChatDeltaJournalIntegrityError('Invalid delta journal effect');
  return {
    chatId,
    kind: 'patch',
    patches: value.patches,
    removedMessageIds: removed.filter(
      (id): id is string => typeof id === 'string',
    ),
    tail: value.tail,
    activeTailCount: value.activeTailCount,
    priorTranscriptRevision: value.priorTranscriptRevision,
  };
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Decode one verified frame. Unknown record versions fail closed. */
export function decodeDeltaJournalRecord(
  frame: DeltaJournalFrame,
): DeltaJournalRecord {
  let value: unknown;
  try {
    value = JSON.parse(UTF8.decode(frame.payload));
  } catch {
    throw new ChatDeltaJournalIntegrityError(
      'Delta journal record is not valid JSON',
    );
  }
  if (!isRecord(value) || typeof value.prev !== 'string')
    throw new ChatDeltaJournalIntegrityError('Invalid delta journal record');
  if (value.v !== 1 || (value.type !== 'segment' && value.type !== 'commit'))
    throw new ChatStorageNewerFormatError(
      'Delta journal record is newer than this version',
    );
  if (value.type === 'segment') {
    if (
      typeof value.scopeId !== 'string' ||
      !isNonNegativeInteger(value.baseRevision)
    )
      throw new ChatDeltaJournalIntegrityError('Invalid delta journal segment');
    return {
      type: 'segment',
      v: 1,
      scopeId: value.scopeId,
      baseRevision: value.baseRevision,
      prev: value.prev,
    };
  }
  const mutationIds = value.mutationIds;
  if (
    !isNonNegativeInteger(value.fromRevision) ||
    !isNonNegativeInteger(value.toRevision) ||
    value.toRevision <= value.fromRevision ||
    !Array.isArray(mutationIds) ||
    !mutationIds.every((id) => typeof id === 'string') ||
    !isIndexDelta(value.delta) ||
    !Array.isArray(value.transcripts)
  )
    throw new ChatDeltaJournalIntegrityError('Invalid delta journal record');
  const transcripts = value.transcripts.map(parseEffect);
  const chats = new Set(transcripts.map((effect) => effect.chatId));
  if (chats.size !== transcripts.length)
    throw new ChatDeltaJournalIntegrityError(
      'Delta journal record has two effects for one chat',
    );
  const batchStart = value.batchStart;
  if (
    batchStart !== undefined &&
    (!isNonNegativeInteger(batchStart) || batchStart >= frame.offset)
  )
    throw new ChatDeltaJournalIntegrityError(
      'Invalid delta journal batch offset',
    );
  return {
    type: 'commit',
    v: 1,
    prev: value.prev,
    fromRevision: value.fromRevision,
    toRevision: value.toRevision,
    mutationIds: mutationIds.filter(
      (id): id is string => typeof id === 'string',
    ),
    delta: value.delta,
    transcripts,
    ...(batchStart !== undefined ? { batchStart } : {}),
  };
}

/** Effects that change only a chat's active projection. */
export function isActiveEffect(
  effect: DeltaJournalTranscriptEffect,
): effect is DeltaJournalMessagesEffect & {
  kind: 'active' | 'active-replace' | 'active-upsert';
} {
  return (
    (effect.kind === 'active' ||
      effect.kind === 'active-replace' ||
      effect.kind === 'active-upsert') &&
    !effect.create
  );
}

/** Every message an effect carries, for artifact verification. */
export function effectMessages(
  effect: DeltaJournalTranscriptEffect,
): PersistedChatMessage[] {
  if (effect.kind === 'delete') return [];
  if (effect.kind === 'patch') return [...effect.patches, ...effect.tail];
  return effect.messages;
}
