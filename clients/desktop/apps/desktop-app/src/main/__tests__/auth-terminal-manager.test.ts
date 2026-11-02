import type * as childProcess from 'node:child_process';
import type * as events from 'node:events';
import type { IPty, IPtyForkOptions, IWindowsPtyForkOptions } from 'node-pty';
import {
  IPC_CHANNELS,
  type AuthTerminalExitEvent,
  type AuthTerminalOutputEvent,
} from '@canopy/desktop-shared/types';
import type { GetEnhancedEnvOptions } from '@canopy/desktop-shared/pipelines/config-paths';
import { AuthTerminalManager } from '../auth-terminal/manager';

jest.mock('node:child_process', () => {
  const actual: typeof childProcess = jest.requireActual('node:child_process');
  const { EventEmitter }: typeof events = jest.requireActual('node:events');
  return {
    ...actual,
    // Fake PTY PIDs can belong to real processes; never start a real taskkill.
    spawn: jest.fn(() => new EventEmitter()),
  };
});

beforeEach(() => {
  // Fake PTY PIDs can belong to real processes on a shared test runner.
  jest.spyOn(process, 'kill').mockImplementation(() => {
    throw new Error('missing fake process');
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

type PtySpawn = (
  file: string,
  args: string[] | string,
  options: IPtyForkOptions | IWindowsPtyForkOptions,
) => IPty;

interface SpawnCall {
  file: string;
  args: string[] | string;
  options: IPtyForkOptions | IWindowsPtyForkOptions;
}

interface EventRecord {
  channel: string;
  payload: AuthTerminalOutputEvent | AuthTerminalExitEvent;
}

class MockPty implements IPty {
  public readonly pid: number;
  public readonly cols = 80;
  public readonly rows = 24;
  public process = 'claude';
  public handleFlowControl = false;
  public readonly writes: string[] = [];
  public readonly resizes: Array<{ cols: number; rows: number }> = [];
  public readonly killSignals: Array<string | undefined> = [];
  public exited = false;
  public dataDisposeCount = 0;
  public exitDisposeCount = 0;
  public destroyCount = 0;

  private dataListener: ((data: string) => void) | null = null;
  private exitListener:
    | ((event: { exitCode: number; signal?: number }) => void)
    | null = null;

  public constructor(pid: number) {
    this.pid = pid;
  }

  public readonly onData = (
    listener: (data: string) => void,
  ): { dispose(): void } => {
    this.dataListener = listener;
    return {
      dispose: (): void => {
        this.dataDisposeCount += 1;
        this.dataListener = null;
      },
    };
  };

  public readonly onExit = (
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): { dispose(): void } => {
    this.exitListener = listener;
    return {
      dispose: (): void => {
        this.exitDisposeCount += 1;
        this.exitListener = null;
      },
    };
  };

  public resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  public clear(): void {}

  public write(data: string | Buffer): void {
    this.writes.push(typeof data === 'string' ? data : data.toString('utf8'));
  }

  public kill(signal?: string): void {
    this.killSignals.push(signal);
    // Default mock behavior: process exits in response to any kill signal.
    if (!this.exited) {
      this.exited = true;
      this.exitListener?.({ exitCode: 0, signal: undefined });
    }
  }

  public destroy(): void {
    this.destroyCount += 1;
  }

  public pause(): void {}

  public resume(): void {}

  public emitData(data: string): void {
    this.dataListener?.(data);
  }

  public emitExit(exitCode: number, signal?: number): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.exitListener?.({ exitCode, signal });
  }
}

interface EnhancedEnvCall {
  includeCanopySecrets: boolean;
  environment: GetEnhancedEnvOptions['environment'];
}

interface Harness {
  manager: AuthTerminalManager;
  spawnCalls: SpawnCall[];
  events: EventRecord[];
  ptys: MockPty[];
  enhancedEnvCalls: EnhancedEnvCall[];
  /** Override default kill behavior so kill() does NOT immediately exit. */
  setKillSilently(value: boolean): void;
}

function createHarness(options: { sigtermGraceMs?: number } = {}): Harness {
  const spawnCalls: SpawnCall[] = [];
  const events: EventRecord[] = [];
  const ptys: MockPty[] = [];
  const enhancedEnvCalls: EnhancedEnvCall[] = [];
  let killSilently = false;
  let nextPid = 4242;
  let sessionCounter = 0;

  const ptySpawn: PtySpawn = (file, args, opts) => {
    spawnCalls.push({ file, args, options: opts });
    const pty = new MockPty(nextPid++);
    if (killSilently) {
      // Replace kill to NOT auto-exit so we can test SIGTERM->SIGKILL escalation.
      pty.kill = (signal?: string): void => {
        pty.killSignals.push(signal);
      };
    }
    ptys.push(pty);
    return pty;
  };

  // Mimic getEnhancedEnv: when secrets are included we emit a Canopy-managed
  // GH_TOKEN, otherwise we don't. process.env.GH_TOKEN (external) is left
  // untouched in both cases — this harness doesn't simulate externals.
  const getEnhancedEnvFn = (
    enhancedOptions: GetEnhancedEnvOptions = {},
  ): NodeJS.ProcessEnv => {
    const includeCanopySecrets = enhancedOptions.includeCanopySecrets !== false;
    enhancedEnvCalls.push({
      includeCanopySecrets,
      environment: enhancedOptions.environment,
    });
    const base: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: '/home/test',
    };
    if (includeCanopySecrets) {
      base.GH_TOKEN = 'canopy-pat-secret';
    }
    return base;
  };

  const manager = new AuthTerminalManager({
    ptySpawn,
    createSessionId: (): string => `session-${++sessionCounter}`,
    getEnhancedEnvFn,
    getClaudeBinaryPath: (): string => '/bundled/claude',
    getCodexBinaryPath: (): string => '/bundled/codex',
    getGhBinaryPath: (): string => '/bundled/gh',
    homedirFn: (): string => '/home/test',
    sigtermGraceMs: options.sigtermGraceMs ?? 50,
  });

  manager.setEventSender((channel, payload): void => {
    events.push({ channel, payload });
  });

  return {
    manager,
    spawnCalls,
    events,
    ptys,
    enhancedEnvCalls,
    setKillSilently: (value: boolean): void => {
      killSilently = value;
    },
  };
}

describe('AuthTerminalManager', () => {
  it('spawns the bundled Claude binary with `auth login`', () => {
    const harness = createHarness();
    const sessionId = harness.manager.start('claude', 100, 30);
    expect(sessionId).toBe('session-1');
    expect(harness.spawnCalls).toHaveLength(1);
    const call = harness.spawnCalls[0];
    expect(call.file).toBe('/bundled/claude');
    expect(call.args).toEqual(['auth', 'login']);
    expect(call.options.cols).toBe(100);
    expect(call.options.rows).toBe(30);
    expect(call.options.cwd).toBe('/home/test');
    const env = call.options.env;
    expect(env?.TERM).toBe('xterm-256color');
    expect(env?.PATH).toBe('/usr/bin');
    expect(env?.BROWSER).toBe('echo');
  });

  it('spawns the bundled Codex binary with `login`', () => {
    const harness = createHarness();
    harness.manager.start('codex', 80, 24);
    expect(harness.spawnCalls[0].file).toBe('/bundled/codex');
    expect(harness.spawnCalls[0].args).toEqual(['login']);
    expect(harness.spawnCalls[0].options.env?.BROWSER).toBe('echo');
  });

  it('spawns the bundled gh binary with `auth login`', () => {
    const harness = createHarness();
    harness.manager.start('github', 80, 24);
    expect(harness.spawnCalls[0].file).toBe('/bundled/gh');
    expect(harness.spawnCalls[0].args).toEqual(['auth', 'login']);
    expect(harness.spawnCalls[0].options.env?.BROWSER).toBeUndefined();
  });

  it('omits user-configured environments for auth flows and the Canopy-managed GH_TOKEN for github', () => {
    const harness = createHarness();
    harness.manager.start('claude', 80, 24);
    harness.manager.start('codex', 80, 24);
    harness.manager.start('github', 80, 24);
    expect(harness.enhancedEnvCalls).toEqual([
      { includeCanopySecrets: true, environment: false },
      { includeCanopySecrets: true, environment: false },
      { includeCanopySecrets: false, environment: false },
    ]);
    expect(harness.spawnCalls[0].options.env?.GH_TOKEN).toBe(
      'canopy-pat-secret',
    );
    expect(harness.spawnCalls[1].options.env?.GH_TOKEN).toBe(
      'canopy-pat-secret',
    );
    expect(harness.spawnCalls[2].options.env?.GH_TOKEN).toBeUndefined();
  });

  it('rejects non-positive integer cols/rows', () => {
    const harness = createHarness();
    expect(() => harness.manager.start('claude', 0, 24)).toThrow(
      /Invalid cols/,
    );
    expect(() => harness.manager.start('claude', 80, -1)).toThrow(
      /Invalid rows/,
    );
    expect(() => harness.manager.start('claude', 1.5, 24)).toThrow(
      /Invalid cols/,
    );
  });

  it('broadcasts output events tagged with the session id', () => {
    const harness = createHarness();
    const sessionId = harness.manager.start('claude', 80, 24);
    harness.ptys[0].emitData('hello\r\n');
    const outputEvents = harness.events.filter(
      (e) => e.channel === IPC_CHANNELS.authTerminalOutput,
    );
    expect(outputEvents).toHaveLength(1);
    const payload = outputEvents[0].payload;
    expect(payload).toEqual({ sessionId, data: 'hello\r\n' });
  });

  it('routes write/resize to the PTY only for the active session', () => {
    const harness = createHarness();
    const sessionId = harness.manager.start('claude', 80, 24);
    harness.manager.write(sessionId, 'y\r');
    harness.manager.resize(sessionId, 120, 40);
    expect(harness.ptys[0].writes).toEqual(['y\r']);
    expect(harness.ptys[0].resizes).toEqual([{ cols: 120, rows: 40 }]);

    // Wrong session id is a no-op.
    harness.manager.write('not-the-session', 'x');
    harness.manager.resize('not-the-session', 50, 50);
    expect(harness.ptys[0].writes).toEqual(['y\r']);
    expect(harness.ptys[0].resizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it('emits an exit event when the PTY exits on its own', () => {
    const harness = createHarness();
    const sessionId = harness.manager.start('claude', 80, 24);
    harness.ptys[0].emitExit(7, 15);
    const exitEvents = harness.events.filter(
      (e) => e.channel === IPC_CHANNELS.authTerminalExit,
    );
    expect(exitEvents).toHaveLength(1);
    expect(exitEvents[0].payload).toEqual({
      sessionId,
      provider: 'claude',
      exitCode: 7,
      signal: '15',
    });
    expect(harness.manager.getActiveSessionId()).toBeNull();
    expect(harness.ptys[0].dataDisposeCount).toBe(1);
    expect(harness.ptys[0].exitDisposeCount).toBe(1);
    expect(harness.ptys[0].destroyCount).toBe(1);
  });

  it('includes the provider in Codex and GitHub exit events', () => {
    const codexHarness = createHarness();
    const codexSessionId = codexHarness.manager.start('codex', 80, 24);
    codexHarness.ptys[0].emitExit(0);
    expect(codexHarness.events[0].payload).toEqual({
      sessionId: codexSessionId,
      provider: 'codex',
      exitCode: 0,
      signal: null,
    });

    const githubHarness = createHarness();
    const githubSessionId = githubHarness.manager.start('github', 80, 24);
    githubHarness.ptys[0].emitExit(0);
    expect(githubHarness.events[0].payload).toEqual({
      sessionId: githubSessionId,
      provider: 'github',
      exitCode: 0,
      signal: null,
    });
  });

  it('kills the existing session when start() is called twice', () => {
    const harness = createHarness();
    const first = harness.manager.start('claude', 80, 24);
    const second = harness.manager.start('codex', 80, 24);
    expect(first).not.toBe(second);
    expect(harness.ptys[0].exited).toBe(true);
    expect(harness.manager.getActiveSessionId()).toBe(second);
    expect(harness.ptys[0].destroyCount).toBe(1);
  });

  it('force-cleans the existing session when start() replaces a PTY that never exits', () => {
    const harness = createHarness();
    harness.setKillSilently(true);
    const first = harness.manager.start('claude', 80, 24);
    const second = harness.manager.start('codex', 80, 24);

    expect(first).not.toBe(second);
    expect(harness.manager.getActiveSessionId()).toBe(second);
    expect(harness.ptys[0].dataDisposeCount).toBe(1);
    expect(harness.ptys[0].exitDisposeCount).toBe(1);
    expect(harness.ptys[0].destroyCount).toBe(1);
    expect(harness.events).toContainEqual({
      channel: IPC_CHANNELS.authTerminalExit,
      payload: {
        sessionId: first,
        provider: 'claude',
        exitCode: null,
        signal: 'forced-cleanup',
      },
    });
  });

  it('stop() sends SIGTERM and then SIGKILLs after grace period', () => {
    jest.useFakeTimers();
    const killSpy = jest.spyOn(process, 'kill');
    try {
      const harness = createHarness({ sigtermGraceMs: 100 });
      harness.setKillSilently(true);
      const sessionId = harness.manager.start('claude', 80, 24);

      harness.manager.stop(sessionId);
      expect(harness.ptys[0].killSignals).toEqual(['SIGTERM']);

      // Fast-forward past the grace period — the manager should force-kill.
      jest.advanceTimersByTime(150);

      expect(killSpy).toHaveBeenCalledWith(-harness.ptys[0].pid, 'SIGKILL');
      expect(killSpy).toHaveBeenCalledWith(harness.ptys[0].pid, 'SIGKILL');
      expect(harness.ptys[0].killSignals).toEqual(['SIGTERM', undefined]);
      expect(harness.manager.getActiveSessionId()).toBeNull();
      expect(harness.ptys[0].dataDisposeCount).toBe(1);
      expect(harness.ptys[0].exitDisposeCount).toBe(1);
      expect(harness.ptys[0].destroyCount).toBe(1);
      expect(harness.events).toContainEqual({
        channel: IPC_CHANNELS.authTerminalExit,
        payload: {
          sessionId,
          provider: 'claude',
          exitCode: null,
          signal: 'forced-cleanup',
        },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('shutdown() kills the active session and clears state', () => {
    const harness = createHarness();
    const sessionId = harness.manager.start('claude', 80, 24);
    expect(harness.manager.getActiveSessionId()).toBe(sessionId);
    harness.manager.shutdown();
    expect(harness.manager.getActiveSessionId()).toBeNull();
    expect(harness.ptys[0].destroyCount).toBe(1);
  });

  it('write/resize/stop become no-ops after the PTY exits', () => {
    const harness = createHarness();
    const sessionId = harness.manager.start('claude', 80, 24);
    harness.ptys[0].emitExit(0);
    harness.manager.write(sessionId, 'late');
    harness.manager.resize(sessionId, 50, 50);
    harness.manager.stop(sessionId);
    expect(harness.ptys[0].writes).toEqual([]);
    expect(harness.ptys[0].resizes).toEqual([]);
  });
});

test('OpenCode login requires a host-verified runtime and excludes application secrets', () => {
  const h = createHarness();
  expect(() => h.manager.start('opencode', 80, 24)).toThrow('must be verified');
  expect(h.spawnCalls).toHaveLength(0);
  h.manager.start('opencode', 80, 24, '/verified/opencode');
  expect(h.spawnCalls[0]).toMatchObject({
    file: '/verified/opencode',
    args: ['auth', 'login'],
  });
  expect(h.enhancedEnvCalls[0]).toEqual({
    includeCanopySecrets: false,
    environment: false,
  });
  expect(h.spawnCalls[0].options.env?.GH_TOKEN).toBeUndefined();
  h.ptys[0].emitExit(0);
});
