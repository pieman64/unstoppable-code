import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createSupervisionServices } from '../supervision';
import { createChildServices } from '../supervision/child';
import {
  NODE_SUPERVISION,
  type SupervisionOperations,
} from '../supervision/shared';
import { parseGitVersion } from '@canopy/core-runtime/node';
import {
  fsmonitorDischargeAudited,
  type SelectedGit,
} from '../git-read/commands';
import {
  createGitReadRunner,
  type GitReadOutput,
  type GitReadRunner,
  type GitReadRunnerOptions,
} from '../git-read/runner';
import { evidenceRecorder } from './git-read-evidence';
import {
  createdSince,
  createFixtureProcesses,
  descendantsOf,
  filetimeAt,
  present,
  startedSince,
  type CleanupResult,
  type FixtureProcesses,
  type Lifeline,
  type Liveness,
  type NativeProcess,
} from './git-read-fixtures';

// Native Windows only: the PlatformServices job's windows-2022 leg runs it.
const windows = process.platform === 'win32';
const nativeDescribe = windows ? describe : describe.skip;
const evidence = evidenceRecorder('windows');

/** libuv v1.51 `src/win/process.c` `required_vars`. */
const LIBUV_REQUIRED = [
  'HOMEDRIVE',
  'HOMEPATH',
  'LOGONSERVER',
  'PATH',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
] as const;
const AMBIENT_ONLY = 'CANOPY_GIT_READ_AMBIENT_ONLY';
const PATHEXT = '.COM;.EXE;.BAT;.CMD';
const RESERVE_MS = 2000;
// A loaded hosted runner can report settlement this late.
const SLACK_MS = 750;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
const settle = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
const errorCode = (error: unknown): unknown => Reflect.get(Object(error), 'code'); // prettier-ignore
const errorExitCode = (error: unknown): unknown =>
  Reflect.get(Object(error), 'exitCode');
const property = (value: unknown, key: string): unknown =>
  Reflect.get(Object(value), key);
const lines = (text: string): string[] => text.split(/\r?\n/).filter(Boolean);

let dir = '';
let home = '';
let emptyConfig = '';
let systemRoot = '';
let system32 = '';
let gitPath = '';
/** `gitPath` with the version production's selection parses from it. */
let selectedGit: SelectedGit = { executable: '', version: undefined };
let serial = 0;
let suiteSince = '';
let processes: FixtureProcesses | undefined;
/** Each test's cleanup, by test name; recorded with the temp-directory removal. */
const cleanups: Record<string, CleanupResult> = {};

function fx(): FixtureProcesses {
  if (processes === undefined) throw new Error('Fixture processes are not set up'); // prettier-ignore
  return processes;
}

/** A tracked process: by lifeline for a Node fixture, by start time otherwise. */
interface Watch {
  readonly pid: number;
  state(): Liveness;
  goneWithin(ms: number): Promise<boolean>;
}

const lifelineState = (line: Lifeline | undefined): Liveness =>
  line === undefined
    ? { state: 'unknown', how: 'never connected', failure: null }
    : line.closedAt === null
      ? { state: 'alive', how: 'lifeline open' }
      : { state: 'gone', how: 'lifeline closed' };

const lifelineWatch = (line: Lifeline): Watch => ({
  pid: line.pid,
  state: () => lifelineState(line),
  goneWithin: (ms) => fx().closedWithin(line, ms),
});

function nativeWatch(label: string, pid: number): Watch {
  const [native] = fx().trackNatives([{ label, pid }]);
  if (native === undefined) throw new Error(`${label} was not tracked`);
  const state = (): Liveness =>
    fx().nativeStates([native])[0] ?? { state: 'unknown', how: 'no result', failure: null }; // prettier-ignore
  return {
    pid,
    state,
    async goneWithin(ms): Promise<boolean> {
      const end = performance.now() + ms;
      while (performance.now() < end) {
        if (!present(pid)) return true;
        await delay(50);
      }
      return state().state === 'gone';
    },
  };
}

async function appears(file: string, ms = 20_000): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (existsSync(file) && readFileSync(file, 'utf8') !== '') return true;
    await delay(25);
  }
  return false;
}

function pidsIn(file: string): Record<string, number> {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const found: Record<string, number> = {};
  if (typeof parsed === 'object' && parsed !== null)
    for (const [key, value] of Object.entries(parsed))
      if (typeof value === 'number') found[key] = value;
  return found;
}

function fixture(name: string, files: Record<string, string> = {}): string {
  serial += 1;
  const target = join(dir, `${name}-${serial}`);
  mkdirSync(target);
  for (const [file, content] of Object.entries(files))
    writeFileSync(join(target, file), content);
  return target;
}

/**
 * Node under another name: it then runs the script named by its first
 * argument. Copied: a hard link would name the suite's own running node.exe
 * image, which Windows may refuse to delete with the temp directory.
 */
function plantNode(target: string): void {
  copyFileSync(process.execPath, target);
}

// Fixture scripts join the suite's lifeline; a fixture is its directory name.
const IN_FIXTURE = "require('node:path').basename(__dirname)";
const IN_CWD = "require('node:path').basename(process.cwd())";
const IDLE = 'setInterval(() => {}, 1000);';
const leafScript = (): string =>
  [`${fx().join('leaf', IN_FIXTURE)};`, IDLE].join('\n');

function samePath(left: string | undefined, right: string): boolean {
  if (left === undefined || !existsSync(left)) return false;
  const real = (value: string): string =>
    realpathSync.native(value).toLowerCase();
  return real(left) === real(right);
}

/** Isolated from the runner's and the user's Git configuration. */
function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    SystemRoot: systemRoot,
    PATH: [dirname(gitPath), system32, systemRoot].join(';'),
    PATHEXT,
    HOME: home,
    USERPROFILE: home,
    TEMP: dir,
    TMP: dir,
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CEILING_DIRECTORIES: dir,
    ...extra,
  };
}

function repository(gitignore: string, config: string[][] = []): string {
  const repo = fixture('repo');
  const env = gitEnv();
  execFileSync(gitPath, ['init', '-q', repo], { env });
  for (const [key = '', value = ''] of config)
    execFileSync(gitPath, ['-C', repo, 'config', key, value], { env });
  writeFileSync(join(repo, '.gitignore'), gitignore);
  return repo;
}

function locateGit(): string {
  const where = spawnSync(join(system32, 'where.exe'), ['git'], {
    encoding: 'utf8',
  });
  const found = lines(where.stdout ?? '').find((line) => existsSync(line));
  const standard = join(
    process.env.ProgramFiles ?? 'C:\\Program Files',
    'Git',
    'cmd',
    'git.exe',
  );
  const located = found ?? (existsSync(standard) ? standard : '');
  if (located === '')
    throw new Error('Git for Windows is required for the native suite');
  return located;
}

const runner = (options: Partial<GitReadRunnerOptions> = {}): GitReadRunner =>
  createGitReadRunner({ os: 'win32', ...options });

