import { GitIgnoreHostError } from '@canopy/core-runtime/node';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import { GitReadError, type GitReadCommand } from '../git-read/commands';
import {
  createGitReadHostWith,
  type GitReadHost,
  type GitReadHostOptions,
  type GitReadHostSeams,
} from '../git-read/host';
import type {
  GitReadOutput,
  GitReadRequest,
  GitReadRunner,
  GitReadRunnerOptions,
} from '../git-read/runner';
import type { SelectionIo, SelectionStats } from '../git-read/selection';

/** The shared table's virtual filesystem entries. */
export type FileEntry =
  | { readonly kind: 'missing' | 'eacces' | 'directory' | 'shim' | 'noexec' }
  | {
      readonly kind: 'executable';
      readonly stdout: string;
      readonly transient?: 'timeout';
    }
  | { readonly kind: 'symlink'; readonly target: string };

export interface ProbeCall {
  readonly command: GitReadCommand;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

/** A host-neutral world: lookups and probes answer from these tables. */
export interface World {
  os: PlatformOperatingSystem;
  filesystem: Record<string, FileEntry>;
  loginPath: string;
  developerDir: string | null;
  whereExe: Record<string, string>;
  /** Candidate lookups: `realpath` on macOS, `stat` elsewhere, as desktop's table. */
  attempts: string[];
  probes: ProbeCall[];
  /** Executables a probe ran. */
  ran: string[];
  /** Each `check-ignore` chunk's executable and cwd. */
  checks: { readonly executable: string; readonly cwd: string }[];
  /** Holds probes by kind, or by executable, until released. */
  gates: Map<string, Promise<void>>;
  /** `getent passwd` stdout; unset fails the lookup. */
  getent?: string;
}

/** Answers the login-shell executable check without recording an attempt. */
export const LOGIN_SHELL = '/canopy-test/login-shell';

export function createWorld(
  os: PlatformOperatingSystem,
  overrides: Partial<World> = {},
): World {
  return {
    os,
    filesystem: {},
    loginPath: '/usr/bin',
    developerDir: null,
    whereExe: {},
    attempts: [],
    probes: [],
    ran: [],
    checks: [],
    gates: new Map(),
    ...overrides,
  };
}

export function errno(code: string, syscall?: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code, syscall });
}

/** Follows symlinks to the final path; unlisted paths are missing. */
export function resolveEntry(
  world: World,
  target: string,
): { readonly path: string; readonly entry: FileEntry } {
  let current = target;
  for (let hop = 0; hop < 8; hop += 1) {
    const entry = world.filesystem[current] ?? { kind: 'missing' };
    if (entry.kind !== 'symlink') return { path: current, entry };
    current = entry.target;
  }
  throw new Error(`Symlink loop at ${target}`);
}

function lookup(
  world: World,
  target: string,
): { readonly path: string; readonly entry: FileEntry } {
  const found = resolveEntry(world, target);
  if (found.entry.kind === 'missing') throw errno('ENOENT');
  if (found.entry.kind === 'eacces') throw errno('EACCES');
  return found;
}

function hash(text: string): number {
  let value = 7;
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) >>> 0;
  return value;
}

/** Identity: the final path is the inode; the entry (not its transient behavior) the content. */
function statsOf(target: string, entry: FileEntry): SelectionStats {
  const content =
    entry.kind === 'executable'
      ? JSON.stringify([entry.kind, entry.stdout])
      : entry.kind;
  return {
    dev: 1,
    ino: hash(target),
    size: content.length,
    mtimeMs: hash(content),
    ctimeMs: hash(content),
    isFile: () => entry.kind !== 'directory',
  };
}

/** `work`'s result, or its throw as a rejection. */
const settled = <T>(work: () => T): Promise<T> => Promise.resolve().then(work);

export function worldIo(world: World): SelectionIo {
  return {
    stat: (target) =>
      settled((): SelectionStats => {
        if (target === LOGIN_SHELL) return statsOf(target, { kind: 'noexec' });
        if (world.os !== 'darwin') world.attempts.push(target);
        const found = lookup(world, target);
        return statsOf(found.path, found.entry);
      }),
    realpath: (target) =>
      settled((): string => {
        if (world.os === 'darwin') world.attempts.push(target);
        return lookup(world, target).path;
      }),
    access: (target) =>
      settled((): void => {
        if (target === LOGIN_SHELL) return;
        const { entry } = lookup(world, target);
        if (entry.kind !== 'executable' && entry.kind !== 'shim')
          throw errno('EACCES');
      }),
  };
}

