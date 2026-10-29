import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as paths from 'node:path';
import { join } from 'node:path';
import type { PlatformOperatingSystem } from '@canopy/core-runtime';
import {
  createDirectoryReadPreferenceSource,
  createReadOnlyDirectoryInputs,
  GitIgnoreHostError,
} from '@canopy/core-runtime/node';
import { createFileIndexingMatchPolicy } from '../file-indexing';
import {
  createGitReadHostWith,
  type GitReadHost,
  type GitReadHostSeams,
} from '../git-read/host';
import { evidenceRecorder } from './git-read-evidence';

/*
 * U2b real-process cases (CAN-4303 R6 §3.3) on POSIX hosts: production
 * selection and check-ignore through createGitReadHost with real files,
 * fake Git scripts and real Git repositories. Windows: the planted-binary
 * case at the end runs only on native Windows.
 */
const HOST: 'darwin' | 'linux' | undefined =
  process.platform === 'darwin' || process.platform === 'linux'
    ? process.platform
    : undefined;
const posix = HOST ? describe : describe.skip;
const windowsDescribe = process.platform === 'win32' ? describe : describe.skip;
const OS: PlatformOperatingSystem = HOST ?? 'linux';
const evidence = evidenceRecorder('host-process');

let base = '';
let serial = 0;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, ms = 10_000): Promise<void> {
  const end = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > end) throw new Error(`Not met within ${ms} ms`);
    await delay(10);
  }
}

const settle = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

function fresh(name: string): string {
  serial += 1;
  const dir = join(base, `${name}-${serial}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const lines = (file: string): string[] =>
  existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []; // prettier-ignore

/**
 * Runs a fresh script once: macOS can take seconds to assess a new
 * executable on its first exec, which would eat a probe's 5 s bound.
 */
function warm(file: string): void {
  execFileSync(file, ['__warm__'], { stdio: 'ignore' });
}

/**
 * A fake Git in its own `bin` directory: answers `--version`, the macOS
 * bare-init smoke and `check-ignore` (echoing its name once per chunk),
 * logging each call to `calls.log` beside `bin`.
 */
function fakeGit(
  name: string,
  options: { versionPrefix?: string; version?: string; checkIgnore?: string } = {}, // prettier-ignore
): { file: string; log: string } {
  const dir = fresh(`git-${name}`);
  mkdirSync(join(dir, 'bin'));
  const file = join(dir, 'bin', 'git');
  const log = join(dir, 'calls.log');
  writeFileSync(
    file,
    `#!/bin/sh
case "$1" in
  __warm__) exit 0;;
  --version) echo "version" >> "${log}"; ${options.versionPrefix ?? ''}
    echo "${options.version ?? 'git version 2.45.0'}"; exit 0;;
  -c) echo "smoke" >> "${log}"; exit 0;;
  check-ignore) echo "check-ignore" >> "${log}"; ${options.checkIgnore ?? 'cat > /dev/null;'} printf '${name}\\000'; exit 0;;
esac
exit 3
`,
  );
  chmodSync(file, 0o755);
  warm(file);
  return { file, log };
}

/** A fake Git whose `check-ignore` hangs until stopped. */
const hangingGit = (name: string): { file: string; log: string } =>
  fakeGit(name, { checkIgnore: 'sleep 30;' });

/** A login shell printing `loginPath` in the OS's probe format. */
function fakeShell(loginPath: string): string {
  const file = join(fresh('shell'), 'login-shell');
  const line =
    OS === 'linux'
      ? `printf '__CANOPY_LOGIN_PATH__%s\\n' '${loginPath}'`
      : `printf '%s\\n' '${loginPath}'`;
  writeFileSync(file, `#!/bin/sh\n${line}\n`);
  chmodSync(file, 0o755);
  warm(file);
  return file;
}

let defaultShell = '';

