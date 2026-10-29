/** GitHub device flow for a GitHub App: client id only, never a secret. */
export interface DeviceFlowOptions {
  clientId: string;
  /** Overrides https://github.com. The caller gates this to E2E builds. */
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface DeviceFlowStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  intervalMs: number;
}

export interface DeviceFlowGrant {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

export type DeviceFlowOutcome =
  | { status: 'granted'; grant: DeviceFlowGrant }
  | { status: 'declined' }
  | { status: 'expired' };

/** GitHub refused the refresh token; the grant is gone and must be re-created. */
export class DeviceFlowRefreshRejectedError extends Error {
  constructor(code: string) {
    super(`GitHub rejected the Copilot refresh token (${code}).`);
    this.name = 'DeviceFlowRefreshRejectedError';
  }
}

const DEFAULT_BASE_URL = 'https://github.com';
const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** Consecutive poll failures tolerated before the sign-in is abandoned. */
const MAX_TRANSIENT_POLL_FAILURES = 3;

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(
        signal.reason instanceof Error ? signal.reason : new Error('Aborted'),
      );
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value)
    throw new Error(`GitHub device flow response is missing ${key}.`);
  return value;
}

function readSeconds(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new Error(`GitHub device flow response is missing ${key}.`);
  return value;
}

async function post(
  options: DeviceFlowOptions,
  path: string,
  body: Record<string, string>,
  signal: AbortSignal,
  rejection?: (status: number) => Error | undefined,
): Promise<Record<string, unknown>> {
  const doFetch = options.fetch ?? fetch;
  const response = await doFetch(
    `${options.baseUrl ?? DEFAULT_BASE_URL}${path}`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(body).toString(),
      signal,
    },
  );
  if (!response.ok) {
    const rejected = rejection?.(response.status);
    if (rejected) throw rejected;
    throw new Error(`GitHub device flow request failed (${response.status}).`);
  }
  const parsed: unknown = await response.json();
  if (!isRecord(parsed))
    throw new Error('GitHub device flow response was not an object.');
  return parsed;
}

function grantFrom(
  record: Record<string, unknown>,
  now: number,
): DeviceFlowGrant {
  return {
    accessToken: readString(record, 'access_token'),
    accessTokenExpiresAt: new Date(
      now + readSeconds(record, 'expires_in') * 1000,
    ).toISOString(),
    refreshToken: readString(record, 'refresh_token'),
    refreshTokenExpiresAt: new Date(
      now + readSeconds(record, 'refresh_token_expires_in') * 1000,
    ).toISOString(),
  };
}

export async function startDeviceFlow(
  options: DeviceFlowOptions,
  signal: AbortSignal,
): Promise<DeviceFlowStart> {
  const now = options.now ?? Date.now;
  const record = await post(
    options,
    '/login/device/code',
    { client_id: options.clientId },
    signal,
  );
  const started = now();
  return {
    deviceCode: readString(record, 'device_code'),
    userCode: readString(record, 'user_code'),
    verificationUri: readString(record, 'verification_uri'),
    expiresAt: new Date(
      started + readSeconds(record, 'expires_in') * 1000,
    ).toISOString(),
    intervalMs: readSeconds(record, 'interval') * 1000,
  };
}

export async function pollDeviceFlow(
  options: DeviceFlowOptions,
  start: DeviceFlowStart,
  signal: AbortSignal,
): Promise<DeviceFlowOutcome> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  let intervalMs = start.intervalMs;
  let transientFailures = 0;
  const expiresAt = Date.parse(start.expiresAt);
  for (;;) {
    if (now() >= expiresAt) return { status: 'expired' };
    await sleep(intervalMs, signal);
    let record: Record<string, unknown>;
    try {
      record = await post(
        options,
        '/login/oauth/access_token',
        {
          client_id: options.clientId,
          device_code: start.deviceCode,
          grant_type: DEVICE_CODE_GRANT,
        },
        signal,
      );
    } catch (error) {
      // The user may be approving in the browser right now; a blip in one
      // poll must not throw the sign-in away. Cancellation still wins.
      signal.throwIfAborted();
      transientFailures += 1;
      if (transientFailures > MAX_TRANSIENT_POLL_FAILURES) throw error;
      continue;
    }
    transientFailures = 0;
    signal.throwIfAborted();
    const error = record.error;
    if (typeof error !== 'string')
      return { status: 'granted', grant: grantFrom(record, now()) };
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      const next = record.interval;
      intervalMs =
        typeof next === 'number' && next > 0 ? next * 1000 : intervalMs + 5000;
      continue;
    }
    if (error === 'access_denied') return { status: 'declined' };
    if (error === 'expired_token') return { status: 'expired' };
    throw new Error(`GitHub device flow failed (${error}).`);
  }
}

export async function refreshDeviceGrant(
  options: DeviceFlowOptions,
  refreshToken: string,
  signal: AbortSignal,
): Promise<DeviceFlowGrant> {
  const now = options.now ?? Date.now;
  const record = await post(
    options,
    '/login/oauth/access_token',
    {
      client_id: options.clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    },
    signal,
    // Only 400/401 mean GitHub refused this grant. Throttling (403/429), a
    // proxy challenge (407), a timeout (408) or a server failure leave the
    // stored grant worth keeping.
    (status) =>
      status === 400 || status === 401
        ? new DeviceFlowRefreshRejectedError(String(status))
        : undefined,
  );
  const error = record.error;
  if (typeof error === 'string')
    throw new DeviceFlowRefreshRejectedError(error);
  return grantFrom(record, now());
}
