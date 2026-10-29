import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

// The hashing worker is a separately bundled thread-worker entry
// (`runtime-hash-worker.ts`, registered in scripts/lib/utility-worker-entries.mjs
// and built by electron.vite.config.ts next to the main bundle). Paths are
// data, never code.
const HASH_WORKER = join(__dirname, 'cursor-runtime-hash-worker.js');

interface HashRequest {
  path: string;
  kind: 'directory' | 'file';
  maxBytes: number;
  maxEntries: number;
  executables?: readonly string[];
}

// One verifier at a time bounds CPU/disk pressure across concurrent chats.
// Cancelled queued requests return immediately and never launch a worker.
let pending: Promise<void> = Promise.resolve();
export async function hashCursorRuntime(
  request: HashRequest,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  let started = false;
  const scheduled = pending.then(() => {
    started = true;
    return runWorker(request, signal);
  });
  pending = scheduled.then(
    () => undefined,
    () => undefined,
  );
  let cancel = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = (): void =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('Cursor verification stopped.'),
      );
    signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    const result = await Promise.race([scheduled, aborted]);
    signal.throwIfAborted();
    return result;
  } catch (error) {
    if (started) await scheduled.catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

async function runWorker(
  request: HashRequest,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const worker = new Worker(HASH_WORKER, {
    workerData: request,
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 32 },
  });
  let cancel = (): void => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      cancel = (): void =>
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error('Cursor verification stopped.'),
        );
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      // A full-tree fingerprint hashes the whole ~584 MB runtime; give it a
      // larger budget than a single-file digest so a slow disk is not reported
      // as a damaged installation.
      timer = setTimeout(
        () => reject(new Error('Cursor verification timed out.')),
        request.kind === 'directory' ? 180_000 : 60_000,
      );
      worker.once('message', (digest: unknown) => {
        if (typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest))
          resolve(digest);
        else reject(new Error('Invalid Cursor verification result.'));
      });
      worker.once('error', reject);
      worker.once('exit', () =>
        reject(new Error('Cursor verification ended without a result.')),
      );
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    // Stop, timeout, worker error, and success all drain the owned worker.
    await worker.terminate();
  }
}