function snapshot(
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  defaultShell ||= fakeShell('/usr/bin:/bin');
  return {
    PATH: '/usr/bin:/bin',
    HOME: join(base, 'home'),
    LANG: 'C',
    TMPDIR: join(base, 'tmp'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CEILING_DIRECTORIES: base,
    // Never the developer's own login shell.
    SHELL: defaultShell,
    ...extra,
  };
}

function host(
  environment: Record<string, string | undefined>,
  seams: GitReadHostSeams = {},
): GitReadHost {
  return createGitReadHostWith(
    { os: OS, environment, probeDirectory: join(base, 'data') },
    { arch: 'x64', ...seams },
  );
}

function check(
  target: GitReadHost,
  root: string,
  relativePaths: readonly string[],
  saved: string | (() => Promise<string>),
  signal = new AbortController().signal,
): Promise<Set<string>> {
  return target.port.checkIgnoredPaths({
    root,
    relativePaths,
    readSavedExecutablePath:
      typeof saved === 'string'
        ? (): Promise<string> => Promise.resolve(saved)
        : saved,
    signal,
  });
}

/** The real Git binary, never Apple's /usr/bin/git shim. */
function realGit(): string {
  const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(); // prettier-ignore
  return realpathSync(join(execPath, 'git'));
}

function repository(gitignore: string, config: string[][] = []): string {
  const repo = fresh('repo');
  const env = { ...process.env, ...snapshot(), SHELL: '/bin/sh' };
  execFileSync('git', ['init', '-q', repo], { env });
  for (const [key = '', value = ''] of config)
    execFileSync('git', ['-C', repo, 'config', key, value], { env });
  writeFileSync(join(repo, '.gitignore'), gitignore);
  return repo;
}

beforeAll(() => {
  if (!HOST) return;
  base = mkdtempSync(join(realpathSync(tmpdir()), 'git-read-host-'));
  for (const dir of ['home', 'tmp', 'data']) mkdirSync(join(base, dir));
});

afterAll(() => {
  evidence.flush();
  if (base) rmSync(base, { recursive: true, force: true });
});

posix('createGitReadHost: real repositories (POSIX)', () => {
  jest.setTimeout(60_000);
  let git = '';
  let reads = 0;
  const saved = (): Promise<string> => {
    reads += 1;
    return Promise.resolve(git);
  };

  beforeAll(() => {
    git = realGit();
  });

  it('applies nested and negated rules', async () => {
    const repo = repository('*.log\n!keep.log\n');
    mkdirSync(join(repo, 'sub'));
    writeFileSync(join(repo, 'sub', '.gitignore'), '*.tmp\n!important.tmp\n');
    const result = await check(host(snapshot()), repo, ['a.log', 'keep.log', 'sub/x.tmp', 'sub/important.tmp', 'sub/b.log'], saved); // prettier-ignore
    expect(result).toEqual(new Set(['a.log', 'sub/x.tmp', 'sub/b.log']));
  });

  it('applies info/exclude', async () => {
    const repo = repository('');
    writeFileSync(join(repo, '.git', 'info', 'exclude'), '*.excluded\n');
    const result = await check(host(snapshot()), repo, ['a.excluded', 'b'], saved); // prettier-ignore
    expect(result).toEqual(new Set(['a.excluded']));
  });

  it("applies the snapshot HOME's core.excludesFile", async () => {
    const repo = repository('');
    const home = fresh('home');
    writeFileSync(join(home, 'excludes'), '*.home\n');
    writeFileSync(join(home, '.gitconfig'), `[core]\n\texcludesFile = ${join(home, 'excludes')}\n`); // prettier-ignore
    const environment = snapshot({ HOME: home, GIT_CONFIG_GLOBAL: undefined });
    const result = await check(host(environment), repo, ['x.home', 'y'], saved);
    expect(result).toEqual(new Set(['x.home']));
  });

  it('does not report tracked paths', async () => {
    const repo = repository('*.log\n');
    writeFileSync(join(repo, 'tracked.log'), '');
    execFileSync('git', ['-C', repo, 'add', '-f', 'tracked.log'], { env: { ...process.env, ...snapshot() } }); // prettier-ignore
    const result = await check(host(snapshot()), repo, ['tracked.log', 'other.log'], saved); // prettier-ignore
    expect(result).toEqual(new Set(['other.log']));
  });

  it('returns names with newlines unquoted', async () => {
    const repo = repository('*.log\n');
    const result = await check(host(snapshot()), repo, ['new\nline.log', 'keep'], saved); // prettier-ignore
    expect(result).toEqual(new Set(['new\nline.log']));
  });

  it('selects before each chunk across the 5,001-path boundary', async () => {
    const repo = repository('*.log\n');
    const input = Array.from({ length: 5001 }, (_, i) => `p${i}.log`);
    reads = 0;
    const result = await check(host(snapshot()), repo, input, saved);
    expect(reads).toBe(2);
    expect(result).toEqual(new Set(input));
  });

  it('matches NFC and NFD byte-exactly', async () => {
    const nfc = 'café.log';
    const repo = repository(`${nfc}\n`);
    const result = await check(host(snapshot()), repo, ['café.log', nfc], saved); // prettier-ignore
    expect(result).toEqual(new Set([nfc]));
  });

  it.each([
    ['true', new Set(['NODE_MODULES/q'])],
    ['false', new Set()],
  ])('follows core.ignorecase=%s', async (ignorecase, expected) => {
    const repo = repository('node_modules/\n', [['core.ignorecase', ignorecase]]); // prettier-ignore
    const result = await check(host(snapshot()), repo, ['NODE_MODULES/q'], saved); // prettier-ignore
    expect(result).toEqual(expected);
  });
});

posix('createGitReadHost: real processes (POSIX)', () => {
  jest.setTimeout(60_000);

  it('a saved value changing between chunks selects the new Git for the next chunk', async () => {
    const a = fakeGit('A');
    const b = fakeGit('B');
    const values = [a.file, b.file];
    let reads = 0;
    const result = await check(
      host(snapshot()),
      fresh('root'),
      Array.from({ length: 5001 }, (_, i) => `p${i}`),
      () => Promise.resolve(values[reads++] ?? b.file),
    );
    expect(result).toEqual(new Set(['A', 'B']));
    expect(lines(a.log).filter((line) => line === 'check-ignore')).toHaveLength(1); // prettier-ignore
    expect(lines(b.log).filter((line) => line === 'check-ignore')).toHaveLength(1); // prettier-ignore
    expect(lines(b.log)[0]).toBe('version');
  });

  it('a superseded detection records nothing (generation race)', async () => {
    const marker = join(fresh('marker'), 'release');
    const slow = fakeGit('S1', {
      versionPrefix: `n=0; while [ ! -e "${marker}" ] && [ $n -lt 400 ]; do sleep 0.05; n=$((n+1)); done;`,
      version: 'not git',
    });
    const valid = fakeGit('S2');
    const target = host(snapshot());
    const root = fresh('root');
    const first = settle(check(target, root, ['x'], slow.file));
    await until(() => lines(slow.log).includes('version'));
    await expect(check(target, root, ['x'], valid.file)).resolves.toEqual(new Set(['S2'])); // prettier-ignore
    writeFileSync(marker, '');
    // Its own result: S1 failed, so it continued into this machine's
    // discovery, whose outcome depends on the host's installed Git.
    const superseded = await first;
    expect(superseded).not.toEqual({ value: new Set(['S2']) });
    expect(superseded).not.toEqual({ value: new Set(['S1']) });
    // Superseded: S1 was not remembered as rejected, so it is validated again.
    await settle(check(target, root, ['x'], slow.file));
    expect(lines(slow.log).filter((line) => line === 'version')).toHaveLength(2); // prettier-ignore
    // Current: now it is.
    await settle(check(target, root, ['x'], slow.file));
    expect(lines(slow.log).filter((line) => line === 'version')).toHaveLength(2); // prettier-ignore
  });

  it('a cold detection can exhaust the request deadline; it runs on and the next request uses it (C9)', async () => {
    const slow = fakeGit('cold', { versionPrefix: 'sleep 1.5;' });
    const bin = paths.dirname(slow.file);
    const environment = snapshot({
      // macOS starts from the snapshot PATH; Linux awaits the login shell.
      PATH: `${bin}:/usr/bin:/bin`,
      SHELL: fakeShell(`${bin}:/usr/bin:/bin`),
    });
    const target = host(environment, {
      timing: { requestDeadlineMs: 1_000 },
      runner: { timing: { cleanupReserveMs: 200 } },
    });
    const root = fresh('root');
    const started = performance.now();
    const cold = await settle(check(target, root, ['x'], ''));
    const coldMs = Math.round(performance.now() - started);
    evidence.record('C9 cold detection', { coldMs, outcome: String(Reflect.get(Object(cold), 'error')) }); // prettier-ignore
    expect(cold).toEqual({
      error: new GitIgnoreHostError('deadline_exceeded'),
    });
    // Settled at its 800 ms stop time, never after the 1.5 s `--version`.
    expect(coldMs).toBeLessThan(1_450);
    expect(target.lastFailure()).toBe('deadline_exceeded');
    await until(() =>
      lines(slow.log).includes(OS === 'darwin' ? 'smoke' : 'version'),
    );
    // Linux logs `version` before its 1.5 s sleep: wait past it, so the next
    // request takes the fast path instead of joining a detection that may
    // outlast its 800 ms.
    await delay(2_500);
    await expect(check(target, root, ['x'], '')).resolves.toEqual(new Set(['cold'])); // prettier-ignore
    expect(lines(slow.log).filter((line) => line === 'version')).toHaveLength(
      1,
    );
  });

  it('other Linux resolves git through the snapshot PATH only', async () => {
    const fake = fakeGit('snapshot-path');
    const ambient = process.env.PATH;
    expect(ambient?.split(':')).not.toContain(paths.dirname(fake.file));
    const target = createGitReadHostWith(
      {
        os: 'linux',
        environment: snapshot({
          PATH: `${paths.dirname(fake.file)}:/usr/bin:/bin`,
        }),
        probeDirectory: join(base, 'data'),
      },
      { arch: 'arm64' },
    );
    await expect(check(target, fresh('root'), ['x'], '/ignored/saved')).resolves.toEqual(new Set(['snapshot-path'])); // prettier-ignore
    expect(lines(fake.log)).toEqual(['check-ignore']);
  });

  it('stop ends an in-flight check-ignore and reports stopped', async () => {
    const hanging = hangingGit('hang');
    const target = host(snapshot());
    const pending = settle(check(target, fresh('root'), ['x'], hanging.file));
    await until(() => lines(hanging.log).includes('check-ignore'));
    await expect(target.stop(AbortSignal.timeout(8_000))).resolves.toEqual({ state: 'stopped' }); // prettier-ignore
    expect(await pending).toEqual({ error: new GitIgnoreHostError('stopped') });
  });

  it('a stop whose signal has already aborted reports work still pending as cleanup_unconfirmed', async () => {
    const hanging = hangingGit('hang-unconfirmed');
    const target = host(snapshot());
    const pending = settle(check(target, fresh('root'), ['x'], hanging.file));
    await until(() => lines(hanging.log).includes('check-ignore'));
    await expect(target.stop(AbortSignal.abort())).resolves.toEqual({ state: 'cleanup_unconfirmed' }); // prettier-ignore
    expect(await pending).toEqual({ error: new GitIgnoreHostError('stopped') });
  });

  it('rejects with the request abort reason mid-chunk', async () => {
    const hanging = hangingGit('hang-abort');
    const target = host(snapshot());
    const controller = new AbortController();
    const reason = { client: 'gone' };
    const pending = settle(check(target, fresh('root'), ['x'], hanging.file, controller.signal)); // prettier-ignore
    await until(() => lines(hanging.log).includes('check-ignore'));
    controller.abort(reason);
    expect(await pending).toEqual({ error: reason });
    expect(target.lastFailure()).toBeNull();
    await expect(target.stop(AbortSignal.timeout(8_000))).resolves.toEqual({ state: 'stopped' }); // prettier-ignore
  });
});

/*
 * D3 B through the host: the win32 kill path with an injected taskkill, as
 * U1's runner suite does. `//` keeps the paths absolute for win32 and valid
 * on POSIX.
 */
posix('createGitReadHost: Windows taskkill after settlement (D3 B)', () => {
  jest.setTimeout(60_000);
  const roots: number[] = [];

  afterEach(() => {
    roots.splice(0).forEach((pid) => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    });
  });

  /** A taskkill that settles when `end` is called. */
  function heldTaskkill(): {
    run: () => Promise<string>;
    end(outcome: 'succeeds' | 'fails'): void;
  } {
    let finish: (outcome: 'succeeds' | 'fails') => void = () => undefined;
    return {
      run: () =>
        new Promise((resolve, reject) => {
          finish = (outcome): void =>
            outcome === 'fails'
              ? reject(new Error('late taskkill failure'))
              : resolve('');
        }),
      end: (outcome) => finish(outcome),
    };
  }

  async function abortedOnWindows(run: () => Promise<string>): Promise<{
    readonly target: GitReadHost;
    readonly outcome: unknown;
    readonly root: number;
    readonly reports: unknown[];
    readonly reason: Error;
  }> {
    const dir = fresh('win32-d3');
    const pidfile = join(dir, 'root.pid');
    const file = join(dir, 'git.exe');
    writeFileSync(
      file,
      `#!/bin/sh
case "$1" in
  __warm__) exit 0;;
  --version) echo "git version 2.45.0.windows.1"; exit 0;;
  check-ignore) echo $$ > "$PIDFILE"; exec /bin/sleep 30;;
esac
exit 3
`,
    );
    chmodSync(file, 0o755);
    warm(file);
    const reports: unknown[] = [];
    const target = createGitReadHostWith(
      {
        os: 'win32',
        environment: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32', PIDFILE: pidfile }, // prettier-ignore
        probeDirectory: `/${join(base, 'data')}`,
        onCleanupReport: (report) => void reports.push(report),
      },
      {
        runner: {
          operations: { run },
          timing: { drainMs: 50, cleanupReserveMs: 400 },
        },
      },
    );
    const controller = new AbortController();
    const reason = new Error('client gone');
    const pending = settle(
      check(target, `/${fresh('root')}`, ['x'], `/${file}`, controller.signal),
    );
    await until(() => existsSync(pidfile) && readFileSync(pidfile, 'utf8').trim() !== ''); // prettier-ignore
    const root = Number(readFileSync(pidfile, 'utf8').trim());
    roots.push(root);
    controller.abort(reason);
    return { target, outcome: await pending, root, reports, reason };
  }

  it('settles at the abort, reports the running taskkill, and stop waits for it', async () => {
    const held = heldTaskkill();
    const s = await abortedOnWindows(held.run);
    expect(s.outcome).toEqual({ error: s.reason });
    expect(s.reports).toEqual([{ kind: 'kill', outcome: 'cleanup_unconfirmed' }]); // prettier-ignore
    const stopping = s.target.stop(AbortSignal.timeout(5_000));
    await delay(100);
    process.kill(s.root, 'SIGKILL');
    held.end('succeeds');
    await expect(stopping).resolves.toEqual({ state: 'stopped' });
    expect(s.reports).toHaveLength(1);
  });

  it('reports a late taskkill failure, and stop reports the live root as cleanup_unconfirmed', async () => {
    const held = heldTaskkill();
    const s = await abortedOnWindows(held.run);
    expect(s.outcome).toEqual({ error: s.reason });
    held.end('fails');
    await delay(50);
    expect(s.reports).toEqual([
      { kind: 'kill', outcome: 'cleanup_unconfirmed' },
      { kind: 'kill', outcome: 'failed' },
    ]);
    await expect(s.target.stop(AbortSignal.timeout(300))).resolves.toEqual({ state: 'cleanup_unconfirmed' }); // prettier-ignore
    await expect(s.target.stop(AbortSignal.timeout(300))).rejects.toEqual(new GitIgnoreHostError('stopped')); // prettier-ignore
  });
});

