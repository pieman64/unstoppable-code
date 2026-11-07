import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IDisposable, IPty } from 'node-pty';
import {
  providerCredentialEffects,
  type CanopyCallerDescriptor,
  type OperationRecord,
} from '@canopy/protocol/canopy-core';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  createCoreOperationAdapter,
  type CoreOperationAdapter,
} from '../canopy-runtime/core-operation-adapter';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../canopy-runtime/desktop-runtime';
import {
  SignInWorkerUnavailableError,
  getActiveSignInTerminalSessionId,
  setSignInTerminalEventSender,
  setSignInTerminalOptionsForTesting,
  shutdownSignInRuns,
  startSignInTerminal,
  stopSignInTerminal,
  writeSignInTerminal,
} from '../sign-in-runs/sign-in-runs';
import { SignInTerminal } from '../sign-in-runs/sign-in-terminal';
import {
  SignInOutsideWorkerError,
  currentSignInWorkerContext,
  type SignInWorkerContext,
} from '../sign-in-runs/sign-in-worker-context';

const mockWarn = jest.fn();
jest.mock('../lib/main-process-logging', () => {
  const actual: Record<string, unknown> = jest.requireActual(
    '../lib/main-process-logging',
  );
  return {
    ...actual,
    logMainProcessWarn: (...args: unknown[]): void => {
      mockWarn(...args);
    },
  };
});

interface FakePty extends IPty {
  readonly spawnedIn: SignInWorkerContext | undefined;
  readonly file: string;
  readonly args: string[];
  readonly cwd: string | undefined;
  readonly env: Record<string, string | undefined>;
  readonly writes: string[];
  readonly kills: (string | undefined)[];
  emitData(data: string): void;
  emitExit(event: { exitCode: number; signal?: number }): void;
}

function fakePty(
  file: string,
  args: string[] | string,
  options: { cwd?: string; env?: Record<string, string | undefined> },
): FakePty {
  const data = new Set<(value: string) => void>();
  const exits = new Set<
    (value: { exitCode: number; signal?: number }) => void
  >();
  const subscribe =
    <T>(set: Set<(value: T) => void>) =>
    (listener: (value: T) => void): IDisposable => {
      set.add(listener);
      return { dispose: () => set.delete(listener) };
    };
  const writes: string[] = [];
  const kills: (string | undefined)[] = [];
  return {
    // pid 0 keeps the forced kill on pty.kill(), never a real process group.
    pid: 0,
    cols: 80,
    rows: 24,
    process: file,
    handleFlowControl: false,
    onData: subscribe(data),
    onExit: subscribe(exits),
    resize: jest.fn(),
    clear: jest.fn(),
    write: (value: string | Buffer): void => {
      writes.push(String(value));
    },
    kill: (signal?: string): void => {
      kills.push(signal);
    },
    pause: jest.fn(),
    resume: jest.fn(),
    spawnedIn: currentSignInWorkerContext(),
    file,
    args: typeof args === 'string' ? [args] : args,
    cwd: options.cwd,
    env: options.env ?? {},
    writes,
    kills,
    emitData: (value: string): void =>
      data.forEach((listener) => listener(value)),
    emitExit: (event): void => exits.forEach((listener) => listener(event)),
  };
}

