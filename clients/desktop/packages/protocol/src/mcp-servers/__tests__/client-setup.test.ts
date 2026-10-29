import { parseAccountMcpClientSetup } from '../index';

const setup = {
  redirectUri:
    'https://app.example.com/api/mcp-connections/callback/issuer-key',
  issuer: 'https://accounts.example.com',
  clientSecretRequired: false,
  clientSecretAccepted: false,
};

describe('parseAccountMcpClientSetup', () => {
  it('reads a client setup with and without vendor docs', (): void => {
    expect(parseAccountMcpClientSetup(setup)).toEqual(setup);
    expect(
      parseAccountMcpClientSetup({
        ...setup,
        docsUrl: 'https://developer.example.com/apps',
        extra: 'ignored',
      }),
    ).toEqual({ ...setup, docsUrl: 'https://developer.example.com/apps' });
  });
  it('reads whether registration was refused, ignoring a malformed flag', (): void => {
    expect(
      parseAccountMcpClientSetup({ ...setup, registrationRefused: true }),
    ).toEqual({ ...setup, registrationRefused: true });
    expect(
      parseAccountMcpClientSetup({ ...setup, registrationRefused: false }),
    ).toEqual({ ...setup, registrationRefused: false });
    expect(
      parseAccountMcpClientSetup({ ...setup, registrationRefused: 'yes' }),
    ).toEqual(setup);
  });
  it.each<[string, unknown]>([
    ['a missing body', undefined],
    ['an array', [setup]],
    ['a non-URL redirect', { ...setup, redirectUri: 'not a url' }],
    ['a script redirect', { ...setup, redirectUri: 'javascript:alert(1)' }],
    ['a missing issuer', { ...setup, issuer: undefined }],
    ['a script docs link', { ...setup, docsUrl: 'javascript:alert(1)' }],
    ['a non-boolean secret flag', { ...setup, clientSecretRequired: 'no' }],
    ['a missing accepted flag', { ...setup, clientSecretAccepted: undefined }],
  ])('refuses %s', (_label, value): void => {
    expect(parseAccountMcpClientSetup(value)).toBeNull();
  });
});
