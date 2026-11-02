import { appendFileSync, statSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

/*
 * Loaded by `recording-worker` before the real worker: records each folder
 * opened to flush and each startup message sent, in order, to
 * `recording.log` beside the database's folder. Tests must not import it.
 */

const dbPath: unknown =
  typeof workerData === 'object' && workerData !== null
    ? Reflect.get(workerData, 'dbPath')
    : undefined;
if (typeof dbPath !== 'string') throw new Error('No dbPath');
const log = join(dirname(dirname(dbPath)), 'recording.log');
const record = (line: string): void => appendFileSync(log, `${line}\n`);

function isFolder(path: Parameters<typeof statSync>[0]): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const open = fsPromises.open;
fsPromises.open = (
  ...args: Parameters<typeof open>
): ReturnType<typeof open> => {
  const [path, flags] = args;
  if (
    (flags === 'r' || flags === 'r+') &&
    typeof path === 'string' &&
    isFolder(path)
  ) {
    record(`flush ${path}`);
  }
  return open(...args);
};

const port = parentPort;
if (port === null) throw new Error('Run only as a worker');
const post = port.postMessage.bind(port);
port.postMessage = (message: unknown): void => {
  const type: unknown =
    typeof message === 'object' && message !== null
      ? Reflect.get(message, 'type')
      : undefined;
  if (typeof type === 'string') record(`message ${type}`);
  post(message);
};
