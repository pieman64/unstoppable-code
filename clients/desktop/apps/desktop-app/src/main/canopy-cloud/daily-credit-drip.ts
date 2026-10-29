import type {
  CloudDailyCreditDripState,
  SaveDailyCreditDripRequest,
} from '@canopy/desktop-shared/types';
import {
  DEFAULT_DAILY_DRIP_CAP_CREDITS,
  parseDailyCreditDripPreference,
  parseDailyCreditDripPreferenceSaveResult,
  type DailyCreditDripPreference,
  type DailyCreditDripPreferenceSaveResult,
} from '@canopy/protocol/billing';
import { CanopyCloudClientError, requestCanopyCloudJson } from './client';

/**
 * Daily free-credit drip opt-in route. Deliberately NOT brand-namespaced: it is
 * a sibling of `/api/v1/ai-credits/balance`, and it is not gated by the billing
 * flag, so guests and signed-in users alike can answer the Home card.
 */
export const DAILY_CREDIT_DRIP_PATH = '/api/v1/ai-credits/daily-drip';

/**
 * Placeholder carried alongside an unavailable/unresolved answer only: opted
 * out, undecided, default cap. Callers must consult `available`/`resolved`
 * before treating it as the account's real choice.
 *
 * Frozen because {@link UNAVAILABLE} and {@link UNRESOLVED} are module-level
 * singletons returned by reference on every failure: without this, one caller
 * mutating `state.preference` would corrupt the constant for later callers.
 */
const PLACEHOLDER_PREFERENCE: DailyCreditDripPreference = Object.freeze({
  enabled: false,
  decidedAt: null,
  capCredits: DEFAULT_DAILY_DRIP_CAP_CREDITS,
});

const UNAVAILABLE: CloudDailyCreditDripState = Object.freeze({
  available: false,
  resolved: true,
  preference: PLACEHOLDER_PREFERENCE,
});

const UNRESOLVED: CloudDailyCreditDripState = Object.freeze({
  available: true,
  resolved: false,
  preference: PLACEHOLDER_PREFERENCE,
});

/**
 * "This surface does not exist for you" (hide it) versus "something went wrong"
 * (keep it, show an error). Unavailable: no cloud credential at all
 * (`cloud-not-configured` / `missing-api-key`, raised before any request), a
 * 404 from a web deploy that predates the route, or a 401/403 credential the
 * server will not accept. Everything else — offline, 5xx — is transient.
 */
function isUnavailableError(error: unknown): boolean {
  return (
    error instanceof CanopyCloudClientError &&
    (error.code === 'cloud-not-configured' ||
      error.code === 'missing-api-key' ||
      error.status === 404 ||
      error.status === 401 ||
      error.status === 403)
  );
}

/**
 * Load the connected account's daily-drip opt-in. Never throws. Deliberately
 * uncached: the choice can change from the web Billing tab or another device
 * at any time, and a stale "undecided" would re-show the onboarding card.
 * A malformed body is `unresolved`, never a fabricated preference.
 */
export async function loadDailyCreditDrip(): Promise<CloudDailyCreditDripState> {
  try {
    const preference = parseDailyCreditDripPreference(
      await requestCanopyCloudJson<unknown>(DAILY_CREDIT_DRIP_PATH),
    );
    return preference
      ? { available: true, resolved: true, preference }
      : UNRESOLVED;
  } catch (error) {
    return isUnavailableError(error) ? UNAVAILABLE : UNRESOLVED;
  }
}

/** Why a daily-drip save did not happen. */
export class DailyCreditDripSaveError extends Error {
  constructor(
    message: string,
    /** True when the route/credential is unavailable rather than failing. */
    readonly unavailable: boolean,
  ) {
    super(message);
    this.name = 'DailyCreditDripSaveError';
  }
}

/**
 * Save the daily-drip choice. Resolves only when the server confirmed the save
 * with a well-formed response; otherwise throws {@link DailyCreditDripSaveError}
 * so the caller can roll back optimistic state.
 */
export async function saveDailyCreditDrip(
  request: SaveDailyCreditDripRequest,
): Promise<DailyCreditDripPreferenceSaveResult> {
  let body: unknown;
  try {
    body = await requestCanopyCloudJson<unknown>(DAILY_CREDIT_DRIP_PATH, {
      method: 'PUT',
      body: JSON.stringify({ enabled: request.enabled }),
    });
  } catch (error) {
    if (isUnavailableError(error)) {
      throw new DailyCreditDripSaveError(
        'Daily free credits are not available for this account.',
        true,
      );
    }
    throw new DailyCreditDripSaveError(
      error instanceof Error
        ? `Could not save daily free credits: ${error.message}`
        : 'Could not save daily free credits.',
      false,
    );
  }
  const result = parseDailyCreditDripPreferenceSaveResult(body);
  if (!result) {
    throw new DailyCreditDripSaveError(
      'Could not save daily free credits: unexpected server response.',
      false,
    );
  }
  return result;
}
