import { EventEmitter } from 'node:events';
import type { SpawnedProcessSpec } from '@canopy/desktop-shared/node/pipelines/executor/types';
import type { LocalSpawnedProcessOptions } from '@canopy/desktop-shared/node/pipelines/executor/spawned-process';
import type { SpawnedProcessResult } from '@canopy/desktop-shared/node/pipelines/executor/types';
import type {
  PipelineProcessHostResponse,
  PipelineProcessHostRunRequest,
} from '../pipelines/process-host-protocol';

const runSpawnedProcessLocallyMock = jest.fn<
  Promise<SpawnedProcessResult>,
  [SpawnedProcessSpec, LocalSpawnedProcessOptions]
>();
jest.mock(
  '@canopy/desktop-shared/node/pipelines/executor/spawned-process',
  () => ({
    runSpawnedProcessLocally: (
      ...args: [SpawnedProcessSpec, LocalSpawnedProcessOptions]
    ): Promise<SpawnedProcessResult> => runSpawnedProcessLocallyMock(...args),
  }),
);

import { startPipelineProcessHost } from '../pipelines/process-host-worker';
import type { ParentPort } from 'electron';

class FakeParentPort extends EventEmitter implements ParentPort {
  public readonly postMessage = jest.fn<void, [PipelineProcessHostResponse]>();
}

function isOutputResponse(
  response: PipelineProcessHostResponse,
): response is Extract<PipelineProcessHostResponse, { type: 'output' }> {
  return response.type === 'output';
}

const SUCCESS: SpawnedProcessResult = {
  status: 'success',
  conclusion: 'success',
  outcome: 'success',
  exit_code: 0,
  outputs: {},
  dynamic_env: {},
  log_file: '/tmp/step.log',
};

function runRequest(requestId: string): PipelineProcessHostRunRequest {
  return {
    type: 'run' as const,
    requestId,
    processSpec: { command: 'node', args: ['step.js'] },
    options: {
      cwd: '/repo',
      env: {},
      timeout_minutes: 5,
      logFile: '/tmp/step.log',
      outputFile: '/tmp/output',
      envFile: '/tmp/env',
    },
  };
}

