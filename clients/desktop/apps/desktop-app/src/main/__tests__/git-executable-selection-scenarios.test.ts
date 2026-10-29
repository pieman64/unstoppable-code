import type * as ChildProcessModule from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import type * as FsPromisesModule from 'node:fs/promises';
import type * as PathModule from 'node:path';
import { resolve } from 'node:path';
import { z } from 'zod';
import type * as GitExecutableModule from '../lib/git-executable';

// Replays the shared selection goldens through the same module-wide mocks as
// git-executable.test.ts. Every lookup and process goes to the scenario's
// virtual filesystem and process table.

type JoinFlavor = 'posix' | 'win32';

const fileEntrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('missing') }).strict(),
  z.object({ kind: z.literal('eacces') }).strict(),
  z.object({ kind: z.literal('directory') }).strict(),
  z
    .object({
      kind: z.literal('executable'),
      stdout: z.string(),
      transient: z.literal('timeout').optional(),
    })
    .strict(),
  z.object({ kind: z.literal('noexec') }).strict(),
  z.object({ kind: z.literal('shim') }).strict(),
  z.object({ kind: z.literal('symlink'), target: z.string() }).strict(),
]);

const expectationSchema = z
  .object({
    attempts: z.array(z.string()),
    status: z
      .object({
        ready: z.boolean(),
        path: z.string().nullable().optional(),
        version: z.string().nullable().optional(),
        source: z.string().optional(),
        wingetAvailable: z.boolean().optional(),
        error: z.string().nullable().optional(),
      })
      .strict(),
    savedAfter: z.string().optional(),
  })
  .strict();

const stepSchema = z
  .object({
    name: z.string(),
    filesystem: z.record(z.string(), fileEntrySchema).optional(),
    select: z.string().optional(),
    elapsedMs: z.number().optional(),
    expected: z
      .object({
        resolved: z.string().nullable(),
        savedAfter: z.string().optional(),
      })
      .strict(),
  })
  .strict();

const scenarioFields = {
  name: z.string(),
  os: z.enum(['darwin', 'linux', 'win32']),
  arch: z.string().optional(),
  environment: z.record(z.string(), z.string()),
  saved: z.string().nullable(),
  loginPath: z.string(),
  developerDir: z.string().nullable(),
  whereExe: z.record(z.string(), z.string()).optional(),
  filesystem: z.record(z.string(), fileEntrySchema),
  steps: z.array(stepSchema).optional(),
};

const scenarioSchema = z.union([
  z.object({ ...scenarioFields, expected: expectationSchema }).strict(),
  z
    .object({
      ...scenarioFields,
      expectedByJoin: z
        .object({ posix: expectationSchema, win32: expectationSchema })
        .strict(),
    })
    .strict(),
]);

type FileEntry = z.infer<typeof fileEntrySchema>;
type Scenario = z.infer<typeof scenarioSchema>;
type Expectation = z.infer<typeof expectationSchema>;

const SCENARIOS_PATH = resolve(
  __dirname,
  '../../../../../packages/protocol/src/git-executable/__tests__/selection-scenarios.json',
);
const scenarios = z
  .object({ scenarios: z.array(scenarioSchema) })
  .parse(JSON.parse(readFileSync(SCENARIOS_PATH, 'utf8'))).scenarios;

interface HostRun {
  scenario: Scenario;
  filesystem: Record<string, FileEntry>;
  attempts: string[];
  executed: string[];
  events: string[];
}

type ExecCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

let mockRun: HostRun | null = null;
let mockJoinFlavor: JoinFlavor = 'posix';
let mockPreferences = { gitExecutablePath: '' };

function mockCurrentRun(): HostRun {
  if (!mockRun) throw new Error('No selection scenario is running');
  return mockRun;
}

