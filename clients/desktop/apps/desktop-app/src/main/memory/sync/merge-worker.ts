import { parentPort, workerData } from 'node:worker_threads';
import {
  MEMORY_DOCUMENT_MERGE_MAX_BYTES,
  mergeMemoryDocument,
} from '@canopy/memory-consolidation/document-merge';

const input: unknown = workerData;

function isSide(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' &&
      Buffer.byteLength(value, 'utf8') <= MEMORY_DOCUMENT_MERGE_MAX_BYTES)
  );
}

try {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('base' in input) ||
    !('ours' in input) ||
    !('theirs' in input) ||
    !isSide(input.base) ||
    typeof input.ours !== 'string' ||
    typeof input.theirs !== 'string' ||
    !isSide(input.ours) ||
    !isSide(input.theirs)
  )
    throw new Error('Invalid memory merge request');
  parentPort?.postMessage({
    merge: mergeMemoryDocument(input.base, input.ours, input.theirs),
  });
} catch {
  parentPort?.postMessage({
    merge: { kind: 'conflict', reason: 'too_costly' },
  });
} finally {
  parentPort?.close();
}
