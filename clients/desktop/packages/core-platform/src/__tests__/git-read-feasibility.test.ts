import { execFileSync } from 'node:child_process';
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, posix, win32 } from 'node:path';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import { GitIgnoreHostError } from '@canopy/core-runtime/node';
import { hostOperatingSystem } from '../host-platform';
import { createChildServices } from '../supervision/child';
import { createGitReadHostWith } from '../git-read/host';
import { createGitReadRunner, type GitReadOutput } from '../git-read/runner';
import {
  type GitReadCommand,
  searchDirectories,
  windowsEnvironmentValue,
} from '../git-read/commands';
import { evidenceRecorder } from './git-read-evidence';

/*
 * G1 (CAN-4303 R6 §3.2), moved into U2b: U1's probes under the daemon child
 * environment (A), A plus the account SHELL/USER/LOGNAME (A+SUL), and the
 * runner's full environment (F); Git selection and the E3 fixtures run through
 * production `createGitReadHost` with each as its snapshot. Assertions cover
 * the mechanism only: each probe ran within its bound, its output parsed, and
 * the selected Git validated. Every cross-environment comparison is recorded,
 * never asserted: it depends on the runner's profile (C1).
 */
const host = hostOperatingSystem();
const darwinDescribe = host === 'darwin' ? describe : describe.skip;
// Desktop's login-shell discovery is Linux x64 only.
const linuxDescribe =
  host === 'linux' && process.arch === 'x64' ? describe : describe.skip;
const windowsDescribe = host === 'win32' ? describe : describe.skip;
const evidence = evidenceRecorder('feasibility');

const LABELS = ['A', 'A+SUL', 'F'] as const;
type Label = (typeof LABELS)[number];
type Environment = Readonly<Record<string, string>>;
type PosixOs = 'darwin' | 'linux';

const REQUEST_MS = 30_000;
const LINUX_PATH_MARKER = '__CANOPY_LOGIN_PATH__';
const PROBE_PATHS = [
  'probe.home-excluded',
  'probe.global-excluded',
  'probe.xdg-excluded',
  'probe.kept',
];

let dir = '';

function subdir(name: string): string {
  const target = join(dir, name);
  mkdirSync(target, { recursive: true });
  return target;
}

function keyed<K, V>(compute: (key: K) => Promise<V>): (key: K) => Promise<V> {
  const cache = new Map<K, Promise<V>>();
  return (key) => {
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const started = compute(key);
    cache.set(key, started);
    return started;
  };
}

function defined(
  source: Readonly<Record<string, string | undefined>>,
): Environment {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source))
    if (value !== undefined) result[key] = value;
  return result;
}

const keyOf = (os: PlatformOperatingSystem, key: string): string =>
  os === 'win32' ? key.toUpperCase() : key;

/** `source` with `overrides`; on Windows every case variant is replaced. */
function withKeys(
  os: PlatformOperatingSystem,
  source: Readonly<Record<string, string | undefined>>,
  overrides: Environment,
): Environment {
  const replaced = new Set(Object.keys(overrides).map((key) => keyOf(os, key)));
  const kept = Object.entries(defined(source)).filter(
    ([key]) => !replaced.has(keyOf(os, key)),
  );
  return { ...Object.fromEntries(kept), ...overrides };
}

function variable(
  os: PlatformOperatingSystem,
  environment: Environment,
  name: string,
): string | undefined {
  return os === 'win32'
    ? windowsEnvironmentValue(environment, name)
    : environment[name];
}

const environmentA = (
  os: PlatformOperatingSystem,
  source: Readonly<Record<string, string | undefined>>,
): Environment => ({ ...createChildServices(os).childEnvironment({ source }) });

/** A runner error code, else a bounded message (fixed text, no values). */
function errorText(error: unknown): string {
  const code: unknown = Reflect.get(Object(error), 'code');
  return typeof code === 'string' ? code : String(error).slice(0, 200);
}

type Built = { readonly environment: Environment } | { readonly error: string };

/** A, or why `childEnvironment` refused `source`: F's evidence never waits on A. */
function buildA(
  os: PlatformOperatingSystem,
  source: Readonly<Record<string, string | undefined>>,
): Built {
  try {
    return { environment: environmentA(os, source) };
  } catch (error) {
    return { error: errorText(error) };
  }
}

type Attempt =
  | { readonly ms: number; readonly output: GitReadOutput }
  | { readonly ms: number; readonly error: string };

