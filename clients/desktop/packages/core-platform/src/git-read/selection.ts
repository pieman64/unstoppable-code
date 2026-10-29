import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import {
  GitIgnoreHostError,
  type GitIgnoreHostFailureCode,
  getLinuxGitCandidates,
  getMacGitCandidates,
  getWindowsGitCandidates,
  isMacGitShim,
  parseGitVersion,
  parseWhereExeOutput,
} from '@canopy/core-runtime/node';
import {
  GitReadError,
  type GitReadCommand,
  type GitReadEnvironment,
  isHostAbsolute,
  windowsEnvironmentValue,
} from './commands';
import type { GitReadOutput, GitReadRunner } from './runner';

/** The `stat` fields selection reads; Node's `Stats` satisfies it. */
export interface SelectionStats {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  isFile(): boolean;
}

/**
 * Every filesystem lookup selection makes. A seam because the fixed macOS and
 * Windows candidates cannot be staged on disk.
 */
export interface SelectionIo {
  stat(this: void, target: string): Promise<SelectionStats>;
  realpath(this: void, target: string): Promise<string>;
  /** Rejects unless the current user may execute `target`. */
  access(this: void, target: string): Promise<void>;
}

export const NODE_SELECTION_IO: SelectionIo = Object.freeze({
  stat: (target: string) => stat(target),
  realpath: (target: string) => realpath(target),
  access: (target: string) => access(target, constants.X_OK),
});

export interface SelectionTiming {
  /** One detection, and one login-PATH refresh, each from its own start. */
  readonly detectionDeadlineMs: number;
  /** A rejected explicit value stays rejected this long for an unchanged file. */
  readonly revalidateMs: number;
  readonly loginPathTtlMs: number;
}

export const DEFAULT_SELECTION_TIMING: SelectionTiming = Object.freeze({
  detectionDeadlineMs: 30_000,
  revalidateMs: 5 * 60_000,
  loginPathTtlMs: 5 * 60_000,
});

export interface SelectionAccount {
  readonly username: string;
  readonly shell: string | null;
}

export interface SelectionOptions {
  readonly os: PlatformOperatingSystem;
  /** `process.arch`; Linux login-shell discovery is x64 only, as in desktop. */
  readonly arch: string;
  /** The validated startup snapshot. */
  readonly environment: GitReadEnvironment;
  readonly probeDirectory: string;
  readonly runner: Pick<GitReadRunner, 'run'>;
  readonly io: SelectionIo;
  /** Monotonic clock for the rejection and login-PATH TTLs. */
  readonly now: () => number;
  readonly timing: SelectionTiming;
  readonly hostSignal: AbortSignal;
  /** `os.userInfo()`; it throws for an account without a passwd entry. */
  readonly userInfo: () => SelectionAccount;
  readonly uid: () => number | undefined;
}

export interface GitSelection {
  /** The executable for one chunk; reads the saved value only when needed. */
  select(
    this: void,
    readSaved: (signal: AbortSignal) => Promise<unknown>,
    signal: AbortSignal,
  ): Promise<string>;
  /** Starts a stale login-PATH refresh where discovery uses one. */
  prewarm(this: void): void;
  /** `idle` once no detection or login-PATH refresh runs. */
  whenIdle(this: void, signal: AbortSignal): Promise<'idle' | 'pending'>;
}

// desktop-shared config-paths fallbacks when the login probe has not answered.
const MACOS_DEFAULT_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const LINUX_DEFAULT_PATH =
  '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const LINUX_PATH_MARKER = '__CANOPY_LOGIN_PATH__';

/** Ends a whole detection: the host stopped or the detection's deadline passed. */
class DetectionEnded extends Error {
  constructor(readonly code: 'stopped' | 'deadline_exceeded') {
    super(code);
  }
}

/**
 * One detection or login-PATH refresh: its deadline, and a signal that aborts
 * with `DetectionEnded` at that deadline or the host's stop.
 */
interface Scope {
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
}

