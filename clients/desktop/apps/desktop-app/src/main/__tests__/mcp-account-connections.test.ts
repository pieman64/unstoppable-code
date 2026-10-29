jest.mock(
  '../mcp/oauth-client',
  (): Record<string, unknown> => ({ openExternalUrl: jest.fn() }),
);
jest.mock(
  '../canopy-cloud/authenticated-portal',
  (): Record<string, unknown> => ({
    openAuthenticatedPortalPage: jest.fn(),
    mintAuthenticatedPortalUrl: jest.fn(),
  }),
);
import { openExternalUrl } from '../mcp/oauth-client';
import {
  openAuthenticatedPortalPage,
  mintAuthenticatedPortalUrl,
} from '../canopy-cloud/authenticated-portal';
import type * as CloudClientModule from '../canopy-cloud/client';
import {
  CanopyCloudClientError,
  assertCanopyCloudCapability,
  requestCanopyCloudJson,
  resolveCanopyCloudCredentialContext,
} from '../canopy-cloud/client';
import {
  startAccountMcpConnection,
  getAccountMcpConnection,
  disconnectAccountMcpConnection,
  setAccountMcpConnectionTools,
  listAccountMcpUpstreamTools,
  awaitAccountMcpConnection,
  findAccountMcpConnection,
  invalidateAccountMcpConnections,
  listAccountMcpConnections,
  resolveAccountMcpProxyTarget,
  accountMcpConnectionsEditable,
  removeAccountMcpConnection,
  updateAccountMcpConnection,
  type AccountMcpConnection,
} from '../canopy-cloud/mcp-connections';
jest.mock('../canopy-cloud/client', (): typeof CloudClientModule => {
  const actual = jest.requireActual<typeof CloudClientModule>(
    '../canopy-cloud/client',
  );
  return {
    ...actual,
    assertCanopyCloudCapability: jest.fn(),
    requestCanopyCloudJson: jest.fn(),
    resolveCanopyCloudCredentialContext: jest.fn(),
  };
});
const credentials = {
  baseUrl: 'https://cloud.example.test',
  apiKey: 'csk_test',
  capabilities: ['mcp-connections-v1', 'mcp-proxy-v1'],
};
const row: AccountMcpConnection = {
  id: 'account-1',
  serverKey: 'github',
  configId: 'default',
  displayName: 'GitHub',
  status: 'CONNECTED',
  routeId: 'route-1',
  enabledTools: null,
  kind: 'CURATED',
};
beforeEach((): void => {
  jest.resetAllMocks();
  invalidateAccountMcpConnections();
  jest
    .mocked(resolveCanopyCloudCredentialContext)
    .mockResolvedValue(credentials);
  jest.mocked(assertCanopyCloudCapability).mockResolvedValue(undefined);
  jest.mocked(requestCanopyCloudJson).mockResolvedValue({ connections: [row] });
});
it('gates the bearer list route and caches for 60 seconds with explicit invalidation', async (): Promise<void> => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    expect(await listAccountMcpConnections()).toEqual([row]);
    expect(assertCanopyCloudCapability).toHaveBeenCalledWith(
      'mcp-connections-v1',
      credentials,
    );
    expect(requestCanopyCloudJson).toHaveBeenCalledWith(
      '/api/v1/mcp-connections',
      { credentialContext: credentials },
    );
    clock.mockReturnValue(60_999);
    await listAccountMcpConnections();
    expect(requestCanopyCloudJson).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(61_000);
    await listAccountMcpConnections();
    expect(requestCanopyCloudJson).toHaveBeenCalledTimes(2);
    invalidateAccountMcpConnections();
    await listAccountMcpConnections();
    expect(requestCanopyCloudJson).toHaveBeenCalledTimes(3);
  } finally {
    clock.mockRestore();
  }
});
it('refreshes an empty cached list after a user retry invalidates it', async (): Promise<void> => {
  jest
    .mocked(requestCanopyCloudJson)
    .mockResolvedValueOnce({ connections: [] });
  expect(await listAccountMcpConnections()).toEqual([]);
  expect(await listAccountMcpConnections()).toEqual([]);
  expect(requestCanopyCloudJson).toHaveBeenCalledTimes(1);
  invalidateAccountMcpConnections();
  expect(await listAccountMcpConnections()).toEqual([row]);
  expect(requestCanopyCloudJson).toHaveBeenCalledTimes(2);
});
it('fails with typed signed-out and missing-capability errors', async (): Promise<void> => {
  jest
    .mocked(resolveCanopyCloudCredentialContext)
    .mockRejectedValueOnce(
      new CanopyCloudClientError('missing-api-key', 'Sign in'),
    );
  await expect(listAccountMcpConnections()).rejects.toMatchObject({
    code: 'missing-api-key',
  });
  jest
    .mocked(assertCanopyCloudCapability)
    .mockRejectedValueOnce(
      new CanopyCloudClientError('unsupported-capability', 'Unsupported'),
    );
  await expect(listAccountMcpConnections()).rejects.toMatchObject({
    code: 'unsupported-capability',
  });
  expect(requestCanopyCloudJson).not.toHaveBeenCalled();
});
it('does not reuse rows after sign-out or an account switch', async (): Promise<void> => {
  await listAccountMcpConnections();
  jest
    .mocked(resolveCanopyCloudCredentialContext)
    .mockRejectedValueOnce(
      new CanopyCloudClientError('missing-api-key', 'Sign in'),
    );
  await expect(listAccountMcpConnections()).rejects.toBeInstanceOf(
    CanopyCloudClientError,
  );
  jest
    .mocked(resolveCanopyCloudCredentialContext)
    .mockResolvedValue({ ...credentials, apiKey: 'csk_other' });
  await listAccountMcpConnections();
  expect(requestCanopyCloudJson).toHaveBeenCalledTimes(2);
});
it('deduplicates concurrent reads and invalidation fences late cache writes', async (): Promise<void> => {
  let complete: (value: unknown) => void = (): void => undefined;
  jest.mocked(requestCanopyCloudJson).mockReturnValueOnce(
    new Promise((resolve): void => {
      complete = resolve;
    }),
  );
  const first = listAccountMcpConnections();
  const second = listAccountMcpConnections();
  await Promise.resolve();
  await Promise.resolve();
  invalidateAccountMcpConnections();
  complete({ connections: [row] });
  await Promise.all([first, second]);
  await listAccountMcpConnections();
  expect(requestCanopyCloudJson).toHaveBeenCalledTimes(2);
});
it('matches explicit ids, then curated key/config, and refuses ambiguous keys', async (): Promise<void> => {
  jest.mocked(requestCanopyCloudJson).mockResolvedValue({
    connections: [row, { ...row, id: 'account-2', configId: 'work' }],
  });
  expect(
    (
      await findAccountMcpConnection({
        accountConnectionId: 'account-2',
        curatedKey: 'other',
      })
    )?.configId,
  ).toBe('work');
  expect(
    await findAccountMcpConnection({
      accountConnectionId: 'absent',
      curatedKey: 'github',
    }),
  ).toBeUndefined();
  expect(
    (await findAccountMcpConnection({ curatedKey: 'github', configId: 'work' }))
      ?.id,
  ).toBe('account-2');
  expect(
    await findAccountMcpConnection({
      curatedKey: 'github',
      configId: 'local-id',
    }),
  ).toBeUndefined();
});
it('resolves the web upstream only when the proxy capability is present', async (): Promise<void> => {
  expect(await resolveAccountMcpProxyTarget({ curatedKey: 'github' })).toEqual({
    connection: row,
    upstreamUrl: 'https://cloud.example.test/api/v1/mcp-proxy/route-1',
  });
  expect(assertCanopyCloudCapability).toHaveBeenCalledWith(
    'mcp-proxy-v1',
    credentials,
  );
  jest
    .mocked(assertCanopyCloudCapability)
    .mockRejectedValueOnce(
      new CanopyCloudClientError('unsupported-capability', 'Unsupported'),
    );
  await expect(
    resolveAccountMcpProxyTarget({ curatedKey: 'github' }),
  ).rejects.toMatchObject({ code: 'unsupported-capability' });
});
it('never routes a connection the user turned off in the cloud (CAN-3620)', async (): Promise<void> => {
  jest
    .mocked(requestCanopyCloudJson)
    .mockResolvedValue({ connections: [{ ...row, enabled: false }] });
  await expect(
    resolveAccountMcpProxyTarget({ curatedKey: 'github' }),
  ).rejects.toThrow('Account MCP connection is turned off.');
  expect(assertCanopyCloudCapability).not.toHaveBeenCalledWith(
    'mcp-proxy-v1',
    expect.anything(),
  );
  invalidateAccountMcpConnections();
  jest
    .mocked(requestCanopyCloudJson)
    .mockResolvedValue({ connections: [{ ...row, enabled: 'no' }] });
  await expect(listAccountMcpConnections()).rejects.toMatchObject({
    code: 'invalid-response',
  });
});
it('rejects malformed account rows', async (): Promise<void> => {
  jest
    .mocked(requestCanopyCloudJson)
    .mockResolvedValue({ connections: [{ ...row, routeId: '../escape' }] });
  await expect(listAccountMcpConnections()).rejects.toMatchObject({
    code: 'invalid-response',
  });
});
it('carries the auth mode through and rejects unknown modes', async (): Promise<void> => {
  jest.mocked(requestCanopyCloudJson).mockResolvedValue({
    connections: [{ ...row, authMode: 'BEARER', upstreamUrl: 'x' }],
  });
  expect(await listAccountMcpConnections()).toEqual([
    { ...row, authMode: 'BEARER' },
  ]);
  invalidateAccountMcpConnections();
  jest
    .mocked(requestCanopyCloudJson)
    .mockResolvedValue({ connections: [{ ...row, authMode: 'BASIC' }] });
  await expect(listAccountMcpConnections()).rejects.toMatchObject({
    code: 'invalid-response',
  });
});

