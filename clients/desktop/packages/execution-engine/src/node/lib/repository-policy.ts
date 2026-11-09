import {
  isDirectInstructionAlias,
  READABLE_INSTRUCTION_ALIAS_RULES,
} from '@canopy/core-runtime/node/workspace/instruction-files';
import type { Stats } from 'node:fs';
import { lstat, readlink, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  contained,
  MAX_FILE_BYTES,
  readBoundedBytes,
  safePath,
} from './bounded-file-reader';

/** Host-owned checkout identity, never inferred from prompt text or Git discovery. */
export type RepositoryPolicyScope =
  | { kind: 'rootless' }
  | { kind: 'checkout'; root: string };
type FailureStatus = 'unreadable' | 'unsupported-layout' | 'oversize';
interface RepositoryPolicyEntry {
  path: string;
  result: 'content' | 'alias' | 'copy' | 'pointer' | 'absent' | FailureStatus;
}
interface PolicyRecord {
  entries: RepositoryPolicyEntry[];
}
type HostRepositoryPolicy = PolicyRecord &
  (
    | { status: 'delivered'; block: string }
    | { status: 'absent'; block: '' }
    | { status: FailureStatus; message: string }
  );
interface RepositoryPolicyOptions {
  signal?: AbortSignal;
}
const names = ['CLAUDE.md', 'AGENTS.md'] as const;
const MAX_BLOCK_BYTES = 128 * 1024;
class PolicyError extends Error {
  constructor(
    readonly status: FailureStatus,
    message: string,
    readonly path?: string,
  ) {
    super(message);
  }
}
function code(error: unknown): string | undefined {
  return error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}