let root: string;
let operations: CoreOperationAdapter;
let runtime: DesktopCanopyDispatcher;
let spawns: FakePty[];
let spawnError: Error | null;
let envCalls: unknown[];
let sent: { channel: string; payload: unknown }[];
let order: string[];
const caller: CanopyCallerDescriptor = {
  principalId: 'another-client',
  clientInstanceId: 'test',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['core.operation.cancel'],
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sign-in-terminal-runs-'));
  operations = createCoreOperationAdapter({
    ledgerPath: () => join(root, 'ledger.sqlite'),
  });
  runtime = createDesktopRuntime({
    operationAdapter: operations,
    shutdownTimeoutMs: 25,
  });
  spawns = [];
  spawnError = null;
  envCalls = [];
  sent = [];
  order = [];
  mockWarn.mockReset();
  setSignInTerminalEventSender((channel, payload) => {
    sent.push({ channel, payload });
    if (channel === IPC_CHANNELS.authTerminalExit)
      order.push(`exit:${payload.sessionId}`);
  });
  setSignInTerminalOptionsForTesting({
    ptySpawn: (file, args, options) => {
      if (spawnError) throw spawnError;
      const pty = fakePty(file, args, options);
      spawns.push(pty);
      order.push(`spawn:${pty.spawnedIn?.signInRunId ?? 'outside'}`);
      return pty;
    },
    getEnhancedEnvFn: (options) => {
      envCalls.push(options);
      return { PATH: '/usr/bin' };
    },
    getClaudeBinaryPath: () => '/bundled/claude',
    getGhBinaryPath: () => '/bundled/gh',
    homedirFn: () => '/home/person',
  });
});
afterEach(async () => {
  shutdownSignInRuns();
  setSignInTerminalOptionsForTesting(null);
  jest.useRealTimers();
  await runtime.shutdown();
  rmSync(root, { recursive: true, force: true });
});

async function signInRuns(): Promise<OperationRecord[]> {
  return (
    await operations.service.list({ kinds: ['core.signIn.run'], limit: 10 })
  ).items;
}

async function settled(operationId: string): Promise<OperationRecord> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const record = await operations.service.get(operationId);
    if (record && record.status !== 'running' && record.status !== 'queued')
      return record;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('The sign-in run did not settle');
}

/** The settled parent whose child reported `sessionId`. */
async function settledRunFor(sessionId: string): Promise<OperationRecord> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    for (const parent of await signInRuns()) {
      if (parent.status === 'running' || parent.status === 'queued') continue;
      const [delegation] = await runtime.localWorker.listDelegations(
        parent.operationId,
      );
      if (!delegation) continue;
      const child = await operations.service.get(delegation.childOperationId);
      const outcome: unknown = child?.outcome;
      if (
        typeof outcome === 'object' &&
        outcome !== null &&
        'signInRunId' in outcome &&
        outcome.signInRunId === sessionId
      )
        return parent;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`No settled sign-in run for ${sessionId}`);
}

it('a sign-in terminal spawns only inside its worker run', async () => {
  const { sessionId } = await startSignInTerminal({
    provider: 'claude',
    cols: 80,
    rows: 24,
  });
  expect(spawns).toHaveLength(1);
  expect(spawns[0]?.spawnedIn).toEqual({
    signInRunId: sessionId,
    provider: 'claude',
  });
  const runs = await signInRuns();
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ status: 'running' });
  const parent = runs[0];
  if (!parent) throw new Error('No parent');
  const [delegation] = await runtime.localWorker.listDelegations(
    parent.operationId,
  );
  if (!delegation) throw new Error('No dispatch');
  expect(
    await operations.service.get(delegation.childOperationId),
  ).toMatchObject({ kind: 'worker.agent.signIn.run', status: 'running' });
  expect(
    () =>
      new SignInTerminal({
        sessionId: 'outside',
        provider: 'claude',
        cols: 80,
        rows: 24,
        emitter: {
          output: (): void => undefined,
          exit: (): void => undefined,
        },
      }),
  ).toThrow(SignInOutsideWorkerError);
});

it('the command and environment are fixed per provider', async () => {
  for (const provider of ['claude', 'github', 'opencode'] as const) {
    await startSignInTerminal({
      provider,
      cols: 80,
      rows: 24,
      ...(provider === 'opencode'
        ? { verifiedOpenCodeExecutable: '/verified/opencode' }
        : {}),
    });
  }
  expect(spawns.map(({ file, args, cwd }) => ({ file, args, cwd }))).toEqual([
    { file: '/bundled/claude', args: ['auth', 'login'], cwd: '/home/person' },
    { file: '/bundled/gh', args: ['auth', 'login'], cwd: '/home/person' },
    {
      file: '/verified/opencode',
      args: ['auth', 'login'],
      cwd: '/home/person',
    },
  ]);
  for (const pty of spawns) expect(pty.env.TERM).toBe('xterm-256color');
  expect(envCalls).toEqual([
    { environment: false },
    { environment: false, includeCanopySecrets: false },
    { environment: false, includeCanopySecrets: false },
  ]);
  expect(spawns.map((pty) => pty.env.BROWSER)).toEqual([
    undefined,
    undefined,
    'echo',
  ]);
});

