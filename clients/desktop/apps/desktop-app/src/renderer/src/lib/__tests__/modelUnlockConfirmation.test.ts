/** @jest-environment jsdom */

import type { CanopyCloudAiCreditsState } from '@canopy/desktop-shared/types';
import {
  MODEL_UNLOCK_BALANCE_RETRY_OFFSETS_MS,
  dismissModelUnlockConfirmation,
  ensureModelUnlockConfirmationBalance,
  hasModelUnlockConfirmationSession,
  reconcileModelUnlockConfirmationAccount,
  recordModelUnlockConfirmation,
  resetModelUnlockConfirmationForTests,
  selectModelUnlockConfirmationAdded,
  selectModelUnlockConfirmationCredits,
  selectModelUnlockConfirmationForChat,
  useModelUnlockConfirmationStore,
} from '../modelUnlockConfirmation';
import type { PendingModelUnlockIntent } from '../modelUnlockIntent';

/**
 * CAN-5027 — the in-chat unlock confirmation: one visible record, dismissal
 * that duplicate delivery cannot undo, account-session isolation, and a
 * bounded balance read shared by every mount.
 */

const SCOPE = { kind: 'work', projectId: 'p1', chatId: 'chat-1' } as const;
const SCOPE_KEY = 'work|p1||chat-1|personal';
const loadCanopyCloudAiCredits = jest.fn<
  Promise<CanopyCloudAiCreditsState>,
  unknown[]
>();
const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');

function intent(
  overrides: Partial<PendingModelUnlockIntent> = {},
): PendingModelUnlockIntent {
  return {
    requestId: 'req-1',
    accountId: 'account:a',
    owner: 'personal',
    chatId: 'chat-1',
    scope: SCOPE,
    modelId: 'claude-sonnet-5-5',
    startedAt: 0,
    ...overrides,
  };
}

function creditsState(
  overrides: Partial<CanopyCloudAiCreditsState> & { credits?: number } = {},
): CanopyCloudAiCreditsState {
  const { credits = 1200, ...rest } = overrides;
  return {
    connected: true,
    email: 'buyer@example.com',
    subscription: null,
    balance: {
      email: 'buyer@example.com',
      credits,
      eligible: credits > 0,
      source: 'canopy',
    },
    noUdAccount: false,
    error: null,
    ...rest,
  };
}

function visible(chatId = 'chat-1'): string | null {
  return (
    selectModelUnlockConfirmationForChat(
      useModelUnlockConfirmationStore.getState(),
      { projectId: SCOPE.projectId, worktreeId: '', chatId },
    )?.requestId ?? null
  );
}

function credits(requestId = 'req-1', scopeKey = SCOPE_KEY): number | null {
  return selectModelUnlockConfirmationCredits(
    useModelUnlockConfirmationStore.getState(),
    requestId,
    scopeKey,
  );
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

beforeEach(() => {
  jest.clearAllMocks();
  resetModelUnlockConfirmationForTests();
  loadCanopyCloudAiCredits.mockResolvedValue(creditsState());
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { loadCanopyCloudAiCredits },
  });
});

afterEach(() => {
  jest.useRealTimers();
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor);
  } else {
    Reflect.deleteProperty(window, 'api');
  }
});

describe('recording a confirmation', () => {
  it('shows it only in the chat the purchase started in', () => {
    expect(recordModelUnlockConfirmation(intent())).toBe(true);
    expect(visible('chat-1')).toBe('req-1');
    expect(visible('chat-2')).toBeNull();
  });

  it('ignores an intent with no chat without replacing another', () => {
    recordModelUnlockConfirmation(intent());
    expect(
      recordModelUnlockConfirmation(
        intent({ requestId: 'req-2', chatId: null }),
      ),
    ).toBe(false);
    expect(visible()).toBe('req-1');
  });

  it('lets a newer confirmation replace the previous one', () => {
    recordModelUnlockConfirmation(intent());
    recordModelUnlockConfirmation(
      intent({
        requestId: 'req-2',
        chatId: 'chat-2',
        scope: { ...SCOPE, chatId: 'chat-2' },
      }),
    );
    expect(visible('chat-1')).toBeNull();
    expect(visible('chat-2')).toBe('req-2');
  });

  it('never revives a dismissed or replaced request on duplicate delivery', () => {
    recordModelUnlockConfirmation(intent());
    dismissModelUnlockConfirmation('req-1');
    expect(recordModelUnlockConfirmation(intent())).toBe(false);
    expect(visible()).toBeNull();

    recordModelUnlockConfirmation(intent({ requestId: 'req-2' }));
    expect(recordModelUnlockConfirmation(intent())).toBe(false);
    expect(visible()).toBe('req-2');
  });

  it('lets only the named request be dismissed', () => {
    recordModelUnlockConfirmation(intent());
    recordModelUnlockConfirmation(intent({ requestId: 'req-2' }));
    dismissModelUnlockConfirmation('req-1');
    expect(visible()).toBe('req-2');
  });
});

