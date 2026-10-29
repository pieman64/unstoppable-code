import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { posix } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { open, type Entry, type ZipFile } from 'yauzl';

export interface ExtractCursorZipOptions {
  archive: string;
  destination: string;
  /** Single permitted top-level directory, e.g. `dist-package`. */
  root: string;
  maxEntries: number;
  maxBytes: number;
  signal: AbortSignal;
}

const UNIX_HOST = 3;
const FILE_TYPE_MASK = 0o170000;
const REGULAR_TYPE = 0o100000;
const DIRECTORY_TYPE = 0o040000;

function invalid(): Error {
  return new Error('Cursor archive contains invalid entries.');
}

/**
 * Entry-name policy shared with the tar path: one known root, no traversal, no
 * absolute or Windows-drive paths, and no separator ambiguity. Names are
 * compared in their normalized POSIX form so a rewritten name cannot slip past.
 */
export function isSafeCursorEntryName(name: string, root: string): boolean {
  if (!name || name.includes('\\') || name.includes('\0')) return false;
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return false;
  const trimmed = name.endsWith('/') ? name.slice(0, -1) : name;
  if (!trimmed) return false;
  const segments = trimmed.split('/');
  if (
    segments.some((segment) => segment === '..' || segment === '.' || !segment)
  )
    return false;
  if (posix.normalize(trimmed) !== trimmed) return false;
  return trimmed === root || trimmed.startsWith(`${root}/`);
}

/** A Unix-created entry that is neither a regular file nor a directory. */
function isUnsupportedUnixType(entry: Entry): boolean {
  if (entry.versionMadeBy >> 8 !== UNIX_HOST) return false;
  const mode = entry.externalFileAttributes >>> 16;
  if (mode === 0) return false;
  const type = mode & FILE_TYPE_MASK;
  // Symlinks are the reachable case, but FIFOs, sockets, and device nodes are
  // equally outside the tar path's "files and directories only" contract, so
  // allow-list the two supported types rather than deny-listing one.
  return type !== REGULAR_TYPE && type !== DIRECTORY_TYPE;
}

function openArchive(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    // `strictFileNames` stops yauzl from silently rewriting `\` to `/` for
    // legacy writers. Without it the name this code validates is not the name
    // that reaches the filesystem, which would defeat the checks below.
    open(
      path,
      {
        lazyEntries: true,
        autoClose: false,
        strictFileNames: true,
        // Load-bearing, not a default worth inheriting: the byte bound below
        // sums attacker-declared `uncompressedSize`, and only this assertion
        // ties that number to the bytes actually produced.
        validateEntrySizes: true,
      },
      (error, zip) => {
        if (error || !zip) reject(error ?? invalid());
        else resolve(zip);
      },
    );
  });
}

/**
 * Read the whole central directory before extracting anything. Entry metadata
 * is cheap to read and lets the archive be rejected as a unit, so a malicious
 * entry cannot be discovered only after earlier ones are already on disk.
 */
function readEntries(zip: ZipFile, maxEntries: number): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: Entry[] = [];
    zip.on('entry', (entry: Entry) => {
      if (entries.length >= maxEntries) {
        reject(invalid());
        return;
      }
      entries.push(entry);
      zip.readEntry();
    });
    zip.once('end', () => resolve(entries));
    zip.once('error', reject);
    zip.readEntry();
  });
}

function openEntryStream(zip: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? invalid());
      else resolve(stream);
    });
  });
}

export async function extractCursorZip(
  options: ExtractCursorZipOptions,
): Promise<void> {
  const { archive, destination, root, maxEntries, maxBytes, signal } = options;
  signal.throwIfAborted();
  // yauzl rejects traversal and absolute names itself; its message is
  // normalized here so callers see one contract no matter which layer caught
  // the archive, while the checks below cover what it does not police.
  const zip = await openArchive(archive).catch(() => {
    throw invalid();
  });
  try {
    const entries = await readEntries(zip, maxEntries).catch(() => {
      throw invalid();
    });
    signal.throwIfAborted();

    const seen = new Set<string>();
    let total = 0;
    for (const entry of entries) {
      // `foo` and `foo/` extract to the same path, so they must collide here
      // rather than surface as a raw EEXIST after earlier entries are written.
      const key = entry.fileName.replace(/\/$/, '');
      if (
        !isSafeCursorEntryName(entry.fileName, root) ||
        isUnsupportedUnixType(entry) ||
        seen.has(key)
      )
        throw invalid();
      seen.add(key);
      total += entry.uncompressedSize;
      if (total > maxBytes) throw invalid();
    }

    // Nothing is written until every entry has passed the name, type, bound,
    // and duplicate checks above. Path-shape conflicts (a file entry that is
    // also another entry's parent directory) still surface mid-loop, which the
    // caller contains by discarding the whole stage directory. The destination
    // is created here so an archive of only directory entries still yields a
    // directory to promote.
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const entry of entries) {
      signal.throwIfAborted();
      const relative = entry.fileName.slice(root.length).replace(/^\//, '');
      const isDirectory = entry.fileName.endsWith('/');
      if (!relative) {
        if (isDirectory) continue;
        throw invalid();
      }
      const target = join(destination, relative);
      if (isDirectory) {
        await mkdir(target, { recursive: true, mode: 0o700 });
        continue;
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const stream = await openEntryStream(zip, entry);
      await pipeline(stream, createWriteStream(target, { mode: 0o600 }), {
        signal,
      });
    }
  } finally {
    zip.close();
  }
}
