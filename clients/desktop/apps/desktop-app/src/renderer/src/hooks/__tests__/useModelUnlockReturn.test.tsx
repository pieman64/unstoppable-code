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
});
