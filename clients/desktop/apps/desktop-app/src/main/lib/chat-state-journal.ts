import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { flushDirectory } from '@canopy/core-platform/directory-flush';
import type { ChatJournalRecord } from '@canopy/desktop-shared/types';
import { getChatJournalQuarantineFilePath } from './paths';
import { writePrettyJsonCooperatively } from './chat-tabs';
import { writeJsonValuesCooperatively } from './cooperative-json';
import { isErrnoException } from './type-guards';

export interface ChatJournalDiagnostic {
  kind:
    | 'partial_tail'
    | 'malformed_record'
    | 'advisory_threshold_exceeded'
    | 'repaired_snapshot'
    | 'regressed_snapshot'
    | 'unrecoverable_snapshot'
    | 'unrecoverable_journal';
  message: string;
  quarantinePath?: string;
}

export interface ChatJournalReadResult {
  records: ChatJournalRecord[];
  diagnostics: ChatJournalDiagnostic[];
  byteLength: number;
  stats: ChatJournalReadStats;
}

export interface ChatJournalReadStats {
  recordCount: number;
  totalRecordBytes: number;
  maxRecordBytes: number;
  meanRecordBytes: number;
}

export interface ChatJournalAdvisoryThresholds {
  /** Advisory only. Complete valid records must remain lossless above it. */
  maxRecordBytes?: number;
  /** Advisory only. Complete valid mutations must remain lossless above it. */
  maxMutationBytes?: number;
  /** Advisory only. Complete valid mutation lists must remain lossless above it. */
  maxMutationsPerRecord?: number;
}

export const CHAT_JOURNAL_ADVISORY_RECORD_BYTES = 64 * 1024 * 1024;
export const CHAT_JOURNAL_ADVISORY_MUTATION_BYTES = 60 * 1024 * 1024;
export const CHAT_JOURNAL_ADVISORY_MUTATIONS_PER_RECORD = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const JOURNAL_SOURCES = new Set([
  'renderer-command',
  'provider',
  'terminal',
  'automation',
  'portal',
  'hook',
  'import',
  'migration',
]);

export function isChatJournalRecord(
  value: unknown,
): value is ChatJournalRecord {
  return (
    isRecord(value) &&
    value.v === 1 &&
    typeof value.revision === 'number' &&
    Number.isSafeInteger(value.revision) &&
    value.revision > 0 &&
    typeof value.mutationId === 'string' &&
    value.mutationId.length > 0 &&
    typeof value.occurredAt === 'string' &&
    typeof value.source === 'string' &&
    JOURNAL_SOURCES.has(value.source) &&
    Array.isArray(value.mutations) &&
    value.mutations.length > 0
  );
}

