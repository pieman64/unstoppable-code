import type {
  CanopyEvent,
  CanopyStreamCursor,
} from '@canopy/protocol/canopy-core';
import { CanopyClientError } from '../errors';
import {
  CanopyEventLedger,
  type CanopyEventLedgerEntry,
  type CanopyEventLedgerOptions,
} from '../events/ledger';
import type { CanopyEventPriority } from '../events/types';
import { encodedSize } from '../stream-budget';

const at = (sequence: number, daemonEpoch = 'e1'): CanopyStreamCursor => ({
  daemonEpoch,
  sequence,
});

function event(sequence: number, text = 'x', epoch = 'e1'): CanopyEvent {
  return {
    cursor: at(sequence, epoch),
    eventId: `ev-${sequence}`,
    name: 'core.test.happened',
    scope: {},
    occurredAt: '2026-10-08T00:00:00.000Z',
    payload: { text },
  };
}

function ledger(
  limits: Partial<CanopyEventLedgerOptions> = {},
  sequence: number | null = null,
): CanopyEventLedger {
  const defaults = { maxBufferedOutput: 99, maxBufferedOutputBytes: 1e6 };
  return new CanopyEventLedger(
    { ...defaults, maxPendingEvents: 99, ...limits },
    sequence === null ? null : at(sequence),
  );
}

function add(
  target: CanopyEventLedger,
  priority: CanopyEventPriority,
  ...sequences: number[]
): void {
  sequences.forEach((sequence) => target.enqueue(event(sequence), priority));
}

function take(target: CanopyEventLedger, count = 1): CanopyEventLedgerEntry[] {
  return Array.from({ length: count }, () => {
    const entry = target.take();
    if (!entry) throw new Error('expected an entry');
    return entry;
  });
}

const labels = (entries: CanopyEventLedgerEntry[]): string[] =>
  entries.map(({ delivery: d }) =>
    d.kind === 'gap'
      ? `gap:${d.from.sequence}-${d.to.sequence}/${d.dropped}`
      : `${d.priority[0]}${d.event.cursor.sequence}`,
  );

function refusal(target: CanopyEventLedger, next: CanopyEvent): string {
  try {
    target.enqueue(next, 'lifecycle');
  } catch (error) {
    return error instanceof CanopyClientError ? error.payload.kind : 'untyped';
  }
  return 'accepted';
}

