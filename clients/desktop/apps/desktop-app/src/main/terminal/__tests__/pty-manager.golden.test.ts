/**
 * Behavior golden for desktop terminals (CAN-5063), captured on the unchanged
 * `PtyManager` and terminal service before CAN-4147 extracts the engine
 * behind a `worker.terminal` port (the CAN-4070 rule).
 *
 * Each scenario in `golden/terminal-golden-scenarios.ts` drives the
 * operations today's callers use: renderer IPC and the Portal through the
 * terminal service, and the script runner, Claude terminals and worktree
 * cleanup through the engine. The transcript records, in order, every
 * operation with its result or error and everything that crosses the
 * engine's boundary: node-pty spawn/write/resize/kill/destroy and listener
 * disposal, `process.kill`, `taskkill`, resource-monitor registration,
 * persistence writes, emitted terminal events and warnings. Order is part of
 * the golden.
 *
 * No Electron runtime and no real PTY are involved. Platform-specific
 * scenarios set `process.platform` (and `process.arch` for Linux x64) on the
 * Jest host, so CI exercises the macOS, Windows and Linux branches on its
 * Linux runner. Shell paths under /bin, /usr, /opt, /sbin and drive letters
 * come from each scenario's virtual file table; the worktree checkout and
 * the `relativeCwd` directories are real temporary directories, recorded as
 * `<worktree>` and `<outside>`. Time is fake and terminal ids are sequential.
 * The engine runs with its production defaults (kill grace period, replay
 * budgets, running detector) except the terminal id generator and, in one
 * scenario, a live-terminal cap of 2.
 *
 * CAN-4147 swaps the engine and service wiring below for the extracted port
 * and must reproduce the fixture unchanged. Re-record only for an intended
 * behavior change, and say why in the PR:
 * `RECORD_TERMINAL_GOLDEN=1 pnpm test pty-manager.golden`.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type * as NodeFs from 'node:fs';
import type * as ChildProcessModule from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as ConfigPathsModule from '@canopy/desktop-shared/pipelines/config-paths';
import type * as PathLookupModule from '@canopy/execution-engine/node/lib/path-lookup';
import type * as MainConfigPathsModule from '../../pipelines/config-paths';
import type * as LoggingModule from '../../lib/main-process-logging';
import type * as ResolveWorktreeModule from '../../lib/resolve-worktree';
import type * as WorkerTerminalModule from '../worker-terminal';
import type * as GoldenHostModule from './golden/terminal-golden-host';

jest.mock('node-pty', () => {
  const { goldenHost } = jest.requireActual<typeof GoldenHostModule>(
    './golden/terminal-golden-host',
  );
  return {
    spawn: (
      ...args: Parameters<GoldenHostModule.GoldenHost['spawnPty']>
    ): ReturnType<GoldenHostModule.GoldenHost['spawnPty']> =>
      goldenHost.spawnPty(...args),
  };
});

jest.mock('node:fs', () => {
  const actual = jest.requireActual<typeof NodeFs>('node:fs');
  const { goldenHost } = jest.requireActual<typeof GoldenHostModule>(
    './golden/terminal-golden-host',
  );
  const errno = (code: string, file: unknown): Error =>
    Object.assign(new Error(`${code}: ${String(file)}`), { code });
  return {
    ...actual,
    existsSync: (file: unknown): boolean => {
      const kind = goldenHost.lookupVirtualFile(file);
      if (kind === undefined) {
        return Reflect.apply(actual.existsSync, actual, [file]) === true;
      }
      return kind !== null;
    },
    statSync: (file: unknown, ...rest: unknown[]): unknown => {
      const kind = goldenHost.lookupVirtualFile(file);
      if (kind === undefined) {
        return Reflect.apply(actual.statSync, actual, [file, ...rest]);
      }
      if (kind === null) throw errno('ENOENT', file);
      return {
        isFile: (): boolean => kind !== 'dir',
        isDirectory: (): boolean => kind === 'dir',
      };
    },
    accessSync: (file: unknown, ...rest: unknown[]): unknown => {
      const kind = goldenHost.lookupVirtualFile(file);
      if (kind === undefined) {
        return Reflect.apply(actual.accessSync, actual, [file, ...rest]);
      }
      if (kind === null) throw errno('ENOENT', file);
      if (kind !== 'exec') throw errno('EACCES', file);
      return undefined;
    },
  };
});

jest.mock('node:child_process', () => {
  const actual =
    jest.requireActual<typeof ChildProcessModule>('node:child_process');
  const { goldenHost } = jest.requireActual<typeof GoldenHostModule>(
    './golden/terminal-golden-host',
  );
  return {
    ...actual,
    spawn: (
      file: string,
      args: readonly string[],
      options: unknown,
    ): ReturnType<GoldenHostModule.GoldenHost['spawnChild']> =>
      goldenHost.spawnChild(file, args, options),
    execFile: (
      file: string,
      args: readonly string[],
      options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ): ReturnType<GoldenHostModule.GoldenHost['execFile']> =>
      goldenHost.execFile(file, args, options, callback),
  };
});

jest.mock('../../resource-monitor', () => {
  const { goldenHost } = jest.requireActual<typeof GoldenHostModule>(
    './golden/terminal-golden-host',
  );
  return {
    getResourceMonitorService: (): {
      registerProcess: GoldenHostModule.GoldenHost['registerResource'];
    } => ({
      registerProcess: (input) => goldenHost.registerResource(input),
    }),
  };
});

jest.mock('../persistence', () => {
  const { goldenHost } = jest.requireActual<typeof GoldenHostModule>(
    './golden/terminal-golden-host',
  );
  return { terminalPersistenceStore: goldenHost.persistence };
});

jest.mock('../../lib/resolve-worktree', () => {
  const actual = jest.requireActual<typeof ResolveWorktreeModule>(
    '../../lib/resolve-worktree',
  );
  const { goldenHost } = jest.requireActual<typeof GoldenHostModule>(
    './golden/terminal-golden-host',
  );
  return {
    ...actual,
    resolveWorktreeCwd: (
      projectId: string,
      worktreeId: string,
      selectedRepoId?: string,
    ): string =>
      goldenHost.resolveWorktreeCwd(projectId, worktreeId, selectedRepoId),
  };
});

// The environment builders answer with their scenario table plus the request
// they received, so the golden pins how the engine asks for its environment.
jest.mock('../../lib/worktree-data-env', () => {
  const { goldenHost } = jest.requireActual<typeof GoldenHostModule>(
    './golden/terminal-golden-host',
  );
  return {
    buildWorktreeDataEnv: (
      projectId: string,
      worktreeId: string,
      env?: NodeJS.ProcessEnv,
      options?: unknown,
    ): NodeJS.ProcessEnv => ({
      ...goldenHost.worktreeEnv,
      GOLDEN_WORKTREE_ENV_REQUEST: JSON.stringify({
        projectId,
        worktreeId,
        env: env ?? null,
        options: options ?? null,
      }),
    }),
  };
});

jest.mock('@canopy/desktop-shared/pipelines/config-paths', () => {
  const actual = jest.requireActual<typeof ConfigPathsModule>(
    '@canopy/desktop-shared/pipelines/config-paths',
  );
  const { goldenHost } = jest.requireActual<typeof GoldenHostModule>(
    './golden/terminal-golden-host',
  );
  return {
    ...actual,
    getEnhancedEnv: (options?: unknown): Record<string, string> => ({
      ...goldenHost.enhancedEnv,
      GOLDEN_ENHANCED_ENV_REQUEST: JSON.stringify(options ?? null),
    }),
    resolveLinuxAccountShell: (): Promise<string | undefined> => {
      goldenHost.record({ at: 'linux.accountShellLookup' });
      return Promise.resolve(goldenHost.linuxAccountShell);
    },
  };
});

jest.mock('@canopy/execution-engine/node/lib/path-lookup', () => {
  const actual = jest.requireActual<typeof PathLookupModule>(
    '@canopy/execution-engine/node/lib/path-lookup',
  );
  const { goldenHost } = jest.requireActual<typeof GoldenHostModule>(
    './golden/terminal-golden-host',
  );
  return {
    ...actual,
    findExecutableOnPath: (name: string): string | null =>
      goldenHost.executablesOnPath[name] ?? null,
  };
});

jest.mock('../../lib/windows-git-bash', () => {
  const { goldenHost } = jest.requireActual<typeof GoldenHostModule>(
    './golden/terminal-golden-host',
  );
  return {
    resolveWindowsGitBash: (): string | null => goldenHost.windowsGitBash,
  };
});

jest.mock('../../pipelines/config-paths', () => {
  const actual = jest.requireActual<typeof MainConfigPathsModule>(
    '../../pipelines/config-paths',
  );
  const { goldenHost } = jest.requireActual<typeof GoldenHostModule>(
    './golden/terminal-golden-host',
  );
  return {
    ...actual,
    getBundledClaudeBinaryPath: (): string => goldenHost.bundledClaudePath,
  };
});

jest.mock('../../lib/main-process-logging', () => {
  const actual = jest.requireActual<typeof LoggingModule>(
    '../../lib/main-process-logging',
  );
  const { goldenHost } = jest.requireActual<typeof GoldenHostModule>(
    './golden/terminal-golden-host',
  );
  return {
    ...actual,
    logMainProcessWarn: (message: string, details?: unknown): void => {
      goldenHost.record({ at: 'log.warn', message, details });
    },
  };
});

// The terminal service reaches the engine through the module's `workerTerminal`
// singleton; each scenario gets a fresh engine behind it. The proxy reads
// exports on use: an import cycle can reach this factory while the module is
// still initializing, and SWC's export bindings throw until it finishes.
jest.mock('../worker-terminal', () => {
  const actual =
    jest.requireActual<typeof WorkerTerminalModule>('../worker-terminal');
  const { goldenHost } = jest.requireActual<typeof GoldenHostModule>(
    './golden/terminal-golden-host',
  );
  return new Proxy(actual, {
    get: (target, key): unknown =>
      key === 'workerTerminal' ? goldenHost.engine : Reflect.get(target, key),
  });
});

import {
  createDesktopTerminalEngine,
  desktopTerminalShells,
  TERMINAL_EVENT_CHANNELS,
} from '../worker-terminal';
import * as terminalService from '../../services/terminal-service';
import {
  goldenHost,
  type GoldenEntry,
  type GoldenValue,
} from './golden/terminal-golden-host';
import {
  PACKAGE_DIR,
  TERMINAL_GOLDEN_SCENARIOS,
  type GoldenContext,
  type GoldenScenario,
} from './golden/terminal-golden-scenarios';

const FIXTURE = join(__dirname, 'fixtures', 'pty-manager-golden.json');
const RECORD = process.env.RECORD_TERMINAL_GOLDEN === '1';
const FAKE_EPOCH_MS = 1_800_000_000_000;

interface ScenarioCapture {
  platform: string;
  arch: string | null;
  transcript: GoldenEntry[];
}

type Fixture = Record<string, ScenarioCapture>;

function readFixture(): Fixture {
  if (RECORD) return {};
  const parsed: unknown = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${FIXTURE} is not a scenario map`);
  }
  return Object.fromEntries(Object.entries(parsed));
}

function stableJson(value: GoldenValue | Fixture): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function overrideProcessProperty(
  property: 'platform' | 'arch',
  value: string,
): () => void {
  const original = Object.getOwnPropertyDescriptor(process, property);
  Object.defineProperty(process, property, { configurable: true, value });
  return (): void => {
    if (original) Object.defineProperty(process, property, original);
  };
}

let workDir = '';
let root = '';
let outside = '';
const recorded: Fixture = {};
const fixture = readFixture();

beforeAll(() => {
  if (RECORD && process.env.CI) {
    throw new Error('The terminal golden is frozen in CI; record it locally.');
  }
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'pty-golden-')));
  root = join(workDir, 'worktree');
  outside = join(workDir, 'outside');
  mkdirSync(join(root, PACKAGE_DIR), { recursive: true });
  mkdirSync(join(root, 'services', 'api', 'src'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, 'README.md'), 'golden\n');
  symlinkSync(outside, join(root, 'escape'));
});

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  const complete = TERMINAL_GOLDEN_SCENARIOS.every(
    (scenario) => scenario.name in recorded,
  );
  if (RECORD && complete) {
    mkdirSync(join(__dirname, 'fixtures'), { recursive: true });
    writeFileSync(FIXTURE, stableJson(recorded));
  }
});

async function settle(): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function runScenario(scenario: GoldenScenario): Promise<ScenarioCapture> {
  const restorers: Array<() => void> = [];
  const savedEnv = new Map<string, string | undefined>();
  const setEnv = (name: string, value: string | undefined): void => {
    if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  try {
    goldenHost.reset();
    goldenHost.tokenizePath(root, '<worktree>');
    goldenHost.tokenizePath(outside, '<outside>');
    goldenHost.tokenizePath(workDir, '<work>');
    goldenHost.worktreeRoot = root;
    goldenHost.enhancedEnv = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/home/golden',
      SHARED_KEY: 'from-enhanced-env',
      TERM: 'dumb',
      SHELL: '/bin/sh',
      NODE_OPTIONS: '--inspect',
      ELECTRON_RUN_AS_NODE: '1',
      LD_PRELOAD: '/opt/preload.so',
      DYLD_INSERT_LIBRARIES: '/opt/insert.dylib',
    };
    goldenHost.worktreeEnv = {
      CANOPY_WORKSPACE_ID: 'golden-project',
      SHARED_KEY: 'from-worktree-env',
    };
    scenario.setup?.(goldenHost, { root, outside });
    restorers.push(overrideProcessProperty('platform', scenario.platform));
    if (scenario.arch) {
      restorers.push(overrideProcessProperty('arch', scenario.arch));
    }
    for (const [name, value] of Object.entries(scenario.env ?? {})) {
      setEnv(name, value);
    }
    desktopTerminalShells.resetForTests();
    jest.useFakeTimers({
      now: FAKE_EPOCH_MS,
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });
    const killSpy = jest
      .spyOn(process, 'kill')
      .mockImplementation((pid: number, signal?: string | number) =>
        goldenHost.killProcess(pid, signal),
      );
    restorers.push(() => killSpy.mockRestore());

    let nextTerminal = 1;
    let nextAttachment = 1;
    const engine = createDesktopTerminalEngine({
      options: {
        createTerminalId: (): string => `terminal-${nextTerminal++}`,
        createAttachmentId: (): string => `attachment-${nextAttachment++}`,
        ...(scenario.maxLiveTerminals === undefined
          ? {}
          : { maxLiveTerminals: scenario.maxLiveTerminals }),
      },
    });
    goldenHost.engine = engine;
    engine.addEventListener((event) => {
      goldenHost.record({
        at: 'event',
        channel: TERMINAL_EVENT_CHANNELS[event.type],
        payload: event.payload,
      });
    });

    const context: GoldenContext = {
      host: goldenHost,
      engine,
      service: terminalService,
      root,
      outside,
      call: (name, input, run) => {
        goldenHost.record({ at: 'call', name, input });
        try {
          const value = run();
          goldenHost.record({ at: 'return', name, value });
          return value;
        } catch (error) {
          goldenHost.record({ at: 'throw', name, error });
          return undefined;
        }
      },
      callAsync: async (name, input, run) => {
        goldenHost.record({ at: 'call', name, input });
        try {
          const value = await run();
          goldenHost.record({ at: 'return', name, value });
          return value;
        } catch (error) {
          goldenHost.record({ at: 'throw', name, error });
          return undefined;
        }
      },
      step: (label) => {
        goldenHost.record({ at: 'step', label });
      },
      settle,
      advance: async (ms) => {
        jest.advanceTimersByTime(ms);
        await settle();
      },
      setEnv,
    };
    try {
      await scenario.run(context);
    } catch (error) {
      // A scenario stops early when an expected terminal never appeared; the
      // recorded errors say why.
      const errors = goldenHost.entries.filter((entry) => entry.at === 'throw');
      throw new Error(
        `${String(error)}\nRecorded errors: ${JSON.stringify(errors.slice(-6), null, 2)}`,
      );
    }
    await settle();
    return {
      platform: scenario.platform,
      arch: scenario.arch ?? null,
      transcript: goldenHost.entries,
    };
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
    goldenHost.engine = null;
    for (const restore of restorers.reverse()) restore();
    savedEnv.forEach((value, name) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  }
}

describe('terminal behavior golden (CAN-5063)', () => {
  it('has exactly one recorded transcript per scenario', () => {
    const names = TERMINAL_GOLDEN_SCENARIOS.map((scenario) => scenario.name);
    expect(new Set(names).size).toBe(names.length);
    if (!RECORD) expect(Object.keys(fixture).sort()).toEqual([...names].sort());
  });

  for (const scenario of TERMINAL_GOLDEN_SCENARIOS) {
    it(scenario.name, async () => {
      const capture = await runScenario(scenario);
      if (RECORD) {
        recorded[scenario.name] = capture;
        return;
      }
      expect(capture).toEqual(fixture[scenario.name]);
    });
  }
});
