// A pooled app-server is terminated when one owner's turn cannot be stopped.
// The other owners are bystanders: their turns go through the same
// persisted-thread recovery as an unexpected process exit instead of being
// failed. See docs/codex-app-server.md, "Failures, cancellation, and retries".
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type * as NodeChildProcess from 'node:child_process';
import type {
  CodexAppServerConnectionOwner,
  CodexAppServerProcessCallbacks,
  CodexProcessRecoveryResult,
} from '../connection';

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

import {
  CodexAppServerConnection,
  CodexAppServerRequestTimeoutError,
  CodexUnsafeRecoveryError,
  isCodexRecoverableProcessExitError,
  isCodexSharedRestartPeerError,
} from '../connection';
import { classifyCodexTransportError } from '../transport-errors';
import {
  configureCodexRuntimeHostHooks,
  resetCodexRuntimeHostHooksForTests,
  type CodexRuntimeDiagnostic,
  type CodexRuntimeResourceRegistrationHandle,
} from '../host-hooks';

const recordDiagnosticMock = jest.fn<void, [CodexRuntimeDiagnostic]>();

const PEER_RESTART_MESSAGE =
  'Codex app-server was restarted because another turn could not be interrupted cleanly. Please retry this message.';
const SHARED_RESTART_DIAGNOSTIC_KIND: string =
  'codex_app_server_shared_restart';

class MockChildProcess extends EventEmitter {
  pid = 4292;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill = jest.fn().mockImplementation((signal?: NodeJS.Signals): boolean => {
    this.signalCode = signal ?? 'SIGTERM';
    this.emit('exit', null, this.signalCode);
    return true;
  });
}

type OwnerMock = CodexAppServerConnectionOwner & {
  rejectActiveTurn: jest.Mock<
    void,
    [Error, Promise<CodexProcessRecoveryResult>?]
  >;
  markProcessFailed: jest.Mock<void, []>;
};

function ownerStub(
  overrides: Partial<CodexAppServerConnectionOwner> = {},
): OwnerMock {
  return {
    hasActiveTurn: () => false,
    getActiveTurnInterruptTarget: () => null,
    cancelPendingTurnStart: jest.fn(),
    markProcessSuspended: jest.fn(),
    handleConnectionNotification: jest.fn(),
    handleRequestUserInput: jest.fn(() => Promise.resolve()),
    handleDynamicToolCall: jest.fn(() => Promise.resolve()),
    handleApprovalRequest: jest.fn(() => Promise.resolve()),
    handleMcpElicitation: jest.fn(() => Promise.resolve()),
    ...overrides,
    rejectActiveTurn: jest.fn<
      void,
      [Error, Promise<CodexProcessRecoveryResult>?]
    >(),
    markProcessFailed: jest.fn<void, []>(),
  };
}

