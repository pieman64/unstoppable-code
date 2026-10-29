import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { getGitExecutableCommand } from '@canopy/desktop-shared/lib/git-executable';
import {
  DELEGATION_FILE_MAX_BYTES,
  validDelegationPath,
} from '@canopy/desktop-shared/node/delegation/file-access';
import { spawnClaudeCodeProcessOffMain } from '../claude-process-host-runner';
import { removeWindowsWorktreeReparsePoints } from '../../lib/git';

const windows = process.platform === 'win32';
const nullDevice = windows ? 'NUL' : '/dev/null';
/** Windows removal retries transient locks from indexers and scanners. */
const removal = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 200,
} as const;

/** Git for Windows follows a junction during `worktree remove --force` and
 * deletes its target's contents. A delegated process could replace the
 * checkout root itself with a link, or create links inside it. Never remove
 * through either: unlink a linked root and prune the stale registration, and
 * unlink every link inside a real checkout before Git removes it. */
async function removeWorktreeRegistration(
  source: string,
  directory: string,
  signal: AbortSignal,
): Promise<void> {
  if (await isLink(directory)) {
    await fs.unlink(directory);
    await git(source, ['worktree', 'prune'], signal);
    return;
  }
  await removeWindowsWorktreeReparsePoints(directory);
  // Indexers and scanners briefly hold files open on Windows, which fails an
  // otherwise authorized removal. Retry a bounded number of times there.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await git(
        source,
        ['worktree', 'remove', '--force', '--', directory],
        signal,
      );
      return;
    } catch (error) {
      if (!windows || attempt >= 3 || signal.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
}

async function isLink(file: string): Promise<boolean> {
  try {
    return (await fs.lstat(file)).isSymbolicLink();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

/** No shell and no model-controlled arguments. Mutations are limited to an owned directory. */
async function git(
  cwd: string,
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  return (await gitOutput(cwd, args, signal)).toString('utf8').trim();
}

/** `git` with its raw output, which may not exceed `maxBytes`. `input` is
 * written to its standard input; `extraEnv` adds host-chosen variables. */
async function gitOutput(
  cwd: string,
  args: string[],
  signal: AbortSignal,
  maxBytes = 65_536,
  input?: string,
  extraEnv: Readonly<Record<string, string>> = {},
  successfulExitCodes: readonly number[] = [0],
): Promise<Buffer> {
  if (signal.aborted) throw new Error('Workspace operation cancelled');
  const child = spawnClaudeCodeProcessOffMain({
    command: getGitExecutableCommand(process.env),
    args: [
      '-c',
      `core.hooksPath=${nullDevice}`,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'submodule.recurse=false',
      // Delegated checkouts sit deep under app data; allow paths past MAX_PATH.
      ...(windows ? ['-c', 'core.longpaths=true'] : []),
      ...args,
    ],
    cwd,
    env: {
      PATH: process.env.PATH ?? (windows ? '' : '/usr/bin:/bin'),
      LANG: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: nullDevice,
      GIT_TERMINAL_PROMPT: '0',
      ...windowsSystemEnvironment(),
      ...extraEnv,
    },
    signal,
  });
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    let exited = false;
    let outputEnded = false;
    let exitCode: number | null = null;
    const timer = setTimeout(() => {
      failed = true;
      child.kill('SIGKILL');
      reject(new Error('Isolated workspace process failed.'));
    }, 30_000);
    const settle = (): void => {
      if (!exited || !outputEnded) return;
      clearTimeout(timer);
      if (
        failed ||
        signal.aborted ||
        !successfulExitCodes.includes(exitCode ?? -1)
      )
        reject(
          new Error(
            'Isolated workspace operation failed. Retained work was not discarded.',
          ),
        );
      else resolve(Buffer.concat(chunks));
    };
    child.stdin.on('error', () => undefined);
    child.on('error', () => {
      failed = true;
      clearTimeout(timer);
      reject(new Error('Isolated workspace process failed.'));
    });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        failed = true;
        child.kill('SIGKILL');
      } else chunks.push(Buffer.from(chunk));
    });
    // Exit can precede stdout completion, especially when a child inherits the
    // pipe. Cleanup must see the complete Git worktree listing.
    child.stdout.once('end', () => {
      outputEnded = true;
      settle();
    });
    child.once('exit', (code) => {
      exited = true;
      exitCode = code;
      settle();
    });
    child.stdin.end(input);
  });
}

function windowsSystemEnvironment(): Record<string, string> {
  if (!windows) return {};
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  return systemRoot ? { SystemRoot: systemRoot, WINDIR: systemRoot } : {};
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return false;
    throw error;
  }
}

async function removeRegisteredWorktree(
  source: string,
  directory: string,
): Promise<void> {
  const signal = new AbortController().signal;
  if (!(await isRegisteredWorktree(source, directory, signal))) return;
  await removeWorktreeRegistration(source, directory, signal);
}

