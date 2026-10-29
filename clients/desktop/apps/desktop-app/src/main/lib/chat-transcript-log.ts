import {
  buildTurnIndex,
  isTranscriptTurnIndex,
  type IndexedTurn,
  type TranscriptTurnIndex,
} from './chat-transcript-turn-index';
import type {
  TranscriptViewRequest,
  TranscriptTurnSummary,
} from '@canopy/agent-transcript/transcript-storage';
import { foldTranscriptTodoState } from '@canopy/agent-transcript';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  open,
  opendir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  PersistedChatBlock,
  PersistedChatMessage,
  PersistedToolOutputReference,
  PersistedVisualReference,
} from '@canopy/agent-transcript/types';
import {
  isHumanAuthoredUserMessage,
  TRANSCRIPT_PAGE_SIZE,
  type TranscriptPage,
  type TranscriptDescriptor,
} from '@canopy/agent-transcript/transcript-storage';
import { ChatDelegationLogs } from './chat-delegation-log';
import {
  ChatTranscriptArtifacts,
  assertTranscriptIdentity,
} from './chat-transcript-artifacts';
import {
  artifactIdsOf,
  storedArtifactLocations,
} from './chat-artifact-references';
import {
  recordChatStorageAtomicReplacement,
  recordChatStorageFileSync,
  recordChatStorageFileWrite,
} from '@canopy/desktop-shared/node/work-counters';
import { beginMainTranscriptPerformanceStage } from './transcript-performance';
import { fsyncDirectory } from './fsync-directory';
import { isPersistedChatMessage } from './persisted-chat-message-validation';
import { iterateAsync, writeJsonValuesCooperatively } from './cooperative-json';
import { isErrnoException, isRecord } from './type-guards';
import {
  MAX_TRANSCRIPT_ROW_BYTES,
  replaceSharedPrefix,
} from './chat-transcript-prefix-replace';

const SPARSE_STRIDE = TRANSCRIPT_PAGE_SIZE;
export { MAX_TRANSCRIPT_ROW_BYTES };
/**
 * Seed of the committed-row hash chain. The chain identifies the committed
 * prefix content: `sha256(previous ‖ rowDigest)` over rows in order, extended
 * on append, recomputed by replace, and derived by every rebuild from JSONL.
 * Active-sidecar updates never touch it.
 */
export const EMPTY_COMMITTED_DIGEST: string = createHash('sha256')
  .update('complete-message-jsonl-v1:committed-digest')
  .digest('hex');

export type { TranscriptDescriptor } from '@canopy/agent-transcript/transcript-storage';

/**
 * The durable log holds less than a committed index describes. Callers map
 * this to the scope's `recovery_error` lifecycle; it never becomes a shorter
 * or empty chat.
 */
export class ChatTranscriptIntegrityError extends Error {
  public override readonly name = 'ChatTranscriptIntegrityError';
}

function errorFromUnknown(value: unknown): Error {
  return value instanceof Error
    ? value
    : Object.assign(new Error(String(value)), { cause: value });
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

function artifactIdsForBlock(block: PersistedChatBlock): string[] {
  const ids: string[] = [];
  for (const location of STORED_ARTIFACT_LOCATIONS)
    ids.push(...artifactIdsOf(block, location.family));
  return ids;
}

const STORED_ARTIFACT_LOCATIONS = storedArtifactLocations();

/** Rows are bounded on the write side so a stored row can always be read back. */
export function assertTranscriptRowWithinLimit(
  message: PersistedChatMessage,
): void {
  if (
    Buffer.byteLength(JSON.stringify(message), 'utf8') >
    MAX_TRANSCRIPT_ROW_BYTES
  )
    throw new Error('Transcript row exceeds maximum size');
}

interface SparseIndex extends TranscriptDescriptor {
  version: 3;
  committedDigest: string;
  offsets: Array<{ ordinal: number; offset: number }>;
  latestHuman?: { ordinal: number; offset: number };
}

function extendCommittedDigest(previous: string, rowDigest: string): string {
  return createHash('sha256').update(previous).update(rowDigest).digest('hex');
}

function indexChecksum(index: SparseIndex): string {
  return createHash('sha256').update(JSON.stringify(index)).digest('hex');
}

interface ActiveSidecar {
  version: 1;
  transcriptRevision: number;
  updatedAt: string;
  messages: PersistedChatMessage[];
  finalizing?: { stagedId: string; byteOffset: number; messageIds: string[] };
}

interface ActiveSidecarHeaderV2 {
  version: 2;
  transcriptRevision: number;
  updatedAt: string;
  finalizing?: { stagedId: string; byteOffset: number };
}

interface ActiveSidecarMessageV2 {
  version: 2;
  kind: 'message';
  message: PersistedChatMessage;
  finalizing?: true;
}

/** Derived snapshots are shared across log instances, but never with callers. */
class BoundedTranscriptSnapshotCache<T extends object> {
  private readonly entries = new Map<
    string,
    { identity: string; bytes: number; value: T }
  >();
  private retainedBytes = 0;

  public constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
    private readonly maxEntryBytes: number,
  ) {}

  public get(path: string, identity: string): T | undefined {
    const entry = this.entries.get(path);
    if (!entry) return undefined;
    if (entry.identity !== identity) {
      this.delete(path);
      return undefined;
    }
    this.entries.delete(path);
    this.entries.set(path, entry);
    return structuredClone(entry.value);
  }

  public set(path: string, identity: string, bytes: number, value: T): void {
    this.delete(path);
    if (bytes > this.maxEntryBytes) return;
    this.entries.set(path, {
      identity,
      bytes,
      value: structuredClone(value),
    });
    this.retainedBytes += bytes;
    while (
      this.entries.size > this.maxEntries ||
      this.retainedBytes > this.maxBytes
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  public delete(path: string): void {
    const entry = this.entries.get(path);
    if (!entry) return;
    this.entries.delete(path);
    this.retainedBytes -= entry.bytes;
  }
}

interface CommittedRecentPage {
  messages: PersistedChatMessage[];
  latestHumanMessage?: PersistedChatMessage;
}

export interface ArtifactReferenceSlice {
  identity: string;
  nextOffset: number;
  complete: boolean;
  scannedBytes: number;
  artifactIds: string[];
  activeHeaderFinalizing?: boolean;
  activeFinalizingRows?: number;
}

const activeSnapshots = new BoundedTranscriptSnapshotCache<ActiveSidecar>(
  8,
  4 * 1024 * 1024,
  1024 * 1024,
);
const recentCommittedPages =
  new BoundedTranscriptSnapshotCache<CommittedRecentPage>(
    8,
    4 * 1024 * 1024,
    2 * 1024 * 1024,
  );
const MAX_MAINTENANCE_INDEX_BYTES = 1024 * 1024;
interface MaintenanceCommittedIndex extends Pick<
  TranscriptDescriptor,
  | 'format'
  | 'committedDigest'
  | 'committedMessageCount'
  | 'committedByteLength'
  | 'transcriptRevision'
  | 'hasActiveSidecar'
  | 'messageCount'
  | 'userMessageCount'
  | 'firstMessageAt'
  | 'lastMessageAt'
> {
  committedDigest: string;
}
// Only fixed-size verified fields are retained; sparse offset arrays are not.
const maintenanceIndexCache = new Map<
  string,
  { stamp: string; index: MaintenanceCommittedIndex }
>();

function fileStatStamp(info: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

async function fileIdentity(
  path: string,
): Promise<{ stamp: string; bytes: number }> {
  const info = await stat(path, { bigint: true });
  return {
    stamp: fileStatStamp(info),
    bytes: Number(info.size),
  };
}

function isActiveSidecar(value: unknown): value is ActiveSidecar {
  return (
    isRecord(value) &&
    value.version === 1 &&
    Number.isSafeInteger(value.transcriptRevision) &&
    typeof value.updatedAt === 'string' &&
    Array.isArray(value.messages) &&
    value.messages.every(isPersistedChatMessage) &&
    (value.finalizing === undefined ||
      (isRecord(value.finalizing) &&
        typeof value.finalizing.stagedId === 'string' &&
        Number.isSafeInteger(value.finalizing.byteOffset) &&
        Array.isArray(value.finalizing.messageIds) &&
        value.finalizing.messageIds.every((id) => typeof id === 'string')))
  );
}

function isActiveSidecarHeaderV2(
  value: unknown,
): value is ActiveSidecarHeaderV2 {
  return (
    isRecord(value) &&
    value.version === 2 &&
    Number.isSafeInteger(value.transcriptRevision) &&
    typeof value.updatedAt === 'string' &&
    (value.finalizing === undefined ||
      (isRecord(value.finalizing) &&
        typeof value.finalizing.stagedId === 'string' &&
        Number.isSafeInteger(value.finalizing.byteOffset)))
  );
}

function isActiveSidecarMessageV2(
  value: unknown,
): value is ActiveSidecarMessageV2 {
  return (
    isRecord(value) &&
    value.version === 2 &&
    value.kind === 'message' &&
    isPersistedChatMessage(value.message) &&
    (value.finalizing === undefined || value.finalizing === true)
  );
}

function isSparseIndexWithChecksum(
  value: unknown,
): value is SparseIndex & { checksum: string } {
  return (
    isRecord(value) &&
    value.version === 3 &&
    value.format === 'complete-message-jsonl-v1' &&
    typeof value.checksum === 'string' &&
    typeof value.committedDigest === 'string' &&
    /^[a-f0-9]{64}$/.test(value.committedDigest) &&
    Number.isSafeInteger(value.committedMessageCount) &&
    Number.isSafeInteger(value.committedByteLength) &&
    Number.isSafeInteger(value.transcriptRevision) &&
    typeof value.hasActiveSidecar === 'boolean' &&
    (value.lastMessageRole === undefined ||
      value.lastMessageRole === 'user' ||
      value.lastMessageRole === 'assistant') &&
    Array.isArray(value.offsets) &&
    value.offsets.every(
      (entry) =>
        isRecord(entry) &&
        Number.isSafeInteger(entry.ordinal) &&
        Number.isSafeInteger(entry.offset),
    ) &&
    (value.latestHuman === undefined ||
      (isRecord(value.latestHuman) &&
        Number.isSafeInteger(value.latestHuman.ordinal) &&
        Number.isSafeInteger(value.latestHuman.offset)))
  );
}

function messageOwnsToolOutput(
  message: PersistedChatMessage,
  messageId: string,
  toolUseId: string,
  reference: PersistedToolOutputReference,
): boolean {
  return (
    message.id === messageId &&
    message.blocks.some(
      (block) =>
        block.type === 'tool_result' &&
        block.toolUseId === toolUseId &&
        block.fullOutputRef?.artifactId === reference.artifactId &&
        block.fullOutputRef.sha256 === reference.sha256 &&
        block.fullOutputRef.byteLength === reference.byteLength &&
        block.fullOutputRef.encoding === reference.encoding &&
        block.fullOutputRef.mediaType === reference.mediaType &&
        block.fullOutputRef.version === reference.version,
    )
  );
}

function messageOwnsVisual(
  message: PersistedChatMessage,
  messageId: string,
  toolUseId: string,
  reference: PersistedVisualReference,
): boolean {
  if (message.id !== messageId) return false;
  return message.blocks.some((block) => {
    if (block.type !== 'tool_result' || block.toolUseId !== toolUseId)
      return false;
    const visual = block.visualRef;
    if (!visual) return false;
    const heightsEqual =
      visual.heights === undefined || reference.heights === undefined
        ? visual.heights === reference.heights
        : visual.heights.length === reference.heights.length &&
          visual.heights.every(
            (pair, index) =>
              pair[0] === reference.heights?.[index]?.[0] &&
              pair[1] === reference.heights?.[index]?.[1],
          );
    return (
      visual.version === reference.version &&
      visual.visualId === reference.visualId &&
      visual.artifactId === reference.artifactId &&
      visual.byteLength === reference.byteLength &&
      visual.sha256 === reference.sha256 &&
      visual.mediaType === reference.mediaType &&
      visual.title === reference.title &&
      visual.maxHeight === reference.maxHeight &&
      heightsEqual
    );
  });
}

interface LoadedLog {
  index: SparseIndex;
  locatorStamp: string;
  locatorsComplete: boolean;
  /**
   * Active row ids a read found absent from the committed history whose
   * digest is `committedDigest`, with locators as of `locatorStamp`, so
   * later reads need not probe them again.
   */
  uncommitted?: {
    committedDigest: string;
    locatorStamp: string;
    ids: Set<string>;
  };
}

/**
 * Chats whose indexes one log keeps loaded. Every commit of a scope reads
 * each chat its delta journal holds, so this must exceed the chats that
 * stream at once in one worktree; an entry is a sparse index, not rows.
 */
const MAX_LOADED_LOGS = 64;

interface MessageLocator {
  version: 1;
  messageId: string;
  offset: number;
  end: number;
  digest: string;
}

/** Derived indexes are bounded writes; the JSONL is the durable authority. */
async function flushLocatorBatch(
  batch: Array<{ path: string; locator: MessageLocator }>,
): Promise<void> {
  const results = await Promise.allSettled(
    batch.map(({ path, locator }) => {
      const text = JSON.stringify(locator);
      return writeFile(path, text, {
        mode: 0o600,
        flag: 'wx',
      }).then(() => {
        recordChatStorageFileWrite(path, Buffer.byteLength(text), true);
      });
    }),
  );
  batch.length = 0;
  for (const result of results) {
    if (result.status === 'fulfilled') continue;
    if (isErrnoException(result.reason) && result.reason.code === 'EEXIST')
      throw new Error('Invalid or duplicate committed message');
    throw result.reason;
  }
}

function isMessageLocator(value: unknown): value is MessageLocator {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.messageId === 'string' &&
    typeof value.offset === 'number' &&
    Number.isSafeInteger(value.offset) &&
    value.offset >= 0 &&
    typeof value.end === 'number' &&
    Number.isSafeInteger(value.end) &&
    value.end > value.offset &&
    typeof value.digest === 'string' &&
    /^[a-f0-9]{64}$/.test(value.digest)
  );
}

function assistantPreview(message: PersistedChatMessage): string | undefined {
  if (message.role !== 'assistant') return undefined;
  let text = '';
  for (const block of message.blocks) {
    if (block.type === 'text')
      text += (text ? ' ' : '') + block.text.slice(0, 201 - text.length);
    if (text.length >= 201) break;
  }
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized
    ? normalized.length > 200
      ? normalized.slice(0, 200) + '...'
      : normalized
    : undefined;
}

function digest(message: PersistedChatMessage): string {
  return createHash('sha256').update(JSON.stringify(message)).digest('hex');
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
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

async function writeActiveSidecar(
  path: string,
  sidecar: ActiveSidecar,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const finalizing = new Set(sidecar.finalizing?.messageIds ?? []);
  const header: ActiveSidecarHeaderV2 = {
    version: 2,
    transcriptRevision: sidecar.transcriptRevision,
    updatedAt: sidecar.updatedAt,
    ...(sidecar.finalizing
      ? {
          finalizing: {
            stagedId: sidecar.finalizing.stagedId,
            byteOffset: sidecar.finalizing.byteOffset,
          },
        }
      : {}),
  };
  await mkdir(dirname(path), { recursive: true });
  let renamed = false;
  try {
    await writeJsonValuesCooperatively(
      temporary,
      (function* (): Generator<ActiveSidecarHeaderV2 | ActiveSidecarMessageV2> {
        yield header;
        for (const message of sidecar.messages) {
          assertTranscriptRowWithinLimit(message);
          yield {
            version: 2,
            kind: 'message',
            message,
            ...(finalizing.has(message.id) ? { finalizing: true } : {}),
          };
        }
      })(),
      { pretty: false, separator: '\n', trailingSeparator: true },
    );
    await rename(temporary, path);
    renamed = true;
    recordChatStorageAtomicReplacement(path);
    await fsyncDirectory(dirname(path));
  } finally {
    if (!renamed) await rm(temporary, { force: true });
  }
}

/** Active sidecars use one bounded JSON value per line. */
async function* activeRowsWithOffsets(
  path: string,
  start = 0,
): AsyncGenerator<{ value: unknown; offset: number; end: number }> {
  yield* activeRowsFromChunks(createReadStream(path, { start }), start);
}

async function* activeRowsFromChunks(
  chunks: AsyncIterable<Buffer>,
  start = 0,
): AsyncGenerator<{ value: unknown; offset: number; end: number }> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending: Buffer[] = [];
  let length = 0;
  let offset = start;
  for await (const raw of chunks) {
    if (!Buffer.isBuffer(raw))
      throw new Error('Active transcript stream must contain bytes');
    let begin = 0;
    for (let i = raw.indexOf(10, begin); i !== -1; i = raw.indexOf(10, begin)) {
      const segment = raw.subarray(begin, i);
      if (length + segment.length > MAX_TRANSCRIPT_ROW_BYTES + 1024)
        throw new Error('Active transcript row exceeds maximum size');
      const bytes = pending.length
        ? Buffer.concat([...pending, segment], length + segment.length)
        : segment;
      const end = offset + bytes.length + 1;
      if (bytes.length > 0)
        yield { value: JSON.parse(decoder.decode(bytes)), offset, end };
      offset = end;
      begin = i + 1;
      pending = [];
      length = 0;
    }
    if (begin < raw.length) {
      const segment = raw.subarray(begin);
      if (length + segment.length > MAX_TRANSCRIPT_ROW_BYTES + 1024)
        throw new Error('Active transcript row exceeds maximum size');
      pending.push(segment);
      length += segment.length;
    }
  }
  if (length > 0) throw new Error('Incomplete active transcript row');
}

async function* activeRows(path: string): AsyncGenerator<unknown> {
  for await (const row of activeRowsWithOffsets(path)) yield row.value;
}

/** Stream the previous object-and-array format during rolling upgrades. */
async function readLegacyActiveSidecar(path: string): Promise<ActiveSidecar> {
  return readLegacyActiveSidecarFromChunks(
    createReadStream(path, { encoding: 'utf8' }),
  );
}

async function readLegacyActiveSidecarFromChunks(
  chunks: AsyncIterable<string>,
): Promise<ActiveSidecar> {
  const messagesMarker = '"messages":[';
  const messageIdsMarker = '"messageIds":[';
  let stage: 'header' | 'messages' | 'tail' | 'messageIds' | 'suffix' =
    'header';
  let header = '';
  let tail = '';
  let suffix = '';
  let value = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  let metadata:
    | Pick<ActiveSidecar, 'transcriptRevision' | 'updatedAt'>
    | undefined;
  let finalizing:
    | Pick<NonNullable<ActiveSidecar['finalizing']>, 'stagedId' | 'byteOffset'>
    | undefined;
  const messages: PersistedChatMessage[] = [];
  const messageIds: string[] = [];

  const parseHeader = (): void => {
    const parsed: unknown = JSON.parse(
      header.slice(0, -messagesMarker.length) + '"messages":[]}',
    );
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      typeof parsed.transcriptRevision !== 'number' ||
      !Number.isSafeInteger(parsed.transcriptRevision) ||
      typeof parsed.updatedAt !== 'string'
    )
      throw new Error('Invalid active transcript sidecar');
    metadata = {
      transcriptRevision: parsed.transcriptRevision,
      updatedAt: parsed.updatedAt,
    };
  };
  const parseTail = (): void => {
    const beforeMarker = tail.slice(0, -messageIdsMarker.length);
    const parsed: unknown = JSON.parse(
      `{"messages":[]${beforeMarker}"messageIds":[]}}`,
    );
    if (
      !isRecord(parsed) ||
      !isRecord(parsed.finalizing) ||
      typeof parsed.finalizing.stagedId !== 'string' ||
      typeof parsed.finalizing.byteOffset !== 'number' ||
      !Number.isSafeInteger(parsed.finalizing.byteOffset)
    )
      throw new Error('Invalid active transcript sidecar');
    finalizing = {
      stagedId: parsed.finalizing.stagedId,
      byteOffset: parsed.finalizing.byteOffset,
    };
  };
  const finishMessage = (): void => {
    const parsed: unknown = JSON.parse(value);
    if (!isPersistedChatMessage(parsed))
      throw new Error('Invalid active transcript message');
    assertTranscriptRowWithinLimit(parsed);
    messages.push(parsed);
    value = '';
  };
  const finishMessageId = (): void => {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'string')
      throw new Error('Invalid active transcript message id');
    messageIds.push(parsed);
    value = '';
  };

  for await (const raw of chunks) {
    const chunk = String(raw);
    for (const character of chunk) {
      if (stage === 'header') {
        header += character;
        if (header.length > 65_536)
          throw new Error('Active transcript header exceeds maximum size');
        if (header.endsWith(messagesMarker)) {
          parseHeader();
          stage = 'messages';
        }
        continue;
      }
      if (stage === 'messages') {
        if (depth === 0) {
          if (/\s|,/.test(character)) continue;
          if (character === ']') {
            stage = 'tail';
            continue;
          }
          if (character !== '{')
            throw new Error('Invalid active transcript message array');
          value = character;
          depth = 1;
          inString = false;
          escaped = false;
          continue;
        }
        value += character;
        if (value.length > MAX_TRANSCRIPT_ROW_BYTES)
          throw new Error('Active transcript row exceeds maximum size');
        if (inString) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') inString = false;
        } else if (character === '"') inString = true;
        else if (character === '{' || character === '[') depth += 1;
        else if (character === '}' || character === ']') {
          depth -= 1;
          if (depth === 0) finishMessage();
        }
        continue;
      }
      if (stage === 'tail') {
        tail += character;
        if (tail.length > 65_536)
          throw new Error('Active transcript metadata exceeds maximum size');
        if (tail.endsWith(messageIdsMarker)) {
          parseTail();
          stage = 'messageIds';
        }
        continue;
      }
      if (stage === 'messageIds') {
        if (!inString) {
          if (/\s|,/.test(character)) continue;
          if (character === ']') {
            stage = 'suffix';
            continue;
          }
          if (character !== '"')
            throw new Error('Invalid active transcript message id array');
          value = character;
          inString = true;
          escaped = false;
          continue;
        }
        value += character;
        if (value.length > MAX_TRANSCRIPT_ROW_BYTES)
          throw new Error('Active transcript message id exceeds maximum size');
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') {
          inString = false;
          finishMessageId();
        }
        continue;
      }
      suffix += character;
      if (suffix.length > 16)
        throw new Error('Invalid active transcript sidecar suffix');
    }
  }
  if (!metadata || stage === 'header' || stage === 'messages')
    throw new Error('Invalid active transcript sidecar');
  if (stage === 'messageIds' || inString)
    throw new Error('Incomplete active transcript sidecar');
  if (stage === 'tail') {
    if (tail.trim() !== '}')
      throw new Error('Invalid active transcript sidecar');
  } else if (!finalizing || suffix.trim() !== '}}') {
    throw new Error('Invalid active transcript sidecar');
  }
  return {
    version: 1,
    ...metadata,
    messages,
    ...(finalizing ? { finalizing: { ...finalizing, messageIds } } : {}),
  };
}

