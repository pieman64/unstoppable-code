/** @jest-environment jsdom */

import type {
  CanopyCloudAccountPublicState,
  CanopyCloudAiCreditsState,
} from '@canopy/desktop-shared/types';
import {
  AI_CREDITS_ARRIVAL_READ_TIMEOUT_MS,
  beginAiCreditsArrivalHandoff,
  clearAiCreditsArrival,
  clearAiCreditsArrivalForChat,
  hasAiCreditsArrivalSession,
  markAiCreditsArrivalRouted,
  reconcileAiCreditsArrivalAccount,
  resetAiCreditsArrivalForTests,
  selectAiCreditsArrivalEvidence,
  selectAiCreditsArrivalForChat,
  selectRoutedAiCreditsArrivalForChat,
  suspendAiCreditsArrivalAccount,
  useAiCreditsArrivalStore,
  type AiCreditsArrivalHandoff,
  type AiCreditsArrivalOrigin,
} from '../aiCreditsArrivalConfirmation';

/**
 * CAN-5160 — the usage-limit arrival confirmation: hand-off fencing, a
 * pre-open baseline, one record per hand-off, account-session isolation, and
 * a bounded balance read that never manufactures an increase.
 */

const SCOPE = { kind: 'work', projectId: 'p1', chatId: 'chat-1' } as const;
const TARGET = { projectId: 'p1', worktreeId: '', chatId: 'chat-1' };
const loadCanopyCloudAiCredits = jest.fn<
  Promise<CanopyCloudAiCreditsState>,
  unknown[]
>();
const loadCanopyCloudAccount = jest.fn<
  Promise<Partial<CanopyCloudAccountPublicState>>,
  []
>();
const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');

type BalanceOverrides = Partial<
  NonNullable<CanopyCloudAiCreditsState['balance']>
>;

function creditsState(
  credits: number,
  balance: BalanceOverrides = {},
  overrides: Partial<CanopyCloudAiCreditsState> = {},
): CanopyCloudAiCreditsState {
  return {
    connected: true,
    email: 'buyer@example.com',
    subscription: null,
    balance: {
      email: 'buyer@example.com',
      credits,
      eligible: credits > 0,
      source: 'canopy',
      ...balance,
    },
    noUdAccount: false,
    error: null,
    ...overrides,
  };
}

