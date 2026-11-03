import type { W5RecordUnservedReason } from './w5-file-store';
import { recordW5Work } from '@canopy/desktop-shared/node/work-counters';
import { logMainProcessWarn } from './main-process-logging';

/*
 * CAN-5531: the work counter for W5 records the daemon record port cannot
 * serve (CAN-5498 debt), so field evidence shows whether either class occurs
 * before W15 chooses id normalization or a non-capture read path. The
 * daemon-backed store feeds it; in-process stores never do.
 */

const unservedCounts = new Map<string, number>();

/** One refusal of a record the port cannot serve. */
export function recordW5RecordUnserved(
  operation: string,
  reason: W5RecordUnservedReason,
): void {
  const key = `${operation} ${reason}`;
  const count = (unservedCounts.get(key) ?? 0) + 1;
  unservedCounts.set(key, count);
  recordW5Work(`unserved.${operation}.${reason}`);
  // Powers of two: a workspace read on every refresh logs O(log n) lines.
  if ((count & (count - 1)) === 0)
    logMainProcessWarn('W5 record port cannot serve a record', {
      operation,
      reason,
      count,
    });
}

/** Refusal counts, keyed `<operation> <reason>`: the measured rate. */
export function w5RecordUnservedCounts(): ReadonlyMap<string, number> {
  return unservedCounts;
}
