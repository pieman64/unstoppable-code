import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import type { SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { buildSync } from 'esbuild';
import { createExecutionProcessServices } from '@canopy/core-platform';
import type {
  PlatformExecutionProcessServices,
  PlatformOperatingSystem,
} from '@canopy/core-runtime';
import type {
  ConnectedExecutionHostChannel,
  ExecutionHostChannel,
} from '@canopy/desktop-shared/node/execution-host/channel';
import { createOwnedProcessHostPort } from '@canopy/desktop-shared/node/execution-host/owned-process-host';
import {
  type ExecutionHostPort,
  type ExecutionHostProcess,
  ReportedExecutionHost,
} from '@canopy/desktop-shared/node/execution-host/port';
import type * as RunnerModule from '../agents/claude-process-host-runner';
import { registerHostedClaudeProcess } from '../agents/claude-process-registry';
import {
  resetClaudeProcessHostForTests,
  shutdownClaudeProcessHost,
  spawnClaudeCodeProcessOffMain,
} from '../agents/claude-process-host-runner';
import type * as HostModule from '../agents/claude-process-host-worker';
import {
  serveClaudeProcessHost,
  startClaudeProcessHost,
} from '../agents/claude-process-host-worker';
import type * as PortModule from '../execution-host/utility-process-host';
import { setExecutionHostPort } from '../execution-host/utility-process-host';

// The production Claude process host and runner over both channels a host is
// launched with (CAN-4116): the runner's getExecutionHostPort().launch reaches
// a host in process over a parent-port-shaped channel (the utility-process
// adapter's shape), and the host bundled as the desktop bundles it, run as a
// real child under plain Node over the owned-process port (the port the
// daemon composes). Carries the CAN-4833 host guarantees forward.

jest.mock('../agents/claude-process-registry', () => ({
  registerHostedClaudeProcess: jest.fn(),
  unregisterHostedClaudeProcess: jest.fn(),
}));

const os = ((): PlatformOperatingSystem => {
  const platform: string = process.platform;
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32')
    return platform;
  throw new Error(`unsupported test host ${platform}`);
})();
const ROOT = path.resolve(__dirname, '../../../../..');
const ENTRY = 'claude-process-host-worker.js';
const CASE_TIMEOUT_MS = 30_000;
const REAP_WITHIN_MS = 8_000;
const HOST_EXIT_ERROR =
  /^Claude process host exited before the Claude process \(code -?\d+\)\.$/;

let dir = '';
const strays = new Set<number>();
const hostPids = new Set<number>();

/** Linux only: a process's state letter and parent, from /proc. */
function procStat(pid: number): { state: string; parent: number } | undefined {
  if (os !== 'linux') return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const [state, parent] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { state, parent: Number(parent) };
  } catch {
    return undefined;
  }
}

/** Whether `pid` exists at all, a zombie included. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && Reflect.get(error, 'code') === 'EPERM';
  }
}

/** This process, the hosts it launched, and the CLIs and grandchildren. */
function underTest(pid: number): boolean {
  return pid === process.pid || hostPids.has(pid) || strays.has(pid);
}

function present(pid: number): boolean {
  // An orphaned zombie has exited and waits on a reaper outside the tree
  // under test, which the host does not control; `kill(pid, 0)` still
  // succeeds on it. A zombie whose parent is in the tree is not yet reaped.
  const stat = procStat(pid);
  if (stat?.state === 'Z' && !underTest(stat.parent)) return false;
  return alive(pid);
}

/** The remaining pids, with their state and parent where /proc has them. */
function remaining(pids: readonly number[]): string {
  return pids
    .filter(alive)
    .map((pid) => {
      const stat = procStat(pid);
      return stat ? `${pid} (${stat.state}, parent ${stat.parent})` : `${pid}`;
    })
    .join(', ');
}