it('exit 0 completes the run and names the declared effects', async () => {
  const { sessionId } = await startSignInTerminal({
    provider: 'claude',
    cols: 80,
    rows: 24,
  });
  const [parent] = await signInRuns();
  if (!parent) throw new Error('No parent');
  spawns[0]?.emitExit({ exitCode: 0 });
  expect(sent).toContainEqual({
    channel: IPC_CHANNELS.authTerminalExit,
    payload: { sessionId, provider: 'claude', exitCode: 0, signal: null },
  });
  const os = hostOperatingSystem();
  if (os === null) throw new Error('Unsupported test host');
  expect(await settled(parent.operationId)).toMatchObject({
    status: 'completed',
    outcome: {
      status: 'succeeded',
      credentialEffects: providerCredentialEffects('claude', os),
    },
  });
});

it('stop cancels the run and the PTY exits after the grace period', async () => {
  const { sessionId } = await startSignInTerminal({
    provider: 'github',
    cols: 80,
    rows: 24,
  });
  const [parent] = await signInRuns();
  if (!parent) throw new Error('No parent');
  jest.useFakeTimers({
    doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
  });
  stopSignInTerminal(sessionId);
  expect(spawns[0]?.kills).toEqual(['SIGTERM']);
  jest.advanceTimersByTime(1499);
  expect(
    sent.some(({ channel }) => channel === IPC_CHANNELS.authTerminalExit),
  ).toBe(false);
  jest.advanceTimersByTime(1);
  expect(sent).toContainEqual({
    channel: IPC_CHANNELS.authTerminalExit,
    payload: {
      sessionId,
      provider: 'github',
      exitCode: null,
      signal: 'forced-cleanup',
    },
  });
  jest.useRealTimers();
  expect(await settled(parent.operationId)).toMatchObject({
    status: 'cancelled',
  });
});

