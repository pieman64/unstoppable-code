import { EventEmitter } from 'node:events';
import { parseMemoryDocumentInWorker } from '../memory/local/parse-runner';

jest.mock('node:worker_threads', () => ({ Worker: jest.fn() }));

const WorkerConstructor = jest.requireMock<{
  Worker: jest.Mock;
}>('node:worker_threads').Worker;

class TestWorker extends EventEmitter {
  terminate = jest.fn((): Promise<number> => Promise.resolve(0));
}

const document = { fileKey: 'MEMORY.md', revision: 'revision', items: [] };
let workers: TestWorker[];

beforeEach(() => {
  workers = [];
  WorkerConstructor.mockReset().mockImplementation(() => {
    const worker = new TestWorker();
    workers.push(worker);
    return worker;
  });
});

afterEach(() => jest.useRealTimers());

it('returns the worker document after terminating the worker', async () => {
  const result = parseMemoryDocumentInWorker('MEMORY.md', '# Memory');
  expect(WorkerConstructor).toHaveBeenCalledWith(
    expect.stringContaining('local-memory-parse-worker.js'),
    expect.objectContaining({
      workerData: { fileKey: 'MEMORY.md', content: '# Memory' },
    }),
  );
  workers[0].emit('message', { document });
  await expect(result).resolves.toEqual(document);
  expect(workers[0].terminate).toHaveBeenCalledTimes(1);
});

it.each(['error', 'exit', 'message'])(
  'rejects a failed %s and terminates its worker',
  async (event) => {
    const result = parseMemoryDocumentInWorker('MEMORY.md', '# Memory');
    const assertion = expect(result).rejects.toThrow();
    workers[0].emit(
      event,
      event === 'error'
        ? new Error('Parser crashed')
        : event === 'exit'
          ? 0
          : { error: 'Unsafe source positions' },
    );
    await assertion;
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  },
);

it('times out and terminates an unresponsive worker', async () => {
  jest.useFakeTimers();
  const result = parseMemoryDocumentInWorker('MEMORY.md', '# Memory');
  const assertion = expect(result).rejects.toThrow('timed out');
  await jest.advanceTimersByTimeAsync(30_000);
  await assertion;
  expect(workers[0].terminate).toHaveBeenCalledTimes(1);
});

it('limits active workers and starts queued reads when a worker finishes', async () => {
  const results = Array.from({ length: 3 }, () =>
    parseMemoryDocumentInWorker('MEMORY.md', '# Memory'),
  );
  expect(workers).toHaveLength(2);
  workers[0].emit('message', { document });
  await results[0];
  expect(workers).toHaveLength(3);
  workers[1].emit('message', { document });
  workers[2].emit('message', { document });
  await Promise.all(results);
});

it('rejects constructor failures without occupying a worker slot', async () => {
  WorkerConstructor.mockImplementationOnce(() => {
    throw new Error('Worker unavailable');
  });
  await expect(
    parseMemoryDocumentInWorker('MEMORY.md', '# Memory'),
  ).rejects.toThrow('Worker unavailable');
  const result = parseMemoryDocumentInWorker('MEMORY.md', '# Memory');
  workers[0].emit('message', { document });
  await expect(result).resolves.toEqual(document);
});

it('bounds queued work and expires queued requests without starting them', async () => {
  jest.useFakeTimers();
  const requests = Array.from({ length: 16 }, () =>
    parseMemoryDocumentInWorker('MEMORY.md', '# Memory'),
  );
  const all = Promise.allSettled(requests);
  await expect(
    parseMemoryDocumentInWorker('MEMORY.md', '# Memory'),
  ).rejects.toThrow('busy');
  await jest.advanceTimersByTimeAsync(30_000);
  expect((await all).every((result) => result.status === 'rejected')).toBe(
    true,
  );
  expect(workers).toHaveLength(2);
  expect(
    workers.every((worker) => worker.terminate.mock.calls.length === 1),
  ).toBe(true);
});