/** Streaming line traversal; keeps only the current complete-message row in memory. */
async function* lines(
  path: string,
  start = 0,
): AsyncGenerator<{
  message: PersistedChatMessage;
  offset: number;
  end: number;
}> {
  yield* linesFromChunks(createReadStream(path, { start }), start);
}

async function* linesFromChunks(
  chunks: AsyncIterable<Buffer>,
  start = 0,
): AsyncGenerator<{
  message: PersistedChatMessage;
  offset: number;
  end: number;
}> {
  let offset = start;
  let pending: Buffer[] = [];
  let length = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for await (const raw of chunks) {
    if (!Buffer.isBuffer(raw))
      throw new Error('Transcript stream must contain bytes');
    const chunk = raw;
    let begin = 0;
    // Native delimiter scanning keeps large tool/message rows off the JS
    // byte-by-byte hot path. Decode only complete rows, with strict UTF-8.
    for (
      let i = chunk.indexOf(10, begin);
      i !== -1;
      i = chunk.indexOf(10, begin)
    ) {
      const segment = chunk.subarray(begin, i);
      if (length + segment.length > MAX_TRANSCRIPT_ROW_BYTES)
        throw new Error('Transcript row exceeds maximum size');
      const bytes = pending.length
        ? Buffer.concat([...pending, segment], length + segment.length)
        : segment;
      const parsed: unknown = JSON.parse(decoder.decode(bytes));
      if (!isPersistedChatMessage(parsed))
        throw new Error('Invalid complete transcript message');
      const end = offset + bytes.length + 1;
      yield { message: parsed, offset, end };
      offset = end;
      begin = i + 1;
      pending = [];
      length = 0;
    }
    if (begin < chunk.length) {
      const segment = chunk.subarray(begin);
      if (length + segment.length > MAX_TRANSCRIPT_ROW_BYTES)
        throw new Error('Transcript row exceeds maximum size');
      pending.push(segment);
      length += segment.length;
    }
  }
  // A partial tail is preserved. Explicit recovery must reconcile it with the
  // active projection/transaction before it can truncate or acknowledge data.
  if (length > 0)
    throw new Error(`Incomplete transcript tail at byte ${offset}`);
}

interface CapturedPreviewFile {
  handle: FileHandle;
  size: number;
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

async function capturedPreviewFile(
  handle: FileHandle,
): Promise<CapturedPreviewFile> {
  const info = await handle.stat({ bigint: true });
  const size = Number(info.size);
  if (!Number.isSafeInteger(size) || size < 0)
    throw new ChatTranscriptIntegrityError(
      'Transcript preview file is too large',
    );
  return {
    handle,
    size,
    dev: info.dev,
    ino: info.ino,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
  };
}

async function assertCapturedPreviewFileUnchanged(
  file: CapturedPreviewFile,
  allowAppend = false,
): Promise<void> {
  const info = await file.handle.stat({ bigint: true });
  const grewByAppend = allowAppend && info.size > BigInt(file.size);
  if (
    info.dev !== file.dev ||
    info.ino !== file.ino ||
    (info.size !== BigInt(file.size) && !grewByAppend) ||
    (info.mtimeNs !== file.mtimeNs && !grewByAppend) ||
    // Atomic replacement may unlink the old inode. Its bytes remain a valid
    // captured snapshot; an in-place edit on a linked inode does not.
    (info.nlink > BigInt(0) && info.ctimeNs !== file.ctimeNs && !grewByAppend)
  )
    throw new ChatTranscriptIntegrityError(
      'Transcript preview changed during read',
    );
}

async function* capturedPreviewChunks(
  file: CapturedPreviewFile,
  signal: AbortSignal,
): AsyncGenerator<Buffer> {
  let offset = 0;
  while (offset < file.size) {
    if (signal.aborted) throw new Error('Transcript preview aborted');
    const bytes = Buffer.allocUnsafe(Math.min(64 * 1024, file.size - offset));
    const { bytesRead } = await file.handle.read(
      bytes,
      0,
      bytes.length,
      offset,
    );
    if (signal.aborted) throw new Error('Transcript preview aborted');
    if (bytesRead === 0)
      throw new ChatTranscriptIntegrityError(
        'Transcript preview was truncated',
      );
    offset += bytesRead;
    yield bytes.subarray(0, bytesRead);
  }
}

async function* capturedPreviewTextChunks(
  file: CapturedPreviewFile,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for await (const chunk of capturedPreviewChunks(file, signal))
    yield decoder.decode(chunk, { stream: true });
  const tail = decoder.decode();
  if (tail) yield tail;
}

/**
 * The active rows of a chat that a delta journal holds ahead of its files:
 * exactly what the active sidecar holds once a checkpoint writes it, and the
 * transcript revision the log's index then carries.
 */
export interface TranscriptActiveProjection {
  messages: readonly PersistedChatMessage[];
  transcriptRevision: number;
}

/**
 * Supplies a chat's journaled active rows to the read paths. Write paths
 * always use the files: a checkpoint applies the journal to them.
 */
export type TranscriptActiveProjectionSource = (
  chatId: string,
) => TranscriptActiveProjection | undefined;

/** Immutable file handles captured under the repository scope lease. */
export class CapturedTranscriptPreview {
  private readonly controller = new AbortController();
  private closePromise?: Promise<void>;
  private consumed = false;
  private complete = false;
  private readonly authority: TranscriptDescriptor;
  private readonly projectedActive?: readonly PersistedChatMessage[];

