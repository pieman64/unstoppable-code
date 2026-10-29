/**
 * @jest-environment jsdom
 */
import { resetModelLibraryAccessForTests } from '../modelLibraryAccess';
import { succeedClientOperation } from '@canopy/desktop-instrumentation/client';
jest.mock('@canopy/desktop-instrumentation/client', () => ({
  succeedClientOperation: jest.fn(),
}));
import {
  MODEL_UNLOCK_POLL_INTERVAL_MS,
  MODEL_UNLOCK_POLL_MAX_BACKOFF_MS,
  MODEL_UNLOCK_POLL_MAX_MS,
  beginModelUnlockIntent,
  checkModelUnlockNow,
  clearModelUnlockIntent,
  handleBillingReturnLink,
  reconcileModelUnlockIntentAccount,
  resetModelUnlockIntentForTests,
  retryModelUnlockApply,
  runModelUnlockPolling,
  setModelUnlockConfirmedListener,
  useModelUnlockIntentStore,
  type ModelUnlockIntentHandlers,
  type PendingModelUnlockIntent,
} from '../modelUnlockIntent';

/**
 * CAN-4028 — the pending purchase. These cases pin the three rules the module
 * exists for: only an authoritative server read unlocks anything, the pending
 * model is applied at most once and never over something newer, and every
 * reason to stop actually stops the loop.
 */

const ACCOUNT_KEY = 'account:acct_1';
const loadCanopyCloudEntitlements = jest.fn();
const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');

type AccessStatus = 'reported' | 'retained';

function serverSays(
  access: string,
  options: { status?: AccessStatus; accountKey?: string | null } = {},
): void {
  loadCanopyCloudEntitlements.mockResolvedValue({
    resolved: true,
    modelLibrary: { status: options.status ?? 'reported', access },
    modelLibraryAccountKey:
      options.accountKey === undefined ? ACCOUNT_KEY : options.accountKey,
  });
}

function intent(
  overrides: Partial<PendingModelUnlockIntent> = {},
): PendingModelUnlockIntent {
  return {
    requestId: 'req-1',
    accountId: ACCOUNT_KEY,
    owner: 'personal',
    chatId: 'chat-1',
    modelId: 'some-model',
    startedAt: Date.now(),
    ...overrides,
  };
}

function handlers(
  overrides: ModelUnlockIntentHandlers = {},
): Required<Pick<ModelUnlockIntentHandlers, 'apply'>> &
  ModelUnlockIntentHandlers & { apply: jest.Mock<Promise<boolean>, []> } {
  return {
    apply: jest.fn<Promise<boolean>, []>().mockResolvedValue(true),
    isStillWanted: () => true,
    resolveOwner: () => Promise.resolve('personal'),
    ...overrides,
  };
}

function phase(): string | null {
  return useModelUnlockIntentStore.getState().phase;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetModelLibraryAccessForTests();
  resetModelUnlockIntentForTests();
  serverSays('needs_purchase');
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { loadCanopyCloudEntitlements },
  });
});

it('confirms organization access from the same authoritative owner read', async () => {
  const apply = jest.fn().mockResolvedValue(true);
  beginModelUnlockIntent(intent({ owner: 'org:org-1', source: 'picker' }), {
    apply,
    resolveOwner: () => Promise.resolve('org:org-1'),
    refreshAccess: () =>
      Promise.resolve({
        accountKey: ACCOUNT_KEY,
        ownerKey: 'org:org-1',
        access: 'unlocked',
        authoritative: true,
      }),
  });
  await checkModelUnlockNow();
  await checkModelUnlockNow();
  expect(apply).toHaveBeenCalledTimes(1);
  expect(succeedClientOperation).toHaveBeenCalledWith('canopy.model_access', {
    context: {
      recovery_source: 'picker',
      model_id: 'some-model',
      library_access: 'unlocked',
    },
  });
  expect(
    jest
      .mocked(succeedClientOperation)
      .mock.calls.filter(([name]) => name === 'canopy.model_access'),
  ).toHaveLength(1);
});

