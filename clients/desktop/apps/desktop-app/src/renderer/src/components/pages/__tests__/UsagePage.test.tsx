/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AgentProviderType,
  AgentUsageOverview,
  AgentObservabilitySnapshot,
  ProviderUsageSummary,
} from '@canopy/desktop-shared/types';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { UsagePage } from '../UsagePage';
import type * as ProviderUsageCardsModule from '../usage/ProviderUsageCards';

const mockRefreshAiCreditsUsage = jest.fn();

jest.mock('@/hooks/useAiCreditsUsage', () => ({
  refreshAiCreditsUsage: (): void => {
    mockRefreshAiCreditsUsage();
  },
  useAiCreditsUsage: (): { refreshing: boolean } => ({ refreshing: false }),
}));

// Keeps the real ProviderUsageCards module (for its provider selector) from
// loading the terminal-backed login modal.
jest.mock('@/components/settings/AuthLoginModal', () => ({
  AuthLoginModal: (): JSX.Element => <div />,
}));

jest.mock('../usage/ProviderUsageCards', () => ({
  ...jest.requireActual<typeof ProviderUsageCardsModule>(
    '../usage/ProviderUsageCards',
  ),
  ProviderUsageCards: ({
    usage,
  }: {
    usage: AgentUsageOverview;
  }): JSX.Element => (
    <div
      data-testid="provider-usage-cards"
      data-providers={usage.providers.map((p) => p.provider).join(',')}
    />
  ),
}));

jest.mock('../usage/AiCreditsUsageCard', () => ({
  AiCreditsUsageCard: (): JSX.Element => <div data-testid="ai-credits" />,
}));

jest.mock('../../shared/PageTitlebar', () => ({
  PageTitlebar: (): JSX.Element => <div />,
}));

const CACHED_USAGE: AgentUsageOverview = {
  updatedAt: '2026-09-27T12:00:00.000Z',
  providers: (['claude', 'codex', 'cursor'] as const).map(
    (provider): ProviderUsageSummary => ({
      provider,
      authState: 'authenticated',
      hasRemainingLimits: true,
      rateLimits: [],
    }),
  ),
};

describe('UsagePage', () => {
  const originalObservability = useObservabilityStore.getState();
  const originalFlags = useFeatureFlagsStore.getState().snapshot;
  const refreshProviderUsage = jest.fn<Promise<void>, [AgentProviderType]>();
  let resolveInitialize: () => void = () => undefined;
  let root: Root | null = null;

  beforeEach(() => {
    refreshProviderUsage.mockResolvedValue(undefined);
    useObservabilityStore.setState({
      usage: CACHED_USAGE,
      refreshProviderUsage,
      initialize: () =>
        new Promise<void>((resolve) => {
          resolveInitialize = resolve;
        }),
    });
    useFeatureFlagsStore.setState({
      snapshot: {
        ...originalFlags,
        values: {
          ...originalFlags.values,
          'canopy-desktop-cursor-harness': false,
        },
      },
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    useObservabilityStore.setState(originalObservability, true);
    useFeatureFlagsStore.setState({ snapshot: originalFlags });
    document.body.innerHTML = '';
    jest.clearAllMocks();
  });

  function renderPage(): HTMLDivElement {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<UsagePage />));
    return container;
  }

  it('refreshes every shown provider and AI Credits on open while keeping the cached cards visible', async () => {
    const container = renderPage();

    // The cached cards render immediately; nothing blanks the page.
    const cards = container.querySelector(
      '[data-testid="provider-usage-cards"]',
    );
    expect(cards?.getAttribute('data-providers')).toBe('claude,codex,cursor');
    expect(mockRefreshAiCreditsUsage).toHaveBeenCalledTimes(1);
    expect(refreshProviderUsage).not.toHaveBeenCalled();

    await act(async () => {
      resolveInitialize();
      await Promise.resolve();
    });

    // Cursor is hidden by its rollout flag, so it is not refreshed.
    expect(refreshProviderUsage.mock.calls).toEqual([['claude'], ['codex']]);
    expect(
      container.querySelector('[data-testid="provider-usage-cards"]'),
    ).toBe(cards);
  });

  it('does not refresh providers after the page closes', async () => {
    renderPage();
    act(() => root?.unmount());
    root = null;

    await act(async () => {
      resolveInitialize();
      await Promise.resolve();
    });

    expect(refreshProviderUsage).not.toHaveBeenCalled();
  });

  it('refreshes providers loaded by another view while its snapshot is still pending', async () => {
    let finishSnapshot: () => void = () => undefined;
    const loadSnapshot = jest.fn<Promise<AgentObservabilitySnapshot>, []>(
      () =>
        new Promise<AgentObservabilitySnapshot>((resolve) => {
          finishSnapshot = (): void =>
            resolve({
              version: 1,
              historicalMode: 'forward-only',
              retentionDays: 7,
              recentEntries: [],
              usage: CACHED_USAGE,
            });
        }),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        observability: {
          loadSnapshot,
          onUpdate: (): (() => void) => () => undefined,
        },
      },
    });
    useObservabilityStore.setState({
      initialized: false,
      usage: { updatedAt: '1970-01-01T00:00:00.000Z', providers: [] },
      initialize: originalObservability.initialize,
    });

    const panelInitialization = useObservabilityStore.getState().initialize();
    const container = renderPage();
    expect(refreshProviderUsage).not.toHaveBeenCalled();

    await act(async () => {
      finishSnapshot();
      await panelInitialization;
    });

    expect(loadSnapshot).toHaveBeenCalledTimes(1);
    expect(
      container
        .querySelector('[data-testid="provider-usage-cards"]')
        ?.getAttribute('data-providers'),
    ).toBe('claude,codex,cursor');
    expect(refreshProviderUsage.mock.calls).toEqual([['claude'], ['codex']]);
  });
});
