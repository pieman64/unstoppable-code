import { createHash } from 'node:crypto';
import type { DelegationChildRow } from '@canopy/agent-transcript';
import type { TranscriptTarget } from '@canopy/protocol/canopy-core';
import type { ChildStreamSequenceEntry } from '../child-stream-sequence-index';
import { activeRowBytes } from './active-turn';
import { ChatDeltaJournalIntegrityError } from './format';

export interface ChildStreamPageOptions {
  before?: number;
  limit?: number;
}

export interface ChildStreamPage {
  rows: readonly DelegationChildRow[];
  nextBefore?: number;
}

export interface ChildStreamCompatibilityPageOptions {
  beforeSequence?: number;
  limit: number;
  physicalByteBudget: number;
  encodedBudget: number;
}

export interface ChildStreamCompatibilitySource {
  committedEntries: readonly ChildStreamSequenceEntry[];
  activeRows: readonly DelegationChildRow[];
  pendingRows: readonly DelegationChildRow[];
  readCommittedRow: (
    entry: ChildStreamSequenceEntry,
  ) => Promise<DelegationChildRow>;
}

export interface ChildStreamCompatibilityPage<T> {
  items: T[];
  hasMore: boolean;
  /** Bytes read from committed child-log row ranges. */
  physicalBytes: number;
  /** Serialized bytes of active rows considered for the page. */
  activeBytes: number;
  /** Serialized bytes of journal-pending rows considered for the page. */
  pendingBytes: number;
}

type ChildCompatibilityCandidate =
  | { kind: 'committed'; entry: ChildStreamSequenceEntry }
  | { kind: 'active'; row: DelegationChildRow }
  | { kind: 'pending'; row: DelegationChildRow };

function compatibilitySequence(candidate: ChildCompatibilityCandidate): number {
  if (candidate.kind === 'committed') return candidate.entry.delegationSequence;
  const sequence = candidate.row.delegationSequence;
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence))
    throw new ChatDeltaJournalIntegrityError('Child row lacks sequence');
  return sequence;
}

function compatibilityId(candidate: ChildCompatibilityCandidate): string {
  return candidate.kind === 'committed' ? candidate.entry.id : candidate.row.id;
}

/**
 * Read the newest contiguous compatibility suffix. The complete committed
 * sequence index, active rows and pending overlay are checked for duplicate identities
 * before selecting; physical lengths are selected before any row read.
 */