async function isRegisteredWorktree(
  source: string,
  directory: string,
  signal: AbortSignal,
): Promise<boolean> {
  const listing = await git(
    source,
    ['worktree', 'list', '--porcelain', '-z'],
    signal,
  );
  const normalizedDirectory = path.resolve(directory);
  const registered = listing
    .split('\0')
    .filter((line) => line.startsWith('worktree '))
    .some((line) => {
      const candidate = path.resolve(line.slice('worktree '.length));
      return process.platform === 'win32'
        ? candidate.toLowerCase() === normalizedDirectory.toLowerCase()
        : candidate === normalizedDirectory;
    });
  return registered;
}

/** Repository-defined filters are arbitrary commands. A delegated workspace
 * never runs them, including long-lived process filters: every Git command
 * that checks out or hashes its files passes these overrides. */
async function disabledFilterArguments(
  cwd: string,
  signal: AbortSignal,
): Promise<string[]> {
  const keys = (
    await git(cwd, ['config', '--name-only', '--list'], signal)
  ).split('\n');
  const filters = Array.from(
    new Set(
      keys
        .filter((key) =>
          /^filter\..+\.(?:process|clean|smudge|required)$/.test(key),
        )
        .map((key) => key.slice(0, key.lastIndexOf('.'))),
    ),
  );
  if (filters.some((name) => name.includes('=')))
    throw new Error(
      'Unsupported repository filter configuration for isolated checkout.',
    );
  return filters.flatMap((name) => [
    '-c',
    `${name}.process=`,
    '-c',
    `${name}.clean=`,
    '-c',
    `${name}.smudge=`,
    '-c',
    `${name}.required=false`,
  ]);
}

/** Paths Git reports for a delegated worktree, at most this many bytes. */
const CHANGE_LISTING_BYTES = 16 * 1024 * 1024;
const OBJECT_ID = /^[a-f0-9]{40,64}$/;

/** A file an isolated delegate changed since its starting revision. */
export interface IsolatedDelegationChange {
  /** `/`-separated, relative to the worktree root. */
  readonly path: string;
  /** Set for a submodule: how its recorded commit changed. Its objects live
   * in another repository, so only the diff can tell it from a new file. */
  readonly submodule?: 'added' | 'deleted' | 'modified';
}

function nulFields(output: Buffer): string[] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(output);
  const fields = text.split('\0');
  if (fields[fields.length - 1] === '') fields.pop();
  return fields;
}

/**
 * Every file the delegate's worktree differs on from its starting revision:
 * tracked changes, including commits the delegate made, and untracked files
 * Git does not ignore. Read without locks, filters, external diff drivers or
 * submodule recursion, so the delegate's own state never runs a command. A
 * submodule whose recorded commit changed is listed; its contents are not.
 */
export async function isolatedDelegationChanges(
  cwd: string,
  revision: string,
  signal: AbortSignal,
): Promise<IsolatedDelegationChange[]> {
  if (!OBJECT_ID.test(revision))
    throw new Error('Retained isolated workspace revision is invalid.');
  const disabled = await disabledFilterArguments(cwd, signal);
  const tracked = nulFields(
    await gitOutput(
      cwd,
      [
        '--no-optional-locks',
        ...disabled,
        'diff',
        '--raw',
        '-z',
        '--no-abbrev',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        // A changed submodule commit is listed (and refused as not a
        // regular file); work inside a submodule's own checkout is not.
        '--ignore-submodules=dirty',
        revision,
        '--',
      ],
      signal,
      CHANGE_LISTING_BYTES,
    ),
  );
  const changes = new Map<string, IsolatedDelegationChange>();
  for (let index = 0; index < tracked.length; index += 2) {
    const status =
      /^:([0-7]{6}) ([0-7]{6}) [a-f0-9]{40,64} [a-f0-9]{40,64} [A-Z][0-9]*$/.exec(
        tracked[index] ?? '',
      );
    const file = tracked[index + 1];
    if (!status || !file)
      throw new Error('Isolated workspace changes could not be read.');
    const [, before, after] = status;
    changes.set(
      file,
      before === '160000' || after === '160000'
        ? {
            path: file,
            submodule:
              before === '000000'
                ? 'added'
                : after === '000000'
                  ? 'deleted'
                  : 'modified',
          }
        : { path: file },
    );
  }
  const untracked = nulFields(
    await gitOutput(
      cwd,
      [
        '--no-optional-locks',
        ...disabled,
        'ls-files',
        '--others',
        '--exclude-standard',
        '-z',
      ],
      signal,
      CHANGE_LISTING_BYTES,
    ),
  );
  for (const file of untracked)
    if (!changes.has(file)) changes.set(file, { path: file });
  for (const file of await flaggedIndexChanges(cwd, disabled, changes, signal))
    changes.set(file, { path: file });
  return Array.from(changes.values()).sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

/** One changed file's bounded, content-free display statistics. */
export interface IsolatedDelegationSummaryFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
}

/** Counts and top files collected from one retained isolated worktree. */
export interface IsolatedDelegationWorktreeStats {
  readonly startingSubject?: string;
  readonly filesChanged: number;
  readonly additions: number;
  readonly deletions: number;
  readonly commitsAhead: number;
  readonly untrackedFiles: number;
  readonly topFiles: readonly IsolatedDelegationSummaryFile[];
  readonly truncated: boolean;
}

