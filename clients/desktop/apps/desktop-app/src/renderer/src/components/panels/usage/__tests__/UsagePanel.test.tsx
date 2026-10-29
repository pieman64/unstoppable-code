/**
 * @jest-environment jsdom
 */
/**
 * UsagePanel — size-mode threshold logic and per-variant provider selection.
 * The provider card and AI Credits card are stubbed (their internals — auth
 * hooks, live account rows — are covered by the standalone Usage page), so
 * these tests focus on UsagePanel's own behavior: which provider(s) each
 * variant renders, and how `active-chat` follows the worktree's chat provider.
 */
import { act } from 'react';
import type * as ReactNamespace from 'react';
import type * as ProviderUsageCardsModule from '@/components/pages/usage/ProviderUsageCards';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AgentUsageOverview,
  ProviderUsageSummary,
} from '@canopy/desktop-shared/types';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import { isUsagePanelVariant } from '@/lib/panels/usage-variants';
import { UsagePanel, resolveUsagePanelSizeMode } from '../UsagePanel';

// Stub card rendering but exercise the real account-provider selector.
jest.mock('@/components/pages/usage/ProviderUsageCards', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    __esModule: true,
    selectAccountProviderUsageSummaries: jest.requireActual<
      typeof ProviderUsageCardsModule
    >('@/components/pages/usage/ProviderUsageCards')
      .selectAccountProviderUsageSummaries,
    ShutdownResumeButton: (): null => null,
    OpenCodeUsageSection: jest.requireActual<typeof ProviderUsageCardsModule>(
      '@/components/pages/usage/ProviderUsageCards',
    ).OpenCodeUsageSection,
    ProviderUsageCard: ({
      provider,
    }: {
      provider: { provider: string };
    }): unknown =>
      react.createElement('div', {
        'data-testid': `usage-provider-card-${provider.provider}`,
      }),
  };
});
jest.mock('@/components/pages/usage/AiCreditsUsageCard', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    AiCreditsUsageCard: (): unknown =>
      react.createElement('div', { 'data-testid': 'usage-card-ai-credits' }),
  };
});
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-1';
const KEY = `${PROJECT_ID}/${WORKTREE_ID}`;

function makeProvider(
  provider: ProviderUsageSummary['provider'],
): ProviderUsageSummary {
  return { provider, authState: 'authenticated', hasRemainingLimits: false };
}

const USAGE: AgentUsageOverview = {
  updatedAt: '2026-07-16T00:00:00.000Z',
  providers: [
    makeProvider('claude'),
    makeProvider('codex'),
    makeProvider('cursor'),
  ],
};

function makeChatTab(overrides: Partial<ChatTab> & { id: string }): ChatTab {
  return {
    title: 'Chat',
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', fastMode: false },
    fastModeExplicit: false,
    ...overrides,
  };
}

describe('resolveUsagePanelSizeMode', () => {
  it('treats an unmeasured (0×0) box as full', () => {
    expect(resolveUsagePanelSizeMode({ width: 0, height: 0 })).toBe('full');
  });

  it('classifies the four regimes by width/height thresholds', () => {
    expect(resolveUsagePanelSizeMode({ width: 900, height: 700 })).toBe('full');
    expect(resolveUsagePanelSizeMode({ width: 900, height: 300 })).toBe(
      'wide-short',
    );
    expect(resolveUsagePanelSizeMode({ width: 320, height: 700 })).toBe(
      'narrow-tall',
    );
    expect(resolveUsagePanelSizeMode({ width: 320, height: 300 })).toBe(
      'compact',
    );
  });
});

