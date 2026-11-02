/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AgentProviderAuthStatus,
  NativeAiCreditsAvailability,
} from '@canopy/desktop-shared/types';
import {
  useProviderAvailability,
  type ProviderAvailability,
} from '../useProviderAvailability';
import { invalidateClaudeAuthStatusCache } from '../useClaudeAuthStatus';
import { invalidateCodexAuthStatusCache } from '../useCodexAuthStatus';
import { invalidateAiCreditsAvailabilityCache } from '../useAiCreditsAvailability';
import { resetAccountProxyStoreForTest } from '@/stores/accountProxyStore';
import type { AccountProxyStatus } from '@canopy/desktop-shared/types/account-proxy';

interface HookProbe {
  current: ProviderAvailability | null;
}

const unauthenticated = (
  provider: 'Claude' | 'Codex',
): AgentProviderAuthStatus => ({
  authenticated: false,
  accountLabel: null,
  detail: null,
  error: `${provider} is not authenticated.`,
});

const authenticated = (accountLabel: string): AgentProviderAuthStatus => ({
  authenticated: true,
  accountLabel,
  detail: null,
  error: null,
});

const probeFailed = (
  provider: 'Claude' | 'Codex',
): AgentProviderAuthStatus => ({
  authenticated: false,
  accountLabel: null,
  detail: null,
  error: `Failed to check ${provider} status.`,
  probeFailed: true,
});

const noNativeCredits: NativeAiCreditsAvailability = {
  personalEligible: false,
  inOrg: false,
  orgCreditPoolCovered: false,
  orgSpendable: false,
  pricingUrl: 'https://cloud.example.com/pricing',
};

function HookHarness({ probe }: { probe: HookProbe }): JSX.Element {
  probe.current = useProviderAvailability();
  return <></>;
}

