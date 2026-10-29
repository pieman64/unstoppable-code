/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AiCreditsRoutingState,
  CanopyApi,
  NativeAccountProvider,
  PreferencesLoadResult,
} from '@canopy/desktop-shared/types';
import type { NativeProviderAccounts } from '../useNativeProviderAccounts';
import { useEffectiveAiCreditsRouting } from '../useEffectiveAiCreditsRouting';

const mockClearAiCreditsRouting = jest.fn();
const mockStore = { live: true };

jest.mock('@/stores/chatStore', () => ({
  useChatStore: <T,>(
    selector: (state: {
      live: boolean;
      clearAiCreditsRouting: typeof mockClearAiCreditsRouting;
    }) => T,
  ): T =>
    selector({
      live: mockStore.live,
      clearAiCreditsRouting: mockClearAiCreditsRouting,
    }),
}));
jest.mock('@/stores/chat/slices/revisioned', () => ({
  isScopeRevisionedLive: (state: { live: boolean }): boolean => state.live,
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TARGET = { projectId: 'proj', worktreeId: 'wt', chatId: 'chat' };
const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface Probe {
  current: boolean | null;
}

function Harness({
  probe,
  routing,
  provider = 'claude',
}: {
  probe: Probe;
  routing: AiCreditsRoutingState | undefined;
  /** `null` stands for an unknown billed provider. */
  provider?: NativeAccountProvider | null;
}): JSX.Element {
  probe.current = useEffectiveAiCreditsRouting(
    routing,
    provider ?? undefined,
    TARGET,
  ).inEffect;
  return <></>;
}

function session(
  overrides: Partial<AiCreditsRoutingState> = {},
): AiCreditsRoutingState {
  return { active: true, scope: 'session', activatedAt: NOW, ...overrides };
}

describe('useEffectiveAiCreditsRouting', () => {
  let container: HTMLDivElement;
  let root: Root;
  let accounts: NativeProviderAccounts;
  let changed: (() => void) | undefined;

  async function flush(): Promise<void> {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
  }

  async function render(element: JSX.Element): Promise<void> {
    act(() => root.render(element));
    await flush();
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    mockStore.live = true;
    accounts = {};
    changed = undefined;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences: () =>
          Promise.resolve({
            nativeProviderAccounts: accounts,
          } as Partial<PreferencesLoadResult> as PreferencesLoadResult),
        onPreferencesChanged: (cb: () => void) => {
          changed = cb;
          return (): void => {};
        },
      } as Partial<CanopyApi> as CanopyApi,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('reverts session routing at its reset time and clears it once', async () => {
    const probe: Probe = { current: null };
    const routing = session({ resetsAt: NOW + 60_000 });
    await render(<Harness probe={probe} routing={routing} />);
    expect(probe.current).toBe(true);
    expect(mockClearAiCreditsRouting).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(60_000);
    });
    expect(probe.current).toBe(false);
    expect(mockClearAiCreditsRouting).toHaveBeenCalledTimes(1);
    expect(mockClearAiCreditsRouting).toHaveBeenCalledWith(TARGET);

    // A re-render with the same stale activation does not clear again.
    await render(<Harness probe={probe} routing={{ ...routing }} />);
    expect(mockClearAiCreditsRouting).toHaveBeenCalledTimes(1);
  });

  it('reverts a reset time given in epoch seconds at the right time', async () => {
    const probe: Probe = { current: null };
    const routing = session({ resetsAt: (NOW + 60_000) / 1000 });
    await render(<Harness probe={probe} routing={routing} />);
    expect(probe.current).toBe(true);

    act(() => {
      jest.advanceTimersByTime(60_000 - 1);
    });
    expect(probe.current).toBe(true);
    expect(mockClearAiCreditsRouting).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(probe.current).toBe(false);
    expect(mockClearAiCreditsRouting).toHaveBeenCalledTimes(1);
  });

  it('reverts a reset beyond the timer limit at the right time', async () => {
    const probe: Probe = { current: null };
    const resetsAt = NOW + 30 * DAY_MS;
    await render(<Harness probe={probe} routing={session({ resetsAt })} />);

    act(() => {
      jest.advanceTimersByTime(25 * DAY_MS);
    });
    expect(probe.current).toBe(true);

    act(() => {
      jest.advanceTimersByTime(5 * DAY_MS - 1);
    });
    expect(probe.current).toBe(true);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(probe.current).toBe(false);
  });

  it('reverts when the provider account changes after activation', async () => {
    const probe: Probe = { current: null };
    await render(<Harness probe={probe} routing={session()} />);
    expect(probe.current).toBe(true);

    accounts = { claude: { accountKey: 'b@example.com', changedAt: NOW + 1 } };
    changed?.();
    await flush();
    expect(probe.current).toBe(false);
    expect(mockClearAiCreditsRouting).toHaveBeenCalledTimes(1);
  });

  it('ignores another provider’s account change', async () => {
    accounts = { codex: { accountKey: 'b@example.com', changedAt: NOW + 1 } };
    const probe: Probe = { current: null };
    await render(<Harness probe={probe} routing={session()} />);
    expect(probe.current).toBe(true);
  });

  it('clears again for a newer activation that goes stale', async () => {
    accounts = { claude: { accountKey: 'b@example.com', changedAt: NOW + 1 } };
    const probe: Probe = { current: null };
    await render(<Harness probe={probe} routing={session()} />);
    expect(mockClearAiCreditsRouting).toHaveBeenCalledTimes(1);

    await render(
      <Harness
        probe={probe}
        routing={session({ activatedAt: NOW + 2, resetsAt: NOW + 10 })}
      />,
    );
    expect(probe.current).toBe(true);
    act(() => {
      jest.advanceTimersByTime(10);
    });
    expect(probe.current).toBe(false);
    expect(mockClearAiCreditsRouting).toHaveBeenCalledTimes(2);
  });

  it('does not clear stored routing while the scope is not live', async () => {
    mockStore.live = false;
    const probe: Probe = { current: null };
    await render(
      <Harness probe={probe} routing={session({ resetsAt: NOW - 1 })} />,
    );
    expect(probe.current).toBe(false);
    expect(mockClearAiCreditsRouting).not.toHaveBeenCalled();
  });

  it('never reverts or clears persistent routing', async () => {
    accounts = { claude: { accountKey: 'b@example.com', changedAt: NOW + 1 } };
    const probe: Probe = { current: null };
    await render(
      <Harness
        probe={probe}
        routing={session({ scope: 'persistent', resetsAt: NOW - 1 })}
      />,
    );
    expect(probe.current).toBe(true);
    expect(mockClearAiCreditsRouting).not.toHaveBeenCalled();
  });

  it('applies only the reset time when the provider is unknown', async () => {
    accounts = { claude: { accountKey: 'b@example.com', changedAt: NOW + 1 } };
    const probe: Probe = { current: null };
    await render(<Harness probe={probe} routing={session()} provider={null} />);
    expect(probe.current).toBe(true);
  });

  it('reports no routing as not in effect without clearing', async () => {
    const probe: Probe = { current: null };
    await render(<Harness probe={probe} routing={undefined} />);
    expect(probe.current).toBe(false);
    expect(mockClearAiCreditsRouting).not.toHaveBeenCalled();
  });
});