function recoverableOwner(
  recovery: () => Promise<CodexProcessRecoveryResult>,
): OwnerMock & {
  recoverAfterUnexpectedProcessExit: jest.Mock<
    Promise<CodexProcessRecoveryResult>,
    [Error]
  >;
} {
  const recoverAfterUnexpectedProcessExit = jest.fn<
    Promise<CodexProcessRecoveryResult>,
    [Error]
  >(recovery);
  return {
    ...ownerStub({ hasActiveTurn: () => true }),
    recoverAfterUnexpectedProcessExit,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function flushMany(count = 20): Promise<void> {
  for (let attempt = 0; attempt < count; attempt += 1) await flush();
}

function emitServerMessage(proc: MockChildProcess, payload: unknown): void {
  proc.stdout.write(`${JSON.stringify(payload)}\n`);
}

function sharedRestartDiagnostics(): CodexRuntimeDiagnostic[] {
  return recordDiagnosticMock.mock.calls
    .map(([event]) => event)
    .filter((event) => event.kind === SHARED_RESTART_DIAGNOSTIC_KIND);
}

async function startConnection(
  owners: Array<
    [CodexAppServerConnectionOwner, CodexAppServerProcessCallbacks]
  >,
): Promise<{ proc: MockChildProcess; connection: CodexAppServerConnection }> {
  const proc = new MockChildProcess();
  spawnMock.mockReturnValue(proc);
  const connection = new CodexAppServerConnection('profile:shared-restart');
  for (const [owner, callbacks] of owners) {
    connection.registerOwner(owner, callbacks);
  }
  const initialization = connection.ensureInitialized();
  await flush();
  emitServerMessage(proc, {
    id: 1,
    result: { userAgent: 'test', codexHome: '/tmp/.codex' },
  });
  await initialization;
  return { proc, connection };
}

const RESTART_TARGET = { threadId: 'restart-thread', turnId: 'restart-turn' };

describe('CodexAppServerConnection forced shared restart', () => {
  beforeEach(() => {
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
    resetCodexRuntimeHostHooksForTests();
  });

  it('recovers a peer with an active turn instead of failing it', async () => {
    const restartOwner = ownerStub({ hasActiveTurn: () => true });
    const peer = recoverableOwner(() =>
      Promise.resolve({ strategy: 'continued' }),
    );
    const onProcessRecovery = jest.fn();
    const { proc, connection } = await startConnection([
      [restartOwner, {}],
      [peer, { onProcessRecovery }],
    ]);
    connection.registerRootThread('restart-thread', restartOwner);
    connection.registerRootThread('peer-thread', peer);

    connection.triggerSharedRestart(
      restartOwner,
      new Error('turn_cancelled'),
      RESTART_TARGET,
      true,
    );
    await flushMany();

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(restartOwner.rejectActiveTurn).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'turn_cancelled' }),
    );
    expect(peer.recoverAfterUnexpectedProcessExit).toHaveBeenCalledTimes(1);
    const recoveryCause =
      peer.recoverAfterUnexpectedProcessExit.mock.calls[0]?.[0];
    expect(isCodexRecoverableProcessExitError(recoveryCause)).toBe(true);
    expect(peer.rejectActiveTurn).not.toHaveBeenCalled();
    expect(peer.markProcessFailed).toHaveBeenCalledTimes(1);
    expect(onProcessRecovery).toHaveBeenCalledWith({
      status: 'succeeded',
      strategy: 'continued',
    });
    expect(sharedRestartDiagnostics()).toEqual([
      expect.objectContaining({
        restartTrigger: 'turn-cancelled',
        recoveredPeerCount: 1,
        failedPeerCount: 0,
      }),
    ]);
  });

  it('rejects a recovering peer request as recoverable and the restart owner request with its own error', async () => {
    const restartOwner = ownerStub({ hasActiveTurn: () => true });
    const peer = recoverableOwner(() =>
      Promise.resolve({ strategy: 'restarted' }),
    );
    const { connection } = await startConnection([
      [restartOwner, {}],
      [peer, {}],
    ]);
    const peerRequest = connection.request(
      'thread/resume',
      { threadId: 'peer-thread' },
      { owner: peer },
    );
    const ownerRequest = connection.request(
      'thread/resume',
      { threadId: 'restart-thread' },
      { owner: restartOwner },
    );
    const peerFailure = peerRequest.then(
      () => undefined,
      (error: unknown) => error,
    );
    const ownerFailure = ownerRequest.then(
      () => undefined,
      (error: unknown) => error,
    );
    await flushMany();

    connection.triggerSharedRestart(
      restartOwner,
      new Error('turn_cancelled'),
      RESTART_TARGET,
      true,
    );

    expect(isCodexRecoverableProcessExitError(await peerFailure)).toBe(true);
    expect(await ownerFailure).toMatchObject({ message: 'turn_cancelled' });
  });

  it('fails a peer that cannot recover with the shared-restart error', async () => {
    const restartOwner = ownerStub({ hasActiveTurn: () => true });
    const peer = ownerStub({ hasActiveTurn: () => true });
    const { connection } = await startConnection([
      [restartOwner, {}],
      [peer, {}],
    ]);
    const peerFailure = connection
      .request('thread/resume', { threadId: 'peer-thread' }, { owner: peer })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await flushMany();

    connection.triggerSharedRestart(
      restartOwner,
      new Error('turn_cancelled'),
      RESTART_TARGET,
      true,
    );
    await flushMany();

    const peerError = peer.rejectActiveTurn.mock.calls[0]?.[0];
    expect(peerError).toMatchObject({ message: PEER_RESTART_MESSAGE });
    expect(isCodexSharedRestartPeerError(peerError)).toBe(true);
    expect(isCodexSharedRestartPeerError(await peerFailure)).toBe(true);
    expect(sharedRestartDiagnostics()).toEqual([
      expect.objectContaining({ recoveredPeerCount: 0, failedPeerCount: 1 }),
    ]);
  });

  it('reports a failed peer recovery to that peer only', async () => {
    const restartOwner = ownerStub({ hasActiveTurn: () => true });
    const recovery = Promise.reject(new Error('resume failed'));
    void recovery.catch(() => undefined);
    const peer = recoverableOwner(() => recovery);
    const onProcessRecovery = jest.fn();
    const { connection } = await startConnection([
      [restartOwner, {}],
      [peer, { onProcessRecovery }],
    ]);

    connection.triggerSharedRestart(
      restartOwner,
      new Error('turn_cancelled'),
      RESTART_TARGET,
      true,
    );
    await flushMany();

    expect(peer.rejectActiveTurn).toHaveBeenCalledTimes(1);
    expect(peer.rejectActiveTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Codex app-server background recovery failed: resume failed',
      }),
      recovery,
    );
    expect(onProcessRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
    // The chat fallback retry still sees this as a shared restart.
    expect(
      classifyCodexTransportError(peer.rejectActiveTurn.mock.calls[0]?.[0]),
    ).toEqual({ codex_error_code: 'app_server_shared_restart' });
  });

  it('does not mark a recovery that refused an unsafe replay', async () => {
    const restartOwner = ownerStub({ hasActiveTurn: () => true });
    const recovery = Promise.reject(
      new CodexUnsafeRecoveryError(
        'Cannot safely replay Codex turn turn-a because its persisted outcome is unavailable',
      ),
    );
    void recovery.catch(() => undefined);
    const peer = recoverableOwner(() => recovery);
    const { connection } = await startConnection([
      [restartOwner, {}],
      [peer, {}],
    ]);

    connection.triggerSharedRestart(
      restartOwner,
      new Error('turn_cancelled'),
      RESTART_TARGET,
      true,
    );
    await flushMany();

    const failure = peer.rejectActiveTurn.mock.calls[0]?.[0];
    expect(String(failure)).toContain('Cannot safely replay');
    expect(classifyCodexTransportError(failure)).toBeNull();
  });

  it('does not mark a recovery that failed on an unanswered turn/start', async () => {
    const restartOwner = ownerStub({ hasActiveTurn: () => true });
    // The replayed turn may still be running, so a retry could repeat it.
    const recoveryFailure = new Error(
      'Could not restore the persisted Codex turn after bounded resume checks',
    );
    Object.defineProperty(recoveryFailure, 'cause', {
      value: new CodexAppServerRequestTimeoutError('turn/start', 600_000),
    });
    const recovery = Promise.reject(recoveryFailure);
    void recovery.catch(() => undefined);
    const peer = recoverableOwner(() => recovery);
    const { connection } = await startConnection([
      [restartOwner, {}],
      [peer, {}],
    ]);

    connection.triggerSharedRestart(
      restartOwner,
      new Error('turn_cancelled'),
      RESTART_TARGET,
      true,
    );
    await flushMany();

    expect(
      classifyCodexTransportError(peer.rejectActiveTurn.mock.calls[0]?.[0]),
    ).toEqual({
      codex_error_code: 'app_server_request_timeout',
      codex_error_method: 'turn/start',
    });
  });

  it('never recovers an owner whose own turn is being cancelled', async () => {
    const restartOwner = ownerStub({ hasActiveTurn: () => true });
    const cancellingOwner = recoverableOwner(() =>
      Promise.resolve({ strategy: 'continued' }),
    );
    const busyPeer = recoverableOwner(() =>
      Promise.resolve({ strategy: 'continued' }),
    );
    const { connection } = await startConnection([
      [restartOwner, {}],
      [cancellingOwner, {}],
      [busyPeer, {}],
    ]);
    connection.registerRootThread('cancelling-thread', cancellingOwner);

    // A busy peer keeps the process alive, so this owner is quarantined.
    connection.triggerSharedRestart(
      cancellingOwner,
      new Error('turn_cancelled'),
      { threadId: 'cancelling-thread', turnId: 'cancelling-turn' },
    );
    connection.triggerSharedRestart(
      restartOwner,
      new Error('session_destroyed'),
      RESTART_TARGET,
      true,
    );
    await flushMany();

    expect(
      cancellingOwner.recoverAfterUnexpectedProcessExit,
    ).not.toHaveBeenCalled();
    expect(cancellingOwner.rejectActiveTurn).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'turn_cancelled' }),
    );
    expect(busyPeer.recoverAfterUnexpectedProcessExit).toHaveBeenCalledTimes(1);
    expect(sharedRestartDiagnostics()).toEqual([
      expect.objectContaining({
        restartTrigger: 'session-destroyed',
        recoveredPeerCount: 1,
      }),
    ]);
  });

  it('does not start recovery for an idle peer', async () => {
    const restartOwner = ownerStub({ hasActiveTurn: () => true });
    const recoverAfterUnexpectedProcessExit = jest.fn<
      Promise<CodexProcessRecoveryResult>,
      [Error]
    >(() => Promise.resolve({ strategy: 'restarted' }));
    const idlePeer: OwnerMock = {
      ...ownerStub(),
      recoverAfterUnexpectedProcessExit,
    };
    const { connection } = await startConnection([
      [restartOwner, {}],
      [idlePeer, {}],
    ]);

    connection.triggerSharedRestart(
      restartOwner,
      new Error('turn_cancelled'),
      RESTART_TARGET,
      true,
    );
    await flushMany();

    expect(recoverAfterUnexpectedProcessExit).not.toHaveBeenCalled();
    expect(idlePeer.markProcessFailed).toHaveBeenCalledTimes(1);
  });
});
