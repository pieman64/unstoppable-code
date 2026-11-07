import { randomUUID } from 'node:crypto';

import type {
  WorkerScriptExecuteResult,
  WorkerScriptExecution,
  WorkerScriptExecutionOutputParams,
} from '@canopy/protocol/canopy-core';

import {
  runScriptRemotely,
  type RemoteScriptOutputFrame,
  type RemoteScriptRunRequest,
  type RemoteScriptTransport,
} from '..';
import { canopyDeadlineExceededError } from '../../../../runtime/errors';
import { SCOPE, scriptParams } from './script-worker-fixtures';

const UNREACHABLE = new Error('unreachable');

interface Opened {
  readonly params: WorkerScriptExecutionOutputParams;
  readonly onFrame: (frame: RemoteScriptOutputFrame) => void;
}

interface FakeTransport extends RemoteScriptTransport {
  readonly opened: Opened[];
  readonly execute: jest.Mock<
    ReturnType<RemoteScriptTransport['execute']>,
    Parameters<RemoteScriptTransport['execute']>
  >;
  readonly cancel: jest.Mock<
    ReturnType<RemoteScriptTransport['cancel']>,
    Parameters<RemoteScriptTransport['cancel']>
  >;
  readonly readRun: jest.Mock<
    ReturnType<RemoteScriptTransport['readRun']>,
    Parameters<RemoteScriptTransport['readRun']>
  >;
}

function fakeTransport(
  options: {
    readonly openOutput?: (opened: Opened) => Promise<void>;
  } = {},
): FakeTransport {
  const opened: Opened[] = [];
  return {
    opened,
    openOutput: async (params, onFrame): Promise<{ close(): void }> => {
      const entry = { params, onFrame };
      opened.push(entry);
      await options.openOutput?.(entry);
      return { close: (): void => undefined };
    },
    execute: jest.fn<
      ReturnType<RemoteScriptTransport['execute']>,
      Parameters<RemoteScriptTransport['execute']>
    >(() => Promise.reject(new Error('not scripted'))),
    cancel: jest.fn<
      ReturnType<RemoteScriptTransport['cancel']>,
      Parameters<RemoteScriptTransport['cancel']>
    >(() => Promise.resolve({ stopped: [] })),
    readRun: jest.fn<
      ReturnType<RemoteScriptTransport['readRun']>,
      Parameters<RemoteScriptTransport['readRun']>
    >(() => Promise.resolve(null)),
    isUnreachable: (error) => error === UNREACHABLE,
  };
}

function result(
  executionId: string,
  status: WorkerScriptExecuteResult['status'],
): WorkerScriptExecuteResult {
  return {
    executionId,
    status,
    exitCode: status === 'success' ? 0 : null,
    timedOut: false,
    durationMs: 5,
    outputBytes: 3,
    outputTruncated: false,
    recorded: true,
  };
}

function record(
  executionId: string,
  status: WorkerScriptExecution['status'],
): WorkerScriptExecution {
  const params = scriptParams('true');
  if (params.record === undefined) throw new Error('No record.');
  return {
    executionId,
    script: params.record.script,
    invocation: 'manual-run',
    status,
    startedAt: new Date(0).toISOString(),
    completedAt: status === 'running' ? null : new Date(1).toISOString(),
    exitCode: status === 'success' ? 0 : null,
    timedOut: false,
    durationMs: 7,
  };
}

function request(
  overrides: Partial<RemoteScriptRunRequest> = {},
): RemoteScriptRunRequest & {
  readonly relayed: string[];
} {
  const relayed: string[] = [];
  return {
    params: scriptParams('echo'),
    execution: { childEnvironment: { PATH: '/usr/bin:/bin' } },
    signal: new AbortController().signal,
    relay: {
      started: () => relayed.push('started'),
      lines: (lines) => relayed.push(`lines:${lines.join(',')}`),
    },
    createIdempotencyKey: randomUUID,
    pollIntervalMs: 5,
    drainTimeoutMs: 20,
    relayed,
    ...overrides,
  };
}

function frame(
  opened: Opened | undefined,
  value: RemoteScriptOutputFrame,
): void {
  if (opened === undefined) throw new Error('The stream is not open.');
  opened.onFrame(value);
}

afterEach(() => {
  jest.useRealTimers();
});

