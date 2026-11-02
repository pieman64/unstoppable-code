import type { CanopyErrorPayload } from '@canopy/protocol/canopy-core';

import {
  CANOPY_CONNECTION_DEFAULTS,
  CanopyClientError,
  deliverCanopy,
  toCanopyClientError,
  type CanopyDeliveryAttempt,
  type CanopyDeliveryOptions,
} from '../index';

const BUSY: CanopyErrorPayload = {
  kind: 'unavailable',
  message: 'Busy.',
  retry: { kind: 'same_request' },
};
const failWith = (payload: CanopyErrorPayload) => (): Promise<never> =>
  Promise.reject(new CanopyClientError(payload));

interface Started<T> {
  outcome: Promise<{ value?: T; error?: CanopyClientError }>;
  /** When each attempt started, in ms after the delivery began. */
  sends: number[];
  remaining: number[];
  retried: string[];
}

/** Runs a delivery under fake timers, recording when each attempt starts. */
function start<T>(
  run: (attempt: CanopyDeliveryAttempt) => Promise<T>,
  options: Partial<CanopyDeliveryOptions<T>> = {},
): Started<T> {
  const began = performance.now();
  const sends: number[] = [];
  const remaining: number[] = [];
  const retried: string[] = [];
  const outcome = deliverCanopy(
    (attempt) => {
      sends.push(performance.now() - began);
      remaining.push(attempt.remainingMs());
      return run(attempt);
    },
    {
      replay: 'same_request',
      onRetry: (error) => retried.push(error.payload.kind),
      ...options,
    },
  ).then(
    (value): { value?: T; error?: CanopyClientError } => ({ value }),
    (error: unknown) => ({ error: toCanopyClientError(error) }),
  );
  return { outcome, sends, remaining, retried };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('deliverCanopy', () => {
  it('backs off from the shared defaults, a directive delay as the floor', async () => {
    let calls = 0;
    const { outcome, sends } = start(() => {
      calls += 1;
      if (calls === 2)
        return failWith({
          ...BUSY,
          retry: { kind: 'same_request', delayMs: 6_000 },
        })();
      return calls < 5 ? failWith(BUSY)() : Promise.resolve('done');
    });
    await jest.advanceTimersByTimeAsync(20_000);
    await expect(outcome).resolves.toEqual({ value: 'done' });
    // 1 s, then the directive's 6 s over the 2 s backoff, then 4 s and 8 s.
    expect(sends).toEqual([0, 1_000, 7_000, 11_000, 19_000]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('exhausts one deadline across attempts, keeping the replay directive', async () => {
    const lost: CanopyErrorPayload = {
      ...BUSY,
      retry: { kind: 'same_idempotency_key' },
    };
    const { outcome, sends, remaining } = start(failWith(lost), {
      replay: 'same_idempotency_key',
    });
    await jest.advanceTimersByTimeAsync(
      CANOPY_CONNECTION_DEFAULTS.deliveryTimeoutMs,
    );
    const { error } = await outcome;
    expect(error?.payload).toEqual({
      kind: 'deadline_exceeded',
      message: 'Delivery timed out.',
      retry: { kind: 'same_idempotency_key' },
    });
    // 1, 2, 4, 8, then 8 s capped; the next wait would pass the deadline.
    expect(sends).toEqual([0, 1_000, 3_000, 7_000, 15_000, 23_000]);
    expect(remaining).toEqual(sends.map((at) => 30_000 - at));
    expect(jest.getTimerCount()).toBe(0);
  });

  it('fails at once when a directive delay would pass the deadline', async () => {
    const slow: CanopyErrorPayload = {
      ...BUSY,
      retry: { kind: 'same_request', delayMs: 5_000 },
    };
    const { outcome, sends, retried } = start(failWith(slow), {
      timeoutMs: 4_000,
    });
    await jest.advanceTimersByTimeAsync(0);
    await expect(outcome).resolves.toMatchObject({
      error: { payload: { kind: 'deadline_exceeded' } },
    });
    expect(sends).toEqual([0]);
    expect(retried).toEqual([]);
  });

  const ENDS: { on: string; payload: CanopyErrorPayload }[] = [
    { on: 'never', payload: { ...BUSY, retry: { kind: 'never' } } },
    {
      on: 'after_refresh',
      payload: { ...BUSY, retry: { kind: 'after_refresh', resource: 'lease' } },
    },
    {
      on: 'the other replay kind',
      payload: { ...BUSY, retry: { kind: 'same_idempotency_key' } },
    },
    { on: 'revoked access', payload: { ...BUSY, kind: 'permission_denied' } },
    { on: 'an ended session', payload: { ...BUSY, kind: 'unauthenticated' } },
    { on: 'a remote cancel', payload: { ...BUSY, kind: 'cancelled' } },
  ];
  it.each(ENDS)(
    'ends on $on with the failure as it arrived',
    async ({ payload }) => {
      const { outcome, sends } = start(failWith(payload));
      await jest.advanceTimersByTimeAsync(60_000);
      expect((await outcome).error?.payload).toEqual(payload);
      expect(sends).toEqual([0]);
    },
  );

  it('ends a failure the caller recovers itself', async () => {
    const { outcome, sends } = start(failWith(BUSY), {
      isFinal: (error) => error.payload.kind === 'unavailable',
    });
    await jest.advanceTimersByTimeAsync(60_000);
    await expect(outcome).resolves.toMatchObject({ error: { payload: BUSY } });
    expect(sends).toEqual([0]);
  });

  it.each(['in a wait', 'in flight'] as const)(
    'stops %s on cancellation, releasing a late result',
    async (when) => {
      const controller = new AbortController();
      const released: string[] = [];
      let finish: (value: string) => void = () => {};
      const { outcome, sends } = start(
        (attempt) =>
          attempt.attempt === 1 && when === 'in a wait'
            ? failWith(BUSY)()
            : new Promise<string>((resolve) => (finish = resolve)),
        { signal: controller.signal, release: (value) => released.push(value) },
      );
      await jest.advanceTimersByTimeAsync(when === 'in a wait' ? 500 : 0);
      controller.abort();
      await expect(outcome).resolves.toMatchObject({
        error: { payload: { kind: 'cancelled', retry: { kind: 'never' } } },
      });
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(60_000);
      finish('late');
      await jest.advanceTimersByTimeAsync(0);
      expect(sends).toEqual([0]);
      expect(released).toEqual(when === 'in flight' ? ['late'] : []);
    },
  );

  it('aborts an attempt still in flight at the deadline', async () => {
    let attemptSignal: AbortSignal | undefined;
    const { outcome } = start(
      ({ signal }) => {
        attemptSignal = signal;
        return new Promise(() => {});
      },
      { timeoutMs: 2_000 },
    );
    await jest.advanceTimersByTimeAsync(2_000);
    await expect(outcome).resolves.toMatchObject({
      error: {
        payload: { kind: 'deadline_exceeded', retry: { kind: 'never' } },
      },
    });
    expect(attemptSignal?.aborted).toBe(true);
  });

  it.each(['before a retry', 'while a reply is in flight'] as const)(
    'fails closed when the destination changes %s, restoring nothing',
    async (when) => {
      let account = 'account-1';
      const released: string[] = [];
      const { outcome, sends } = start(
        () => {
          if (when === 'before a retry') return failWith(BUSY)();
          account = 'account-2';
          return Promise.resolve('account-1 data');
        },
        {
          current: () => account === 'account-1',
          release: (value) => released.push(value),
        },
      );
      if (when === 'before a retry') {
        await jest.advanceTimersByTimeAsync(500);
        account = 'account-2';
      }
      await jest.advanceTimersByTimeAsync(60_000);
      expect((await outcome).error?.payload).toEqual({
        kind: 'failed_precondition',
        message: 'The delivery destination changed.',
        retry: { kind: 'after_refresh', resource: 'destination' },
      });
      expect(sends).toEqual([0]);
      const stale = when === 'before a retry' ? [] : ['account-1 data'];
      expect(released).toEqual(stale);
    },
  );

  it.each(Array.from({ length: 8 }, (_, turns) => turns))(
    'accepts only while current when the destination changes %i turns after the reply',
    async (turns) => {
      let account = 'account-1';
      const accepted: string[] = [];
      const released: string[] = [];
      const flip = (left: number): void => {
        if (left === 0) account = 'account-2';
        else queueMicrotask(() => flip(left - 1));
      };
      const { outcome } = start(
        () => {
          flip(turns);
          return Promise.resolve('account-1 data');
        },
        {
          current: () => account === 'account-1',
          accept: () => accepted.push(account),
          release: (value) => released.push(value),
        },
      );
      await jest.advanceTimersByTimeAsync(0);
      const { value } = await outcome;
      if (value === undefined) expect(released).toEqual(['account-1 data']);
      else expect(accepted).toEqual(['account-1']);
      expect(accepted.length + released.length).toBe(1);
    },
  );
});

describe('deliverCanopy attempt signal', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('detaches the caller signal before accept runs', async () => {
    const controller = new AbortController();
    let attemptSignal: AbortSignal | undefined;
    const value = await deliverCanopy(
      ({ signal }) => {
        attemptSignal = signal;
        return Promise.resolve('adopted');
      },
      {
        replay: 'same_request',
        signal: controller.signal,
        accept: () => controller.abort(),
      },
    );
    expect(value).toBe('adopted');
    expect(attemptSignal?.aborted).toBe(false);
  });
});