const SUMMARY_TOP_FILES = 10;
/** Bound per-file Git work, even when a delegate creates many large files. */
const SUMMARY_ANALYZED_FILES = 512;
/** Keep the aggregate text scanned for numstat within a fixed memory budget. */
const SUMMARY_DIFF_BYTES = 16 * 1024 * 1024;
/** Reserve at most half the aggregate budget for Git rename similarity scans. */
const SUMMARY_RENAME_DIFF_BYTES = SUMMARY_DIFF_BYTES / 2;
/** Keep argv portable to Git builds with small command-line limits (Windows). */
const SUMMARY_PATHSPEC_ARG_BYTES = 12 * 1024;

interface RawSummaryChange {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: string;
}

interface Numstat {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

type SummaryPathState =
  | { readonly kind: 'file'; readonly size: number }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unsafe' };

function relativeGitPath(file: string): boolean {
  return (
    file.length > 0 &&
    !file.startsWith('/') &&
    !path.win32.isAbsolute(file) &&
    !file.includes('\\') &&
    !hasControlCharacters(file) &&
    file
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function hasControlCharacters(value: string): boolean {
  for (const character of value)
    if (character.charCodeAt(0) < 0x20) return true;
  return false;
}

/** Inspect only path metadata. Neither links nor hard links are followed. */
async function summaryPathState(
  cwd: string,
  file: string,
): Promise<SummaryPathState> {
  if (!relativeGitPath(file)) return { kind: 'unsafe' };
  let current = cwd;
  const parts = file.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index] ?? '');
    let stat: Stats;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (isMissing(error)) return { kind: 'absent' };
      throw error;
    }
    const last = index === parts.length - 1;
    if (stat.isSymbolicLink()) return { kind: 'unsafe' };
    if (!last && !stat.isDirectory()) return { kind: 'unsafe' };
    if (last)
      return stat.isFile() && stat.nlink === 1
        ? { kind: 'file', size: stat.size }
        : { kind: 'unsafe' };
  }
  return { kind: 'unsafe' };
}

function rawSummaryChanges(output: Buffer): RawSummaryChange[] {
  const fields = nulFields(output);
  const changes: RawSummaryChange[] = [];
  for (let index = 0; index < fields.length; ) {
    const header = fields[index++];
    const match =
      /^:([0-7]{6}) ([0-7]{6}) [a-f0-9]{40,64} [a-f0-9]{40,64} ([A-Z][0-9]*)$/.exec(
        header ?? '',
      );
    const status = match?.[3];
    if (!status)
      throw new Error('Isolated workspace changes could not be read.');
    const firstPath = fields[index++];
    if (!firstPath)
      throw new Error('Isolated workspace changes could not be read.');
    if (status.startsWith('R') || status.startsWith('C')) {
      const nextPath = fields[index++];
      if (!nextPath)
        throw new Error('Isolated workspace changes could not be read.');
      changes.push({ path: nextPath, previousPath: firstPath, status });
    } else changes.push({ path: firstPath, status });
  }
  return changes;
}

function parseLineCount(value: string | undefined): number | undefined {
  if (value === '-') return 0;
  if (!value || !/^\d+$/.test(value)) return undefined;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : undefined;
}

function parseNumstat(output: Buffer): Numstat[] {
  const fields = nulFields(output);
  const stats: Numstat[] = [];
  for (let index = 0; index < fields.length; ) {
    const entry = fields[index++];
    const firstTab = entry?.indexOf('\t') ?? -1;
    const secondTab =
      firstTab < 0 ? -1 : (entry?.indexOf('\t', firstTab + 1) ?? -1);
    if (firstTab < 0 || secondTab < 0)
      throw new Error('Isolated workspace changes could not be read.');
    const additions = parseLineCount(entry?.slice(0, firstTab));
    const deletions = parseLineCount(entry?.slice(firstTab + 1, secondTab));
    if (additions === undefined || deletions === undefined)
      throw new Error('Isolated workspace changes could not be read.');
    let file = entry?.slice(secondTab + 1) ?? '';
    // Git emits two NUL-delimited paths for a rename when --numstat -z is used.
    if (!file) {
      const previousPath = fields[index++];
      file = fields[index++] ?? '';
      if (!previousPath || !file)
        throw new Error('Isolated workspace changes could not be read.');
    }
    if (!relativeGitPath(file))
      throw new Error('Isolated workspace changes could not be read.');
    stats.push({ path: file, additions, deletions });
  }
  return stats;
}

function summaryStatus(
  status: string,
): IsolatedDelegationSummaryFile['status'] | undefined {
  switch (status[0]) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'M':
    case 'T':
    case 'U':
      return 'modified';
    case 'R':
    case 'C':
      return 'renamed';
    default:
      return undefined;
  }
}