function account(id = 'a'): Partial<CanopyCloudAccountPublicState> {
  return {
    read: 'ok',
    hasApiKey: true,
    authMode: 'oauth',
    credentialSource: 'oauth_desktop',
    account: {
      id,
      name: 'Buyer',
      email: 'buyer@example.com',
      role: 'DEVELOPER',
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function visible(
  origin: AiCreditsArrivalOrigin = 'usage-limit',
): ReturnType<typeof selectAiCreditsArrivalForChat> {
  return selectAiCreditsArrivalForChat(
    useAiCreditsArrivalStore.getState(),
    TARGET,
    origin,
  );
}

function evidence(): ReturnType<typeof selectAiCreditsArrivalEvidence> {
  return selectAiCreditsArrivalEvidence(
    useAiCreditsArrivalStore.getState(),
    visible()?.handoffId,
  );
}

function routed(
  target = TARGET,
): ReturnType<typeof selectRoutedAiCreditsArrivalForChat> {
  return selectRoutedAiCreditsArrivalForChat(
    useAiCreditsArrivalStore.getState(),
    target,
  );
}

function routedEvidence(): ReturnType<typeof selectAiCreditsArrivalEvidence> {
  return selectAiCreditsArrivalEvidence(
    useAiCreditsArrivalStore.getState(),
    routed()?.handoffId,
  );
}

/** Begin with a settled baseline, open the browser, and come back covered. */
async function completedHandoff(
  baseline: CanopyCloudAiCreditsState,
  origin: AiCreditsArrivalOrigin = 'usage-limit',
): Promise<AiCreditsArrivalHandoff> {
  loadCanopyCloudAiCredits.mockResolvedValueOnce(baseline);
  const handoff = beginAiCreditsArrivalHandoff(SCOPE, origin);
  if (handoff === null) throw new Error('no hand-off');
  await flush();
  handoff.markExternalOpen();
  handoff.retain();
  return handoff;
}

beforeEach(() => {
  jest.useFakeTimers();
  resetAiCreditsArrivalForTests();
  loadCanopyCloudAiCredits.mockReset();
  loadCanopyCloudAccount.mockReset();
  loadCanopyCloudAccount.mockResolvedValue(account());
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { loadCanopyCloudAiCredits, loadCanopyCloudAccount },
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

describe('recording an arrival', () => {
  it('names the increase over a pre-open baseline in its chat only', async () => {
    const handoff = await completedHandoff(creditsState(0));
    loadCanopyCloudAiCredits.mockResolvedValueOnce(creditsState(16));
    expect(handoff.recordCovered()).toBe(true);
    expect(visible()?.handoffId).toBe(handoff.handoffId);
    expect(evidence()).toBeNull();
    await flush();
    expect(evidence()).toMatchObject({ addedCredits: 16, balanceCredits: 16 });
    expect(
      selectAiCreditsArrivalForChat(
        useAiCreditsArrivalStore.getState(),
        { ...TARGET, chatId: 'chat-2' },
        'usage-limit',
      ),
    ).toBeNull();
  });

  it('records nothing for a scope without a chat', () => {
    expect(
      beginAiCreditsArrivalHandoff(
        { kind: 'work', projectId: 'p1' },
        'usage-limit',
      ),
    ).toBeNull();
    expect(
      beginAiCreditsArrivalHandoff({ kind: 'navigation' }, 'usage-limit'),
    ).toBeNull();
    expect(beginAiCreditsArrivalHandoff(undefined, 'usage-limit')).toBeNull();
  });

  it('records nothing unless the browser opened', async () => {
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState(0));
    const handoff = beginAiCreditsArrivalHandoff(SCOPE, 'usage-limit');
    await flush();
    expect(handoff?.recordCovered()).toBe(false);
    expect(visible()).toBeNull();
  });

  it('records nothing once cancelled, and a late baseline is inert', async () => {
    let resolveBaseline: (state: CanopyCloudAiCreditsState) => void = () => {};
    loadCanopyCloudAiCredits.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveBaseline = resolve;
      }),
    );
    const handoff = beginAiCreditsArrivalHandoff(SCOPE, 'usage-limit');
    await flush();
    handoff?.retain();
    handoff?.cancel();
    resolveBaseline(creditsState(0));
    await flush();
    expect(handoff?.recordCovered()).toBe(false);
    expect(visible()).toBeNull();
  });

  it('records once per hand-off; dismissal cannot be undone by a duplicate', async () => {
    const handoff = await completedHandoff(creditsState(0));
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState(16));
    expect(handoff.recordCovered()).toBe(true);
    expect(handoff.recordCovered()).toBe(false);
    clearAiCreditsArrival(handoff.handoffId);
    expect(handoff.recordCovered()).toBe(false);
    expect(visible()).toBeNull();
  });

  it('keeps a newer record when an older hand-off completes late', async () => {
    const older = await completedHandoff(creditsState(0));
    const newer = await completedHandoff(creditsState(0));
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState(16));
    expect(newer.recordCovered()).toBe(true);
    expect(older.recordCovered()).toBe(false);
    expect(visible()?.handoffId).toBe(newer.handoffId);
    clearAiCreditsArrival(older.handoffId);
    expect(visible()?.handoffId).toBe(newer.handoffId);
  });

  it('records nothing when the account cannot be identified', async () => {
    loadCanopyCloudAccount.mockResolvedValue({ read: 'error' });
    const handoff = await completedHandoff(creditsState(0));
    expect(handoff.recordCovered()).toBe(false);
    expect(visible()).toBeNull();
  });

  it('rejects an older completion even after the newer notice is dismissed', async () => {
    const older = await completedHandoff(creditsState(0));
    const newer = await completedHandoff(creditsState(0));
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState(16));
    newer.recordCovered();
    clearAiCreditsArrival(newer.handoffId);
    expect(older.recordCovered()).toBe(false);
    expect(visible()).toBeNull();
  });

  it('lets the newest initiated hand-off win before either completes', async () => {
    const older = await completedHandoff(creditsState(0));
    const newer = await completedHandoff(creditsState(0));
    expect(older.recordCovered()).toBe(false);
    expect(visible()).toBeNull();
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState(16));
    expect(newer.recordCovered()).toBe(true);
  });
});