describe('UsagePanel', () => {
  const originalFlags = useFeatureFlagsStore.getState().snapshot;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    useObservabilityStore.setState({
      initialized: true,
      usage: USAGE,
      refreshingProviders: new Set(),
      refreshProviderUsage: jest.fn(() => Promise.resolve(undefined)),
      refreshProviderUsageDetails: jest.fn(() => Promise.resolve(USAGE)),
    });
    useChatStore.setState({ worktreeChats: {} });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    useFeatureFlagsStore.setState({ snapshot: originalFlags });
    useChatStore.setState({ worktreeChats: {} });
  });

  function renderPanel(variant: string): void {
    act(() => {
      root.render(
        <UsagePanel
          variant={isUsagePanelVariant(variant) ? variant : 'all'}
          projectId={PROJECT_ID}
          worktreeId={WORKTREE_ID}
        />,
      );
    });
  }

  function has(testId: string): boolean {
    return container.querySelector(`[data-testid="${testId}"]`) !== null;
  }

  it('all: renders all account provider cards plus AI Credits', () => {
    renderPanel('all');
    expect(has('usage-provider-card-claude')).toBe(true);
    expect(has('usage-provider-card-codex')).toBe(true);
    expect(has('usage-provider-card-cursor')).toBe(true);
    expect(has('usage-card-ai-credits')).toBe(true);
  });

  it.each(['all', 'cursor'])(
    '%s: hides a cached Cursor snapshot while the rollout is disabled',
    (variant) => {
      renderPanel(variant);
      expect(has('usage-provider-card-cursor')).toBe(true);
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
      expect(has('usage-provider-card-cursor')).toBe(false);
    },
  );

  it('all: keeps AI Credits mounted when provider cards are unavailable', () => {
    useObservabilityStore.setState({
      usage: { ...USAGE, providers: [] },
    });
    renderPanel('all');
    expect(has('usage-provider-card-claude')).toBe(false);
    expect(has('usage-provider-card-codex')).toBe(false);
    expect(has('usage-card-ai-credits')).toBe(true);
    expect(container.textContent).toContain(
      'No provider usage is available yet.',
    );
  });

  it('codex: renders only the Codex card and no AI Credits', () => {
    renderPanel('codex');
    expect(has('usage-provider-card-codex')).toBe(true);
    expect(has('usage-provider-card-claude')).toBe(false);
    expect(has('usage-card-ai-credits')).toBe(false);
  });

  it('claude: renders only the Claude card', () => {
    renderPanel('claude');
    expect(has('usage-provider-card-claude')).toBe(true);
    expect(has('usage-provider-card-codex')).toBe(false);
  });

  it('cursor: renders only the Cursor account card', () => {
    renderPanel('cursor');
    expect(has('usage-provider-card-cursor')).toBe(true);
    expect(has('usage-provider-card-claude')).toBe(false);
    expect(has('usage-provider-card-codex')).toBe(false);
    expect(has('usage-card-ai-credits')).toBe(false);
  });

  it.each(['all', 'copilot', 'active-chat'])(
    '%s: shows Copilot account usage',
    (variant) => {
      useFeatureFlagsStore.setState({
        snapshot: {
          ...originalFlags,
          values: {
            ...originalFlags.values,
            'canopy-desktop-copilot-harness': true,
          },
        },
      });
      useObservabilityStore.setState({
        usage: {
          ...USAGE,
          providers: [
            ...USAGE.providers,
            {
              provider: 'copilot',
              authState: 'authenticated',
              hasRemainingLimits: true,
              accountLabel: 'copilot-fixture',
            },
          ],
        },
      });
      useChatStore.setState({
        worktreeChats: {
          [KEY]: {
            tabs: [
              makeChatTab({
                id: 'copilot-chat',
                providerType: 'copilot',
                model: 'copilot:fixture-model',
              }),
            ],
            activeTabId: 'copilot-chat',
          },
        },
      });
      renderPanel(variant);
      expect(has('usage-provider-card-copilot')).toBe(true);
      act(() =>
        useFeatureFlagsStore.setState({
          snapshot: {
            ...originalFlags,
            values: {
              ...originalFlags.values,
              'canopy-desktop-copilot-harness': false,
            },
          },
        }),
      );
      expect(has('usage-provider-card-copilot')).toBe(false);
    },
  );

  it('active-chat: follows a Cursor harness using a Claude model', () => {
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          tabs: [
            makeChatTab({
              id: 'cursor-chat',
              providerType: 'cursor',
              model: 'claude-sonnet-4-6',
            }),
          ],
          activeTabId: 'cursor-chat',
        },
      },
    });
    renderPanel('active-chat');
    expect(has('usage-provider-card-cursor')).toBe(true);
    expect(has('usage-provider-card-claude')).toBe(false);
    expect(has('usage-provider-card-codex')).toBe(false);
  });

  it.each(['all', 'active-chat'])(
    '%s: shows OpenCode account metadata while its rollout is enabled',
    (variant) => {
      useFeatureFlagsStore.setState({
        snapshot: {
          ...originalFlags,
          values: {
            ...originalFlags.values,
            'canopy-desktop-opencode-harness': true,
          },
        },
      });
      useObservabilityStore.setState({
        usage: {
          ...USAGE,
          openCodeAccounts: {
            status: 'ready',
            updatedAt: '2026-10-21T23:00:00Z',
            providers: [
              {
                id: 'fixture',
                name: 'Fixture',
                accounts: [
                  {
                    label: 'Work account',
                    method: 'oauth',
                    selected: true,
                    needsSignIn: false,
                  },
                ],
              },
            ],
          },
        },
      });
      useChatStore.setState({
        worktreeChats: {
          [KEY]: {
            tabs: [
              makeChatTab({
                id: 'opencode-chat',
                providerType: 'opencode',
                model: 'opencode:fixture%2Fmodel',
              }),
            ],
            activeTabId: 'opencode-chat',
          },
        },
      });
      renderPanel(variant);
      expect(has('opencode-account-card')).toBe(true);
      expect(container.textContent).toContain('Work account');
      act(() =>
        useFeatureFlagsStore.setState({
          snapshot: {
            ...originalFlags,
            values: {
              ...originalFlags.values,
              'canopy-desktop-opencode-harness': false,
            },
          },
        }),
      );
      expect(has('opencode-account-card')).toBe(false);
    },
  );

  it('active-chat: follows the worktree active chat provider', () => {
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          tabs: [makeChatTab({ id: 'c1', providerType: 'codex' })],
          activeTabId: 'c1',
        },
      },
    });
    renderPanel('active-chat');
    expect(has('usage-provider-card-codex')).toBe(true);
    expect(has('usage-provider-card-claude')).toBe(false);
  });

  it('active-chat: restores the last chat provider while a file tab is focused', () => {
    const chatTab = makeChatTab({ id: 'c1', providerType: 'codex' });
    const fileTab = makeChatTab({ id: 'f1', kind: 'file' });
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          tabs: [chatTab, fileTab],
          activeTabId: fileTab.id,
          lastActiveChatProvider: 'codex',
        },
      },
    });
    renderPanel('active-chat');
    expect(has('usage-provider-card-codex')).toBe(true);
    expect(container.textContent).not.toContain('follows the active chat');
  });

  it('active-chat: shows the follow-the-chat empty state when no chat is active', () => {
    renderPanel('active-chat');
    expect(has('usage-panel-cards')).toBe(false);
    expect(has('usage-provider-card-codex')).toBe(false);
    expect(container.textContent).toContain('follows the active chat');
  });
});
