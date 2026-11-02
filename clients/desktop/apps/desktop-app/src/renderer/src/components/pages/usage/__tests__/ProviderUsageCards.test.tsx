/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AgentProviderAuthStatus,
  AgentProviderType,
  AgentUsageOverview,
  ProviderAuthState,
  ScheduledActivity,
  UsageLimitedSessionGroup,
  UsageLimitedSessionItem,
  PersistedChatMessage,
  AutomationsListResponse,
} from '@canopy/desktop-shared/types';
import { CODE_REVIEW_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { formatUsageLimitTimeLabel } from '@/lib/usage-limit-time-label';
import {
  expectReplayBlocksOnlyValue,
  outermostReplayBlock,
} from '@/test-utils/replay';
import { useNavigationStore } from '@/stores/navigationStore';
import type * as WorkspaceAccessModule from '@/lib/workspace-access';
import { useAccountProxyStore } from '@/stores/accountProxyStore';
import { invalidateAiCreditsUsageCache } from '@/hooks/useAiCreditsUsage';
import type { AccountProxyStatus } from '@canopy/desktop-shared/types/account-proxy';
import { useUsageLimitResumePromptStore } from '@/stores/usageLimitResumePromptStore';
import { useAutomationsStore } from '@/stores/automationsStore';
import { ProviderUsageCard, ProviderUsageCards } from '../ProviderUsageCards';

const mockNavigateToLiveChat = jest.fn<Promise<void>, [unknown]>();
const mockOpenPipelineExecutionFromUi = jest.fn<Promise<unknown>, [unknown]>();

jest.mock('@/components/chat/ChatMessageList', () => {
  const { useWorkspaceIsReadOnly } = jest.requireActual<
    typeof WorkspaceAccessModule
  >('@/lib/workspace-access');
  return {
    ChatMessageList: ({
      messages,
    }: {
      messages: PersistedChatMessage[];
    }): JSX.Element => (
      <div
        data-testid="review-transcript-messages"
        data-read-only={String(useWorkspaceIsReadOnly())}
      >
        {messages.flatMap((message) =>
          message.blocks.map((block, index) =>
            block.type === 'text' ? (
              <span key={`${message.id}-${index}`}>{block.text}</span>
            ) : null,
          ),
        )}
      </div>
    ),
  };
});

jest.mock('@/lib/navigation/live-chat-navigation', () => ({
  navigateToLiveChat: (target: unknown): Promise<void> =>
    mockNavigateToLiveChat(target),
}));

jest.mock('@/lib/panels/open-pipeline-execution', () => ({
  openPipelineExecutionFromUi: (request: unknown): Promise<unknown> =>
    mockOpenPipelineExecutionFromUi(request),
}));

let mockClaudeStatus: AgentProviderAuthStatus | null = null;
let mockCodexStatus: AgentProviderAuthStatus | null = null;

const mockInvalidateClaudeAuthStatusCache = jest.fn();
const mockInvalidateCodexAuthStatusCache = jest.fn();

jest.mock('@/hooks/useClaudeAuthStatus', () => ({
  useClaudeAuthStatus: (): AgentProviderAuthStatus | null => mockClaudeStatus,
  invalidateClaudeAuthStatusCache: (): void => {
    mockInvalidateClaudeAuthStatusCache();
  },
}));

jest.mock('@/hooks/useCodexAuthStatus', () => ({
  useCodexAuthStatus: (): AgentProviderAuthStatus | null => mockCodexStatus,
  invalidateCodexAuthStatusCache: (): void => {
    mockInvalidateCodexAuthStatusCache();
  },
}));

jest.mock('@/components/settings/AuthLoginModal', () => ({
  AuthLoginModal: ({
    provider,
    onClose,
  }: {
    provider: string;
    onClose: () => void;
  }): JSX.Element => (
    <div data-testid={`auth-login-modal-${provider}`}>
      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  ),
}));

function render(node: ReactNode): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

describe('ProviderUsageCards', () => {
  const originalFlags = useFeatureFlagsStore.getState().snapshot;
  const refreshProviderUsage = jest.fn<Promise<void>, [AgentProviderType]>();
  const refreshProviderUsageDetails = jest.fn<
    Promise<AgentUsageOverview>,
    [AgentProviderType]
  >();

  beforeEach(() => {
    mockClaudeStatus = null;
    mockCodexStatus = null;
    mockInvalidateClaudeAuthStatusCache.mockReset();
    mockInvalidateCodexAuthStatusCache.mockReset();
    refreshProviderUsage.mockResolvedValue(undefined);
    refreshProviderUsageDetails.mockResolvedValue({
      updatedAt: '2026-06-05T12:00:00.000Z',
      providers: [],
    });
  });

  afterEach(() => {
    useFeatureFlagsStore.setState({ snapshot: originalFlags });
    document.body.innerHTML = '';
    jest.clearAllMocks();
  });

  it('shows Copilot quotas and refreshes through the shared service', () => {
    useFeatureFlagsStore.setState({
      snapshot: {
        ...originalFlags,
        values: {
          ...originalFlags.values,
          'canopy-desktop-copilot-harness': true,
        },
      },
    });
    const { container, root } = render(
      <ProviderUsageCards
        nowMs={Date.now()}
        usage={{
          updatedAt: new Date().toISOString(),
          providers: [
            {
              provider: 'copilot',
              authState: 'authenticated',
              hasRemainingLimits: true,
              accountLabel: 'copilot-fixture',
              rateLimits: [
                {
                  limitId: 'premium_interactions',
                  limitName: 'Premium requests',
                  primary: { usedPercent: 25 },
                },
              ],
            },
          ],
        }}
        refreshingProviders={new Set()}
        refreshProviderUsage={refreshProviderUsage}
        refreshProviderUsageDetails={refreshProviderUsageDetails}
      />,
    );
    expect(container.textContent).toContain('copilot-fixture');
    expect(container.textContent).toContain('Premium requests');
    expect(container.textContent).toContain('25%');
    // The surface owns refresh: the group has no refresh of its own.
    expect(
      container.querySelector('[aria-label="Refresh GitHub Copilot usage"]'),
    ).toBeNull();
    act(() => root.unmount());
  });

  it.each([
    { released: false, section: 'experiments' },
    { released: true, section: 'account' },
  ])(
    'routes Manage Copilot to $section when released=$released',
    ({ released, section }) => {
      useFeatureFlagsStore.setState({
        snapshot: {
          ...originalFlags,
          values: {
            ...originalFlags.values,
            'canopy-desktop-copilot-harness': true,
            'canopy-desktop-copilot-harness-released': released,
          },
        },
      });
      useNavigationStore.setState({ settingsOpen: false });
      const { container, root } = render(
        <ProviderUsageCards
          nowMs={Date.now()}
          usage={{
            updatedAt: new Date().toISOString(),
            providers: [
              {
                provider: 'copilot',
                authState: 'authenticated',
                hasRemainingLimits: true,
                accountLabel: 'copilot-fixture',
                rateLimits: [],
              },
            ],
          }}
          refreshingProviders={new Set()}
          refreshProviderUsage={refreshProviderUsage}
          refreshProviderUsageDetails={refreshProviderUsageDetails}
        />,
      );
      const manage = container.querySelector<HTMLButtonElement>(
        '[data-testid="usage-provider-copilot-manage"]',
      );
      expect(manage?.textContent).toBe('Manage GitHub Copilot');
      act(() => manage?.click());
      expect(useNavigationStore.getState().settingsInitialSection).toBe(
        section,
      );
      expect(useNavigationStore.getState().settingsOpen).toBe(true);
      act(() => root.unmount());
    },
  );

  it('renders Cursor account usage and routes account management to Cursor settings', () => {
    mockCodexStatus = {
      authenticated: true,
      accountLabel: 'unrelated-codex@example.com',
      detail: null,
      error: null,
    };
    useNavigationStore.setState({ settingsOpen: false });
    const { container, root } = render(
      <ProviderUsageCards
        nowMs={Date.parse('2026-09-16T12:00:00Z')}
        usage={{
          updatedAt: '2026-09-16T12:00:00Z',
          providers: [
            {
              provider: 'cursor',
              authState: 'authenticated',
              hasRemainingLimits: true,
              accountEmail: 'cursor@example.com',
              subscriptionLabel: 'Pro',
              rateLimits: [
                {
                  limitId: 'cursor-plan',
                  limitName: 'Included usage',
                  primary: {
                    usedPercent: 24,
                    resetsAt: '2026-10-12T12:00:00Z',
                  },
                  credits: { remainingUsd: 15.2 },
                },
                {
                  limitId: 'cursor-auto',
                  limitName: 'Auto',
                  primary: { usedPercent: 10 },
                },
                {
                  limitId: 'cursor-api',
                  limitName: 'API',
                  primary: { usedPercent: 14 },
                },
                {
                  limitId: 'cursor-on-demand',
                  limitName: 'On-demand usage',
                  credits: { remainingUsd: 45 },
                },
              ],
            },
          ],
        }}
        refreshingProviders={new Set()}
        refreshProviderUsage={refreshProviderUsage}
        refreshProviderUsageDetails={refreshProviderUsageDetails}
      />,
    );
    expect(container.textContent).toContain('Cursor');
    expect(container.textContent).toContain('cursor@example.com');
    expect(container.textContent).not.toContain('unrelated-codex');
    expect(container.textContent).toContain('Included usage');
    expect(container.textContent).toContain('24%');
    expect(container.textContent).toContain('$15.20');
    expect(container.textContent).toContain('Auto');
    expect(container.textContent).toContain('API');
    expect(container.textContent).toContain('On-demand usage');
    // Unlimited/on-demand entries retain their credit data without a fake meter.
    expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(3);
    expect(container.textContent).toContain('$45.00');
    // The surface owns refresh: the group has no refresh of its own.
    expect(
      container.querySelector('[aria-label="Refresh Cursor usage"]'),
    ).toBeNull();
    const manage = container.querySelector<HTMLButtonElement>(
      '[data-testid="usage-provider-cursor-manage"]',
    );
    expect(manage?.textContent).toBe('Manage Cursor');
    // Session replay blocks the account email, not the row or its action.
    expectReplayBlocksOnlyValue(container, 'cursor@example.com');
    expect(outermostReplayBlock(manage)).toBeNull();
    act(() => manage?.click());
    expect(useNavigationStore.getState().settingsInitialSection).toBe(
      'experiments',
    );
    expect(useNavigationStore.getState().settingsOpen).toBe(true);
    expect(
      container.querySelector('[data-testid^="auth-login-modal"]'),
    ).toBeNull();
    act(() => root.unmount());
  });

  it('keeps missing Cursor usage unknown and renders a retry for a fetch failure', () => {
    const { container, root } = render(
      <ProviderUsageCards
        nowMs={Date.now()}
        usage={{
          updatedAt: '2026-09-16T12:00:00Z',
          providers: [
            {
              provider: 'cursor',
              authState: 'authenticated',
              hasRemainingLimits: false,
              errorInfo: { kind: 'network' },
            },
          ],
        }}
        refreshingProviders={new Set(['cursor'])}
        refreshProviderUsage={refreshProviderUsage}
        refreshProviderUsageDetails={refreshProviderUsageDetails}
      />,
    );
    expect(
      container.querySelector('[data-testid="usage-provider-card-cursor"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toMatch(/(^|[^0-9])0%/);
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="usage-provider-cursor-error"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="usage-provider-cursor-resume"]'),
    ).toBeNull();
    act(() => root.unmount());
  });

  it('removes Cursor immediately when the rollout gate turns off', () => {
    const { container, root } = render(
      <ProviderUsageCards
        nowMs={Date.now()}
        usage={{
          updatedAt: '2026-09-16T12:00:00Z',
          providers: [
            {
              provider: 'cursor',
              authState: 'authenticated',
              hasRemainingLimits: false,
            },
            {
              provider: 'claude',
              authState: 'authenticated',
              hasRemainingLimits: false,
            },
          ],
        }}
        refreshingProviders={new Set()}
        refreshProviderUsage={refreshProviderUsage}
        refreshProviderUsageDetails={refreshProviderUsageDetails}
      />,
    );
    expect(
      container.querySelector('[data-testid="usage-provider-card-cursor"]'),
    ).not.toBeNull();
    act(() =>
      useFeatureFlagsStore.setState({
        snapshot: {
          ...originalFlags,
          values: {
            ...originalFlags.values,
            'canopy-desktop-cursor-harness': false,
          },
        },
      }),
    );
    expect(
      container.querySelector('[data-testid="usage-provider-card-cursor"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="usage-provider-card-claude"]'),
    ).not.toBeNull();
    act(() => root.unmount());
  });

  it('uses the latest Cursor auth snapshot after sign-out', () => {
    const provider = {
      provider: 'cursor',
      authState: 'authenticated',
      hasRemainingLimits: false,
      accountEmail: 'cursor@example.com',
    } as const;
    const props = {
      nowMs: Date.now(),
      refreshingProviders: new Set<AgentProviderType>(),
      refreshProviderUsage,
      refreshProviderUsageDetails,
    };
    const { container, root } = render(
      <ProviderUsageCards
        {...props}
        usage={{ updatedAt: '2026-09-16T12:00:00Z', providers: [provider] }}
      />,
    );
    expect(container.textContent).toContain('cursor@example.com');
    act(() =>
      root.render(
        <ProviderUsageCards
          {...props}
          usage={{
            updatedAt: '2026-09-16T12:01:00Z',
            providers: [
              {
                ...provider,
                authState: 'unauthenticated',
                errorInfo: { kind: 'auth' },
              },
            ],
          }}
        />,
      ),
    );
    expect(container.textContent).not.toContain('cursor@example.com');
    expect(container.textContent).toContain('Sign in to see usage');
    expect(container.textContent).toContain('Sign in to Cursor again');
    const manage = container.querySelector<HTMLButtonElement>(
      '[data-testid="usage-provider-cursor-manage"]',
    );
    expect(manage?.disabled).toBe(false);
    const retry = container.querySelector<HTMLButtonElement>(
      '[data-testid="usage-provider-cursor-error-retry"]',
    );
    act(() => retry?.click());
    expect(refreshProviderUsage).toHaveBeenCalledWith('cursor');
    act(() => root.unmount());
  });

  it('renders Change account inline with the connected account and refreshes usage details after login closes', () => {
    mockClaudeStatus = {
      authenticated: true,
      accountLabel: 'current@example.com',
      detail: null,
      error: null,
    };

    const { container, root } = render(
      <ProviderUsageCards
        nowMs={Date.now()}
        usage={{
          updatedAt: '2026-06-05T12:00:00.000Z',
          providers: [
            {
              provider: 'claude',
              authState: 'authenticated',
              hasRemainingLimits: true,
              accountLabel: 'stale@example.com',
            },
          ],
        }}
        refreshingProviders={new Set()}
        refreshProviderUsage={refreshProviderUsage}
        refreshProviderUsageDetails={refreshProviderUsageDetails}
      />,
    );

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="usage-provider-claude-connect"]',
    );

    expect(container.textContent).toContain('Accountcurrent@example.com');
    expect(container.textContent).not.toContain('stale@example.com');
    expect(button?.textContent).toBe('Change account');
    // Session replay blocks the account label, not "Account:" or the action.
    expectReplayBlocksOnlyValue(container, 'current@example.com');
    expect(outermostReplayBlock(button)).toBeNull();

    act(() => {
      button?.click();
    });
    expect(
      container.querySelector('[data-testid="auth-login-modal-claude"]'),
    ).not.toBeNull();

    const closeButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="auth-login-modal-claude"] button',
    );
    act(() => {
      closeButton?.click();
    });

    expect(mockInvalidateClaudeAuthStatusCache).toHaveBeenCalledTimes(1);
    expect(refreshProviderUsageDetails).toHaveBeenCalledWith('claude');

    act(() => {
      root.unmount();
    });
  });

  it('renders Sign in when the provider is not authenticated', () => {
    mockCodexStatus = {
      authenticated: false,
      accountLabel: null,
      detail: null,
      error: null,
    };

    const { container, root } = render(
      <ProviderUsageCards
        nowMs={Date.now()}
        usage={{
          updatedAt: '2026-06-05T12:00:00.000Z',
          providers: [
            {
              provider: 'codex',
              authState: 'unauthenticated',
              hasRemainingLimits: false,
              accountLabel: 'stale@example.com',
            },
          ],
        }}
        refreshingProviders={new Set()}
        refreshProviderUsage={refreshProviderUsage}
        refreshProviderUsageDetails={refreshProviderUsageDetails}
      />,
    );

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="usage-provider-codex-connect"]',
    );

    expect(container.textContent).toContain('AccountSign in to see usage');
    expect(container.textContent).not.toContain('stale@example.com');
    expect(button?.textContent).toBe('Sign in');
    // Status copy is not an identity, so nothing on the row is blocked.
    expect(
      container.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`),
    ).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it('prefers a fresh logged-out probe over an authenticated usage snapshot', () => {
    mockClaudeStatus = {
      authenticated: false,
      accountLabel: null,
      detail: null,
      error: null,
    };

    const { container, root } = render(
      <ProviderUsageCards
        nowMs={Date.now()}
        usage={{
          updatedAt: '2026-06-05T12:00:00.000Z',
          providers: [
            {
              provider: 'claude',
              authState: 'authenticated',
              hasRemainingLimits: true,
              subscriptionLabel: 'Claude Max 20x',
            },
          ],
        }}
        refreshingProviders={new Set()}
        refreshProviderUsage={refreshProviderUsage}
        refreshProviderUsageDetails={refreshProviderUsageDetails}
      />,
    );

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="usage-provider-claude-connect"]',
    );

    expect(container.textContent).toContain('AccountSign in to see usage');
    expect(container.textContent).not.toContain('AccountSigned in');
    expect(button?.textContent).toBe('Sign in');

    act(() => {
      root.unmount();
    });
  });

  it('keeps Sign in available when the usage snapshot confirms unauthenticated while the live probe is loading', () => {
    mockCodexStatus = null;

    const { container, root } = render(
      <ProviderUsageCards
        nowMs={Date.now()}
        usage={{
          updatedAt: '2026-06-05T12:00:00.000Z',
          providers: [
            {
              provider: 'codex',
              authState: 'unauthenticated',
              hasRemainingLimits: false,
            },
          ],
        }}
        refreshingProviders={new Set()}
        refreshProviderUsage={refreshProviderUsage}
        refreshProviderUsageDetails={refreshProviderUsageDetails}
      />,
    );

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="usage-provider-codex-connect"]',
    );

    expect(container.textContent).toContain('AccountSign in to see usage');
    expect(container.textContent).not.toContain('Checking account…');
    expect(button?.textContent).toBe('Sign in');
    expect(button?.disabled).toBe(false);

    act(() => {
      root.unmount();
    });
  });

  it('renders a disabled loading account control while both the snapshot and live probe are inconclusive', () => {
    mockCodexStatus = null;

    const { container, root } = render(
      <ProviderUsageCards
        nowMs={Date.now()}
        usage={{
          updatedAt: '2026-06-05T12:00:00.000Z',
          providers: [
            {
              provider: 'codex',
              authState: 'unknown',
              hasRemainingLimits: false,
            },
          ],
        }}
        refreshingProviders={new Set()}
        refreshProviderUsage={refreshProviderUsage}
        refreshProviderUsageDetails={refreshProviderUsageDetails}
      />,
    );

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="usage-provider-codex-connect"]',
    );

    expect(container.textContent).toContain('AccountChecking account…');
    expect(button?.disabled).toBe(true);

    act(() => {
      root.unmount();
    });
  });
});

describe('ProviderUsageCard error notice', () => {
  const refreshProviderUsage = jest.fn<Promise<void>, [AgentProviderType]>();
  const refreshProviderUsageDetails = jest.fn<
    Promise<AgentUsageOverview>,
    [AgentProviderType]
  >();

  const CODEX_RAW_404 =
    'failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 404 Not Found; content-type=; body=';

  beforeEach(() => {
    mockClaudeStatus = null;
    mockCodexStatus = null;
    refreshProviderUsage.mockResolvedValue(undefined);
    refreshProviderUsageDetails.mockResolvedValue({
      updatedAt: '2026-06-05T12:00:00.000Z',
      providers: [],
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  function renderWithProvider(
    provider: AgentUsageOverview['providers'][number],
    refreshingProviders: Set<AgentProviderType> = new Set(),
  ): { container: HTMLDivElement; root: Root } {
    return render(
      <ProviderUsageCards
        nowMs={Date.now()}
        usage={{
          updatedAt: '2026-06-05T12:00:00.000Z',
          providers: [provider],
        }}
        refreshingProviders={refreshingProviders}
        refreshProviderUsage={refreshProviderUsage}
        refreshProviderUsageDetails={refreshProviderUsageDetails}
      />,
    );
  }

  it('shows retained Claude windows with a rate-limit notice and future retry time', () => {
    jest.useFakeTimers();
    const now = new Date(2026, 9, 13, 15, 40);
    jest.setSystemTime(now);
    const retryAt = new Date(now.getTime() + 8 * 60 * 1000).toISOString();
    const retryTimeLabel = formatUsageLimitTimeLabel(retryAt);
    if (retryTimeLabel === null) {
      throw new Error('Expected a formatted retry time label');
    }

    const { container, root } = renderWithProvider({
      provider: 'claude',
      authState: 'authenticated',
      hasRemainingLimits: true,
      lastUpdatedAt: new Date(now.getTime() - 60_000).toISOString(),
      rateLimits: [
        {
          limitId: 'five_hour',
          limitName: '5-hour window',
          primary: {
            usedPercent: 42,
            resetsAt: new Date(
              now.getTime() + 4 * 60 * 60 * 1000,
            ).toISOString(),
          },
        },
      ],
      errorInfo: { kind: 'rate_limited', retryAt },
    });
    const notice = container.querySelector(
      '[data-testid="usage-provider-claude-error"]',
    );
    const retry = container.querySelector<HTMLButtonElement>(
      '[data-testid="usage-provider-claude-error-retry"]',
    );

    expect(container.textContent).toContain('5-hour window');
    expect(container.textContent).toContain('42%');
    expect(notice?.textContent).toContain('Usage checks paused');
    expect(notice?.textContent).toContain('limiting usage checks');
    expect(notice?.textContent).toContain(
      'These are the last numbers Claude reported.',
    );
    expect(notice?.textContent).toContain(
      `You can try again after ${retryTimeLabel}.`,
    );
    expect(retry?.disabled).toBe(true);
    act(() => root.unmount());
  });

  it('does not claim retained numbers for a Claude rate-limit cold start', () => {
    const { container, root } = renderWithProvider({
      provider: 'claude',
      authState: 'authenticated',
      hasRemainingLimits: false,
      errorInfo: { kind: 'rate_limited' },
    });
    const notice = container.querySelector(
      '[data-testid="usage-provider-claude-error"]',
    );

    expect(notice?.textContent).toContain('Usage checks paused');
    expect(notice?.textContent?.toLowerCase()).not.toContain('last numbers');
    act(() => root.unmount());
  });

  it('enables a Claude retry after its rate-limit deadline and refreshes usage', () => {
    jest.useFakeTimers();
    const now = new Date(2026, 9, 13, 15, 40);
    jest.setSystemTime(now);
    const retryAt = new Date(now.getTime() + 8 * 60 * 1000).toISOString();
    const { container, root } = renderWithProvider({
      provider: 'claude',
      authState: 'authenticated',
      hasRemainingLimits: false,
      errorInfo: { kind: 'rate_limited', retryAt },
    });
    const retry = container.querySelector<HTMLButtonElement>(
      '[data-testid="usage-provider-claude-error-retry"]',
    );

    expect(retry?.disabled).toBe(true);
    act(() => {
      jest.advanceTimersByTime(8 * 60 * 1000);
    });
    expect(retry?.disabled).toBe(false);
    act(() => retry?.click());
    expect(refreshProviderUsage).toHaveBeenCalledWith('claude');
    act(() => root.unmount());
  });

  it('keeps service errors unchanged when provider windows are present', () => {
    const { container, root } = renderWithProvider({
      provider: 'claude',
      authState: 'authenticated',
      hasRemainingLimits: true,
      rateLimits: [
        {
          limitId: 'five_hour',
          limitName: '5-hour window',
          primary: { usedPercent: 42 },
        },
      ],
      errorInfo: { kind: 'service' },
    });
    const notice = container.querySelector(
      '[data-testid="usage-provider-claude-error"]',
    );
    const retry = container.querySelector<HTMLButtonElement>(
      '[data-testid="usage-provider-claude-error-retry"]',
    );

    expect(notice?.textContent).toContain('Usage unavailable');
    expect(notice?.textContent?.toLowerCase()).not.toContain('last numbers');
    expect(retry?.textContent).toBe('Try again');
    expect(retry?.disabled).toBe(false);
    act(() => root.unmount());
  });

  it('renders friendly copy instead of the raw message and reveals it behind a details toggle', () => {
    const { container, root } = renderWithProvider({
      provider: 'codex',
      authState: 'authenticated',
      hasRemainingLimits: false,
      error: CODEX_RAW_404,
      errorInfo: { kind: 'unsupported', detail: CODEX_RAW_404 },
    });

    const notice = container.querySelector(
      '[data-testid="usage-provider-codex-error"]',
    );
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain(
      "Usage not available. This Codex account doesn't expose usage details.",
    );
    expect(container.textContent).not.toContain(CODEX_RAW_404);

    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="usage-provider-codex-error-details-toggle"]',
    );
    expect(toggle).not.toBeNull();
    // Structure, not just presence: the disclosure is an action in the
    // notice's trailing slot, never a link in the copy column. Without this
    // the suite passes on the text link this replaced.
    expect(toggle?.closest('[data-notice-actions="trailing"]')).not.toBeNull();
    // The dismiss control is a direct child of the notice root, outside both
    // actions containers, so exclude it: this asserts the copy column holds
    // no control, not that the notice can never be dismissible.
    const copyColumnButtons = Array.from(
      container.querySelectorAll(
        '[data-testid="usage-provider-codex-error"] button',
      ),
    ).filter(
      (button) =>
        !button.closest('[data-notice-actions]') &&
        !button.hasAttribute('aria-label'),
    );
    expect(copyColumnButtons).toHaveLength(0);
    act(() => {
      toggle?.click();
    });
    const details = container.querySelector(
      '[data-testid="usage-provider-codex-error-details"]',
    );
    expect(details?.textContent).toContain(CODEX_RAW_404);
    // The revealed raw error stays in the copy column, not among the actions.
    expect(details?.closest('[data-notice-actions]')).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it('offers a Try again action that triggers the provider refresh', () => {
    const { container, root } = renderWithProvider({
      provider: 'codex',
      authState: 'authenticated',
      hasRemainingLimits: false,
      error: 'fetch failed',
      errorInfo: { kind: 'network', detail: 'fetch failed' },
    });

    expect(container.textContent).toContain(
      'No connection. Check your connection, then try reaching Codex again.',
    );

    const retry = container.querySelector<HTMLButtonElement>(
      '[data-testid="usage-provider-codex-error-retry"]',
    );
    expect(retry).not.toBeNull();
    act(() => {
      retry?.click();
    });
    expect(refreshProviderUsage).toHaveBeenCalledWith('codex');

    act(() => {
      root.unmount();
    });
  });

  it('shows a curated message verbatim when the main process provided one', () => {
    const curated =
      'Claude credentials were not found in the system credential store. Sign in to Claude Code, then refresh.';
    const { container, root } = renderWithProvider({
      provider: 'claude',
      authState: 'authenticated',
      hasRemainingLimits: false,
      error: curated,
      errorInfo: { kind: 'auth', message: curated },
    });

    const notice = container.querySelector(
      '[data-testid="usage-provider-claude-error"]',
    );
    expect(notice?.textContent).toContain(curated);
    // No detail beyond the curated message — the toggle would reveal nothing.
    expect(
      container.querySelector(
        '[data-testid="usage-provider-claude-error-details-toggle"]',
      ),
    ).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it('suppresses the no-live-data placeholder while an error notice explains the gap', () => {
    const { container, root } = renderWithProvider({
      provider: 'codex',
      authState: 'authenticated',
      hasRemainingLimits: false,
      error: CODEX_RAW_404,
      errorInfo: { kind: 'unsupported', detail: CODEX_RAW_404 },
    });

    expect(container.textContent).not.toContain(
      'No live remaining-limit data is available',
    );

    act(() => {
      root.unmount();
    });
  });

  it('classifies a legacy string-only error and keeps the raw text in details', () => {
    const { container, root } = renderWithProvider({
      provider: 'codex',
      authState: 'authenticated',
      hasRemainingLimits: false,
      error: CODEX_RAW_404,
    });

    const notice = container.querySelector(
      '[data-testid="usage-provider-codex-error"]',
    );
    expect(notice?.textContent).toContain(
      "Usage not available. This Codex account doesn't expose usage details.",
    );
    expect(container.textContent).not.toContain(CODEX_RAW_404);

    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="usage-provider-codex-error-details-toggle"]',
    );
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    // The raw error is unmounted while collapsed, so the toggle names no
    // element; `aria-controls` appears only once there is one to name.
    expect(toggle?.getAttribute('aria-controls')).toBeNull();
    act(() => {
      toggle?.click();
    });
    const details = container.querySelector(
      '[data-testid="usage-provider-codex-error-details"]',
    );
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(toggle?.getAttribute('aria-controls')).toBe(
      'usage-provider-codex-error-details',
    );
    expect(details?.id).toBe('usage-provider-codex-error-details');
    expect(details?.textContent).toContain(CODEX_RAW_404);

    act(() => {
      root.unmount();
    });
  });

  it('disables the retry action while the provider is already refreshing', () => {
    const { container, root } = renderWithProvider(
      {
        provider: 'codex',
        authState: 'authenticated',
        hasRemainingLimits: false,
        error: 'fetch failed',
        errorInfo: { kind: 'network', detail: 'fetch failed' },
      },
      new Set<AgentProviderType>(['codex']),
    );

    const retry = container.querySelector<HTMLButtonElement>(
      '[data-testid="usage-provider-codex-error-retry"]',
    );
    expect(retry?.disabled).toBe(true);

    act(() => {
      root.unmount();
    });
  });
});

describe('ProviderUsageCards waiting sessions', () => {
  const NOW_MS = Date.parse('2026-07-23T12:00:00.000Z');
  const FUTURE_ISO = '2026-07-23T14:00:00.000Z';
  const PAST_ISO = '2026-07-23T10:00:00.000Z';

  const refreshProviderUsage = jest.fn<Promise<void>, [AgentProviderType]>();
  const refreshProviderUsageDetails = jest.fn<
    Promise<AgentUsageOverview>,
    [AgentProviderType]
  >();
  const listUsageLimitedIdleSessionsMock = jest.fn();

  const sessionGroups: UsageLimitedSessionGroup[] = [
    {
      groupId: 'ws-a',
      groupKind: 'workspace',
      workspaceId: 'ws-a',
      workspaceName: 'Workspace A',
      workspaceType: 'single-repo',
      sessions: [
        {
          kind: 'chat',
          projectId: 'ws-a',
          worktreeId: 'wt',
          chatId: 'c1',
          provider: 'claude',
          chatTitle: 'Chat one',
          detectedAt: 1,
          worktreeName: 'main',
        },
        {
          kind: 'pipeline',
          executionId: 'exec-1',
          statusReasonIds: ['r1'],
          provider: 'claude',
          pipelineName: 'Pipeline one',
          detectedAt: 2,
          pausedStepCount: 1,
          modelLabels: [],
          otherBlockingReasonCount: 0,
        },
      ],
    },
  ];

  function buildUsage(
    rateLimits: AgentUsageOverview['providers'][number]['rateLimits'],
  ): AgentUsageOverview {
    return {
      updatedAt: '2026-07-23T11:59:00.000Z',
      providers: [
        {
          provider: 'claude',
          authState: 'authenticated',
          hasRemainingLimits: true,
          rateLimits,
        },
      ],
    };
  }

  async function renderCards(usage: AgentUsageOverview): Promise<{
    container: HTMLDivElement;
    root: Root;
  }> {
    const rendered = render(
      <ProviderUsageCards
        nowMs={NOW_MS}
        usage={usage}
        refreshingProviders={new Set()}
        refreshProviderUsage={refreshProviderUsage}
        refreshProviderUsageDetails={refreshProviderUsageDetails}
      />,
    );
    // Flush the hook's async session-count fetch.
    await act(async () => {
      await Promise.resolve();
    });
    return rendered;
  }

  function resumeButton(container: HTMLElement): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(
      '[data-testid="usage-provider-claude-resume"]',
    );
  }

  beforeEach(() => {
    listUsageLimitedIdleSessionsMock
      .mockReset()
      .mockResolvedValue(sessionGroups);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        listUsageLimitedIdleSessions: listUsageLimitedIdleSessionsMock,
      },
    });
    useUsageLimitResumePromptStore.setState({
      isOpen: false,
      provider: null,
      origin: 'account-change',
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'api');
    useUsageLimitResumePromptStore.setState({
      isOpen: false,
      provider: null,
      origin: 'account-change',
    });
    document.body.innerHTML = '';
    jest.clearAllMocks();
  });

  it('leaves resuming to the interrupted-sessions notice while no window blocks', async () => {
    const { container, root } = await renderCards(
      buildUsage([
        {
          limitId: 'five_hour',
          primary: { usedPercent: 92, resetsAt: FUTURE_ISO },
        },
      ]),
    );

    expect(listUsageLimitedIdleSessionsMock).toHaveBeenCalledWith({
      provider: 'claude',
    });
    // The surface's one notice offers the resume; the group adds no control.
    expect(resumeButton(container)).toBeNull();
    expect(waitingRow(container)).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  function waitingRow(container: HTMLElement): HTMLElement | null {
    return container.querySelector<HTMLElement>(
      '[data-testid="usage-provider-claude-waiting"]',
    );
  }

  const chatSessionCandidate = sessionGroups[0]?.sessions[0];
  if (!chatSessionCandidate || chatSessionCandidate.kind !== 'chat') {
    throw new Error('Expected the first usage-limited session to be a chat.');
  }
  const chatSession = chatSessionCandidate;
  const pipelineSession = sessionGroups[0].sessions[1];

  function groupWith(
    sessions: UsageLimitedSessionGroup['sessions'],
  ): UsageLimitedSessionGroup[] {
    return [{ ...sessionGroups[0], sessions }];
  }

  it.each(['available', 'missing', 'failed'])(
    'opens a retained review transcript or explains an %s result without resuming',
    async (result) => {
      listUsageLimitedIdleSessionsMock.mockResolvedValue(
        groupWith([
          {
            ...chatSession,
            kind: 'chat',
            projectId: CODE_REVIEW_CHAT_PROJECT_ID,
            worktreeId: 'review-scope',
            chatId: 'retained-review',
            chatTitle: 'Interrupted review',
          },
        ]),
      );
      const getState =
        result === 'failed'
          ? jest.fn().mockRejectedValue(new Error('unavailable'))
          : jest.fn().mockResolvedValue({
              tabsFile: {
                tabs:
                  result === 'missing'
                    ? []
                    : [
                        {
                          id: 'retained-review',
                          title: 'Interrupted review',
                          messages: [],
                        },
                      ],
              },
            });
      const getTranscriptPage = jest.fn().mockResolvedValue({
        messages: [
          {
            id: 'review-message',
            role: 'assistant',
            timestamp: 1,
            blocks: [{ type: 'text', text: 'Retained review transcript' }],
          },
        ],
        totalMessages: 1,
        transcriptRevision: 1,
      });
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          listUsageLimitedIdleSessions: listUsageLimitedIdleSessionsMock,
          chat: { getState, getTranscriptPage },
        },
      });
      const usage = buildUsage([
        {
          limitId: 'codex',
          secondary: { usedPercent: 100, resetsAt: FUTURE_ISO },
        },
      ]);
      const { container, root } = await renderCards(usage);
      try {
        await act(async () => {
          container
            .querySelector<HTMLButtonElement>(
              '[data-testid="usage-provider-claude-waiting-open"]',
            )
            ?.click();
          await Promise.resolve();
        });
        const dialog = document.querySelector(
          '[data-testid="usage-retained-review-chat"]',
        );
        expect(dialog).not.toBeNull();
        if (result === 'available') {
          expect(dialog?.textContent).toContain('Retained review transcript');
          expect(
            dialog
              ?.querySelector('[data-testid="review-transcript-messages"]')
              ?.getAttribute('data-read-only'),
          ).toBe('true');
        } else {
          expect(dialog?.textContent).toContain("Couldn't open the chat");
          expect(dialog?.textContent).not.toContain(
            'Retained review transcript',
          );
        }
        expect(getState).toHaveBeenCalledWith({
          projectId: CODE_REVIEW_CHAT_PROJECT_ID,
          worktreeId: 'review-scope',
        });
        expect(getTranscriptPage).toHaveBeenCalledWith({
          projectId: CODE_REVIEW_CHAT_PROJECT_ID,
          worktreeId: 'review-scope',
          chatId: 'retained-review',
        });
        await act(async () => {
          root.render(
            <ProviderUsageCards
              nowMs={Date.parse(FUTURE_ISO) + 1}
              usage={usage}
              refreshingProviders={new Set()}
              refreshProviderUsage={refreshProviderUsage}
              refreshProviderUsageDetails={refreshProviderUsageDetails}
            />,
          );
          await Promise.resolve();
        });
        expect(waitingRow(container)).toBeNull();
        expect(
          document.querySelector('[data-testid="usage-retained-review-chat"]'),
        ).toBe(dialog);
        expect(getState).toHaveBeenCalledTimes(1);
        expect(getTranscriptPage).toHaveBeenCalledTimes(1);
        expect(mockNavigateToLiveChat).not.toHaveBeenCalled();
        expect(useUsageLimitResumePromptStore.getState().isOpen).toBe(false);
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it('shows the waiting sessions while a window is confirmed at 100%', async () => {
    const { container, root } = await renderCards(
      buildUsage([
        {
          limitId: 'five_hour',
          primary: { usedPercent: 100, resetsAt: FUTURE_ISO },
        },
      ]),
    );

    expect(resumeButton(container)).toBeNull();
    expect(waitingRow(container)?.textContent).toContain(
      `2 interrupted sessionsLimit resets at ${formatUsageLimitTimeLabel(Date.parse(FUTURE_ISO))}`,
    );

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="usage-provider-claude-waiting-view"]',
        )
        ?.click();
    });
    const pipelineRow = document.querySelector<HTMLButtonElement>(
      '[data-testid="usage-provider-claude-waiting-session-pipeline-exec-1"]',
    );
    expect(
      document.querySelector(
        '[data-testid="usage-provider-claude-waiting-session-chat-ws-a-wt-c1"]',
      ),
    ).not.toBeNull();
    act(() => {
      pipelineRow?.click();
    });

    expect(mockOpenPipelineExecutionFromUi).toHaveBeenCalledWith({
      executionId: 'exec-1',
    });
    expect(mockNavigateToLiveChat).not.toHaveBeenCalled();
    // Navigation never opens the resume prompt.
    expect(useUsageLimitResumePromptStore.getState().isOpen).toBe(false);

    act(() => {
      root.unmount();
    });
  });

  it('routes every mixed chooser entry without opening the resume prompt', async () => {
    const { container, root } = await renderCards(
      buildUsage([
        {
          limitId: 'weekly',
          secondary: { usedPercent: 100, resetsAt: FUTURE_ISO },
        },
      ]),
    );
    try {
      const view = container.querySelector<HTMLButtonElement>(
        '[data-testid="usage-provider-claude-waiting-view"]',
      );
      act(() => view?.click());
      act(() =>
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="usage-provider-claude-waiting-session-chat-ws-a-wt-c1"]',
          )
          ?.click(),
      );
      expect(mockNavigateToLiveChat).toHaveBeenCalledWith({
        projectId: 'ws-a',
        worktreeId: 'wt',
        chatId: 'c1',
        workspaceId: 'ws-a',
      });
      act(() => view?.click());
      act(() =>
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="usage-provider-claude-waiting-session-pipeline-exec-1"]',
          )
          ?.click(),
      );
      expect(mockOpenPipelineExecutionFromUi).toHaveBeenCalledWith({
        executionId: 'exec-1',
      });
      expect(useUsageLimitResumePromptStore.getState().isOpen).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it('lists both chats with their complete identities', async () => {
    listUsageLimitedIdleSessionsMock.mockResolvedValue([
      {
        ...sessionGroups[0],
        sessions: [
          sessionGroups[0]?.sessions[0],
          {
            ...sessionGroups[0]?.sessions[0],
            chatId: 'c2',
            chatTitle: 'Chat two',
          },
        ],
      },
    ]);
    const { container, root } = await renderCards(
      buildUsage([{ limitId: 'weekly', secondary: { usedPercent: 100 } }]),
    );
    try {
      expect(container.textContent).toContain('2 interrupted sessions');
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="usage-provider-claude-waiting-view"]',
          )
          ?.click(),
      );
      act(() =>
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="usage-provider-claude-waiting-session-chat-ws-a-wt-c2"]',
          )
          ?.click(),
      );
      expect(mockNavigateToLiveChat).toHaveBeenCalledWith({
        projectId: 'ws-a',
        worktreeId: 'wt',
        chatId: 'c2',
        workspaceId: 'ws-a',
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it('uses native blocking windows even when proxy display windows are below limit', async () => {
    const proxy: AccountProxyStatus = {
      available: true,
      connection: {
        id: 'conn',
        kind: 'server',
        url: 'https://proxy.example.com',
      },
      state: 'connected',
      error: null,
      version: '8.0.28',
      accounts: [
        {
          authIndex: 'native-proxy-test',
          provider: 'claude',
          label: 'proxy@example.test',
          source: 'sign-in',
          fileName: 'claude-test.json',
          planType: 'max',
          status: 'active',
          statusMessage: null,
          availableAt: null,
          limits: [{ id: 'five-hour', usedPercent: 10, resetsAt: null }],
        },
      ],
      routing: null,
      keepChatOnOneAccount: true,
      routeClaude: true,
      routeCodex: false,
      refreshedAt: NOW_MS,
      local: {
        phase: 'not-installed',
        version: '8.0.28',
        install: null,
        port: null,
        startWithApp: true,
        message: null,
      },
      signIn: null,
    };
    useAccountProxyStore.setState({ status: proxy });
    const { container, root } = await renderCards(
      buildUsage([
        {
          limitId: 'native',
          secondary: { usedPercent: 100, resetsAt: FUTURE_ISO },
        },
      ]),
    );
    try {
      expect(container.textContent).toContain('Account proxy');
      expect(
        container.querySelector(
          '[data-testid="usage-provider-claude-waiting"]',
        ),
      ).not.toBeNull();
      expect(resumeButton(container)).toBeNull();
    } finally {
      act(() => root.unmount());
      useAccountProxyStore.setState({ status: null });
    }
  });

  it('opens the one waiting chat without resuming it', async () => {
    listUsageLimitedIdleSessionsMock.mockResolvedValue(
      groupWith([chatSession]),
    );
    const { container, root } = await renderCards(
      buildUsage([
        {
          limitId: 'five_hour',
          primary: { usedPercent: 100, resetsAt: FUTURE_ISO },
        },
      ]),
    );

    expect(waitingRow(container)?.textContent).toContain(
      '1 interrupted session',
    );
    const open = container.querySelector<HTMLButtonElement>(
      '[data-testid="usage-provider-claude-waiting-open"]',
    );
    expect(open?.textContent).toBe('Open chat');
    act(() => {
      open?.click();
    });
    expect(mockNavigateToLiveChat).toHaveBeenCalledWith({
      projectId: 'ws-a',
      worktreeId: 'wt',
      chatId: 'c1',
      workspaceId: 'ws-a',
    });
    expect(useUsageLimitResumePromptStore.getState().isOpen).toBe(false);

    act(() => {
      root.unmount();
    });
  });

  it('opens the one waiting pipeline in its owning worktree', async () => {
    listUsageLimitedIdleSessionsMock.mockResolvedValue(
      groupWith([{ ...pipelineSession, projectId: 'ws-a', worktreeId: 'wt' }]),
    );
    const { container, root } = await renderCards(
      buildUsage([
        {
          limitId: 'five_hour',
          primary: { usedPercent: 100, resetsAt: FUTURE_ISO },
        },
      ]),
    );

    const open = container.querySelector<HTMLButtonElement>(
      '[data-testid="usage-provider-claude-waiting-open"]',
    );
    expect(open?.textContent).toBe('Open pipeline');
    act(() => {
      open?.click();
    });
    expect(mockOpenPipelineExecutionFromUi).toHaveBeenCalledWith({
      executionId: 'exec-1',
      owner: { projectId: 'ws-a', worktreeId: 'wt' },
    });

    act(() => {
      root.unmount();
    });
  });

  it('says the reset time is unavailable when any blocking window has no reset', async () => {
    const { container, root } = await renderCards(
      buildUsage([
        {
          limitId: 'five_hour',
          primary: { usedPercent: 100, resetsAt: FUTURE_ISO },
          secondary: { usedPercent: 100 },
        },
      ]),
    );

    expect(waitingRow(container)?.textContent).toContain(
      '2 interrupted sessionsReset time unavailable',
    );
    expect(waitingRow(container)?.textContent).not.toContain('expected');

    act(() => {
      root.unmount();
    });
  });

  it('drops the waiting row when the clock passes the last known reset', async () => {
    const usage = buildUsage([
      {
        limitId: 'five_hour',
        primary: { usedPercent: 100, resetsAt: FUTURE_ISO },
      },
    ]);
    const { container, root } = await renderCards(usage);
    expect(waitingRow(container)).not.toBeNull();

    act(() => {
      root.render(
        <ProviderUsageCards
          nowMs={Date.parse(FUTURE_ISO) + 1}
          usage={usage}
          refreshingProviders={new Set()}
          refreshProviderUsage={refreshProviderUsage}
          refreshProviderUsageDetails={refreshProviderUsageDetails}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(waitingRow(container)).toBeNull();
    expect(resumeButton(container)).toBeNull();
    expect(container.textContent).toContain('Reset time has passed');

    act(() => {
      root.unmount();
    });
  });

  it('keeps waiting past a known reset while another blocker has no reset', async () => {
    const usage = buildUsage([
      {
        limitId: 'five_hour',
        primary: { usedPercent: 100, resetsAt: FUTURE_ISO },
        secondary: { usedPercent: 100 },
      },
    ]);
    const { container, root } = await renderCards(usage);

    act(() => {
      root.render(
        <ProviderUsageCards
          nowMs={Date.parse(FUTURE_ISO) + 1}
          usage={usage}
          refreshingProviders={new Set()}
          refreshProviderUsage={refreshProviderUsage}
          refreshProviderUsageDetails={refreshProviderUsageDetails}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(resumeButton(container)).toBeNull();
    expect(waitingRow(container)?.textContent).toContain(
      'Reset time unavailable',
    );

    act(() => {
      root.unmount();
    });
  });

  it('shows the waiting row for an exhausted Codex weekly window in the panel', async () => {
    listUsageLimitedIdleSessionsMock.mockResolvedValue(
      groupWith([{ ...chatSession, provider: 'codex' }]),
    );
    const { container, root } = render(
      <ProviderUsageCard
        provider={{
          provider: 'codex',
          authState: 'authenticated',
          hasRemainingLimits: false,
          rateLimits: [
            {
              limitId: 'codex',
              primary: { usedPercent: 40, resetsAt: FUTURE_ISO },
              secondary: {
                usedPercent: 100,
                resetsAt: FUTURE_ISO,
                windowDurationMins: 10_080,
              },
            },
          ],
        }}
        nowMs={NOW_MS}
        snapshots={[]}
        refreshingProviders={new Set()}
        refreshProviderUsage={refreshProviderUsage}
        refreshProviderUsageDetails={refreshProviderUsageDetails}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    const row = container.querySelector<HTMLElement>(
      '[data-testid="usage-provider-codex-waiting"]',
    );
    expect(row?.textContent).toContain('1 interrupted session');
    // A row of the group's card, before the account row.
    const box = row?.parentElement;
    expect(box?.className).toContain('@container/usage-group');
    const rows = Array.from(box?.children ?? []);
    expect(rows.indexOf(row as Element)).toBe(rows.length - 2);
    expect(
      container.querySelector('[data-testid="usage-provider-codex-resume"]'),
    ).toBeNull();
    expect(container.textContent).toContain('Limit reached');

    act(() => {
      root.unmount();
    });
  });

  it('shows no waiting row when the 100% window is stale (reset passed)', async () => {
    const { container, root } = await renderCards(
      buildUsage([
        {
          limitId: 'five_hour',
          primary: { usedPercent: 100, resetsAt: PAST_ISO },
        },
      ]),
    );

    expect(waitingRow(container)).toBeNull();
    expect(resumeButton(container)).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it('shows no waiting row when there are no usage-limited sessions', async () => {
    listUsageLimitedIdleSessionsMock.mockResolvedValue([]);
    const { container, root } = await renderCards(
      buildUsage([
        {
          limitId: 'five_hour',
          primary: { usedPercent: 100, resetsAt: FUTURE_ISO },
        },
      ]),
    );

    expect(waitingRow(container)).toBeNull();
    expect(resumeButton(container)).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  describe('with scheduled usage-limit resumes (CAN-5014)', () => {
    function chat(chatId: string): UsageLimitedSessionItem {
      return {
        kind: 'chat',
        projectId: 'ws-a',
        worktreeId: 'wt',
        chatId,
        provider: 'claude',
        chatTitle: `Chat ${chatId}`,
        detectedAt: 1,
        worktreeName: 'main',
      };
    }

    function resumeFor(chatId: string): ScheduledActivity {
      return {
        version: 1,
        id: `resume-${chatId}`,
        name: 'Resume',
        enabled: true,
        schedule: { kind: 'one_time', runAt: FUTURE_ISO, timezone: 'local' },
        action: {
          type: 'worktree_session_prompt',
          workspaceId: 'ws-a',
          worktreeId: 'wt',
          chatId,
          prompt: 'continue',
          purpose: 'usage_limit_resume',
        },
        createdAt: PAST_ISO,
        updatedAt: PAST_ISO,
        nextRunAt: FUTURE_ISO,
        failureCount: 0,
      };
    }

    function listChats(...chatIds: string[]): void {
      listUsageLimitedIdleSessionsMock.mockResolvedValue([
        { ...sessionGroups[0], sessions: chatIds.map(chat) },
      ]);
    }

    function schedule(...chatIds: string[]): void {
      useAutomationsStore.setState({ activities: chatIds.map(resumeFor) });
    }

    const blocked = (): AgentUsageOverview =>
      buildUsage([
        {
          limitId: 'weekly',
          secondary: { usedPercent: 100, resetsAt: FUTURE_ISO },
        },
      ]);

    function chooserChatIds(): string[] {
      return Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-testid^="usage-provider-claude-waiting-session-chat-"]',
        ),
        (row) =>
          row.dataset.testid?.replace(
            'usage-provider-claude-waiting-session-chat-ws-a-wt-',
            '',
          ) ?? '',
      );
    }

    beforeEach(() => {
      useAutomationsStore.setState({
        activities: [],
        hydrated: true,
        loading: false,
        error: null,
      });
    });

    afterEach(() => {
      useAutomationsStore.setState({
        activities: [],
        hydrated: false,
        loading: false,
        error: null,
      });
    });

    it('counts and opens only the chat that is not scheduled', async () => {
      listChats('c1', 'c2');
      schedule('c1');
      const { container, root } = await renderCards(blocked());
      try {
        expect(waitingRow(container)?.textContent).toContain(
          '1 interrupted session',
        );
        expect(
          container.querySelector(
            '[data-testid="usage-provider-claude-waiting-view"]',
          ),
        ).toBeNull();
        act(() =>
          container
            .querySelector<HTMLButtonElement>(
              '[data-testid="usage-provider-claude-waiting-open"]',
            )
            ?.click(),
        );
        expect(mockNavigateToLiveChat).toHaveBeenCalledWith({
          projectId: 'ws-a',
          worktreeId: 'wt',
          chatId: 'c2',
          workspaceId: 'ws-a',
        });
      } finally {
        act(() => root.unmount());
      }
    });

    it('hides the waiting row when every chat is scheduled', async () => {
      listChats('c1', 'c2');
      schedule('c1', 'c2');
      const { container, root } = await renderCards(blocked());
      try {
        expect(waitingRow(container)).toBeNull();
        expect(resumeButton(container)).toBeNull();
      } finally {
        act(() => root.unmount());
      }
    });

    it('withholds the waiting row until automations have loaded', async () => {
      listChats('c1', 'c2');
      useAutomationsStore.setState({ hydrated: false, loading: true });
      const { container, root } = await renderCards(blocked());
      try {
        expect(waitingRow(container)).toBeNull();
        act(() =>
          useAutomationsStore.setState({
            activities: [resumeFor('c1')],
            hydrated: true,
            loading: false,
          }),
        );
        expect(waitingRow(container)?.textContent).toContain(
          '1 interrupted session',
        );
      } finally {
        act(() => root.unmount());
      }
    });

    it('drops a chat from the open chooser once it is scheduled', async () => {
      listChats('c1', 'c2', 'c3');
      schedule('c1');
      const { container, root } = await renderCards(blocked());
      try {
        expect(waitingRow(container)?.textContent).toContain(
          '2 interrupted sessions',
        );
        act(() =>
          container
            .querySelector<HTMLButtonElement>(
              '[data-testid="usage-provider-claude-waiting-view"]',
            )
            ?.click(),
        );
        expect(chooserChatIds()).toEqual(['c2', 'c3']);

        act(() => schedule('c1', 'c2'));
        expect(chooserChatIds()).not.toContain('c2');
        expect(waitingRow(container)?.textContent).toContain(
          '1 interrupted session',
        );

        act(() => schedule());
        expect(waitingRow(container)?.textContent).toContain(
          '3 interrupted sessions',
        );
        expect(listUsageLimitedIdleSessionsMock).toHaveBeenCalledTimes(1);
      } finally {
        act(() => root.unmount());
      }
    });

    it('keeps the chooser open without stale actions across a broadcast reload', async () => {
      listChats('c1', 'c2', 'c3');
      schedule('c1');
      const originalFlags = useFeatureFlagsStore.getState().snapshot;
      useFeatureFlagsStore.setState({
        snapshot: {
          ...originalFlags,
          values: {
            ...originalFlags.values,
            'canopy-shared-org-projects-enabled': true,
          },
        },
      });
      let broadcast: (snapshot: AutomationsListResponse) => void = () =>
        undefined;
      let completeReload: (snapshot: AutomationsListResponse) => void = () =>
        undefined;
      const reload = new Promise<AutomationsListResponse>((resolve) => {
        completeReload = resolve;
      });
      const list = jest.fn(() => reload);
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          listUsageLimitedIdleSessions: listUsageLimitedIdleSessionsMock,
          automations: {
            list,
            onChanged: (listener: typeof broadcast): (() => void) => {
              broadcast = listener;
              return () => undefined;
            },
          },
        },
      });
      const { container, root } = await renderCards(blocked());
      try {
        act(() =>
          container
            .querySelector<HTMLButtonElement>(
              '[data-testid="usage-provider-claude-waiting-view"]',
            )
            ?.click(),
        );
        expect(chooserChatIds()).toEqual(['c2', 'c3']);
        act(() => broadcast({ activities: [], recentRuns: [] }));
        expect(list).toHaveBeenCalledTimes(1);
        expect(
          document.querySelector(
            '[data-testid="usage-provider-claude-waiting-chooser"]',
          ),
        ).not.toBeNull();
        expect(chooserChatIds()).toEqual([]);
        expect(waitingRow(container)).toBeNull();
        await act(async () => {
          completeReload({
            activities: [resumeFor('c1'), resumeFor('c2')],
            recentRuns: [],
          });
          await reload;
        });
        expect(chooserChatIds()).toEqual(['c3']);
        expect(waitingRow(container)?.textContent).toContain(
          '1 interrupted session',
        );
        act(() =>
          document
            .querySelector<HTMLButtonElement>(
              '[data-testid="usage-provider-claude-waiting-session-chat-ws-a-wt-c3"]',
            )
            ?.click(),
        );
        expect(mockNavigateToLiveChat).toHaveBeenCalledWith({
          projectId: 'ws-a',
          worktreeId: 'wt',
          chatId: 'c3',
          workspaceId: 'ws-a',
        });
      } finally {
        act(() => root.unmount());
        useFeatureFlagsStore.setState({ snapshot: originalFlags });
      }
    });
  });
});

describe('ProviderUsageCard plan pill', () => {
  const refreshProviderUsage = jest.fn<Promise<void>, [AgentProviderType]>();
  const refreshProviderUsageDetails = jest.fn<
    Promise<AgentUsageOverview>,
    [AgentProviderType]
  >();

  beforeEach(() => {
    mockClaudeStatus = null;
    mockCodexStatus = null;
    refreshProviderUsage.mockResolvedValue(undefined);
    refreshProviderUsageDetails.mockResolvedValue({
      updatedAt: '2026-06-05T12:00:00.000Z',
      providers: [],
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    jest.clearAllMocks();
  });

  function renderClaude(
    // Typed to the real union rather than `string`: this file is not covered by
    // `tsconfig.web.json` and Jest's SWC transform does not type-check, so a `string` here
    // would silently accept invalid states and defeat the narrowing on
    // `UsageCardHeaderProps.authState`.
    authState: ProviderAuthState,
    subscriptionLabel?: string,
  ): { container: HTMLDivElement; root: Root } {
    return render(
      <ProviderUsageCards
        nowMs={Date.now()}
        usage={{
          updatedAt: '2026-06-05T12:00:00.000Z',
          providers: [
            {
              provider: 'claude',
              authState,
              hasRemainingLimits: false,
              subscriptionLabel,
            },
          ],
        }}
        refreshingProviders={new Set()}
        refreshProviderUsage={refreshProviderUsage}
        refreshProviderUsageDetails={refreshProviderUsageDetails}
      />,
    );
  }

  function planChip(container: HTMLElement): HTMLElement | null {
    return container.querySelector(
      '[data-testid="usage-provider-claude-plan-chip"]',
    );
  }

  it('leads the group with the Claude mark and marks window progress', () => {
    const nowMs = Date.now();
    const { container, root } = render(
      <ProviderUsageCards
        nowMs={nowMs}
        usage={{
          updatedAt: '2026-06-05T12:00:00.000Z',
          providers: [
            {
              provider: 'claude',
              authState: 'authenticated',
              hasRemainingLimits: true,
              rateLimits: [
                {
                  limitId: 'five_hour',
                  primary: {
                    usedPercent: 30,
                    resetsAt: new Date(nowMs + 2 * 60 * 60_000).toISOString(),
                    windowDurationMins: 300,
                  },
                },
              ],
            },
          ],
        }}
        refreshingProviders={new Set()}
        refreshProviderUsage={refreshProviderUsage}
        refreshProviderUsageDetails={refreshProviderUsageDetails}
      />,
    );

    expect(
      container.querySelector(
        '[data-testid="usage-provider-card-claude"] h2 [data-testid="usage-group-provider-mark"]',
      ),
    ).toBeInstanceOf(SVGElement);
    const triangle = container.querySelector<SVGElement>(
      '[data-testid="usage-window-elapsed"]',
    );
    expect(triangle).toBeInstanceOf(SVGElement);
    expect(Number.parseFloat(triangle?.style.left ?? '')).toBeCloseTo(60, 0);

    act(() => {
      root.unmount();
    });
  });

  it('names the plan in the group heading, without the provider prefix', () => {
    const { container, root } = renderClaude('authenticated', 'Claude Max 20x');

    expect(planChip(container)?.textContent).toBe('Max 20x');
    expect(container.querySelector('h2')?.textContent).toBe('Claude · Max 20x');
    // No auth word and no per-group clock or refresh.
    expect(container.textContent).not.toContain('authenticated');
    expect(
      container.querySelector('[aria-label="Refresh Claude usage"]'),
    ).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it('names no plan while the provider is not signed in', () => {
    const { container, root } = renderClaude(
      'unauthenticated',
      'Claude Max 20x',
    );

    expect(planChip(container)).toBeNull();
    expect(container.querySelector('h2')?.textContent).toBe('Claude');

    act(() => {
      root.unmount();
    });
  });

  it('names no plan when there is no subscription label', () => {
    const { container, root } = renderClaude('authenticated', undefined);

    expect(planChip(container)).toBeNull();
    expect(container.textContent).not.toContain('authenticated');

    act(() => {
      root.unmount();
    });
  });
});

describe('ProviderUsageCard with the account proxy', () => {
  const PROXY_STATUS: AccountProxyStatus = {
    available: true,
    connection: {
      id: 'conn-1',
      kind: 'server',
      url: 'https://proxy.example.com',
    },
    state: 'connected',
    error: null,
    version: '8.0.28',
    accounts: [
      {
        authIndex: 'a1f3c2d4a1f3c2d4',
        provider: 'codex',
        label: 'sam@example.com',
        source: 'sign-in',
        fileName: 'codex-sam.json',
        planType: 'pro',
        status: 'active',
        statusMessage: null,
        availableAt: null,
        limits: [{ id: 'five-hour', usedPercent: 42, resetsAt: null }],
      },
    ],
    routing: null,
    keepChatOnOneAccount: true,
    routeClaude: false,
    routeCodex: true,
    refreshedAt: Date.parse('2026-10-15T12:00:00.000Z'),
    local: {
      phase: 'not-installed',
      version: '8.0.28',
      install: null,
      port: null,
      startWithApp: true,
      message: null,
    },
    signIn: null,
  };
  const usage: AgentUsageOverview = {
    updatedAt: '2026-10-15T12:00:00.000Z',
    providers: [
      {
        provider: 'claude',
        authState: 'unauthenticated',
        hasRemainingLimits: false,
      },
      {
        provider: 'codex',
        authState: 'unauthenticated',
        hasRemainingLimits: false,
      },
    ],
  };

  beforeEach(() => {
    const unauthenticated: AgentProviderAuthStatus = {
      authenticated: false,
      accountLabel: null,
      detail: null,
      error: null,
    };
    mockClaudeStatus = unauthenticated;
    mockCodexStatus = unauthenticated;
    useAccountProxyStore.setState({ status: PROXY_STATUS, refreshing: false });
  });

  afterEach(() => {
    useAccountProxyStore.setState({ status: null, refreshing: false });
    document.body.innerHTML = '';
  });

  it("shows the proxy's accounts and limits for the harness it serves", () => {
    const openSettings = jest.fn();
    const originalOpenSettings = useNavigationStore.getState().openSettings;
    useNavigationStore.setState({ openSettings });
    const { container, root } = render(
      <ProviderUsageCards
        nowMs={Date.parse('2026-10-15T12:00:00.000Z')}
        usage={usage}
        refreshingProviders={new Set()}
        refreshProviderUsage={jest.fn()}
        refreshProviderUsageDetails={jest.fn()}
      />,
    );

    const codex = container.querySelector(
      '[data-testid="usage-provider-card-codex"]',
    );
    const text = codex?.textContent ?? '';
    expect(text).toContain('Account proxy');
    expect(text).toContain(
      'Codex runs through the account proxy on this device.',
    );
    expect(text).toContain('sam@example.com');
    expect(text).toContain('5-hour limit');
    expect(text).not.toContain('Sign in');
    expectReplayBlocksOnlyValue(container, 'sam@example.com');
    // Claude is not routed, so its card keeps the user's own sign-in.
    expect(
      container.querySelector('[data-testid="usage-provider-card-claude"]')
        ?.textContent,
    ).toContain('Sign in to see usage');

    const manage = codex?.querySelector<HTMLButtonElement>(
      '[data-testid="usage-provider-codex-account-proxy-manage"]',
    );
    // Names the Settings page it opens; the row already names it on screen.
    expect(manage?.textContent).toBe('Manage');
    expect(manage?.getAttribute('aria-label')).toBe(
      'Manage Multi-account proxy',
    );
    act(() => {
      manage?.click();
    });
    expect(openSettings).toHaveBeenCalledWith('account-proxy');

    act(() => {
      root.unmount();
    });
    useNavigationStore.setState({ openSettings: originalOpenSettings });
  });

  it('asks for an account instead of a sign-in when the proxy has none', () => {
    useAccountProxyStore.setState({
      status: { ...PROXY_STATUS, accounts: [] },
    });
    const { container, root } = render(
      <ProviderUsageCards
        nowMs={Date.now()}
        usage={usage}
        refreshingProviders={new Set()}
        refreshProviderUsage={jest.fn()}
        refreshProviderUsageDetails={jest.fn()}
      />,
    );

    const text =
      container.querySelector('[data-testid="usage-provider-card-codex"]')
        ?.textContent ?? '';
    expect(text).toContain('Add a Codex account to the account proxy.');
    expect(text).not.toContain('Sign in');

    act(() => {
      root.unmount();
    });
  });

  it('keeps the Claude add-account notice when the proxy has no accounts', () => {
    useAccountProxyStore.setState({
      status: {
        ...PROXY_STATUS,
        routeClaude: true,
        routeCodex: false,
        accounts: [],
      },
    });
    const { container, root } = render(
      <ProviderUsageCards
        nowMs={Date.now()}
        usage={usage}
        refreshingProviders={new Set()}
        refreshProviderUsage={jest.fn()}
        refreshProviderUsageDetails={jest.fn()}
      />,
    );
    const claude = container.querySelector(
      '[data-testid="usage-provider-card-claude"]',
    );
    expect(claude?.textContent).toContain(
      'Add a Claude account to the account proxy.',
    );
    expect(claude?.textContent).not.toContain('Sign in');
    act(() => root.unmount());
  });

  it('renders named authoritative proxy usage with freshness instead of legacy limits', () => {
    const accountWithUsage = {
      ...PROXY_STATUS.accounts[0],
      provider: 'claude',
      label: 'claude-proxy@example.com',
      planType: 'max',
      limits: [{ id: 'weekly' as const, usedPercent: 88, resetsAt: null }],
      usage: {
        rateLimits: [
          {
            limitId: 'seven_day_opus',
            limitName: '7-day Opus',
            primary: {
              usedPercent: 42,
              resetsAt: '2026-10-20T18:00:00.000Z',
              windowDurationMins: 10_080,
            },
          },
        ],
        source: 'live' as const,
        lastUpdatedAt: '2026-10-20T14:30:00.000Z',
      },
    };
    useAccountProxyStore.setState({
      status: {
        ...PROXY_STATUS,
        routeClaude: true,
        routeCodex: false,
        accounts: [accountWithUsage],
      },
      refreshing: false,
    });

    const { container, root } = render(
      <ProviderUsageCards
        nowMs={Date.parse('2026-10-20T15:00:00.000Z')}
        usage={usage}
        refreshingProviders={new Set()}
        refreshProviderUsage={jest.fn()}
        refreshProviderUsageDetails={jest.fn()}
      />,
    );
    const card = container.querySelector(
      '[data-testid="usage-provider-card-claude"]',
    );

    expect(
      card?.querySelectorAll('[data-testid="provider-account-usage"]'),
    ).toHaveLength(1);
    expect(card?.textContent).toContain('claude-proxy@example.com');
    expect(card?.textContent).toContain('7-day Opus');
    expect(card?.textContent).toContain('42%');
    expect(card?.textContent).toContain('Resets ');
    expect(card?.textContent).toContain('Updated ');
    expect(card?.textContent).not.toContain('Weekly limit');
    expect(card?.textContent).not.toContain('88%');
    expectReplayBlocksOnlyValue(container, 'claude-proxy@example.com');

    act(() => {
      root.unmount();
    });
  });

  it('keeps cached proxy usage with safe errors and uses legacy limits only when usage is absent', () => {
    const baseAccount = PROXY_STATUS.accounts[0];
    const cachedAccount = {
      ...baseAccount,
      provider: 'claude',
      authIndex: 'e2a8f640e2a8f640',
      label: 'cached@example.com',
      limits: [{ id: 'five-hour' as const, usedPercent: 90, resetsAt: null }],
      usage: {
        rateLimits: [
          {
            limitId: 'session',
            limitName: '5-hour window',
            primary: {
              usedPercent: 14,
              resetsAt: '2026-10-20T18:00:00.000Z',
            },
          },
        ],
        source: 'passive' as const,
        lastUpdatedAt: '2026-10-20T14:30:00.000Z',
        errorInfo: {
          kind: 'network' as const,
          detail: 'Bearer private-value',
        },
        retryAt: Date.parse('2026-10-20T16:00:00.000Z'),
      },
    };
    const emptyUsageAccount = {
      ...baseAccount,
      provider: 'claude',
      authIndex: 'b2f3c2d4b2f3c2d4',
      label: 'empty@example.com',
      limits: [{ id: 'weekly' as const, usedPercent: 88, resetsAt: null }],
      usage: { rateLimits: [], source: 'live' as const },
    };
    const legacyAccount = {
      ...baseAccount,
      provider: 'claude',
      authIndex: 'c3f3c2d4c3f3c2d4',
      label: 'legacy@example.com',
      limits: [{ id: 'weekly' as const, usedPercent: 40, resetsAt: null }],
    };
    const unavailableAccount = {
      ...baseAccount,
      provider: 'claude',
      authIndex: 'd4f3c2d4d4f3c2d4',
      label: 'unavailable@example.com',
      limits: [],
    };
    useAccountProxyStore.setState({
      status: {
        ...PROXY_STATUS,
        routeClaude: true,
        routeCodex: false,
        accounts: [
          cachedAccount,
          emptyUsageAccount,
          legacyAccount,
          unavailableAccount,
        ],
      },
      refreshing: false,
    });

    const { container, root } = render(
      <ProviderUsageCards
        nowMs={Date.parse('2026-10-20T15:00:00.000Z')}
        usage={usage}
        refreshingProviders={new Set()}
        refreshProviderUsage={jest.fn()}
        refreshProviderUsageDetails={jest.fn()}
      />,
    );
    const card = container.querySelector(
      '[data-testid="usage-provider-card-claude"]',
    );
    const accountSections = Array.from(
      card?.querySelectorAll('[data-testid="provider-account-usage"]') ?? [],
    );
    const sectionFor = (label: string): string =>
      accountSections.find((section) => section.textContent?.includes(label))
        ?.textContent ?? '';
    const cachedText = sectionFor('cached@example.com');
    const emptyUsageText = sectionFor('empty@example.com');
    const legacyText = sectionFor('legacy@example.com');
    const unavailableText = sectionFor('unavailable@example.com');

    expect(accountSections).toHaveLength(4);
    expect(cachedText).toContain('5-hour window');
    expect(cachedText).toContain('14%');
    expect(cachedText).toContain(
      'Check your connection, then try reaching Claude again.',
    );
    expect(cachedText).toContain('Showing last known usage.');
    expect(cachedText).toContain('Try again after ');
    expect(cachedText).not.toContain('Bearer private-value');
    expect(cachedText).not.toContain('90%');
    expect(emptyUsageText).toContain('Usage unavailable');
    expect(emptyUsageText).not.toContain('Weekly limit');
    expect(emptyUsageText).not.toContain('88%');
    expect(legacyText).toContain('Weekly limit');
    expect(legacyText).toContain('40%');
    expect(unavailableText).toContain('Usage unavailable');
    expect(unavailableText).not.toMatch(/(^|[^0-9])0%/);

    act(() => {
      root.unmount();
    });
  });

  describe('with the AI Credits routing mode', () => {
    const originalApiDescriptor = Object.getOwnPropertyDescriptor(
      window,
      'api',
    );

    afterEach(() => {
      if (originalApiDescriptor) {
        Object.defineProperty(window, 'api', originalApiDescriptor);
      } else {
        Reflect.deleteProperty(window, 'api');
      }
      invalidateAiCreditsUsageCache();
    });

    async function renderWithMode(
      aiCreditsRoutingMode: 'on' | 'on-quota',
    ): Promise<{ text: string; root: Root }> {
      invalidateAiCreditsUsageCache();
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          loadPreferences: jest
            .fn()
            .mockResolvedValue({ aiCreditsRoutingMode }),
        },
      });
      const { container, root } = render(
        <ProviderUsageCards
          nowMs={Date.parse('2026-10-15T12:00:00.000Z')}
          usage={usage}
          refreshingProviders={new Set()}
          refreshProviderUsage={jest.fn()}
          refreshProviderUsageDetails={jest.fn()}
        />,
      );
      await act(async () => {
        for (let index = 0; index < 6; index += 1) await Promise.resolve();
      });
      return {
        text:
          container.querySelector('[data-testid="usage-provider-card-codex"]')
            ?.textContent ?? '',
        root,
      };
    }

    it('keeps the native card while AI Credits route every session', async () => {
      // Main sends every session to AI Credits in `on`, so Codex does not
      // run through the account proxy.
      const { text, root } = await renderWithMode('on');
      expect(text).not.toContain('Account proxy');
      expect(text).not.toContain('runs through the account proxy');
      expect(text).not.toContain('sam@example.com');
      act(() => {
        root.unmount();
      });
    });

    it('keeps the proxy card for on-quota', async () => {
      const { text, root } = await renderWithMode('on-quota');
      expect(text).toContain('Account proxy');
      expect(text).toContain('sam@example.com');
      act(() => {
        root.unmount();
      });
    });
  });
});