describe('the baseline', () => {
  it('uses balance-only fallback after a failed baseline', async () => {
    loadCanopyCloudAiCredits.mockRejectedValueOnce(
      new Error('baseline failed'),
    );
    const handoff = beginAiCreditsArrivalHandoff(SCOPE, 'usage-limit');
    await flush();
    handoff?.markExternalOpen();
    handoff?.retain();
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState(16));
    expect(handoff?.recordCovered()).toBe(true);
    await flush();
    expect(evidence()).toMatchObject({
      addedCredits: null,
      balanceCredits: 16,
    });
  });

  it('becomes unknown when it is still loading at the external open', async () => {
    let resolveBaseline: (state: CanopyCloudAiCreditsState) => void = () => {};
    loadCanopyCloudAiCredits.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveBaseline = resolve;
      }),
    );
    const handoff = beginAiCreditsArrivalHandoff(SCOPE, 'usage-limit');
    await flush();
    handoff?.markExternalOpen();
    handoff?.retain();
    resolveBaseline(creditsState(0));
    await flush();
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState(16));
    handoff?.recordCovered();
    await flush();
    expect(evidence()).toMatchObject({
      addedCredits: null,
      balanceCredits: 16,
    });
  });

  it('includes a different balance, and a negative personal baseline counts', async () => {
    const handoff = await completedHandoff(creditsState(-4));
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState(12));
    handoff.recordCovered();
    await flush();
    expect(evidence()).toMatchObject({ addedCredits: 16, balanceCredits: 12 });
  });

  it('is unknown for an organization-funded reading', async () => {
    const handoff = await completedHandoff(
      creditsState(0, { orgPool: { orgId: 'o', orgName: 'Org' } }),
    );
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState(16));
    handoff.recordCovered();
    await flush();
    expect(evidence()).toMatchObject({
      addedCredits: null,
      balanceCredits: 16,
    });
  });
});

