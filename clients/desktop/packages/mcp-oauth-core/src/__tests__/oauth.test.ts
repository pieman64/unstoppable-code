import {
  createCodeVerifier,
  createPkceChallenge,
  discoverProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
  registerDynamicClient,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  parseDiscoveredPublicHttpsUrl,
  parseHttpUrl,
  buildCanonicalResourceUrl,
  isSameOAuthIssuer,
  isSameRegistrableDomain,
  parseAuthorizationServerMetadata,
  isAccessTokenFresh,
  parseExpiresAt,
  buildOAuthDiscoveryHeaders,
  isTrustedDelegatedOAuthEndpointTuple,
  isTrustedOAuthEndpointPair,
  isTrustedOAuthEndpointPairForResource,
  loopbackOriginOf,
  oauthClientSecretRequired,
  parseProtectedResourceMetadata,
  providerAuthorizationParameters,
  registeredTokenEndpointAuthMethod,
  selectTokenEndpointAuthMethod,
  type OAuthAttempt,
  type OAuthFetch,
  type RegistrationRefusalReason,
  type TokenEndpointAuthMethod,
} from '../index';

// Captured from https://ramp-mcp-remote.ramp.com/.well-known/oauth-authorization-server.
const rampIssuer = 'https://ramp-mcp-remote.ramp.com';
const rampMetadata = {
  issuer: rampIssuer,
  authorization_endpoint:
    'https://ramp-mcp-remote.ramp.com/oauth/authorize?auth_level=auto',
  token_endpoint: 'https://api.ramp.com/developer/v1/token/pkce',
  registration_endpoint: 'https://ramp-mcp-remote.ramp.com/register',
  token_endpoint_auth_methods_supported: ['none'],
  code_challenge_methods_supported: ['S256'],
};

const upstream = 'https://mcp.example.com/tools?region=eu#fragment';
const issuer = 'https://auth.example.com/tenant';
const wireMetadata = {
  issuer,
  authorization_endpoint: 'https://auth.example.com/authorize',
  token_endpoint: 'https://auth.example.com/token',
  registration_endpoint: 'https://auth.example.com/register',
  scopes_supported: ['read'],
};

