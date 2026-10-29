import { copilotAccountFromStatus, sameCopilotAccount } from '../auth';

test.each(['env', 'gh-cli', 'hmac', 'api-key', 'token'] as const)(
  'does not bill ambient %s authentication',
  (authType) => {
    expect(
      copilotAccountFromStatus({
        isAuthenticated: true,
        authType,
        host: 'https://github.com',
        login: 'alice',
      }),
    ).toBeNull();
  },
);
test('normalizes and binds the official account without accepting a changed identity', () => {
  const account = copilotAccountFromStatus({
    isAuthenticated: true,
    authType: 'user',
    host: 'https://github.com/',
    login: 'alice',
  });
  expect(account).toEqual({ host: 'https://github.com', login: 'alice' });
  expect(
    sameCopilotAccount(account, { host: 'https://github.com', login: 'bob' }),
  ).toBe(false);
  expect(sameCopilotAccount(account, account ?? undefined)).toBe(true);
});
test.each([
  'http://github.com',
  'https://github.com.attacker.invalid',
  'https://github.com/private',
  'https://user:password@github.com',
])('rejects unexpected account host %s', (host) => {
  expect(
    copilotAccountFromStatus({
      isAuthenticated: true,
      authType: 'user',
      host,
      login: 'alice',
    }),
  ).toBeNull();
});
