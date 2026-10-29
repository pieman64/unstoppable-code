import {
  SettingsOperationError,
  settingsErrorCodeForStatus,
  validateSettingsOperationResult,
  type SettingsOperationName,
} from '@canopy/protocol/settings';
import type { FakeSettingsHandler } from '../../../__tests__/helpers/test-settings-host';

/**
 * Fake-client handlers that behave like a real settings transport: a body is
 * validated against the entry's result schema (rejecting with
 * `invalid_response`, as the web and desktop clients do), and a route
 * failure rejects with the status, `{ error }` message and `code` the route
 * answered with.
 */

/** Answer `operation` with `body`, validated by the table. */
export function respondWith(
  operation: SettingsOperationName,
  body: unknown,
): FakeSettingsHandler {
  return (): unknown => {
    const validation = validateSettingsOperationResult(operation, body);
    if (!validation.ok)
      throw new SettingsOperationError({ code: 'invalid_response' });
    return validation.result;
  };
}

/** Reject as a route that answered `status` with `{ error, code }`. */
export function failWith(
  status: number,
  body: { error?: string; code?: string } = {},
  options: { write?: boolean } = {},
): FakeSettingsHandler {
  return (): never => {
    throw new SettingsOperationError({
      code: settingsErrorCodeForStatus(status, {
        write: options.write === true,
      }),
      status,
      ...(body.error === undefined ? {} : { message: body.error }),
      ...(body.code === undefined ? {} : { serverCode: body.code }),
    });
  };
}

/** Reject as a request that never reached the server. */
export function failOffline(write = false): FakeSettingsHandler {
  return (): never => {
    throw new SettingsOperationError({ code: write ? 'uncertain' : 'offline' });
  };
}
