import { cloudAccountIdentityKey } from '@canopy/desktop-shared/lib/guest-account';
import {
  peekCanopyCloudAccount,
  subscribeCanopyCloudAccountChanges,
} from './canopy-cloud-account-store';
import { createDesktopInstrumentationOperationKey } from '@canopy/desktop-instrumentation';
import {
  startDesktopOperation,
  succeedDesktopOperation,
} from '@canopy/desktop-instrumentation/electron/main';
import {
  isDailyDripBlockedReason,
  isDailyDripGrantOutcome,
  type DailyCreditDripPreferenceSaveResult,
  type DailyDripBlockedReason,
  type DailyDripGrantOutcome,
} from '@canopy/protocol/billing';

import {
  getPostHogOperationCaptureState,
  subscribePostHogOperationCaptureChanges,
} from './posthog-operation-capture-gate';

/**
 * Daily free AI credit grant telemetry (CAN-4633).
 *
 * The server decides each daily-drip grant and reports the outcome on the
 * balance read (`dailyDripOutcome`) and on an opt-in save (`granted`,
 * `blockedReason`). Main reports that outcome as
 * `billing:daily_credit_grant_update`. Balance reads repeat on a short cache,
 * so each status is reported at most once per connected account lifetime per
 * Pacific day, the day the server grants on. The latest status is also kept for `chat:turn_end`, so a
 * `no_credits` failure says whether the drip was blocked, off, or spent.
 *
 * Only the fixed outcome, reason, and amount leave this module; never a
 * balance, email, or network detail.
 */

const OPERATION = 'canopy.daily_credit_grant';

type GrantSource = 'balance_read' | 'opt_in_save';

interface GrantObservation {
  status: DailyDripGrantOutcome;
  blockedReason?: DailyDripBlockedReason;
  amount?: number;
}

const PACIFIC_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

interface GrantAccountScope {
  readonly key: string;
}

let accountScope: GrantAccountScope | null = null;
let isSubscribed = false;
let reportedDay: string | null = null;
const reportedToday = new Set<string>();
let lastStatus: DailyDripGrantOutcome | undefined;
interface PendingGrantObservation {
  observation: GrantObservation;
  source: GrantSource;
  now: Date;
  scope: GrantAccountScope;
}
// Bounded by the fixed outcome/reason catalog for one account and Pacific day.
const pendingStartup = new Map<string, PendingGrantObservation>();

function flushStartupObservations(): void {
  syncAccountScope();
  const pending = Array.from(pendingStartup.values());
  pendingStartup.clear();
  if (!getPostHogOperationCaptureState()?.enabled) return;
  const latestStatus = lastStatus;
  for (const item of pending) {
    report(item.observation, item.source, item.now, item.scope);
  }
  lastStatus = latestStatus;
}

/** Capture the account lifetime before starting a grant-producing request. */
export function captureDailyCreditGrantAccount(): GrantAccountScope | null {
  if (!isSubscribed) {
    subscribeCanopyCloudAccountChanges(() => {
      syncAccountScope();
    });
    subscribePostHogOperationCaptureChanges(flushStartupObservations);
    isSubscribed = true;
  }
  return syncAccountScope();
}

function syncAccountScope(): GrantAccountScope | null {
  const key = cloudAccountIdentityKey(peekCanopyCloudAccount());
  if ((accountScope?.key ?? null) !== key) {
    accountScope = key === null ? null : { key };
    clearDailyCreditGrantStatus();
  }
  return accountScope;
}

/** Test seam: forget reported statuses and the latest status. */
export function resetDailyCreditGrantTelemetryForTests(): void {
  accountScope = null;
  clearDailyCreditGrantStatus();
}

/** The latest drip outcome main saw, or undefined when unknown. */
export function getLastDailyCreditGrantStatus():
  | DailyDripGrantOutcome
  | undefined {
  captureDailyCreditGrantAccount();
  return lastStatus;
}

