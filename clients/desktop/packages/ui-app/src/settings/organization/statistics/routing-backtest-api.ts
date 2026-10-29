import type {
  ModelRoutingBacktestCreateResponseV1,
  ModelRoutingBacktestLookupResponseV1,
  ModelRoutingBacktestMode,
  ModelRoutingBacktestV1,
} from '@canopy/protocol/model-routing';
import { MODEL_ROUTING_BACKTEST_STATUSES } from '@canopy/protocol/model-routing';
import { SettingsOperationError } from '@canopy/protocol/settings/errors';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import { TeamApiError } from '../team-api';

/**
 * Whose turns an automatic model routing estimate replays. Organization runs
 * read the Statistics filter; profile runs always cover the signed-in user.
 */
export type RoutingBacktestSubject =
  | {
      kind: 'organization';
      orgId: string;
      scope: 'organization' | 'team';
      teamId?: string;
      userId?: string;
    }
  | { kind: 'user' };

export interface RoutingBacktestRange {
  startIso: string;
  endIso: string;
}

/**
 * Rethrow a failed settings call as the legacy `TeamApiError`, so the card's
 * code checks (402/409/429 `code`) are unchanged. The route's `{ error }`
 * text becomes the log-only `serverDetail`; the error's message is generic. A
 * failure without a response (offline, a dropped write) stays a plain error,
 * which the card shows as its generic copy, as a failed `fetch` did.
 */
function rethrowAsTeamApiError(error: unknown): never {
  if (error instanceof SettingsOperationError) {
    if (error.code === 'invalid_response')
      throw new TeamApiError(
        error.status ?? 200,
        'Invalid server response',
        error.serverCode,
      );
    // The payload carries the route's text only when it sent one.
    if (error.status !== undefined)
      throw new TeamApiError(
        error.status,
        error.toPayload().message,
        error.serverCode,
      );
  }
  throw error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStatus(value: unknown): boolean {
  return MODEL_ROUTING_BACKTEST_STATUSES.some((status) => status === value);
}

/** Shallow shape check; the server owns the full contract. */
export function isRoutingBacktest(
  value: unknown,
): value is ModelRoutingBacktestV1 {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isStatus(value.status) &&
    (value.mode === 'sample' || value.mode === 'full') &&
    typeof value.rangeStartIso === 'string' &&
    typeof value.rangeEndIso === 'string' &&
    isRecord(value.progress) &&
    (value.result === null || isRecord(value.result))
  );
}

function isLookupResponse(
  value: unknown,
): value is ModelRoutingBacktestLookupResponseV1 {
  return (
    isRecord(value) &&
    (value.backtest === null || isRoutingBacktest(value.backtest)) &&
    (value.estimate === null || isRecord(value.estimate)) &&
    (value.unavailableReason === null ||
      typeof value.unavailableReason === 'string')
  );
}

function isCreateResponse(
  value: unknown,
): value is ModelRoutingBacktestCreateResponseV1 {
  return (
    isRecord(value) &&
    isRoutingBacktest(value.backtest) &&
    typeof value.cached === 'boolean'
  );
}

function validated<T>(
  value: unknown,
  validate: (value: unknown) => value is T,
): T {
  if (!validate(value)) throw new TeamApiError(200, 'Invalid server response');
  return value;
}

/** Cached run for the range and filter, plus an estimate for a new one. */
export async function lookupRoutingBacktest(
  client: AccountOrganizationSettingsClient,
  subject: RoutingBacktestSubject,
  range: RoutingBacktestRange,
): Promise<ModelRoutingBacktestLookupResponseV1> {
  try {
    const result =
      subject.kind === 'organization'
        ? await client.read('organization.statistics.routingBacktest.lookup', {
            organizationId: subject.orgId,
            scope: subject.scope,
            ...(subject.teamId ? { teamId: subject.teamId } : {}),
            ...(subject.userId ? { userId: subject.userId } : {}),
            startIso: range.startIso,
            endIso: range.endIso,
          })
        : await client.read('account.profile.routingBacktest.lookup', {
            startIso: range.startIso,
            endIso: range.endIso,
          });
    return validated(result, isLookupResponse);
  } catch (error: unknown) {
    rethrowAsTeamApiError(error);
  }
}

/** Start a run, or return the cached one for the same range and filter. */
export async function createRoutingBacktest(
  client: AccountOrganizationSettingsClient,
  subject: RoutingBacktestSubject,
  range: RoutingBacktestRange,
  mode: ModelRoutingBacktestMode,
): Promise<ModelRoutingBacktestCreateResponseV1> {
  try {
    const result =
      subject.kind === 'organization'
        ? await client.write('organization.statistics.routingBacktest.create', {
            organizationId: subject.orgId,
            scope: subject.scope,
            ...(subject.teamId ? { teamId: subject.teamId } : {}),
            ...(subject.userId ? { userId: subject.userId } : {}),
            startIso: range.startIso,
            endIso: range.endIso,
            mode,
          })
        : await client.write('account.profile.routingBacktest.create', {
            startIso: range.startIso,
            endIso: range.endIso,
            mode,
          });
    return validated(result, isCreateResponse);
  } catch (error: unknown) {
    rethrowAsTeamApiError(error);
  }
}

function isGetResponse(
  value: unknown,
): value is { backtest: ModelRoutingBacktestV1 } {
  return isRecord(value) && isRoutingBacktest(value.backtest);
}

/** Progress and results for one run. */
export async function getRoutingBacktest(
  client: AccountOrganizationSettingsClient,
  subject: RoutingBacktestSubject,
  backtestId: string,
): Promise<ModelRoutingBacktestV1> {
  try {
    const result =
      subject.kind === 'organization'
        ? await client.read('organization.statistics.routingBacktest.get', {
            organizationId: subject.orgId,
            backtestId,
          })
        : await client.read('account.profile.routingBacktest.read', {
            backtestId,
          });
    return validated(result, isGetResponse).backtest;
  } catch (error: unknown) {
    rethrowAsTeamApiError(error);
  }
}