describe('pipeline process host worker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('coalesces many action chunks before crossing into Electron main', async () => {
    const parent = new FakeParentPort();
    runSpawnedProcessLocallyMock.mockImplementation((_spec, options) => {
      options.onSpawn?.(42);
      for (let index = 0; index < 20; index += 1) {
        options.onOutput?.('stdout', 'x'.repeat(4 * 1024));
      }
      return Promise.resolve(SUCCESS);
    });
    startPipelineProcessHost(parent);

    parent.emit('message', { data: runRequest('run-1') });
    await new Promise((resolve) => setImmediate(resolve));

    const outputMessages = parent.postMessage.mock.calls
      .map(([message]) => message)
      .filter(isOutputResponse);
    expect(outputMessages).toHaveLength(2);
    expect(
      outputMessages.reduce(
        (total, message) => total + (message.data?.length ?? 0),
        0,
      ),
    ).toBe(20 * 4 * 1024);
    expect(parent.postMessage).toHaveBeenCalledWith({
      type: 'result',
      requestId: 'run-1',
      result: SUCCESS,
    });
  });

  it('does not copy its pending output again for every small append', async () => {
    // Appending by concatenating the whole pending batch each time made N
    // small appends cost N copies of up to a batch each. Output is still
    // exact and ordered, with multibyte characters split across appends.
    const parent = new FakeParentPort();
    const pieces = Array.from({ length: 20_000 }, (_, index) =>
      index % 7 === 0 ? '\u{1F642}' : 'y',
    );
    runSpawnedProcessLocallyMock.mockImplementation((_spec, options) => {
      options.onSpawn?.(42);
      for (const piece of pieces) options.onOutput?.('stdout', piece);
      options.onOutput?.('stderr', 'err');
      options.onOutput?.('stdout', 'tail');
      return Promise.resolve(SUCCESS);
    });
    // Only the batcher's own copies: lazily loaded modules also call
    // Buffer.concat while the run is in flight.
    const realConcat = Buffer.concat.bind(Buffer);
    let batcherCopies = 0;
    const concat = jest
      .spyOn(Buffer, 'concat')
      .mockImplementation((list, totalLength) => {
        if (new Error().stack?.includes('/pipelines/process-host-worker'))
          batcherCopies += 1;
        return realConcat(list, totalLength);
      });
    try {
      startPipelineProcessHost(parent);
      parent.emit('message', { data: runRequest('run-small') });
      await new Promise((resolve) => setImmediate(resolve));
      const outputMessages = parent.postMessage.mock.calls
        .map(([message]) => message)
        .filter(isOutputResponse);
      const byStream = (stream: string): string =>
        outputMessages
          .filter((message) => message.stream === stream)
          .map((message) => message.data ?? '')
          .join('');
      expect(byStream('stdout')).toBe(`${pieces.join('')}tail`);
      expect(byStream('stderr')).toBe('err');
      expect(outputMessages.map((message) => message.stream).slice(-2)).toEqual(
        ['stderr', 'stdout'],
      );
      // At most one concatenation per message sent, not one per append.
      expect(batcherCopies).toBeLessThanOrEqual(outputMessages.length);
    } finally {
      concat.mockRestore();
    }
  });

  it('splits one oversized multibyte append into byte-bounded messages', async () => {
    const parent = new FakeParentPort();
    const output = `${'🙂'.repeat(20_000)}${'x'.repeat(70_000)}`;
    runSpawnedProcessLocallyMock.mockImplementation((_spec, options) => {
      options.onOutput?.('stdout', output);
      return Promise.resolve(SUCCESS);
    });
    startPipelineProcessHost(parent);

    parent.emit('message', { data: runRequest('oversized') });
    await new Promise((resolve) => setImmediate(resolve));

    const outputMessages = parent.postMessage.mock.calls
      .map(([message]) => message)
      .filter(isOutputResponse)
      .filter((message) => message.stream === 'stdout');
    expect(outputMessages.length).toBeGreaterThan(2);
    expect(
      outputMessages.every(
        (message) => Buffer.byteLength(message.data ?? '', 'utf8') <= 64 * 1024,
      ),
    ).toBe(true);
    expect(outputMessages.map((message) => message.data ?? '').join('')).toBe(
      output,
    );
  });

  it('preserves interleaved stdout and stderr ordering', async () => {
    const parent = new FakeParentPort();
    runSpawnedProcessLocallyMock.mockImplementation((_spec, options) => {
      options.onOutput?.('stdout', 'first');
      options.onOutput?.('stderr', 'second');
      options.onOutput?.('stdout', 'third');
      return Promise.resolve(SUCCESS);
    });
    startPipelineProcessHost(parent);

    parent.emit('message', { data: runRequest('interleaved') });
    await new Promise((resolve) => setImmediate(resolve));

    expect(
      parent.postMessage.mock.calls
        .map(([message]) => message)
        .filter(isOutputResponse)
        .map(({ stream, data }) => ({ stream, data })),
    ).toEqual([
      { stream: 'stdout', data: 'first' },
      { stream: 'stderr', data: 'second' },
      { stream: 'stdout', data: 'third' },
    ]);
  });

  it('posts exactly the written bytes in write order, so main can position batches by counting', async () => {
    // Electron main stamps each output message with the log offset it
    // occupies by summing the UTF-8 bytes of earlier messages. That is exact
    // only if the concatenated messages are the concatenated writes: same
    // bytes, same order, split only at character boundaries.
    const parent = new FakeParentPort();
    const writes: Array<['stdout' | 'stderr', string]> = [
      ['stdout', 'caf'],
      ['stdout', 'é '],
      ['stderr', 'warn 🙂\n'],
      ['stdout', `${'🙂'.repeat(17_000)}é`],
      ['stdout', 'x'.repeat(3)],
      ['stderr', 'e'],
      ['stdout', 'tail\n'],
    ];
    runSpawnedProcessLocallyMock.mockImplementation((_spec, options) => {
      for (const [stream, data] of writes) options.onOutput?.(stream, data);
      return Promise.resolve(SUCCESS);
    });
    startPipelineProcessHost(parent);

    parent.emit('message', { data: runRequest('positioned') });
    await new Promise((resolve) => setImmediate(resolve));

    const outputMessages = parent.postMessage.mock.calls
      .map(([message]) => message)
      .filter(isOutputResponse);
    expect(outputMessages.length).toBeGreaterThan(writes.length - 3);
    const posted = Buffer.concat(
      outputMessages.map((message) => Buffer.from(message.data ?? '', 'utf8')),
    );
    const written = Buffer.concat(
      writes.map(([, data]) => Buffer.from(data, 'utf8')),
    );
    expect(posted).toEqual(written);
    // Stream switches land exactly where the writes switched streams.
    let offset = 0;
    const switches: number[] = [];
    outputMessages.forEach((message, index) => {
      if (index > 0 && outputMessages[index - 1]?.stream !== message.stream) {
        switches.push(offset);
      }
      offset += Buffer.byteLength(message.data ?? '', 'utf8');
    });
    const byteLength = (text: string): number =>
      Buffer.byteLength(text, 'utf8');
    const writeSwitches: number[] = [];
    let writeOffset = 0;
    writes.forEach(([stream, data], index) => {
      if (index > 0 && writes[index - 1]?.[0] !== stream) {
        writeSwitches.push(writeOffset);
      }
      writeOffset += byteLength(data);
    });
    expect(switches).toEqual(writeSwitches);
  });

  it('aborts the matching action without affecting concurrent work', async () => {
    const parent = new FakeParentPort();
    const signals = new Map<string, AbortSignal>();
    runSpawnedProcessLocallyMock.mockImplementation((spec, options) => {
      const id = spec.args[0] ?? '';
      signals.set(id, options.signal);
      return new Promise<SpawnedProcessResult>((resolve) => {
        options.signal.addEventListener('abort', () =>
          resolve({
            ...SUCCESS,
            status: 'cancelled',
            conclusion: 'cancelled',
            outcome: 'cancelled',
          }),
        );
      });
    });
    startPipelineProcessHost(parent);
    const first = runRequest('first');
    first.processSpec.args = ['first'];
    const second = runRequest('second');
    second.processSpec.args = ['second'];

    parent.emit('message', { data: first });
    parent.emit('message', { data: second });
    parent.emit('message', {
      data: { type: 'cancel', requestId: 'first' },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(signals.get('first')?.aborted).toBe(true);
    expect(signals.get('second')?.aborted).toBe(false);
    expect(parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'result', requestId: 'first' }),
    );
  });

  it('waits for post-result process cleanup before completing shutdown', async () => {
    const parent = new FakeParentPort();
    const exitProcess = jest.fn<void, [number]>();
    let completeCleanup = (): void => undefined;
    const cleanup = new Promise<void>((resolve) => {
      completeCleanup = resolve;
    });
    runSpawnedProcessLocallyMock.mockImplementation((_spec, options) => {
      options.onProcessCleanup?.(cleanup);
      return Promise.resolve(SUCCESS);
    });
    startPipelineProcessHost(parent, exitProcess);

    parent.emit('message', { data: runRequest('cleanup') });
    await new Promise((resolve) => setImmediate(resolve));
    expect(parent.postMessage).toHaveBeenCalledWith({
      type: 'result',
      requestId: 'cleanup',
      result: SUCCESS,
    });
    expect(parent.postMessage).not.toHaveBeenCalledWith({
      type: 'cleanup-complete',
      requestId: 'cleanup',
    });

    parent.emit('message', { data: { type: 'shutdown' } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(parent.postMessage).not.toHaveBeenCalledWith({
      type: 'shutdown-complete',
    });
    expect(exitProcess).not.toHaveBeenCalled();

    completeCleanup();
    await new Promise((resolve) => setImmediate(resolve));

    expect(parent.postMessage).toHaveBeenCalledWith({
      type: 'cleanup-complete',
      requestId: 'cleanup',
    });
    expect(parent.postMessage).toHaveBeenCalledWith({
      type: 'shutdown-complete',
    });
    expect(exitProcess).toHaveBeenCalledWith(0);
  });
});