it('relays started and lines and returns the result with the streamed output', async () => {
  const transport = fakeTransport();
  const run = request();
  transport.execute.mockImplementation((params) => {
    frame(transport.opened[0], { kind: 'item', item: { kind: 'started' } });
    frame(transport.opened[0], {
      kind: 'item',
      item: { kind: 'lines', lines: ['a', 'b'], truncated: false },
    });
    frame(transport.opened[0], { kind: 'end', completed: true });
    return Promise.resolve(result(params.executionId, 'success'));
  });
  const outcome = await runScriptRemotely(transport, run);
  expect(outcome).toEqual({
    kind: 'finished',
    result: result(run.params.executionId, 'success'),
    output: 'a\nb',
  });
  expect(run.relayed).toEqual(['started', 'lines:a,b']);
  expect(transport.opened[0]?.params).toEqual({
    scope: SCOPE,
    executionId: run.params.executionId,
    awaitStart: true,
  });
  const anyKey: unknown = expect.any(String);
  expect(transport.execute).toHaveBeenCalledWith(run.params, {
    idempotencyKey: anyKey,
    execution: run.execution,
  });
});

it('drains output queued behind the execute reply before it returns', async () => {
  const transport = fakeTransport();
  const run = request({ drainTimeoutMs: 1_000 });
  transport.execute.mockImplementation((params) => {
    frame(transport.opened[0], { kind: 'item', item: { kind: 'started' } });
    frame(transport.opened[0], {
      kind: 'item',
      item: { kind: 'lines', lines: ['a'], truncated: false },
    });
    setTimeout(() => {
      frame(transport.opened[0], {
        kind: 'item',
        item: { kind: 'lines', lines: ['tail'], truncated: false },
      });
      frame(transport.opened[0], { kind: 'end', completed: true });
    }, 5);
    return Promise.resolve(result(params.executionId, 'success'));
  });
  const outcome = await runScriptRemotely(transport, run);
  expect(outcome).toMatchObject({
    kind: 'finished',
    output: 'a\ntail',
    result: { outputTruncated: false },
  });
  expect(run.relayed).toEqual(['started', 'lines:a', 'lines:tail']);

  // A stream that never ends leaves the last lines unknown.
  const silent = fakeTransport();
  silent.execute.mockImplementation((params) =>
    Promise.resolve(result(params.executionId, 'success')),
  );
  const unconfirmed = await runScriptRemotely(silent, request());
  if (unconfirmed.kind !== 'finished')
    throw new Error('The run did not finish.');
  expect(unconfirmed.result.outputTruncated).toBe(true);
});

it('sends nothing when the output stream cannot be opened', async () => {
  const unreachable = fakeTransport({
    openOutput: () => Promise.reject(UNREACHABLE),
  });
  await expect(runScriptRemotely(unreachable, request())).resolves.toEqual({
    kind: 'not-started',
    reason: 'unreachable',
  });
  const refused = fakeTransport({
    openOutput: () => Promise.reject(new Error('refused')),
  });
  await expect(runScriptRemotely(refused, request())).resolves.toEqual({
    kind: 'not-started',
    reason: 'refused',
  });
  expect(unreachable.execute).not.toHaveBeenCalled();
  expect(refused.execute).not.toHaveBeenCalled();
});

it('cancels on abort and returns the cancelled result', async () => {
  const transport = fakeTransport();
  const abort = new AbortController();
  const run = request({ signal: abort.signal });
  let finish = (): void => undefined;
  transport.execute.mockImplementation(
    (params) =>
      new Promise((resolve) => {
        finish = (): void => resolve(result(params.executionId, 'cancelled'));
        frame(transport.opened[0], { kind: 'item', item: { kind: 'started' } });
      }),
  );
  transport.cancel.mockImplementation(() => {
    finish();
    return Promise.resolve({
      stopped: [result(run.params.executionId, 'cancelled')],
    });
  });
  const running = runScriptRemotely(transport, run);
  await new Promise((resolve) => setImmediate(resolve));
  expect(run.relayed).toEqual(['started']);
  abort.abort();
  await expect(running).resolves.toMatchObject({
    kind: 'finished',
    result: { status: 'cancelled' },
  });
  expect(transport.cancel).toHaveBeenCalledTimes(1);
  const [cancelParams, cancelOptions] = transport.cancel.mock.calls[0] ?? [];
  expect(cancelParams).toEqual({
    scope: SCOPE,
    scriptKey: 'dev',
    executionId: run.params.executionId,
  });
  expect(cancelOptions?.idempotencyKey).not.toBe(
    transport.execute.mock.calls[0]?.[1].idempotencyKey,
  );
});

