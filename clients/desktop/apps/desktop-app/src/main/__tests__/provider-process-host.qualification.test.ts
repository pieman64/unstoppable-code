import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ConnectedExecutionHostChannel } from '@canopy/desktop-shared/node/execution-host/channel';
import {
  ReportedExecutionHost,
  type ExecutionHostPort,
  type ExecutionHostProcess,
} from '@canopy/desktop-shared/node/execution-host/port';
import type {
  ProviderProcess,
  ProviderProcessError,
  ProviderProcessOwner,
  ProviderProcessRequest,
} from '@canopy/desktop-shared/node/provider-process/spawn';
import {
  serveProviderProcessHost,
  startProviderProcessHost,
  type ProviderProcessHostChildSnapshot,
  type ProviderProcessHostHandle,
} from '../agent-runs/provider-process-host/host';
import {
  isProviderProcessHostResponse,
  PROVIDER_PROCESS_STDERR_LIMIT_BYTES,
  PROVIDER_PROCESS_STDOUT_WINDOW_BYTES,
  type ProviderProcessHostRequest,
} from '../agent-runs/provider-process-host/protocol';
import {
  createProviderProcessHostClient,
  type ProviderProcessHostClient,
} from '../agent-runs/provider-process-host/runner';
import { startOwnedProviderProcessHost } from './helpers/owned-provider-process-host';

// The provider process host qualified in process (a fake parent port, as the
// utility adapter delivers `{ data }`) and as a real child over the
// owned-process port (the daemon's). Owned-process cases are darwin and linux
// only; the port's own suite covers win32.

type Mode = 'in-process' | 'owned-process';
const posix = process.platform !== 'win32';
const MODES: readonly Mode[] = posix
  ? ['in-process', 'owned-process']
  : ['in-process'];
const describePosix = posix ? describe : describe.skip;
const itPosix = posix ? it : it.skip;

jest.setTimeout(60_000);

let dir = '';
const strays = new Set<number>();

function present(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && Reflect.get(error, 'code') === 'EPERM';
  }
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves with `promise`, or rejects once `ms` pass first. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const OWNER: ProviderProcessOwner = { kind: 'turn', id: 'host-qualification' };

function request(
  args: string[],
  overrides: Partial<ProviderProcessRequest> = {},
): ProviderProcessRequest {
  return {
    command: process.execPath,
    args,
    cwd: dir,
    env: { PATH: process.env.PATH ?? '' },
    owner: OWNER,
    ...overrides,
  };
}

/** A child that starts a grandchild in its group, prints its pid and waits. */
const WAITING_WITH_GRANDCHILD = [
  '-e',
  `const { spawn } = require('node:child_process');
   const grandchild = spawn(process.execPath, ['-e',
     "process.on('SIGTERM', () => undefined); process.stdout.write('ready'); setInterval(() => undefined, 1 << 30);"],
     { stdio: ['ignore', 'pipe', 'ignore'] });
   grandchild.stdout.once('data', () => process.stdout.write(grandchild.pid + '\\n'));
   process.on('SIGTERM', () => process.exit(0));
   setInterval(() => undefined, 1 << 30);`,
];

interface Observed {
  errors: ProviderProcessError[];
  closes: [number | null, NodeJS.Signals | null][];
  closed: Promise<void>;
}

function observe(child: ProviderProcess): Observed {
  const errors: ProviderProcessError[] = [];
  const closes: [number | null, NodeJS.Signals | null][] = [];
  child.once('error', (error) => errors.push(error));
  const closed = new Promise<void>((resolve) => {
    child.once('close', (code, signal) => {
      closes.push([code, signal]);
      resolve();
    });
  });
  return { errors, closes, closed };
}

function readAll(child: ProviderProcess): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    child.stdout.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
    });
    child.stdout.once('end', () => resolve(text));
  });
}

function firstLine(child: ProviderProcess): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    const onData = (chunk: Buffer): void => {
      text += chunk.toString('utf8');
      const end = text.indexOf('\n');
      if (end < 0) return;
      child.stdout.off('data', onData);
      resolve(text.slice(0, end));
    };
    child.stdout.on('data', onData);
  });
}