describe('CanopyEventLedger', () => {
  it('takes lifecycle before queued output in lane order and never preempts in-flight output', () => {
    const target = ledger();
    add(target, 'output', 1);
    const [first] = take(target);
    add(target, 'output', 2);
    add(target, 'lifecycle', 3, 4);
    const [l3, l4, o2] = take(target, 3);
    expect(labels([first, l3, l4, o2])).toEqual(['o1', 'l3', 'l4', 'o2']);
    expect(target.take()).toBeNull();

    expect(target.settle(l3)).toBeNull();
    expect(target.settle(l4)).toBeNull();
    expect(target.cursor).toBeNull();
    expect(target.settle(first)).toEqual(at(1));
    expect(target.settle(o2)).toEqual(at(4));
    expect(target.pendingEvents).toBe(0);
  });

  it('dedupes committed and tracked sequences, accepts sparse ones, and rejects reordering', () => {
    const target = ledger({}, 3);
    add(target, 'lifecycle', 3, 5, 5);
    add(target, 'output', 9);
    expect(refusal(target, event(7))).toBe('failed_precondition');
    expect(refusal(target, event(10, 'x', 'e2'))).toBe('failed_precondition');
    expect(target.pendingEvents).toBe(2);

    const [five, nine] = take(target, 2);
    add(target, 'output', 9);
    expect(target.settle(nine)).toBeNull();
    add(target, 'output', 9);
    expect(target.settle(five)).toEqual(at(9));
    add(target, 'output', 9);
    expect(target.take()).toBeNull();
  });

  it('adopts the first epoch when no cursor is committed', () => {
    const target = ledger();
    target.enqueue(event(4, 'x', 'e2'), 'lifecycle');
    expect(refusal(target, event(5))).toBe('failed_precondition');
    expect(target.settle(take(target)[0])).toEqual(at(4, 'e2'));
  });

  it('evicts the oldest undispatched output into a gap that blocks the cursor until settled', () => {
    const target = ledger({ maxBufferedOutput: 2 });
    add(target, 'output', 1);
    const [inFlight] = take(target);
    add(target, 'output', 2, 3, 4);
    add(target, 'lifecycle', 5);
    expect(target.bufferedOutput).toBe(2);

    const [gap, l5, o4] = take(target, 3);
    expect(labels([gap, l5, o4])).toEqual(['gap:2-3/2', 'l5', 'o4']);
    expect(target.settle(inFlight)).toEqual(at(1));
    expect(target.bufferedOutput).toBe(1);
    expect(target.settle(o4)).toBeNull();
    expect(target.settle(l5)).toBeNull();
    expect(target.settle(gap)).toEqual(at(5));
  });

  it('starts a new gap once the previous gap is in flight', () => {
    const target = ledger({ maxBufferedOutput: 1 });
    add(target, 'output', 1, 2);
    const [gap] = take(target);
    add(target, 'output', 3, 4);
    expect(labels([gap, ...take(target, 2)])).toEqual([
      'gap:1-1/1',
      'gap:2-3/2',
      'o4',
    ]);
  });

  it('bounds output by UTF-8 JSON bytes, gapping an oversize output immediately', () => {
    const wide = event(1, 'ééé');
    const limit = JSON.stringify(wide).length;
    const target = ledger({ maxBufferedOutputBytes: limit });
    target.enqueue(wide, 'output');
    expect(target.bufferedOutputBytes).toBe(0);
    const small = event(2, 'a');
    target.enqueue(small, 'output');
    expect(target.bufferedOutputBytes).toBe(encodedSize(small));
    target.enqueue(event(3, 'bb'), 'output');
    target.enqueue(event(4, 'c'), 'output');
    expect(labels(take(target, 2))).toEqual(['gap:1-3/3', 'o4']);
    expect(target.bufferedOutput).toBe(1);
  });

  it('caps all tracked sequences, including settled ones behind an unsettled entry', () => {
    const target = ledger({ maxPendingEvents: 2 });
    add(target, 'lifecycle', 1, 2);
    expect(refusal(target, event(3))).toBe('resource_exhausted');
    const [one, two] = take(target, 2);
    expect(target.settle(two)).toBeNull();
    expect(refusal(target, event(3))).toBe('resource_exhausted');
    expect(target.settle(one)).toEqual(at(2));
    expect(refusal(target, event(3))).toBe('accepted');
    expect(labels(take(target))).toEqual(['l3']);
  });

  it('counts gapped output against the pending cap until the gap settles', () => {
    const target = ledger({ maxBufferedOutput: 0, maxPendingEvents: 2 });
    add(target, 'output', 1, 2);
    expect(refusal(target, event(3))).toBe('resource_exhausted');
    const [gap] = take(target);
    expect(labels([gap])).toEqual(['gap:1-2/2']);
    expect(target.settle(gap)).toEqual(at(2));
    expect(refusal(target, event(3))).toBe('accepted');
  });

  it('rejects settling an entry that is not in flight', () => {
    const target = ledger();
    add(target, 'lifecycle', 1);
    const [entry] = take(target);
    target.settle(entry);
    expect(() => target.settle(entry)).toThrow(CanopyClientError);
  });

  describe('cursor isolation', () => {
    it('detaches the constructor cursor from its caller', () => {
      const start = at(3);
      const target = new CanopyEventLedger(
        {
          maxBufferedOutput: 9,
          maxBufferedOutputBytes: 1e6,
          maxPendingEvents: 9,
        },
        start,
      );
      start.sequence = 7;
      start.daemonEpoch = 'e2';
      expect(target.cursor).toEqual(at(3));
      add(target, 'lifecycle', 4);
      expect(target.settle(take(target)[0])).toEqual(at(4));
    });

    it('detaches cursors returned by the getter and by settle', () => {
      const target = ledger();
      add(target, 'lifecycle', 1, 2);
      const [one, two] = take(target, 2);
      const settled = target.settle(one);
      if (settled) settled.sequence = 50;
      const exposed = target.cursor;
      if (exposed) exposed.sequence = 60;
      expect(target.cursor).toEqual(at(1));
      expect(target.settle(two)).toEqual(at(2));
      add(target, 'lifecycle', 3);
      expect(labels(take(target))).toEqual(['l3']);
    });

    it('detaches queued events from mutation or replacement of the enqueued cursor', () => {
      const target = ledger({ maxBufferedOutput: 1 });
      const mutated = event(1);
      const replaced = event(2);
      target.enqueue(mutated, 'lifecycle');
      target.enqueue(replaced, 'output');
      target.enqueue(event(3), 'output');
      mutated.cursor.sequence = 40;
      replaced.cursor = at(41);
      const entries = take(target, 3);
      expect(labels(entries)).toEqual(['l1', 'gap:2-2/1', 'o3']);
      entries.forEach((entry) => target.settle(entry));
      expect(target.cursor).toEqual(at(3));
    });

    it('detaches the slot cursor from a still-queued event cursor', () => {
      const target = ledger();
      const queued = event(1);
      target.enqueue(queued, 'lifecycle');
      queued.cursor.sequence = 40;
      expect(target.settle(take(target)[0])).toEqual(at(1));
    });

    it('detaches open gap bounds from later evictions and their sources', () => {
      const target = ledger({ maxBufferedOutput: 0 });
      const first = event(1);
      const last = event(2);
      target.enqueue(first, 'output');
      first.cursor.sequence = 30;
      target.enqueue(last, 'output');
      last.cursor.sequence = 31;
      const [gap] = take(target);
      expect(labels([gap])).toEqual(['gap:1-2/2']);
      expect(target.settle(gap)).toEqual(at(2));
    });

    it('detaches delivered cursors from ledger state', () => {
      const target = ledger({ maxBufferedOutput: 1 });
      add(target, 'lifecycle', 1);
      add(target, 'output', 2, 3);
      const entries = take(target, 3);
      expect(labels(entries)).toEqual(['l1', 'gap:2-2/1', 'o3']);
      for (const { delivery } of entries) {
        if (delivery.kind === 'gap') {
          delivery.from.sequence = 70;
          delivery.to.sequence = 71;
        } else {
          delivery.event.cursor.sequence += 80;
        }
      }
      const [lifecycle, gap, output] = entries;
      expect(target.settle(lifecycle)).toEqual(at(1));
      expect(target.settle(gap)).toEqual(at(2));
      expect(target.settle(output)).toEqual(at(3));
      add(target, 'lifecycle', 4);
      expect(labels(take(target))).toEqual(['l4']);
    });
  });
});
