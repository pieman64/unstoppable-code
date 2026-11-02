/**
 * The code-graph worktree fingerprint: pure Git and SHA-256 digest
 * computation, run by the fingerprint host. The Git executable is a host
 * fact the caller supplies.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import {
  CODE_GRAPH_MAX_FILE_BYTES,
  type CodeGraphRepositoryInput,
} from '../types/code-graph';

const execFileAsync = promisify(execFile);

// Module-private: only the digest below consumes it. Keep it unexported so the
// worker-safe surface stays the minimum the main-only half actually needs.
const WORKTREE_FINGERPRINT_VERSION = 'code-graph-worktree-state-v2';

// Deliberately structural rather than `instanceof Error`: Jest's module
// registry can hand back an Error constructed in another realm, where
// `instanceof` is false even for a genuine fs rejection.
export function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

async function gitOutput(
  gitExecutable: string,
  rootPath: string,
  args: readonly string[],
): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync(
      gitExecutable,
      ['-C', rootPath, ...args],
      {
        encoding: 'buffer',
        maxBuffer: 128 * 1024 * 1024,
        timeout: 30_000,
      },
    );
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Buffer.from(`git-error:${message}`);
  }
}

function nulSeparatedPaths(output: Buffer): string[] {
  if (output.subarray(0, 10).toString() === 'git-error:') {
    return [];
  }
  return output
    .toString('utf8')
    .split('\0')
    .filter((candidate) => candidate.length > 0);
}

async function hashWorktreePath(
  hash: ReturnType<typeof createHash>,
  rootPath: string,
  relativePath: string,
): Promise<void> {
  hash.update('\0path:');
  hash.update(relativePath);
  const absolutePath = path.join(rootPath, relativePath);
  try {
    const stat = await lstat(absolutePath, { bigint: true });
    if (stat.isSymbolicLink()) {
      hash.update('\0symlink:');
      hash.update(await readlink(absolutePath));
      return;
    }
    if (!stat.isFile()) {
      hash.update(`\0non-file:${stat.mode}`);
      return;
    }
    hash.update(`\0stat:${stat.size}:${stat.mtimeNs}`);
    // The graph never reads oversized file contents. Avoid turning a refresh
    // fingerprint into an unbounded binary-file read while still tracking the
    // same size/mtime inputs the scanner uses for these skipped files.
    if (stat.size > BigInt(CODE_GRAPH_MAX_FILE_BYTES)) {
      hash.update('\0oversized');
      return;
    }
    hash.update('\0file:');
    for await (const chunk of createReadStream(absolutePath)) {
      if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) {
        hash.update(chunk);
      } else {
        throw new TypeError('Unexpected worktree fingerprint stream chunk');
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    hash.update(`\0read-error:${message}`);
  }
}

export async function fingerprintCodeGraphWorktree(
  repositories: readonly CodeGraphRepositoryInput[],
  gitExecutable: string,
): Promise<string> {
  const hash = createHash('sha256');
  hash.update(WORKTREE_FINGERPRINT_VERSION);
  const ordered = [...repositories].sort((a, b) =>
    a.repoId.localeCompare(b.repoId),
  );
  for (const repository of ordered) {
    hash.update('\0repo:');
    hash.update(repository.repoId);
    hash.update('\0head:');
    hash.update(
      await gitOutput(gitExecutable, repository.rootPath, [
        'rev-parse',
        'HEAD',
      ]),
    );
    hash.update('\0status:');
    const status = await gitOutput(gitExecutable, repository.rootPath, [
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
    ]);
    hash.update(status);

    // Porcelain status describes which paths are dirty, but not the current
    // bytes of an already-dirty tracked or untracked file. Hash those bytes
    // so repeated edits that do not change the XY status still invalidate the
    // graph. Keep the path-list output in the digest too so deletions and Git
    // failures remain observable even when there are no bytes to read.
    const trackedPaths = await gitOutput(gitExecutable, repository.rootPath, [
      'diff',
      '--name-only',
      '-z',
      '--no-ext-diff',
      'HEAD',
      '--',
    ]);
    const untrackedPaths = await gitOutput(gitExecutable, repository.rootPath, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ]);
    hash.update('\0tracked-paths:');
    hash.update(trackedPaths);
    hash.update('\0untracked-paths:');
    hash.update(untrackedPaths);
    const contentPaths = new Set([
      ...nulSeparatedPaths(trackedPaths),
      ...nulSeparatedPaths(untrackedPaths),
    ]);
    for (const relativePath of Array.from(contentPaths).sort()) {
      await hashWorktreePath(hash, repository.rootPath, relativePath);
    }
  }
  return hash.digest('hex');
}