  public constructor(
    descriptor: TranscriptDescriptor,
    private readonly committed: CapturedPreviewFile,
    private readonly active?: CapturedPreviewFile,
    /** Journaled active rows; the active sidecar file is then not read. */
    projectedActive?: readonly PersistedChatMessage[],
  ) {
    this.authority = structuredClone(descriptor);
    if (projectedActive)
      this.projectedActive = structuredClone(projectedActive);
  }

  public get descriptor(): TranscriptDescriptor {
    return structuredClone(this.authority);
  }

  /** The active rows come from a delta journal's projection, not the sidecar. */
  public get journalProjected(): boolean {
    return this.projectedActive !== undefined;
  }

  public async *messages(): AsyncGenerator<PersistedChatMessage> {
    if (this.consumed)
      throw new Error('Transcript preview was already consumed');
    this.consumed = true;
    if (this.controller.signal.aborted)
      throw new Error('Transcript preview aborted');
    let count = 0;
    let committedDigest = EMPTY_COMMITTED_DIGEST;
    for await (const row of linesFromChunks(
      capturedPreviewChunks(this.committed, this.controller.signal),
    )) {
      count += 1;
      committedDigest = extendCommittedDigest(
        committedDigest,
        digest(row.message),
      );
      yield row.message;
    }
    if (
      count !== this.authority.committedMessageCount ||
      committedDigest !== this.authority.committedDigest ||
      this.committed.size !== this.authority.committedByteLength
    )
      throw new ChatTranscriptIntegrityError(
        'Transcript preview committed prefix mismatch',
      );
    await assertCapturedPreviewFileUnchanged(this.committed, true);
    yield* this.readActiveRows();
  }

  /**
   * Yields only the active sidecar when the consumer already holds a
   * projection of this exact committed prefix: the captured descriptor's
   * count, byte length, and digest chain identify it. The committed rows are
   * neither read nor parsed, so nothing re-verifies their bytes: the captured
   * file must hold exactly the descriptor's committed length and still be
   * that inode with no change at all. Unlike {@link messages}, growth is not
   * tolerated, because an in-place edit followed by an append would pass a
   * size check alone; callers project the whole transcript instead.
   */
  public async *activeMessages(): AsyncGenerator<PersistedChatMessage> {
    if (this.consumed)
      throw new Error('Transcript preview was already consumed');
    this.consumed = true;
    if (this.controller.signal.aborted)
      throw new Error('Transcript preview aborted');
    if (this.committed.size !== this.authority.committedByteLength)
      throw new ChatTranscriptIntegrityError(
        'Transcript preview committed prefix mismatch',
      );
    await assertCapturedPreviewFileUnchanged(this.committed);
    yield* this.readActiveRows();
  }

  private async *readActiveRows(): AsyncGenerator<PersistedChatMessage> {
    if (this.projectedActive) {
      for (const message of this.projectedActive) {
        if (this.controller.signal.aborted)
          throw new Error('Transcript preview aborted');
        yield message;
      }
      this.complete = true;
      return;
    }
    if (!this.active) {
      if (this.authority.hasActiveSidecar)
        throw new ChatTranscriptIntegrityError(
          'Transcript preview active sidecar is missing',
        );
      this.complete = true;
      return;
    }
    const prefix = Buffer.alloc(1024);
    const { bytesRead } = await this.active.handle.read(
      prefix,
      0,
      prefix.length,
      0,
    );
    if (this.controller.signal.aborted)
      throw new Error('Transcript preview aborted');
    const match = /"version"\s*:\s*(\d+)/.exec(
      prefix.subarray(0, bytesRead).toString('utf8'),
    );
    const version = match ? Number(match[1]) : undefined;
    if (version === 1) {
      const sidecar = await readLegacyActiveSidecarFromChunks(
        capturedPreviewTextChunks(this.active, this.controller.signal),
      );
      if (!isActiveSidecar(sidecar) || sidecar.finalizing)
        throw new ChatTranscriptIntegrityError(
          'Invalid captured active sidecar',
        );
      if (sidecar.transcriptRevision !== this.authority.transcriptRevision)
        throw new ChatTranscriptIntegrityError(
          'Transcript preview active revision mismatch',
        );
      for (const message of sidecar.messages) yield message;
    } else if (version === 2) {
      let header: ActiveSidecarHeaderV2 | undefined;
      let finalizingRows = 0;
      for await (const row of activeRowsFromChunks(
        capturedPreviewChunks(this.active, this.controller.signal),
      )) {
        if (!header) {
          if (!isActiveSidecarHeaderV2(row.value))
            throw new ChatTranscriptIntegrityError(
              'Invalid captured active header',
            );
          header = row.value;
          continue;
        }
        if (!isActiveSidecarMessageV2(row.value))
          throw new ChatTranscriptIntegrityError(
            'Invalid captured active message',
          );
        if (row.value.finalizing) finalizingRows += 1;
        yield row.value.message;
      }
      if (
        !header ||
        header.transcriptRevision !== this.authority.transcriptRevision ||
        finalizingRows > 0 !== !!header.finalizing ||
        header.finalizing
      )
        throw new ChatTranscriptIntegrityError(
          'Transcript preview active revision mismatch',
        );
    } else
      throw new ChatTranscriptIntegrityError('Invalid captured active sidecar');
    await assertCapturedPreviewFileUnchanged(this.active);
    this.complete = true;
  }

  public assertComplete(): void {
    if (!this.complete || this.controller.signal.aborted)
      throw new ChatTranscriptIntegrityError(
        'Transcript preview did not complete',
      );
  }

  public close(): Promise<void> {
    if (!this.closePromise) {
      this.controller.abort();
      this.closePromise = (async (): Promise<void> => {
        const outcomes = await Promise.allSettled([
          this.committed.handle.close(),
          ...(this.active ? [this.active.handle.close()] : []),
        ]);
        const failure = outcomes.find(
          (outcome): outcome is PromiseRejectedResult =>
            outcome.status === 'rejected',
        );
        if (failure) throw errorFromUnknown(failure.reason);
      })().catch((error: unknown) => {
        // A failed OS close remains visible and retryable to the owner.
        this.closePromise = undefined;
        throw error;
      });
    }
    return this.closePromise;
  }
}

export async function* readCompleteTranscriptMessages(
  path: string,
): AsyncGenerator<PersistedChatMessage> {
  for await (const row of lines(path)) yield row.message;
}

/** Main-owned per-chat storage. Scope transactions serialize operations using this store. */
export class ChatTranscriptLog {
  public readonly artifacts: ChatTranscriptArtifacts;
  public readonly delegations: ChatDelegationLogs;
  private readonly loaded = new Map<string, LoadedLog>();
  private readonly tails = new Map<string, Promise<unknown>>();

  public constructor(
    private readonly root: string,
    private readonly onAppendBoundary: (
      boundary: 'prepared' | 'appended',
    ) => Promise<void> = () => Promise.resolve(),
    private readonly options: { readOnly?: boolean } = {},
  ) {
    this.artifacts = new ChatTranscriptArtifacts(root, options.readOnly);
    this.delegations = new ChatDelegationLogs(root, options.readOnly);
  }

  private activeProjection?: TranscriptActiveProjectionSource;

  /**
   * Delta-journal scopes: read paths (descriptors, pages, active rows, tool
   * output ownership, search previews) take a chat's active rows and
   * transcript revision from `source` while it has one, because the journal
   * holds them ahead of the active sidecar. Committed rows are always read
   * from the files. `undefined` restores file-only reads.
   */
  public setActiveProjection(
    source: TranscriptActiveProjectionSource | undefined,
  ): void {
    this.activeProjection = source;
  }

  private projectedActive(
    chatId: string,
  ): TranscriptActiveProjection | undefined {
    return this.activeProjection?.(chatId);
  }

  private path(chatId: string, extension: string): string {
    assertTranscriptIdentity(chatId);
    return join(this.root, `${chatId}.${extension}`);
  }

  private locatorDirectory(chatId: string): string {
    assertTranscriptIdentity(chatId);
    return join(this.root, 'message-index', chatId);
  }

  private locatorPath(chatId: string, messageId: string): string {
    const key = createHash('sha256').update(messageId).digest('hex');
    return join(this.locatorDirectory(chatId), `${key}.json`);
  }

  private async locatorStamp(chatId: string): Promise<string> {
    try {
      const info = await stat(this.locatorDirectory(chatId), { bigint: true });
      return `${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}`;
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return 'missing';
      throw error;
    }
  }