async function truncateAndSync(
  filePath: string,
  length: number,
): Promise<void> {
  const handle = await open(filePath, 'r+');
  try {
    await handle.truncate(length);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function advisoryThresholds(options: ChatJournalAdvisoryThresholds): {
  maxRecordBytes: number;
  maxMutationBytes: number;
  maxMutationsPerRecord: number;
} {
  return {
    maxRecordBytes: positiveLimit(
      options.maxRecordBytes,
      CHAT_JOURNAL_ADVISORY_RECORD_BYTES,
    ),
    maxMutationBytes: positiveLimit(
      options.maxMutationBytes,
      CHAT_JOURNAL_ADVISORY_MUTATION_BYTES,
    ),
    maxMutationsPerRecord: positiveLimit(
      options.maxMutationsPerRecord,
      CHAT_JOURNAL_ADVISORY_MUTATIONS_PER_RECORD,
    ),
  };
}

function exceedsAdvisoryThreshold(
  record: ChatJournalRecord,
  recordBytes: number,
  options: ChatJournalAdvisoryThresholds = {},
): boolean {
  const limits = advisoryThresholds(options);
  if (record.mutations.length > limits.maxMutationsPerRecord) {
    return true;
  }
  // The encoded record size is an upper bound for every encoded mutation.
  // Using the smaller byte threshold may conservatively report a large record,
  // but avoids synchronously reserializing transcript-bearing mutations on the
  // Electron main event loop during recovery.
  return (
    recordBytes > limits.maxRecordBytes || recordBytes > limits.maxMutationBytes
  );
}

async function quarantineJournalSuffix(
  journalPath: string,
  quarantinePath: string,
  start: number,
): Promise<void> {
  await mkdir(dirname(quarantinePath), { recursive: true });
  await pipeline(
    createReadStream(journalPath, { start }),
    createWriteStream(quarantinePath, { flags: 'w' }),
  );
}

export async function readChatJournal(
  journalPath: string,
  options: ChatJournalAdvisoryThresholds = {},
): Promise<ChatJournalReadResult> {
  const records: ChatJournalRecord[] = [];
  const diagnostics: ChatJournalDiagnostic[] = [];
  const lineChunks: Uint8Array[] = [];
  let lineBytes = 0;
  let lineStart = 0;
  let bytesRead = 0;
  let totalRecordBytes = 0;
  let maxObservedRecordBytes = 0;
  let advisoryThresholdExceededCount = 0;
  let malformed:
    | { offset: number; error: unknown; quarantinePath: string }
    | undefined;

  const stream = createReadStream(journalPath);
  try {
    outer: for await (const rawChunk of stream) {
      const chunk = Buffer.isBuffer(rawChunk)
        ? rawChunk
        : Buffer.from(rawChunk);
      let segmentStart = 0;
      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk[index] !== 0x0a) continue;
        const segment = chunk.subarray(segmentStart, index);
        const recordBytes = lineBytes + segment.byteLength;
        const line =
          lineChunks.length === 0
            ? segment
            : Buffer.concat([...lineChunks, segment], recordBytes);
        const raw = line.toString('utf8').trim();
        if (raw.length > 0) {
          try {
            const parsed: unknown = JSON.parse(raw);
            if (!isChatJournalRecord(parsed)) {
              throw new Error('record does not match ChatJournalRecord v1');
            }
            if (exceedsAdvisoryThreshold(parsed, recordBytes, options)) {
              advisoryThresholdExceededCount += 1;
            }
            records.push(parsed);
            totalRecordBytes += recordBytes;
            maxObservedRecordBytes = Math.max(
              maxObservedRecordBytes,
              recordBytes,
            );
          } catch (error) {
            malformed = {
              offset: lineStart,
              error,
              quarantinePath: getChatJournalQuarantineFilePath(journalPath),
            };
            break outer;
          }
        }
        lineChunks.length = 0;
        lineBytes = 0;
        lineStart = bytesRead + index + 1;
        segmentStart = index + 1;
      }
      if (segmentStart < chunk.length) {
        const remainder = chunk.subarray(segmentStart);
        lineChunks.push(remainder);
        lineBytes += remainder.byteLength;
      }
      bytesRead += chunk.byteLength;
    }
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return {
        records: [],
        diagnostics: [],
        byteLength: 0,
        stats: {
          recordCount: 0,
          totalRecordBytes: 0,
          maxRecordBytes: 0,
          meanRecordBytes: 0,
        },
      };
    }
    throw error;
  }

  if (malformed) {
    await quarantineJournalSuffix(
      journalPath,
      malformed.quarantinePath,
      malformed.offset,
    );
    await truncateAndSync(journalPath, malformed.offset);
    diagnostics.push({
      kind: 'malformed_record',
      message: `Quarantined malformed journal data at byte ${malformed.offset}: ${String(malformed.error)}`,
      quarantinePath: malformed.quarantinePath,
    });
  } else if (lineBytes > 0) {
    await truncateAndSync(journalPath, lineStart);
    diagnostics.push({
      kind: 'partial_tail',
      message: `Truncated incomplete final journal line at byte ${lineStart}`,
    });
  }

  if (advisoryThresholdExceededCount > 0) {
    diagnostics.push({
      kind: 'advisory_threshold_exceeded',
      message: `${advisoryThresholdExceededCount} complete chat journal record${advisoryThresholdExceededCount === 1 ? '' : 's'} exceeded an advisory size threshold and were recovered losslessly`,
    });
  }

  const recordCount = records.length;
  return {
    records,
    diagnostics,
    byteLength: lineStart,
    stats: {
      recordCount,
      totalRecordBytes,
      maxRecordBytes: maxObservedRecordBytes,
      meanRecordBytes: recordCount > 0 ? totalRecordBytes / recordCount : 0,
    },
  };
}

