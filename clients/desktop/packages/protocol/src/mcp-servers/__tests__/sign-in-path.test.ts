import {
  ACCOUNT_MCP_SIGN_IN_PATH,
  accountMcpSignInPath,
  isAccountMcpSignInPath,
} from '../index';

describe('the account MCP sign-in path', () => {
  it('carries the flow state as its only query parameter', (): void => {
    const path = accountMcpSignInPath('a+b/c=');
    expect(path).toBe(`${ACCOUNT_MCP_SIGN_IN_PATH}?state=a%2Bb%2Fc%3D`);
    expect(
      new URL(path, 'https://cloud.example').searchParams.get('state'),
    ).toBe('a+b/c=');
    expect(isAccountMcpSignInPath(path)).toBe(true);
  });
  it.each([
    undefined,
    42,
    '',
    ACCOUNT_MCP_SIGN_IN_PATH,
    `${ACCOUNT_MCP_SIGN_IN_PATH}?state=`,
    `${ACCOUNT_MCP_SIGN_IN_PATH}?state=s&next=/x`,
    `${ACCOUNT_MCP_SIGN_IN_PATH}?state=s#frag`,
    `${ACCOUNT_MCP_SIGN_IN_PATH}/../../account?state=s`,
    `//evil.example${ACCOUNT_MCP_SIGN_IN_PATH}?state=s`,
    `https://evil.example${ACCOUNT_MCP_SIGN_IN_PATH}?state=s`,
    '/account/billing?state=s',
    `${ACCOUNT_MCP_SIGN_IN_PATH}?state=${'s'.repeat(1024)}`,
  ])('refuses %p', (value): void => {
    expect(isAccountMcpSignInPath(value)).toBe(false);
  });
});
