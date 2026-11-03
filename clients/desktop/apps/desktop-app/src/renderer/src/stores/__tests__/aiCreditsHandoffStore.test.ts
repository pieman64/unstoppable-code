/** @jest-environment jsdom */

import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';
import type { AiCreditsArrivalHandoff } from '@/lib/aiCreditsArrivalConfirmation';
import { aiCreditsWalletKey } from '@/lib/aiCreditsScope';
import {
  AI_CREDITS_HANDOFF_MAX_AGE_MS,
  beginAiCreditsHandoff,
  claimAiCreditsHandoffOpening,
  completeAiCreditsHandoff,
  endAiCreditsHandoff,
  hasAiCreditsHandoffs,
  isAiCreditsHandoffCurrent,
  reconcileAiCreditsHandoffAccount,
  releaseAiCreditsHandoffOpening,
  resetAiCreditsHandoffsForTests,
  selectAiCreditsHandoff,
  setAiCreditsHandoffFeedback,
  useAiCreditsHandoffStore,
  type AiCreditsHandoffRecord,
} from '../aiCreditsHandoffStore';

/**
 * CAN-5534 — the pending credits checkout outlives its CTA: one record per
 * purchase scope, a fixed lifetime, and account isolation.
 */

const NAV = 'personal';
const WALLET = 'work|p1|w1||personal';
const loadCanopyCloudAccount = jest.fn<
  Promise<Partial<CanopyCloudAccountPublicState>>,
  []
>();
const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');

function account(id: string): Partial<CanopyCloudAccountPublicState> {
  return {
    read: 'ok',
    hasApiKey: true,
    authMode: 'oauth',
    credentialSource: 'oauth_desktop',
    account: { id, name: 'Buyer', email: 'b@example.com', role: 'DEVELOPER' },
  };
}

function fakeHandle(): AiCreditsArrivalHandoff & {
  readonly recordCovered: jest.Mock<boolean, []>;
  readonly cancel: jest.Mock<void, []>;
} {
  return {
    handoffId: 'arrival-1',
    isLive: () => true,
    markExternalOpen: () => {},
    retain: () => {},
    recordCovered: jest.fn(() => true),
    cancel: jest.fn(),
  };
}

function begin(
  overrides: Partial<Parameters<typeof beginAiCreditsHandoff>[0]> = {},
): AiCreditsHandoffRecord {
  const record = beginAiCreditsHandoff({
    walletKey: WALLET,
    originChatKey: 'p1/w1/chat-1',
    originScopeKey: 'work|p1|w1|chat-1|personal',
    origin: 'no-billing-source',
    accountGeneration: useAiCreditsHandoffStore.getState().accountGeneration,
    arrival: null,
    ...overrides,
  });
  if (record === null) throw new Error('no record');
  return record;
}

function current(): AiCreditsHandoffRecord | null {
  return selectAiCreditsHandoff(useAiCreditsHandoffStore.getState(), WALLET);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

beforeEach(() => {
  jest.useFakeTimers({ now: 1_000_000 });
  resetAiCreditsHandoffsForTests();
  loadCanopyCloudAccount.mockReset();
  loadCanopyCloudAccount.mockResolvedValue(account('a'));
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { loadCanopyCloudAccount },
  });
});

afterEach(() => {
  resetAiCreditsHandoffsForTests();
  jest.useRealTimers();
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor);
  } else {
    Reflect.deleteProperty(window, 'api');
  }
});

describe('aiCreditsWalletKey', () => {
  it('ignores the chat but separates project, worktree and navigation context', () => {
    const key = aiCreditsWalletKey({ projectId: 'p1', worktreeId: 'w1' }, NAV);
    expect(key).toBe(WALLET);
    expect(
      aiCreditsWalletKey({ projectId: 'p2', worktreeId: 'w1' }, NAV),
    ).not.toBe(key);
    expect(
      aiCreditsWalletKey({ projectId: 'p1', worktreeId: 'w2' }, NAV),
    ).not.toBe(key);
    expect(
      aiCreditsWalletKey({ projectId: 'p1', worktreeId: 'w1' }, 'org:o1'),
    ).not.toBe(key);
    expect(aiCreditsWalletKey(null, NAV)).toBeNull();
  });
});