const output = (stdout: string, code = 0): GitReadOutput => ({
  code,
  signal: null,
  stdout,
  stderr: '',
  pipes: 'closed',
});

function answer(world: World, command: GitReadCommand): GitReadOutput {
  switch (command.kind) {
    case 'macos-login-shell-path':
      return output(`${world.loginPath}\n`);
    case 'linux-login-shell-path':
      return output(`__CANOPY_LOGIN_PATH__${world.loginPath}\n`);
    case 'getent-passwd':
      return world.getent === undefined ? output('', 2) : output(world.getent);
    case 'xcode-select-print-path':
      return world.developerDir === null
        ? output('', 1)
        : output(world.developerDir);
    case 'where-git': {
      const listed = world.whereExe.git;
      return listed === undefined ? output('', 1) : output(listed);
    }
    case 'git-version':
    case 'git-bare-init-smoke': {
      world.ran.push(command.executable);
      const { entry } = resolveEntry(world, command.executable);
      if (entry.kind === 'missing')
        throw errno('ENOENT', `spawn ${command.executable}`);
      if (entry.kind !== 'executable')
        throw errno('EACCES', `spawn ${command.executable}`);
      if (entry.transient === 'timeout') throw new GitReadError('timeout');
      return output(command.kind === 'git-version' ? entry.stdout : '');
    }
    case 'git-check-ignore':
      throw new Error('check-ignore runs through checkIgnoredPathsSelected');
  }
}

/** A runner-shaped executor over `world`; each chunk reports its executable. */
export function worldRunner(
  world: World,
  captured?: { options?: GitReadRunnerOptions },
): (options: GitReadRunnerOptions) => GitReadRunner {
  return (options) => {
    if (captured) captured.options = options;
    const hostAborted = (): void => options.hostSignal?.throwIfAborted();
    return {
      async run(
        command: GitReadCommand,
        request: GitReadRequest,
      ): Promise<GitReadOutput> {
        hostAborted();
        world.probes.push({
          command,
          cwd: request.cwd,
          environment: request.environment,
        });
        await world.gates.get(command.kind);
        if ('executable' in command) await world.gates.get(command.executable);
        hostAborted();
        if (performance.now() >= request.deadlineAt)
          throw new GitReadError('deadline_exceeded');
        return answer(world, command);
      },
      checkIgnoredPathsWith: () => Promise.reject(new Error('unused')),
      async checkIgnoredPathsSelected(request): Promise<Set<string>> {
        const signals = [request.signal, options.hostSignal].filter(
          (signal): signal is AbortSignal => signal !== undefined,
        );
        signals.forEach((signal) => signal.throwIfAborted());
        const ignored = new Set<string>();
        if (request.paths.length === 0) return ignored;
        const chunks = Math.ceil(request.paths.length / 5000);
        for (let chunk = 0; chunk < chunks; chunk += 1) {
          const selection = new AbortController();
          // As the runner: stop waiting at an abort or the deadline, and
          // abort the selection.
          const chosen = await new Promise<
            { readonly executable: string } | { readonly failure: unknown }
          >((settle) => {
            const stop = (failure: unknown): void => {
              clearTimeout(timer);
              selection.abort(failure);
              settle({ failure });
            };
            const timer = setTimeout(
              () => stop(new GitReadError('deadline_exceeded')),
              Math.max(0, request.deadlineAt - performance.now()),
            );
            signals.forEach((signal) =>
              signal.addEventListener('abort', () => stop(signal.reason), {
                once: true,
              }),
            );
            request
              .executableForChunk(chunk, selection.signal, request.deadlineAt)
              .then(
                (executable) => settle({ executable }),
                (failure: unknown) => settle({ failure }),
              )
              .finally(() => clearTimeout(timer));
          });
          if ('failure' in chosen) throw chosen.failure;
          const { executable } = chosen;
          world.checks.push({ executable, cwd: request.cwd });
          ignored.add(executable);
        }
        return ignored;
      },
      whenIdle: () => Promise.resolve('idle'),
    };
  };
}