/** `attempt` under `built`; an unbuilt environment is a failed attempt. */
function attemptIn(
  os: PlatformOperatingSystem,
  command: GitReadCommand,
  built: Built,
  cwd = dir,
): Promise<Attempt> {
  return 'error' in built
    ? Promise.resolve({ ms: 0, error: `environment: ${built.error}` })
    : attempt(os, command, built.environment, cwd);
}

async function attempt(
  os: PlatformOperatingSystem,
  command: GitReadCommand,
  environment: Environment,
  cwd = dir,
): Promise<Attempt> {
  const started = performance.now();
  const ms = (): number => Math.round(performance.now() - started);
  try {
    const output = await createGitReadRunner({ os }).run(command, {
      cwd,
      environment,
      deadlineAt: started + REQUEST_MS,
    });
    return { ms: ms(), output };
  } catch (error) {
    return { ms: ms(), error: errorText(error) };
  }
}

/** The output of a run that exited 0, else null. */
const exitedZero = (result: Attempt): GitReadOutput | null =>
  'output' in result &&
  result.output.code === 0 &&
  result.output.signal === null
    ? result.output
    : null;

/** Recorded without output: stderr may carry profile noise. */
const summary = (result: Attempt): Record<string, unknown> =>
  'output' in result
    ? {
        ms: result.ms,
        code: result.output.code,
        signal: result.output.signal,
        pipes: result.output.pipes,
        stderrBytes: Buffer.byteLength(result.output.stderr),
      }
    : { ms: result.ms, error: result.error };

interface Comparison {
  readonly equal: boolean;
  readonly onlyLeft: readonly string[];
  readonly onlyRight: readonly string[];
}

/** Order-sensitive equality, and the entries each side lacks. */
function compare(
  os: PlatformOperatingSystem,
  left: readonly string[] | null,
  right: readonly string[] | null,
): Comparison | { readonly missing: true } {
  if (left === null || right === null) return { missing: true };
  const key = (value: string): string =>
    os === 'win32' ? value.toLowerCase() : value;
  const leftKeys = new Set(left.map(key));
  const rightKeys = new Set(right.map(key));
  return {
    equal:
      left.length === right.length &&
      left.every((value, index) => key(value) === key(right[index] ?? '')),
    onlyLeft: left.filter((value) => !rightKeys.has(key(value))),
    onlyRight: right.filter((value) => !leftKeys.has(key(value))),
  };
}

/** R6 class (b): F's extra login-PATH entries are all in F's inherited PATH. */
function inheritedRule(
  comparison: Comparison | { readonly missing: true },
  inherited: readonly string[],
): Record<string, unknown> {
  if ('missing' in comparison) return { ...comparison };
  const notInherited = comparison.onlyRight.filter(
    (entry) => !inherited.includes(entry),
  );
  return {
    ...comparison,
    fExtrasInherited: notInherited.length === 0,
    fExtrasNotInherited: notInherited,
  };
}

interface Account {
  readonly username: string;
  readonly homedir: string;
  readonly shell: string | null;
}

/** `os.userInfo()` throws for an account without a passwd entry. */
function account(): Account | null {
  try {
    const info = userInfo();
    return {
      username: info.username,
      homedir: info.homedir,
      shell: info.shell,
    };
  } catch {
    return null;
  }
}

interface PosixEnvironments {
  readonly byLabel: Readonly<Record<Label, Environment>>;
  readonly facts: Readonly<Record<string, unknown>>;
}

/** desktop-shared config-paths `getLinuxAccountShell`: one 7-field record for `uid`. */
function passwdShell(stdout: string, uid: number): string | undefined {
  const records = stdout.trim().split('\n');
  if (records.length !== 1) return undefined;
  const fields = (records[0] ?? '').split(':');
  return fields.length === 7 && fields[2] === String(uid)
    ? fields[6]
    : undefined;
}

const uid = (): number | undefined => {
  const value = process.getuid?.();
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
};