function mockErrno(code: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

/** Follow symlinks to the final path and its entry; unlisted paths are missing. */
function mockResolveEntry(path: string): { path: string; entry: FileEntry } {
  const { filesystem } = mockCurrentRun();
  let current = path;
  for (let hop = 0; hop < 8; hop += 1) {
    const entry = filesystem[current] ?? { kind: 'missing' };
    if (entry.kind !== 'symlink') return { path: current, entry };
    current = entry.target;
  }
  throw new Error(`Symlink loop at ${path}`);
}

function mockLookup(path: string): { path: string; entry: FileEntry } {
  const resolved = mockResolveEntry(path);
  if (resolved.entry.kind === 'missing') throw mockErrno('ENOENT', path);
  if (resolved.entry.kind === 'eacces') throw mockErrno('EACCES', path);
  return resolved;
}

const mockActualFs =
  jest.requireActual<typeof FsPromisesModule>('node:fs/promises');

async function mockStat(path: unknown): Promise<Stats> {
  const run = mockCurrentRun();
  if (run.scenario.os !== 'darwin') run.attempts.push(String(path));
  const { entry } = mockLookup(String(path));
  return mockActualFs.stat(entry.kind === 'directory' ? __dirname : __filename);
}

async function mockRealpath(path: unknown): Promise<string> {
  const run = mockCurrentRun();
  if (run.scenario.os === 'darwin') run.attempts.push(String(path));
  return Promise.resolve(mockLookup(String(path)).path);
}

async function mockAccess(path: unknown): Promise<void> {
  const { entry } = mockLookup(String(path));
  if (entry.kind !== 'executable' && entry.kind !== 'shim') {
    throw mockErrno('EACCES', String(path));
  }
  return Promise.resolve();
}

function mockProcessOutput(command: string, args: string[]): string {
  const run = mockCurrentRun();
  if (command === 'where.exe') {
    const stdout = run.scenario.whereExe?.[args[0] ?? ''];
    if (stdout === undefined) throw new Error('INFO: Could not find files');
    return stdout;
  }
  if (command === '/usr/bin/xcode-select') {
    run.events.push('xcode-select');
    if (run.scenario.developerDir === null) {
      throw new Error('No active developer directory');
    }
    return run.scenario.developerDir;
  }
  run.executed.push(command);
  const { entry } = mockLookup(command);
  if (entry.kind === 'shim') throw new Error(`Ran a shim: ${command}`);
  if (entry.kind !== 'executable') throw mockErrno('EACCES', command);
  // execFile's timeout error: the child was killed.
  if (entry.transient === 'timeout')
    throw Object.assign(new Error(`Timed out: ${command}`), { killed: true });
  return args[0] === '--version' ? entry.stdout : '';
}

function isExecCallback(entry: unknown): entry is ExecCallback {
  return typeof entry === 'function';
}

function mockExecFile(...call: unknown[]): void {
  const [command, args] = call;
  const callback = call.find(isExecCallback);
  if (!callback) throw new Error('execFile was called without a callback');
  try {
    const stdout = mockProcessOutput(
      String(command),
      Array.isArray(args) ? args.map(String) : [],
    );
    callback(null, stdout, '');
  } catch (error) {
    callback(error instanceof Error ? error : new Error(String(error)), '', '');
  }
}

jest.mock('@canopy/desktop-shared/pipelines/config-paths', () => ({
  getLinuxProbeEnv: (): Record<string, string> => ({ PATH: '/probe/bin' }),
  getLoginShellPath: (): string => {
    const run = mockCurrentRun();
    run.events.push('read-login-path');
    return run.scenario.loginPath;
  },
  prewarmLoginShellPath: (): Promise<void> => Promise.resolve(),
}));

jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof ChildProcessModule>('node:child_process'),
  execFile: mockExecFile,
}));

jest.mock('node:fs/promises', () => ({
  access: mockAccess,
  stat: mockStat,
  realpath: mockRealpath,
  readdir: (): Promise<string[]> => Promise.resolve([]),
  mkdtemp: (): Promise<string> => Promise.resolve('/tmp/git-selection-probe'),
  rm: (): Promise<void> => Promise.resolve(),
}));

// The desktop joins Windows candidates with the host's `join`; switching it
// replays the win32 flavor on a POSIX test host.
jest.mock('node:path', () => {
  const actual = jest.requireActual<typeof PathModule>('node:path');
  return {
    ...actual,
    join: (...parts: string[]): string => actual[mockJoinFlavor].join(...parts),
  };
});

jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<{ gitExecutablePath: string }> =>
    Promise.resolve(mockPreferences),
  writePreferencesFile: (patch: {
    gitExecutablePath?: string;
  }): Promise<void> => {
    if (typeof patch.gitExecutablePath === 'string') {
      mockPreferences = { gitExecutablePath: patch.gitExecutablePath };
    }
    return Promise.resolve();
  },
}));

const originalPlatform = process.platform;
const originalArch = process.arch;
const originalEnv = { ...process.env };
const HOST_ENVIRONMENT_KEYS = [
  'CANOPY_GIT_EXECUTABLE',
  'CANOPY_E2E_PLATFORM',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'LOCALAPPDATA',
];