async function summaryTrackedBlobSizes(
  cwd: string,
  revision: string,
  files: readonly string[],
  signal: AbortSignal,
): Promise<Map<string, number | undefined>> {
  if (!files.length) return new Map();
  const output = await gitOutput(
    cwd,
    ['cat-file', '--batch-check'],
    signal,
    CHANGE_LISTING_BYTES,
    files.map((file) => `${revision}:${file}\n`).join(''),
  );
  const lines = output.toString('utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length !== files.length)
    throw new Error('Isolated workspace changes could not be read.');
  const sizes = new Map<string, number | undefined>();
  files.forEach((file, index) => {
    const line = lines[index] ?? '';
    if (line.endsWith(' missing')) {
      sizes.set(file, undefined);
      return;
    }
    const match = /^[a-f0-9]{40,64} blob ([0-9]+)$/.exec(line);
    if (!match) {
      sizes.set(file, undefined);
      return;
    }
    const size = Number(match[1]);
    sizes.set(file, Number.isSafeInteger(size) ? size : undefined);
  });
  return sizes;
}

async function untrackedSummaryPaths(
  cwd: string,
  disabled: readonly string[],
  signal: AbortSignal,
): Promise<string[]> {
  return nulFields(
    await gitOutput(
      cwd,
      [
        '--no-optional-locks',
        ...disabled,
        'ls-files',
        '--others',
        '--exclude-standard',
        '-z',
      ],
      signal,
      CHANGE_LISTING_BYTES,
    ),
  );
}

/**
 * A read-only bounded summary for the commit and files visible from an
 * isolated delegate's checkout. Content counts omit protected, linked,
 * oversized, and over-budget files; `truncated` records any such omission.
 */
export async function isolatedDelegationWorktreeStats(
  cwd: string,
  revision: string,
  signal: AbortSignal,
): Promise<IsolatedDelegationWorktreeStats> {
  if (!OBJECT_ID.test(revision))
    throw new Error('Retained isolated workspace revision is invalid.');
  const disabled = await disabledFilterArguments(cwd, signal);
  const listed = await isolatedDelegationChanges(cwd, revision, signal);
  const paths = listed.map(({ path: file }) => file);
  const untrackedPaths = await untrackedSummaryPaths(cwd, disabled, signal);
  const untracked = new Set(untrackedPaths);
  const selectedPaths = paths.slice(0, SUMMARY_ANALYZED_FILES);
  let truncated = paths.length > selectedPaths.length;
  const preflight = new Map<string, SummaryPathState>();
  const trackedPaths: string[] = [];
  const safeUntrackedPaths: string[] = [];
  for (const file of selectedPaths) {
    if (!relativeGitPath(file) || !validDelegationPath(file)) {
      truncated = true;
      continue;
    }
    const state = await summaryPathState(cwd, file);
    preflight.set(file, state);
    if (
      state.kind === 'unsafe' ||
      (state.kind === 'file' && state.size > DELEGATION_FILE_MAX_BYTES)
    ) {
      truncated = true;
      continue;
    }
    if (untracked.has(file)) safeUntrackedPaths.push(file);
    else trackedPaths.push(file);
  }

  const baseSizes = await summaryTrackedBlobSizes(
    cwd,
    revision,
    trackedPaths,
    signal,
  );
  const safeTrackedPaths: string[] = [];
  for (const file of trackedPaths) {
    const previousSize = baseSizes.get(file);
    const current = preflight.get(file);
    if (
      (previousSize !== undefined &&
        previousSize > DELEGATION_FILE_MAX_BYTES) ||
      !current ||
      current.kind === 'unsafe' ||
      (previousSize === undefined && current.kind !== 'file')
    ) {
      truncated = true;
      continue;
    }
    safeTrackedPaths.push(file);
  }

  // Infer add/delete/modify from path metadata and the starting tree. Run
  // similarity detection only on safe, size-bounded selected paths; files
  // outside the argv/content budget remain separate add/delete entries.
  const rawTracked: RawSummaryChange[] = [];
  for (const file of safeTrackedPaths) {
    const previousSize = baseSizes.get(file);
    const current = preflight.get(file);
    if (previousSize === undefined && current?.kind === 'file')
      rawTracked.push({ path: file, status: 'A' });
    else if (previousSize !== undefined && current?.kind === 'absent')
      rawTracked.push({ path: file, status: 'D' });
    else if (previousSize !== undefined && current?.kind === 'file')
      rawTracked.push({ path: file, status: 'M' });
    else truncated = true;
  }

  const safeTrackedSet = new Set(safeTrackedPaths);
  const renamedChanges: RawSummaryChange[] = [];
  let renameBytes = 0;
  let renameBatch: string[] = [];
  let renameBatchArgBytes = 0;
  let renameBatchContentBytes = 0;
  const flushRenameBatch = async (): Promise<void> => {
    if (!renameBatch.length) return;
    const changes = rawSummaryChanges(
      await gitOutput(
        cwd,
        [
          '--no-optional-locks',
          ...disabled,
          'diff',
          '--raw',
          '-z',
          '--no-abbrev',
          '--find-renames',
          '--no-ext-diff',
          '--no-textconv',
          '--ignore-submodules=dirty',
          revision,
          '--',
          ...renameBatch.map((file) => `:(literal)${file}`),
        ],
        signal,
        CHANGE_LISTING_BYTES,
      ),
    );
    const selectedInBatch = new Set(renameBatch);
    for (const change of changes) {
      const previousPath = change.previousPath;
      const previousState = previousPath
        ? preflight.get(previousPath)
        : undefined;
      const currentState = preflight.get(change.path);
      if (
        (change.status.startsWith('R') || change.status.startsWith('C')) &&
        previousPath &&
        selectedInBatch.has(previousPath) &&
        selectedInBatch.has(change.path) &&
        safeTrackedSet.has(previousPath) &&
        safeTrackedSet.has(change.path) &&
        baseSizes.get(previousPath) !== undefined &&
        baseSizes.get(change.path) === undefined &&
        previousState?.kind === 'absent' &&
        currentState?.kind === 'file'
      )
        renamedChanges.push(change);
    }
    renameBytes += renameBatchContentBytes;
    renameBatch = [];
    renameBatchArgBytes = 0;
    renameBatchContentBytes = 0;
  };

  for (const file of safeTrackedPaths) {
    const argumentBytes = Buffer.byteLength(`:(literal)${file}`, 'utf8') + 1;
    const current = preflight.get(file);
    const contentBytes =
      (baseSizes.get(file) ?? 0) +
      (current?.kind === 'file' ? current.size : 0);
    if (
      argumentBytes > SUMMARY_PATHSPEC_ARG_BYTES ||
      contentBytes > SUMMARY_RENAME_DIFF_BYTES
    ) {
      truncated = true;
      continue;
    }
    if (
      renameBatch.length &&
      (renameBatchArgBytes + argumentBytes > SUMMARY_PATHSPEC_ARG_BYTES ||
        renameBytes + renameBatchContentBytes + contentBytes >
          SUMMARY_RENAME_DIFF_BYTES)
    ) {
      await flushRenameBatch();
      // Splitting pathspecs can prevent Git from pairing a rename's endpoints.
      // In that case the separately inferred add/delete rows are still safe.
      truncated = true;
    }
    if (renameBytes + contentBytes > SUMMARY_RENAME_DIFF_BYTES) {
      truncated = true;
      continue;
    }
    renameBatch.push(file);
    renameBatchArgBytes += argumentBytes;
    renameBatchContentBytes += contentBytes;
  }
  await flushRenameBatch();

  const renamedPaths = new Set(
    renamedChanges.flatMap(({ path: file, previousPath }) =>
      previousPath ? [previousPath, file] : [file],
    ),
  );
  const unrenamedChanges = rawTracked.filter(
    ({ path: file }) => !renamedPaths.has(file),
  );
  const finalTrackedChanges = [...unrenamedChanges, ...renamedChanges];
  const renamedFiles = renamedChanges.length;
  let remainingBytes = SUMMARY_DIFF_BYTES - renameBytes;
  const selectedTracked: RawSummaryChange[] = [];
  for (const change of finalTrackedChanges) {
    const status = summaryStatus(change.status);
    if (!status) {
      truncated = true;
      continue;
    }
    const previousPath = change.previousPath ?? change.path;
    const previousSize = baseSizes.get(previousPath);
    const current = preflight.get(change.path);
    const currentSize = current?.kind === 'file' ? current.size : undefined;
    const addition = status === 'added' ? currentSize : 0;
    const deletion = status === 'deleted' ? previousSize : 0;
    const unchangedSide = status === 'modified' || status === 'renamed';
    const bytes =
      (addition ?? 0) +
      (deletion ?? 0) +
      (unchangedSide ? (previousSize ?? 0) + (currentSize ?? 0) : 0);
    const needsPrevious =
      status === 'deleted' || status === 'modified' || status === 'renamed';
    const needsCurrent = status !== 'deleted';
    if (
      (needsPrevious && previousSize === undefined) ||
      (needsCurrent && currentSize === undefined) ||
      bytes > remainingBytes
    ) {
      truncated = true;
      continue;
    }
    remainingBytes -= bytes;
    selectedTracked.push(change);
  }

  const trackedStats: Numstat[] = [];
  let batch: RawSummaryChange[] = [];
  let batchBytes = 0;
  const flushBatch = async (): Promise<void> => {
    if (!batch.length) return;
    const pathsForBatch = batch.flatMap(({ path: file, previousPath }) =>
      previousPath ? [previousPath, file] : [file],
    );
    trackedStats.push(
      ...parseNumstat(
        await gitOutput(
          cwd,
          [
            '--no-optional-locks',
            ...disabled,
            'diff',
            '--numstat',
            '-z',
            '--no-renames',
            '--no-ext-diff',
            '--no-textconv',
            '--ignore-submodules=dirty',
            revision,
            '--',
            ...pathsForBatch.map((file) => `:(literal)${file}`),
          ],
          signal,
          CHANGE_LISTING_BYTES,
        ),
      ),
    );
    batch = [];
    batchBytes = 0;
  };
  for (const change of selectedTracked) {
    if (change.previousPath) {
      await flushBatch();
      trackedStats.push(
        ...parseNumstat(
          await gitOutput(
            cwd,
            [
              '--no-optional-locks',
              ...disabled,
              'diff',
              '--numstat',
              '-z',
              '--find-renames',
              '--no-ext-diff',
              '--no-textconv',
              '--ignore-submodules=dirty',
              revision,
              '--',
              `:(literal)${change.previousPath}`,
              `:(literal)${change.path}`,
            ],
            signal,
            CHANGE_LISTING_BYTES,
          ),
        ),
      );
      continue;
    }
    const fileArgs = [change.path];
    const unitBytes = fileArgs.reduce(
      (total, file) =>
        total + Buffer.byteLength(`:(literal)${file}`, 'utf8') + 1,
      0,
    );
    if (unitBytes > SUMMARY_PATHSPEC_ARG_BYTES) {
      truncated = true;
      continue;
    }
    if (batch.length && batchBytes + unitBytes > SUMMARY_PATHSPEC_ARG_BYTES)
      await flushBatch();
    batch.push(change);
    batchBytes += unitBytes;
  }
  await flushBatch();
  const trackedCounts = new Map(
    trackedStats.map((entry) => [entry.path, entry]),
  );
  const summaries: IsolatedDelegationSummaryFile[] = [];
  let additions = 0;
  let deletions = 0;
  for (const change of selectedTracked) {
    const status = summaryStatus(change.status);
    if (!status) continue;
    const counts = trackedCounts.get(change.path);
    const fileAdditions = counts?.additions ?? 0;
    const fileDeletions = counts?.deletions ?? 0;
    additions += fileAdditions;
    deletions += fileDeletions;
    summaries.push({
      path: change.path,
      additions: fileAdditions,
      deletions: fileDeletions,
      status,
    });
  }

  let analyzedFiles = selectedTracked.length;
  for (const file of safeUntrackedPaths) {
    const state = preflight.get(file);
    if (
      analyzedFiles >= SUMMARY_ANALYZED_FILES ||
      state?.kind !== 'file' ||
      state.size > remainingBytes
    ) {
      truncated = true;
      continue;
    }
    remainingBytes -= state.size;
    analyzedFiles += 1;
    const stats = parseNumstat(
      await gitOutput(
        cwd,
        [
          '--no-optional-locks',
          ...disabled,
          'diff',
          '--no-index',
          '--numstat',
          '-z',
          '--no-ext-diff',
          '--no-textconv',
          '--',
          nullDevice,
          file,
        ],
        signal,
        65_536,
        undefined,
        {},
        [0, 1],
      ),
    );
    const counts = stats[0];
    const fileAdditions = counts?.additions ?? 0;
    const fileDeletions = counts?.deletions ?? 0;
    additions += fileAdditions;
    deletions += fileDeletions;
    summaries.push({
      path: file,
      additions: fileAdditions,
      deletions: fileDeletions,
      status: 'untracked',
    });
  }

  summaries.sort((left, right) => {
    const churn =
      right.additions + right.deletions - left.additions - left.deletions;
    if (churn !== 0) return churn;
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });
  if (summaries.length > SUMMARY_TOP_FILES) truncated = true;

  const aheadOutput = await gitOutput(
    cwd,
    ['rev-list', '--count', `${revision}..HEAD`],
    signal,
    128,
  );
  const commitsAhead = Number(aheadOutput.toString('ascii').trim());
  if (!Number.isSafeInteger(commitsAhead) || commitsAhead < 0)
    throw new Error('Isolated workspace changes could not be read.');

  let startingSubject: string | undefined;
  try {
    const subjectOutput = await gitOutput(
      cwd,
      ['show', '-s', '--format=%s', revision],
      signal,
      4096,
    );
    const subject = new TextDecoder('utf-8', { fatal: true })
      .decode(subjectOutput)
      .trim();
    if (subject) startingSubject = subject;
  } catch {
    if (signal.aborted)
      throw new Error('Isolated workspace changes could not be read.');
    truncated = true;
  }

  return {
    ...(startingSubject ? { startingSubject } : {}),
    filesChanged: Math.max(0, paths.length - renamedFiles),
    additions,
    deletions,
    commitsAhead,
    untrackedFiles: untrackedPaths.length,
    topFiles: summaries.slice(0, SUMMARY_TOP_FILES),
    truncated,
  };
}

/** The delegate's index entries, with their `ls-files -v` tags. */
const INDEX_LISTING_BYTES = 64 * 1024 * 1024;

/**
 * Git's diff trusts an index entry marked `assume-unchanged` or
 * `skip-worktree` and never reads that file, so an edit to one is otherwise
 * invisible. Compares each such file on disk with its index entry, which
 * matches the starting revision unless the diff already listed it. A
 * `skip-worktree` file absent from disk is sparse, not deleted.
 */
async function flaggedIndexChanges(
  cwd: string,
  disabled: readonly string[],
  listed: ReadonlyMap<string, IsolatedDelegationChange>,
  signal: AbortSignal,
): Promise<string[]> {
  const entries = nulFields(
    await gitOutput(
      cwd,
      ['--no-optional-locks', 'ls-files', '-v', '-s', '-z'],
      signal,
      INDEX_LISTING_BYTES,
    ),
  );
  const changed: string[] = [];
  const hashed: { file: string; id: string }[] = [];
  for (const entry of entries) {
    const match = /^([A-Za-z?]) ([0-7]{6}) ([a-f0-9]{40,64}) 0\t([^]+)$/.exec(
      entry,
    );
    if (!match) continue;
    const [, tag = '', mode, id = '', file = ''] = match;
    const skipWorktree = tag === 'S' || tag === 's';
    if (!skipWorktree && tag === tag.toUpperCase()) continue;
    if (listed.has(file) || mode === '160000') continue;
    let stat: Stats;
    try {
      stat = await fs.lstat(path.join(cwd, ...file.split('/')));
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      ) {
        if (!skipWorktree) changed.push(file);
        continue;
      }
      throw error;
    }
    if (mode === '120000') {
      // Without symbolic link support, Git writes the target as a file.
      const target = path.join(cwd, ...file.split('/'));
      const content = stat.isSymbolicLink()
        ? await fs.readlink(target, 'buffer')
        : stat.isFile() && stat.size <= 65_536
          ? await fs.readFile(target)
          : undefined;
      if (!content || blobId(id, content) !== id) changed.push(file);
    } else if (!stat.isFile() || /[\r\n]/.test(file)) {
      // Hashing reads one path per line; such a name is listed unread.
      changed.push(file);
    } else hashed.push({ file, id });
  }
  if (!hashed.length) return changed;
  const ids = (
    await gitOutput(
      cwd,
      ['--no-optional-locks', ...disabled, 'hash-object', '--stdin-paths'],
      signal,
      hashed.length * 66,
      hashed.map(({ file }) => `${file}\n`).join(''),
    )
  )
    .toString('utf8')
    .split('\n');
  if (ids[ids.length - 1] === '') ids.pop();
  if (ids.length !== hashed.length)
    throw new Error('Isolated workspace changes could not be read.');
  hashed.forEach(({ file, id }, index) => {
    if (ids[index] !== id) changed.push(file);
  });
  return changed;
}

