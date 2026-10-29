import {
  createOAuthRequestBudget,
  discoverAuthorizationServerMetadata,
  discoverOriginAuthorizationServer,
  discoverProtectedResourceMetadata,
  exchangeAuthorizationCode,
  isTrustedOAuthEndpointPair,
  isTrustedOAuthEndpointPairForResource,
  parseAuthorizationServerMetadata,
  parseResourceMetadataChallenge,
  refreshAccessToken,
  registerDynamicClient,
  registrationTokenEndpointAuthMethods,
  resourceDiagnosticUrl,
  OAuthError,
  type OAuthAttempt,
  type OAuthFetch,
} from '../index';

// Responses below are distilled from a staging sweep of the curated MCP
// catalog (REG-3034): real provider URLs, statuses and metadata fields.

/** A fetch answering each URL from a table; anything else is a 404. */
function routes(
  table: Record<string, () => Response>,
): jest.MockedFunction<OAuthFetch> {
  return jest.fn(
    async (url: string): Promise<Response> =>
      Promise.resolve(
        table[url]?.() ?? new Response('Not Found', { status: 404 }),
      ),
  );
}

function status(code: number, body = ''): () => Response {
  return (): Response => new Response(body, { status: code });
}

function json(payload: unknown): () => Response {
  return (): Response => Response.json(payload);
}

function collect(): {
  attempts: OAuthAttempt[];
  observe: (attempt: OAuthAttempt) => void;
} {
  const attempts: OAuthAttempt[] = [];
  return {
    attempts,
    observe: (attempt): void => {
      attempts.push(attempt);
    },
  };
}

describe('protected resource metadata discovery', () => {
  it.each([
    [403, 'RBAC: access denied'],
    [401, ''],
    [400, ''],
    [406, ''],
    [429, ''],
    [502, ''],
  ])(
    'moves past a path-aware document answering %s to the root one',
    async (code, body): Promise<void> => {
      // Docusign: the path-aware URL is behind RBAC, the root one is public.
      const fetch = routes({
        'https://mcp.docusign.com/.well-known/oauth-protected-resource/mcp':
          status(code, body),
        'https://mcp.docusign.com/.well-known/oauth-protected-resource': json({
          resource: 'https://mcp.docusign.com/mcp',
          resource_name: 'Docusign MCP',
          authorization_servers: ['https://mcp.docusign.com'],
          bearer_methods_supported: ['header'],
        }),
      });
      const { attempts, observe } = collect();
      await expect(
        discoverProtectedResourceMetadata(
          'https://mcp.docusign.com/mcp',
          fetch,
          { observe },
        ),
      ).resolves.toEqual({
        resource: 'https://mcp.docusign.com/mcp',
        authorizationServers: ['https://mcp.docusign.com/'],
        scopesSupported: [],
      });
      expect(attempts).toEqual([
        {
          stage: 'protected_resource_metadata',
          url: 'https://mcp.docusign.com/.well-known/oauth-protected-resource/mcp',
          outcome:
            code === 429 || code >= 500
              ? 'unavailable'
              : code === 404
                ? 'not_found'
                : 'rejected',
          status: code,
        },
      ]);
    },
  );

  it('passes over a redirect to plain HTTP instead of failing', async (): Promise<void> => {
    // O'Reilly: the path-aware document redirects to its http:// twin.
    const fetch = routes({
      'https://api.oreilly.com/.well-known/oauth-protected-resource/api/content-discovery/v1/mcp/':
        (): Response =>
          new Response(null, {
            status: 307,
            headers: {
              Location:
                'http://api.oreilly.com/.well-known/oauth-protected-resource/api/content-discovery/v1/mcp',
            },
          }),
    });
    const { attempts, observe } = collect();
    await expect(
      discoverProtectedResourceMetadata(
        'https://api.oreilly.com/api/content-discovery/v1/mcp/',
        fetch,
        { observe },
      ),
    ).resolves.toBeNull();
    expect(attempts).toEqual([
      {
        stage: 'protected_resource_metadata',
        url: 'http://api.oreilly.com/.well-known/oauth-protected-resource/api/*/v1/mcp',
        outcome: 'unsafe_url',
      },
      {
        stage: 'protected_resource_metadata',
        url: 'https://api.oreilly.com/.well-known/oauth-protected-resource',
        outcome: 'not_found',
        status: 404,
      },
    ]);
  });

  it('reports a network failure as unavailable without throwing', async (): Promise<void> => {
    const { attempts, observe } = collect();
    await expect(
      discoverProtectedResourceMetadata(
        'https://mcp.example.com/mcp',
        (): Promise<Response> => Promise.reject(new Error('ECONNRESET')),
        { observe },
      ),
    ).resolves.toBeNull();
    expect(attempts.map((attempt) => attempt.outcome)).toEqual([
      'unavailable',
      'unavailable',
    ]);
  });

  it('records a document that names no authorization server as unusable', async (): Promise<void> => {
    // Verisk Underwriting publishes `resource: "placeholder"`.
    const { attempts, observe } = collect();
    await expect(
      discoverProtectedResourceMetadata(
        'https://gatewaymcp.verisk.com/underwriting/intelligencemcp/v1',
        routes({
          'https://gatewaymcp.verisk.com/.well-known/oauth-protected-resource':
            json({
              authorization_servers: [
                'https://sso.verisk.com/oauth2/ausce3eyr3v1mce0o2p7',
              ],
              resource: 'placeholder',
            }),
        }),
        { observe },
      ),
    ).resolves.toBeNull();
    expect(attempts.at(-1)).toEqual({
      stage: 'protected_resource_metadata',
      url: 'https://gatewaymcp.verisk.com/.well-known/oauth-protected-resource',
      outcome: 'unusable',
    });
  });

  it('follows challenge metadata on a sibling host of the same site', async (): Promise<void> => {
    // Everlaw serves the MCP endpoint on api. and its metadata on app.
    const fetch = routes({
      'https://app.everlaw.com/.well-known/oauth-protected-resource/v1/mcp':
        json({
          resource: 'https://api.everlaw.com/v1/mcp',
          bearer_methods_supported: ['header', 'body'],
          authorization_servers: ['https://app.everlaw.com'],
        }),
    });
    await expect(
      discoverProtectedResourceMetadata(
        'https://api.everlaw.com/v1/mcp',
        fetch,
        {
          resourceMetadataUrl:
            'https://app.everlaw.com/.well-known/oauth-protected-resource/v1/mcp',
        },
      ),
    ).resolves.toMatchObject({
      resource: 'https://api.everlaw.com/v1/mcp',
      authorizationServers: ['https://app.everlaw.com/'],
    });
  });

  it('still binds sibling-host metadata to the MCP origin', async (): Promise<void> => {
    await expect(
      discoverProtectedResourceMetadata(
        'https://api.everlaw.com/v1/mcp',
        routes({
          'https://app.everlaw.com/prm': json({
            resource: 'https://app.everlaw.com/v1/mcp',
            authorization_servers: ['https://app.everlaw.com'],
          }),
        }),
        { resourceMetadataUrl: 'https://app.everlaw.com/prm' },
      ),
    ).resolves.toBeNull();
  });

  it.each([
    // Grasshopper proxies through another registrable domain.
    [
      'https://grasshopper-mcp.prd.narmitech.com/mcp',
      'https://api.grasshopper.bank/.well-known/oauth-protected-resource',
    ],
    [
      'https://tenant-a.herokuapp.com/mcp',
      'https://tenant-b.herokuapp.com/.well-known/oauth-protected-resource',
    ],
    [
      'https://mcp.example.com/mcp',
      'http://mcp.example.com/.well-known/oauth-protected-resource',
    ],
  ])(
    'never fetches challenge metadata for %s from another site at %s',
    async (mcpUrl, resourceMetadataUrl): Promise<void> => {
      const fetch = routes({});
      const { attempts, observe } = collect();
      await expect(
        discoverProtectedResourceMetadata(mcpUrl, fetch, {
          resourceMetadataUrl,
          observe,
        }),
      ).resolves.toBeNull();
      expect(fetch).not.toHaveBeenCalled();
      expect(attempts).toEqual([
        expect.objectContaining({ outcome: 'unsafe_url' }),
      ]);
    },
  );
});

