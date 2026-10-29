// The host's per-owner in-flight budget on a pooled Codex app-server
// connection (desktop performance phase 11). While the host returns a budget
// from `ownerAdmissionBudget`, one owner receives further `item/*`
// notifications while its earlier admissions are pending, in pipe order;
// turn boundaries and responses still wait. Without a budget one admission is
// pending per owner (`connection-owner-admission.test.ts`). See
// docs/codex-app-server.md, "Per-owner notification admission".
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
  spawn: spawnMock,
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
import {
  GROUP_COMMIT_OWNER_ADMISSION_BUDGET,
  configureCodexRuntimeHostHooks,
  resetCodexRuntimeHostHooksForTests,
  type CodexOwnerAdmissionBudget,
  type CodexRuntimeResourceRegistrationHandle,
} from '../host-hooks';

class MockChildProcess extends EventEmitter {
  pid = 4291;
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

function ownerStub(): CodexAppServerConnectionOwner {
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
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function flushMany(count = 8): Promise<void> {
  for (let attempt = 0; attempt < count; attempt += 1) await flush();
}

function emitServerMessage(proc: MockChildProcess, payload: unknown): void {
  proc.stdout.write(`${JSON.stringify(payload)}\n`);
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function startConnection(
  owner: CodexAppServerConnectionOwner,
  threadId: string,
): Promise<{ proc: MockChildProcess; connection: CodexAppServerConnection }> {
  const proc = new MockChildProcess();
  spawnMock.mockReturnValue(proc);
  const connection = new CodexAppServerConnection(
    'profile:owner-in-flight',
    undefined,
    undefined,
    { allowOwnerlessStartup: false },
  );
  connection.registerOwner(owner, {});
  connection.registerRootThread(threadId, owner);
  const initialization = connection.ensureInitialized();
  await flush();
  emitServerMessage(proc, {
    id: 1,
    result: { userAgent: 'test', codexHome: '/tmp/.codex' },
  });
  await initialization;
  return { proc, connection };
}

describe('CodexAppServerConnection per-owner in-flight budget', () => {
  let budget: CodexOwnerAdmissionBudget | undefined;

  let processKillSpy: jest.SpiedFunction<typeof process.kill>;

  beforeEach(() => {
    // Model a host where the fake PID happens to identify a live group.
    processKillSpy = jest.spyOn(process, 'kill').mockReturnValue(true);
    budget = undefined;
    configureCodexRuntimeHostHooks({
      clientInfo: () => ({
        name: 'test-runtime',
        title: 'Test Runtime',
        version: '0.0.0',
      }),
      registerProcess: (): CodexRuntimeResourceRegistrationHandle => ({
        update: (): void => {},
        unregister: (): void => {},
      }),
      registerProcessOwner: (): void => {},
      unregisterProcessOwner: (): void => {},
      recordDiagnostic: (): void => {},
      productDisplayName: () => 'Test Runtime',
      ownerAdmissionBudget: () => budget,
    });
  });

  afterEach(() => {
    expect(processKillSpy).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    resetCodexRuntimeHostHooksForTests();
  });

  /** An owner whose every notification admission stays pending. */
  function holdingOwner(): {
    owner: CodexAppServerConnectionOwner;
    received: string[];
    holds: Deferred[];
  } {
    const owner = ownerStub();
    const received: string[] = [];
    const holds: Deferred[] = [];
    owner.handleConnectionNotification = (
      method,
      notification,
    ): Promise<void> => {
      const params = notification.params;
      const sequence =
        typeof params === 'object' && params !== null && 'sequence' in params
          ? String(params.sequence)
          : '?';
      received.push(`${method}#${sequence}`);
      const hold = deferred();
      holds.push(hold);
      return hold.promise;
    };
    return { owner, received, holds };
  }

  it('delivers further item notifications of one owner while its admissions are pending', async () => {
    budget = GROUP_COMMIT_OWNER_ADMISSION_BUDGET;
    const { owner, received, holds } = holdingOwner();
    const { proc, connection } = await startConnection(owner, 'thread');
    try {
      for (const sequence of [1, 2, 3])
        emitServerMessage(proc, {
          method: 'item/started',
          params: { threadId: 'thread', sequence },
        });
      // A turn boundary, then another item behind it.
      emitServerMessage(proc, {
        method: 'turn/completed',
        params: { threadId: 'thread', sequence: 4 },
      });
      emitServerMessage(proc, {
        method: 'item/started',
        params: { threadId: 'thread', sequence: 5 },
      });
      await flushMany();
      // Three admissions are pending for one chat, delivered in pipe order.
      // The turn boundary waits for all of them.
      expect(received).toEqual([
        'item/started#1',
        'item/started#2',
        'item/started#3',
      ]);
      holds[1].resolve();
      holds[0].resolve();
      await flushMany();
      expect(received).toHaveLength(3);
      holds[2].resolve();
      await flushMany();
      // Delivered alone: nothing overlaps a turn boundary's admission.
      expect(received.slice(3)).toEqual(['turn/completed#4']);
      holds[3].resolve();
      await flushMany();
      expect(received.slice(4)).toEqual(['item/started#5']);
    } finally {
      for (const hold of holds) hold.resolve();
      await connection.terminateForFinalRelease();
    }
  });

  it('keeps one pending admission per owner when the host gives no budget', async () => {
    const { owner, received, holds } = holdingOwner();
    const { proc, connection } = await startConnection(owner, 'thread');
    try {
      for (const sequence of [1, 2])
        emitServerMessage(proc, {
          method: 'item/started',
          params: { threadId: 'thread', sequence },
        });
      await flushMany();
      expect(received).toEqual(['item/started#1']);
      holds[0].resolve();
      await flushMany();
      expect(received).toEqual(['item/started#1', 'item/started#2']);
    } finally {
      for (const hold of holds) hold.resolve();
      await connection.terminateForFinalRelease();
    }
  });
});
