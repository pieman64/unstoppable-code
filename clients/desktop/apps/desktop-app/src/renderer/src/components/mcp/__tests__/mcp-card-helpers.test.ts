import type {
  McpOAuthConfigData,
  McpServerConnectionStatus,
  McpServerIndexEntry,
  McpServerStatusEntry,
} from '@canopy/desktop-shared/types/mcp-servers';
import type { CuratedMcpServerEntry } from '@canopy/protocol/mcp-catalog';
import {
  mcpConnectionStatusBadgeClass,
  mcpConnectionStatusLabel,
} from '../mcp-card-helpers';
import {
  deriveMcpConnectionBadge,
  curatedMetadataForServerType,
  curatedInitialUrl,
  curatedRequiresProviderAuth,
  getMcpConnectConfigId,
  mcpRowSubtitle,
  oauthFromDefinition,
  oauthFromCuratedHints,
  optionalNumberInputValue,
  validateOAuthForm,
  validateCuratedSetup,
} from '../../pages/McpServersTab';

describe('curatedMetadataForServerType', () => {
  const curated = { key: 'notion', logoUrl: 'https://example.test/logo.png' };

  it('preserves curated metadata for HTTP definitions', () => {
    expect(curatedMetadataForServerType('http', curated)).toBe(curated);
  });

  it('drops curated metadata when converting to a command definition', () => {
    expect(curatedMetadataForServerType('command', curated)).toBeUndefined();
  });
});

describe('mcpConnectionStatusLabel', () => {
  const cases: Array<[McpServerConnectionStatus, string]> = [
    ['connected', 'Connected'],
    ['auth_required', 'Auth required'],
    ['unreachable', 'Unreachable'],
    ['unknown', 'Not checked'],
  ];
  it.each(cases)('labels %s as "%s"', (status, label) => {
    expect(mcpConnectionStatusLabel(status)).toBe(label);
  });

  it('uses distinct tone classes per status', () => {
    expect(mcpConnectionStatusBadgeClass('connected')).toContain(
      'success-strong',
    );
    expect(mcpConnectionStatusBadgeClass('auth_required')).toContain('warning');
    expect(mcpConnectionStatusBadgeClass('unreachable')).toContain(
      'destructive',
    );
    expect(mcpConnectionStatusBadgeClass('unknown')).toContain('muted');
  });
});

function makeStatus(
  overrides: Partial<McpServerStatusEntry> = {},
): McpServerStatusEntry {
  return {
    serverId: 's1',
    transport: 'http',
    connectionStatus: 'connected',
    reachability: 'reachable',
    configs: [],
    ...overrides,
  };
}

describe('deriveMcpConnectionBadge', () => {
  it('returns unknown when there is no status entry', () => {
    expect(deriveMcpConnectionBadge(undefined)).toEqual({
      status: 'unknown',
      isProvider: false,
    });
  });

  it('passes through the connection status for canopy-handled servers', () => {
    expect(
      deriveMcpConnectionBadge(
        makeStatus({ handler: 'canopy', connectionStatus: 'auth_required' }),
      ),
    ).toEqual({ status: 'auth_required', isProvider: false });
  });

  it('renders reachability-only (never auth_required) for provider-managed servers', () => {
    // Even if the derived connectionStatus were auth_required, a provider
    // handler downgrades to reachability and flags the provider annotation.
    expect(
      deriveMcpConnectionBadge(
        makeStatus({
          handler: 'provider',
          connectionStatus: 'auth_required',
          reachability: 'reachable',
        }),
      ),
    ).toEqual({ status: 'connected', isProvider: true });

    expect(
      deriveMcpConnectionBadge(
        makeStatus({ handler: 'provider', reachability: 'unreachable' }),
      ),
    ).toEqual({ status: 'unreachable', isProvider: true });

    expect(
      deriveMcpConnectionBadge(
        makeStatus({ handler: 'provider', reachability: 'unknown' }),
      ),
    ).toEqual({ status: 'unknown', isProvider: true });
  });
});

describe('getMcpConnectConfigId', () => {
  const server: McpServerIndexEntry = {
    id: 's1',
    name: 'Server',
    description: '',
    type: 'http',
    updatedAt: '2026-07-01T00:00:00.000Z',
    configs: [
      { id: 'disabled', name: 'Disabled', enabled: false },
      { id: 'enabled', name: 'Enabled', enabled: true },
    ],
  };

  it('never selects a disabled configuration for row-level OAuth', () => {
    expect(
      getMcpConnectConfigId(
        server,
        makeStatus({
          configs: [
            { configId: 'disabled', authStatus: 'not_connected' },
            { configId: 'enabled', authStatus: 'not_connected' },
          ],
        }),
      ),
    ).toBe('enabled');
  });
});

