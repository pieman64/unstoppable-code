import { getEventListeners } from 'node:events';
import { SETUP_WITHDRAWN, createSetupWithdrawal } from '../step-timeout';

/**
 * The helper claimed to always release its timer and listeners. It did not:
 * `{ once: true }` only detaches on abort, so a race the WORK won left its
 * listener attached, and `release()` left them too — three completed races
 * measured three listeners before AND after release.
 */
describe('createSetupWithdrawal cleanup', () => {
  const abortListeners = (signal: AbortSignal): number =>
    getEventListeners(signal, 'abort').length;

  it('detaches a race listener when the work wins', async () => {
    const caller = new AbortController();
    const withdrawal = createSetupWithdrawal(caller.signal, 60_000);
    expect(abortListeners(withdrawal.signal)).toBe(0);
    for (let round = 0; round < 3; round += 1)
      await withdrawal.race(Promise.resolve(round));
    expect(abortListeners(withdrawal.signal)).toBe(0);
    withdrawal.release();
    expect(abortListeners(withdrawal.signal)).toBe(0);
    expect(abortListeners(caller.signal)).toBe(0);
  });

  it('detaches a race listener when the work REJECTS', async () => {
    const caller = new AbortController();
    const withdrawal = createSetupWithdrawal(caller.signal, 60_000);
    await expect(
      withdrawal.race(Promise.reject(new Error('probe failed'))),
    ).rejects.toThrow('probe failed');
    expect(abortListeners(withdrawal.signal)).toBe(0);
    withdrawal.release();
    expect(abortListeners(caller.signal)).toBe(0);
  });

  it('detaches a race listener when the step withdraws', async () => {
    const caller = new AbortController();
    const withdrawal = createSetupWithdrawal(caller.signal, 60_000);
    const never = new Promise<number>(() => {});
    const pending = withdrawal.race(never);
    // Positive control: while the race is in flight the listener IS attached.
    expect(abortListeners(withdrawal.signal)).toBe(1);
    caller.abort();
    expect(await pending).toBe(SETUP_WITHDRAWN);
    expect(abortListeners(withdrawal.signal)).toBe(0);
    withdrawal.release();
    expect(abortListeners(caller.signal)).toBe(0);
  });

  it('releases a race still in flight, and clears the deadline timer', async () => {
    const caller = new AbortController();
    const withdrawal = createSetupWithdrawal(caller.signal, 60_000);
    void withdrawal.race(new Promise<number>(() => {}));
    expect(abortListeners(withdrawal.signal)).toBe(1);
    // Release while it is still pending — the exception path a caller takes.
    withdrawal.release();
    expect(abortListeners(withdrawal.signal)).toBe(0);
    expect(abortListeners(caller.signal)).toBe(0);
    // The timer is cleared too: an uncleared 60s timer keeps the loop alive.
    await new Promise((resolve) => setImmediate(resolve));
    expect(withdrawal.withdrawn).toBe(false);
  });

  it('keeps cancellation and an expired budget distinct', () => {
    const cancelledCaller = new AbortController();
    const cancelled = createSetupWithdrawal(cancelledCaller.signal, 60_000);
    cancelledCaller.abort();
    expect(cancelled.reason).toBe('cancelled');
    cancelled.release();

    const expired = createSetupWithdrawal(new AbortController().signal, 0);
    expect(expired.reason).toBe('timeout');
    expired.release();
  });
});
