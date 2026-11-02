import type { DelegationChildRow } from '@canopy/agent-transcript';

/** Disposable sequence-to-byte lookup; committed rows may be finalized out of order. */
export interface ChildStreamSequenceEntry {
  id: string;
  delegationSequence: number;
  offset: number;
  end: number;
}

export function buildChildStreamSequenceIndex(
  rows: readonly {
    row: Pick<DelegationChildRow, 'id' | 'delegationSequence'>;
    offset: number;
    end: number;
  }[],
): ChildStreamSequenceEntry[] {
  const ids = new Set<string>();
  const entries = rows.map(({ row, offset, end }) => {
    const sequence = row.delegationSequence;
    if (
      ids.has(row.id) ||
      typeof sequence !== 'number' ||
      !Number.isSafeInteger(sequence) ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(end) ||
      offset < 0 ||
      end <= offset
    )
      throw new Error('Invalid child sequence index row');
    ids.add(row.id);
    return { id: row.id, delegationSequence: sequence, offset, end };
  });
  return entries.sort(
    (left, right) =>
      left.delegationSequence - right.delegationSequence ||
      left.id.localeCompare(right.id),
  );
}

export function childStreamSequencePage(
  entries: readonly ChildStreamSequenceEntry[],
  before = entries.length,
  limit = 100,
): { entries: ChildStreamSequenceEntry[]; before?: number } {
  if (
    !Number.isSafeInteger(before) ||
    before < 0 ||
    before > entries.length ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000
  )
    throw new Error('Invalid child sequence page');
  const start = Math.max(0, before - limit);
  return {
    entries: entries.slice(start, before),
    ...(start > 0 ? { before: start } : {}),
  };
}

export function findChildStreamSequenceEntry(
  entries: readonly ChildStreamSequenceEntry[],
  id: string,
): ChildStreamSequenceEntry | undefined {
  return entries.find((entry) => entry.id === id);
}