/** `work()`, or the first signal's abort reason; `work` itself runs on. */
async function within<T>(
  work: () => Promise<T>,
  signals: readonly AbortSignal[],
): Promise<T> {
  const outcome = await new Promise<
    { readonly value: T } | { readonly error: unknown }
  >((settle) => {
    const preAborted = signals.find((signal) => signal.aborted);
    if (preAborted) return settle({ error: preAborted.reason });
    let done = false;
    const listeners = signals.map((signal): [AbortSignal, () => void] => [
      signal,
      (): void => finish({ error: signal.reason }),
    ]);
    function finish(
      result: { readonly value: T } | { readonly error: unknown },
    ): void {
      if (done) return;
      done = true;
      listeners.forEach(([signal, listener]) =>
        signal.removeEventListener('abort', listener),
      );
      settle(result);
    }
    listeners.forEach(([signal, listener]) =>
      signal.addEventListener('abort', listener, { once: true }),
    );
    let pending: Promise<T>;
    try {
      pending = work();
    } catch (error) {
      return finish({ error });
    }
    pending.then(
      (value) => finish({ value }),
      (error: unknown) => finish({ error }),
    );
  });
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}

/** Rethrows the abort reason of the first aborted signal. */
function throwIfEnded(signals: readonly AbortSignal[]): void {
  signals.forEach((signal) => signal.throwIfAborted());
}

type Verdict =
  | { readonly path: string }
  /** `identity`: the validated file's, when validation reached its `stat`. */
  | { readonly rejected: true; readonly identity: string | undefined };

type Detected =
  | {
      readonly path: string;
      readonly fromSaved: boolean;
      readonly revalidateAt: number;
    }
  | { readonly failure: GitIgnoreHostFailureCode };

interface Accepted {
  readonly key: string;
  readonly saved: string;
  readonly path: string;
  readonly fromSaved: boolean;
  /** A rejected explicit value is retried from here, through detection. */
  readonly revalidateAt: number;
}

function errnoCode(error: unknown): string | undefined {
  const code: unknown = Reflect.get(Object(error), 'code');
  return typeof code === 'string' ? code : undefined;
}

const missing = (code: string | undefined): boolean =>
  code === 'ENOENT' || code === 'ENOTDIR';

const exitedZero = (output: GitReadOutput | null): output is GitReadOutput =>
  output !== null && output.code === 0 && output.signal === null;

function identityOfStats(found: SelectionStats): string {
  return [found.dev, found.ino, found.size, found.mtimeMs, found.ctimeMs].join(
    ':',
  );
}

const identityOfError = (error: unknown): string =>
  `error:${errnoCode(error) ?? 'unknown'}`;

/** Counts outstanding host work for `stop()`. */
function createWork(): {
  track<T>(this: void, work: Promise<T>): Promise<T>;
  whenIdle(this: void, signal: AbortSignal): Promise<'idle' | 'pending'>;
} {
  const outstanding = new Set<Promise<unknown>>();
  return {
    track<T>(work: Promise<T>): Promise<T> {
      outstanding.add(work);
      const forget = (): void => void outstanding.delete(work);
      work.then(forget, forget);
      return work;
    },
    async whenIdle(signal: AbortSignal): Promise<'idle' | 'pending'> {
      let abort = (): void => undefined;
      const aborted = new Promise<'pending'>((settle) => {
        abort = (): void => settle('pending');
        signal.addEventListener('abort', abort, { once: true });
      });
      try {
        // Work tracked while waiting (a detection's refresh) is waited for too.
        while (outstanding.size > 0) {
          if (signal.aborted) return 'pending';
          const settled = Promise.allSettled(Array.from(outstanding)).then(
            () => 'idle' as const,
          );
          if ((await Promise.race([settled, aborted])) === 'pending')
            return 'pending';
        }
        return 'idle';
      } finally {
        signal.removeEventListener('abort', abort);
      }
    },
  };
}

/**
 * Desktop's `detectGitExecutableInternal` and `getResolvedGitExecutableForSpawn`
 * (apps/desktop-app git-executable.ts), read-only: nothing is installed,
 * saved, cleared or published. A failed explicit value is remembered for
 * `revalidateMs` while its file is unchanged instead of being cleared.
 */
