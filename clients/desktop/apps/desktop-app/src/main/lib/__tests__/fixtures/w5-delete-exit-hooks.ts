import { parentPort } from 'node:worker_threads';
import {
  isW5CommitLogRequest,
  isW5CommitLogResponse,
  isW5CommitOutcome,
} from '@canopy/core-runtime/node/w5/commit-log/worker-contract';

// Installed before the real worker: exit after durable deletion, before reply.
const port = parentPort;
if (port === null) throw new Error('Run only as a worker');
let deletionRequest: number | undefined;
port.on('message', (message: unknown): void => {
  if (
    isW5CommitLogRequest(message) &&
    message.method === 'commit' &&
    Reflect.get(Object(message.args[0]), 'operation') ===
      'core.workspace.delete'
  )
    deletionRequest = message.id;
});
const post = port.postMessage.bind(port);
port.postMessage = (message: unknown): void => {
  if (
    isW5CommitLogResponse(message) &&
    message.id === deletionRequest &&
    message.ok &&
    isW5CommitOutcome(message.result) &&
    message.result.status === 'applied'
  )
    process.exit(72);
  post(message);
};