function setProcessValue(key: 'platform' | 'arch', value: string): void {
  Object.defineProperty(process, key, { value, configurable: true });
}

afterEach(() => {
  mockRun = null;
  mockJoinFlavor = 'posix';
  setProcessValue('platform', originalPlatform);
  setProcessValue('arch', originalArch);
  process.env = { ...originalEnv };
});

type ScenarioCase = [string, Scenario, JoinFlavor, Expectation];

function expectationFor(scenario: Scenario, flavor: JoinFlavor): Expectation {
  return 'expectedByJoin' in scenario
    ? scenario.expectedByJoin[flavor]
    : scenario.expected;
}

function cases(): ScenarioCase[] {
  return scenarios.flatMap((scenario): ScenarioCase[] => {
    // Only Windows candidates are joined with the host flavor.
    if (scenario.os !== 'win32') {
      return [
        [scenario.name, scenario, 'posix', expectationFor(scenario, 'posix')],
      ];
    }
    return (['posix', 'win32'] as const).map(
      (flavor): ScenarioCase => [
        `${scenario.name} (${flavor} join)`,
        scenario,
        flavor,
        expectationFor(scenario, flavor),
      ],
    );
  });
}

async function loadSelection(): Promise<typeof GitExecutableModule> {
  const loaded: { module?: typeof GitExecutableModule } = {};
  // A fresh module per scenario: detection caches live in module state.
  await jest.isolateModulesAsync(async () => {
    loaded.module = await import('../lib/git-executable');
  });
  if (!loaded.module) throw new Error('git-executable did not load');
  return loaded.module;
}

function expectStatus(
  actual: Awaited<ReturnType<typeof GitExecutableModule.detectGitExecutable>>,
  expected: Expectation['status'],
): void {
  const { error, ...fields } = expected;
  expect(actual).toMatchObject(fields);
  if (error === null) expect(actual.error).toBeUndefined();
  else if (error !== undefined) expect(actual.error).toBe(error);
}

describe('shared Git executable selection scenarios', () => {
  it('loads a non-empty table', () => {
    expect(scenarios.length).toBeGreaterThan(0);
  });

  it.each(cases())('%s', async (_name, scenario, flavor, expected) => {
    const environment = { ...originalEnv };
    for (const key of HOST_ENVIRONMENT_KEYS) delete environment[key];
    process.env = { ...environment, ...scenario.environment };
    setProcessValue('platform', scenario.os);
    setProcessValue('arch', scenario.arch ?? 'x64');
    mockJoinFlavor = flavor;
    mockPreferences = { gitExecutablePath: scenario.saved ?? '' };
    const run: HostRun = {
      scenario,
      filesystem: { ...scenario.filesystem },
      attempts: [],
      executed: [],
      events: [],
    };
    mockRun = run;

    const selection = await loadSelection();
    const status = await selection.detectGitExecutable({ force: true });

    expect(run.attempts).toEqual(expected.attempts);
    expectStatus(status, expected.status);
    if (expected.savedAfter !== undefined) {
      expect(mockPreferences.gitExecutablePath).toBe(expected.savedAfter);
    }
    const ranShims = run.executed.filter(
      (command) => mockResolveEntry(command).entry.kind === 'shim',
    );
    expect(ranShims).toEqual([]);
    if (run.events.includes('xcode-select')) {
      expect(run.events).toEqual(['read-login-path', 'xcode-select']);
    }

    // Later spawns keep the module's state, as a long-running desktop does.
    for (const step of scenario.steps ?? []) {
      Object.assign(run.filesystem, step.filesystem);
      if (step.select !== undefined) {
        const validated = await selection.validateGitExecutable(step.select);
        await selection.setCachedGitExecutablePath(validated.path);
      }
      const resolved = await selection.getResolvedGitExecutableForSpawn().then(
        (path) => path,
        () => null,
      );
      expect([step.name, resolved]).toEqual([
        step.name,
        step.expected.resolved,
      ]);
      if (step.expected.savedAfter !== undefined) {
        expect([step.name, mockPreferences.gitExecutablePath]).toEqual([
          step.name,
          step.expected.savedAfter,
        ]);
      }
    }
    expect(
      run.executed.filter(
        (command) => mockResolveEntry(command).entry.kind === 'shim',
      ),
    ).toEqual([]);
  });
});
