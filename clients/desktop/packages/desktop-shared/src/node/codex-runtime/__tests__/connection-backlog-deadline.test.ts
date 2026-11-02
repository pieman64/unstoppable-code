import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type * as NodeChildProcess from 'node:child_process';
import type { CodexAppServerConnectionOwner } from '../connection';

const spawnMock = jest.fn<
  MockChildProcess,
  [string, readonly string[], NodeChildProcess.SpawnOptions]
>();

jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof NodeChildProcess>('node:child_process'),
  get spawn(): typeof spawnMock {
    return spawnMock;
  },
}));

// Fake PIDs must never reach the host's process-group signal path.
jest.mock('../../lib/process-kill', () => ({
  killChildProcessGroup: (
    child: NodeChildProcess.ChildProcess,
    signal: NodeJS.Signals,
  ): void => {
    child.kill(signal);
  },
}));

jest.mock('../../../pipelines/config-paths', () => ({
  getBundledCodexBinaryPath: jest.fn(() => '/mock/codex'),
  getEnhancedEnv: jest.fn(() => ({ ...process.env })),
}));

import { CodexAppServerConnection } from '../connection';

class MockChildProcess extends EventEmitter {
  pid = 4290;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  clientOutput = '';
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill = jest.fn().mockImplementation((signal?: NodeJS.Signals): boolean => {
    this.signalCode = signal ?? 'SIGTERM';
    this.emit('exit', null, this.signalCode);
    return true;
  });

  constructor() {
    super();
    this.stdin.on('data', (chunk: unknown) => {
      this.clientOutput += String(chunk);
    });
  }
}

function ownerStub(
  overrides: Partial<CodexAppServerConnectionOwner> = {},
): CodexAppServerConnectionOwner {
  return {
    hasActiveTurn: () => false,
    getActiveTurnInterruptTarget: () => null,
    cancelPendingTurnStart: jest.fn(),
    rejectActiveTurn: jest.fn(),
    markProcessSuspended: jest.fn(),
    markProcessFailed: jest.fn(),
    handleConnectionNotification: jest.fn(),
    handleRequestUserInput: jest.fn(() => Promise.resolve()),
    handleDynamicToolCall: jest.fn(() => Promise.resolve()),
    handleApprovalRequest: jest.fn(() => Promise.resolve()),
    handleMcpElicitation: jest.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function emitServerMessage(proc: MockChildProcess, payload: unknown): void {
  proc.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** One mebibyte delta for the held peer. */
function largeDelta(index: number): unknown {
  return {
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'peer-thread',
      turnId: 'peer-turn',
      itemId: `item-${String(index)}`,
      delta: 'x'.repeat(1024 * 1024),
    },
  };
}

describe('quarantine deadline behind a stdout backlog', () => {
  let proc: MockChildProcess;
  let connection: CodexAppServerConnection;
  let releasePeer: () => void = () => undefined;

  beforeEach(async () => {
    jest.clearAllMocks();
    proc = new MockChildProcess();
    spawnMock.mockReturnValue(proc);
    // Retention is per owner: the peer's 10 MiB of deltas only pause the
    // shared stdout once they exceed its hard limit.
    connection = new CodexAppServerConnection(
      'profile:backlog-deadline',
      undefined,
      undefined,
      {
        stdoutQueueHighWaterBytes: 4 * 1024 * 1024,
        stdoutQueueLowWaterBytes: 2 * 1024 * 1024,
        stdoutOwnerHardLimitBytes: 8 * 1024 * 1024,
      },
    );
    // Startup needs an owner; this one stays idle.
    connection.registerOwner(ownerStub(), {});
    const initialization = connection.ensureInitialized();
    await new Promise((resolve) => setImmediate(resolve));
    emitServerMessage(proc, {
      id: 1,
      result: { userAgent: 'test', codexHome: '/tmp/.codex' },
    });
    await initialization;
    jest.useFakeTimers();
  });

  afterEach(async () => {
    releasePeer();
    jest.useRealTimers();
    await connection.terminateForFinalRelease();
  });

  async function quarantineWhilePeerBacklogsStdout(): Promise<
    CodexAppServerConnectionOwner & { rejectActiveTurn: jest.Mock }
  > {
    const peerAdmission = new Promise<void>((resolve) => {
      releasePeer = resolve;
    });
    // A busy peer whose durable commits are slow: its first frame holds its
    // lane and later frames fill the shared retained-frame budget.
    const peer = ownerStub({
      hasActiveTurn: () => true,
      handleConnectionNotification: (): Promise<void> => peerAdmission,
    });
    const rejectActiveTurn = jest.fn();
    const owner = {
      ...ownerStub({
        hasActiveTurn: () => true,
        getActiveTurnInterruptTarget: () => ({
          threadId: 'owner-thread',
          turnId: 'owner-turn',
        }),
      }),
      rejectActiveTurn,
    };
    connection.registerOwner(peer, {});
    connection.registerOwner(owner, {});
    connection.registerRootThread('peer-thread', peer);
    connection.registerRootThread('owner-thread', owner);
    for (let index = 0; index <= 9; index += 1)
      emitServerMessage(proc, largeDelta(index));
    await jest.advanceTimersByTimeAsync(0);
    // The owner's interrupt could not be confirmed while a peer is busy, so
    // it is quarantined instead of restarting the shared process.
    connection.triggerSharedRestart(owner, new Error('turn_cancelled'), {
      threadId: 'owner-thread',
      turnId: 'owner-turn',
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(proc.kill).not.toHaveBeenCalled();
    return owner;
  }

  it('waits while the stdout backlog may hold the terminal frame', async () => {
    const owner = await quarantineWhilePeerBacklogsStdout();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(proc.kill).not.toHaveBeenCalled();

    releasePeer();
    await jest.advanceTimersByTimeAsync(0);
    emitServerMessage(proc, {
      method: 'turn/completed',
      params: {
        threadId: 'owner-thread',
        turn: {
          id: 'owner-turn',
          status: 'interrupted',
          items: [],
          error: null,
        },
      },
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(owner.rejectActiveTurn).toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('restarts once the backlog outlasts the bounded extension', async () => {
    await quarantineWhilePeerBacklogsStdout();
    await jest.advanceTimersByTimeAsync(30_000 + 5 * 60_000);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('restarts at the deadline when nothing is backlogged', async () => {
    releasePeer = (): void => undefined;
    const owner = ownerStub({
      hasActiveTurn: () => true,
      getActiveTurnInterruptTarget: () => ({
        threadId: 'owner-thread',
        turnId: 'owner-turn',
      }),
    });
    const peer = ownerStub({ hasActiveTurn: () => true });
    connection.registerOwner(peer, {});
    connection.registerOwner(owner, {});
    connection.registerRootThread('owner-thread', owner);
    connection.triggerSharedRestart(owner, new Error('turn_cancelled'), {
      threadId: 'owner-thread',
      turnId: 'owner-turn',
    });
    await jest.advanceTimersByTimeAsync(29_000);
    expect(proc.kill).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