describe('the balance read', () => {
  it('retries a nonzero increase that formats as zero', async () => {
    const handoff = await completedHandoff(creditsState(0));
    loadCanopyCloudAiCredits
      .mockResolvedValueOnce(creditsState(0.004))
      .mockResolvedValueOnce(creditsState(16));
    handoff.recordCovered();
    await flush();
    expect(evidence()).toBeNull();
    await jest.advanceTimersByTimeAsync(1_500);
    expect(evidence()).toMatchObject({ addedCredits: 16 });
  });

  it('retries a stale zero, then names the increase', async () => {
    const handoff = await completedHandoff(creditsState(0));
    loadCanopyCloudAiCredits
      .mockResolvedValueOnce(creditsState(0))
      .mockResolvedValueOnce(creditsState(16));
    handoff.recordCovered();
    await flush();
    expect(evidence()).toBeNull();
    await jest.advanceTimersByTimeAsync(1_500);
    expect(evidence()).toMatchObject({ addedCredits: 16, balanceCredits: 16 });
    // Baseline plus two reads; no third read.
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledTimes(3);
  });

  it('falls back to generic availability once the budget is spent', async () => {
    const handoff = await completedHandoff(creditsState(0));
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState(0));
    handoff.recordCovered();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(evidence()).toMatchObject({
      final: true,
      addedCredits: null,
      balanceCredits: null,
    });
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledTimes(4);
  });

  it.each([200, 180])(
    'falls back after an unchanged or decreased balance (%s)',
    async (current) => {
      const handoff = await completedHandoff(creditsState(200));
      loadCanopyCloudAiCredits.mockResolvedValue(creditsState(current));
      handoff.recordCovered();
      await jest.advanceTimersByTimeAsync(5_000);
      expect(evidence()).toMatchObject({
        addedCredits: null,
        balanceCredits: current,
      });
    },
  );

  it('subtracts a granted daily drip once across retries', async () => {
    const handoff = await completedHandoff(creditsState(0));
    loadCanopyCloudAiCredits
      .mockResolvedValueOnce(
        creditsState(5, {
          dailyDripOutcome: 'granted',
          dailyDripGrantedCredits: 5,
        }),
      )
      .mockResolvedValueOnce(
        creditsState(21, { dailyDripOutcome: 'already_granted' }),
      );
    handoff.recordCovered();
    await flush();
    // The grant alone is not credits added by the purchase.
    expect(evidence()).toBeNull();
    await jest.advanceTimersByTimeAsync(1_500);
    expect(evidence()).toMatchObject({ addedCredits: 16, balanceCredits: 21 });
  });

  it.each([undefined, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'suppresses the increase for an invalid grant amount (%s)',
    async (granted) => {
      const handoff = await completedHandoff(creditsState(0));
      loadCanopyCloudAiCredits.mockResolvedValue(
        creditsState(16, {
          dailyDripOutcome: 'granted',
          ...(granted === undefined
            ? {}
            : { dailyDripGrantedCredits: granted }),
        }),
      );
      handoff.recordCovered();
      await jest.advanceTimersByTimeAsync(5_000);
      expect(evidence()).toMatchObject({
        addedCredits: null,
        balanceCredits: 16,
      });
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'retries a nonfinite balance (%s)',
    async (invalid) => {
      const handoff = await completedHandoff(creditsState(0));
      loadCanopyCloudAiCredits
        .mockResolvedValueOnce(creditsState(invalid))
        .mockResolvedValueOnce(creditsState(16));
      handoff.recordCovered();
      await flush();
      expect(evidence()).toBeNull();
      await jest.advanceTimersByTimeAsync(1_500);
      expect(evidence()).toMatchObject({
        addedCredits: 16,
        balanceCredits: 16,
      });
    },
  );

  it('does not accumulate repeated grant metadata across retries', async () => {
    const handoff = await completedHandoff(creditsState(0));
    loadCanopyCloudAiCredits
      .mockResolvedValueOnce(
        creditsState(5, {
          dailyDripOutcome: 'granted',
          dailyDripGrantedCredits: 5,
        }),
      )
      .mockResolvedValue(
        creditsState(21, {
          dailyDripOutcome: 'granted',
          dailyDripGrantedCredits: 5,
        }),
      );
    handoff.recordCovered();
    await jest.advanceTimersByTimeAsync(4_000);
    expect(evidence()).toMatchObject({
      addedCredits: null,
      balanceCredits: 21,
    });
  });

  it('uses fallback when grant metadata could repeat the baseline grant', async () => {
    const handoff = await completedHandoff(
      creditsState(5, {
        dailyDripOutcome: 'granted',
        dailyDripGrantedCredits: 5,
      }),
    );
    loadCanopyCloudAiCredits.mockResolvedValue(
      creditsState(21, {
        dailyDripOutcome: 'granted',
        dailyDripGrantedCredits: 5,
      }),
    );
    handoff.recordCovered();
    await jest.advanceTimersByTimeAsync(4_000);
    expect(evidence()).toMatchObject({
      addedCredits: null,
      balanceCredits: 21,
    });
  });

  it('keeps continuation available when every balance read rejects', async () => {
    const handoff = await completedHandoff(creditsState(0));
    loadCanopyCloudAiCredits.mockRejectedValue(
      new Error('balance unavailable'),
    );
    expect(handoff.recordCovered()).toBe(true);
    expect(visible()).not.toBeNull();
    await jest.advanceTimersByTimeAsync(4_000);
    expect(evidence()).toMatchObject({
      final: true,
      addedCredits: null,
      balanceCredits: null,
    });
  });

  it('says only that credits are available when the chat is org-funded', async () => {
    const handoff = await completedHandoff(creditsState(0));
    loadCanopyCloudAiCredits.mockResolvedValue(
      creditsState(16, { orgFundingAvailable: true }),
    );
    handoff.recordCovered();
    await flush();
    expect(evidence()).toMatchObject({
      addedCredits: null,
      balanceCredits: null,
    });
  });

  it('ends with what is known when a read hangs', async () => {
    const handoff = await completedHandoff(creditsState(0));
    loadCanopyCloudAiCredits.mockReturnValue(new Promise(() => {}));
    handoff.recordCovered();
    await jest.advanceTimersByTimeAsync(AI_CREDITS_ARRIVAL_READ_TIMEOUT_MS);
    expect(evidence()).toMatchObject({ final: true, addedCredits: null });
    // Never a second request beside the hung one.
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledTimes(2);
  });

  it('cannot publish after the record is cleared', async () => {
    const handoff = await completedHandoff(creditsState(0));
    let resolveRead: (state: CanopyCloudAiCreditsState) => void = () => {};
    loadCanopyCloudAiCredits.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );
    handoff.recordCovered();
    clearAiCreditsArrival(handoff.handoffId);
    resolveRead(creditsState(16));
    await flush();
    expect(useAiCreditsArrivalStore.getState().evidence).toBeNull();
  });
});