export async function readChildStreamCompatibilityPage<T>(
  committedEntries: readonly ChildStreamSequenceEntry[],
  activeRows: readonly DelegationChildRow[],
  pendingRows: readonly DelegationChildRow[],
  readCommittedRow: (
    entry: ChildStreamSequenceEntry,
  ) => Promise<DelegationChildRow>,
  project: (row: DelegationChildRow) => T,
  options: ChildStreamCompatibilityPageOptions,
): Promise<ChildStreamCompatibilityPage<T>> {
  const { beforeSequence, limit, physicalByteBudget, encodedBudget } = options;
  if (
    (beforeSequence !== undefined &&
      (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1)) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    !Number.isSafeInteger(physicalByteBudget) ||
    physicalByteBudget < 0 ||
    !Number.isSafeInteger(encodedBudget) ||
    encodedBudget < 0
  )
    throw new Error('Invalid child compatibility page request');
  if (Buffer.byteLength(JSON.stringify([]), 'utf8') > encodedBudget)
    throw new Error('Compatibility item array exceeds encoded budget');

  const sequences = new Set<number>();
  const ids = new Set<string>();
  const candidates: ChildCompatibilityCandidate[] = [];
  for (const entry of committedEntries) {
    if (
      typeof entry.id !== 'string' ||
      entry.id.length === 0 ||
      !Number.isSafeInteger(entry.delegationSequence) ||
      !Number.isSafeInteger(entry.offset) ||
      entry.offset < 0 ||
      !Number.isSafeInteger(entry.end) ||
      entry.end <= entry.offset
    )
      throw new ChatDeltaJournalIntegrityError(
        'Invalid committed child sequence index entry',
      );
    if (sequences.has(entry.delegationSequence))
      throw new ChatDeltaJournalIntegrityError(
        'Duplicate sequence across committed child rows',
      );
    if (ids.has(entry.id))
      throw new ChatDeltaJournalIntegrityError(
        'Child stream page contains duplicate rows',
      );
    sequences.add(entry.delegationSequence);
    ids.add(entry.id);
    candidates.push({ kind: 'committed', entry });
  }
  const addRows = (
    kind: 'active' | 'pending',
    rows: readonly DelegationChildRow[],
  ): void => {
    for (const row of rows) {
      const sequence = row.delegationSequence;
      if (
        typeof row.id !== 'string' ||
        row.id.length === 0 ||
        typeof sequence !== 'number' ||
        !Number.isSafeInteger(sequence)
      )
        throw new ChatDeltaJournalIntegrityError('Child row lacks sequence');
      if (sequences.has(sequence))
        throw new ChatDeltaJournalIntegrityError(
          'Duplicate sequence across committed and pending child rows',
        );
      if (ids.has(row.id))
        throw new ChatDeltaJournalIntegrityError(
          'Child stream page contains duplicate rows',
        );
      sequences.add(sequence);
      ids.add(row.id);
      candidates.push({ kind, row });
    }
  };
  addRows('active', activeRows);
  addRows('pending', pendingRows);

  const eligible = candidates
    .filter(
      (candidate) =>
        beforeSequence === undefined ||
        compatibilitySequence(candidate) < beforeSequence,
    )
    .sort(
      (left, right) =>
        compatibilitySequence(left) - compatibilitySequence(right) ||
        compatibilityId(left).localeCompare(compatibilityId(right)),
    );

  const physicalSuffix: ChildCompatibilityCandidate[] = [];
  let physicalBudgetBytes = 0;
  for (let index = eligible.length - 1; index >= 0; index -= 1) {
    if (physicalSuffix.length >= limit) break;
    const candidate = eligible[index];
    if (!candidate) break;
    const bytes =
      candidate.kind === 'committed'
        ? candidate.entry.end - candidate.entry.offset
        : activeRowBytes(candidate.row);
    if (bytes > physicalByteBudget - physicalBudgetBytes) {
      if (physicalSuffix.length === 0)
        throw new Error('Newest child row exceeds physical read budget');
      break;
    }
    physicalBudgetBytes += bytes;
    physicalSuffix.push(candidate);
  }

  const reverseItems: T[] = [];
  let physicalBytes = 0;
  let activeBytes = 0;
  let pendingBytes = 0;
  for (const candidate of physicalSuffix) {
    const row =
      candidate.kind !== 'committed'
        ? candidate.row
        : await readCommittedRow(candidate.entry);
    if (candidate.kind === 'committed')
      physicalBytes += candidate.entry.end - candidate.entry.offset;
    else if (candidate.kind === 'active')
      activeBytes += activeRowBytes(candidate.row);
    else pendingBytes += activeRowBytes(candidate.row);
    if (
      typeof row.delegationSequence !== 'number' ||
      !Number.isSafeInteger(row.delegationSequence) ||
      row.delegationSequence !== compatibilitySequence(candidate) ||
      row.id !== compatibilityId(candidate)
    )
      throw new ChatDeltaJournalIntegrityError(
        'Child transcript index mismatch',
      );
    const item = project(row);
    const encoded = JSON.stringify([...reverseItems, item]);
    if (
      encoded === undefined ||
      Buffer.byteLength(encoded, 'utf8') > encodedBudget
    ) {
      if (reverseItems.length === 0)
        throw new Error('Newest child row exceeds encoded budget');
      break;
    }
    reverseItems.push(item);
  }

  return {
    items: reverseItems.reverse(),
    hasMore: reverseItems.length < eligible.length,
    physicalBytes,
    activeBytes,
    pendingBytes,
  };
}

type ReadCommittedChildPage = (options: {
  before: number;
  limit: number;
}) => Promise<ChildStreamPage>;

/**
 * Merge a bounded committed page with rows still held by the journal overlay.
 * Pending rows sort by the same sequence/ID key as the committed stream index.
 */
export async function readMergedChildStreamPage(
  committedRowCount: number,
  pendingRows: readonly DelegationChildRow[],
  readCommittedPage: ReadCommittedChildPage,
  options: ChildStreamPageOptions = {},
): Promise<ChildStreamPage> {
  const total = committedRowCount + pendingRows.length;
  const before = options.before ?? total;
  const limit = options.limit ?? 100;
  if (
    !Number.isSafeInteger(committedRowCount) ||
    committedRowCount < 0 ||
    !Number.isSafeInteger(total) ||
    !Number.isSafeInteger(before) ||
    before < 0 ||
    before > total ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000
  )
    throw new Error('Invalid child stream page');

  const wanted = Math.min(committedRowCount, before);
  const candidateCount = Math.min(wanted, limit + pendingRows.length);
  const candidates: DelegationChildRow[] = [];
  let cursor = wanted;
  while (cursor > 0 && candidates.length < candidateCount) {
    const page = await readCommittedPage({
      before: cursor,
      limit: Math.min(1000, candidateCount - candidates.length),
    });
    candidates.unshift(...page.rows);
    if (page.nextBefore === undefined) break;
    if (page.nextBefore >= cursor)
      throw new ChatDeltaJournalIntegrityError(
        'Child stream page cursor did not advance',
      );
    cursor = page.nextBefore;
  }

  const missingCommitted = wanted - candidates.length;
  const seenIds = new Set<string>();
  const merged = [...candidates, ...pendingRows].sort((left, right) => {
    const leftSequence = left.delegationSequence;
    const rightSequence = right.delegationSequence;
    if (
      typeof leftSequence !== 'number' ||
      !Number.isSafeInteger(leftSequence) ||
      typeof rightSequence !== 'number' ||
      !Number.isSafeInteger(rightSequence)
    )
      throw new ChatDeltaJournalIntegrityError('Child row lacks sequence');
    return leftSequence - rightSequence || left.id.localeCompare(right.id);
  });
  for (const row of merged) {
    if (seenIds.has(row.id))
      throw new ChatDeltaJournalIntegrityError(
        'Child stream page contains duplicate rows',
      );
    seenIds.add(row.id);
  }

  const start = Math.max(0, before - limit);
  return {
    rows: merged.slice(
      Math.max(0, start - missingCommitted),
      Math.max(0, before - missingCommitted),
    ),
    ...(start > 0 ? { nextBefore: start } : {}),
  };
}

