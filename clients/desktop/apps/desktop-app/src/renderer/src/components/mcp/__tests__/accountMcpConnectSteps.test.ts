import type { AccountMcpClientSetup } from '@canopy/protocol/mcp-servers';
import type { CuratedMcpServerEntry } from '@canopy/protocol/mcp-catalog';
import type { AccountMcpConnection } from '@canopy/desktop-shared/types/mcp-servers';
import {
  accountMcpCatalogConnectStep,
  accountMcpClientPromptStep,
  accountMcpConnectStep,
  accountMcpEndpointEntry,
  accountMcpUnavailableMessage,
  mcpAlreadyConnectedMessage,
} from '../accountMcpConnectSteps';

function entry(
  overrides: Partial<CuratedMcpServerEntry> = {},
): CuratedMcpServerEntry {
  return {
    key: 'github',
    name: 'GitHub',
    shortDescription: '',
    url: 'https://mcp.example.test/mcp',
    transport: 'http',
    categories: [],
    popular: false,
    sortOrder: 0,
    updatedAt: '2026-09-29T00:00:00.000Z',
    ...overrides,
  };
}

function connection(
  overrides: Partial<AccountMcpConnection> = {},
): AccountMcpConnection {
  return {
    id: 'conn-1',
    serverKey: 'github',
    configId: 'default',
    displayName: 'Account GitHub',
    status: 'DISCONNECTED',
    routeId: 'route',
    enabledTools: null,
    kind: 'CURATED',
    authMode: 'OAUTH',
    ...overrides,
  };
}

const SETUP: AccountMcpClientSetup = {
  redirectUri: 'https://app.example.test/api/mcp-connections/callback',
  issuer: 'https://auth.example.test',
  clientSecretRequired: false,
  clientSecretAccepted: false,
};

describe('accountMcpConnectStep', () => {
  it('connects an existing connection straight away', () => {
    expect(
      accountMcpConnectStep({ entry: entry(), connection: connection() }),
    ).toEqual({ kind: 'connect', serverKey: 'github', configId: 'default' });
  });

  it('never connects a desktop-only catalog server', () => {
    expect(
      accountMcpConnectStep({
        entry: entry({ providerConnector: { providers: ['claude'] } }),
        connection: connection(),
      }),
    ).toEqual({ kind: 'unavailable' });
  });

  it('never connects a server the catalog marks desktop only through the account (REG-3035)', () => {
    // The account broker refuses it; the device server path connects it.
    expect(
      accountMcpConnectStep({
        entry: entry({
          availability: 'desktop',
          oauthHints: { scopes: ['read'] },
        }),
      }),
    ).toEqual({ kind: 'unavailable' });
  });

  it('opens setup for a catalog server with fields or endpoint choices', () => {
    const withFields = entry({
      requiredConfigFields: [{ kind: 'oauth-client-id' }],
    });
    expect(
      accountMcpConnectStep({
        entry: withFields,
        connection: connection({ configId: 'work' }),
      }),
    ).toEqual({ kind: 'setup', entry: withFields, configId: 'work' });
    const oneEndpoint = entry({
      urlOptions: [{ label: 'US', url: 'https://us.example.test/mcp' }],
    });
    expect(accountMcpConnectStep({ entry: oneEndpoint })).toEqual({
      kind: 'setup',
      entry: oneEndpoint,
      configId: 'default',
    });
    expect(
      accountMcpConnectStep({ entry: oneEndpoint, connection: connection() }),
    ).toEqual({ kind: 'connect', serverKey: 'github', configId: 'default' });
  });

  it('asks a custom bearer connection for a fresh token', () => {
    const bearer = connection({
      kind: 'CUSTOM',
      authMode: 'BEARER',
      serverKey: 'custom:abc',
    });
    expect(accountMcpConnectStep({ connection: bearer })).toEqual({
      kind: 'credential',
      connection: bearer,
    });
  });

  it('connects a catalog server that has no connection yet by its key', () => {
    expect(accountMcpConnectStep({ entry: entry() })).toEqual({
      kind: 'connect',
      serverKey: 'github',
      configId: 'default',
    });
    expect(accountMcpConnectStep({ curatedKey: 'linear' })).toEqual({
      kind: 'connect',
      serverKey: 'linear',
      configId: 'default',
    });
    expect(accountMcpConnectStep({})).toEqual({ kind: 'unavailable' });
  });

  it('signs a server with no connection in under the selected configuration', () => {
    expect(
      accountMcpConnectStep({ curatedKey: 'linear', configId: 'work' }),
    ).toEqual({ kind: 'connect', serverKey: 'linear', configId: 'work' });
    expect(accountMcpConnectStep({ entry: entry(), configId: 'work' })).toEqual(
      { kind: 'connect', serverKey: 'github', configId: 'work' },
    );
    const withFields = entry({
      requiredConfigFields: [{ kind: 'oauth-client-id' }],
    });
    expect(
      accountMcpConnectStep({ entry: withFields, configId: 'work' }),
    ).toEqual({ kind: 'setup', entry: withFields, configId: 'work' });
    expect(
      accountMcpConnectStep({
        entry: entry(),
        connection: connection({ configId: 'personal' }),
        configId: 'work',
      }),
    ).toEqual({ kind: 'connect', serverKey: 'github', configId: 'personal' });
  });
});

