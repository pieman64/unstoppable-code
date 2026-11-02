import type { DelegationChildRow } from '@canopy/agent-transcript';
import { TRANSCRIPT_PAGE_SIZE } from '@canopy/agent-transcript/transcript-storage';

/**
 * Serialized bytes of one child page's rows. Child pages cross the renderer
 * relay, whose replies are capped at 1 MiB, so a page keeps its newest rows
 * within this budget and leaves the rest to the next older page.
 */
export const CHILD_PAGE_ROW_BYTES = 768 * 1024;

/** Rows read per step, which bounds what one page holds before it is trimmed. */
const CHILD_PAGE_READ_BATCH = 16;

/** A newest row whose identity alone exceeds the page budget. */
export class ChildPageRowTooLargeError extends Error {
  public constructor() {
    super('Child transcript row identity exceeds the page');
    this.name = 'ChildPageRowTooLargeError';
  }
}

export type ChildPageRead = (options: {
  before?: number;
  limit: number;
}) => Promise<{ rows: readonly DelegationChildRow[]; nextBefore?: number }>;

export interface ChildPageSelection {
  /** Oldest first, as the reader returns rows. */
  rows: DelegationChildRow[];
  /** Reader position of the first returned row. */
  start: number;
  /** Position after the newest row of the stream, read on a first page. */
  end: number;
}

/**
 * A row too large for any page on its own: its identity and attribution
 * without blocks. Arbitrary extras stay behind, so the envelope is bounded.
 */
export function blocksOmittedChildRow(
  row: DelegationChildRow,
): DelegationChildRow {
  return {
    id: row.id,
    role: row.role,
    timestamp: row.timestamp,
    itemRevision: row.itemRevision,
    final: row.final,
    blocks: [],
    blocksOmitted: {
      blockCount: row.blocksRef?.blockCount ?? row.blocks.length,
    },
    ...(row.parentBlockId === undefined
      ? {}
      : { parentBlockId: row.parentBlockId }),
    ...(row.delegationAuthor === undefined
      ? {}
      : { delegationAuthor: row.delegationAuthor }),
    ...(row.delegationDelivery === undefined
      ? {}
      : { delegationDelivery: row.delegationDelivery }),
    ...(row.truncated ? { truncated: true } : {}),
  };
}

function serializedBytes(row: DelegationChildRow): number {
  return Buffer.byteLength(JSON.stringify(row), 'utf8');
}

/**
 * The contiguous newest rows before `before` (or the stream's end) that fit
 * {@link CHILD_PAGE_ROW_BYTES}, never skipping a row. A newest row that alone
 * exceeds the budget is returned with its blocks omitted. Stored rows are
 * measured: the portable projection only removes fields, so its bytes are
 * never larger.
 */
export async function selectChildPageRows(
  read: ChildPageRead,
  before?: number,
  maxRows = TRANSCRIPT_PAGE_SIZE,
): Promise<ChildPageSelection> {
  const kept: DelegationChildRow[] = [];
  let bytes = 2;
  let start = before ?? 0;
  let end = before ?? 0;
  let next = before;
  for (let first = true; kept.length < maxRows; first = false) {
    const batch = await read({
      ...(next === undefined ? {} : { before: next }),
      limit: Math.min(CHILD_PAGE_READ_BATCH, maxRows - kept.length),
    });
    const batchStart = batch.nextBefore ?? 0;
    if (first) {
      end = batchStart + batch.rows.length;
      start = end;
    }
    let full = false;
    for (let index = batch.rows.length - 1; index >= 0; index--) {
      const row = batch.rows[index];
      if (row === undefined) break;
      const size = serializedBytes(row) + (kept.length === 0 ? 0 : 1);
      if (bytes + size > CHILD_PAGE_ROW_BYTES) {
        if (kept.length === 0) {
          const envelope = blocksOmittedChildRow(row);
          if (serializedBytes(envelope) + bytes > CHILD_PAGE_ROW_BYTES)
            throw new ChildPageRowTooLargeError();
          kept.push(envelope);
          start = batchStart + index;
        }
        full = true;
        break;
      }
      kept.push(row);
      bytes += size;
      start = batchStart + index;
    }
    if (full || batch.nextBefore === undefined || batch.rows.length === 0)
      break;
    next = batch.nextBefore;
  }
  kept.reverse();
  return { rows: kept, start, end };
}