/** Spawns a waiting child with a grandchild; resolves with both pids. */
async function waitingChild(
  client: ProviderProcessHostClient,
  overrides: Partial<ProviderProcessRequest> = {},
): Promise<{ child: ProviderProcess; observed: Observed; pids: number[] }> {
  const child = client.spawn(request(WAITING_WITH_GRANDCHILD, overrides));
  const observed = observe(child);
  const grandchild = Number(await firstLine(child));
  const pid = child.pid;
  if (pid === undefined) throw new Error('child pid not reported');
  strays.add(pid);
  strays.add(grandchild);
  return { child, observed, pids: [pid, grandchild] };
}

/**
 * An execution host running startProviderProcessHost in this process. Frames
 * cross on the next microtask in the `{ data }` shape.
 */
class InProcessHost extends ReportedExecutionHost {
  readonly hostFrames: unknown[] = [];
  readonly launcherFrames: unknown[] = [];
  readonly handle: ProviderProcessHostHandle;
  /** Runs after the host has handled each launcher frame. */
  afterLauncherFrame: () => void = () => undefined;
  /** While set, frames the host posts wait for `releaseFrames`. */
  holdFrames = false;
  private readonly heldFrames: unknown[] = [];
  private readonly hostListeners = new Set<
    (event: { data: unknown }) => void
  >();
  private stopped = false;

  constructor() {
    super();
    this.handle = startProviderProcessHost(
      {
        postMessage: (message) => {
          if (this.stopped) return;
          this.hostFrames.push(message);
          if (this.holdFrames) this.heldFrames.push(message);
          else queueMicrotask(() => this.reportMessage({ data: message }));
        },
        on: (_event, listener) => this.hostListeners.add(listener),
        once: (_event, listener) => this.hostListeners.add(listener),
      },
      (code) => this.exit(code),
    );
    queueMicrotask(() => this.reportSpawn());
  }

  get pid(): number | undefined {
    return this.exited ? undefined : process.pid;
  }

  releaseFrames(): void {
    this.holdFrames = false;
    for (const message of this.heldFrames.splice(0))
      queueMicrotask(() => this.reportMessage({ data: message }));
  }

  postMessage(message: unknown): void {
    if (this.stopped) throw new Error('host exited');
    this.launcherFrames.push(message);
    queueMicrotask(() => {
      if (this.stopped) return;
      for (const listener of this.hostListeners) listener({ data: message });
      this.afterLauncherFrame();
    });
  }

  kill(): boolean {
    if (this.stopped) return false;
    this.exit(1);
    return true;
  }

  /** The host's own exit: later frames from either side are dropped. */
  exit(code: number): void {
    if (this.stopped) return;
    this.stopped = true;
    queueMicrotask(() => this.reportExit(code));
  }
}

interface Harness {
  readonly client: ProviderProcessHostClient;
  /** Hosts launched so far; in process only. */
  readonly launches?: () => number;
  hostPid(): number | undefined;
  killHost(): void;
  dispose(): Promise<void>;
}

function inProcessHarness(
  onHost: (host: InProcessHost) => void = () => undefined,
): Harness & { hosts: InProcessHost[] } {
  const hosts: InProcessHost[] = [];
  const port: ExecutionHostPort = {
    launch: () => {
      const host = new InProcessHost();
      hosts.push(host);
      onHost(host);
      return host;
    },
    probe: () => Promise.reject(new Error('not used')),
  };
  const client = createProviderProcessHostClient(() => port);
  return {
    client,
    hosts,
    launches: () => hosts.length,
    hostPid: () => client.currentHostForTests()?.pid,
    killHost: (): void => {
      hosts.at(-1)?.exit(1);
    },
    dispose: () => client.shutdown(),
  };
}

function ownedHarness(): Harness {
  const owned = startOwnedProviderProcessHost();
  return {
    client: owned.client,
    hostPid: () => owned.hostPid(),
    killHost: () => owned.killHost(),
    dispose: () => owned.dispose(),
  };
}

beforeAll(() => {
  dir = realpathSync.native(
    mkdtempSync(path.join(realpathSync.native(tmpdir()), 'provider-host-q-')),
  );
});

