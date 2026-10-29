import { Worker } from 'node:worker_threads';

const MAX_BYTES = 1024 * 1024;
const MAX_NODES = 10_000;
const DEADLINE_MS = 2_000;
const MAX_PENDING = 32;

export type OpenCodeSchemaValidator = (
  schema: unknown,
  input: unknown,
  signal: AbortSignal,
) => Promise<boolean>;

/** Bound the host's serialization work before transferring untrusted JSON. */
function boundedJson(value: unknown): string {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > MAX_NODES || depth > 64 || bytes > MAX_BYTES)
      throw new Error('Schema validation input exceeds its limit.');
    if (typeof item === 'string') {
      if (item.length > MAX_BYTES) throw new Error('String exceeds its limit.');
      bytes += Buffer.byteLength(item);
      return;
    }
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || ancestors.has(item))
      throw new Error('Expected JSON input.');
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw new Error('Expected a JSON object.');
    if (
      (Array.isArray(item) && item.length > MAX_NODES) ||
      Object.prototype.hasOwnProperty.call(item, 'toJSON')
    )
      throw new Error('Expected bounded JSON data.');
    ancestors.add(item);
    for (const key in item) {
      if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
      const property = Object.getOwnPropertyDescriptor(item, key);
      if (!property || !('value' in property))
        throw new Error('Expected JSON data.');
      bytes += Buffer.byteLength(key);
      visit(property.value, depth + 1);
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  const text = JSON.stringify(value);
  if (bytes > MAX_BYTES || Buffer.byteLength(text) > MAX_BYTES)
    throw new Error('Schema validation input exceeds its limit.');
  return text;
}

/** One owned worker at a time; the host supplies a bundled, trusted entry path. */
export function createOpenCodeSchemaValidator(
  workerPath: string,
): OpenCodeSchemaValidator {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  return async (schema, input, signal) => {
    if (signal.aborted || pending >= MAX_PENDING) return false;
    let payload: { schema: string; input: string };
    try {
      payload = { schema: boundedJson(schema), input: boundedJson(input) };
    } catch {
      return false;
    }
    const deadline = AbortSignal.any([
      signal,
      AbortSignal.timeout(DEADLINE_MS),
    ]);
    pending++;
    let started = false;
    const scheduled = tail.then(async () => {
      try {
        if (deadline.aborted) return false;
        started = true;
        return await validateInWorker(workerPath, payload, deadline);
      } finally {
        pending--;
      }
    });
    tail = scheduled.catch(() => false);
    let cancel = (): void => {};
    const stopped = new Promise<false>((resolve) => {
      cancel = (): void => resolve(false);
      deadline.addEventListener('abort', cancel, { once: true });
      if (deadline.aborted) cancel();
    });
    try {
      const result = await Promise.race([scheduled, stopped]);
      // A running worker must exit before its slot or request is released.
      if (started) await scheduled;
      return result && !deadline.aborted;
    } catch {
      return false;
    } finally {
      deadline.removeEventListener('abort', cancel);
    }
  };
}

async function validateInWorker(
  entry: string,
  payload: { schema: string; input: string },
  signal: AbortSignal,
): Promise<boolean> {
  const worker = new Worker(entry, {
    workerData: payload,
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 2 },
  });
  let cancel = (): void => {};
  try {
    return await new Promise<boolean>((resolve) => {
      cancel = (): void => resolve(false);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      worker.once('message', (message: unknown) => resolve(message === true));
      worker.once('error', () => resolve(false));
      worker.once('exit', () => resolve(false));
    });
  } finally {
    signal.removeEventListener('abort', cancel);
    await worker.terminate();
  }
}
