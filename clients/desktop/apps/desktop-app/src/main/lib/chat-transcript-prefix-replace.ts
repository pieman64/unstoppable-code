import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  opendir,
  readFile,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PersistedChatMessage } from '@canopy/agent-transcript/types';
import {
  isTranscriptTurnIndex,
  type IndexedTurn,
} from './chat-transcript-turn-index';
import { iterateAsync, writeJsonValuesCooperatively } from './cooperative-json';
import { fsyncDirectory } from './fsync-directory';
import { isPersistedChatMessage } from './persisted-chat-message-validation';
import { isErrnoException, isRecord } from './type-guards';
import { recordChatStorageFileWrite } from '@canopy/desktop-shared/node/work-counters';

/** Rows are bounded on the write side so a stored row can always be read back. */
export const MAX_TRANSCRIPT_ROW_BYTES = 16 * 1024 * 1024;
const LOCATOR_BATCH = 64;
const YIELD_BYTES = 1024 * 1024;

/** The committed log a verified sparse index describes. */
export interface CommittedLogIdentity {
  committedDigest: string;
  committedMessageCount: number;
  committedByteLength: number;
}

export interface SharedPrefixReplaceOptions {
  logPath: string;
  indexPath: string;
  turnsPath: string;
  /** Fresh `<chatId>.<uuid>.rewrite.tmp` path beside the log. */
  temporaryPath: string;
  locatorDirectory: string;
  messages:
    | Iterable<PersistedChatMessage>
    | AsyncIterable<PersistedChatMessage>;
  externalize: (message: PersistedChatMessage) => Promise<PersistedChatMessage>;
  /** Folds one replacement row, in order, into the caller's fresh index. */
  record: (
    message: PersistedChatMessage,
    offset: number,
    end: number,
    rowDigest: string,
  ) => void | Promise<void>;
  /**
   * The caller's cached index when its locator inventory is known complete
   * and the directory stamp is unchanged; otherwise the inventory is counted.
   */
  verifiedIndex: CommittedLogIdentity | undefined;
}

export type SharedPrefixReplaceMode = 'identical' | 'append' | 'rewrite';

export type SharedPrefixReplaceResult =
  | {
      /** No trusted baseline or no shared first row: nothing was recorded. */
      kind: 'full';
      messages:
        | Iterable<PersistedChatMessage>
        | AsyncIterable<PersistedChatMessage>;
    }
  | {
      kind: 'preserved';
      /** JSONL bytes serialized into the suffix; cloned prefix bytes excluded. */
      bytesWritten: number;
      mode: SharedPrefixReplaceMode;
      prefixRows: number;
      suffixRows: number;
      locatorWrites: number;
      locatorRemovals: number;
      /** Turns of the previous turn index that the replacement cannot change. */
      reusableTurns: IndexedTurn[];
    };

interface RawRow {
  bytes: Buffer;
  offset: number;
  end: number;
}

