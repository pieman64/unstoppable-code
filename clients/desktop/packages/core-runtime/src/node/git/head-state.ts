import { lstat, open, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface GitHeadState {
  /** True means this branch has no commit, not that the repository has none. */
  headUnborn?: boolean;
  symbolicHead?: string;
}

function missing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'code') === 'ENOENT'
  );
}

/** A fixed-size read; oversized, inaccessible and non-file metadata is unknown. */
async function metadata(file: string, limit = 4096): Promise<string | null> {
  let handle;
  try {
    // Do not open a FIFO or device as Git metadata.
    if (!(await lstat(file)).isFile())
      throw new Error('Unsupported Git metadata');
    handle = await open(file, 'r');
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        size,
        buffer.length - size,
        size,
      );
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > limit) throw new Error('Git metadata exceeds read limit');
    return buffer.toString('utf8', 0, size);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

function validRef(ref: string): boolean {
  return (
    ref.startsWith('refs/') &&
    !Array.from(ref).some(
      (character) =>
        character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    ) &&
    !/[~^:?*\[\\]/.test(ref) &&
    !ref.includes('..') &&
    !ref.includes('@{') &&
    ref
      .split('/')
      .every(
        (part) =>
          part.length > 0 &&
          !part.startsWith('.') &&
          !part.endsWith('.') &&
          !part.endsWith('.lock'),
      )
  );
}

/** Conservative subset: includes, complex syntax and alternate ref stores stay unknown. */
function filesObjectIdLength(config: string): 40 | 64 | undefined {
  let section = '';
  let version: string | undefined;
  let objectIdLength: 40 | 64 = 40;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([a-zA-Z0-9.-]+)(?: "[^"\\]*")?\]$/.exec(line);
    if (header) {
      section = header[1].toLowerCase();
      if (section === 'include' || section === 'includeif') return undefined;
      continue;
    }
    const entry =
      /^([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*([^"\\]*?)(?:\s+[;#].*)?$/.exec(line);
    if (!section || !entry) return undefined;
    const key = entry[1].toLowerCase();
    const value = entry[2].trim().toLowerCase();
    if (section === 'core' && key === 'repositoryformatversion')
      version = value;
    if (
      section === 'core' &&
      [
        'bare',
        'filemode',
        'ignorecase',
        'precomposeunicode',
        'symlinks',
      ].includes(key) &&
      !['true', 'false', 'yes', 'no', 'on', 'off', '1', '0'].includes(value)
    )
      return undefined;
    if (
      section === 'extensions' &&
      key === 'objectformat' &&
      value === 'sha256'
    )
      objectIdLength = 64;
    if (
      section === 'extensions' &&
      !(
        (key === 'refstorage' && value === 'files') ||
        (key === 'objectformat' && (value === 'sha1' || value === 'sha256')) ||
        (key === 'worktreeconfig' && (value === 'true' || value === 'false'))
      )
    )
      return undefined;
  }
  return version === '1' || (version === '0' && objectIdLength === 40)
    ? objectIdLength
    : undefined;
}

async function readUnbornHead(
  repoPath: string,
  signal?: AbortSignal,
): Promise<GitHeadState> {
  signal?.throwIfAborted();
  let gitDir = join(repoPath, '.git');
  const dotGit = await stat(gitDir);
  if (dotGit.isFile()) {
    const pointer = await metadata(gitDir);
    const match = pointer && /^gitdir: ([^\r\n]+)\r?\n?$/.exec(pointer);
    if (!match) return {};
    gitDir = resolve(repoPath, match[1]);
  } else if (!dotGit.isDirectory()) return {};
  const commonPointer = await metadata(join(gitDir, 'commondir'));
  if (commonPointer !== null && !/^[^\r\n]+\r?\n?$/.test(commonPointer))
    return {};
  const commonDir =
    commonPointer === null ? gitDir : resolve(gitDir, commonPointer.trim());
  const config = await metadata(join(commonDir, 'config'), 64 * 1024);
  const objectIdLength =
    config === null ? undefined : filesObjectIdLength(config);
  if (objectIdLength === undefined) return {};
  if (
    !(await stat(join(commonDir, 'objects'))).isDirectory() ||
    !(await stat(join(commonDir, 'refs'))).isDirectory()
  )
    return {};
  const head = await metadata(join(gitDir, 'HEAD'));
  const symbolic = head && /^ref: ([^\r\n]+)\r?\n?$/.exec(head);
  if (
    !symbolic ||
    !symbolic[1].startsWith('refs/heads/') ||
    !validRef(symbolic[1])
  )
    return {};
  const symbolicHead = symbolic[1];
  // An existing ref (including a symbolic/dangling/malformed one) is never unborn.
  if ((await metadata(join(commonDir, symbolicHead))) !== null) return {};
  const packed = await metadata(join(commonDir, 'packed-refs'), 1024 * 1024);
  let canPeel = false;
  for (const line of (packed ?? '').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('^')) {
      if (
        !canPeel ||
        line.length !== objectIdLength + 1 ||
        !/^\^[0-9a-f]+$/.test(line)
      )
        return {};
      canPeel = false;
      continue;
    }
    const entry = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) (refs\/[^\s]+)$/.exec(line);
    if (
      !entry ||
      entry[1].length !== objectIdLength ||
      !validRef(entry[2]) ||
      entry[2] === symbolicHead
    )
      return {};
    canPeel = true;
  }
  signal?.throwIfAborted();
  // Refuse certainty when HEAD or the ref store changed while reading.
  if (
    (await metadata(join(gitDir, 'HEAD'))) !== head ||
    (await metadata(join(commonDir, symbolicHead))) !== null ||
    (await metadata(join(commonDir, 'packed-refs'), 1024 * 1024)) !== packed
  )
    return {};
  return { headUnborn: true, symbolicHead };
}

/**
 * Shared worker-owned semantics for import, branch listing and failed adds.
 * Import omits verifyCommit: existing refs then remain unknown rather than
 * claiming that a referenced object exists. Git-backed callers verify a commit
 * through their existing bundled runner before using the files-ref fallback.
 */
export async function readGitHeadState(
  repoPath: string,
  options: { verifyCommit?: () => Promise<unknown>; signal?: AbortSignal } = {},
): Promise<GitHeadState> {
  try {
    options.signal?.throwIfAborted();
    if (options.verifyCommit) {
      try {
        await options.verifyCommit();
        return { headUnborn: false };
      } catch (error) {
        // rev-parse --verify --quiet exits 1 for unresolved HEAD. Every other
        // failure, including missing Git and timeouts, remains unknown.
        if (
          typeof error !== 'object' ||
          error === null ||
          (Reflect.get(error, 'code') !== 1 &&
            Reflect.get(error, 'exitCode') !== 1)
        )
          return {};
      }
    }
    return await readUnbornHead(repoPath, options.signal);
  } catch {
    return {};
  }
}

export interface WorktreeSourceFailure {
  failureReason: 'source-no-commits';
  /** Host-local source identity; never part of a portable protocol result. */
  sourceRepoPath: string;
}

export function worktreeSourceFailure(
  error: unknown,
): WorktreeSourceFailure | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const sourceRepoPath: unknown = Reflect.get(error, 'sourceRepoPath');
  return Reflect.get(error, 'failureReason') === 'source-no-commits' &&
    typeof sourceRepoPath === 'string'
    ? { failureReason: 'source-no-commits', sourceRepoPath }
    : undefined;
}

/** Only call from the failed worktree-add step, with its exact start point. */
export async function classifyWorktreeAddFailure(
  error: unknown,
  repoPath: string,
  startPoint: string,
  verifyCommit: () => Promise<unknown>,
): Promise<void> {
  if (typeof error !== 'object' || error === null) return;
  const stderr: unknown = Reflect.get(error, 'stderr');
  const message: unknown = Reflect.get(error, 'message');
  const detail =
    typeof stderr === 'string'
      ? stderr
      : typeof message === 'string'
        ? message
        : '';
  const match =
    /fatal: (?:not a valid object name|invalid reference|invalid object name):? ['"]?([^'"\r\n]+)/.exec(
      detail,
    );
  if (match?.[1].trim() !== startPoint) return;
  const state = await readGitHeadState(repoPath, { verifyCommit });
  if (state.headUnborn !== true || !state.symbolicHead) return;
  if (
    startPoint !== 'HEAD' &&
    startPoint !== state.symbolicHead &&
    startPoint !== state.symbolicHead.slice('refs/heads/'.length)
  )
    return;
  // Preserve the original error identity, stderr and stack for cleanup/details.
  try {
    Object.assign(error, {
      failureReason: 'source-no-commits',
      sourceRepoPath: repoPath,
    });
  } catch {
    // Diagnostics must never replace an immutable host error.
  }
}