describe('account sessions', () => {
  it('tracks an identifying hand-off and rejects its result after account revalidation', async () => {
    let resolveIdentity: (
      value: Partial<CanopyCloudAccountPublicState>,
    ) => void = () => {};
    loadCanopyCloudAccount.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveIdentity = resolve;
      }),
    );
    const handoff = beginAiCreditsArrivalHandoff(SCOPE, 'usage-limit');
    expect(hasAiCreditsArrivalSession()).toBe(true);
    suspendAiCreditsArrivalAccount();
    reconcileAiCreditsArrivalAccount('account:b');
    // The read started before the account changed, but answers with B.
    resolveIdentity(account('b'));
    await flush();
    handoff?.retain();
    expect(handoff?.recordCovered()).toBe(false);
    expect(visible()).toBeNull();
  });
  it('queues a record made during a same-account recheck', async () => {
    const handoff = await completedHandoff(creditsState(0));
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState(16));
    suspendAiCreditsArrivalAccount();
    expect(handoff.recordCovered()).toBe(false);
    expect(visible()).toBeNull();
    reconcileAiCreditsArrivalAccount('account:a');
    expect(visible()?.handoffId).toBe(handoff.handoffId);
    await flush();
    expect(evidence()).toMatchObject({ addedCredits: 16 });
  });

  it.each(['projectId', 'worktreeId', 'chatId'] as const)(
    'preserves published and queued arrivals when clearing another %s',
    async (key) => {
      const published = await completedHandoff(creditsState(0));
      published.recordCovered();
      const pending = await completedHandoff(creditsState(0));
      suspendAiCreditsArrivalAccount();
      pending.recordCovered();
      clearAiCreditsArrivalForChat({ ...TARGET, [key]: 'other' });
      expect(useAiCreditsArrivalStore.getState().arrival?.handoffId).toBe(
        published.handoffId,
      );
      reconcileAiCreditsArrivalAccount('account:a');
      expect(visible()?.handoffId).toBe(pending.handoffId);
    },
  );

  it('hides during a recheck and keeps an answer read meanwhile', async () => {
    const handoff = await completedHandoff(creditsState(0));
    let resolveRead: (state: CanopyCloudAiCreditsState) => void = () => {};
    loadCanopyCloudAiCredits.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );
    handoff.recordCovered();
    suspendAiCreditsArrivalAccount();
    resolveRead(creditsState(16));
    await flush();
    expect(visible()).toBeNull();
    reconcileAiCreditsArrivalAccount('account:a');
    expect(evidence()).toMatchObject({ addedCredits: 16 });
  });

  it('spends the original retry budget while suspended without restarting it on reconcile', async () => {
    const handoff = await completedHandoff(creditsState(0));
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState(0));
    handoff.recordCovered();
    await flush();
    suspendAiCreditsArrivalAccount();
    await jest.advanceTimersByTimeAsync(4_000);
    expect(visible()).toBeNull();
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledTimes(4);
    reconcileAiCreditsArrivalAccount('account:a');
    expect(evidence()).toMatchObject({ final: true, addedCredits: null });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledTimes(4);
  });

  it('clears on an account switch and rejects the old session after', async () => {
    const handoff = await completedHandoff(creditsState(0));
    const pending = await completedHandoff(creditsState(0));
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState(16));
    handoff.recordCovered();
    expect(hasAiCreditsArrivalSession()).toBe(true);
    suspendAiCreditsArrivalAccount();
    reconcileAiCreditsArrivalAccount('account:b');
    expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();
    // Back to the first account: the old session's hand-off stays inert.
    suspendAiCreditsArrivalAccount();
    reconcileAiCreditsArrivalAccount('account:a');
    expect(pending.isLive()).toBe(false);
    expect(pending.recordCovered()).toBe(false);
    expect(visible()).toBeNull();
  });

  it('clears on sign-out', async () => {
    const handoff = await completedHandoff(creditsState(0));
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState(16));
    handoff.recordCovered();
    reconcileAiCreditsArrivalAccount(null);
    expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();
  });

  it('rejects a hand-off whose identity resolves to another account', async () => {
    reconcileAiCreditsArrivalAccount('account:a');
    suspendAiCreditsArrivalAccount();
    loadCanopyCloudAccount.mockResolvedValue(account('b'));
    const handoff = await completedHandoff(creditsState(0));
    reconcileAiCreditsArrivalAccount('account:a');
    expect(handoff.recordCovered()).toBe(false);
    expect(visible()).toBeNull();
  });
});