interface PendingRow {
  original: PersistedChatMessage;
  stored: PersistedChatMessage;
  json: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function locatorName(messageId: string): string {
  return `${sha256(messageId)}.json`;
}

/** Same field order as the log's `MessageLocator` writes. */
function locatorContent(
  messageId: string,
  offset: number,
  end: number,
  rowDigest: string,
): string {
  return JSON.stringify({
    version: 1,
    messageId,
    offset,
    end,
    digest: rowDigest,
  });
}

function sameRow(bytes: Buffer, json: string): boolean {
  return (
    bytes.length === Buffer.byteLength(json, 'utf8') &&
    bytes.equals(Buffer.from(json, 'utf8'))
  );
}

function parseRow(bytes: Buffer): PersistedChatMessage {
  const value: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  );
  if (!isPersistedChatMessage(value))
    throw new Error('Invalid complete transcript message');
  return value;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Undecoded rows (without their newline); only one row is held at a time. */
async function* rawRows(path: string, start = 0): AsyncGenerator<RawRow> {
  const chunks: AsyncIterable<unknown> = createReadStream(path, { start });
  let offset = start;
  let pending: Buffer[] = [];
  let length = 0;
  for await (const chunk of chunks) {
    if (!Buffer.isBuffer(chunk))
      throw new Error('Transcript stream must contain bytes');
    let begin = 0;
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
      const end = offset + bytes.length + 1;
      yield { bytes, offset, end };
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
  if (length > 0)
    throw new Error(`Incomplete transcript tail at byte ${offset}`);
}

/** An operating-system I/O failure stays an error; bad bytes do not. */
function isSystemError(error: unknown): boolean {
  return isErrnoException(error) && typeof error.syscall === 'string';
}

function isMissingOrMalformed(error: unknown): boolean {
  return (
    error instanceof SyntaxError ||
    (isErrnoException(error) && error.code === 'ENOENT')
  );
}

async function locatorInventoryComplete(
  directory: string,
  expected: number,
): Promise<boolean> {
  let count = 0;
  try {
    for await (const entry of await opendir(directory)) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name))
        return false;
      if (++count > expected) return false;
    }
    return count === expected;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * A prefix can be preserved only when the checksummed sparse index describes
 * exactly the current log and every committed row has a locator. Anything
 * else (a crash inside an earlier rewrite or append, a missing or legacy
 * index, an incomplete inventory) uses the full replacement.
 */
async function trustedBaseline(
  options: SharedPrefixReplaceOptions,
): Promise<CommittedLogIdentity | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(options.indexPath, 'utf8'));
  } catch (error) {
    if (isMissingOrMalformed(error)) return undefined;
    throw error;
  }
  if (!isRecord(parsed)) return undefined;
  const { checksum, ...candidate } = parsed;
  const committedDigest = candidate.committedDigest;
  const committedMessageCount = candidate.committedMessageCount;
  const committedByteLength = candidate.committedByteLength;
  if (
    candidate.version !== 3 ||
    candidate.format !== 'complete-message-jsonl-v1' ||
    typeof checksum !== 'string' ||
    checksum !== sha256(JSON.stringify(candidate)) ||
    typeof committedDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(committedDigest) ||
    typeof committedMessageCount !== 'number' ||
    !Number.isSafeInteger(committedMessageCount) ||
    committedMessageCount < 1 ||
    typeof committedByteLength !== 'number' ||
    !Number.isSafeInteger(committedByteLength) ||
    committedByteLength < 1
  )
    return undefined;
  let size: number;
  try {
    size = (await stat(options.logPath)).size;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (size !== committedByteLength) return undefined;
  const identity: CommittedLogIdentity = {
    committedDigest,
    committedMessageCount,
    committedByteLength,
  };
  const verified = options.verifiedIndex;
  if (
    verified?.committedDigest === committedDigest &&
    verified.committedMessageCount === committedMessageCount &&
    verified.committedByteLength === committedByteLength
  )
    return identity;
  return (await locatorInventoryComplete(
    options.locatorDirectory,
    committedMessageCount,
  ))
    ? identity
    : undefined;
}

/**
 * Turns split only at user boundary rows, and each turn's projection depends
 * only on its own rows and on whether a turn follows. A previously indexed
 * turn that is not the index's last turn and ends before the last preserved
 * row is therefore identical in the replacement.
 */
async function reusablePriorTurns(
  turnsPath: string,
  baseline: CommittedLogIdentity,
  prefixRows: number,
): Promise<IndexedTurn[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(turnsPath, 'utf8'));
  } catch (error) {
    if (isMissingOrMalformed(error)) return [];
    throw error;
  }
  if (!isRecord(parsed)) return [];
  const { checksum, ...value } = parsed;
  if (
    typeof checksum !== 'string' ||
    checksum !== sha256(JSON.stringify(value)) ||
    !isTranscriptTurnIndex(value) ||
    value.committedMessageCount > baseline.committedMessageCount ||
    value.committedByteLength > baseline.committedByteLength
  )
    return [];
  const reusable: IndexedTurn[] = [];
  for (const turn of value.turns.slice(0, -1)) {
    if (turn.end >= prefixRows) break;
    reusable.push(turn);
  }
  return reusable;
}

