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
} from '@canopy/desktop-shared/types';
import type { AccountProxyStatus } from '@canopy/desktop-shared/types/account-proxy';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { useAccountProxyStore } from '@/stores/accountProxyStore';
import type * as AccountProxyStoreModule from '@/stores/accountProxyStore';
import { useUsageRefresh, type UsageRefreshState } from '../useUsageRefresh';

let mockAiCreditsRefreshing = false;
const mockRefreshAccountProxyStatus = jest.fn<Promise<void>, []>();

jest.mock('@/hooks/useAiCreditsUsage', () => ({
  refreshAiCreditsUsage: (): void => undefined,
  useAiCreditsUsage: (): { refreshing: boolean } => ({
    refreshing: mockAiCreditsRefreshing,
  }),
}));

jest.mock('@/stores/accountProxyStore', () => ({
  ...jest.requireActual<typeof AccountProxyStoreModule>(
    '@/stores/accountProxyStore',
  ),
  refreshAccountProxyStatus: (): Promise<void> =>
    mockRefreshAccountProxyStatus(),
}));

// Keeps the real ProviderUsageCards module (for its provider selector) from
// loading the terminal-backed login modal.
jest.mock('@/components/settings/AuthLoginModal', () => ({
  AuthLoginModal: (): JSX.Element => <div />,
}));

const USAGE: AgentUsageOverview = {
  updatedAt: '2026-10-27T09:00:00.000Z',
  providers: [
    {
      provider: 'claude',
      authState: 'authenticated',
      hasRemainingLimits: true,
      rateLimits: [],
    },
  ],
};

let latest: UsageRefreshState | null = null;
function Probe({ includeAiCredits }: { includeAiCredits: boolean }): null {
  latest = useUsageRefresh({ includeAiCredits });
  return null;
}

describe('useUsageRefresh', () => {
  const originalObservability = useObservabilityStore.getState();
  const originalProxy = useAccountProxyStore.getState();
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    mockAiCreditsRefreshing = false;
    useObservabilityStore.setState({
      usage: USAGE,
      refreshingProviders: new Set<AgentProviderType>(),
      initialize: () => Promise.resolve(),
      refreshProviderUsage: () => Promise.resolve(),
    });
    useAccountProxyStore.setState({
      // Any non-null status means a proxy is configured.
      status: { refreshedAt: null } as unknown as AccountProxyStatus,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useObservabilityStore.setState(originalObservability, true);
    useAccountProxyStore.setState(originalProxy, true);
    latest = null;
    jest.clearAllMocks();
  });

  it('keeps refreshing until the account proxy read settles', async () => {
    let finishProxy: () => void = () => undefined;
    mockRefreshAccountProxyStatus.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishProxy = resolve;
        }),
    );
    act(() => root.render(<Probe includeAiCredits={false} />));
    expect(latest?.refreshing).toBe(false);

    await act(async () => {
      latest?.refresh();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockRefreshAccountProxyStatus).toHaveBeenCalledTimes(1);
    expect(latest?.refreshing).toBe(true);

    await act(async () => {
      finishProxy();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest?.refreshing).toBe(false);
  });

  it('reads as refreshing while AI Credits are re-read', () => {
    mockAiCreditsRefreshing = true;
    act(() => root.render(<Probe includeAiCredits />));
    expect(latest?.refreshing).toBe(true);
  });
});