/** The object ID Git gives `content` as a blob, in `like`'s hash format. */
function blobId(like: string, content: Buffer): string {
  return createHash(like.length === 40 ? 'sha1' : 'sha256')
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest('hex');
}

/** A path's entry in the delegate's starting revision. */
export type IsolatedDelegationBase =
  | {
      readonly kind: 'file';
      readonly size: number;
      /** False when the copy was over a limit and never written to disk. */
      readonly checkedOut: boolean;
    }
  | { readonly kind: 'other' };

/**
 * Checks out the starting copies of `paths` into `<directory>/files`, as
 * checking out `revision` writes them: with Git's built-in conversions (line
 * endings, `ident`), never repository filters. `directory` is a private,
 * empty directory the caller owns and removes. Returns each path the
 * revision holds; one it lacks is absent from the map, a tree or submodule is
 * `other`, and a file (or symbolic link) is checked out. The size is the
 * stored blob's, before conversion. A file over `limits.fileBytes`, or past
 * `limits.totalBytes` of files in `paths` order, is never written.
 */
export async function materializeIsolatedDelegationBases(
  cwd: string,
  revision: string,
  paths: readonly string[],
  directory: string,
  signal: AbortSignal,
  limits: { readonly fileBytes: number; readonly totalBytes: number },
): Promise<Map<string, IsolatedDelegationBase>> {
  if (!OBJECT_ID.test(revision))
    throw new Error('Retained isolated workspace revision is invalid.');
  const bases = new Map<string, IsolatedDelegationBase>();
  // Batch input is one path per line; such names are never applied anyway.
  const requested = paths.filter((file) => !/[\0\r\n]/.test(file));
  if (!requested.length) return bases;
  const unreadable = (): Error =>
    new Error('Isolated workspace starting copies could not be read.');
  const entries = (
    await gitOutput(
      cwd,
      ['cat-file', '--batch-check'],
      signal,
      // A missing path's reply repeats its whole `<revision>:<path>` input.
      requested.reduce(
        (total, file) =>
          total + Buffer.byteLength(file, 'utf8') + revision.length + 200,
        0,
      ),
      requested.map((file) => `${revision}:${file}\n`).join(''),
    )
  )
    .toString('utf8')
    .split('\n');
  if (entries[entries.length - 1] === '') entries.pop();
  if (entries.length !== requested.length) throw unreadable();
  const files: string[] = [];
  let total = 0;
  requested.forEach((file, index) => {
    const line = entries[index] ?? '';
    if (line === `${revision}:${file} missing`) return;
    // Git 2.51+ identifies gitlinks without looking in the submodule's store.
    if (/^[a-f0-9]{40,64} submodule$/.test(line)) {
      bases.set(file, { kind: 'other' });
      return;
    }
    const match = /^[a-f0-9]{40,64} ([a-z]+) ([0-9]+)$/.exec(line);
    if (!match) throw unreadable();
    const [, type, size] = match;
    if (type !== 'blob') {
      bases.set(file, { kind: 'other' });
      return;
    }
    const bytes = Number(size);
    const checkedOut =
      bytes <= limits.fileBytes && total + bytes <= limits.totalBytes;
    bases.set(file, { kind: 'file', size: bytes, checkedOut });
    if (!checkedOut) return;
    total += bytes;
    files.push(file);
  });
  if (!files.length) return bases;
  const disabled = await disabledFilterArguments(cwd, signal);
  // A private index keeps the delegate's own index, and its checkout, untouched.
  const index = { GIT_INDEX_FILE: path.join(directory, 'index') };
  await gitOutput(
    cwd,
    [...disabled, 'read-tree', revision],
    signal,
    65_536,
    undefined,
    index,
  );
  const prefix = `${path.join(directory, 'files').split(path.sep).join('/')}/`;
  await gitOutput(
    cwd,
    [
      ...disabled,
      'checkout-index',
      '-q',
      '-z',
      '--stdin',
      `--prefix=${prefix}`,
    ],
    signal,
    65_536,
    `${files.join('\0')}\0`,
    index,
  );
  return bases;
}

