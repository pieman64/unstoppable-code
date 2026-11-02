import type * as WorkerThreads from 'node:worker_threads';

/*
 * `node:worker_threads` for tests that run the real Ledger storage worker.
 * Jest runs TypeScript sources, so the worker entry runs through tsx; the app
 * starts the bundled `ledger-storage-worker.js` instead. Use it as a module
 * mock factory:
 *
 *   jest.mock('node:worker_threads', () =>
 *     jest
 *       .requireActual<typeof TsxWorkerThreads>('./fixtures/tsx-worker-threads')
 *       .createTsxWorkerThreads(),
 *   );
 */

/**
 * tsx's CommonJS hooks. Under `--import tsx` a worker entry loads as an ES
 * module, and tsx's ES module resolver cannot load workspace subpaths such as
 * `@canopy/desktop-shared/node/ledger` that name a directory.
 */
export const TSX_EXEC_ARGV: readonly string[] = ['--require', 'tsx/cjs'];

/** A worker a test started, with its exit code once it has exited. */
export interface StartedWorker {
  readonly filename: string | URL;
  readonly workerData: unknown;
  readonly exited: Promise<void>;
  exitCode: number | undefined;
}

/** Every worker started in this test file, in start order. */
export const startedWorkers: StartedWorker[] = [];

export function createTsxWorkerThreads(): typeof WorkerThreads {
  const actual = jest.requireActual<typeof WorkerThreads>(
    'node:worker_threads',
  );
  class TsxWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      const [filename, options] = args;
      super(filename, { ...options, execArgv: [...TSX_EXEC_ARGV] });
      let markExited = (): void => undefined;
      const exited = new Promise<void>((resolve) => {
        markExited = resolve;
      });
      const started: StartedWorker = {
        filename,
        workerData: options?.workerData,
        exited,
        exitCode: undefined,
      };
      this.once('exit', (exitCode: number): void => {
        started.exitCode = exitCode;
        markExited();
      });
      startedWorkers.push(started);
    }
  }
  return { ...actual, Worker: TsxWorker };
}