describe('mcpRowSubtitle', () => {
  const base = {
    id: 's1',
    name: 'GitHub',
    description: 'GitHub MCP server',
    type: 'http' as const,
    updatedAt: '2026-07-01T00:00:00.000Z',
  };

  it('uses the description for zero or one config', () => {
    expect(mcpRowSubtitle({ ...base, configs: [] })).toBe('GitHub MCP server');
    expect(
      mcpRowSubtitle({
        ...base,
        configs: [{ id: 'c1', name: 'Default', enabled: true }],
      }),
    ).toBe('GitHub MCP server');
  });

  it('uses only enabled configs when choosing and building the summary', () => {
    expect(
      mcpRowSubtitle({
        ...base,
        configs: [
          { id: 'c1', name: 'Prod', enabled: true },
          { id: 'c2', name: 'Staging', enabled: false },
        ],
      }),
    ).toBe('GitHub MCP server');
    expect(
      mcpRowSubtitle({
        ...base,
        configs: [
          { id: 'c1', name: 'Prod', enabled: true },
          { id: 'c2', name: 'Staging', enabled: true },
          { id: 'c3', name: 'Disabled', enabled: false },
        ],
      }),
    ).toBe('2 configs · Prod, Staging');
  });
});

describe('OAuth form helpers', () => {
  it('normalizes invalid optional number input values', () => {
    expect(optionalNumberInputValue(Number.NaN)).toBeUndefined();
    expect(optionalNumberInputValue(3118)).toBe(3118);
  });

  it('opens advanced overrides for a custom fixed callback port', () => {
    const form = oauthFromDefinition({
      callbackPort: 3118,
    } satisfies McpOAuthConfigData);

    expect(form.advancedOpen).toBe(true);
    expect(validateOAuthForm(form)).toEqual({
      oauth: { usePkce: true, callbackPort: 3118 },
      error: null,
    });
  });

  it('preserves an explicit usePkce=false value through form validation', () => {
    const form = oauthFromCuratedHints({
      key: 'legacy-oauth',
      name: 'Legacy OAuth',
      shortDescription: 'OAuth fixture',
      url: 'https://mcp.example.test',
      transport: 'http',
      oauthHints: { usePkce: false },
      categories: [],
      popular: false,
      sortOrder: 0,
      updatedAt: '2026-07-14T00:00:00.000Z',
    } satisfies CuratedMcpServerEntry);

    expect(validateOAuthForm(form)).toEqual({
      oauth: { usePkce: false },
      error: null,
    });
  });

  it('preserves a curated fixed callback port', () => {
    const entry = {
      key: 'fixed-port',
      name: 'Fixed Port',
      shortDescription: 'OAuth fixture',
      url: 'https://mcp.example.test',
      transport: 'http',
      oauthHints: { callbackPort: 3118 },
      categories: [],
      popular: false,
      sortOrder: 0,
      updatedAt: '2026-07-14T00:00:00.000Z',
    } satisfies CuratedMcpServerEntry;

    expect(oauthFromCuratedHints(entry).advancedOpen).toBe(true);
    expect(validateOAuthForm(oauthFromCuratedHints(entry))).toMatchObject({
      oauth: { callbackPort: 3118 },
      error: null,
    });
  });

  it('rejects curated OAuth endpoints split across origins', () => {
    const form = oauthFromCuratedHints({
      key: 'split-origin',
      name: 'Split Origin',
      shortDescription: 'OAuth fixture',
      url: 'https://mcp.example.test',
      transport: 'http',
      oauthHints: {
        authorizationUrl: 'https://auth.example.test/authorize',
        tokenUrl: 'https://tokens.evil.test/token',
      },
      categories: [],
      popular: false,
      sortOrder: 0,
      updatedAt: '2026-07-14T00:00:00.000Z',
    } satisfies CuratedMcpServerEntry);

    expect(validateOAuthForm(form)).toEqual({
      oauth: null,
      error: 'OAuth Authorization URL and Token URL must use the same origin.',
    });
  });

  it('selects catalog endpoints and validates required client setup', () => {
    const entry = {
      key: 'regional',
      name: 'Regional',
      shortDescription: 'Regional fixture',
      url: 'https://fallback.example.test',
      transport: 'http',
      oauthHints: {},
      requiredConfigFields: [{ kind: 'oauth-client-id' }],
      urlOptions: [
        { url: 'https://eu.example.test', label: 'Europe' },
        { url: 'https://us.example.test', label: 'United States' },
      ],
      categories: [],
      popular: false,
      sortOrder: 0,
      updatedAt: '2026-07-14T00:00:00.000Z',
    } satisfies CuratedMcpServerEntry;
    const form = oauthFromCuratedHints(entry);

    expect(curatedInitialUrl(entry)).toBe('https://eu.example.test');
    expect(validateCuratedSetup(entry, curatedInitialUrl(entry), form)).toMatch(
      /Client ID is required/,
    );
    expect(
      validateCuratedSetup(entry, 'https://invalid.example.test', {
        ...form,
        clientId: 'public-client',
      }),
    ).toMatch(/available MCP endpoints/);
  });

  it('routes catalog entries requiring secrets to provider-managed auth', () => {
    const entry = {
      key: 'secret-client',
      name: 'Secret Client',
      shortDescription: 'Secret fixture',
      url: 'https://mcp.example.test',
      transport: 'http',
      requiredConfigFields: [
        { kind: 'oauth-client-secret' },
        { kind: 'oauth-client-id' },
      ],
      categories: [],
      popular: false,
      sortOrder: 0,
      updatedAt: '2026-07-14T00:00:00.000Z',
    } satisfies CuratedMcpServerEntry;

    expect(curatedRequiresProviderAuth(entry)).toBe(true);
    expect(
      validateCuratedSetup(entry, entry.url, oauthFromCuratedHints(entry)),
    ).toBeNull();
  });
});
