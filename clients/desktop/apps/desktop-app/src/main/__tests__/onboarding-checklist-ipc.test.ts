const mockComputeState = jest.fn<Promise<unknown>, []>();
const mockLatchItemComplete = jest.fn<Promise<unknown>, [string]>();
const mockSetDismissedAt = jest.fn<Promise<unknown>, [string | null]>();
const mockSetSnoozedUntil = jest.fn<Promise<unknown>, [string | null]>();
const mockSetProviderNotUsed = jest.fn<Promise<unknown>, [string, boolean]>();
const mockSendToAllWindows = jest.fn<void, [string, ...unknown[]]>();
const mockRegisterIpcHandler = jest.fn<void, unknown[]>();
const mockSubscribeAccountChanges = jest.fn<() => void, [unknown]>();

jest.mock('../lib/onboarding-checklist-progress', () => ({
  computeOnboardingChecklistState: (): Promise<unknown> => mockComputeState(),
}));
jest.mock('../lib/onboarding-checklist-state', () => ({
  latchOnboardingChecklistItemComplete: (itemId: string): Promise<unknown> =>
    mockLatchItemComplete(itemId),
  setOnboardingChecklistDismissedAt: (value: string | null): Promise<unknown> =>
    mockSetDismissedAt(value),
  setOnboardingChecklistSnoozedUntil: (
    value: string | null,
  ): Promise<unknown> => mockSetSnoozedUntil(value),
  setOnboardingChecklistProviderNotUsed: (
    provider: string,
    notUsed: boolean,
  ): Promise<unknown> => mockSetProviderNotUsed(provider, notUsed),
}));
jest.mock('../lib/window-send', () => ({
  sendToAllWindows: (channel: string, ...args: unknown[]): void =>
    mockSendToAllWindows(channel, ...args),
}));
jest.mock('../ipc/register', () => ({
  registerIpcHandler: (...args: unknown[]): void => {
    mockRegisterIpcHandler(...args);
  },
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  subscribeCanopyCloudAccountChanges: (listener: unknown): (() => void) =>
    mockSubscribeAccountChanges(listener),
}));

import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  handleDismissOnboardingChecklist,
  handleGetOnboardingChecklistState,
  handleMarkOnboardingChecklistItemComplete,
  handleRestoreOnboardingChecklist,
  handleSetOnboardingChecklistProviderNotUsed,
  handleSnoozeOnboardingChecklist,
  notifyOnboardingChecklistChatStarted,
  registerOnboardingChecklistHandlers,
} from '../ipc/onboarding-checklist';

const SNAPSHOT = {
  items: [],
  dismissedAt: null,
  snoozedUntil: null,
  providersNotUsed: [],
};

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockComputeState.mockResolvedValue(SNAPSHOT);
  mockLatchItemComplete.mockResolvedValue({ state: SNAPSHOT, changed: true });
  mockSetDismissedAt.mockResolvedValue({ state: SNAPSHOT, changed: true });
  mockSetSnoozedUntil.mockResolvedValue({ state: SNAPSHOT, changed: true });
  mockSetProviderNotUsed.mockResolvedValue({ state: SNAPSHOT, changed: true });
});

describe('handleGetOnboardingChecklistState', () => {
  it('returns the computed snapshot without broadcasting', async () => {
    const state = await handleGetOnboardingChecklistState();
    expect(state).toBe(SNAPSHOT);
    expect(mockSendToAllWindows).not.toHaveBeenCalled();
  });
});

describe('handleDismissOnboardingChecklist', () => {
  it('persists an ISO dismissal timestamp and broadcasts the fresh snapshot', async () => {
    const state = await handleDismissOnboardingChecklist();
    expect(mockSetDismissedAt).toHaveBeenCalledTimes(1);
    const [stamp] = mockSetDismissedAt.mock.calls[0];
    expect(typeof stamp).toBe('string');
    expect(Number.isNaN(Date.parse(stamp as string))).toBe(false);
    expect(mockSendToAllWindows).toHaveBeenCalledWith(
      IPC_CHANNELS.onboardingChecklistChanged,
      SNAPSHOT,
    );
    expect(state).toBe(SNAPSHOT);
  });
});

describe('handleSnoozeOnboardingChecklist', () => {
  it('persists a valid snooze deadline', async () => {
    await handleSnoozeOnboardingChecklist({
      until: '2026-09-01T00:00:00.000Z',
    });
    expect(mockSetSnoozedUntil).toHaveBeenCalledWith(
      '2026-09-01T00:00:00.000Z',
    );
    expect(mockSendToAllWindows).toHaveBeenCalledWith(
      IPC_CHANNELS.onboardingChecklistChanged,
      SNAPSHOT,
    );
  });

  it('rejects an unparseable deadline', async () => {
    await expect(
      handleSnoozeOnboardingChecklist({ until: 'not-a-date' }),
    ).rejects.toThrow('snooze');
    expect(mockSetSnoozedUntil).not.toHaveBeenCalled();
  });
});