it('an expired matching return only refreshes access and cannot select', async () => {
  const bound = handlers();
  beginModelUnlockIntent(
    intent({ startedAt: Date.now() - MODEL_UNLOCK_POLL_MAX_MS - 1 }),
    bound,
  );
  serverSays('unlocked');
  handleBillingReturnLink({ requestId: 'req-1' });
  for (let index = 0; index < 20; index++) await Promise.resolve();
  expect(bound.apply).not.toHaveBeenCalled();
  expect(phase()).toBe('waiting');
});

afterEach(() => {
  jest.useRealTimers();
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor);
  } else {
    Reflect.deleteProperty(window, 'api');
  }
});

describe('confirming an unlock', () => {
  it('applies the pending model once the server reports unlocked', async () => {
    const bound = handlers();
    const confirmed = jest.fn();
    setModelUnlockConfirmedListener(confirmed);
    beginModelUnlockIntent(intent(), bound);

    await expect(checkModelUnlockNow()).resolves.toBe('pending');
    expect(bound.apply).not.toHaveBeenCalled();
    expect(phase()).toBe('waiting');

    serverSays('unlocked');
    await expect(checkModelUnlockNow()).resolves.toBe('unlocked');
    expect(bound.apply).toHaveBeenCalledTimes(1);
    expect(confirmed).toHaveBeenCalledTimes(1);
    expect(phase()).toBe('unlocked');
  });

  it('applies exactly once however many triggers confirm it', async () => {
    const bound = handlers();
    const confirmed = jest.fn();
    setModelUnlockConfirmedListener(confirmed);
    beginModelUnlockIntent(intent(), bound);
    serverSays('unlocked');

    // The poll, a window focus, and the return link all landing together,
    // then again after it has completed.
    handleBillingReturnLink({ requestId: 'req-1' });
    await Promise.all([checkModelUnlockNow(), checkModelUnlockNow()]);
    await checkModelUnlockNow();
    handleBillingReturnLink({ requestId: 'req-1' });
    await checkModelUnlockNow();

    expect(bound.apply).toHaveBeenCalledTimes(1);
    expect(confirmed).toHaveBeenCalledTimes(1);
  });

  it('never confirms from a retained (last-known) value', async () => {
    // A blip returns the previous answer. Even if that answer is `unlocked`,
    // it is not this read's, so it cannot stand in for the payment.
    const bound = handlers();
    beginModelUnlockIntent(intent(), bound);
    serverSays('unlocked', { status: 'retained' });

    await expect(checkModelUnlockNow()).resolves.toBe('pending');
    expect(bound.apply).not.toHaveBeenCalled();
    expect(phase()).toBe('waiting');
  });

  it('cannot confirm an organization-owned purchase from personal access', async () => {
    const bound = handlers();
    beginModelUnlockIntent(intent({ owner: 'org:abc' }), bound);
    serverSays('unlocked');

    await expect(checkModelUnlockNow()).resolves.toBe('pending');
    expect(bound.apply).not.toHaveBeenCalled();
  });

  it('reports a failed read as failed and changes nothing', async () => {
    const bound = handlers();
    beginModelUnlockIntent(intent(), bound);
    loadCanopyCloudEntitlements.mockRejectedValue(new Error('offline'));

    await expect(checkModelUnlockNow()).resolves.toBe('failed');
    expect(phase()).toBe('waiting');
    expect(bound.apply).not.toHaveBeenCalled();
  });
});