function instructionReadFailure(path: string, error: unknown): string {
  const errorCode = code(error);
  if (errorCode === 'EACCES' || errorCode === 'EPERM')
    return `Instruction file ${path} isn't readable. Check its permissions, then try again.`;
  if (errorCode === 'ENOENT')
    return `Instruction file ${path} is no longer available. Restore it, then try again.`;
  if (error instanceof Error && error.message === 'too-large')
    return `Instruction file ${path} exceeds 64 KiB. Reduce its size, then try again.`;
  return `Couldn't read instruction file ${path}. Check that it is available and readable, then try again.`;
}
async function maybeStat(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (code(error) === 'ENOENT') return undefined;
    throw error;
  }
}
function same(a: Stats | undefined, b: Stats | undefined): boolean {
  return !a || !b
    ? a === b
    : a.dev === b.dev &&
        a.ino === b.ino &&
        a.mode === b.mode &&
        a.size === b.size &&
        a.mtimeMs === b.mtimeMs &&
        a.ctimeMs === b.ctimeMs;
}
async function directories(
  scope: RepositoryPolicyScope,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ root: string; dirs: string[] }> {
  if (scope.kind !== 'checkout') throw new Error('Checkout scope required.');
  if (
    !isAbsolute(scope.root) ||
    !isAbsolute(cwd) ||
    !contained(resolve(scope.root), resolve(cwd))
  )
    throw new PolicyError(
      'unsupported-layout',
      "The step folder is outside this run's saved checkout. Run the workflow again from the intended project or folder. Start over keeps this run's saved checkout.",
    );
  const root = await realpath(scope.root);
  if (!(await stat(root)).isDirectory())
    throw new Error('Checkout root is not a directory.');
  const rel = relative(resolve(scope.root), resolve(cwd));
  const dirs = [''];
  if (rel) {
    const parts = rel.split(sep);
    for (let i = 1; i <= parts.length; i++) {
      signal?.throwIfAborted();
      const path = parts.slice(0, i).join('/');
      try {
        if (!(await lstat(await safePath(root, path))).isDirectory())
          throw new PolicyError(
            'unsupported-layout',
            'Step directory is not a regular checkout directory.',
          );
      } catch (error) {
        if (error instanceof Error && error.message === 'unsafe-path')
          throw new PolicyError(
            'unsupported-layout',
            'Step directory contains a link or an unsupported name. Select a regular directory without colons, backslashes or control characters.',
          );
        throw error;
      }
      dirs.push(path);
    }
  }
  return { root, dirs };
}
async function readPair(
  root: string,
  dir: string,
  signal?: AbortSignal,
): Promise<{ bodies: string[]; entries: RepositoryPolicyEntry[] }> {
  const paths = names.map((name) => (dir ? `${dir}/${name}` : name));
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const before = await Promise.all(
      paths.map(async (path) => {
        try {
          return await maybeStat(join(root, path));
        } catch (error) {
          throw new PolicyError(
            'unreadable',
            instructionReadFailure(path, error),
            path,
          );
        }
      }),
    );
    let activePath = paths[0];
    try {
      const entries: RepositoryPolicyEntry[] = [];
      const values: (Buffer | undefined)[] = [];
      for (let i = 0; i < paths.length; i++) {
        const item = before[i];
        const path = paths[i];
        activePath = path;
        if (!item) {
          entries.push({ path, result: 'absent' });
          continue;
        }
        if (item.isSymbolicLink()) {
          if (
            !(await isDirectInstructionAlias(
              join(root, path),
              join(root, paths[1 - i]),
              { readlink },
              READABLE_INSTRUCTION_ALIAS_RULES,
            )) ||
            !before[1 - i]?.isFile()
          )
            throw new PolicyError(
              'unsupported-layout',
              `Unsupported or dangling instruction link: ${path}`,
            );
          entries.push({ path, result: 'alias' });
        } else {
          if (!item.isFile())
            throw new PolicyError(
              'unsupported-layout',
              `Instruction is not a regular file: ${path}`,
            );
          values[i] = await readBoundedBytes(
            root,
            path,
            MAX_FILE_BYTES,
            signal,
          );
          entries.push({ path, result: 'content' });
        }
      }
      const after = await Promise.all(
        paths.map((path) => maybeStat(join(root, path))),
      );
      if (!before.every((value, i) => same(value, after[i])))
        throw new Error('changed');
      const pointers = values.map(
        (value, i) => value?.toString('utf8').trim() === names[1 - i],
      );
      if (pointers.some(Boolean)) {
        if (
          (pointers[0] && pointers[1]) ||
          pointers.some((pointer, i) => pointer && !values[1 - i])
        )
          throw new PolicyError(
            'unsupported-layout',
            `Unresolved instruction pointer: ${dir || '.'}`,
          );
        for (let i = 0; i < pointers.length; i++)
          if (pointers[i]) {
            values[i] = undefined;
            entries[i].result = 'pointer';
          }
      } else if (values[0] && values[1] && values[0].equals(values[1])) {
        values[1] = undefined;
        entries[1].result = 'copy';
      }
      return {
        entries,
        bodies: paths.flatMap((path, i) => {
          const value = values[i];
          return value ? [`### ${path}\n${value.toString('utf8')}`] : [];
        }),
      };
    } catch (error) {
      signal?.throwIfAborted();
      const current = await Promise.all(
        paths.map((path) => maybeStat(join(root, path))),
      );
      const changed =
        (error instanceof Error && error.message === 'changed') ||
        !before.every((value, i) => same(value, current[i]));
      if (changed && attempt === 0) continue;
      if (changed)
        throw new PolicyError(
          'unreadable',
          `Instruction changed repeatedly: ${activePath}`,
          activePath,
        );
      if (error instanceof PolicyError)
        throw new PolicyError(error.status, error.message, activePath);
      throw new PolicyError(
        error instanceof Error && error.message === 'too-large'
          ? 'oversize'
          : 'unreadable',
        instructionReadFailure(activePath, error),
        activePath,
      );
    }
  }
}
/** One immutable value per owner; the Copilot adapter retains it until invocation settlement. */
export async function resolveHostRepositoryPolicy(
  scope: RepositoryPolicyScope | undefined,
  cwd: string,
  options: RepositoryPolicyOptions = {},
): Promise<HostRepositoryPolicy> {
  const entries: RepositoryPolicyEntry[] = [];
  try {
    options.signal?.throwIfAborted();
    if (!scope)
      throw new PolicyError(
        'unreadable',
        "This run's checkout is unknown. Run the workflow again from its project or folder. Start over can't recover it.",
      );
    if (scope.kind === 'rootless')
      return { status: 'absent', block: '', entries };
    const { root, dirs } = await directories(scope, cwd, options.signal);
    const bodies: string[] = [];
    for (const dir of dirs) {
      const pair = await readPair(root, dir, options.signal);
      entries.push(...pair.entries);
      bodies.push(...pair.bodies);
      if (Buffer.byteLength(bodies.join('\n\n'), 'utf8') > MAX_BLOCK_BYTES)
        throw new PolicyError(
          'oversize',
          'Formatted repository instructions exceed 128 KiB.',
        );
    }
    options.signal?.throwIfAborted();
    const block = bodies.join('\n\n');
    return block
      ? {
          status: 'delivered',
          block,
          entries,
        }
      : { status: 'absent', block: '', entries };
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof PolicyError && error.path)
      entries.push({ path: error.path, result: error.status });
    const status =
      error instanceof PolicyError
        ? error.status
        : error instanceof Error && error.message === 'too-large'
          ? 'oversize'
          : 'unreadable';
    const errorCode = code(error);
    const reason =
      error instanceof PolicyError
        ? error.message
        : errorCode === 'ENOENT'
          ? 'The checkout or step folder is missing. Restore it or select an existing folder and run the workflow again.'
          : errorCode === 'EACCES' || errorCode === 'EPERM'
            ? "The checkout or step folder isn't readable. Check its permissions, then try again."
            : 'Check that the checkout and instruction files are available and readable, then try again.';
    return {
      status,
      message: `Couldn't prepare repository instructions. ${reason}`,
      entries,
    };
  }
}