describe('account sessions', () => {
  it('clears the confirmation and its history on an account switch', () => {
    recordModelUnlockConfirmation(intent());
    reconcileModelUnlockConfirmationAccount('account:b');
    expect(visible()).toBeNull();
    // A late callback from the previous account cannot repopulate it.
    expect(recordModelUnlockConfirmation(intent({ requestId: 'req-9' }))).toBe(
      false,
    );
    expect(visible()).toBeNull();
  });

  it('clears on sign-out and rejects anything until an account returns', () => {
    recordModelUnlockConfirmation(intent());
    reconcileModelUnlockConfirmationAccount(null);
    expect(visible()).toBeNull();
    expect(recordModelUnlockConfirmation(intent({ requestId: 'req-2' }))).toBe(
      false,
    );
    // Signing back in starts a fresh session; its history is gone too.
    reconcileModelUnlockConfirmationAccount('account:a');
    expect(recordModelUnlockConfirmation(intent())).toBe(true);
  });

  it('keeps the confirmation when the same account reports a change', () => {
    recordModelUnlockConfirmation(intent());
    reconcileModelUnlockConfirmationAccount('account:a');
    expect(visible()).toBe('req-1');
  });

  it('reports a session only once one exists', () => {
    expect(hasModelUnlockConfirmationSession()).toBe(false);
    recordModelUnlockConfirmation(intent());
    expect(hasModelUnlockConfirmationSession()).toBe(true);
  });
});