function rowDigest(row: DelegationChildRow): string {
  return createHash('sha256').update(JSON.stringify(row)).digest('hex');
}

/** Pending child rows overlay the checkpointed stream without changing it. */
export class ChildJournalOverlay {
  private readonly rows = new Map<string, DelegationChildRow>();
  private readonly finalizationOrder: DelegationChildRow[] = [];
  private changed = false;
  /** Distinguish checkpointed active rows from revisions still in the journal. */
  private readonly pendingIds = new Set<string>();

  public constructor(
    public readonly target: Extract<TranscriptTarget, { kind: 'delegation' }>,
    private readonly committedRow: (
      id: string,
    ) => Promise<DelegationChildRow | undefined>,
    open: readonly DelegationChildRow[],
  ) {
    for (const row of open) this.rows.set(row.id, row);
  }

  public clone(): ChildJournalOverlay {
    const copy = new ChildJournalOverlay(this.target, this.committedRow, []);
    for (const [id, row] of Array.from(this.rows)) copy.rows.set(id, row);
    copy.finalizationOrder.push(...this.finalizationOrder);
    copy.changed = this.changed;
    for (const id of Array.from(this.pendingIds)) copy.pendingIds.add(id);
    return copy;
  }

  /** Exact revision+digest replay is a no-op, even after mutation-ID expiry. */
  public async apply(
    changes: readonly DelegationChildRow[],
    allowMaterializedStale = false,
  ): Promise<DelegationChildRow[]> {
    const seen = new Set<string>();
    const changed: DelegationChildRow[] = [];
    for (const row of changes) {
      if (seen.has(row.id))
        throw new ChatDeltaJournalIntegrityError(
          'Duplicate child row in effect',
        );
      seen.add(row.id);
      const previous =
        this.rows.get(row.id) ?? (await this.committedRow(row.id));
      if (previous) {
        if (
          previous.itemRevision === row.itemRevision &&
          rowDigest(previous) === rowDigest(row)
        )
          continue;
        // A resumed checkpoint may already have written a later open or final revision.
        if (allowMaterializedStale && previous.itemRevision > row.itemRevision)
          continue;
        if (previous.final)
          throw new ChatDeltaJournalIntegrityError(
            'Final child row is immutable',
          );
        if (row.itemRevision !== previous.itemRevision + 1)
          throw new ChatDeltaJournalIntegrityError(
            'Child item revision is stale or gapped',
          );
      } else if (row.itemRevision !== 0)
        throw new ChatDeltaJournalIntegrityError(
          'New child item revision must be zero',
        );
      this.rows.set(row.id, row);
      this.pendingIds.add(row.id);
      this.changed = true;
      changed.push(row);
      if (row.final) {
        this.finalizationOrder.push(row);
      }
    }
    return changed;
  }

  public async matches(
    changes: readonly DelegationChildRow[],
  ): Promise<boolean> {
    for (const row of changes) {
      const previous =
        this.rows.get(row.id) ?? (await this.committedRow(row.id));
      if (
        !(
          previous !== undefined &&
          previous.itemRevision === row.itemRevision &&
          rowDigest(previous) === rowDigest(row)
        )
      )
        return false;
    }
    return true;
  }

  public get openRows(): DelegationChildRow[] {
    return Array.from(this.rows.values()).filter((row) => !row.final);
  }

  public get newlyFinalRows(): DelegationChildRow[] {
    return [...this.finalizationOrder];
  }

  public get pendingRows(): DelegationChildRow[] {
    return Array.from(this.rows.values());
  }

  public compatibilityRows(): {
    activeRows: DelegationChildRow[];
    pendingRows: DelegationChildRow[];
  } {
    const rows = Array.from(this.rows.values());
    return {
      activeRows: rows.filter((row) => !this.pendingIds.has(row.id)),
      pendingRows: rows.filter((row) => this.pendingIds.has(row.id)),
    };
  }

  public get hasChanges(): boolean {
    return this.changed;
  }

  public get openBytes(): number {
    return this.openRows.reduce((sum, row) => sum + activeRowBytes(row), 0);
  }
}