describe('routing the chat through bought credits (CAN-5159)', () => {
  it('moves the record from the notice to the card and keeps late evidence', async () => {
    const handoff = await completedHandoff(creditsState(0));
    let answer: (value: CanopyCloudAiCreditsState) => void = () => undefined;
    loadCanopyCloudAiCredits.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    handoff.recordCovered();
    expect(routed()).toBeNull();
    markAiCreditsArrivalRouted(handoff.handoffId);
    expect(visible()).toBeNull();
    expect(routed()?.handoffId).toBe(handoff.handoffId);
    expect(routedEvidence()).toBeNull();
    answer(creditsState(16));
    await flush();
    expect(routedEvidence()).toMatchObject({
      addedCredits: 16,
      balanceCredits: 16,
    });
    expect(visible()).toBeNull();
  });

  it('keeps evidence that settled before routing', async () => {
    const handoff = await completedHandoff(creditsState(0));
    loadCanopyCloudAiCredits.mockResolvedValueOnce(creditsState(16));
    handoff.recordCovered();
    await flush();
    markAiCreditsArrivalRouted(handoff.handoffId);
    expect(routedEvidence()).toMatchObject({ addedCredits: 16 });
  });

  it('ignores a stale or unknown hand-off id', async () => {
    markAiCreditsArrivalRouted('arrival-unknown');
    expect(useAiCreditsArrivalStore.getState().routed).toBe(false);
    expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();

    const older = await completedHandoff(creditsState(0));
    const newer = await completedHandoff(creditsState(0));
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState(16));
    newer.recordCovered();
    markAiCreditsArrivalRouted(older.handoffId);
    expect(useAiCreditsArrivalStore.getState().routed).toBe(false);
    expect(visible()?.handoffId).toBe(newer.handoffId);
    expect(routed()).toBeNull();
  });

  it('a newer arrival replaces a routed record unrouted', async () => {
    const first = await completedHandoff(creditsState(0));
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState(16));
    first.recordCovered();
    markAiCreditsArrivalRouted(first.handoffId);
    const second = await completedHandoff(creditsState(16));
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState(32));
    expect(second.recordCovered()).toBe(true);
    expect(useAiCreditsArrivalStore.getState().routed).toBe(false);
    expect(visible()?.handoffId).toBe(second.handoffId);
    expect(routed()).toBeNull();
  });

  it('drops a routed record on sign-out', async () => {
    const handoff = await completedHandoff(creditsState(0));
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState(16));
    handoff.recordCovered();
    markAiCreditsArrivalRouted(handoff.handoffId);
    reconcileAiCreditsArrivalAccount(null);
    expect(useAiCreditsArrivalStore.getState()).toMatchObject({
      arrival: null,
      evidence: null,
      routed: false,
    });
  });

  it('drops a routed record on an account switch', async () => {
    const handoff = await completedHandoff(creditsState(0));
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState(16));
    handoff.recordCovered();
    markAiCreditsArrivalRouted(handoff.handoffId);
    suspendAiCreditsArrivalAccount();
    reconcileAiCreditsArrivalAccount('account:b');
    expect(useAiCreditsArrivalStore.getState()).toMatchObject({
      arrival: null,
      routed: false,
    });
  });

  it('hides during a same-account recheck and restores it still routed', async () => {
    const handoff = await completedHandoff(creditsState(0));
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState(16));
    handoff.recordCovered();
    await flush();
    markAiCreditsArrivalRouted(handoff.handoffId);
    suspendAiCreditsArrivalAccount();
    expect(routed()).toBeNull();
    reconcileAiCreditsArrivalAccount('account:a');
    expect(routed()?.handoffId).toBe(handoff.handoffId);
    expect(visible()).toBeNull();
    expect(routedEvidence()).toMatchObject({ addedCredits: 16 });
  });

  it('clears a routed record by hand-off id', async () => {
    const handoff = await completedHandoff(creditsState(0));
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState(16));
    handoff.recordCovered();
    await flush();
    markAiCreditsArrivalRouted(handoff.handoffId);
    clearAiCreditsArrival(handoff.handoffId);
    expect(useAiCreditsArrivalStore.getState()).toMatchObject({
      arrival: null,
      evidence: null,
      routed: false,
    });
  });

  it('clears a routed record for its chat', async () => {
    const handoff = await completedHandoff(creditsState(0));
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState(16));
    handoff.recordCovered();
    await flush();
    markAiCreditsArrivalRouted(handoff.handoffId);
    clearAiCreditsArrivalForChat(TARGET);
    expect(useAiCreditsArrivalStore.getState()).toMatchObject({
      arrival: null,
      evidence: null,
      routed: false,
    });
  });

  it('shows the routed record only for its chat, routed, while the account is ready', async () => {
    const handoff = await completedHandoff(creditsState(0));
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState(16));
    handoff.recordCovered();
    expect(routed()).toBeNull();
    markAiCreditsArrivalRouted(handoff.handoffId);
    expect(routed({ ...TARGET, chatId: 'chat-2' })).toBeNull();
    expect(routed({ ...TARGET, worktreeId: 'wt-1' })).toBeNull();
    expect(routed({ ...TARGET, projectId: 'p2' })).toBeNull();
    expect(
      selectRoutedAiCreditsArrivalForChat(
        useAiCreditsArrivalStore.getState(),
        null,
      ),
    ).toBeNull();
    suspendAiCreditsArrivalAccount();
    expect(routed()).toBeNull();
  });
});

