/**
 * @jest-environment jsdom
 *
 * CAN-5030 — the composer's cue for a purchase still finishing in the
 * browser. It must survive the recovery dialog closing, belong only to the
 * chat where the purchase started, never open another checkout, and keep its
 * busy state scoped to the purchase whose check it started.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { initClaudeModels } from '@canopy/desktop-shared/types';

jest.mock('@canopy/desktop-instrumentation/client', () => ({
  succeedClientOperation: jest.fn(),
}));
jest.mock('@/lib/modelUnlockIntent', () => {
  const actual: Record<string, unknown> = jest.requireActual(
    '@/lib/modelUnlockIntent',
  );
  return { ...actual, checkModelUnlockNow: jest.fn() };
});

import {
  beginModelUnlockIntent,
  checkModelUnlockNow,
  handleBillingReturnLink,
  MODEL_UNLOCK_POLL_INTERVAL_MS,
  MODEL_UNLOCK_POLL_MAX_MS,
  resetModelUnlockIntentForTests,
  runModelUnlockPolling,
  useModelUnlockIntentStore,
} from '@/lib/modelUnlockIntent';
import { ModelUnlockPendingBanner } from '../ModelUnlockPendingBanner';
import type { ModelLibraryAccessRead } from '@/lib/modelLibraryAccess';
import type * as ModelUnlockIntentModule from '@/lib/modelUnlockIntent';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const checkNow = jest.mocked(checkModelUnlockNow);

let container: HTMLDivElement;
let root: Root;

function pendingIntent(
  requestId: string,
  overrides: { chatId?: string | null; modelId?: string | null } = {},
): void {
  beginModelUnlockIntent({
    requestId,
    accountId: 'account:acct_1',
    owner: 'personal',
    chatId: overrides.chatId === undefined ? 'chat-a' : overrides.chatId,
    modelId: overrides.modelId === undefined ? 'sonnet' : overrides.modelId,
    startedAt: Date.now(),
  });
}

function render(chatId: string | null | undefined): void {
  act(() => root.render(<ModelUnlockPendingBanner chatId={chatId} />));
}

function query(testId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function click(testId: string): void {
  act(() => query(testId)?.click());
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** A check the test settles by hand. */
function deferredCheck(): (outcome: 'unlocked' | 'pending' | 'failed') => void {
  let settle: (outcome: 'unlocked' | 'pending' | 'failed') => void = () => {};
  checkNow.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  return (outcome) => settle(outcome);
}

beforeAll(() => {
  initClaudeModels([{ id: 'sonnet', label: 'Sonnet' }]);
});

