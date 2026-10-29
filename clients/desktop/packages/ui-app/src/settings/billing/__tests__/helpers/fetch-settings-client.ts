import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import {
  SettingsOperationError,
  settingsErrorCodeForStatus,
  settingsOperationRequest,
  validateSettingsOperationInput,
  validateSettingsOperationResult,
  type SettingsOperationName,
} from '@canopy/protocol/settings';

/**
 * A settings client for billing tests that executes each fixed table entry
 * against the global `fetch`, so a suite's `fetch` stub answers the same
 * `/api/...` paths and bodies the browser sends. Inputs and results are
 * validated against the table exactly as a real host does; a non-2xx answer
 * rejects with a `SettingsOperationError` carrying the status, the `{ error }`
 * message and the `code`.
 *
 * Lenient about the response shape (`ok`, `status`, `json()`), matching the
 * minimal stubs the billing suites install.
 */
export function createFetchSettingsClient(): AccountOrganizationSettingsClient {
  const run = async (
    operation: SettingsOperationName,
    input: unknown,
    write: boolean,
  ): Promise<never> => {
    const validated = validateSettingsOperationInput(operation, input);
    if (!validated.ok)
      throw new SettingsOperationError({
        code: 'failed',
        message: `Invalid input for ${operation}`,
      });
    const request = settingsOperationRequest(operation, validated.input);
    const withBody =
      request.body !== undefined &&
      request.method !== 'GET' &&
      request.method !== 'DELETE';
    const response = await fetch(request.path, {
      method: request.method,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(withBody ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(withBody ? { body: JSON.stringify(request.body) } : {}),
    });
    let body: unknown = null;
    try {
      const parsed: unknown = await response.json();
      body = parsed;
    } catch {
      body = null;
    }
    if (!response.ok) {
      const status =
        typeof response.status === 'number' ? response.status : 500;
      const record: object =
        typeof body === 'object' && body !== null ? body : {};
      const message: unknown = Reflect.get(record, 'error');
      const serverCode: unknown = Reflect.get(record, 'code');
      throw new SettingsOperationError({
        code: settingsErrorCodeForStatus(status, { write }),
        status,
        ...(typeof message === 'string' ? { message } : {}),
        ...(typeof serverCode === 'string' ? { serverCode } : {}),
      });
    }
    const result = validateSettingsOperationResult(operation, body);
    if (!result.ok)
      throw new SettingsOperationError({ code: 'invalid_response' });
    // The table validated the result for this entry; the client contract
    // types it per operation.
    return result.result as never;
  };
  return {
    read: (operation, input) => run(operation, input, false),
    write: (operation, input) => run(operation, input, true),
    subscribe: () => () => undefined,
  };
}