describe('WWW-Authenticate resource_metadata', () => {
  it.each<[string, string | null, string | undefined]>([
    [
      'quoted, beside error fields (Dropbox)',
      'Bearer resource_metadata="https://mcp.dropbox.com/.well-known/oauth-protected-resource/claude_app_mcp", error="invalid_token", error_description="missing bearer token"',
      'https://mcp.dropbox.com/.well-known/oauth-protected-resource/claude_app_mcp',
    ],
    [
      'unquoted (Resy)',
      'Bearer resource_metadata=https://apigw.americanexpress.com/dining/v1/mcp/.well-known/oauth-protected-resource',
      'https://apigw.americanexpress.com/dining/v1/mcp/.well-known/oauth-protected-resource',
    ],
    [
      'without a space after the comma (Figma)',
      'Bearer resource_metadata="https://mcp.figma.com/.well-known/oauth-protected-resource",scope="mcp:connect",authorization_uri="https://api.figma.com/.well-known/oauth-authorization-server"',
      'https://mcp.figma.com/.well-known/oauth-protected-resource',
    ],
    [
      'last, after other parameters (Harvey)',
      'Bearer error="invalid_token", error_description="Authentication required", resource_metadata="https://api.harvey.ai/.well-known/oauth-protected-resource"',
      'https://api.harvey.ai/.well-known/oauth-protected-resource',
    ],
    [
      'with a differently cased name',
      'Bearer Resource_Metadata="https://mcp.example.com/prm"',
      'https://mcp.example.com/prm',
    ],
    [
      'with an escaped character',
      'Bearer resource_metadata="https://mcp.example.com/p\\rm"',
      'https://mcp.example.com/prm',
    ],
    [
      'unquoted, before another parameter',
      'Bearer resource_metadata=https://mcp.example.com/prm, scope="read"',
      'https://mcp.example.com/prm',
    ],
    [
      'absent (Atlassian)',
      'Bearer realm="OAuth", error="invalid_token", error_description="Missing or invalid access token"',
      undefined,
    ],
    [
      'only inside another parameter',
      'Bearer error_description="see x_resource_metadata=https://evil.example"',
      undefined,
    ],
    ['missing', null, undefined],
  ])('reads %s', (_label, header, expected): void => {
    expect(parseResourceMetadataChallenge(header)).toBe(expected);
  });
});