export async function createIsolatedDelegationWorktree(
  source: string,
  directory: string,
  signal: AbortSignal,
  retain?: (
    workspace: { cwd: string; revision: string; ready: boolean } | undefined,
  ) => Promise<void>,
): Promise<{ cwd: string; revision: string }> {
  await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  const canonicalDirectory = path.join(
    await fs.realpath(path.dirname(directory)),
    path.basename(directory),
  );
  const destinationExisted = await exists(canonicalDirectory);
  const revision = await git(source, ['rev-parse', '--verify', 'HEAD'], signal);
  if (!/^[a-f0-9]{40,64}$/.test(revision))
    throw new Error('A committed source revision is required for isolation.');
  if (destinationExisted)
    throw new Error('Isolated workspace destination already exists.');
  // Existing dirty changes intentionally remain in the parent's worktree. The
  // returned revision is the exact clean base; applying later uses expected text.
  let journaled = false;
  try {
    await retain?.({ cwd: canonicalDirectory, revision, ready: false });
    journaled = retain !== undefined;
    await git(
      source,
      [
        'worktree',
        'add',
        '--no-checkout',
        '--detach',
        '--',
        canonicalDirectory,
        revision,
      ],
      signal,
    );
    const disabled = await disabledFilterArguments(canonicalDirectory, signal);
    await git(
      canonicalDirectory,
      [...disabled, 'reset', '--hard', revision],
      signal,
    );
    const workspace = { cwd: await fs.realpath(canonicalDirectory), revision };
    await retain?.({ ...workspace, ready: true });
    return workspace;
  } catch (error) {
    let cleanupConfirmed = false;
    if (!destinationExisted) {
      try {
        await removeRegisteredWorktree(source, canonicalDirectory);
        await fs.rm(canonicalDirectory, removal);
        cleanupConfirmed =
          !(await exists(canonicalDirectory)) &&
          !(await isRegisteredWorktree(
            source,
            canonicalDirectory,
            new AbortController().signal,
          ));
      } catch {
        cleanupConfirmed = false;
      }
    }
    if (journaled && cleanupConfirmed)
      await retain?.(undefined).catch(() => undefined);
    throw error;
  }
}