async function settleBatch(work: Array<Promise<unknown>>): Promise<void> {
  const results = await Promise.allSettled(work);
  for (const result of results)
    if (result.status === 'rejected') throw result.reason;
}

/** Bounded batches; a name collision means the inventory was not as trusted. */
async function createLocators(
  directory: string,
  entries: ReadonlyArray<readonly [string, string]>,
): Promise<'created' | 'collision'> {
  for (let start = 0; start < entries.length; start += LOCATOR_BATCH) {
    const results = await Promise.allSettled(
      entries
        .slice(start, start + LOCATOR_BATCH)
        .map(async ([name, content]) => {
          const path = join(directory, name);
          await writeFile(path, content, {
            mode: 0o600,
            flag: 'wx',
          });
          try {
            recordChatStorageFileWrite(
              path,
              Buffer.byteLength(content, 'utf8'),
              true,
            );
          } catch {
            // A counter failure must not turn a successful locator write into an error.
          }
        }),
    );
    let collision = false;
    for (const result of results) {
      if (result.status === 'fulfilled') continue;
      if (isErrnoException(result.reason) && result.reason.code === 'EEXIST')
        collision = true;
      else throw result.reason;
    }
    if (collision) return 'collision';
  }
  return 'created';
}

/** Rebuild the complete inventory from the published log, as `load` does. */
async function rebuildLocators(
  logPath: string,
  directory: string,
): Promise<number> {
  const temporary = `${directory}.${randomUUID()}.tmp`;
  let renamed = false;
  let written = 0;
  await mkdir(temporary, { recursive: true });
  try {
    let batch: Array<readonly [string, string]> = [];
    for await (const row of rawRows(logPath)) {
      const message = parseRow(row.bytes);
      batch.push([
        locatorName(message.id),
        locatorContent(
          message.id,
          row.offset,
          row.end,
          sha256(JSON.stringify(message)),
        ),
      ]);
      if (batch.length === LOCATOR_BATCH) {
        if ((await createLocators(temporary, batch)) === 'collision')
          throw new Error('Invalid or duplicate committed message');
        written += batch.length;
        batch = [];
      }
    }
    if ((await createLocators(temporary, batch)) === 'collision')
      throw new Error('Invalid or duplicate committed message');
    written += batch.length;
    await fsyncDirectory(temporary);
    await mkdir(dirname(directory), { recursive: true });
    await rm(directory, { recursive: true, force: true });
    await rename(temporary, directory);
    renamed = true;
    await fsyncDirectory(dirname(directory));
  } finally {
    if (!renamed) await rm(temporary, { recursive: true, force: true });
  }
  return written;
}

