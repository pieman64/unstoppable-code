import type { PersistedChatBlock, PersistedChatMessage } from '../types';
import { applyAssistantPatches } from './assistant-snapshot';
import { delegationLivePreview } from './delegation-live-preview';
import type { DelegationChildRow } from './delegation-transcript';

export interface DelegationLogicalItem {
  id: string;
  role: PersistedChatMessage['role'];
  blocks: PersistedChatBlock[];
  final: boolean;
  segment: string;
  timestamp: number;
  author?: PersistedChatMessage['delegationAuthor'];
  delivery?: PersistedChatMessage['delegationDelivery'];
}

interface StoredLogicalItem {
  id: string;
  role: PersistedChatMessage['role'];
  blocks: PersistedChatBlock[];
  final: boolean;
  segment: string;
  timestamp: number;
  author?: PersistedChatMessage['delegationAuthor'];
  delivery?: PersistedChatMessage['delegationDelivery'];
  sequence: number;
  revision: number;
}

interface ObservedRow {
  sequence: number;
  timestamp: number;
  segment: string;
  item: DelegationLogicalItem;
  published?: DelegationChildRow;
}

interface FinalTombstone {
  sequence: number;
  revision: number;
  final: true;
}

function liveBlocks(item: DelegationLogicalItem): PersistedChatBlock[] {
  if (item.final) return item.blocks;
  return item.blocks.map((block) => {
    if (block.type === 'text' || block.type === 'thinking') {
      return { ...block, text: delegationLivePreview(block.text) };
    }
    if (block.type === 'tool_use') {
      return { ...block, input: delegationLivePreview(block.input) };
    }
    return block;
  });
}

function samePublication(
  previous: DelegationChildRow,
  next: DelegationChildRow,
): boolean {
  return (
    previous.role === next.role &&
    previous.final === next.final &&
    equalContent(previous.delegationAuthor, next.delegationAuthor) &&
    previous.delegationDelivery === next.delegationDelivery &&
    equalContent(previous.blocks, next.blocks)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function equalContent(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return (
      left.length === right.length &&
      left.every((value, index) => equalContent(value, right[index]))
    );
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] && equalContent(left[key], right[key]),
      )
    );
  }
  return false;
}

function snapshotItem(item: DelegationLogicalItem): StoredLogicalItem {
  return {
    id: item.id,
    role: item.role,
    blocks: structuredClone(item.blocks),
    final: item.final,
    segment: item.segment,
    timestamp: item.timestamp,
    ...(item.author !== undefined ? { author: item.author } : {}),
    ...(item.delivery !== undefined ? { delivery: item.delivery } : {}),
    sequence: -1,
    revision: 0,
  };
}

function sameMutableContent(
  current: StoredLogicalItem,
  next: StoredLogicalItem,
): boolean {
  return (
    current.role === next.role &&
    current.final === next.final &&
    current.author === next.author &&
    current.delivery === next.delivery &&
    equalContent(current.blocks, next.blocks)
  );
}

/** In-memory deterministic projection of stream items into persisted rows. */
export class DelegationChildRowBuilder {
  // Kept separate so the deprecated full-snapshot API retains its exact semantics.
  private readonly rows = new Map<string, StoredLogicalItem>();
  private nextSequence = 0;
  private readonly observed = new Map<string, ObservedRow | FinalTombstone>();
  private readonly dirty = new Map<string, ObservedRow>();
  private readonly dirtyFinals = new Map<string, ObservedRow>();
  // Insertion order is observation order. Entries leave this queue once published.
  private readonly unpublished = new Map<string, ObservedRow>();
  private nextObservedSequence = 0;
  private materializations = 0;

  constructor(private readonly agentBlockId: string) {}

  /** Number of changed rows cloned for publication by take (not legacy update). */
  get materializedRows(): number {
    return this.materializations;
  }

  /** Keep the latest immutable item by reference, without inspecting or cloning its blocks.
   * Returns false once a final state was observed, published, or evicted. */
  observe(item: DelegationLogicalItem): boolean {
    const rowId = `${this.agentBlockId}:${item.id}`;
    const current = this.observed.get(rowId);
    if (current && (!('item' in current) || current.item.final)) return false;
    const row: ObservedRow = current ?? {
      sequence: this.nextObservedSequence++,
      timestamp: item.timestamp,
      segment: item.segment,
      item,
    };
    row.item = item;
    this.observed.set(rowId, row);
    this.dirty.set(rowId, row);
    if (row.published === undefined) this.unpublished.set(rowId, row);
    if (item.final) this.dirtyFinals.set(rowId, row);
    return true;
  }

  /** Publish dirty rows, or just finals and their never-published predecessors. */
  take(mode: 'final' | 'all'): DelegationChildRow[] {
    const candidates = new Map(mode === 'all' ? this.dirty : this.dirtyFinals);
    if (mode === 'final' && candidates.size > 0) {
      let lastFinalSequence = -1;
      candidates.forEach((row) => {
        lastFinalSequence = Math.max(lastFinalSequence, row.sequence);
      });
      const pending = this.unpublished.entries();
      for (let next = pending.next(); !next.done; next = pending.next()) {
        const [rowId, row] = next.value;
        if (row.sequence >= lastFinalSequence) break;
        candidates.set(rowId, row);
      }
    }

    const result: DelegationChildRow[] = [];
    for (const [rowId, row] of Array.from(candidates).sort(
      (left, right) => left[1].sequence - right[1].sequence,
    )) {
      const publication = this.publish(rowId, row);
      if (publication) result.push(publication);
      this.dirty.delete(rowId);
      this.dirtyFinals.delete(rowId);
      this.unpublished.delete(rowId);
    }
    return result;
  }

