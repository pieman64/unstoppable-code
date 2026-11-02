import { randomBytes } from 'node:crypto';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';

/*
 * Continuation for the core workspace and worktree lists (CAN-5319). A
 * listing's first page pins its complete projected result, together with the
 * legacy capture and authority metadata it published, and every later page
 * serves that pinned copy. Retention is runtime memory only, so restart,
 * shutdown, expiry and eviction each end a listing; a refused cursor is never
 * rebuilt from live data.
 */

export type CoreReadSnapshotOperation =
  | 'core.workspace.list'
  | 'core.worktree.list';

/** What a continuation token is bound to, beyond the runtime that minted it. */
export interface CoreReadSnapshotBinding {
  readonly operation: CoreReadSnapshotOperation;
  readonly scope: {
    readonly workspaceId?: string;
    readonly organizationId?: string;
    readonly worktreeId?: string;
  };
  readonly pageSize: number;
  /** Absent only for direct (non-dispatcher) adapter calls. */
  readonly caller?: CanopyCallerDescriptor;
}

export interface CoreReadSnapshotLimits {
  /** Absolute, from the first page: a snapshot's age bounds its staleness. */
  readonly lifetimeMs: number;
  readonly maxSnapshots: number;
  /** Keeps one caller's listings from evicting every other caller's. */
  readonly maxSnapshotsPerCaller: number;
  /** Serialized size of every retained snapshot together. */
  readonly maxBytes: number;
}

export const CORE_READ_SNAPSHOT_LIMITS: CoreReadSnapshotLimits = {
  lifetimeMs: 10 * 60_000,
  maxSnapshots: 64,
  maxSnapshotsPerCaller: 8,
  maxBytes: 32 * 1024 * 1024,
};

const TOKEN_BYTES = 24;
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

interface Snapshot<Pinned> {
  readonly caller: string;
  readonly request: string;
  readonly pinned: Pinned;
  readonly total: number;
  readonly pageSize: number;
  readonly pinnedAt: number;
  readonly expiresAt: number;
  readonly bytes: number;
  /** The token naming each page after the first, by offset. */
  readonly tokens: Map<number, string>;
}

export interface CoreReadSnapshotPage<Pinned> {
  /** A copy: the retained snapshot never reaches a caller. */
  readonly pinned: Pinned;
  readonly offset: number;
  readonly nextCursor: string | null;
}

function refuse(
  kind: 'invalid_argument' | 'failed_precondition',
  message: string,
): CanopyOperationError {
  return new CanopyOperationError({ kind, message, retry: { kind: 'never' } });
}

// Grants are rechecked by the dispatcher on every page, so they stay out.
function callerKey(caller: CanopyCallerDescriptor | undefined): string {
  return JSON.stringify(
    caller
      ? [
          caller.principalId,
          caller.authorityId,
          caller.interfaceKind,
          caller.clientInstanceId,
        ]
      : null,
  );
}

function requestKey(binding: CoreReadSnapshotBinding): string {
  return JSON.stringify([
    binding.operation,
    binding.scope.workspaceId ?? null,
    binding.scope.organizationId ?? null,
    binding.scope.worktreeId ?? null,
    binding.pageSize,
  ]);
}

export interface CoreReadSnapshotStore<Pinned> {
  /**
   * Pins a copy of `pinned` when its `total` items span more than one page
   * and returns the cursor of the second page, or null for a single page.
   */
  open(
    binding: CoreReadSnapshotBinding,
    pinned: Pinned,
    total: number,
  ): string | null;
  /**
   * The pinned page `cursor` names, after checking it against `binding`.
   * Throws before the caller publishes anything; reads nothing live.
   */
  resume(
    cursor: string,
    binding: CoreReadSnapshotBinding,
  ): CoreReadSnapshotPage<Pinned>;
  /** What is retained now, after releasing expired listings. */
  retained(): { readonly snapshots: number; readonly bytes: number };
  /** Runtime teardown: drops every snapshot and pins no more. */
  close(): void;
}

