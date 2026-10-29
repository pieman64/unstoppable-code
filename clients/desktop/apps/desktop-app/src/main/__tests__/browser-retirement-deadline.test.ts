import {
  BROWSER_RETIREMENT_DEADLINE_MS,
  BrowserRetirementTimeoutError,
  runWithBrowserRetirementDeadlineScope,
  withBrowserRetirementDeadline,
} from '../lib/browser-retirement-deadline';
import { logMainProcessWarn } from '../lib/main-process-logging';

jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

const LATE_FAILURE_LOG = 'Browser profile retirement failed after its deadline';

describe('browser retirement deadline', () => {
  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    jest.mocked(logMainProcessWarn).mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function flush(): Promise<void> {
    return new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }

  function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: Error) => void;
  } {
    let resolve: (value: T) => void = () => undefined;
    let reject: (error: Error) => void = () => undefined;
    const promise = new Promise<T>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    return { promise, resolve, reject };
  }

  /** Starts a call that outlasts the deadline and returns its rejection. */
  async function expire<T>(
    call: () => Promise<T>,
    settleLate?: (value: T) => Promise<void>,
  ): Promise<unknown> {
    const outcome = withBrowserRetirementDeadline(call, settleLate).then(
      () => undefined,
      (error: unknown) => error,
    );
    jest.advanceTimersByTime(BROWSER_RETIREMENT_DEADLINE_MS);
    return outcome;
  }

  it('returns the answer and clears the deadline when the call answers in time', async () => {
    await expect(
      withBrowserRetirementDeadline(() => Promise.resolve('fence')),
    ).resolves.toBe('fence');

    expect(jest.getTimerCount()).toBe(0);
  });

  it('reports the failure of a call that fails in time, without expiring the scope', async () => {
    await runWithBrowserRetirementDeadlineScope(async () => {
      await expect(
        withBrowserRetirementDeadline(() =>
          Promise.reject(new Error('profile metadata unavailable')),
        ),
      ).rejects.toThrow('profile metadata unavailable');
      const next = jest.fn(() => Promise.resolve('fence'));

      await expect(withBrowserRetirementDeadline(next)).resolves.toBe('fence');
      expect(next).toHaveBeenCalledTimes(1);
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects with a timeout once the deadline passes', async () => {
    const pending = deferred<string>();

    const error = await expire(() => pending.promise);

    expect(error).toBeInstanceOf(BrowserRetirementTimeoutError);
    expect(error).toMatchObject({ code: 'timeout' });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not expire before the deadline', async () => {
    const pending = deferred<string>();
    const outcome = withBrowserRetirementDeadline(() => pending.promise);

    jest.advanceTimersByTime(BROWSER_RETIREMENT_DEADLINE_MS - 1);
    pending.resolve('fence');

    await expect(outcome).resolves.toBe('fence');
  });

  it('skips later calls in a scope whose first call expired', async () => {
    await runWithBrowserRetirementDeadlineScope(async () => {
      await expire(() => deferred<string>().promise);
      const skipped = jest.fn(() => Promise.resolve('fence'));

      await expect(
        withBrowserRetirementDeadline(skipped),
      ).rejects.toBeInstanceOf(BrowserRetirementTimeoutError);

      expect(skipped).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  it.each([
    [
      'answers',
      (call: ReturnType<typeof deferred<string>>): void =>
        call.resolve('late-fence'),
    ],
    [
      'fails',
      (call: ReturnType<typeof deferred<string>>): void =>
        call.reject(new Error('profile metadata unavailable')),
    ],
  ])(
    'gives later calls their own deadline once the expired call %s late',
    async (_outcome, settle) => {
      await runWithBrowserRetirementDeadlineScope(async () => {
        const abandoned = deferred<string>();
        await expire(() => abandoned.promise);
        settle(abandoned);
        await flush();
        const next = jest.fn(() => Promise.resolve('fence'));

        // Metadata that settled the abandoned call is answering again, so a
        // later call of the same archive is made instead of skipped.
        await expect(withBrowserRetirementDeadline(next)).resolves.toBe(
          'fence',
        );
        expect(next).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
      });
    },
  );

  it('skips again behind a later call that expires after the scope recovered', async () => {
    await runWithBrowserRetirementDeadlineScope(async () => {
      const first = deferred<string>();
      await expire(() => first.promise);
      first.resolve('late-fence');
      await flush();
      await expire(() => deferred<string>().promise);
      // The first call settling late must not release the second expiry.
      await flush();
      const skipped = jest.fn(() => Promise.resolve('fence'));

      await expect(
        withBrowserRetirementDeadline(skipped),
      ).rejects.toBeInstanceOf(BrowserRetirementTimeoutError);
      expect(skipped).not.toHaveBeenCalled();
    });
  });

  it('gives each scope, and a call outside any scope, its own deadline', async () => {
    await runWithBrowserRetirementDeadlineScope(async () => {
      await expire(() => deferred<string>().promise);
    });

    await runWithBrowserRetirementDeadlineScope(async () => {
      await expect(
        withBrowserRetirementDeadline(() => Promise.resolve('fence')),
      ).resolves.toBe('fence');
    });
    await expire(() => deferred<string>().promise);
    await expect(
      withBrowserRetirementDeadline(() => Promise.resolve('fence')),
    ).resolves.toBe('fence');
  });

  it('hands a late answer to settleLate and not to the caller', async () => {
    const pending = deferred<string>();
    const settleLate = jest.fn(() => Promise.resolve());

    const error = await expire(() => pending.promise, settleLate);
    expect(error).toBeInstanceOf(BrowserRetirementTimeoutError);
    expect(settleLate).not.toHaveBeenCalled();

    pending.resolve('late-fence');
    await flush();

    expect(settleLate).toHaveBeenCalledTimes(1);
    expect(settleLate).toHaveBeenCalledWith('late-fence');
    expect(logMainProcessWarn).not.toHaveBeenCalled();
  });

  it('does not call settleLate for a call that answers in time', async () => {
    const settleLate = jest.fn(() => Promise.resolve());

    await withBrowserRetirementDeadline(
      () => Promise.resolve('fence'),
      settleLate,
    );
    await flush();

    expect(settleLate).not.toHaveBeenCalled();
  });

  it('logs the code of an abandoned call that fails late and raises nothing', async () => {
    const pending = deferred<string>();
    const settleLate = jest.fn(() => Promise.resolve());
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await expire(() => pending.promise, settleLate);

      pending.reject(
        Object.assign(new Error('EBUSY: /Users/someone/profile'), {
          code: 'EBUSY',
        }),
      );
      await flush();
      await flush();

      expect(unhandled).not.toHaveBeenCalled();
      expect(settleLate).not.toHaveBeenCalled();
      // The code only: the message can name a local path.
      expect(logMainProcessWarn).toHaveBeenCalledTimes(1);
      expect(logMainProcessWarn).toHaveBeenCalledWith(LATE_FAILURE_LOG, {
        operation: 'browser_retirement_deadline',
        code: 'EBUSY',
      });
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('logs a settleLate that fails and raises nothing', async () => {
    const pending = deferred<string>();
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await expire(
        () => pending.promise,
        () => Promise.reject(new Error('settle failed')),
      );

      pending.resolve('late-fence');
      await flush();
      await flush();

      expect(unhandled).not.toHaveBeenCalled();
      expect(logMainProcessWarn).toHaveBeenCalledWith(LATE_FAILURE_LOG, {
        operation: 'browser_retirement_deadline',
        code: 'other',
      });
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