  /** Check derived-index closure without hydrating transcript bodies. */
  private async locatorsComplete(
    chatId: string,
    expected: number,
  ): Promise<boolean> {
    let count = 0;
    try {
      for await (const entry of await opendir(this.locatorDirectory(chatId))) {
        if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name))
          return false;
        if (++count > expected) return false;
      }
      return count === expected;
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT')
        return expected === 0;
      throw error;
    }
  }

  private async writeLocators(
    chatId: string,
    rows: ReadonlyArray<{
      message: PersistedChatMessage;
      offset: number;
      end: number;
    }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    const directory = this.locatorDirectory(chatId);
    await mkdir(directory, { recursive: true });
    for (let start = 0; start < rows.length; start += 64) {
      const batch = rows
        .slice(start, start + 64)
        .map(({ message, offset, end }) => ({
          path: this.locatorPath(chatId, message.id),
          locator: {
            version: 1 as const,
            messageId: message.id,
            offset,
            end,
            digest: digest(message),
          },
        }));
      // Locators are reconstructible from the already-synced JSONL. Keep
      // bounded writes and directory publication, as the rebuild path does.
      await flushLocatorBatch(batch);
    }
    await fsyncDirectory(directory);
    await fsyncDirectory(dirname(directory));
  }

  /**
   * {@link readCommittedMessage} for an active row, probing a row absent
   * from the committed history `loaded` describes only once. Every commit
   * reads its chat's active rows twice and a checkpoint rewrites them, so
   * probing each row every time grows each commit with the turn. Callers
   * load `loaded` in the same serial section, before any committed write.
   * A new committed digest or any locator change (a rebuild restoring a
   * missing locator) starts over.
   */
  private async committedCopy(
    chatId: string,
    loaded: LoadedLog,
    messageId: string,
  ): Promise<PersistedChatMessage | undefined> {
    if (
      loaded.uncommitted?.committedDigest !== loaded.index.committedDigest ||
      loaded.uncommitted.locatorStamp !== loaded.locatorStamp
    )
      loaded.uncommitted = {
        committedDigest: loaded.index.committedDigest,
        locatorStamp: loaded.locatorStamp,
        ids: new Set(),
      };
    const absent = loaded.uncommitted.ids;
    if (absent.has(messageId)) return undefined;
    const existing = await this.readCommittedMessage(chatId, messageId);
    if (existing === undefined) absent.add(messageId);
    return existing;
  }

  private async readCommittedMessage(
    chatId: string,
    messageId: string,
  ): Promise<PersistedChatMessage | undefined> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        await readFile(this.locatorPath(chatId, messageId), 'utf8'),
      );
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        // Read-only archives cannot rebuild derived files. Scan only when
        // their locator inventory is known to be incomplete.
        if (this.loaded.get(chatId)?.locatorsComplete === false)
          for await (const row of lines(this.path(chatId, 'jsonl')))
            if (row.message.id === messageId) return row.message;
        return undefined;
      }
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (!isMessageLocator(parsed) || parsed.messageId !== messageId) {
      // A durable directory can contain a torn derived file after power loss.
      // Rebuild from complete rows, without weakening row/digest validation.
      if (this.options.readOnly) {
        for await (const row of lines(this.path(chatId, 'jsonl')))
          if (row.message.id === messageId) return row.message;
        return undefined;
      }
      await this.load(chatId, true);
      return this.readCommittedMessage(chatId, messageId);
    }
    const length = parsed.end - parsed.offset;
    if (length > MAX_TRANSCRIPT_ROW_BYTES + 1)
      throw new Error('Committed message locator exceeds maximum row size');
    const handle = await open(this.path(chatId, 'jsonl'), 'r');
    try {
      const bytes = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const result = await handle.read(
          bytes,
          read,
          length - read,
          parsed.offset + read,
        );
        if (result.bytesRead === 0)
          throw new Error('Committed message locator exceeds transcript');
        read += result.bytesRead;
      }
      if (bytes[length - 1] !== 10)
        throw new Error('Committed message locator is not row-aligned');
      const value: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          bytes.subarray(0, length - 1),
        ),
      );
      if (
        !isPersistedChatMessage(value) ||
        value.id !== messageId ||
        digest(value) !== parsed.digest
      )
        throw new Error('Committed message locator does not match transcript');
      return value;
    } finally {
      await handle.close();
    }
  }

  private async writeIndex(chatId: string, index: SparseIndex): Promise<void> {
    if (this.options.readOnly) return;
    await atomicJson(this.path(chatId, 'index.json'), {
      ...index,
      checksum: indexChecksum(index),
    });
  }

  private assertWritable(): void {
    if (this.options.readOnly) throw new Error('Transcript store is read-only');
  }

  private async serial<T>(chatId: string, work: () => Promise<T>): Promise<T> {
    assertTranscriptIdentity(chatId);
    const pending = (this.tails.get(chatId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(work);
    this.tails.set(chatId, pending);
    try {
      return await pending;
    } catch (error) {
      this.loaded.delete(chatId);
      activeSnapshots.delete(this.path(chatId, 'active.json'));
      recentCommittedPages.delete(this.path(chatId, 'jsonl'));
      throw error;
    } finally {
      if (this.tails.get(chatId) === pending) this.tails.delete(chatId);
    }
  }

  private async active(chatId: string): Promise<ActiveSidecar | undefined> {
    const path = this.path(chatId, 'active.json');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let before: { stamp: string; bytes: number };
      try {
        before = await fileIdentity(path);
      } catch (error) {
        activeSnapshots.delete(path);
        if (isErrnoException(error) && error.code === 'ENOENT')
          return undefined;
        throw error;
      }
      const cached = activeSnapshots.get(path, before.stamp);
      if (cached) return cached;
      let parsed: ActiveSidecar | undefined;
      let readError: unknown;
      try {
        parsed = await this.readActiveUncached(chatId);
      } catch (error) {
        readError = error;
      }
      let after: { stamp: string; bytes: number };
      try {
        after = await fileIdentity(path);
      } catch (error) {
        activeSnapshots.delete(path);
        if (isErrnoException(error) && error.code === 'ENOENT') {
          if (attempt < 2) continue;
          return undefined;
        }
        throw error;
      }
      if (before.stamp !== after.stamp || parsed === undefined) {
        activeSnapshots.delete(path);
        if (before.stamp === after.stamp && readError)
          throw errorFromUnknown(readError);
        if (attempt < 2) continue;
        throw new Error('Active transcript sidecar changed during read');
      }
      activeSnapshots.set(path, after.stamp, after.bytes, parsed);
      return parsed;
    }
    throw new Error('Active transcript sidecar changed during read');
  }

  private async readActiveUncached(
    chatId: string,
  ): Promise<ActiveSidecar | undefined> {
    const path = this.path(chatId, 'active.json');
    let version: number | undefined;
    try {
      const handle = await open(path, 'r');
      try {
        const prefix = Buffer.alloc(1024);
        const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
        const match = /"version"\s*:\s*(\d+)/.exec(
          prefix.subarray(0, bytesRead).toString('utf8'),
        );
        version = match ? Number(match[1]) : undefined;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return undefined;
      throw error;
    }
    if (version === 2) {
      let header: ActiveSidecarHeaderV2 | undefined;
      const messages: PersistedChatMessage[] = [];
      const finalizingIds: string[] = [];
      for await (const row of activeRows(path)) {
        if (!header) {
          if (!isActiveSidecarHeaderV2(row))
            throw new Error('Invalid active transcript sidecar header');
          header = row;
          continue;
        }
        if (!isActiveSidecarMessageV2(row))
          throw new Error('Invalid active transcript sidecar message');
        messages.push(row.message);
        if (row.finalizing) finalizingIds.push(row.message.id);
      }
      if (!header || finalizingIds.length > 0 !== !!header.finalizing)
        throw new Error('Invalid active transcript finalization state');
      return {
        version: 1,
        transcriptRevision: header.transcriptRevision,
        updatedAt: header.updatedAt,
        messages,
        ...(header.finalizing
          ? {
              finalizing: {
                ...header.finalizing,
                messageIds: finalizingIds,
              },
            }
          : {}),
      };
    }
    if (version !== 1) throw new Error('Invalid active transcript sidecar');
    const parsed = await readLegacyActiveSidecar(path);
    if (!isActiveSidecar(parsed))
      throw new Error('Invalid active transcript sidecar');
    return parsed;
  }

  private async committedRecentPage(
    chatId: string,
    index: SparseIndex,
  ): Promise<CommittedRecentPage> {
    const path = this.path(chatId, 'jsonl');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await fileIdentity(path);
      const identity = `${index.committedDigest}:${index.committedMessageCount}:${index.committedByteLength}:${index.latestHuman?.ordinal ?? -1}:${index.latestHuman?.offset ?? -1}:${before.stamp}`;
      const cached = recentCommittedPages.get(path, identity);
      if (cached) return cached;
      let page: CommittedRecentPage | undefined;
      let pageBytes = 256;
      let readError: unknown;
      try {
        const end = index.committedMessageCount;
        const start = Math.max(0, end - TRANSCRIPT_PAGE_SIZE);
        const checkpoint = [...index.offsets]
          .reverse()
          .find((entry) => entry.ordinal <= start);
        const messages: PersistedChatMessage[] = [];
        if (checkpoint && start < end) {
          let ordinal = checkpoint.ordinal;
          for await (const row of lines(path, checkpoint.offset)) {
            if (ordinal >= start && ordinal < end) {
              messages.push(row.message);
              pageBytes += row.end - row.offset;
            }
            ordinal += 1;
            if (ordinal >= end) break;
          }
        }
        if (messages.length !== end - start)
          throw new Error('Committed transcript page is incomplete');
        let latestHumanMessage: PersistedChatMessage | undefined;
        if (index.latestHuman) {
          if (
            index.latestHuman.ordinal >= start &&
            index.latestHuman.ordinal < end
          )
            latestHumanMessage = messages[index.latestHuman.ordinal - start];
          else
            for await (const row of lines(path, index.latestHuman.offset)) {
              latestHumanMessage = row.message;
              pageBytes += row.end - row.offset;
              break;
            }
        }
        page = {
          messages,
          ...(latestHumanMessage ? { latestHumanMessage } : {}),
        };
      } catch (error) {
        readError = error;
      }
      const after = await fileIdentity(path);
      if (before.stamp !== after.stamp) {
        recentCommittedPages.delete(path);
        if (attempt < 2) continue;
        throw new Error('Committed transcript changed during page read');
      }
      if (readError) throw errorFromUnknown(readError);
      if (!page) throw new Error('Committed transcript page is unavailable');
      recentCommittedPages.set(path, identity, pageBytes, page);
      return page;
    }
    throw new Error('Committed transcript changed during page read');
  }

  private remember(chatId: string, value: LoadedLog): void {
    this.loaded.delete(chatId);
    this.loaded.set(chatId, value);
    while (this.loaded.size > MAX_LOADED_LOGS) {
      const oldest = this.loaded.keys().next().value;
      if (oldest === undefined) break;
      this.loaded.delete(oldest);
    }
  }

  private async load(
    chatId: string,
    rebuildLocators = false,
  ): Promise<LoadedLog> {
    const cached = this.loaded.get(chatId);
    const locatorStamp = await this.locatorStamp(chatId);
    if (!rebuildLocators && cached?.locatorStamp === locatorStamp)
      return cached;
    if (!this.options.readOnly) await mkdir(this.root, { recursive: true });
    // Only an explicit initializer may create a missing log. Missing files for
    // an indexed chat are recovery errors, never interpreted as empty history.
    let active = await this.active(chatId);
    await this.removeOrphanedStagedAppends(
      chatId,
      active?.finalizing?.stagedId,
    );
    if (active?.finalizing) {
      this.assertWritable();
      active = await this.finishOrAbandonAppend(chatId, active);
    }
    let persistedRevision = 0;
    {
      let persisted: SparseIndex | undefined;
      try {
        const parsed: unknown = JSON.parse(
          await readFile(this.path(chatId, 'index.json'), 'utf8'),
        );
        if (!isSparseIndexWithChecksum(parsed))
          throw new SyntaxError('Invalid sparse transcript index');
        const { checksum, ...candidate } = parsed;
        const size = (await stat(this.path(chatId, 'jsonl'))).size;
        if (
          Number.isSafeInteger(candidate?.transcriptRevision) &&
          candidate.transcriptRevision >= 0
        )
          persistedRevision = candidate.transcriptRevision;
        const trusted =
          candidate.version === 3 &&
          checksum === indexChecksum(candidate) &&
          candidate.format === 'complete-message-jsonl-v1';
        // A verified index that describes more bytes than the log holds is a
        // truncated transcript. Rebuilding would silently shorten the chat.
        if (trusted && candidate.committedByteLength > size)
          throw new ChatTranscriptIntegrityError(
            `Transcript ${chatId} is shorter than its committed index: ${size} of ${candidate.committedByteLength} bytes`,
          );
        if (
          trusted &&
          Number.isSafeInteger(candidate.committedMessageCount) &&
          candidate.committedMessageCount >= 0 &&
          (candidate.committedMessageCount === 0 ? size === 0 : size > 0) &&
          candidate.committedByteLength === size &&
          Number.isSafeInteger(candidate.transcriptRevision) &&
          Array.isArray(candidate.offsets) &&
          candidate.offsets.length ===
            Math.ceil(candidate.committedMessageCount / SPARSE_STRIDE) &&
          candidate.offsets.every(
            (entry, i) =>
              entry.ordinal === i * SPARSE_STRIDE &&
              Number.isSafeInteger(entry.offset) &&
              entry.offset >= 0 &&
              entry.offset < size &&
              (i === 0
                ? entry.offset === 0
                : entry.offset > candidate.offsets[i - 1].offset),
          ) &&
          (candidate.latestHuman === undefined ||
            (candidate.latestHuman.offset >= 0 &&
              candidate.latestHuman.offset < size &&
              candidate.latestHuman.ordinal >= 0 &&
              candidate.latestHuman.ordinal < candidate.committedMessageCount))
        ) {
          persisted = candidate;
        }
      } catch (error) {
        if (
          !(error instanceof SyntaxError) &&
          !(isErrnoException(error) && error.code === 'ENOENT')
        )
          throw error;
      }
      if (persisted && !rebuildLocators) {
        const locatorsComplete = await this.locatorsComplete(
          chatId,
          persisted.committedMessageCount,
        );
        if (locatorsComplete || this.options.readOnly) {
          const result = { index: persisted, locatorStamp, locatorsComplete };
          this.remember(chatId, result);
          if (active?.finalizing) await this.clearFinalized(chatId, active);
          return result;
        }
      }
    }
    const index: SparseIndex = {
      version: 3,
      format: 'complete-message-jsonl-v1',
      committedMessageCount: 0,
      committedByteLength: 0,
      committedDigest: EMPTY_COMMITTED_DIGEST,
      transcriptRevision: 0,
      hasActiveSidecar: false,
      offsets: [],
    };
    const activeIds = new Set(
      active?.messages.map((message) => message.id) ?? [],
    );
    const committedActiveIds = new Set<string>();
    const locatorTemporary = `${this.locatorDirectory(chatId)}.${randomUUID()}.tmp`;
    const locatorBatch: Array<{ path: string; locator: MessageLocator }> = [];
    if (!this.options.readOnly)
      await mkdir(locatorTemporary, { recursive: true });
    try {
      for await (const row of lines(this.path(chatId, 'jsonl'))) {
        const locatorPath = join(
          locatorTemporary,
          `${createHash('sha256').update(row.message.id).digest('hex')}.json`,
        );
        if (!this.options.readOnly) {
          locatorBatch.push({
            path: locatorPath,
            locator: {
              version: 1,
              messageId: row.message.id,
              offset: row.offset,
              end: row.end,
              digest: digest(row.message),
            },
          });
          if (locatorBatch.length === 64) await flushLocatorBatch(locatorBatch);
        }
        if (activeIds.has(row.message.id))
          committedActiveIds.add(row.message.id);
        this.record(index, row.message, row.offset, row.end);
      }
      if (!this.options.readOnly) {
        await flushLocatorBatch(locatorBatch);
        await fsyncDirectory(locatorTemporary);
        await mkdir(join(this.root, 'message-index'), { recursive: true });
        await rm(this.locatorDirectory(chatId), {
          recursive: true,
          force: true,
        });
        await rename(locatorTemporary, this.locatorDirectory(chatId));
        recordChatStorageAtomicReplacement(this.locatorDirectory(chatId));
        await fsyncDirectory(join(this.root, 'message-index'));
      }
    } finally {
      if (!this.options.readOnly)
        await rm(locatorTemporary, { recursive: true, force: true });
    }
    index.hasActiveSidecar =
      active?.messages.some((message) => !committedActiveIds.has(message.id)) ??
      false;
    index.transcriptRevision = Math.max(
      persistedRevision,
      active?.transcriptRevision ?? 0,
      index.committedMessageCount,
    );
    const result = Object.assign(cached ?? {}, {
      index,
      locatorStamp: await this.locatorStamp(chatId),
      locatorsComplete: !this.options.readOnly,
    });
    await this.writeIndex(chatId, index);
    if (active?.finalizing) await this.clearFinalized(chatId, active);
    this.remember(chatId, result);
    return result;
  }

  private record(
    index: SparseIndex,
    message: PersistedChatMessage,
    offset: number,
    end: number,
    rowDigest = digest(message),
  ): void {
    const ordinal = index.committedMessageCount;
    if (ordinal % SPARSE_STRIDE === 0) index.offsets.push({ ordinal, offset });
    if (isHumanAuthoredUserMessage(message))
      index.latestHuman = { ordinal, offset };
    index.firstMessageAt ??= message.timestamp;
    index.lastMessageAt = message.timestamp;
    index.lastMessageId = message.id;
    if (message.role === 'user' || message.role === 'assistant')
      index.lastMessageRole = message.role;
    const preview = assistantPreview(message);
    if (preview) index.lastAssistantPreview = preview;
    Object.assign(index, foldTranscriptTodoState(index, message));
    index.committedMessageCount += 1;
    if (message.role === 'user')
      index.userMessageCount = (index.userMessageCount ?? 0) + 1;
    index.committedByteLength = end;
    index.committedDigest = extendCommittedDigest(
      index.committedDigest,
      rowDigest,
    );
  }

  public async initialize(chatId: string): Promise<void> {
    this.assertWritable();
    await this.serial(chatId, async () => {
      activeSnapshots.delete(this.path(chatId, 'active.json'));
      recentCommittedPages.delete(this.path(chatId, 'jsonl'));
      await mkdir(this.root, { recursive: true });
      const handle = await open(this.path(chatId, 'jsonl'), 'ax', 0o600);
      try {
        await handle.sync();
        recordChatStorageFileSync(this.path(chatId, 'jsonl'));
      } finally {
        await handle.close();
      }
      await fsyncDirectory(this.root);
    });
  }

  public async descriptor(chatId: string): Promise<TranscriptDescriptor> {
    return this.serial(chatId, async () => {
      const { index } = await this.load(chatId);
      const {
        offsets: _offsets,
        latestHuman: _human,
        version: _version,
        ...descriptor
      } = index;
      void _offsets;
      void _human;
      void _version;
      const projection = this.projectedActive(chatId);
      const active = projection
        ? [...projection.messages]
        : ((await this.active(chatId))?.messages ?? []);
      const preview = [...active]
        .reverse()
        .map(assistantPreview)
        .find((value) => value !== undefined);
      const lastMessageRole =
        [...active]
          .reverse()
          .find(
            (message) =>
              message.role === 'user' || message.role === 'assistant',
          )?.role ?? descriptor.lastMessageRole;
      return {
        ...descriptor,
        ...(lastMessageRole === 'user' || lastMessageRole === 'assistant'
          ? { lastMessageRole }
          : {}),
        // Existing keys keep their positions, as in the index a checkpoint
        // writes after applying the journaled active rows.
        ...(projection
          ? {
              transcriptRevision: projection.transcriptRevision,
              hasActiveSidecar: projection.messages.length > 0,
            }
          : {}),
        ...active.reduce(foldTranscriptTodoState, {
          todos: descriptor.todos,
          taskTodos: descriptor.taskTodos,
        }),
        ...(preview ? { lastAssistantPreview: preview } : {}),
        messageCount: index.committedMessageCount + active.length,
        userMessageCount:
          (index.userMessageCount ?? 0) +
          active.filter((message) => message.role === 'user').length,
        ...(active.length
          ? {
              lastMessageAt: active[active.length - 1].timestamp,
              lastMessageId: active[active.length - 1].id,
              firstMessageAt: index.firstMessageAt ?? active[0].timestamp,
            }
          : {}),
      };
    });
  }

  public async activeMessages(chatId: string): Promise<PersistedChatMessage[]> {
    const finishPerformanceStage = beginMainTranscriptPerformanceStage(
      'active_tail_reconstruction',
      chatId,
    );
    return this.serial(chatId, async () => {
      await this.load(chatId);
      const projection = this.projectedActive(chatId);
      const messages = projection
        ? [...projection.messages]
        : ((await this.active(chatId))?.messages ?? []);
      finishPerformanceStage({ loadedRows: messages.length });
      return messages;
    });
  }

  public async ownsToolOutputReference(
    chatId: string,
    messageId: string,
    toolUseId: string,
    reference: PersistedToolOutputReference,
  ): Promise<boolean> {
    return this.serial(chatId, async () => {
      await this.load(chatId);
      const committed = await this.readCommittedMessage(chatId, messageId);
      if (
        committed &&
        messageOwnsToolOutput(committed, messageId, toolUseId, reference)
      )
        return true;
      const active =
        this.projectedActive(chatId)?.messages ??
        (await this.active(chatId))?.messages ??
        [];
      return active.some((message) =>
        messageOwnsToolOutput(message, messageId, toolUseId, reference),
      );
    });
  }

  public async ownsVisualReference(
    chatId: string,
    messageId: string,
    toolUseId: string,
    reference: PersistedVisualReference,
  ): Promise<boolean> {
    return this.serial(chatId, async () => {
      await this.load(chatId);
      const committed = await this.readCommittedMessage(chatId, messageId);
      if (
        committed &&
        messageOwnsVisual(committed, messageId, toolUseId, reference)
      )
        return true;
      const active =
        this.projectedActive(chatId)?.messages ??
        (await this.active(chatId))?.messages ??
        [];
      return active.some((message) =>
        messageOwnsVisual(message, messageId, toolUseId, reference),
      );
    });
  }

  public async committedMessageState(
    chatId: string,
    message: PersistedChatMessage,
  ): Promise<'absent' | 'identical' | 'different'> {
    return this.serial(chatId, async () => {
      await this.load(chatId);
      const existing = await this.readCommittedMessage(chatId, message.id);
      return existing === undefined
        ? 'absent'
        : digest(existing) === digest(message)
          ? 'identical'
          : 'different';
    });
  }

  /** The committed row with this id, read through its locator. */
  public async committedMessage(
    chatId: string,
    messageId: string,
  ): Promise<PersistedChatMessage | undefined> {
    return this.serial(chatId, async () => {
      await this.load(chatId);
      return this.readCommittedMessage(chatId, messageId);
    });
  }

  public async hasCommittedMessage(
    chatId: string,
    messageId: string,
  ): Promise<boolean> {
    return this.serial(chatId, async () => {
      await this.load(chatId);
      return (await this.readCommittedMessage(chatId, messageId)) !== undefined;
    });
  }

  /** Read one retained row without materializing its surrounding history. */
  public async readMessage(
    chatId: string,
    messageId: string,
  ): Promise<PersistedChatMessage | undefined> {
    return this.serial(chatId, async () => {
      await this.load(chatId);
      const active =
        this.projectedActive(chatId)?.messages ??
        (await this.active(chatId))?.messages ??
        [];
      return (
        active.find((message) => message.id === messageId) ??
        (await this.readCommittedMessage(chatId, messageId))
      );
    });
  }

  /**
   * Intentional one-chat rewrite (reset, amendment, import). The caller's
   * durable scope transaction retains the source until all indexes commit,
   * and replays this replacement after a crash. Never use a paged projection
   * as an authoritative replacement.
   *
   * An unchanged committed prefix is preserved (`replaceSharedPrefix`): only
   * the changed suffix and its locators are written. Both appends and rewrites
   * with a shared prefix clone the existing log to a temporary file and
   * atomically rename it. Without a trusted baseline or a shared first row,
   * the whole log and a fresh locator directory are written.
   */
  public async replace(
    chatId: string,
    messages:
      | Iterable<PersistedChatMessage>
      | AsyncIterable<PersistedChatMessage>,
    revision: number,
  ): Promise<void> {
    this.assertWritable();
    await this.serial(chatId, async () => {
      const index: SparseIndex = {
        version: 3,
        format: 'complete-message-jsonl-v1',
        committedMessageCount: 0,
        committedByteLength: 0,
        committedDigest: EMPTY_COMMITTED_DIGEST,
        transcriptRevision: revision,
        hasActiveSidecar: false,
        offsets: [],
      };
      const cached = this.loaded.get(chatId);
      const verifiedIndex =
        cached?.locatorsComplete === true &&
        cached.locatorStamp === (await this.locatorStamp(chatId))
          ? {
              committedDigest: cached.index.committedDigest,
              committedMessageCount: cached.index.committedMessageCount,
              committedByteLength: cached.index.committedByteLength,
            }
          : undefined;
      const preserved = await replaceSharedPrefix({
        logPath: this.path(chatId, 'jsonl'),
        indexPath: this.path(chatId, 'index.json'),
        turnsPath: this.path(chatId, 'turns.json'),
        temporaryPath: this.path(chatId, `${randomUUID()}.rewrite.tmp`),
        locatorDirectory: this.locatorDirectory(chatId),
        messages,
        externalize: (message) => this.artifacts.externalize(chatId, message),
        record: (message, offset, end, rowDigest) =>
          this.record(index, message, offset, end, rowDigest),
        verifiedIndex,
      });
      if (preserved.kind === 'preserved') {
        await this.writeIndex(chatId, index);
        await rm(this.path(chatId, 'active.json'), { force: true });
        await fsyncDirectory(this.root);
        await this.turnIndex(chatId, index, preserved.reusableTurns);
        this.remember(chatId, {
          index,
          locatorStamp: await this.locatorStamp(chatId),
          locatorsComplete: true,
        });
        return;
      }
      const replacement = preserved.messages;
      const temporary = this.path(chatId, `${randomUUID()}.rewrite.tmp`);
      const locatorTemporary = `${this.locatorDirectory(chatId)}.${randomUUID()}.tmp`;
      const locatorBatch: Array<{ path: string; locator: MessageLocator }> = [];
      await mkdir(locatorTemporary, { recursive: true });
      const artifacts = this.artifacts;
      const record = this.record.bind(this);
      try {
        await writeJsonValuesCooperatively(
          temporary,
          (async function* (): AsyncGenerator<PersistedChatMessage> {
            for await (const message of iterateAsync(replacement)) {
              const stored = await artifacts.externalize(chatId, message);
              if (!isPersistedChatMessage(stored))
                throw new Error('Invalid or duplicate replacement message');
              const offset = index.committedByteLength;
              const rowBytes = Buffer.byteLength(
                JSON.stringify(stored),
                'utf8',
              );
              if (rowBytes > MAX_TRANSCRIPT_ROW_BYTES)
                throw new Error('Transcript row exceeds maximum size');
              const end = offset + rowBytes + 1;
              const locatorPath = join(
                locatorTemporary,
                `${createHash('sha256').update(stored.id).digest('hex')}.json`,
              );
              locatorBatch.push({
                path: locatorPath,
                locator: {
                  version: 1,
                  messageId: stored.id,
                  offset,
                  end,
                  digest: digest(stored),
                },
              });
              if (locatorBatch.length === 64)
                await flushLocatorBatch(locatorBatch);
              record(index, stored, offset, end);
              yield stored;
            }
          })(),
          { pretty: false, separator: '\n', trailingSeparator: true },
        );
        await flushLocatorBatch(locatorBatch);
        // A crash must not leave an old but byte-length-compatible sparse index
        // silently describing the replacement log.
        await rm(this.path(chatId, 'turns.json'), { force: true });
        await rm(this.path(chatId, 'index.json'), { force: true });
        await fsyncDirectory(this.root);
        await rename(temporary, this.path(chatId, 'jsonl'));
        recordChatStorageAtomicReplacement(this.path(chatId, 'jsonl'));
        await fsyncDirectory(this.root);
        await mkdir(join(this.root, 'message-index'), { recursive: true });
        await fsyncDirectory(locatorTemporary);
        await rm(this.locatorDirectory(chatId), {
          recursive: true,
          force: true,
        });
        await rename(locatorTemporary, this.locatorDirectory(chatId));
        recordChatStorageAtomicReplacement(this.locatorDirectory(chatId));
        await fsyncDirectory(join(this.root, 'message-index'));
        await this.writeIndex(chatId, index);
        await rm(this.path(chatId, 'active.json'), { force: true });
        await fsyncDirectory(this.root);
        await this.turnIndex(chatId, index);
        this.remember(chatId, {
          index,
          locatorStamp: await this.locatorStamp(chatId),
          locatorsComplete: true,
        });
      } finally {
        await rm(temporary, { force: true });
        await rm(locatorTemporary, { recursive: true, force: true });
      }
    });
  }

  /** Scope metadata/tombstones must commit before physical deletion. */
  public async remove(chatId: string): Promise<void> {
    this.assertWritable();
    await this.serial(chatId, async () => {
      for (const extension of [
        'jsonl',
        'index.json',
        'active.json',
        'turns.json',
      ])
        await rm(this.path(chatId, extension), { force: true });
      const affectedArtifactDirectories: string[] = [];
      for (const { directory } of STORED_ARTIFACT_LOCATIONS) {
        const familyDirectory = join(this.root, directory);
        const chatArtifactDirectory = join(familyDirectory, chatId);
        const existed = await directoryExists(chatArtifactDirectory);
        await rm(chatArtifactDirectory, { recursive: true, force: true });
        if (existed) affectedArtifactDirectories.push(familyDirectory);
      }
      await this.delegations.remove(chatId);
      await rm(this.locatorDirectory(chatId), { recursive: true, force: true });
      this.loaded.delete(chatId);
      activeSnapshots.delete(this.path(chatId, 'active.json'));
      recentCommittedPages.delete(this.path(chatId, 'jsonl'));
      for (const directory of affectedArtifactDirectories)
        await fsyncDirectory(directory);
      await fsyncDirectory(this.root);
    });
  }

  /** Append final rows before clearing any redundant active projection. */
  public async append(
    chatId: string,
    messages: readonly PersistedChatMessage[],
  ): Promise<void> {
    this.assertWritable();
    await this.serial(chatId, async () => this.appendLocked(chatId, messages));
  }

  /**
   * A delta-journal checkpoint's turn-end write: a run of journaled active
   * updates and the append that finalizes rows, as one append. The run's
   * rows and transcript revision stand in for an active sidecar that is
   * never written, so the files equal those of
   * {@link writeActiveAtRevision} followed by {@link append}; the append's
   * intent still holds every row, as for any append. Idempotent: once the
   * log index is past the run's revision the append already happened, and a
   * resumed checkpoint repeating it does nothing.
   */
  public async appendAfterActive(
    chatId: string,
    messages: readonly PersistedChatMessage[],
    active: readonly PersistedChatMessage[],
    transcriptRevision: number,
  ): Promise<void> {
    this.assertWritable();
    if (!Number.isSafeInteger(transcriptRevision) || transcriptRevision < 0)
      throw new Error('Invalid transcript revision');
    await this.serial(chatId, async () => {
      const loaded = await this.load(chatId);
      if (loaded.index.transcriptRevision > transcriptRevision) return;
      await this.appendLocked(chatId, messages, {
        messages: await this.uncommittedActiveRows(chatId, loaded, active),
        transcriptRevision,
      });
    });
  }

  /**
   * `messages` without rows the log already commits, externalized, as an
   * active write stores them; a different committed row is a conflict.
   */
  private async uncommittedActiveRows(
    chatId: string,
    loaded: LoadedLog,
    messages: readonly PersistedChatMessage[],
  ): Promise<PersistedChatMessage[]> {
    const stored: PersistedChatMessage[] = [];
    const ids = new Set<string>();
    for (const message of messages) {
      if (ids.has(message.id)) throw new Error('Duplicate active message');
      ids.add(message.id);
      const next = await this.artifacts.externalize(chatId, message);
      const existing = await this.committedCopy(chatId, loaded, next.id);
      if (existing !== undefined) {
        if (digest(existing) !== digest(next))
          throw new Error('Active message conflicts with committed history');
      } else stored.push(next);
    }
    return stored;
  }

  /**
   * {@link append} under the chat's serial lock. `before`, when given, is
   * the active state the append follows instead of the sidecar's.
   */
  private async appendLocked(
    chatId: string,
    messages: readonly PersistedChatMessage[],
    before?: { messages: PersistedChatMessage[]; transcriptRevision: number },
  ): Promise<void> {
    const loaded = await this.load(chatId);
    const prepared: PersistedChatMessage[] = [];
    const ids = new Set<string>();
    for (const message of messages) {
      const stored = await this.artifacts.externalize(chatId, message);
      assertTranscriptRowWithinLimit(stored);
      const hash = digest(stored);
      const existing = await this.readCommittedMessage(chatId, stored.id);
      if (existing !== undefined) {
        if (digest(existing) !== hash)
          throw new Error(`Conflicting committed message ${stored.id}`);
        continue;
      }
      if (ids.has(stored.id)) throw new Error('Duplicate message in append');
      ids.add(stored.id);
      prepared.push(stored);
    }
    if (prepared.length === 0) {
      if (before) {
        // Nothing to finalize: the run alone, as writeActiveAtRevision.
        loaded.index.transcriptRevision = before.transcriptRevision;
        await this.persistActive(chatId, loaded, before.messages);
        await this.writeIndex(chatId, loaded.index);
      }
      return;
    }
    const active = before ?? (await this.active(chatId));
    const pendingIds: string[] = [];
    for (const message of active?.messages ?? [])
      if (!(await this.readCommittedMessage(chatId, message.id)))
        pendingIds.push(message.id);
    if (
      prepared.some((message, index) =>
        index < pendingIds.length ? message.id !== pendingIds[index] : false,
      )
    ) {
      throw new Error('Finalized messages must follow active transcript order');
    }
    const stagedId = randomUUID();
    await writeJsonValuesCooperatively(
      this.path(chatId, `${stagedId}.append.tmp`),
      prepared,
      {
        pretty: false,
        separator: '\n',
        trailingSeparator: true,
      },
    );
    const pending: ActiveSidecar = {
      version: 1,
      transcriptRevision:
        (before?.transcriptRevision ?? loaded.index.transcriptRevision) + 1,
      updatedAt: new Date().toISOString(),
      messages: [
        ...prepared,
        ...(active?.messages.filter((message) => !ids.has(message.id)) ?? []),
      ],
      finalizing: {
        stagedId,
        byteOffset: loaded.index.committedByteLength,
        messageIds: prepared.map((message) => message.id),
      },
    };
    await writeActiveSidecar(this.path(chatId, 'active.json'), pending);
    await this.onAppendBoundary('prepared');
    await this.finishAppend(chatId, pending);
    const locatorRows: Array<{
      message: PersistedChatMessage;
      offset: number;
      end: number;
    }> = [];
    for (const message of prepared) {
      const offset = loaded.index.committedByteLength;
      const end =
        offset + Buffer.byteLength(JSON.stringify(message), 'utf8') + 1;
      locatorRows.push({ message, offset, end });
      this.record(loaded.index, message, offset, end);
    }
    await this.writeLocators(chatId, locatorRows);
    loaded.locatorStamp = await this.locatorStamp(chatId);
    loaded.index.transcriptRevision = pending.transcriptRevision;
    loaded.index.hasActiveSidecar = pending.messages.length > prepared.length;
    await this.writeIndex(chatId, loaded.index);
    await this.clearFinalized(chatId, pending);
    if (
      prepared.some((message) =>
        message.blocks.some(
          (block) => block.type === 'turn_timer' && block.completedAt != null,
        ),
      )
    )
      await this.turnIndex(chatId, loaded.index);
  }

  /**
   * Staged rows are redundant with the durable active projection until the
   * log is extended. An intent whose staged file cannot be read is abandoned
   * only while the log still ends at the recorded offset; any other failure
   * stays a recovery error.
   */
  private async finishOrAbandonAppend(
    chatId: string,
    pending: ActiveSidecar,
  ): Promise<ActiveSidecar> {
    const intent = pending.finalizing;
    if (!intent) return pending;
    try {
      await this.finishAppend(chatId, pending);
      return pending;
    } catch (error) {
      const size = (await stat(this.path(chatId, 'jsonl'))).size;
      if (size !== intent.byteOffset) throw error;
      const { finalizing: _finalizing, ...settled } = pending;
      void _finalizing;
      await writeActiveSidecar(this.path(chatId, 'active.json'), settled);
      await rm(this.path(chatId, `${intent.stagedId}.append.tmp`), {
        force: true,
      });
      await fsyncDirectory(this.root);
      return settled;
    }
  }

  /** A staged append that no intent references can never be replayed. */
  private async removeOrphanedStagedAppends(
    chatId: string,
    referencedStagedId: string | undefined,
  ): Promise<void> {
    if (this.options.readOnly) return;
    const prefix = `${chatId}.`;
    const suffix = '.append.tmp';
    const referenced =
      referencedStagedId === undefined
        ? undefined
        : `${prefix}${referencedStagedId}${suffix}`;
    let removed = false;
    for await (const entry of await opendir(this.root)) {
      if (
        !entry.isFile() ||
        !entry.name.startsWith(prefix) ||
        !entry.name.endsWith(suffix) ||
        entry.name === referenced
      )
        continue;
      await rm(join(this.root, entry.name), { force: true });
      removed = true;
    }
    if (removed) await fsyncDirectory(this.root);
  }

  /** Replays only a proved prefix of our staged append; unrelated corruption is preserved. */
  private async finishAppend(
    chatId: string,
    pending: ActiveSidecar,
  ): Promise<void> {
    const intent = pending.finalizing;
    if (!intent) return;
    assertTranscriptIdentity(intent.stagedId);
    if (
      !Number.isSafeInteger(intent.byteOffset) ||
      intent.byteOffset < 0 ||
      !Array.isArray(intent.messageIds)
    ) {
      throw new Error('Invalid transcript append intent');
    }
    const stagedPath = this.path(chatId, `${intent.stagedId}.append.tmp`);
    const stagedMessages: PersistedChatMessage[] = [];
    for await (const row of lines(stagedPath)) stagedMessages.push(row.message);
    const finalizing = new Set(intent.messageIds);
    if (
      finalizing.size !== stagedMessages.length ||
      !stagedMessages.every(
        (message, i) =>
          message.id === intent.messageIds[i] &&
          pending.messages.some(
            (candidate) =>
              candidate.id === message.id &&
              digest(candidate) === digest(message),
          ),
      )
    ) {
      throw new Error('Staged append differs from durable active projection');
    }
    const logPath = this.path(chatId, 'jsonl');
    const logHandle = await open(logPath, 'r+');
    try {
      const stagedHandle = await open(stagedPath, 'r');
      try {
        const logLength = (await logHandle.stat()).size;
        const stagedLength = (await stagedHandle.stat()).size;
        if (
          logLength < intent.byteOffset ||
          logLength > intent.byteOffset + stagedLength
        )
          throw new Error('Unexpected transcript append extent');
        if (intent.byteOffset > 0) {
          const boundary = Buffer.alloc(1);
          await logHandle.read(boundary, 0, 1, intent.byteOffset - 1);
          if (boundary[0] !== 10)
            throw new Error('Append intent does not target a message boundary');
        }
        const actual = Buffer.alloc(65_536);
        const expected = Buffer.alloc(65_536);
        for (let offset = 0; offset < logLength - intent.byteOffset; ) {
          const length = Math.min(
            actual.length,
            logLength - intent.byteOffset - offset,
          );
          const a = await logHandle.read(
            actual,
            0,
            length,
            intent.byteOffset + offset,
          );
          const b = await stagedHandle.read(expected, 0, length, offset);
          if (
            a.bytesRead !== length ||
            b.bytesRead !== length ||
            !actual.subarray(0, length).equals(expected.subarray(0, length))
          ) {
            throw new Error('Transcript suffix does not match staged append');
          }
          offset += length;
        }
        // Continue at the exact persisted byte, including a partial UTF-8/JSON
        // token. No accepted bytes are truncated or reconstructed from a preview.
        for (
          let offset = logLength - intent.byteOffset;
          offset < stagedLength;
        ) {
          const { bytesRead } = await stagedHandle.read(
            expected,
            0,
            Math.min(expected.length, stagedLength - offset),
            offset,
          );
          if (bytesRead === 0)
            throw new Error('Unexpected end of staged append');
          let written = 0;
          while (written < bytesRead) {
            const result = await logHandle.write(
              expected,
              written,
              bytesRead - written,
              intent.byteOffset + offset + written,
            );
            if (!result.bytesWritten)
              throw new Error('Transcript append made no progress');
            written += result.bytesWritten;
          }
          offset += bytesRead;
        }
        await logHandle.sync();
        // The log grows by copying the staged bytes it does not hold yet.
        recordChatStorageFileWrite(
          logPath,
          stagedLength - (logLength - intent.byteOffset),
          false,
        );
        recordChatStorageFileSync(logPath);
      } finally {
        await stagedHandle.close();
      }
    } finally {
      await logHandle.close();
    }
    await this.onAppendBoundary('appended');
  }

  /** The committed sparse index and revision must be durable before clearing. */
  private async clearFinalized(
    chatId: string,
    pending: ActiveSidecar,
  ): Promise<void> {
    const intent = pending.finalizing;
    if (!intent) return;
    const finalizing = new Set(intent.messageIds);
    const remaining = pending.messages.filter(
      (message) => !finalizing.has(message.id),
    );
    if (remaining.length) {
      const { finalizing: _finalizing, ...settled } = pending;
      void _finalizing;
      await writeActiveSidecar(this.path(chatId, 'active.json'), {
        ...settled,
        messages: remaining,
      });
    } else {
      await rm(this.path(chatId, 'active.json'), { force: true });
      await fsyncDirectory(this.root);
    }
    await rm(this.path(chatId, `${intent.stagedId}.append.tmp`), {
      force: true,
    });
    await fsyncDirectory(this.root);
  }

  private async persistActive(
    chatId: string,
    loaded: LoadedLog,
    messages: PersistedChatMessage[],
  ): Promise<void> {
    if (messages.length === 0) {
      await rm(this.path(chatId, 'active.json'), { force: true });
      await fsyncDirectory(this.root);
    } else {
      await writeActiveSidecar(this.path(chatId, 'active.json'), {
        version: 1,
        transcriptRevision: loaded.index.transcriptRevision,
        updatedAt: new Date().toISOString(),
        messages,
      } satisfies ActiveSidecar);
    }
    loaded.index.hasActiveSidecar = messages.length > 0;
  }

  private async updateActive(
    chatId: string,
    messages: readonly PersistedChatMessage[],
    allowRemoval: boolean,
  ): Promise<void> {
    this.assertWritable();
    await this.serial(chatId, async () => {
      const loaded = await this.load(chatId);
      const stored: PersistedChatMessage[] = [];
      const ids = new Set<string>();
      for (const message of messages) {
        if (ids.has(message.id)) throw new Error('Duplicate active message');
        ids.add(message.id);
        const next = await this.artifacts.externalize(chatId, message);
        const existing = await this.readCommittedMessage(chatId, next.id);
        if (existing !== undefined) {
          if (digest(existing) !== digest(next))
            throw new Error('Active message conflicts with committed history');
        } else stored.push(next);
      }
      const previous = await this.active(chatId);
      if (!allowRemoval)
        for (const message of previous?.messages ?? [])
          if (
            !ids.has(message.id) &&
            !(await this.readCommittedMessage(chatId, message.id))
          )
            throw new Error(
              'Active transcript replacement would discard an uncommitted message',
            );
      loaded.index.transcriptRevision += 1;
      await this.persistActive(chatId, loaded, stored);
      await this.writeIndex(chatId, loaded.index);
    });
  }

  public async writeActive(
    chatId: string,
    messages: readonly PersistedChatMessage[],
  ): Promise<void> {
    await this.updateActive(chatId, messages, false);
  }

  /** Explicitly replace the mutable sidecar without touching committed rows. */
  public async replaceActive(
    chatId: string,
    messages: readonly PersistedChatMessage[],
  ): Promise<void> {
    await this.updateActive(chatId, messages, true);
  }

  /**
   * A delta-journal checkpoint's single write for a run of journaled active
   * updates: the rows the run left active and the transcript revision its
   * individual writes reached, so the files match those of writing each
   * update in turn. Rows already committed are dropped, as
   * {@link writeActive} drops them; the journal admitted every update
   * against the same history. Idempotent, so a resumed checkpoint may repeat
   * it.
   */
  public async writeActiveAtRevision(
    chatId: string,
    messages: readonly PersistedChatMessage[],
    transcriptRevision: number,
  ): Promise<void> {
    this.assertWritable();
    if (!Number.isSafeInteger(transcriptRevision) || transcriptRevision < 0)
      throw new Error('Invalid transcript revision');
    await this.serial(chatId, async () => {
      const loaded = await this.load(chatId);
      const stored = await this.uncommittedActiveRows(chatId, loaded, messages);
      loaded.index.transcriptRevision = transcriptRevision;
      await this.persistActive(chatId, loaded, stored);
      await this.writeIndex(chatId, loaded.index);
    });
  }

  private async turnIndex(
    chatId: string,
    index: SparseIndex,
    reusable: readonly IndexedTurn[] = [],
  ): Promise<TranscriptTurnIndex> {
    const finishPerformanceStage = beginMainTranscriptPerformanceStage(
      'turn_index',
      chatId,
      { committedRows: index.committedMessageCount },
    );
    let previous: TranscriptTurnIndex | undefined;
    try {
      const stored: unknown = JSON.parse(
        await readFile(this.path(chatId, 'turns.json'), 'utf8'),
      );
      if (isRecord(stored)) {
        const { checksum, ...value } = stored;
        if (
          typeof checksum === 'string' &&
          createHash('sha256').update(JSON.stringify(value)).digest('hex') ===
            checksum &&
          isTranscriptTurnIndex(value)
        )
          previous = value;
      }
    } catch (error) {
      if (
        !(error instanceof SyntaxError) &&
        !(isErrnoException(error) && error.code === 'ENOENT')
      )
        throw error;
    }
    if (
      previous?.committedByteLength === index.committedByteLength &&
      previous.committedMessageCount === index.committedMessageCount
    ) {
      finishPerformanceStage({ reused: 1, turns: previous.turns.length });
      return previous;
    }
    // Appends revisit only the last turn. Replacements remove this derived
    // file before publishing the new log, so equal-size rewrites cannot reuse
    // it; a prefix-preserving replacement passes the turns it cannot change.
    const prefix =
      previous && previous.committedMessageCount < index.committedMessageCount
        ? previous.turns.slice(0, -1)
        : [...reusable];
    const start = prefix[prefix.length - 1]?.end ?? 0;
    const source = this.range(
      chatId,
      index,
      start,
      index.committedMessageCount,
    );
    const artifacts = this.artifacts;
    async function* withCanonicalReceipts(): AsyncGenerator<PersistedChatMessage> {
      for await (const row of source)
        yield await artifacts.hydrateAgentArtifacts(chatId, row);
    }
    const turns = [
      ...prefix,
      ...(await buildTurnIndex(withCanonicalReceipts(), start)),
    ];
    const next: TranscriptTurnIndex = {
      version: 5,
      committedByteLength: index.committedByteLength,
      committedMessageCount: index.committedMessageCount,
      turns,
    };
    if (!this.options.readOnly)
      await atomicJson(this.path(chatId, 'turns.json'), {
        ...next,
        checksum: createHash('sha256')
          .update(JSON.stringify(next))
          .digest('hex'),
      });
    finishPerformanceStage({ rebuilt: 1, turns: next.turns.length });
    return next;
  }

  private async *range(
    chatId: string,
    index: SparseIndex,
    start: number,
    end: number,
  ): AsyncGenerator<PersistedChatMessage> {
    if (start >= end) return;
    const checkpoint = [...index.offsets]
      .reverse()
      .find((entry) => entry.ordinal <= start);
    if (!checkpoint) return;
    let ordinal = checkpoint.ordinal;
    for await (const row of lines(
      this.path(chatId, 'jsonl'),
      checkpoint.offset,
    )) {
      if (ordinal >= start && ordinal < end) yield row.message;
      ordinal += 1;
      if (ordinal >= end) break;
    }
  }

  private async turnPage(
    chatId: string,
    index: SparseIndex,
    active: PersistedChatMessage[],
    before: number | undefined,
    options: TranscriptViewRequest,
    transcriptRevision: number = index.transcriptRevision,
  ): Promise<TranscriptPage> {
    const cached = await this.turnIndex(chatId, index);
    let records = cached.turns;
    // Active messages are already a provider-side projection. Fold only the
    // current committed turn with its active suffix, never all past turns.
    let activeTail: PersistedChatMessage[] | undefined;
    const activeStart = records[records.length - 1]?.start ?? 0;
    if (active.length > 0) {
      activeTail = [];
      for await (const row of this.range(
        chatId,
        index,
        activeStart,
        index.committedMessageCount,
      ))
        activeTail.push(row);
      activeTail.push(...active);
      records = [
        ...records.slice(0, -1),
        ...(await buildTurnIndex(activeTail, activeStart)),
      ];
    }
    const totalMessages = index.committedMessageCount + active.length;
    const owner = options.turnId
      ? records.find((turn) => turn.id === options.turnId)
      : undefined;
    if (options.turnId && !owner) throw new Error('Unknown transcript turn');
    // A turn read without a cursor starts at that turn's own end.
    const end = before ?? owner?.end ?? totalMessages;
    if (!Number.isSafeInteger(end) || end < 0 || end > totalMessages)
      throw new Error('Invalid transcript page cursor');
    if (owner && (end <= owner.start || end > owner.end))
      throw new Error('Invalid turn page cursor');
    const selected = owner
      ? [owner]
      : records.filter((turn) => turn.start < end).slice(-100);
    const historyBefore = selected[0]?.start;
    // Watcher/internal turns continue the preceding human's sticky section.
    // Include that frame even when a page contains only generated follow-ups,
    // without moving the history cursor past the intervening turns.
    if (
      !owner &&
      index.latestHuman &&
      historyBefore !== undefined &&
      index.latestHuman.ordinal < historyBefore
    ) {
      const ordinal = index.latestHuman.ordinal;
      const context = records.find(
        (turn) => turn.start <= ordinal && ordinal < turn.end,
      );
      if (context) selected.unshift(context);
    }
    const ordinals = new Set<number>();
    const turns: TranscriptTurnSummary[] = [];
    for (const turn of selected) {
      const newest = turn === records[records.length - 1];
      const tailStart = owner
        ? Math.max(turn.start, end - TRANSCRIPT_PAGE_SIZE)
        : newest || !turn.complete
          ? Math.max(turn.start, turn.end - 1000)
          : Math.max(turn.start, turn.end - 16);
      const tailEnd = owner ? end : turn.end;
      for (let ordinal = tailStart; ordinal < tailEnd; ordinal += 1)
        ordinals.add(ordinal);
      for (const ordinal of [...turn.frame, ...turn.retained])
        ordinals.add(ordinal);
      let gapEnd = tailStart;
      while (gapEnd > turn.start && ordinals.has(gapEnd - 1)) gapEnd -= 1;
      let gapStart = turn.start;
      while (gapStart < gapEnd && ordinals.has(gapStart)) gapStart += 1;
      turns.push({
        id: turn.id,
        start: turn.start,
        end: turn.end,
        complete: turn.complete,
        summary: turn.summary,
        finalMessageIds: turn.finalMessageIds,
        files: turn.files,
        ...(turn.frameTimer ? { frameTimer: turn.frameTimer } : {}),
        ...(gapEnd > gapStart ? { before: gapEnd } : {}),
      });
    }
    const ordered = Array.from(ordinals).sort((a, b) => a - b);
    const messages: PersistedChatMessage[] = [];
    // Coalesce nearby runs that would seek from the same sparse checkpoint.
    // Otherwise each retained frame/tail reparses that checkpoint's prefix.
    // Large gaps still seek independently; only selected rows are retained.
    for (let i = 0; i < ordered.length; ) {
      const start = ordered[i];
      let end = start + 1;
      while (
        ++i < ordered.length &&
        (ordered[i] === end ||
          Math.floor(ordered[i] / SPARSE_STRIDE) ===
            Math.floor((end - 1) / SPARSE_STRIDE))
      )
        end = ordered[i] + 1;
      if (activeTail && start >= activeStart) {
        for (let ordinal = start; ordinal < end; ordinal += 1)
          if (ordinals.has(ordinal))
            messages.push(activeTail[ordinal - activeStart]);
      } else {
        let ordinal = start;
        for await (const row of this.range(
          chatId,
          index,
          start,
          Math.min(end, index.committedMessageCount),
        )) {
          if (ordinals.has(ordinal)) messages.push(row);
          ordinal += 1;
        }
        for (
          let ordinal = Math.max(start, index.committedMessageCount);
          ordinal < end;
          ordinal += 1
        )
          if (ordinals.has(ordinal))
            messages.push(active[ordinal - index.committedMessageCount]);
      }
    }
    const messageOrdinals = Object.fromEntries(
      messages.map((message, i) => [message.id, ordered[i]]),
    );
    return {
      messages,
      view: 'turns',
      turns,
      totalMessages,
      ...(options.turnId ? { turnId: options.turnId } : {}),
      messageOrdinals,
      transcriptRevision,
      ...(!owner && historyBefore !== undefined && historyBefore > 0
        ? { before: historyBefore }
        : {}),
    };
  }

  private async readPageWithActive(
    chatId: string,
    before?: number,
    options: TranscriptViewRequest = {},
  ): Promise<{
    page: TranscriptPage;
    activeMessages: PersistedChatMessage[];
  }> {
    return this.serial(chatId, async () => {
      const loaded = await this.load(chatId);
      const { index } = loaded;
      const projection = this.projectedActive(chatId);
      const activeMessages = projection
        ? [...projection.messages]
        : ((await this.active(chatId))?.messages ?? []);
      const transcriptRevision =
        projection?.transcriptRevision ?? index.transcriptRevision;
      const active: PersistedChatMessage[] = [];
      for (const message of activeMessages) {
        const existing = await this.committedCopy(chatId, loaded, message.id);
        if (existing === undefined) active.push(message);
        else if (digest(existing) !== digest(message))
          throw new Error('Active message conflicts with committed history');
      }
      if (options.view === 'turns')
        return {
          page: await this.turnPage(
            chatId,
            index,
            active,
            before,
            options,
            transcriptRevision,
          ),
          activeMessages,
        };
      const totalMessages = index.committedMessageCount + active.length;
      const end = before ?? index.committedMessageCount;
      if (
        !Number.isSafeInteger(end) ||
        end < 0 ||
        end > index.committedMessageCount
      )
        throw new Error('Invalid transcript page cursor');
      const start = Math.max(0, end - TRANSCRIPT_PAGE_SIZE);
      let committedPage: CommittedRecentPage;
      if (before === undefined)
        committedPage = await this.committedRecentPage(chatId, index);
      else {
        const messages: PersistedChatMessage[] = [];
        const checkpoint = [...index.offsets]
          .reverse()
          .find((entry) => entry.ordinal <= start);
        if (checkpoint && start < index.committedMessageCount) {
          let ordinal = checkpoint.ordinal;
          for await (const row of lines(
            this.path(chatId, 'jsonl'),
            checkpoint.offset,
          )) {
            if (ordinal >= start && ordinal < end) messages.push(row.message);
            ordinal += 1;
            if (ordinal >= Math.min(end, index.committedMessageCount)) break;
          }
        }
        committedPage = { messages };
      }
      const messages = committedPage.messages;
      if (before === undefined) messages.push(...active);
      let latestHumanMessage =
        [...active].reverse().find(isHumanAuthoredUserMessage) ??
        committedPage.latestHumanMessage;
      if (!latestHumanMessage && index.latestHuman) {
        for await (const row of lines(
          this.path(chatId, 'jsonl'),
          index.latestHuman.offset,
        )) {
          latestHumanMessage = row.message;
          break;
        }
      }
      return {
        page: {
          messages,
          totalMessages,
          transcriptRevision,
          ...(start > 0 ? { before: start } : {}),
          ...(latestHumanMessage &&
          !messages.some((message) => message.id === latestHumanMessage.id)
            ? { latestHumanMessage }
            : {}),
        },
        activeMessages,
      };
    });
  }

  public async page(
    chatId: string,
    before?: number,
    options: TranscriptViewRequest = {},
  ): Promise<TranscriptPage> {
    const finishRangeRead = beginMainTranscriptPerformanceStage(
      'range_read',
      chatId,
    );
    const result = (await this.readPageWithActive(chatId, before, options))
      .page;
    finishRangeRead({ loadedRows: result.messages.length });
    return result;
  }

  public async pageWithActiveMessages(
    chatId: string,
    before?: number,
    options: TranscriptViewRequest = {},
  ): Promise<{
    page: TranscriptPage;
    activeMessages: PersistedChatMessage[];
  }> {
    const finishRangeRead = beginMainTranscriptPerformanceStage(
      'range_read',
      chatId,
    );
    const result = await this.readPageWithActive(chatId, before, options);
    finishRangeRead({ loadedRows: result.page.messages.length });
    return result;
  }

  public async *iterate(chatId: string): AsyncGenerator<PersistedChatMessage> {
    // Caller holds the scope read/export lease to prevent concurrent rewrites.
    await this.load(chatId);
    for await (const row of lines(this.path(chatId, 'jsonl')))
      yield row.message;
  }

  /** Capture only file handles and a verified descriptor under the scope lease.
   * Search parses the immutable committed prefix and active snapshot later.
   * This path does not inventory or rebuild derived message locators when its
   * sparse index is valid.
   */
  /**
   * {@link capturePreview} for a chat whose active rows a delta journal holds
   * ahead of its files: the committed prefix comes from the log, the active
   * rows from the projection, and no active sidecar handle is captured.
   */
  private async captureProjectedPreview(
    chatId: string,
    canonical: TranscriptDescriptor,
    projection: TranscriptActiveProjection,
  ): Promise<CapturedTranscriptPreview> {
    const { index } = await this.load(chatId);
    if (
      canonical.format !== index.format ||
      canonical.committedMessageCount !== index.committedMessageCount ||
      canonical.committedByteLength !== index.committedByteLength ||
      (canonical.committedDigest !== undefined &&
        canonical.committedDigest !== index.committedDigest)
    )
      throw new ChatTranscriptIntegrityError(
        'Transcript preview canonical descriptor mismatch',
      );
    const committedHandle = await open(this.path(chatId, 'jsonl'), 'r');
    let transferred = false;
    try {
      const committed = await capturedPreviewFile(committedHandle);
      if (committed.size !== index.committedByteLength)
        throw new ChatTranscriptIntegrityError(
          'Transcript preview committed length mismatch',
        );
      const hasActiveSidecar = projection.messages.length > 0;
      const descriptor: TranscriptDescriptor = {
        ...canonical,
        format: index.format,
        committedDigest: index.committedDigest,
        committedMessageCount: index.committedMessageCount,
        committedByteLength: index.committedByteLength,
        transcriptRevision: projection.transcriptRevision,
        hasActiveSidecar,
      };
      if (
        canonical.transcriptRevision !== projection.transcriptRevision ||
        canonical.hasActiveSidecar !== hasActiveSidecar
      ) {
        // The caller's descriptor describes another active generation.
        delete descriptor.messageCount;
        delete descriptor.userMessageCount;
        delete descriptor.firstMessageAt;
        delete descriptor.lastMessageAt;
        delete descriptor.lastMessageId;
        delete descriptor.lastMessageRole;
        delete descriptor.lastAssistantPreview;
        delete descriptor.todos;
        delete descriptor.taskTodos;
      }
      transferred = true;
      return new CapturedTranscriptPreview(
        descriptor,
        committed,
        undefined,
        projection.messages,
      );
    } finally {
      if (!transferred) await committedHandle.close();
    }
  }

  public async capturePreview(
    chatId: string,
    canonical: TranscriptDescriptor,
  ): Promise<CapturedTranscriptPreview> {
    return this.serial(chatId, async () => {
      const projection = this.projectedActive(chatId);
      if (projection)
        return this.captureProjectedPreview(chatId, canonical, projection);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let index: MaintenanceCommittedIndex;
        try {
          index = await this.maintenanceCommittedIndex(chatId);
        } catch {
          // A legacy or damaged derived index uses the ordinary recovery path.
          // A valid common-case index never pays for locator inventory here.
          this.loaded.delete(chatId);
          const loaded = await this.load(chatId);
          const candidate = loaded.index;
          index = {
            format: candidate.format,
            committedDigest: candidate.committedDigest,
            committedMessageCount: candidate.committedMessageCount,
            committedByteLength: candidate.committedByteLength,
            transcriptRevision: candidate.transcriptRevision,
            hasActiveSidecar: candidate.hasActiveSidecar,
            messageCount: candidate.messageCount,
            userMessageCount: candidate.userMessageCount,
            firstMessageAt: candidate.firstMessageAt,
            lastMessageAt: candidate.lastMessageAt,
          };
        }
        if (
          canonical.format !== index.format ||
          canonical.committedMessageCount !== index.committedMessageCount ||
          canonical.committedByteLength !== index.committedByteLength ||
          (canonical.committedDigest !== undefined &&
            canonical.committedDigest !== index.committedDigest)
        )
          throw new ChatTranscriptIntegrityError(
            'Transcript preview canonical descriptor mismatch',
          );
        const committedHandle = await open(this.path(chatId, 'jsonl'), 'r');
        let activeHandle: FileHandle | undefined;
        let retryFinalization = false;
        let transferred = false;
        try {
          const committed = await capturedPreviewFile(committedHandle);
          if (committed.size !== index.committedByteLength)
            throw new ChatTranscriptIntegrityError(
              'Transcript preview committed length mismatch',
            );
          try {
            activeHandle = await open(this.path(chatId, 'active.json'), 'r');
          } catch (error) {
            if (!(isErrnoException(error) && error.code === 'ENOENT'))
              throw error;
          }
          if (!!activeHandle !== index.hasActiveSidecar)
            throw new ChatTranscriptIntegrityError(
              'Transcript preview active sidecar mismatch',
            );
          const active = activeHandle
            ? await capturedPreviewFile(activeHandle)
            : undefined;
          if (active) {
            const prefix = Buffer.alloc(1024);
            const { bytesRead } = await active.handle.read(
              prefix,
              0,
              prefix.length,
              0,
            );
            const firstLine = prefix
              .subarray(0, bytesRead)
              .toString('utf8')
              .split('\n')[0];
            const version = /"version"\s*:\s*(\d+)/.exec(firstLine)?.[1];
            if (version === '2') {
              const parsed: unknown = JSON.parse(firstLine);
              if (!isActiveSidecarHeaderV2(parsed))
                throw new ChatTranscriptIntegrityError(
                  'Invalid captured active header',
                );
              if (parsed.transcriptRevision !== index.transcriptRevision)
                throw new ChatTranscriptIntegrityError(
                  'Transcript preview active revision mismatch',
                );
              retryFinalization = !!parsed.finalizing;
            } else if (version === '1' && attempt === 0)
              retryFinalization = true;
            else if (version !== '1')
              throw new ChatTranscriptIntegrityError(
                'Invalid captured active sidecar',
              );
          }
          if (!retryFinalization) {
            const descriptor: TranscriptDescriptor = {
              ...canonical,
              format: index.format,
              committedDigest: index.committedDigest,
              committedMessageCount: index.committedMessageCount,
              committedByteLength: index.committedByteLength,
              transcriptRevision: index.transcriptRevision,
              hasActiveSidecar: index.hasActiveSidecar,
            };
            if (
              canonical.transcriptRevision !== index.transcriptRevision ||
              canonical.hasActiveSidecar !== index.hasActiveSidecar
            ) {
              // An out-of-band active-sidecar replacement can advance the log
              // index before the scope summary. Its optional derived metadata
              // then describes a different active generation.
              delete descriptor.messageCount;
              delete descriptor.userMessageCount;
              delete descriptor.firstMessageAt;
              delete descriptor.lastMessageAt;
              delete descriptor.lastMessageId;
              delete descriptor.lastMessageRole;
              delete descriptor.lastAssistantPreview;
              delete descriptor.todos;
              delete descriptor.taskTodos;
            }
            transferred = true;
            return new CapturedTranscriptPreview(descriptor, committed, active);
          }
        } finally {
          if (!transferred)
            await Promise.all([committedHandle.close(), activeHandle?.close()]);
        }
        this.loaded.delete(chatId);
        await this.load(chatId);
      }
      throw new ChatTranscriptIntegrityError(
        'Transcript preview finalization did not settle',
      );
    });
  }

  /** Cleanup must not invoke load(): missing derived locators can make it
   * rebuild and stream an entire transcript before a nominally bounded slice.
   */
  private async maintenanceCommittedIndex(
    chatId: string,
    expected?: TranscriptDescriptor,
  ): Promise<MaintenanceCommittedIndex> {
    const path = this.path(chatId, 'index.json');
    const before = await fileIdentity(path);
    if (before.bytes < 1 || before.bytes > MAX_MAINTENANCE_INDEX_BYTES)
      throw new Error('Artifact maintenance index exceeds size limit');
    let cached = maintenanceIndexCache.get(path);
    if (cached?.stamp !== before.stamp) {
      maintenanceIndexCache.delete(path);
      const handle = await open(path, 'r');
      try {
        if (fileStatStamp(await handle.stat({ bigint: true })) !== before.stamp)
          throw new Error('Artifact maintenance index changed during read');
        const bytes = Buffer.alloc(before.bytes);
        let read = 0;
        while (read < bytes.length) {
          const result = await handle.read(
            bytes,
            read,
            bytes.length - read,
            read,
          );
          if (result.bytesRead === 0)
            throw new Error('Artifact maintenance index changed during read');
          read += result.bytesRead;
        }
        if (
          fileStatStamp(await handle.stat({ bigint: true })) !== before.stamp ||
          (await fileIdentity(path)).stamp !== before.stamp
        )
          throw new Error('Artifact maintenance index changed during read');
        const parsed: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        );
        if (!isSparseIndexWithChecksum(parsed))
          throw new Error('Invalid artifact maintenance index');
        const { checksum, ...candidate } = parsed;
        if (
          checksum !== indexChecksum(candidate) ||
          candidate.committedMessageCount < 0 ||
          candidate.committedByteLength < 0
        )
          throw new Error('Invalid artifact maintenance index');
        cached = {
          stamp: before.stamp,
          index: {
            format: candidate.format,
            committedDigest: candidate.committedDigest,
            committedMessageCount: candidate.committedMessageCount,
            committedByteLength: candidate.committedByteLength,
            transcriptRevision: candidate.transcriptRevision,
            hasActiveSidecar: candidate.hasActiveSidecar,
            messageCount: candidate.messageCount,
            userMessageCount: candidate.userMessageCount,
            firstMessageAt: candidate.firstMessageAt,
            lastMessageAt: candidate.lastMessageAt,
          },
        };
        maintenanceIndexCache.set(path, cached);
        while (maintenanceIndexCache.size > 8) {
          const oldest = maintenanceIndexCache.keys().next().value;
          if (oldest === undefined) break;
          maintenanceIndexCache.delete(oldest);
        }
      } finally {
        await handle.close();
      }
    }
    if (!cached) throw new Error('Invalid artifact maintenance index');
    const index = cached.index;
    if (
      expected &&
      (expected.format !== index.format ||
        expected.committedDigest !== index.committedDigest ||
        expected.committedMessageCount !== index.committedMessageCount ||
        expected.committedByteLength !== index.committedByteLength)
    )
      throw new Error('Artifact maintenance canonical descriptor mismatch');
    const log = await fileIdentity(this.path(chatId, 'jsonl'));
    if (log.bytes !== index.committedByteLength)
      throw new ChatTranscriptIntegrityError(
        'Artifact maintenance committed transcript length mismatch',
      );
    return index;
  }

  /** A bounded, row-aligned maintenance read. The caller owns the scope lease. */
  public async artifactReferenceSlice(
    chatId: string,
    offset: number,
    maxBytes: number,
    expected?: TranscriptDescriptor,
  ): Promise<ArtifactReferenceSlice> {
    return this.serial(chatId, async () => {
      const index = await this.maintenanceCommittedIndex(chatId, expected);
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > index.committedByteLength ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 ||
        maxBytes > 1024 * 1024
      )
        throw new Error('Invalid artifact reference scan cursor');
      const path = this.path(chatId, 'jsonl');
      const before = await fileIdentity(path);
      const identity = `${index.committedDigest}:${index.committedMessageCount}:${index.committedByteLength}:${before.stamp}`;
      let nextOffset = offset;
      let scannedBytes = 0;
      const artifactIds: string[] = [];
      if (offset < index.committedByteLength)
        for await (const row of lines(path, offset)) {
          if (row.end > index.committedByteLength)
            throw new Error('Artifact scan crossed committed transcript');
          nextOffset = row.end;
          scannedBytes += row.end - row.offset;
          for (const block of row.message.blocks)
            artifactIds.push(...artifactIdsForBlock(block));
          if (scannedBytes >= maxBytes) break;
        }
      const after = await fileIdentity(path);
      if (before.stamp !== after.stamp)
        throw new Error('Committed transcript changed during artifact scan');
      if (nextOffset === offset && offset < index.committedByteLength)
        throw new Error('Artifact scan did not advance');
      return {
        identity,
        nextOffset,
        complete: nextOffset === index.committedByteLength,
        scannedBytes,
        artifactIds,
      };
    });
  }

  /** Bound the mutable sidecar pass as well as the committed-prefix pass. */
  public async artifactActiveReferenceSlice(
    chatId: string,
    offset: number,
    maxBytes: number,
  ): Promise<ArtifactReferenceSlice> {
    return this.serial(chatId, async () => {
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 ||
        maxBytes > 1024 * 1024
      )
        throw new Error('Invalid active artifact scan cursor');
      const path = this.path(chatId, 'active.json');
      let before: Awaited<ReturnType<typeof fileIdentity>>;
      try {
        before = await fileIdentity(path);
      } catch (error) {
        if (!(isErrnoException(error) && error.code === 'ENOENT')) throw error;
        if (offset !== 0)
          throw new Error('Active transcript changed during artifact scan');
        return {
          identity: 'absent',
          nextOffset: 0,
          complete: true,
          scannedBytes: 0,
          artifactIds: [],
        };
      }
      if (offset > before.bytes)
        throw new Error('Active artifact scan crossed sidecar length');
      const prefix = Buffer.alloc(1024);
      const handle = await open(path, 'r');
      let bytesRead = 0;
      try {
        ({ bytesRead } = await handle.read(prefix, 0, prefix.length, 0));
      } finally {
        await handle.close();
      }
      const match = /"version"\s*:\s*(\d+)/.exec(
        prefix.subarray(0, bytesRead).toString('utf8'),
      );
      const version = match ? Number(match[1]) : undefined;
      const artifactIds: string[] = [];
      let nextOffset = offset;
      let scannedBytes = 0;
      let activeHeaderFinalizing: boolean | undefined;
      let activeFinalizingRows = 0;
      if (version === 1) {
        // Rolling-upgrade sidecars use an object/array format. A larger legacy
        // sidecar waits for the next canonical write to replace it with v2.
        if (offset !== 0 || before.bytes > maxBytes)
          throw new Error(
            'Large legacy active sidecar defers artifact cleanup',
          );
        const legacy = await readLegacyActiveSidecar(path);
        if (!isActiveSidecar(legacy))
          throw new Error('Invalid active transcript sidecar');
        for (const message of legacy.messages)
          for (const block of message.blocks)
            artifactIds.push(...artifactIdsForBlock(block));
        nextOffset = before.bytes;
        scannedBytes = before.bytes;
      } else if (version === 2) {
        if (offset < before.bytes)
          for await (const row of activeRowsWithOffsets(path, offset)) {
            if (row.end > before.bytes)
              throw new Error('Active artifact scan crossed sidecar length');
            if (row.offset === 0) {
              if (!isActiveSidecarHeaderV2(row.value))
                throw new Error('Invalid active transcript sidecar header');
              activeHeaderFinalizing = !!row.value.finalizing;
            } else {
              if (!isActiveSidecarMessageV2(row.value))
                throw new Error('Invalid active transcript sidecar message');
              if (row.value.finalizing) activeFinalizingRows += 1;
              for (const block of row.value.message.blocks)
                artifactIds.push(...artifactIdsForBlock(block));
            }
            nextOffset = row.end;
            scannedBytes += row.end - row.offset;
            if (scannedBytes >= maxBytes) break;
          }
      } else throw new Error('Invalid active transcript sidecar');
      const after = await fileIdentity(path);
      if (before.stamp !== after.stamp)
        throw new Error('Active transcript changed during artifact scan');
      if (nextOffset === offset && offset < before.bytes)
        throw new Error('Active artifact scan did not advance');
      return {
        identity: before.stamp,
        nextOffset,
        complete: nextOffset === before.bytes,
        scannedBytes,
        artifactIds,
        ...(activeHeaderFinalizing !== undefined
          ? { activeHeaderFinalizing }
          : {}),
        activeFinalizingRows,
      };
    });
  }

  /** Descriptor plus inode identity; verify again immediately before unlink. */
  public async artifactReferenceIdentity(
    chatId: string,
    expected?: TranscriptDescriptor,
  ): Promise<string> {
    return this.serial(chatId, async () => {
      const index = await this.maintenanceCommittedIndex(chatId, expected);
      const committed = await fileIdentity(this.path(chatId, 'jsonl'));
      let active = 'absent';
      try {
        active = (await fileIdentity(this.path(chatId, 'active.json'))).stamp;
      } catch (error) {
        if (!(isErrnoException(error) && error.code === 'ENOENT')) throw error;
      }
      return `${index.committedDigest}:${index.committedMessageCount}:${index.committedByteLength}:${committed.stamp}:${active}`;
    });
  }
}
