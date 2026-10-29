import { EventEmitter } from 'node:events';
import type {
  ArchiveIoRequest,
  ArchiveIoOperationRequest,
} from '../archive/archive-io-protocol';

class FakeUtilityProcess extends EventEmitter {
  public readonly postMessage = jest.fn<void, [ArchiveIoRequest]>();
  public readonly kill = jest.fn<boolean, []>(() => true);
}

const forkMock = jest.fn<FakeUtilityProcess, unknown[]>();
const killProcessGroupByPidMock = jest.fn(() => Promise.resolve());
const recordSessionDiagnosticMock = jest.fn();
jest.mock('electron', () => ({
  utilityProcess: {
    fork: (...args: unknown[]): FakeUtilityProcess => forkMock(...args),
  },
}));
jest.mock('@canopy/desktop-shared/node/lib/process-kill', () => ({
  killProcessGroupByPid: (...args: [number, NodeJS.Signals]): Promise<void> =>
    killProcessGroupByPidMock(...args),
}));
jest.mock('../observability', () => ({
  getObservabilityService: (): {
    recordSessionDiagnostic: typeof recordSessionDiagnosticMock;
  } => ({
    recordSessionDiagnostic: recordSessionDiagnosticMock,
  }),
}));

import {
  ARCHIVE_IO_INTERRUPTED_MESSAGE,
  resetArchiveIoRunnerForTests,
  runArchiveIoRequest,
  shutdownArchiveIoRunner,
} from '../archive/archive-io-runner';
import { ARCHIVE_IO_GIT_RECOVERY_REQUIRED_CODE } from '../archive/archive-io-protocol';

function request(
  operationId = 'operation-1',
): Extract<ArchiveIoOperationRequest, { type: 'remove-directory' }> {
  return {
    version: 1,
    type: 'remove-directory',
    requestId: `request-${operationId}`,
    operationId,
    projectId: 'project-1',
    containerId: 'container-1',
    expectedCreatedAt: '2026-09-21T12:00:00.000Z',
    input: { path: '/archive/container-1', allowedRoot: '/archive' },
  };
}

async function ready(child: FakeUtilityProcess | undefined): Promise<void> {
  if (!child) throw new Error('Expected archive utility process.');
  child.emit('message', { version: 1, type: 'ready', workerPid: 42 });
  await new Promise((resolve) => setImmediate(resolve));
}

