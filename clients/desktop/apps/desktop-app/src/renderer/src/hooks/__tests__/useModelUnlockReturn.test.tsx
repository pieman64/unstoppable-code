/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { useModelUnlockReturn } from '../useModelUnlockReturn';
import {
  resetModelUnlockConfirmationForTests,
  useModelUnlockConfirmationStore,
} from '@/lib/modelUnlockConfirmation';
import {
  beginModelUnlockIntent,
  checkModelUnlockNow,
  clearModelUnlockIntent,
  resetModelUnlockIntentForTests,
  type PendingModelUnlockIntent,
} from '@/lib/modelUnlockIntent';
import { useGitHubStore } from '@/stores/githubStore';
import {
  beginAiCreditsHandoff,
  completeAiCreditsHandoff,
  resetAiCreditsHandoffsForTests,
  useAiCreditsHandoffStore,
} from '@/stores/aiCreditsHandoffStore';
import {
  beginAiCreditsArrivalHandoff,
  resetAiCreditsArrivalForTests,
  useAiCreditsArrivalStore,
} from '@/lib/aiCreditsArrivalConfirmation';

jest.mock('@/lib/modelLibraryAccess', () => ({
  ensureModelLibraryAccessSubscribed: jest.fn(),
  refreshModelLibraryAccess: jest.fn(() => Promise.resolve(null)),
}));

/**
 * CAN-5027 — the app root turns a confirmed unlock into the unchanged toast
 * plus the in-chat confirmation, and ends the confirmation with its account
 * session even when nothing is pending any more.
 */

const ACCOUNT_KEY = 'account:acct_1';
const loadCanopyCloudAccount = jest.fn();
const addToast = jest.fn();
const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');

function Root(): JSX.Element | null {
  useModelUnlockReturn();
  return null;
}

function intent(
  overrides: Partial<PendingModelUnlockIntent> = {},
): PendingModelUnlockIntent {
  return {
    requestId: 'req-1',
    accountId: ACCOUNT_KEY,
    owner: 'personal',
    chatId: 'chat-1',
    scope: {
      kind: 'work',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat-1',
    },
    modelId: 'sonnet',
    startedAt: Date.now(),
    ...overrides,
  };
}

async function confirm(pending: PendingModelUnlockIntent): Promise<void> {
  await act(async () => {
    beginModelUnlockIntent(pending, {
      apply: () => Promise.resolve(true),
      resolveOwner: () => Promise.resolve(pending.owner),
      refreshAccess: () =>
        Promise.resolve({
          accountKey: pending.accountId,
          ownerKey: pending.owner,
          access: 'unlocked',
          authoritative: true,
        }),
    });
    await Promise.all([checkModelUnlockNow(), checkModelUnlockNow()]);
  });
}

/** CAN-5160: an arrival recorded with no unlock session at all. */
async function recordArrival(): Promise<void> {
  const loadCanopyCloudAiCredits = jest.fn(() =>
    Promise.resolve({
      connected: true,
      email: 'buyer@example.com',
      subscription: null,
      balance: {
        email: 'buyer@example.com',
        credits: 0,
        eligible: false,
        source: 'canopy',
      },
      noUdAccount: false,
      error: null,
    }),
  );
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { loadCanopyCloudAccount, loadCanopyCloudAiCredits },
  });
  await act(async () => {
    const handoff = beginAiCreditsArrivalHandoff(
      {
        kind: 'work',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat-1',
      },
      'usage-limit',
    );
    for (let index = 0; index < 10; index++) await Promise.resolve();
    handoff?.markExternalOpen();
    handoff?.retain();
    expect(handoff?.recordCovered()).toBe(true);
  });
}

async function accountChanged(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    for (let index = 0; index < 20; index++) await Promise.resolve();
  });
}