describe('MCP OAuth core', () => {
  it('performs discovery, DCR, S256 authorization, exchange and refresh rotation with injected fetch', async () => {
    const fetch = jest.fn(
      async (url: string, init?: RequestInit): Promise<Response> => {
        void init;
        if (url.includes('oauth-protected-resource'))
          return Promise.resolve(
            Response.json({
              resource: buildCanonicalResourceUrl(upstream),
              authorization_servers: [issuer],
              scopes_supported: ['read'],
            }),
          );
        if (url.includes('oauth-authorization-server'))
          return Promise.resolve(Response.json(wireMetadata));
        if (url.endsWith('/register'))
          return Promise.resolve(Response.json({ client_id: 'shared-client' }));
        return Promise.resolve(
          Response.json({
            access_token: 'access',
            refresh_token: 'rotated',
            expires_in: 3600,
          }),
        );
      },
    );
    const protectedResource = await discoverProtectedResourceMetadata(
      upstream,
      fetch,
    );
    expect(protectedResource?.authorizationServers).toEqual([issuer]);
    expect(fetch.mock.calls[0][0]).toBe(
      'https://mcp.example.com/.well-known/oauth-protected-resource/tools',
    );
    const metadata = await discoverAuthorizationServerMetadata(issuer, fetch);
    expect(metadata?.tokenEndpoint).toBe(wireMetadata.token_endpoint);
    const client = await registerDynamicClient({
      registrationEndpoint: wireMetadata.registration_endpoint,
      redirectUri: 'https://app.example.com/callback',
      clientName: 'Test app',
      fetch,
    });
    const verifier = createCodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      await createPkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    ).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    const authorization = new URL(
      await buildAuthorizationUrl({
        authorizationEndpoint: wireMetadata.authorization_endpoint,
        ...client,
        redirectUri: 'https://app.example.com/callback',
        codeVerifier: verifier,
        state: 'state',
        resource: upstream,
        scopes: ['read'],
      }),
    );
    expect(authorization.searchParams.get('resource')).toBe(
      'https://mcp.example.com/tools?region=eu',
    );
    expect(authorization.searchParams.get('code_challenge_method')).toBe(
      'S256',
    );
    expect(authorization.searchParams.get('state')).toBe('state');
    expect(client.tokenEndpointAuthMethod).toBeUndefined();
    const common = {
      ...client,
      tokenEndpointAuthMethod: 'none' as const,
      tokenEndpoint: wireMetadata.token_endpoint,
      resource: upstream,
      fetch,
    };
    const token = await exchangeAuthorizationCode({
      ...common,
      code: 'code',
      codeVerifier: verifier,
      redirectUri: 'https://app.example.com/callback',
    });
    expect(token.refreshToken).toBe('rotated');
    const exchangeBody = fetch.mock.calls.at(-1)?.[1]?.body;
    if (typeof exchangeBody !== 'string')
      throw new Error('Expected exchange body');
    const body = new URLSearchParams(exchangeBody);
    expect(body.get('code_verifier')).toBe(verifier);
    expect(body.get('resource')).toBe(buildCanonicalResourceUrl(upstream));
    const refreshed = await refreshAccessToken({
      ...common,
      refreshToken: 'previous',
    });
    expect(refreshed.refreshToken).toBe('rotated');
    const refreshBody = fetch.mock.calls.at(-1)?.[1]?.body;
    if (typeof refreshBody !== 'string')
      throw new Error('Expected refresh body');
    expect(new URLSearchParams(refreshBody).get('refresh_token')).toBe(
      'previous',
    );
    expect(fetch.mock.calls.at(-1)?.[1]?.redirect).toBe('error');
  });

  it.each([
    undefined,
    'not a URL',
    'https://other.example.com/tenant',
    'https://auth.example.com/other',
    'https://auth.example.com/tenant/',
  ])(
    'rejects missing, invalid or mismatched issuer %s during parsing and discovery',
    async (advertised): Promise<void> => {
      const payload = { ...wireMetadata, issuer: advertised };
      expect(parseAuthorizationServerMetadata(payload, issuer)).toBeNull();
      expect(
        await discoverAuthorizationServerMetadata(
          issuer,
          (): Promise<Response> => Promise.resolve(Response.json(payload)),
        ),
      ).toBeNull();
    },
  );
  it('matches the full issuer path after URL normalization and records RFC 9207 support', async (): Promise<void> => {
    const payload = {
      ...wireMetadata,
      issuer: 'https://AUTH.example.com:443/tenant',
      authorization_response_iss_parameter_supported: true,
    };
    expect(
      await discoverAuthorizationServerMetadata(
        issuer,
        (): Promise<Response> => Promise.resolve(Response.json(payload)),
      ),
    ).toMatchObject({ authorizationResponseIssParameterSupported: true });
    expect(
      parseAuthorizationServerMetadata(wireMetadata, issuer),
    ).toMatchObject({ authorizationResponseIssParameterSupported: false });
  });
  it.each([
    'not a URL',
    'https://other.example.net/tools',
    'https://mcp.example.com:8443/tools',
    'http://mcp.example.com/tools',
  ])(
    'rejects a cross-origin or malformed protected resource %s in well-known and challenge discovery',
    async (resource): Promise<void> => {
      for (const challenge of [
        {},
        { resourceMetadataUrl: 'https://mcp.example.com/resource-metadata' },
      ]) {
        const fetch = (): Promise<Response> =>
          Promise.resolve(
            Response.json({ resource, authorization_servers: [issuer] }),
          );
        expect(
          await discoverProtectedResourceMetadata(upstream, fetch, challenge),
        ).toBeNull();
      }
    },
  );
  it.each([
    [undefined, buildCanonicalResourceUrl(upstream)],
    ['https://mcp.example.com/', 'https://mcp.example.com/'],
    ['https://mcp.example.com/alias', 'https://mcp.example.com/alias'],
  ])(
    'binds a missing or same-origin protected resource %s as %s',
    async (resource, expected): Promise<void> => {
      for (const challenge of [
        {},
        { resourceMetadataUrl: 'https://mcp.example.com/resource-metadata' },
      ]) {
        const fetch = (): Promise<Response> =>
          Promise.resolve(
            Response.json({
              ...(resource === undefined ? {} : { resource }),
              authorization_servers: [issuer],
            }),
          );
        expect(
          await discoverProtectedResourceMetadata(upstream, fetch, challenge),
        ).toMatchObject({ resource: expected });
      }
    },
  );
  it('accepts exactly bound challenge metadata', async (): Promise<void> => {
    expect(
      await discoverProtectedResourceMetadata(
        upstream,
        (): Promise<Response> =>
          Promise.resolve(
            Response.json({
              resource: buildCanonicalResourceUrl(upstream),
              authorization_servers: [issuer],
            }),
          ),
        { resourceMetadataUrl: 'https://mcp.example.com/resource-metadata' },
      ),
    ).toMatchObject({ resource: buildCanonicalResourceUrl(upstream) });
  });

  it.each(['invalid_grant', 'invalid_client', 'unauthorized_client'])(
    'classifies terminal %s without carrying the response body',
    async (code) => {
      const fetch = async (): Promise<Response> =>
        Promise.resolve(
          Response.json(
            { error: code, error_description: 'secret response' },
            { status: 400 },
          ),
        );
      await expect(
        refreshAccessToken({
          fetch,
          clientId: 'c',
          tokenEndpointAuthMethod: 'none',
          refreshToken: 'r',
          tokenEndpoint: wireMetadata.token_endpoint,
          resource: upstream,
        }),
      ).rejects.toMatchObject({
        code,
        message: code,
        requiresReauthorization: true,
      });
    },
  );
  it.each([500, 503])(
    'treats HTTP %s as transient even with an invalid_grant body',
    async (status) => {
      await expect(
        refreshAccessToken({
          fetch: async () =>
            Promise.resolve(
              Response.json({ error: 'invalid_grant' }, { status }),
            ),
          clientId: 'c',
          tokenEndpointAuthMethod: 'none',
          refreshToken: 'r',
          tokenEndpoint: wireMetadata.token_endpoint,
          resource: upstream,
        }),
      ).rejects.toMatchObject({
        code: 'transient',
        requiresReauthorization: false,
      });
    },
  );
  it.each([
    { expiry: 1800000000, expected: new Date(1800000000000) },
    { expiry: 0, expected: undefined },
    { expiry: undefined, expected: undefined },
  ])(
    'parses DCR secret expiry $expiry',
    async ({ expiry, expected }): Promise<void> => {
      const result = await registerDynamicClient({
        registrationEndpoint: wireMetadata.registration_endpoint,
        redirectUri: 'https://app.example.com/callback',
        clientName: 'Test',
        fetch: (): Promise<Response> =>
          Promise.resolve(
            Response.json({
              client_id: 'client',
              client_secret: 'secret',
              client_secret_expires_at: expiry,
            }),
          ),
      });
      expect(result).toEqual({
        clientId: 'client',
        clientSecret: 'secret',
        clientSecretExpiresAt: expected,
      });
    },
  );
  it.each([-1, 1.5, '1800000000', null, 9000000000000])(
    'rejects malformed DCR secret expiry %j',
    async (expiry): Promise<void> => {
      await expect(
        registerDynamicClient({
          registrationEndpoint: wireMetadata.registration_endpoint,
          redirectUri: 'https://app.example.com/callback',
          clientName: 'Test',
          fetch: (): Promise<Response> =>
            Promise.resolve(
              Response.json({
                client_id: 'client',
                client_secret_expires_at: expiry,
              }),
            ),
        }),
      ).rejects.toMatchObject({ code: 'invalid_metadata' });
    },
  );

  it('reports vendors rejecting the HTTPS redirect', async () => {
    await expect(
      registerDynamicClient({
        fetch: async () =>
          Promise.resolve(
            Response.json({ error: 'invalid_redirect_uri' }, { status: 400 }),
          ),
        registrationEndpoint: wireMetadata.registration_endpoint,
        redirectUri: 'https://app.example.com/callback',
        clientName: 'Test',
      }),
    ).rejects.toMatchObject({ code: 'unsupported_redirect' });
  });
  describe('registration refusals', () => {
    const register = (
      status: number,
      body: Record<string, unknown>,
    ): Promise<unknown> =>
      registerDynamicClient({
        fetch: async () => Promise.resolve(Response.json(body, { status })),
        registrationEndpoint: wireMetadata.registration_endpoint,
        redirectUri: 'https://app.example.com/callback',
        clientName: 'Test',
      });

    // Refusals real providers answered dynamic registration with: each takes
    // only clients its operator approved, whatever this one sends. The reason
    // says which approval: a desktop's loopback registration passes only a
    // partner-only refusal (Dropbox takes it).
    it.each<
      [string, number, Record<string, unknown>, RegistrationRefusalReason]
    >([
      [
        'Dropbox',
        403,
        {
          error: 'registration_not_supported',
          error_description:
            'Dynamic client registration is not supported. Only pre-registered MCP trusted partners are allowed.',
        },
        'partner_only',
      ],
      [
        'ZoomInfo',
        400,
        {
          error: 'invalid_client_metadata',
          error_description:
            'Vendor with name Canopy was not found in approved vendors',
        },
        'vendor_not_approved',
      ],
      [
        'ZoomInfo (vendor list)',
        400,
        {
          error: 'invalid_client_metadata',
          error_description:
            'Vendor with name Canopy was not found in approved vendor list',
        },
        'vendor_not_approved',
      ],
      [
        'Okta',
        403,
        {
          error: 'insufficient_scope',
          error_description:
            "Policy 'Trusted Hosts' rejected request to client-registration service.",
        },
        'policy',
      ],
      [
        'a disabled endpoint answering with a message',
        400,
        {
          statusCode: 400,
          error: 'Bad Request',
          message: 'dynamic client registration is disabled',
        },
        'disabled',
      ],
      [
        'a disabled endpoint',
        403,
        {
          error: 'forbidden',
          error_description:
            'Dynamic client registration is currently disabled',
        },
        'disabled',
      ],
      [
        'a client quota',
        400,
        {
          error: 'invalid_client_metadata',
          error_description:
            'could not create client: Too many clients have been created',
        },
        'rate_limited',
      ],
      [
        'an unapproved software statement',
        400,
        {
          error: 'unapproved_software_statement',
        },
        'vendor_not_approved',
      ],
      [
        'a bare registration_not_supported',
        403,
        { error: 'registration_not_supported' },
        'partner_only',
      ],
      [
        'a redirect allowlist',
        403,
        {
          error: 'access_denied',
          error_description:
            'redirect_uri is not on the allowlist for this tenant',
        },
        'partner_only',
      ],
      ['a bare 401', 401, {}, 'initial_access_token'],
      [
        'an endpoint wanting an initial access token',
        403,
        {
          error: 'insufficient_scope',
          error_description: 'An initial access token is required',
        },
        'initial_access_token',
      ],
      [
        'an endpoint wanting authorization',
        403,
        { error: 'forbidden', error_description: 'Authorization required' },
        'initial_access_token',
      ],
      ['a bare 403', 403, {}, 'policy'],
    ])(
      'classifies the %s refusal as registration_refused',
      async (_provider, status, body, refusalReason): Promise<void> => {
        await expect(register(status, body)).rejects.toMatchObject({
          code: 'registration_refused',
          refusalReason,
          requiresReauthorization: false,
          attempt: {
            stage: 'registration',
            outcome: 'rejected',
            status,
          },
        });
      },
    );

    it('names a registration_not_supported refusal in its attempt', async (): Promise<void> => {
      await expect(
        register(403, {
          error: 'registration_not_supported',
          error_description:
            'Dynamic client registration is not supported. Only pre-registered MCP trusted partners are allowed.',
        }),
      ).rejects.toMatchObject({
        attempt: {
          error: 'registration_not_supported',
          errorDescription:
            'Dynamic client registration is not supported. Only pre-registered MCP trusted partners are allowed.',
        },
      });
    });

    it('keeps a message-only refusal description for diagnostics', async (): Promise<void> => {
      await expect(
        register(400, {
          statusCode: 400,
          error: 'Bad Request',
          message: 'dynamic client registration is disabled',
        }),
      ).rejects.toMatchObject({
        attempt: {
          error: 'other',
          errorDescription: 'dynamic client registration is disabled',
        },
      });
    });

    it.each<[string, number, Record<string, unknown>, string]>([
      [
        'a refused client authentication method',
        400,
        {
          error: 'invalid_client_metadata',
          error_description: 'token_endpoint_auth_method not supported',
        },
        'registration_unavailable',
      ],
      [
        'a forbidden client authentication method',
        403,
        {
          error: 'invalid_client_metadata',
          error_description:
            'Only client_secret_basic is allowed for token_endpoint_auth_method',
        },
        'registration_unavailable',
      ],
      [
        'a refused redirect URI',
        400,
        {
          error: 'invalid_client_metadata',
          error_description: 'redirect_uri is not allowed',
        },
        'unsupported_redirect',
      ],
      [
        'a forbidden redirect URI',
        403,
        { error: 'invalid_redirect_uri' },
        'unsupported_redirect',
      ],
      [
        'a redirect URI the request names in other words',
        400,
        {
          error: 'invalid_request',
          error_description: 'redirect_uris not permitted for this client',
        },
        'registration_unavailable',
      ],
      [
        'a refused kind of client another method may fix',
        400,
        {
          error: 'invalid_client_metadata',
          error_description: 'Confidential clients are not allowed',
        },
        'registration_unavailable',
      ],
      [
        'other metadata wanted',
        400,
        {
          error: 'invalid_client_metadata',
          error_description: 'client_uri is required',
        },
        'registration_unavailable',
      ],
      ['a rejected client', 401, { error: 'invalid_client' }, 'invalid_client'],
      ['a rate limit', 429, { error: 'access_denied' }, 'transient'],
    ])(
      'keeps %s out of registration_refused',
      async (_label, status, body, code): Promise<void> => {
        const error = await register(status, body).catch(
          (thrown: unknown): unknown => thrown,
        );
        expect(error).toMatchObject({ code });
        expect(error).not.toHaveProperty('refusalReason');
      },
    );
  });
  it('keeps absent rotation absent and classifies network errors', async () => {
    const input = {
      clientId: 'c',
      tokenEndpointAuthMethod: 'none' as const,
      refreshToken: 'r',
      tokenEndpoint: wireMetadata.token_endpoint,
      resource: upstream,
    };
    expect(
      await refreshAccessToken({
        ...input,
        fetch: async () =>
          Promise.resolve(Response.json({ access_token: 'a' })),
      }),
    ).toMatchObject({ accessToken: 'a', refreshToken: undefined });
    await expect(
      refreshAccessToken({
        ...input,
        fetch: () => Promise.reject(new Error('network secret')),
      }),
    ).rejects.toMatchObject({ code: 'transient', message: 'transient' });
  });
  it.each([
    'http://example.com',
    'https://127.0.0.1',
    'https://[::1]',
    'https://localhost',
    'https://user:pass@example.com',
  ])('rejects unsafe discovery URL %s', (url) => {
    expect(() => parseDiscoveredPublicHttpsUrl(url, 'URL')).toThrow();
  });
  it('preserves domain, tuple, URL and freshness policies', () => {
    expect(parseHttpUrl('http://localhost/a', 'URL').protocol).toBe('http:');
    expect(
      parseDiscoveredPublicHttpsUrl('https://8.8.8.8', 'URL').hostname,
    ).toBe('8.8.8.8');
    expect(isSameRegistrableDomain('a.example.com', 'b.example.com')).toBe(
      true,
    );
    expect(isSameRegistrableDomain('a.herokuapp.com', 'b.herokuapp.com')).toBe(
      false,
    );
    expect(
      parseAuthorizationServerMetadata(
        { ...wireMetadata, token_endpoint: 'https://evil.example.org/token' },
        issuer,
      ),
    ).toBeNull();
    expect(
      isTrustedDelegatedOAuthEndpointTuple(
        new URL('https://calendarmcp.googleapis.com'),
        new URL('https://accounts.google.com'),
        new URL('https://oauth2.googleapis.com'),
      ),
    ).toBe(true);
    expect(isAccessTokenFresh(undefined)).toBe(true);
    expect(isAccessTokenFresh(new Date(Date.now() + 59000).toISOString())).toBe(
      false,
    );
    expect(parseExpiresAt('3600')).toBeUndefined();
    expect(
      buildOAuthDiscoveryHeaders(
        { headers: { X: 'one' } },
        { extraHeaders: { X: 'two' }, authToken: 'a' },
      ),
    ).toEqual({ X: 'two', Authorization: 'Bearer a' });
  });
  it('accepts an authorization and token endpoint pair on one registrable domain', async (): Promise<void> => {
    const metadata = await discoverAuthorizationServerMetadata(
      rampIssuer,
      (url: string): Promise<Response> =>
        Promise.resolve(
          url.endsWith('/.well-known/oauth-authorization-server')
            ? Response.json(rampMetadata)
            : new Response(null, { status: 404 }),
        ),
    );
    expect(metadata).toMatchObject({
      issuer: rampIssuer,
      authorizationEndpoint: rampMetadata.authorization_endpoint,
      tokenEndpoint: rampMetadata.token_endpoint,
      registrationEndpoint: rampMetadata.registration_endpoint,
      tokenEndpointAuthMethodsSupported: ['none'],
    });
    const authorization = new URL(
      await buildAuthorizationUrl({
        authorizationEndpoint: metadata?.authorizationEndpoint ?? '',
        clientId: 'client',
        redirectUri: 'https://app.example.com/callback',
        resource: 'https://ramp-mcp-remote.ramp.com/mcp',
        state: 'state',
        codeVerifier: createCodeVerifier(),
      }),
    );
    expect(authorization.origin + authorization.pathname).toBe(
      'https://ramp-mcp-remote.ramp.com/oauth/authorize',
    );
    expect(authorization.searchParams.get('auth_level')).toBe('auto');
    expect(authorization.searchParams.get('client_id')).toBe('client');
    expect(authorization.searchParams.has('access_type')).toBe(false);
    expect(authorization.searchParams.has('prompt')).toBe(false);
    expect(
      isTrustedOAuthEndpointPairForResource(
        new URL('https://ramp-mcp-remote.ramp.com/mcp'),
        new URL(rampMetadata.authorization_endpoint),
        new URL(rampMetadata.token_endpoint),
      ),
    ).toBe(true);
  });
  it('requests offline access with re-consent from Google', async (): Promise<void> => {
    const authorization = new URL(
      await buildAuthorizationUrl({
        authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        clientId: 'client',
        redirectUri: 'https://app.example.com/callback',
        resource: 'https://calendarmcp.googleapis.com/mcp/v1',
        state: 'state',
        codeVerifier: createCodeVerifier(),
        scopes: ['https://www.googleapis.com/auth/calendar'],
      }),
    );
    expect(authorization.searchParams.get('access_type')).toBe('offline');
    expect(authorization.searchParams.get('prompt')).toBe('consent');
    expect(authorization.searchParams.get('client_id')).toBe('client');
    expect(authorization.searchParams.get('code_challenge_method')).toBe(
      'S256',
    );
  });
  it.each([
    'https://auth.example.com/authorize',
    'https://accounts.google.com.evil.tld/o/oauth2/v2/auth',
    'https://evil.accounts.google.com/o/oauth2/v2/auth',
    'http://accounts.google.com/o/oauth2/v2/auth',
    'https://accounts.google.com:8443/o/oauth2/v2/auth',
  ])(
    'adds no provider authorization parameters for %s',
    (authorizationEndpoint): void => {
      expect(
        providerAuthorizationParameters(new URL(authorizationEndpoint)),
      ).toEqual({});
    },
  );
  it.each([
    [
      'another registrable domain',
      'https://login.example.com/authorize',
      'https://token.example.net/token',
    ],
    [
      'a sibling on a shared hosting suffix',
      'https://a.herokuapp.com/authorize',
      'https://b.herokuapp.com/token',
    ],
    [
      'a sibling on another shared hosting suffix',
      'https://tenant-a.github.io/authorize',
      'https://tenant-b.github.io/token',
    ],
  ])(
    'rejects an endpoint pair on %s',
    (_label, authorizationEndpoint, tokenEndpoint): void => {
      const payload = {
        ...wireMetadata,
        authorization_endpoint: authorizationEndpoint,
        token_endpoint: tokenEndpoint,
      };
      expect(parseAuthorizationServerMetadata(payload, issuer)).toBeNull();
      expect(
        isTrustedOAuthEndpointPair(
          new URL(authorizationEndpoint),
          new URL(tokenEndpoint),
        ),
      ).toBe(false);
      expect(
        isTrustedOAuthEndpointPairForResource(
          new URL('https://mcp.example.com/tools'),
          new URL(authorizationEndpoint),
          new URL(tokenEndpoint),
        ),
      ).toBe(false);
    },
  );
  it('keeps cross-domain delegation to the pinned Google tuples and their resources', (): void => {
    const google = {
      issuer: 'https://accounts.google.com',
      authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      token_endpoint: 'https://oauth2.googleapis.com/token',
    };
    expect(
      parseAuthorizationServerMetadata(google, 'https://accounts.google.com'),
    ).toMatchObject({ tokenEndpoint: google.token_endpoint });
    const authorization = new URL(google.authorization_endpoint);
    const token = new URL(google.token_endpoint);
    expect(isTrustedOAuthEndpointPair(authorization, token)).toBe(true);
    for (const resource of [
      'https://calendarmcp.googleapis.com/mcp',
      'https://code.unstoppabledomains.com/mcp',
      'https://code.ud-staging.com/mcp',
      'https://app.unstoppable.ai/mcp',
    ])
      expect(
        isTrustedOAuthEndpointPairForResource(
          new URL(resource),
          authorization,
          token,
        ),
      ).toBe(true);
    expect(
      isTrustedOAuthEndpointPairForResource(
        new URL('https://unrelated.example.net/mcp'),
        authorization,
        token,
      ),
    ).toBe(false);
  });
  it.each<[string, string[] | undefined, boolean]>([
    ['public clients', ['none'], false],
    ['public and confidential clients', ['client_secret_basic', 'none'], false],
    [
      'only confidential clients',
      ['client_secret_post', 'client_secret_basic'],
      true,
    ],
    ['only HTTP Basic clients', ['client_secret_basic'], true],
    ['the RFC 8414 default of HTTP Basic clients', undefined, true],
    ['only methods no secret can satisfy', ['private_key_jwt'], false],
  ])(
    'reports whether a server that takes %s needs a client secret',
    (_label, methods, required): void => {
      const metadata = parseAuthorizationServerMetadata(
        {
          ...wireMetadata,
          ...(methods === undefined
            ? {}
            : { token_endpoint_auth_methods_supported: methods }),
        },
        issuer,
      );
      expect(metadata).not.toBeNull();
      if (!metadata) return;
      expect(metadata.tokenEndpointAuthMethodsSupported).toEqual(methods);
      expect(oauthClientSecretRequired(metadata)).toBe(required);
    },
  );
  it.each<
    [
      string[] | undefined,
      TokenEndpointAuthMethod | null,
      TokenEndpointAuthMethod | null,
    ]
  >([
    [undefined, 'client_secret_basic', null],
    [['client_secret_basic'], 'client_secret_basic', null],
    [['client_secret_post'], 'client_secret_post', null],
    [
      ['client_secret_post', 'client_secret_basic'],
      'client_secret_basic',
      null,
    ],
    [['none'], 'none', 'none'],
    [['none', 'client_secret_post'], 'client_secret_post', 'none'],
    [['private_key_jwt'], null, null],
  ])(
    'picks the token endpoint auth method for %j with and without a secret',
    (methods, withSecret, withoutSecret): void => {
      const metadata = { tokenEndpointAuthMethodsSupported: methods };
      expect(selectTokenEndpointAuthMethod(metadata, true)).toBe(withSecret);
      expect(selectTokenEndpointAuthMethod(metadata, false)).toBe(
        withoutSecret,
      );
    },
  );
  it.each<[string, string, boolean]>([
    ['https://accounts.google.com', 'https://accounts.google.com/', true],
    [
      'https://Auth.Example.com/tenant',
      'https://auth.example.com/tenant',
      true,
    ],
    ['https://auth.example.com/a', 'https://auth.example.com/b', false],
    ['https://auth.example.com/?x=1', 'https://auth.example.com/?x=1', false],
    ['https://auth.example.com/#a', 'https://auth.example.com/#a', false],
    ['http://auth.example.com', 'http://auth.example.com', false],
    ['not a url', 'not a url', false],
  ])('compares issuers %s and %s as URLs', (left, right, same): void => {
    expect(isSameOAuthIssuer(left, right)).toBe(same);
    expect(isSameOAuthIssuer(right, left)).toBe(same);
  });
  describe('token endpoint client authentication', () => {
    const tokenEndpoint = wireMetadata.token_endpoint;
    interface SentRequest {
      body: URLSearchParams;
      authorization: string | null;
    }
    function recordingFetch(): {
      fetch: jest.Mock<Promise<Response>, [string, RequestInit?]>;
      sent: () => SentRequest;
    } {
      const fetch = jest.fn<Promise<Response>, [string, RequestInit?]>(
        (): Promise<Response> =>
          Promise.resolve(Response.json({ access_token: 'access' })),
      );
      return {
        fetch,
        sent: (): SentRequest => {
          const init = fetch.mock.calls.at(-1)?.[1];
          return {
            body: new URLSearchParams(
              typeof init?.body === 'string' ? init.body : '',
            ),
            authorization: new Headers(init?.headers).get('authorization'),
          };
        },
      };
    }
    function request(
      operation: 'exchange' | 'refresh',
      input: {
        fetch: OAuthFetch;
        clientId: string;
        clientSecret?: string;
        tokenEndpointAuthMethod: TokenEndpointAuthMethod;
      },
    ): Promise<unknown> {
      const common = { ...input, tokenEndpoint, resource: upstream };
      return operation === 'exchange'
        ? exchangeAuthorizationCode({
            ...common,
            code: 'code',
            codeVerifier: 'verifier',
            redirectUri: 'https://app.example.com/callback',
          })
        : refreshAccessToken({ ...common, refreshToken: 'refresh' });
    }

    it.each(['exchange', 'refresh'] as const)(
      'sends a client_secret_basic client in an HTTP Basic header during %s',
      async (operation): Promise<void> => {
        const { fetch, sent } = recordingFetch();
        await request(operation, {
          fetch,
          clientId: 'app id:1',
          clientSecret: 's3cr+t/=:é',
          tokenEndpointAuthMethod: 'client_secret_basic',
        });
        // RFC 6749 §2.3.1: both parts are form-urlencoded before Base64.
        const credentials = 'app+id%3A1:s3cr%2Bt%2F%3D%3A%C3%A9';
        expect(sent().authorization).toBe(
          `Basic ${Buffer.from(credentials).toString('base64')}`,
        );
        expect(sent().body.has('client_secret')).toBe(false);
        expect(sent().body.has('client_id')).toBe(false);
      },
    );
    it.each(['exchange', 'refresh'] as const)(
      'posts a client_secret_post client in the form body during %s',
      async (operation): Promise<void> => {
        const { fetch, sent } = recordingFetch();
        await request(operation, {
          fetch,
          clientId: 'app',
          clientSecret: 'secret',
          tokenEndpointAuthMethod: 'client_secret_post',
        });
        expect(sent().authorization).toBeNull();
        expect(sent().body.get('client_id')).toBe('app');
        expect(sent().body.get('client_secret')).toBe('secret');
      },
    );
    it.each(['exchange', 'refresh'] as const)(
      'sends no secret for a public client during %s',
      async (operation): Promise<void> => {
        const { fetch, sent } = recordingFetch();
        await request(operation, {
          fetch,
          clientId: 'app',
          clientSecret: 'unused',
          tokenEndpointAuthMethod: 'none',
        });
        expect(sent().authorization).toBeNull();
        expect(sent().body.get('client_id')).toBe('app');
        expect(sent().body.has('client_secret')).toBe(false);
      },
    );
    it.each(['client_secret_basic', 'client_secret_post'] as const)(
      'refuses a %s request without a secret before sending it',
      async (tokenEndpointAuthMethod): Promise<void> => {
        const { fetch } = recordingFetch();
        await expect(
          request('refresh', {
            fetch,
            clientId: 'app',
            tokenEndpointAuthMethod,
          }),
        ).rejects.toMatchObject({ code: 'invalid_client' });
        expect(fetch).not.toHaveBeenCalled();
      },
    );
  });
  it.each<[TokenEndpointAuthMethod, Record<string, unknown>]>([
    ['none', {}],
    ['client_secret_post', { client_secret: 'secret' }],
    ['client_secret_basic', { client_secret: 'secret' }],
  ])(
    'keeps the %s method a registration response names',
    async (method, secret): Promise<void> => {
      const client = await registerDynamicClient({
        registrationEndpoint: wireMetadata.registration_endpoint,
        redirectUri: 'https://app.example.com/callback',
        clientName: 'Test',
        fetch: (): Promise<Response> =>
          Promise.resolve(
            Response.json({
              client_id: 'client',
              token_endpoint_auth_method: method,
              ...secret,
            }),
          ),
      });
      expect(client.tokenEndpointAuthMethod).toBe(method);
      expect(registeredTokenEndpointAuthMethod(client, {})).toBe(method);
    },
  );
  it.each<[string, Record<string, unknown>, string, string]>([
    [
      'a method no client here can use',
      { token_endpoint_auth_method: 'private_key_jwt' },
      'registration_unavailable',
      'unsupported_token_endpoint_auth_method',
    ],
    [
      'a secret method without a secret',
      { token_endpoint_auth_method: 'client_secret_basic' },
      'invalid_metadata',
      'missing_client_secret',
    ],
  ])(
    'rejects a registration response naming %s',
    async (_label, response, code, reason): Promise<void> => {
      await expect(
        registerDynamicClient({
          registrationEndpoint: wireMetadata.registration_endpoint,
          redirectUri: 'https://app.example.com/callback',
          clientName: 'Test',
          fetch: (): Promise<Response> =>
            Promise.resolve(
              Response.json({ client_id: 'client', ...response }),
            ),
        }),
      ).rejects.toMatchObject({
        code,
        attempt: {
          stage: 'registration',
          url: wireMetadata.registration_endpoint,
          reason,
        },
      });
    },
  );
  it.each<
    [string, string | undefined, string[] | undefined, TokenEndpointAuthMethod]
  >([
    [
      'a secret for the default server',
      'secret',
      undefined,
      'client_secret_basic',
    ],
    [
      'a secret for a POST-only server',
      'secret',
      ['client_secret_post'],
      'client_secret_post',
    ],
    ['no secret', undefined, undefined, 'none'],
  ])(
    'chooses the method for a registration that names none and returns %s',
    (_label, clientSecret, methods, expected): void => {
      expect(
        registeredTokenEndpointAuthMethod(
          { clientId: 'client', ...(clientSecret ? { clientSecret } : {}) },
          { tokenEndpointAuthMethodsSupported: methods },
        ),
      ).toBe(expected);
    },
  );
  it('revalidates metadata redirects and falls back through RFC/OIDC discovery URLs', async () => {
    const fetch = jest.fn(
      async (url: string): Promise<Response> =>
        url.includes('/tenant/.well-known/')
          ? Promise.resolve(Response.json(wireMetadata))
          : Promise.resolve(new Response(null, { status: 404 })),
    );
    expect(
      await discoverAuthorizationServerMetadata(issuer, fetch),
    ).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
    const attempts: OAuthAttempt[] = [];
    await expect(
      discoverAuthorizationServerMetadata(
        issuer,
        async () =>
          Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { Location: 'http://localhost/secret?token=a' },
            }),
          ),
        { observe: (attempt): number => attempts.push(attempt) },
      ),
    ).resolves.toBeNull();
    expect(attempts).toContainEqual({
      stage: 'authorization_server_metadata',
      url: 'http://localhost/secret',
      outcome: 'unsafe_url',
    });
  });
});

