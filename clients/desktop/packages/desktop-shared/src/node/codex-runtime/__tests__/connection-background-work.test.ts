import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type * as NodeChildProcess from 'node:child_process';
import type * as ProcessKill from '../../lib/process-kill';
import type {
  CodexAppServerConnectionOwner,
  CodexProcessRecoveryResult,
  CodexRecoverableProcessExitError,
} from '../connection';

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

jest.mock('../../lib/process-kill', () => ({
  ...jest.requireActual<typeof ProcessKill>('../../lib/process-kill'),
  killChildProcessGroup: jest.fn(
    (
      child: { kill(signal?: NodeJS.Signals): boolean },
      signal?: NodeJS.Signals,
    ): void => {
      child.kill(signal);
    },
  ),
}));

jest.mock('../../../pipelines/config-paths', () => ({
  getBundledCodexBinaryPath: jest.fn(() => '/mock/codex'),
  getEnhancedEnv: jest.fn(() => ({ ...process.env })),
}));

import { CodexAppServerConnection } from '../connection';
import {
  configureCodexRuntimeHostHooks,
  resetCodexRuntimeHostHooksForTests,
  type CodexRuntimeDiagnostic,
  type CodexRuntimeResourceRegistrationHandle,
} from '../host-hooks';

interface BackgroundWorkOwner extends CodexAppServerConnectionOwner {
  hasLiveBackgroundWork(): boolean;
  markProcessSuspended: jest.Mock<void, []>;
  markProcessFailed: jest.Mock<void, []>;
}

interface OwnerOptions {
  activeTurn?: boolean;
  liveBackgroundWork?: boolean;
  recovery?: (
    error: CodexRecoverableProcessExitError,
  ) => Promise<CodexProcessRecoveryResult>;
}

class MockChildProcess extends EventEmitter {
  pid = 4711;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = jest.fn((signal?: NodeJS.Signals): boolean => {
    this.signalCode = signal ?? 'SIGTERM';
    this.emit('exit', null, this.signalCode);
    return true;
  });
}

const recordDiagnosticMock = jest.fn<void, [CodexRuntimeDiagnostic]>();