async function flushAsyncEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('useProviderAvailability', () => {
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
  const getClaudeAuthStatusMock = jest.fn<
    Promise<AgentProviderAuthStatus>,
    []
  >();
  const getCodexAuthStatusMock = jest.fn<
    Promise<AgentProviderAuthStatus>,
    []
  >();
  const loadNativeAiCreditsAvailabilityMock = jest.fn<
    Promise<NativeAiCreditsAvailability>,
    []
  >();

  let container: HTMLDivElement;
  let root: Root;
  let accountProxyStatus: AccountProxyStatus;

  beforeEach(() => {
    resetAccountProxyStoreForTest();
    accountProxyStatus = {
      available: false,
      connection: null,
      state: 'not-configured',
      error: null,
      version: null,
      accounts: [],
      routing: null,
      keepChatOnOneAccount: true,
      routeClaude: true,
      routeCodex: true,
      refreshedAt: null,
      local: {
        phase: 'not-installed',
        version: null,
        install: null,
        port: null,
        startWithApp: true,
        message: null,
      },
      signIn: null,
    };
    getClaudeAuthStatusMock.mockReset();
    getCodexAuthStatusMock.mockReset();
    loadNativeAiCreditsAvailabilityMock.mockReset();
    invalidateClaudeAuthStatusCache();
    invalidateCodexAuthStatusCache();
    invalidateAiCreditsAvailabilityCache();

    getCodexAuthStatusMock.mockResolvedValue(unauthenticated('Codex'));
    loadNativeAiCreditsAvailabilityMock.mockResolvedValue(noNativeCredits);

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getClaudeAuthStatus: getClaudeAuthStatusMock,
        getCodexAuthStatus: getCodexAuthStatusMock,
        loadNativeAiCreditsAvailability: loadNativeAiCreditsAvailabilityMock,
        loadPreferences: jest
          .fn()
          .mockResolvedValue({ opencodeEnabled: false }),
        onPreferencesChanged: jest.fn((): (() => void) => (): void => {}),
        accountProxy: {
          status: (): Promise<AccountProxyStatus> =>
            Promise.resolve(accountProxyStatus),
          onChanged: (): (() => void) => (): void => undefined,
        },
      },
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    invalidateClaudeAuthStatusCache();
    invalidateCodexAuthStatusCache();
    invalidateAiCreditsAvailabilityCache();
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  it('re-reads Claude auth for mounted model pickers after settings login invalidates the cache', async () => {
    getClaudeAuthStatusMock
      .mockResolvedValueOnce(unauthenticated('Claude'))
      .mockResolvedValueOnce(authenticated('dev@example.com'));

    const probe: HookProbe = { current: null };
    await act(async () => {
      root.render(<HookHarness probe={probe} />);
      await flushAsyncEffects();
    });

    expect(probe.current?.claude.nativeAuth).toBe(false);
    expect(probe.current?.claude.selectable).toBe(false);

    await act(async () => {
      invalidateClaudeAuthStatusCache();
      await flushAsyncEffects();
    });

    expect(probe.current?.claude.nativeAuth).toBe(true);
    expect(probe.current?.claude.selectable).toBe(true);
    expect(getClaudeAuthStatusMock).toHaveBeenCalledTimes(2);
  });

  it('treats a failed auth probe as loading (optimistic) rather than signed out', async () => {
    getClaudeAuthStatusMock.mockResolvedValue(probeFailed('Claude'));

    const probe: HookProbe = { current: null };
    await act(async () => {
      root.render(<HookHarness probe={probe} />);
      await flushAsyncEffects();
    });

    // A failed probe is inconclusive: stay optimistic (selectable + loading) so
    // the billing toggle hides instead of locking the user out.
    expect(probe.current?.claude.loading).toBe(true);
    expect(probe.current?.claude.selectable).toBe(true);
    expect(probe.current?.claude.nativeAuthInconclusive).toBe(true);
  });

  it('reports native auth as inconclusive while its probe is still loading', async () => {
    getClaudeAuthStatusMock.mockImplementation(
      () => new Promise<AgentProviderAuthStatus>(() => undefined),
    );

    const probe: HookProbe = { current: null };
    await act(async () => {
      root.render(<HookHarness probe={probe} />);
      await flushAsyncEffects();
    });

    expect(probe.current?.claude.nativeAuth).toBe(false);
    expect(probe.current?.claude.nativeAuthInconclusive).toBe(true);
    // Auth is provider-specific: Codex's settled sign-out stays conclusive.
    expect(probe.current?.codex.nativeAuthInconclusive).toBe(false);
  });

  it('keeps a settled sign-out conclusive while only the credits read is loading', async () => {
    // CAN-5349: a balance refresh raises aggregate `loading`, but must not
    // make a confirmed sign-out look like an unresolved auth probe.
    getClaudeAuthStatusMock.mockResolvedValue(unauthenticated('Claude'));
    loadNativeAiCreditsAvailabilityMock.mockImplementation(
      () => new Promise<NativeAiCreditsAvailability>(() => undefined),
    );

    const probe: HookProbe = { current: null };
    await act(async () => {
      root.render(<HookHarness probe={probe} />);
      await flushAsyncEffects();
    });

    expect(probe.current?.claude.nativeAuth).toBe(false);
    expect(probe.current?.claude.loading).toBe(true);
    expect(probe.current?.claude.creditsLoading).toBe(true);
    expect(probe.current?.claude.nativeAuthInconclusive).toBe(false);
    expect(probe.current?.codex.nativeAuthInconclusive).toBe(false);
  });

  it('withdraws settled credit evidence during an account refresh without changing selection', async () => {
    getClaudeAuthStatusMock.mockResolvedValue(unauthenticated('Claude'));
    loadNativeAiCreditsAvailabilityMock.mockResolvedValue({
      ...noNativeCredits,
      personalEligible: true,
      dailyDripEnabled: false,
    });
    const probe: HookProbe = { current: null };
    await act(async () => {
      root.render(<HookHarness probe={probe} />);
      await flushAsyncEffects();
    });
    expect(probe.current?.claude.creditsEligible).toBe(true);
    expect(probe.current?.claude.creditsInconclusive).toBe(false);

    let finishRead: ((value: NativeAiCreditsAvailability) => void) | undefined;
    loadNativeAiCreditsAvailabilityMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    await act(async () => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
      await flushAsyncEffects();
    });
    // The old balance may still drive the existing optimistic selection gate,
    // but it must no longer establish Available or an opt-in promise.
    expect(probe.current?.claude.selectable).toBe(true);
    expect(probe.current?.claude.creditsInconclusive).toBe(true);

    await act(async () => {
      finishRead?.({ ...noNativeCredits, dailyDripEnabled: true });
      await flushAsyncEffects();
    });
    expect(probe.current?.claude.creditsEligible).toBe(false);
    expect(probe.current?.claude.creditsInconclusive).toBe(false);
    expect(probe.current?.claude.dailyCreditsEnabled).toBe(true);
  });

  it('expires cue evidence and refreshes without reopening the picker', async () => {
    jest.useFakeTimers();
    try {
      getClaudeAuthStatusMock.mockResolvedValue(unauthenticated('Claude'));
      loadNativeAiCreditsAvailabilityMock.mockResolvedValue({
        ...noNativeCredits,
        personalEligible: true,
        dailyDripEnabled: false,
      });
      const probe: HookProbe = { current: null };
      await act(async () => {
        root.render(<HookHarness probe={probe} />);
        await flushAsyncEffects();
      });
      expect(probe.current?.codex.creditsInconclusive).toBe(false);
      let finishRead:
        | ((value: NativeAiCreditsAvailability) => void)
        | undefined;
      loadNativeAiCreditsAvailabilityMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRead = resolve;
          }),
      );
      await act(async () => {
        await jest.advanceTimersByTimeAsync(60_000);
      });
      expect(probe.current?.codex.creditsInconclusive).toBe(true);
      expect(loadNativeAiCreditsAvailabilityMock).toHaveBeenCalledTimes(2);
      await act(async () => {
        finishRead?.({ ...noNativeCredits, dailyDripEnabled: false });
        await flushAsyncEffects();
      });
      expect(probe.current?.codex.creditsInconclusive).toBe(false);
      expect(probe.current?.codex.creditsEligible).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('still refreshes when a render observes expiry before the timer runs', async () => {
    jest.useFakeTimers();
    try {
      getClaudeAuthStatusMock.mockResolvedValue(unauthenticated('Claude'));
      loadNativeAiCreditsAvailabilityMock.mockResolvedValue({
        ...noNativeCredits,
        personalEligible: true,
      });
      const probe: HookProbe = { current: null };
      await act(async () => {
        root.render(<HookHarness probe={probe} />);
        await flushAsyncEffects();
      });
      // Background windows can render an IPC update before overdue timers
      // are dispatched. Detecting stale evidence must not cancel its refresh.
      jest.setSystemTime(Date.now() + 60_001);
      act(() => {
        root.render(<HookHarness probe={probe} />);
      });
      expect(probe.current?.codex.creditsInconclusive).toBe(true);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(0);
      });
      expect(loadNativeAiCreditsAvailabilityMock).toHaveBeenCalledTimes(2);
      expect(probe.current?.codex.creditsInconclusive).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('counts user-supplied provider credentials as native billing paths', async () => {
    getClaudeAuthStatusMock.mockResolvedValue({
      ...unauthenticated('Claude'),
      userSuppliedCredential: true,
    });
    getCodexAuthStatusMock.mockResolvedValue({
      ...unauthenticated('Codex'),
      userSuppliedCredential: true,
    });

    const probe: HookProbe = { current: null };
    await act(async () => {
      root.render(<HookHarness probe={probe} />);
      await flushAsyncEffects();
    });

    expect(probe.current?.claude.nativeAuth).toBe(true);
    expect(probe.current?.claude.selectable).toBe(true);
    expect(probe.current?.claude.creditsEligible).toBe(false);
    expect(probe.current?.codex.nativeAuth).toBe(true);
    expect(probe.current?.codex.selectable).toBe(true);
    expect(probe.current?.codex.creditsEligible).toBe(false);
  });

  it('counts a ready account proxy as a way to pay for its harness', async () => {
    // No native login and no AI Credits, but the proxy has a ready Claude
    // account: Claude models must be pickable, as main routes them (CAN-4020).
    getClaudeAuthStatusMock.mockResolvedValue(unauthenticated('Claude'));
    accountProxyStatus = {
      ...accountProxyStatus,
      available: true,
      connection: {
        id: 'connection-1',
        kind: 'server',
        url: 'https://proxy.example.com',
      },
      state: 'connected',
      version: '8.0.27',
      accounts: [
        {
          authIndex: 'a1f3c2d4a1f3c2d4',
          provider: 'claude',
          label: 'Team key',
          source: 'api-key',
          fileName: null,
          planType: null,
          status: 'active',
          statusMessage: null,
          availableAt: null,
          limits: [],
        },
      ],
    };

    const probe: HookProbe = { current: null };
    await act(async () => {
      root.render(<HookHarness probe={probe} />);
      await flushAsyncEffects();
      await flushAsyncEffects();
    });

    expect(probe.current?.claude.nativeAuth).toBe(true);
    expect(probe.current?.claude.selectable).toBe(true);
    // No ready Codex account on the proxy.
    expect(probe.current?.codex.nativeAuth).toBe(false);
    expect(probe.current?.codex.selectable).toBe(false);
  });
});