describe('authorization server metadata discovery', () => {
  const owkinIssuer =
    'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_sHA1n8NIn';
  const owkinMetadata = {
    issuer: owkinIssuer,
    authorization_endpoint:
      'https://k.auth.eu-west-1.amazoncognito.com/oauth2/authorize',
    token_endpoint: 'https://k.auth.eu-west-1.amazoncognito.com/oauth2/token',
    token_endpoint_auth_methods_supported: [
      'client_secret_basic',
      'client_secret_post',
    ],
  };

  it('tries every discovery URL when Cognito refuses the first two with 400', async (): Promise<void> => {
    const fetch = routes({
      'https://cognito-idp.eu-west-1.amazonaws.com/.well-known/oauth-authorization-server/eu-west-1_sHA1n8NIn':
        status(400),
      'https://cognito-idp.eu-west-1.amazonaws.com/.well-known/openid-configuration/eu-west-1_sHA1n8NIn':
        status(400),
      'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_sHA1n8NIn/.well-known/openid-configuration':
        json(owkinMetadata),
    });
    await expect(
      discoverAuthorizationServerMetadata(owkinIssuer, fetch),
    ).resolves.toMatchObject({
      issuer: owkinIssuer,
      tokenEndpoint: owkinMetadata.token_endpoint,
      tokenEndpointAuthMethodsSupported: [
        'client_secret_basic',
        'client_secret_post',
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('is transient only when no discovery URL could be reached', async (): Promise<void> => {
    const { attempts, observe } = collect();
    await expect(
      discoverAuthorizationServerMetadata(owkinIssuer, routes({}), {
        observe,
      }),
    ).resolves.toBeNull();
    expect(attempts).toHaveLength(3);
    await expect(
      discoverAuthorizationServerMetadata(
        owkinIssuer,
        async (): Promise<Response> =>
          Promise.resolve(new Response(null, { status: 503 })),
      ),
    ).rejects.toMatchObject({ code: 'transient' });
    await expect(
      discoverAuthorizationServerMetadata(
        owkinIssuer,
        (): Promise<Response> => Promise.reject(new Error('timeout')),
      ),
    ).rejects.toMatchObject({ code: 'transient' });
  });

  it('records metadata whose issuer does not match as unusable and moves on', async (): Promise<void> => {
    // Docusign's issuer is account.docusign.com, not the server it names.
    const { attempts, observe } = collect();
    await expect(
      discoverAuthorizationServerMetadata(
        'https://mcp.docusign.com',
        routes({
          'https://mcp.docusign.com/.well-known/oauth-authorization-server':
            json({
              issuer: 'https://account.docusign.com',
              authorization_endpoint: 'https://account.docusign.com/oauth/auth',
              token_endpoint: 'https://account.docusign.com/oauth/token',
            }),
          'https://mcp.docusign.com/.well-known/openid-configuration':
            status(403),
        }),
        { observe },
      ),
    ).resolves.toBeNull();
    expect(attempts).toEqual([
      {
        stage: 'authorization_server_metadata',
        url: 'https://mcp.docusign.com/.well-known/oauth-authorization-server',
        outcome: 'unusable',
      },
      {
        stage: 'authorization_server_metadata',
        url: 'https://mcp.docusign.com/.well-known/openid-configuration',
        outcome: 'rejected',
        status: 403,
      },
    ]);
  });
});

describe('authorization server at the MCP origin (2025-03-26)', () => {
  it.each([
    [
      'Atlassian',
      'https://mcp.atlassian.com/v1/mcp',
      {
        issuer: 'https://mcp.atlassian.com',
        authorization_endpoint: 'https://mcp.atlassian.com/v1/authorize',
        token_endpoint: 'https://mcp.atlassian.com/v1/token',
        registration_endpoint: 'https://mcp.atlassian.com/v1/register',
        token_endpoint_auth_methods_supported: [
          'client_secret_basic',
          'client_secret_post',
          'none',
        ],
      },
    ],
    [
      'Zomato',
      'https://mcp-server.zomato.com/mcp',
      {
        issuer: 'https://mcp-server.zomato.com/',
        authorization_endpoint: 'https://mcp-server.zomato.com/authorize',
        token_endpoint: 'https://mcp-server.zomato.com/token',
        registration_endpoint: 'https://mcp-server.zomato.com/register',
      },
    ],
  ])(
    'stands the %s origin in for missing resource metadata',
    async (_label, mcpUrl, metadata): Promise<void> => {
      const origin = new URL(mcpUrl).origin;
      await expect(
        discoverOriginAuthorizationServer(
          mcpUrl,
          routes({
            [`${origin}/.well-known/oauth-authorization-server`]:
              json(metadata),
          }),
        ),
      ).resolves.toEqual({
        resource: mcpUrl,
        authorizationServers: [`${origin}/`],
        scopesSupported: [],
      });
    },
  );

  it('finds nothing at an origin that publishes no metadata', async (): Promise<void> => {
    // Kindora serves no OAuth at all.
    await expect(
      discoverOriginAuthorizationServer(
        'https://kindora-mcp.azurewebsites.net/mcp',
        routes({}),
      ),
    ).resolves.toBeNull();
  });

  it('refuses origin metadata naming another issuer', async (): Promise<void> => {
    // Blackbaud's origin document names oauth2.sky.blackbaud.com.
    await expect(
      discoverOriginAuthorizationServer(
        'https://mcp.sky.blackbaud.com/',
        routes({
          'https://mcp.sky.blackbaud.com/.well-known/oauth-authorization-server':
            json({
              issuer: 'https://oauth2.sky.blackbaud.com',
              authorization_endpoint:
                'https://oauth2.sky.blackbaud.com/authorization',
              token_endpoint: 'https://oauth2.sky.blackbaud.com/token',
            }),
        }),
      ),
    ).resolves.toBeNull();
  });
});

describe('endpoints across sites', () => {
  it.each([
    [
      'Harvey (token endpoint on Auth0)',
      'https://api.harvey.ai/hosted_mcp/mcp',
      {
        issuer: 'https://api.harvey.ai',
        authorization_endpoint: 'https://api.harvey.ai/authorize',
        token_endpoint: 'https://harvey-ai.us.auth0.com/oauth/token',
      },
    ],
    [
      'Descript (token endpoint on Stytch)',
      'https://api.descript.com/v2/mcp/claude',
      {
        issuer: 'https://api.descript.com',
        authorization_endpoint: 'https://web.descript.com/oauth/authorize',
        token_endpoint: 'https://api.stytch.com/v1/public/oauth2/token',
      },
    ],
    [
      'Ketryx (issuer on Stytch, consent on its own site)',
      'https://app.ketryx.com/api/mcp',
      {
        issuer: 'https://pleasant-bridge-4023.customers.stytch.com',
        authorization_endpoint: 'https://app.ketryx.com/oauth/authorize',
        token_endpoint:
          'https://pleasant-bridge-4023.customers.stytch.com/v1/oauth2/token',
        registration_endpoint:
          'https://pleasant-bridge-4023.customers.stytch.com/v1/oauth2/register',
      },
    ],
    [
      'Dropbox (dropbox.com and dropboxapi.com)',
      'https://mcp.dropbox.com/claude_app_mcp',
      {
        issuer: 'https://www.dropbox.com',
        authorization_endpoint: 'https://www.dropbox.com/oauth2/authorize',
        token_endpoint: 'https://api.dropboxapi.com/oauth2/token',
      },
    ],
    [
      'Fathom (fathom.video and fathom.ai)',
      'https://api.fathom.ai/mcp',
      {
        issuer: 'https://api.fathom.ai',
        authorization_endpoint:
          'https://fathom.video/external/v1/oauth2/authorize',
        token_endpoint: 'https://api.fathom.ai/external/v1/oauth2/token',
      },
    ],
  ])(
    'trusts %s for its own resource only',
    (_label, resource, metadata): void => {
      const parsed = parseAuthorizationServerMetadata(
        metadata,
        metadata.issuer,
      );
      expect(parsed).toMatchObject({
        authorizationEndpoint: metadata.authorization_endpoint,
        tokenEndpoint: metadata.token_endpoint,
      });
      const authorization = new URL(metadata.authorization_endpoint);
      const token = new URL(metadata.token_endpoint);
      expect(isTrustedOAuthEndpointPair(authorization, token)).toBe(true);
      expect(
        isTrustedOAuthEndpointPairForResource(
          new URL(resource),
          authorization,
          token,
        ),
      ).toBe(true);
      expect(
        isTrustedOAuthEndpointPairForResource(
          new URL('https://mcp.attacker.example/mcp'),
          authorization,
          token,
        ),
      ).toBe(false);
    },
  );

  it.each([
    [
      'a token endpoint whose host only ends like an identity provider',
      'https://api.harvey.ai/authorize',
      'https://evilauth0.com/oauth/token',
    ],
    [
      'an identity provider name inside another domain',
      'https://api.harvey.ai/authorize',
      'https://auth0.com.attacker.example/oauth/token',
    ],
    [
      'an identity provider holding the consent screen instead',
      'https://harvey-ai.us.auth0.com/authorize',
      'https://api.harvey.ai/oauth/token',
    ],
    [
      'a documented site pair in the wrong direction',
      'https://api.dropboxapi.com/oauth2/authorize',
      'https://www.dropbox.com/oauth2/token',
    ],
    [
      'plain HTTP toward an identity provider',
      'http://api.harvey.ai/authorize',
      'https://harvey-ai.us.auth0.com/oauth/token',
    ],
  ])('rejects %s', (_label, authorizationEndpoint, tokenEndpoint): void => {
    expect(
      isTrustedOAuthEndpointPairForResource(
        new URL('https://api.harvey.ai/hosted_mcp/mcp'),
        new URL(authorizationEndpoint),
        new URL(tokenEndpoint),
      ),
    ).toBe(false);
  });

  it('keeps a consent screen on another site from borrowing an identity provider', (): void => {
    // The provider's token endpoint is trusted, but a resource cannot send
    // its users to a consent screen on a site it does not share.
    expect(
      isTrustedOAuthEndpointPairForResource(
        new URL('https://mcp.attacker.example/mcp'),
        new URL('https://accounts.google.com/o/oauth2/v2/auth'),
        new URL('https://attacker.us.auth0.com/oauth/token'),
      ),
    ).toBe(false);
  });

  it.each([
    [
      'Vercel',
      {
        issuer: 'https://vercel.com/',
        authorization_endpoint: 'https://vercel.com/oauth/authorize',
        token_endpoint: 'https://api.vercel.com/login/oauth/token',
        registration_endpoint: 'https://api.vercel.com/login/oauth/register',
      },
    ],
    [
      'PlanetScale',
      {
        issuer: 'https://api.planetscale.com/',
        authorization_endpoint: 'https://app.planetscale.com/oauth/authorize',
        token_endpoint: 'https://auth.planetscale.com/oauth/token',
        registration_endpoint:
          'https://auth.planetscale.com/oauth/registration',
      },
    ],
    [
      'TickTick',
      {
        issuer: 'https://ticktick.com/',
        authorization_endpoint: 'https://ticktick.com/oauth/authorize',
        token_endpoint: 'https://api.ticktick.com/oauth/token',
        registration_endpoint: 'https://api.ticktick.com/oauth/register',
      },
    ],
    [
      'Lawve',
      {
        issuer: 'https://auth.lawve.ai/',
        authorization_endpoint: 'https://auth.lawve.ai/oauth2/authorize',
        token_endpoint: 'https://auth.lawve.ai/oauth2/token',
        registration_endpoint: 'https://mcp.lawve.ai/oauth2/register',
      },
    ],
  ])(
    'keeps %s’s registration endpoint on its own site',
    (_label, metadata): void => {
      expect(
        parseAuthorizationServerMetadata(metadata, metadata.issuer),
      ).toMatchObject({ registrationEndpoint: metadata.registration_endpoint });
    },
  );

  it('drops a registration endpoint on another site', (): void => {
    const metadata = {
      issuer: 'https://vercel.com/',
      authorization_endpoint: 'https://vercel.com/oauth/authorize',
      token_endpoint: 'https://api.vercel.com/login/oauth/token',
      registration_endpoint: 'https://register.attacker.example/register',
    };
    const parsed = parseAuthorizationServerMetadata(metadata, metadata.issuer);
    expect(parsed).not.toBeNull();
    expect(parsed?.registrationEndpoint).toBeUndefined();
  });
});

describe('dynamic client registration', () => {
  const registrationEndpoint = 'https://api.figma.com/v1/oauth/mcp/register';
  const redirectUri =
    'https://app.example.com/api/mcp-connections/callback/key';

  it.each<[string, string[] | undefined, string[]]>([
    [
      'a server that takes public clients',
      ['none', 'client_secret_basic'],
      ['none'],
    ],
    [
      'Figma (Basic or post)',
      ['client_secret_basic', 'client_secret_post'],
      ['client_secret_basic'],
    ],
    ['BioRender (post only)', ['client_secret_post'], ['client_secret_post']],
    [
      'Cloze (signed JWT or Basic)',
      ['private_key_jwt', 'client_secret_basic'],
      ['client_secret_basic'],
    ],
    [
      'a server that omits the list',
      undefined,
      ['client_secret_basic', 'none'],
    ],
    ['a server that only takes signed JWTs', ['private_key_jwt'], []],
  ])('registers %s as %j', (_label, supported, expected): void => {
    expect(
      registrationTokenEndpointAuthMethods({
        tokenEndpointAuthMethodsSupported: supported,
      }),
    ).toEqual(expected);
  });

  it('registers a confidential client and authenticates its token requests with the secret', async (): Promise<void> => {
    const fetch = jest.fn(
      async (url: string, init?: RequestInit): Promise<Response> => {
        void init;
        return Promise.resolve(
          url === registrationEndpoint
            ? Response.json(
                {
                  client_id: 'figma-client',
                  client_secret: 'figma-secret',
                  client_secret_expires_at: 0,
                  token_endpoint_auth_method: 'client_secret_basic',
                },
                { status: 201 },
              )
            : Response.json({ access_token: 'access', expires_in: 3600 }),
        );
      },
    );
    const client = await registerDynamicClient({
      registrationEndpoint,
      redirectUri,
      clientName: 'Canopy',
      tokenEndpointAuthMethod: 'client_secret_basic',
      fetch,
    });
    expect(client).toEqual({
      clientId: 'figma-client',
      clientSecret: 'figma-secret',
      clientSecretExpiresAt: undefined,
      tokenEndpointAuthMethod: 'client_secret_basic',
    });
    const registration = fetch.mock.calls[0][1]?.body;
    if (typeof registration !== 'string')
      throw new Error('Expected a registration body');
    expect(JSON.parse(registration)).toMatchObject({
      token_endpoint_auth_method: 'client_secret_basic',
      redirect_uris: [redirectUri],
    });
    await exchangeAuthorizationCode({
      ...client,
      tokenEndpointAuthMethod: 'client_secret_basic',
      tokenEndpoint: 'https://api.figma.com/v1/oauth/token',
      resource: 'https://mcp.figma.com/mcp',
      code: 'code',
      codeVerifier: 'verifier',
      redirectUri,
      fetch,
    });
    const exchange = fetch.mock.calls[1][1];
    expect(new Headers(exchange?.headers).get('authorization')).toBe(
      `Basic ${btoa('figma-client:figma-secret')}`,
    );
    if (typeof exchange?.body !== 'string')
      throw new Error('Expected an exchange body');
    expect(exchange.body).not.toContain('figma-secret');
  });

  it.each<[string, number, Record<string, unknown>, string]>([
    // PingFederate and Okta want an initial access token: only clients their
    // operator approved register, whatever this one sends. Okta's 403 names
    // no token, so it reads as a policy refusal.
    ['Datasite', 401, { error: 'invalid_token' }, 'initial_access_token'],
    ['Verisk', 403, { errorCode: 'E0000006' }, 'policy'],
    ['a closed registration', 400, { error: 'access_denied' }, 'policy'],
  ])(
    'reports %s (%s) as registration_refused with its details',
    async (_label, code, payload, refusalReason): Promise<void> => {
      await expect(
        registerDynamicClient({
          registrationEndpoint: `${registrationEndpoint}?tenant=secret`,
          redirectUri,
          clientName: 'Canopy',
          fetch: async (): Promise<Response> =>
            Promise.resolve(Response.json(payload, { status: code })),
        }),
      ).rejects.toMatchObject({
        code: 'registration_refused',
        refusalReason,
        attempt: {
          stage: 'registration',
          url: registrationEndpoint,
          status: code,
          ...(typeof payload.error === 'string'
            ? { error: payload.error }
            : {}),
        },
      });
    },
  );

  it.each<[string, number, Record<string, unknown>]>([
    [
      'an auth-method refusal that mentions redirect URIs',
      400,
      {
        error: 'invalid_client_metadata',
        error_description:
          'token_endpoint_auth_method "none" is not allowed for clients with redirect_uris',
      },
    ],
    [
      'an unsupported auth method',
      400,
      {
        error: 'invalid_client_metadata',
        error_description: 'Unsupported token endpoint authentication method',
      },
    ],
    ['a missing endpoint', 404, {}],
  ])(
    'reports %s (%s) as registration_unavailable with its details',
    async (_label, code, payload): Promise<void> => {
      await expect(
        registerDynamicClient({
          registrationEndpoint: `${registrationEndpoint}?tenant=secret`,
          redirectUri,
          clientName: 'Canopy',
          fetch: async (): Promise<Response> =>
            Promise.resolve(Response.json(payload, { status: code })),
        }),
      ).rejects.toMatchObject({
        code: 'registration_unavailable',
        attempt: {
          stage: 'registration',
          url: registrationEndpoint,
          status: code,
          ...(typeof payload.error === 'string'
            ? { error: payload.error }
            : {}),
          ...(typeof payload.error_description === 'string'
            ? { errorDescription: payload.error_description }
            : {}),
        },
      });
    },
  );

  it.each<[string, Record<string, unknown>]>([
    ['IFTTT', { error: 'invalid_redirect_uri' }],
    [
      'Adobe Experience Manager',
      {
        error: 'invalid_client_metadata',
        error_description:
          'No IMS client configuration found for redirect URI: https://canopy.ud-staging.com/api/mcp-connections/callback/1iLdNrH9PPKAUVKGSAObPTLJ573yYb2dAwd8Vf_1CuI',
      },
    ],
    [
      'Lusha',
      {
        error: 'invalid_client_metadata',
        error_description:
          'redirect_uris are not eligible for dynamic client registration',
      },
    ],
    [
      'Spinach',
      {
        error: 'invalid_client_metadata',
        error_description: 'No redirect_uris allowed by policy',
      },
    ],
    [
      'Quartr',
      {
        error: 'invalid_client_metadata',
        error_description:
          "redirect URI host 'canopy.ud-staging.com' is not allowed",
      },
    ],
  ])(
    'keeps %s refusing the callback as unsupported_redirect',
    async (_label, payload): Promise<void> => {
      await expect(
        registerDynamicClient({
          registrationEndpoint,
          redirectUri,
          clientName: 'Canopy',
          fetch: async (): Promise<Response> =>
            Promise.resolve(Response.json(payload, { status: 400 })),
        }),
      ).rejects.toMatchObject({ code: 'unsupported_redirect' });
    },
  );

  it.each<[string, number, string]>([
    ['invalid_grant', 400, 'registration_unavailable'],
    ['unauthorized_client', 400, 'registration_unavailable'],
    // A 401 or 403 refuses this client by policy whatever its code says.
    ['unauthorized_client', 401, 'registration_refused'],
    ['invalid_grant', 403, 'registration_refused'],
  ])(
    'reports a registration refused with %s (%s) as %s',
    async (error, code, classification): Promise<void> => {
      await expect(
        registerDynamicClient({
          registrationEndpoint,
          redirectUri,
          clientName: 'Canopy',
          fetch: async (): Promise<Response> =>
            Promise.resolve(Response.json({ error }, { status: code })),
        }),
      ).rejects.toMatchObject({
        code: classification,
        attempt: { stage: 'registration', status: code, error },
      });
    },
  );

  it('keeps a registration refused with invalid_client as invalid_client, for one retry', async (): Promise<void> => {
    await expect(
      registerDynamicClient({
        registrationEndpoint,
        redirectUri,
        clientName: 'Canopy',
        fetch: async (): Promise<Response> =>
          Promise.resolve(
            Response.json({ error: 'invalid_client' }, { status: 401 }),
          ),
      }),
    ).rejects.toMatchObject({ code: 'invalid_client' });
  });

  it.each([429, 500, 503])(
    'keeps a registration answered with %s transient',
    async (code): Promise<void> => {
      await expect(
        registerDynamicClient({
          registrationEndpoint,
          redirectUri,
          clientName: 'Canopy',
          fetch: async (): Promise<Response> =>
            Promise.resolve(new Response(null, { status: code })),
        }),
      ).rejects.toMatchObject({
        code: 'transient',
        attempt: { outcome: 'unavailable', status: code },
      });
    },
  );

  it('never keeps a token endpoint’s error description', async (): Promise<void> => {
    await expect(
      exchangeAuthorizationCode({
        clientId: 'client',
        tokenEndpointAuthMethod: 'none',
        tokenEndpoint: 'https://auth.example.com/token',
        resource: 'https://mcp.example.com/mcp',
        code: 'the-code',
        codeVerifier: 'verifier',
        redirectUri,
        fetch: async (): Promise<Response> =>
          Promise.resolve(
            Response.json(
              {
                error: 'invalid_grant',
                error_description: 'code the-code was already used',
              },
              { status: 400 },
            ),
          ),
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'invalid_grant',
        attempt: {
          stage: 'token',
          url: 'https://auth.example.com/token',
          outcome: 'rejected',
          status: 400,
          error: 'invalid_grant',
        },
      }),
    );
  });
});

describe('diagnostics that never carry a secret', () => {
  const redirectUri =
    'https://canopy.ud-staging.com/api/mcp-connections/callback';
  const tokenRequest = {
    clientId: 'client',
    tokenEndpointAuthMethod: 'none' as const,
    tokenEndpoint: 'https://auth.example.com/token',
    resource: 'https://mcp.example.com/mcp',
    code: 'the-code',
    codeVerifier: 'verifier',
    redirectUri,
  };
  const answer =
    (payload: unknown, code: number): OAuthFetch =>
    async (): Promise<Response> =>
      Promise.resolve(Response.json(payload, { status: code }));

  it.each([
    'the-code',
    'refresh token rt-123 is revoked',
    'invalid_grant: code=the-code',
  ])(
    'logs a token endpoint’s non-standard error %j as other',
    async (error): Promise<void> => {
      const failure = exchangeAuthorizationCode({
        ...tokenRequest,
        fetch: answer({ error }, 400),
      });
      await expect(failure).rejects.toMatchObject({
        code: 'transient',
        attempt: { stage: 'token', status: 400, error: 'other' },
      });
      await failure.catch((thrown: unknown): void => {
        expect(JSON.stringify(thrown)).not.toContain('the-code');
        expect(JSON.stringify(thrown)).not.toContain('rt-123');
      });
    },
  );

  it.each(['invalid_request', 'unsupported_grant_type', 'invalid_scope'])(
    'keeps the standard token error %s',
    async (error): Promise<void> => {
      await expect(
        exchangeAuthorizationCode({
          ...tokenRequest,
          fetch: answer({ error }, 400),
        }),
      ).rejects.toMatchObject({ attempt: { error } });
    },
  );

  it('logs a registration’s non-standard error as other', async (): Promise<void> => {
    await expect(
      registerDynamicClient({
        registrationEndpoint: 'https://auth.example.com/register',
        redirectUri,
        clientName: 'Canopy',
        fetch: answer({ error: 'Tenant ABC-123 is closed' }, 403),
      }),
    ).rejects.toMatchObject({
      code: 'registration_refused',
      attempt: { error: 'other' },
    });
  });

  it('drops the query and fragment of any URL a registration error describes', async (): Promise<void> => {
    const failure = registerDynamicClient({
      registrationEndpoint: 'https://auth.example.com/register',
      redirectUri,
      clientName: 'Canopy',
      fetch: answer(
        {
          error: 'invalid_client_metadata',
          error_description:
            'Client https://auth.example.com/clients/7?access=s3cr3t#frag is closed',
        },
        400,
      ),
    });
    await expect(failure).rejects.toMatchObject({
      attempt: {
        errorDescription: 'Client https://auth.example.com/clients/7 is closed',
      },
    });
  });

  it('attaches an attempt to a token response with no access token', async (): Promise<void> => {
    await expect(
      exchangeAuthorizationCode({
        ...tokenRequest,
        fetch: answer({ token_type: 'Bearer' }, 200),
      }),
    ).rejects.toMatchObject({
      code: 'transient',
      attempt: {
        stage: 'token',
        url: 'https://auth.example.com/token',
        outcome: 'unusable',
        reason: 'missing_access_token',
      },
    });
  });

  it('logs only a redacted shape of an MCP URL path that may hold a secret', async (): Promise<void> => {
    // Zapier-style per-user MCP URLs carry the user's key in the path.
    const { attempts, observe } = collect();
    await expect(
      discoverProtectedResourceMetadata(
        'https://mcp.zapier.com/api/mcp/s/Zk9QmX2c7Lp0Rt4v/mcp',
        routes({}),
        { observe },
      ),
    ).resolves.toBeNull();
    expect(attempts.map((attempt) => attempt.url)).toEqual([
      'https://mcp.zapier.com/.well-known/oauth-protected-resource/api/mcp/*/*/mcp',
      'https://mcp.zapier.com/.well-known/oauth-protected-resource',
    ]);
  });

  it.each([
    ['/api/content-discovery/v1/mcp/', '/api/*/v1/mcp/'],
    ['/u/12345/mcp', '/*/*/mcp'],
    ['/mcp/AbCdEf', '/mcp/*'],
    ['/tenant_one/sse', '/*/sse'],
    // Lowercase, word-like secrets are never kept.
    ['/mcp/huntertwo', '/mcp/*'],
    ['/s/abcdefghijklmnopqrstuvwx/mcp', '/*/*/mcp'],
    ['/api/mcp/s/correct-horse-battery/sse', '/api/mcp/*/*/sse'],
    ['/MCP/Api', '/*/*'],
    [
      '/.well-known/oauth-protected-resource/api/v2/mcp',
      '/.well-known/oauth-protected-resource/api/v2/mcp',
    ],
  ])('shows the path %s as %s', (path, shape): void => {
    expect(resourceDiagnosticUrl(`https://mcp.example.com${path}?k=v`)).toBe(
      `https://mcp.example.com${shape}`,
    );
  });
});

describe('a 429 carrying an OAuth error code', () => {
  const redirectUri =
    'https://canopy.ud-staging.com/api/mcp-connections/callback';

  it.each(['invalid_grant', 'invalid_client', 'unauthorized_client'])(
    'keeps a token request rate-limited with %s transient',
    async (error): Promise<void> => {
      await expect(
        refreshAccessToken({
          clientId: 'client',
          tokenEndpointAuthMethod: 'none',
          tokenEndpoint: 'https://auth.example.com/token',
          resource: 'https://mcp.example.com/mcp',
          refreshToken: 'refresh',
          fetch: async (): Promise<Response> =>
            Promise.resolve(Response.json({ error }, { status: 429 })),
        }),
      ).rejects.toMatchObject({
        code: 'transient',
        requiresReauthorization: false,
        attempt: { outcome: 'unavailable', status: 429, error },
      });
    },
  );

  it.each(['invalid_client', 'invalid_redirect_uri', 'access_denied'])(
    'keeps a registration rate-limited with %s transient',
    async (error): Promise<void> => {
      await expect(
        registerDynamicClient({
          registrationEndpoint: 'https://auth.example.com/register',
          redirectUri,
          clientName: 'Canopy',
          fetch: async (): Promise<Response> =>
            Promise.resolve(Response.json({ error }, { status: 429 })),
        }),
      ).rejects.toMatchObject({ code: 'transient' });
    },
  );
});

describe('one request budget for a sign-in', () => {
  afterEach((): void => {
    jest.useRealTimers();
  });

  it('refuses requests past its count', async (): Promise<void> => {
    const fetch = routes({});
    const budget = createOAuthRequestBudget(fetch, {
      timeoutMs: 60_000,
      maxRequests: 2,
    });
    try {
      await budget.fetch('https://a.example.com/1');
      await budget.fetch('https://a.example.com/2');
      await expect(budget.fetch('https://a.example.com/3')).rejects.toThrow(
        'OAuth request budget exhausted',
      );
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      budget.dispose();
    }
  });

  it('aborts a request in flight at its deadline, keeping the request’s own signal', async (): Promise<void> => {
    jest.useFakeTimers();
    const signals: AbortSignal[] = [];
    const hanging: OAuthFetch = async (_url, init): Promise<Response> =>
      new Promise((_resolve, reject): void => {
        const signal = init?.signal;
        if (!signal) throw new Error('Expected a signal');
        signals.push(signal);
        signal.addEventListener('abort', (): void => {
          reject(new Error('aborted'));
        });
      });
    const budget = createOAuthRequestBudget(hanging, {
      timeoutMs: 1_000,
      maxRequests: 10,
    });
    const own = new AbortController();
    try {
      const first = budget.fetch('https://a.example.com/1', {
        signal: own.signal,
      });
      jest.advanceTimersByTime(1_000);
      await expect(first).rejects.toThrow('aborted');
      await expect(budget.fetch('https://a.example.com/2')).rejects.toThrow(
        'OAuth request budget exhausted',
      );
      expect(signals).toHaveLength(1);
      const second = createOAuthRequestBudget(hanging, {
        timeoutMs: 1_000,
        maxRequests: 10,
      });
      const pending = second.fetch('https://a.example.com/3', {
        signal: own.signal,
      });
      own.abort();
      await expect(pending).rejects.toThrow('aborted');
      second.dispose();
    } finally {
      budget.dispose();
    }
  });

  it('a disposed budget leaves no timer behind', (): void => {
    jest.useFakeTimers();
    const budget = createOAuthRequestBudget(routes({}), {
      timeoutMs: 1_000,
      maxRequests: 1,
    });
    budget.dispose();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('provider error text that could stall a sign-in', () => {
  const redirectUri =
    'https://canopy.ud-staging.com/api/mcp-connections/callback';
  const refuse =
    (body: string): OAuthFetch =>
    async (): Promise<Response> =>
      Promise.resolve(
        new Response(body, {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
  const register = (fetch: OAuthFetch): Promise<unknown> =>
    registerDynamicClient({
      registrationEndpoint: 'https://auth.example.com/register',
      redirectUri,
      clientName: 'Canopy',
      fetch,
    });

  it('reads a long URL-shaped description in linear time', async (): Promise<void> => {
    // `http://` repeated with no whitespace, `?` or `#` backtracks
    // quadratically in a regex; this one fits the error-body cap.
    const description = 'http://'.repeat(2_000);
    const started = performance.now();
    const failure = register(
      refuse(
        JSON.stringify({
          error: 'invalid_client_metadata',
          error_description: description,
        }),
      ),
    );
    await expect(failure).rejects.toMatchObject({
      code: 'registration_unavailable',
    });
    expect(performance.now() - started).toBeLessThan(250);
    await failure.catch((thrown: unknown): void => {
      if (!(thrown instanceof OAuthError)) throw thrown;
      expect(thrown.attempt?.errorDescription?.length).toBeLessThanOrEqual(300);
    });
  });

  it('never parses an error body past its cap', async (): Promise<void> => {
    const huge = JSON.stringify({
      error: 'invalid_client_metadata',
      error_description: 'http://'.repeat(40_000),
    });
    const started = performance.now();
    const failure = register(refuse(huge));
    await expect(failure).rejects.toMatchObject({
      code: 'registration_unavailable',
      attempt: { status: 400 },
    });
    expect(performance.now() - started).toBeLessThan(250);
    await failure.catch((thrown: unknown): void => {
      if (!(thrown instanceof OAuthError)) throw thrown;
      expect(thrown.attempt).not.toHaveProperty('errorDescription');
      expect(thrown.attempt).not.toHaveProperty('error');
    });
  });

  it('still strips the query and fragment of each URL in a description', async (): Promise<void> => {
    await expect(
      register(
        refuse(
          JSON.stringify({
            error: 'invalid_client_metadata',
            error_description:
              'See HTTPS://a.example/x?t=1 and http://b.example/y#f, http:// plain',
          }),
        ),
      ),
    ).rejects.toMatchObject({
      attempt: {
        errorDescription:
          'See HTTPS://a.example/x and http://b.example/y http:// plain',
      },
    });
  });
});

describe('a confidential registration that names no method', () => {
  const redirectUri =
    'https://canopy.ud-staging.com/api/mcp-connections/callback';
  const answer =
    (payload: unknown): OAuthFetch =>
    async (): Promise<Response> =>
      Promise.resolve(Response.json(payload, { status: 201 }));

  it.each(['client_secret_basic', 'client_secret_post'] as const)(
    'keeps the requested %s when the response issues a secret',
    async (method): Promise<void> => {
      await expect(
        registerDynamicClient({
          registrationEndpoint: 'https://auth.example.com/register',
          redirectUri,
          clientName: 'Canopy',
          tokenEndpointAuthMethod: method,
          fetch: answer({ client_id: 'c', client_secret: 's' }),
        }),
      ).resolves.toEqual({
        clientId: 'c',
        clientSecret: 's',
        clientSecretExpiresAt: undefined,
        tokenEndpointAuthMethod: method,
      });
    },
  );

  it('refuses the method when no secret was issued, so the next can be tried', async (): Promise<void> => {
    await expect(
      registerDynamicClient({
        registrationEndpoint: 'https://auth.example.com/register',
        redirectUri,
        clientName: 'Canopy',
        tokenEndpointAuthMethod: 'client_secret_basic',
        fetch: answer({ client_id: 'c' }),
      }),
    ).rejects.toMatchObject({
      code: 'registration_unavailable',
      attempt: {
        stage: 'registration',
        outcome: 'unusable',
        reason: 'missing_client_secret',
      },
    });
  });
});