it('keeps cancelling until the daemon has admitted the run and stopped it', async () => {
  const transport = fakeTransport();
  const abort = new AbortController();
  const run = request({ signal: abort.signal });
  let admitted = false;
  let finish = (): void => undefined;
  transport.execute.mockImplementation(
    (params) =>
      new Promise((resolve) => {
        finish = (): void => resolve(result(params.executionId, 'cancelled'));
      }),
  );
  transport.cancel.mockImplementation(() => {
    if (!admitted) return Promise.resolve({ stopped: [] });
    finish();
    return Promise.resolve({
      stopped: [result(run.params.executionId, 'cancelled')],
    });
  });
  const running = runScriptRemotely(transport, run);
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  await new Promise((resolve) => setTimeout(resolve, 20));
  admitted = true;
  const outcome = await Promise.race([
    running,
    new Promise((resolve) => setTimeout(() => resolve('stuck'), 500)),
  ]);
  expect(outcome).toMatchObject({
    kind: 'finished',
    result: { status: 'cancelled' },
  });
  // A key whose cancel stopped nothing is never sent again: its answer is kept.
  const keys = transport.cancel.mock.calls.map(
    ([, options]) => options.idempotencyKey,
  );
  expect(new Set(keys).size).toBe(keys.length);
});

it('follows the run log after a dropped connection and never sends the run again', async () => {
  const transport = fakeTransport();
  const run = request();
  const id = run.params.executionId;
  transport.execute.mockRejectedValue(UNREACHABLE);
  transport.readRun
    .mockResolvedValueOnce(record(id, 'running'))
    .mockResolvedValueOnce(record(id, 'running'))
    .mockResolvedValue(record(id, 'success'));
  const outcome = await runScriptRemotely(transport, run);
  expect(outcome).toMatchObject({
    kind: 'finished',
    result: {
      executionId: id,
      status: 'success',
      exitCode: 0,
      durationMs: 7,
      recorded: true,
    },
  });
  expect(transport.execute).toHaveBeenCalledTimes(1);
  expect(transport.readRun).toHaveBeenCalledWith(SCOPE, 'dev');
});

it('follows the run log when execute passes its deadline', async () => {
  const transport = fakeTransport();
  const run = request();
  const id = run.params.executionId;
  transport.execute.mockRejectedValue(
    canopyDeadlineExceededError('The request passed its deadline.'),
  );
  transport.readRun
    .mockResolvedValueOnce(record(id, 'running'))
    .mockResolvedValue(record(id, 'success'));
  await expect(runScriptRemotely(transport, run)).resolves.toMatchObject({
    kind: 'finished',
    result: { status: 'success', recorded: true },
  });
  expect(transport.execute).toHaveBeenCalledTimes(1);
  expect(transport.readRun).toHaveBeenCalled();
});

it('keeps cancelling while it follows the run log until the daemon takes the cancel', async () => {
  const transport = fakeTransport();
  const abort = new AbortController();
  const run = request({ signal: abort.signal });
  const id = run.params.executionId;
  let accepted = false;
  transport.execute.mockRejectedValue(UNREACHABLE);
  transport.cancel
    .mockRejectedValueOnce(UNREACHABLE)
    .mockRejectedValueOnce(UNREACHABLE)
    .mockImplementation(() => {
      accepted = true;
      return Promise.resolve({ stopped: [result(id, 'cancelled')] });
    });
  transport.readRun.mockImplementation(() => {
    abort.abort();
    return Promise.resolve(record(id, accepted ? 'cancelled' : 'running'));
  });
  const outcome = await runScriptRemotely(transport, run);
  expect(outcome).toMatchObject({
    kind: 'finished',
    result: { status: 'cancelled', recorded: true },
  });
  expect(transport.cancel.mock.calls.length).toBeGreaterThanOrEqual(3);
  const keys = new Set(
    transport.cancel.mock.calls.map(([, options]) => options.idempotencyKey),
  );
  expect(keys.size).toBe(1);
  expect(transport.execute).toHaveBeenCalledTimes(1);
});