/** Forget account-specific status and deduplication, e.g. on sign-out. */
export function clearDailyCreditGrantStatus(): void {
  lastStatus = undefined;
  reportedDay = null;
  reportedToday.clear();
  pendingStartup.clear();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function positiveAmount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function report(
  observation: GrantObservation,
  source: GrantSource,
  now: Date,
  scope: GrantAccountScope | null,
): void {
  if (scope === null || scope !== captureDailyCreditGrantAccount()) return;
  lastStatus = observation.status;
  const day = PACIFIC_DAY.format(now);
  if (day !== reportedDay) {
    reportedDay = day;
    reportedToday.clear();
    pendingStartup.clear();
  }
  // A grant this install saw already explains the rest of the day's reads.
  if (
    observation.status === 'already_granted' &&
    (reportedToday.has('granted') || pendingStartup.has('granted'))
  )
    return;
  const dedupeKey =
    observation.status === 'blocked'
      ? `blocked:${observation.blockedReason ?? ''}`
      : observation.status;
  if (reportedToday.has(dedupeKey)) return;
  const captureState = getPostHogOperationCaptureState();
  if (captureState === undefined) {
    if (!pendingStartup.has(dedupeKey)) {
      pendingStartup.set(dedupeKey, { observation, source, now, scope });
    }
    return;
  }
  if (!captureState.enabled) return;
  reportedToday.add(dedupeKey);

  const context = {
    grant_status: observation.status,
    ...(observation.blockedReason
      ? { grant_blocked_reason: observation.blockedReason }
      : {}),
    ...(observation.amount !== undefined
      ? { grant_amount: observation.amount }
      : {}),
    grant_source: source,
  };
  setImmediate(() => {
    if (
      scope !== captureDailyCreditGrantAccount() ||
      captureState !== getPostHogOperationCaptureState()
    )
      return;
    try {
      const operationKey = createDesktopInstrumentationOperationKey(
        `${OPERATION}:${dedupeKey}:${now.getTime()}`,
      );
      startDesktopOperation(OPERATION, { operationKey, context });
      succeedDesktopOperation(OPERATION, { operationKey, context });
    } catch {
      // Instrumentation must never affect the app path.
    }
  });
}

/**
 * Record the outcome a balance read reported. The body is unvalidated wire
 * data, so anything but a known outcome is ignored; an older server that omits
 * the outcome reports nothing.
 */
export function recordDailyCreditGrantFromBalance(
  balance: unknown,
  now: Date = new Date(),
  scope: GrantAccountScope | null = captureDailyCreditGrantAccount(),
): void {
  if (!isRecord(balance) || !isDailyDripGrantOutcome(balance.dailyDripOutcome))
    return;
  const status = balance.dailyDripOutcome;
  const blockedReason =
    status === 'blocked' &&
    isDailyDripBlockedReason(balance.dailyDripBlockedReason)
      ? balance.dailyDripBlockedReason
      : undefined;
  const amount =
    status === 'granted'
      ? positiveAmount(balance.dailyDripGrantedCredits)
      : undefined;
  report(
    {
      status,
      ...(blockedReason ? { blockedReason } : {}),
      ...(amount !== undefined ? { amount } : {}),
    },
    'balance_read',
    now,
    scope,
  );
}

/**
 * Record a confirmed opt-in save. A turn-on reports its grant or block; a
 * turn-on that minted nothing for another reason (already granted, at the
 * cap) waits for the next balance read to say which. A turn-off is not a
 * grant attempt, so it only updates the latest status.
 */
export function recordDailyCreditGrantFromSave(
  result: DailyCreditDripPreferenceSaveResult,
  now: Date = new Date(),
  scope: GrantAccountScope | null = captureDailyCreditGrantAccount(),
): void {
  if (scope === null || scope !== captureDailyCreditGrantAccount()) return;
  if (!result.enabled) {
    lastStatus = 'not_opted_in';
    return;
  }
  const amount = positiveAmount(result.granted);
  if (amount !== undefined) {
    report({ status: 'granted', amount }, 'opt_in_save', now, scope);
  } else if (result.blockedReason !== undefined) {
    report(
      { status: 'blocked', blockedReason: result.blockedReason },
      'opt_in_save',
      now,
      scope,
    );
  }
}
