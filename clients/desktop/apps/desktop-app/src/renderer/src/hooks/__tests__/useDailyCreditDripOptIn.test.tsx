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
  describe('local save outcome', () => {
    function saved(overrides: Record<string, unknown> = {}): unknown {
      return {
        enabled: true,
        decidedAt: '2026-10-06T19:00:00.000Z',
        capCredits: 25,
        balanceCredits: 12.5,
        granted: 12.5,
        ...overrides,
      };
    }

    it('keeps the grant, balance and blocked reason of its own turn-on', async () => {
      loadCloudDailyCreditDrip.mockResolvedValue(cloudState());
      saveCloudDailyCreditDrip
        .mockResolvedValueOnce(saved())
        .mockResolvedValueOnce(saved({ enabled: false, granted: 0 }))
        .mockResolvedValueOnce(
          saved({ blockedReason: 'network_limit', granted: 3 }),
        );
      await mount();
      expect(current().outcome).toBeNull();

      await act(async () => {
        await current().turnOn();
      });
      expect(current().outcome).toEqual({
        granted: 12.5,
        balanceCredits: 12.5,
      });

      await act(async () => {
        await current().notNow();
      });
      expect(current().outcome).toBeNull();

      await act(async () => {
        await current().turnOn();
      });
      expect(current().outcome).toEqual({
        granted: 3,
        balanceCredits: 12.5,
        blockedReason: 'network_limit',
      });
    });

    it('clears the outcome while a new save runs and when it fails', async () => {
      loadCloudDailyCreditDrip.mockResolvedValue(cloudState());
      saveCloudDailyCreditDrip.mockResolvedValueOnce(saved());
      await mount();
      await act(async () => {
        await current().turnOn();
      });
      expect(current().outcome).not.toBeNull();

      let fail: (error: Error) => void = () => undefined;
      saveCloudDailyCreditDrip.mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
      );
      let pending: Promise<void> = Promise.resolve();
      act(() => {
        pending = current().turnOn();
      });
      expect(current().outcome).toBeNull();
      await act(async () => {
        fail(new Error('offline'));
        await pending;
      });
      expect(current().outcome).toBeNull();
      expect(current().error).toBe(DAILY_CREDIT_DRIP_SAVE_ERROR);
    });

    it('never claims a grant for a turn-on saved elsewhere', async () => {
      loadCloudDailyCreditDrip.mockResolvedValue(cloudState());
      await mount();
      act(() => {
        window.dispatchEvent(
          new CustomEvent(DAILY_CREDIT_DRIP_CHANGED_EVENT, { detail: saved() }),
        );
      });
      expect(current().live.enabled).toBe(true);
      expect(current().outcome).toBeNull();
    });

    it('withdraws the outcome when another surface turns the drip off', async () => {
      loadCloudDailyCreditDrip.mockResolvedValue(cloudState());
      saveCloudDailyCreditDrip.mockResolvedValueOnce(saved());
      await mount();
      await act(async () => {
        await current().turnOn();
      });
      act(() => {
        window.dispatchEvent(
          new CustomEvent(DAILY_CREDIT_DRIP_CHANGED_EVENT, {
            detail: saved({ enabled: false, granted: 0 }),
          }),
        );
      });
      expect(current().outcome).toBeNull();
    });

    it('drops the outcome when the account changes, and ignores a late result', async () => {
      loadCloudDailyCreditDrip.mockResolvedValue(cloudState());
      saveCloudDailyCreditDrip.mockResolvedValueOnce(saved());
      await mount();
      await act(async () => {
        await current().turnOn();
      });
      act(() => {
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
      });
      await flush();
      expect(current().outcome).toBeNull();

      let finish: (value: unknown) => void = () => undefined;
      saveCloudDailyCreditDrip.mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      let pending: Promise<void> = Promise.resolve();
      act(() => {
        pending = current().turnOn();
      });
      act(() => {
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
      });
      await flush();
      await act(async () => {
        finish(saved());
        await pending;
      });
      expect(current().outcome).toBeNull();
    });
  });
});

describe('save supersession', () => {
  it('does not show a previous account save rejection', async () => {
    loadCloudDailyCreditDrip.mockResolvedValue(cloudState());
    await mount();
    let rejectSave: (error: Error) => void = () => {};
    saveCloudDailyCreditDrip.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectSave = reject;
      }),
    );
    let pending = Promise.resolve();
    act(() => {
      pending = current().turnOn();
    });
    act(() => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    });
    await flush();
    await act(async () => {
      rejectSave(new Error('old session'));
      await pending;
    });
    expect(current().error).toBeNull();
    expect(current().outcome).toBeNull();
  });

  it('a newer external disable supersedes a pending local enable', async () => {
    loadCloudDailyCreditDrip.mockResolvedValue(cloudState());
    await mount();
    const disabled = {
      enabled: false,
      decidedAt: '2026-10-24T12:00:00.000Z',
      capCredits: 25,
      granted: 0,
      balanceCredits: 10,
    };
    let resolveSave: (value: unknown) => void = () => {};
    saveCloudDailyCreditDrip.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    let pending = Promise.resolve();
    act(() => {
      pending = current().turnOn();
    });
    act(() => {
      window.dispatchEvent(
        new CustomEvent(DAILY_CREDIT_DRIP_CHANGED_EVENT, { detail: disabled }),
      );
    });
    await act(async () => {
      resolveSave({ ...disabled, enabled: true, granted: 10 });
      await pending;
    });
    expect(current().live.enabled).toBe(false);
    expect(current().outcome).toBeNull();
  });
});
