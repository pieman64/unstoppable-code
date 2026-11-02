/**
 * @jest-environment jsdom
 */
// `AuthLoginModal` (the provider recovery route) pulls xterm in at module
// load, which jsdom cannot construct. Mirrors ChatBlockRenderer.test.tsx.
jest.mock('@xterm/xterm', () => ({ Terminal: jest.fn() }));
jest.mock('@xterm/addon-fit', () => ({ FitAddon: jest.fn() }));

const mockHostedSettingsOpenable = jest.fn<boolean, []>(() => false);
jest.mock(
  '@/components/settings/hosted/hosted-settings-availability',
  (): typeof HostedSettingsAvailabilityModule => ({
    ...jest.requireActual<typeof HostedSettingsAvailabilityModule>(
      '@/components/settings/hosted/hosted-settings-availability',
    ),
    hostedSettingsOpenable: (): boolean => mockHostedSettingsOpenable(),
  }),
);

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AuthDependencyFailure,
  AuthFailureClass,
} from '@canopy/protocol/auth-recovery';
import {
  AuthRecoveryCard,
  authRecoveryMessage,
  resolveAuthRecoveryAction,
} from '../AuthRecoveryCard';
import {
  MCP_AUTH_RECOVERY_POLL_INTERVAL_MS,
  MCP_AUTH_RECOVERY_POLL_TIMEOUT_MS,
} from '@/hooks/useMcpAuthRecovery';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import type * as HostedSettingsAvailabilityModule from '@/components/settings/hosted/hosted-settings-availability';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const MCP_NAME = 'Prod MCP server';

/** An MCP failure in the shape main actually produces for `failureClass`. */
function mcpFailure(failureClass: AuthFailureClass): AuthDependencyFailure {
  const recoverable =
    failureClass === 'unauthenticated' ||
    failureClass === 'expired' ||
    failureClass === 'revoked' ||
    failureClass === 'reauthorization_required';
  return {
    dependencyClass: 'mcp',
    dependencyId: 'srv-1:cfg-1',
    displayName: MCP_NAME,
    failureClass,
    recovery: recoverable
      ? { kind: 'mcp_oauth', serverId: 'srv-1', configId: 'cfg-1' }
      : { kind: 'none' },
  };
}

/**
 * Case tables are ANNOTATED, never `as`-asserted (CAN-1814 review). A widening
 * assertion on an array literal — `[...] as readonly AuthFailureClass[]` —
 * type checks a misspelled member as `string`, so the case would silently
 * render a different failure than its name claims. An annotation checks each
 * element at the declaration site instead.
 */
const FAILURE_COPY_CASES: ReadonlyArray<readonly [AuthFailureClass, string]> = [
  ['unauthenticated', `${MCP_NAME} needs to be reconnected.`],
  ['expired', `${MCP_NAME} needs to be reconnected.`],
  ['revoked', `${MCP_NAME} needs to be reconnected.`],
  ['reauthorization_required', `${MCP_NAME} needs to be reconnected.`],
  [
    'insufficient_scope',
    `${MCP_NAME} refused this request — the connection is missing a required permission. Reconnecting will not grant it.`,
  ],
  ['quota_exceeded', `${MCP_NAME} is over its usage limit.`],
  ['provider_outage', `${MCP_NAME} is unavailable right now.`],
  ['network_error', `Could not reach ${MCP_NAME}.`],
  ['misconfigured', `${MCP_NAME} is not fully configured.`],
  [
    'unsupported_auth_method',
    `${MCP_NAME} uses an authentication method that cannot be completed here.`,
  ],
];

/** The four classes that may carry a recovery method. */
const RECOVERABLE_CLASSES: readonly AuthFailureClass[] = [
  'unauthenticated',
  'expired',
  'revoked',
  'reauthorization_required',
];

/** Non-recoverable and not configuration-shaped: no action of any kind. */
const NO_ACTION_CLASSES: readonly AuthFailureClass[] = [
  'quota_exceeded',
  'provider_outage',
  'network_error',
];

/** Non-recoverable but fixable in configuration: settings, never a login. */
const SETTINGS_ONLY_CLASSES: readonly AuthFailureClass[] = [
  'insufficient_scope',
  'misconfigured',
  'unsupported_auth_method',
];

