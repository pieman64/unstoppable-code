import {
  curatedMcpDesktopOnly,
  curatedMcpProviderOnly,
  curatedMcpRequiresConnection,
  MCP_CATALOG_API_VERSION,
  MCP_CATALOG_AVAILABILITIES,
  MCP_CATALOG_TRANSPORTS,
  isCuratedMcpAvailability,
  isCuratedMcpOAuthHints,
  isCuratedMcpServerEntry,
  isCuratedMcpServerListResponse,
  isCuratedMcpTransport,
  type CuratedMcpServerEntry,
  type CuratedMcpServerListResponse,
} from '../index';

function makeEntry(
  overrides: Partial<CuratedMcpServerEntry> = {},
): CuratedMcpServerEntry {
  return {
    key: 'acme-mcp',
    name: 'Acme MCP',
    shortDescription: 'Acme tools over MCP',
    url: 'https://mcp.acme.example/v1',
    transport: 'http',
    categories: ['productivity'],
    popular: true,
    sortOrder: 0,
    updatedAt: '2026-07-14T00:00:00Z',
    ...overrides,
  };
}

function makeResponse(): CuratedMcpServerListResponse {
  return {
    version: MCP_CATALOG_API_VERSION,
    servers: [makeEntry()],
  };
}

/** Wrap arbitrary `servers` in a list-response envelope typed as `unknown`. */
function responseWith(servers: unknown): unknown {
  return { version: 1, servers };
}

describe('curated MCP catalog contract', () => {
  it('pins the API version and transport tuple', () => {
    expect(MCP_CATALOG_API_VERSION).toBe(1);
    expect(MCP_CATALOG_TRANSPORTS).toEqual(['http']);
  });

  it('pins the availability tuple and recognizes only its values', () => {
    expect(MCP_CATALOG_AVAILABILITIES).toEqual(['desktop']);
    expect(isCuratedMcpAvailability('desktop')).toBe(true);
    expect(isCuratedMcpAvailability('DESKTOP')).toBe(false);
    expect(isCuratedMcpAvailability('all')).toBe(false);
    expect(isCuratedMcpAvailability(null)).toBe(false);
  });

  it('accepts an entry marked desktop only and rejects an unknown availability', () => {
    expect(
      isCuratedMcpServerEntry(makeEntry({ availability: 'desktop' })),
    ).toBe(true);
    expect(
      isCuratedMcpServerEntry({ ...makeEntry(), availability: 'everywhere' }),
    ).toBe(false);
    expect(
      isCuratedMcpServerEntry({ ...makeEntry(), availability: null }),
    ).toBe(false);
  });

  it('recognizes valid transports and rejects unknown ones', () => {
    expect(isCuratedMcpTransport('http')).toBe(true);
    expect(isCuratedMcpTransport('command')).toBe(false);
    expect(isCuratedMcpTransport('HTTP')).toBe(false);
    expect(isCuratedMcpTransport(undefined)).toBe(false);
  });

  it('round-trips a fully-populated entry through JSON', () => {
    const entry = makeEntry({
      longDescription: 'A longer description',
      logoUrl: 'https://cdn.acme.example/logo.svg',
      oauthHints: {
        authorizationUrl: 'https://auth.acme.example/authorize',
        tokenUrl: 'https://auth.acme.example/token',
        scopes: ['read', 'write'],
        audience: 'acme',
        usePkce: true,
        clientId: 'public-client-id',
        callbackPort: 3118,
      },
      requiredConfigFields: [
        {
          kind: 'oauth-client-id',
          sourceUrl: 'https://acme.example/oauth-setup',
        },
      ],
      urlOptions: [
        {
          url: 'https://us.mcp.acme.example/v1',
          label: 'United States',
          description: 'Default region',
        },
      ],
      setupInstructions: 'Select the region matching your account.',
      authorName: 'Acme, Inc.',
      authorUrl: 'https://acme.example',
      docsUrl: 'https://acme.example/docs',
      supportUrl: 'https://acme.example/support',
      privacyPolicyUrl: 'https://acme.example/privacy',
      categories: ['productivity', 'dev-tools'],
    });

    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
    expect(isCuratedMcpServerEntry(entry)).toBe(true);
  });

  it('accepts a valid list response and round-trips it', () => {
    const response = makeResponse();
    expect(isCuratedMcpServerListResponse(response)).toBe(true);
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
  });

  it('accepts an empty catalog', () => {
    expect(isCuratedMcpServerListResponse({ version: 1, servers: [] })).toBe(
      true,
    );
  });

  it('rejects non-objects and missing fields', () => {
    expect(isCuratedMcpServerListResponse(null)).toBe(false);
    expect(isCuratedMcpServerListResponse(undefined)).toBe(false);
    expect(isCuratedMcpServerListResponse([])).toBe(false);
    expect(isCuratedMcpServerListResponse('nope')).toBe(false);
    expect(isCuratedMcpServerListResponse({ servers: [] })).toBe(false);
    expect(isCuratedMcpServerListResponse({ version: 1 })).toBe(false);
    expect(isCuratedMcpServerListResponse({ version: '1', servers: [] })).toBe(
      false,
    );
  });

  it('rejects a response containing a malformed entry', () => {
    const emptyKey = responseWith([{ ...makeEntry(), key: '' }]);
    const badTransport = responseWith([
      { ...makeEntry(), transport: 'command' },
    ]);
    const badCategories = responseWith([
      { ...makeEntry(), categories: 'productivity' },
    ]);
    const nanSortOrder = responseWith([
      { ...makeEntry(), sortOrder: Number.NaN },
    ]);

    expect(isCuratedMcpServerListResponse(emptyKey)).toBe(false);
    expect(isCuratedMcpServerListResponse(badTransport)).toBe(false);
    expect(isCuratedMcpServerListResponse(badCategories)).toBe(false);
    expect(isCuratedMcpServerListResponse(nanSortOrder)).toBe(false);
  });

  it('validates optional OAuth hints structurally', () => {
    expect(isCuratedMcpOAuthHints({})).toBe(true);
    expect(isCuratedMcpOAuthHints({ scopes: ['a', 'b'], usePkce: true })).toBe(
      true,
    );
    expect(isCuratedMcpOAuthHints({ scopes: 'a' })).toBe(false);
    expect(isCuratedMcpOAuthHints({ usePkce: 'yes' })).toBe(false);
    expect(isCuratedMcpOAuthHints({ callbackPort: 0 })).toBe(false);
    expect(isCuratedMcpOAuthHints({ callbackPort: 3118 })).toBe(true);
    expect(isCuratedMcpOAuthHints(null)).toBe(false);
  });

  it('never declares a clientSecret on the non-secret hints type', () => {
    // A rogue clientSecret is ignored by the structural guard — the type never
    // declares it and the backend admin schema rejects it on write.
    const entry = makeEntry({
      oauthHints: {
        clientId: 'public',
        // @ts-expect-error clientSecret is not part of the non-secret hints.
        clientSecret: 'should-never-be-here',
      },
    });
    expect(isCuratedMcpServerEntry(entry)).toBe(true);
  });
});

