import {
  MCP_CONNECT_FAILED_MESSAGE,
  mcpClientSetupCollectsClient,
  mcpClientSetupExplanation,
  mcpConnectErrorCodeTitle,
  mcpConnectErrorMessage,
  mcpSignInUnavailableMessage,
} from '../mcp-connect-errors';

// Every code the broker's start, callback, and OAuth paths can report, plus
// the client's own network failure.
const CODES = [
  'network_error',
  'not_found',
  'server_not_found',
  'invalid_token',
  'invalid_oauth_client',
  'invalid_headers',
  'unsupported_provider',
  'desktop_only',
  'unsupported_configuration',
  'configuration_required',
  'client_credentials_required',
  'sign_in_unavailable',
  'registration_unavailable',
  'authorization_server_unavailable',
  'invalid_url',
  'endpoint_required',
  'connection_limit_reached',
  'untrusted_authorization_server',
  'oauth_unavailable',
  'discovery_failed',
  'unsupported_redirect',
  'unsupported_pkce',
  'connection_busy',
  'mcp_extra_headers_unavailable',
  'transient',
  'invalid_metadata',
  'invalid_client',
  'unauthorized_client',
  'invalid_grant',
  'invalid_state',
  'invalid_callback',
  'account_mismatch',
  'issuer_mismatch',
  'access_denied',
  'oauth_error',
  'callback_failed',
];

describe('mcpConnectErrorMessage', () => {
  it.each(CODES)('names %s in plain words without the code', (code): void => {
    const message = mcpConnectErrorMessage(code);
    expect(message).not.toBe(MCP_CONNECT_FAILED_MESSAGE);
    expect(message).not.toContain(code);
    expect(message).not.toContain('(');
    expect(message).not.toMatch(/—/);
    expect(message).toMatch(/\.$/);
  });
  it.each([null, undefined, '', 'connection_failed', 'invalid_request'])(
    'falls back for %p',
    (code): void => {
      expect(mcpConnectErrorMessage(code)).toBe(MCP_CONNECT_FAILED_MESSAGE);
    },
  );
  it('asks for an endpoint without sending the user to another app', (): void => {
    expect(mcpConnectErrorMessage('endpoint_required')).toBe(
      'Choose an endpoint for this server, then sign in again.',
    );
  });
  it('says the account can’t sign in to a server that takes approved apps only', (): void => {
    // A client that doesn't know whether a desktop can sign in reads this.
    expect(mcpConnectErrorMessage('sign_in_unavailable')).toBe(
      "This server only lets approved apps sign in, so your account can't connect it yet.",
    );
  });
  it('keeps the code in a tooltip', (): void => {
    expect(mcpConnectErrorCodeTitle('invalid_state')).toBe(
      'Error code: invalid_state',
    );
    expect(mcpConnectErrorCodeTitle(null)).toBeUndefined();
  });
});

describe('mcpClientSetupExplanation', () => {
  it.each<[boolean, boolean, string, boolean]>([
    [
      false,
      false,
      'Spotify doesn’t let apps register themselves. Create an app in Spotify’s developer dashboard with this redirect URI, then paste its client ID.',
      true,
    ],
    [
      false,
      true,
      'Spotify doesn’t let apps register themselves. Create an app in Spotify’s developer dashboard with this redirect URI, then paste its client ID.',
      true,
    ],
    [
      true,
      true,
      'Spotify doesn’t let apps register themselves. Create an app in Spotify’s developer dashboard with this redirect URI, then paste its client ID and client secret.',
      true,
    ],
    [
      true,
      false,
      'Spotify needs its own app with a client secret, which your account can’t store for this server. Connect with an access token instead.',
      false,
    ],
  ])(
    'explains a setup (secret required %p, accepted %p)',
    (clientSecretRequired, clientSecretAccepted, text, collects): void => {
      const setup = { clientSecretRequired, clientSecretAccepted };
      expect(mcpClientSetupExplanation('Spotify', setup)).toBe(text);
      expect(mcpClientSetupCollectsClient(setup)).toBe(collects);
    },
  );
});

describe('mcpSignInUnavailableMessage', () => {
  it.each<[boolean, 'web' | 'desktop', string]>([
    [true, 'web', 'Connect this server from the desktop app.'],
    [
      true,
      'desktop',
      "Your account can't sign in to this server. Add it to this device instead.",
    ],
    [
      false,
      'web',
      "This server only lets approved apps sign in, so your account can't connect it yet.",
    ],
    [
      false,
      'desktop',
      "This server only lets approved apps sign in, so your account can't connect it yet.",
    ],
  ])(
    'words desktopSignIn %p on the %s app in plain words',
    (desktopSignIn, surface, text): void => {
      const message = mcpSignInUnavailableMessage(desktopSignIn, surface);
      expect(message).toBe(text);
      expect(message).not.toContain('sign_in_unavailable');
      expect(message).not.toContain('client ID');
      expect(message).not.toMatch(/—/);
    },
  );
});

describe('mcpClientSetupExplanation for a server that refused registration', () => {
  it.each<[boolean, string]>([
    [
      false,
      'Acme only lets approved apps sign in. Register an app with Acme using this redirect URI, then paste its client ID.',
    ],
    [
      true,
      'Acme only lets approved apps sign in. Register an app with Acme using this redirect URI, then paste its client ID and client secret.',
    ],
  ])(
    'explains it takes approved apps only (secret required %p)',
    (clientSecretRequired, text): void => {
      expect(
        mcpClientSetupExplanation('Acme', {
          clientSecretRequired,
          clientSecretAccepted: true,
          registrationRefused: true,
        }),
      ).toBe(text);
    },
  );
  it('keeps the access token explanation when the secret can’t be stored', (): void => {
    expect(
      mcpClientSetupExplanation('Acme', {
        clientSecretRequired: true,
        clientSecretAccepted: false,
        registrationRefused: true,
      }),
    ).toBe(
      'Acme needs its own app with a client secret, which your account can’t store for this server. Connect with an access token instead.',
    );
  });
});