it('asks for the OAuth client when the cloud cannot register one', async (): Promise<void> => {
  jest
    .mocked(requestCanopyCloudJson)
    .mockRejectedValueOnce(
      new CanopyCloudClientError(
        'http-error',
        'registration_unavailable',
        400,
        'registration_unavailable',
      ),
    );
  await expect(
    startAccountMcpConnection({ serverKey: 'custom:abc', configId: 'default' }),
  ).rejects.toMatchObject({ code: 'oauth-client-required', details: {} });
  const clientSetup = {
    redirectUri:
      'https://app.example.test/api/mcp-connections/callback/issuer-key',
    issuer: 'https://accounts.example.test',
    clientSecretRequired: false,
    clientSecretAccepted: false,
  };
  jest
    .mocked(requestCanopyCloudJson)
    .mockRejectedValueOnce(
      new CanopyCloudClientError(
        'http-error',
        'client_credentials_required',
        400,
        'client_credentials_required',
        undefined,
        true,
        undefined,
        false,
        undefined,
        undefined,
        clientSetup,
      ),
    );
  await expect(
    startAccountMcpConnection({ serverKey: 'spotify', configId: 'default' }),
  ).rejects.toMatchObject({
    code: 'oauth-client-required',
    details: { clientSetup },
  });
  jest
    .mocked(requestCanopyCloudJson)
    .mockRejectedValueOnce(
      new CanopyCloudClientError(
        'http-error',
        'invalid_url',
        400,
        'invalid_url',
      ),
    );
  await expect(
    startAccountMcpConnection({ serverKey: 'custom:abc', configId: 'default' }),
  ).rejects.toMatchObject({
    code: 'connect-refused',
    details: { serverCode: 'invalid_url' },
  });
  jest
    .mocked(requestCanopyCloudJson)
    .mockRejectedValueOnce(
      new CanopyCloudClientError('network-error', 'offline'),
    );
  await expect(
    startAccountMcpConnection({ serverKey: 'custom:abc', configId: 'default' }),
  ).rejects.toMatchObject({ code: 'network-error' });
});
it.each<[boolean | undefined, boolean]>([
  [true, true],
  [false, false],
  // A body without the flag reads as no device sign-in.
  [undefined, false],
])(
  'forwards a refused sign-in with desktopSignIn %p, never as an OAuth app prompt',
  async (desktopSignIn, forwarded): Promise<void> => {
    jest
      .mocked(requestCanopyCloudJson)
      .mockRejectedValueOnce(
        new CanopyCloudClientError(
          'http-error',
          'sign_in_unavailable',
          400,
          'sign_in_unavailable',
          undefined,
          true,
          undefined,
          false,
          undefined,
          undefined,
          undefined,
          desktopSignIn,
        ),
      );
    const refusal: unknown = await startAccountMcpConnection({
      serverKey: 'dropbox',
      configId: 'default',
    }).catch((error: unknown): unknown => error);
    expect(refusal).toMatchObject({
      code: 'connect-refused',
      details: { serverCode: 'sign_in_unavailable', desktopSignIn: forwarded },
    });
    expect(refusal).not.toHaveProperty('details.clientSetup');
  },
);
it('reports the custom connection limit as a recoverable account error', async (): Promise<void> => {
  jest
    .mocked(requestCanopyCloudJson)
    .mockRejectedValueOnce(
      new CanopyCloudClientError(
        'http-error',
        'connection_limit_reached',
        409,
        'connection_limit_reached',
      ),
    );
  await expect(
    startAccountMcpConnection({
      customUrl: 'https://mcp.example.test',
      displayName: 'Internal tools',
      configId: 'default',
    }),
  ).rejects.toMatchObject({ code: 'connection-limit-reached' });
});
it('reports refused custom headers as a recoverable account error', async (): Promise<void> => {
  jest
    .mocked(requestCanopyCloudJson)
    .mockRejectedValueOnce(
      new CanopyCloudClientError(
        'http-error',
        'invalid_request',
        400,
        'invalid_headers',
      ),
    );
  await expect(
    startAccountMcpConnection({
      customUrl: 'https://mcp.example.test',
      headers: { 'X-Team': 'core' },
      configId: 'default',
    }),
  ).rejects.toMatchObject({ code: 'invalid-headers', header: undefined });
  jest
    .mocked(requestCanopyCloudJson)
    .mockRejectedValueOnce(
      new CanopyCloudClientError(
        'http-error',
        'invalid_request',
        400,
        'invalid_headers',
        undefined,
        true,
        undefined,
        false,
        undefined,
        'X-Team',
      ),
    );
  await expect(
    startAccountMcpConnection({
      customUrl: 'https://mcp.example.test',
      headers: { 'X-Team': 'core' },
      configId: 'default',
    }),
  ).rejects.toMatchObject({
    code: 'invalid-headers',
    header: 'X-Team',
    message:
      "Your cloud account couldn't store the X-Team header. Check it and try again.",
  });
  expect(jest.mocked(requestCanopyCloudJson)).toHaveBeenCalledWith(
    '/api/v1/mcp-connections',
    expect.objectContaining({
      body: JSON.stringify({
        customUrl: 'https://mcp.example.test',
        headers: { 'X-Team': 'core' },
        configId: 'default',
      }),
    }),
  );
});
it('starts connections and opens only validated browser URLs', async (): Promise<void> => {
  jest
    .mocked(requestCanopyCloudJson)
    .mockResolvedValueOnce({ connection: row });
  expect(
    await startAccountMcpConnection({
      serverKey: 'github',
      configId: 'default',
    }),
  ).toEqual({ connection: row });
  expect(requestCanopyCloudJson).toHaveBeenLastCalledWith(
    expect.stringContaining('/mcp-connections'),
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ serverKey: 'github', configId: 'default' }),
    }),
  );
  jest.mocked(requestCanopyCloudJson).mockResolvedValueOnce({
    authorizationUrl: 'https://auth.example.test/authorize',
  });
  await startAccountMcpConnection({
    customUrl: 'https://mcp.example.test',
    configId: 'default',
  });
  expect(openExternalUrl).toHaveBeenCalledWith(
    'https://auth.example.test/authorize',
  );
  jest
    .mocked(requestCanopyCloudJson)
    .mockResolvedValueOnce({ authorizationUrl: 'file:///tmp/unsafe' });
  await expect(
    startAccountMcpConnection({ serverKey: 'github', configId: 'default' }),
  ).rejects.toMatchObject({ code: 'invalid-response' });
  expect(openExternalUrl).toHaveBeenCalledTimes(1);
  expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
});
describe('the browser a sign-in opens', () => {
  const authorizationUrl = 'https://auth.example.test/authorize?state=s';
  const signInPath = '/api/mcp-connections/authorize?state=s';
  it('is signed in as the starting account before it reaches the provider', async (): Promise<void> => {
    const bound = { ...credentials, account: { id: 'acct-1' } };
    jest.mocked(resolveCanopyCloudCredentialContext).mockResolvedValue(bound);
    jest
      .mocked(requestCanopyCloudJson)
      .mockResolvedValueOnce({ authorizationUrl, signInPath });
    jest.mocked(openAuthenticatedPortalPage).mockResolvedValue(true);
    expect(
      await startAccountMcpConnection({
        serverKey: 'github',
        configId: 'default',
        expectedAccountId: 'acct-1',
      }),
    ).toEqual({ authorizationUrl });
    // The auth link is minted for the account the start ran under, never
    // whichever account is signed in by the time it is minted.
    expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(signInPath, {
      credentialContext: bound,
    });
    expect(openExternalUrl).not.toHaveBeenCalled();
  });
  it('falls back to the provider page when no browser page could be opened', async (): Promise<void> => {
    jest
      .mocked(requestCanopyCloudJson)
      .mockResolvedValueOnce({ authorizationUrl, signInPath });
    jest.mocked(openAuthenticatedPortalPage).mockResolvedValue(false);
    await startAccountMcpConnection({
      serverKey: 'github',
      configId: 'default',
    });
    expect(openAuthenticatedPortalPage).toHaveBeenCalledTimes(1);
    expect(openExternalUrl).toHaveBeenCalledWith(authorizationUrl);
  });
  it('opens the provider page from an older cloud that names no sign-in page', async (): Promise<void> => {
    jest
      .mocked(requestCanopyCloudJson)
      .mockResolvedValueOnce({ authorizationUrl });
    await startAccountMcpConnection({
      serverKey: 'github',
      configId: 'default',
    });
    expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
    expect(openExternalUrl).toHaveBeenCalledWith(authorizationUrl);
  });
  it.each([
    '/account/billing',
    '//evil.example/api/mcp-connections/authorize?state=s',
    'https://evil.example/api/mcp-connections/authorize?state=s',
    '/api/mcp-connections/authorize?state=s&next=/x',
    42,
  ])(
    'never signs a browser in for a sign-in page it does not recognize: %p',
    async (unexpected): Promise<void> => {
      jest.mocked(requestCanopyCloudJson).mockResolvedValueOnce({
        authorizationUrl,
        signInPath: unexpected,
      });
      await startAccountMcpConnection({
        serverKey: 'github',
        configId: 'default',
      });
      expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
      expect(openExternalUrl).toHaveBeenCalledWith(authorizationUrl);
    },
  );
  it('opens nothing for an unsafe provider URL, whatever sign-in page it names', async (): Promise<void> => {
    jest.mocked(requestCanopyCloudJson).mockResolvedValueOnce({
      authorizationUrl: 'http://auth.example.test/authorize',
      signInPath,
    });
    await expect(
      startAccountMcpConnection({ serverKey: 'github', configId: 'default' }),
    ).rejects.toMatchObject({ code: 'invalid-response' });
    expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
    expect(openExternalUrl).not.toHaveBeenCalled();
  });
});
it('binds a start to the account it was captured under and never forwards the binding', async (): Promise<void> => {
  const bound = { ...credentials, account: { id: 'acct-1' } };
  jest.mocked(resolveCanopyCloudCredentialContext).mockResolvedValue(bound);
  jest
    .mocked(requestCanopyCloudJson)
    .mockResolvedValueOnce({ connection: row });
  await startAccountMcpConnection({
    serverKey: 'github',
    configId: 'default',
    oauthClient: { clientId: 'own-client', clientSecret: 'own-secret' },
    expectedAccountId: 'acct-1',
  });
  expect(requestCanopyCloudJson).toHaveBeenLastCalledWith(
    expect.stringContaining('/mcp-connections'),
    expect.objectContaining({
      body: JSON.stringify({
        serverKey: 'github',
        configId: 'default',
        oauthClient: { clientId: 'own-client', clientSecret: 'own-secret' },
      }),
      credentialContext: bound,
    }),
  );
  jest.mocked(requestCanopyCloudJson).mockClear();
  jest
    .mocked(resolveCanopyCloudCredentialContext)
    .mockResolvedValue({ ...credentials, account: { id: 'acct-2' } });
  await expect(
    startAccountMcpConnection({
      serverKey: 'github',
      configId: 'default',
      bearerToken: 'device-secret',
      expectedAccountId: 'acct-1',
    }),
  ).rejects.toMatchObject({ code: 'account-changed' });
  expect(requestCanopyCloudJson).not.toHaveBeenCalled();
});
it('gets, disconnects and updates the tools allowlist through bearer routes', async (): Promise<void> => {
  jest.mocked(requestCanopyCloudJson).mockResolvedValue({ connection: row });
  expect(await getAccountMcpConnection(row.id)).toEqual(row);
  await setAccountMcpConnectionTools(row.id, []);
  expect(requestCanopyCloudJson).toHaveBeenLastCalledWith(
    expect.stringContaining('/account-1/tools'),
    expect.objectContaining({ method: 'PATCH', body: '{"enabledTools":[]}' }),
  );
  await setAccountMcpConnectionTools(row.id, null);
  expect(requestCanopyCloudJson).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.objectContaining({ body: '{"enabledTools":null}' }),
  );
  await disconnectAccountMcpConnection(row.id);
  expect(requestCanopyCloudJson).toHaveBeenLastCalledWith(
    expect.stringContaining('/account-1'),
    expect.objectContaining({ method: 'DELETE' }),
  );
});
it('lists upstream tools through the bearer route, projecting known fields', async (): Promise<void> => {
  jest.mocked(requestCanopyCloudJson).mockResolvedValue({
    tools: [
      { name: 'search', title: 'Search', description: 'Find', extra: 1 },
      { name: 'read' },
      { title: 'nameless' },
    ],
  });
  expect(await listAccountMcpUpstreamTools(row.id)).toEqual([
    { name: 'search', title: 'Search', description: 'Find' },
    { name: 'read' },
  ]);
  expect(requestCanopyCloudJson).toHaveBeenLastCalledWith(
    '/api/v1/mcp-connections/account-1/tools',
    { credentialContext: credentials },
  );
  jest.mocked(requestCanopyCloudJson).mockResolvedValue({ tools: 'nope' });
  await expect(listAccountMcpUpstreamTools(row.id)).rejects.toMatchObject({
    code: 'invalid-response',
  });
});
it('names a reconnect-required listing so the renderer can act on it', async (): Promise<void> => {
  jest
    .mocked(requestCanopyCloudJson)
    .mockRejectedValue(
      new CanopyCloudClientError(
        'http-error',
        'mcp_reauth_required',
        409,
        'mcp_reauth_required',
      ),
    );
  await expect(listAccountMcpUpstreamTools(row.id)).rejects.toThrow(
    'mcp_reauth_required',
  );
  const other = new CanopyCloudClientError('http-error', 'nope', 502);
  jest.mocked(requestCanopyCloudJson).mockRejectedValue(other);
  await expect(listAccountMcpUpstreamTools(row.id)).rejects.toBe(other);
});
it.each(['CONNECTED', 'REAUTH_REQUIRED', 'DISCONNECTED'] as const)(
  'polls every three seconds until %s',
  async (status): Promise<void> => {
    jest.useFakeTimers();
    try {
      jest
        .mocked(requestCanopyCloudJson)
        .mockResolvedValueOnce({ connection: { ...row, status: 'PENDING' } })
        .mockResolvedValueOnce({ connection: { ...row, status } });
      const wait = awaitAccountMcpConnection(row.id);
      await jest.advanceTimersByTimeAsync(2999);
      expect(requestCanopyCloudJson).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect((await wait).status).toBe(status);
    } finally {
      jest.useRealTimers();
    }
  },
);
it.each(['access_denied', 'oauth_error'])(
  'settles a pending sign-in the provider answered with %s',
  async (code): Promise<void> => {
    jest.useFakeTimers();
    try {
      // The callback leaves a refused flow PENDING and records why (CAN-4451).
      jest
        .mocked(requestCanopyCloudJson)
        .mockResolvedValueOnce({
          connection: { ...row, status: 'PENDING', lastError: null },
        })
        .mockResolvedValueOnce({
          connection: { ...row, status: 'PENDING', lastError: code },
        });
      const wait = expect(
        awaitAccountMcpConnection(row.id),
      ).rejects.toMatchObject({
        code: 'connect-refused',
        details: { serverCode: code },
      });
      await jest.advanceTimersByTimeAsync(3000);
      await wait;
      expect(requestCanopyCloudJson).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  },
);
it('polls under the account captured when awaiting began', async (): Promise<void> => {
  const other = { ...credentials, apiKey: 'other-key' };
  jest
    .mocked(resolveCanopyCloudCredentialContext)
    .mockResolvedValueOnce(credentials)
    .mockResolvedValueOnce(credentials)
    .mockResolvedValue(other);
  jest
    .mocked(requestCanopyCloudJson)
    .mockResolvedValue({ connection: { ...row, status: 'PENDING' } });
  await expect(
    awaitAccountMcpConnection(row.id, { timeoutMs: 5000 }),
  ).rejects.toMatchObject({ code: 'account-changed' });
  expect(requestCanopyCloudJson).toHaveBeenCalledTimes(1);
  expect(requestCanopyCloudJson).toHaveBeenCalledWith(
    `/api/v1/mcp-connections/${row.id}`,
    expect.objectContaining({ credentialContext: credentials }),
  );
});
it('times out pending connections', async (): Promise<void> => {
  jest.useFakeTimers();
  try {
    jest
      .mocked(requestCanopyCloudJson)
      .mockResolvedValue({ connection: { ...row, status: 'PENDING' } });
    const result = expect(
      awaitAccountMcpConnection(row.id, { timeoutMs: 5000 }),
    ).rejects.toMatchObject({ code: 'connection-timeout' });
    await jest.advanceTimersByTimeAsync(5000);
    await result;
  } finally {
    jest.useRealTimers();
  }
});
it.each([
  (): Promise<unknown> =>
    startAccountMcpConnection({ serverKey: 'github', configId: 'default' }),
  (): Promise<unknown> => getAccountMcpConnection(row.id),
  (): Promise<unknown> => disconnectAccountMcpConnection(row.id),
  (): Promise<unknown> => setAccountMcpConnectionTools(row.id, null),
  (): Promise<unknown> => listAccountMcpUpstreamTools(row.id),
  (): Promise<unknown> => awaitAccountMcpConnection(row.id),
])(
  'gates every operation and refuses signed-out requests',
  async (operation): Promise<void> => {
    jest
      .mocked(assertCanopyCloudCapability)
      .mockRejectedValueOnce(
        new CanopyCloudClientError('unsupported-capability', 'Unsupported'),
      );
    await expect(operation()).rejects.toMatchObject({
      code: 'unsupported-capability',
    });
    jest
      .mocked(resolveCanopyCloudCredentialContext)
      .mockResolvedValue({ ...credentials, apiKey: '' });
    await expect(operation()).rejects.toMatchObject({
      code: 'missing-api-key',
    });
    expect(requestCanopyCloudJson).not.toHaveBeenCalled();
  },
);

it.each(['capability', 'connections'] as const)(
  'reports an unavailable legacy %s endpoint without hiding other failures',
  async (endpoint): Promise<void> => {
    const source =
      endpoint === 'capability'
        ? jest.mocked(assertCanopyCloudCapability)
        : jest.mocked(requestCanopyCloudJson);
    source.mockRejectedValueOnce(
      new CanopyCloudClientError('http-error', 'Not found', 404),
    );
    await expect(listAccountMcpConnections()).rejects.toMatchObject({
      code: 'http-error',
      status: 404,
    });
  },
);
it('identifies account switches by code', async (): Promise<void> => {
  jest
    .mocked(resolveCanopyCloudCredentialContext)
    .mockResolvedValueOnce(credentials)
    .mockResolvedValueOnce({ ...credentials, apiKey: 'other-account' });
  await expect(awaitAccountMcpConnection(row.id)).rejects.toMatchObject({
    code: 'account-changed',
  });
});

it('sends curated endpoint selection without converting it to a custom connection', async (): Promise<void> => {
  jest
    .mocked(requestCanopyCloudJson)
    .mockResolvedValueOnce({ connection: row });
  const request = {
    serverKey: 'github',
    endpointUrl: 'https://eu.example.test/mcp',
    configId: 'default',
  };
  await startAccountMcpConnection(request);
  expect(requestCanopyCloudJson).toHaveBeenLastCalledWith(
    expect.stringContaining('/mcp-connections'),
    expect.objectContaining({ body: JSON.stringify(request) }),
  );
});

it('sends OAuth application credentials with the selected curated endpoint', async (): Promise<void> => {
  jest.mocked(requestCanopyCloudJson).mockResolvedValue({ connection: row });
  const request = {
    serverKey: 'github',
    configId: 'work',
    endpointUrl: 'https://eu.example.test/mcp',
    oauthClient: { clientId: 'own-client', clientSecret: 'own-secret' },
  };
  await startAccountMcpConnection(request);
  expect(requestCanopyCloudJson).toHaveBeenCalledWith(
    '/api/v1/mcp-connections',
    expect.objectContaining({ method: 'POST', body: JSON.stringify(request) }),
  );
});

it('keeps the public host and header flag and drops unknown fields', async (): Promise<void> => {
  jest.mocked(requestCanopyCloudJson).mockResolvedValueOnce({
    connections: [
      {
        ...row,
        upstreamHost: 'mcp.example.test',
        hasExtraHeaders: true,
        upstreamUrl: 'https://mcp.example.test/secret-path',
      },
    ],
  });
  expect(await listAccountMcpConnections()).toEqual([
    { ...row, upstreamHost: 'mcp.example.test', hasExtraHeaders: true },
  ]);
  invalidateAccountMcpConnections();
  jest.mocked(requestCanopyCloudJson).mockResolvedValueOnce({
    connections: [{ ...row, upstreamHost: 42 }],
  });
  await expect(listAccountMcpConnections()).rejects.toMatchObject({
    code: 'invalid-response',
  });
});

it('edits a connection through PATCH behind the edit capability', async (): Promise<void> => {
  const bound = { ...credentials, account: { id: 'acct-1' } };
  jest.mocked(resolveCanopyCloudCredentialContext).mockResolvedValue(bound);
  const edited = { ...row, kind: 'CUSTOM' as const, displayName: 'Team' };
  jest
    .mocked(requestCanopyCloudJson)
    .mockResolvedValueOnce({ connection: edited });
  expect(
    await updateAccountMcpConnection(row.id, {
      displayName: 'Team',
      customUrl: 'https://mcp2.example.test/mcp',
      headers: { 'X-Team': 'core' },
      bearerToken: 'secret',
      expectedAccountId: 'acct-1',
    }),
  ).toEqual(edited);
  expect(assertCanopyCloudCapability).toHaveBeenCalledWith(
    'mcp-connections-v2',
    bound,
    undefined,
  );
  expect(requestCanopyCloudJson).toHaveBeenLastCalledWith(
    '/api/v1/mcp-connections/account-1',
    expect.objectContaining({
      method: 'PATCH',
      credentialContext: bound,
      body: JSON.stringify({
        displayName: 'Team',
        customUrl: 'https://mcp2.example.test/mcp',
        headers: { 'X-Team': 'core' },
        bearerToken: 'secret',
      }),
    }),
  );
});

it('refuses an edit captured under another account before sending it', async (): Promise<void> => {
  jest
    .mocked(resolveCanopyCloudCredentialContext)
    .mockResolvedValue({ ...credentials, account: { id: 'acct-2' } });
  await expect(
    updateAccountMcpConnection(row.id, {
      bearerToken: 'secret',
      expectedAccountId: 'acct-1',
    }),
  ).rejects.toMatchObject({ code: 'account-changed' });
  expect(requestCanopyCloudJson).not.toHaveBeenCalled();
});

it.each([
  [
    new CanopyCloudClientError('unsupported-capability', 'Unsupported'),
    { code: 'edit-unavailable' },
  ],
  [
    new CanopyCloudClientError(
      'http-error',
      'invalid_request',
      400,
      'invalid_headers',
      undefined,
      true,
      undefined,
      false,
      undefined,
      'X-Team',
    ),
    { code: 'invalid-headers', header: 'X-Team' },
  ],
  [
    new CanopyCloudClientError('http-error', 'invalid_url', 400, 'invalid_url'),
    { code: 'invalid-url' },
  ],
  [
    new CanopyCloudClientError(
      'http-error',
      'connection_limit_reached',
      409,
      'connection_limit_reached',
    ),
    { code: 'connection-limit-reached' },
  ],
])('maps a refused edit to %s', async (error, expected): Promise<void> => {
  jest.mocked(requestCanopyCloudJson).mockRejectedValueOnce(error);
  await expect(
    updateAccountMcpConnection(row.id, { displayName: 'Team' }),
  ).rejects.toMatchObject(expected);
});

it('removes a connection outright when the cloud can, and only disconnects otherwise', async (): Promise<void> => {
  jest.mocked(requestCanopyCloudJson).mockResolvedValue({ ok: true });
  expect(await removeAccountMcpConnection(row.id)).toEqual({ removed: true });
  expect(requestCanopyCloudJson).toHaveBeenLastCalledWith(
    '/api/v1/mcp-connections/account-1?remove=1',
    expect.objectContaining({ method: 'DELETE' }),
  );
  jest
    .mocked(assertCanopyCloudCapability)
    .mockImplementation(
      (capability): Promise<void> =>
        capability === 'mcp-connections-v2'
          ? Promise.reject(
              new CanopyCloudClientError('unsupported-capability', 'Old'),
            )
          : Promise.resolve(),
    );
  expect(await accountMcpConnectionsEditable()).toBe(false);
  expect(await removeAccountMcpConnection(row.id)).toEqual({ removed: false });
  expect(requestCanopyCloudJson).toHaveBeenLastCalledWith(
    '/api/v1/mcp-connections/account-1',
    expect.objectContaining({ method: 'DELETE' }),
  );
});

it('treats a connection the cloud no longer has as removed, so a retry finishes', async (): Promise<void> => {
  const gone = (): CanopyCloudClientError =>
    new CanopyCloudClientError(
      'http-error',
      'not_found',
      404,
      'not_found',
      undefined,
      true,
    );
  jest.mocked(requestCanopyCloudJson).mockRejectedValueOnce(gone());
  expect(await removeAccountMcpConnection(row.id)).toEqual({ removed: true });
  jest
    .mocked(assertCanopyCloudCapability)
    .mockImplementation(
      (capability): Promise<void> =>
        capability === 'mcp-connections-v2'
          ? Promise.reject(
              new CanopyCloudClientError('unsupported-capability', 'Old'),
            )
          : Promise.resolve(),
    );
  jest.mocked(requestCanopyCloudJson).mockRejectedValueOnce(gone());
  expect(await removeAccountMcpConnection(row.id)).toEqual({ removed: true });
  // A bare 404, as a gateway might send, is no proof the connection is gone.
  jest
    .mocked(requestCanopyCloudJson)
    .mockRejectedValueOnce(
      new CanopyCloudClientError('http-error', 'Not Found', 404),
    );
  await expect(removeAccountMcpConnection(row.id)).rejects.toMatchObject({
    status: 404,
  });
  jest
    .mocked(requestCanopyCloudJson)
    .mockRejectedValueOnce(
      new CanopyCloudClientError(
        'http-error',
        'connection_failed',
        500,
        'connection_failed',
      ),
    );
  await expect(removeAccountMcpConnection(row.id)).rejects.toMatchObject({
    status: 500,
  });
});

describe('embedded account MCP start', () => {
  const authorizationUrl = 'https://provider.test/authorize?state=s';
  const signInPath = '/api/mcp-connections/authorize?state=s';
  const request = {
    serverKey: 'github',
    configId: 'default',
    browser: 'embedded' as const,
    expectedAccountId: 'acct-1',
  };
  beforeEach(() => {
    jest
      .mocked(resolveCanopyCloudCredentialContext)
      .mockResolvedValue({ ...credentials, account: { id: 'acct-1' } });
    jest
      .mocked(requestCanopyCloudJson)
      .mockResolvedValue({ authorizationUrl, signInPath });
    jest
      .mocked(mintAuthenticatedPortalUrl)
      .mockResolvedValue('https://cloud.example.test/consume?code=once');
  });
  afterEach(() => {
    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
  });
  it('returns the minted URL and omits both local-only request fields from cloud', async () => {
    expect(await startAccountMcpConnection(request)).toEqual({
      authorizationUrl,
      embeddedUrl: 'https://cloud.example.test/consume?code=once',
    });
    expect(requestCanopyCloudJson).toHaveBeenCalledWith(
      '/api/v1/mcp-connections',
      expect.objectContaining({
        body: JSON.stringify({ serverKey: 'github', configId: 'default' }),
      }),
    );
    expect(mintAuthenticatedPortalUrl).toHaveBeenCalledWith(signInPath, {
      ...credentials,
      account: { id: 'acct-1' },
    });
  });
  it('falls back to the validated signed-out page when minting is unavailable', async () => {
    jest.mocked(mintAuthenticatedPortalUrl).mockResolvedValue(null);
    expect(await startAccountMcpConnection(request)).toEqual({
      authorizationUrl,
      embeddedUrl: `https://cloud.example.test${signInPath}`,
    });
  });
  it.each([
    undefined,
    '//evil.test',
    '/account',
    '/api/mcp-connections/authorize?state=s&next=/evil',
  ])('uses the validated provider when sign-in path is %p', async (path) => {
    jest
      .mocked(requestCanopyCloudJson)
      .mockResolvedValue({ authorizationUrl, signInPath: path });
    expect(await startAccountMcpConnection(request)).toEqual({
      authorizationUrl,
      embeddedUrl: authorizationUrl,
    });
    expect(mintAuthenticatedPortalUrl).not.toHaveBeenCalled();
  });
  it.each([
    'file:///tmp/cloud',
    'not a URL',
    'https://user:secret@cloud.example.test',
  ])('rejects unsafe cloud fallback origin %s', async (baseUrl) => {
    jest.mocked(mintAuthenticatedPortalUrl).mockResolvedValue(null);
    jest.mocked(resolveCanopyCloudCredentialContext).mockResolvedValue({
      ...credentials,
      baseUrl,
      account: { id: 'acct-1' },
    });
    expect(await startAccountMcpConnection(request)).toEqual({
      authorizationUrl,
      embeddedUrl: authorizationUrl,
    });
  });
  it.each([
    'http://provider.test',
    'file:///tmp/unsafe',
    'https://user:secret@provider.test',
  ])('rejects unsafe provider %s', async (url) => {
    jest
      .mocked(requestCanopyCloudJson)
      .mockResolvedValue({ authorizationUrl: url, signInPath });
    await expect(startAccountMcpConnection(request)).rejects.toMatchObject({
      code: 'invalid-response',
    });
    expect(mintAuthenticatedPortalUrl).not.toHaveBeenCalled();
  });
  it('preserves immediate connections', async () => {
    jest.mocked(requestCanopyCloudJson).mockResolvedValue({ connection: row });
    expect(await startAccountMcpConnection(request)).toEqual({
      connection: row,
    });
    expect(mintAuthenticatedPortalUrl).not.toHaveBeenCalled();
  });
  it('refuses a mismatched account before sending', async () => {
    await expect(
      startAccountMcpConnection({ ...request, expectedAccountId: 'other' }),
    ).rejects.toMatchObject({ code: 'account-changed' });
    expect(requestCanopyCloudJson).not.toHaveBeenCalled();
  });
  it('refuses a changed account after minting before returning the link', async () => {
    jest.mocked(mintAuthenticatedPortalUrl).mockImplementation(() => {
      jest.mocked(resolveCanopyCloudCredentialContext).mockResolvedValue({
        ...credentials,
        apiKey: 'csk_other',
        account: { id: 'other' },
      });
      return Promise.resolve('https://cloud.example.test/consume?code=once');
    });
    await expect(startAccountMcpConnection(request)).rejects.toMatchObject({
      code: 'account-changed',
    });
  });
});
