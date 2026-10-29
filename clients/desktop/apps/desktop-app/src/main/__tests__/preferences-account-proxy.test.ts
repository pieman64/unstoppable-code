import { normalizePreferences } from '../lib/preferences-store';

describe('normalizePreferences — account proxy (CAN-4019)', () => {
  test('is opt-in and keeps a chat on one account by default', () => {
    const normalized = normalizePreferences({});
    expect(normalized.accountProxyEnabled).toBe(false);
    expect(normalized.accountProxyConnection).toBeNull();
    expect(normalized.accountProxyKeepChatOnOneAccount).toBe(true);
    expect(
      normalizePreferences({ accountProxyKeepChatOnOneAccount: false })
        .accountProxyKeepChatOnOneAccount,
    ).toBe(false);
  });

  test('keeps a valid connection with its URL normalized', () => {
    expect(
      normalizePreferences({
        accountProxyConnection: {
          id: '6f1c7a52-6a41-4e2b-9d0e-2b6f3f0a9c11',
          kind: 'server',
          url: 'https://proxy.example.com/',
        },
      }).accountProxyConnection,
    ).toEqual({
      id: '6f1c7a52-6a41-4e2b-9d0e-2b6f3f0a9c11',
      kind: 'server',
      url: 'https://proxy.example.com',
    });
  });

  test('drops malformed or insecure connections', () => {
    for (const value of [
      { id: 'short', kind: 'server', url: 'https://proxy.example.com' },
      {
        id: '6f1c7a52-6a41-4e2b-9d0e-2b6f3f0a9c11',
        kind: 'cloud',
        url: 'https://proxy.example.com',
      },
      {
        id: '6f1c7a52-6a41-4e2b-9d0e-2b6f3f0a9c11',
        kind: 'server',
        url: 'http://proxy.example.com',
      },
      'https://proxy.example.com',
    ]) {
      const raw: Record<string, unknown> = { accountProxyConnection: value };
      expect(normalizePreferences(raw).accountProxyConnection).toBeNull();
    }
  });

  test('keeps only a known account order for the proxy on this device', () => {
    expect(
      normalizePreferences({ accountProxyLocalRoutingStrategy: 'fill-first' })
        .accountProxyLocalRoutingStrategy,
    ).toBe('fill-first');
    expect(normalizePreferences({})).not.toHaveProperty(
      'accountProxyLocalRoutingStrategy',
    );
    for (const value of ['ff', 'bogus', 3, null]) {
      const raw: Record<string, unknown> = {
        accountProxyLocalRoutingStrategy: value,
      };
      expect(normalizePreferences(raw)).not.toHaveProperty(
        'accountProxyLocalRoutingStrategy',
      );
    }
  });
});
