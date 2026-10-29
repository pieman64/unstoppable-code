import {
  MainFrameNavigationGate,
  READ_NAVIGATION_WAIT_MS,
} from '../browser/navigation-read-gate';

/**
 * Phase 04b E2: a read that arrives while the main frame navigates waits
 * for the new document's DOMContentLoaded, bounded, and never for the old
 * document.
 */
describe('MainFrameNavigationGate', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  async function settledWithin(
    promise: Promise<unknown>,
  ): Promise<{ settled: boolean; value?: unknown }> {
    let outcome: { settled: boolean; value?: unknown } = { settled: false };
    void promise.then((value) => {
      outcome = { settled: true, value };
    });
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    return outcome;
  }

  it('bounds the wait at 2 seconds', () => {
    expect(READ_NAVIGATION_WAIT_MS).toBe(2_000);
  });

  it('does not wait when no navigation is in flight', async () => {
    const gate = new MainFrameNavigationGate();
    expect(gate.inFlight).toBe(false);
    expect(await settledWithin(gate.wait({ timeoutMs: 2_000 }))).toEqual({
      settled: true,
      value: 'ready',
    });
  });

  it('waits from navigation start until the committed document is DOM-ready', async () => {
    const gate = new MainFrameNavigationGate();
    gate.started();
    const wait = gate.wait({ timeoutMs: 2_000 });
    expect(await settledWithin(wait)).toEqual({ settled: false });
    // The document being replaced reaching DOMContentLoaded does not count.
    gate.domContentLoaded();
    expect(await settledWithin(wait)).toEqual({ settled: false });
    gate.committed();
    expect(gate.inFlight).toBe(true);
    expect(await settledWithin(wait)).toEqual({ settled: false });
    gate.domContentLoaded();
    expect(gate.inFlight).toBe(false);
    expect(await settledWithin(wait)).toEqual({
      settled: true,
      value: 'ready',
    });
  });

  it('ends the wait when the navigation fails or stops', async () => {
    for (const end of ['before commit', 'after commit'] as const) {
      const gate = new MainFrameNavigationGate();
      gate.started();
      if (end === 'after commit') gate.committed();
      const wait = gate.wait({ timeoutMs: 2_000 });
      gate.stopped();
      expect([end, await settledWithin(wait)]).toEqual([
        end,
        { settled: true, value: 'ready' },
      ]);
      expect(gate.inFlight).toBe(false);
    }
  });

  it('a newer navigation keeps the wait open until its own document is ready', async () => {
    const gate = new MainFrameNavigationGate();
    gate.started();
    gate.committed();
    const wait = gate.wait({ timeoutMs: 2_000 });
    gate.started();
    gate.domContentLoaded();
    expect(await settledWithin(wait)).toEqual({ settled: false });
    gate.committed();
    gate.domContentLoaded();
    expect(await settledWithin(wait)).toEqual({
      settled: true,
      value: 'ready',
    });
  });

  it('a commit without a start (no navigation seen) does not open a wait', () => {
    const gate = new MainFrameNavigationGate();
    gate.committed();
    expect(gate.inFlight).toBe(false);
  });

  it('proceeds after the bound with whatever document is there', async () => {
    jest.useFakeTimers();
    const gate = new MainFrameNavigationGate();
    gate.started();
    const wait = gate.wait({ timeoutMs: 2_000 });
    await jest.advanceTimersByTimeAsync(1_999);
    expect(await settledWithin(wait)).toEqual({ settled: false });
    await jest.advanceTimersByTimeAsync(1);
    expect(await settledWithin(wait)).toEqual({
      settled: true,
      value: 'timeout',
    });
    // The navigation is still in flight; the next read waits again.
    expect(gate.inFlight).toBe(true);
  });

  it('an abort or an interruption ends the wait, and every listener is removed', async () => {
    const gate = new MainFrameNavigationGate();
    gate.started();
    const controller = new AbortController();
    const removeSpy = jest.spyOn(controller.signal, 'removeEventListener');
    const aborted = gate.wait({ timeoutMs: 2_000, signal: controller.signal });
    controller.abort();
    expect(await settledWithin(aborted)).toEqual({
      settled: true,
      value: 'interrupted',
    });

    let interrupt: (() => void) | undefined;
    const removed = jest.fn();
    const interrupted = gate.wait({
      timeoutMs: 2_000,
      interrupt: (end) => {
        interrupt = end;
        return removed;
      },
    });
    expect(await settledWithin(interrupted)).toEqual({ settled: false });
    interrupt?.();
    expect(await settledWithin(interrupted)).toEqual({
      settled: true,
      value: 'interrupted',
    });
    expect(removed).toHaveBeenCalledTimes(1);

    const ready = gate.wait({
      timeoutMs: 2_000,
      signal: controller.signal,
      interrupt: () => removed,
    });
    expect(await settledWithin(ready)).toEqual({
      settled: true,
      value: 'interrupted',
    });
    expect(removeSpy).toHaveBeenCalled();
  });

  it('an already aborted request does not wait', async () => {
    const gate = new MainFrameNavigationGate();
    gate.started();
    const controller = new AbortController();
    controller.abort();
    expect(
      await settledWithin(
        gate.wait({ timeoutMs: 2_000, signal: controller.signal }),
      ),
    ).toEqual({ settled: true, value: 'interrupted' });
  });

  it('releases timers and waiters when the wait ends', async () => {
    jest.useFakeTimers();
    const gate = new MainFrameNavigationGate();
    gate.started();
    const wait = gate.wait({ timeoutMs: 2_000 });
    gate.committed();
    gate.domContentLoaded();
    await wait;
    expect(jest.getTimerCount()).toBe(0);
  });
});