describe('what may not be overwritten', () => {
  it('does not apply over a newer manual selection, but keeps the unlock', async () => {
    const bound = handlers({ isStillWanted: () => false });
    beginModelUnlockIntent(intent(), bound);
    serverSays('unlocked');

    await checkModelUnlockNow();
    expect(bound.apply).not.toHaveBeenCalled();
    // Unlocked, and no retry offered: nothing failed.
    expect(phase()).toBe('unlocked');
  });

  it('does not apply when the owner changed while paying', async () => {
    const bound = handlers({ resolveOwner: () => Promise.resolve('org:abc') });
    beginModelUnlockIntent(intent(), bound);
    serverSays('unlocked');

    await checkModelUnlockNow();
    expect(bound.apply).not.toHaveBeenCalled();
    expect(phase()).toBe('unlocked');
  });

  it('does not apply when the owner cannot be established', async () => {
    const bound = handlers({ resolveOwner: () => Promise.resolve(null) });
    beginModelUnlockIntent(intent(), bound);
    serverSays('unlocked');

    await checkModelUnlockNow();
    expect(bound.apply).not.toHaveBeenCalled();
  });

  it('lets a newer intent replace an older one, which is never applied', async () => {
    const older = handlers();
    const newer = handlers();
    beginModelUnlockIntent(intent({ requestId: 'req-old' }), older);
    beginModelUnlockIntent(
      intent({ requestId: 'req-new', modelId: 'other-model' }),
      newer,
    );
    serverSays('unlocked');

    await checkModelUnlockNow();
    expect(older.apply).not.toHaveBeenCalled();
    expect(newer.apply).toHaveBeenCalledTimes(1);
  });

  it('leaves a newer intent untouched when it arrives mid-application', async () => {
    let finishApply: (landed: boolean) => void = () => {};
    const older = handlers({
      apply: jest.fn<Promise<boolean>, []>(
        () =>
          new Promise<boolean>((resolve) => {
            finishApply = resolve;
          }),
      ),
    });
    beginModelUnlockIntent(intent({ requestId: 'req-old' }), older);
    serverSays('unlocked');
    const checking = checkModelUnlockNow();
    // Wait until the older intent's application is actually in flight.
    for (let i = 0; i < 50 && older.apply.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }
    expect(older.apply).toHaveBeenCalledTimes(1);

    // A second purchase attempt starts while the first is still applying.
    beginModelUnlockIntent(intent({ requestId: 'req-new' }), handlers());
    finishApply(false);
    await checking;

    expect(useModelUnlockIntentStore.getState()).toMatchObject({
      intent: { requestId: 'req-new' },
      phase: 'waiting',
    });
  });
});

describe('a failed application', () => {
  it('keeps the unlock and offers the selection again', async () => {
    const bound = handlers();
    bound.apply.mockResolvedValueOnce(false);
    const confirmed = jest.fn();
    setModelUnlockConfirmedListener(confirmed);
    beginModelUnlockIntent(intent(), bound);
    serverSays('unlocked');

    await checkModelUnlockNow();
    expect(phase()).toBe('apply-failed');

    await expect(retryModelUnlockApply()).resolves.toBe(true);
    expect(bound.apply).toHaveBeenCalledTimes(2);
    expect(phase()).toBe('unlocked');
    // The retry is about the selection. The unlock was confirmed once.
    expect(confirmed).toHaveBeenCalledTimes(1);
  });

  it('treats a throwing application as failed, not as an unhandled rejection', async () => {
    const bound = handlers();
    bound.apply.mockRejectedValueOnce(new Error('ipc'));
    beginModelUnlockIntent(intent(), bound);
    serverSays('unlocked');

    await checkModelUnlockNow();
    expect(phase()).toBe('apply-failed');
  });

  it('does not retry outside the failed state', async () => {
    const bound = handlers();
    beginModelUnlockIntent(intent(), bound);
    await expect(retryModelUnlockApply()).resolves.toBe(false);
    expect(bound.apply).not.toHaveBeenCalled();
  });
});