describe('archive I/O runner', () => {
  const children: FakeUtilityProcess[] = [];

  beforeEach(() => {
    resetArchiveIoRunnerForTests();
    children.length = 0;
    forkMock.mockReset();
    killProcessGroupByPidMock.mockClear();
    recordSessionDiagnosticMock.mockClear();
    forkMock.mockImplementation(() => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    });
  });

  it('waits for cleanup acknowledgement after receiving a result', async () => {
    const running = runArchiveIoRequest(request());
    await ready(children[0]);
    const sent = children[0]?.postMessage.mock.calls[0]?.[0];
    expect(sent?.type).toBe('remove-directory');
    children[0]?.emit('message', {
      version: 1,
      type: 'result',
      requestId: request().requestId,
      operationType: 'remove-directory',
      result: { removed: true },
    });
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    children[0]?.emit('message', {
      version: 1,
      type: 'cleanup-complete',
      requestId: request().requestId,
      childCleanup: 'not-required',
    });
    await expect(running).resolves.toEqual({ removed: true });
    expect(recordSessionDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'archive_io_operation',
        archiveIoStage: 'finished',
        archiveIoOutcome: 'succeeded',
      }),
    );
  });

  it('joins duplicate operation stages before they reach the worker', async () => {
    const first = runArchiveIoRequest(request());
    const second = runArchiveIoRequest({
      ...request(),
      requestId: 'request-2',
    });
    await ready(children[0]);
    expect(children[0]?.postMessage).toHaveBeenCalledTimes(1);
    const requestId = request().requestId;
    children[0]?.emit('message', {
      version: 1,
      type: 'result',
      requestId,
      operationType: 'remove-directory',
      result: { removed: true },
    });
    children[0]?.emit('message', {
      version: 1,
      type: 'cleanup-complete',
      requestId,
      childCleanup: 'not-required',
    });
    await expect(first).resolves.toEqual({ removed: true });
    await expect(second).resolves.toEqual({ removed: true });
  });

  it('kills tracked destructive children before rejecting a lost worker', async () => {
    const running = runArchiveIoRequest(request());
    await ready(children[0]);
    children[0]?.emit('message', {
      version: 1,
      type: 'child-started',
      requestId: request().requestId,
      pid: 5151,
    });
    children[0]?.emit('exit', 9);

    await expect(running).rejects.toThrow(ARCHIVE_IO_INTERRUPTED_MESSAGE);
    expect(killProcessGroupByPidMock).toHaveBeenCalledWith(5151, 'SIGKILL');
  });

  it('fails closed on a malformed response from the active worker', async () => {
    const running = runArchiveIoRequest(request());
    await ready(children[0]);
    children[0]?.emit('message', {
      version: 1,
      type: 'result',
      requestId: request().requestId,
      operationType: 'remove-directory',
      result: { removed: false },
    });
    expect(children[0]?.kill).toHaveBeenCalledTimes(1);
    children[0]?.emit('exit', 9);
    await expect(running).rejects.toThrow(ARCHIVE_IO_INTERRUPTED_MESSAGE);
  });

  it('terminates a worker that never acknowledges an admitted request', async () => {
    jest.useFakeTimers();
    try {
      const controller = new AbortController();
      const running = runArchiveIoRequest(request(), controller.signal);
      let settled = false;
      void running.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      children[0]?.emit('message', {
        version: 1,
        type: 'ready',
        workerPid: 42,
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(children[0]?.postMessage).toHaveBeenCalledWith(request());

      jest.advanceTimersByTime(10_001);
      expect(children[0]?.kill).toHaveBeenCalledTimes(1);
      controller.abort();
      expect(children[0]?.postMessage).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      children[0]?.emit('exit', 9);
      await expect(running).rejects.toThrow(ARCHIVE_IO_INTERRUPTED_MESSAGE);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(['returns false', 'throws'])(
    'retains an unacknowledged request when worker kill %s',
    async (killOutcome) => {
      jest.useFakeTimers();
      try {
        const running = runArchiveIoRequest(request());
        let settled = false;
        void running.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        children[0]?.emit('message', {
          version: 1,
          type: 'ready',
          workerPid: 42,
        });
        await jest.advanceTimersByTimeAsync(0);
        if (killOutcome === 'throws') {
          children[0]?.kill.mockImplementation(() => {
            throw new Error('kill failed');
          });
        } else {
          children[0]?.kill.mockReturnValue(false);
        }

        jest.advanceTimersByTime(10_001);
        await jest.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
        expect(recordSessionDiagnosticMock).toHaveBeenCalledWith(
          expect.objectContaining({
            archiveIoErrorCode: 'ARCHIVE_IO_ADMISSION_KILL_FAILED',
          }),
        );
        children[0]?.emit('exit', 9);
        await expect(running).rejects.toThrow(ARCHIVE_IO_INTERRUPTED_MESSAGE);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it.each(['returns false', 'throws'])(
    'includes a retired admission-timeout worker in shutdown when kill %s',
    async (killOutcome) => {
      jest.useFakeTimers();
      try {
        const running = runArchiveIoRequest(request());
        void running.catch(() => undefined);
        const child = children[0];
        child?.emit('message', { version: 1, type: 'ready', workerPid: 42 });
        await jest.advanceTimersByTimeAsync(0);
        if (killOutcome === 'throws') {
          child?.kill.mockImplementation(() => {
            throw new Error('kill failed');
          });
        } else {
          child?.kill.mockReturnValue(false);
        }
        jest.advanceTimersByTime(10_001);
        expect(child?.kill).toHaveBeenCalledTimes(1);

        child?.postMessage.mockImplementation((message) => {
          if (message.type === 'shutdown') child.emit('exit', 0);
        });
        await shutdownArchiveIoRunner();
        expect(child?.postMessage).toHaveBeenCalledWith({
          version: 1,
          type: 'shutdown',
        });
        await expect(running).rejects.toThrow(ARCHIVE_IO_INTERRUPTED_MESSAGE);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('force-kills a reported child before accepting cleanup', async () => {
    const running = runArchiveIoRequest(request());
    await ready(children[0]);
    children[0]?.emit('message', {
      version: 1,
      type: 'child-started',
      requestId: request().requestId,
      pid: 6161,
    });
    children[0]?.emit('message', {
      version: 1,
      type: 'result',
      requestId: request().requestId,
      operationType: 'remove-directory',
      result: { removed: true },
    });
    children[0]?.emit('message', {
      version: 1,
      type: 'cleanup-complete',
      requestId: request().requestId,
      childCleanup: 'forced',
    });

    await expect(running).rejects.toThrow(ARCHIVE_IO_INTERRUPTED_MESSAGE);
    expect(killProcessGroupByPidMock).toHaveBeenCalledWith(6161, 'SIGKILL');
  });

  it('rehydrates a worker Git timeout for worktree-removal recovery', async () => {
    const running = runArchiveIoRequest(request());
    await ready(children[0]);
    children[0]?.emit('message', {
      version: 1,
      type: 'error',
      requestId: request().requestId,
      code: 'ARCHIVE_IO_GIT_TIMEOUT',
      message: 'Git worktree removal timed out.',
    });
    children[0]?.emit('message', {
      version: 1,
      type: 'cleanup-complete',
      requestId: request().requestId,
      childCleanup: 'not-required',
    });

    await expect(running).rejects.toMatchObject({
      message: 'Git worktree removal timed out.',
      code: 'ETIMEDOUT',
      killed: true,
    });
  });

  it('preserves a source-owned missing Git metadata recovery code', async () => {
    const running = runArchiveIoRequest(request());
    await ready(children[0]);
    children[0]?.emit('message', {
      version: 1,
      type: 'error',
      requestId: request().requestId,
      code: ARCHIVE_IO_GIT_RECOVERY_REQUIRED_CODE,
      message:
        'The damaged worktree has no unique Git registration; its files were preserved.',
    });
    children[0]?.emit('message', {
      version: 1,
      type: 'cleanup-complete',
      requestId: request().requestId,
      childCleanup: 'not-required',
    });

    await expect(running).rejects.toMatchObject({
      code: ARCHIVE_IO_GIT_RECOVERY_REQUIRED_CODE,
    });
    expect(recordSessionDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'archive_io_operation',
        archiveIoStage: 'failed',
        archiveIoOutcome: 'failed',
        archiveIoErrorCode: ARCHIVE_IO_GIT_RECOVERY_REQUIRED_CODE,
      }),
    );
  });
});
