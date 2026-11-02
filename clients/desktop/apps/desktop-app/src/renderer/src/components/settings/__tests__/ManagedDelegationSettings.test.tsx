/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PreferencesSaveResult } from '@canopy/desktop-shared/types';
import { MAX_MANAGED_DELEGATION_CONCURRENCY } from '@canopy/protocol/delegation/discovery';
import * as delegationDiscovery from '@canopy/protocol/delegation/discovery';
import { makeTestPreferences } from '@/test-utils/preferences';
import { ManagedDelegationSettings } from '../ManagedDelegationSettings';
import {
  emitManagedDelegationPreferenceUpdated,
  subscribeManagedDelegationPreferenceUpdated,
} from '@/lib/managedDelegationPreferenceEvents';
import {
  querySettingsSelect,
  querySettingsSelects,
  type SettingsSelectProbe,
} from '@canopy/ui-app/settings/__tests__/helpers/settings-select';

const reportUiState = jest.fn();
jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (
    key: string,
    value: Record<string, unknown>,
  ): void => {
    reportUiState(key, value);
  },
}));

describe('ManagedDelegationSettings', () => {
  let container: HTMLElement;
  let root: Root;
  let originalApiDescriptor: PropertyDescriptor | undefined;
  let originalPlatformDescriptor: PropertyDescriptor | undefined;
  const savePreferences = jest.fn();
  let preferencesSynced:
    | ((preferences: PreferencesSaveResult) => void)
    | undefined;

  beforeEach(() => {
    originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
    originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
      window,
      'platform',
    );
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'darwin',
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        savePreferences,
        onPreferencesSynced: jest.fn(
          (callback: (preferences: PreferencesSaveResult) => void) => {
            preferencesSynced = callback;
            return jest.fn();
          },
        ),
      },
    });
    savePreferences.mockReset();
    reportUiState.mockClear();
    preferencesSynced = undefined;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (originalApiDescriptor)
      Object.defineProperty(window, 'api', originalApiDescriptor);
    else Reflect.deleteProperty(window, 'api');
    if (originalPlatformDescriptor)
      Object.defineProperty(window, 'platform', originalPlatformDescriptor);
    else Reflect.deleteProperty(window, 'platform');
    jest.restoreAllMocks();
  });

  function useHigherTestCap(): void {
    const normalize =
      delegationDiscovery.normalizeManagedDelegationLifetimeLimit;
    jest
      .spyOn(delegationDiscovery, 'managedDelegationLifetimeLimitChoices')
      .mockReturnValue([512, 1024, 2048]);
    jest
      .spyOn(delegationDiscovery, 'normalizeManagedDelegationLifetimeLimit')
      .mockImplementation((value) => normalize(value, 2048));
  }

  const lifetimeSelect = (): SettingsSelectProbe | null =>
    querySettingsSelect(
      container,
      '[data-testid="settings-managed-delegation-lifetime-limit"]',
    );

  it('shows the shipped lifetime limit as one disabled choice with honest help', () => {
    act(() => root.render(<ManagedDelegationSettings initialMode="off" />));
    expect(container.textContent).toContain('Lifetime limit');
    const lifetime = lifetimeSelect();
    expect(lifetime?.value).toBe('512');
    expect(lifetime?.disabled).toBe(true);
    // A disabled dropdown cannot open: its one choice is the label it shows.
    expect(lifetime?.trigger.textContent).toBe('512');
    expect(
      container.querySelector(
        '[data-testid="settings-managed-delegation-lifetime-limit-help"]',
      )?.textContent,
    ).toBe(
      'Managed delegates a worktree can start over its lifetime, separate from how many run at once. This build allows only 512.',
    );
  });

  it('reports the normalized lifetime limit to App Advisor without a setter', () => {
    act(() =>
      root.render(
        <ManagedDelegationSettings
          initialMode="off"
          initialLifetimeLimit={999}
        />,
      ),
    );
    expect(reportUiState).toHaveBeenLastCalledWith(
      'settings.managedDelegation',
      expect.objectContaining({ lifetimeLimit: 512 }),
    );
  });

  it('uses cap-filtered choices and saves and emits the returned higher lifetime value', async () => {
    useHigherTestCap();
    act(() =>
      root.render(
        <ManagedDelegationSettings
          initialMode="proactive"
          initialLifetimeLimit={512}
        />,
      ),
    );
    const lifetime = lifetimeSelect();
    expect(
      Array.from(lifetime?.options ?? [], (option) => option.value),
    ).toEqual(['512', '1024', '2048']);
    if (!lifetime) return;
    expect(lifetime.disabled).toBe(false);
    expect(container.textContent).not.toContain('This build allows only');
    savePreferences.mockResolvedValue(
      makeTestPreferences({
        managedDelegationMode: 'proactive',
        managedDelegationLifetimeLimit: 1024,
      }),
    );
    const received = jest.fn();
    const unsubscribe = subscribeManagedDelegationPreferenceUpdated(received);
    try {
      lifetime.choose('2048');
      await act(async () => {
        await Promise.resolve();
      });
      expect(savePreferences).toHaveBeenCalledWith({
        managedDelegationLifetimeLimit: 2048,
      });
      expect(lifetime.value).toBe('1024');
      expect(received).toHaveBeenLastCalledWith(
        expect.objectContaining({ lifetimeLimit: 1024 }),
      );
    } finally {
      unsubscribe();
    }
  });

  it('synchronizes external lifetime preferences', () => {
    useHigherTestCap();
    act(() =>
      root.render(
        <ManagedDelegationSettings
          initialMode="off"
          initialLifetimeLimit={512}
        />,
      ),
    );
    act(() =>
      preferencesSynced?.(
        makeTestPreferences({ managedDelegationLifetimeLimit: 2048 }),
      ),
    );
    expect(lifetimeSelect()?.value).toBe('2048');
    act(() =>
      preferencesSynced?.(
        makeTestPreferences({ managedDelegationLifetimeLimit: 999 }),
      ),
    );
    expect(lifetimeSelect()?.value).toBe('1024');
  });

  it('applies valid local lifetime events and ignores invalid ones', () => {
    useHigherTestCap();
    act(() =>
      root.render(
        <ManagedDelegationSettings
          initialMode="off"
          initialLifetimeLimit={512}
        />,
      ),
    );
    act(() =>
      emitManagedDelegationPreferenceUpdated({
        mode: 'off',
        revocationIncomplete: false,
        lifetimeLimit: 2048,
      }),
    );
    expect(lifetimeSelect()?.value).toBe('2048');
    act(() =>
      emitManagedDelegationPreferenceUpdated({
        mode: 'off',
        revocationIncomplete: false,
        lifetimeLimit: 999,
      }),
    );
    expect(lifetimeSelect()?.value).toBe('2048');
  });

  it('preserves an incomplete shutdown warning when settings remount', () => {
    act(() => {
      root.render(
        <ManagedDelegationSettings
          initialMode="off"
          initialRevocationIncomplete
        />,
      );
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'some child sessions could not be stopped',
    );
    expect(reportUiState).toHaveBeenLastCalledWith(
      'settings.managedDelegation',
      {
        loaded: true,
        mode: 'off',
        maxDepth: 1,
        lifetimeLimit: 512,
        revocationIncomplete: true,
      },
    );
  });

  it('defaults depth to one, saves ten, and follows external preference changes', async () => {
    act(() =>
      root.render(<ManagedDelegationSettings initialMode="proactive" />),
    );
    const depth = querySettingsSelect(
      container,
      '[data-testid="settings-managed-delegation-depth"]',
    );
    expect(depth?.value).toBe('1');
    if (!depth) throw new Error('Expected depth selector');
    expect(depth.options.length).toBe(10);
    expect(reportUiState).toHaveBeenLastCalledWith(
      'settings.managedDelegation',
      expect.objectContaining({ maxDepth: 1 }),
    );
    savePreferences.mockResolvedValue({
      ...makeTestPreferences(),
      managedDelegationMaxDepth: 10,
    });
    await act(async () => {
      await Promise.resolve();
    });
    depth.choose('10');
    await act(async () => {
      await Promise.resolve();
    });
    expect(savePreferences).toHaveBeenCalledWith({
      managedDelegationMaxDepth: 10,
    });
    expect(depth.value).toBe('10');
    act(() =>
      preferencesSynced?.({
        ...makeTestPreferences(),
        managedDelegationMaxDepth: 2,
      }),
    );
    expect(depth.value).toBe('2');
  });

  it('offers every concurrency value up to the app limit and says extra tasks queue', () => {
    act(() =>
      root.render(<ManagedDelegationSettings initialMode="proactive" />),
    );
    const concurrency = querySettingsSelect(
      container,
      '[data-testid="settings-managed-delegation-concurrency"]',
    );
    if (!concurrency) throw new Error('Expected concurrency selector');
    expect(concurrency.options.length).toBe(MAX_MANAGED_DELEGATION_CONCURRENCY);
    const help = container.querySelector(
      '[data-testid="settings-managed-delegation-concurrency-help"]',
    );
    expect(help?.textContent).toContain(
      'Tasks over the limit wait their turn and start automatically.',
    );
    expect(help?.textContent).toContain(
      `The application-wide limit is ${MAX_MANAGED_DELEGATION_CONCURRENCY}.`,
    );
    expect(help?.textContent).not.toContain('limit is 16.');
  });

  const windowsNote = (): HTMLElement | null =>
    container.querySelector(
      '[data-testid="settings-managed-delegation-windows-codex"]',
    );

  it('enables managed delegation on Windows and says Codex tasks run unsandboxed', () => {
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'win32',
    });
    act(() => {
      root.render(<ManagedDelegationSettings initialMode="off" />);
    });

    const selects = Array.from(querySettingsSelects(container));
    expect(selects.length).toBeGreaterThan(0);
    expect(
      selects
        .filter((select) => select.trigger !== lifetimeSelect()?.trigger)
        .every((select) => !select.disabled),
    ).toBe(true);
    expect(lifetimeSelect()?.disabled).toBe(true);
    expect(windowsNote()?.textContent).toBe(
      "On Windows, Codex tasks run without the Codex sandbox and follow this chat's approval settings.",
    );
  });

  it.each(['darwin', 'linux'])(
    'enables Code worktree delegation controls on %s without opting in',
    (platform) => {
      Object.defineProperty(window, 'platform', {
        configurable: true,
        value: platform,
      });
      act(() => root.render(<ManagedDelegationSettings initialMode="off" />));
      const selects = Array.from(querySettingsSelects(container));
      expect(selects.length).toBeGreaterThan(0);
      expect(
        selects
          .filter((select) => select.trigger !== lifetimeSelect()?.trigger)
          .every((select) => !select.disabled),
      ).toBe(true);
      expect(lifetimeSelect()?.disabled).toBe(true);
      expect(selects[0].value).toBe('off');
      expect(container.textContent).toContain('Code worktree chats');
      expect(windowsNote()).toBeNull();
      expect(savePreferences).not.toHaveBeenCalled();
    },
  );

  it('keeps managed delegation unavailable on unsupported platforms', () => {
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'freebsd',
    });
    act(() => {
      root.render(<ManagedDelegationSettings initialMode="off" />);
    });

    const selects = Array.from(querySettingsSelects(container));
    expect(selects.every((select) => select.disabled)).toBe(true);
    expect(container.textContent).toContain(
      'Managed delegation is currently available on macOS, Windows, and Linux.',
    );
    expect(windowsNote()).toBeNull();
  });

  it('warns and retries when turning consultation off cannot stop every child', async () => {
    savePreferences
      .mockResolvedValueOnce({
        ...makeTestPreferences({ managedDelegationMode: 'off' }),
        __managedDelegationRevocationIncomplete: true,
      })
      .mockResolvedValueOnce(
        makeTestPreferences({ managedDelegationMode: 'off' }),
      );
    act(() => {
      root.render(<ManagedDelegationSettings initialMode="proactive" />);
    });
    const select = querySettingsSelects(container)[0] ?? null;
    if (!select) throw new Error('Expected consultation select');
    // The shared settings dropdown: the 28px secondary capsule.
    expect(select.trigger.classList.contains('rounded-full')).toBe(true);
    expect(select.trigger.classList.contains('h-7')).toBe(true);

    select.choose('off');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(select.value).toBe('off');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'some child sessions could not be stopped',
    );
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Retry shutdown',
    );
    if (!retry) throw new Error('Expected retry shutdown button');
    // The shared secondary button draws its outline with a ring, because a
    // `border-<color>` utility never paints over the base border rule.
    expect(retry.classList.contains('ring-line-secondary')).toBe(true);
    expect(retry.classList.contains('border-border')).toBe(false);
    await act(async () => {
      retry.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(savePreferences).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('reflects preference changes saved through App Advisor', () => {
    act(() => {
      root.render(<ManagedDelegationSettings initialMode="off" />);
    });
    if (!preferencesSynced) throw new Error('Expected preferences listener');
    act(() => {
      preferencesSynced?.(
        makeTestPreferences({ managedDelegationMode: 'explicit-only' }),
      );
    });
    expect((querySettingsSelects(container)[0] ?? null)?.value).toBe(
      'explicit-only',
    );
    act(() => {
      emitManagedDelegationPreferenceUpdated({
        mode: 'proactive',
        revocationIncomplete: false,
      });
    });

    expect((querySettingsSelects(container)[0] ?? null)?.value).toBe(
      'proactive',
    );
    expect(reportUiState).toHaveBeenLastCalledWith(
      'settings.managedDelegation',
      {
        loaded: true,
        mode: 'proactive',
        maxDepth: 1,
        lifetimeLimit: 512,
        revocationIncomplete: false,
      },
    );
  });

  it('preserves the effective fallback and synchronizes revocation status', () => {
    act(() => {
      root.render(<ManagedDelegationSettings initialMode="explicit-only" />);
    });
    if (!preferencesSynced) throw new Error('Expected preferences listener');

    act(() => {
      preferencesSynced?.({
        ...makeTestPreferences({ managedDelegationMode: undefined }),
        __managedDelegationRevocationIncomplete: true,
      });
    });

    expect((querySettingsSelects(container)[0] ?? null)?.value).toBe(
      'explicit-only',
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'some child sessions could not be stopped',
    );
  });
});