describe('the banner that started the hand-off (CAN-5160)', () => {
  it('shows a record only to its origin', async () => {
    const handoff = await completedHandoff(
      creditsState(0),
      'no-billing-source',
    );
    loadCanopyCloudAiCredits.mockResolvedValueOnce(creditsState(16));
    expect(handoff.recordCovered()).toBe(true);
    expect(useAiCreditsArrivalStore.getState().arrival?.origin).toBe(
      'no-billing-source',
    );
    expect(visible('no-billing-source')?.handoffId).toBe(handoff.handoffId);
    expect(visible('usage-limit')).toBeNull();
    await flush();
    // Evidence and routing selectors do not depend on the origin.
    expect(
      selectAiCreditsArrivalEvidence(
        useAiCreditsArrivalStore.getState(),
        handoff.handoffId,
      ),
    ).toMatchObject({ addedCredits: 16, balanceCredits: 16 });
    markAiCreditsArrivalRouted(handoff.handoffId);
    expect(routed()?.handoffId).toBe(handoff.handoffId);
  });

  it('lets a newer hand-off from the other banner supersede the record', async () => {
    const first = await completedHandoff(creditsState(0), 'usage-limit');
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState(16));
    first.recordCovered();
    expect(visible('usage-limit')?.handoffId).toBe(first.handoffId);
    const second = await completedHandoff(
      creditsState(16),
      'no-billing-source',
    );
    loadCanopyCloudAiCredits.mockResolvedValue(creditsState(32));
    expect(second.recordCovered()).toBe(true);
    expect(visible('usage-limit')).toBeNull();
    expect(visible('no-billing-source')?.handoffId).toBe(second.handoffId);
  });
});
