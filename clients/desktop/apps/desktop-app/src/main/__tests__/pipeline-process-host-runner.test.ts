import { EventEmitter } from 'node:events';
import type {
  PipelineProcessHostRequest,
  PipelineProcessHostRunRequest,
} from '../pipelines/process-host-protocol';

class FakeUtilityProcess extends EventEmitter {
  public readonly postMessage = jest.fn<void, [PipelineProcessHostRequest]>();
  public readonly kill = jest.fn<boolean, []>(() => true);
}

const forkMock = jest.fn<FakeUtilityProcess, unknown[]>();
const killProcessGroupByPidMock = jest.fn<
  Promise<void>,
  [number, NodeJS.Signals]
>(() => Promise.resolve());
jest.mock('electron', () => ({
  utilityProcess: {
    fork: (...args: unknown[]): FakeUtilityProcess => forkMock(...args),
  },
}));
jest.mock('@canopy/desktop-shared/node/lib/process-kill', () => ({
  killProcessGroupByPid: (...args: [number, NodeJS.Signals]): Promise<void> =>
    killProcessGroupByPidMock(...args),
}));

import {
  resetPipelineProcessHostForTests,
  runPipelineProcessInExecutionHost,
  shutdownPipelineProcessHost,
} from '../pipelines/process-host-runner';
import type { SpawnedProcessResult } from '@canopy/desktop-shared/node/pipelines/executor/types';

const SUCCESS: SpawnedProcessResult = {
  status: 'success',
  conclusion: 'success',
  outcome: 'success',
  exit_code: 0,
  outputs: {},
  dynamic_env: {},
  log_file: '/tmp/step.log',
};

function run(
  controller = new AbortController(),
): Promise<SpawnedProcessResult> {
  return runPipelineProcessInExecutionHost(
    { command: 'node', args: ['step.js'] },
    {
      cwd: '/repo',
      env: { PATH: '/bin' },
      signal: controller.signal,
      timeout_minutes: 5,
      logFile: '/tmp/step.log',
      outputFile: '/tmp/output',
      envFile: '/tmp/env',
    },
  );
}

function getRunRequest(
  child: FakeUtilityProcess | undefined,
  index = 0,
): PipelineProcessHostRunRequest {
  const request = child?.postMessage.mock.calls[index]?.[0];
  if (request?.type !== 'run') {
    throw new Error(`Expected run request at index ${index}.`);
  }
  return request;
}

