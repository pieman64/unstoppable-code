import { Inflate } from 'pako';
import type { OfficeArchiveData } from './office-archive';

const CHUNK_BYTES = 16 * 1024;

/** Verify admitted ZIP sizes while streaming and discarding expanded bytes. */
export function assertOfficeArchiveExpansion(
  entries: readonly OfficeArchiveData[],
  onChunk?: (chunk: Uint8Array) => void,
): void {
  for (const entry of entries) {
    let expandedBytes = 0;
    const consume = (chunk: Uint8Array): void => {
      expandedBytes += chunk.length;
      if (expandedBytes > entry.expandedSize)
        throw new Error(
          'Office ZIP expanded size does not match its directory.',
        );
      onChunk?.(chunk);
    };
    if (entry.method === 0) {
      consume(entry.data);
    } else {
      const inflater = new Inflate({ raw: true, chunkSize: CHUNK_BYTES });
      let complete = false;
      inflater.onData = (chunk): void =>
        consume(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
      inflater.onEnd = (status: number): void => {
        if (status !== 0)
          throw new Error('Invalid Office ZIP compressed stream.');
        complete = true;
      };
      inflater.push(entry.data, true);
      if (!complete)
        throw new Error('Incomplete Office ZIP compressed stream.');
    }
    if (expandedBytes !== entry.expandedSize)
      throw new Error('Office ZIP expanded size does not match its directory.');
  }
}

/** Expand one admitted entry, enforcing the same size checks as above. */
export function expandOfficeArchiveEntry(entry: OfficeArchiveData): Uint8Array {
  const output = new Uint8Array(entry.expandedSize);
  let offset = 0;
  assertOfficeArchiveExpansion([entry], (chunk) => {
    output.set(chunk, offset);
    offset += chunk.length;
  });
  return output;
}