export async function appendChatJournalRecord(
  journalPath: string,
  record: ChatJournalRecord,
  options: ChatJournalAdvisoryThresholds = {},
): Promise<number> {
  if (!isChatJournalRecord(record)) {
    throw new Error('Refusing to append an invalid chat journal record');
  }
  // Thresholds are intentionally advisory in the rollback-safe v1 format.
  // Rejecting a complete transcript-bearing mutation here would discard the
  // only durable copy of provider output. Phase 2 removes that pressure by
  // offloading large tool output and storing one complete message per record.
  void options;
  await mkdir(dirname(journalPath), { recursive: true });
  let createdJournal = false;
  try {
    await stat(journalPath);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
    createdJournal = true;
  }
  const bytesWritten = await writeJsonValuesCooperatively(
    journalPath,
    [record],
    {
      pretty: false,
      separator: '\n',
      trailingSeparator: true,
      append: true,
    },
  );
  if (createdJournal) {
    await fsyncDirectory(dirname(journalPath));
  }
  return bytesWritten;
}

export async function replaceChatJournal(
  journalPath: string,
  records: readonly ChatJournalRecord[],
  options: { shouldAbort?: () => boolean } & ChatJournalAdvisoryThresholds = {},
): Promise<void> {
  await mkdir(dirname(journalPath), { recursive: true });
  const tempPath = join(
    dirname(journalPath),
    `.${basename(journalPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await writeJsonValuesCooperatively(tempPath, records, {
      pretty: false,
      separator: '\n',
      trailingSeparator: true,
      shouldAbort: options.shouldAbort,
    });
    await rename(tempPath, journalPath);
    await fsyncDirectory(dirname(journalPath));
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeSyncedJsonTemp(
  targetPath: string,
  value: unknown,
  options: { shouldAbort?: () => boolean } = {},
): Promise<string> {
  await mkdir(dirname(targetPath), { recursive: true });
  const tempPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${process.pid}.${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.tmp`,
  );
  try {
    await writePrettyJsonCooperatively(tempPath, value, options.shouldAbort);
    return tempPath;
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function restoreSnapshotPrimary(
  targetPath: string,
  value: unknown,
): Promise<void> {
  const tempPath = await writeSyncedJsonTemp(targetPath, value);
  await rename(tempPath, targetPath);
  await fsyncDirectory(dirname(targetPath));
}

export async function replaceSnapshotWithBackup(
  tempPath: string,
  targetPath: string,
  backupPath: string,
): Promise<void> {
  await rm(backupPath, { force: true });
  try {
    await rename(targetPath, backupPath);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') throw error;
  }
  await rename(tempPath, targetPath);
}

/** The shared D1 directory flush, without the chat-storage work counter. */
export async function fsyncDirectory(directoryPath: string): Promise<void> {
  await flushDirectory(directoryPath);
}

export async function preserveSnapshotConflict(
  sourcePath: string,
  conflictPath: string,
): Promise<void> {
  await mkdir(dirname(conflictPath), { recursive: true });
  await copyFile(sourcePath, conflictPath);
}

export async function fileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return 0;
    throw error;
  }
}
