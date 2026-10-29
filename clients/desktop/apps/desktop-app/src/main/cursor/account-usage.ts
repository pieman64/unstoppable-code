import type {
  ProviderUsageSummary,
  UsageFetchErrorKind,
} from '@canopy/desktop-shared/types';
import { isRecord } from '../lib/type-guards';
import { getMockApiKey, getMockLlmOrigin } from '../lib/e2e-mock-control-plane';
import { readPreferencesFile } from '../lib/preferences-store';
import { getManagedCursorRuntime } from './connection';
import { cursorConnectionStatus } from './runtime-status';
import { runCursorRuntimeCommand } from '@canopy/desktop-shared/node/cursor/runtime-process';
import { isCursorHarnessEnabled } from './feature-flag';
import { readCursorAccessToken } from './account-credentials';
import { cursorUsageRateLimits } from './account-usage-data';
import { cursorBackendHeaders, readCursorBackendJson } from './backend-request';

const DASHBOARD = 'https://api2.cursor.sh/aiserver.v1.DashboardService/';
const MAX_RESPONSE_BYTES = 1024 * 1024;
type ReadMethod =
  | 'GetMe'
  | 'GetCurrentPeriodUsage'
  | 'GetPlanInfo'
  | 'GetHardLimit';
class CursorUsageError extends Error {
  constructor(readonly kind: UsageFetchErrorKind) {
    super('Could not load Cursor account usage.');
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const value = await readCursorBackendJson(response, MAX_RESPONSE_BYTES);
  if (!value) throw new CursorUsageError('service');
  return value;
}

function sameAccount(
  status: Record<string, unknown>,
  account: Record<string, unknown>,
): boolean {
  if (!isRecord(status.userInfo)) return false;
  const previous = status.userInfo;
  if (typeof previous.userId === 'string' && previous.userId.length > 0)
    return previous.userId === account.userId;
  return (
    typeof previous.email === 'string' &&
    previous.email.length > 0 &&
    previous.email === account.email
  );
}

/** Reads the existing login without a prompt, login, logout, or credential copies.
 * The CLI's status call owns token refresh. The captured access token then pins
 * all four reads to one account; only the normalized snapshot leaves this module. */
export async function readCursorAccountUsage(
  signal: AbortSignal,
): Promise<ProviderUsageSummary | null> {
  if (!isCursorHarnessEnabled()) return null;
  const mock = __CANOPY_E2E__ ? getMockLlmOrigin() : null;
  const available = async (): Promise<boolean> => {
    if (!isCursorHarnessEnabled()) return false;
    if (mock) return Boolean((await readPreferencesFile()).cursorEnabled);
    const status = await cursorConnectionStatus();
    return status.enabled && status.supported && status.installed;
  };
  const base: ProviderUsageSummary = {
    provider: 'cursor',
    authState: 'unknown',
    hasRemainingLimits: false,
  };
  let accountSummary: Partial<ProviderUsageSummary> = {};
  try {
    if (!(await available())) return null;
    let token: string | null;
    let status: Record<string, unknown> | undefined;
    if (mock) {
      token = getMockApiKey();
    } else {
      const managed = await getManagedCursorRuntime(signal);
      const auth = await runCursorRuntimeCommand(
        managed.launch,
        ['status', '--format', 'json'],
        managed.env,
        signal,
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(auth.stdout);
      } catch {
        throw new CursorUsageError('service');
      }
      if (auth.code !== 0 || !isRecord(parsed))
        throw new CursorUsageError('service');
      if (parsed.isAuthenticated !== true) throw new CursorUsageError('auth');
      status = parsed;
      token = await readCursorAccessToken(managed.env, signal);
    }
    signal.throwIfAborted();
    if (!token) throw new CursorUsageError('auth');
    const read = async (
      method: ReadMethod,
    ): Promise<Record<string, unknown>> => {
      let url = `${DASHBOARD}${method}`;
      if (__CANOPY_E2E__) {
        if (mock) url = `${mock}/__mock/cursor/${method}`;
      }
      const response = await fetch(url, {
        method: 'POST',
        body: '{}',
        redirect: 'error',
        signal,
        headers: cursorBackendHeaders(token),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new CursorUsageError(
          response.status === 401 || response.status === 403
            ? 'auth'
            : 'service',
        );
      }
      return readJson(response);
    };
    const account = await read('GetMe');
    if (status && !sameAccount(status, account))
      throw new CursorUsageError('auth');
    if (typeof account.email !== 'string' && typeof account.userId !== 'string')
      throw new CursorUsageError('auth');
    accountSummary = {
      authState: 'authenticated',
      ...(typeof account.email === 'string'
        ? { accountEmail: account.email, accountLabel: account.email }
        : {}),
    };
    const optional = async (
      method: ReadMethod,
    ): Promise<Record<string, unknown>> => {
      try {
        return await read(method);
      } catch (error) {
        if (error instanceof CursorUsageError && error.kind === 'auth')
          throw error;
        return {};
      }
    };
    const [usage, plan, hard] = await Promise.all([
      read('GetCurrentPeriodUsage'),
      optional('GetPlanInfo'),
      optional('GetHardLimit'),
    ]);
    const planInfo = isRecord(plan.planInfo) ? plan.planInfo : {};
    const rateLimits =
      usage.enabled === false
        ? []
        : cursorUsageRateLimits(usage, hard, planInfo);
    if (!(await available())) return null;
    signal.throwIfAborted();
    return {
      ...base,
      ...accountSummary,
      lastUpdatedAt: new Date().toISOString(),
      ...(typeof planInfo.planName === 'string'
        ? { subscriptionLabel: planInfo.planName }
        : {}),
      hasRemainingLimits: rateLimits.length > 0,
      ...(rateLimits.length
        ? { rateLimits }
        : {
            errorInfo: {
              kind: 'unsupported',
              message:
                'Cursor has not provided usage details for this account.',
            },
          }),
    };
  } catch (error) {
    if (!isCursorHarnessEnabled()) return null;
    if (
      signal.aborted &&
      !(signal.reason instanceof Error && signal.reason.name === 'TimeoutError')
    )
      return null;
    const kind = error instanceof CursorUsageError ? error.kind : 'network';
    return {
      ...base,
      ...(kind === 'auth' ? { authState: 'unauthenticated' } : accountSummary),
      lastUpdatedAt: new Date().toISOString(),
      errorInfo: { kind },
    };
  }
}
