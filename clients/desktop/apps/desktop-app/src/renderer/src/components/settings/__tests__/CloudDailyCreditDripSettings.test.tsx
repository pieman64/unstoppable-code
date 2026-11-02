/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { CloudDailyCreditDripState } from '@canopy/desktop-shared/types';
import type { DailyCreditDripPreferenceSaveResult } from '@canopy/protocol/billing';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { CloudDailyCreditDripSettings } from '../CloudDailyCreditDripSettings';

const mockRefresh = jest.fn();
jest.mock('@/lib/ai-credits-refresh', () => ({
  refreshAiCreditsAfterDripChange: (): unknown => mockRefresh(),
}));

const loadCloudDailyCreditDrip = jest.fn<
  Promise<CloudDailyCreditDripState>,
  []
>();
const saveCloudDailyCreditDrip = jest.fn<
  Promise<DailyCreditDripPreferenceSaveResult>,
  [{ enabled: boolean }]
>();

let container: HTMLElement;
let root: Root;

function state(
  enabled: boolean,
  overrides: Partial<CloudDailyCreditDripState> = {},
): CloudDailyCreditDripState {
  return {
    available: true,
    resolved: true,
    preference: {
      enabled,
      decidedAt: '2026-10-01T00:00:00.000Z',
      capCredits: 10,
    },
    ...overrides,
  };
}

function saved(enabled: boolean): DailyCreditDripPreferenceSaveResult {
  return {
    enabled,
    decidedAt: '2026-10-06T19:00:00.000Z',
    capCredits: 10,
    balanceCredits: enabled ? 10 : 0,
    granted: enabled ? 10 : 0,
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(<CloudDailyCreditDripSettings />);
    await Promise.resolve();
  });
  await flush();
}

function query(testId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function toggle(): HTMLElement {
  const node = query('settings-daily-credit-drip-toggle');
  if (!node) throw new Error('Missing daily credit drip toggle');
  return node;
}

beforeEach(() => {
  loadCloudDailyCreditDrip.mockReset();
  saveCloudDailyCreditDrip.mockReset();
  mockRefresh.mockReset();
  mockRefresh.mockResolvedValue({
    eligible: true,
    loading: false,
    inconclusive: false,
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
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

describe('CloudDailyCreditDripSettings', () => {
  it('renders the saved state with the plan cap', async () => {
    loadCloudDailyCreditDrip.mockResolvedValue(state(false));
    await render();

    const section = query('settings-daily-credit-drip')?.textContent;
    expect(section).toContain('Free daily AI Credits');
    expect(section).not.toContain('Daily free AI Credits');
    expect(section).toContain('Get 10 free AI Credits every day.');
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(toggle().getAttribute('aria-label')).toBe('Free daily AI Credits');
  });

  it.each([
    ['unavailable', { available: false }],
    ['unresolved', { resolved: false }],
  ])('renders nothing when the state is %s', async (_label, overrides) => {
    loadCloudDailyCreditDrip.mockResolvedValue(state(false, overrides));
    await render();
    expect(query('settings-daily-credit-drip')).toBeNull();
  });

  it('saves optimistically and refreshes the AI Credits caches', async () => {
    loadCloudDailyCreditDrip.mockResolvedValue(state(false));
    let resolveSave: (
      value: DailyCreditDripPreferenceSaveResult,
    ) => void = () => undefined;
    saveCloudDailyCreditDrip.mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    await render();

    act(() => toggle().click());
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(toggle().hasAttribute('disabled')).toBe(true);
    expect(saveCloudDailyCreditDrip).toHaveBeenCalledWith({ enabled: true });

    await act(async () => {
      resolveSave(saved(true));
      await Promise.resolve();
    });
    await flush();

    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(toggle().hasAttribute('disabled')).toBe(false);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(query('settings-daily-credit-drip-error')).toBeNull();
  });

  it('rolls back with an inline notice when the save fails', async () => {
    loadCloudDailyCreditDrip.mockResolvedValue(state(true));
    saveCloudDailyCreditDrip.mockRejectedValue(new Error('offline'));
    await render();

    act(() => toggle().click());
    await flush();

    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(query('settings-daily-credit-drip-error')?.textContent).toContain(
      "Couldn't save. Try again.",
    );
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('re-reads on a cloud account change', async () => {
    loadCloudDailyCreditDrip.mockResolvedValue(
      state(false, { available: false }),
    );
    await render();
    expect(query('settings-daily-credit-drip')).toBeNull();

    loadCloudDailyCreditDrip.mockResolvedValue(state(true));
    act(() => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    });
    await flush();

    expect(loadCloudDailyCreditDrip).toHaveBeenCalledTimes(2);
    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });

  it('reports the settings.dailyCreditDrip current-UI-state slice', async () => {
    loadCloudDailyCreditDrip.mockResolvedValue(state(true));
    await render();
    expect(
      useCurrentUiStateStore.getState().slices['settings.dailyCreditDrip'],
    ).toEqual({ loaded: true, available: true, enabled: true, decided: true });
  });
});
