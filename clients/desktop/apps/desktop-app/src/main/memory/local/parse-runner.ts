import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { LocalMemoryDocument } from '@canopy/desktop-shared/types';

const queued: Array<() => void> = [];
let active = 0;
let pending = 0;

function pump(): void {
  while (active < 2 && queued.length) queued.shift()?.();
}

export function parseMemoryDocumentInWorker(
  fileKey: string,
  content: string,
): Promise<LocalMemoryDocument> {
  if (pending >= 16)
    return Promise.reject(new Error('Memory parser is busy. Try again.'));
  if (Buffer.byteLength(content, 'utf8') > 512 * 1024)
    return Promise.reject(new Error('This memory file is too large to open.'));
  pending += 1;
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    let worker: Worker | undefined;
    let started = false;
    let settled = false;
    const finish = (error?: Error, document?: LocalMemoryDocument): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const index = queued.indexOf(start);
      if (index >= 0) queued.splice(index, 1);
      const release = (cleanupError?: unknown): void => {
        pending -= 1;
        if (started) active -= 1;
        if (error || cleanupError)
          reject(
            error ??
              (cleanupError instanceof Error
                ? cleanupError
                : new Error('Memory parser cleanup failed')),
          );
        else if (document) resolve(document);
        else reject(new Error('Memory parser returned no document'));
        pump();
      };
      if (worker) void worker.terminate().then(() => release(), release);
      else release();
    };
    const timer = setTimeout(
      () => finish(new Error('Memory parsing timed out')),
      30_000,
    );
    const start = (): void => {
      if (Date.now() >= deadline) {
        finish(new Error('Memory parsing timed out'));
        return;
      }
      started = true;
      active += 1;
      try {
        worker = new Worker(join(__dirname, 'local-memory-parse-worker.js'), {
          workerData: { fileKey, content },
          resourceLimits: { maxOldGenerationSizeMb: 256 },
        });
        worker.once('error', (error: Error) => finish(error));
        worker.once('exit', (code) =>
          finish(new Error(`Memory parser exited (${code})`)),
        );
        worker.once(
          'message',
          (message: { document?: LocalMemoryDocument; error?: string }) => {
            if (message.document) finish(undefined, message.document);
            else
              finish(
                new Error(
                  message.error ?? 'Memory parser returned no document',
                ),
              );
          },
        );
      } catch (error) {
        finish(
          error instanceof Error
            ? error
            : new Error('Memory parser could not start'),
        );
      }
    };
    queued.push(start);
    pump();
  });
}