describe('records', () => {
  it('adopts the pending record instead of replacing its baseline or deadline', () => {
    const first = begin();
    const handle = fakeHandle();
    jest.advanceTimersByTime(60_000);
    const second = begin({ originChatKey: 'p1/w1/chat-2', arrival: handle });
    expect(second).toBe(first);
    expect(handle.cancel).toHaveBeenCalledTimes(1);
    expect(current()?.startedAt).toBe(first.startedAt);
  });

  it('lets one CTA open per scope until the record exists', () => {
    const latch = claimAiCreditsHandoffOpening(WALLET);
    expect(latch).not.toBeNull();
    expect(claimAiCreditsHandoffOpening(WALLET)).toBeNull();
    if (latch) releaseAiCreditsHandoffOpening(WALLET, latch);
    begin();
    expect(claimAiCreditsHandoffOpening(WALLET)).toBeNull();
  });

  it('ignores feedback from a record that has ended', () => {
    const record = begin();
    endAiCreditsHandoff(WALLET, record.id, record.accountGeneration);
    const next = begin();
    setAiCreditsHandoffFeedback(
      WALLET,
      record.id,
      record.accountGeneration,
      'uncovered',
    );
    expect(current()?.id).toBe(next.id);
    expect(current()?.feedback).toBeNull();
  });

  it('completes once, recording the arrival before the record goes', async () => {
    const handle = fakeHandle();
    let recordedWhilePending = false;
    handle.recordCovered.mockImplementation(() => {
      recordedWhilePending = current() !== null;
      return true;
    });
    const record = begin({ arrival: handle });
    await flush();
    expect(
      completeAiCreditsHandoff(WALLET, record.id, record.accountGeneration),
    ).toBe(true);
    expect(
      completeAiCreditsHandoff(WALLET, record.id, record.accountGeneration),
    ).toBe(false);
    expect(handle.recordCovered).toHaveBeenCalledTimes(1);
    expect(recordedWhilePending).toBe(true);
    expect(hasAiCreditsHandoffs()).toBe(false);
  });

  it('ignores a dismissal carrying the wrong account generation', () => {
    const record = begin();
    endAiCreditsHandoff(WALLET, record.id, record.accountGeneration - 1);
    expect(current()?.id).toBe(record.id);
  });

  it('ends a dismissed record and cancels its arrival', () => {
    const handle = fakeHandle();
    const record = begin({ arrival: handle });
    endAiCreditsHandoff(WALLET, record.id, record.accountGeneration);
    expect(current()).toBeNull();
    expect(handle.cancel).toHaveBeenCalledTimes(1);
    expect(
      completeAiCreditsHandoff(WALLET, record.id, record.accountGeneration),
    ).toBe(false);
    expect(handle.recordCovered).not.toHaveBeenCalled();
  });
});

