import { readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type {
  StepLogReadOptions,
  StepLogReadResult,
  StepOutputLogPosition,
} from '@canopy/execution-engine/types/pipeline';

/**
 * Byte positions for step output, so a persisted snapshot and live output
 * events can be joined exactly (the log catch-up seam).
 *
 * Contract, per log file:
 *
 * - A **generation** names one content epoch of the file. Within a committed
 *   generation the file only grows by appends, or is rewritten with identical
 *   bytes, so any read observes a prefix of the generation's final content.
 * - Anything that truncates or replaces the file first invalidates the
 *   committed generation. A positioned writer commits a new, strictly larger
 *   generation only once its base is established, and before it emits the
 *   first positioned event.
 * - A positioned writer stamps every chunk it persists and emits, in persist
 *   order, from one serialized writer. The offset may name bytes still queued
 *   for writing.
 *
 * The registry is process-local: the reader resolves a generation only for
 * files whose writer runs in this process (the desktop main process hosts
 * both the executor and the `readStepLog` handler). Anything else reads
 * without a generation, and consumers fall back to textual reconciliation.
 */

/** Bounded so a long-lived process cannot grow the registry without limit. */
const MAX_TRACKED_LOG_FILES = 4096;

const committedGenerations = new Map<string, number>();
let lastGeneration = 0;

function registryKey(logFile: string): string {
  return path.resolve(logFile);
}

/** Called before anything truncates or replaces a step log. */
export function invalidateStepLogGeneration(logFile: string): void {
  committedGenerations.delete(registryKey(logFile));
}

function commitStepLogGeneration(logFile: string): number {
  lastGeneration += 1;
  const key = registryKey(logFile);
  committedGenerations.delete(key);
  committedGenerations.set(key, lastGeneration);
  while (committedGenerations.size > MAX_TRACKED_LOG_FILES) {
    const oldest = committedGenerations.keys().next();
    if (oldest.done) break;
    committedGenerations.delete(oldest.value);
  }
  return lastGeneration;
}

/** The committed generation of a step log, if its positioned writer is live here. */
export function getStepLogGeneration(logFile: string): number | undefined {
  return committedGenerations.get(registryKey(logFile));
}

/** Stamps consecutive chunks of one positioned writer. */
export class StepLogPositionCursor {
  private nextOffset: number;

  constructor(
    readonly generation: number,
    baseOffset: number,
  ) {
    this.nextOffset = baseOffset;
  }

  /**
   * Claims the next byte range for `data`. Call it exactly once per persisted
   * chunk, in the order the chunks are written.
   */
  claim(data: string): StepOutputLogPosition {
    const byteLength = Buffer.byteLength(data, 'utf8');
    const position: StepOutputLogPosition = {
      generation: this.generation,
      offset: this.nextOffset,
      byteLength,
    };
    this.nextOffset += byteLength;
    return position;
  }
}

/**
 * Starts a positioned generation at the current end of a log whose remaining
 * writes are appends of exactly the emitted bytes (the spawned-process
 * writers). Setup lines already appended without being emitted are covered by
 * the base offset. Returns undefined when the file cannot be measured, so the
 * writer's events stay unpositioned.
 */
export async function openAppendingStepLogCursor(
  logFile: string,
): Promise<StepLogPositionCursor | undefined> {
  try {
    const { size } = await stat(logFile);
    return new StepLogPositionCursor(commitStepLogGeneration(logFile), size);
  } catch {
    return undefined;
  }
}

/**
 * Truncates a log and starts a positioned generation at offset zero, for a
 * writer that owns the whole file from here on (the Codex/Cursor transcript
 * writers). Rejects when the truncation fails; the generation stays invalid.
 */
export async function resetStepLogForPositionedWriter(
  logFile: string,
): Promise<StepLogPositionCursor> {
  invalidateStepLogGeneration(logFile);
  await writeFile(logFile, '', 'utf8');
  return new StepLogPositionCursor(commitStepLogGeneration(logFile), 0);
}

/**
 * Commits a new generation for a log that was just written whole with
 * `content`, returning that content's position (the Claude worker writes its
 * transcript once, then emits it). Call only after the write resolved and
 * before emitting.
 */
export function commitWholeStepLog(
  logFile: string,
  content: string,
): StepOutputLogPosition {
  return new StepLogPositionCursor(commitStepLogGeneration(logFile), 0).claim(
    content,
  );
}

/**
 * Length of the longest prefix of `bytes` that does not end inside a UTF-8
 * character. A read can observe a write that is only partly complete; the
 * excluded bytes are re-read with the rest of their character later.
 */
export function completeUtf8PrefixLength(bytes: Uint8Array): number {
  const end = bytes.length;
  let index = end - 1;
  let continuationBytes = 0;
  while (
    index >= 0 &&
    continuationBytes < 3 &&
    (bytes[index] & 0xc0) === 0x80
  ) {
    index -= 1;
    continuationBytes += 1;
  }
  if (index < 0) return end;
  const lead = bytes[index];
  const expected =
    (lead & 0xe0) === 0xc0
      ? 2
      : (lead & 0xf0) === 0xe0
        ? 3
        : (lead & 0xf8) === 0xf0
          ? 4
          : 1;
  return end - index < expected ? index : end;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'code') === 'ENOENT'
  );
}

function toLines(content: string): string[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/**
 * Reads one step log for `readStepLog`. The generation is sampled before and
 * after the read; it is reported only when it was committed and unchanged
 * throughout, which proves no truncation or replacement overlapped the read.
 * A missing file reads as empty, as before.
 */
export async function readStepLogFile(
  logFile: string,
  options: StepLogReadOptions = {},
): Promise<StepLogReadResult> {
  const generationBefore = getStepLogGeneration(logFile);
  let bytes: Buffer;
  try {
    bytes = await readFile(logFile);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    return options.format === 'text'
      ? { lines: [], text: '', byteLength: 0 }
      : { lines: [], byteLength: 0 };
  }
  const generationAfter = getStepLogGeneration(logFile);
  const generation =
    generationBefore !== undefined && generationBefore === generationAfter
      ? { generation: generationBefore }
      : {};

  if (options.format === 'text') {
    const byteLength = completeUtf8PrefixLength(bytes);
    return {
      lines: [],
      text: bytes.toString('utf8', 0, byteLength),
      byteLength,
      ...generation,
    };
  }
  return {
    lines: toLines(bytes.toString('utf8')),
    byteLength: bytes.length,
    ...generation,
  };
}
