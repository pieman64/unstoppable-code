/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AgentProviderType,
  ChatTabUsage,
} from '@canopy/desktop-shared/types';
import {
  initAgentModels,
  initOpenCodeModels,
  initClaudeModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import { UsageIndicator } from '../UsageIndicator';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { resetUsageRefreshOnOpen } from '../usageRefreshOnOpen';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';

class TestResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  value: TestResizeObserver,
});

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
  writable: true,
});

const BASE_USAGE: ChatTabUsage = {
  contextTokens: 64_000,
  contextWindow: 200_000,
  maxOutputTokens: 0,
  totalCostUsd: 0,
  inputTokens: 100,
  outputTokens: 20,
  cacheReadInputTokens: 10,
  cacheCreationInputTokens: 0,
  durationMs: 0,
  durationApiMs: 0,
  numTurns: 1,
  model: 'gpt-6-sol',
};

describe('UsageIndicator', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    initClaudeModels([
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', contextWindow: 200_000 },
    ]);
    initCodexModels([
      { id: 'gpt-6-sol', label: 'GPT-6 Sol', contextWindow: 400_000 },
    ]);
  });

  const refreshProviderUsageDetails = jest.fn<Promise<void>, [string]>();

  beforeEach(() => {
    resetUsageRefreshOnOpen();
    refreshProviderUsageDetails.mockReset();
    refreshProviderUsageDetails.mockResolvedValue(undefined);
    useObservabilityStore.setState({
      initialized: true,
      usage: { updatedAt: '2026-09-17T00:00:00Z', providers: [] },
      refreshingProviders: new Set(),
      refreshProviderUsageDetails,
    });
    const snapshot = useFeatureFlagsStore.getState().snapshot;
    useFeatureFlagsStore.setState({
      snapshot: {
        ...snapshot,
        values: {
          ...snapshot.values,
          [CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key]: true,
          [CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness.key]: true,
        },
      },
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderAndOpen(
    usage: ChatTabUsage | undefined,
    isCodex: boolean,
    model?: string,
    isCursor?: boolean,
    providerType?: AgentProviderType,
  ): Promise<void> {
    act(() => {
      root.render(
        <UsageIndicator
          usage={usage}
          isCodex={isCodex}
          model={model}
          isCursor={isCursor}
          providerType={providerType}
        />,
      );
    });
    const button = container.querySelector('button');
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('Expected usage indicator button');
    }
    await act(async () => {
      button.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );

      await Promise.resolve();
    });
  }

  const CLAUDE_PROVIDER_USAGE = {
    updatedAt: '2026-09-17T00:00:00Z',
    providers: [
      {
        provider: 'claude' as const,
        authState: 'authenticated' as const,
        hasRemainingLimits: true,
        accountEmail: 'claude@example.com',
        subscriptionLabel: 'Claude Max 20x',
        rateLimits: [
          {
            limitId: 'five_hour',
            limitName: '5-hour limit',
            primary: { usedPercent: 5, resetsAt: '2099-10-01T00:00:00Z' },
          },
          {
            limitId: 'seven_day',
            limitName: 'Weekly · all models',
            primary: { usedPercent: 2, resetsAt: '2099-10-02T00:00:00Z' },
          },
        ],
      },
    ],
  };

  it('names the model that answered, even when it is the one selected', async () => {
    // The usage ring no longer sits beside the model picker, so the popover
    // names the model itself, as it did before the composer moved.
    await renderAndOpen(BASE_USAGE, true, 'gpt-6-sol');
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>(
          '[data-testid="usage-indicator-context"]',
        )
        ?.click();

      await Promise.resolve();
    });
    expect(
      document.body.querySelector('[data-testid="usage-indicator-details"]')
        ?.textContent,
    ).toContain('ModelGPT-6 Sol');
  });

  it('shows Claude plan limits for a chat on the Claude sign-in', async () => {
    useObservabilityStore.setState({ usage: CLAUDE_PROVIDER_USAGE });
    await renderAndOpen(
      { ...BASE_USAGE, model: 'claude-sonnet-4-6' },
      false,
      'claude-sonnet-4-6',
    );
    const account = document.querySelector(
      '[data-testid="usage-indicator-account"]',
    );
    expect(account?.textContent).toContain('Claude Max 20x');
    expect(account?.textContent).toContain('5-hour limit');
    expect(account?.textContent).toContain('Weekly · all models');
    expect(account?.textContent).toContain('5%');
    // Usage refreshes as the popover opens; there is no refresh button.
    expect(
      account?.querySelector('[aria-label="Refresh Claude account usage"]'),
    ).toBeNull();
  });

  it('refreshes plan limits as the popover opens, at most every 30 seconds', async () => {
    jest.useFakeTimers();
    try {
      useObservabilityStore.setState({ usage: CLAUDE_PROVIDER_USAGE });
      const usage = { ...BASE_USAGE, model: 'claude-sonnet-4-6' };
      await renderAndOpen(usage, false, 'claude-sonnet-4-6');
      expect(refreshProviderUsageDetails).toHaveBeenCalledTimes(1);
      expect(refreshProviderUsageDetails).toHaveBeenCalledWith('claude');

      // Closing and reopening straight away reuses the fresh numbers.
      const toggle = async (): Promise<void> => {
        await act(async () => {
          container.querySelector('button')?.click();

          await Promise.resolve();
        });
      };
      await toggle();
      await toggle();
      expect(refreshProviderUsageDetails).toHaveBeenCalledTimes(1);

      act(() => {
        jest.advanceTimersByTime(30_000);
      });
      await toggle();
      await toggle();
      expect(refreshProviderUsageDetails).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('asks the live session for its context breakdown as the popover opens', async () => {
    const getContextUsage = jest.fn().mockResolvedValue({
      categories: [{ name: 'Messages', tokens: 64_000, kind: 'used' }],
      totalTokens: 64_000,
      maxTokens: 200_000,
      percentage: 32,
    });
    const originalApi = window.api;
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...originalApi,
        chat: { ...originalApi?.chat, getContextUsage },
      },
    });
    try {
      act(() => {
        root.render(
          <UsageIndicator
            usage={{ ...BASE_USAGE, model: 'claude-sonnet-4-6' }}
            isCodex={false}
            model="claude-sonnet-4-6"
            contextTarget={{
              projectId: 'project-a',
              worktreeId: 'worktree-a',
              chatId: 'chat-a',
            }}
          />,
        );
      });
      expect(getContextUsage).not.toHaveBeenCalled();
      await act(async () => {
        container.querySelector('button')?.click();
        // Let the breakdown request resolve inside the act scope.
        await Promise.resolve();
      });
      expect(getContextUsage).toHaveBeenCalledWith({
        projectId: 'project-a',
        worktreeId: 'worktree-a',
        chatId: 'chat-a',
      });
      expect(
        document.body.querySelector(
          '[aria-label="Context window by category"]',
        ),
      ).not.toBeNull();
    } finally {
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: originalApi,
      });
    }
  });

  it('counts a Codex credit balance instead of pricing it', async () => {
    useObservabilityStore.setState({
      usage: {
        updatedAt: '2026-09-17T00:00:00Z',
        providers: [
          {
            provider: 'codex',
            authState: 'authenticated',
            hasRemainingLimits: true,
            subscriptionLabel: 'ChatGPT Pro',
            rateLimits: [
              {
                limitId: 'codex',
                primary: {
                  usedPercent: 63,
                  resetsAt: '2099-10-01T00:00:00Z',
                  windowDurationMins: 10_080,
                },
                // Codex's balance is a credit count in the shared slot.
                credits: { remainingUsd: 62_500 },
              },
            ],
          },
        ],
      },
    });
    await renderAndOpen(BASE_USAGE, true, 'gpt-5.4');
    const account = document.querySelector(
      '[data-testid="usage-indicator-account"]',
    );
    expect(account?.textContent).toContain('62,500 credits left');
    expect(account?.textContent).not.toContain('$62');
  });

  it('points a signed-out Codex chat at signing in', async () => {
    useObservabilityStore.setState({
      usage: {
        updatedAt: '2026-09-17T00:00:00Z',
        providers: [
          {
            provider: 'codex',
            authState: 'unauthenticated',
            hasRemainingLimits: false,
          },
        ],
      },
    });
    await renderAndOpen(BASE_USAGE, true, 'gpt-5.4');
    expect(
      document.querySelector('[data-testid="usage-indicator-account"]')
        ?.textContent,
    ).toContain('Sign in to Codex to see plan limits.');
  });

  it('omits plan limits for a chat routed through AI Credits', async () => {
    useObservabilityStore.setState({ usage: CLAUDE_PROVIDER_USAGE });
    act(() => {
      root.render(
        <UsageIndicator
          usage={{ ...BASE_USAGE, model: 'claude-sonnet-4-6' }}
          isCodex={false}
          model="claude-sonnet-4-6"
          aiCreditsRouted
        />,
      );
    });
    await act(async () => {
      container.querySelector('button')?.click();

      await Promise.resolve();
    });
    expect(
      document.querySelector('[data-testid="usage-indicator-popover"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="usage-indicator-account"]'),
    ).toBeNull();
  });

  it('does not link OpenCode reports to the unsupported account usage page', async () => {
    await renderAndOpen(
      { ...BASE_USAGE, model: 'opencode:fixture%2Fmodel' },
      false,
    );
    expect(
      document.querySelector('[data-testid="usage-indicator-popover"]')
        ?.textContent,
    ).toContain('Account limits and billed charges are unavailable.');
    expect(
      document.querySelector('[data-testid="usage-indicator-see-details"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="usage-indicator-account"]'),
    ).toBeNull();
  });

  it('shows the OpenCode report for a saved Agent without an account details link', async () => {
    const baseModel = 'opencode:fixture%2Fmodel';
    const agentId = 'agent_model_usage_reviewer';
    initOpenCodeModels([
      {
        id: baseModel,
        rawModelId: 'fixture/model',
        label: 'Fixture model',
        supportsVision: false,
        supportedThinkingLevels: [],
      },
    ]);
    initAgentModels([
      {
        id: agentId,
        name: 'Usage reviewer',
        baseModel,
        instructions: '',
        pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
        createdAt: '2026-10-16T00:00:00Z',
        updatedAt: '2026-10-16T00:00:00Z',
        available: true,
      },
    ]);
    try {
      await renderAndOpen(
        {
          ...BASE_USAGE,
          model: baseModel,
          opencodeReportedUsage: {
            turn: {
              inputTokens: 100,
              outputTokens: 20,
              reasoningTokens: 12,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              estimatedCostUsd: 0.75,
            },
          },
        },
        false,
        agentId,
      );
      const popover = document.querySelector(
        '[data-testid="usage-indicator-popover"]',
      );
      expect(popover?.textContent).toContain('Latest reported turn');
      expect(popover?.textContent).toContain('Reasoning');
      expect(popover?.textContent).toContain('$0.75');
      expect(
        document.querySelector('[data-testid="usage-indicator-see-details"]'),
      ).toBeNull();
    } finally {
      initAgentModels([]);
      initOpenCodeModels([]);
    }
  });

  it('uses the selected OpenCode harness for a shared model identity', async () => {
    await renderAndOpen(
      undefined,
      false,
      'claude-sonnet-4-6',
      false,
      'opencode',
    );
    expect(
      document.querySelector('[data-testid="usage-indicator-popover"]')
        ?.textContent,
    ).toContain('OpenCode has not reported token usage');
    expect(
      document.querySelector('[data-testid="usage-indicator-see-details"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="usage-indicator-account"]'),
    ).toBeNull();
  });

  it('opens the Usage page from the detailed breakdown link', async () => {
    const navigate = jest.fn();
    const original = useNavigationStore.getState().navigate;
    useNavigationStore.setState({ navigate });
    try {
      await renderAndOpen(BASE_USAGE, true, 'gpt-5.4');
      await act(async () => {
        document
          .querySelector<HTMLButtonElement>(
            '[data-testid="usage-indicator-see-details"]',
          )
          ?.click();

        await Promise.resolve();
      });
      expect(navigate).toHaveBeenCalledWith('usage');
      expect(
        document.querySelector('[data-testid="usage-indicator-popover"]'),
      ).toBeNull();
    } finally {
      useNavigationStore.setState({ navigate: original });
    }
  });

  it('shows cumulative Copilot tokens without inventing a response cost', async () => {
    await renderAndOpen(
      { ...BASE_USAGE, model: 'copilot:gpt-5', cacheCreationInputTokens: 5 },
      false,
    );
    await act(async () => {
      await Promise.resolve();
    });
    const popup = document.querySelector(
      '[data-testid="usage-indicator-popover"]',
    );
    expect(popup?.textContent).toContain('GitHub Copilot');
    for (const [label, value] of [
      ['Input', '100'],
      ['Output', '20'],
      ['Cache read', '10'],
      ['Cache write', '5'],
    ]) {
      const row = Array.from(popup?.querySelectorAll('dt') ?? []).find(
        (element) => element.textContent === label,
      )?.parentElement;
      expect(row?.textContent).toBe(`${label}${value}`);
    }
    expect(popup?.textContent).not.toContain('Response tokens');
    expect(popup?.textContent).not.toContain('$0.0000');
    expect(popup?.textContent).not.toContain('Context');
  });

  it('distinguishes unlimited Copilot allowance from unreported usage in the chat popup', async () => {
    useObservabilityStore.setState({
      usage: {
        updatedAt: '2026-10-07T00:00:00Z',
        providers: [
          {
            provider: 'copilot',
            authState: 'authenticated',
            hasRemainingLimits: true,
            rateLimits: [
              {
                limitId: 'premium_interactions',
                limitName: 'Premium requests',
                primary: { unlimited: true },
              },
            ],
          },
        ],
      },
    });
    await renderAndOpen({ ...BASE_USAGE, model: 'copilot:gpt-5' }, false);
    const account = document.querySelector(
      '[data-testid="usage-indicator-account"]',
    );
    expect(account?.textContent).toContain('Premium requests');
    expect(account?.textContent).toContain('Unlimited');
    expect(account?.textContent).not.toContain('0%');
    act(() =>
      useObservabilityStore.setState({
        usage: {
          updatedAt: '2026-10-07T00:01:00Z',
          providers: [
            {
              provider: 'copilot',
              authState: 'authenticated',
              hasRemainingLimits: false,
              rateLimits: [
                {
                  limitId: 'premium_interactions',
                  limitName: 'Premium requests',
                  primary: {},
                },
              ],
            },
          ],
        },
      }),
    );
    expect(account?.textContent).not.toContain('Unlimited');
    expect(account?.textContent).not.toContain('0%');
  });

  it('uses the shared Copilot allowance and clears it when the account disconnects', async () => {
    useObservabilityStore.setState({
      usage: {
        updatedAt: '2026-10-07T00:00:00Z',
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
                primary: { usedPercent: 25, resetsAt: '2099-11-01T00:00:00Z' },
              },
            ],
          },
        ],
      },
    });
    await renderAndOpen({ ...BASE_USAGE, model: 'copilot:gpt-5' }, false);
    const account = document.querySelector(
      '[data-testid="usage-indicator-account"]',
    );
    expect(account?.textContent).toContain('copilot-fixture');
    expect(account?.textContent).toContain('Premium requests');
    expect(account?.textContent).toContain('25%');
    expect(refreshProviderUsageDetails).toHaveBeenCalledWith('copilot');
    act(() =>
      useObservabilityStore.setState({
        usage: {
          updatedAt: '2026-10-07T00:01:00Z',
          providers: [
            {
              provider: 'copilot',
              authState: 'unauthenticated',
              hasRemainingLimits: false,
            },
          ],
        },
      }),
    );
    expect(account?.textContent).toContain(
      'Connect Copilot to see account usage.',
    );
    expect(account?.textContent).not.toContain('copilot-fixture');
    expect(account?.textContent).not.toContain('25%');
    act(() =>
      useObservabilityStore.setState({
        usage: { updatedAt: '2026-10-07T00:02:00Z', providers: [] },
      }),
    );
    expect(account?.textContent).toContain(
      'Connect Copilot to see account usage.',
    );
  });

  it('keeps unreported Copilot cost and context absent before the first turn', async () => {
    await renderAndOpen(undefined, false, 'copilot:gpt-5');
    await act(async () => {
      await Promise.resolve();
    });
    const popup = document.querySelector(
      '[data-testid="usage-indicator-popover"]',
    );
    expect(popup?.textContent).toContain(
      'Usage appears after the first reply.',
    );
    expect(popup?.textContent).not.toContain('$0.0000');
    expect(popup?.textContent).not.toContain('Context');
  });

  it('shows Cursor account allowance alongside response tokens without inventing context', async () => {
    useObservabilityStore.setState({
      usage: {
        updatedAt: '2026-09-17T00:00:00Z',
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
                primary: { usedPercent: 25, resetsAt: '2099-10-01T00:00:00Z' },
                credits: { totalUsd: 20, remainingUsd: 15 },
              },
            ],
          },
        ],
      },
    });
    await renderAndOpen(
      {
        ...BASE_USAGE,
        model: 'cursor-default',
        cursorReportedUsage: { inputTokens: 12000, outputTokens: 800 },
      },
      false,
    );
    const account = document.querySelector(
      '[data-testid="usage-indicator-account"]',
    );
    // Cursor's bare tier is named with the product.
    expect(account?.textContent).toContain('Cursor Pro');
    expect(
      account?.querySelector('[title="cursor@example.com"]'),
    ).not.toBeNull();
    expect(account?.textContent).toContain('25%');
    expect(account?.textContent).toContain('$15.00');
    expect(account?.textContent).toContain('$20.00');
    expect(account?.textContent).toContain('Resets');
    expect(document.body.textContent).toContain('Response tokens');
    expect(document.body.textContent).toContain('12.0k');
    expect(document.body.textContent).toContain('800');
    expect(document.body.textContent).not.toContain('200.0k');
    act(() => {
      const snapshot = useFeatureFlagsStore.getState().snapshot;
      useFeatureFlagsStore.setState({
        snapshot: {
          ...snapshot,
          values: {
            ...snapshot.values,
            [CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key]: false,
          },
        },
      });
    });
    expect(
      document.querySelector('[data-testid="usage-indicator-account"]'),
    ).toBeNull();
    expect(document.body.textContent).toContain('12.0k');
  });

  it('does not show stale account limits after the account disconnects', async () => {
    useObservabilityStore.setState({
      usage: {
        updatedAt: '2026-09-17T00:00:00Z',
        providers: [
          {
            provider: 'cursor',
            authState: 'unauthenticated',
            hasRemainingLimits: false,
            accountEmail: 'old@example.com',
            rateLimits: [
              { limitId: 'cursor-plan', primary: { usedPercent: 95 } },
            ],
          },
        ],
      },
    });
    await renderAndOpen(undefined, false, 'cursor-default');
    expect(document.body.textContent).toContain(
      'Connect Cursor to see account usage.',
    );
    expect(document.body.textContent).not.toContain('old@example.com');
    expect(document.body.textContent).not.toContain('95.0%');
    expect(document.body.textContent).toContain(
      'Cursor has not reported token usage.',
    );
  });

  it.each([
    ['auth', 'Connect Cursor to see account usage.'],
    ['unsupported', 'Cursor has not provided usage details for this account.'],
    ['network', 'Cursor account usage is unavailable.'],
    ['service', 'Cursor account usage is unavailable.'],
    ['unknown', 'Cursor account usage is unavailable.'],
  ] as const)(
    'shows actionable guidance for %s account errors',
    async (kind, message) => {
      useObservabilityStore.setState({
        usage: {
          updatedAt: '2026-09-17T00:00:00Z',
          providers: [
            {
              provider: 'cursor',
              authState: 'authenticated',
              accountEmail: 'previous@example.com',
              hasRemainingLimits: false,
              errorInfo: { kind },
              rateLimits: [
                { limitId: 'cursor-plan', primary: { usedPercent: 95 } },
              ],
            },
          ],
        },
      });
      await renderAndOpen(undefined, false, 'cursor-default');
      const account = document.querySelector(
        '[data-testid="usage-indicator-account"]',
      );
      expect(account?.textContent).toContain(message);
      expect(account?.textContent).not.toContain('95%');
      if (kind === 'auth') {
        expect(account?.textContent).not.toContain('previous@example.com');
      }
      // A failed read offers a retry; signing in or an unsupported account
      // cannot be fixed by fetching again.
      const retry = account?.querySelector<HTMLButtonElement>(
        '[data-testid="usage-indicator-retry"]',
      );
      if (kind === 'auth' || kind === 'unsupported') {
        expect(retry ?? null).toBeNull();
      } else {
        expect(retry?.textContent).toBe('Try again');
        refreshProviderUsageDetails.mockClear();
        await act(async () => {
          retry?.click();
          await Promise.resolve();
        });
        expect(refreshProviderUsageDetails).toHaveBeenCalledWith('cursor');
      }
      expect(document.body.textContent).toContain(
        'Cursor has not reported token usage.',
      );
    },
  );

  it('waits until the popup opens before initializing account data', async () => {
    const initialize = jest
      .fn<Promise<void>, []>()
      .mockResolvedValue(undefined);
    const original = useObservabilityStore.getState().initialize;
    useObservabilityStore.setState({ initialize });
    try {
      act(() =>
        root.render(
          <UsageIndicator
            usage={undefined}
            isCodex={false}
            isCursor
            model="cursor-default"
          />,
        ),
      );
      expect(initialize).not.toHaveBeenCalled();
      const button = container.querySelector('button');
      if (!button) throw new Error('Missing usage trigger');
      await act(async () => {
        button.click();
        await Promise.resolve();
      });
      expect(initialize).toHaveBeenCalledTimes(1);
      await act(async () => {
        button.click();
        await Promise.resolve();
      });
      expect(
        document.querySelector('[data-testid="usage-indicator-account"]'),
      ).toBeNull();
    } finally {
      useObservabilityStore.setState({ initialize: original });
    }
  });

  it('shows reported Codex context usage in the composer popover', async () => {
    await renderAndOpen(BASE_USAGE, true);

    expect(document.body.textContent).toContain('Context');
    expect(document.body.textContent).toContain('64.0k / 200.0k');
    expect(document.body.textContent).toContain('64.0k / 200.0k (32%)');
  });

  it('explains unreported Cursor usage without displaying invented zero cost or tokens', async () => {
    await renderAndOpen(undefined, false, 'cursor-default');
    expect(document.body.textContent).toContain(
      'Cursor has not reported token usage.',
    );
    expect(document.body.textContent).not.toContain('Cost');
    expect(document.body.textContent).not.toContain('Cache read');
    expect(document.body.textContent).not.toContain(
      'Usage appears after the first reply.',
    );
  });

  it('shows only reported Cursor response counters and omits unavailable capacity and billing', async () => {
    const usage = {
      ...BASE_USAGE,
      model: 'cursor-default',
      cursorReportedUsage: {
        inputTokens: 12000,
        outputTokens: 800,
        cacheReadTokens: 9000,
      },
    };
    await renderAndOpen(usage, false);
    expect(document.body.textContent).toContain('Latest reported response');
    expect(document.body.textContent).toContain('12.0k');
    expect(document.body.textContent).toContain('800');
    expect(document.body.textContent).toContain('9.0k');
    expect(document.body.textContent).not.toContain('Cache write');
    expect(document.body.textContent).not.toContain('200.0k');
    expect(document.body.textContent).not.toContain('$0.0000');
  });

  it('uses the selected Cursor harness when the model has a shared identity', async () => {
    await renderAndOpen(undefined, false, 'claude-sonnet-4-6', true);
    expect(document.body.textContent).toContain(
      'Cursor has not reported token usage.',
    );
    expect(document.body.textContent).not.toContain('200.0k');
    expect(document.body.textContent).not.toContain('$0.0000');
  });

  it('does not present the synthetic default as Codex context data', async () => {
    await renderAndOpen({ ...BASE_USAGE, contextTokens: 0 }, true);

    expect(document.body.textContent).not.toContain('Context');
    expect(document.body.textContent).toContain('Turns');
  });

  it('draws no empty context bar when nothing is counted in the window', async () => {
    await renderAndOpen({ ...BASE_USAGE, contextTokens: 0 }, false);

    expect(document.body.textContent).not.toContain('Context');
    expect(document.body.textContent).toContain('Turns1');
  });

  // CAN-2799: after a model/session switch the tab can have no `usage` yet.
  // The meter must stay usable — not a dead 0% ring with a popover that
  // never opens.
  it('draws the context row with an empty bar when usage is not yet known', async () => {
    await renderAndOpen(undefined, false, 'claude-sonnet-4-6');

    // The row at zero over an empty bar, sized to the model's window.
    expect(
      document.querySelector('[data-testid="usage-indicator-context-empty"]')
        ?.textContent,
    ).toBe('Context0');
    expect(document.body.textContent).not.toContain(
      'Usage appears after the first reply.',
    );
  });

  it('opens the popover without presenting a synthetic context window as Codex data', async () => {
    await renderAndOpen(undefined, true, 'gpt-6-sol');

    expect(
      document.querySelector('[data-testid="usage-indicator-context-empty"]')
        ?.textContent,
    ).toBe('Context0');
    expect(document.body.textContent).not.toMatch(/\d\.\dk|\d\.\dM/);
    // Before the first reply every figure is 0, so none show.
    expect(document.body.textContent).not.toContain('Turns');
  });

  it('opens the popover even when neither usage nor a model is known', async () => {
    await renderAndOpen(undefined, false);

    expect(document.body.textContent).not.toContain('Context');
    expect(document.body.textContent).toContain(
      'Usage appears after the first reply.',
    );
  });

  it('does not show the empty-usage hint once a reply has been counted', async () => {
    await renderAndOpen(BASE_USAGE, false);

    expect(document.body.textContent).not.toContain(
      'Usage appears after the first reply.',
    );
  });
});
