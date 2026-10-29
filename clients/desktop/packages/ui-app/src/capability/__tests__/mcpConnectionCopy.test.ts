import {
  mcpConnectActionLabel,
  mcpConnectionStatusConnected,
  mcpConnectionStatusLabel,
  mcpConnectToAccountActionLabel,
  mcpConnectToAccountDescription,
  mcpDesktopInstallNote,
  MCP_CONNECT_ONCE_FOR_HARNESSES,
  MCP_PROVIDER_CONNECTOR_LABELS,
  MCP_PROVIDER_ROUTES_TITLE,
  MCP_SHARED_ACROSS_HARNESSES,
  mcpFoldedPluginSkillsNote,
  mcpAppRouteDescription,
  mcpAppRouteTitle,
  mcpProviderAccountPhrase,
  mcpProviderOnlyGuidance,
  mcpProviderRoutesDescription,
  mcpUseAccountConnectionActionLabel,
  type McpConnectionCopyState,
} from '../mcpConnectionCopy';

describe('MCP connection copy (REG-3052)', () => {
  it.each<[McpConnectionCopyState, string, boolean]>([
    ['account-connected', 'Granola is connected to your account', true],
    ['account-reauth', 'Granola needs reconnecting', false],
    ['account-not-connected', "Granola isn't connected to your account", false],
    [
      'device-connected-only',
      'Granola is connected on this desktop only',
      true,
    ],
    ['device-connected', 'Granola is connected on this desktop', true],
    ['device-not-connected', "Granola isn't connected on this desktop", false],
  ])('words %s with the service and its scope', (state, label, connected) => {
    expect(mcpConnectionStatusLabel('Granola', state)).toBe(label);
    expect(mcpConnectionStatusConnected(state)).toBe(connected);
  });

  it('never reads like the app sign-in', () => {
    const states: McpConnectionCopyState[] = [
      'account-connected',
      'account-reauth',
      'account-not-connected',
      'device-connected-only',
      'device-connected',
      'device-not-connected',
    ];
    for (const state of states) {
      const label = mcpConnectionStatusLabel('Granola', state);
      expect(label).not.toMatch(/signed in/i);
      expect(label).not.toContain('—');
    }
  });

  it('names the service in its actions', () => {
    expect(mcpConnectActionLabel('Granola')).toBe('Connect Granola');
    expect(mcpConnectActionLabel('Granola', true)).toBe('Reconnect Granola');
    expect(mcpConnectToAccountActionLabel('Granola')).toBe(
      'Connect Granola to your account',
    );
    expect(mcpUseAccountConnectionActionLabel('Granola')).toBe(
      'Use Granola from your account',
    );
  });

  it('says a move without an account connection signs in again', () => {
    expect(mcpConnectToAccountDescription('Granola', false)).toBe(
      "Connect it to your account to use Granola on the web and in cloud chats. You'll sign in to Granola once more.",
    );
    expect(mcpConnectToAccountDescription('Granola', true)).toBe(
      'Granola is connected to your account. Use that connection on this desktop too, so it matches the web and cloud chats.',
    );
  });

  it('describes a desktop install without claiming a desktop sign-in', () => {
    expect(mcpDesktopInstallNote('Granola', 'Studio Mac', false)).toBe(
      'Installed on Studio Mac only. Connect Granola to use it here and in cloud chats.',
    );
    expect(mcpDesktopInstallNote('Granola', null, true)).toBe(
      'Also installed on your desktop',
    );
  });

  it('falls back to a generic name when the service has none', () => {
    expect(mcpConnectionStatusLabel('  ', 'account-not-connected')).toBe(
      "This server isn't connected to your account",
    );
  });
});

describe('MCP connection route copy (REG-3033)', () => {
  it('names the app route and the provider route apart', () => {
    expect(mcpAppRouteTitle('Unstoppable Code')).toBe(
      'Unstoppable Code MCP server',
    );
    expect(MCP_PROVIDER_ROUTES_TITLE).toBe('Provider connections');
  });

  it('says who holds each connection and where its tools appear', () => {
    expect(mcpAppRouteDescription('Unstoppable Code')).toBe(
      'Connects through Unstoppable Code. Works with every supported harness.',
    );
    expect(
      mcpProviderRoutesDescription('Unstoppable Code', ['Claude', 'Codex']),
    ).toBe(
      'Connects through your Claude or Codex account. Works in every chat on that provider, and Unstoppable Code never sees these credentials.',
    );
  });

  it('names only the providers that offer the connector', () => {
    expect(mcpProviderAccountPhrase(['Claude'])).toBe('your Claude account');
    expect(mcpProviderAccountPhrase(['Claude', 'Codex'])).toBe(
      'your Claude or Codex account',
    );
    expect(mcpProviderAccountPhrase(['Claude', 'Codex', 'Cursor'])).toBe(
      'your Claude, Codex, or Cursor account',
    );
    expect(mcpProviderAccountPhrase([])).toBe('your provider account');
    expect(mcpProviderRoutesDescription('Canopy', ['Claude'])).toBe(
      'Connects through your Claude account. Works in every chat on that provider, and Canopy never sees these credentials.',
    );
  });

  it('uses no em dashes', () => {
    for (const text of [
      mcpAppRouteTitle('Canopy'),
      mcpAppRouteDescription('Canopy'),
      MCP_PROVIDER_ROUTES_TITLE,
      mcpProviderRoutesDescription('Canopy', ['Claude', 'Codex']),
    ]) {
      expect(text).not.toContain('\u2014');
    }
  });

  it('keeps the connection card sentences with the rest of the copy', () => {
    expect(MCP_SHARED_ACROSS_HARNESSES).toBe(
      'Shared across your supported harnesses.',
    );
    expect(MCP_CONNECT_ONCE_FOR_HARNESSES).toBe(
      'Connect once for all supported harnesses.',
    );
    expect(mcpFoldedPluginSkillsNote('Linear')).toBe(
      'Add also installs the Linear skills.',
    );
  });

  it('tells a provider-only service how to connect, naming only its providers', () => {
    expect(mcpProviderOnlyGuidance('Gmail', ['Claude'])).toBe(
      'Gmail connects through your Claude account. Connect Claude first, then link Gmail there.',
    );
    expect(mcpProviderOnlyGuidance('Gmail', ['Claude', 'Codex'])).toBe(
      'Gmail connects through your Claude or Codex account. Connect Claude or Codex first, then link Gmail there.',
    );
    expect(mcpProviderOnlyGuidance('Gmail', [])).toBe(
      "This server can't be connected from here.",
    );
    expect(mcpProviderOnlyGuidance('  ', ['Claude'])).toBe(
      'This server connects through your Claude account. Connect Claude first, then link This server there.',
    );
    expect(MCP_PROVIDER_CONNECTOR_LABELS).toEqual({
      claude: 'Claude',
      codex: 'Codex',
    });
  });
});