beforeEach(() => {
  resetModelUnlockIntentForTests();
  checkNow.mockReset();
  checkNow.mockResolvedValue('pending');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ModelUnlockPendingBanner', () => {
  it.each([null, undefined, 'chat-b'])(
    'renders nothing for the %s chat',
    (chatId) => {
      pendingIntent('req-1');
      render(chatId);
      expect(query('model-unlock-pending-notice')).toBeNull();
    },
  );

  it('renders nothing for a purchase that started without a chat', () => {
    pendingIntent('req-1', { chatId: null });
    render('chat-a');
    expect(query('model-unlock-pending-notice')).toBeNull();
  });

  it('renders nothing with no purchase pending', () => {
    render('chat-a');
    expect(query('model-unlock-pending-notice')).toBeNull();
  });

  it('shows the waiting notice with its model and no Dismiss', () => {
    pendingIntent('req-1');
    render('chat-a');

    const notice = query('model-unlock-pending-notice');
    expect(notice?.dataset.phase).toBe('waiting');
    expect(notice?.textContent).toContain(
      "We'll switch to Sonnet once the payment goes through.",
    );
    // The shared checkout step: neutral with a clock, never a spinner.
    expect(notice?.dataset.noticeIntent).toBe('neutral');
    expect(query('model-unlock-pending-spinner')).toBeNull();
    expect(query('model-unlock-pending-dismiss')).toBeNull();
  });

  it('uses the generic copy for an unregistered model', () => {
    pendingIntent('req-1', { modelId: 'not-a-registered-model' });
    render('chat-a');

    const copy = query('model-unlock-pending-notice')?.textContent ?? '';
    expect(copy).toContain("We'll unlock advanced models");
    expect(copy).not.toContain('not-a-registered-model');
  });

  it('switches to the timed-out notice, whose Dismiss clears only that purchase', () => {
    pendingIntent('req-1');
    render('chat-a');
    act(() => useModelUnlockIntentStore.setState({ phase: 'timed-out' }));

    expect(query('model-unlock-pending-notice')?.dataset.phase).toBe(
      'timed-out',
    );
    expect(query('model-unlock-pending-spinner')).toBeNull();
    click('model-unlock-pending-dismiss');

    expect(useModelUnlockIntentStore.getState().intent).toBeNull();
    expect(query('model-unlock-pending-notice')).toBeNull();
  });

  it.each(['applying', 'unlocked', 'apply-failed'] as const)(
    'hides once the purchase is %s',
    (phase) => {
      pendingIntent('req-1');
      render('chat-a');
      act(() => useModelUnlockIntentStore.setState({ phase }));
      expect(query('model-unlock-pending-notice')).toBeNull();
    },
  );

  it('checks once per press and stays up after a failed read', async () => {
    pendingIntent('req-1');
    render('chat-a');
    const settle = deferredCheck();

    click('model-unlock-pending-check-now');
    click('model-unlock-pending-check-now');
    expect(checkNow).toHaveBeenCalledTimes(1);
    const busy = query('model-unlock-pending-check-now');
    expect(busy?.getAttribute('aria-busy')).toBe('true');
    expect(busy?.textContent).toBe('Checking…');

    act(() => settle('failed'));
    await flush();

    expect(query('model-unlock-pending-notice')?.dataset.phase).toBe('waiting');
    const ready = query('model-unlock-pending-check-now');
    expect(ready?.hasAttribute('disabled')).toBe(false);
    expect(ready?.textContent).toBe('Check again');
  });

  it('clears busy state even when the check rejects', async () => {
    pendingIntent('req-1');
    render('chat-a');
    checkNow.mockRejectedValueOnce(new Error('offline'));

    click('model-unlock-pending-check-now');
    await flush();

    expect(
      query('model-unlock-pending-check-now')?.hasAttribute('disabled'),
    ).toBe(false);
  });

  it('joins an existing check across timeout and applies the original model once', async () => {
    jest.useFakeTimers();
    const actual: typeof ModelUnlockIntentModule = jest.requireActual(
      '@/lib/modelUnlockIntent',
    );
    checkNow.mockImplementation(actual.checkModelUnlockNow);
    let resolveRead: ((read: ModelLibraryAccessRead) => void) | undefined;
    const refreshAccess = jest.fn(
      () =>
        new Promise<ModelLibraryAccessRead>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const apply = jest.fn().mockResolvedValue(true);
    beginModelUnlockIntent(
      {
        requestId: 'req-1',
        accountId: 'account:acct_1',
        owner: 'personal',
        chatId: 'chat-a',
        modelId: 'sonnet',
        startedAt:
          Date.now() - MODEL_UNLOCK_POLL_MAX_MS + MODEL_UNLOCK_POLL_INTERVAL_MS,
      },
      { refreshAccess, apply },
    );
    const stop = runModelUnlockPolling('req-1');
    try {
      const inFlight = actual.checkModelUnlockNow();
      handleBillingReturnLink({ requestId: 'req-1' });
      render('chat-a');
      click('model-unlock-pending-check-now');
      expect(refreshAccess).toHaveBeenCalledTimes(1);

      await act(async () =>
        jest.advanceTimersByTimeAsync(MODEL_UNLOCK_POLL_INTERVAL_MS),
      );
      expect(query('model-unlock-pending-notice')?.dataset.phase).toBe(
        'timed-out',
      );
      expect(query('model-unlock-pending-spinner')).toBeNull();
      expect(
        query('model-unlock-pending-check-now')?.getAttribute('aria-busy'),
      ).toBe('true');
      expect(refreshAccess).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveRead?.({
          accountKey: 'account:acct_1',
          ownerKey: 'personal',
          authoritative: true,
          access: 'unlocked',
        });
        await inFlight;
      });
      await flush();
      expect(apply).toHaveBeenCalledTimes(1);
      expect(query('model-unlock-pending-notice')).toBeNull();
      await act(async () =>
        jest.advanceTimersByTimeAsync(MODEL_UNLOCK_POLL_INTERVAL_MS * 2),
      );
      expect(refreshAccess).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      jest.useRealTimers();
    }
  });

  it('ignores a stale Check now after the request is replaced', () => {
    pendingIntent('req-1');
    render('chat-a');
    const check = query('model-unlock-pending-check-now');
    act(() => {
      pendingIntent('req-2');
      check?.click();
    });
    expect(checkNow).not.toHaveBeenCalled();
    expect(useModelUnlockIntentStore.getState().intent?.requestId).toBe(
      'req-2',
    );
  });

  it('keeps a replacement purchase out of an older check', async () => {
    pendingIntent('req-1');
    render('chat-a');
    const settleOld = deferredCheck();
    click('model-unlock-pending-check-now');

    // A new purchase replaces the one being checked.
    act(() => pendingIntent('req-2'));
    const fresh = query('model-unlock-pending-check-now');
    expect(fresh?.hasAttribute('disabled')).toBe(false);

    const settleNew = deferredCheck();
    click('model-unlock-pending-check-now');
    expect(checkNow).toHaveBeenCalledTimes(2);

    // The old check settles last: it must not clear the new one's busy state.
    act(() => settleOld('pending'));
    await flush();
    expect(
      query('model-unlock-pending-check-now')?.getAttribute('aria-busy'),
    ).toBe('true');

    act(() => settleNew('pending'));
    await flush();
    expect(
      query('model-unlock-pending-check-now')?.hasAttribute('disabled'),
    ).toBe(false);
  });

  it('hides when the purchase is cleared during a check', async () => {
    pendingIntent('req-1');
    render('chat-a');
    const settle = deferredCheck();
    click('model-unlock-pending-check-now');

    act(() => resetModelUnlockIntentForTests());
    expect(query('model-unlock-pending-notice')).toBeNull();

    act(() => settle('pending'));
    await flush();
    expect(query('model-unlock-pending-notice')).toBeNull();
  });

  it('never clears a newer purchase from a stale Dismiss', () => {
    pendingIntent('req-1');
    render('chat-a');
    act(() => useModelUnlockIntentStore.setState({ phase: 'timed-out' }));
    const dismiss = query('model-unlock-pending-dismiss');

    // A newer purchase lands before the click is handled.
    act(() => {
      pendingIntent('req-2');
      dismiss?.click();
    });

    expect(useModelUnlockIntentStore.getState().intent?.requestId).toBe(
      'req-2',
    );
    expect(query('model-unlock-pending-notice')?.dataset.phase).toBe('waiting');
  });

  it('returns when the originating chat is shown again', () => {
    pendingIntent('req-1');
    render('chat-b');
    expect(query('model-unlock-pending-notice')).toBeNull();

    render('chat-a');
    expect(query('model-unlock-pending-notice')).not.toBeNull();
  });
});