/** R6 §2.5: the probe-environment constants this gate informs. */
const posixEnvironments = keyed(
  async (os: PosixOs): Promise<PosixEnvironments> => {
    const F = defined(process.env);
    const A = environmentA(os, process.env);
    const info = account();
    let shell: string;
    let shellSource: string;
    const snapshot =
      os === 'darwin' ? process.env.SHELL : process.env.SHELL?.trim();
    if (snapshot) {
      shell = snapshot;
      shellSource = 'snapshot';
    } else if (os === 'darwin') {
      const fromAccount = info?.shell ?? null;
      if (fromAccount !== null && posix.isAbsolute(fromAccount)) {
        shell = fromAccount;
        shellSource = 'userInfo';
      } else {
        shell = '/bin/zsh';
        shellSource = 'default';
      }
    } else {
      const id = uid();
      let fromGetent: string | undefined;
      if (id !== undefined) {
        const lookup = exitedZero(
          await attempt(os, { kind: 'getent-passwd', uid: id }, A),
        );
        fromGetent = lookup ? passwdShell(lookup.stdout, id) : undefined;
      }
      shell = fromGetent || '/bin/bash';
      shellSource = fromGetent ? 'getent' : 'default';
    }
    const named: Environment = info
      ? { USER: info.username, LOGNAME: info.username }
      : {};
    const sul: Environment = { ...A, SHELL: shell, ...named };
    return {
      byLabel: { A, 'A+SUL': sul, F },
      facts: {
        aKeys: Object.keys(A).sort(),
        sulShell: shell,
        sulShellSource: shellSource,
        userInfo: info ? 'ok' : 'threw',
        // null: A+SUL omits USER and LOGNAME.
        sulUserMatchesSnapshot: info
          ? info.username === process.env.USER
          : null,
        sulLognameMatchesSnapshot: info
          ? info.username === process.env.LOGNAME
          : null,
        sulShellMatchesSnapshot: shell === process.env.SHELL,
        inheritedPath: (process.env.PATH ?? '').split(':'),
      },
    };
  },
);

const inheritedPosixPath = (): string[] => (process.env.PATH ?? '').split(':');

function fileState(candidate: string): 'file' | 'missing' | 'not-file' {
  try {
    return statSync(candidate).isFile() ? 'file' : 'not-file';
  } catch {
    return 'missing';
  }
}

