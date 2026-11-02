import { createHash } from 'node:crypto';
import { isRecord } from '../../../lib/type-guards';

type SparseIndex = Record<string, unknown>;

/**
 * Source-derived unchanged predicate from chat-transcript-log.ts at
 * 339153ab43be3a6895909afc24ee7cbf0a3a30e1 (lines 297-322).
 */
export function isSparseIndexWithChecksum(
  value: unknown,
): value is SparseIndex & { checksum: string } {
  return (
    isRecord(value) &&
    value.version === 3 &&
    value.format === 'complete-message-jsonl-v1' &&
    typeof value.checksum === 'string' &&
    typeof value.committedDigest === 'string' &&
    /^[a-f0-9]{64}$/.test(value.committedDigest) &&
    Number.isSafeInteger(value.committedMessageCount) &&
    Number.isSafeInteger(value.committedByteLength) &&
    Number.isSafeInteger(value.transcriptRevision) &&
    typeof value.hasActiveSidecar === 'boolean' &&
    Array.isArray(value.offsets) &&
    value.offsets.every(
      (entry) =>
        isRecord(entry) &&
        Number.isSafeInteger(entry.ordinal) &&
        Number.isSafeInteger(entry.offset),
    ) &&
    (value.latestHuman === undefined ||
      (isRecord(value.latestHuman) &&
        Number.isSafeInteger(value.latestHuman.ordinal) &&
        Number.isSafeInteger(value.latestHuman.offset)))
  );
}

/** Source-derived unchanged index checksum function from the same baseline. */
export function indexChecksum(index: SparseIndex): string {
  return createHash('sha256').update(JSON.stringify(index)).digest('hex');
}
