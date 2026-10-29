/**
 * Failure codes every hosted settings transport reports. Hosts map transport
 * failures onto these; shared UI maps them onto copy and recovery actions.
 *
 * - `unauthenticated`: no signed-in account, or the account is a guest.
 * - `expired`: the hosted session ended or no longer matches the account.
 * - `forbidden`: the viewer lost access to the organization or resource.
 * - `not_found`: the requested detail does not exist.
 * - `offline`: the server could not be reached.
 * - `unsupported_server`: the server predates the settings endpoints.
 * - `invalid_response`: the server answered with malformed data.
 * - `uncertain`: a mutation may or may not have applied; never replayed.
 * - `failed`: any other failure, including server-specific rejections.
 */
export const SETTINGS_ERROR_CODES = [
  'unauthenticated',
  'expired',
  'forbidden',
  'not_found',
  'offline',
  'unsupported_server',
  'invalid_response',
  'uncertain',
  'failed',
] as const;

export type SettingsErrorCode = (typeof SETTINGS_ERROR_CODES)[number];

export function isSettingsErrorCode(
  value: unknown,
): value is SettingsErrorCode {
  return SETTINGS_ERROR_CODES.some((code) => code === value);
}

/** Portable error description that crosses IPC as plain data. */
export interface SettingsErrorPayload {
  code: SettingsErrorCode;
  /** Server-provided message, when the server supplied a user-facing one. */
  message?: string;
  /** HTTP status the server returned, when there was a response. */
  status?: number;
  /** Server-specific machine code (for example `last_owner`). */
  serverCode?: string;
}

/** Error thrown by every {@link SettingsErrorPayload}-reporting client. */
export class SettingsOperationError extends Error {
  readonly code: SettingsErrorCode;
  readonly status: number | undefined;
  readonly serverCode: string | undefined;

  constructor(payload: SettingsErrorPayload) {
    super(payload.message ?? payload.code);
    this.name = 'SettingsOperationError';
    this.code = payload.code;
    this.status = payload.status;
    this.serverCode = payload.serverCode;
  }

  toPayload(): SettingsErrorPayload {
    return {
      code: this.code,
      ...(this.message !== this.code ? { message: this.message } : {}),
      ...(this.status !== undefined ? { status: this.status } : {}),
      ...(this.serverCode !== undefined ? { serverCode: this.serverCode } : {}),
    };
  }
}

/**
 * Map an HTTP status onto a code. `uncertain` applies only to writes whose
 * outcome is unknown (a dropped connection or a 5xx after sending), so the
 * caller passes whether the request was a write. For an entry with
 * `rejectedCredentialOn401`, a 401 is an ordinary `failed`.
 */
export function settingsErrorCodeForStatus(
  status: number,
  options: {
    write: boolean;
    sessionReady?: boolean;
    rejectedCredentialOn401?: boolean;
  },
): SettingsErrorCode {
  if (status === 401) {
    if (options.rejectedCredentialOn401 === true) return 'failed';
    return options.sessionReady ? 'expired' : 'unauthenticated';
  }
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status >= 500) return options.write ? 'uncertain' : 'failed';
  return 'failed';
}
