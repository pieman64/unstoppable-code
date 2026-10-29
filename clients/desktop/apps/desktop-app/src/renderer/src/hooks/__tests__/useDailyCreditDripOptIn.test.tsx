/**
 * @jest-environment jsdom
 *
 * Daily free AI Credits opt-in hook: maps the cloud read onto the queue's
 * states, re-reads on a cloud account change, adopts a save made from another
 * surface, and keeps the card undecided when a save fails.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { CloudDailyCreditDripState } from '@canopy/desktop-shared/types';
import { DAILY_CREDIT_DRIP_CHANGED_EVENT } from '@/lib/daily-credit-drip';
import {
  DAILY_CREDIT_DRIP_SAVE_ERROR,
  resetDailyCreditDripOptInCacheForTests,
  useDailyCreditDripOptIn,
  type DailyCreditDripOptInState,
} from '@/hooks/useDailyCreditDripOptIn';

jest.mock('@/lib/ai-credits-refresh', () => ({
  refreshAiCreditsAfterDripChange: (): Promise<unknown> =>
    Promise.resolve({ eligible: true, loading: false, inconclusive: false }),
}));

const loadCloudDailyCreditDrip = jest.fn<
  Promise<CloudDailyCreditDripState>,
  []
>();
const saveCloudDailyCreditDrip = jest.fn();

let container: HTMLDivElement;
let root: Root;
let latest: DailyCreditDripOptInState | null = null;

function Probe(): JSX.Element | null {
  latest = useDailyCreditDripOptIn();
  return null;
}

function current(): DailyCreditDripOptInState {
  if (latest === null) throw new Error('hook not rendered');
  return latest;
}

function cloudState(
  overrides: Partial<CloudDailyCreditDripState> = {},
  decidedAt: string | null = null,
): CloudDailyCreditDripState {
  return {
    available: true,
    resolved: true,
    preference: { enabled: false, decidedAt, capCredits: 25 },
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(Probe));
    await Promise.resolve();
  });
  await flush();
}

beforeEach(() => {
  resetDailyCreditDripOptInCacheForTests();
  latest = null;
  loadCloudDailyCreditDrip.mockReset();
  saveCloudDailyCreditDrip.mockReset();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { loadCloudDailyCreditDrip, saveCloudDailyCreditDrip },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  container.remove();
});

describe('useDailyCreditDripOptIn', () => {
  it('reports undecided, decided, and unavailable from the cloud read', async () => {
    loadCloudDailyCreditDrip.mockResolvedValue(cloudState());
    await mount();
    expect(current().live).toEqual({
      state: 'undecided',
      enabled: false,
      capCredits: 25,
    });

    loadCloudDailyCreditDrip.mockResolvedValue(
      cloudState({}, '2026-10-01T00:00:00.000Z'),
    );
    act(() => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    });
    await flush();
    expect(current().live.state).toBe('decided');
  });

  it.each([
    ['no credential / older server', { available: false }],
    ['a transient failure', { resolved: false }],
  ])('hides the card on %s', async (_label, overrides) => {
    loadCloudDailyCreditDrip.mockResolvedValue(cloudState(overrides));
    await mount();
    expect(current().live.state).toBe('unavailable');
  });

  it('re-reads when the cloud account changes (guest credential arrives)', async () => {
    loadCloudDailyCreditDrip.mockResolvedValue(
      cloudState({ available: false }),
    );
    await mount();
    expect(current().live.state).toBe('unavailable');

    loadCloudDailyCreditDrip.mockResolvedValue(cloudState());
    act(() => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    });
    await flush();
    expect(loadCloudDailyCreditDrip).toHaveBeenCalledTimes(2);
    expect(current().live.state).toBe('undecided');
  });

  it('adopts a choice saved from another surface', async () => {
    loadCloudDailyCreditDrip.mockResolvedValue(cloudState());
    await mount();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(DAILY_CREDIT_DRIP_CHANGED_EVENT, {
          detail: {
            enabled: true,
            decidedAt: '2026-10-06T19:00:00.000Z',
            capCredits: 25,
            balanceCredits: 25,
            granted: 25,
          },
        }),
      );
    });
    expect(current().live).toEqual({
      state: 'decided',
      enabled: true,
      capCredits: 25,
    });
  });

  it.each([true, false])(
    'saves enabled: %s and marks the user decided',
    async (enabled) => {
      loadCloudDailyCreditDrip.mockResolvedValue(cloudState());
      saveCloudDailyCreditDrip.mockResolvedValue({
        enabled,
        decidedAt: '2026-10-06T19:00:00.000Z',
        capCredits: 25,
        balanceCredits: null,
        granted: 0,
      });
      await mount();

      await act(async () => {
        await (enabled ? current().turnOn() : current().notNow());
      });

      expect(saveCloudDailyCreditDrip).toHaveBeenCalledWith({ enabled });
      expect(current().live).toMatchObject({ state: 'decided', enabled });
      expect(current().busy).toBe(false);
      expect(current().error).toBeNull();
    },
  );

  it('drops a save that finishes after the cloud account changed', async () => {
    loadCloudDailyCreditDrip.mockResolvedValue(cloudState());
    let finishSave: (value: unknown) => void = () => undefined;
    saveCloudDailyCreditDrip.mockReturnValue(
      new Promise((resolve) => {
        finishSave = resolve;
      }),
    );
    const broadcasts: unknown[] = [];
    const onBroadcast = (event: Event): void => {
      broadcasts.push(event);
    };
    window.addEventListener(DAILY_CREDIT_DRIP_CHANGED_EVENT, onBroadcast);
    await mount();

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = current().turnOn();
    });
    // The user switches accounts while the old account's save is in flight;
    // the new account has not answered.
    act(() => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    });
    await flush();
    await act(async () => {
      finishSave({
        enabled: true,
        decidedAt: '2026-10-06T19:00:00.000Z',
        capCredits: 25,
        balanceCredits: 25,
        granted: 25,
      });
      await pending;
    });
    window.removeEventListener(DAILY_CREDIT_DRIP_CHANGED_EVENT, onBroadcast);

    expect(broadcasts).toHaveLength(0);
    expect(current().live.state).toBe('undecided');
    expect(current().busy).toBe(false);
  });

  it('stays undecided with an error when the save fails', async () => {
    loadCloudDailyCreditDrip.mockResolvedValue(cloudState());
    saveCloudDailyCreditDrip.mockRejectedValue(new Error('offline'));
    await mount();

    await act(async () => {
      await current().turnOn();
    });

    expect(current().live.state).toBe('undecided');
    expect(current().error).toBe(DAILY_CREDIT_DRIP_SAVE_ERROR);
    expect(current().busy).toBe(false);
  });
});