function executableByUser(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** One production host request: what it selected and how it settled. */
interface HostSelection {
  readonly ms: number;
  /** The executable each `check-ignore` chunk ran. */
  readonly selected: string | null;
  /** The ignored paths, a host failure code, or why the snapshot was not built. */
  readonly outcome: string;
  readonly lastFailure: string | null;
  readonly stop: string;
}

/**
 * `createGitReadHost` with `built` as its startup snapshot, checking
 * `relativePaths` under `root` with `saved` as the saved preference. The
 * runner is production's, observed only for the executable it is handed.
 */
async function hostRequest(
  os: PlatformOperatingSystem,
  built: Built,
  root: string,
  relativePaths: readonly string[],
  saved = '',
): Promise<HostSelection> {
  if ('error' in built)
    return {
      ms: 0,
      selected: null,
      outcome: `environment: ${built.error}`,
      lastFailure: null,
      stop: 'not-started',
    };
  const chunks: string[] = [];
  const target = createGitReadHostWith(
    {
      os,
      environment: built.environment,
      probeDirectory: subdir('probe-data'),
    },
    {
      createRunner: (options) => {
        const runner = createGitReadRunner(options);
        return {
          ...runner,
          checkIgnoredPathsSelected: (request): Promise<Set<string>> =>
            runner.checkIgnoredPathsSelected({
              ...request,
              executableForChunk: async (...args) => {
                const executable = await request.executableForChunk(...args);
                chunks.push(executable);
                return executable;
              },
            }),
        };
      },
    },
  );
  const started = performance.now();
  let outcome: string;
  try {
    const ignored = await target.port.checkIgnoredPaths({
      root,
      relativePaths,
      readSavedExecutablePath: () => Promise.resolve(saved),
      signal: new AbortController().signal,
    });
    outcome = JSON.stringify(Array.from(ignored).sort());
  } catch (error) {
    // Host failures carry a code only; anything else would be a defect.
    outcome =
      error instanceof GitIgnoreHostError
        ? error.code
        : `raw: ${errorText(error)}`;
  }
  const ms = Math.round(performance.now() - started);
  const stopped = await target.stop(AbortSignal.timeout(10_000));
  return {
    ms,
    selected: chunks[0] ?? null,
    outcome,
    lastFailure: target.lastFailure(),
    stop: stopped.state,
  };
}

/** Production discovery under one label: nothing saved, a directory outside any repository. */
function hostSelection(
  os: PlatformOperatingSystem,
  built: Built,
): Promise<HostSelection> {
  return hostRequest(os, built, subdir('selection-root'), ['probe.kept']);
}

/** The Git production selects under F, for the config fixtures; absent fails the fixture. */
async function fixtureGit(os: PlatformOperatingSystem): Promise<string> {
  const selection =
    os === 'darwin'
      ? await macSelection('F')
      : os === 'linux'
        ? await linuxSelection('F')
        : await windowsSelection('F');
  if (selection.selected === null) throw new Error('No Git selected under F');
  return selection.selected;
}

/** Selected and settled without a raw error; anything else is recorded. */
function expectSelected(selection: HostSelection): void {
  expect(selection.selected).not.toBeNull();
  expect(selection.outcome).not.toMatch(/^raw: /);
}

beforeAll(() => {
  if (host === null) return;
  dir = mkdtempSync(
    join(realpathSync.native(tmpdir()), 'git-read-feasibility-'),
  );
});

afterAll(() => {
  evidence.flush();
  if (dir !== '')
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
});

// ---------------------------------------------------------------- macOS

/** desktop-shared config-paths: the last non-empty line, trimmed. */
function macLoginPath(stdout: string): string | null {
  const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
  const last = lines[lines.length - 1]?.trim();
  return last ? last : null;
}

const macLogin = keyed(async (label: Label) => {
  const environment = (await posixEnvironments('darwin')).byLabel[label];
  const result = await attempt(
    'darwin',
    { kind: 'macos-login-shell-path' },
    environment,
  );
  const output = exitedZero(result);
  return {
    shell: environment.SHELL || '/bin/zsh',
    result,
    loginPath: output ? macLoginPath(output.stdout) : null,
  };
});

/** Production selection under `label`; macOS probes add the account facts. */
const macSelection = keyed(
  async (label: Label): Promise<HostSelection> =>
    hostSelection('darwin', {
      environment: (await posixEnvironments('darwin')).byLabel[label],
    }),
);

/** The login-PATH directory whose `git` resolves to `selected`. */
function loginEntryOf(
  selected: string,
  login: readonly string[],
  gitIn: (entry: string) => string,
): string | undefined {
  return login.find((directory) => {
    const candidate = gitIn(directory);
    try {
      return candidate === selected || realpathSync(candidate) === selected;
    } catch {
      return false;
    }
  });
}

/** Where F's selected Git came from, for class (b). */
function selectedVia(
  selected: string | null,
  fLogin: readonly string[],
  onlyF: readonly string[],
  gitIn: (entry: string) => string,
): string | null {
  if (selected === null) return null;
  const entry = loginEntryOf(selected, fLogin, gitIn);
  if (entry === undefined) return 'fixed-location';
  if (!onlyF.includes(entry)) return 'shared-login-entry';
  return inheritedPosixPath().includes(entry)
    ? 'login-extra-inherited'
    : 'login-extra-not-inherited';
}

darwinDescribe('G1 on native macOS (requires process.platform darwin)', () => {
  jest.setTimeout(180_000);

  it('runs the login-shell PATH probe under A, A+SUL and F', async () => {
    const { facts } = await posixEnvironments('darwin');
    const results = await Promise.all(LABELS.map((label) => macLogin(label)));
    const [a, sul, f] = results;
    const entries = (loginPath: string | null | undefined): string[] | null =>
      loginPath ? loginPath.split(':') : null;
    const inherited = inheritedPosixPath();
    evidence.record('darwin: environments', facts);
    evidence.record('darwin: login-shell PATH', {
      perLabel: Object.fromEntries(
        LABELS.map((label, index) => {
          const found = results[index];
          return [
            label,
            found === undefined
              ? null
              : {
                  shell: found.shell,
                  ...summary(found.result),
                  loginPath: entries(found.loginPath),
                },
          ];
        }),
      ),
      'A vs A+SUL': compare(
        'darwin',
        entries(a?.loginPath),
        entries(sul?.loginPath),
      ),
      'A+SUL vs F': inheritedRule(
        compare('darwin', entries(sul?.loginPath), entries(f?.loginPath)),
        inherited,
      ),
      'A vs F': inheritedRule(
        compare('darwin', entries(a?.loginPath), entries(f?.loginPath)),
        inherited,
      ),
    });
    for (const found of results) {
      expect(summary(found.result)).toMatchObject({ code: 0, signal: null });
      expect(found.loginPath).not.toBeNull();
      expect(
        searchDirectories('darwin', found.loginPath ?? '').length,
      ).toBeGreaterThan(0);
    }
  });

  it('selects Git through createGitReadHost under A, A+SUL and F', async () => {
    const [a, sul, f] = await Promise.all(
      LABELS.map((label) => macSelection(label)),
    );
    const sulLogin = (await macLogin('A+SUL')).loginPath?.split(':') ?? [];
    const fLogin = (await macLogin('F')).loginPath?.split(':') ?? [];
    const login = compare('darwin', sulLogin, fLogin);
    const onlyF = 'missing' in login ? [] : login.onlyRight;
    const gitIn = (entry: string): string => posix.join(entry, 'git');
    evidence.record('darwin: Git selection', {
      A: a,
      'A+SUL': sul,
      F: f,
      // Class (a): the host adds the account facts to A itself.
      selectedEqual: {
        'A vs A+SUL': a?.selected === sul?.selected,
        'A+SUL vs F': sul?.selected === f?.selected,
      },
      fSelectedVia: selectedVia(f?.selected ?? null, fLogin, onlyF, gitIn),
      sulSelectedVia: selectedVia(sul?.selected ?? null, sulLogin, [], gitIn),
    });
    for (const found of [a, sul, f]) {
      expect(found).toBeDefined();
      if (found) expectSelected(found);
    }
  });

  describeConfigFixtures('darwin');
});

// ---------------------------------------------------------------- Linux

const linuxGetent = keyed(async (label: Label) => {
  const environment = (await posixEnvironments('linux')).byLabel[label];
  const id = uid();
  if (id === undefined) return { id, result: null, shell: undefined };
  const result = await attempt(
    'linux',
    { kind: 'getent-passwd', uid: id },
    environment,
  );
  const output = exitedZero(result);
  return {
    id,
    result,
    shell: output ? passwdShell(output.stdout, id) : undefined,
  };
});

/** desktop-shared config-paths `isExecutableLinuxShell`. */
function isExecutableLinuxShell(shell: string): boolean {
  if (!posix.isAbsolute(shell) || /[\0\r\n]/.test(shell)) return false;
  return fileState(shell) === 'file' && executableByUser(shell);
}

/** desktop-shared config-paths: the line after the last marker. */
function linuxLoginPath(stdout: string): string | null {
  const markerAt = stdout.lastIndexOf(LINUX_PATH_MARKER);
  if (markerAt < 0) return null;
  const value = (
    stdout.slice(markerAt + LINUX_PATH_MARKER.length).split('\n')[0] ?? ''
  ).replace(/\r$/, '');
  return value.trim().length > 0 && !/[\0\r]/.test(value) ? value : null;
}

/** desktop-shared config-paths `resolveLinuxLoginShellPath` under `label`. */
const linuxLogin = keyed(async (label: Label) => {
  const environment = (await posixEnvironments('linux')).byLabel[label];
  const configured = environment.SHELL?.trim();
  const shell = configured || (await linuxGetent(label)).shell;
  const shellSource = configured ? 'SHELL' : shell ? 'getent' : 'none';
  const shells =
    shell && shell !== '/bin/bash' ? [shell, '/bin/bash'] : ['/bin/bash'];
  const tried: Record<string, unknown>[] = [];
  for (const candidate of shells) {
    if (!isExecutableLinuxShell(candidate)) {
      tried.push({ shell: candidate, outcome: 'not-executable' });
      continue;
    }
    const result = await attempt(
      'linux',
      { kind: 'linux-login-shell-path', shell: candidate },
      environment,
    );
    const output = exitedZero(result);
    const loginPath = output ? linuxLoginPath(output.stdout) : null;
    tried.push({
      shell: candidate,
      ...summary(result),
      markerParsed: loginPath !== null,
    });
    if (loginPath !== null)
      return { shellSource, tried, shell: candidate, result, loginPath };
  }
  return { shellSource, tried, shell: null, result: null, loginPath: null };
});

/** desktop-shared git-executable `getPathGitCandidates`' normalization. */
const linuxGitIn = (entry: string): string =>
  `/${[...entry.split('/').filter(Boolean), 'git'].join('/')}`;

/** Production selection under `label`: its own login refresh, then candidates. */
const linuxSelection = keyed(
  async (label: Label): Promise<HostSelection> =>
    hostSelection('linux', {
      environment: (await posixEnvironments('linux')).byLabel[label],
    }),
);

linuxDescribe(
  'G1 on native Linux x64 (requires process.platform linux, x64)',
  () => {
    jest.setTimeout(180_000);

    it('runs getent passwd under A, A+SUL and F', async () => {
      const { facts } = await posixEnvironments('linux');
      const results = await Promise.all(
        LABELS.map((label) => linuxGetent(label)),
      );
      const stdout = results.map((found) =>
        found.result !== null && 'output' in found.result
          ? found.result.output.stdout
          : null,
      );
      const info = account();
      evidence.record('linux: environments', facts);
      evidence.record('linux: getent passwd', {
        perLabel: Object.fromEntries(
          LABELS.map((label, index) => {
            const found = results[index];
            const fields = (stdout[index] ?? '').trim().split(':');
            return [
              label,
              found === undefined || found.result === null
                ? null
                : {
                    ...summary(found.result),
                    shell: found.shell ?? null,
                    homeMatchesUserInfo:
                      info !== null && fields[5] === info.homedir,
                  },
            ];
          }),
        ),
        outputsEqual: new Set(stdout).size === 1,
      });
      for (const found of results) {
        expect(found.id).toBeDefined();
        expect(found.result).not.toBeNull();
        expect(found.result && summary(found.result)).toMatchObject({
          code: 0,
          signal: null,
        });
        expect(found.shell).toBeDefined();
      }
    });

    it('runs the login-shell PATH probe under A, A+SUL and F', async () => {
      const results = await Promise.all(
        LABELS.map((label) => linuxLogin(label)),
      );
      const [a, sul, f] = results;
      const entries = (
        loginPath: string | null | undefined,
      ): string[] | null => (loginPath ? loginPath.split(':') : null);
      const inherited = inheritedPosixPath();
      evidence.record('linux: login-shell PATH', {
        perLabel: Object.fromEntries(
          LABELS.map((label, index) => {
            const found = results[index];
            return [
              label,
              found === undefined
                ? null
                : {
                    shellSource: found.shellSource,
                    shell: found.shell,
                    tried: found.tried,
                    loginPath: entries(found.loginPath),
                  },
            ];
          }),
        ),
        'A vs A+SUL': compare(
          'linux',
          entries(a?.loginPath),
          entries(sul?.loginPath),
        ),
        'A+SUL vs F': inheritedRule(
          compare('linux', entries(sul?.loginPath), entries(f?.loginPath)),
          inherited,
        ),
        'A vs F': inheritedRule(
          compare('linux', entries(a?.loginPath), entries(f?.loginPath)),
          inherited,
        ),
      });
      for (const found of results) {
        // A parsed PATH implies the probe that produced it exited 0.
        expect(found.loginPath).not.toBeNull();
        expect(found.result && summary(found.result)).toMatchObject({
          code: 0,
          signal: null,
        });
      }
    });

    it('selects Git through createGitReadHost under A, A+SUL and F', async () => {
      const results = await Promise.all(
        LABELS.map((label) => linuxSelection(label)),
      );
      const [a, sul, f] = results;
      const sulLogin = (await linuxLogin('A+SUL')).loginPath?.split(':') ?? [];
      const fLogin = (await linuxLogin('F')).loginPath?.split(':') ?? [];
      const login = compare('linux', sulLogin, fLogin);
      const onlyF = 'missing' in login ? [] : login.onlyRight;
      evidence.record('linux: Git selection', {
        A: a,
        'A+SUL': sul,
        F: f,
        selectedEqual: {
          'A vs A+SUL': a?.selected === sul?.selected,
          'A+SUL vs F': sul?.selected === f?.selected,
        },
        fSelectedVia: selectedVia(
          f?.selected ?? null,
          fLogin,
          onlyF,
          linuxGitIn,
        ),
      });
      for (const found of results) expectSelected(found);
    });

    describeConfigFixtures('linux');
  },
);

// ---------------------------------------------------------------- Windows

type WindowsLabel = 'A' | 'F';

interface WindowsEnvironments {
  readonly A: Built;
  readonly F: Environment;
}

let windowsBuilt: WindowsEnvironments | undefined;

function windowsEnvironments(): WindowsEnvironments {
  windowsBuilt ??= {
    A: buildA('win32', process.env),
    F: defined(process.env),
  };
  return windowsBuilt;
}

const windowsBuiltFor = (label: WindowsLabel): Built => {
  const { A, F } = windowsEnvironments();
  return label === 'A' ? A : { environment: F };
};

/** apps/desktop-app git-executable `getWhereExeResults`, from an empty cwd. */
const windowsWhere = keyed(async (label: WindowsLabel) => {
  const result = await attemptIn(
    'win32',
    { kind: 'where-git' },
    windowsBuiltFor(label),
    subdir('where-cwd'),
  );
  const listed =
    'output' in result && result.output.code === 0
      ? result.output.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      : [];
  return { result, listed };
});

/** Production selection under `label`: where.exe in the probe directory, then the common locations. */
const windowsSelection = keyed(
  (label: WindowsLabel): Promise<HostSelection> =>
    hostSelection('win32', windowsBuiltFor(label)),
);

windowsDescribe(
  'G1 on native Windows (requires process.platform win32)',
  () => {
    jest.setTimeout(180_000);

    it('runs where.exe git under A and F', async () => {
      const built = windowsEnvironments();
      const A = 'environment' in built.A ? built.A.environment : null;
      const { F } = built;
      const a = await windowsWhere('A');
      const f = await windowsWhere('F');
      // Case- and trailing-separator-insensitive, as where.exe matches entries.
      const directoryKey = (entry: string): string =>
        entry.replace(/[\\/]+$/, '').toLowerCase();
      const directories = (environment: Environment): string[] =>
        searchDirectories(
          'win32',
          windowsEnvironmentValue(environment, 'PATH'),
        ).map(directoryKey);
      const aPath = A ? directories(A) : [];
      const fPath = directories(F);
      const comparison = compare('win32', a.listed, f.listed);
      const onlyF = 'missing' in comparison ? [] : comparison.onlyRight;
      const cwd = directoryKey(subdir('where-cwd'));
      const fHome = windowsEnvironmentValue(F, 'HOME');
      const fKeys = Object.keys(F);
      evidence.record('win32: environments', {
        aError: 'error' in built.A ? built.A.error : null,
        aKeys: A ? Object.keys(A).sort() : null,
        aPath,
        // Names only: childEnvironment refuses differing case variants.
        fCaseVariantKeys: fKeys.filter((key) =>
          fKeys.some(
            (other) =>
              other !== key && other.toUpperCase() === key.toUpperCase(),
          ),
        ),
        // A carries USERPROFILE, never HOME; Git for Windows falls back to it.
        fHasHome: fHome !== undefined,
        fHomeIsUserProfile:
          fHome !== undefined &&
          directoryKey(fHome) ===
            directoryKey(windowsEnvironmentValue(F, 'USERPROFILE') ?? ''),
      });
      evidence.record('win32: where git', {
        A: { ...summary(a.result), listed: a.listed },
        F: { ...summary(f.result), listed: f.listed },
        'A vs F': comparison,
        // R6 class (b): each F-only result is in a directory only F's PATH has.
        fOnlyFromInheritedPath: onlyF.every((found) => {
          const directory = directoryKey(win32.dirname(found));
          return fPath.includes(directory) && !aPath.includes(directory);
        }),
        listedFromCwd: [...a.listed, ...f.listed].some(
          (found) => directoryKey(win32.dirname(found)) === cwd,
        ),
      });
      expect('error' in built.A ? built.A.error : null).toBeNull();
      for (const found of [a, f]) {
        expect(
          'output' in found.result ? found.result.output.signal : 'rejected',
        ).toBeNull();
        expect([0, 1]).toContain(
          'output' in found.result ? found.result.output.code : null,
        );
        for (const line of found.listed)
          expect(win32.isAbsolute(line)).toBe(true);
      }
    });

    it('selects Git through createGitReadHost under A and F', async () => {
      const a = await windowsSelection('A');
      const f = await windowsSelection('F');
      evidence.record('win32: Git selection', {
        A: a,
        F: f,
        selectedEqual: a.selected?.toLowerCase() === f.selected?.toLowerCase(),
      });
      // A carries no ProgramFiles; only F is expected to find the runner's Git.
      // An unbuilt A is recorded and asserted by the where.exe case.
      expect(a.outcome).not.toMatch(/^raw: /);
      expectSelected(f);
    });

    describeConfigFixtures('win32');
  },
);

// ------------------------------------------------- E3 Git config fixtures

/** A Git config path value: quoted, forward slashes for Git for Windows. */
const configPath = (value: string): string => `"${value.replace(/\\/g, '/')}"`;

function describeConfigFixtures(os: PlatformOperatingSystem): void {
  describe('E3 Git config fixtures', () => {
    /** An empty repository made with no system or global config. */
    function repository(git: string): string {
      const repo = mkdtempSync(join(dir, 'repo-'));
      const emptyConfig = join(dir, 'empty.gitconfig');
      writeFileSync(emptyConfig, '');
      const source = Object.fromEntries(
        Object.entries(defined(process.env)).filter(
          ([key]) => !key.toUpperCase().startsWith('GIT_'),
        ),
      );
      const env = withKeys(os, source, {
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: emptyConfig,
      });
      execFileSync(git, ['init', '-q', repo], { env, windowsHide: true });
      return repo;
    }

    /** A fresh home; Windows A carries USERPROFILE, not HOME. */
    function home(): Environment {
      const created = mkdtempSync(join(dir, 'home-'));
      return os === 'win32'
        ? { HOME: created, USERPROFILE: created }
        : { HOME: created };
    }

    /** check-ignore through the host, with the fixture Git saved. */
    async function ignoredUnder(
      git: string,
      repo: string,
      built: Built,
    ): Promise<{ result: HostSelection; ignored: string[] | null }> {
      const result = await hostRequest(os, built, repo, PROBE_PATHS, git);
      const parsed: unknown = result.outcome.startsWith('[')
        ? JSON.parse(result.outcome)
        : null;
      const ignored =
        Array.isArray(parsed) &&
        parsed.every((entry): entry is string => typeof entry === 'string')
          ? parsed
          : null;
      return { result, ignored };
    }

    /** check-ignore under A and F derived from one source. */
    async function compareFixture(
      name: string,
      overrides: Environment,
      expected: string,
      carriedKey: string,
    ): Promise<void> {
      const git = await fixtureGit(os);
      const repo = repository(git);
      const source = withKeys(os, process.env, overrides);
      const A = buildA(os, source);
      const a = await ignoredUnder(git, repo, A);
      const f = await ignoredUnder(git, repo, { environment: source });
      const sameIgnored =
        a.ignored !== null &&
        f.ignored !== null &&
        a.ignored.join('\0') === f.ignored.join('\0');
      evidence.record(`${os}: E3 ${name}`, {
        git,
        aCarries:
          'environment' in A
            ? variable(os, A.environment, carriedKey) === overrides[carriedKey]
            : null,
        A: {
          ...a.result,
          ignored: a.ignored,
          applied: a.ignored?.includes(expected) ?? null,
        },
        F: {
          ...f.result,
          ignored: f.ignored,
          applied: f.ignored?.includes(expected) ?? null,
        },
        equal: sameIgnored,
      });
      for (const found of [a, f]) expect(found.ignored).not.toBeNull();
    }

    it('a temporary HOME with core.excludesFile under A and F', async () => {
      const homes = home();
      const target = homes.HOME ?? '';
      const excludes = join(target, 'home-excludes');
      writeFileSync(excludes, '*.home-excluded\n');
      writeFileSync(
        join(target, '.gitconfig'),
        `[core]\n\texcludesFile = ${configPath(excludes)}\n`,
      );
      await compareFixture(
        'HOME core.excludesFile',
        homes,
        'probe.home-excluded',
        os === 'win32' ? 'USERPROFILE' : 'HOME',
      );
    });

    it('GIT_CONFIG_GLOBAL under A and F (an env-only residual)', async () => {
      const homes = home();
      const global = join(dir, `global-${Date.now()}.gitconfig`);
      const excludes = join(dir, `global-excludes-${Date.now()}`);
      writeFileSync(excludes, '*.global-excluded\n');
      writeFileSync(
        global,
        `[core]\n\texcludesFile = ${configPath(excludes)}\n`,
      );
      await compareFixture(
        'GIT_CONFIG_GLOBAL',
        { ...homes, GIT_CONFIG_GLOBAL: global },
        'probe.global-excluded',
        'GIT_CONFIG_GLOBAL',
      );
    });

    // R6 names macOS, whose A drops it; Linux A keeps it, recorded for contrast.
    (os === 'win32' ? it.skip : it)(
      'XDG_CONFIG_HOME under A and F',
      async () => {
        const homes = home();
        const xdg = mkdtempSync(join(dir, 'xdg-'));
        mkdirSync(join(xdg, 'git'));
        writeFileSync(join(xdg, 'git', 'ignore'), '*.xdg-excluded\n');
        await compareFixture(
          'XDG_CONFIG_HOME',
          { ...homes, XDG_CONFIG_HOME: xdg },
          'probe.xdg-excluded',
          'XDG_CONFIG_HOME',
        );
      },
    );
  });
}