posix('createGitReadHost: composed no-write inventory (POSIX)', () => {
  jest.setTimeout(60_000);

  interface Entry {
    readonly kind: string;
    readonly mode: number;
    readonly mtimeMs: number;
    readonly sha256: string | null;
  }

  function inventory(root: string): Record<string, Entry> {
    const found: Record<string, Entry> = {};
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        const target = join(dir, name);
        const stats = lstatSync(target);
        const file = stats.isFile();
        found[target] = {
          kind: file ? 'file' : stats.isDirectory() ? 'dir' : 'other',
          mode: stats.mode,
          mtimeMs: stats.mtimeMs,
          sha256: file ? createHash('sha256').update(readFileSync(target)).digest('hex') : null, // prettier-ignore
        };
        if (stats.isDirectory()) walk(target);
      }
    };
    walk(root);
    return found;
  }

  it('writes only the bare-init scratch, under the snapshot TMPDIR, and removes it', async () => {
    const world = fresh('inventory');
    const dataRoot = join(world, 'data');
    const scratch = join(world, 'scratch');
    const home = join(world, 'home');
    for (const dir of [dataRoot, scratch, home]) mkdirSync(dir);
    const git = fakeGit('inventory');
    const repo = fresh('inventory-repo');
    writeFileSync(join(repo, '.gitignore'), '*.log\n');
    writeFileSync(
      join(dataRoot, 'preferences.json'),
      JSON.stringify({ version: 1, preferences: { gitExecutablePath: ` ${git.file} ` } }), // prettier-ignore
    );
    const watched = [dataRoot, home, repo, paths.dirname(git.file)];
    const before = Object.fromEntries(watched.map((dir) => [dir, inventory(dir)])); // prettier-ignore
    const published = process.env.CANOPY_GIT_EXECUTABLE;

    const created: string[] = [];
    const removed: string[] = [];
    const environment = snapshot({ HOME: home, TMPDIR: scratch });
    const target = createGitReadHostWith(
      { os: OS, environment, probeDirectory: dataRoot },
      {
        arch: 'x64',
        runner: {
          scratch: {
            create: async (prefix) => {
              const dir = mkdtempSync(prefix);
              created.push(dir);
              return Promise.resolve(dir);
            },
            remove: async (dir) => {
              removed.push(dir);
              rmSync(dir, { recursive: true, force: true });
              return Promise.resolve();
            },
          },
        },
      },
    );
    const inputs = createReadOnlyDirectoryInputs({
      preferences: createDirectoryReadPreferenceSource({ canonicalDataRoot: dataRoot, paths }), // prettier-ignore
      matchPolicy: createFileIndexingMatchPolicy(OS),
      git: target.port,
    });
    const options = await inputs.readOptions(new AbortController().signal);
    const ignored = await options.gitIgnore.checkIgnoredPaths(repo, ['a.log', 'b']); // prettier-ignore
    expect(ignored).toEqual(new Set(['inventory']));
    await expect(target.stop(AbortSignal.timeout(8_000))).resolves.toEqual({ state: 'stopped' }); // prettier-ignore

    evidence.record('composed no-write inventory', { created: created.length, removed: removed.length }); // prettier-ignore
    for (const dir of watched)
      expect([dir, inventory(dir)]).toEqual([dir, before[dir]]);
    // The fake Git logs beside its bin directory, outside the inventory.
    expect(lines(git.log)).toContain('check-ignore');
    expect(process.env.CANOPY_GIT_EXECUTABLE).toBe(published);
    expect(created.length).toBe(OS === 'darwin' ? 1 : 0);
    expect(removed).toEqual(created);
    for (const dir of created) {
      expect(dir.startsWith(join(scratch, 'git-validation-'))).toBe(true);
      expect(existsSync(dir)).toBe(false);
    }
    expect(readdirSync(scratch)).toEqual([]);
  });
});

