import { normalizePreferences } from '../lib/preferences-store';

describe('normalizePreferences — native provider accounts (CAN-4200)', () => {
  test('omits the field when absent or malformed', () => {
    expect(normalizePreferences({}).nativeProviderAccounts).toBeUndefined();
    expect(
      normalizePreferences({ nativeProviderAccounts: 'nope' })
        .nativeProviderAccounts,
    ).toBeUndefined();
  });

  test('round-trips billed provider records and drops everything else', () => {
    expect(
      normalizePreferences({
        nativeProviderAccounts: {
          claude: { accountKey: 'a@example.com', changedAt: 123 },
          codex: { accountKey: ' b@example.com ' },
          ollama: { accountKey: 'c@example.com' },
        },
      }).nativeProviderAccounts,
    ).toEqual({
      claude: { accountKey: 'a@example.com', changedAt: 123 },
      codex: { accountKey: 'b@example.com' },
    });
  });

  test('drops empty keys and invalid change times', () => {
    expect(
      normalizePreferences({
        nativeProviderAccounts: {
          claude: { accountKey: '  ', changedAt: 5 },
          codex: { accountKey: 'b@example.com', changedAt: Number.NaN },
        },
      }).nativeProviderAccounts,
    ).toEqual({ codex: { accountKey: 'b@example.com' } });
  });
  test('preserves the account-bound subscription recovery watermark only when valid', () => {
    expect(
      normalizePreferences({
        nativeProviderAccounts: {
          claude: { accountKey: 'a@example.com', subscriptionRestoredAt: 123 },
          codex: {
            accountKey: 'b@example.com',
            subscriptionRestoredAt: Number.NaN,
          },
        },
      }).nativeProviderAccounts,
    ).toEqual({
      claude: { accountKey: 'a@example.com', subscriptionRestoredAt: 123 },
      codex: { accountKey: 'b@example.com' },
    });
  });
});