describe('handleRestoreOnboardingChecklist', () => {
  it('clears both dismissal and snooze', async () => {
    await handleRestoreOnboardingChecklist();
    expect(mockSetDismissedAt).toHaveBeenCalledWith(null);
    expect(mockSetSnoozedUntil).toHaveBeenCalledWith(null);
  });
});

describe('handleSetOnboardingChecklistProviderNotUsed', () => {
  it('persists a valid provider mark', async () => {
    await handleSetOnboardingChecklistProviderNotUsed({
      provider: 'linear',
      notUsed: true,
    });
    expect(mockSetProviderNotUsed).toHaveBeenCalledWith('linear', true);
  });

  it('rejects an unknown provider', async () => {
    await expect(
      handleSetOnboardingChecklistProviderNotUsed({
        // Renderer payloads are untrusted at this boundary.
        provider: 'gitlab' as never,
        notUsed: true,
      }),
    ).rejects.toThrow('provider');
    expect(mockSetProviderNotUsed).not.toHaveBeenCalled();
  });
});

describe('handleMarkOnboardingChecklistItemComplete', () => {
  it('latches the renderer-derived connect-accounts item', async () => {
    await handleMarkOnboardingChecklistItemComplete({
      itemId: 'connect-accounts',
    });
    expect(mockLatchItemComplete).toHaveBeenCalledWith('connect-accounts');
  });

  it('rejects main-derived items', async () => {
    await expect(
      handleMarkOnboardingChecklistItemComplete({ itemId: 'start-chat' }),
    ).rejects.toThrow('connect-accounts');
    expect(mockLatchItemComplete).not.toHaveBeenCalled();
  });
});