describe('AuthRecoveryCard copy and actions', () => {
  let container: HTMLDivElement;
  let root: Root;

  function render(...failures: readonly AuthDependencyFailure[]): void {
    act((): void => {
      root.render(<AuthRecoveryCard failures={failures} />);
    });
  }

  function card(): HTMLElement {
    const node = container.querySelector('[data-testid="auth-recovery-card"]');
    if (!(node instanceof HTMLElement)) {
      throw new Error('card did not render');
    }
    return node;
  }

  function button(testId: string): HTMLButtonElement | null {
    const node = container.querySelector(`[data-testid="${testId}"]`);
    return node instanceof HTMLButtonElement ? node : null;
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act((): void => root.unmount());
    container.remove();
  });

  // One case per failure class, as the plan's copy table requires. The four
  // recoverable classes offer a login action; the rest must not.
  it.each(FAILURE_COPY_CASES)(
    'names the dependency and explains %s',
    (failureClass, message) => {
      const failure = mcpFailure(failureClass);
      render(failure);

      expect(card().textContent).toContain(message);
      expect(authRecoveryMessage(failure)).toBe(message);
    },
  );

  it.each(RECOVERABLE_CLASSES)(
    'offers an inline reconnect for the recoverable class %s',
    (failureClass) => {
      render(mcpFailure(failureClass));

      const cta = button('chat-connection-cta-mcp');
      expect(cta).not.toBeNull();
      expect(cta?.textContent).toBe(`Reconnect ${MCP_NAME}`);
    },
  );

  it.each(NO_ACTION_CLASSES)(
    'offers no action at all for the non-recoverable class %s',
    (failureClass) => {
      render(mcpFailure(failureClass));

      expect(button('chat-connection-cta-mcp')).toBeNull();
      expect(button('auth-recovery-settings-cta')).toBeNull();
      expect(card().querySelectorAll('button')).toHaveLength(0);
    },
  );

  it.each(SETTINGS_ONLY_CLASSES)(
    'routes %s to settings and never to a login',
    (failureClass) => {
      render(mcpFailure(failureClass));

      expect(button('chat-connection-cta-mcp')).toBeNull();
      const settings = button('auth-recovery-settings-cta');
      expect(settings?.textContent).toBe(`Open ${MCP_NAME} settings`);
    },
  );

  it('opens the MCP settings surface from the settings action', () => {
    const openPluginsTab = jest.fn();
    const restore = useNavigationStore.getState().openPluginsTab;
    useNavigationStore.setState({ openPluginsTab });
    try {
      render(mcpFailure('insufficient_scope'));
      act((): void => {
        button('auth-recovery-settings-cta')?.click();
      });
      expect(openPluginsTab).toHaveBeenCalledWith('mcp');
    } finally {
      useNavigationStore.setState({ openPluginsTab: restore });
    }
  });

  it('offers the provider terminal login for a provider failure', () => {
    render({
      dependencyClass: 'provider',
      dependencyId: 'claude',
      displayName: 'Claude',
      failureClass: 'unauthenticated',
      recovery: { kind: 'provider_terminal', provider: 'claude' },
      detail: 'Claude is not authenticated.',
    });

    expect(button('chat-connection-cta-claude')?.textContent).toBe(
      'Reconnect Claude',
    );
    expect(card().textContent).toContain('Claude needs to be reconnected.');
    expect(card().textContent).toContain('Claude is not authenticated.');
  });

  // CAN-1814 PR 4. `integration` had no producer until the GitHub watcher
  // failure shipped, and `github_login` routed to Settings > Account with a
  // 'later slice' note. This is that slice: the CTA now opens the SAME
  // `gh auth login` terminal `AuthLoginModal` the settings surface would have
  // led to, one click earlier. No new auth was built.
  it('offers the gh auth login terminal for a GitHub integration failure', () => {
    const failure: AuthDependencyFailure = {
      dependencyClass: 'integration',
      dependencyId: 'integration:github',
      displayName: 'GitHub',
      failureClass: 'unauthenticated',
      recovery: { kind: 'github_login' },
      detail: 'No GitHub token is available.',
    };

    expect(resolveAuthRecoveryAction(failure)).toEqual({
      kind: 'provider-login',
      intent: 'connect',
      label: 'Reconnect GitHub',
      provider: 'github',
    });

    render(failure);
    expect(button('chat-connection-cta-github')?.textContent).toBe(
      'Reconnect GitHub',
    );
    expect(card().textContent).toContain('GitHub needs to be reconnected.');
    expect(card().textContent).toContain('No GitHub token is available.');
  });

  // Linear has no first-party terminal login — `resolveLinearToken` reads a
  // stored token, and there is no `gh`-equivalent CLI to drive. It stays on the
  // honest settings route rather than borrowing GitHub's modal.
  const LINEAR_FAILURE: AuthDependencyFailure = {
    dependencyClass: 'integration',
    dependencyId: 'integration:linear',
    displayName: 'Linear',
    failureClass: 'unauthenticated',
    recovery: { kind: 'linear_login' },
  };

  it('routes a Linear integration failure to the settings surface', () => {
    const openSettings = jest.fn();
    const restore = useNavigationStore.getState().openSettings;
    useNavigationStore.setState({ openSettings });
    mockHostedSettingsOpenable.mockReturnValue(false);
    try {
      expect(resolveAuthRecoveryAction(LINEAR_FAILURE)).toEqual({
        kind: 'open-settings',
        intent: 'connect',
        label: 'Connect Linear',
        destination: { kind: 'integrations' },
      });
      render(LINEAR_FAILURE);
      expect(button('chat-connection-cta-integration')?.textContent).toBe(
        'Connect Linear',
      );
      act((): void => {
        button('chat-connection-cta-integration')?.click();
      });
      expect(openSettings).toHaveBeenCalledWith('account');
    } finally {
      useNavigationStore.setState({ openSettings: restore });
    }
  });

  it('opens hosted Integrations for an integration failure when hosted settings are on', () => {
    const openSettings = jest.fn();
    const openAccountOrganizationSettings = jest.fn();
    const restore = useNavigationStore.getState();
    useNavigationStore.setState({
      openSettings,
      openAccountOrganizationSettings,
    });
    mockHostedSettingsOpenable.mockReturnValue(true);
    try {
      render(LINEAR_FAILURE);
      act((): void => {
        button('chat-connection-cta-integration')?.click();
      });
      expect(openAccountOrganizationSettings).toHaveBeenCalledWith({
        scope: 'account',
        page: 'integrations',
      });
      expect(openSettings).not.toHaveBeenCalled();
    } finally {
      mockHostedSettingsOpenable.mockReturnValue(false);
      useNavigationStore.setState({
        openSettings: restore.openSettings,
        openAccountOrganizationSettings:
          restore.openAccountOrganizationSettings,
      });
    }
  });

  it('sends GitHub and Linear settings routes to the integrations destination', () => {
    expect(
      resolveAuthRecoveryAction({
        dependencyClass: 'integration',
        dependencyId: 'integration:github',
        displayName: 'GitHub',
        failureClass: 'unauthenticated',
        recovery: {
          kind: 'settings_deeplink',
          target: { page: 'integrations', integration: 'github' },
        },
      }),
    ).toMatchObject({ destination: { kind: 'integrations' } });
    expect(
      resolveAuthRecoveryAction({
        dependencyClass: 'integration',
        dependencyId: 'integration:github',
        displayName: 'GitHub',
        failureClass: 'insufficient_scope',
        recovery: { kind: 'none' },
      }),
    ).toMatchObject({ destination: { kind: 'integrations' } });
  });

  it('renders no action for a persisted failure that breaks the wire invariant', () => {
    // The persisted read path does not re-validate `authFailure`, so a
    // hand-edited chat file can pair a non-recoverable class with a login
    // recovery. The card must refuse it even when its caller did not.
    const failure: AuthDependencyFailure = {
      dependencyClass: 'mcp',
      dependencyId: 'srv-1:cfg-1',
      displayName: MCP_NAME,
      failureClass: 'quota_exceeded',
      recovery: { kind: 'mcp_oauth', serverId: 'srv-1', configId: 'cfg-1' },
    };

    expect(resolveAuthRecoveryAction(failure)).toBeNull();
    render(failure);
    expect(button('chat-connection-cta-mcp')).toBeNull();
  });

  it('gates the action on recovery.kind, not on the failure class', () => {
    // Same recoverable class, no recovery method: still no login affordance.
    expect(
      resolveAuthRecoveryAction({
        dependencyClass: 'mcp',
        dependencyId: 'srv-1:cfg-1',
        displayName: MCP_NAME,
        failureClass: 'expired',
        recovery: { kind: 'none' },
      }),
    ).toBeNull();
  });
});

