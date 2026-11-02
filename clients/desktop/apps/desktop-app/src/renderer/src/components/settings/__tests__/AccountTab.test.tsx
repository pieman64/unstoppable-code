/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyApi } from '@canopy/desktop-shared/types';
import type * as LinearStatusHooks from '@/hooks/useLinearStatus';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  GITHUB_CONNECTION_CHANGED_EVENT,
  LINEAR_CONNECTION_CHANGED_EVENT,
  MODEL_GATEWAY_CREDENTIAL_CHANGED_EVENT,
} from '@/lib/integrationConnectionEvents';
import { makeTestPreferences } from '@/test-utils/preferences';
import {
  expectReplayBlocksOnlyValue,
  outermostReplayBlock,
} from '@/test-utils/replay';
import { SETTINGS_SECTION_REPLAY_PRIVACY } from '@canopy/desktop-instrumentation/posthog-replay-surfaces';
import { AccountTab } from '../AccountTab';
import { SettingsReplayPrivacyContext } from '../settings-replay-privacy';
import { CanopyCloudAccountSection } from '../CanopyCloudAccountSection';
import { ModelGatewayCredentialSection } from '../ModelGatewayCredentialSection';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';

type AccountTabApiDouble = Partial<Omit<CanopyApi, 'browser'>> & {
  browser: Pick<CanopyApi['browser'], 'openExternal'>;
};

// The imported store reads this mock before the test module's initializers run.
// eslint-disable-next-line no-var -- Jest's hoisted imports require this binding before initialization.
var mockScopingContext:
  | { kind: 'personal' }
  | { kind: 'organization'; organizationId: string }
  | undefined;
jest.mock('@/components/sidebar/useSidebarScopingContext', () => ({
  useSidebarScopingContext: (): typeof mockScopingContext => mockScopingContext,
  getSidebarScopingContext: (): typeof mockScopingContext => mockScopingContext,
}));

let mockAuthLoginOnClose: (() => void) | null = null;
jest.mock('../AuthLoginModal', () => ({
  AuthLoginModal: function MockAuthLoginModal({
    onClose,
  }: {
    onClose: () => void;
  }): null {
    mockAuthLoginOnClose = onClose;
    return null;
  },
}));

jest.mock('@/hooks/useClaudeAuthStatus', () => ({
  invalidateClaudeAuthStatusCache: jest.fn(),
  useClaudeAuthStatus: jest.fn(() => ({
    authenticated: true,
    accountLabel: 'claude@example.com',
    detail: null,
    error: null,
  })),
}));

jest.mock('@/hooks/useCodexAuthStatus', () => ({
  invalidateCodexAuthStatusCache: jest.fn(),
  useCodexAuthStatus: jest.fn(() => ({
    authenticated: true,
    accountLabel: 'codex@example.com',
    detail: null,
    error: null,
  })),
}));

jest.mock('@/hooks/useGitHubCliStatus', () => ({
  invalidateGitHubCliStatusCache: jest.fn(),
  useGitHubCliStatus: jest.fn(() => ({
    authenticated: false,
    username: null,
    error: null,
    tokenSource: null,
    envOverride: false,
    envOverrideName: null,
    hasCredentialStoreLogin: false,
  })),
}));

jest.mock('@/hooks/useGitHubPermissions', () => ({
  invalidateGitHubPermissionsCache: jest.fn(),
  useGitHubPermissions: jest.fn(() => ({
    tokenAvailable: false,
    tokenType: 'unknown',
    scopes: [],
    permissions: [],
    canListRepos: false,
    error: null,
  })),
}));

jest.mock('@/hooks/useLinearStatus', () => ({
  invalidateLinearStatusCache: jest.fn(),
  useLinearStatus: jest.fn(() => ({
    authenticated: true,
    displayName: 'Linear User',
    error: null,
  })),
}));

let mockGuestCredential: boolean | undefined = false;
jest.mock('@/hooks/useIsGuestCredential', () => ({
  ...jest.requireActual<object>('@/hooks/useIsGuestCredential'),
  useGuestCredentialState: (): boolean | undefined => mockGuestCredential,
}));

let mockHostedSettingsAvailable = false;
jest.mock('../hosted/hosted-settings-availability', () => ({
  ...jest.requireActual<object>('../hosted/hosted-settings-availability'),
  useHostedSettingsAvailable: (): boolean => mockHostedSettingsAvailable,
}));

// Stand-ins that mark where each panel mounts; each has dedicated coverage.
jest.mock('../CloudDailyCreditDripSettings', () => ({
  CloudDailyCreditDripSettings: (): JSX.Element => (
    <div data-testid="stub-cloud-daily-credit-drip" />
  ),
}));
jest.mock('../CursorApprovalCheck', () => ({
  CursorApprovalCheck: (): JSX.Element => (
    <div data-testid="stub-cursor-approval-check" />
  ),
}));
jest.mock('../CursorConnection', () => ({
  CursorConnection: (): null => null,
}));
jest.mock('../OpenCodeConnection', () => ({
  OpenCodeConnection: ({
    placement,
  }: {
    placement?: 'row' | 'section';
  }): JSX.Element => (
    <div data-testid="stub-opencode-connection" data-placement={placement} />
  ),
}));
jest.mock('../CopilotConnection', () => ({
  CopilotConnection: ({
    placement,
  }: {
    placement?: 'row' | 'section';
  }): JSX.Element => (
    <div data-testid="stub-copilot-connection" data-placement={placement} />
  ),
}));

const CONNECTED_STATUS = {
  authenticated: true,
  capabilities: ['portal-v1'],
  missingCapabilities: [],
  account: {
    id: 'acct-1',
    name: 'Alice',
    email: 'alice@example.com',
    role: 'ADMIN',
  },
  error: null,
};