export const POSIX_PROBE_DIRECTORY = '/canopy-data';
export const WINDOWS_PROBE_DIRECTORY = 'C:\\canopy-data';

export function probeDirectoryFor(os: PlatformOperatingSystem): string {
  return os === 'win32' ? WINDOWS_PROBE_DIRECTORY : POSIX_PROBE_DIRECTORY;
}

/** A plausible daemon snapshot; `extra` overrides. */
export function snapshotFor(
  os: PlatformOperatingSystem,
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const base: Record<string, string> =
    os === 'win32'
      ? {
          SystemRoot: 'C:\\Windows',
          PATH: 'C:\\Windows\\System32',
          USERPROFILE: 'C:\\Users\\tester',
        }
      : { PATH: '/usr/bin:/bin', HOME: '/home/tester', SHELL: LOGIN_SHELL };
  return { ...base, ...extra };
}

export interface FakeHost {
  readonly host: GitReadHost;
  readonly world: World;
  readonly clock: { now: number };
  readonly captured: { options?: GitReadRunnerOptions };
  /** Resolves one chunk through the port: its executable, or the failure code. */
  resolve(this: void, saved: string): Promise<Resolution>;
}

/** One chunk's executable, or the host failure code. */
export interface Resolution {
  readonly resolved: string | null;
  readonly failure?: string;
}

export function fakeHost(
  world: World,
  options: Partial<GitReadHostOptions> = {},
  seams: Partial<GitReadHostSeams> = {},
): FakeHost {
  const clock = { now: 0 };
  const captured: { options?: GitReadRunnerOptions } = {};
  const host = createGitReadHostWith(
    {
      os: world.os,
      environment: snapshotFor(world.os),
      probeDirectory: probeDirectoryFor(world.os),
      ...options,
    },
    {
      arch: 'x64',
      io: worldIo(world),
      now: () => clock.now,
      createRunner: worldRunner(world, captured),
      userInfo: () => ({ username: 'tester', shell: '/bin/zsh' }),
      uid: () => 501,
      ...seams,
    },
  );
  return {
    host,
    world,
    clock,
    captured,
    async resolve(saved: string): Promise<Resolution> {
      try {
        const ignored = await host.port.checkIgnoredPaths({
          root: world.os === 'win32' ? 'C:\\repo' : '/repo',
          relativePaths: ['x'],
          readSavedExecutablePath: () => Promise.resolve(saved),
          signal: new AbortController().signal,
        });
        const [resolved] = Array.from(ignored);
        return { resolved: resolved ?? null };
      } catch (error) {
        if (error instanceof GitIgnoreHostError)
          return { resolved: null, failure: error.code };
        throw error;
      }
    },
  };
}

/** Lets fire-and-forget work (a prewarm refresh) settle. */
export async function flush(turns = 5): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

export const settle = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

/** R6 §2.7: every deliberate daemon/desktop difference, by name. */
export const DIVERGENCES = {
  'no-writes':
    'Nothing is saved, cleared or published: desktop writes the discovered path and clears a failed saved one.',
  'account-facts':
    'macOS probes get SHELL, USER and LOGNAME from the account, which a GUI-launched desktop inherits.',
  'probe-directory-cwd':
    "Validation and discovery probes run in the trusted probe directory; desktop's GUI cwd is /.",
  'no-winget-probe': 'Windows detection never looks for winget.',
  'detection-deadline':
    'One 30 s deadline bounds a request, so a cold first listing may show nothing ignored; desktop waits.',
  'overlay-keying-and-ttl':
    'A rejected explicit value stays rejected while its stat identity is unchanged, for 5 minutes; a changed identity (a retargeted symlink) re-selects at once, except that a repaired override behind a selected fallback waits until detection re-runs.',
  'windows-absolute-path':
    'Windows accepts only host-absolute saved values and candidates; desktop resolves relative ones against its cwd.',
  'other-linux-snapshot-path':
    "Linux without login-shell discovery spawns the override or `git` from the snapshot PATH, unvalidated, as desktop's spawn path.",
  'linux-override-explicit':
    'A Linux x64 snapshot override is explicit even when a desktop published it as its own discovery.',
} as const;
