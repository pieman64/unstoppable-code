import {
  EventPressureGate,
  GROUP_COMMIT_EVENT_PRESSURE_LIMITS,
} from '../agents/event-pressure';

function synchronousRelease(
  gate: EventPressureGate,
  value: unknown,
): () => void {
  const admission = gate.admit(value);
  if (typeof admission !== 'function')
    throw new Error('Expected an immediate event-pressure grant');
  return admission;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('EventPressureGate drain barriers', () => {
  it('does not extend a drain for later admissions during a steady stream', async () => {
    const gate = new EventPressureGate();
    const releaseA = synchronousRelease(gate, { event: 'A' });
    let drained = false;
    const drainCompletion = gate.drain().then(() => {
      drained = true;
    });

    const releaseB = synchronousRelease(gate, { event: 'B' });
    const releaseC = synchronousRelease(gate, { event: 'C' });
    releaseB();
    releaseA();

    try {
      await flush();
      expect(drained).toBe(true);
      expect(gate.snapshot().activeCount).toBe(1);
    } finally {
      releaseC();
    }
    await drainCompletion;
  });

  it('waits for the oldest admission when active events release out of order', async () => {
    const gate = new EventPressureGate();
    const releaseA = synchronousRelease(gate, { event: 'A' });
    const releaseB = synchronousRelease(gate, { event: 'B' });
    let drained = false;
    const drainCompletion = gate.drain().then(() => {
      drained = true;
    });

    releaseB();
    await flush();
    expect(drained).toBe(false);

    releaseA();
    await drainCompletion;
    expect(drained).toBe(true);
  });

  it('includes pre-call waiters but ignores events admitted after the barrier', async () => {
    const gate = new EventPressureGate(
      () => GROUP_COMMIT_EVENT_PRESSURE_LIMITS,
    );
    const releaseExclusive = synchronousRelease(gate, {
      text: 'x'.repeat(GROUP_COMMIT_EVENT_PRESSURE_LIMITS.highWaterBytes + 1),
    });
    const beforeBarrier = gate.admit({ event: 'before barrier' });
    const barrier = gate.drain();
    const afterBarrier = gate.admit({ event: 'after barrier' });
    let drained = false;
    const drainCompletion = barrier.then(() => {
      drained = true;
    });

    releaseExclusive();
    const [releaseBefore, releaseAfter] = await Promise.all([
      beforeBarrier,
      afterBarrier,
    ]);
    try {
      releaseBefore();
      await flush();
      expect(drained).toBe(true);
      expect(gate.snapshot().activeCount).toBe(1);
    } finally {
      releaseAfter();
    }
    await drainCompletion;
  });

  it('resolves multiple barriers independently in captured-position order', async () => {
    const gate = new EventPressureGate();
    const releaseA = synchronousRelease(gate, { event: 'A' });
    const firstDrain = gate.drain();
    const releaseB = synchronousRelease(gate, { event: 'B' });
    const secondDrain = gate.drain();
    const resolved: string[] = [];
    const firstCompletion = firstDrain.then(() => resolved.push('first'));
    const secondCompletion = secondDrain.then(() => resolved.push('second'));

    releaseA();
    await firstCompletion;
    expect(resolved).toEqual(['first']);

    releaseB();
    await secondCompletion;
    expect(resolved).toEqual(['first', 'second']);
  });

  it('resolves immediately when idle', async () => {
    const gate = new EventPressureGate();
    await expect(gate.drain()).resolves.toBeUndefined();
  });

  it('tracks group-commit admissions through a hand-off', async () => {
    const gate = new EventPressureGate(
      () => GROUP_COMMIT_EVENT_PRESSURE_LIMITS,
    );
    const releaseExclusive = synchronousRelease(gate, {
      text: 'x'.repeat(GROUP_COMMIT_EVENT_PRESSURE_LIMITS.highWaterBytes + 1),
    });
    const waiting = gate.admit({ event: 'waiting' });
    const firstDrain = gate.drain();

    releaseExclusive();
    const handedOff = gate.admit({ event: 'handed off behind waiter' });
    const secondDrain = gate.drain();
    const [releaseWaiting, releaseHandedOff] = await Promise.all([
      waiting,
      handedOff,
    ]);
    const resolved: string[] = [];
    const firstCompletion = firstDrain.then(() => resolved.push('first'));
    const secondCompletion = secondDrain.then(() => resolved.push('second'));

    releaseHandedOff();
    await flush();
    expect(resolved).toEqual([]);

    releaseWaiting();
    await Promise.all([firstCompletion, secondCompletion]);
    expect(resolved).toEqual(['first', 'second']);
  });
});