afterEach(() => {
  for (const pid of Array.from(strays))
    if (present(pid)) process.kill(pid, 'SIGKILL');
  strays.clear();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.each(MODES)('provider process host (%s)', (mode) => {
  let harness: Harness;

  beforeEach(() => {
    harness = mode === 'in-process' ? inProcessHarness() : ownedHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it("streams a child's stdout with credit and reports its close", async () => {
    const child = harness.client.spawn(
      request([
        '-e',
        `const bytes = Buffer.alloc(1024 * 1024);
         for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
         process.stdout.write(bytes, () => { process.exitCode = 0; });`,
      ]),
    );
    const observed = observe(child);
    const chunks: Buffer[] = [];
    let sinceSleep = 0;
    for await (const chunk of child.stdout) {
      const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from([]);
      chunks.push(buffer);
      sinceSleep += buffer.length;
      if (sinceSleep >= 64 * 1024) {
        sinceSleep = 0;
        await sleep(50);
      }
    }
    await observed.closed;
    const bytes = Buffer.concat(chunks);
    expect(bytes.length).toBe(1024 * 1024);
    for (let i = 0; i < bytes.length; i++)
      if (bytes[i] !== i % 251) throw new Error(`byte ${i} out of order`);
    expect(observed.closes).toEqual([[0, null]]);
    expect(observed.errors).toEqual([]);
  });

  if (mode === 'owned-process')
    it("a hosted child's parent is the host process, not the launcher", async () => {
      const child = harness.client.spawn(
        request(['-e', 'process.stdout.write(String(process.ppid))']),
      );
      const observed = observe(child);
      const parent = Number(await readAll(child));
      await observed.closed;
      expect(parent).toBe(harness.hostPid());
      expect(parent).not.toBe(process.pid);
    });

  it('stdin reaches the child and stdin end closes it', async () => {
    const child = harness.client.spawn(
      request(['-e', 'process.stdin.pipe(process.stdout)']),
    );
    const observed = observe(child);
    const output = readAll(child);
    child.stdin.write('hello ');
    child.stdin.end('host');
    expect(await output).toBe('hello host');
    await observed.closed;
    expect(observed.closes).toEqual([[0, null]]);
  });

  it("stop ends the child's whole group", async () => {
    const { child, observed, pids } = await waitingChild(harness.client);
    const grandchild = pids[1];
    expect(present(grandchild)).toBe(true);
    await child.stop({ graceMs: 200 });
    // Windows forces the tree kill, so the SIGTERM handler never runs there.
    if (posix) expect(observed.closes).toEqual([[0, null]]);
    else expect(observed.closes).toHaveLength(1);
    await until(() => !present(grandchild), 3_000);
  });

  it('a host that exits ends every proxy once and reaps their groups', async () => {
    const first = await waitingChild(harness.client);
    const second = await waitingChild(harness.client);
    const killed = harness.client.currentHostForTests();
    harness.killHost();
    await Promise.all([first.observed.closed, second.observed.closed]);
    for (const { observed } of [first, second]) {
      expect(observed.errors.map((error) => error.code)).toEqual([
        'ERR_PROVIDER_PROCESS_HOST_EXIT',
      ]);
      expect(observed.errors[0].message).toMatch(
        /^Provider process host exited before the provider process \(code -?\d+\)\.$/,
      );
      expect(observed.closes).toEqual([[null, 'SIGKILL']]);
    }
    await until(
      () => [...first.pids, ...second.pids].every((pid) => !present(pid)),
      8_000,
    );
    const next = harness.client.spawn(
      request(['-e', 'process.stdout.write("again")']),
    );
    const observed = observe(next);
    expect(await readAll(next)).toBe('again');
    await observed.closed;
    expect(observed.closes).toEqual([[0, null]]);
    const relaunched = harness.client.currentHostForTests();
    expect(relaunched).toBeDefined();
    expect(relaunched).not.toBe(killed);
    if (harness.launches) expect(harness.launches()).toBe(2);
  });

  it('shutdown stops every child and the host', async () => {
    const first = await waitingChild(harness.client);
    const second = await waitingChild(harness.client);
    const hostPid = harness.hostPid();
    await harness.client.shutdown();
    expect(first.observed.closes).toHaveLength(1);
    expect(second.observed.closes).toHaveLength(1);
    await until(
      () => [...first.pids, ...second.pids].every((pid) => !present(pid)),
      8_000,
    );
    if (mode === 'owned-process' && hostPid !== undefined)
      await until(() => !present(hostPid), 8_000);
    expect(harness.client.currentHostForTests()).toBeUndefined();
  });

  it('stop completes for a child whose unread stdout used up its credit', async () => {
    const child = harness.client.spawn(
      request([
        '-e',
        `const chunk = Buffer.alloc(64 * 1024, 120);
         const write = () => { while (process.stdout.write(chunk)); process.stdout.once('drain', write); };
         write();`,
      ]),
    );
    const observed = observe(child);
    await until(() => child.pid !== undefined);
    const pid = child.pid;
    if (pid !== undefined) strays.add(pid);
    // Nobody reads the proxy's stdout, so the host's credit runs out.
    await sleep(300);
    await within(child.stop({ graceMs: 200 }), 8_000);
    expect(observed.closes).toHaveLength(1);
  });

  it('a stopping child that floods stdout stays within the credit window', async () => {
    const child = harness.client.spawn(
      request([
        '-e',
        `process.on('SIGTERM', () => undefined);
         const chunk = Buffer.alloc(64 * 1024, 120);
         const write = () => { while (process.stdout.write(chunk)); process.stdout.once('drain', write); };
         write();`,
      ]),
    );
    const observed = observe(child);
    await until(() => child.pid !== undefined);
    const pid = child.pid;
    if (pid !== undefined) strays.add(pid);
    // Nobody reads the proxy's stdout while the child is stopped.
    await sleep(200);
    await within(child.stop({ graceMs: 1_000 }), 8_000);
    expect(observed.closes).toHaveLength(1);
    expect(child.stdout.readableLength).toBeLessThanOrEqual(
      PROVIDER_PROCESS_STDOUT_WINDOW_BYTES,
    );
  });

  itPosix('stop reaps the group of a child that already closed', async () => {
    const child = harness.client.spawn(
      request([
        '-e',
        `const { spawn } = require('node:child_process');
         const grandchild = spawn(process.execPath, ['-e',
           "process.on('SIGTERM', () => undefined); process.stdout.write('ready'); setInterval(() => undefined, 1 << 30);"],
           { stdio: ['ignore', 'pipe', 'ignore'] });
         grandchild.stdout.once('data', () => {
           process.stdout.write(grandchild.pid + '\\n', () => process.exit(0));
         });`,
      ]),
    );
    const observed = observe(child);
    const grandchild = Number(await firstLine(child));
    strays.add(grandchild);
    await observed.closed;
    expect(observed.closes).toEqual([[0, null]]);
    expect(present(grandchild)).toBe(true);
    await child.stop();
    await until(() => !present(grandchild), 3_000);
  });

  it('an invalid owner launches no host', async () => {
    const owner: ProviderProcessOwner = { kind: 'turn', id: '' };
    const child = harness.client.spawn(request(['-e', ''], { owner }));
    const observed = observe(child);
    await observed.closed;
    expect(observed.errors.map((error) => error.code)).toEqual([
      'ERR_PROVIDER_PROCESS_OWNER',
    ]);
    expect(observed.closes).toEqual([[null, null]]);
    if (harness.launches) expect(harness.launches()).toBe(0);
    expect(harness.client.currentHostForTests()).toBeUndefined();
  });
});

describePosix('provider process host lifecycle', () => {
  it('a launcher that disconnects leaves no child running', async () => {
    const posted: unknown[] = [];
    const listeners = new Set<(event: { data: unknown }) => void>();
    let disconnect: (() => void) | undefined;
    const exit = jest.fn();
    const channel: ConnectedExecutionHostChannel = {
      postMessage: (message) => posted.push(message),
      on: (_event, listener) => listeners.add(listener),
      once: (_event, listener) => listeners.add(listener),
      exit,
      congested: () => false,
      onceDrained: (listener) => listener(),
      onDisconnect: (handler) => {
        disconnect = handler;
      },
    };
    serveProviderProcessHost(channel);
    const spawn: ProviderProcessHostRequest = {
      type: 'spawn',
      requestId: 'disconnect-child',
      command: process.execPath,
      args: WAITING_WITH_GRANDCHILD,
      cwd: dir,
      env: { PATH: process.env.PATH ?? '' },
      owner: OWNER,
    };
    for (const listener of listeners) listener({ data: spawn });
    let pid: number | undefined;
    let grandchild: number | undefined;
    await until(() => {
      let stdout = '';
      for (const frame of posted.filter(isProviderProcessHostResponse)) {
        if (frame.type === 'started') pid = frame.pid;
        if (frame.type === 'stdout')
          stdout += Buffer.from(frame.dataBase64, 'base64').toString('utf8');
      }
      if (stdout.includes('\n')) grandchild = Number(stdout.split('\n')[0]);
      return pid !== undefined && grandchild !== undefined;
    });
    if (pid === undefined || grandchild === undefined)
      throw new Error('child did not start');
    strays.add(pid);
    strays.add(grandchild);
    if (!disconnect) throw new Error('no disconnect handler');
    disconnect();
    const childPid = pid;
    const grandchildPid = grandchild;
    await until(() => !present(childPid) && !present(grandchildPid), 8_000);
    await until(() => exit.mock.calls.length > 0, 8_000);
    expect(
      posted.some(
        (frame) =>
          isProviderProcessHostResponse(frame) &&
          frame.type === 'shutdown-complete',
      ),
    ).toBe(true);
    expect(exit).toHaveBeenCalledWith(0);
  });
});

/** A host that never starts until told: kill() is false before spawn. */
class UnstartedHost extends ReportedExecutionHost {
  private running = false;
  readonly kills = jest.fn();

  get pid(): number | undefined {
    return this.running ? 4242 : undefined;
  }

  postMessage(): void {
    // Queued until spawn; this host never answers.
  }

  kill(): boolean {
    this.kills();
    if (!this.running) return false;
    this.running = false;
    this.reportExit(137);
    return true;
  }

  start(): void {
    this.running = true;
    this.reportSpawn();
  }
}

describePosix('provider process host stop races', () => {
  const EXITING_WITH_GRANDCHILD = [
    '-e',
    `const { spawn } = require('node:child_process');
     const grandchild = spawn(process.execPath, ['-e',
       "process.on('SIGTERM', () => undefined); process.stdout.write('ready'); setInterval(() => undefined, 1 << 30);"],
       { stdio: ['ignore', 'pipe', 'ignore'] });
     grandchild.stdout.once('data', () => {
       process.stdout.write(grandchild.pid + '\\n', () => process.exit(0));
     });`,
  ];

  it("a stop that crosses the child's close still reaps its group", async () => {
    let current: InProcessHost | undefined;
    const harness = inProcessHarness((host) => {
      current = host;
    });
    try {
      const child = harness.client.spawn(request(EXITING_WITH_GRANDCHILD));
      const observed = observe(child);
      const grandchild = Number(await firstLine(child));
      strays.add(grandchild);
      const host = current;
      if (!host) throw new Error('no host');
      host.holdFrames = true;
      // The host has seen the close; the launcher has not.
      await until(() => host.handle.liveChildren().length === 0);
      const stopped = child.stop();
      host.releaseFrames();
      await stopped;
      expect(observed.closes).toEqual([[0, null]]);
      await until(() => !present(grandchild), 3_000);
    } finally {
      await harness.dispose();
    }
  });

  it('shutdown force-kills a child already stopping with a long grace', async () => {
    let current: InProcessHost | undefined;
    const harness = inProcessHarness((host) => {
      current = host;
    });
    try {
      const child = harness.client.spawn(
        request([
          '-e',
          `process.on('SIGTERM', () => undefined);
           process.stdout.write('ready\\n');
           setInterval(() => undefined, 1 << 30);`,
        ]),
      );
      const observed = observe(child);
      await firstLine(child);
      const pid = child.pid;
      if (pid === undefined) throw new Error('no pid');
      strays.add(pid);
      void child.stop({ graceMs: 60_000 });
      await sleep(100);
      const host = current;
      if (!host) throw new Error('no host');
      await within(host.handle.shutdown(), 3_000);
      await until(() => !present(pid), 1_000);
      expect(observed.closes).toHaveLength(1);
    } finally {
      await harness.dispose();
    }
  });
});

/** A child the host spawns through an in-test spawner, fed by the test. */
class ScriptedChild extends EventEmitter implements ProviderProcess {
  readonly pid = 4343;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  stop(): Promise<void> {
    this.stdout.end();
    this.stderr.end();
    this.emit('close', null, 'SIGKILL');
    return Promise.resolve();
  }
}

/** A child that stays open while stopping until the test closes it. */
class StoppingChild extends ScriptedChild {
  readonly stops: number[] = [];

  override stop(options?: { graceMs?: number }): Promise<void> {
    this.stops.push(options?.graceMs ?? -1);
    return Promise.resolve();
  }

  finish(): void {
    this.stdout.end();
    this.stderr.end();
    this.emit('close', null, 'SIGKILL');
  }
}

describe('provider process host stdout while stopping', () => {
  it('relayed stdout stays a prefix once a stopping child exceeds its credit', async () => {
    const child = new StoppingChild();
    const posted: unknown[] = [];
    const listeners = new Set<(event: { data: unknown }) => void>();
    startProviderProcessHost(
      {
        postMessage: (message) => posted.push(message),
        on: (_event, listener) => listeners.add(listener),
        once: (_event, listener) => listeners.add(listener),
      },
      () => undefined,
      () => child,
    );
    const send = (data: ProviderProcessHostRequest): void => {
      for (const listener of listeners) listener({ data });
    };
    const requestId = 'stopping-child';
    send({
      type: 'spawn',
      requestId,
      command: process.execPath,
      args: [],
      cwd: dir,
      env: {},
      owner: OWNER,
    });
    send({ type: 'stop', requestId, graceMs: 1_000 });
    child.stdout.write(Buffer.alloc(PROVIDER_PROCESS_STDOUT_WINDOW_BYTES, 97));
    child.stdout.write(Buffer.alloc(100, 98));
    await sleep(20);
    send({
      type: 'stdout-ack',
      requestId,
      bytes: PROVIDER_PROCESS_STDOUT_WINDOW_BYTES,
    });
    child.stdout.write(Buffer.alloc(50, 99));
    await sleep(20);
    const relayed = Buffer.concat(
      posted
        .filter(isProviderProcessHostResponse)
        .flatMap((frame) =>
          frame.type === 'stdout'
            ? [Buffer.from(frame.dataBase64, 'base64')]
            : [],
        ),
    );
    expect(relayed.length).toBe(PROVIDER_PROCESS_STDOUT_WINDOW_BYTES);
    expect(relayed.every((byte) => byte === 97)).toBe(true);
    child.finish();
  });
});

describe('provider process host stderr', () => {
  it('relayed stderr stays a prefix once a chunk is dropped', async () => {
    const child = new ScriptedChild();
    const posted: unknown[] = [];
    const listeners = new Set<(event: { data: unknown }) => void>();
    startProviderProcessHost(
      {
        postMessage: (message) => posted.push(message),
        on: (_event, listener) => listeners.add(listener),
        once: (_event, listener) => listeners.add(listener),
      },
      () => undefined,
      () => child,
    );
    const spawn: ProviderProcessHostRequest = {
      type: 'spawn',
      requestId: 'stderr-child',
      command: process.execPath,
      args: [],
      cwd: dir,
      env: {},
      owner: OWNER,
    };
    for (const listener of listeners) listener({ data: spawn });
    const first = PROVIDER_PROCESS_STDERR_LIMIT_BYTES - 10;
    child.stderr.write(Buffer.alloc(first, 97));
    child.stderr.write(Buffer.alloc(100, 98));
    child.stderr.write(Buffer.alloc(5, 99));
    await sleep(20);
    const relayed = Buffer.concat(
      posted
        .filter(isProviderProcessHostResponse)
        .flatMap((frame) =>
          frame.type === 'stderr'
            ? [Buffer.from(frame.dataBase64, 'base64')]
            : [],
        ),
    );
    expect(relayed.length).toBe(first);
    expect(relayed.every((byte) => byte === 97)).toBe(true);
    await child.stop();
  });
});

describe('provider process host shutdown before spawn', () => {
  it('shutdown stops a host that has not spawned yet', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    const host = new UnstartedHost();
    const launch = jest.fn((): ExecutionHostProcess => host);
    const client = createProviderProcessHostClient(() => ({
      launch,
      probe: (): Promise<never> => Promise.reject(new Error('not used')),
    }));
    const child = client.spawn(request(['-e', '']));
    const observed = observe(child);
    let resolved = false;
    const shutdown = client.shutdown().then(() => {
      resolved = true;
    });
    await jest.advanceTimersByTimeAsync(6_000);
    expect(host.kills).toHaveBeenCalledTimes(1);
    expect(resolved).toBe(false);
    host.start();
    await shutdown;
    expect(host.kills).toHaveBeenCalledTimes(2);
    expect(observed.closes).toEqual([[null, 'SIGKILL']]);
    expect(launch).toHaveBeenCalledTimes(1);
  });
});

describe('provider process host secrecy', () => {
  it("no spawn request's environment or arguments leak", async () => {
    const canary = `canary-${randomUUID()}`;
    const spied = [
      jest.spyOn(console, 'log'),
      jest.spyOn(console, 'info'),
      jest.spyOn(console, 'warn'),
      jest.spyOn(console, 'error'),
      jest.spyOn(console, 'debug'),
      jest.spyOn(process.stdout, 'write'),
      jest.spyOn(process.stderr, 'write'),
    ];
    const snapshots: (readonly ProviderProcessHostChildSnapshot[])[] = [];
    let current: InProcessHost | undefined;
    const takeSnapshot = (): void => {
      if (current) snapshots.push(current.handle.liveChildren());
    };
    const harness = inProcessHarness((host) => {
      current = host;
      host.afterLauncherFrame = takeSnapshot;
    });
    const errors: ProviderProcessError[] = [];
    const collect = (child: ProviderProcess): Observed => {
      const observed = observe(child);
      child.once('error', (error) => errors.push(error));
      return observed;
    };
    const env = { PATH: process.env.PATH ?? '', CANARY_TOKEN: canary };
    try {
      // (a) a child that exits with the canary in env and args.
      const exiting = harness.client.spawn(
        request(['-e', 'process.exit(3)', '--', `--token=${canary}`], { env }),
      );
      const a = collect(exiting);
      exiting.stdout.resume();
      exiting.stderr.resume();
      await a.closed;
      expect(a.closes).toEqual([[3, null]]);
      // (b) a missing command with the canary in env and args.
      const missing = harness.client.spawn(
        request([`--token=${canary}`], {
          command: path.join(dir, 'missing'),
          env,
        }),
      );
      const b = collect(missing);
      await b.closed;
      expect(b.errors.map((error) => error.code)).toEqual(['ENOENT']);
      // (c) a waiting child ended by the host's own exit.
      const waiting = await waitingChild(harness.client, { env });
      waiting.child.once('error', (error) => errors.push(error));
      takeSnapshot();
      harness.killHost();
      await waiting.observed.closed;
      await until(() => waiting.pids.every((pid) => !present(pid)), 8_000);
    } finally {
      for (const spy of spied) spy.mockRestore();
    }
    const frames = harness.hosts.flatMap((host) => [
      ...host.hostFrames.map((frame) =>
        isProviderProcessHostResponse(frame) &&
        (frame.type === 'stdout' || frame.type === 'stderr')
          ? { ...frame, dataBase64: '' }
          : frame,
      ),
      ...host.launcherFrames.filter(
        (frame) =>
          typeof frame !== 'object' ||
          frame === null ||
          (Reflect.get(frame, 'type') !== 'spawn' &&
            Reflect.get(frame, 'type') !== 'stdin'),
      ),
    ]);
    const collected = [
      ...frames.map((frame) => JSON.stringify(frame)),
      ...errors.flatMap((error) => [
        error.message,
        String(error.code),
        String(error),
        JSON.stringify(error),
      ]),
      ...snapshots.map((snapshot) => JSON.stringify(snapshot)),
      ...spied.flatMap((spy) =>
        spy.mock.calls.map((call) => JSON.stringify(call)),
      ),
    ];
    expect(snapshots.flat().length).toBeGreaterThanOrEqual(2);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(frames.length).toBeGreaterThan(0);
    for (const text of collected) expect(text).not.toContain(canary);
    await harness.dispose();
  });
});