it('reports the output cut when the streamed lines pass the cap', async () => {
  const transport = fakeTransport();
  const run = request();
  const id = run.params.executionId;
  const line = 'x'.repeat(8_000);
  transport.execute.mockImplementation(() => {
    frame(transport.opened[0], { kind: 'item', item: { kind: 'started' } });
    for (let index = 0; index < 40; index += 1)
      frame(transport.opened[0], {
        kind: 'item',
        item: { kind: 'lines', lines: [line], truncated: false },
      });
    return Promise.reject(UNREACHABLE);
  });
  transport.readRun.mockResolvedValue(record(id, 'success'));
  const outcome = await runScriptRemotely(transport, run);
  if (outcome.kind !== 'finished') throw new Error('The run did not finish.');
  expect(outcome.result.outputTruncated).toBe(true);
  expect(outcome.result.outputBytes).toBeLessThanOrEqual(256 * 1024);
});

it('reports output lost when the stream drops and the run settles before the first poll', async () => {
  const dropped = fakeTransport();
  const droppedRun = request();
  dropped.execute.mockImplementation(() => {
    frame(dropped.opened[0], { kind: 'item', item: { kind: 'started' } });
    frame(dropped.opened[0], { kind: 'end' });
    return Promise.reject(UNREACHABLE);
  });
  dropped.readRun.mockResolvedValue(
    record(droppedRun.params.executionId, 'success'),
  );
  const lost = await runScriptRemotely(dropped, droppedRun);
  if (lost.kind !== 'finished') throw new Error('The run did not finish.');
  expect(lost.result.outputTruncated).toBe(true);

  const finished = fakeTransport();
  const finishedRun = request();
  finished.execute.mockImplementation(() => {
    frame(finished.opened[0], { kind: 'item', item: { kind: 'started' } });
    frame(finished.opened[0], { kind: 'end', completed: true });
    return Promise.reject(UNREACHABLE);
  });
  finished.readRun.mockResolvedValue(
    record(finishedRun.params.executionId, 'success'),
  );
  const complete = await runScriptRemotely(finished, finishedRun);
  if (complete.kind !== 'finished') throw new Error('The run did not finish.');
  expect(complete.result.outputTruncated).toBe(false);
});

it('reports a cut streamed line in the result of a completed run', async () => {
  const transport = fakeTransport();
  const run = request();
  transport.execute.mockImplementation((params) => {
    frame(transport.opened[0], { kind: 'item', item: { kind: 'started' } });
    frame(transport.opened[0], {
      kind: 'item',
      item: { kind: 'lines', lines: ['x'.repeat(8_192)], truncated: true },
    });
    return Promise.resolve({
      ...result(params.executionId, 'success'),
      outputTruncated: false,
    });
  });
  const outcome = await runScriptRemotely(transport, run);
  if (outcome.kind !== 'finished') throw new Error('The run did not finish.');
  expect(outcome.result.outputTruncated).toBe(true);
});

it('reports the output incomplete when the stream cut a line or dropped lines', async () => {
  const transport = fakeTransport();
  const run = request();
  const id = run.params.executionId;
  transport.execute.mockImplementation(() => {
    frame(transport.opened[0], { kind: 'item', item: { kind: 'started' } });
    frame(transport.opened[0], {
      kind: 'item',
      item: { kind: 'lines', lines: ['x'.repeat(8_192)], truncated: true },
    });
    frame(transport.opened[0], {
      kind: 'item',
      item: { kind: 'gap', droppedLines: 10 },
    });
    return Promise.reject(UNREACHABLE);
  });
  transport.readRun.mockResolvedValue(record(id, 'success'));
  const outcome = await runScriptRemotely(transport, run);
  if (outcome.kind !== 'finished') throw new Error('The run did not finish.');
  expect(outcome.result.outputTruncated).toBe(true);
});

