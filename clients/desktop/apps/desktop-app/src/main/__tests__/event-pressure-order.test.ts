/**
 * Arrival order through `EventPressureGate` when a producer does not wait
 * for each admission before sending the next event (the Codex owner lane's
 * in-flight budget, phase 11): an event admitted at once must not overtake
 * an earlier event whose grant is still on its way to it.
 *
 * The guard belongs to the group-commit limits. With a generic gate using
 * its default limits, admission is what it was before
 * group commit: an event that fits is granted synchronously, also in that
 * window.
 */
import {
  EventPressureGate,
  GROUP_COMMIT_EVENT_PRESSURE_LIMITS,
} from '../agents/event-pressure';

/** Above the group-commit bound (and the default one): the exclusive slot. */
const OVERSIZED = {
  text: 'x'.repeat(GROUP_COMMIT_EVENT_PRESSURE_LIMITS.highWaterBytes + 1),
};

function groupCommitGate(): EventPressureGate {
  return new EventPressureGate(() => GROUP_COMMIT_EVENT_PRESSURE_LIMITS);
}

async function flush(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

describe('EventPressureGate arrival order', () => {
  it('does not let a later event overtake a waiter whose grant is in hand-off', async () => {
    const gate = groupCommitGate();
    const order: string[] = [];
    // An oversized event takes the exclusive slot.
    const oversized = gate.admit(OVERSIZED);
    if (typeof oversized !== 'function')
      throw new Error('The first event is admitted at once');
    // The next event has to wait for it.
    const waiting = gate.admit({ first: 1 });
    if (typeof waiting === 'function')
      throw new Error('An event behind an exclusive one waits');
    void waiting.then(() => order.push('first'));
    // Releasing the slot hands the waiter its grant; its continuation has
    // not run yet when the next event arrives in the same synchronous step.
    oversized();
    const later = gate.admit({ second: 2 });
    if (typeof later === 'function') order.push('second');
    else void later.then(() => order.push('second'));
    const third = gate.admit({ third: 3 });
    if (typeof third === 'function') order.push('third');
    else void third.then(() => order.push('third'));
    await flush();
    expect(order).toEqual(['first', 'second', 'third']);
    // With nothing in hand-off, admission is synchronous again.
    expect(typeof gate.admit({ fourth: 4 })).toBe('function');
  });

  it('still accounts for an event admitted behind a hand-off', async () => {
    const gate = groupCommitGate();
    const oversized = gate.admit(OVERSIZED);
    if (typeof oversized !== 'function')
      throw new Error('The first event is admitted at once');
    const waiting = gate.admit({ first: 1 });
    if (typeof waiting === 'function')
      throw new Error('An event behind an exclusive one waits');
    oversized();
    const later = gate.admit({ second: 2 });
    const releases = await Promise.all([waiting, Promise.resolve(later)]);
    expect(gate.snapshot().activeCount).toBe(2);
    for (const release of releases) release();
    expect(gate.snapshot()).toMatchObject({
      activeCount: 0,
      chargedBytes: 0,
      waitingCount: 0,
    });
    await gate.drain();
  });

  describe('with an unconfigured generic gate', () => {
    it('grants an event synchronously while an earlier grant is in hand-off', async () => {
      const gate = new EventPressureGate();
      const order: string[] = [];
      const oversized = gate.admit(OVERSIZED);
      if (typeof oversized !== 'function')
        throw new Error('The first event is admitted at once');
      const waiting = gate.admit({ first: 1 });
      if (typeof waiting === 'function')
        throw new Error('An event behind an exclusive one waits');
      void waiting.then(() => order.push('first'));
      // The release grants the waiter; its continuation has not run yet.
      oversized();
      // As before group commit: an event that fits is granted in the same
      // synchronous step, not through a promise.
      const later = gate.admit({ second: 2 });
      expect(typeof later).toBe('function');
      if (typeof later === 'function') order.push('second');
      expect(gate.snapshot()).toMatchObject({
        activeCount: 2,
        waitingCount: 0,
      });
      await flush();
      expect(order).toEqual(['second', 'first']);
    });

    it('follows the limits in effect at each admission', async () => {
      let groupCommit = false;
      const gate = new EventPressureGate(() =>
        groupCommit ? GROUP_COMMIT_EVENT_PRESSURE_LIMITS : undefined,
      );
      /** Admit an event while an earlier waiter's grant is in hand-off. */
      const admitInHandOff = (): (() => void) | Promise<() => void> => {
        const oversized = gate.admit(OVERSIZED);
        if (typeof oversized !== 'function')
          throw new Error('The first event is admitted at once');
        const waiting = gate.admit({ first: 1 });
        if (typeof waiting === 'function')
          throw new Error('An event behind an exclusive one waits');
        void waiting.then((release) => release());
        oversized();
        return gate.admit({ second: 2 });
      };
      const off = admitInHandOff();
      expect(typeof off).toBe('function');
      (await off)();
      await flush();
      expect(gate.snapshot()).toMatchObject({ activeCount: 0 });
      groupCommit = true;
      const on = admitInHandOff();
      expect(typeof on).not.toBe('function');
      (await on)();
      await flush();
      expect(gate.snapshot()).toMatchObject({
        activeCount: 0,
        chargedBytes: 0,
        waitingCount: 0,
      });
    });
  });
});