describe('return links', () => {
  it('checks immediately for the pending request', async () => {
    const bound = handlers();
    beginModelUnlockIntent(intent(), bound);
    serverSays('unlocked');

    handleBillingReturnLink({ requestId: 'req-1' });
    await checkModelUnlockNow();
    expect(bound.apply).toHaveBeenCalledTimes(1);
  });

  it('refreshes access for an unmatched link without selecting anything', async () => {
    const bound = handlers();
    beginModelUnlockIntent(intent(), bound);
    serverSays('unlocked');

    // Expired, replayed, or hand-crafted, and naming a model of its own.
    handleBillingReturnLink({
      requestId: 'some-other-request',
      modelId: 'attacker-chosen-model',
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(loadCanopyCloudEntitlements).toHaveBeenCalledTimes(1);
    expect(bound.apply).not.toHaveBeenCalled();
    expect(phase()).toBe('waiting');
  });

  it('does nothing harmful with no pending intent', async () => {
    serverSays('unlocked');
    handleBillingReturnLink({ requestId: 'req-1', modelId: 'some-model' });
    await Promise.resolve();
    await Promise.resolve();
    expect(useModelUnlockIntentStore.getState()).toEqual({
      intent: null,
      phase: null,
    });
  });
});

describe('account changes', () => {
  it('clears the intent on sign-out and on an account switch', () => {
    beginModelUnlockIntent(intent(), handlers());
    reconcileModelUnlockIntentAccount(ACCOUNT_KEY);
    expect(useModelUnlockIntentStore.getState().intent).not.toBeNull();

    reconcileModelUnlockIntentAccount('account:someone-else');
    expect(useModelUnlockIntentStore.getState().intent).toBeNull();

    beginModelUnlockIntent(intent(), handlers());
    reconcileModelUnlockIntentAccount(null);
    expect(useModelUnlockIntentStore.getState().intent).toBeNull();
  });

  it('never applies when the read comes back for another account', async () => {
    const bound = handlers();
    beginModelUnlockIntent(intent(), bound);
    serverSays('unlocked', { accountKey: 'account:someone-else' });

    await checkModelUnlockNow();
    expect(bound.apply).not.toHaveBeenCalled();
    expect(useModelUnlockIntentStore.getState().intent).toBeNull();
  });

  it('clears only the named intent', () => {
    beginModelUnlockIntent(intent({ requestId: 'req-new' }), handlers());
    clearModelUnlockIntent('req-old');
    expect(useModelUnlockIntentStore.getState().intent?.requestId).toBe(
      'req-new',
    );
  });
});

describe('the poll loop', () => {
  /** Advance fake time and let the awaited read chain settle. */
  async function advance(ms: number): Promise<void> {
    await jest.advanceTimersByTimeAsync(ms);
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  it('asks about every three seconds and stops once unlocked', async () => {
    const bound = handlers();
    beginModelUnlockIntent(intent(), bound);
    const stop = runModelUnlockPolling('req-1');

    await advance(MODEL_UNLOCK_POLL_INTERVAL_MS - 1);
    expect(loadCanopyCloudEntitlements).not.toHaveBeenCalled();
    await advance(1);
    expect(loadCanopyCloudEntitlements).toHaveBeenCalledTimes(1);
    await advance(MODEL_UNLOCK_POLL_INTERVAL_MS);
    expect(loadCanopyCloudEntitlements).toHaveBeenCalledTimes(2);

    serverSays('unlocked');
    await advance(MODEL_UNLOCK_POLL_INTERVAL_MS);
    expect(bound.apply).toHaveBeenCalledTimes(1);

    // Completed: no further reads, however long the app stays open.
    const reads = loadCanopyCloudEntitlements.mock.calls.length;
    await advance(MODEL_UNLOCK_POLL_INTERVAL_MS * 10);
    expect(loadCanopyCloudEntitlements).toHaveBeenCalledTimes(reads);
    stop();
  });

  it('never overlaps: a slow read delays the next one instead of stacking', async () => {
    let release: (value: unknown) => void = () => {};
    loadCanopyCloudEntitlements.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    beginModelUnlockIntent(intent(), handlers());
    const stop = runModelUnlockPolling('req-1');

    await advance(MODEL_UNLOCK_POLL_INTERVAL_MS);
    expect(loadCanopyCloudEntitlements).toHaveBeenCalledTimes(1);
    // Several intervals pass with the first read still on the wire.
    await advance(MODEL_UNLOCK_POLL_INTERVAL_MS * 5);
    expect(loadCanopyCloudEntitlements).toHaveBeenCalledTimes(1);

    release({
      resolved: true,
      modelLibrary: { status: 'reported', access: 'needs_purchase' },
      modelLibraryAccountKey: ACCOUNT_KEY,
    });
    await advance(MODEL_UNLOCK_POLL_INTERVAL_MS);
    expect(loadCanopyCloudEntitlements).toHaveBeenCalledTimes(2);
    stop();
  });

  it('backs off after failed reads and recovers on an answered one', async () => {
    loadCanopyCloudEntitlements.mockRejectedValue(new Error('offline'));
    beginModelUnlockIntent(intent(), handlers());
    const stop = runModelUnlockPolling('req-1');

    await advance(MODEL_UNLOCK_POLL_INTERVAL_MS);
    expect(loadCanopyCloudEntitlements).toHaveBeenCalledTimes(1);
    // The next wait is doubled, so the plain interval is not enough.
    await advance(MODEL_UNLOCK_POLL_INTERVAL_MS);
    expect(loadCanopyCloudEntitlements).toHaveBeenCalledTimes(1);
    await advance(MODEL_UNLOCK_POLL_INTERVAL_MS);
    expect(loadCanopyCloudEntitlements).toHaveBeenCalledTimes(2);

    // Capped: a long outage never waits longer than the ceiling.
    await advance(MODEL_UNLOCK_POLL_MAX_BACKOFF_MS * 4);
    const before = loadCanopyCloudEntitlements.mock.calls.length;
    await advance(MODEL_UNLOCK_POLL_MAX_BACKOFF_MS);
    expect(loadCanopyCloudEntitlements).toHaveBeenCalledTimes(before + 1);

    // An answered read resets the wait to the plain interval.
    serverSays('needs_purchase');
    await advance(MODEL_UNLOCK_POLL_MAX_BACKOFF_MS);
    const answered = loadCanopyCloudEntitlements.mock.calls.length;
    await advance(MODEL_UNLOCK_POLL_INTERVAL_MS);
    expect(loadCanopyCloudEntitlements).toHaveBeenCalledTimes(answered + 1);
    stop();
  });

  it('times out after ten minutes without calling the payment failed', async () => {
    const bound = handlers();
    beginModelUnlockIntent(intent(), bound);
    const stop = runModelUnlockPolling('req-1');

    await advance(MODEL_UNLOCK_POLL_MAX_MS + MODEL_UNLOCK_POLL_INTERVAL_MS);
    expect(phase()).toBe('timed-out');
    // The intent survives: the payment may still complete.
    expect(useModelUnlockIntentStore.getState().intent).not.toBeNull();

    const reads = loadCanopyCloudEntitlements.mock.calls.length;
    await advance(MODEL_UNLOCK_POLL_INTERVAL_MS * 10);
    expect(loadCanopyCloudEntitlements).toHaveBeenCalledTimes(reads);

    // A manual re-check still confirms and applies after the timeout.
    serverSays('unlocked');
    await checkModelUnlockNow();
    expect(bound.apply).toHaveBeenCalledTimes(1);
    expect(phase()).toBe('unlocked');
    stop();
  });

  it.each([
    ['cleanup (unmount)', (stop: () => void): void => stop()],
    ['cancellation', (): void => clearModelUnlockIntent()],
    [
      'an account change',
      (): void => reconcileModelUnlockIntentAccount('account:someone-else'),
    ],
    [
      'a newer intent',
      (): void =>
        beginModelUnlockIntent(intent({ requestId: 'req-new' }), handlers()),
    ],
  ])('stops on %s', async (_label, end) => {
    beginModelUnlockIntent(intent(), handlers());
    const stop = runModelUnlockPolling('req-1');
    await advance(MODEL_UNLOCK_POLL_INTERVAL_MS);
    expect(loadCanopyCloudEntitlements).toHaveBeenCalledTimes(1);

    end(stop);
    await advance(MODEL_UNLOCK_POLL_INTERVAL_MS * 10);
    // This loop made no further reads. (A newer intent gets its own loop from
    // the app root; this one must not keep running beside it.)
    expect(loadCanopyCloudEntitlements).toHaveBeenCalledTimes(1);
    stop();
  });
});