async function* resumeAfter(
  first: PersistedChatMessage,
  rest: AsyncGenerator<PersistedChatMessage>,
): AsyncGenerator<PersistedChatMessage> {
  let finished = false;
  try {
    yield first;
    for (;;) {
      const next = await rest.next();
      if (next.done) {
        finished = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!finished) await rest.return(undefined);
  }
}

/**
 * Replace a committed log in time proportional to its changed suffix.
 *
 * The old JSONL is streamed beside the replacement rows. A replacement row
 * extends the shared prefix only while its serialized bytes equal the old row
 * at the same offset, so the prefix has the same ids, rows, row digests and
 * offsets. Prefix rows whose raw serialization already equals the committed
 * bytes are in stored form and skip externalization (and its artifact
 * re-verification); every other row is externalized as before.
 *
 * A changed log (append or rewrite) is a copy-on-write clone of the old log,
 * truncated to the prefix, plus the serialized suffix, atomically renamed
 * into place: a crash leaves either the old or the new log.
 *
 * Publication order matches the full replacement: the sparse and turn
 * indexes are removed first and the caller publishes them last, so an
 * interrupted call leaves no trusted index and the next load or transaction
 * replay rebuilds from JSONL. Changed locators are unlinked before their
 * replacements are created with `wx`, so a durable locator is current,
 * missing or torn, never stale and well-formed.
 */
export async function replaceSharedPrefix(
  options: SharedPrefixReplaceOptions,
): Promise<SharedPrefixReplaceResult> {
  const baseline = await trustedBaseline(options);
  if (!baseline) return { kind: 'full', messages: options.messages };
  const root = dirname(options.logPath);
  const incoming = iterateAsync(options.messages);
  const old = rawRows(options.logPath);
  const ids = new Set<string>();
  let prefixRows = 0;
  let prefixEnd = 0;
  let pending: PendingRow | undefined;
  let oldRemains = false;
  let oldBroken = false;
  let delegated = false;
  let consumed = false;
  try {
    let sinceYield = 0;
    for (;;) {
      const next = await incoming.next();
      if (next.done) {
        consumed = true;
        oldRemains = prefixEnd < baseline.committedByteLength;
        break;
      }
      const original = next.value;
      let oldRow: RawRow | undefined;
      if (!oldBroken && prefixEnd < baseline.committedByteLength) {
        try {
          const row = await old.next();
          oldRow = row.done ? undefined : row.value;
        } catch (error) {
          if (isSystemError(error)) throw error;
          oldBroken = true;
        }
      }
      let stored = original;
      let json = JSON.stringify(original);
      let same = oldRow !== undefined && sameRow(oldRow.bytes, json);
      if (!same) {
        stored = await options.externalize(original);
        json = JSON.stringify(stored);
        same = oldRow !== undefined && sameRow(oldRow.bytes, json);
      }
      if (!oldRow || !same) {
        pending = { original, stored, json };
        oldRemains = prefixEnd < baseline.committedByteLength;
        break;
      }
      if (!isPersistedChatMessage(stored) || ids.has(stored.id))
        throw new Error('Invalid or duplicate replacement message');
      ids.add(stored.id);
      // Only a paged row's record reads its pages; others stay synchronous.
      const recorded = options.record(
        stored,
        oldRow.offset,
        oldRow.end,
        sha256(json),
      );
      if (recorded) await recorded;
      prefixRows += 1;
      prefixEnd = oldRow.end;
      sinceYield += oldRow.bytes.length;
      if (sinceYield >= YIELD_BYTES) {
        sinceYield = 0;
        await yieldToEventLoop();
      }
    }
    if (prefixRows === 0) {
      delegated = true;
      return {
        kind: 'full',
        messages: pending ? resumeAfter(pending.original, incoming) : [],
      };
    }
  } finally {
    await old.return(undefined);
    if (!delegated && !consumed && !pending) await incoming.return(undefined);
  }

  const mode: SharedPrefixReplaceMode = oldRemains
    ? 'rewrite'
    : pending
      ? 'append'
      : 'identical';
  const suffixIds = new Set<string>();
  const suffixLocators = new Map<string, string>();
  let offset = prefixEnd;
  let suffixRows = 0;
  const record = options.record;
  const externalize = options.externalize;
  let next = pending;
  async function* suffix(): AsyncGenerator<string> {
    while (next) {
      const { stored, json } = next;
      if (!isPersistedChatMessage(stored) || ids.has(stored.id))
        throw new Error('Invalid or duplicate replacement message');
      ids.add(stored.id);
      suffixIds.add(stored.id);
      const rowBytes = Buffer.byteLength(json, 'utf8');
      if (rowBytes > MAX_TRANSCRIPT_ROW_BYTES)
        throw new Error('Transcript row exceeds maximum size');
      const end = offset + rowBytes + 1;
      const rowDigest = sha256(json);
      suffixLocators.set(
        locatorName(stored.id),
        locatorContent(stored.id, offset, end, rowDigest),
      );
      const recorded = record(stored, offset, end, rowDigest);
      if (recorded) await recorded;
      offset = end;
      suffixRows += 1;
      yield json;
      const following = await incoming.next();
      if (following.done) next = undefined;
      else {
        const externalized = await externalize(following.value);
        next = {
          original: following.value,
          stored: externalized,
          json: JSON.stringify(externalized),
        };
      }
    }
  }

  let bytesWritten = 0;
  let temporaryCreated = false;
  let renamed = false;
  try {
    // Build the complete replacement beside the log before any canonical file
    // changes, so validation failures (duplicates, oversized rows) and crashes
    // leave the committed log intact. The prefix is a copy-on-write clone
    // where the file system supports it (APFS, reflink) and a kernel byte copy
    // elsewhere; only the suffix is serialized.
    if (mode !== 'identical') {
      temporaryCreated = true;
      await copyFile(
        options.logPath,
        options.temporaryPath,
        constants.COPYFILE_FICLONE,
      );
      if (prefixEnd < baseline.committedByteLength)
        await truncate(options.temporaryPath, prefixEnd);
      bytesWritten = await writeJsonValuesCooperatively(
        options.temporaryPath,
        suffix(),
        {
          pretty: false,
          serializedValues: true,
          separator: '\n',
          trailingSeparator: true,
          append: true,
        },
      );
    }

    // Old suffix locators, read before the old log is replaced. A row that
    // cannot be read, or an id that repeats, makes the inventory untrusted.
    const staleLocators = new Map<string, string>();
    let rebuild = oldBroken;
    if (mode === 'rewrite' && !rebuild) {
      try {
        for await (const row of rawRows(options.logPath, prefixEnd)) {
          const message = parseRow(row.bytes);
          const name = locatorName(message.id);
          if (
            staleLocators.has(name) ||
            (ids.has(message.id) && !suffixIds.has(message.id))
          ) {
            rebuild = true;
            break;
          }
          staleLocators.set(
            name,
            locatorContent(
              message.id,
              row.offset,
              row.end,
              sha256(JSON.stringify(message)),
            ),
          );
        }
      } catch (error) {
        if (isSystemError(error)) throw error;
        rebuild = true;
      }
    }

    const reusableTurns = await reusablePriorTurns(
      options.turnsPath,
      baseline,
      prefixRows,
    );
    if (mode !== 'identical') {
      // A crash must not leave an old but byte-length-compatible sparse
      // index describing the replacement log.
      await rm(options.turnsPath, { force: true });
      await rm(options.indexPath, { force: true });
      await fsyncDirectory(root);
    }
    if (mode !== 'identical') {
      await rename(options.temporaryPath, options.logPath);
      renamed = true;
      await fsyncDirectory(root);
    }

    let locatorWrites = 0;
    let locatorRemovals = 0;
    const removals = Array.from(staleLocators)
      .filter(([name, content]) => suffixLocators.get(name) !== content)
      .map(([name]) => name);
    const creates = Array.from(suffixLocators).filter(
      ([name, content]) => staleLocators.get(name) !== content,
    );
    if (!rebuild) {
      for (let start = 0; start < removals.length; start += LOCATOR_BATCH)
        await settleBatch(
          removals
            .slice(start, start + LOCATOR_BATCH)
            .map((name) =>
              rm(join(options.locatorDirectory, name), { force: true }),
            ),
        );
      locatorRemovals = removals.length;
      if (
        (await createLocators(options.locatorDirectory, creates)) ===
        'collision'
      )
        rebuild = true;
      else locatorWrites = creates.length;
      if (!rebuild && (removals.length > 0 || creates.length > 0))
        await fsyncDirectory(options.locatorDirectory);
    }
    if (rebuild) {
      locatorRemovals = baseline.committedMessageCount;
      locatorWrites = await rebuildLocators(
        options.logPath,
        options.locatorDirectory,
      );
    }
    return {
      kind: 'preserved',
      bytesWritten,
      mode,
      prefixRows,
      suffixRows,
      locatorWrites,
      locatorRemovals,
      reusableTurns,
    };
  } finally {
    if (next) await incoming.return(undefined);
    if (temporaryCreated && !renamed)
      await rm(options.temporaryPath, { force: true });
  }
}
