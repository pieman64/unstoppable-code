import { open, readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { normalizeLimit } from '../lib/concurrency';
import { isRecord } from '../lib/type-guards';

/**
 * Bounded readers for provider session files. Discovery only needs the
 * metadata records near the start of a transcript or rollout, so the adapters
 * read one fixed-size head instead of the whole file: session stores can hold
 * gigabytes of prompt and tool output, none of which belongs in a scan.
 */

export async function readFileHead(
  filePath: string,
  maxBytes: number,
): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    // Every byte past `bytesRead` is discarded, so zero-filling is waste
    // across thousands of inspected files.
    const buffer = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * The last `maxBytes` of a file of `sizeBytes`, starting at a record
 * boundary: a tail that begins mid-file drops its first, partial line.
 */
export async function readFileTail(
  filePath: string,
  maxBytes: number,
  sizeBytes: number,
): Promise<string> {
  const start = Math.max(0, sizeBytes - maxBytes);
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, start);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start === 0) return text;
    const newline = text.indexOf('\n');
    return newline === -1 ? '' : text.slice(newline + 1);
  } finally {
    await handle.close();
  }
}

/**
 * When a session file's last message was written, or `null` when its tail
 * holds none. Providers rewrite old transcripts (titles, metadata) without
 * anyone working in them, so the file's modified time overstates how
 * recently it was used. `head` is reused when it already holds the file.
 */
export async function lastMessageAt(
  file: FileEntryWithStats,
  head: string,
  maxBytes: number,
  pool: ReadPool,
  isMessage: (record: Record<string, unknown>) => boolean,
): Promise<string | null> {
  const tail =
    file.sizeBytes <= maxBytes
      ? head
      : await pool
          .run(() => readFileTail(file.path, maxBytes, file.sizeBytes))
          .catch(() => '');
  const records = parseJsonLinesHead(tail, maxBytes);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record && isMessage(record)) {
      const at = isoFromValue(record.timestamp);
      if (at) return at;
    }
  }
  return null;
}

/**
 * Parse the complete JSON lines in a file head. The final line is dropped
 * when the head ended mid-record so a truncated line never yields a partial
 * object that happens to parse.
 */
export function parseJsonLinesHead(
  head: string,
  maxBytes: number,
): Record<string, unknown>[] {
  const lines = head.split('\n');
  // A head that filled the buffer may have cut the last record mid-line —
  // unless it ends on a newline, in which case every line is complete.
  const truncated = Buffer.byteLength(head, 'utf8') >= maxBytes;
  if (truncated && !head.endsWith('\n')) lines.pop();
  const records: Record<string, unknown>[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) records.push(parsed);
    } catch {
      // Provider files are appended live; a torn line is expected.
    }
  }
  return records;
}

/**
 * Admission control shared by every stat and file read of one scan. Two
 * nested loops each sized to the limit would multiply into limit² calls in
 * flight; one pool holds the total to the limit whatever the nesting.
 *
 * A task passed to `run` must not itself call `run` on the same pool: it
 * would hold its slot while waiting for another, and on a full pool that
 * wait never ends. Express nesting by calling the pooled helper outside a
 * slot, the way the adapters fan `listFilesNewestFirst` out from
 * `mapWithConcurrency` rather than from inside `run`.
 */
export interface ReadPool {
  run<T>(task: () => Promise<T>): Promise<T>;
}

export function createReadPool(limit: number): ReadPool {
  const max = normalizeLimit(limit);
  let active = 0;
  const waiting: Array<() => void> = [];
  const acquire = (): Promise<void> => {
    if (active < max) {
      active += 1;
      return Promise.resolve();
    }
    // Handed the slot directly by `release`, which leaves `active` as is.
    return new Promise((resolve) => {
      waiting.push(resolve);
    });
  };
  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}

export interface FileEntryWithStats {
  path: string;
  name: string;
  sizeBytes: number;
  mtimeMs: number;
}

/**
 * List regular files in one directory matching `filter`, newest first. The
 * stats go through `pool`, which the caller owns for its whole scan, so
 * listing many directories at once shares one bound across all of them
 * instead of minting a fresh pool per directory.
 */
export async function listFilesNewestFirst(
  directory: string,
  filter: (entry: Dirent) => boolean,
  pool: ReadPool,
): Promise<FileEntryWithStats[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const matching = entries.filter((entry) => entry.isFile() && filter(entry));
  const files = (
    await Promise.all(
      matching.map(async (entry): Promise<FileEntryWithStats | null> => {
        const filePath = join(directory, entry.name);
        try {
          const stats = await pool.run(() => stat(filePath));
          return {
            path: filePath,
            name: entry.name,
            sizeBytes: stats.size,
            mtimeMs: stats.mtimeMs,
          };
        } catch {
          // Removed between readdir and stat.
          return null;
        }
      }),
    )
  ).filter((file): file is FileEntryWithStats => file !== null);
  // Names carry the provider's own timestamp (Codex rollouts) or are opaque
  // ids (Claude); the name tie-break keeps same-instant writes deterministic.
  return files.sort(
    (a, b) => b.mtimeMs - a.mtimeMs || compareText(b.name, a.name),
  );
}

/**
 * A total order over any two strings that is the same on every machine,
 * which `localeCompare` is not (locale-tailored, and it treats some distinct
 * strings as equal): UTF-16 code-unit order, case-folded first so the
 * alphabetical reading holds, then raw so distinct strings never tie.
 */
export function compareText(a: string, b: string): number {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al !== bl) return al < bl ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isoFromMs(ms: number | null | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

export function isoFromValue(value: unknown): string | null {
  if (typeof value === 'number') return isoFromMs(value);
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function laterIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/** `Map#values()` as an array without relying on iterator downleveling. */
export function mapValues<K, V>(map: Map<K, V>): V[] {
  const out: V[] = [];
  map.forEach((value) => out.push(value));
  return out;
}