describe('accountMcpCatalogConnectStep', () => {
  it('sets up any catalog server with fields or an endpoint list', () => {
    expect(accountMcpCatalogConnectStep(entry())).toEqual({
      kind: 'connect',
      serverKey: 'github',
      configId: 'default',
    });
    const oneEndpoint = entry({
      urlOptions: [{ label: 'US', url: 'https://us.example.test/mcp' }],
    });
    expect(accountMcpCatalogConnectStep(oneEndpoint)).toEqual({
      kind: 'setup',
      entry: oneEndpoint,
      configId: 'default',
    });
    expect(accountMcpCatalogConnectStep(oneEndpoint, 'work')).toEqual({
      kind: 'setup',
      entry: oneEndpoint,
      configId: 'work',
    });
  });
});

describe('accountMcpClientPromptStep', () => {
  it('reopens catalog setup for the user’s own app on the endpoint tried', () => {
    const github = entry();
    expect(
      accountMcpClientPromptStep({
        entry: github,
        configId: 'default',
        clientSetup: SETUP,
        endpointUrl: 'https://eu.example.test/mcp',
      }),
    ).toEqual({
      kind: 'setup',
      entry: github,
      configId: 'default',
      clientSetup: SETUP,
      endpointUrl: 'https://eu.example.test/mcp',
    });
  });

  it('asks a custom connection for its client ID', () => {
    const custom = connection({ kind: 'CUSTOM', serverKey: 'custom:abc' });
    expect(
      accountMcpClientPromptStep({
        entry: entry(),
        connection: custom,
        configId: 'default',
        clientSetup: SETUP,
      }),
    ).toEqual({ kind: 'client', connection: custom, clientSetup: SETUP });
  });

  it('falls back to an access token when the secret can’t be stored', () => {
    const noSecret: AccountMcpClientSetup = {
      ...SETUP,
      clientSecretRequired: true,
      clientSecretAccepted: false,
    };
    expect(
      accountMcpClientPromptStep({
        entry: entry(),
        configId: 'default',
        clientSetup: noSecret,
      }),
    ).toEqual({
      kind: 'token',
      target: {
        id: 'curated:github',
        serverKey: 'github',
        configId: 'default',
        displayName: 'GitHub',
      },
      intro:
        'GitHub needs its own app with a client secret, which your account can’t store for this server. Connect with an access token instead.',
    });
  });

  it('reports the refusal when nothing can collect the app', () => {
    expect(accountMcpClientPromptStep({ configId: 'default' })).toEqual({
      kind: 'error',
      message:
        'This server needs its own OAuth app. Enter its client ID to connect.',
    });
  });
});