describe('the balance read', () => {
  it('rejects an organization-funded result even with positive credits', async () => {
    jest.useFakeTimers();
    loadCanopyCloudAiCredits.mockResolvedValue(
      creditsState({
        balance: {
          email: 'buyer@example.com',
          credits: 1200,
          eligible: true,
          source: 'canopy',
          orgFundingAvailable: true,
        },
      }),
    );
    recordModelUnlockConfirmation(intent());
    ensureModelUnlockConfirmationBalance('req-1', SCOPE, SCOPE_KEY);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(credits()).toBeNull();
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledTimes(1);
  });

  it('does not restart an exhausted budget after another scope was shown', async () => {
    jest.useFakeTimers();
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState({ credits: 0 }));
    recordModelUnlockConfirmation(intent());
    ensureModelUnlockConfirmationBalance('req-1', SCOPE, SCOPE_KEY);
    await jest.advanceTimersByTimeAsync(60_000);
    ensureModelUnlockConfirmationBalance('req-1', SCOPE, 'other-scope');
    await jest.advanceTimersByTimeAsync(60_000);
    ensureModelUnlockConfirmationBalance('req-1', SCOPE, SCOPE_KEY);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledTimes(6);
  });

  it('cancels timers while hidden and resumes the same remaining budget', async () => {
    jest.useFakeTimers();
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState({ credits: 0 }));
    recordModelUnlockConfirmation(intent());
    const release = ensureModelUnlockConfirmationBalance(
      'req-1',
      SCOPE,
      SCOPE_KEY,
    );
    await flush();
    release();
    await flush();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledTimes(1);
    ensureModelUnlockConfirmationBalance('req-1', SCOPE, SCOPE_KEY);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledTimes(3);
    expect(credits()).toBeNull();
  });

  it('ignores a hidden read and serializes remounts behind it', async () => {
    jest.useFakeTimers();
    let answer: (value: CanopyCloudAiCreditsState) => void = () => {};
    loadCanopyCloudAiCredits.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    recordModelUnlockConfirmation(intent());
    const release = ensureModelUnlockConfirmationBalance(
      'req-1',
      SCOPE,
      SCOPE_KEY,
    );
    release();
    await flush();
    ensureModelUnlockConfirmationBalance('req-1', SCOPE, SCOPE_KEY);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledTimes(1);
    answer(creditsState({ credits: 9999 }));
    await flush();
    expect(credits()).toBeNull();
    await jest.advanceTimersByTimeAsync(1500);
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledTimes(2);
    expect(credits()).toBe(1200);
  });

  it('keeps a shared read alive until the last matching mount leaves', async () => {
    jest.useFakeTimers();
    loadCanopyCloudAiCredits.mockResolvedValueOnce(
      creditsState({ credits: 0 }),
    );
    recordModelUnlockConfirmation(intent());
    const first = ensureModelUnlockConfirmationBalance(
      'req-1',
      SCOPE,
      SCOPE_KEY,
    );
    const second = ensureModelUnlockConfirmationBalance(
      'req-1',
      SCOPE,
      SCOPE_KEY,
    );
    await flush();
    first();
    await jest.advanceTimersByTimeAsync(1500);
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledTimes(2);
    expect(credits()).toBe(1200);
    second();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('shares the initial read across immediate effect cleanup and replay', async () => {
    let answer: (value: CanopyCloudAiCreditsState) => void = () => {};
    loadCanopyCloudAiCredits.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    recordModelUnlockConfirmation(intent());
    const release = ensureModelUnlockConfirmationBalance(
      'req-1',
      SCOPE,
      SCOPE_KEY,
    );
    release();
    ensureModelUnlockConfirmationBalance('req-1', SCOPE, SCOPE_KEY);
    answer(creditsState());
    await flush();
    expect(credits()).toBe(1200);
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledTimes(1);
  });

  it('does not cache a late positive answer after scope invalidation', async () => {
    let answer: (value: CanopyCloudAiCreditsState) => void = () => {};
    loadCanopyCloudAiCredits.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    recordModelUnlockConfirmation(intent());
    ensureModelUnlockConfirmationBalance('req-1', SCOPE, SCOPE_KEY);
    ensureModelUnlockConfirmationBalance('req-1', SCOPE, 'other-scope');
    await flush();
    answer(creditsState({ credits: 9999 }));
    await flush();
    expect(credits()).toBeNull();
    expect(credits('req-1', 'other-scope')).toBe(1200);
  });

  it('reads once and keeps a usable balance for this request and scope', async () => {
    recordModelUnlockConfirmation(intent());
    ensureModelUnlockConfirmationBalance('req-1', SCOPE, SCOPE_KEY);
    ensureModelUnlockConfirmationBalance('req-1', SCOPE, SCOPE_KEY);
    await flush();
    ensureModelUnlockConfirmationBalance('req-1', SCOPE, SCOPE_KEY);
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledTimes(1);
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledWith(SCOPE);
    expect(credits()).toBe(1200);
    expect(credits('req-1', 'other-scope')).toBeNull();
    expect(credits('req-2')).toBeNull();
  });

  it('retries twice, serialized, then keeps the fallback', async () => {
    jest.useFakeTimers({ now: 0 });
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState({ credits: 0 }));
    recordModelUnlockConfirmation(intent());
    ensureModelUnlockConfirmationBalance('req-1', SCOPE, SCOPE_KEY);
    await flush();
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(
      MODEL_UNLOCK_BALANCE_RETRY_OFFSETS_MS[0] - 1,
    );
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(
      MODEL_UNLOCK_BALANCE_RETRY_OFFSETS_MS[1] -
        MODEL_UNLOCK_BALANCE_RETRY_OFFSETS_MS[0],
    );
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledTimes(3);
    expect(credits()).toBeNull();

    // The budget is spent: another mount does not start it again.
    ensureModelUnlockConfirmationBalance('req-1', SCOPE, SCOPE_KEY);
    await flush();
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledTimes(3);
  });

  it('stops retrying once a usable balance arrives', async () => {
    jest.useFakeTimers({ now: 0 });
    loadCanopyCloudAiCredits
      .mockResolvedValueOnce(creditsState({ error: 'blip', balance: null }))
      .mockResolvedValueOnce(creditsState({ credits: 12.5 }));
    recordModelUnlockConfirmation(intent());
    ensureModelUnlockConfirmationBalance('req-1', SCOPE, SCOPE_KEY);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledTimes(2);
    expect(credits()).toBe(12.5);
  });

  it.each([
    ['a missing cloud account', { noUdAccount: true }],
    ['a disconnected account', { connected: false }],
  ])('uses the bounded fallback retries for %s', async (_label, overrides) => {
    jest.useFakeTimers({ now: 0 });
    loadCanopyCloudAiCredits.mockResolvedValue(
      creditsState({ ...overrides, balance: null }),
    );
    recordModelUnlockConfirmation(intent());
    ensureModelUnlockConfirmationBalance('req-1', SCOPE, SCOPE_KEY);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledTimes(3);
    expect(credits()).toBeNull();
  });

  it.each([-5, Number.NaN, Number.POSITIVE_INFINITY])(
    'never keeps an unusable balance (%p)',
    async (value) => {
      jest.useFakeTimers({ now: 0 });
      loadCanopyCloudAiCredits.mockResolvedValue(
        creditsState({ credits: value }),
      );
      recordModelUnlockConfirmation(intent());
      ensureModelUnlockConfirmationBalance('req-1', SCOPE, SCOPE_KEY);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(credits()).toBeNull();
    },
  );

  it('retries a rejected read', async () => {
    jest.useFakeTimers({ now: 0 });
    loadCanopyCloudAiCredits
      .mockRejectedValueOnce(new Error('ipc'))
      .mockResolvedValueOnce(creditsState());
    recordModelUnlockConfirmation(intent());
    ensureModelUnlockConfirmationBalance('req-1', SCOPE, SCOPE_KEY);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(credits()).toBe(1200);
  });

  it.each([
    ['dismissal', (): void => dismissModelUnlockConfirmation('req-1')],
    [
      'replacement',
      (): void => {
        recordModelUnlockConfirmation(intent({ requestId: 'req-2' }));
      },
    ],
    [
      'an account switch',
      (): void => reconcileModelUnlockConfirmationAccount('account:b'),
    ],
  ])(
    'drops a late answer and pending retries after %s',
    async (_label, act) => {
      jest.useFakeTimers({ now: 0 });
      let answer: (state: CanopyCloudAiCreditsState) => void = () => {};
      loadCanopyCloudAiCredits.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      );
      recordModelUnlockConfirmation(intent());
      ensureModelUnlockConfirmationBalance('req-1', SCOPE, SCOPE_KEY);
      act();
      answer(creditsState({ credits: 0 }));
      await jest.advanceTimersByTimeAsync(60_000);
      expect(loadCanopyCloudAiCredits).toHaveBeenCalledTimes(1);
      expect(useModelUnlockConfirmationStore.getState().balance).toBeNull();
    },
  );

  it('does not read for a request that is not the visible confirmation', async () => {
    recordModelUnlockConfirmation(intent());
    ensureModelUnlockConfirmationBalance('req-other', SCOPE, SCOPE_KEY);
    await flush();
    expect(loadCanopyCloudAiCredits).not.toHaveBeenCalled();
  });
});

