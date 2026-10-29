/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyApi,
  PreferencesLoadResult,
} from '@canopy/desktop-shared/types';
import {
  useNativeProviderAccounts,
  type NativeProviderAccounts,
} from '../useNativeProviderAccounts';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface Probe {
  current: NativeProviderAccounts | null;
}

function Harness({ probe }: { probe: Probe }): JSX.Element {
  probe.current = useNativeProviderAccounts();
  return <></>;
}

function preferences(
  nativeProviderAccounts?: NativeProviderAccounts,
): PreferencesLoadResult {
  return {
    ...(nativeProviderAccounts ? { nativeProviderAccounts } : {}),
  } as Partial<PreferencesLoadResult> as PreferencesLoadResult;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

describe('useNativeProviderAccounts', () => {
  let container: HTMLDivElement;
  let root: Root;
  let changed: (() => void) | undefined;
  const unsubscribe = jest.fn();
  const loadPreferences = jest.fn();

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    changed = undefined;
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences,
        onPreferencesChanged: (cb: () => void) => {
          changed = cb;
          return unsubscribe;
        },
      } as Partial<CanopyApi> as CanopyApi,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.clearAllMocks();
  });

  it('loads the recorded accounts', async () => {
    loadPreferences.mockResolvedValue(
      preferences({ claude: { accountKey: 'a@example.com', changedAt: 10 } }),
    );
    const probe: Probe = { current: null };
    act(() => root.render(<Harness probe={probe} />));
    expect(probe.current).toEqual({});
    await flush();
    expect(probe.current).toEqual({
      claude: { accountKey: 'a@example.com', changedAt: 10 },
    });
  });

  it('re-reads when preferences change', async () => {
    loadPreferences.mockResolvedValueOnce(preferences());
    const probe: Probe = { current: null };
    act(() => root.render(<Harness probe={probe} />));
    await flush();
    expect(probe.current).toEqual({});

    loadPreferences.mockResolvedValueOnce(
      preferences({ codex: { accountKey: 'b@example.com', changedAt: 20 } }),
    );
    changed?.();
    await flush();
    expect(probe.current).toEqual({
      codex: { accountKey: 'b@example.com', changedAt: 20 },
    });
  });

  it('unsubscribes on unmount', async () => {
    loadPreferences.mockResolvedValue(preferences());
    const probe: Probe = { current: null };
    act(() => root.render(<Harness probe={probe} />));
    await flush();
    act(() => root.render(<></>));
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('keeps the last value when a read fails', async () => {
    loadPreferences.mockResolvedValueOnce(
      preferences({ claude: { accountKey: 'a@example.com' } }),
    );
    const probe: Probe = { current: null };
    act(() => root.render(<Harness probe={probe} />));
    await flush();
    loadPreferences.mockRejectedValueOnce(new Error('read failed'));
    changed?.();
    await flush();
    expect(probe.current).toEqual({ claude: { accountKey: 'a@example.com' } });
  });

  it('renders without the preload bridge', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: undefined,
    });
    const probe: Probe = { current: null };
    act(() => root.render(<Harness probe={probe} />));
    await flush();
    expect(probe.current).toEqual({});
  });
});
