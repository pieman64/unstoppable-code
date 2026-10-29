// Bundled thread-worker entry for Cursor runtime verification. Registered in
// scripts/lib/utility-worker-entries.mjs and built by electron.vite.config.ts.
// Paths are data, never code: the worker only hashes what the parent names.
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

// This entry is bundled standalone and its TypeScript source runs directly
// under tsx in tests, so it stays import-free: limits arrive in the request.

interface HashWorkerRequest {
  path: string;
  kind: 'directory' | 'file';
  maxBytes: number;
  maxEntries: number;
  executables?: readonly string[];
}

function readRequest(value: unknown): HashWorkerRequest {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('path' in value) ||
    typeof value.path !== 'string' ||
    !('kind' in value) ||
    (value.kind !== 'directory' && value.kind !== 'file') ||
    !('maxBytes' in value) ||
    typeof value.maxBytes !== 'number' ||
    !('maxEntries' in value) ||
    typeof value.maxEntries !== 'number'
  )
    throw new Error('Invalid Cursor verification request');
  const executables =
    'executables' in value && Array.isArray(value.executables)
      ? value.executables.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [];
  return {
    path: value.path,
    kind: value.kind,
    maxBytes: value.maxBytes,
    maxEntries: value.maxEntries,
    executables,
  };
}

const request = readRequest(workerData);
const executableFiles = new Set(request.executables);
let bytes = 0;
let entries = 0;

async function hashFile(file: string): Promise<string> {
  const digest = createHash('sha256');
  const stream: AsyncIterable<Buffer> = createReadStream(file);
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > request.maxBytes)
      throw new Error('Runtime exceeds verification limit');
    digest.update(chunk);
  }
  return digest.digest('hex');
}

async function fingerprint(): Promise<string> {
  const files = new Map<string, string>();
  async function visit(relative: string): Promise<void> {
    if (++entries > request.maxEntries)
      throw new Error('Too many runtime entries');
    const full = join(request.path, relative);
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
  }
  await visit('');
  const sortedEntries = Array.from(files.keys())
    .sort()
    .map((name: string): [string, string] => [name, files.get(name) ?? '']);
  const sorted = Object.fromEntries(sortedEntries);
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

void (request.kind === 'directory' ? fingerprint() : hashFile(request.path))
  .then((digest) => parentPort?.postMessage(digest))
  // Exit without a result; the parent reports a fixed message rather than a raw
  // filesystem error that may carry absolute paths.
  .catch(() => {
    process.exit(1);
  });
