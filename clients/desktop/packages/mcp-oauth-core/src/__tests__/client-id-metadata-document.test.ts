import {
  buildClientIdMetadataDocument,
  isClientIdMetadataDocumentUrl,
  parseAuthorizationServerMetadata,
  supportsClientIdMetadataDocument,
} from '../index';

// A server that registers no clients itself but takes public clients and
// Client ID Metadata Documents, and sends RFC 9207 `iss`, as ElevenLabs and
// TomTom do.
const issuer = 'https://auth.example.com';
const metadata = {
  issuer,
  authorization_response_iss_parameter_supported: true,
  authorization_endpoint: 'https://auth.example.com/authorize',
  token_endpoint: 'https://auth.example.com/token',
  token_endpoint_auth_methods_supported: ['none'],
  code_challenge_methods_supported: ['S256'],
  client_id_metadata_document_supported: true,
};

describe('Client ID Metadata Document support', () => {
  it('reads the advertisement from authorization server metadata', (): void => {
    expect(parseAuthorizationServerMetadata(metadata, issuer)).toMatchObject({
      clientIdMetadataDocumentSupported: true,
    });
    const plain = {
      ...metadata,
      client_id_metadata_document_supported: undefined,
    };
    expect(parseAuthorizationServerMetadata(plain, issuer)).toMatchObject({
      clientIdMetadataDocumentSupported: false,
    });
    expect(
      parseAuthorizationServerMetadata(
        { ...plain, client_id_metadata_document_supported: 'true' },
        issuer,
      ),
    ).toMatchObject({ clientIdMetadataDocumentSupported: false });
  });

  it.each<[string, string[] | undefined, boolean]>([
    ['lists none', ['client_secret_basic', 'none'], true],
    ['omits its methods', undefined, true],
    // Cloze takes metadata document clients that sign their token requests.
    [
      'takes only signed or secret clients',
      ['private_key_jwt', 'client_secret_basic'],
      false,
    ],
  ])(
    'prefers the document for an RFC 9207 server that advertises it and %s',
    (_label, methods, expected): void => {
      expect(
        supportsClientIdMetadataDocument({
          clientIdMetadataDocumentSupported: true,
          authorizationResponseIssParameterSupported: true,
          ...(methods ? { tokenEndpointAuthMethodsSupported: methods } : {}),
        }),
      ).toBe(expected);
    },
  );

  it('registers instead with a server that does not advertise it', (): void => {
    expect(
      supportsClientIdMetadataDocument({
        clientIdMetadataDocumentSupported: false,
        authorizationResponseIssParameterSupported: true,
        tokenEndpointAuthMethodsSupported: ['none'],
      }),
    ).toBe(false);
  });

  // Every document server sees the same client ID and callback, so without
  // `iss` a relayed response could not be told from the server's own.
  it('registers instead with a server that sends no RFC 9207 iss (Canva, Affinity)', (): void => {
    expect(
      supportsClientIdMetadataDocument({
        clientIdMetadataDocumentSupported: true,
        authorizationResponseIssParameterSupported: false,
        tokenEndpointAuthMethodsSupported: ['none'],
      }),
    ).toBe(false);
  });

  it.each([
    'https://app.unstoppable.ai/api/mcp-connections/client-metadata/unstoppable-code',
    'https://canopy.ud-staging.com/api/mcp-connections/client-metadata/canopy/desktop',
  ])('accepts %s as a client ID', (url): void => {
    expect(isClientIdMetadataDocumentUrl(url)).toBe(true);
  });

  it.each([
    ['plain HTTP', 'http://app.unstoppable.ai/client'],
    ['a loopback host', 'https://localhost/client'],
    ['a private address', 'https://10.0.0.1/client'],
    ['no path', 'https://app.unstoppable.ai/'],
    ['a query', 'https://app.unstoppable.ai/client?v=1'],
    ['an empty query', 'https://app.unstoppable.ai/client?'],
    ['a fragment', 'https://app.unstoppable.ai/client#a'],
    ['credentials', 'https://user:pass@app.unstoppable.ai/client'],
    ['dot segments', 'https://app.unstoppable.ai/a/../client'],
    ['a default port', 'https://app.unstoppable.ai:443/client'],
    ['an uppercase host', 'https://App.Unstoppable.ai/client'],
  ])('refuses a client ID with %s', (_label, url): void => {
    expect(isClientIdMetadataDocumentUrl(url)).toBe(false);
  });

  it('builds a public client document that names its own URL', (): void => {
    expect(
      buildClientIdMetadataDocument({
        clientId:
          'https://app.unstoppable.ai/api/mcp-connections/client-metadata/unstoppable-code',
        clientName: 'Unstoppable Code',
        clientUri: 'https://app.unstoppable.ai/',
        redirectUris: [
          'https://app.unstoppable.ai/api/mcp-connections/callback',
        ],
      }),
    ).toEqual({
      client_id:
        'https://app.unstoppable.ai/api/mcp-connections/client-metadata/unstoppable-code',
      client_name: 'Unstoppable Code',
      client_uri: 'https://app.unstoppable.ai/',
      redirect_uris: [
        'https://app.unstoppable.ai/api/mcp-connections/callback',
      ],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });
});