describe('AccountTab Canopy Cloud account controls', () => {
  let container: HTMLElement;
  let root: Root;
  const loadCanopyCloudAccount = jest.fn();
  const loadCanopyCloudApiKey = jest.fn();
  const saveCanopyCloudApiKey = jest.fn();
  const clearCanopyCloudApiKey = jest.fn();
  const validateCanopyCloudApiKey = jest.fn();
  const startCanopyCloudOAuthLogin = jest.fn();
  const cancelCanopyCloudOAuthLogin = jest.fn();
  const disconnectCanopyCloudAccount = jest.fn();
  const refreshGitHubCredentials = jest.fn();

  beforeEach(() => {
    jest.useFakeTimers();
    mockAuthLoginOnClose = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: false,
      authMode: null,
      credentialSource: null,
      capabilities: [],
      storageAvailable: true,
    });
    loadCanopyCloudApiKey.mockResolvedValue('');
    saveCanopyCloudApiKey.mockResolvedValue({
      status: CONNECTED_STATUS,
      account: {
        hasApiKey: true,
        authMode: 'api_key',
        credentialSource: 'manual',
        capabilities: ['portal-v1'],
        storageAvailable: true,
        account: CONNECTED_STATUS.account,
      },
    });
    clearCanopyCloudApiKey.mockResolvedValue({
      hasApiKey: false,
      authMode: null,
      credentialSource: null,
      capabilities: [],
      storageAvailable: true,
    });
    validateCanopyCloudApiKey.mockResolvedValue(CONNECTED_STATUS);
    startCanopyCloudOAuthLogin.mockResolvedValue({
      status: CONNECTED_STATUS,
      account: {
        hasApiKey: true,
        authMode: 'oauth',
        credentialSource: 'oauth_desktop',
        capabilities: ['portal-v1'],
        storageAvailable: true,
        account: CONNECTED_STATUS.account,
      },
    });
    cancelCanopyCloudOAuthLogin.mockResolvedValue(undefined);
    disconnectCanopyCloudAccount.mockResolvedValue({
      hasApiKey: false,
      authMode: null,
      credentialSource: null,
      capabilities: [],
      storageAvailable: true,
    });
    refreshGitHubCredentials.mockResolvedValue(undefined);
    const api = {
      getClaudeAuthStatus: jest.fn(),
      getCodexAuthStatus: jest.fn(),
      getGitHubCliStatus: jest.fn(),
      getGitHubPermissions: jest.fn(),
      loadGitHubPat: jest.fn(() => Promise.resolve('')),
      saveGitHubPat: jest.fn(() => Promise.resolve({ success: true })),
      refreshGitHubCredentials,
      loadLinearToken: jest.fn(() => Promise.resolve('')),
      saveLinearToken: jest.fn(() => Promise.resolve({ success: true })),
      loadPreferences: jest.fn(() =>
        Promise.resolve(
          makeTestPreferences({ telemetrySharingPromptSeen: true }),
        ),
      ),
      savePreferences: jest
        .fn<
          ReturnType<CanopyApi['savePreferences']>,
          Parameters<CanopyApi['savePreferences']>
        >()
        .mockResolvedValue(makeTestPreferences()),
      loadCanopyCloudAccount,
      loadCanopyCloudApiKey,
      saveCanopyCloudApiKey,
      clearCanopyCloudApiKey,
      validateCanopyCloudApiKey,
      startCanopyCloudOAuthLogin,
      cancelCanopyCloudOAuthLogin,
      disconnectCanopyCloudAccount,
      loadCanopyCloudAiCredits: jest.fn(() =>
        Promise.resolve({
          connected: false,
          email: null,
          subscription: null,
          balance: null,
          noUdAccount: false,
          error: null,
        }),
      ),
      browser: { openExternal: jest.fn(() => Promise.resolve()) },
    } satisfies AccountTabApiDouble;
    Object.assign(window, { api });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    jest.clearAllMocks();
    jest.useRealTimers();
    mockScopingContext = undefined;
    mockHostedSettingsAvailable = false;
    mockGuestCredential = false;
  });

  it('initializes new users with the OAuth segment selected', async () => {
    await renderAccountTab();

    expect(isSegmentSelected('oauth')).toBe(true);
    expect(isSegmentSelected('api_key')).toBe(false);
    expect(container.textContent).toContain(
      'Sign in through your browser to connect your Canopy Cloud account.',
    );
    expect(findCloudApiKeyInput()).toBeNull();
    expect(oauthLoginButton().textContent?.trim()).toBe('Sign in');
  });

  it('notifies GitHub listeners only after main-process credentials reset', async () => {
    let finishCredentialReset = (): void => undefined;
    const credentialReset = new Promise<void>((resolve) => {
      finishCredentialReset = resolve;
    });
    refreshGitHubCredentials.mockReturnValueOnce(credentialReset);
    const connectionChanged = jest.fn();
    window.addEventListener(GITHUB_CONNECTION_CHANGED_EVENT, connectionChanged);

    await renderAccountTab();
    const connectButton = findByTestId('auth-panel-github-connect');
    if (!connectButton) throw new Error('GitHub connect button not found');

    act(() => {
      connectButton.click();
    });
    if (!mockAuthLoginOnClose) {
      throw new Error('GitHub login modal close callback not captured');
    }
    act(() => {
      mockAuthLoginOnClose?.();
    });

    expect(refreshGitHubCredentials).toHaveBeenCalledTimes(1);
    expect(connectionChanged).not.toHaveBeenCalled();

    await act(async () => {
      finishCredentialReset();
      await credentialReset;
      await Promise.resolve();
    });

    expect(connectionChanged).toHaveBeenCalledTimes(1);
    window.removeEventListener(
      GITHUB_CONNECTION_CHANGED_EVENT,
      connectionChanged,
    );
  });

  it('groups the account rows into page sections under their headings', async () => {
    // Sections are direct children of the page stack, each a heading (when it
    // has one) over one group box whose direct children are the rows. A
    // wrapper around rows would merge them into one row of the box.
    await renderAccountTab();

    const page = findByTestId('settings-tab-account');
    if (!page) throw new Error('Accounts page not found');
    const identify = (row: Element): string => {
      const has = (selector: string): boolean =>
        row.matches(selector) || row.querySelector(selector) !== null;
      if (has('[data-testid="settings-account-canopy-cloud-section"]')) {
        return 'cloud-account';
      }
      for (const provider of ['claude', 'codex', 'github']) {
        if (has(`[data-testid="auth-panel-${provider}"]`)) return provider;
      }
      if (has('[data-testid="settings-linear-token-input"]')) return 'linear';
      return row.textContent?.trim() ?? '';
    };
    const order = Array.from(
      page.querySelectorAll(':scope > div > section'),
    ).flatMap((section) =>
      Array.from(section.children).flatMap((child) => {
        const header = child.querySelector(
          '[data-testid^="account-section-header-"]',
        );
        if (header) return [header.textContent?.trim() ?? ''];
        return Array.from(child.children).map(identify);
      }),
    );

    expect(order).toEqual([
      'cloud-account',
      'LLM provider',
      'claude',
      'codex',
      'Version control',
      'github',
      'Project management',
      'linear',
    ]);
  });

  describe('Copilot provider row', () => {
    let originalFlags: ReturnType<
      typeof useFeatureFlagsStore.getState
    >['snapshot'];

    function setCopilotFlags(harness: boolean, released: boolean): void {
      useFeatureFlagsStore.setState({
        snapshot: {
          ...originalFlags,
          values: {
            ...originalFlags.values,
            [CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness.key]: harness,
            [CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarnessReleased.key]:
              released,
          },
        },
      });
    }

    function llmProviderRows(): string[] {
      const header = findByTestId('account-section-header-llm-provider');
      const section = header?.closest('section');
      if (!section) throw new Error('LLM provider section not found');
      return Array.from(
        section.querySelectorAll(
          '[data-testid="auth-panel-claude"], [data-testid="auth-panel-codex"], [data-testid="stub-copilot-connection"]',
        ),
      ).map((row) => row.getAttribute('data-testid') ?? '');
    }

    beforeEach(() => {
      originalFlags = useFeatureFlagsStore.getState().snapshot;
    });

    afterEach(() => {
      act(() => {
        useFeatureFlagsStore.setState({ snapshot: originalFlags });
      });
    });

    it.each([false, true])(
      'lists released Copilot as a provider row after Codex (hosted settings: %s)',
      async (hosted) => {
        mockHostedSettingsAvailable = hosted;
        setCopilotFlags(true, true);
        await renderAccountTab();

        expect(llmProviderRows()).toEqual([
          'auth-panel-claude',
          'auth-panel-codex',
          'stub-copilot-connection',
        ]);
        expect(
          findByTestId('stub-copilot-connection')?.getAttribute(
            'data-placement',
          ),
        ).toBe('row');
      },
    );

    it.each([
      { harness: true, released: false },
      { harness: false, released: true },
    ])(
      'leaves Copilot off Accounts until it is released (harness=$harness, released=$released)',
      async ({ harness, released }) => {
        setCopilotFlags(harness, released);
        await renderAccountTab();

        expect(findByTestId('stub-copilot-connection')).toBeNull();
      },
    );
  });

  describe('OpenCode provider row', () => {
    let originalFlags: ReturnType<
      typeof useFeatureFlagsStore.getState
    >['snapshot'];

    function setFlags(values: Record<string, boolean>): void {
      useFeatureFlagsStore.setState({
        snapshot: {
          ...originalFlags,
          values: { ...originalFlags.values, ...values },
        },
      });
    }

    function llmProviderRows(): string[] {
      const header = findByTestId('account-section-header-llm-provider');
      const section = header?.closest('section');
      if (!section) throw new Error('LLM provider section not found');
      return Array.from(
        section.querySelectorAll(
          '[data-testid="auth-panel-claude"], [data-testid="auth-panel-codex"], [data-testid="stub-copilot-connection"], [data-testid="stub-opencode-connection"]',
        ),
      ).map((row) => row.getAttribute('data-testid') ?? '');
    }

    beforeEach(() => {
      originalFlags = useFeatureFlagsStore.getState().snapshot;
    });

    afterEach(() => {
      act(() => {
        useFeatureFlagsStore.setState({ snapshot: originalFlags });
      });
    });

    it.each([false, true])(
      'lists released OpenCode as a provider row after Codex and Copilot (hosted settings: %s)',
      async (hosted) => {
        mockHostedSettingsAvailable = hosted;
        setFlags({
          [CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness.key]: true,
          [CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarnessReleased.key]: true,
          [CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarness.key]: true,
          [CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarnessReleased.key]: true,
        });
        await renderAccountTab();

        expect(llmProviderRows()).toEqual([
          'auth-panel-claude',
          'auth-panel-codex',
          'stub-copilot-connection',
          'stub-opencode-connection',
        ]);
        expect(
          findByTestId('stub-opencode-connection')?.getAttribute(
            'data-placement',
          ),
        ).toBe('row');
      },
    );

    it.each([
      { harness: true, released: false },
      { harness: false, released: true },
    ])(
      'leaves OpenCode off Accounts until it is released (harness=$harness, released=$released)',
      async ({ harness, released }) => {
        setFlags({
          [CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarness.key]: harness,
          [CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarnessReleased.key]:
            released,
        });
        await renderAccountTab();

        expect(findByTestId('stub-opencode-connection')).toBeNull();
      },
    );
  });

  describe('with hosted account settings', () => {
    let originalFlags: ReturnType<
      typeof useFeatureFlagsStore.getState
    >['snapshot'];

    beforeEach(() => {
      // Cursor released, so its approval check mounts on both layouts.
      originalFlags = useFeatureFlagsStore.getState().snapshot;
      useFeatureFlagsStore.setState({
        snapshot: {
          ...originalFlags,
          values: {
            ...originalFlags.values,
            [CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key]: true,
            [CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarnessReleased.key]: true,
          },
        },
      });
    });

    afterEach(() => {
      // Runs before the outer unmount, so the restore re-renders the tab.
      act(() => {
        useFeatureFlagsStore.setState({ snapshot: originalFlags });
      });
    });

    it('shows only the LLM providers as Providers when hosted settings are available', async () => {
      mockHostedSettingsAvailable = true;
      await renderAccountTab();

      const page = findByTestId('settings-tab-account');
      expect(page?.querySelector('h1')?.textContent).toBe('Providers');
      expect(sectionHeaders()).toEqual(['LLM provider']);
      expect(findByTestId('auth-panel-claude')).not.toBeNull();
      expect(findByTestId('auth-panel-codex')).not.toBeNull();
      expect(findByTestId('stub-cursor-approval-check')).not.toBeNull();
      // The cloud account, daily credits, GitHub and Linear live on the
      // hosted Account, Billing and Integrations pages.
      expect(findByTestId('settings-account-canopy-cloud-section')).toBeNull();
      expect(findByTestId('stub-cloud-daily-credit-drip')).toBeNull();
      expect(findByTestId('auth-panel-github')).toBeNull();
      expect(findByTestId('settings-linear-token-input')).toBeNull();
      expect(window.api.loadLinearToken).not.toHaveBeenCalled();
    });

    it('keeps the daily credits control reachable for a guest with hosted settings on', async () => {
      mockHostedSettingsAvailable = true;
      mockGuestCredential = true;
      await renderAccountTab();

      expect(findByTestId('stub-cloud-daily-credit-drip')).not.toBeNull();
      expect(findByTestId('settings-account-canopy-cloud-section')).toBeNull();
    });

    it('keeps every Accounts section when hosted settings are unavailable', async () => {
      await renderAccountTab();

      const page = findByTestId('settings-tab-account');
      expect(page?.querySelector('h1')?.textContent).toBe('Accounts');
      expect(sectionHeaders()).toEqual([
        'LLM provider',
        'Version control',
        'Project management',
      ]);
      expect(
        findByTestId('settings-account-canopy-cloud-section'),
      ).not.toBeNull();
      expect(findByTestId('stub-cloud-daily-credit-drip')).not.toBeNull();
      expect(findByTestId('stub-cursor-approval-check')).not.toBeNull();
      expect(findByTestId('auth-panel-github')).not.toBeNull();
      expect(findByTestId('settings-linear-token-input')).not.toBeNull();
    });

    function sectionHeaders(): string[] {
      return Array.from(
        container.querySelectorAll('[data-testid^="account-section-header-"]'),
      ).map((header) => header.textContent?.trim() ?? '');
    }
  });

  it('shows the Canopy Cloud section', async () => {
    await renderAccountTab();

    expect(
      findByTestId('settings-account-canopy-cloud-section'),
    ).not.toBeNull();
    expect(findByTestId('org-memory-settings')).toBeNull();
  });

  it('shows a saved signed-in cloud account on load', async () => {
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: true,
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      capabilities: ['portal-v1'],
      storageAvailable: true,
      account: CONNECTED_STATUS.account,
    });

    await renderAccountTab();

    expect(cloudSectionText()).toContain(
      'Signed in as Alice (alice@example.com)',
    );
  });

  it('blocks only the signed-in account identities from session replay', async () => {
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: true,
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      capabilities: ['portal-v1'],
      storageAvailable: true,
      account: CONNECTED_STATUS.account,
    });

    // As SettingsOverlay mounts the section, so the page itself is recorded.
    await act(async () => {
      root.render(
        <SettingsReplayPrivacyContext.Provider
          value={SETTINGS_SECTION_REPLAY_PRIVACY.account}
        >
          <AccountTab />
        </SettingsReplayPrivacyContext.Provider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Signed in as Linear User');
    for (const identity of [
      'Alice',
      'alice@example.com',
      'claude@example.com',
      'codex@example.com',
      'Linear User',
    ]) {
      expectReplayBlocksOnlyValue(container, identity);
    }
    expect(
      outermostReplayBlock(findByTestId('settings-linear-token-input')),
    ).toBeNull();
    expect(outermostReplayBlock(oauthLoginButton())).toBeNull();
  });

  it('offers no gateway key field when the account declares no gateway', async () => {
    await renderAccountTab();

    expect(findByTestId('settings-model-gateway-credential')).toBeNull();
  });

  it('lists the gateway as an LLM provider, ahead of the personal sign-ins', async () => {
    // A gateway IS a provider: it is where the member's turns actually run.
    // It sat in a section of its own above the header, which read as an
    // unrelated settings block rather than as the route that supersedes the
    // two sign-ins under it.
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: true,
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      capabilities: ['portal-v1'],
      storageAvailable: true,
      account: CONNECTED_STATUS.account,
      enforcedSettings: [
        {
          organizationId: 'org-acme',
          organizationName: 'Acme',
          policies: [
            {
              kind: 'model-gateway',
              baseUrl: 'https://gw.acme.test',
              models: [],
              enforced: true,
              promptCachePassthrough: true,
            },
          ],
        },
      ],
    });
    Object.assign(window.api, {
      loadModelGatewayCredential: jest.fn(() =>
        Promise.resolve({
          organizationId: 'org-acme',
          apiKey: '',
          baseUrlAtSave: '',
          storageAvailable: true,
        }),
      ),
    });

    await renderAccountTab();

    const card = findByTestId('settings-model-gateway-credential');
    expect(card).not.toBeNull();
    expect(card?.getAttribute('data-organization-id')).toBe('org-acme');
    expect(card?.textContent).toContain('Acme');
    expect(card?.textContent).toContain('https://gw.acme.test');
    expect(findByTestId('settings-model-gateway-key-input')).not.toBeNull();

    // Inside the LLM Provider section and before the Claude tile. Asserting
    // only "before Claude" would pass in the OLD layout too, where the card
    // sat above the heading entirely — the heading is the discriminating end.
    const heading = findByTestId('account-section-header-llm-provider');
    const claudePanel = findByTestId('auth-panel-claude');
    expect(heading).not.toBeNull();
    expect(claudePanel).not.toBeNull();
    if (!card || !heading || !claudePanel) {
      throw new Error('Expected the gateway card and LLM provider panels');
    }
    expect(
      heading.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      card.compareDocumentPosition(claudePanel) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Sized and placed like the Claude/Codex marks. The org's own image needs
    // a wire field the desktop does not receive yet, so the relevant
    // placeholder stands in rather than a broken image.
    expect(findByTestId('model-gateway-org-logo-placeholder')).not.toBeNull();
  });

  it('lists one gateway row per org, the selected context org first', async () => {
    function gatewayOrg(
      organizationId: string,
      organizationName: string,
    ): Record<string, unknown> {
      return {
        organizationId,
        organizationName,
        policies: [
          {
            kind: 'model-gateway',
            baseUrl: `https://gw.${organizationName.toLowerCase()}.test`,
            models: [],
            enforced: false,
            promptCachePassthrough: true,
          },
        ],
      };
    }
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: true,
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      capabilities: ['portal-v1'],
      storageAvailable: true,
      account: CONNECTED_STATUS.account,
      enforcedSettings: [
        gatewayOrg('org-alpha', 'Alpha'),
        gatewayOrg('org-zeta', 'Zeta'),
        gatewayOrg('org-beta', 'Beta'),
      ],
    });
    Object.assign(window.api, {
      loadModelGatewayCredential: jest.fn((organizationId: string) =>
        Promise.resolve({
          organizationId,
          apiKey: '',
          baseUrlAtSave: '',
          storageAvailable: true,
        }),
      ),
    });
    mockScopingContext = { kind: 'organization', organizationId: 'org-zeta' };

    await renderAccountTab();

    const cards = Array.from(
      container.querySelectorAll(
        '[data-testid="settings-model-gateway-credential"]',
      ),
    ).map((card) => card.getAttribute('data-organization-id'));
    expect(cards).toEqual(['org-zeta', 'org-alpha', 'org-beta']);
  });

  it('keeps a debounced key bound to the gateway where it was entered', async () => {
    const loadModelGatewayCredential = jest.fn((organizationId: string) =>
      Promise.resolve({
        organizationId,
        apiKey: '',
        baseUrlAtSave: '',
        storageAvailable: true,
      }),
    );
    const saveModelGatewayCredential = jest.fn(() =>
      Promise.resolve({ valid: true, error: null }),
    );
    Object.assign(window.api, {
      loadModelGatewayCredential,
      saveModelGatewayCredential,
    });
    const acmeGateway = {
      organizationId: 'org-acme',
      organizationName: 'Acme',
      baseUrl: 'https://gw.acme.test',
      enforced: true,
      modelIds: [],
    };
    const betaGateway = {
      organizationId: 'org-beta',
      organizationName: 'Beta',
      baseUrl: 'https://gw.beta.test',
      enforced: true,
      modelIds: [],
    };

    await act(async () => {
      root.render(<ModelGatewayCredentialSection gateway={acmeGateway} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const input = findByTestId(
      'settings-model-gateway-key-input',
    ) as HTMLInputElement | null;
    if (!input) throw new Error('Gateway key input not found');
    act(() => {
      setInputValue(input, 'sk-acme');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      root.render(<ModelGatewayCredentialSection gateway={betaGateway} />);
      await Promise.resolve();
    });
    await act(async () => {
      jest.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(saveModelGatewayCredential).toHaveBeenCalledWith({
      organizationId: 'org-acme',
      baseUrl: 'https://gw.acme.test',
      apiKey: 'sk-acme',
    });
  });

  it('keeps a newer gateway edit when a retry read finishes late', async () => {
    const changed = jest.fn();
    window.addEventListener(MODEL_GATEWAY_CREDENTIAL_CHANGED_EVENT, changed);
    const failure = {
      version: 1,
      code: 'SECURE_STORAGE_READ_UNAVAILABLE',
      operation: 'read',
      state: 'locked',
      backend: null,
      retryable: true,
    };
    let finishRead: (state: object) => void = () => undefined;
    const pendingRead = new Promise<object>((resolve) => {
      finishRead = resolve;
    });
    const load = jest
      .fn()
      .mockResolvedValueOnce({
        apiKey: '',
        storageAvailable: true,
        secureStorageFailure: failure,
      })
      .mockReturnValueOnce(pendingRead);
    const save = jest.fn().mockResolvedValue({ valid: true, error: null });
    Object.assign(window.api, {
      loadModelGatewayCredential: load,
      saveModelGatewayCredential: save,
    });
    const gateway = {
      organizationId: 'org-acme',
      organizationName: 'Acme',
      baseUrl: 'https://gw.acme.test',
      enforced: true,
      modelIds: [],
    };
    await act(async () => {
      root.render(<ModelGatewayCredentialSection gateway={gateway} />);
      await Promise.resolve();
    });
    const retry = findByTestId('secure-storage-retry');
    const input = findByTestId('settings-model-gateway-key-input');
    if (!retry || !(input instanceof HTMLInputElement))
      throw new Error('Gateway controls missing');
    act(() => retry.click());
    act(() => {
      setInputValue(input, 'new-user-key');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      finishRead({ apiKey: 'old-key', storageAvailable: true });
      await pendingRead;
    });
    expect(input.value).toBe('new-user-key');
    expect(changed).not.toHaveBeenCalled();
    await flushApiKeyDebounce();
    expect(save).toHaveBeenCalledWith({
      organizationId: gateway.organizationId,
      baseUrl: gateway.baseUrl,
      apiKey: 'new-user-key',
    });
    expect(changed).toHaveBeenCalledTimes(1);
    window.removeEventListener(MODEL_GATEWAY_CREDENTIAL_CHANGED_EVENT, changed);
  });

  it('offers gateway write retry after an IPC rejection', async () => {
    const changed = jest.fn();
    window.addEventListener(MODEL_GATEWAY_CREDENTIAL_CHANGED_EVENT, changed);
    const gateway = {
      organizationId: 'org-acme',
      organizationName: 'Acme',
      baseUrl: 'https://gw.acme.test',
      enforced: true,
      modelIds: [],
    };
    Object.assign(window.api, {
      loadModelGatewayCredential: jest
        .fn()
        .mockResolvedValue({ apiKey: '', storageAvailable: true }),
      saveModelGatewayCredential: jest
        .fn()
        .mockRejectedValue(new Error('store unavailable')),
    });
    await act(async () => {
      root.render(<ModelGatewayCredentialSection gateway={gateway} />);
      await Promise.resolve();
    });
    const input = findByTestId('settings-model-gateway-key-input');
    if (!(input instanceof HTMLInputElement))
      throw new Error('Gateway input missing');
    act(() => {
      setInputValue(input, 'new-user-key');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flushApiKeyDebounce();
    expect(
      findByTestId('secure-storage-notice')?.getAttribute('data-storage-state'),
    ).toBe('failed');
    expect(findByTestId('secure-storage-retry')).not.toBeNull();
    expect(container.textContent).not.toContain('Checking your key');
    expect(container.textContent).not.toContain('unlock your system');
    expect(changed).not.toHaveBeenCalled();
    window.removeEventListener(MODEL_GATEWAY_CREDENTIAL_CHANGED_EVENT, changed);
  });

  it('retries the new gateway read after its URL changes during an older save', async () => {
    let finishOldSave: (result: { valid: boolean; error: null }) => void = () =>
      undefined;
    const oldSave = new Promise<{ valid: boolean; error: null }>((resolve) => {
      finishOldSave = resolve;
    });
    const load = jest
      .fn()
      .mockResolvedValueOnce({ apiKey: 'old-key', storageAvailable: true })
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValueOnce({ apiKey: 'stored-key', storageAvailable: true });
    const save = jest
      .fn()
      .mockReturnValueOnce(oldSave)
      .mockResolvedValue({ valid: true, error: null });
    Object.assign(window.api, {
      loadModelGatewayCredential: load,
      saveModelGatewayCredential: save,
    });
    const original = {
      organizationId: 'org-acme',
      organizationName: 'Acme',
      baseUrl: 'https://old.test',
      enforced: true,
      modelIds: [],
    };
    await act(async () => {
      root.render(<ModelGatewayCredentialSection gateway={original} />);
      await Promise.resolve();
    });
    const input = findByTestId('settings-model-gateway-key-input');
    if (!(input instanceof HTMLInputElement))
      throw new Error('Gateway input missing');
    act(() => {
      setInputValue(input, 'pending-old-key');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flushApiKeyDebounce();
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => {
      root.render(
        <ModelGatewayCredentialSection
          gateway={{ ...original, baseUrl: 'https://new.test' }}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishOldSave({ valid: true, error: null });
      await oldSave;
      await Promise.resolve();
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(findByTestId('secure-storage-notice')).not.toBeNull();
    expect(container.textContent).not.toContain('Checking your key');
    const retry = findByTestId('secure-storage-retry');
    if (!retry) throw new Error('Read retry missing');
    await act(async () => {
      retry.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(load).toHaveBeenCalledTimes(3);
    expect(save).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('stored-key');
  });

  it('waits for a pending gateway save before reading the credential for a new URL', async () => {
    let finishSave: (result: { valid: boolean; error: null }) => void = () =>
      undefined;
    const pendingSave = new Promise<{ valid: boolean; error: null }>(
      (resolve) => {
        finishSave = resolve;
      },
    );
    let persisted = 'stored-old-key';
    const load = jest.fn(() =>
      Promise.resolve({ apiKey: persisted, storageAvailable: true }),
    );
    const save = jest.fn(() =>
      pendingSave.then((result) => {
        persisted = 'new-key';
        return result;
      }),
    );
    Object.assign(window.api, {
      loadModelGatewayCredential: load,
      saveModelGatewayCredential: save,
    });
    const original = {
      organizationId: 'org-acme',
      organizationName: 'Acme',
      baseUrl: 'https://old.test',
      enforced: true,
      modelIds: [],
    };
    await act(async () => {
      root.render(<ModelGatewayCredentialSection gateway={original} />);
      await Promise.resolve();
    });
    const input = findByTestId('settings-model-gateway-key-input');
    if (!(input instanceof HTMLInputElement))
      throw new Error('Gateway input missing');
    act(() => {
      setInputValue(input, 'new-key');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flushApiKeyDebounce();
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => {
      root.render(
        <ModelGatewayCredentialSection
          gateway={{ ...original, baseUrl: 'https://new.test' }}
        />,
      );
      await Promise.resolve();
    });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishSave({ valid: true, error: null });
      await pendingSave;
      await Promise.resolve();
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(input.value).toBe('new-key');
  });

  it('cancels a debounced gateway save when its URL changes', async () => {
    const load = jest
      .fn()
      .mockResolvedValue({ apiKey: '', storageAvailable: true });
    const save = jest.fn().mockResolvedValue({ valid: true, error: null });
    Object.assign(window.api, {
      loadModelGatewayCredential: load,
      saveModelGatewayCredential: save,
    });
    const original = {
      organizationId: 'org-acme',
      organizationName: 'Acme',
      baseUrl: 'https://old.test',
      enforced: true,
      modelIds: [],
    };
    await act(async () => {
      root.render(<ModelGatewayCredentialSection gateway={original} />);
      await Promise.resolve();
    });
    const input = findByTestId('settings-model-gateway-key-input');
    if (!(input instanceof HTMLInputElement))
      throw new Error('Gateway input missing');
    act(() => {
      setInputValue(input, 'old-url-key');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      root.render(
        <ModelGatewayCredentialSection
          gateway={{ ...original, baseUrl: 'https://new.test' }}
        />,
      );
      await Promise.resolve();
    });
    await flushApiKeyDebounce();
    expect(save).not.toHaveBeenCalled();
  });

  it('persists overlapping gateway edits in order', async () => {
    let finishFirst: (result: { valid: boolean; error: null }) => void = () =>
      undefined;
    const first = new Promise<{ valid: boolean; error: null }>((resolve) => {
      finishFirst = resolve;
    });
    const save = jest
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValue({ valid: true, error: null });
    Object.assign(window.api, {
      loadModelGatewayCredential: jest
        .fn()
        .mockResolvedValue({ apiKey: '', storageAvailable: true }),
      saveModelGatewayCredential: save,
    });
    const gateway = {
      organizationId: 'org-acme',
      organizationName: 'Acme',
      baseUrl: 'https://gw.acme.test',
      enforced: true,
      modelIds: [],
    };
    await act(async () => {
      root.render(<ModelGatewayCredentialSection gateway={gateway} />);
      await Promise.resolve();
    });
    const input = findByTestId('settings-model-gateway-key-input');
    if (!(input instanceof HTMLInputElement))
      throw new Error('Gateway input missing');
    act(() => {
      setInputValue(input, 'first-key');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flushApiKeyDebounce();
    act(() => {
      setInputValue(input, 'latest-key');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flushApiKeyDebounce();
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishFirst({ valid: true, error: null });
      await first;
      await Promise.resolve();
    });
    expect(save).toHaveBeenNthCalledWith(2, {
      organizationId: gateway.organizationId,
      baseUrl: gateway.baseUrl,
      apiKey: 'latest-key',
    });
    expect(input.value).toBe('latest-key');
  });

  it('initializes a legacy saved key with the API Key segment selected', async () => {
    loadCanopyCloudApiKey.mockResolvedValue('csk_saved');
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: true,
      authMode: null,
      credentialSource: null,
      capabilities: ['portal-v1'],
      storageAvailable: true,
      account: CONNECTED_STATUS.account,
    });
    await renderAccountTab();

    expect(isSegmentSelected('api_key')).toBe(true);
    expect(isSegmentSelected('oauth')).toBe(false);
    expect(getCloudApiKeyInput().value).toBe('csk_saved');
  });

  it('completes OAuth login and shows the connected account', async () => {
    const events: Event[] = [];
    const listener = (event: Event): void => {
      events.push(event);
    };
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, listener);

    try {
      await renderAccountTab();
      loadCanopyCloudAccount.mockResolvedValue({
        hasApiKey: true,
        authMode: 'oauth',
        credentialSource: 'oauth_desktop',
        capabilities: ['portal-v1'],
        storageAvailable: true,
        account: CONNECTED_STATUS.account,
      });

      await clickAsync(oauthLoginButton());

      expect(startCanopyCloudOAuthLogin).toHaveBeenCalledTimes(1);
      expect(cloudSectionText()).toContain(
        'Signed in as Alice (alice@example.com)',
      );
      expect(oauthLoginButton().textContent?.trim()).toBe('Change account');
      expect(
        findByTestId('settings-account-canopy-cloud-disconnect'),
      ).not.toBeNull();
      expect(events.length).toBe(1);
    } finally {
      window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, listener);
    }
  });

  // Regression: Linear-gated surfaces (Home branch picker, composer + menu)
  // stay mounted underneath this overlay, so saving a key has to announce
  // itself or they keep telling the user to connect one.
  it.each(['lin_api_recovered', ''])(
    'refreshes mounted Linear consumers after a failed-read retry recovers %j',
    async (token) => {
      const { useLinearAvailability, invalidateLinearStatusCache } =
        jest.requireActual<typeof LinearStatusHooks>('@/hooks/useLinearStatus');
      invalidateLinearStatusCache();
      function MountedConsumer(): JSX.Element {
        const { available, tokenLoaded } = useLinearAvailability();
        return (
          <output data-testid="linear-consumer">{`${tokenLoaded}:${available}`}</output>
        );
      }
      const failedRead = {
        success: false,
        error: 'Unavailable',
        secureStorageFailure: {
          version: 1,
          code: 'SECURE_STORAGE_READ_UNAVAILABLE',
          operation: 'read',
          state: 'locked',
          backend: null,
          retryable: true,
        },
      };
      const load = jest.fn().mockResolvedValue(failedRead);
      const validate = jest.fn().mockResolvedValue({
        authenticated: true,
        displayName: 'Linear User',
        error: null,
      });
      Object.assign(window.api, {
        loadLinearToken: load,
        validateLinearToken: validate,
      });
      const changed = jest.fn();
      window.addEventListener(LINEAR_CONNECTION_CHANGED_EVENT, changed);
      try {
        await act(async () => {
          root.render(
            <>
              <MountedConsumer />
              <AccountTab />
            </>,
          );
          await Promise.resolve();
        });
        expect(findByTestId('linear-consumer')?.textContent).toBe('true:false');
        expect(changed).not.toHaveBeenCalled();
        const retry = findByTestId('secure-storage-retry');
        if (!(retry instanceof HTMLButtonElement))
          throw new Error('Retry missing');
        await clickAsync(retry);
        expect(changed).not.toHaveBeenCalled();
        load.mockResolvedValue(token);
        await clickAsync(retry);
        expect(findByTestId('secure-storage-notice')).toBeNull();
        expect(changed).toHaveBeenCalledTimes(1);
        expect(findByTestId('linear-consumer')?.textContent).toBe(
          `true:${!!token}`,
        );
        expect(window.api.saveLinearToken).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener(LINEAR_CONNECTION_CHANGED_EVENT, changed);
        invalidateLinearStatusCache();
      }
    },
  );

  it('announces the Linear connection change once the key is saved', async () => {
    const events: Event[] = [];
    const listener = (event: Event): void => {
      events.push(event);
    };
    window.addEventListener(LINEAR_CONNECTION_CHANGED_EVENT, listener);

    try {
      await renderAccountTab();

      const input = findByTestId('settings-linear-token-input');
      if (!(input instanceof HTMLInputElement)) {
        throw new Error('Linear token input not found');
      }

      await act(async () => {
        setInputValue(input, 'lin_api_test');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await Promise.resolve();
      });
      // Nothing is persisted yet, so nothing should have been announced.
      expect(events.length).toBe(0);

      await flushApiKeyDebounce();

      expect(window.api.saveLinearToken).toHaveBeenCalledWith('lin_api_test');
      expect(events.length).toBe(1);
    } finally {
      window.removeEventListener(LINEAR_CONNECTION_CHANGED_EVENT, listener);
    }
  });

  it.each(['linear', 'github'])(
    'does not announce a discarded %s token and offers retry',
    async (provider) => {
      const failure = {
        version: 1,
        code: 'SECURE_STORAGE_WRITE_REFUSED',
        operation: 'write',
        state: 'locked',
        backend: null,
        retryable: true,
      };
      const method =
        provider === 'linear' ? 'saveLinearToken' : 'saveGitHubPat';
      const save = jest.fn().mockResolvedValue({
        success: false,
        error: 'Unavailable',
        secureStorageFailure: failure,
      });
      Object.assign(window.api, { [method]: save });
      const events: Event[] = [];
      const name =
        provider === 'linear'
          ? LINEAR_CONNECTION_CHANGED_EVENT
          : GITHUB_CONNECTION_CHANGED_EVENT;
      const listener = (event: Event): void => {
        events.push(event);
      };
      window.addEventListener(name, listener);
      try {
        await renderAccountTab();
        if (provider === 'github') {
          const toggle = Array.from(container.querySelectorAll('button')).find(
            (button) => button.textContent === 'Personal access token',
          );
          await act(async () => {
            toggle?.click();
            await Promise.resolve();
          });
        }
        const input = findByTestId(
          provider === 'linear'
            ? 'settings-linear-token-input'
            : 'auth-panel-github-pat-input',
        );
        if (!(input instanceof HTMLInputElement))
          throw new Error('Missing token field');
        await act(async () => {
          setInputValue(input, 'test-token');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await Promise.resolve();
        });
        await flushApiKeyDebounce();
        expect(save).toHaveBeenCalledWith('test-token');
        expect(events).toHaveLength(0);
        expect(
          findByTestId('secure-storage-notice')?.getAttribute(
            'data-storage-state',
          ),
        ).toBe('locked');
        expect(findByTestId('secure-storage-retry')).not.toBeNull();
        expect(input.value).toBe('test-token');
      } finally {
        window.removeEventListener(name, listener);
      }
    },
  );

  it.each(['linear', 'github'] as const)(
    'does not replace a newer %s edit when a retry read finishes late',
    async (provider) => {
      const readFailure = {
        success: false,
        error: 'Storage is locked',
        secureStorageFailure: {
          version: 1,
          code: 'SECURE_STORAGE_READ_UNAVAILABLE',
          operation: 'read',
          state: 'locked',
          backend: null,
          retryable: true,
        },
      };
      let finishRead: (value: string) => void = () => undefined;
      const pendingRead = new Promise<string>((resolve) => {
        finishRead = resolve;
      });
      const read = jest
        .fn()
        .mockResolvedValueOnce(readFailure)
        .mockReturnValueOnce(pendingRead);
      const method =
        provider === 'linear' ? 'loadLinearToken' : 'loadGitHubPat';
      Object.assign(window.api, { [method]: read });
      await renderAccountTab();
      if (provider === 'github') {
        const toggle = Array.from(container.querySelectorAll('button')).find(
          (button) => button.textContent === 'Personal access token',
        );
        act(() => toggle?.click());
      }
      const retry = findByTestId('secure-storage-retry');
      const input = findByTestId(
        provider === 'linear'
          ? 'settings-linear-token-input'
          : 'auth-panel-github-pat-input',
      );
      if (!retry || !(input instanceof HTMLInputElement))
        throw new Error('Credential controls missing');
      act(() => retry.click());
      act(() => {
        setInputValue(input, 'new-user-edit');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => {
        finishRead('older-stored-key');
        await pendingRead;
      });
      expect(input.value).toBe('new-user-edit');
      await flushApiKeyDebounce();
      const save =
        provider === 'linear'
          ? window.api.saveLinearToken
          : window.api.saveGitHubPat;
      expect(save).toHaveBeenCalledWith('new-user-edit');
    },
  );

  it.each(['linear', 'github'] as const)(
    'releases %s saving after an in-flight IPC rejection and retries the same edit',
    async (provider) => {
      let failSave: (error: Error) => void = () => undefined;
      const pendingSave = new Promise<never>((_resolve, reject) => {
        failSave = reject;
      });
      const save = jest
        .fn()
        .mockReturnValueOnce(pendingSave)
        .mockResolvedValue({ success: true });
      Object.assign(window.api, {
        [provider === 'linear' ? 'saveLinearToken' : 'saveGitHubPat']: save,
      });
      const name =
        provider === 'linear'
          ? LINEAR_CONNECTION_CHANGED_EVENT
          : GITHUB_CONNECTION_CHANGED_EVENT;
      const changed = jest.fn();
      window.addEventListener(name, changed);
      try {
        await renderAccountTab();
        if (provider === 'github') {
          const toggle = Array.from(container.querySelectorAll('button')).find(
            (button) => button.textContent === 'Personal access token',
          );
          act(() => toggle?.click());
        }
        const input = findByTestId(
          provider === 'linear'
            ? 'settings-linear-token-input'
            : 'auth-panel-github-pat-input',
        );
        if (!(input instanceof HTMLInputElement))
          throw new Error('Credential input missing');
        act(() => {
          setInputValue(input, 'retry-this-key');
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await flushApiKeyDebounce();
        expect(save).toHaveBeenCalledTimes(1);
        await act(async () => {
          failSave(new Error('store unavailable'));
          await Promise.resolve();
        });
        expect(
          findByTestId('secure-storage-notice')?.getAttribute(
            'data-storage-state',
          ),
        ).toBe('failed');
        expect(container.textContent).not.toContain('unlock your system');
        const retry = findByTestId('secure-storage-retry');
        expect(retry?.hasAttribute('disabled')).toBe(false);
        expect(changed).not.toHaveBeenCalled();
        await act(async () => {
          retry?.click();
          await Promise.resolve();
        });
        expect(save).toHaveBeenNthCalledWith(2, 'retry-this-key');
        expect(changed).toHaveBeenCalledTimes(1);
        expect(findByTestId('secure-storage-notice')).toBeNull();
      } finally {
        window.removeEventListener(name, changed);
      }
    },
  );

  it.each(['linear', 'github'] as const)(
    'persists overlapping %s edits in order and announces each persisted transition',
    async (provider) => {
      let finishFirst: (result: { success: boolean }) => void = () => undefined;
      const first = new Promise<{ success: boolean }>((resolve) => {
        finishFirst = resolve;
      });
      const save = jest
        .fn()
        .mockReturnValueOnce(first)
        .mockResolvedValue({ success: true });
      Object.assign(window.api, {
        [provider === 'linear' ? 'saveLinearToken' : 'saveGitHubPat']: save,
      });
      const name =
        provider === 'linear'
          ? LINEAR_CONNECTION_CHANGED_EVENT
          : GITHUB_CONNECTION_CHANGED_EVENT;
      const changed = jest.fn();
      window.addEventListener(name, changed);
      try {
        await renderAccountTab();
        if (provider === 'github') {
          const toggle = Array.from(container.querySelectorAll('button')).find(
            (button) => button.textContent === 'Personal access token',
          );
          act(() => toggle?.click());
        }
        const input = findByTestId(
          provider === 'linear'
            ? 'settings-linear-token-input'
            : 'auth-panel-github-pat-input',
        );
        if (!(input instanceof HTMLInputElement))
          throw new Error('Credential input missing');
        act(() => {
          setInputValue(input, 'first-key');
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await flushApiKeyDebounce();
        act(() => {
          setInputValue(input, 'latest-key');
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await flushApiKeyDebounce();
        expect(save).toHaveBeenCalledTimes(1);
        await act(async () => {
          finishFirst({ success: true });
          await first;
          await Promise.resolve();
        });
        expect(save).toHaveBeenNthCalledWith(2, 'latest-key');
        expect(changed).toHaveBeenCalledTimes(2);
        expect(input.value).toBe('latest-key');
      } finally {
        window.removeEventListener(name, changed);
      }
    },
  );

  it.each([
    ['linear', 'stale-token'],
    ['linear', ''],
    ['github', 'stale-token'],
    ['github', ''],
  ] as const)(
    'reads a reopened %s field only after the closed tab flushes %j',
    async (provider, staleDraft) => {
      // Main persists each token in arrival order: the last submitted save
      // is the stored token.
      let persisted = 'saved-token';
      let finishFirst: (result: { success: boolean }) => void = () => undefined;
      const save = jest
        .fn()
        .mockImplementationOnce((token: string) => {
          persisted = token;
          return new Promise<{ success: boolean }>((resolve) => {
            finishFirst = resolve;
          });
        })
        .mockImplementation((token: string) => {
          persisted = token;
          return Promise.resolve({ success: true });
        });
      const load = jest.fn(() => Promise.resolve(persisted));
      Object.assign(window.api, {
        [provider === 'linear' ? 'saveLinearToken' : 'saveGitHubPat']: save,
        [provider === 'linear' ? 'loadLinearToken' : 'loadGitHubPat']: load,
      });
      const tokenInput = async (): Promise<HTMLInputElement> => {
        const testId =
          provider === 'linear'
            ? 'settings-linear-token-input'
            : 'auth-panel-github-pat-input';
        if (!findByTestId(testId) && provider === 'github') {
          await clickAsync(findButton('Personal access token'));
        }
        const input = findByTestId(testId);
        if (!(input instanceof HTMLInputElement))
          throw new Error('Credential input missing');
        return input;
      };
      await renderAccountTab();
      const closing = await tokenInput();
      act(() => {
        setInputValue(closing, 'first-token');
        closing.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await flushApiKeyDebounce();
      expect(save).toHaveBeenCalledTimes(1);
      act(() => {
        setInputValue(closing, staleDraft);
        closing.dispatchEvent(new Event('input', { bubbles: true }));
        root.render(null);
      });

      // Reopening must not load, and offer for editing, the token that the
      // closed tab's queued write is about to replace.
      await renderAccountTab();
      expect(load).toHaveBeenCalledTimes(1);

      await act(async () => {
        finishFirst({ success: true });
        for (let i = 0; i < 8; i += 1) await Promise.resolve();
      });
      expect(save).toHaveBeenCalledTimes(2);
      expect(persisted).toBe(staleDraft);
      const reopened = await tokenInput();
      expect(reopened.value).toBe(staleDraft);

      act(() => {
        setInputValue(reopened, 'newest-token');
        reopened.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await flushApiKeyDebounce();
      expect(save).toHaveBeenCalledTimes(3);
      expect(persisted).toBe('newest-token');
    },
  );

  it('shows disconnect-specific copy when OAuth disconnect fails', async () => {
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: true,
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      serverApiKeyId: 'key-1',
      capabilities: ['portal-v1'],
      storageAvailable: true,
      account: CONNECTED_STATUS.account,
    });
    disconnectCanopyCloudAccount.mockRejectedValue(
      new Error('revocation failed'),
    );

    await renderAccountTab();

    await clickAsync(
      findByTestId(
        'settings-account-canopy-cloud-disconnect',
      ) as HTMLButtonElement,
    );

    expect(cloudSectionText()).toContain(
      'Unable to disconnect Canopy Cloud account.',
    );
    expect(cloudSectionText()).not.toContain('Unable to complete');
  });

  it('cancels a pending OAuth login without changing the saved account', async () => {
    let rejectStart: (error: Error) => void = () => {};
    startCanopyCloudOAuthLogin.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectStart = reject;
        }),
    );
    cancelCanopyCloudOAuthLogin.mockImplementation(() => {
      rejectStart(new Error('OAuth login cancelled.'));
      return Promise.resolve();
    });

    await renderAccountTab();

    await clickAsync(oauthLoginButton());
    // Login is in flight: the primary button shows the pending label and a
    // Cancel button is offered.
    expect(oauthLoginButton().textContent?.trim()).toBe('Waiting for browser…');

    const cancelButton = findByTestId(
      'settings-account-canopy-cloud-oauth-cancel',
    ) as HTMLButtonElement | null;
    await clickAsync(cancelButton ?? undefined);

    expect(cancelCanopyCloudOAuthLogin).toHaveBeenCalledTimes(1);
    // Pending state cleared, saved account untouched.
    expect(oauthLoginButton().textContent?.trim()).toBe('Sign in');
    expect(document.activeElement).toBe(oauthLoginButton());
    expect(cloudSectionText()).toContain(
      'Sign in through your browser to connect your Canopy Cloud account.',
    );
    expect(cloudSectionText()).not.toContain('Signed in as');
    expect(cloudSectionText()).not.toContain('Unable to complete');
  });

  it('does not steal focus when OAuth settles after the user moves elsewhere', async () => {
    let rejectStart: (error: Error) => void = () => {};
    startCanopyCloudOAuthLogin.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectStart = reject;
        }),
    );
    await renderAccountTab();
    await clickAsync(oauthLoginButton());
    await clickAsync(
      findByTestId(
        'settings-account-canopy-cloud-oauth-cancel',
      ) as HTMLButtonElement,
    );
    const linearInput = findByTestId(
      'settings-linear-token-input',
    ) as HTMLInputElement;
    linearInput.focus();

    await act(async () => {
      rejectStart(new Error('OAuth login cancelled.'));
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(document.activeElement).toBe(linearInput);
  });

  it('validates and saves a typed API key in API Key mode without manual buttons', async () => {
    await renderAccountTab();
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: true,
      authMode: 'api_key',
      credentialSource: 'manual',
      capabilities: ['portal-v1'],
      storageAvailable: true,
      account: CONNECTED_STATUS.account,
    });
    loadCanopyCloudApiKey.mockResolvedValue('csk_test');

    selectSegment('api_key');

    const input = getCloudApiKeyInput();
    await act(async () => {
      setInputValue(input, ' csk_test ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    await flushApiKeyDebounce();

    expect(saveCanopyCloudApiKey).toHaveBeenCalledWith({ apiKey: 'csk_test' });
    expect(validateCanopyCloudApiKey).not.toHaveBeenCalled();
    expect(findButton('Save API key')).toBeUndefined();
    expect(findButton('Validate API key')).toBeUndefined();
    expect(findButton('Remove API key')).toBeUndefined();
    expect(input.value).toBe('csk_test');
    expect(cloudSectionText()).toContain(
      'Signed in as Alice (alice@example.com)',
    );
  });

  it('clears the saved API key when the field is cleared', async () => {
    loadCanopyCloudApiKey.mockResolvedValue('csk_saved');
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: true,
      authMode: 'api_key',
      credentialSource: 'manual',
      capabilities: ['portal-v1'],
      storageAvailable: true,
      account: CONNECTED_STATUS.account,
    });

    await renderAccountTab();

    const input = getCloudApiKeyInput();
    await act(async () => {
      setInputValue(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await flushApiKeyDebounce();

    expect(clearCanopyCloudApiKey).toHaveBeenCalledTimes(1);
  });

  it('does not delete the saved credential when switching modes', async () => {
    loadCanopyCloudApiKey.mockResolvedValue('csk_saved');
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: true,
      authMode: 'api_key',
      credentialSource: 'manual',
      capabilities: ['portal-v1'],
      storageAvailable: true,
      account: CONNECTED_STATUS.account,
    });

    await renderAccountTab();

    // Starts in API Key mode; flip to OAuth and back.
    selectSegment('oauth');
    selectSegment('api_key');

    await flushApiKeyDebounce();

    expect(clearCanopyCloudApiKey).not.toHaveBeenCalled();
    expect(disconnectCanopyCloudAccount).not.toHaveBeenCalled();
    expect(saveCanopyCloudApiKey).not.toHaveBeenCalled();
  });

  it('does not present an OAuth credential as a connected manual API key', async () => {
    loadCanopyCloudApiKey.mockResolvedValue('csk_oauth_secret');
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: true,
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      serverApiKeyId: 'key-1',
      capabilities: ['portal-v1'],
      storageAvailable: true,
      account: CONNECTED_STATUS.account,
    });

    await renderAccountTab();

    expect(isSegmentSelected('oauth')).toBe(true);
    expect(cloudStatusDot().className).toContain('bg-success');

    selectSegment('api_key');

    expect(getCloudApiKeyInput().value).toBe('');
    expect(cloudSectionText()).toContain(
      'Paste a Canopy Cloud API key to connect your account.',
    );
    expect(cloudSectionText()).not.toContain('Signed in as');
    expect(cloudStatusDot().className).toContain('bg-destructive');
  });

  it('keeps the host connection signal true when viewing API Key mode with OAuth connected', async () => {
    loadCanopyCloudApiKey.mockResolvedValue('csk_oauth_secret');
    loadCanopyCloudAccount.mockResolvedValue({
      hasApiKey: true,
      authMode: 'oauth',
      credentialSource: 'oauth_desktop',
      serverApiKeyId: 'key-1',
      capabilities: ['portal-v1'],
      storageAvailable: true,
      account: CONNECTED_STATUS.account,
    });

    function HostHarness(): JSX.Element {
      const [connected, setConnected] = useState(false);
      return (
        <>
          <CanopyCloudAccountSection onConnectedChange={setConnected} />
          <button data-testid="privacy-controls" disabled={!connected}>
            Privacy
          </button>
        </>
      );
    }

    await act(async () => {
      root.render(<HostHarness />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(isSegmentSelected('oauth')).toBe(true);
    expect(cloudStatusDot().className).toContain('bg-success');
    expect(getPrivacyControlsButton().disabled).toBe(false);

    selectSegment('api_key');

    expect(cloudStatusDot().className).toContain('bg-destructive');
    expect(getPrivacyControlsButton().disabled).toBe(false);
  });

  async function renderAccountTab(): Promise<void> {
    await act(async () => {
      root.render(<AccountTab />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function findByTestId(testId: string): HTMLElement | null {
    return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  }

  function cloudSection(): HTMLElement {
    const section = findByTestId('settings-account-canopy-cloud-section');
    if (!section) throw new Error('Canopy Cloud section not found');
    return section;
  }

  function cloudSectionText(): string {
    return cloudSection().textContent ?? '';
  }

  function oauthLoginButton(): HTMLButtonElement {
    const button = findByTestId(
      'settings-account-canopy-cloud-oauth-login',
    ) as HTMLButtonElement | null;
    if (!button) throw new Error('OAuth login button not found');
    return button;
  }

  function cloudStatusDot(): HTMLElement {
    const dot = findByTestId('settings-account-canopy-cloud-status-dot');
    if (!dot) throw new Error('Canopy Cloud status dot not found');
    return dot;
  }

  function findCloudApiKeyInput(): HTMLInputElement | null {
    return container.querySelector<HTMLInputElement>(
      '[data-testid="settings-account-canopy-cloud-api-key-input"]',
    );
  }

  function getCloudApiKeyInput(): HTMLInputElement {
    const input = findCloudApiKeyInput();
    if (!input) throw new Error('Canopy Cloud API key input not found');
    return input;
  }

  /** The mode-switch link for `mode` (rendered inside the *other* pane). */
  function getSegment(mode: 'oauth' | 'api_key'): HTMLButtonElement {
    const testId =
      mode === 'oauth'
        ? 'settings-account-canopy-cloud-mode-oauth'
        : 'settings-account-canopy-cloud-mode-api-key';
    const button = container.querySelector<HTMLButtonElement>(
      `[data-testid="${testId}"]`,
    );
    if (!button) throw new Error(`Segment ${mode} not found`);
    return button;
  }

  /**
   * The OAuth/API-key segmented control is gone: only the active mode's pane
   * renders, and the inactive mode is reachable through a text link inside it.
   * "Selected" is therefore pane presence, not a highlighted segment class.
   */
  function isSegmentSelected(mode: 'oauth' | 'api_key'): boolean {
    return (
      findByTestId(
        mode === 'oauth'
          ? 'settings-account-canopy-cloud-oauth'
          : 'settings-account-canopy-cloud-api-key',
      ) !== null
    );
  }

  /** Clicks the link that swaps to `mode`; it lives inside the other pane. */
  function selectSegment(mode: 'oauth' | 'api_key'): void {
    const button = getSegment(mode);
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  async function clickAsync(
    button: HTMLButtonElement | undefined,
  ): Promise<void> {
    if (!button) throw new Error('button not found');
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function setInputValue(input: HTMLInputElement, value: string): void {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    );
    if (descriptor?.set) {
      const setValue = descriptor.set.bind(input) as (next: string) => void;
      setValue(value);
    } else {
      input.value = value;
    }
  }

  function findButton(label: string): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === label,
    );
  }

  function getPrivacyControlsButton(): HTMLButtonElement {
    const button = findByTestId('privacy-controls') as HTMLButtonElement | null;
    if (!button) throw new Error('Privacy controls button not found');
    return button;
  }

  async function flushApiKeyDebounce(): Promise<void> {
    await act(async () => {
      jest.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
    });
  }
});