it('core.operation.cancel stops the terminal', async () => {
  await startSignInTerminal({ provider: 'claude', cols: 80, rows: 24 });
  const [parent] = await signInRuns();
  if (!parent) throw new Error('No parent');
  await runtime.instruction(
    'core.operation.cancel',
    { operationId: parent.operationId, reason: 'stop' },
    { caller },
  );
  for (let attempt = 0; attempt < 50 && !spawns[0]?.kills.length; attempt += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
  expect(spawns[0]?.kills).toEqual(['SIGTERM']);
  spawns[0]?.emitExit({ exitCode: 0, signal: 15 });
  expect(await settled(parent.operationId)).toMatchObject({
    status: 'cancelled',
  });
});

it('starting a second sign-in force-stops the first', async () => {
  const first = await startSignInTerminal({
    provider: 'claude',
    cols: 80,
    rows: 24,
  });
  const second = await startSignInTerminal({
    provider: 'github',
    cols: 80,
    rows: 24,
  });
  expect(order).toEqual([
    `spawn:${first.sessionId}`,
    `exit:${first.sessionId}`,
    `spawn:${second.sessionId}`,
  ]);
  expect(sent).toContainEqual({
    channel: IPC_CHANNELS.authTerminalExit,
    payload: {
      sessionId: first.sessionId,
      provider: 'claude',
      exitCode: null,
      signal: 'forced-cleanup',
    },
  });
  expect(await settledRunFor(first.sessionId)).toMatchObject({
    status: 'cancelled',
  });
});

it('overlapping starts leave only the newest terminal live', async () => {
  const [first, second] = await Promise.all([
    startSignInTerminal({ provider: 'claude', cols: 80, rows: 24 }),
    startSignInTerminal({ provider: 'github', cols: 80, rows: 24 }),
  ]);
  expect(spawns).toHaveLength(2);
  expect(sent).toContainEqual({
    channel: IPC_CHANNELS.authTerminalExit,
    payload: {
      sessionId: first.sessionId,
      provider: 'claude',
      exitCode: null,
      signal: 'forced-cleanup',
    },
  });
  expect(getActiveSignInTerminalSessionId()).toBe(second.sessionId);
  expect(await settledRunFor(first.sessionId)).toMatchObject({
    status: 'cancelled',
  });
  stopSignInTerminal(second.sessionId);
  expect(spawns[1]?.kills).toEqual(['SIGTERM']);
});

it('an unavailable runtime spawns nothing', async () => {
  await runtime.shutdown();
  await expect(
    startSignInTerminal({ provider: 'claude', cols: 80, rows: 24 }),
  ).rejects.toBeInstanceOf(SignInWorkerUnavailableError);
  expect(spawns).toHaveLength(0);
});

it('a spawn failure rejects start and fails the run', async () => {
  const error = new Error('spawn failed');
  spawnError = error;
  await expect(
    startSignInTerminal({ provider: 'claude', cols: 80, rows: 24 }),
  ).rejects.toBe(error);
  const [parent] = await signInRuns();
  if (!parent) throw new Error('No parent');
  expect(await settled(parent.operationId)).toMatchObject({
    status: 'failed',
    error: {
      code: 'worker.agent.signInFailed',
      message: 'The provider sign-in did not finish.',
    },
  });
});

it('quit settles every live sign-in run as cancelled', async () => {
  const { sessionId } = await startSignInTerminal({
    provider: 'claude',
    cols: 80,
    rows: 24,
  });
  const [parent] = await signInRuns();
  if (!parent) throw new Error('No parent');
  shutdownSignInRuns();
  expect(spawns[0]?.kills).toEqual([undefined]);
  expect(sent).toContainEqual({
    channel: IPC_CHANNELS.authTerminalExit,
    payload: {
      sessionId,
      provider: 'claude',
      exitCode: null,
      signal: 'forced-cleanup',
    },
  });
  expect(await settled(parent.operationId)).toMatchObject({
    status: 'cancelled',
  });
});

it('no terminal byte or credential reaches the ledger, receipts or logs', async () => {
  const output = 'sk-canary-OUTPUT-123';
  const input = 'sk-canary-INPUT-456';
  const consoleCalls: unknown[] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
    (method) =>
      jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleCalls.push(args);
      }),
  );
  try {
    const { sessionId } = await startSignInTerminal({
      provider: 'opencode',
      cols: 80,
      rows: 24,
      verifiedOpenCodeExecutable: '/verified/opencode',
    });
    spawns[0]?.emitData(output);
    writeSignInTerminal(sessionId, input);
    expect(spawns[0]?.writes).toEqual([input]);
    expect(sent).toContainEqual({
      channel: IPC_CHANNELS.authTerminalOutput,
      payload: { sessionId, data: output },
    });
    spawns[0]?.emitExit({ exitCode: 0 });
    const [parent] = await signInRuns();
    if (!parent) throw new Error('No parent');
    await settled(parent.operationId);
    const delegations = await runtime.localWorker.listDelegations(
      parent.operationId,
    );
    const children = await Promise.all(
      delegations.map((entry) =>
        operations.service.get(entry.childOperationId),
      ),
    );
    const recorded = JSON.stringify({
      runs: await operations.service.list({ limit: 50 }),
      delegations,
      children,
      warnings: mockWarn.mock.calls,
      consoleCalls,
    });
    for (const canary of [output, input]) {
      expect(recorded).not.toContain(canary);
      for (const file of readdirSync(root))
        expect(readFileSync(join(root, file)).includes(canary)).toBe(false);
    }
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