describe('expiry', () => {
  it('times out at the deadline with no banner mounted, and nothing renews it', () => {
    const handle = fakeHandle();
    const record = begin({ arrival: handle });
    jest.advanceTimersByTime(AI_CREDITS_HANDOFF_MAX_AGE_MS - 1_000);
    setAiCreditsHandoffFeedback(
      WALLET,
      record.id,
      record.accountGeneration,
      'uncovered',
    );
    begin();
    jest.advanceTimersByTime(999);
    expect(current()?.id).toBe(record.id);
    jest.advanceTimersByTime(1);
    expect(current()).toBeNull();
    expect(handle.cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects an expired record before completing it after a suspended timer', () => {
    const handle = fakeHandle();
    const record = begin({ arrival: handle });
    // A sleeping machine: the clock moves without the timer firing.
    jest.setSystemTime(record.startedAt + AI_CREDITS_HANDOFF_MAX_AGE_MS);
    expect(
      isAiCreditsHandoffCurrent(WALLET, record.id, record.accountGeneration),
    ).toBe(false);
    expect(
      completeAiCreditsHandoff(WALLET, record.id, record.accountGeneration),
    ).toBe(false);
    expect(handle.recordCovered).not.toHaveBeenCalled();
  });
});

describe('account lifecycle', () => {
  it('does not complete or discard a checkout while its buyer is unresolved', async () => {
    let identify: (
      value: Partial<CanopyCloudAccountPublicState>,
    ) => void = () => {};
    loadCanopyCloudAccount.mockReturnValueOnce(
      new Promise((resolve) => {
        identify = resolve;
      }),
    );
    const handle = fakeHandle();
    const record = begin({ arrival: handle });
    await flush();
    expect(
      completeAiCreditsHandoff(WALLET, record.id, record.accountGeneration),
    ).toBe(false);
    expect(current()?.id).toBe(record.id);
    expect(handle.recordCovered).not.toHaveBeenCalled();
    identify(account('a'));
    await flush();
    expect(
      completeAiCreditsHandoff(WALLET, record.id, record.accountGeneration),
    ).toBe(true);
  });

  it('clears a new checkout when its identifying read confirms sign-out', async () => {
    loadCanopyCloudAccount.mockResolvedValue({ read: 'ok', hasApiKey: false });
    const handle = fakeHandle();
    begin({ arrival: handle });
    await flush();
    expect(current()).toBeNull();
    expect(handle.cancel).toHaveBeenCalledTimes(1);
  });

  it('keeps records through a same-account refresh', async () => {
    const record = begin();
    await flush();
    expect(current()?.accountKey).toBe('account:a');
    reconcileAiCreditsHandoffAccount({ kind: 'account', key: 'account:a' });
    expect(current()?.id).toBe(record.id);
  });

  it('ends records for good on a different account or sign-out', async () => {
    const handle = fakeHandle();
    const record = begin({ arrival: handle });
    await flush();
    reconcileAiCreditsHandoffAccount({ kind: 'account', key: 'account:b' });
    expect(current()).toBeNull();
    expect(handle.cancel).toHaveBeenCalledTimes(1);
    expect(
      completeAiCreditsHandoff(WALLET, record.id, record.accountGeneration),
    ).toBe(false);

    begin({
      accountGeneration: useAiCreditsHandoffStore.getState().accountGeneration,
    });
    await flush();
    reconcileAiCreditsHandoffAccount({ kind: 'signed-out' });
    expect(current()).toBeNull();
  });

  it('keeps a record and its arrival through unreadable coverage until identity recovers', async () => {
    const handle = fakeHandle();
    const record = begin({ arrival: handle });
    await flush();
    reconcileAiCreditsHandoffAccount({ kind: 'unreadable' });
    expect(current()?.identityUnverified).toBe(true);
    expect(
      completeAiCreditsHandoff(WALLET, record.id, record.accountGeneration),
    ).toBe(false);
    expect(current()?.id).toBe(record.id);
    expect(handle.recordCovered).not.toHaveBeenCalled();
    expect(handle.cancel).not.toHaveBeenCalled();
    reconcileAiCreditsHandoffAccount({ kind: 'account', key: 'account:a' });
    expect(
      completeAiCreditsHandoff(WALLET, record.id, record.accountGeneration),
    ).toBe(true);
    expect(handle.recordCovered).toHaveBeenCalledTimes(1);
  });

  it('attributes again once the same account reads back', async () => {
    const handle = fakeHandle();
    const record = begin({ arrival: handle });
    await flush();
    reconcileAiCreditsHandoffAccount({ kind: 'unreadable' });
    reconcileAiCreditsHandoffAccount({ kind: 'account', key: 'account:a' });
    expect(current()?.identityUnverified).toBe(false);
    completeAiCreditsHandoff(WALLET, record.id, record.accountGeneration);
    expect(handle.recordCovered).toHaveBeenCalledTimes(1);
  });

  it('never binds a late identity answer to a newer account', async () => {
    let answer: (
      value: Partial<CanopyCloudAccountPublicState>,
    ) => void = () => {};
    loadCanopyCloudAccount.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    begin();
    await flush();
    reconcileAiCreditsHandoffAccount({ kind: 'account', key: 'account:b' });
    // The click's own account read answers late, naming the old account.
    answer(account('a'));
    await flush();
    expect(current()).toBeNull();
  });

  it('rejects a begin whose open started before an account change', async () => {
    begin();
    await flush();
    const staleGeneration =
      useAiCreditsHandoffStore.getState().accountGeneration;
    reconcileAiCreditsHandoffAccount({ kind: 'signed-out' });
    const handle = fakeHandle();
    expect(
      beginAiCreditsHandoff({
        walletKey: WALLET,
        originChatKey: null,
        originScopeKey: 'k',
        origin: null,
        accountGeneration: staleGeneration,
        arrival: handle,
      }),
    ).toBeNull();
    expect(handle.cancel).toHaveBeenCalledTimes(1);
    expect(current()).toBeNull();
  });
});