function ownerStub(options: OwnerOptions = {}): BackgroundWorkOwner {
  return {
    hasActiveTurn: () => options.activeTurn ?? false,
    hasLiveBackgroundWork: () => options.liveBackgroundWork ?? false,
    getActiveTurnInterruptTarget: () =>
      options.activeTurn
        ? { threadId: 'root-thread', turnId: 'root-turn' }
        : null,
    cancelPendingTurnStart: jest.fn(),
    rejectActiveTurn: jest.fn(),
    markProcessSuspended: jest.fn<void, []>(),
    markProcessFailed: jest.fn<void, []>(),
    ...(options.recovery
      ? { recoverAfterUnexpectedProcessExit: options.recovery }
      : {}),
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

async function flushMany(count = 4): Promise<void> {
  for (let attempt = 0; attempt < count; attempt += 1) await flush();
}

function emitServerMessage(proc: MockChildProcess, payload: unknown): void {
  proc.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function startConnection(
  owners: readonly BackgroundWorkOwner[],
): Promise<{ connection: CodexAppServerConnection; proc: MockChildProcess }> {
  const proc = new MockChildProcess();
  spawnMock.mockReturnValue(proc);
  const connection = new CodexAppServerConnection('profile:background-work');
  for (const owner of owners) connection.registerOwner(owner, {});
  const initialization = connection.ensureInitialized();
  await flush();
  emitServerMessage(proc, {
    id: 1,
    result: { userAgent: 'test', codexHome: '/tmp/.codex' },
  });
  await initialization;
  return { connection, proc };
}

interface BackgroundWorkProcessFailure {
  readonly label: string;
  readonly emit: (proc: MockChildProcess) => void;
}

const BACKGROUND_WORK_PROCESS_FAILURES: readonly BackgroundWorkProcessFailure[] =
  [
    {
      label: 'clean exit',
      emit: (proc): void => {
        proc.emit('exit', 0, null);
      },
    },
    {
      label: 'abnormal exit',
      emit: (proc): void => {
        proc.emit('exit', 1, null);
      },
    },
    {
      label: 'process error',
      emit: (proc): void => {
        proc.emit('error', new Error('process failed'));
      },
    },
    {
      label: 'stdin error',
      emit: (proc): void => {
        proc.stdin.emit('error', new Error('stdin failed'));
      },
    },
    {
      label: 'stdout parser error',
      emit: (proc): void => {
        proc.stdout.emit('error', new Error('stdout failed'));
      },
    },
    {
      label: 'stdout close followed by process exit',
      emit: (proc): void => {
        proc.stdout.emit('close');
      },
    },
  ];

describe('CodexAppServerConnection background work protection', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    recordDiagnosticMock.mockReset();
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
      recordDiagnostic: recordDiagnosticMock,
      productDisplayName: () => 'Test Runtime',
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    resetCodexRuntimeHostHooksForTests();
  });

  it('does not evict the last inactive owner while it has live background work', () => {
    const connection = new CodexAppServerConnection('profile:eviction');
    const options: OwnerOptions = { liveBackgroundWork: true };
    const owner = ownerStub(options);
    connection.registerOwner(owner, {});

    expect(owner.hasActiveTurn()).toBe(false);
    expect(connection.canEvictOwner(owner)).toBe(false);

    options.liveBackgroundWork = false;

    expect(connection.canEvictOwner(owner)).toBe(true);
  });

  it('does not suspend a background-work owner for the idle timeout', async () => {
    const options: OwnerOptions = { liveBackgroundWork: true };
    const owner = ownerStub(options);
    const { connection, proc } = await startConnection([owner]);
    try {
      expect(connection.suspendIdleProcessIfIdle('idle-timeout')).toBe(false);
      expect(proc.kill).not.toHaveBeenCalled();
      expect(owner.markProcessSuspended).not.toHaveBeenCalled();

      options.liveBackgroundWork = false;

      expect(connection.suspendIdleProcessIfIdle('idle-timeout')).toBe(true);
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(owner.markProcessSuspended).toHaveBeenCalledTimes(1);
    } finally {
      await connection.terminateForFinalRelease();
    }
  });

  it('does not suspend a background-work owner under critical pressure', async () => {
    const options: OwnerOptions = { liveBackgroundWork: true };
    const owner = ownerStub(options);
    const { connection, proc } = await startConnection([owner]);
    const startedAt = Date.now();
    const dateNow = jest
      .spyOn(Date, 'now')
      .mockReturnValue(startedAt + 120_001);
    try {
      expect(connection.suspendIdleProcessIfIdle('critical-pressure')).toBe(
        false,
      );
      expect(proc.kill).not.toHaveBeenCalled();
      expect(owner.markProcessSuspended).not.toHaveBeenCalled();

      options.liveBackgroundWork = false;

      expect(connection.suspendIdleProcessIfIdle('critical-pressure')).toBe(
        true,
      );
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(owner.markProcessSuspended).toHaveBeenCalledTimes(1);
    } finally {
      dateNow.mockRestore();
      await connection.terminateForFinalRelease();
    }
  });

  it('does not restart a shared process for one owner when a peer has live background work', async () => {
    const requester = ownerStub({ activeTurn: true });
    const backgroundPeer = ownerStub({ liveBackgroundWork: true });
    const { connection, proc } = await startConnection([
      requester,
      backgroundPeer,
    ]);
    try {
      connection.triggerSharedRestart(
        requester,
        new Error('turn interrupt failed'),
        { threadId: 'root-thread', turnId: 'root-turn' },
      );
      await flush();

      expect(proc.kill).not.toHaveBeenCalled();
      expect(backgroundPeer.markProcessFailed).not.toHaveBeenCalled();
    } finally {
      await connection.terminateForFinalRelease();
    }
  });

  it('proceeds with failed-interrupt recovery after a background peer drains', async () => {
    const requester = ownerStub({ activeTurn: true });
    const backgroundPeerOptions: OwnerOptions = { liveBackgroundWork: true };
    const backgroundPeer = ownerStub(backgroundPeerOptions);
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const { connection, proc } = await startConnection([
      requester,
      backgroundPeer,
    ]);
    try {
      connection.triggerSharedRestart(
        requester,
        new Error('turn interrupt failed'),
        { threadId: 'root-thread', turnId: 'root-turn' },
      );
      await flush();

      expect(proc.kill).not.toHaveBeenCalled();

      backgroundPeerOptions.liveBackgroundWork = false;
      await jest.advanceTimersByTimeAsync(1_000);
      await flushMany();

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(backgroundPeer.markProcessFailed).toHaveBeenCalledTimes(1);
    } finally {
      await connection.terminateForFinalRelease();
      jest.useRealTimers();
    }
  });

  it('marks idle background owners failed when a forced shared restart exits', async () => {
    const requester = ownerStub({ activeTurn: true });
    const backgroundPeer = ownerStub({ liveBackgroundWork: true });
    const { connection, proc } = await startConnection([
      requester,
      backgroundPeer,
    ]);
    try {
      connection.triggerSharedRestart(
        requester,
        new Error('turn interrupt failed'),
        { threadId: 'root-thread', turnId: 'root-turn' },
        true,
      );
      await flushMany();

      expect(proc.kill).toHaveBeenCalled();
      expect(backgroundPeer.markProcessFailed).toHaveBeenCalledTimes(1);
    } finally {
      await connection.terminateForFinalRelease();
    }
  });

  it.each(BACKGROUND_WORK_PROCESS_FAILURES)(
    'marks an idle owner with live background work failed on $label without recovering it as a turn',
    async ({ emit }) => {
      const recovery = jest.fn(
        (): Promise<CodexProcessRecoveryResult> =>
          Promise.resolve({ strategy: 'continued' }),
      );
      const owner = ownerStub({ liveBackgroundWork: true, recovery });
      const { connection, proc } = await startConnection([owner]);
      try {
        expect(owner.hasActiveTurn()).toBe(false);
        emit(proc);
        await flushMany();

        expect(owner.markProcessFailed).toHaveBeenCalledTimes(1);
        expect(recovery).not.toHaveBeenCalled();
      } finally {
        await connection.terminateForFinalRelease();
      }
    },
  );

  it('marks idle background owners failed on the recovery branch but recovers only active turns', async () => {
    const activeRecovery = jest.fn(
      (): Promise<CodexProcessRecoveryResult> =>
        Promise.resolve({ strategy: 'continued' }),
    );
    const backgroundRecovery = jest.fn(
      (): Promise<CodexProcessRecoveryResult> =>
        Promise.resolve({ strategy: 'continued' }),
    );
    const activeOwner = ownerStub({
      activeTurn: true,
      recovery: activeRecovery,
    });
    const backgroundOwner = ownerStub({
      liveBackgroundWork: true,
      recovery: backgroundRecovery,
    });
    const { connection, proc } = await startConnection([
      activeOwner,
      backgroundOwner,
    ]);
    try {
      proc.emit('exit', 0, null);
      await flushMany();

      expect(activeOwner.markProcessFailed).toHaveBeenCalledTimes(1);
      expect(backgroundOwner.markProcessFailed).toHaveBeenCalledTimes(1);
      expect(activeRecovery).toHaveBeenCalledTimes(1);
      expect(backgroundRecovery).not.toHaveBeenCalled();
    } finally {
      await connection.terminateForFinalRelease();
    }
  });
});
