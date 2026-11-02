import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../../runtime/errors';
import {
  CORE_READ_SNAPSHOT_LIMITS,
  createCoreReadSnapshotStore,
  type CoreReadSnapshotBinding,
  type CoreReadSnapshotStore,
  type CoreReadSnapshotLimits,
} from '../core-workspace-read-snapshots';

interface Pinned {
  items: string[];
  legacy: { rows: string[] };
}

const caller: CanopyCallerDescriptor = {
  principalId: 'user',
  clientInstanceId: 'client-1',
  authorityId: 'local-desktop',
  interfaceKind: 'test',
  grants: ['core.workspace.read'],
};
const binding: CoreReadSnapshotBinding = {
  operation: 'core.workspace.list',
  scope: {},
  pageSize: 2,
  caller,
};
const pinned = (count: number): Pinned => {
  const items = Array.from({ length: count }, (_, index) => `item-${index}`);
  return { items, legacy: { rows: [...items] } };
};

function store(
  limits: Partial<CoreReadSnapshotLimits> = {},
  now: () => number = (): number => 0,
): CoreReadSnapshotStore<Pinned> {
  return createCoreReadSnapshotStore<Pinned>(
    { ...CORE_READ_SNAPSHOT_LIMITS, ...limits },
    now,
  );
}

/** The refusal kind `run` throws, if any. */
function refusal(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof CanopyOperationError ? error.payload.kind : 'other';
  }
  return undefined;
}

function isTimeout(value: unknown): value is NodeJS.Timeout {
  return (
    typeof value === 'object' &&
    value !== null &&
    'hasRef' in value &&
    typeof value.hasRef === 'function'
  );
}

function cursorOf(value: string | null): string {
  if (value === null) throw new Error('expected a continuation');
  return value;
}