describe('the amount added (CAN-5160)', () => {
  function added(requestId = 'req-1', scopeKey = SCOPE_KEY): number | null {
    return selectModelUnlockConfirmationAdded(
      useModelUnlockConfirmationStore.getState(),
      requestId,
      scopeKey,
    );
  }
  const START = {
    credits: 0,
    source: 'canopy',
    email: 'buyer@example.com',
    reportedGrant: false,
  };

  it('names the increase over the balance read before checkout opened', async () => {
    recordModelUnlockConfirmation(intent({ startingBalance: START }));
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState({ credits: 16 }));
    const release = ensureModelUnlockConfirmationBalance(
      'req-1',
      SCOPE,
      SCOPE_KEY,
    );
    await flush();
    expect(credits()).toBe(16);
    expect(added()).toBe(16);
    release();
  });

  it('claims nothing without a starting balance', async () => {
    recordModelUnlockConfirmation(intent());
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState({ credits: 16 }));
    const release = ensureModelUnlockConfirmationBalance(
      'req-1',
      SCOPE,
      SCOPE_KEY,
    );
    await flush();
    expect(credits()).toBe(16);
    expect(added()).toBeNull();
    release();
  });

  it('claims nothing when a daily grant could account for the change', async () => {
    recordModelUnlockConfirmation(intent({ startingBalance: START }));
    loadCanopyCloudAiCredits.mockResolvedValue(
      creditsState({
        credits: 16,
        balance: {
          email: 'buyer@example.com',
          credits: 16,
          eligible: true,
          source: 'canopy',
          dailyDripOutcome: 'granted',
        },
      }),
    );
    const release = ensureModelUnlockConfirmationBalance(
      'req-1',
      SCOPE,
      SCOPE_KEY,
    );
    await flush();
    expect(added()).toBeNull();
    release();
  });

  it('claims nothing for a different wallet', async () => {
    recordModelUnlockConfirmation(
      intent({ startingBalance: { ...START, email: 'other@example.com' } }),
    );
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState({ credits: 16 }));
    const release = ensureModelUnlockConfirmationBalance(
      'req-1',
      SCOPE,
      SCOPE_KEY,
    );
    await flush();
    expect(added()).toBeNull();
    release();
  });
});