async function until(
  check: () => boolean,
  timeoutMs = 10_000,
  explain?: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error(
        `condition not met in time${explain ? `: ${explain()}` : ''}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The CLI pids whose start the runner has read from the host. */
function trackedPids(): Set<number> {
  return new Set(
    jest
      .mocked(registerHostedClaudeProcess)
      .mock.calls.map(([record]) => record.pid),
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A CLI that starts a grandchild in its own group, records both pids and
 * waits. With `ignoreTerm` both ignore SIGTERM.
 */
function waitingScript(pidFile: string, ignoreTerm: boolean): string {
  const ignore = ignoreTerm ? "process.on('SIGTERM', () => undefined);" : '';
  return `${ignore}
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(
      `${ignore} setInterval(() => undefined, 1 << 30);`,
    )}], { stdio: 'ignore' });
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, process.pid + ' ' + child.pid);
    setInterval(() => undefined, 1 << 30);`;
}

async function pidsOf(pidFile: string): Promise<[number, number]> {
  await until(
    () =>
      existsSync(pidFile) && /^\d+ \d+$/.test(readFileSync(pidFile, 'utf8')),
  );
  const [cli, grandchild] = readFileSync(pidFile, 'utf8')
    .split(' ')
    .map(Number);
  strays.add(cli);
  strays.add(grandchild);
  return [cli, grandchild];
}

interface Observed {
  errors: Error[];
  exits: [number | null, NodeJS.Signals | null][];
}

function observe(proxy: SpawnedProcess): Observed {
  const observed: Observed = { errors: [], exits: [] };
  proxy.on('error', (error: Error) => observed.errors.push(error));
  proxy.on('exit', (code: number | null, signal: NodeJS.Signals | null) =>
    observed.exits.push([code, signal]),
  );
  return observed;
}

function startCli(
  spawn: typeof spawnClaudeCodeProcessOffMain,
  args: string[],
  command: string = process.execPath,
): SpawnedProcess {
  return spawn({
    command,
    args,
    cwd: dir,
    env: { PATH: process.env.PATH ?? '' },
    signal: new AbortController().signal,
  });
}

/**
 * The host in this process, over a channel shaped like Electron's parent
 * port: the runner's messages reach the host as `{ data }`, the host's reach
 * the runner as sent, each on a later microtask.
 */
class InProcessClaudeHost extends ReportedExecutionHost {
  private readonly hostListeners = new Set<
    (event: { data: unknown }) => void
  >();
  private closed = false;
  readonly channel: ExecutionHostChannel;

  constructor(start: typeof startClaudeProcessHost) {
    super();
    const channel: ExecutionHostChannel = {
      postMessage: (message: unknown): void => {
        if (this.closed) return;
        const sent = structuredClone(message);
        queueMicrotask(() => this.reportMessage(sent));
      },
      on: (_event, listener) => {
        this.hostListeners.add(listener);
        return channel;
      },
      once: (_event, listener) => {
        const once = (event: { data: unknown }): void => {
          this.hostListeners.delete(once);
          listener(event);
        };
        this.hostListeners.add(once);
        return channel;
      },
    };
    this.channel = channel;
    start(channel, (code) => this.exit(code));
    queueMicrotask(() => this.reportSpawn());
  }

  get pid(): number | undefined {
    return undefined;
  }

  postMessage(message: unknown): void {
    if (this.closed) throw new Error('The in-process host has exited.');
    const data = structuredClone(message);
    queueMicrotask(() => {
      if (this.closed) return;
      for (const listener of Array.from(this.hostListeners)) listener({ data });
    });
  }

  kill(): boolean {
    if (this.exited || this.closed) return false;
    this.exit(1);
    return true;
  }

  /** Ends the host; `exit` follows every message it already sent. */
  exit(code: number): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.reportExit(code));
  }
}

function inProcessPort(
  start: typeof startClaudeProcessHost,
  hosts: ExecutionHostProcess[],
): ExecutionHostPort {
  return {
    launch() {
      const host = new InProcessClaudeHost(start);
      hosts.push(host);
      return host;
    },
    probe: () => Promise.reject(new Error('not used')),
  };
}

beforeAll(() => {
  dir = realpathSync.native(
    mkdtempSync(path.join(realpathSync.native(tmpdir()), 'claude-host-')),
  );
  if (os === 'win32') return;
  buildSync({
    entryPoints: [
      path.join(
        ROOT,
        'apps/desktop-app/src/main/agents/claude-process-host-worker.ts',
      ),
    ],
    outfile: path.join(dir, ENTRY),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    tsconfig: path.join(ROOT, 'tsconfig.base.json'),
    external: ['electron', 'node:*'],
    define: { __CANOPY_E2E__: 'false' },
    logLevel: 'silent',
  });
});

afterEach(() => {
  for (const pid of Array.from(strays))
    if (present(pid)) process.kill(pid, 'SIGKILL');
  strays.clear();
  hostPids.clear();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.each(['in-process', 'owned-process'] as const)(
  'Claude process host %s',
  (mode) => {
    const describeMode =
      mode === 'owned-process' && os === 'win32' ? describe.skip : describe;

    describeMode('over the execution host port', () => {
      let hosts: ExecutionHostProcess[];
      let services: PlatformExecutionProcessServices | undefined;

      beforeEach(() => {
        resetClaudeProcessHostForTests();
        jest.mocked(registerHostedClaudeProcess).mockClear();
        hosts = [];
        services = undefined;
        if (mode === 'in-process') {
          setExecutionHostPort(inProcessPort(startClaudeProcessHost, hosts));
          return;
        }
        services = createExecutionProcessServices({ os });
        const owned = createOwnedProcessHostPort({
          services,
          nodeExecutable: process.execPath,
          entryDirectory: dir,
          cwd: dir,
          environment: () => process.env,
        });
        setExecutionHostPort({
          launch(request) {
            const host = owned.launch(request);
            hosts.push(host);
            host.once('spawn', () => {
              if (host.pid !== undefined) hostPids.add(host.pid);
            });
            return host;
          },
          probe: (request) => owned.probe(request),
        });
      });

      afterEach(async () => {
        await shutdownClaudeProcessHost();
        resetClaudeProcessHostForTests();
        await services?.shutdown();
        setExecutionHostPort(undefined);
      });

      it(
        "streams a CLI's stdout with credit and reports its exit",
        async () => {
          const size = 200 * 1024;
          const expected = Buffer.alloc(size);
          for (let i = 0; i < size; i += 1) expected[i] = i % 251;
          const pidFile = path.join(dir, `${mode}-stream.pid`);
          const proxy = startCli(spawnClaudeCodeProcessOffMain, [
            '-e',
            `const b = Buffer.alloc(${size});
             for (let i = 0; i < b.length; i += 1) b[i] = i % 251;
             require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
             process.stdout.write(b);`,
          ]);
          const observed = observe(proxy);
          const chunks: Buffer[] = [];
          proxy.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
          const ended = new Promise<void>((resolve) =>
            proxy.stdout.once('end', () => resolve()),
          );
          await ended;
          await until(() => observed.exits.length > 0);
          await delay(50);

          expect(Buffer.concat(chunks).equals(expected)).toBe(true);
          expect(observed.exits).toEqual([[0, null]]);
          expect(observed.errors).toEqual([]);
          const pid = Number(readFileSync(pidFile, 'utf8'));
          strays.add(pid);
          await until(() => !present(pid));
        },
        CASE_TIMEOUT_MS,
      );

      it(
        "an ignored SIGTERM ends the CLI's whole group",
        async () => {
          const pidFile = path.join(dir, `${mode}-sigterm.pid`);
          const proxy = startCli(spawnClaudeCodeProcessOffMain, [
            '-e',
            waitingScript(pidFile, true),
          ]);
          const observed = observe(proxy);
          const [cli, grandchild] = await pidsOf(pidFile);

          expect(proxy.kill('SIGTERM')).toBe(true);
          await until(
            () => !present(cli) && !present(grandchild),
            REAP_WITHIN_MS,
          );
          await until(() => observed.exits.length > 0);
          expect(observed.exits).toHaveLength(1);
        },
        CASE_TIMEOUT_MS,
      );

      it(
        'a host that exits ends every proxy once and reaps their groups',
        async () => {
          const files = [1, 2].map((n) =>
            path.join(dir, `${mode}-host-exit-${n}.pid`),
          );
          const proxies = files.map((file) =>
            startCli(spawnClaudeCodeProcessOffMain, [
              '-e',
              waitingScript(file, false),
            ]),
          );
          const observed = proxies.map(observe);
          const groups = await Promise.all(files.map(pidsOf));
          const pids = groups.flat();
          // The runner reaps the groups of CLIs whose start it has read. A pid
          // file shows a CLI runs, not that the host's report of it arrived.
          await until(
            () => groups.every(([cli]) => trackedPids().has(cli)),
            undefined,
            () =>
              `runner tracked [${Array.from(trackedPids()).join(', ')}] of CLIs [${groups
                .map(([cli]) => cli)
                .join(', ')}]`,
          );
          expect(hosts).toHaveLength(1);

          const host = hosts[0];
          if (host instanceof InProcessClaudeHost) host.exit(1);
          else expect(host.kill()).toBe(true);

          await until(
            () => pids.every((pid) => !present(pid)),
            REAP_WITHIN_MS,
            () =>
              `still present: ${remaining(pids)}; proxies ended: ${
                observed.filter((o) => o.exits.length > 0).length
              } of ${observed.length}`,
          );
          await until(() => observed.every((o) => o.exits.length > 0));
          await delay(50);
          for (const o of observed) {
            expect(o.errors).toHaveLength(1);
            expect(o.errors[0].message).toMatch(HOST_EXIT_ERROR);
            expect(o.exits).toEqual([[null, 'SIGKILL']]);
          }
        },
        CASE_TIMEOUT_MS,
      );
    });
  },
);

describe('Claude process host in-process: a post-spawn error', () => {
  it(
    'a child that errors after it spawned stays tracked until it exits',
    async () => {
      const fake = Object.assign(new EventEmitter(), {
        pid: 4242,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: jest.fn(() => true),
      });
      let fakeExited = false;
      // The case exits the child itself, once it has seen the child stay
      // tracked; a timer here would race those checks on a loaded runner.
      const exitFake = (): void => {
        fakeExited = true;
        fake.stdout.end();
        fake.stderr.end();
        fake.emit('exit', 0, null);
        fake.emit('close', 0, null);
      };
      const spawn = jest.fn(() => {
        setImmediate(() => {
          fake.emit('error', new Error('kill EPERM'));
          fake.emit('error', new Error('kill EPERM'));
        });
        return fake;
      });
      let runner: typeof RunnerModule | undefined;
      let host: typeof HostModule | undefined;
      let port: typeof PortModule | undefined;
      jest.isolateModules(() => {
        jest.doMock('node:child_process', () => ({
          ...jest.requireActual<object>('node:child_process'),
          spawn,
        }));
        // The fake pid must never reach a real process group.
        jest.doMock('../lib/process-kill', () => ({
          ...jest.requireActual<object>('../lib/process-kill'),
          killChildProcessGroup: jest.fn(
            (
              child: { kill(signal: NodeJS.Signals): boolean },
              signal: NodeJS.Signals,
            ) => child.kill(signal),
          ),
        }));
        jest.doMock('@canopy/execution-engine/node/lib/process-kill', () => ({
          ...jest.requireActual<object>(
            '@canopy/execution-engine/node/lib/process-kill',
          ),
          killProcessGroupByPid: jest.fn(() => Promise.resolve()),
        }));
        host = jest.requireActual<typeof HostModule>(
          '../agents/claude-process-host-worker',
        );
        runner = jest.requireActual<typeof RunnerModule>(
          '../agents/claude-process-host-runner',
        );
        port = jest.requireActual<typeof PortModule>(
          '../execution-host/utility-process-host',
        );
      });
      if (!runner || !host || !port) throw new Error('modules did not load');
      port.setExecutionHostPort(inProcessPort(host.startClaudeProcessHost, []));

      try {
        const proxy = startCli(
          runner.spawnClaudeCodeProcessOffMain,
          [],
          'claude',
        );
        const observed = observe(proxy);
        const exitedBeforeExit: boolean[] = [];
        proxy.on('exit', () => exitedBeforeExit.push(fakeExited));

        await until(() => observed.errors.length > 0);
        await delay(20);
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(observed.errors).toHaveLength(1);
        expect(observed.errors[0].message).toBe('kill EPERM');
        expect(observed.exits).toEqual([]);
        expect(proxy.kill('SIGKILL')).toBe(true);
        await until(() => fake.kill.mock.calls.length > 0);
        expect(fake.kill).toHaveBeenCalledWith('SIGKILL');
        await delay(20);
        expect(observed.exits).toEqual([]);

        exitFake();
        await until(() => observed.exits.length > 0);
        await delay(50);
        expect(observed.exits).toEqual([[0, null]]);
        expect(exitedBeforeExit).toEqual([true]);
        expect(observed.errors).toHaveLength(1);
      } finally {
        // A case that failed early still lets the fake child exit.
        if (!fakeExited) exitFake();
        await runner.shutdownClaudeProcessHost();
        runner.resetClaudeProcessHostForTests();
        port.setExecutionHostPort(undefined);
      }
    },
    CASE_TIMEOUT_MS,
  );
});

describe('Claude process host served over a launched channel', () => {
  it(
    'a launcher that disconnects leaves no CLI running',
    async () => {
      const posted: unknown[] = [];
      const listeners = new Set<(event: { data: unknown }) => void>();
      let disconnect: (() => void) | undefined;
      const exit = jest.fn();
      const channel: ConnectedExecutionHostChannel = {
        postMessage: (message) => {
          posted.push(message);
        },
        on: (_event, listener) => {
          listeners.add(listener);
          return channel;
        },
        once: (_event, listener) => {
          const once = (event: { data: unknown }): void => {
            listeners.delete(once);
            listener(event);
          };
          listeners.add(once);
          return channel;
        },
        exit,
        congested: () => false,
        onceDrained: (listener) => listener(),
        onDisconnect: (handler) => {
          disconnect = handler;
        },
      };
      serveClaudeProcessHost(channel);
      const pidFile = path.join(dir, 'disconnect.pid');
      for (const listener of Array.from(listeners))
        listener({
          data: {
            type: 'spawn',
            requestId: 'disconnect-1',
            command: process.execPath,
            args: ['-e', waitingScript(pidFile, false)],
            cwd: dir,
            env: { PATH: process.env.PATH ?? '' },
          },
        });
      const [cli, grandchild] = await pidsOf(pidFile);

      if (!disconnect) throw new Error('the host registered no disconnect');
      disconnect();
      await until(() => !present(cli) && !present(grandchild), REAP_WITHIN_MS);
      await until(() => exit.mock.calls.length > 0);
      expect(posted).toContainEqual({ type: 'shutdown-complete' });
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
    },
    CASE_TIMEOUT_MS,
  );
});

/** A host that reports `spawn` only when told and never exits by itself. */
class PendingHost extends ReportedExecutionHost {
  private launched = false;
  readonly kill = jest.fn((): boolean => this.launched);

  get pid(): number | undefined {
    return undefined;
  }

  postMessage(): void {
    // Messages wait for a start that the test controls.
  }

  start(): void {
    this.launched = true;
    this.reportSpawn();
  }

  end(code: number): void {
    this.reportExit(code);
  }
}

describe('Claude process host shutdown before spawn', () => {
  afterEach(() => {
    jest.useRealTimers();
    resetClaudeProcessHostForTests();
    setExecutionHostPort(undefined);
  });

  it('shutdown stops a host that has not spawned yet', async () => {
    jest.useFakeTimers();
    resetClaudeProcessHostForTests();
    const host = new PendingHost();
    setExecutionHostPort({
      launch: () => host,
      probe: () => Promise.reject(new Error('not used')),
    });
    const proxy = startCli(spawnClaudeCodeProcessOffMain, [], 'claude');
    observe(proxy);

    const shutdown = shutdownClaudeProcessHost();
    await jest.advanceTimersByTimeAsync(6_000);
    expect(host.kill).toHaveBeenCalledTimes(1);
    expect(host.kill).toHaveReturnedWith(false);

    host.start();
    expect(host.kill).toHaveBeenCalledTimes(2);
    expect(host.kill).toHaveLastReturnedWith(true);

    host.end(0);
    await expect(shutdown).resolves.toBeUndefined();
  });
});
