import {
  DEFAULT_INSTALL_UPDATE_EMAIL_PREFERENCE,
  parseAccountNotificationPreferences,
  parseAccountNotificationPreferencesPatch,
  parseInstallUpdateEmailPreference,
} from '..';

describe('account notification preference wire contract', () => {
  it('defaults install update emails to on', () => {
    expect(DEFAULT_INSTALL_UPDATE_EMAIL_PREFERENCE).toEqual({ enabled: true });
  });

  describe('parseInstallUpdateEmailPreference', () => {
    it('accepts a boolean enabled field', () => {
      expect(parseInstallUpdateEmailPreference({ enabled: false })).toEqual({
        enabled: false,
      });
    });

    it.each([
      ['missing field', {}],
      ['wrong type', { enabled: 'true' }],
      ['extra field', { enabled: true, extra: 1 }],
      ['null', null],
      ['array', [true]],
    ])('rejects %s without substituting a default', (_label, value) => {
      expect(parseInstallUpdateEmailPreference(value)).toBeNull();
    });
  });

  describe('parseAccountNotificationPreferences', () => {
    it('accepts both fields', () => {
      expect(
        parseAccountNotificationPreferences({
          pushEnabled: true,
          installUpdateEmailsEnabled: false,
        }),
      ).toEqual({ pushEnabled: true, installUpdateEmailsEnabled: false });
    });

    it.each([
      ['missing field', { pushEnabled: true }],
      ['wrong type', { pushEnabled: true, installUpdateEmailsEnabled: 1 }],
      [
        'extra field',
        { pushEnabled: true, installUpdateEmailsEnabled: true, other: true },
      ],
    ])('rejects %s', (_label, value) => {
      expect(parseAccountNotificationPreferences(value)).toBeNull();
    });
  });

  describe('parseAccountNotificationPreferencesPatch', () => {
    it('accepts a partial patch and keeps only present fields', () => {
      expect(
        parseAccountNotificationPreferencesPatch({
          installUpdateEmailsEnabled: false,
        }),
      ).toEqual({ installUpdateEmailsEnabled: false });
      expect(
        parseAccountNotificationPreferencesPatch({ pushEnabled: true }),
      ).toEqual({ pushEnabled: true });
    });

    it.each([
      ['empty', {}],
      ['wrong type', { pushEnabled: 'yes' }],
      ['extra field', { pushEnabled: true, digest: true }],
      ['non-object', 'pushEnabled'],
    ])('rejects %s', (_label, value) => {
      expect(parseAccountNotificationPreferencesPatch(value)).toBeNull();
    });
  });
});
