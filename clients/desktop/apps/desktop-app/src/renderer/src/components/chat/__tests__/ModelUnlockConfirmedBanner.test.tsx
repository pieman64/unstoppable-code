/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  getModelDisplayName,
  type CanopyCloudAiCreditsState,
} from '@canopy/desktop-shared/types';
import { ModelUnlockConfirmedBanner } from '../ModelUnlockConfirmedBanner';
import {
  recordModelUnlockConfirmation,
  resetModelUnlockConfirmationForTests,
  useModelUnlockConfirmationStore,
} from '@/lib/modelUnlockConfirmation';
import type { PendingModelUnlockIntent } from '@/lib/modelUnlockIntent';
import { readBillingOwnerKey } from '@/lib/openBillingPage';

jest.mock('@/lib/openBillingPage', () => ({
  readBillingOwnerKey: jest.fn(),
}));

/**
 * CAN-5027 — the composer's unlock confirmation: shown only in the chat the
 * purchase started in and only for the owner that paid, with the balance and
 * model sentences each stated only while true.
 */

const TARGET = { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' };
const MODEL = 'sonnet';
const ownerKey = jest.mocked(readBillingOwnerKey);
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
    chatId: TARGET.chatId,
    scope: { kind: 'work', ...TARGET },
    modelId: MODEL,
    startedAt: 0,
    ...overrides,
  };
}

function balance(credits: number): CanopyCloudAiCreditsState {
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
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 20; index++) await Promise.resolve();
  });
}

describe('ModelUnlockConfirmedBanner', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    resetModelUnlockConfirmationForTests();
    ownerKey.mockResolvedValue('personal');
    loadCanopyCloudAiCredits.mockResolvedValue(balance(1200));
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { loadCanopyCloudAiCredits },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
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

  function render(
    model: string | undefined = MODEL,
    target: typeof TARGET | null = TARGET,
  ): void {
    act(() =>
      root.render(<ModelUnlockConfirmedBanner target={target} model={model} />),
    );
  }

  function notice(): HTMLElement | null {
    return container.querySelector<HTMLElement>(
      '[data-testid="model-unlock-confirmed-notice"]',
    );
  }

  it('reports the refreshed balance and the selected model', async () => {
    recordModelUnlockConfirmation(intent());
    render();
    await flush();
    expect(notice()?.textContent).toBe(
      `Your 1,200 AI Credits are now available. ${getModelDisplayName(MODEL)} is selected for this chat.`,
    );
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledTimes(1);
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledWith({
      kind: 'work',
      projectId: TARGET.projectId,
      worktreeId: TARGET.worktreeId,
      chatId: TARGET.chatId,
    });
  });

  it('names the model only while the chat is on it', async () => {
    recordModelUnlockConfirmation(intent());
    // Confirmation precedes the model landing.
    render('opus');
    await flush();
    expect(notice()?.textContent).toBe(
      'Your 1,200 AI Credits are now available. Advanced models are unlocked.',
    );
    render(MODEL);
    expect(notice()?.textContent).toContain('is selected for this chat.');
    // A later manual change removes the sentence again.
    render('haiku');
    expect(notice()?.textContent).not.toContain('is selected for this chat.');
  });

  it('omits the model sentence for an intent with no model', async () => {
    recordModelUnlockConfirmation(intent({ modelId: null }));
    render();
    await flush();
    expect(notice()?.textContent).not.toContain('is selected for this chat.');
  });

  it('shows nothing in another chat or without a target', async () => {
    recordModelUnlockConfirmation(intent({ chatId: 'other-chat' }));
    render();
    await flush();
    expect(notice()).toBeNull();
    render(MODEL, null);
    await flush();
    expect(notice()).toBeNull();
    expect(loadCanopyCloudAiCredits).not.toHaveBeenCalled();
  });

  it('does not show a same-named chat from another project or worktree', async () => {
    recordModelUnlockConfirmation(intent());
    render(MODEL, { ...TARGET, projectId: 'other-project' });
    await flush();
    expect(notice()).toBeNull();
    render(MODEL, { ...TARGET, worktreeId: 'other-worktree' });
    await flush();
    expect(notice()).toBeNull();
    expect(loadCanopyCloudAiCredits).not.toHaveBeenCalled();
  });

  it('stays silent until the owner is known and for a different owner', async () => {
    let resolveOwner: (owner: string | null) => void = () => {};
    ownerKey.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOwner = resolve;
      }),
    );
    recordModelUnlockConfirmation(intent());
    render();
    await flush();
    expect(notice()).toBeNull();
    expect(loadCanopyCloudAiCredits).not.toHaveBeenCalled();
    resolveOwner('org:another');
    await flush();
    expect(notice()).toBeNull();
    expect(loadCanopyCloudAiCredits).not.toHaveBeenCalled();
  });

  it('confirms an organization-owned unlock without a personal balance', async () => {
    ownerKey.mockResolvedValue('org:acme');
    recordModelUnlockConfirmation(intent({ owner: 'org:acme' }));
    render('opus');
    await flush();
    expect(notice()?.textContent).toBe('Advanced models are unlocked.');
    expect(loadCanopyCloudAiCredits).not.toHaveBeenCalled();
  });

  it('stays hidden when the owner cannot be established', async () => {
    ownerKey.mockResolvedValue(null);
    recordModelUnlockConfirmation(intent());
    render('opus');
    await flush();
    expect(notice()).toBeNull();
    expect(loadCanopyCloudAiCredits).not.toHaveBeenCalled();
  });

  it('never reports a zero balance', async () => {
    jest.useFakeTimers();
    try {
      loadCanopyCloudAiCredits.mockResolvedValue(balance(0));
      recordModelUnlockConfirmation(intent());
      render('opus');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(60_000);
      });
      expect(notice()?.textContent).toBe('Advanced models are unlocked.');
    } finally {
      jest.useRealTimers();
    }
  });

  it('shares one read across remounts and keeps the result', async () => {
    recordModelUnlockConfirmation(intent());
    render();
    await flush();
    act(() => root.unmount());
    root = createRoot(container);
    render();
    await flush();
    expect(loadCanopyCloudAiCredits).toHaveBeenCalledTimes(1);
    expect(notice()?.textContent).toContain('Your 1,200 AI Credits');
  });

  it('dismisses its own request, and a newer one shows again', async () => {
    recordModelUnlockConfirmation(intent());
    render();
    await flush();
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="model-unlock-confirmed-notice-dismiss"]',
        )
        ?.click(),
    );
    expect(notice()).toBeNull();
    expect(useModelUnlockConfirmationStore.getState().confirmation).toBeNull();
    act(() => {
      recordModelUnlockConfirmation(intent());
    });
    expect(notice()).toBeNull();
    act(() => {
      recordModelUnlockConfirmation(intent({ requestId: 'req-2' }));
    });
    await flush();
    expect(notice()).not.toBeNull();
  });
});
