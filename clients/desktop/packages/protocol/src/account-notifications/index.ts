/**
 * Wire contract for account-level notification preferences that cross the
 * desktop/web boundary.
 *
 * Every parser here is strict: a missing, extra or wrong-typed field returns
 * `null`. A parser never substitutes a default, because a caller that saved a
 * substituted default would silently overwrite the user's real choice.
 */

/** The single "Updates to things I've installed" email preference. */
export interface InstallUpdateEmailPreference {
  enabled: boolean;
}

/** On by default, including for users who existed before the preference. */
export const DEFAULT_INSTALL_UPDATE_EMAIL_PREFERENCE: InstallUpdateEmailPreference =
  Object.freeze({ enabled: true });

/**
 * Account notification preferences served by
 * `/api/account/notification-preferences` and
 * `/api/v1/account/notification-preferences`.
 */
export interface AccountNotificationPreferences {
  pushEnabled: boolean;
  installUpdateEmailsEnabled: boolean;
}

/** A partial PATCH body. At least one field is present. */
export type AccountNotificationPreferencesPatch =
  Partial<AccountNotificationPreferences>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function parseInstallUpdateEmailPreference(
  value: unknown,
): InstallUpdateEmailPreference | null {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ['enabled'])) return null;
  if (typeof value.enabled !== 'boolean') return null;
  return { enabled: value.enabled };
}

const ACCOUNT_NOTIFICATION_PREFERENCE_KEYS = [
  'pushEnabled',
  'installUpdateEmailsEnabled',
] as const;

export function parseAccountNotificationPreferences(
  value: unknown,
): AccountNotificationPreferences | null {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ACCOUNT_NOTIFICATION_PREFERENCE_KEYS)
  ) {
    return null;
  }
  if (
    typeof value.pushEnabled !== 'boolean' ||
    typeof value.installUpdateEmailsEnabled !== 'boolean'
  ) {
    return null;
  }
  return {
    pushEnabled: value.pushEnabled,
    installUpdateEmailsEnabled: value.installUpdateEmailsEnabled,
  };
}

/**
 * Parse a partial PATCH body. Returns `null` for an empty object, an unknown
 * key, or a present field that is not a boolean.
 */
export function parseAccountNotificationPreferencesPatch(
  value: unknown,
): AccountNotificationPreferencesPatch | null {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ACCOUNT_NOTIFICATION_PREFERENCE_KEYS)
  ) {
    return null;
  }
  const patch: AccountNotificationPreferencesPatch = {};
  for (const key of ACCOUNT_NOTIFICATION_PREFERENCE_KEYS) {
    if (!(key in value)) continue;
    const field = value[key];
    if (typeof field !== 'boolean') return null;
    patch[key] = field;
  }
  return Object.keys(patch).length === 0 ? null : patch;
}
