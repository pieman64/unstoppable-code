/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
  type ChatTabUsage,
} from '@canopy/desktop-shared/types';
import { createEmptyCostTotals } from '@canopy/protocol/cost-view';
import type {
  AccountProxySessionAccount,
  AccountProxyStatus,
} from '@canopy/desktop-shared/types/account-proxy';
import type { CostChatRow } from '@canopy/protocol/cost-view';
import { useAccountProxyStore } from '@/stores/accountProxyStore';
import { invalidateAiCreditsUsageCache } from '@/hooks/useAiCreditsUsage';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  resetRendererBillingLaneForTests,
  setRendererBillingLaneAvailability,
} from '@/stores/billingLaneRuntime';
import {
  PROXY_USAGE_EXPANDED_STORAGE_KEY,
  useProxyUsageExpandedStore,
} from '@/stores/proxyUsageExpandedStore';
import { UsageIndicator } from '../UsageIndicator';

const mockOpenSessionBreakdownPanel = jest.fn();
jest.mock('@/lib/cost/open-cost-panels', () => ({
  openSessionBreakdownPanel: (...args: unknown[]): unknown =>
    mockOpenSessionBreakdownPanel(...args),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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

const contextTarget = {
  projectId: 'project-a',
  worktreeId: 'worktree-a',
  chatId: 'chat-a',
};

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
  routeClaude: true,
  routeCodex: true,
  refreshedAt: 1,
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

describe('UsageIndicator cost preview', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalApi: Window['api'];
  let originalNavigate: ReturnType<
    typeof useNavigationStore.getState
  >['navigate'];
  const navigate = jest.fn();

  function installCostApi(chat: Partial<CostChatRow> = {}): {
    readonly getChat: jest.Mock;
  } {
    const empty = createEmptyCostTotals();
    const totals = {
      ...empty,
      usd: 1.23,
      bySource: { ...empty.bySource, chat: 1.23 },
    };
    const getChat = jest.fn().mockResolvedValue({
      status: 'ok',
      value: {
        kind: 'summary',
        chat: {
          chatId: contextTarget.chatId,
          label: 'Cost preview chat',
          state: 'open',
          totals,
          turnCount: 1,
          lastActivityAt: '2026-10-09T12:00:00.000Z',
          running: false,
          models: ['GPT'],
          ...chat,
        },
      },
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...window.api,
        cost: {
          getChat,
          getScope: jest.fn(),
          getPipelineRun: jest.fn(),
          refresh: jest.fn().mockResolvedValue({
            status: 'ok',
            value: {
              ran: true,
              updatedAt: '2026-10-09T12:00:00.000Z',
              revision: 1,
            },
          }),
          watchScope: jest.fn(() => (): void => undefined),
          onUpdated: jest.fn(() => (): void => undefined),
        },
      },
    });
    return { getChat };
  }

  async function clickSeeDetails(): Promise<void> {
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>(
          '[data-testid="usage-indicator-see-details"]',
        )
        ?.click();
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
    });
  }

  function renderUsage(
    target?: typeof contextTarget,
    accountProxyRouted?: boolean,
    providerType: 'claude' | 'codex' = 'codex',
  ): void {
    act(() => {
      root.render(
        <UsageIndicator
          usage={BASE_USAGE}
          isCodex={providerType === 'codex'}
          providerType={providerType}
          accountProxyRouted={accountProxyRouted}
          {...(target === undefined ? {} : { contextTarget: target })}
        />,
      );
    });
  }

  function installSessionAccounts(
    accounts: readonly AccountProxySessionAccount[],
  ): jest.Mock {
    const sessionAccounts = jest.fn().mockResolvedValue(accounts);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...window.api,
        accountProxy: {
          sessionAccounts,
          onChanged: jest.fn(() => (): void => undefined),
          status: jest
            .fn()
            .mockImplementation(() =>
              Promise.resolve(
                useAccountProxyStore.getState().status ?? PROXY_STATUS,
              ),
            ),
        },
      },
    });
    return sessionAccounts;
  }

  function proxySectionText(): string {
    return (
      document.body.querySelector(
        '[data-testid="usage-indicator-proxy-accounts"]',
      )?.textContent ?? ''
    );
  }

  async function openPopover(): Promise<void> {
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="usage-indicator"]')
        ?.click();
      for (let index = 0; index < 12; index += 1) await Promise.resolve();
    });
  }

  beforeEach(() => {
    mockOpenSessionBreakdownPanel.mockReset();
    mockOpenSessionBreakdownPanel.mockResolvedValue({ status: 'placed' });
    navigate.mockReset();
    originalApi = window.api;
    originalNavigate = useNavigationStore.getState().navigate;
    useNavigationStore.setState({ navigate });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: originalApi,
    });
    useNavigationStore.setState({ navigate: originalNavigate });
    useAccountProxyStore.setState({ status: null });
    invalidateAiCreditsUsageCache();
    window.localStorage.clear();
    useProxyUsageExpandedStore.setState({
      expanded: {},
      sectionCollapsed: false,
    });
    resetRendererBillingLaneForTests();
  });

  it('reads the stored chat row only when opened and links to its breakdown', async () => {
    const { getChat } = installCostApi();
    renderUsage(contextTarget);

    expect(getChat).not.toHaveBeenCalled();
    await openPopover();

    expect(getChat).toHaveBeenCalledWith({
      scope: {
        kind: 'entry',
        projectId: contextTarget.projectId,
        worktreeId: contextTarget.worktreeId,
      },
      chatId: contextTarget.chatId,
      detail: 'summary',
    });
    expect(
      document.body.querySelector('[data-testid="usage-indicator-cost"]'),
    ).not.toBeNull();
    expect(
      document.body.querySelector('[data-testid="usage-indicator-cost"]')
        ?.textContent,
    ).toContain('1.23');

    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>(
          '[data-testid="usage-indicator-see-details"]',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(mockOpenSessionBreakdownPanel).toHaveBeenCalledWith(
      {
        projectId: contextTarget.projectId,
        worktreeId: contextTarget.worktreeId,
      },
      contextTarget.chatId,
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps Change review without a context target on the Usage page', async () => {
    const { getChat } = installCostApi();
    renderUsage();
    await openPopover();

    expect(getChat).not.toHaveBeenCalled();
    expect(
      document.body.querySelector('[data-testid="usage-indicator-cost"]'),
    ).toBeNull();
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>(
          '[data-testid="usage-indicator-see-details"]',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(navigate).toHaveBeenCalledWith('usage');
    expect(mockOpenSessionBreakdownPanel).not.toHaveBeenCalled();
  });

  it('opens the Usage page from a composer whose scope keeps no cost', async () => {
    const { getChat } = installCostApi();
    renderUsage({
      projectId: PIPELINE_EDITOR_PROJECT_ID,
      worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
      chatId: 'pipeline-assistant-chat',
    });
    await openPopover();

    expect(getChat).not.toHaveBeenCalled();
    expect(
      document.body.querySelector('[data-testid="usage-indicator-cost"]'),
    ).toBeNull();
    await clickSeeDetails();

    expect(navigate).toHaveBeenCalledWith('usage');
    expect(mockOpenSessionBreakdownPanel).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'failed'] as const)(
    'falls back to the Usage page when the breakdown open is %s',
    async (status) => {
      installCostApi();
      mockOpenSessionBreakdownPanel.mockResolvedValue({ status });
      renderUsage(contextTarget);
      await openPopover();
      await clickSeeDetails();

      expect(mockOpenSessionBreakdownPanel).toHaveBeenCalledTimes(1);
      expect(navigate).toHaveBeenCalledWith('usage');
    },
  );

  it('falls back to the Usage page when the breakdown open throws', async () => {
    installCostApi();
    mockOpenSessionBreakdownPanel.mockRejectedValue(new Error('no layout'));
    renderUsage(contextTarget);
    await openPopover();
    await clickSeeDetails();

    expect(navigate).toHaveBeenCalledWith('usage');
  });

  it('shows the proxy accounts that served the chat instead of the plan', async () => {
    const openSettings = jest.fn();
    useNavigationStore.setState({ openSettings });
    useAccountProxyStore.setState({ status: PROXY_STATUS });
    installCostApi({
      turnCount: 4,
      proxyAccounts: [
        {
          accountKey: 'proxy:conn-1:a1f3c2d4a1f3c2d4',
          label: 'sam@example.com',
          provider: 'codex',
          turnShare: 3,
          requestCount: 9,
          usd: 0.31,
          notPricedCount: 0,
        },
        {
          accountKey: 'proxy:conn-1:e2a8f640e2a8f640',
          label: '',
          provider: 'codex',
          turnShare: 1,
          requestCount: 2,
          usd: 0.1,
          notPricedCount: 0,
        },
      ],
    });
    renderUsage(contextTarget);
    await openPopover();
    act(() => {
      document.body
        .querySelectorAll<HTMLButtonElement>(
          '[data-testid="usage-indicator-account-toggle"]',
        )
        .forEach((button) => button.click());
    });

    const section = document.body.querySelector(
      '[data-testid="usage-indicator-proxy-accounts"]',
    );
    expect(section).not.toBeNull();
    const text = section?.textContent ?? '';
    expect(text).toContain('sam@example.com');
    expect(text).toContain('75% of turns');
    expect(text).toContain('5-hour limit');
    // An account the last list did not name keeps a generic name.
    expect(text).toContain('Codex account');
    expect(text).toContain('25% of turns');
    await act(async () => {
      section
        ?.querySelector<HTMLButtonElement>('button[aria-label^="Manage"]')
        ?.click();
      await Promise.resolve();
    });
    expect(openSettings).toHaveBeenCalledWith('account-proxy');
  });

  it('loads live proxy quotas only when the composer popover opens', async () => {
    useAccountProxyStore.setState({ status: PROXY_STATUS });
    installCostApi();
    installSessionAccounts([]);
    const accountProxyApi = window.api.accountProxy;
    if (accountProxyApi === undefined) {
      throw new Error('The account proxy API was not installed');
    }
    const readStatus = jest.spyOn(accountProxyApi, 'status');
    renderUsage(contextTarget, true);
    expect(readStatus).not.toHaveBeenCalledWith({
      refresh: true,
      refreshUsage: true,
    });
    await openPopover();
    expect(readStatus).toHaveBeenCalledWith({
      refresh: true,
      refreshUsage: true,
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="usage-indicator"]')
        ?.click();
      await Promise.resolve();
    });
    await openPopover();
    expect(readStatus).toHaveBeenCalledTimes(2);
  });

  it('uses named usage windows and curated error status for a Claude proxy account', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...window.api,
        chat: { getContextUsage: jest.fn().mockResolvedValue(null) },
      },
    });
    const claudeAccount = {
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
            credits: { usedUsd: 1.25, remainingUsd: 8.75, totalUsd: 10 },
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
    const codexAccount = {
      ...PROXY_STATUS.accounts[0],
      authIndex: 'b2f3c2d4b2f3c2d4',
      label: 'codex-proxy@example.com',
      limits: [{ id: 'five-hour' as const, usedPercent: 64, resetsAt: null }],
      usage: {
        rateLimits: [
          {
            limitId: 'codex',
            limitName: 'Codex',
            primary: {
              usedPercent: 22,
              resetsAt: '2026-10-20T18:00:00.000Z',
              windowDurationMins: 300,
            },
            credits: { remainingUsd: 12_500 },
          },
        ],
        source: 'live' as const,
        lastUpdatedAt: '2026-10-20T14:30:00.000Z',
      },
    };
    useAccountProxyStore.setState({
      status: {
        ...PROXY_STATUS,
        accounts: [claudeAccount, codexAccount],
        routeClaude: true,
        routeCodex: false,
      },
    });
    installCostApi({
      turnCount: 1,
      proxyAccounts: [
        {
          accountKey: 'proxy:conn-1:a1f3c2d4a1f3c2d4',
          label: 'claude-proxy@example.com',
          provider: 'claude',
          turnShare: 1,
          requestCount: 3,
          usd: 0.1,
          notPricedCount: 0,
        },
        {
          accountKey: 'proxy:conn-1:b2f3c2d4b2f3c2d4',
          label: 'codex-proxy@example.com',
          provider: 'codex',
          turnShare: 1,
          requestCount: 3,
          usd: 0.2,
          notPricedCount: 0,
        },
      ],
    });
    installSessionAccounts([]);
    renderUsage(contextTarget, true, 'claude');
    await openPopover();
    act(() => {
      document.body
        .querySelectorAll<HTMLButtonElement>(
          '[data-testid="usage-indicator-account-toggle"]',
        )
        .forEach((button) => button.click());
    });

    const section = document.body.querySelector(
      '[data-testid="usage-indicator-proxy-accounts"]',
    );
    const accountSummary = section?.querySelector(
      '[data-testid="usage-indicator-account"]',
    );
    const status = accountSummary?.querySelector('[role="status"]');
    expect(accountSummary?.textContent).toContain('claude-proxy@example.com');
    expect(accountSummary?.textContent).toContain('7-day Opus');
    expect(accountSummary?.textContent).toContain('42%');
    expect(accountSummary?.textContent).toContain('Spent $1.25');
    expect(accountSummary?.textContent).toContain('$8.75 of $10.00 left');
    expect(status?.textContent).toContain(
      'Check your connection, then try reaching Claude again.',
    );
    expect(status?.textContent).toContain('Showing last known usage.');
    expect(status?.textContent).not.toContain('Bearer private-value');
    expect(accountSummary?.textContent).not.toContain('Weekly limit');

    const codexSummary = Array.from(
      section?.querySelectorAll('[data-testid="usage-indicator-account"]') ??
        [],
    ).find((summary) =>
      summary.textContent?.includes('codex-proxy@example.com'),
    );
    expect(codexSummary?.textContent).toContain('5-hour window');
    expect(codexSummary?.textContent).toContain('22%');
    expect(codexSummary?.textContent).toContain('12,500 credits left');
    expect(codexSummary?.querySelector('[role="status"]')).toBeNull();
  });

  it('names the account the proxy uses before any turn is recorded', async () => {
    useAccountProxyStore.setState({ status: PROXY_STATUS });
    installCostApi();
    installSessionAccounts([]);
    renderUsage(contextTarget, true);
    await openPopover();

    const text = proxySectionText();
    expect(text).toContain('sam@example.com');
    expect(text).toContain('Proxy accounts');
    expect(text).toContain('5-hour limit');
    expect(document.body.textContent).not.toContain('Sign in');
  });

  it('leads with the account serving the session now', async () => {
    useAccountProxyStore.setState({
      status: {
        ...PROXY_STATUS,
        accounts: [
          ...PROXY_STATUS.accounts,
          {
            authIndex: 'e2a8f640e2a8f640',
            provider: 'codex',
            label: 'ops@example.com',
            source: 'sign-in',
            fileName: 'codex-ops.json',
            planType: 'plus',
            status: 'active',
            statusMessage: null,
            availableAt: null,
            limits: [],
          },
        ],
      },
    });
    installCostApi({
      turnCount: 2,
      proxyAccounts: [
        {
          accountKey: 'proxy:conn-1:a1f3c2d4a1f3c2d4',
          label: 'sam@example.com',
          provider: 'codex',
          turnShare: 2,
          requestCount: 4,
          usd: 0.2,
          notPricedCount: 0,
        },
      ],
    });
    const sessionAccounts = installSessionAccounts([
      {
        connectionId: 'conn-1',
        authIndex: 'e2a8f640e2a8f640',
        label: 'ops@example.com',
        provider: 'codex',
        requests: 1,
        current: true,
      },
    ]);
    renderUsage(contextTarget, true);
    await openPopover();

    expect(sessionAccounts).toHaveBeenCalledWith(contextTarget);
    const labels = Array.from(
      document.body.querySelectorAll(
        '[data-testid="usage-indicator-account-label"]',
      ),
      (element) => element.textContent,
    );
    expect(labels).toEqual(['ops@example.com', 'sam@example.com']);
    expect(proxySectionText()).toContain('100% of turns');
  });

  it('keeps the session account on the connection it was recorded under', async () => {
    // The proxy moved to a new connection, whose list names another
    // credential under the same id. The session's account is still the one
    // the old connection served, so it is not shown with the new one's
    // details or limits.
    useAccountProxyStore.setState({
      status: {
        ...PROXY_STATUS,
        connection: {
          id: 'new-connection',
          kind: 'server',
          url: 'https://proxy-2.example.com',
        },
        accounts: [
          {
            ...PROXY_STATUS.accounts[0],
            label: 'ops@example.com',
            fileName: 'codex-ops.json',
          },
        ],
      },
    });
    installCostApi({
      turnCount: 2,
      proxyAccounts: [
        {
          accountKey: 'proxy:old-connection:a1f3c2d4a1f3c2d4',
          label: 'sam@example.com',
          provider: 'codex',
          turnShare: 2,
          requestCount: 4,
          usd: 0.2,
          notPricedCount: 0,
        },
      ],
    });
    installSessionAccounts([
      {
        connectionId: 'old-connection',
        authIndex: 'a1f3c2d4a1f3c2d4',
        label: 'sam@example.com',
        provider: 'codex',
        requests: 4,
        current: true,
      },
    ]);
    renderUsage(contextTarget, true);
    await openPopover();

    const labels = Array.from(
      document.body.querySelectorAll(
        '[data-testid="usage-indicator-account-label"]',
      ),
      (element) => element.textContent,
    );
    expect(labels).toEqual(['sam@example.com']);
    const text = proxySectionText();
    expect(text).toContain('100% of turns');
    expect(text).not.toContain('ops@example.com');
    expect(text).not.toContain('5-hour limit');
  });

  it('does not guess the connection a host did not report', async () => {
    useAccountProxyStore.setState({ status: PROXY_STATUS });
    installCostApi({
      turnCount: 1,
      proxyAccounts: [
        {
          accountKey: 'proxy:conn-1:a1f3c2d4a1f3c2d4',
          label: 'sam@example.com',
          provider: 'codex',
          turnShare: 1,
          requestCount: 1,
          usd: 0.1,
          notPricedCount: 0,
        },
      ],
    });
    // A remote host on an older release names the account but not the
    // connection that served it.
    installSessionAccounts([
      {
        authIndex: 'e2a8f640e2a8f640',
        label: 'ops@example.com',
        provider: 'codex',
        requests: 1,
        current: true,
      },
    ]);
    renderUsage(contextTarget, true);
    await openPopover();

    const labels = Array.from(
      document.body.querySelectorAll(
        '[data-testid="usage-indicator-account-label"]',
      ),
      (element) => element.textContent,
    );
    expect(labels).toEqual(['sam@example.com']);
  });

  it('asks for an account when the proxy has none for the chat', async () => {
    useAccountProxyStore.setState({
      status: { ...PROXY_STATUS, accounts: [] },
    });
    installCostApi();
    installSessionAccounts([]);
    renderUsage(contextTarget, true);
    await openPopover();

    expect(proxySectionText()).toContain(
      'Via account proxy · Add a Codex account to the account proxy.',
    );
    expect(document.body.textContent).not.toContain('Sign in');
  });

  it('points to the proxy settings when its limits cannot be read', async () => {
    useAccountProxyStore.setState({
      status: {
        ...PROXY_STATUS,
        state: 'error',
        error: { code: 'unreachable', message: 'Unreachable.' },
      },
    });
    installCostApi();
    installSessionAccounts([]);
    renderUsage(contextTarget, true);
    await openPopover();

    expect(proxySectionText()).toContain(
      'Via account proxy · Limits are unavailable. Check Settings > Multi-account proxy.',
    );
    expect(document.body.textContent).not.toContain('Sign in');
  });

  describe('which chats the proxy serves', () => {
    const CLAUDE_PROXY_STATUS: AccountProxyStatus = {
      ...PROXY_STATUS,
      accounts: [
        {
          authIndex: 'b1f3c2d4a1f3c2d4',
          provider: 'claude',
          label: 'claude-pool@example.com',
          source: 'sign-in',
          fileName: 'claude-pool.json',
          planType: 'max',
          status: 'active',
          statusMessage: null,
          availableAt: null,
          limits: [{ id: 'five-hour', usedPercent: 42, resetsAt: null }],
        },
      ],
    };

    function installPreferences(
      aiCreditsRoutingMode: 'off' | 'on' | 'on-quota',
    ): void {
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          ...window.api,
          loadPreferences: jest.fn().mockResolvedValue({
            aiCreditsRoutingMode,
          }),
          // A Claude session reports what fills its window as it opens.
          chat: { getContextUsage: jest.fn().mockResolvedValue(null) },
        },
      });
    }

    function renderChat(
      props: Partial<Parameters<typeof UsageIndicator>[0]>,
    ): void {
      act(() => {
        root.render(
          <UsageIndicator
            usage={{ ...BASE_USAGE, model: props.model ?? BASE_USAGE.model }}
            isCodex={false}
            contextTarget={contextTarget}
            {...props}
          />,
        );
      });
    }

    it('keeps an OpenCode chat off the Claude proxy pool', async () => {
      useAccountProxyStore.setState({ status: CLAUDE_PROXY_STATUS });
      installCostApi();
      installSessionAccounts([]);
      installPreferences('off');
      // An Anthropic model through OpenCode: main's OpenCode session has no
      // proxy route, so the popover shows what it did before the proxy.
      renderChat({
        model: 'opencode:anthropic%2Fclaude-sonnet-4-5',
        providerType: 'opencode',
      });
      await openPopover();

      expect(
        document.body.querySelector(
          '[data-testid="usage-indicator-proxy-accounts"]',
        ),
      ).toBeNull();
      expect(document.body.textContent).not.toContain('Via account proxy');
      expect(document.body.textContent).not.toContain(
        'claude-pool@example.com',
      );
    });

    it('leaves the proxy out while AI Credits route every session', async () => {
      useAccountProxyStore.setState({ status: CLAUDE_PROXY_STATUS });
      installCostApi();
      installSessionAccounts([]);
      installPreferences('on');
      renderChat({ model: 'claude-sonnet-4-5', providerType: 'claude' });
      await openPopover();

      expect(
        document.body.querySelector(
          '[data-testid="usage-indicator-proxy-accounts"]',
        ),
      ).toBeNull();
      expect(document.body.textContent).not.toContain('Via account proxy');
    });

    it('keeps the proxy for on-quota and a per-chat subscription choice', async () => {
      useAccountProxyStore.setState({ status: CLAUDE_PROXY_STATUS });
      installCostApi();
      installSessionAccounts([]);
      installPreferences('on-quota');
      renderChat({ model: 'claude-sonnet-4-5', providerType: 'claude' });
      await openPopover();
      expect(proxySectionText()).toContain('claude-pool@example.com');

      act(() => root.unmount());
      root = createRoot(container);
      invalidateAiCreditsUsageCache();
      installPreferences('on');
      renderChat({
        model: 'claude-sonnet-4-5',
        providerType: 'claude',
        subscriptionBillingOverride: true,
      });
      await openPopover();
      expect(proxySectionText()).toContain('claude-pool@example.com');
    });
  });
  describe('with Proxy account cards on', () => {
    const TWO_ACCOUNTS = [
      {
        accountKey: 'proxy:conn-1:a1f3c2d4a1f3c2d4',
        label: 'sam@example.com',
        provider: 'codex',
        turnShare: 3,
        requestCount: 9,
        usd: 0.31,
        notPricedCount: 0,
      },
      {
        accountKey: 'proxy:conn-1:b2f3c2d4b2f3c2d4',
        label: 'kim@example.com',
        provider: 'codex',
        turnShare: 1,
        requestCount: 2,
        usd: 0.1,
        notPricedCount: 0,
      },
    ] as const;
    const KIM = {
      ...PROXY_STATUS.accounts[0],
      authIndex: 'b2f3c2d4b2f3c2d4',
      label: 'kim@example.com',
      limits: [
        { id: 'five-hour' as const, usedPercent: 100, resetsAt: null },
        { id: 'weekly' as const, usedPercent: 30, resetsAt: null },
      ],
    };

    function cards(): HTMLElement[] {
      return Array.from(
        document.body.querySelectorAll<HTMLElement>(
          '[data-testid="usage-indicator-account"]',
        ),
      );
    }

    async function click(element: Element | null | undefined): Promise<void> {
      expect(element).toBeInstanceOf(Element);
      await act(async () => {
        (element as HTMLElement).click();
        await Promise.resolve();
      });
    }

    it('lists each account as a folded card under one Proxy accounts row', async () => {
      const openSettings = jest.fn();
      useNavigationStore.setState({ openSettings });
      useAccountProxyStore.setState({
        status: { ...PROXY_STATUS, accounts: [PROXY_STATUS.accounts[0], KIM] },
      });
      installCostApi({ turnCount: 4, proxyAccounts: [...TWO_ACCOUNTS] });
      renderUsage(contextTarget);
      await openPopover();

      const section = document.body.querySelector(
        '[data-testid="usage-indicator-proxy-accounts"]',
      );
      expect(section?.textContent).toContain('Proxy accounts');
      expect(section?.textContent).not.toContain('Via account proxy');
      const [sam, kim] = cards();
      expect(sam?.textContent).toContain('sam@example.com');
      expect(sam?.textContent).toContain('75% of turns');
      expect(kim?.textContent).toContain('25% of turns');
      // Folded: the lead meter beside the plan, no limit rows.
      expect(sam?.textContent).not.toContain('5-hour limit');
      const mini = sam?.querySelector(
        '[data-testid="usage-indicator-account-mini"] [role="progressbar"]',
      );
      expect(mini?.getAttribute('aria-label')).toBe('5-hour limit used');
      expect(mini?.getAttribute('aria-valuenow')).toBe('42');

      await click(
        sam?.querySelector('[data-testid="usage-indicator-account-toggle"]'),
      );
      expect(cards()[0]?.textContent).toContain('5-hour limit');
      expect(
        JSON.parse(
          window.localStorage.getItem(PROXY_USAGE_EXPANDED_STORAGE_KEY) ?? '[]',
        ),
      ).toEqual(['proxy:conn-1:a1f3c2d4a1f3c2d4']);

      await click(
        section?.querySelector('button[aria-label="Manage proxy accounts"]'),
      );
      expect(openSettings).toHaveBeenCalledWith('account-proxy');
    });

    it('shows when a resting account is back in place of its share, once', async () => {
      const backAt = Date.now() + 52 * 60_000;
      useAccountProxyStore.setState({
        status: {
          ...PROXY_STATUS,
          accounts: [
            PROXY_STATUS.accounts[0],
            {
              ...KIM,
              status: 'cooling',
              availableAt: backAt,
              limits: [
                { id: 'five-hour', usedPercent: 100, resetsAt: backAt },
                { id: 'weekly', usedPercent: 30, resetsAt: null },
              ],
            },
          ],
        },
      });
      installCostApi({ turnCount: 4, proxyAccounts: [...TWO_ACCOUNTS] });
      renderUsage(contextTarget);
      await openPopover();

      const kim = cards()[1];
      expect(kim?.textContent).toContain('Back at');
      expect(kim?.textContent).not.toContain('25% of turns');
      await click(
        kim?.querySelector('[data-testid="usage-indicator-account-toggle"]'),
      );
      // The limiting window does not repeat the time the header shows.
      const opened = cards()[1]?.textContent ?? '';
      expect(opened).toContain('5-hour limit');
      expect(opened).not.toContain('52 min');
      expect(opened.match(/Back at/g)).toHaveLength(1);
    });

    it('shows the pool as cards before any turn is recorded', async () => {
      useAccountProxyStore.setState({
        status: { ...PROXY_STATUS, accounts: [PROXY_STATUS.accounts[0], KIM] },
      });
      installCostApi();
      installSessionAccounts([]);
      renderUsage(contextTarget, true);
      await openPopover();

      const [sam, kim] = cards();
      expect(sam?.textContent).toContain('sam@example.com');
      expect(kim?.textContent).toContain('kim@example.com');
      expect(proxySectionText()).not.toContain('Via account proxy');
      expect(proxySectionText()).not.toContain('of turns');
    });

    it('counts pool accounts past the shown cards as the pool, not as served', async () => {
      const extra = (
        authIndex: string,
        label: string,
      ): AccountProxyStatus['accounts'][number] => ({
        ...PROXY_STATUS.accounts[0],
        authIndex,
        label,
      });
      useAccountProxyStore.setState({
        status: {
          ...PROXY_STATUS,
          accounts: [
            PROXY_STATUS.accounts[0],
            KIM,
            extra('c3f3c2d4c3f3c2d4', 'lee@example.com'),
            extra('d4f3c2d4d4f3c2d4', 'ana@example.com'),
          ],
        },
      });
      installCostApi();
      installSessionAccounts([]);
      renderUsage(contextTarget, true);
      await openPopover();

      expect(cards()).toHaveLength(3);
      expect(proxySectionText()).toContain('1 more account in the pool.');
      expect(proxySectionText()).not.toContain('served this chat');
    });

    it('folds the whole section from its row', async () => {
      useAccountProxyStore.setState({
        status: { ...PROXY_STATUS, accounts: [PROXY_STATUS.accounts[0], KIM] },
      });
      installCostApi({ turnCount: 4, proxyAccounts: [...TWO_ACCOUNTS] });
      renderUsage(contextTarget);
      await openPopover();

      expect(cards()).toHaveLength(2);
      await click(
        document.body.querySelector(
          '[data-testid="usage-indicator-proxy-section-toggle"]',
        ),
      );
      expect(cards()).toHaveLength(0);
      expect(useProxyUsageExpandedStore.getState().sectionCollapsed).toBe(true);
    });
  });

  describe('credits-only billing (CAN-5028)', () => {
    const CREDITS_ONLY = {
      claudeNativeAuth: false,
      codexNativeAuth: false,
      creditsEligible: true,
    } as const;

    function renderBilled(aiCreditsBilled: boolean): void {
      act(() => {
        root.render(
          <UsageIndicator
            usage={{ ...BASE_USAGE, totalCostUsd: 0.4 }}
            isCodex
            providerType="codex"
            contextTarget={contextTarget}
            aiCreditsBilled={aiCreditsBilled}
          />,
        );
      });
    }

    async function expandContext(): Promise<void> {
      await act(async () => {
        document.body
          .querySelector<HTMLButtonElement>(
            '[data-testid="usage-indicator-context"]',
          )
          ?.click();
        await Promise.resolve();
      });
    }

    function costRow(): Element | null {
      return document.body.querySelector(
        '[data-testid="usage-indicator-cost"]',
      );
    }

    it('hides every USD figure and skips the cost read for a credits-billed chat', async () => {
      setRendererBillingLaneAvailability(CREDITS_ONLY);
      const { getChat } = installCostApi();
      renderBilled(true);
      await openPopover();

      expect(getChat).not.toHaveBeenCalled();
      expect(costRow()).toBeNull();
      expect(
        document.body.querySelector(
          '[data-testid="usage-indicator-see-details"]',
        ),
      ).toBeNull();
      await expandContext();
      const details =
        document.body.querySelector('[data-testid="usage-indicator-details"]')
          ?.textContent ?? '';
      expect(details).toContain('Turns');
      expect(details).not.toContain('Cost');
    });

    it('keeps cost for a chat in the same account that bills elsewhere', async () => {
      setRendererBillingLaneAvailability(CREDITS_ONLY);
      installCostApi();
      renderBilled(false);
      await openPopover();

      expect(costRow()).not.toBeNull();
    });

    it('keeps cost and the breakdown link for a subscriber', async () => {
      setRendererBillingLaneAvailability({
        ...CREDITS_ONLY,
        claudeNativeAuth: true,
      });
      installCostApi();
      renderBilled(true);
      await openPopover();

      expect(costRow()).not.toBeNull();
      expect(
        document.body.querySelector(
          '[data-testid="usage-indicator-see-details"]',
        ),
      ).not.toBeNull();
    });

    it('keeps cost while the account facts are unknown', async () => {
      installCostApi();
      renderBilled(true);
      await openPopover();

      expect(costRow()).not.toBeNull();
    });

    it('drops cost in place when the facts settle as credits-only', async () => {
      installCostApi();
      renderBilled(true);
      await openPopover();
      expect(costRow()).not.toBeNull();

      await act(async () => {
        setRendererBillingLaneAvailability(CREDITS_ONLY);
        await Promise.resolve();
      });

      expect(
        document.body.querySelector('[data-testid="usage-indicator-popover"]'),
      ).not.toBeNull();
      expect(costRow()).toBeNull();
    });
  });
});