describe('providerConnector validation', () => {
  const base = {
    key: 'gmail-gmailmcp',
    name: 'Gmail',
    shortDescription: 'Read and send mail',
    url: 'https://gmailmcp.googleapis.com/mcp/v1',
    transport: 'http',
    categories: ['productivity'],
    popular: false,
    sortOrder: 0,
    updatedAt: '2026-08-27T00:00:00.000Z',
  };

  it('accepts a well-formed providerConnector', () => {
    expect(
      isCuratedMcpServerEntry({
        ...base,
        providerConnector: {
          providers: ['claude', 'codex'],
          claudeConnectorName: 'Gmail',
        },
      }),
    ).toBe(true);
  });

  it('rejects a providerConnector with no providers array', () => {
    // This struct is served by the hub, so a typo there is untrusted input.
    // Unvalidated, it reaches `normalizeProviderConnector`'s
    // `[...connector.providers]` spread and throws — and that throw is caught
    // where the whole catalog is discarded, so one malformed connector would
    // silently zero out every curated MCP server for every user.
    expect(
      isCuratedMcpServerEntry({
        ...base,
        providerConnector: { claudeConnectorName: 'Gmail' },
      }),
    ).toBe(false);
  });

  it('rejects a provider outside the known set', () => {
    expect(
      isCuratedMcpServerEntry({
        ...base,
        providerConnector: { providers: ['claude', 'gemini'] },
      }),
    ).toBe(false);
  });

  it('rejects non-string connector name overrides', () => {
    expect(
      isCuratedMcpServerEntry({
        ...base,
        providerConnector: { providers: ['claude'], claudeConnectorName: 7 },
      }),
    ).toBe(false);
  });
});