describe('loopback discovery for a local MCP server', () => {
  const origin = 'http://localhost:3701';
  const resource = `${origin}/api/v1/mcp/account`;
  const issuer = `${origin}/api/v1/oauth`;
  const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
  };

  it('finds the loopback origin of a local MCP URL only', () => {
    expect(loopbackOriginOf(resource)).toBe(origin);
    expect(loopbackOriginOf('http://127.0.0.1:8080/mcp')).toBe(
      'http://127.0.0.1:8080',
    );
    expect(loopbackOriginOf('http://[::1]:8080/mcp')).toBe('http://[::1]:8080');
    expect(loopbackOriginOf('https://mcp.example.com/mcp')).toBeUndefined();
    expect(loopbackOriginOf('not a url')).toBeUndefined();
  });

  it('admits an authorization server on that origin only when asked', () => {
    const payload = { resource, authorization_servers: [issuer] };
    expect(parseProtectedResourceMetadata(payload, resource)).toBeNull();
    expect(
      parseProtectedResourceMetadata(payload, resource, origin),
    ).toMatchObject({ authorizationServers: [issuer] });
    expect(
      parseProtectedResourceMetadata(
        { resource, authorization_servers: ['http://localhost:4999/oauth'] },
        resource,
        origin,
      ),
    ).toBeNull();
  });

  it('admits metadata whose issuer and endpoints share that origin', () => {
    expect(parseAuthorizationServerMetadata(metadata, issuer)).toBeNull();
    expect(
      parseAuthorizationServerMetadata(metadata, issuer, origin),
    ).toMatchObject({
      issuer,
      authorizationEndpoint: `${issuer}/authorize`,
      tokenEndpoint: `${issuer}/token`,
    });
    expect(
      parseAuthorizationServerMetadata(
        { ...metadata, token_endpoint: 'http://localhost:4999/token' },
        issuer,
        origin,
      ),
    ).toBeNull();
  });
});
