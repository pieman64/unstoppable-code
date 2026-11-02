import type { WorkerGitDiffFile } from '@canopy/protocol/canopy-core';
import { WORKER_GIT_DIFF_MAX_PATCH_LENGTH } from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import { gitChangeSetRangeArgs, type GitChangeSetRange } from './change-set';

/** At most this many listed files get a patch per call. */
export const GIT_CHANGE_SET_MAX_PATCHES = 20;

/**
 * One tracked file's patch read: `diff <range> --patch` limited, literally,
 * to `paths`.
 */
export interface GitPatchRead {
  readonly range: GitChangeSetRange;
  /**
   * The file; for a rename or copy, also its source and every other listed
   * destination of that source, so Git pairs them as the listing did.
   */
  readonly paths: readonly string[];
}

/**
 * The argv of a {@link GitPatchRead}, after the Git executable. Headers are
 * pinned to Git's default prefixes and quoting, so a file's section is found
 * by its header and untracked patches match. No external diff driver runs;
 * textconv drivers still do. A working-tree read takes no optional lock.
 */
export function gitPatchReadArgs(read: GitPatchRead): string[] {
  return [
    '-c',
    'core.quotePath=true',
    ...(read.range.kind === 'worktree' ? ['--no-optional-locks'] : []),
    '--literal-pathspecs',
    'diff',
    ...gitChangeSetRangeArgs(read.range),
    '--patch',
    '--no-color',
    '--no-ext-diff',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '--find-renames',
    '--find-copies',
    '--',
    ...read.paths,
  ];
}

/** An untracked file's content, read without following a final symlink. */
export type GitUntrackedContent =
  | {
      readonly kind: 'file';
      readonly executable: boolean;
      /** At most the requested bytes, from the start. */
      readonly data: Uint8Array;
      /** The file's full size in bytes. */
      readonly size: number;
    }
  | { readonly kind: 'symlink'; readonly target: string };

/** Host reads for patches of one repository. */
export interface GitPatchReader {
  /**
   * Stdout of a {@link GitPatchRead} that exited 0, cut at `maxBytes`;
   * `truncated` when Git printed more. Any other outcome rejects.
   */
  readPatch(
    this: void,
    read: GitPatchRead,
    maxBytes: number,
  ): Promise<{ readonly data: Uint8Array; readonly truncated: boolean }>;
  /**
   * The content of an untracked path the engine's own listing returned,
   * confined to the checkout; `null` for a directory, a special file, a path
   * that left the checkout or one that cannot be read.
   */
  readUntracked(
    this: void,
    path: string,
    maxBytes: number,
  ): Promise<GitUntrackedContent | null>;
}

/** Bytes as UTF-8; a cut prefix drops the sequence the cut left incomplete. */
function decode(data: Uint8Array, cut: boolean): string {
  return new TextDecoder('utf-8').decode(data, { stream: cut });
}

const C_ESCAPES: Readonly<Record<number, string>> = {
  0x07: '\\a',
  0x08: '\\b',
  0x09: '\\t',
  0x0a: '\\n',
  0x0b: '\\v',
  0x0c: '\\f',
  0x0d: '\\r',
  0x22: '\\"',
  0x5c: '\\\\',
};

/**
 * A patch header name as Git prints it with its default `core.quotePath`:
 * quoted, with C escapes and octal bytes, when it holds a quote, a backslash,
 * a control character or a non-ASCII byte.
 */
export function gitQuotedPatchName(name: string): string {
  const bytes = new TextEncoder().encode(name);
  let quoted = false;
  let text = '';
  for (const byte of bytes) {
    const escape = C_ESCAPES[byte];
    if (escape !== undefined) {
      quoted = true;
      text += escape;
    } else if (byte < 0x20 || byte >= 0x7f) {
      quoted = true;
      text += `\\${byte.toString(8).padStart(3, '0')}`;
    } else text += String.fromCharCode(byte);
  }
  return quoted ? `"${text}"` : text;
}

/** Git's binary test: a NUL in the first 8,000 bytes. */
function looksBinary(data: Uint8Array): boolean {
  return data.subarray(0, 8_000).includes(0);
}

/**
 * The patch Git prints for an untracked file against nothing, without the
 * `index` line: what `git diff --no-index /dev/null <path>` shows, without
 * running it on a caller's path.
 */
export function untrackedFilePatch(
  path: string,
  content: GitUntrackedContent,
  maxBytes: number,
): { patch: string; truncated: boolean } | 'binary' {
  let mode: string;
  let text: string;
  let truncated = false;
  if (content.kind === 'symlink') {
    mode = '120000';
    text = content.target;
  } else {
    if (looksBinary(content.data)) return 'binary';
    mode = content.executable ? '100755' : '100644';
    const data = content.data.subarray(0, maxBytes);
    truncated = content.size > data.byteLength;
    text = decode(data, truncated);
  }
  const header = `${sectionHeader(path, path)}\nnew file mode ${mode}\n`;
  if (text === '') return { patch: header, truncated };
  const endsWithNewline = text.endsWith('\n');
  const lines = (endsWithNewline ? text.slice(0, -1) : text).split('\n');
  const count = lines.length === 1 ? '1' : `1,${lines.length}`;
  return {
    patch:
      header +
      // Git ends a name holding a space with a tab.
      `--- /dev/null\n+++ ${gitQuotedPatchName(`b/${path}`)}${path.includes(' ') ? '\t' : ''}\n@@ -0,0 +${count} @@\n` +
      lines.map((line) => `+${line}\n`).join('') +
      (endsWithNewline || truncated ? '' : '\\ No newline at end of file\n'),
    truncated,
  };
}