/** Bounded; what still holds the directory is recorded with the error. */
async function removeDir(
  target: string,
): Promise<{ attempts: number; error: unknown; remaining: string[] }> {
  let error: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); // prettier-ignore
      return { attempts: attempt, error: null, remaining: [] };
    } catch (caught) {
      error = {
        code: errorCode(caught),
        message: String(caught).slice(0, 300),
      };
      await delay(2000);
    }
  }
  let remaining: string[];
  try {
    remaining = readdirSync(target, { encoding: 'utf8', recursive: true }).slice(0, 40); // prettier-ignore
  } catch (caught) {
    remaining = [`unlistable: ${String(caught)}`];
  }
  return { attempts: 3, error, remaining };
}

/** Names a fixture can start, directly or through Git for Windows. */
const AUDITED = new Set(['cmd.exe', 'conhost.exe', 'git.exe', 'node.exe', 'sh.exe', 'bash.exe', 'sleep.exe', 'taskkill.exe', 'where.exe', 'powershell.exe']); // prettier-ignore

/**
 * Processes created since the suite began that still run, other than this
 * query: untracked leftovers, or unrelated runner activity under an audited
 * name. Recorded only, because the two cannot be told apart.
 */
function untrackedSurvivors(since: string): unknown {
  const table = fx().processTable();
  if ('failure' in table) return { failure: table.failure };
  return startedSince(table.rows, { self: process.pid, since, dir, names: AUDITED }) // prettier-ignore
    .map(({ pid, ppid, name, commandLine }) => ({ pid, ppid, name, commandLine: commandLine.slice(0, 200) })); // prettier-ignore
}

beforeAll(async () => {
  if (!windows) return;
  suiteSince = filetimeAt(Date.now());
  dir = mkdtempSync(join(realpathSync.native(tmpdir()), 'git-read-win-'));
  systemRoot = process.env.SystemRoot ?? '';
  system32 = join(systemRoot, 'System32');
  processes = await createFixtureProcesses({ dir, systemRoot });
  home = join(dir, 'home');
  mkdirSync(home);
  emptyConfig = join(dir, 'empty.gitconfig');
  writeFileSync(emptyConfig, '');
  gitPath = locateGit();
  const gitVersion = execFileSync(gitPath, ['--version'], { env: gitEnv() })
    .toString()
    .trim();
  selectedGit = {
    executable: gitPath,
    version: parseGitVersion(gitVersion) ?? undefined,
  };
  evidence.recordSuite('host', {
    gitPath,
    gitVersion,
    fsmonitorDischargeAudited: fsmonitorDischargeAudited(selectedGit.version),
  });
});

// Ends every process the test left; one it cannot confirm gone fails the test.
afterEach(async () => {
  if (processes === undefined) return;
  const result = await processes.reap('test');
  const { lifelines: started, natives } = result.tracked;
  if (started + natives > 0 || result.survivors.length > 0)
    cleanups[expect.getState().currentTestName ?? 'unknown'] = result;
  if (result.survivors.length > 0)
    throw new Error(`Fixture processes survived cleanup: ${JSON.stringify(result.survivors)}`); // prettier-ignore
});

afterAll(async () => {
  const failures: string[] = [];
  if (windows && dir !== '') {
    // A fixture still starting connects within this; one that never does
    // ends itself when the lifeline server closes.
    await delay(500);
    const final = processes === undefined ? null : await processes.reap('all');
    await processes?.close();
    const untracked =
      processes === undefined ? null : untrackedSurvivors(suiteSince);
    const tempDir = await removeDir(dir);
    evidence.recordSuite('cleanup', { perTest: cleanups, final, untracked, tempDir }); // prettier-ignore
    if (final !== null && final.survivors.length > 0)
      failures.push(`survivors ${JSON.stringify(final.survivors)}`);
    if (tempDir.error !== null)
      failures.push(`temp directory ${JSON.stringify(tempDir)}`);
  }
  evidence.flush();
  if (failures.length > 0)
    throw new Error(`Windows fixture cleanup failed: ${failures.join('; ')}`);
});

