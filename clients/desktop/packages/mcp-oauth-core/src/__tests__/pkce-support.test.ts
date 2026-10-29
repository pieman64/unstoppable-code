import { parseAuthorizationServerMetadata, supportsPkceS256 } from '../index';

const issuer = 'https://auth.example.com';
const metadata = {
  issuer,
  authorization_endpoint: 'https://auth.example.com/authorize',
  token_endpoint: 'https://auth.example.com/token',
};

describe('PKCE support', () => {
  it.each<[string, unknown, boolean]>([
    ['lists S256', ['S256'], true],
    ['lists plain and S256', ['plain', 'S256'], true],
    ['lists only plain', ['plain'], false],
    ['lists nothing', [], false],
    // Strava, Lorikeet, Paytm and Cognito's OpenID document omit it.
    ['omits the list', undefined, false],
    ['sends a string instead of a list', 'S256', false],
  ])(
    'reads a server that %s',
    (_label, codeChallengeMethods, expected): void => {
      const parsed = parseAuthorizationServerMetadata(
        { ...metadata, code_challenge_methods_supported: codeChallengeMethods },
        issuer,
      );
      if (!parsed) throw new Error('metadata did not parse');
      expect(supportsPkceS256(parsed)).toBe(expected);
    },
  );
});