describe('curated MCP connection predicates', () => {
  const connector = { providers: ['claude'] };

  it('requires a connection for hints, required fields, or a provider connector', () => {
    expect(
      curatedMcpRequiresConnection({ oauthHints: { scopes: ['r'] } }),
    ).toBe(true);
    expect(
      curatedMcpRequiresConnection({ requiredConfigFields: [{ kind: 'x' }] }),
    ).toBe(true);
    expect(curatedMcpRequiresConnection({ providerConnector: connector })).toBe(
      true,
    );
    expect(
      curatedMcpRequiresConnection({
        oauthHints: [],
        requiredConfigFields: null,
        providerConnector: {},
      }),
    ).toBe(false);
  });

  it('requires a connection to choose between several endpoints', () => {
    const us = { url: 'https://us.example/mcp', label: 'US' };
    const eu = { url: 'https://eu.example/mcp', label: 'EU' };
    expect(curatedMcpRequiresConnection({ urlOptions: [us, eu] })).toBe(true);
    expect(curatedMcpRequiresConnection({ urlOptions: [eu] })).toBe(false);
    expect(curatedMcpRequiresConnection({ urlOptions: [] })).toBe(false);
    expect(curatedMcpRequiresConnection({ urlOptions: null })).toBe(false);
  });

  it('keeps a provider connector with several endpoints desktop only', () => {
    expect(
      curatedMcpDesktopOnly({
        providerConnector: connector,
        urlOptions: [
          { url: 'https://us.example/mcp', label: 'US' },
          { url: 'https://eu.example/mcp', label: 'EU' },
        ],
      }),
    ).toBe(true);
  });

  it('marks provider connectors without a cloud connection path provider only', () => {
    expect(curatedMcpProviderOnly({ providerConnector: connector })).toBe(true);
    expect(
      curatedMcpProviderOnly({
        providerConnector: connector,
        oauthHints: { scopes: ['r'] },
      }),
    ).toBe(false);
    expect(
      curatedMcpProviderOnly({
        providerConnector: connector,
        requiredConfigFields: [{ kind: 'x' }],
      }),
    ).toBe(false);
    expect(curatedMcpProviderOnly({ oauthHints: null })).toBe(false);
  });

  it('never reads a server the catalog marks desktop only as provider only', () => {
    expect(curatedMcpProviderOnly({ availability: 'desktop' })).toBe(false);
    expect(
      curatedMcpProviderOnly({
        availability: 'desktop',
        oauthHints: { scopes: ['r'] },
      }),
    ).toBe(false);
  });

  it('marks provider-only connectors and catalog-flagged servers desktop only', () => {
    // Provider connector without a cloud connection path.
    expect(curatedMcpDesktopOnly({ providerConnector: connector })).toBe(true);
    // Marked desktop only by the catalog, whatever else it declares.
    expect(curatedMcpDesktopOnly({ availability: 'desktop' })).toBe(true);
    expect(
      curatedMcpDesktopOnly({
        availability: 'desktop',
        oauthHints: { scopes: ['r'] },
        requiredConfigFields: [{ kind: 'x' }],
      }),
    ).toBe(true);
    expect(
      curatedMcpDesktopOnly({
        availability: 'desktop',
        providerConnector: connector,
        oauthHints: { scopes: ['r'] },
      }),
    ).toBe(true);
  });

  it('keeps every other server connectable from the web', () => {
    expect(
      curatedMcpDesktopOnly({
        providerConnector: connector,
        oauthHints: { scopes: ['r'] },
      }),
    ).toBe(false);
    expect(
      curatedMcpDesktopOnly({
        providerConnector: connector,
        requiredConfigFields: [{ kind: 'x' }],
      }),
    ).toBe(false);
    expect(curatedMcpDesktopOnly({ oauthHints: null })).toBe(false);
    expect(curatedMcpDesktopOnly({})).toBe(false);
    // Only the wire value counts; the admin enum spelling is not a wire value.
    expect(curatedMcpDesktopOnly({ availability: 'DESKTOP' })).toBe(false);
    expect(curatedMcpDesktopOnly({ availability: undefined })).toBe(false);
  });
});

it('accepts optional Try it prompt metadata and rejects malformed wire values', () => {
  expect(
    isCuratedMcpServerEntry({ ...makeEntry(), tryNowPrompt: 'An example' }),
  ).toBe(true);
  for (const tryNowPrompt of [null, 42, {}])
    expect(isCuratedMcpServerEntry({ ...makeEntry(), tryNowPrompt })).toBe(
      false,
    );
  expect(isCuratedMcpServerEntry(makeEntry())).toBe(true);
});
