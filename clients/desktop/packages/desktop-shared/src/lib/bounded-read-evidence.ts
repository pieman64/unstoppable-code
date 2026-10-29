export interface ReadEvidenceCursor {
  readonly observerId: string;
  readonly sequence: number;
}

export interface ReadEvidenceSnapshot<T> {
  cursor: ReadEvidenceCursor;
  capacity: number;
  dropped: number;
  complete: boolean;
  entries: Array<T & { sequence: number }>;
}

export interface ReadEvidenceJournal<T> {
  record(value: T): number;
  snapshot(after?: ReadEvidenceCursor | null): ReadEvidenceSnapshot<T>;
}

/** A bounded, process-local journal. Only its snapshot function is published. */
export function createBoundedReadEvidence<
  T extends Readonly<Record<string, string | number | boolean>>,
>(capacity = 256): ReadEvidenceJournal<T> {
  if (!Number.isSafeInteger(capacity) || capacity < 1)
    throw new Error('Invalid evidence capacity');
  const observerId = globalThis.crypto.randomUUID();
  let sequence = 0;
  const entries: Array<T & { sequence: number }> = [];
  return {
    record(value: T): number {
      sequence += 1;
      entries.push({ ...value, sequence });
      if (entries.length > capacity) entries.shift();
      return sequence;
    },
    snapshot(after?: ReadEvidenceCursor | null): ReadEvidenceSnapshot<T> {
      const complete =
        after != null &&
        after.observerId === observerId &&
        Number.isSafeInteger(after.sequence) &&
        after.sequence >= sequence - entries.length &&
        after.sequence <= sequence;
      return {
        cursor: { observerId, sequence },
        capacity,
        dropped: sequence - entries.length,
        complete,
        entries: complete
          ? entries
              .filter((entry) => entry.sequence > after.sequence)
              .map((entry) => ({ ...entry }))
          : [],
      };
    },
  };
}
