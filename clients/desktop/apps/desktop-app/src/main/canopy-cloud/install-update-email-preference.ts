import {
  parseAccountNotificationPreferences,
  type AccountNotificationPreferences,
  type AccountNotificationPreferencesPatch,
  type InstallUpdateEmailPreference,
} from '@canopy/protocol/account-notifications';
import { CanopyCloudClientError, requestCanopyCloudJson } from './client';

const NOTIFICATION_PREFERENCES_PATH =
  '/api/v1/account/notification-preferences';

/**
 * Why the preference could not be read or written.
 *
 * - `unavailable`: the surface does not exist for this account (no cloud
 *   account, a guest, a credential the server refuses, or a server that
 *   predates the route).
 * - `unresolved`: something went wrong (offline, 5xx, 429, a malformed body).
 *
 * Either way the caller has no real value and must not persist a default.
 */
export type InstallUpdateEmailPreferenceFailure = 'unavailable' | 'unresolved';

export class InstallUpdateEmailPreferenceError extends Error {
  readonly reason: InstallUpdateEmailPreferenceFailure;

  constructor(reason: InstallUpdateEmailPreferenceFailure) {
    super(
      reason === 'unavailable'
        ? 'Install update emails are unavailable for this account.'
        : 'Could not load the install update email preference.',
    );
    this.name = 'InstallUpdateEmailPreferenceError';
    this.reason = reason;
  }
}

/**
 * Same classification as `digest-preferences.ts`: no account at all (raised
 * before any request), a 404, and 401/403 mean the surface is unavailable.
 * Every other failure is transient.
 */
function errorFor(error: unknown): InstallUpdateEmailPreferenceError {
  if (error instanceof InstallUpdateEmailPreferenceError) return error;
  if (error instanceof CanopyCloudClientError) {
    if (
      error.code === 'cloud-not-configured' ||
      error.code === 'missing-api-key' ||
      error.status === 404 ||
      error.status === 401 ||
      error.status === 403
    ) {
      return new InstallUpdateEmailPreferenceError('unavailable');
    }
  }
  return new InstallUpdateEmailPreferenceError('unresolved');
}

/**
 * A partial or renamed body is an error, never a default: showing a toggle
 * the user did not choose would let the next click persist it.
 */
function toPreference(value: unknown): InstallUpdateEmailPreference {
  const parsed: AccountNotificationPreferences | null =
    parseAccountNotificationPreferences(value);
  if (parsed === null) {
    throw new InstallUpdateEmailPreferenceError('unresolved');
  }
  return { enabled: parsed.installUpdateEmailsEnabled };
}

/**
 * Read the connected account's "Updates to things I've installed" email
 * preference. Uncached, like the digest preferences, because the user can
 * change it from the web at any time. Rejects with
 * {@link InstallUpdateEmailPreferenceError}.
 */
export async function loadInstallUpdateEmailPreference(): Promise<InstallUpdateEmailPreference> {
  try {
    return toPreference(
      await requestCanopyCloudJson<unknown>(NOTIFICATION_PREFERENCES_PATH),
    );
  } catch (error) {
    throw errorFor(error);
  }
}

/**
 * Write the preference with a partial PATCH that leaves the other account
 * notification preferences alone, and adopt the value the server returns.
 * Rejects with {@link InstallUpdateEmailPreferenceError}.
 */
export async function saveInstallUpdateEmailPreference(
  preference: InstallUpdateEmailPreference,
): Promise<InstallUpdateEmailPreference> {
  const patch: AccountNotificationPreferencesPatch = {
    installUpdateEmailsEnabled: preference.enabled,
  };
  try {
    return toPreference(
      await requestCanopyCloudJson<unknown>(NOTIFICATION_PREFERENCES_PATH, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    );
  } catch (error) {
    throw errorFor(error);
  }
}