windowsDescribe('createGitReadHost: planted binaries (native Windows)', () => {
  jest.setTimeout(120_000);

  it('never runs a where.exe planted in the probe directory or a where.exe or git.exe planted in the repository root', async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'git-read-host-win-'));
    try {
      const repo = join(dir, 'repo');
      const data = join(dir, 'data');
      mkdirSync(data);
      execFileSync('git', ['init', '-q', repo], { windowsHide: true });
      writeFileSync(join(repo, '.gitignore'), '*.log\n');
      // A planted copy of node loads the script named by its first argument
      // from its cwd, which writes the marker: `git` for where.exe, which
      // probes run in the probe directory, and `check-ignore` for git.exe,
      // which runs in the repository. No git.exe goes in the trusted probe
      // directory: where.exe lists its cwd first, and validation would run it
      // with `--version`, which loads no script.
      const marker = join(dir, 'planted-ran');
      const script = `require('fs').writeFileSync(${JSON.stringify(marker)}, process.argv0);\n`; // prettier-ignore
      const plant = (cwd: string, names: readonly string[]): void => {
        for (const name of names)
          writeFileSync(join(cwd, name), readFileSync(process.execPath));
        writeFileSync(join(cwd, 'git'), script);
        writeFileSync(join(cwd, 'check-ignore'), script);
      };
      plant(data, ['where.exe']);
      plant(repo, ['where.exe', 'git.exe']);
      const environment: Record<string, string | undefined> = {
        ...process.env,
      };
      const target = createGitReadHostWith(
        { os: 'win32', environment, probeDirectory: data },
        {},
      );
      const outcome = await settle(
        target.port.checkIgnoredPaths({
          root: repo,
          relativePaths: ['a.log', 'b.txt'],
          readSavedExecutablePath: () => Promise.resolve(''),
          signal: new AbortController().signal,
        }),
      );
      evidence.record('win32: planted binaries', {
        outcome: JSON.stringify(outcome, (_, value: unknown) => (value instanceof Set ? Array.from(value) : value)), // prettier-ignore
        markerWritten: existsSync(marker),
      });
      expect(existsSync(marker)).toBe(false);
      expect(outcome).toEqual({ value: new Set(['a.log']) });
      await expect(target.stop(AbortSignal.timeout(8_000))).resolves.toEqual({ state: 'stopped' }); // prettier-ignore
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); // prettier-ignore
    }
  });
});