/** `diff --git` sections; a body line never starts with that header. */
function sections(patch: string): string[] {
  const starts: number[] = [];
  const header = /^diff --git /gm;
  for (let match = header.exec(patch); match; match = header.exec(patch))
    starts.push(match.index);
  return starts.map((start, index) =>
    patch.slice(start, starts[index + 1] ?? patch.length),
  );
}

function isBinarySection(section: string): boolean {
  return section
    .split('\n')
    .some(
      (line) => line.startsWith('Binary files ') || line === 'GIT binary patch',
    );
}

/** The `diff --git` line Git prints with the pinned prefixes and quoting. */
function sectionHeader(from: string, to: string): string {
  return `diff --git ${gitQuotedPatchName(`a/${from}`)} ${gitQuotedPatchName(`b/${to}`)}`;
}

function firstLine(section: string): string {
  const end = section.indexOf('\n');
  return end === -1 ? section : section.slice(0, end);
}

/**
 * The part of a pathspec-limited patch that belongs to one listed file. A
 * rename or copy read with its source and siblings also prints their
 * changes; only the section pairing the source with this file is kept, or
 * this file's own sections when Git did not pair it.
 */
export function selectFilePatch(
  stdout: string,
  path: string,
  previousPath: string | null,
): string {
  if (previousPath === null) return stdout;
  const all = sections(stdout);
  const paired = all.filter(
    (section) => firstLine(section) === sectionHeader(previousPath, path),
  );
  if (paired.length > 0) return paired.join('');
  return all
    .filter((section) => firstLine(section) === sectionHeader(path, path))
    .join('');
}

function exhausted(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'resource_exhausted',
    message: 'The comparison is too large for one result.',
    retry: { kind: 'after_refresh', resource: 'repository' },
  });
}

function internal(cause: unknown): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'internal',
      message: 'Git could not read a patch.',
      retry: { kind: 'never' },
    },
    cause,
  );
}

/**
 * The listed files `paths` names by `path` or `previousPath`, the first
 * {@link GIT_CHANGE_SET_MAX_PATCHES} of them with patches. Binary files keep
 * `patch` `null`. `truncated` is set when a named file went unpatched or a
 * patch was cut. Patches past `budget` bytes of JSON text in total fail with
 * `resource_exhausted` before more is read.
 */
export async function withGitPatches(
  reader: GitPatchReader,
  range: GitChangeSetRange,
  listed: { files: WorkerGitDiffFile[]; truncated: boolean },
  paths: readonly string[],
  budget: number,
): Promise<{ files: WorkerGitDiffFile[]; truncated: boolean }> {
  const named = new Set(paths);
  const files = listed.files.filter(
    (file) =>
      named.has(file.path) ||
      (file.previousPath !== null && named.has(file.previousPath)),
  );
  // Every listed destination of each rename or copy source.
  const destinations = new Map<string, string[]>();
  for (const file of listed.files)
    if (file.previousPath !== null)
      destinations.set(file.previousPath, [
        ...(destinations.get(file.previousPath) ?? []),
        file.path,
      ]);
  let truncated = listed.truncated || files.length > GIT_CHANGE_SET_MAX_PATCHES;
  let total = 0;
  const result: WorkerGitDiffFile[] = [];
  for (const [index, file] of files.entries()) {
    if (index >= GIT_CHANGE_SET_MAX_PATCHES || file.binary === true) {
      result.push(file);
      continue;
    }
    const pathspecs =
      file.previousPath === null
        ? [file.path]
        : [file.previousPath, ...(destinations.get(file.previousPath) ?? [])];
    const patched = await patchFile(reader, range, file, pathspecs);
    truncated ||= patched.truncated;
    const { patch } = patched.file;
    total += patch === null ? 0 : Buffer.byteLength(JSON.stringify(patch));
    if (total > budget) throw exhausted();
    result.push(patched.file);
  }
  return { files: result, truncated };
}

/** One listed file with its patch, or marked binary when Git shows it so. */
async function patchFile(
  reader: GitPatchReader,
  range: GitChangeSetRange,
  file: WorkerGitDiffFile,
  pathspecs: readonly string[],
): Promise<{ file: WorkerGitDiffFile; truncated: boolean }> {
  let patched: { patch: string; truncated: boolean } | 'binary' | null;
  try {
    patched =
      file.status === 'untracked'
        ? await untrackedPatch(reader, file.path)
        : await trackedPatch(reader, range, file, pathspecs);
  } catch (error) {
    throw internal(error);
  }
  if (patched === null) return { file, truncated: false };
  if (patched === 'binary' || isBinarySection(patched.patch))
    return { file: { ...file, binary: true }, truncated: false };
  const patch = patched.patch.slice(0, WORKER_GIT_DIFF_MAX_PATCH_LENGTH);
  return {
    file: { ...file, patch: patch === '' ? null : patch },
    truncated: patched.truncated || patch.length < patched.patch.length,
  };
}

async function trackedPatch(
  reader: GitPatchReader,
  range: GitChangeSetRange,
  file: WorkerGitDiffFile,
  paths: readonly string[],
): Promise<{ patch: string; truncated: boolean }> {
  const { data, truncated } = await reader.readPatch(
    { range, paths },
    WORKER_GIT_DIFF_MAX_PATCH_LENGTH,
  );
  return {
    patch: selectFilePatch(
      decode(data, truncated),
      file.path,
      file.previousPath,
    ),
    truncated,
  };
}

async function untrackedPatch(
  reader: GitPatchReader,
  path: string,
): Promise<{ patch: string; truncated: boolean } | 'binary' | null> {
  const content = await reader.readUntracked(
    path,
    WORKER_GIT_DIFF_MAX_PATCH_LENGTH,
  );
  return content === null
    ? null
    : untrackedFilePatch(path, content, WORKER_GIT_DIFF_MAX_PATCH_LENGTH);
}