export function createCoreReadSnapshotStore<Pinned>(
  limits: CoreReadSnapshotLimits = CORE_READ_SNAPSHOT_LIMITS,
  now: () => number = Date.now,
): CoreReadSnapshotStore<Pinned> {
  const snapshots = new Set<Snapshot<Pinned>>();
  const pages = new Map<
    string,
    { snapshot: Snapshot<Pinned>; offset: number }
  >();
  let bytes = 0;
  let closed = false;
  let sweep: ReturnType<typeof setTimeout> | undefined;

  /** Same offset, same token, so a replayed page names the same next page. */
  const token = (snapshot: Snapshot<Pinned>, offset: number): string => {
    const known = snapshot.tokens.get(offset);
    if (known) return known;
    const minted = randomBytes(TOKEN_BYTES).toString('base64url');
    snapshot.tokens.set(offset, minted);
    pages.set(minted, { snapshot, offset });
    return minted;
  };
  const evict = (snapshot: Snapshot<Pinned>): void => {
    if (!snapshots.delete(snapshot)) return;
    bytes -= snapshot.bytes;
    snapshot.tokens.forEach((minted) => pages.delete(minted));
  };
  // A clock that moved backwards cannot date a snapshot, so it expires it.
  const purgeExpired = (): void => {
    const current = now();
    for (const snapshot of Array.from(snapshots))
      if (snapshot.expiresAt <= current || current < snapshot.pinnedAt)
        evict(snapshot);
  };
  /** Releases memory at the earliest expiry, not only on the next call. */
  const scheduleSweep = (): void => {
    clearTimeout(sweep);
    sweep = undefined;
    if (snapshots.size === 0) return;
    const earliest = Math.min(
      ...Array.from(snapshots, (snapshot) => snapshot.expiresAt),
    );
    sweep = setTimeout(
      () => {
        purgeExpired();
        scheduleSweep();
      },
      // Node clamps longer delays to 1 ms; a later sweep just reschedules.
      Math.min(Math.max(0, earliest - now()), MAX_TIMER_DELAY_MS),
    );
    sweep.unref();
  };
  /** Oldest first: the caller's own listings, then anyone's. */
  const evictFor = (incoming: Snapshot<Pinned>): void => {
    const own = Array.from(snapshots).filter(
      (snapshot) => snapshot.caller === incoming.caller,
    );
    for (const snapshot of own.slice(
      0,
      Math.max(0, own.length - limits.maxSnapshotsPerCaller + 1),
    ))
      evict(snapshot);
    for (const snapshot of Array.from(snapshots)) {
      if (
        snapshots.size < limits.maxSnapshots &&
        bytes + incoming.bytes <= limits.maxBytes
      )
        break;
      evict(snapshot);
    }
  };

  return {
    open: (binding, pinned, total): string | null => {
      if (total <= binding.pageSize) return null;
      if (closed)
        throw new CanopyOperationError({
          kind: 'unavailable',
          message: 'This listing is unavailable while Canopy shuts down.',
          retry: { kind: 'never' },
        });
      purgeExpired();
      const retained = structuredClone(pinned);
      const size = Buffer.byteLength(JSON.stringify(retained), 'utf8');
      if (size > limits.maxBytes)
        throw new CanopyOperationError({
          kind: 'resource_exhausted',
          message: 'This listing is too large to page. Narrow its scope.',
          retry: { kind: 'never' },
        });
      const pinnedAt = now();
      const snapshot: Snapshot<Pinned> = {
        caller: callerKey(binding.caller),
        request: requestKey(binding),
        pinned: retained,
        total,
        pageSize: binding.pageSize,
        pinnedAt,
        expiresAt: pinnedAt + limits.lifetimeMs,
        bytes: size,
        tokens: new Map(),
      };
      evictFor(snapshot);
      snapshots.add(snapshot);
      bytes += size;
      scheduleSweep();
      return token(snapshot, binding.pageSize);
    },
    resume: (cursor, binding): CoreReadSnapshotPage<Pinned> => {
      if (/^[0-9]+$/.test(cursor))
        throw refuse(
          'invalid_argument',
          'Numeric list cursors are no longer accepted. Restart the listing without a cursor.',
        );
      if (!TOKEN_PATTERN.test(cursor))
        throw refuse('invalid_argument', 'This list cursor is not valid.');
      purgeExpired();
      const page = pages.get(cursor);
      // Another caller's cursor reads as unknown: it neither authorizes nor reveals.
      if (!page || page.snapshot.caller !== callerKey(binding.caller))
        throw refuse(
          'failed_precondition',
          'This list cursor has expired. Restart the listing without a cursor.',
        );
      const { snapshot, offset } = page;
      if (snapshot.request !== requestKey(binding))
        throw refuse(
          'invalid_argument',
          'This list cursor belongs to a different listing. Repeat the scope and page size it was issued for.',
        );
      const end = offset + snapshot.pageSize;
      return {
        pinned: structuredClone(snapshot.pinned),
        offset,
        nextCursor: end < snapshot.total ? token(snapshot, end) : null,
      };
    },
    retained: (): { snapshots: number; bytes: number } => {
      purgeExpired();
      return { snapshots: snapshots.size, bytes };
    },
    close: (): void => {
      closed = true;
      snapshots.clear();
      pages.clear();
      bytes = 0;
      scheduleSweep();
    },
  };
}