nativeDescribe(
  'git read on native Windows (requires process.platform win32)',
  () => {
    jest.setTimeout(120_000);

    // D2: where.exe is resolved through the supplied PATH and spawned by its
    // absolute path; where.exe itself then lists its cwd before PATH.
    describe('where.exe git', () => {
      function whereGit(cwd: string, path: string): Promise<GitReadOutput> {
        return runner().run(
          { kind: 'where-git' },
          {
            cwd,
            environment: { SystemRoot: systemRoot, PATH: path, PATHEXT },
            deadlineAt: performance.now() + 20_000,
          },
        );
      }

      it('lists the request cwd before the supplied PATH', async () => {
        const cwd = fixture('where-cwd', { 'git.cmd': '@exit /b 0\r\n' });
        const onPath = fixture('where-path', { 'git.cmd': '@exit /b 0\r\n' });
        const output = await whereGit(cwd, [onPath, system32].join(';'));
        const found = lines(output.stdout);
        evidence.record('where: cwd before PATH', {
          code: output.code,
          order: found.map((line) =>
            samePath(line, join(cwd, 'git.cmd'))
              ? 'cwd'
              : samePath(line, join(onPath, 'git.cmd'))
                ? 'path'
                : 'other',
          ),
        });
        expect(output.code).toBe(0);
        expect(found).toHaveLength(2);
        expect(samePath(found[0], join(cwd, 'git.cmd'))).toBe(true);
        expect(samePath(found[1], join(onPath, 'git.cmd'))).toBe(true);
      });

      it('finds real Git through the supplied PATH alone', async () => {
        const output = await whereGit(
          fixture('where-empty'),
          [dirname(gitPath), system32].join(';'),
        );
        const found = lines(output.stdout);
        evidence.record('where: PATH only', {
          code: output.code,
          firstIsGit: samePath(found[0], gitPath),
          count: found.length,
        });
        expect(output.code).toBe(0);
        expect(samePath(found[0], gitPath)).toBe(true);
      });

      it('exits 1 when neither the cwd nor the supplied PATH has git', async () => {
        const output = await whereGit(fixture('where-none'), system32);
        evidence.record('where: not found', {
          code: output.code,
          stdout: output.stdout,
        });
        expect(output).toMatchObject({ code: 1, stdout: '' });
      });

      // libuv's search_path would try the spawn cwd before PATH.
      it('runs System32 where.exe from the supplied PATH, not one planted in the request cwd', async () => {
        const cwd = fixture('where-planted', {
          git: "process.stdout.write('planted where.exe ran');",
        });
        plantNode(join(cwd, 'where.exe'));
        const output = await whereGit(cwd, system32);
        evidence.record('where: planted where.exe in cwd', {
          code: output.code,
          ranPlanted: output.stdout === 'planted where.exe ran',
        });
        expect(output.stdout).not.toContain('planted where.exe ran');
        expect([0, 1]).toContain(output.code);
      });

      it('rejects with command_not_found when the supplied PATH has no where.exe', async () => {
        const cwd = fixture('where-unresolved');
        plantNode(join(cwd, 'where.exe'));
        const outcome = await settle(whereGit(cwd, fixture('where-empty-path'))); // prettier-ignore
        evidence.record('where: not on the supplied PATH', {
          code: errorCode(Reflect.get(Object(outcome), 'error')),
        });
        expect(outcome).toMatchObject({ error: { code: 'command_not_found' } });
      });
    });

    describe('relative check-ignore executable', () => {
      it('resolves `git` through the supplied PATH, never the request cwd', async () => {
        const repo = repository('*.log\n');
        writeFileSync(
          join(repo, 'check-ignore'),
          "process.stdout.write('planted git.exe\\0');",
        );
        const check = (): Promise<Set<string>> =>
          runner().checkIgnoredPathsWith('git', repo, ['a.log', 'b'], gitEnv());
        const real = await check();
        plantNode(join(repo, 'git.exe'));
        const planted = await check();
        evidence.record(
          'relative git: PATH only, planted cwd git.exe ignored',
          {
            withoutPlant: Array.from(real),
            withPlant: Array.from(planted),
          },
        );
        expect(real).toEqual(new Set(['a.log']));
        expect(planted).toEqual(new Set(['a.log']));
      });
    });

    // D1 against libuv's make_program_env: absent required keys are supplied
    // empty, and a missing or unusable PATH or SystemRoot is refused.
    describe('child environment', () => {
      const DUMP = [
        'const env = {};',
        'for (const key of Object.keys(process.env)) env[key] = process.env[key];',
        "process.stdout.write(JSON.stringify({ env, node: process.versions.node, uv: process.versions.uv }) + '\\0');",
      ].join('\n');
      const CRITICAL = new Set(['PATH', 'SYSTEMROOT']);
      let dumpDir = '';
      let savedAmbient: string | undefined;

      interface Dump {
        readonly env: Readonly<Record<string, unknown>>;
        readonly node: unknown;
        readonly uv: unknown;
      }
      type Observed =
        | { readonly started: true; readonly dump: Dump }
        | {
            readonly started: false;
            readonly code: number | null;
            readonly stderr: string;
            /** The request's rejection code; null when the child ran. */
            readonly rejected: string | null;
          };

      function isDump(value: unknown): value is Dump {
        if (typeof value !== 'object' || value === null) return false;
        const env: unknown = Reflect.get(value, 'env');
        return typeof env === 'object' && env !== null;
      }

      async function observe(
        environment: Record<string, string>,
      ): Promise<Observed> {
        let output: GitReadOutput;
        try {
          output = await runner().run(
            {
              kind: 'git-check-ignore',
              executable: process.execPath,
              input: new Uint8Array(0),
            },
            { cwd: dumpDir, environment, deadlineAt: performance.now() + 20_000 }, // prettier-ignore
          );
        } catch (error) {
          const code = errorCode(error);
          return { started: false, code: null, stderr: '', rejected: typeof code === 'string' ? code : String(error) }; // prettier-ignore
        }
        const text = output.stdout.replace(/\0$/, '');
        const parsed: unknown = output.code === 0 ? JSON.parse(text) : null;
        if (isDump(parsed)) return { started: true, dump: parsed };
        return {
          started: false,
          code: output.code,
          stderr: output.stderr.slice(0, 400),
          rejected: null,
        };
      }

      /** Every key matching `name` case-insensitively, as the child sees it. */
      function entries(dump: Dump, name: string): [string, unknown][] {
        return Object.entries(dump.env).filter(
          ([key]) => key.toUpperCase() === name,
        );
      }

      function host(): Record<string, string> {
        const values: Record<string, string> = {};
        for (const key of LIBUV_REQUIRED) {
          const value = process.env[key];
          if (value !== undefined) values[key] = value;
        }
        return values;
      }

      function without(
        values: Record<string, string>,
        name: string,
      ): Record<string, string> {
        return Object.fromEntries(
          Object.entries(values).filter(([key]) => key.toUpperCase() !== name),
        );
      }

      /** Classifies a value without recording it; `supplied` wins over host. */
      function seen(
        observed: Observed,
        name: string,
        supplied?: string,
      ): string {
        if (!observed.started)
          return observed.rejected === null ? 'child-failed' : `rejected:${observed.rejected}`; // prettier-ignore
        const found = entries(observed.dump, name);
        if (found.length === 0) return 'absent';
        if (found.length > 1) return 'duplicated';
        const value = found[0]?.[1];
        if (value === '') return 'empty';
        if (supplied !== undefined && value === supplied) return 'supplied';
        if (value === process.env[name]) return 'host';
        return 'other';
      }

      beforeAll(() => {
        dumpDir = fixture('env-dump', { 'check-ignore': DUMP });
        savedAmbient = process.env[AMBIENT_ONLY];
        process.env[AMBIENT_ONLY] = 'ambient';
      });

      afterAll(() => {
        if (savedAmbient === undefined) delete process.env[AMBIENT_ONLY];
        else process.env[AMBIENT_ONLY] = savedAmbient;
      });

      it('supplies every omitted libuv-required key empty, and nothing from the host', async () => {
        const supplied = { SystemRoot: systemRoot, PATH: system32 };
        const observed = await observe({ ...supplied, CANOPY_SUPPLIED: 'yes' });
        const keys = observed.started
          ? Object.keys(observed.dump.env).map((key) => key.toUpperCase())
          : [];
        const perKey = Object.fromEntries(
          LIBUV_REQUIRED.map((key) => [
            key,
            seen(observed, key, key === 'PATH' ? system32 : key === 'SYSTEMROOT' ? systemRoot : undefined), // prettier-ignore
          ]),
        );
        evidence.record(
          'env: only PATH, SystemRoot and CANOPY_SUPPLIED supplied',
          {
            started: observed.started,
            childNode: observed.started ? observed.dump.node : null,
            childUv: observed.started ? observed.dump.uv : null,
            childKeys: [...keys].sort(),
            hostDefined: Object.keys(host()).sort(),
            perKey,
            ambientOnly: seen(observed, AMBIENT_ONLY),
          },
        );
        expect(observed.started).toBe(true);
        expect([...keys].sort()).toEqual(
          ['CANOPY_SUPPLIED', ...LIBUV_REQUIRED].sort(),
        );
        expect(perKey).toEqual(
          Object.fromEntries(
            LIBUV_REQUIRED.map((key) => [key, CRITICAL.has(key) ? 'supplied' : 'empty']), // prettier-ignore
          ),
        );
      });

      it('supplies each omitted key empty, keeps each empty key, and refuses a missing or empty PATH or SystemRoot, one at a time', async () => {
        const perKey: Record<string, unknown> = {};
        const failures: string[] = [];
        for (const key of LIBUV_REQUIRED) {
          const omitted = await observe({
            ...without(host(), key),
            CANOPY_SUPPLIED: 'yes',
          });
          const empty = await observe({
            ...host(),
            [key]: '',
            CANOPY_SUPPLIED: 'yes',
          });
          const leaked = (observed: Observed): boolean =>
            observed.started && seen(observed, AMBIENT_ONLY) !== 'absent';
          const result = {
            hostDefined: process.env[key] !== undefined,
            omitted: seen(omitted, key),
            empty: seen(empty, key),
            childFailure: [omitted, empty].flatMap(
              (observed) =>
              observed.started || observed.rejected !== null ? [] : [{ code: observed.code, stderr: observed.stderr }], // prettier-ignore
            ),
            ambientOnlyReached: leaked(omitted) || leaked(empty),
          };
          perKey[key] = result;
          const expected = CRITICAL.has(key) ? 'rejected:invalid_request' : 'empty'; // prettier-ignore
          if (result.omitted !== expected)
            failures.push(`${key} omitted: ${result.omitted}`);
          if (result.empty !== expected)
            failures.push(`${key} empty: ${result.empty}`);
          if (result.ambientOnlyReached)
            failures.push(`${key}: ambient leaked`);
        }
        evidence.record('env: each required key omitted or empty', perKey);
        expect(failures).toEqual([]);
      });

      it('treats a differently cased Path as present', async () => {
        const observed = await observe({
          ...without(host(), 'PATH'),
          Path: 'C:\\canopy-path-variant',
          CANOPY_SUPPLIED: 'yes',
        });
        const found = observed.started ? entries(observed.dump, 'PATH') : [];
        evidence.record('env: Path variant', {
          started: observed.started,
          keys: found.map(([key]) => key),
          supplied: found.every(([, value]) => value === 'C:\\canopy-path-variant'), // prettier-ignore
        });
        expect(found).toEqual([['Path', 'C:\\canopy-path-variant']]);
      });
    });

    // Recorded only: the suite identifies its processes by lifeline and .NET
    // start time, not by this CIM query.
    describe('inspectProcess on a live fixture', () => {
      it('never reports it absent, and records each query it ran', async () => {
        const cwd = fixture('inspect', { 'leaf.js': leafScript() });
        spawn(process.execPath, [join(cwd, 'leaf.js')], {
          cwd,
          stdio: 'ignore',
          windowsHide: true,
        });
        const leaf = await fx().lifeline(cwd, 'leaf');
        const queries: unknown[] = [];
        const run: SupervisionOperations['run'] = async (
          file,
          args,
          signal,
          env,
        ) => {
          const begun = performance.now();
          const ms = (): number => Math.round(performance.now() - begun);
          try {
            const stdout = await NODE_SUPERVISION.run(file, args, signal, env);
            queries.push({ file: basename(file), ms: ms(), ok: true, stdout: stdout.slice(0, 400) }); // prettier-ignore
            return stdout;
          } catch (error) {
            const part = (key: string): string => {
              const value = property(error, key);
              return typeof value === 'string' ? value.slice(0, 800) : '';
            };
            queries.push({
              file: basename(file),
              ms: ms(),
              ok: false,
              code: errorCode(error),
              killed: property(error, 'killed'),
              signal: property(error, 'signal'),
              message: String(error).slice(0, 400),
              stdout: part('stdout'),
              stderr: part('stderr'),
            });
            throw error;
          }
        };
        const result = await createSupervisionServices('win32', {
          run,
        }).inspectProcess({ pid: leaf.pid });
        evidence.record('inspectProcess: live fixture', {
          result,
          queries,
          lifelineOpen: leaf.closedAt === null,
          suiteIdentity: fx().identities([leaf.pid]),
        });
        expect(leaf.closedAt).toBeNull();
        expect(result.state).not.toBe('absent');
      });
    });

    // C2/D3: taskkill is asynchronous; settlement waits for it within the
    // reserve, and one still running then continues within the port's bound.
    describe('taskkill settlement', () => {
      /** A runner root and the descendant it starts, each on its lifeline. */
      const treeScript = (): string =>
        [
          "const { spawn } = require('node:child_process');",
          `${fx().join('root', IN_FIXTURE)};`,
          `spawn(process.execPath, ['-e', ${JSON.stringify(`${fx().join('descendant', IN_CWD)}; ${IDLE}`)}], { stdio: 'ignore', windowsHide: true });`, // prettier-ignore
          IDLE,
        ].join('\n');
      // Stands in for taskkill: runs the real one at `invokeAt` (epoch ms).
      const helperScript = (): string =>
        [
          "const { execFile } = require('node:child_process');",
          'const [fixture, invokeAt, taskkill, ...args] = process.argv.slice(2);',
          `const line = ${fx().join('helper', 'fixture')};`,
          'setTimeout(() => {',
          "  line.report('invoking taskkill');",
          "  execFile(taskkill, args, { windowsHide: true }, (error) => line.finish('taskkill ended', { code: error ? (error.code ?? null) : 0 }, error ? 1 : 0));", // prettier-ignore
          '}, Math.max(0, Number(invokeAt) - Date.now()));',
        ].join('\n');
      // 0.5 s after the reserve ends, 1.5 s before the port's 4 s execFile bound.
      const HELPER_INVOKE_MS = 2500;
      /** NODE_SUPERVISION.run's execFile timeout. */
      const TASKKILL_BOUND_MS = 4000;
      const PRE_CALL_DELAY_MS = 3000;

      type SignalAtCall = 'none' | 'live' | 'aborted';
      const signalAt = (signal: AbortSignal | undefined): SignalAtCall =>
        signal === undefined ? 'none' : signal.aborted ? 'aborted' : 'live';

      interface KillCall {
        readonly ms: number;
        readonly ok: boolean;
        readonly code?: unknown;
        /** The signal the runner passed, as `run` was called. */
        readonly signalAtCall: SignalAtCall;
      }

      /** Waits until `done`, at most until `at` (performance.now() time). */
      async function waitUntil(
        done: () => boolean,
        at: number,
      ): Promise<boolean> {
        while (!done() && performance.now() < at) await delay(50);
        return done();
      }

      function timed(
        calls: KillCall[],
        latencyMs = 0,
      ): SupervisionOperations['run'] {
        return async (file, args, signal, env) => {
          const begun = performance.now();
          // Injected latency ignores the signal; the call then follows the abort.
          if (latencyMs > 0) await delay(latencyMs);
          const signalAtCall = signalAt(signal);
          try {
            const stdout = await NODE_SUPERVISION.run(file, args, signal, env);
            calls.push({ ms: Math.round(performance.now() - begun), ok: true, signalAtCall }); // prettier-ignore
            return stdout;
          } catch (error) {
            calls.push({
              ms: Math.round(performance.now() - begun),
              ok: false,
              code: errorCode(error),
              signalAtCall,
            });
            throw error;
          }
        };
      }

      function start(
        options: Partial<GitReadRunnerOptions>,
        deadlineAt: number,
        signal?: AbortSignal,
        cwd = fixture('tree', { 'check-ignore': treeScript() }),
      ): { cwd: string; work: Promise<unknown>; started: GitReadRunner } {
        const started = runner(options);
        const work = settle(
          started.run(
            {
              kind: 'git-check-ignore',
              executable: process.execPath,
              input: new Uint8Array(0),
            },
            { cwd, environment: gitEnv(), deadlineAt, signal },
          ),
        );
        return { cwd, work, started };
      }

      async function treeOf(
        cwd: string,
      ): Promise<{ root: Lifeline; descendant: Lifeline }> {
        const root = await fx().lifeline(cwd, 'root');
        return { root, descendant: await fx().lifeline(cwd, 'descendant') };
      }

      const outcomeCode = (outcome: unknown): unknown =>
        errorCode(Reflect.get(Object(outcome), 'error'));

      it('settles an abort after taskkill ends the tree, within the reserve', async () => {
        const rounds: unknown[] = [];
        for (let round = 0; round < 3; round += 1) {
          const calls: KillCall[] = [];
          const controller = new AbortController();
          const reason = new Error(`abort ${round}`);
          const { cwd, work } = start(
            { operations: { run: timed(calls) } },
            performance.now() + 60_000,
            controller.signal,
          );
          const tree = await treeOf(cwd);
          const abortedAt = performance.now();
          controller.abort(reason);
          const outcome = await work;
          const settleMs = Math.round(performance.now() - abortedAt);
          const rootGone = await fx().closedWithin(tree.root, 6000);
          const descendantGone = await fx().closedWithin(tree.descendant, 6000);
          const kind =
            Reflect.get(Object(outcome), 'error') === reason
              ? 'abort-reason'
              : outcomeCode(outcome);
          rounds.push({ settleMs, outcome: kind, taskkills: calls, rootGone, descendantGone }); // prettier-ignore
          expect(settleMs).toBeLessThan(RESERVE_MS + SLACK_MS);
          expect(calls).toHaveLength(1);
          expect(rootGone && descendantGone).toBe(true);
          // Unconfirmed only if taskkill outlasted the reserve; recorded either way.
          expect(['abort-reason', 'cleanup_unconfirmed']).toContain(kind);
        }
        evidence.record('taskkill: request abort (3 rounds)', rounds);
      });

      it('settles a deadline stop by the request deadline', async () => {
        const calls: KillCall[] = [];
        const deadlineAt = performance.now() + RESERVE_MS + 6000;
        const { cwd, work } = start(
          { operations: { run: timed(calls) } },
          deadlineAt,
        );
        const outcome = await work;
        const lateMs = Math.round(performance.now() - deadlineAt);
        const root = fx().find(cwd, 'root');
        const descendant = fx().find(cwd, 'descendant');
        const formed = root !== undefined && descendant !== undefined;
        const rootGone = root !== undefined && (await fx().closedWithin(root, 6000)); // prettier-ignore
        const descendantGone = descendant !== undefined && (await fx().closedWithin(descendant, 6000)); // prettier-ignore
        evidence.record('taskkill: deadline', {
          lateMs,
          outcome: outcomeCode(outcome),
          taskkills: calls,
          formed,
          rootGone,
          descendantGone,
        });
        expect(lateMs).toBeLessThan(SLACK_MS);
        expect(formed).toBe(true);
        expect(['deadline_exceeded', 'cleanup_unconfirmed']).toContain(
          outcomeCode(outcome),
        );
        expect(rootGone && descendantGone).toBe(true);
      });

      // The port's taskkill bound (4 s) exceeds the reserve (2 s). Here the
      // reserve ends during an injected delay before the call. D3: the call
      // still runs taskkill, unsignalled, after the request settled.
      it('reports cleanup_unconfirmed at the reserve, and the delayed taskkill still ends the tree (3 s injected pre-call delay)', async () => {
        const calls: KillCall[] = [];
        const reports: string[] = [];
        const controller = new AbortController();
        const reason = new Error('slow taskkill');
        const { cwd, work, started } = start(
          {
            operations: { run: timed(calls, PRE_CALL_DELAY_MS) },
            onKillCleanup: (outcome) => void reports.push(outcome),
          },
          performance.now() + 60_000,
          controller.signal,
        );
        const tree = await treeOf(cwd);
        const abortedAt = performance.now();
        controller.abort(reason);
        const outcome = await work;
        const settleMs = Math.round(performance.now() - abortedAt);
        const callsAtSettle = calls.length;
        const reportsAtSettle = [...reports];
        const idleAtSettle = await started.whenIdle(AbortSignal.abort());
        const bound = abortedAt + PRE_CALL_DELAY_MS + TASKKILL_BOUND_MS + SLACK_MS; // prettier-ignore
        const called = await waitUntil(() => calls.length > 0, bound);
        const rootGone = await fx().closedWithin(tree.root, Math.max(0, bound - performance.now())); // prettier-ignore
        const descendantGone = await fx().closedWithin(tree.descendant, Math.max(1000, bound - performance.now())); // prettier-ignore
        const idleAfter = await started.whenIdle(AbortSignal.timeout(2000));
        const since = (at: number | null): number | null =>
          at === null ? null : Math.round(at - abortedAt);
        evidence.record('taskkill: reserve expires before the call', {
          settleMs,
          outcome: outcomeCode(outcome),
          callsAtSettle,
          taskkills: calls,
          rootEndedMs: since(tree.root.closedAt),
          descendantEndedMs: since(tree.descendant.closedAt),
          reportsAtSettle,
          reports,
          idleAtSettle,
          idleAfter,
        });
        expect(outcome).toMatchObject({
          error: { code: 'cleanup_unconfirmed', failure: reason },
        });
        expect(settleMs).toBeGreaterThanOrEqual(RESERVE_MS - 50);
        expect(settleMs).toBeLessThan(RESERVE_MS + SLACK_MS);
        expect(callsAtSettle).toBe(0);
        expect(called).toBe(true);
        expect(calls).toMatchObject([{ ok: true, signalAtCall: 'none' }]);
        expect(calls[0]?.ms).toBeLessThan(PRE_CALL_DELAY_MS + TASKKILL_BOUND_MS); // prettier-ignore
        expect(rootGone && descendantGone).toBe(true);
        // R5 §2.3: the continuing kill is reported, and keeps the runner pending.
        expect(reportsAtSettle).toEqual(['cleanup_unconfirmed']);
        expect(reports).toEqual(['cleanup_unconfirmed']);
        expect(idleAtSettle).toBe('pending');
        expect(idleAfter).toBe('idle');
      });

      // A Node stand-in for taskkill runs through the port's own execFile
      // (same options and 4 s bound) and is still running when the reserve
      // ends; it calls the real taskkill at HELPER_INVOKE_MS. D3: it is not
      // aborted, so it goes on to end the tree after the request settled.
      it('reports cleanup_unconfirmed at the reserve while the kill helper runs, and the helper then ends the tree (taskkill stand-in)', async () => {
        const calls: KillCall[] = [];
        const controller = new AbortController();
        const reason = new Error('helper still running');
        const cwd = fixture('tree', {
          'check-ignore': treeScript(),
          'helper.js': helperScript(),
        });
        const run: SupervisionOperations['run'] = async (
          file,
          args,
          signal,
          env,
        ) => {
          const begun = performance.now();
          const signalAtCall = signalAt(signal);
          const invokeAt = String(Date.now() + HELPER_INVOKE_MS);
          const helper = [join(cwd, 'helper.js'), basename(cwd), invokeAt, file, ...args]; // prettier-ignore
          try {
            const stdout = await NODE_SUPERVISION.run(process.execPath, helper, signal, env); // prettier-ignore
            calls.push({ ms: Math.round(performance.now() - begun), ok: true, signalAtCall }); // prettier-ignore
            return stdout;
          } catch (error) {
            calls.push({
              ms: Math.round(performance.now() - begun),
              ok: false,
              code: errorCode(error),
              signalAtCall,
            });
            throw error;
          }
        };
        const reports: string[] = [];
        const { work, started } = start(
          {
            operations: { run },
            onKillCleanup: (killOutcome) => void reports.push(killOutcome),
          },
          performance.now() + 60_000,
          controller.signal,
          cwd,
        );
        const tree = await treeOf(cwd);
        const abortedAt = performance.now();
        controller.abort(reason);
        const outcome = await work;
        const settledAt = performance.now();
        // No close is processed between settlement and this read, so an open
        // lifeline here means the helper still ran when the reserve ended.
        const helper = fx().find(cwd, 'helper');
        const runningAtSettle =
          helper !== undefined && helper.closedAt === null;
        const reportsAtSettle = [...reports];
        const idleAtSettle = await started.whenIdle(AbortSignal.abort());
        const bound = abortedAt + TASKKILL_BOUND_MS + SLACK_MS;
        const helperEnded = helper !== undefined && (await fx().closedWithin(helper, Math.max(0, bound - performance.now()))); // prettier-ignore
        const called = await waitUntil(() => calls.length > 0, bound + 1000);
        const rootGone = await fx().closedWithin(tree.root, 2000);
        const descendantGone = await fx().closedWithin(tree.descendant, 2000);
        const idleAfter = await started.whenIdle(AbortSignal.timeout(2000));
        const since = (at: number | null): number | null =>
          at === null ? null : Math.round(at - abortedAt);
        evidence.record('taskkill: reserve expires while the helper runs', {
          reportsAtSettle,
          reports,
          idleAtSettle,
          idleAfter,
          settleMs: since(settledAt),
          outcome: outcomeCode(outcome),
          taskkills: calls,
          helper:
            helper === undefined
              ? null
              : {
                  pid: helper.pid,
                  startedMs: since(helper.openedAt),
                  runningAtSettle,
                  endedMs: since(helper.closedAt),
                  events: helper.events.map(({ event, at, detail }) => ({ event, ms: since(at), detail })), // prettier-ignore
                },
          rootEndedMs: since(tree.root.closedAt),
          descendantEndedMs: since(tree.descendant.closedAt),
        });
        expect(outcome).toMatchObject({
          error: { code: 'cleanup_unconfirmed', failure: reason },
        });
        expect(settledAt - abortedAt).toBeGreaterThanOrEqual(RESERVE_MS - 50);
        expect(settledAt - abortedAt).toBeLessThan(RESERVE_MS + SLACK_MS);
        expect(runningAtSettle).toBe(true);
        expect(helperEnded).toBe(true);
        expect(helper?.events).toMatchObject([
          { event: 'invoking taskkill' },
          { event: 'taskkill ended', detail: { code: 0 } },
        ]);
        expect(called).toBe(true);
        expect(calls).toMatchObject([{ ok: true, signalAtCall: 'none' }]);
        expect(rootGone && descendantGone).toBe(true);
        // R5 §2.3: the running helper is reported, and keeps the runner pending.
        expect(reportsAtSettle).toEqual(['cleanup_unconfirmed']);
        expect(reports).toEqual(['cleanup_unconfirmed']);
        expect(idleAtSettle).toBe('pending');
        expect(idleAfter).toBe('idle');
      });

      // Why the runner passes taskkill no signal: an aborted one still starts it.
      it('execFile with an already-aborted signal creates taskkill.exe, then terminates it', async () => {
        const controller = new AbortController();
        controller.abort();
        const observed = await new Promise<Record<string, unknown>>(
          (resolve) => {
            const seen: Record<string, unknown> = {};
            const child = execFile(
              join(system32, 'taskkill.exe'),
              ['/?'],
              { signal: controller.signal, windowsHide: true, env: { SystemRoot: systemRoot } }, // prettier-ignore
              (error) => {
                seen.callbackCode = errorCode(error);
              },
            );
            seen.pid = child.pid ?? null;
            const timer = setTimeout(() => resolve({ ...seen, exit: 'none within 5 s' }), 5000); // prettier-ignore
            child.once('exit', (code, signal) => {
              clearTimeout(timer);
              // The callback can follow the exit event; let it run first.
              setImmediate(() => resolve({ ...seen, exitCode: code, exitSignal: signal })); // prettier-ignore
            });
          },
        );
        evidence.record('execFile: signal aborted before the call', observed);
        expect(observed.callbackCode).toBe('ABORT_ERR');
        expect(typeof observed.pid).toBe('number');
        // libuv reports SIGTERM only when its TerminateProcess ended a running process.
        expect(observed.exitSignal).toBe('SIGTERM');
      });
    });

    // Whether libuv's kill-on-close job ends an owned tree when its host dies.
    describe('parent-exit job object', () => {
      const hostScript = (): string =>
        [
          "const { spawn } = require('node:child_process');",
          "const { readFileSync, writeFileSync } = require('node:fs');",
          "const { join } = require('node:path');",
          `${fx().join('host', IN_FIXTURE)};`,
          "const { options, file, args } = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf8'));", // prettier-ignore
          "const child = spawn(file, args, { ...options, cwd: __dirname, stdio: ['pipe', 'ignore', 'ignore'] });", // prettier-ignore
          "child.on('spawn', () => writeFileSync(join(__dirname, 'owned.json'), JSON.stringify({ host: process.pid, owned: child.pid })));", // prettier-ignore
          IDLE,
        ].join('\n');
      const nodeTreeScript = (): string =>
        [
          "const { spawn } = require('node:child_process');",
          `${fx().join('tree', IN_FIXTURE)};`,
          "spawn(process.execPath, ['leaf.js'], { stdio: 'ignore', windowsHide: true });", // prettier-ignore
          IDLE,
        ].join('\n');
      const jobFixture = (): string =>
        fixture('job', { 'host.js': hostScript(), 'leaf.js': leafScript(), 'tree.js': nodeTreeScript() }); // prettier-ignore

      /**
       * Starts a host that spawns `file args` with `options`, then kills the
       * host. `ownedRole` names a Node child's lifeline; null tracks a native
       * child by its start time.
       */
      async function hostDies(
        lifetime: 'owned' | 'independent',
        file: string,
        args: string[],
        ownedRole: string | null,
        cwd = jobFixture(),
        beforeKill: (owned: Watch) => Promise<void> = () => Promise.resolve(),
      ): Promise<{ owned: Watch; ownedGone: boolean; cwd: string }> {
        const options = createChildServices('win32').childProcessOptions({
          lifetime,
        });
        writeFileSync(
          join(cwd, 'config.json'),
          JSON.stringify({ options, file, args }),
        );
        const hostProcess = spawn(process.execPath, [join(cwd, 'host.js')], {
          cwd,
          stdio: 'ignore',
          windowsHide: true,
        });
        await fx().lifeline(cwd, 'host');
        expect(await appears(join(cwd, 'owned.json'))).toBe(true);
        const { owned: ownedPid = 0 } = pidsIn(join(cwd, 'owned.json'));
        // The live host holds the owned child's handle, so its PID is not reused yet.
        const owned =
          ownedRole === null
            ? nativeWatch(basename(file), ownedPid)
            : lifelineWatch(await fx().lifeline(cwd, ownedRole));
        expect(owned.pid).toBe(ownedPid);
        if (existsSync(join(cwd, 'leaf.js'))) await fx().lifeline(cwd, 'leaf');
        await beforeKill(owned);
        hostProcess.kill();
        const ownedGone = await owned.goneWithin(5000);
        return { owned, ownedGone, cwd };
      }

      /** Tracks what `owned` started by start time, except the PIDs in `onLifeline`. */
      function trackDescendants(
        owned: Watch,
        onLifeline: readonly number[] = [],
      ): { found: number[]; tracked: NativeProcess[]; failure: unknown } {
        const table = fx().processTable();
        if ('failure' in table)
          return { found: [], tracked: [], failure: table.failure };
        const found = descendantsOf(table.rows, owned.pid);
        const tracked = fx().trackNatives(
          found
            .filter(({ pid }) => !onLifeline.includes(pid))
            .map(({ name, pid }) => ({ label: name, pid })),
        );
        return { found: found.map(({ pid }) => pid), tracked, failure: null };
      }

      function described(tracked: readonly NativeProcess[]): unknown[] {
        const states = fx().nativeStates(tracked);
        return tracked.map(({ label, pid }, index) => ({ name: label, pid, ...states[index] })); // prettier-ignore
      }

      it('owned options are not detached', () => {
        expect(
          createChildServices('win32').childProcessOptions({
            lifetime: 'owned',
          }),
        ).toEqual({ detached: false, windowsHide: true });
      });

      it('ends an owned Node child and the descendant it assigned to its own job', async () => {
        const result = await hostDies('owned', process.execPath, ['tree.js'], 'tree'); // prettier-ignore
        await delay(1000);
        const descendant = lifelineState(fx().find(result.cwd, 'leaf'));
        evidence.record('job: owned node child, libuv descendant', {
          ownedGone: result.ownedGone,
          descendant,
        });
        expect(result.ownedGone).toBe(true);
        expect(descendant.state).toBe('gone');
      });

      // libuv's job sets JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK: only the direct
      // child is in it, so a non-libuv child's descendants are not.
      // Its other descendants (a console host) are tracked so cleanup confirms them gone.
      it('ends an owned cmd.exe child but not the descendant cmd.exe started', async () => {
        const cwd = jobFixture();
        let discovery: ReturnType<typeof trackDescendants> = {
          found: [],
          tracked: [],
          failure: 'not run',
        };
        const result = await hostDies(
          'owned',
          join(system32, 'cmd.exe'),
          ['/d', '/c', process.execPath, 'leaf.js'],
          null,
          cwd,
          (owned) => {
            const leaf = fx().find(cwd, 'leaf');
            discovery = trackDescendants(owned, leaf === undefined ? [] : [leaf.pid]); // prettier-ignore
            return Promise.resolve();
          },
        );
        await delay(1000);
        const leaf = fx().find(cwd, 'leaf');
        const descendant = lifelineState(leaf);
        evidence.record('job: owned cmd.exe child, its descendant', {
          ownedGone: result.ownedGone,
          owned: result.owned.state(),
          descendant,
          discoveryFailure: discovery.failure,
          leafDiscovered: leaf !== undefined && discovery.found.includes(leaf.pid), // prettier-ignore
          others: described(discovery.tracked),
        });
        expect(result.ownedGone).toBe(true);
        expect(descendant.state).toBe('alive');
        expect(discovery.failure).toBeNull();
        // Discovery that misses the leaf would leave the others untracked too.
        expect(discovery.found).toContain(leaf?.pid);
      });

      // A Git alias holds the tree without stdin, which the host's death closes.
      // Git for Windows starts its alias shell outside the owned job.
      it('ends an owned git.exe but not the sh.exe its alias started', async () => {
        const repo = repository('');
        writeFileSync(join(repo, 'host.js'), hostScript());
        let discovery: ReturnType<typeof trackDescendants> = {
          found: [],
          tracked: [],
          failure: 'not run',
        };
        const result = await hostDies(
          'owned',
          gitPath,
          ['-c', 'alias.canopy-hold=!sleep 20', 'canopy-hold'],
          null,
          repo,
          async (owned) => {
            await delay(1500);
            discovery = trackDescendants(owned);
          },
        );
        await delay(1000);
        const descendants = described(discovery.tracked);
        evidence.record('job: owned git.exe tree', {
          gitPath,
          ownedGone: result.ownedGone,
          owned: result.owned.state(),
          discoveryFailure: discovery.failure,
          descendants,
        });
        expect(discovery.failure).toBeNull();
        expect(result.ownedGone).toBe(true);
        expect(descendants).toContainEqual(
          expect.objectContaining({ name: 'sh.exe', state: 'alive' }),
        );
      });

      it('control: an independent child outlives its host', async () => {
        const result = await hostDies(
          'independent',
          process.execPath,
          ['leaf.js'],
          'leaf',
        );
        const owned = result.owned.state();
        evidence.record('job: independent control', {
          ownedGone: result.ownedGone,
          owned,
        });
        expect(result.ownedGone).toBe(false);
        expect(owned.state).toBe('alive');
      });
    });

    describe('checkIgnoredPathsWith with Git for Windows', () => {
      const paths = (count: number): string[] =>
        Array.from(
          { length: count },
          (_, i) => `p${i}.${i % 2 ? 'log' : 'txt'}`,
        );

      it('unions sequential chunks with real Git', async () => {
        const repo = repository('*.log\n');
        const input = paths(10_001);
        const result = await runner().checkIgnoredPathsWith(
          selectedGit,
          repo,
          input,
          gitEnv(),
        );
        evidence.record('check-ignore: 10,001 paths', { ignored: result.size });
        expect(result).toEqual(
          new Set(input.filter((name) => name.endsWith('.log'))),
        );
      });

      it('treats exit 1 (nothing ignored) as empty', async () => {
        const repo = repository('*.log\n');
        const result = await runner().checkIgnoredPathsWith(
          selectedGit,
          repo,
          ['a.txt', 'b'],
          gitEnv(),
        );
        expect(result).toEqual(new Set());
      });

      it('returns NUL-separated Unicode paths unquoted under each locale', async () => {
        const repo = repository('*.log\n');
        const input = ['café x.log', '日本語.log', 'new\nline.log', 'keep.txt', ' spaced .log']; // prettier-ignore
        const expected = new Set(input.filter((name) => name.endsWith('.log')));
        const observed: Record<string, string[]> = {};
        for (const locale of ['C', 'en_US.UTF-8']) {
          const result = await runner().checkIgnoredPathsWith(
            selectedGit,
            repo,
            input,
            gitEnv({ LANG: locale, LC_ALL: locale }),
          );
          observed[locale] = Array.from(result).sort();
        }
        evidence.record('check-ignore: Unicode and NUL', {
          matched: Object.fromEntries(
            Object.entries(observed).map(([locale, found]) => [
              locale,
              found.length === expected.size &&
                found.every((name) => expected.has(name)),
            ]),
          ),
        });
        for (const found of Object.values(observed))
          expect(new Set(found)).toEqual(expected);
      });

      // Outside a repository, Git can exit before a small write lands and
      // race the stdin failure; it must read this path before rejecting it.
      it('rejects a small input Git has read with exit 128', async () => {
        const outcome = await settle(
          runner().checkIgnoredPathsWith(selectedGit, repository(''), ['../outside'], gitEnv()), // prettier-ignore
        );
        expect(outcome).toMatchObject({
          error: { code: 'exit_status', exitCode: 128 },
        });
      });

      // POSIX rejects with EPIPE first. libuv reports a write to a closed
      // pipe as EOF (ERROR_BROKEN_PIPE) or EPIPE (ERROR_NO_DATA); run
      // 38855722252 saw EOF.
      it('records the stdin failure (EOF on Windows) versus exit 128 for 4 MiB outside a repository', async () => {
        const long = paths(5000).map((name) => `${name}-${'x'.repeat(900)}`);
        const outcome = await settle(
          runner().checkIgnoredPathsWith(selectedGit, fixture('outside'), long, gitEnv()), // prettier-ignore
        );
        const error: unknown = Reflect.get(Object(outcome), 'error');
        const syscall: unknown = Reflect.get(Object(error), 'syscall');
        evidence.record('check-ignore: 4 MiB outside a repository', {
          code: errorCode(error),
          syscall,
          exitCode: errorExitCode(error),
        });
        expect(['EOF', 'EPIPE', 'exit_status']).toContain(errorCode(error));
      });

      // C1 discharge for the ignored listing (CAN-5037): ls-files reads the
      // working tree, so it may start the daemon check-ignore may start.
      it('lists ignored paths with the discharge, and the listing starts no fsmonitor daemon', async () => {
        expect(fsmonitorDischargeAudited(selectedGit.version)).toBe(true);
        const env = gitEnv();
        const repo = repository('*.log\nbuild/\n', [
          ['core.fsmonitor', 'true'],
          ['core.useBuiltinFSMonitor', 'true'],
        ]);
        writeFileSync(join(repo, 'a.log'), '');
        writeFileSync(join(repo, 'keep.txt'), '');
        mkdirSync(join(repo, 'build'));
        writeFileSync(join(repo, 'build', 'out.js'), '');
        const listed = await runner().listIgnoredPathsSelected({
          cwd: repo,
          environment: env,
          deadlineAt: performance.now() + 30_000,
          signal: new AbortController().signal,
          selectExecutable: () => Promise.resolve(selectedGit),
        });
        const status = (): string =>
          String(
            spawnSync(gitPath, ['-C', repo, 'fsmonitor--daemon', 'status'], {
              env,
              encoding: 'utf8',
            }).stdout,
          );
        const end = performance.now() + 3000;
        let watching = false;
        while (!watching && performance.now() < end) {
          watching = /is watching/.test(status());
          await delay(100);
        }
        evidence.record('ls-files ignored listing', { listed, watching });
        try {
          expect([...listed].sort()).toEqual(['a.log', 'build/']);
          expect(watching).toBe(false);
        } finally {
          if (watching)
            spawnSync(gitPath, ['-C', repo, 'fsmonitor--daemon', 'stop'], { env }); // prettier-ignore
        }
      });

      // C1 discharge: both enabling keys set; only raw Git starts the daemon.
      it('builtin fsmonitor daemon: the discharged runner never starts one; raw check-ignore outlives the request where Git supports it', async () => {
        // Production plans the discharge only for an audited Git for Windows.
        expect(fsmonitorDischargeAudited(selectedGit.version)).toBe(true);
        const env = gitEnv();
        const options = execFileSync(gitPath, ['version', '--build-options'], { env }); // prettier-ignore
        const supported = options.toString().includes('fsmonitor--daemon');
        const repo = repository('*.log\n', [
          ['core.fsmonitor', 'true'],
          ['core.useBuiltinFSMonitor', 'true'],
        ]);
        const since = filetimeAt(Date.now() - 1000);
        const daemonRows = (): { rows: string[] } | { failure: unknown } => {
          const table = fx().processTable();
          if ('failure' in table) return table;
          return {
            rows: table.rows
              .filter(
                (row) =>
                  row.commandLine.includes('fsmonitor--daemon') &&
                  createdSince(row, since),
              ) // prettier-ignore
              .map(({ name, pid }) => `${name} ${pid}`),
          };
        };
        const status = (): ReturnType<typeof spawnSync> =>
          spawnSync(gitPath, ['-C', repo, 'fsmonitor--daemon', 'status'], {
            env,
            encoding: 'utf8',
          });
        let stopped = false;
        /** Stops the daemon and waits for Git to report it stopped. */
        const stop = async (): Promise<unknown> => {
          const result = spawnSync(gitPath, ['-C', repo, 'fsmonitor--daemon', 'stop'], { env, encoding: 'utf8' }); // prettier-ignore
          const begun = performance.now();
          for (;;) {
            const now = status();
            stopped = now.status !== 0;
            if (stopped || performance.now() - begun > 5000)
              return {
                stopExit: result.status,
                stopStderr: String(result.stderr).slice(0, 400),
                stoppedWithinMs: stopped ? Math.round(performance.now() - begun) : null, // prettier-ignore
                lastStatus: String(now.stdout).trim().slice(0, 400),
              };
            await delay(100);
          }
        };
        /** Polls `status` for up to 5 s; true once a daemon is watching. */
        const watchingWithin = async (): Promise<boolean> => {
          const end = performance.now() + 5000;
          while (supported && performance.now() < end) {
            if (/is watching/.test(String(status().stdout))) return true;
            await delay(100);
          }
          return false;
        };
        try {
          const result = await runner().checkIgnoredPathsWith(
            selectedGit,
            repo,
            ['a.log', 'b'],
            env,
          );
          const dischargedWatching = await watchingWithin();
          const dischargedRows = daemonRows();
          // Control: the same request without the discharge.
          const raw = spawnSync(
            gitPath,
            ['-C', repo, 'check-ignore', '-z', '--stdin'],
            { env, input: 'a.log\0b\0', encoding: 'utf8' },
          );
          const watching = await watchingWithin();
          const last = status();
          // Tracked so cleanup confirms the daemon gone even if stop fails.
          let daemons: NativeProcess[] = [];
          let discoveryFailure: unknown = null;
          if (watching) {
            const table = fx().processTable();
            if ('failure' in table) discoveryFailure = table.failure;
            else
              daemons = fx().trackNatives(
                table.rows
                  .filter((row) => row.commandLine.includes('fsmonitor--daemon') && createdSince(row, since)) // prettier-ignore
                  .map(({ name, pid }) => ({ label: `${name} fsmonitor--daemon`, pid })), // prettier-ignore
              );
          }
          const stopping = watching ? await stop() : null;
          evidence.record('fsmonitor daemon', {
            supported,
            discharged: { watching: dischargedWatching, rows: dischargedRows },
            rawExit: raw.status,
            watchingAfterSettle: watching,
            statusExit: last.status,
            daemons: daemons.map(({ label, pid, start }) => ({ label, pid, tracked: start !== null })), // prettier-ignore
            discoveryFailure,
            stopping,
          });
          expect(result).toEqual(new Set(['a.log']));
          expect(dischargedWatching).toBe(false);
          expect(dischargedRows).toEqual({ rows: [] });
          expect(raw.stdout).toBe('a.log\0');
          if (supported) {
            expect(watching).toBe(true);
            expect(discoveryFailure).toBeNull();
            expect(daemons.length).toBeGreaterThan(0);
            expect(stopped).toBe(true);
          } else expect(last.status).not.toBe(0);
        } finally {
          if (!stopped) await stop();
        }
      });
    });
  },
);
