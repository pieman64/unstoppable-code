/**
 * The in-flight byte bound of `EventPressureGate` (one chat's provider
 * events between arrival and their durable commit).
 *
 * - Default (the delta-journal experiment off): 64 KiB of estimated bytes,
 *   and an event whose size the cheap estimate cannot establish holds the
 *   gate alone, so such events are committed one at a time.
 * - Group commit limits: an event the estimate cannot size is measured
 *   exactly and shares the gate up to 256 KiB, so several commits of one
 *   chat can be in flight together; memory stays bounded by that budget.
 */
import {
  EventPressureGate,
  GROUP_COMMIT_EVENT_PRESSURE_LIMITS,
  type EventPressureLimits,
} from '../agents/event-pressure';

/** A tool result nested deeper than the cheap estimate looks. */
function deepEvent(text: string): unknown {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-1',
          content: [{ type: 'text', text }],
        },
      ],
    },
  };
}

function admitted(
  gate: EventPressureGate,
  event: unknown,
): (() => void) | undefined {
  const admission = gate.admit(event);
  return typeof admission === 'function' ? admission : undefined;
}

describe('EventPressureGate limits', () => {
  it('holds the gate alone for an event it cannot size, by default', () => {
    const gate = new EventPressureGate();
    const first = admitted(gate, deepEvent('first'));
    expect(first).toBeDefined();
    // One at a time: the next event waits for the first one's commit.
    expect(admitted(gate, deepEvent('second'))).toBeUndefined();
    expect(gate.snapshot()).toMatchObject({
      activeCount: 1,
      activeUncertainCount: 1,
      waitingCount: 1,
    });
  });

  it('admits events it measures exactly together, up to the group-commit bound', () => {
    const gate = new EventPressureGate(
      () => GROUP_COMMIT_EVENT_PRESSURE_LIMITS,
    );
    const releases = [1, 2, 3, 4].map((index) =>
      admitted(gate, deepEvent(`result ${index} `.repeat(500))),
    );
    // Four tool results of about 5 KiB are in flight together.
    expect(releases.every((release) => release !== undefined)).toBe(true);
    const snapshot = gate.snapshot();
    expect(snapshot).toMatchObject({
      activeCount: 4,
      activeUncertainCount: 0,
      waitingCount: 0,
    });
    // Charged by their serialized size, not by an estimate.
    const exact = Buffer.byteLength(
      JSON.stringify(deepEvent(`result 1 `.repeat(500))),
      'utf8',
    );
    expect(snapshot.chargedBytes).toBeGreaterThanOrEqual(4 * exact - 8);
    expect(snapshot.chargedBytes).toBeLessThanOrEqual(4 * exact + 8);
  });

  it('stops admitting at the bound and resumes at the low-water mark', async () => {
    const gate = new EventPressureGate(
      () => GROUP_COMMIT_EVENT_PRESSURE_LIMITS,
    );
    const chunk = 'x'.repeat(60 * 1024);
    const releases: Array<() => void> = [];
    // 60 KiB events: four fit under 256 KiB.
    for (let index = 0; index < 4; index += 1) {
      const release = admitted(gate, deepEvent(chunk));
      if (!release) throw new Error(`event ${index} is admitted at once`);
      releases.push(release);
    }
    // The hard bound: a fifth would exceed it, so it waits, and so does
    // everything behind it, until commits settle.
    const waiting = gate.admit(deepEvent(chunk));
    expect(typeof waiting).not.toBe('function');
    expect(admitted(gate, { type: 'assistant' })).toBeUndefined();
    expect(gate.snapshot().chargedBytes).toBeLessThanOrEqual(
      GROUP_COMMIT_EVENT_PRESSURE_LIMITS.highWaterBytes,
    );
    let resumed = false;
    void Promise.resolve(waiting).then(() => {
      resumed = true;
    });
    releases[0]();
    await Promise.resolve();
    await Promise.resolve();
    // About 180 KiB are still in flight: above the 128 KiB low-water mark.
    expect(resumed).toBe(false);
    releases[1]();
    await Promise.resolve();
    await Promise.resolve();
    expect(resumed).toBe(true);
  });

  it('still gives an oversized or unserializable event the gate alone', () => {
    const gate = new EventPressureGate(
      () => GROUP_COMMIT_EVENT_PRESSURE_LIMITS,
    );
    const oversized = admitted(
      gate,
      deepEvent(
        'x'.repeat(GROUP_COMMIT_EVENT_PRESSURE_LIMITS.highWaterBytes + 1),
      ),
    );
    expect(oversized).toBeDefined();
    expect(admitted(gate, { type: 'assistant' })).toBeUndefined();
    oversized?.();

    const cyclic: Record<string, unknown> = { type: 'user', nested: {} };
    cyclic.nested = { deeper: { again: { back: cyclic } } };
    const second = new EventPressureGate(
      () => GROUP_COMMIT_EVENT_PRESSURE_LIMITS,
    );
    expect(admitted(second, cyclic)).toBeDefined();
    expect(second.snapshot().activeUncertainCount).toBe(1);
    expect(admitted(second, { type: 'assistant' })).toBeUndefined();
  });

  it('follows the limits in force at each admission', () => {
    let limits: EventPressureLimits | undefined;
    const gate = new EventPressureGate(() => limits);
    const first = admitted(gate, deepEvent('first'));
    expect(first).toBeDefined();
    expect(admitted(gate, deepEvent('held'))).toBeUndefined();
    first?.();
    // Turning the experiment on applies to the next events.
    limits = GROUP_COMMIT_EVENT_PRESSURE_LIMITS;
    const fresh = new EventPressureGate(() => limits);
    expect(admitted(fresh, deepEvent('a'))).toBeDefined();
    expect(admitted(fresh, deepEvent('b'))).toBeDefined();
    limits = undefined;
    // Back to one unmeasured event at a time.
    expect(admitted(fresh, deepEvent('c'))).toBeUndefined();
  });
});