  /** Drop acknowledged final content only when the published revision matches exactly. */
  evict(rowId: string, itemRevision: number): void {
    const row = this.observed.get(rowId);
    if (
      row &&
      'item' in row &&
      row.published?.final === true &&
      row.published.itemRevision === itemRevision
    ) {
      this.observed.set(rowId, {
        sequence: row.sequence,
        revision: itemRevision,
        final: true,
      });
    }
  }

  private publish(
    rowId: string,
    row: ObservedRow,
  ): DelegationChildRow | undefined {
    const item = row.item;
    const candidate: DelegationChildRow = {
      id: rowId,
      role: item.role,
      blocks: liveBlocks(item),
      timestamp: row.timestamp,
      parentBlockId: this.agentBlockId,
      delegationSequence: row.sequence,
      delegationSegment: row.segment,
      itemRevision:
        row.published === undefined ? 0 : row.published.itemRevision + 1,
      final: item.final,
      ...(item.author !== undefined ? { delegationAuthor: item.author } : {}),
      ...(item.delivery !== undefined
        ? { delegationDelivery: item.delivery }
        : {}),
    };
    if (row.published && samePublication(row.published, candidate))
      return undefined;
    // Retain a private snapshot: neither input nor returned-row mutation can rewrite history.
    row.published = structuredClone(candidate);
    this.materializations += 1;
    return structuredClone(row.published);
  }

  /** @deprecated Full-history snapshot API; use observe/take/evict for stream publication. */
  update(items: readonly DelegationLogicalItem[]): DelegationChildRow[] {
    for (const item of items) {
      const next = snapshotItem(item);
      const current = this.rows.get(item.id);
      if (!current) {
        next.sequence = this.nextSequence;
        this.nextSequence += 1;
        this.rows.set(item.id, next);
        continue;
      }
      if (current.final) continue;

      next.sequence = current.sequence;
      next.timestamp = current.timestamp;
      next.segment = current.segment;
      next.revision = current.revision;
      if (!sameMutableContent(current, next)) next.revision += 1;
      this.rows.set(item.id, next);
    }

    return Array.from(this.rows.values())
      .sort((left, right) => left.sequence - right.sequence)
      .map((item) => ({
        id: `${this.agentBlockId}:${item.id}`,
        role: item.role,
        blocks: structuredClone(item.blocks),
        timestamp: item.timestamp,
        parentBlockId: this.agentBlockId,
        delegationSequence: item.sequence,
        delegationSegment: item.segment,
        itemRevision: item.revision,
        final: item.final,
        ...(item.author !== undefined ? { delegationAuthor: item.author } : {}),
        ...(item.delivery !== undefined
          ? { delegationDelivery: item.delivery }
          : {}),
      }));
  }
}

/** Project a validated provider-neutral assistant patch into logical items. */
export function projectDelegationAssistantPatch(
  previous: PersistedChatMessage | undefined,
  value: Record<string, unknown>,
  segment: string,
  final?: boolean,
):
  | { message: PersistedChatMessage; items: DelegationLogicalItem[] }
  | undefined {
  const message = applyAssistantPatches(previous, value);
  if (!message) return undefined;

  const items: DelegationLogicalItem[] = [];
  const resultIndexes = new Map<string, { indexes: number[]; next: number }>();
  message.blocks.forEach((block, index) => {
    if (block.type !== 'tool_result') return;
    const matches = resultIndexes.get(block.toolUseId);
    if (matches) matches.indexes.push(index);
    else resultIndexes.set(block.toolUseId, { indexes: [index], next: 0 });
  });
  const matchedResults = new Set<number>();
  message.blocks.forEach((block, index) => {
    if (block.type === 'text' || block.type === 'thinking') {
      items.push({
        id: `${message.id}:${index}`,
        role: message.role,
        blocks: [block],
        final: final === true,
        segment,
        timestamp: message.timestamp,
      });
      return;
    }
    if (block.type !== 'tool_use') return;

    const matches = resultIndexes.get(block.toolUseId);
    const resultIndex = matches?.indexes[matches.next];
    if (matches && resultIndex !== undefined) matches.next += 1;
    const pairedResult =
      resultIndex !== undefined ? message.blocks[resultIndex] : undefined;
    if (pairedResult?.type === 'tool_result' && resultIndex !== undefined) {
      matchedResults.add(resultIndex);
    }
    items.push({
      id: `${message.id}:${block.toolUseId}`,
      role: message.role,
      blocks:
        pairedResult?.type === 'tool_result' ? [block, pairedResult] : [block],
      final: pairedResult?.type === 'tool_result',
      segment,
      timestamp: message.timestamp,
    });
  });
  // A result whose start was never observed still carries the tool's output.
  message.blocks.forEach((block, index) => {
    if (block.type !== 'tool_result' || matchedResults.has(index)) return;
    items.push({
      id: `${message.id}:${block.toolUseId}`,
      role: message.role,
      blocks: [block],
      final: true,
      segment,
      timestamp: message.timestamp,
    });
  });

  return { message, items };
}
