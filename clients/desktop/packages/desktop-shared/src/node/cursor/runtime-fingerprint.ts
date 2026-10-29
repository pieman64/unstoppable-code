import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MAX_RUNTIME_ENTRIES,
  MAX_UNPACKED_BYTES,
} from '../../lib/cursor-runtime-limits';

/** One verification at a time bounds disk and CPU pressure. */
let pending: Promise<void> = Promise.resolve();

/**
 * The full-tree digest of an installed Cursor runtime, for a process that
 * cannot load the desktop's bundled hash worker (the CLI).
 *
 * It computes exactly what the desktop's `runtime-hash-worker.ts` computes, so
 * the same pinned `filesSha256` verifies both: every regular file's SHA-256,
 * keyed by its `/`-separated relative path, sorted and hashed as JSON. Links
 * and other entry types are refused, required executables must be executable,
 * and the byte and entry limits match the installer's. A cross-check test in
 * `cursor-runtime.test.ts` pins the two together.
 *
 * It runs asynchronously in the calling process and stops between reads when
 * `signal` aborts. One verification runs at a time, as on the desktop.
 */
export async function fingerprintCursorRuntime(
  directory: string,
  executables: readonly string[],
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const scheduled = pending.then(() =>
    fingerprint(directory, executables, signal),
  );
  pending = scheduled.then(
    () => undefined,
    () => undefined,
  );
  return scheduled;
}

async function fingerprint(
  directory: string,
  executables: readonly string[],
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const executableFiles = new Set(executables);
  const files = new Map<string, string>();
  let bytes = 0;
  let entries = 0;

  const hashFile = async (file: string): Promise<string> => {
    const digest = createHash('sha256');
    const stream = createReadStream(file);
    const stop = (): void => {
      stream.destroy();
    };
    signal.addEventListener('abort', stop, { once: true });
    try {
      const chunks: AsyncIterable<Buffer> = stream;
      for await (const chunk of chunks) {
        signal.throwIfAborted();
        bytes += chunk.length;
        if (bytes > MAX_UNPACKED_BYTES)
          throw new Error('Runtime exceeds verification limit');
        digest.update(chunk);
      }
    } finally {
      signal.removeEventListener('abort', stop);
    }
    signal.throwIfAborted();
    return digest.digest('hex');
  };

  const visit = async (relative: string): Promise<void> => {
    signal.throwIfAborted();
    if (++entries > MAX_RUNTIME_ENTRIES)
      throw new Error('Too many runtime entries');
    const full = join(directory, relative);
    const info = await lstat(full);
    if (info.isSymbolicLink())
      throw new Error('Runtime links are not supported');
    if (info.isDirectory()) {
      for (const name of await readdir(full))
        await visit(relative ? `${relative}/${name}` : name);
    } else if (info.isFile()) {
      if (executableFiles.has(relative)) await access(full, constants.X_OK);
      files.set(relative, await hashFile(full));
    } else throw new Error('Unsupported runtime entry');
  };

  await visit('');
  const sorted = Object.fromEntries(
    Array.from(files.keys())
      .sort()
      .map((name): [string, string] => [name, files.get(name) ?? '']),
  );
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}