describe('AuthRecoveryCard inline MCP reconnect', () => {
  let container: HTMLDivElement;
  let root: Root;
  let startOAuthLogin: jest.Mock;
  const originalMcpServers = window.mcpServers;

  beforeEach(() => {
    jest.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    startOAuthLogin = jest.fn().mockResolvedValue({
      status: 'started',
      authorizationUrl: 'https://example.test/authorize?state=abc',
    });
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: {
        startOAuthLogin,
        checkHealth: jest.fn().mockResolvedValue({}),
        listStatus: jest.fn().mockResolvedValue([]),
      },
    });
  });

  afterEach(() => {
    act((): void => root.unmount());
    container.remove();
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: originalMcpServers,
    });
    jest.useRealTimers();
  });

  async function clickAndSettle(testId: string): Promise<void> {
    await act(async (): Promise<void> => {
      const node = container.querySelector(`[data-testid="${testId}"]`);
      if (node instanceof HTMLButtonElement) node.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('starts the existing OAuth flow and surfaces a clickable, copyable URL', async () => {
    act((): void => {
      root.render(<AuthRecoveryCard failures={[mcpFailure('expired')]} />);
    });

    await clickAndSettle('chat-connection-cta-mcp');

    expect(startOAuthLogin).toHaveBeenCalledWith({
      serverId: 'srv-1',
      configId: 'cfg-1',
    });
    const link = container.querySelector(
      '[data-testid="auth-recovery-authorization-url"]',
    );
    expect(link?.textContent).toBe('https://example.test/authorize?state=abc');
    expect(
      container.querySelector('[data-testid="auth-recovery-copy-url"]'),
    ).not.toBeNull();
  });

  it('keeps the authorization link visible after the verify poll times out', async () => {
    // The timeout copy tells the user to finish the login in their browser and
    // try again. Gating the link on `awaiting-browser` alone took it away at
    // exactly the moment that instruction needs it (CAN-1814 review).
    act((): void => {
      root.render(<AuthRecoveryCard failures={[mcpFailure('expired')]} />);
    });
    await clickAndSettle('chat-connection-cta-mcp');
    expect(
      container.querySelector(
        '[data-testid="auth-recovery-authorization-url"]',
      ),
    ).not.toBeNull();

    const ticks =
      MCP_AUTH_RECOVERY_POLL_TIMEOUT_MS / MCP_AUTH_RECOVERY_POLL_INTERVAL_MS;
    for (let index = 0; index < ticks; index += 1) {
      await act(async (): Promise<void> => {
        jest.advanceTimersByTime(MCP_AUTH_RECOVERY_POLL_INTERVAL_MS);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    expect(
      container.querySelector('[data-testid="auth-recovery-failure-detail"]')
        ?.textContent,
    ).toBe(
      'Still not connected. Switch to your browser to finish signing in, then try again.',
    );
    const link = container.querySelector(
      '[data-testid="auth-recovery-authorization-url"]',
    );
    expect(link?.textContent).toBe('https://example.test/authorize?state=abc');
    expect(
      container.querySelector('[data-testid="auth-recovery-copy-url"]'),
    ).not.toBeNull();
  });
});

/** A recoverable MCP failure for one specific server. */
function namedMcpFailure(
  serverId: string,
  displayName: string,
): AuthDependencyFailure {
  return {
    dependencyClass: 'mcp',
    dependencyId: `${serverId}:cfg-1`,
    displayName,
    failureClass: 'expired',
    recovery: { kind: 'mcp_oauth', serverId, configId: 'cfg-1' },
  };
}

describe('AuthRecoveryCard multi-blocker checklist', () => {
  let container: HTMLDivElement;
  let root: Root;
  let startOAuthLogin: jest.Mock;
  const originalMcpServers = window.mcpServers;

  const PROD = namedMcpFailure('srv-prod', 'Prod MCP server');
  const DOCS = namedMcpFailure('srv-docs', 'Docs MCP server');

  beforeEach(() => {
    jest.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    startOAuthLogin = jest.fn().mockResolvedValue({
      status: 'started',
      authorizationUrl: 'https://example.test/authorize',
    });
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: {
        startOAuthLogin,
        checkHealth: jest.fn().mockResolvedValue({}),
        // Never usable, so a started reconnect stays pending for the whole
        // test rather than racing to `connected`.
        listStatus: jest.fn().mockResolvedValue([]),
      },
    });
  });

  afterEach(() => {
    act((): void => root.unmount());
    container.remove();
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: originalMcpServers,
    });
    jest.useRealTimers();
  });

  function render(...failures: readonly AuthDependencyFailure[]): void {
    act((): void => {
      root.render(<AuthRecoveryCard failures={failures} />);
    });
  }

  function rows(): HTMLElement[] {
    return Array.from(
      container.querySelectorAll('[data-testid="auth-recovery-row"]'),
    ).filter((node): node is HTMLElement => node instanceof HTMLElement);
  }

  function row(failure: AuthDependencyFailure): HTMLElement {
    const node = container.querySelector(
      `[data-testid="auth-recovery-row"][data-dependency-id="${failure.dependencyId}"]`,
    );
    if (!(node instanceof HTMLElement)) {
      throw new Error(`no row for ${failure.dependencyId}`);
    }
    return node;
  }

  function cta(failure: AuthDependencyFailure): HTMLButtonElement | null {
    const node = row(failure).querySelector(
      '[data-testid="chat-connection-cta-mcp"]',
    );
    return node instanceof HTMLButtonElement ? node : null;
  }

  async function clickAndSettle(button: HTMLButtonElement): Promise<void> {
    await act(async (): Promise<void> => {
      button.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('renders one row per dependency inside a single card', () => {
    render(PROD, DOCS);

    expect(
      container.querySelectorAll('[data-testid="auth-recovery-card"]'),
    ).toHaveLength(1);
    expect(rows()).toHaveLength(2);
    expect(row(PROD).textContent).toContain(
      'Prod MCP server needs to be reconnected.',
    );
    expect(row(DOCS).textContent).toContain(
      'Docs MCP server needs to be reconnected.',
    );
    expect(cta(PROD)?.textContent).toBe('Reconnect Prod MCP server');
    expect(cta(DOCS)?.textContent).toBe('Reconnect Docs MCP server');
    expect(
      container.querySelector('[data-testid="auth-recovery-checklist-header"]')
        ?.textContent,
    ).toBe('2 connections need attention before this can continue.');
  });

  it('deduplicates by dependencyId', () => {
    // Two claims for the same server must not offer two logins for one token.
    render(PROD, { ...PROD, displayName: 'Prod MCP server (stale copy)' });

    expect(rows()).toHaveLength(1);
    expect(
      container.querySelector('[data-testid="auth-recovery-checklist-header"]'),
    ).toBeNull();
  });

  it('gives each row independent reconnect state', async () => {
    render(PROD, DOCS);

    const prodCta = cta(PROD);
    if (!prodCta) throw new Error('no CTA for the prod row');
    await clickAndSettle(prodCta);

    // The row that was clicked advances...
    expect(startOAuthLogin).toHaveBeenCalledTimes(1);
    expect(startOAuthLogin).toHaveBeenCalledWith({
      serverId: 'srv-prod',
      configId: 'cfg-1',
    });
    expect(cta(PROD)?.textContent).toBe('Waiting for browser…');
    expect(cta(PROD)?.disabled).toBe(true);
    expect(
      row(PROD).querySelector(
        '[data-testid="auth-recovery-authorization-url"]',
      ),
    ).not.toBeNull();

    // ...and the other one is neither started nor blocked by it.
    expect(cta(DOCS)?.textContent).toBe('Reconnect Docs MCP server');
    expect(cta(DOCS)?.disabled).toBe(false);
    expect(
      row(DOCS).querySelector(
        '[data-testid="auth-recovery-authorization-url"]',
      ),
    ).toBeNull();

    const docsCta = cta(DOCS);
    if (!docsCta) throw new Error('no CTA for the docs row');
    await clickAndSettle(docsCta);

    expect(startOAuthLogin).toHaveBeenCalledTimes(2);
    expect(startOAuthLogin).toHaveBeenLastCalledWith({
      serverId: 'srv-docs',
      configId: 'cfg-1',
    });
    // Starting the second reconnect did not reset the first.
    expect(cta(PROD)?.textContent).toBe('Waiting for browser…');
  });

  it("keeps one row's failed reconnect from collapsing the others", async () => {
    startOAuthLogin.mockImplementation(
      (request: { serverId: string }): Promise<{ status: string }> =>
        request.serverId === 'srv-prod'
          ? Promise.reject(new Error('OAuth is only for HTTP servers'))
          : Promise.resolve({ status: 'started' }),
    );
    render(PROD, DOCS);

    const prodCta = cta(PROD);
    if (!prodCta) throw new Error('no CTA for the prod row');
    await clickAndSettle(prodCta);

    expect(rows()).toHaveLength(2);
    expect(
      row(PROD).querySelector('[data-testid="auth-recovery-failure-detail"]')
        ?.textContent,
    ).toBe('OAuth is only for HTTP servers');
    expect(cta(PROD)?.textContent).toBe('Try again');
    expect(
      row(DOCS).querySelector('[data-testid="auth-recovery-failure-detail"]'),
    ).toBeNull();
    expect(cta(DOCS)?.textContent).toBe('Reconnect Docs MCP server');
  });

  it('offers no login on a non-recoverable row beside a recoverable one', () => {
    // The invariant is per row: `recovery.kind === 'none'` still explains the
    // problem and still refuses a login, even in a card that has one.
    const quota: AuthDependencyFailure = {
      dependencyClass: 'mcp',
      dependencyId: 'srv-quota:cfg-1',
      displayName: 'Metered MCP server',
      failureClass: 'quota_exceeded',
      recovery: { kind: 'none' },
    };
    render(PROD, quota);

    expect(rows()).toHaveLength(2);
    expect(cta(PROD)?.textContent).toBe('Reconnect Prod MCP server');
    expect(row(quota).textContent).toContain(
      'Metered MCP server is over its usage limit.',
    );
    expect(cta(quota)).toBeNull();
    expect(row(quota).querySelectorAll('button')).toHaveLength(0);
  });

  it('renders nothing at all when handed an empty list', () => {
    render();

    expect(
      container.querySelector('[data-testid="auth-recovery-card"]'),
    ).toBeNull();
  });
});

describe('AuthRecoveryCard turn resume', () => {
  const originalMcpServers = window.mcpServers;
  let originalState: ReturnType<typeof useChatStore.getState>;
  let container: HTMLDivElement;
  let root: Root;
  let tab: ChatTab;
  let sendMessage: jest.Mock;
  let connected: Set<string>;
  let refresh: (() => void) | undefined;

  beforeEach(() => {
    originalState = useChatStore.getState();
    connected = new Set();
    refresh = undefined;
    sendMessage = jest.fn().mockResolvedValue(undefined);
    tab = {
      id: 'auth-resume-unit',
      title: 'Chat',
      status: 'idle',
      error: null,
      createdAt: '2026-09-25T00:00:00.000Z',
      queuedMessages: [],
      planMode: false,
      proposalMode: 'optional',
      thinkingLevel: 'high',
      modelConfig: {
        thinkingLevel: 'high',
        speed: 'standard',
        fastMode: false,
      },
      fastModeExplicit: false,
      model: 'gpt-6-sol',
      providerType: 'codex',
      messages: [
        {
          id: 'request',
          role: 'user',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'Find the errors' }],
        },
        {
          id: 'failure',
          role: 'system',
          timestamp: 2,
          blocks: [{ type: 'text', text: 'Reconnect' }],
        },
      ],
    };
    useChatStore.setState({
      sendMessage,
      worktreeChats: {
        'project/worktree': { tabs: [tab], activeTabId: tab.id },
      },
    });
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: {
        startOAuthLogin: jest
          .fn()
          .mockImplementation(({ configId }: { configId: string }) => {
            connected.add(configId);
            return Promise.resolve({ status: 'completed' });
          }),
        checkHealth: jest.fn().mockResolvedValue({}),
        listStatus: jest.fn().mockImplementation(() =>
          Promise.resolve([
            {
              serverId: 'srv-1',
              configs: ['cfg-1', 'cfg-2'].map((configId) => ({
                configId,
                authStatus: connected.has(configId)
                  ? 'connected'
                  : 'not_connected',
              })),
            },
          ]),
        ),
        onAuthChanged: (listener: () => void): (() => void) => {
          refresh = listener;
          return () => {
            refresh = undefined;
          };
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
    useChatStore.setState(originalState, true);
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: originalMcpServers,
    });
  });
  async function render(
    failures: AuthDependencyFailure[] = [mcpFailure('expired')],
  ): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      root.render(
        <AuthRecoveryCard
          failures={failures}
          originChatTabId={tab.id}
          sourceMessageId="failure"
        />,
      );
    });
  }
  async function click(testId: string, index = 0): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      const buttons = container.querySelectorAll<HTMLButtonElement>(
        `[data-testid="${testId}"]`,
      );
      if (!buttons[index]) throw new Error('Missing recovery button');
      buttons[index].click();
    });
  }

  it('offers Resume once every blocking connection is ready and never resends on its own', async () => {
    await render([
      mcpFailure('expired'),
      {
        ...mcpFailure('expired'),
        dependencyId: 'srv-1:cfg-2',
        displayName: 'Second server',
        recovery: { kind: 'mcp_oauth', serverId: 'srv-1', configId: 'cfg-2' },
      },
    ]);
    await click('chat-connection-cta-mcp');
    expect(
      container.querySelector('[data-testid="auth-recovery-resume"]'),
    ).toBeNull();
    await click('chat-connection-cta-mcp');
    // Replaying the turn may repeat an external write, so only the
    // main-process path (gated on autoResumeSafe) resumes without asking.
    expect(sendMessage).not.toHaveBeenCalled();
    await click('auth-recovery-resume');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      'Find the errors',
      undefined,
      expect.any(Object),
      'typed',
      expect.any(Object),
    );
  });

  it('keeps a failed resume actionable without automatically retrying it', async () => {
    sendMessage.mockRejectedValue(new Error('dispatch refused'));
    await render();
    await click('chat-connection-cta-mcp');
    expect(sendMessage).not.toHaveBeenCalled();
    await click('auth-recovery-resume');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Could not resume. Try again.');
    expect(
      container.querySelector('[data-testid="auth-recovery-card"]'),
    ).not.toBeNull();
    await click('auth-recovery-resume');
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('keeps Resume after a failed dispatch leaves its user message behind', async () => {
    let attempts = 0;
    sendMessage.mockImplementation((text: string): Promise<void> => {
      attempts += 1;
      // Like the real store: the resume message is added before dispatch and
      // stays in the transcript, beside the error, when dispatch fails.
      const scope = useChatStore.getState().worktreeChats['project/worktree'];
      if (!scope) return Promise.reject(new Error('Missing chat scope'));
      useChatStore.setState({
        worktreeChats: {
          'project/worktree': {
            ...scope,
            tabs: scope.tabs.map((entry) => ({
              ...entry,
              status: 'error',
              messages: [
                ...entry.messages,
                {
                  id: `resume-attempt-${attempts}`,
                  role: 'user',
                  timestamp: 10 + attempts,
                  blocks: [{ type: 'text', text }],
                },
                {
                  id: `resume-error-${attempts}`,
                  role: 'system',
                  timestamp: 20 + attempts,
                  blocks: [{ type: 'text', text: 'dispatch refused' }],
                },
              ],
            })),
          },
        },
      });
      return Promise.reject(new Error('dispatch refused'));
    });
    await render();
    await click('chat-connection-cta-mcp');
    await click('auth-recovery-resume');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-testid="auth-recovery-card"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Could not resume. Try again.');
    await click('auth-recovery-resume');
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(
      container.querySelector('[data-testid="auth-recovery-resume"]'),
    ).not.toBeNull();
  });

  it('retires after a manual resume and stays retired after completion', async () => {
    connected.add('cfg-1');
    await render();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="auth-recovery-resume"]'),
    ).not.toBeNull();
    await act(async () => {
      await Promise.resolve();
      useChatStore.setState({
        worktreeChats: {
          'project/worktree': {
            activeTabId: tab.id,
            tabs: [
              {
                ...tab,
                messages: [
                  ...tab.messages,
                  {
                    id: 'continued',
                    role: 'user',
                    timestamp: 3,
                    blocks: [{ type: 'text', text: 'Continue' }],
                  },
                ],
              },
            ],
          },
        },
      });
      refresh?.();
    });
    expect(
      container.querySelector('[data-testid="auth-recovery-card"]'),
    ).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not offer an enabled Resume for a read-only chat', async () => {
    tab.readOnly = true;
    await render();
    await click('chat-connection-cta-mcp');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="auth-recovery-resume"]',
      )?.disabled,
    ).toBe(true);
  });
});