describe('pipeline process host runner', () => {
  const children: FakeUtilityProcess[] = [];

  beforeEach(() => {
    resetPipelineProcessHostForTests();
    forkMock.mockReset();
    children.length = 0;
    killProcessGroupByPidMock.mockReset();
    killProcessGroupByPidMock.mockResolvedValue();
    forkMock.mockImplementation(() => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    });
  });

  it('reuses one utility process and forwards bounded output messages', async () => {
    const output = jest.fn();
    const first = runPipelineProcessInExecutionHost(
      { command: 'node', args: ['one.js'] },
      {
        cwd: '/repo',
        env: {},
        signal: new AbortController().signal,
        timeout_minutes: 5,
        logFile: '/tmp/one.log',
        outputFile: '/tmp/one-output',
        envFile: '/tmp/one-env',
        onOutput: output,
      },
    );
    const second = run();

    expect(forkMock).toHaveBeenCalledTimes(1);
    const firstId = getRunRequest(children[0]).requestId;
    const secondId = getRunRequest(children[0], 1).requestId;
    // Electron UtilityProcess delivers the protocol object directly. In
    // particular, output messages have their own `data` field and must not be
    // mistaken for a MessageEvent envelope.
    children[0]?.emit('message', {
      type: 'output',
      requestId: firstId,
      stream: 'stdout',
      data: 'batched output',
    });
    children[0]?.emit('message', {
      data: { type: 'result', requestId: firstId, result: SUCCESS },
    });
    children[0]?.emit('message', {
      data: { type: 'result', requestId: secondId, result: SUCCESS },
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      SUCCESS,
      SUCCESS,
    ]);
    expect(output).toHaveBeenCalledWith('stdout', 'batched output');
  });

  it('forwards cancellation to the host and settles from its result', async () => {
    const controller = new AbortController();
    const result = run(controller);
    const runRequest = getRunRequest(children[0]);

    controller.abort();

    expect(children[0]?.postMessage).toHaveBeenCalledWith({
      type: 'cancel',
      requestId: runRequest.requestId,
    });
    children[0]?.emit('message', {
      data: {
        type: 'result',
        requestId: runRequest.requestId,
        result: { ...SUCCESS, status: 'cancelled', conclusion: 'cancelled' },
      },
    });
    await expect(result).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('rejects in-flight work after a host crash and restarts on the next run', async () => {
    let completeKill = (): void => undefined;
    killProcessGroupByPidMock.mockReturnValue(
      new Promise<void>((resolve) => {
        completeKill = resolve;
      }),
    );
    const interrupted = run();
    const interruptedRequest = getRunRequest(children[0]);
    children[0]?.emit('message', {
      data: {
        type: 'started',
        requestId: interruptedRequest.requestId,
        pid: 5151,
      },
    });
    children[0]?.emit('exit', 9);

    expect(killProcessGroupByPidMock).toHaveBeenCalledWith(5151, 'SIGKILL');
    const recovered = run();
    expect(forkMock).toHaveBeenCalledTimes(2);
    completeKill();
    await expect(interrupted).rejects.toThrow(
      'Pipeline process host exited before completing its work (code 9).',
    );
    const request = getRunRequest(children[1]);
    children[1]?.emit('message', {
      data: { type: 'result', requestId: request.requestId, result: SUCCESS },
    });
    await expect(recovered).resolves.toEqual(SUCCESS);
  });

  it("does not let an exited worker resolve its replacement's exit promise", async () => {
    let completeOldCleanup = (): void => undefined;
    killProcessGroupByPidMock.mockReturnValue(
      new Promise<void>((resolve) => {
        completeOldCleanup = resolve;
      }),
    );
    const interrupted = run();
    const interruptedRequest = getRunRequest(children[0]);
    children[0]?.emit('message', {
      data: {
        type: 'started',
        requestId: interruptedRequest.requestId,
        pid: 5151,
      },
    });
    children[0]?.emit('exit', 9);

    const recovered = run();
    const recoveredRequest = getRunRequest(children[1]);
    children[1]?.emit('message', {
      data: {
        type: 'result',
        requestId: recoveredRequest.requestId,
        result: SUCCESS,
      },
    });
    children[1]?.emit('message', {
      data: {
        type: 'cleanup-complete',
        requestId: recoveredRequest.requestId,
      },
    });
    await expect(recovered).resolves.toEqual(SUCCESS);

    let shutdownSettled = false;
    const shutdown = shutdownPipelineProcessHost().then(() => {
      shutdownSettled = true;
    });
    completeOldCleanup();
    await expect(interrupted).rejects.toThrow(
      'Pipeline process host exited before completing its work (code 9).',
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(shutdownSettled).toBe(false);
    children[1]?.emit('exit', 0);
    await shutdown;
    expect(shutdownSettled).toBe(true);
  });

  it('retains a completed action PID until the worker acknowledges cleanup', async () => {
    const result = run();
    const request = getRunRequest(children[0]);
    children[0]?.emit('message', {
      data: { type: 'started', requestId: request.requestId, pid: 6262 },
    });
    children[0]?.emit('message', {
      data: { type: 'result', requestId: request.requestId, result: SUCCESS },
    });
    await expect(result).resolves.toEqual(SUCCESS);

    children[0]?.emit('exit', 9);
    await new Promise((resolve) => setImmediate(resolve));

    expect(killProcessGroupByPidMock).toHaveBeenCalledWith(6262, 'SIGKILL');
  });

  it('releases a completed action PID after the cleanup acknowledgement', async () => {
    const result = run();
    const request = getRunRequest(children[0]);
    children[0]?.emit('message', {
      data: { type: 'started', requestId: request.requestId, pid: 6363 },
    });
    children[0]?.emit('message', {
      data: { type: 'result', requestId: request.requestId, result: SUCCESS },
    });
    children[0]?.emit('message', {
      data: { type: 'cleanup-complete', requestId: request.requestId },
    });
    await expect(result).resolves.toEqual(SUCCESS);

    children[0]?.emit('exit', 0);
    await new Promise((resolve) => setImmediate(resolve));

    expect(killProcessGroupByPidMock).not.toHaveBeenCalled();
  });

  it('tracks the action child PID rather than the utility host PID', async () => {
    const unregister = jest.fn();
    const registerProcess = jest.fn(() => ({
      update: jest.fn(),
      unregister,
    }));
    const controller = new AbortController();
    const result = runPipelineProcessInExecutionHost(
      { command: 'node', args: ['step.js'] },
      {
        cwd: '/repo',
        env: {},
        signal: controller.signal,
        timeout_minutes: 5,
        logFile: '/tmp/step.log',
        outputFile: '/tmp/output',
        envFile: '/tmp/env',
        resource: {
          executionId: 'execution',
          jobId: 'review',
          childId: 'child-000001',
          stepId: 'analyze',
          attempt: 0,
          label: 'review / analyze',
        },
      },
      { registerProcess, registerWorkItem: jest.fn() },
    );
    const request = getRunRequest(children[0]);
    expect(request.childId).toBe('child-000001');

    children[0]?.emit('message', {
      data: { type: 'started', requestId: request.requestId, pid: 4242 },
    });
    expect(registerProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'pipeline-step:execution:review:child-000001:analyze:0:4242',
        pid: 4242,
        processGroupId: 4242,
      }),
    );
    children[0]?.emit('message', {
      data: { type: 'result', requestId: request.requestId, result: SUCCESS },
    });
    await result;
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it('asks the host to drain during app shutdown and rejects unfinished work on exit', async () => {
    const unfinished = run();
    const unfinishedExpectation = expect(unfinished).rejects.toThrow(
      'Pipeline process host exited before completing its work (code 0).',
    );
    const shutdown = shutdownPipelineProcessHost();

    expect(children[0]?.postMessage).toHaveBeenCalledWith({
      type: 'shutdown',
    });
    children[0]?.emit('exit', 0);

    await expect(shutdown).resolves.toBeUndefined();
    await unfinishedExpectation;
  });

  it('waits for exit cleanup after forcibly terminating the host', async () => {
    jest.useFakeTimers();
    try {
      let completeCleanup = (): void => undefined;
      killProcessGroupByPidMock.mockReturnValue(
        new Promise<void>((resolve) => {
          completeCleanup = resolve;
        }),
      );
      const unfinished = run();
      const unfinishedExpectation = expect(unfinished).rejects.toThrow(
        'Pipeline process host exited before completing its work (code 9).',
      );
      const request = getRunRequest(children[0]);
      children[0]?.emit('message', {
        data: { type: 'started', requestId: request.requestId, pid: 7373 },
      });

      let shutdownSettled = false;
      const shutdown = shutdownPipelineProcessHost().then(() => {
        shutdownSettled = true;
      });
      await jest.advanceTimersByTimeAsync(6_000);
      expect(children[0]?.kill).toHaveBeenCalledTimes(1);

      children[0]?.emit('exit', 9);
      await Promise.resolve();
      expect(killProcessGroupByPidMock).toHaveBeenCalledWith(7373, 'SIGKILL');
      expect(shutdownSettled).toBe(false);

      completeCleanup();
      await shutdown;
      await unfinishedExpectation;
      expect(shutdownSettled).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('waits for cleanup when the host has already exited', async () => {
    let completeCleanup = (): void => undefined;
    killProcessGroupByPidMock.mockReturnValue(
      new Promise<void>((resolve) => {
        completeCleanup = resolve;
      }),
    );
    const unfinished = run();
    const unfinishedExpectation = expect(unfinished).rejects.toThrow(
      'Pipeline process host exited before completing its work (code 9).',
    );
    const request = getRunRequest(children[0]);
    children[0]?.emit('message', {
      data: { type: 'started', requestId: request.requestId, pid: 7474 },
    });
    children[0]?.emit('exit', 9);

    let shutdownSettled = false;
    const shutdown = shutdownPipelineProcessHost().then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);

    completeCleanup();
    await shutdown;
    await unfinishedExpectation;
    expect(shutdownSettled).toBe(true);
  });
});
