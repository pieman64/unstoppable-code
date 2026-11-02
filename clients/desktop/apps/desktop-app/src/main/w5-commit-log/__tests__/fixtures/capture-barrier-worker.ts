import { createRequire } from 'node:module';
import { workerData, MessagePort } from 'node:worker_threads';
import { desktopW5Durability } from '@canopy/desktop-shared/node/w5-commit-log/durability';
import {
  W5CommitLogRequestHandler,
  type W5CommitLogRequest,
} from '@canopy/core-runtime/node/w5/commit-log';

// Only this test entry instruments production composition; no production test hooks.
const data: unknown = workerData;
const port: unknown =
  typeof data === 'object' && data !== null
    ? Reflect.get(data, 'barrierPort')
    : undefined;
if (!(port instanceof MessagePort))
  throw new Error('Missing test barrier port');
const barrierPort = port;
async function barrier(kind: string): Promise<void> {
  await new Promise<void>((resolve) => {
    barrierPort.once('message', () => resolve());
    barrierPort.postMessage(kind);
  });
}
const write = desktopW5Durability.writeFileDurably;
Object.assign(desktopW5Durability, {
  writeFileDurably: async (path: string, contents: string): Promise<void> => {
    await write(path, contents);
    await barrier('file-written');
  },
});
const runDescriptor = Object.getOwnPropertyDescriptors(
  W5CommitLogRequestHandler.prototype,
).run;
const run = runDescriptor.value;
if (!run) throw new Error('Missing request handler method');
W5CommitLogRequestHandler.prototype.run = async function (
  this: W5CommitLogRequestHandler,
  request: W5CommitLogRequest,
): Promise<unknown> {
  const result = await run.call(this, request);
  if (request.method === 'capture') await barrier('captured');
  return result;
};
// Match the tsx/cjs worker loader; ESM import cannot resolve the TS entry.
const loadWorker = createRequire(__filename);
loadWorker('../../commit-log-worker');