describe('core read snapshot store', () => {
  it('pins nothing for a single page', () => {
    const snapshots = store();
    expect(snapshots.open(binding, pinned(2), 2)).toBeNull();
  });

  it('replays a page and its terminal page with the same cursors', () => {
    const snapshots = store();
    const second = cursorOf(snapshots.open(binding, pinned(5), 5));
    const page = snapshots.resume(second, binding);
    expect(page).toMatchObject({ offset: 2 });
    const third = cursorOf(page.nextCursor);
    expect(snapshots.resume(second, binding)).toEqual(page);
    expect(snapshots.resume(third, binding)).toMatchObject({
      offset: 4,
      nextCursor: null,
    });
    expect(snapshots.resume(third, binding)).toMatchObject({
      offset: 4,
      nextCursor: null,
    });
  });

  it('keeps the pinned copy apart from its producer and every reader', () => {
    const snapshots = store();
    const original = pinned(3);
    const cursor = cursorOf(snapshots.open(binding, original, 3));
    original.items.reverse();
    original.legacy.rows.length = 0;
    const page = snapshots.resume(cursor, binding);
    page.pinned.items.length = 0;
    expect(snapshots.resume(cursor, binding).pinned).toEqual(pinned(3));
  });

  it('rejects numeric offsets and malformed cursors as invalid', () => {
    const snapshots = store();
    snapshots.open(binding, pinned(5), 5);
    for (const cursor of ['0', '2', '9007199254740993', 'not a cursor', '-1'])
      expect(refusal(() => snapshots.resume(cursor, binding))).toBe(
        'invalid_argument',
      );
    expect(() => snapshots.resume('2', binding)).toThrow(
      'Numeric list cursors are no longer accepted',
    );
  });

  it('refuses another listing, and reads another caller as unknown', () => {
    const snapshots = store();
    const cursor = cursorOf(snapshots.open(binding, pinned(5), 5));
    for (const other of [
      { ...binding, operation: 'core.worktree.list' as const },
      { ...binding, scope: { organizationId: 'org-1' } },
      { ...binding, pageSize: 3 },
    ])
      expect(refusal(() => snapshots.resume(cursor, other))).toBe(
        'invalid_argument',
      );
    for (const other of [
      { ...binding, caller: { ...caller, clientInstanceId: 'client-2' } },
      { ...binding, caller: { ...caller, principalId: 'someone-else' } },
      { ...binding, caller: undefined },
    ])
      expect(refusal(() => snapshots.resume(cursor, other))).toBe(
        'failed_precondition',
      );
    // Grants are not part of the binding; the dispatcher rechecks them.
    expect(
      snapshots.resume(cursor, {
        ...binding,
        caller: { ...caller, grants: [] },
      }),
    ).toMatchObject({ offset: 2 });
  });

  it('expires a listing a fixed time after its first page', () => {
    let now = 0;
    const snapshots = store({ lifetimeMs: 1_000 }, () => now);
    const cursor = cursorOf(snapshots.open(binding, pinned(5), 5));
    now = 999;
    const next = cursorOf(snapshots.resume(cursor, binding).nextCursor);
    now = 1_000;
    expect(refusal(() => snapshots.resume(next, binding))).toBe(
      'failed_precondition',
    );
    expect(refusal(() => snapshots.resume(cursor, binding))).toBe(
      'failed_precondition',
    );
  });

  it('releases an expired listing without waiting for another call', () => {
    jest.useFakeTimers({ now: 0 });
    try {
      const snapshots = createCoreReadSnapshotStore<Pinned>({
        ...CORE_READ_SNAPSHOT_LIMITS,
        lifetimeMs: 1_000,
      });
      snapshots.open(binding, pinned(5), 5);
      jest.advanceTimersByTime(500);
      snapshots.open(binding, pinned(5), 5);
      jest.advanceTimersByTime(499);
      expect(snapshots.retained().snapshots).toBe(2);
      jest.advanceTimersByTime(1);
      expect(snapshots.retained().snapshots).toBe(1);
      jest.advanceTimersByTime(500);
      expect(snapshots.retained()).toEqual({ snapshots: 0, bytes: 0 });
      expect(jest.getTimerCount()).toBe(0);
      snapshots.open(binding, pinned(5), 5);
      snapshots.close();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('sweeps with an unreferenced setTimeout that never holds the process open', () => {
    const scheduled = jest.spyOn(globalThis, 'setTimeout');
    const snapshots = store();
    try {
      snapshots.open(binding, pinned(5), 5);
      expect(scheduled).toHaveBeenCalledTimes(1);
      const timer: unknown = scheduled.mock.results[0]?.value;
      if (!isTimeout(timer)) throw new Error('No sweep timer was scheduled.');
      expect(timer.hasRef()).toBe(false);
    } finally {
      snapshots.close();
      scheduled.mockRestore();
    }
  });

  it('expires a listing when the clock moves backwards', () => {
    let now = 5_000;
    const snapshots = store({ lifetimeMs: 1_000 }, () => now);
    const cursor = cursorOf(snapshots.open(binding, pinned(5), 5));
    now = 4_999;
    expect(refusal(() => snapshots.resume(cursor, binding))).toBe(
      'failed_precondition',
    );
  });

  it('evicts the oldest listing past the snapshot count', () => {
    const snapshots = store({ maxSnapshots: 2 });
    const other = {
      ...binding,
      caller: { ...caller, clientInstanceId: 'client-2' },
    };
    const first = cursorOf(snapshots.open(binding, pinned(3), 3));
    const second = cursorOf(snapshots.open(other, pinned(3), 3));
    const third = cursorOf(snapshots.open(binding, pinned(3), 3));
    expect(refusal(() => snapshots.resume(first, binding))).toBe(
      'failed_precondition',
    );
    expect(snapshots.resume(second, other)).toMatchObject({ offset: 2 });
    expect(snapshots.resume(third, binding)).toMatchObject({ offset: 2 });
  });

  it("evicts a caller's own oldest listing before anyone else's", () => {
    const snapshots = store({ maxSnapshotsPerCaller: 1 });
    const other = {
      ...binding,
      caller: { ...caller, clientInstanceId: 'client-2' },
    };
    const theirs = cursorOf(snapshots.open(other, pinned(3), 3));
    const first = cursorOf(snapshots.open(binding, pinned(3), 3));
    const second = cursorOf(snapshots.open(binding, pinned(3), 3));
    expect(refusal(() => snapshots.resume(first, binding))).toBe(
      'failed_precondition',
    );
    expect(snapshots.resume(second, binding)).toMatchObject({ offset: 2 });
    expect(snapshots.resume(theirs, other)).toMatchObject({ offset: 2 });
  });

  it('evicts by retained bytes and refuses a listing larger than the budget', () => {
    const size = Buffer.byteLength(JSON.stringify(pinned(3)), 'utf8');
    const snapshots = store({ maxBytes: size * 2 });
    const first = cursorOf(snapshots.open(binding, pinned(3), 3));
    const second = cursorOf(snapshots.open(binding, pinned(3), 3));
    const third = cursorOf(snapshots.open(binding, pinned(3), 3));
    expect(refusal(() => snapshots.resume(first, binding))).toBe(
      'failed_precondition',
    );
    expect(snapshots.resume(second, binding)).toMatchObject({ offset: 2 });
    expect(snapshots.resume(third, binding)).toMatchObject({ offset: 2 });
    expect(refusal(() => snapshots.open(binding, pinned(40), 40))).toBe(
      'resource_exhausted',
    );
    // The refused listing evicted nothing.
    expect(snapshots.resume(third, binding)).toMatchObject({ offset: 2 });
  });

  it('drops every listing at teardown and pins no more', () => {
    const snapshots = store();
    const cursor = cursorOf(snapshots.open(binding, pinned(3), 3));
    snapshots.close();
    expect(refusal(() => snapshots.resume(cursor, binding))).toBe(
      'failed_precondition',
    );
    expect(refusal(() => snapshots.open(binding, pinned(3), 3))).toBe(
      'unavailable',
    );
    expect(snapshots.open(binding, pinned(1), 1)).toBeNull();
  });
});