describe('accountMcpUnavailableMessage', () => {
  it('names what to connect first for a provider connector', () => {
    expect(
      accountMcpUnavailableMessage(
        entry({
          name: 'Gmail',
          providerConnector: { providers: ['claude', 'codex'] },
        }),
      ),
    ).toBe(
      'Gmail connects through your Claude or Codex account. Connect Claude or Codex first, then link Gmail there.',
    );
  });

  it('names a single provider on its own', () => {
    expect(
      accountMcpUnavailableMessage(
        entry({
          name: 'Google Drive',
          providerConnector: { providers: ['codex'] },
        }),
      ),
    ).toBe(
      'Google Drive connects through your Codex account. Connect Codex first, then link Google Drive there.',
    );
  });

  it('points a server the catalog marks desktop only at this device (REG-3035)', () => {
    // The cloud account cannot sign in to it; a device server can.
    expect(
      accountMcpUnavailableMessage(
        entry({
          name: 'Canva',
          availability: 'desktop',
          oauthHints: { scopes: ['design'] },
          providerConnector: { providers: ['claude'] },
        }),
      ),
    ).toBe('Add Canva as a server on this device to connect it.');
    // A provider-only connector keeps naming the provider account.
    expect(
      accountMcpUnavailableMessage(
        entry({
          name: 'Gmail',
          availability: 'desktop',
          providerConnector: { providers: ['claude'] },
        }),
      ),
    ).toBe(
      'Gmail connects through your Claude account. Connect Claude first, then link Gmail there.',
    );
  });

  it.each([
    ['no catalog entry', undefined],
    ['an entry without providers', entry()],
    ['an empty provider list', entry({ providerConnector: { providers: [] } })],
  ])('falls back to a plain sentence for %s', (_label, value) => {
    expect(accountMcpUnavailableMessage(value)).toBe(
      "This server can't be connected from here.",
    );
  });

  it('pairs with the unavailable step for a desktop-only server', () => {
    const gmail = entry({
      name: 'Gmail',
      providerConnector: { providers: ['claude'] },
    });
    expect(accountMcpConnectStep({ entry: gmail })).toEqual({
      kind: 'unavailable',
    });
    expect(accountMcpUnavailableMessage(gmail)).toContain('Claude');
  });
});

describe('mcpAlreadyConnectedMessage', () => {
  it('says the server is already connected', () => {
    expect(mcpAlreadyConnectedMessage('Google Calendar')).toBe(
      'Google Calendar is already connected.',
    );
  });
});

describe('accountMcpEndpointEntry', () => {
  const urlOptions = [
    { url: 'https://us.example.test/mcp', label: 'US' },
    { url: 'https://eu.example.test/mcp', label: 'EU' },
  ];

  it('uses the held entry when it lists endpoints, without reading the catalog again', async () => {
    const held = entry({ key: 'datadog', urlOptions });
    const refreshCatalog = jest.fn(
      (): Promise<CuratedMcpServerEntry[]> => Promise.resolve([]),
    );
    await expect(
      accountMcpEndpointEntry('datadog', [held], refreshCatalog),
    ).resolves.toBe(held);
    expect(refreshCatalog).not.toHaveBeenCalled();
  });

  it('reads the catalog again when the held one lacks the entry or its endpoints', async () => {
    const fresh = entry({ key: 'datadog', urlOptions });
    const refreshCatalog = jest.fn(
      (): Promise<CuratedMcpServerEntry[]> => Promise.resolve([fresh]),
    );
    await expect(
      accountMcpEndpointEntry(
        'datadog',
        [entry({ key: 'datadog' })],
        refreshCatalog,
      ),
    ).resolves.toBe(fresh);
    await expect(
      accountMcpEndpointEntry('datadog', [], refreshCatalog),
    ).resolves.toBe(fresh);
    expect(refreshCatalog).toHaveBeenCalledTimes(2);
  });

  it('reads the catalog again when the held entry lists a single endpoint', async () => {
    const fresh = entry({ key: 'datadog', urlOptions });
    const refreshCatalog = jest.fn(
      (): Promise<CuratedMcpServerEntry[]> => Promise.resolve([fresh]),
    );
    await expect(
      accountMcpEndpointEntry(
        'datadog',
        [entry({ key: 'datadog', urlOptions: [urlOptions[0]] })],
        refreshCatalog,
      ),
    ).resolves.toBe(fresh);
    expect(refreshCatalog).toHaveBeenCalledTimes(1);
  });

  it('finds nothing when the fresh catalog has no endpoints for the server', async () => {
    await expect(
      accountMcpEndpointEntry(
        'datadog',
        [],
        (): Promise<CuratedMcpServerEntry[]> =>
          Promise.resolve([entry({ key: 'datadog' })]),
      ),
    ).resolves.toBeUndefined();
  });
});
