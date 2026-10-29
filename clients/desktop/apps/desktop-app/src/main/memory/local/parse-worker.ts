import { parentPort, workerData } from 'node:worker_threads';
import { parseMemoryDocument } from './document-parser';

const input: unknown = workerData;
try {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('fileKey' in input) ||
    typeof input.fileKey !== 'string' ||
    !('content' in input) ||
    typeof input.content !== 'string' ||
    Buffer.byteLength(input.content, 'utf8') > 512 * 1024
  )
    throw new Error('Invalid memory parser request');
  parentPort?.postMessage({
    document: parseMemoryDocument(input.fileKey, input.content),
  });
} catch (error) {
  parentPort?.postMessage({
    error: error instanceof Error ? error.message : 'Memory parsing failed',
  });
} finally {
  parentPort?.close();
}