export async function discardIsolatedDelegationWorktree(
  source: string,
  directory: string,
  signal: AbortSignal,
): Promise<void> {
  // The caller validates the durable ownership record and explicit discard intent.
  await removeWorktreeRegistration(source, directory, signal);
}

export async function reconcileIsolatedDelegationWorktree(
  source: string,
  expectedDirectory: string,
  retainedDirectory: string,
  revision: string,
): Promise<void> {
  if (!/^[a-f0-9]{40,64}$/.test(revision))
    throw new Error('Retained isolated workspace revision is invalid.');
  await fs.mkdir(path.dirname(expectedDirectory), {
    recursive: true,
    mode: 0o700,
  });
  const canonicalExpected = path.join(
    await fs.realpath(path.dirname(expectedDirectory)),
    path.basename(expectedDirectory),
  );
  const expected = path.resolve(canonicalExpected);
  const retained = path.resolve(retainedDirectory);
  const matches =
    process.platform === 'win32'
      ? expected.toLowerCase() === retained.toLowerCase()
      : expected === retained;
  if (!matches)
    throw new Error('Retained isolated workspace ownership does not match.');
  await removeRegisteredWorktree(source, canonicalExpected);
  // A root replaced by a link is unlinked above; never walk or remove through it.
  if (await isLink(canonicalExpected)) {
    await fs.unlink(canonicalExpected);
    return;
  }
  await removeWindowsWorktreeReparsePoints(canonicalExpected);
  await fs.rm(canonicalExpected, removal);
}