it('reattaches the output stream while it follows the run log', async () => {
  const transport = fakeTransport({
    openOutput: (opened) => {
      if (opened.params.awaitStart === false) {
        opened.onFrame({
          kind: 'item',
          item: { kind: 'lines', lines: ['late'], truncated: false },
        });
      }
      return Promise.resolve();
    },
  });
  const run = request();
  const id = run.params.executionId;
  transport.execute.mockImplementation(() => {
    frame(transport.opened[0], { kind: 'item', item: { kind: 'started' } });
    frame(transport.opened[0], { kind: 'end' });
    return Promise.reject(UNREACHABLE);
  });
  transport.readRun
    .mockResolvedValueOnce(record(id, 'running'))
    .mockResolvedValue(record(id, 'success'));
  const outcome = await runScriptRemotely(transport, run);
  expect(transport.opened.map(({ params }) => params.awaitStart)).toEqual([
    true,
    false,
  ]);
  expect(run.relayed).toEqual(['started', 'lines:late']);
  expect(outcome).toMatchObject({ kind: 'finished', output: 'late' });
  // Lines written while the stream was detached are lost.
  if (outcome.kind === 'finished')
    expect(outcome.result.outputTruncated).toBe(true);
});

it('fails as placementUnreachable when the run never appears or another run replaces it', async () => {
  jest.useFakeTimers();
  const placementUnreachable = {
    payload: { code: 'worker.script.placementUnreachable' },
  };

  const never = fakeTransport();
  never.execute.mockRejectedValue(UNREACHABLE);
  const missing = runScriptRemotely(never, request({ pollIntervalMs: 1_000 }));
  const missingSettled =
    expect(missing).rejects.toMatchObject(placementUnreachable);
  await jest.advanceTimersByTimeAsync(30_000);
  await missingSettled;

  const replaced = fakeTransport();
  replaced.execute.mockImplementation(() => {
    frame(replaced.opened[0], { kind: 'item', item: { kind: 'started' } });
    return Promise.reject(UNREACHABLE);
  });
  replaced.readRun.mockResolvedValue(record(randomUUID(), 'running'));
  const later = runScriptRemotely(replaced, request({ pollIntervalMs: 1_000 }));
  const laterSettled =
    expect(later).rejects.toMatchObject(placementUnreachable);
  await jest.advanceTimersByTimeAsync(1_000);
  await laterSettled;
});

it('fails as placementUnreachable when an observed run leaves the log', async () => {
  jest.useFakeTimers();
  const transport = fakeTransport();
  const run = request({ pollIntervalMs: 1_000 });
  transport.execute.mockRejectedValue(UNREACHABLE);
  transport.readRun
    .mockResolvedValueOnce(record(run.params.executionId, 'running'))
    .mockRejectedValueOnce(new Error('unreadable'))
    .mockResolvedValue(null);
  let settled: unknown = 'pending';
  void runScriptRemotely(transport, run).then(
    () => {
      settled = 'resolved';
    },
    (error: unknown) => {
      settled = error;
    },
  );
  await jest.advanceTimersByTimeAsync(32_000);
  expect(settled).toMatchObject({
    payload: { code: 'worker.script.placementUnreachable' },
  });
});

it('reopens the output stream again when a reopened stream ends while it opens', async () => {
  let reopens = 0;
  const transport = fakeTransport({
    openOutput: (opened) => {
      if (opened.params.awaitStart !== false) return Promise.resolve();
      reopens += 1;
      opened.onFrame(
        reopens === 1
          ? { kind: 'end' }
          : {
              kind: 'item',
              item: { kind: 'lines', lines: ['late'], truncated: false },
            },
      );
      return Promise.resolve();
    },
  });
  const run = request();
  const id = run.params.executionId;
  transport.execute.mockImplementation(() => {
    frame(transport.opened[0], { kind: 'item', item: { kind: 'started' } });
    frame(transport.opened[0], { kind: 'end' });
    return Promise.reject(UNREACHABLE);
  });
  transport.readRun
    .mockResolvedValueOnce(record(id, 'running'))
    .mockResolvedValueOnce(record(id, 'running'))
    .mockResolvedValueOnce(record(id, 'running'))
    .mockResolvedValue(record(id, 'success'));
  const outcome = await runScriptRemotely(transport, run);
  expect(transport.opened.map(({ params }) => params.awaitStart)).toEqual([
    true,
    false,
    false,
  ]);
  expect(outcome).toMatchObject({ kind: 'finished', output: 'late' });
});