describe('EventPressureGate admission that must hold the gate alone', () => {
  // An event a follow-up must stay ordered behind (an errored tool result a
  // paired authentication failure follows) is admitted alone: it waits for
  // the events in flight, and nothing is admitted behind it until it is
  // released, even with room under the byte bound.
  it('waits for the events in flight and admits nothing behind it until released', async () => {
    const gate = new EventPressureGate(
      () => GROUP_COMMIT_EVENT_PRESSURE_LIMITS,
    );
    const first = admitted(gate, { type: 'assistant', message: 'first' });
    expect(first).toBeDefined();
    const alone = gate.admit(
      { type: 'user', message: 'errored result' },
      { alone: true },
    );
    expect(typeof alone).not.toBe('function');
    const behind = gate.admit({ type: 'result', message: 'terminal' });
    expect(typeof behind).not.toBe('function');
    first?.();
    const releaseAlone = await alone;
    let behindAdmitted = false;
    void Promise.resolve(behind).then(() => {
      behindAdmitted = true;
    });
    for (let tick = 0; tick < 5; tick += 1)
      await new Promise((resolve) => setImmediate(resolve));
    expect(behindAdmitted).toBe(false);
    expect(gate.snapshot()).toMatchObject({ activeCount: 1, waitingCount: 1 });
    releaseAlone();
    const releaseBehind = await behind;
    expect(behindAdmitted).toBe(true);
    releaseBehind();
    expect(gate.snapshot()).toMatchObject({ activeCount: 0, waitingCount: 0 });
  });

  it('is admitted at once when nothing is in flight', () => {
    const gate = new EventPressureGate(
      () => GROUP_COMMIT_EVENT_PRESSURE_LIMITS,
    );
    const alone = gate.admit({ type: 'user' }, { alone: true });
    expect(typeof alone).toBe('function');
  });
});