export function createGitSelection(options: SelectionOptions): GitSelection {
  const { os, environment, probeDirectory, runner, io, now, timing } = options;
  const linuxDiscovery = os === 'linux' && options.arch === 'x64';
  const work = createWork();
  const override = (
    (os === 'win32'
      ? windowsEnvironmentValue(environment, 'CANOPY_GIT_EXECUTABLE')
      : environment.CANOPY_GIT_EXECUTABLE) ?? ''
  ).trim();

  // ----------------------------------------------------- probe environment

  let account: SelectionAccount | null | undefined;
  function accountFacts(): SelectionAccount | null {
    if (account === undefined) {
      try {
        const info = options.userInfo();
        account = { username: info.username, shell: info.shell };
      } catch {
        account = null;
      }
    }
    return account;
  }

  let macEnvironment: GitReadEnvironment | undefined;
  /**
   * macOS probes run with a login shell and the account's names, which a
   * GUI-launched desktop inherits and the daemon's allowlisted startup
   * environment may lack.
   */
  function probeEnvironment(): GitReadEnvironment {
    if (os !== 'darwin') return environment;
    if (macEnvironment) return macEnvironment;
    const facts = accountFacts();
    const accountShell = facts?.shell ?? '';
    const shell =
      environment.SHELL ||
      (path.posix.isAbsolute(accountShell) ? accountShell : '/bin/zsh');
    macEnvironment = Object.freeze({
      ...environment,
      SHELL: shell,
      ...(facts ? { USER: facts.username, LOGNAME: facts.username } : {}),
    });
    return macEnvironment;
  }

  function scratchRoot(): string {
    const configured = environment.TMPDIR;
    return configured && path.posix.isAbsolute(configured)
      ? configured
      : '/tmp';
  }

  // ----------------------------------------------------------------- probes

  /** A scope from now; `close` once its work settles. */
  function openScope(): Scope & { close(this: void): void } {
    const deadlineAt = performance.now() + timing.detectionDeadlineMs;
    const ending = new AbortController();
    const host = options.hostSignal;
    const stop = (): void => ending.abort(new DetectionEnded('stopped'));
    const timer = setTimeout(
      () => ending.abort(new DetectionEnded('deadline_exceeded')),
      timing.detectionDeadlineMs,
    );
    timer.unref?.();
    if (host.aborted) stop();
    else host.addEventListener('abort', stop, { once: true });
    return {
      deadlineAt,
      signal: ending.signal,
      close: (): void => {
        clearTimeout(timer);
        host.removeEventListener('abort', stop);
      },
    };
  }

  /** `work` until `scope` ends; a stalled lookup or probe is abandoned. */
  const scoped = <T>(scope: Scope, work: () => Promise<T>): Promise<T> =>
    within(work, [scope.signal]);

  /**
   * One probe in `probeDirectory`. A stop or the detection deadline ends the
   * detection; any other failure is this probe's alone (`null`).
   */
  async function probe(
    command: GitReadCommand,
    scope: Scope,
  ): Promise<GitReadOutput | null> {
    try {
      return await scoped(scope, () =>
        runner.run(command, {
          cwd: probeDirectory,
          environment: probeEnvironment(),
          deadlineAt: scope.deadlineAt,
        }),
      );
    } catch (error) {
      if (error instanceof DetectionEnded) throw error;
      if (options.hostSignal.aborted) throw new DetectionEnded('stopped');
      const cause =
        error instanceof GitReadError && error.code === 'cleanup_unconfirmed'
          ? error.failure
          : error;
      if (cause instanceof GitReadError && cause.code === 'deadline_exceeded')
        throw new DetectionEnded('deadline_exceeded');
      return null;
    }
  }

  // ------------------------------------------------------------- login PATH

  let loginPath: string | undefined;
  let loginPathAt = 0;
  let refreshing: Promise<void> | null = null;

  const loginPathFallback = (): string =>
    environment.PATH || (os === 'linux' ? LINUX_DEFAULT_PATH : MACOS_DEFAULT_PATH); // prettier-ignore
  const loginPathFresh = (): boolean =>
    loginPath !== undefined && now() - loginPathAt < timing.loginPathTtlMs;

  /**
   * Probes swallow every failure here: a missing login PATH is not fatal. The
   * refresh still ends with its scope.
   */
  async function quietProbe(
    command: GitReadCommand,
    scope: Scope,
  ): Promise<GitReadOutput | null> {
    try {
      return await probe(command, scope);
    } catch {
      scope.signal.throwIfAborted();
      return null;
    }
  }

  /** desktop-shared config-paths: the last non-empty line, trimmed. */
  async function macLoginPath(scope: Scope): Promise<string | undefined> {
    const output = await quietProbe({ kind: 'macos-login-shell-path' }, scope);
    if (!exitedZero(output)) return undefined;
    const lines = output.stdout.split('\n').filter((line) => line.trim());
    return lines[lines.length - 1]?.trim() || undefined;
  }

  async function executableShell(
    shell: string,
    scope: Scope,
  ): Promise<boolean> {
    if (!path.posix.isAbsolute(shell) || /[\0\r\n]/.test(shell)) return false;
    try {
      if (!(await scoped(scope, () => io.stat(shell))).isFile()) return false;
      await scoped(scope, () => io.access(shell));
      return true;
    } catch {
      scope.signal.throwIfAborted();
      return false;
    }
  }

  /** desktop-shared config-paths `getLinuxAccountShell`. */
  async function accountShell(scope: Scope): Promise<string | undefined> {
    const uid = options.uid();
    if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0)
      return undefined;
    const output = await quietProbe({ kind: 'getent-passwd', uid }, scope);
    if (!exitedZero(output)) return undefined;
    const records = output.stdout.trim().split('\n');
    if (records.length !== 1) return undefined;
    const fields = (records[0] ?? '').split(':');
    return fields.length === 7 && fields[2] === String(uid)
      ? fields[6]
      : undefined;
  }

  /** desktop-shared config-paths `resolveLinuxLoginShellPath`. */
  async function linuxLoginPath(scope: Scope): Promise<string | undefined> {
    const shell = environment.SHELL?.trim() || (await accountShell(scope));
    const shells =
      shell && shell !== '/bin/bash' ? [shell, '/bin/bash'] : ['/bin/bash'];
    for (const candidate of shells) {
      if (!(await executableShell(candidate, scope))) continue;
      const output = await quietProbe(
        { kind: 'linux-login-shell-path', shell: candidate },
        scope,
      );
      if (!exitedZero(output)) continue;
      const markerAt = output.stdout.lastIndexOf(LINUX_PATH_MARKER);
      if (markerAt < 0) continue;
      const value =
        (output.stdout.slice(markerAt + LINUX_PATH_MARKER.length).split('\n')[0] ?? '') // prettier-ignore
          .replace(/\r$/, '');
      if (value.trim().length > 0 && !/[\0\r]/.test(value)) return value;
    }
    return undefined;
  }

  /**
   * Shared by every caller, under its own scope from its start; a failed
   * probe keeps the previous value. A detection awaiting it stops waiting at
   * its own deadline.
   */
  function refreshLoginPath(): Promise<void> {
    if (refreshing) return refreshing;
    // Nothing starts after a stop, which may already have reported idle.
    if (options.hostSignal.aborted) return Promise.resolve();
    const scope = openScope();
    const resolving =
      os === 'darwin' ? macLoginPath(scope) : linuxLoginPath(scope);
    const refresh = resolving
      .catch(() => undefined)
      .then((resolved) => {
        scope.close();
        loginPath = resolved ?? loginPath ?? loginPathFallback();
        loginPathAt = now();
        refreshing = null;
      });
    refreshing = work.track(refresh);
    return refresh;
  }

  /** macOS: stale-while-revalidate, as desktop's `getLoginShellPath`. */
  function currentLoginPath(): string {
    if (!loginPathFresh()) void refreshLoginPath();
    return loginPath ?? loginPathFallback();
  }

  /** Linux x64: desktop awaits `prewarmLoginShellPath` before discovery. */
  async function awaitedLoginPath(scope: Scope): Promise<string> {
    if (!loginPathFresh()) await scoped(scope, refreshLoginPath);
    return loginPath ?? loginPathFallback();
  }

  // ------------------------------------------------------------- validation

  /** desktop `validateGitExecutable`; the rejection carries the file's identity. */
  async function validate(candidate: string, scope: Scope): Promise<Verdict> {
    const value = candidate.trim();
    let identity: string | undefined;
    const reject = (): Verdict => ({ rejected: true, identity });
    if (!value || !isHostAbsolute(os, value)) return reject();
    if (os === 'darwin' && isMacGitShim(value)) return reject();
    if (os === 'win32' && path.win32.basename(value).toLowerCase() !== 'git.exe') return reject(); // prettier-ignore

    let target = value;
    try {
      if (os === 'darwin') {
        target = await scoped(scope, () => io.realpath(value));
        if (isMacGitShim(target)) return reject();
      }
      const found = await scoped(scope, () => io.stat(target));
      identity = identityOfStats(found);
      if (!found.isFile()) return reject();
      if (os === 'linux') await scoped(scope, () => io.access(target));
    } catch (error) {
      scope.signal.throwIfAborted();
      identity ??= identityOfError(error);
      return reject();
    }

    const version = await probe({ kind: 'git-version', executable: target }, scope); // prettier-ignore
    if (
      !exitedZero(version) ||
      !parseGitVersion(`${version.stdout}\n${version.stderr}`, {
        numeric: os === 'linux',
      })
    )
      return reject();
    if (os === 'darwin') {
      const smoke = await probe(
        {
          kind: 'git-bare-init-smoke',
          executable: target,
          temporaryRoot: scratchRoot(),
        },
        scope,
      );
      if (!exitedZero(smoke)) return reject();
    }
    return { path: target };
  }

  // -------------------------------------------------------------- discovery

  async function macCandidates(scope: Scope): Promise<string[]> {
    const currentPath = currentLoginPath();
    const printed = await probe({ kind: 'xcode-select-print-path' }, scope);
    return getMacGitCandidates({
      loginPath: currentPath,
      developerDir: exitedZero(printed) ? printed.stdout.trim() : null,
      paths: {
        join: (...parts) => path.posix.join(...parts),
        isAbsolute: (value) => path.posix.isAbsolute(value),
      },
    });
  }

  /** `where.exe git` runs in `probeDirectory`; no winget probe. */
  async function windowsCandidates(scope: Scope): Promise<string[]> {
    const where = await probe({ kind: 'where-git' }, scope);
    const value = (name: string): string | undefined =>
      windowsEnvironmentValue(environment, name);
    return [
      ...(exitedZero(where) ? parseWhereExeOutput(where.stdout) : []),
      ...getWindowsGitCandidates({
        programFiles: value('ProgramFiles'),
        programFilesX86: value('ProgramFiles(x86)'),
        localAppData: value('LOCALAPPDATA'),
        join: (...parts) => path.win32.join(...parts),
      }),
    ];
  }

  // ------------------------------------------------------- shared selection

  let accepted: Accepted | null = null;
  /** Pending detections by key; each settles by its own deadline. */
  const inFlight = new Map<
    string,
    { readonly token: symbol; readonly work: Promise<Detected> }
  >();
  /**
   * The detection serving the latest request: the only one that records.
   * `null` while that request needs none.
   */
  let current: symbol | null = null;
  /** Requests are ordered by when they read the saved value. */
  let savedReads = 0;
  /** The newest read whose request has established its key: the latest. */
  let latestRequest = 0;
  /** Explicit values that failed, by value: the file identity and time then. */
  const rejections = new Map<
    string,
    { readonly identity: string; readonly at: number }
  >();
  let linuxDiscovered: string | null = null;

  /**
   * The value's `stat` identity, or the lookup error's. Ends with the first
   * of `signals` to abort, rethrowing its reason.
   */
  async function identityOf(
    value: string,
    signals: readonly AbortSignal[],
  ): Promise<string> {
    if (!value) return 'none';
    if (!isHostAbsolute(os, value)) return 'relative';
    try {
      return identityOfStats(await within(() => io.stat(value), signals));
    } catch (error) {
      throwIfEnded(signals);
      return identityOfError(error);
    }
  }

  /**
   * An explicit value (saved or override): skipped while rejected for an
   * unchanged file, else validated. Only the current detection records.
   */
  async function tryExplicit(
    value: string,
    knownIdentity: string | undefined,
    scope: Scope,
    isCurrent: () => boolean,
  ): Promise<{ readonly path: string } | { readonly rejectedAt: number }> {
    const prior = rejections.get(value);
    if (prior && now() - prior.at < timing.revalidateMs) {
      const identity =
        knownIdentity ?? (await identityOf(value, [scope.signal]));
      if (identity === prior.identity) return { rejectedAt: prior.at };
    }
    const verdict = await validate(value, scope);
    if ('path' in verdict) {
      if (isCurrent()) rejections.delete(value);
      return verdict;
    }
    const at = now();
    // Recorded as the check above reads it: a value rejected before its stat
    // (relative, a shim) is keyed by `identityOf` too.
    const identity =
      knownIdentity ??
      verdict.identity ??
      (await identityOf(value, [scope.signal]));
    // Only while current: a failure seen then is real for this identity, so it
    // stays after a later supersession. Revisit if supersession must roll back.
    if (isCurrent()) rejections.set(value, { identity, at });
    return { rejectedAt: at };
  }

  async function detectMacOrWindows(
    saved: string,
    savedIdentity: string,
    scope: Scope,
    isCurrent: () => boolean,
  ): Promise<Detected> {
    let revalidateAt = Number.POSITIVE_INFINITY;
    const explicit: [string, string | undefined][] = [];
    if (saved) explicit.push([saved, savedIdentity]);
    if (override && override !== saved) explicit.push([override, undefined]);
    for (const [value, identity] of explicit) {
      const outcome = await tryExplicit(value, identity, scope, isCurrent);
      if ('path' in outcome)
        return { path: outcome.path, fromSaved: value === saved, revalidateAt };
      revalidateAt = Math.min(
        revalidateAt,
        outcome.rejectedAt + timing.revalidateMs,
      );
    }

    const candidates =
      os === 'darwin'
        ? await macCandidates(scope)
        : await windowsCandidates(scope);
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (os === 'darwin' && isMacGitShim(candidate)) continue;
      const key = os === 'win32' ? candidate.toLowerCase() : candidate;
      if (seen.has(key)) continue;
      seen.add(key);
      const verdict = await validate(candidate, scope);
      if ('path' in verdict)
        return { path: verdict.path, fromSaved: false, revalidateAt };
    }
    return { failure: 'git_unavailable' };
  }

  /**
   * desktop `detectLinuxGitExecutable`: a broken explicit choice is reported,
   * never replaced. The snapshot override counts as explicit even when a
   * desktop published it as its own discovery: the daemon cannot tell.
   * Discovery-cache writes follow the overlay's rule: only while current, and
   * kept after a later supersession.
   */
  async function detectLinux(
    saved: string,
    savedIdentity: string,
    scope: Scope,
    isCurrent: () => boolean,
  ): Promise<Detected> {
    const explicit = saved || override;
    if (explicit) {
      const outcome = await tryExplicit(
        explicit,
        saved ? savedIdentity : undefined,
        scope,
        isCurrent,
      );
      if ('path' in outcome)
        return {
          path: outcome.path,
          fromSaved: Boolean(saved),
          revalidateAt: Number.POSITIVE_INFINITY,
        };
      return { failure: 'git_unavailable' };
    }
    const accept = (found: string): Detected => {
      if (isCurrent()) linuxDiscovered = found;
      return { path: found, fromSaved: false, revalidateAt: Number.POSITIVE_INFINITY }; // prettier-ignore
    };
    const cached = linuxDiscovered;
    if (cached) {
      const verdict = await validate(cached, scope);
      if ('path' in verdict) return accept(verdict.path);
      if (isCurrent() && linuxDiscovered === cached) linuxDiscovered = null;
    }
    for (const { path: candidate } of getLinuxGitCandidates(
      await awaitedLoginPath(scope),
    )) {
      const verdict = await validate(candidate, scope);
      if ('path' in verdict) return accept(verdict.path);
    }
    return { failure: 'git_unavailable' };
  }

  /**
   * One detection under its own scope: every lookup, probe and awaited
   * login-PATH refresh ends with it, so it settles by its deadline.
   */
  async function runDetection(
    saved: string,
    savedIdentity: string,
    isServing: () => boolean,
  ): Promise<Detected> {
    const scope = openScope();
    const isCurrent = (): boolean => isServing() && !scope.signal.aborted;
    try {
      return os === 'linux'
        ? await detectLinux(saved, savedIdentity, scope, isCurrent)
        : await detectMacOrWindows(saved, savedIdentity, scope, isCurrent);
    } catch (error) {
      return {
        failure:
          error instanceof DetectionEnded ? error.code : 'git_unavailable',
      };
    } finally {
      scope.close();
    }
  }

  /**
   * Single-flight per key. The latest request's detection, started or
   * joined, is current; a superseded one never records.
   */
  function detect(
    key: string,
    saved: string,
    savedIdentity: string,
    isLatest: () => boolean,
  ): Promise<Detected> {
    const pending = inFlight.get(key);
    if (pending) {
      if (isLatest()) current = pending.token;
      return pending.work;
    }
    if (options.hostSignal.aborted)
      return Promise.resolve({ failure: 'stopped' });
    const token = Symbol(key);
    if (isLatest()) current = token;
    const isServing = (): boolean =>
      current === token && !options.hostSignal.aborted;
    const detection = work.track(
      runDetection(saved, savedIdentity, isServing).then((detected) => {
        if (inFlight.get(key)?.token === token) inFlight.delete(key);
        if (isServing())
          accepted =
            'path' in detected
              ? {
                  key,
                  saved,
                  path: detected.path,
                  fromSaved: detected.fromSaved,
                  revalidateAt: detected.revalidateAt,
                }
              : null;
        return detected;
      }),
    );
    inFlight.set(key, { token, work: detection });
    return detection;
  }

  /**
   * desktop's spawn fast path: `true` keeps the selection, `false` re-runs
   * detection (ENOENT, ENOTDIR, or no longer the validated file). Any other
   * lookup error does not prove the installation gone and is surfaced.
   */
  async function stillSelected(
    selected: string,
    signals: readonly AbortSignal[],
  ): Promise<boolean> {
    const look = <T>(work: () => Promise<T>): Promise<T> =>
      within(work, signals);
    try {
      if (os === 'darwin') {
        const real = await look(() => io.realpath(selected));
        if (real !== selected || isMacGitShim(real)) return false;
        return (await look(() => io.stat(real))).isFile();
      }
      if (!(await look(() => io.stat(selected))).isFile()) return false;
      if (os === 'linux') await look(() => io.access(selected));
      return true;
    } catch (error) {
      throwIfEnded(signals);
      if (missing(errnoCode(error))) return false;
      throw new GitIgnoreHostError('selection_rejected');
    }
  }

  /** The request's own lookups end with the stop or the request's signal. */
  async function selectOnce(
    readSaved: (signal: AbortSignal) => Promise<unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    const raw = await readSaved(signal);
    const read = ++savedReads;
    if (typeof raw !== 'string')
      throw new GitIgnoreHostError('invalid_request');
    const saved = raw.trim();
    const requested = [options.hostSignal, signal];
    const savedIdentity = await identityOf(saved, requested);
    // A stop during the lookup starts no detection after `whenIdle` settled.
    if (options.hostSignal.aborted) throw new GitIgnoreHostError('stopped');
    // R6 overlay keying omits the override's identity: a repaired override
    // waits behind a selected fallback until detection re-runs (the TTL, a
    // failed fast path, a saved-value change). Revisit if it must win at once.
    const key = JSON.stringify([saved, savedIdentity]);
    // Unless a newer read already established its key, this request is now
    // the latest: a pending detection for another key no longer serves it,
    // even when the fast path keeps its selection.
    if (read > latestRequest) {
      latestRequest = read;
      current = inFlight.get(key)?.token ?? null;
      // Desktop holds no discovery while a choice is saved: it forgets it on
      // every save or clear (`setCachedGitExecutablePath`,
      // `clearCachedGitExecutablePath`). So the latest request's saved choice
      // drops it, whichever detection serves that request. An override needs
      // no clear: with one, Linux never discovers.
      if (os === 'linux' && saved) linuxDiscovered = null;
    }
    const isLatest = (): boolean => read === latestRequest;
    const selected = accepted;
    if (selected?.key === key && now() < selected.revalidateAt) {
      if (await stillSelected(selected.path, requested)) return selected.path;
    } else if (
      selected?.fromSaved &&
      selected.saved === saved &&
      savedIdentity.startsWith('error:') &&
      !missing(savedIdentity.slice('error:'.length))
    ) {
      // The saved file became unreadable: as desktop, keep it and surface that.
      throw new GitIgnoreHostError('selection_rejected');
    }
    throwIfEnded(requested);
    const detected = await detect(key, saved, savedIdentity, isLatest);
    if ('failure' in detected) throw new GitIgnoreHostError(detected.failure);
    return detected.path;
  }

  async function select(
    readSaved: (signal: AbortSignal) => Promise<unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    // desktop: an unrequired platform spawns the override or `git` unvalidated.
    if (os === 'linux' && !linuxDiscovery) return override || 'git';
    try {
      return await selectOnce(readSaved, signal);
    } catch (error) {
      if (options.hostSignal.aborted) throw new GitIgnoreHostError('stopped');
      throw error;
    }
  }

  function prewarm(): void {
    if (os === 'darwin' || linuxDiscovery)
      if (!loginPathFresh()) void refreshLoginPath();
  }

  return Object.freeze({
    select,
    prewarm,
    whenIdle: (signal: AbortSignal) => work.whenIdle(signal),
  });
}
