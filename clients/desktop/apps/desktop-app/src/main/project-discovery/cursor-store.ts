import { createHash, randomBytes } from 'node:crypto';
import type { PageResult } from '@canopy/desktop-shared/lib/project-discovery';
import { DiscoveryError } from './errors';

export const CURSOR_TTL_MS = 15 * 60 * 1000;
const MAX_HANDLES = 128;
const MAX_SNAPSHOT_IDS = 5000;

export interface SnapshotItem {
  id: string;
  sortKey: string;
  incarnation: string;
}
interface Snapshot {
  binding: string;
  items: SnapshotItem[];
  totalMatches: number;
  offset: number;
  expiresAt: number;
  revision: string;
}
interface PageOptions {
  binding: string;
  cursor?: string;
  pageSize: number;
  order: 'asc' | 'desc';
  freezeMatches?: boolean;
}

function signature(items: SnapshotItem[], total: number): string {
  return createHash('sha256')
    .update(JSON.stringify({ items, total }))
    .digest('hex');
}

/** Metadata-only snapshots. Runtime fields are never stored in a cursor. */
export class DiscoveryCursorStore {
  private readonly handles = new Map<string, Snapshot>();
  constructor(private readonly now: () => number = Date.now) {}

  assertLive(cursor: string, binding?: string): void {
    const entry = this.handles.get(cursor);
    if (!entry || entry.expiresAt <= this.now()) {
      this.handles.delete(cursor);
      throw new DiscoveryError(
        'cursor_expired',
        'This listing cursor has expired. Restart the listing.',
      );
    }
    if (binding !== undefined && entry.binding !== binding) {
      throw new DiscoveryError(
        'cursor_context_changed',
        'This listing context changed. Restart the listing.',
      );
    }
  }

  page<T extends SnapshotItem>(rows: T[], options: PageOptions): PageResult<T> {
    const now = this.now();
    this.handles.forEach((entry, token) => {
      if (entry.expiresAt <= now) this.handles.delete(token);
    });
    const sorted = [...rows].sort((left, right) => {
      const primary =
        left.sortKey < right.sortKey
          ? -1
          : left.sortKey > right.sortKey
            ? 1
            : 0;
      return (
        (options.order === 'asc' ? primary : -primary) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      );
    });
    const seeds = sorted
      .slice(0, MAX_SNAPSHOT_IDS)
      .map(({ id, sortKey, incarnation }) => ({ id, sortKey, incarnation }));
    const revision = signature(seeds, sorted.length);
    let snapshot: Snapshot;
    if (options.cursor !== undefined) {
      const existing = this.handles.get(options.cursor);
      if (!existing)
        throw new DiscoveryError(
          'cursor_expired',
          'This listing cursor has expired. Restart the listing.',
        );
      if (
        existing.binding !== options.binding ||
        (!options.freezeMatches && existing.revision !== revision)
      ) {
        throw new DiscoveryError(
          'cursor_context_changed',
          'This listing context or metadata changed. Restart the listing.',
        );
      }
      this.handles.delete(options.cursor);
      this.handles.set(options.cursor, existing);
      snapshot = existing;
    } else {
      snapshot = {
        binding: options.binding,
        items: seeds,
        totalMatches: sorted.length,
        offset: 0,
        expiresAt: now + CURSOR_TTL_MS,
        revision,
      };
    }
    const end = Math.min(
      snapshot.offset + options.pageSize,
      snapshot.totalMatches,
    );
    if (end > snapshot.items.length) {
      throw new DiscoveryError(
        'cursor_expired',
        'This listing has more than 5,000 matches. Narrow the filters to page further.',
      );
    }
    let items: T[];
    if (options.cursor && options.freezeMatches) {
      const currentById = new Map(rows.map((row) => [row.id, row]));
      items = snapshot.items.slice(snapshot.offset, end).map((seed) => {
        const row = currentById.get(seed.id);
        if (!row || row.incarnation !== seed.incarnation) {
          throw new DiscoveryError(
            'cursor_context_changed',
            'This listing context or metadata changed. Restart the listing.',
          );
        }
        return row;
      });
    } else {
      items = sorted.slice(snapshot.offset, end);
    }
    let nextCursor: string | null = null;
    if (end < snapshot.totalMatches) {
      nextCursor = randomBytes(32).toString('hex');
      this.handles.set(nextCursor, { ...snapshot, offset: end });
      while (this.handles.size > MAX_HANDLES) {
        const oldest = this.handles.keys().next().value;
        if (oldest === undefined) break;
        this.handles.delete(oldest);
      }
    }
    return {
      items,
      returned: items.length,
      totalMatches: snapshot.totalMatches,
      nextCursor,
      generatedAt: new Date(now).toISOString(),
      revision: snapshot.revision,
    };
  }
}