describe('registerOnboardingChecklistHandlers', () => {
  it('registers every checklist channel', () => {
    registerOnboardingChecklistHandlers();
    const channels = mockRegisterIpcHandler.mock.calls.map(
      (call) => call[0] as string,
    );
    expect(channels).toEqual(
      expect.arrayContaining([
        IPC_CHANNELS.onboardingChecklistGetState,
        IPC_CHANNELS.onboardingChecklistDismiss,
        IPC_CHANNELS.onboardingChecklistSnooze,
        IPC_CHANNELS.onboardingChecklistRestore,
        IPC_CHANNELS.onboardingChecklistSetProviderNotUsed,
        IPC_CHANNELS.onboardingChecklistMarkItemComplete,
      ]),
    );
  });

  it('re-derives and broadcasts when the cloud account changes', async () => {
    registerOnboardingChecklistHandlers();
    expect(mockSubscribeAccountChanges).toHaveBeenCalledTimes(1);
    const listener = mockSubscribeAccountChanges.mock.calls[0][0] as (
      entry: unknown,
    ) => void;
    // Sign-in and sign-out both change whether a real (non-guest) account
    // exists, and neither goes through a checklist mutation.
    listener({ authMode: 'oauth', credentialSource: 'oauth_desktop' });
    await flushAsync();
    expect(mockSendToAllWindows).toHaveBeenCalledWith(
      IPC_CHANNELS.onboardingChecklistChanged,
      SNAPSHOT,
    );
  });

  // Review follow-up: the account store notifies on EVERY persist, including
  // the 20-minute org-enforced-settings re-probe. Re-deriving on each would
  // run a full skills-lock + marketplace-cache read and broadcast to every
  // window, forever, for users who finished the checklist long ago.
  it('ignores account persists that do not change real-account status', async () => {
    registerOnboardingChecklistHandlers();
    const listener = mockSubscribeAccountChanges.mock.calls[0][0] as (
      entry: unknown,
    ) => void;
    const guest = { authMode: 'guest', credentialSource: 'guest' };
    listener(guest);
    await flushAsync();
    mockSendToAllWindows.mockClear();

    // Same guest identity re-persisted (capability refresh, org re-probe).
    listener({ ...guest });
    listener({ ...guest });
    await flushAsync();
    expect(mockSendToAllWindows).not.toHaveBeenCalled();
  });

  it('broadcasts when a guest upgrades to a real account', async () => {
    registerOnboardingChecklistHandlers();
    const listener = mockSubscribeAccountChanges.mock.calls[0][0] as (
      entry: unknown,
    ) => void;
    listener({ authMode: 'guest', credentialSource: 'guest' });
    await flushAsync();
    mockSendToAllWindows.mockClear();

    listener({ authMode: 'oauth', credentialSource: 'oauth_desktop' });
    await flushAsync();
    expect(mockSendToAllWindows).toHaveBeenCalledWith(
      IPC_CHANNELS.onboardingChecklistChanged,
      SNAPSHOT,
    );
  });

  // The first event must still broadcast: seeding from it would swallow the
  // case where that first event IS the sign-in.
  it('broadcasts on a first observation that is already a real account', async () => {
    registerOnboardingChecklistHandlers();
    const listener = mockSubscribeAccountChanges.mock.calls[0][0] as (
      entry: unknown,
    ) => void;
    listener({ authMode: 'oauth', credentialSource: 'oauth_desktop' });
    await flushAsync();
    expect(mockSendToAllWindows).toHaveBeenCalledWith(
      IPC_CHANNELS.onboardingChecklistChanged,
      SNAPSHOT,
    );
  });

  // The gate must be atomic with respect to the OBSERVATION, not the
  // broadcast. Deferring the assignment until the broadcast resolved let two
  // same-value events that arrive while the first is still in flight both pass
  // the gate — each starting a full skills-lock + marketplace-cache read and
  // an all-windows broadcast for one logical transition.
  it('gates a second same-value event while the first broadcast is in flight', async () => {
    registerOnboardingChecklistHandlers();
    const listener = mockSubscribeAccountChanges.mock.calls[0][0] as (
      entry: unknown,
    ) => void;
    const real = { authMode: 'oauth', credentialSource: 'oauth_desktop' };

    let releaseBroadcast: (() => void) | null = null;
    mockComputeState.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseBroadcast = (): void => resolve(SNAPSHOT);
        }),
    );

    listener(real);
    // Second persist lands before the first broadcast has settled.
    listener({ ...real });
    expect(mockComputeState).toHaveBeenCalledTimes(1);

    let release: (() => void) | null = releaseBroadcast;
    while (release === null) {
      await Promise.resolve();
      release = releaseBroadcast;
    }
    release();
    await flushAsync();
    expect(mockComputeState).toHaveBeenCalledTimes(1);
    expect(mockSendToAllWindows).toHaveBeenCalledTimes(1);
  });

  // Complements the atomicity test above: a rejected broadcast must roll the
  // gate back so the next persist retries, rather than being swallowed.
  it('retries the transition after a failed broadcast', async () => {
    registerOnboardingChecklistHandlers();
    const listener = mockSubscribeAccountChanges.mock.calls[0][0] as (
      entry: unknown,
    ) => void;
    const real = { authMode: 'oauth', credentialSource: 'oauth_desktop' };

    mockComputeState.mockRejectedValueOnce(new Error('disk error'));
    listener(real);
    await flushAsync();
    expect(mockSendToAllWindows).not.toHaveBeenCalled();

    // Same value again: the gate must have rolled back, so this retries.
    listener({ ...real });
    await flushAsync();
    expect(mockSendToAllWindows).toHaveBeenCalledWith(
      IPC_CHANNELS.onboardingChecklistChanged,
      SNAPSHOT,
    );
  });

  it('swallows a broadcast failure on the account-change path', async () => {
    registerOnboardingChecklistHandlers();
    const listener = mockSubscribeAccountChanges.mock.calls[0][0] as (
      entry: unknown,
    ) => void;
    mockComputeState.mockRejectedValue(new Error('disk error'));
    listener(null);
    await flushAsync();
    expect(mockSendToAllWindows).not.toHaveBeenCalled();
  });
});

describe('notifyOnboardingChecklistChatStarted', () => {
  it('latches start-chat and broadcasts the fresh snapshot', async () => {
    notifyOnboardingChecklistChatStarted();
    await flushAsync();
    expect(mockLatchItemComplete).toHaveBeenCalledWith('start-chat');
    expect(mockSendToAllWindows).toHaveBeenCalledWith(
      IPC_CHANNELS.onboardingChecklistChanged,
      SNAPSHOT,
    );
  });

  it('does not re-broadcast when the latch was already set', async () => {
    mockLatchItemComplete.mockResolvedValue({
      state: SNAPSHOT,
      changed: false,
    });
    notifyOnboardingChecklistChatStarted();
    await flushAsync();
    expect(mockLatchItemComplete).toHaveBeenCalledWith('start-chat');
    expect(mockSendToAllWindows).not.toHaveBeenCalled();
  });

  // It runs on the chat send path, so a checklist failure must never surface
  // as an unhandled rejection or block the message.
  it('swallows a latch failure', async () => {
    mockLatchItemComplete.mockRejectedValue(new Error('disk full'));
    expect(() => notifyOnboardingChecklistChatStarted()).not.toThrow();
    await flushAsync();
    expect(mockSendToAllWindows).not.toHaveBeenCalled();
  });
});