describe('useModelUnlockReturn', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    loadCanopyCloudAccount.mockReset();
    loadCanopyCloudAccount.mockResolvedValue({ account: { id: 'acct_1' } });
    resetModelUnlockIntentForTests();
    resetModelUnlockConfirmationForTests();
    resetAiCreditsArrivalForTests();
    useGitHubStore.setState({ addToast });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { loadCanopyCloudAccount },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Root />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  it('keeps the toast and records the confirmation once', async () => {
    await confirm(intent());
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledWith(
      'Advanced models are unlocked.',
      'success',
    );
    expect(useModelUnlockConfirmationStore.getState().confirmation).toEqual({
      requestId: 'req-1',
      accountId: ACCOUNT_KEY,
      owner: 'personal',
      chatId: 'chat-1',
      scope: {
        kind: 'work',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat-1',
      },
      modelId: 'sonnet',
      // No balance was read before this checkout opened.
      startingBalance: null,
    });
  });

  it('keeps only the toast for an intent with no chat', async () => {
    await confirm(intent({ chatId: null }));
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(useModelUnlockConfirmationStore.getState().confirmation).toBeNull();
  });

  it('clears the confirmation on an account switch with nothing pending', async () => {
    await confirm(intent());
    act(() => clearModelUnlockIntent());
    loadCanopyCloudAccount.mockResolvedValue({ account: { id: 'acct_2' } });
    await accountChanged();
    expect(loadCanopyCloudAccount).toHaveBeenCalledTimes(2);
    expect(useModelUnlockConfirmationStore.getState().confirmation).toBeNull();
  });

  it('clears the confirmation when the account cannot be read', async () => {
    await confirm(intent());
    act(() => clearModelUnlockIntent());
    loadCanopyCloudAccount.mockRejectedValue(new Error('unreadable'));
    await accountChanged();
    expect(useModelUnlockConfirmationStore.getState().confirmation).toBeNull();
  });

  it('skips the account read when there is nothing to reconcile', async () => {
    await accountChanged();
    expect(loadCanopyCloudAccount).not.toHaveBeenCalled();
  });

  it('clears an unreadable identity even if stale account metadata is returned', async () => {
    await confirm(intent());
    act(() => clearModelUnlockIntent());
    loadCanopyCloudAccount.mockResolvedValue({
      read: 'unavailable',
      account: { id: 'acct_1' },
    });
    await accountChanged();
    expect(useModelUnlockConfirmationStore.getState().confirmation).toBeNull();
  });

  it('ignores an older account read that finishes after a newer switch', async () => {
    await confirm(intent());
    let resolveOld: (value: unknown) => void = () => {};
    loadCanopyCloudAccount.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
    );
    await accountChanged();
    loadCanopyCloudAccount.mockResolvedValue({ account: { id: 'acct_2' } });
    await accountChanged();
    await confirm(intent({ requestId: 'req-2', accountId: 'account:acct_2' }));
    await act(async () => {
      resolveOld({ account: { id: 'acct_1' } });
      for (let index = 0; index < 20; index++) await Promise.resolve();
    });
    expect(
      useModelUnlockConfirmationStore.getState().confirmation?.requestId,
    ).toBe('req-2');
  });

  it('hides the old confirmation while account identity is unresolved', async () => {
    await confirm(intent());
    loadCanopyCloudAccount.mockReturnValueOnce(new Promise(() => {}));
    await accountChanged();
    expect(useModelUnlockConfirmationStore.getState().accountReady).toBe(false);
  });

  it('records a confirmation delivered during a matching account check', async () => {
    await confirm(intent());
    let answer: (value: unknown) => void = () => {};
    loadCanopyCloudAccount.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await accountChanged();
    await confirm(intent({ requestId: 'req-2' }));
    await confirm(intent({ requestId: 'req-3', chatId: null }));
    await act(async () => {
      answer({ account: { id: 'acct_1' } });
      for (let index = 0; index < 20; index++) await Promise.resolve();
    });
    expect(useModelUnlockConfirmationStore.getState().accountReady).toBe(true);
    expect(
      useModelUnlockConfirmationStore.getState().confirmation?.requestId,
    ).toBe('req-2');
  });

  it('clears when the account API is unavailable', async () => {
    await confirm(intent());
    Object.defineProperty(window, 'api', { configurable: true, value: {} });
    await accountChanged();
    expect(useModelUnlockConfirmationStore.getState().confirmation).toBeNull();
  });

  it('reconciles an arrival confirmation when it is the only session', async () => {
    await recordArrival();
    loadCanopyCloudAccount.mockClear();
    await accountChanged();
    expect(loadCanopyCloudAccount).toHaveBeenCalledTimes(1);
    expect(useAiCreditsArrivalStore.getState().arrival).not.toBeNull();
    expect(useAiCreditsArrivalStore.getState().accountReady).toBe(true);

    loadCanopyCloudAccount.mockResolvedValue({ account: { id: 'acct_2' } });
    await accountChanged();
    expect(useAiCreditsArrivalStore.getState().arrival).toBeNull();
  });

  it('stops delivering after unmount', async () => {
    act(() => root.unmount());
    root = createRoot(container);
    await confirm(intent());
    expect(addToast).not.toHaveBeenCalled();
    expect(useModelUnlockConfirmationStore.getState().confirmation).toBeNull();
  });

  describe('pending credits checkouts (CAN-5534)', () => {
    const WALLET = 'work|project|worktree||personal';

    async function startCheckout(): Promise<string> {
      let id = '';
      await act(async () => {
        const record = beginAiCreditsHandoff({
          walletKey: WALLET,
          originChatKey: 'project/worktree/chat-1',
          originScopeKey: 'work|project|worktree|chat-1|personal',
          origin: 'no-billing-source',
          accountGeneration:
            useAiCreditsHandoffStore.getState().accountGeneration,
          arrival: null,
        });
        id = record?.id ?? '';
        for (let index = 0; index < 10; index++) await Promise.resolve();
      });
      return id;
    }

    function pending(): string | undefined {
      return useAiCreditsHandoffStore.getState().records[WALLET]?.id;
    }

    beforeEach(() => {
      resetAiCreditsHandoffsForTests();
    });
    afterEach(() => {
      resetAiCreditsHandoffsForTests();
    });

    it('keeps a checkout through a same-account credits refresh', async () => {
      const id = await startCheckout();
      await accountChanged();
      expect(pending()).toBe(id);
    });

    it('ends a checkout when another account signs in, with nothing else pending', async () => {
      await startCheckout();
      loadCanopyCloudAccount.mockResolvedValue({ account: { id: 'acct_2' } });
      await accountChanged();
      expect(pending()).toBeUndefined();
    });

    it('ends a checkout on sign-out', async () => {
      await startCheckout();
      loadCanopyCloudAccount.mockResolvedValue({ hasApiKey: false });
      await accountChanged();
      expect(pending()).toBeUndefined();
    });

    it('keeps a checkout, unattributed, when the account cannot be read', async () => {
      const id = await startCheckout();
      loadCanopyCloudAccount.mockRejectedValue(new Error('offline'));
      await accountChanged();
      expect(pending()).toBe(id);
      expect(
        useAiCreditsHandoffStore.getState().records[WALLET]?.identityUnverified,
      ).toBe(true);
    });

    it('fences coverage during identity refresh and preserves the original arrival after a failed read', async () => {
      const scope = {
        kind: 'work',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat-1',
      } satisfies PendingModelUnlockIntent['scope'];
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          loadCanopyCloudAccount,
          loadCanopyCloudAiCredits: () =>
            Promise.resolve({
              connected: true,
              balance: { credits: 0, eligible: false, source: 'canopy' },
              error: null,
            }),
        },
      });
      await act(async () => {
        const arrival = beginAiCreditsArrivalHandoff(
          scope,
          'no-billing-source',
        );
        for (let i = 0; i < 20; i++) await Promise.resolve();
        arrival?.markExternalOpen();
        arrival?.retain();
        beginAiCreditsHandoff({
          walletKey: WALLET,
          originChatKey: 'project/worktree/chat-1',
          originScopeKey: 'scope',
          origin: 'no-billing-source',
          accountGeneration:
            useAiCreditsHandoffStore.getState().accountGeneration,
          arrival,
        });
        for (let i = 0; i < 20; i++) await Promise.resolve();
      });
      const original = useAiCreditsHandoffStore.getState().records[WALLET];
      if (!original) throw new Error('Expected checkout');
      let rejectRead: (error: Error) => void = () => {};
      loadCanopyCloudAccount.mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectRead = reject;
        }),
      );
      await accountChanged();
      expect(
        completeAiCreditsHandoff(
          WALLET,
          original.id,
          original.accountGeneration,
        ),
      ).toBe(false);
      expect(pending()).toBe(original.id);
      await act(async () => {
        rejectRead(new Error('offline'));
        for (let i = 0; i < 20; i++) await Promise.resolve();
      });
      expect(pending()).toBe(original.id);
      loadCanopyCloudAccount.mockResolvedValue({ account: { id: 'acct_1' } });
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        for (let i = 0; i < 20; i++) await Promise.resolve();
      });
      await act(async () => {
        const current = useAiCreditsHandoffStore.getState().records[WALLET];
        if (!current) throw new Error('Lost pending checkout');
        expect(
          completeAiCreditsHandoff(
            WALLET,
            current.id,
            current.accountGeneration,
          ),
        ).toBe(true);
        for (let i = 0; i < 20; i++) await Promise.resolve();
      });
      expect(useAiCreditsArrivalStore.getState().arrival?.chatId).toBe(
        'chat-1',
      );
    });

    it('applies only the newest of out-of-order account reads', async () => {
      await startCheckout();
      let answerFirst: (value: unknown) => void = () => {};
      loadCanopyCloudAccount
        .mockReturnValueOnce(
          new Promise((resolve) => {
            answerFirst = resolve;
          }),
        )
        .mockResolvedValueOnce({ account: { id: 'acct_2' } });
      await accountChanged();
      await accountChanged();
      expect(pending()).toBeUndefined();
      // The older read names the original account; it must not revive it.
      await act(async () => {
        answerFirst({ account: { id: 'acct_1' } });
        for (let index = 0; index < 10; index++) await Promise.resolve();
      });
      expect(pending()).toBeUndefined();
    });
  });
});
